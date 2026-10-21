"""Toggle switch for a light-timer group — one entity that turns the
lights on (honoring the Light timer slider) and off again, so HA's native
Tile cards get a single-button toggle instead of separate on/off buttons.
The buttons remain for tap-only dashboards and automations."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN, LIGHTS_OFF
from .controllers import TankData
from .entity import FeedAndWaterEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    tank: TankData = hass.data[DOMAIN][entry.entry_id]
    entities: list[SwitchEntity] = []
    if tank.lights is not None:
        entities.append(LightsToggleSwitch(tank))
    if tank.has_night:
        entities.append(NightFeedSwitch(tank))
    async_add_entities(entities)


class LightsToggleSwitch(FeedAndWaterEntity, SwitchEntity):
    _attr_icon = "mdi:lightbulb"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "switch", "lights")

    @property
    def is_on(self) -> bool:
        return self.tank.lights is not None and self.tank.lights.stage != LIGHTS_OFF

    async def async_turn_on(self, **kwargs: Any) -> None:
        if self.tank.lights:
            await self.tank.lights.async_turn_on()

    async def async_turn_off(self, **kwargs: Any) -> None:
        if self.tank.lights:
            await self.tank.lights.async_turn_off()

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self.tank.lights is not None:
            self.async_on_remove(
                self.tank.lights.async_add_listener(self.async_write_ha_state)
            )


class NightFeedSwitch(FeedAndWaterEntity, RestoreEntity, SwitchEntity):
    """Red-only (or any-channel) viewing light for after-dark feeding.

    On: snapshot the configured channels, flip any mode selects, zero the
    dim channels, raise the night channels to the Night level. Off:
    restore the snapshot, so the light resumes exactly what it was doing.
    The snapshot persists through HA restarts via the restored attributes.
    """

    _attr_icon = "mdi:weather-night"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "switch", "night_feed")

    @property
    def is_on(self) -> bool:
        return self.tank.night_active

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"snapshot": dict(self.tank.night_snapshot)}

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.tank.async_night_on()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.tank.async_night_off()

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.night_listeners.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and last.state == "on" and not self.tank.night_active:
            snapshot = last.attributes.get("snapshot") or {}
            self.tank.async_night_restore(snapshot)
