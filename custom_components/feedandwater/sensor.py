"""Sensors for a tank: feed/water-change stage machines (with restart
recovery), last-water-change timestamp, and the multi-device off-duration
tracker ported from the YAML flavor's trigger template sensor."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.util import dt as dt_util

from .const import DOMAIN, FEED_IDLE, LIGHTS_OFF, WC_IDLE
from .controllers import TankData
from .entity import FeedAndWaterEntity
from .util import compute_off_durations, parse_tracked_devices

ATTR_WAVEMAKERS_AT = "wavemakers_at"
ATTR_SKIMMER_AT = "skimmer_at"
ATTR_SAFETY_AT = "safety_at"
ATTR_SAVED_SPEEDS = "saved_speeds"
ATTR_OFF_AT = "off_at"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    tank: TankData = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = []
    if tank.has_equipment:
        # Feed/water-change stages and device tracking belong to real
        # tanks — a lights-only entry stays lean.
        entities += [
            FeedStageSensor(tank),
            WaterChangeStageSensor(tank),
            LastWaterChangeSensor(tank),
            OffDurationsSensor(tank),
        ]
    if tank.lights is not None:
        entities.append(LightStageSensor(tank))
    if tank.monitored_speed_entities():
        entities.append(PumpSpeedsSensor(tank))
    async_add_entities(entities)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse(value: Any) -> datetime | None:
    if not value:
        return None
    return dt_util.parse_datetime(str(value))


class FeedStageSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """idle / feeding / settling — plus the scheduled end-times and saved
    pump speeds as attributes, which double as the persistence layer for
    recovering an in-flight feed after an HA restart."""

    _attr_icon = "mdi:food-drumstick"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "feed_stage")

    @property
    def native_value(self) -> str:
        return self.tank.feed.stage

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        feed = self.tank.feed
        return {
            ATTR_WAVEMAKERS_AT: _iso(feed.wavemakers_resume_at),
            ATTR_SKIMMER_AT: _iso(feed.skimmer_resume_at),
            ATTR_SAVED_SPEEDS: dict(feed.saved_speeds),
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self.tank.feed.async_add_listener(self.async_write_ha_state))
        last = await self.async_get_last_state()
        if last is not None and last.state not in (FEED_IDLE, "unknown", "unavailable"):
            saved = last.attributes.get(ATTR_SAVED_SPEEDS) or {}
            await self.tank.feed.async_restore(
                last.state,
                _parse(last.attributes.get(ATTR_WAVEMAKERS_AT)),
                _parse(last.attributes.get(ATTR_SKIMMER_AT)),
                {str(k): float(v) for k, v in saved.items()},
            )


class WaterChangeStageSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """idle / paused / restarting_wavemakers / restarting_skimmer — same
    persistence-through-attributes pattern as the feed stage sensor."""

    _attr_icon = "mdi:water-sync"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "water_change_stage")

    @property
    def native_value(self) -> str:
        return self.tank.water.stage

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        water = self.tank.water
        return {
            ATTR_WAVEMAKERS_AT: _iso(water.wavemakers_restart_at),
            ATTR_SKIMMER_AT: _iso(water.skimmer_restart_at),
            ATTR_SAFETY_AT: _iso(water.safety_at),
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.water.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and last.state not in (WC_IDLE, "unknown", "unavailable"):
            await self.tank.water.async_restore(
                last.state,
                _parse(last.attributes.get(ATTR_WAVEMAKERS_AT)),
                _parse(last.attributes.get(ATTR_SKIMMER_AT)),
                _parse(last.attributes.get(ATTR_SAFETY_AT)),
            )


class LastWaterChangeSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:calendar-check"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "last_water_change")

    @property
    def native_value(self) -> datetime | None:
        return self.tank.last_water_change

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.last_water_change_listeners.async_add_listener(
                self.async_write_ha_state
            )
        )
        last = await self.async_get_last_state()
        if last is not None and self.tank.last_water_change is None:
            self.tank.last_water_change = _parse(last.state)


class LightStageSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """off / on / on_timed — with the scheduled auto-off time as an
    attribute, doubling as the persistence layer so a timed light session
    survives an HA restart (same pattern as the feed stage sensor)."""

    _attr_icon = "mdi:lightbulb-outline"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "light_stage")

    @property
    def native_value(self) -> str:
        return self.tank.lights.stage if self.tank.lights else LIGHTS_OFF

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        lights = self.tank.lights
        return {ATTR_OFF_AT: _iso(lights.off_at) if lights else None}

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self.tank.lights is None:
            return
        self.async_on_remove(
            self.tank.lights.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and last.state not in (LIGHTS_OFF, "unknown", "unavailable"):
            await self.tank.lights.async_restore(
                last.state, _parse(last.attributes.get(ATTR_OFF_AT))
            )


class PumpSpeedsSensor(FeedAndWaterEntity, SensorEntity):
    """At-a-glance speeds for every monitored pump (feed-mode speed
    controls + display-only additions). Event-driven: updates the instant
    any underlying speed changes. State = number of readable pumps;
    per-pump details live in the `speeds` attribute for the card and for
    markdown tables."""

    _attr_icon = "mdi:speedometer"
    _attr_native_unit_of_measurement = "pumps"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "pump_speeds")
        self._speeds: list[dict[str, Any]] = []

    def _read(self) -> None:
        hass = self.tank.hass
        result: list[dict[str, Any]] = []
        for entity_id in self.tank.monitored_speed_entities():
            state = hass.states.get(entity_id)
            if state is None:
                continue
            value = self.tank.read_speed(entity_id)
            unit = (
                "%"
                if entity_id.startswith("fan.")
                else state.attributes.get("unit_of_measurement") or ""
            )
            result.append(
                {
                    "entity_id": entity_id,
                    "name": state.attributes.get("friendly_name") or entity_id,
                    "value": value,
                    "unit": unit,
                    "on": state.state != "off",
                }
            )
        self._speeds = result

    @property
    def native_value(self) -> int:
        return sum(1 for s in self._speeds if s["value"] is not None)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"speeds": self._speeds}

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._read()

        async def _changed(_event: Any) -> None:
            self._read()
            self.async_write_ha_state()

        self.async_on_remove(
            async_track_state_change_event(
                self.hass, self.tank.monitored_speed_entities(), _changed
            )
        )


class OffDurationsSensor(FeedAndWaterEntity, SensorEntity):
    """How many tracked devices are off, with per-device details in the
    attributes for the dashboard table. Polls on HA's default 30 s cycle —
    same cadence as the YAML flavor's time_pattern /30 trigger."""

    _attr_icon = "mdi:timer-off-outline"
    _attr_native_unit_of_measurement = "devices"
    _attr_should_poll = True

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "device_off_durations")
        self._devices: list[dict[str, Any]] = []

    @property
    def native_value(self) -> int:
        return sum(1 for device in self._devices if device["state"] == "off")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"devices": self._devices}

    async def async_update(self) -> None:
        tracked = parse_tracked_devices(self.tank.tracked_devices)
        self._devices = compute_off_durations(
            tracked, self.hass.states.get, dt_util.utcnow()
        )
