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

from .const import DOMAIN, LIGHTS_OFF
from .controllers import TankData
from .entity import FeedAndWaterEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    tank: TankData = hass.data[DOMAIN][entry.entry_id]
    if tank.lights is not None:
        async_add_entities([LightsToggleSwitch(tank)])


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
