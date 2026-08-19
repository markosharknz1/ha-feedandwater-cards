"""Tracked-devices text entity — the comma-separated entity_id list the
off-duration sensor reads, editable straight from the dashboard (same UX
as the YAML flavor's input_text helper)."""
from __future__ import annotations

from homeassistant.components.text import TextEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN
from .controllers import TankData
from .entity import FeedAndWaterEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    tank: TankData = hass.data[DOMAIN][entry.entry_id]
    if tank.has_equipment:
        async_add_entities([TrackedDevicesText(tank)])


class TrackedDevicesText(FeedAndWaterEntity, RestoreEntity, TextEntity):
    _attr_icon = "mdi:format-list-bulleted"
    _attr_native_max = 255

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "text", "tracked_devices")
        self._attr_native_value = ""

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        if last is not None and last.state not in ("unknown", "unavailable"):
            self._attr_native_value = last.state
        self.tank.tracked_devices = self._attr_native_value or ""

    async def async_set_value(self, value: str) -> None:
        self._attr_native_value = value
        self.tank.tracked_devices = value
        self.async_write_ha_state()
