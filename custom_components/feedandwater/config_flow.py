"""Config flow for Reef Feed & Water: one entry per tank.

Step 1 asks for the tank name + slug (the entity_id prefix — same rule as
generate_tank.py in the YAML flavor). Step 2 picks the hardware entities.
Hardware picks land in entry.options so the OptionsFlow can rewire them
later (e.g. demo entities -> real pumps) without recreating the entry.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_KIND,
    CONF_LIGHTS,
    CONF_MAINT_ACTIONS,
    CONF_MAINT_STATUS,
    CONF_POWER_SENSOR,
    CONF_PUMP_SPEED_CONTROLS,
    CONF_RETURN_PUMPS,
    CONF_SKIMMERS,
    CONF_SLUG,
    CONF_SPEED_DISPLAYS,
    CONF_WAVEMAKERS,
    DOMAIN,
    KIND_MAINTENANCE,
)
from .util import slugify_name, valid_slug

ON_OFF_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["switch", "fan"], multiple=True)
)
# Speed controls accept either a number entity (a raw set-point, e.g. a
# separate Flow control) or a fan entity (pumps whose integration merges
# power+speed into one fan — the fan's percentage is used).
SPEED_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["number", "fan"], multiple=True)
)
# The Speed card additionally takes plain switches (e.g. a pump on a Tapo
# plug) — no speed to read, but the per-pump Off button + timer still work.
SPEED_CARD_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["number", "fan", "switch"], multiple=True)
)
POWER_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain="binary_sensor")
)
LIGHTS_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["switch", "light", "fan"], multiple=True)
)
MAINT_ACTION_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["button", "switch", "script"], multiple=True)
)
MAINT_STATUS_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["binary_sensor", "sensor"])
)

# RedSea-targeted variants: same shapes, but the pickers only offer
# entities from the ReefBeat integration (domain "redsea",
# Elwinmage/ha-reefbeat-component) — for the dedicated ReefMat/ATO flows.
REDSEA_ACTION_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(
        multiple=True,
        filter=selector.EntityFilterSelectorConfig(
            integration="redsea", domain=["button", "switch", "number"]
        ),
    )
)
REDSEA_STATUS_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(
        filter=selector.EntityFilterSelectorConfig(
            integration="redsea", domain=["binary_sensor", "sensor"]
        )
    )
)


def _hardware_schema(current: dict[str, Any]) -> vol.Schema:
    """Hardware pickers, pre-filled with current values when re-shown by
    the OptionsFlow."""
    # All equipment is optional: a "tank" can be as small as a single light
    # on a plug (lights-only entry) — features whose hardware is absent
    # simply don't create their entities.
    schema: dict[Any, Any] = {
        vol.Optional(
            CONF_WAVEMAKERS, default=current.get(CONF_WAVEMAKERS, [])
        ): ON_OFF_SELECTOR,
        vol.Optional(
            CONF_SKIMMERS, default=current.get(CONF_SKIMMERS, [])
        ): ON_OFF_SELECTOR,
        vol.Optional(
            CONF_RETURN_PUMPS, default=current.get(CONF_RETURN_PUMPS, [])
        ): ON_OFF_SELECTOR,
        vol.Optional(
            CONF_PUMP_SPEED_CONTROLS,
            default=current.get(CONF_PUMP_SPEED_CONTROLS, []),
        ): SPEED_SELECTOR,
        vol.Optional(
            CONF_LIGHTS, default=current.get(CONF_LIGHTS, [])
        ): LIGHTS_SELECTOR,
        vol.Optional(
            CONF_SPEED_DISPLAYS, default=current.get(CONF_SPEED_DISPLAYS, [])
        ): SPEED_CARD_SELECTOR,
    }
    power_current = current.get(CONF_POWER_SENSOR)
    if power_current:
        schema[vol.Optional(CONF_POWER_SENSOR, default=power_current)] = POWER_SELECTOR
    else:
        schema[vol.Optional(CONF_POWER_SENSOR)] = POWER_SELECTOR
    return vol.Schema(schema)


class FeedAndWaterConfigFlow(ConfigFlow, domain=DOMAIN):
    """Menu flow: a full tank (identity -> hardware), or a standalone
    light timer (one small form) — the latter repeatable for as many
    light circuits as wanted."""

    VERSION = 1

    def __init__(self) -> None:
        self._name: str | None = None
        self._slug: str | None = None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="user", menu_options=["tank", "light", "maintenance", "redsea"]
        )

    async def async_step_redsea(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="redsea", menu_options=["redsea_mat", "redsea_ato"]
        )

    def _resolve_identity(
        self, user_input: dict[str, Any], errors: dict[str, str]
    ) -> str | None:
        """Validate name+optional slug; returns the slug or records an error."""
        name = user_input["name"].strip()
        slug = (user_input.get(CONF_SLUG) or "").strip().lower()
        if not slug:
            slug = slugify_name(name)
        if not valid_slug(slug):
            errors[CONF_SLUG] = "invalid_slug"
            return None
        self._name = name
        return slug

    async def async_step_tank(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            slug = self._resolve_identity(user_input, errors)
            if slug is not None:
                await self.async_set_unique_id(slug)
                self._abort_if_unique_id_configured()
                self._slug = slug
                return await self.async_step_hardware()

        return self.async_show_form(
            step_id="tank",
            data_schema=vol.Schema(
                {
                    vol.Required("name"): str,
                    vol.Optional(CONF_SLUG): str,
                }
            ),
            errors=errors,
        )

    async def async_step_light(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Standalone light timer: name + the light(s), done."""
        errors: dict[str, str] = {}
        if user_input is not None:
            slug = self._resolve_identity(user_input, errors)
            if slug is not None:
                await self.async_set_unique_id(slug)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=self._name or slug,
                    data={CONF_SLUG: slug},
                    options={CONF_LIGHTS: user_input[CONF_LIGHTS]},
                )

        return self.async_show_form(
            step_id="light",
            data_schema=vol.Schema(
                {
                    vol.Required("name"): str,
                    vol.Optional(CONF_SLUG): str,
                    vol.Required(CONF_LIGHTS): LIGHTS_SELECTOR,
                }
            ),
            errors=errors,
        )

    async def async_step_maintenance(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Repeatable maintenance task: fleece roll change, ATO reset, …"""
        errors: dict[str, str] = {}
        if user_input is not None:
            slug = self._resolve_identity(user_input, errors)
            if slug is not None:
                await self.async_set_unique_id(slug)
                self._abort_if_unique_id_configured()
                options: dict[str, Any] = {
                    CONF_MAINT_ACTIONS: user_input.get(CONF_MAINT_ACTIONS, [])
                }
                if user_input.get(CONF_MAINT_STATUS):
                    options[CONF_MAINT_STATUS] = user_input[CONF_MAINT_STATUS]
                return self.async_create_entry(
                    title=self._name or slug,
                    data={CONF_SLUG: slug, CONF_KIND: KIND_MAINTENANCE},
                    options=options,
                )

        return self.async_show_form(
            step_id="maintenance",
            data_schema=vol.Schema(
                {
                    vol.Required("name"): str,
                    vol.Optional(CONF_SLUG): str,
                    vol.Optional(CONF_MAINT_ACTIONS, default=[]): MAINT_ACTION_SELECTOR,
                    vol.Optional(CONF_MAINT_STATUS): MAINT_STATUS_SELECTOR,
                }
            ),
            errors=errors,
        )

    async def _async_step_redsea_task(
        self, step_id: str, default_name: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        """Shared RedSea-targeted maintenance form (ReefMat / ATO)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            slug = self._resolve_identity(user_input, errors)
            if slug is not None:
                await self.async_set_unique_id(slug)
                self._abort_if_unique_id_configured()
                options: dict[str, Any] = {
                    CONF_MAINT_ACTIONS: user_input.get(CONF_MAINT_ACTIONS, [])
                }
                if user_input.get(CONF_MAINT_STATUS):
                    options[CONF_MAINT_STATUS] = user_input[CONF_MAINT_STATUS]
                return self.async_create_entry(
                    title=self._name or slug,
                    data={CONF_SLUG: slug, CONF_KIND: KIND_MAINTENANCE},
                    options=options,
                )

        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema(
                {
                    vol.Required("name", default=default_name): str,
                    vol.Optional(CONF_SLUG): str,
                    vol.Optional(
                        CONF_MAINT_ACTIONS, default=[]
                    ): REDSEA_ACTION_SELECTOR,
                    vol.Optional(CONF_MAINT_STATUS): REDSEA_STATUS_SELECTOR,
                }
            ),
            errors=errors,
        )

    async def async_step_redsea_mat(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._async_step_redsea_task(
            "redsea_mat", "Fleece Roll", user_input
        )

    async def async_step_redsea_ato(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._async_step_redsea_task(
            "redsea_ato", "ATO Reset", user_input
        )

    async def async_step_hardware(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(
                title=self._name or self._slug or "Tank",
                data={CONF_SLUG: self._slug},
                options=user_input,
            )
        return self.async_show_form(
            step_id="hardware", data_schema=_hardware_schema({})
        )

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> "FeedAndWaterOptionsFlow":
        return FeedAndWaterOptionsFlow(entry)


class FeedAndWaterOptionsFlow(OptionsFlow):
    """Re-shows the hardware pickers so a tank can be rewired (e.g. demo
    entities swapped for real hardware) without recreating the entry."""

    def __init__(self, entry: ConfigEntry) -> None:
        self.entry = entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        return self.async_show_form(
            step_id="init", data_schema=_hardware_schema(dict(self.entry.options))
        )
