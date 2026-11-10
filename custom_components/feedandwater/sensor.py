"""Sensors for a tank: feed/water-change stage machines (with restart
recovery), last-water-change timestamp, and the multi-device off-duration
tracker ported from the YAML flavor's trigger template sensor."""
from __future__ import annotations

from datetime import datetime, timedelta
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
# Heaters/ATOs held off by the running mode, to turn back on afterwards
ATTR_HELD_OFF = "held_off"
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
    if tank.is_maintenance:
        entities.append(MaintenanceSensor(tank))
    if tank.has_equipment:
        entities.append(WaterChangeStatsSensor(tank))
    if tank.equipment_entities():
        entities.append(EquipmentSensor(tank))
    if tank.watched_onoff_entities():
        entities.append(ProblemsSensor(tank))
    if tank.dropout_watched_entities():
        entities.append(DropoutsSensor(tank))
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
            ATTR_HELD_OFF: list(feed.saved_aux),
            "unresponsive": sorted(self.tank.unresponsive),
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self.tank.feed.async_add_listener(self.async_write_ha_state))
        self.async_on_remove(
            self.tank.unresponsive_listeners.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and last.state not in (FEED_IDLE, "unknown", "unavailable"):
            saved = last.attributes.get(ATTR_SAVED_SPEEDS) or {}
            await self.tank.feed.async_restore(
                last.state,
                _parse(last.attributes.get(ATTR_WAVEMAKERS_AT)),
                _parse(last.attributes.get(ATTR_SKIMMER_AT)),
                {str(k): float(v) for k, v in saved.items()},
                [str(e) for e in (last.attributes.get(ATTR_HELD_OFF) or [])],
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
            ATTR_HELD_OFF: list(water.saved_aux),
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
                [str(e) for e in (last.attributes.get(ATTR_HELD_OFF) or [])],
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
        return {
            ATTR_OFF_AT: _iso(lights.off_at) if lights else None,
            "unresponsive": sorted(self.tank.unresponsive),
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self.tank.lights is None:
            return
        self.async_on_remove(
            self.tank.lights.async_add_listener(self.async_write_ha_state)
        )
        self.async_on_remove(
            self.tank.unresponsive_listeners.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and last.state not in (LIGHTS_OFF, "unknown", "unavailable"):
            await self.tank.lights.async_restore(
                last.state, _parse(last.attributes.get(ATTR_OFF_AT))
            )


class PumpSpeedsSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """At-a-glance speeds for every monitored pump (feed-mode speed
    controls + display-only additions). Event-driven: updates the instant
    any underlying speed changes. State = number of readable pumps;
    per-pump details live in the `speeds` attribute, and the Speed card's
    per-pump pause timers persist through the `paused` attribute (restored
    after HA restarts, overdue resumes running immediately)."""

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
        return {
            "speeds": self._speeds,
            "paused": {
                entity_id: _iso(resume_at)
                for entity_id, resume_at in self.tank.pump_pauses.items()
            },
            "unresponsive": sorted(self.tank.unresponsive),
        }

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
        self.async_on_remove(
            self.tank.pump_pause_listeners.async_add_listener(self.async_write_ha_state)
        )
        self.async_on_remove(
            self.tank.unresponsive_listeners.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and not self.tank.pump_pauses:
            paused = last.attributes.get("paused") or {}
            if paused:
                await self.tank.async_restore_pump_pauses(paused)


class MaintenanceSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """Timestamp of when this maintenance task was last done, with the
    linked status entity (if any) exposed as an attribute so the card can
    show live device state (e.g. an ATO run-dry binary sensor)."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:wrench-clock"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "last_done")

    @property
    def native_value(self) -> datetime | None:
        return self.tank.maintenance_last_done

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        from .const import CONF_MAINT_ACTIONS, CONF_MAINT_STATUS

        return {
            "status_entity": self.tank.entry.options.get(CONF_MAINT_STATUS),
            "action_entities": self.tank.option_entities(CONF_MAINT_ACTIONS),
            "interval_days": self.tank.maintenance_interval_days,
            "due_at": _iso(self.tank.maintenance_due_at),
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.maintenance_done_listeners.async_add_listener(
                self.async_write_ha_state
            )
        )
        last = await self.async_get_last_state()
        if last is not None:
            self.tank.async_maintenance_restore(_parse(last.state))


class WaterChangeStatsSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """Rolling water-change stats from the per-change log: state = litres
    changed in the last 30 days; attributes add the change count, the
    weekly percentage of tank volume (when the tank's volume is set in
    its Configure dialog), the average interval, and the recent log. The
    log persists across HA restarts via the restored attributes."""

    _attr_icon = "mdi:chart-line-variant"
    _attr_native_unit_of_measurement = "L"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "water_change_stats")

    def _recent(self) -> list[dict[str, Any]]:
        cutoff = dt_util.utcnow() - timedelta(days=30)
        out = []
        for entry in self.tank.water_change_log:
            at = dt_util.parse_datetime(str(entry.get("at") or ""))
            if at is not None and at >= cutoff:
                out.append(entry)
        return out

    @property
    def native_value(self) -> float:
        return round(sum(float(e.get("volume_l") or 0) for e in self._recent()), 1)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        recent = self._recent()
        volume_30d = sum(float(e.get("volume_l") or 0) for e in recent)
        tank_volume = self.tank.tank_volume_l
        weekly_pct = (
            round((volume_30d / 30 * 7) / tank_volume * 100, 1)
            if tank_volume > 0
            else None
        )
        stamps = [
            dt_util.parse_datetime(str(e.get("at") or ""))
            for e in self.tank.water_change_log
        ]
        stamps = [s for s in stamps if s is not None]
        avg_interval = (
            round((stamps[-1] - stamps[0]).total_seconds() / 86400 / (len(stamps) - 1), 1)
            if len(stamps) >= 2
            else None
        )
        return {
            "changes_30d": len(recent),
            "volume_30d_l": round(volume_30d, 1),
            "tank_volume_l": tank_volume or None,
            "weekly_pct_of_tank": weekly_pct,
            "avg_interval_days": avg_interval,
            "log": list(self.tank.water_change_log)[-20:],
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.last_water_change_listeners.async_add_listener(
                self.async_write_ha_state
            )
        )
        last = await self.async_get_last_state()
        if last is not None and not self.tank.water_change_log:
            restored = last.attributes.get("log") or []
            if restored:
                self.tank.water_change_log.extend(restored)
                del self.tank.water_change_log[:-40]


class EquipmentSensor(FeedAndWaterEntity, SensorEntity):
    """Live status of the Equipment card's devices (dosers, ATO, heaters…).
    State = how many are unavailable/missing (0 = all good — handy for
    automations and future notifications); per-device details live in
    the `devices` attribute. Event-driven like the pump speeds sensor."""

    _attr_icon = "mdi:power-plug-outline"
    _attr_native_unit_of_measurement = "unavailable"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "equipment")
        self._devices: list[dict[str, Any]] = []

    def _read(self) -> None:
        hass = self.tank.hass
        result: list[dict[str, Any]] = []
        for entity_id in self.tank.equipment_entities():
            state = hass.states.get(entity_id)
            available = state is not None and state.state not in (
                "unavailable",
                "unknown",
            )
            result.append(
                {
                    "entity_id": entity_id,
                    "name": (state and state.attributes.get("friendly_name"))
                    or entity_id,
                    "domain": entity_id.split(".", 1)[0],
                    "state": state.state if state else None,
                    "available": available,
                    "unit": (state and state.attributes.get("unit_of_measurement"))
                    or "",
                    "device_class": (state and state.attributes.get("device_class"))
                    or None,
                    "last_changed": state.last_changed.isoformat() if state else None,
                }
            )
        self._devices = result

    @property
    def native_value(self) -> int:
        return sum(1 for d in self._devices if not d["available"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"devices": self._devices}

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._read()

        async def _changed(_event: Any) -> None:
            self._read()
            self.async_write_ha_state()

        self.async_on_remove(
            async_track_state_change_event(
                self.hass, self.tank.equipment_entities(), _changed
            )
        )


class ProblemsSensor(FeedAndWaterEntity, SensorEntity):
    """How many of this entry's devices are not doing what they were told
    (commanded on/off, device disagrees after verification + watchdog
    retries). 0 = all good — automate a phone notification on > 0."""

    _attr_icon = "mdi:alert-circle-outline"
    _attr_native_unit_of_measurement = "devices"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "problems")

    @property
    def native_value(self) -> int:
        return len(self.tank.unresponsive)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        names = []
        for entity_id in sorted(self.tank.unresponsive):
            state = self.hass.states.get(entity_id)
            names.append(
                (state and state.attributes.get("friendly_name")) or entity_id
            )
        return {
            "entities": sorted(self.tank.unresponsive),
            "names": names,
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.unresponsive_listeners.async_add_listener(
                self.async_write_ha_state
            )
        )


class DropoutsSensor(FeedAndWaterEntity, RestoreEntity, SensorEntity):
    """How many times this entry's devices have dropped off the network
    (gone unavailable), with per-device detail in the attributes: count,
    last seen, whether it is offline right now, and the recent outages
    with durations. Turns "the devices seem flaky" into which device,
    when, and for how long. Persists across HA restarts."""

    _attr_icon = "mdi:wifi-strength-alert-outline"
    _attr_native_unit_of_measurement = "dropouts"

    def __init__(self, tank: TankData) -> None:
        super().__init__(tank, "sensor", "dropouts")

    @property
    def native_value(self) -> int:
        return sum(self.tank.dropout_counts.values())

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        hass = self.tank.hass
        devices: dict[str, Any] = {}
        for entity_id in self.tank.dropout_watched_entities():
            count = self.tank.dropout_counts.get(entity_id, 0)
            offline_since = self.tank.dropout_offline_since.get(entity_id)
            events = self.tank.dropout_events.get(entity_id) or []
            last_seen = self.tank.dropout_last_seen.get(entity_id)
            if not count and offline_since is None and not events:
                continue
            state = hass.states.get(entity_id)
            devices[entity_id] = {
                "name": (state and state.attributes.get("friendly_name"))
                or entity_id,
                "count": count,
                "last_seen": _iso(last_seen),
                "offline_since": _iso(offline_since),
                "recent": list(events),
            }
        return {
            "offline_now": sorted(self.tank.dropout_offline_since),
            "devices": devices,
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.tank.dropout_listeners.async_add_listener(self.async_write_ha_state)
        )
        last = await self.async_get_last_state()
        if last is not None and last.state not in ("unknown", "unavailable"):
            self.tank.async_dropout_restore(dict(last.attributes))


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
