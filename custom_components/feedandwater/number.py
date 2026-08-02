"""Settings numbers for a tank — replaces the YAML flavor's input_number
helpers. Values are mirrored into TankData.values, which is what the
controllers read (never entity_ids, which users can rename)."""
from __future__ import annotations

from homeassistant.components.number import NumberMode, RestoreNumber
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, NUMBER_SPECS
from .controllers import TankData
from .entity import FeedAndWaterEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    tank: TankData = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(TankNumber(tank, key) for key in NUMBER_SPECS)


class TankNumber(FeedAndWaterEntity, RestoreNumber):
    _attr_mode = NumberMode.SLIDER

    def __init__(self, tank: TankData, key: str) -> None:
        super().__init__(tank, "number", key)
        self.key = key
        default, minimum, maximum, step, unit = NUMBER_SPECS[key]
        self._attr_native_min_value = minimum
        self._attr_native_max_value = maximum
        self._attr_native_step = step
        self._attr_native_unit_of_measurement = unit
        self._attr_native_value = default

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_number_data()
        if last is not None and last.native_value is not None:
            self._attr_native_value = last.native_value
        self.tank.values[self.key] = float(self._attr_native_value)

    async def async_set_native_value(self, value: float) -> None:
        self._attr_native_value = value
        self.tank.values[self.key] = float(value)
        self.async_write_ha_state()
