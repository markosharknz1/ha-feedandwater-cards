"""Per-tank orchestration logic — the Python port of the YAML flavor's
three automation blueprints (reef_feed_mode, reef_water_change_mode,
reef_skimmer_power_delay). Behavior was live-verified in blueprint form
against a real HA instance before this port; the sequencing rules below
must stay identical to the blueprints unless both are changed together.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import (
    async_call_later,
    async_track_point_in_time,
    async_track_state_change_event,
)
from homeassistant.util import dt as dt_util

from .const import (
    CONF_KIND,
    CONF_LIGHTS,
    CONF_MAINT_ACTIONS,
    CONF_POWER_SENSOR,
    CONF_PUMP_SPEED_CONTROLS,
    CONF_SPEED_DISPLAYS,
    KIND_MAINTENANCE,
    CONF_RETURN_PUMPS,
    CONF_SKIMMERS,
    CONF_SLUG,
    CONF_WAVEMAKERS,
    FEED_FEEDING,
    FEED_IDLE,
    FEED_SETTLING,
    LIGHTS_OFF,
    LIGHTS_ON,
    LIGHTS_ON_TIMED,
    NUMBER_SPECS,
    SAFETY_TIMEOUT_HOURS,
    VALUE_LIGHT_TIMER,
    VALUE_POWER_LOSS_DELAY,
    VALUE_RETURN_PUMP_FEED_SPEED,
    VALUE_SKIMMER_EXTRA_OFF,
    VALUE_SKIMMER_RESTART_DELAY,
    VALUE_WAVEMAKER_RESTART_DELAY,
    WC_IDLE,
    WC_PAUSED,
    WC_RESTARTING_SKIMMER,
    WC_RESTARTING_WAVEMAKERS,
)


class _Notifier:
    """Minimal listener registry: stage sensors subscribe to be told when
    controller state changes so they can write their HA state."""

    def __init__(self) -> None:
        self._listeners: list[Callable[[], None]] = []

    @callback
    def async_add_listener(self, cb: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(cb)

        def _remove() -> None:
            if cb in self._listeners:
                self._listeners.remove(cb)

        return _remove

    @callback
    def _notify(self) -> None:
        for cb in list(self._listeners):
            cb()


@dataclass
class TankData:
    """Everything for one tank (one config entry), shared by all platforms.

    Number/text entities write their current values in here (instead of the
    controllers depending on entity_ids, which users can rename) and the
    controllers read from it.
    """

    hass: HomeAssistant
    entry: ConfigEntry
    values: dict[str, float] = field(
        default_factory=lambda: {key: spec[0] for key, spec in NUMBER_SPECS.items()}
    )
    tracked_devices: str = ""
    last_water_change: datetime | None = None
    last_water_change_listeners: _Notifier = field(default_factory=_Notifier)
    maintenance_last_done: datetime | None = None
    maintenance_done_listeners: _Notifier = field(default_factory=_Notifier)
    # Per-pump pause timers (Speed card: "off for X minutes, then back on";
    # None = off until resumed manually)
    pump_pauses: dict[str, datetime | None] = field(default_factory=dict)
    pump_pause_listeners: _Notifier = field(default_factory=_Notifier)
    _pump_pause_unsubs: dict[str, Callable[[], None]] = field(default_factory=dict)
    # Devices that didn't reach their commanded state (dead plug, lost
    # WiFi, ...) — surfaced as warnings on the cards rather than silently
    # trusting the command.
    unresponsive: set[str] = field(default_factory=set)
    unresponsive_listeners: _Notifier = field(default_factory=_Notifier)
    _verify_unsubs: dict[object, Callable[[], None]] = field(default_factory=dict)
    # Latest commanded state per entity — checks validate against this, not
    # the state captured at schedule time, so a quick off→on flip (e.g. a
    # short pump pause) can't leave a stale check raising a false warning.
    _verify_expected: dict[str, str] = field(default_factory=dict)
    feed: "FeedController" = field(init=False)
    water: "WaterChangeController" = field(init=False)
    power: "PowerLossController | None" = field(init=False, default=None)
    lights: "LightController | None" = field(init=False, default=None)

    def __post_init__(self) -> None:
        self.feed = FeedController(self)
        self.water = WaterChangeController(self)
        if self.entry.options.get(CONF_POWER_SENSOR):
            self.power = PowerLossController(self)
        if self.entry.options.get(CONF_LIGHTS):
            self.lights = LightController(self)

    @property
    def slug(self) -> str:
        return self.entry.data[CONF_SLUG]

    @property
    def has_equipment(self) -> bool:
        """Whether any pause/resume hardware is configured — gates the
        feed and water-change features (a lights-only entry has none)."""
        return any(
            self.option_entities(key)
            for key in (CONF_WAVEMAKERS, CONF_SKIMMERS, CONF_RETURN_PUMPS)
        )

    @property
    def is_maintenance(self) -> bool:
        """Whether this entry is a maintenance task (fleece roll, ATO
        reset, …) rather than a tank/light."""
        return self.entry.data.get(CONF_KIND) == KIND_MAINTENANCE

    async def async_run_maintenance(self) -> None:
        """Fire the task's linked action entities (if any), then stamp the
        last-done timestamp. Buttons get pressed; switches/scripts get
        turned on — vendor-agnostic, same as everything else here."""
        for entity_id in self.option_entities(CONF_MAINT_ACTIONS):
            domain = entity_id.split(".", 1)[0]
            if domain == "button":
                await self.hass.services.async_call(
                    "button", "press", {"entity_id": entity_id}, blocking=True
                )
            else:
                await self.hass.services.async_call(
                    "homeassistant", "turn_on", {"entity_id": entity_id}, blocking=True
                )
        self.maintenance_last_done = dt_util.utcnow()
        self.maintenance_done_listeners._notify()

    def option_entities(self, key: str) -> list[str]:
        value = self.entry.options.get(key) or []
        if isinstance(value, str):
            return [value]
        return list(value)

    # How long after a command before checking the device actually obeyed —
    # long enough for slow-polling plug integrations to report back.
    VERIFY_DELAY_S = 15

    async def async_turn(self, service: str, entity_ids: list[str]) -> None:
        """homeassistant.turn_on/turn_off — domain-agnostic on purpose, the
        same guarantee the blueprints give (switch and fan both work).

        Every command is verified ~15 s later: devices that never reached
        the commanded state (dead plug, lost WiFi) land in
        self.unresponsive and show as warnings on the cards."""
        if not entity_ids:
            return
        await self.hass.services.async_call(
            "homeassistant", service, {"entity_id": entity_ids}, blocking=True
        )
        self._schedule_turn_verify(entity_ids, expect_on=service == "turn_on")

    def _schedule_turn_verify(self, entity_ids: list[str], expect_on: bool) -> None:
        # Only stateful on/off domains can be verified this way (scripts,
        # for example, return to "off" by design).
        checkable = [
            entity_id
            for entity_id in entity_ids
            if entity_id.split(".", 1)[0] in ("switch", "fan", "light")
        ]
        if not checkable:
            return

        token = object()
        for entity_id in checkable:
            self._verify_expected[entity_id] = "on" if expect_on else "off"

        async def _check(_now: datetime) -> None:
            self._verify_unsubs.pop(token, None)
            changed = False
            for entity_id in checkable:
                expected = self._verify_expected.get(entity_id)
                if expected is None:
                    continue
                state = self.hass.states.get(entity_id)
                ok = state is not None and state.state == expected
                if not ok and entity_id not in self.unresponsive:
                    self.unresponsive.add(entity_id)
                    changed = True
                elif ok and entity_id in self.unresponsive:
                    self.unresponsive.discard(entity_id)
                    changed = True
            if changed:
                self.unresponsive_listeners._notify()

        self._verify_unsubs[token] = async_call_later(
            self.hass, self.VERIFY_DELAY_S, _check
        )

    async def async_set_speed(self, entity_id: str, value: float) -> None:
        """Set a speed control: number entities get a raw set_value; fan
        entities (pumps whose integration merges power+speed, e.g. newer
        Jebao builds) get their percentage set."""
        if entity_id.startswith("fan."):
            await self.hass.services.async_call(
                "fan",
                "set_percentage",
                {"entity_id": entity_id, "percentage": int(round(value))},
                blocking=True,
            )
            return
        await self.hass.services.async_call(
            "number", "set_value", {"entity_id": entity_id, "value": value}, blocking=True
        )

    def monitored_speed_entities(self) -> list[str]:
        """Every pump speed worth showing at a glance: the feed-mode speed
        controls plus any display-only additions, deduplicated in order."""
        seen: list[str] = []
        for key in (CONF_PUMP_SPEED_CONTROLS, CONF_SPEED_DISPLAYS):
            for entity_id in self.option_entities(key):
                if entity_id not in seen:
                    seen.append(entity_id)
        return seen

    def read_speed(self, entity_id: str) -> float | None:
        """Current value of a speed control, or None if unreadable."""
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            return None
        if entity_id.startswith("fan."):
            pct = state.attributes.get("percentage")
            return float(pct) if pct is not None else None
        try:
            return float(state.state)
        except ValueError:
            return None

    @callback
    def async_log_water_change(self) -> None:
        self.last_water_change = dt_util.utcnow()
        self.last_water_change_listeners._notify()

    # --- Speed-card pump pauses -----------------------------------------

    def _cancel_pump_timer(self, entity_id: str) -> None:
        unsub = self._pump_pause_unsubs.pop(entity_id, None)
        if unsub:
            unsub()

    async def async_pause_pump(self, entity_id: str, minutes: float) -> None:
        """Turn one monitored pump off; minutes > 0 schedules the automatic
        turn-back-on, 0 keeps it off until resumed manually."""
        self._cancel_pump_timer(entity_id)
        await self.async_turn("turn_off", [entity_id])
        resume_at = (
            dt_util.utcnow() + timedelta(minutes=minutes) if minutes > 0 else None
        )
        self.pump_pauses[entity_id] = resume_at
        if resume_at is not None:
            self._schedule_pump_resume(entity_id, resume_at)
        self.pump_pause_listeners._notify()

    async def async_resume_pump(self, entity_id: str) -> None:
        self._cancel_pump_timer(entity_id)
        self.pump_pauses.pop(entity_id, None)
        await self.async_turn("turn_on", [entity_id])
        self.pump_pause_listeners._notify()

    def _schedule_pump_resume(self, entity_id: str, resume_at: datetime) -> None:
        async def _fire(_now: datetime) -> None:
            self._pump_pause_unsubs.pop(entity_id, None)
            await self.async_resume_pump(entity_id)

        self._pump_pause_unsubs[entity_id] = async_track_point_in_time(
            self.hass, _fire, resume_at
        )

    async def async_restore_pump_pauses(self, paused: dict[str, Any]) -> None:
        """Rebuild pause timers after an HA restart (same overdue-runs-now,
        future-reschedules contract as the other controllers)."""
        now = dt_util.utcnow()
        for entity_id, iso in paused.items():
            if entity_id not in self.monitored_speed_entities():
                continue
            resume_at = dt_util.parse_datetime(str(iso)) if iso else None
            if resume_at is not None and resume_at <= now:
                await self.async_resume_pump(entity_id)
            else:
                self.pump_pauses[entity_id] = resume_at
                if resume_at is not None:
                    self._schedule_pump_resume(entity_id, resume_at)
        self.pump_pause_listeners._notify()

    @callback
    def async_shutdown(self) -> None:
        self.feed.async_shutdown()
        self.water.async_shutdown()
        if self.power:
            self.power.async_shutdown()
        if self.lights:
            self.lights.async_shutdown()
        for entity_id in list(self._pump_pause_unsubs):
            self._cancel_pump_timer(entity_id)
        for unsub in self._verify_unsubs.values():
            unsub()
        self._verify_unsubs.clear()


class FeedController(_Notifier):
    """Feed mode: wavemakers pause, return pump speed drops, skimmer pauses
    longer. Mirrors reef_feed_mode.yaml exactly:

    - start: save pump speeds -> wavemakers+skimmer off -> speeds to feed
      value -> wavemakers resume at T+duration, skimmer (+speed restore) at
      T+duration+extra.
    - cancel early: wavemakers + speeds restore NOW, but the skimmer is
      re-timed for a full extra-buffer from the moment of cancellation —
      never turned straight back on.
    """

    def __init__(self, tank: TankData) -> None:
        super().__init__()
        self.tank = tank
        self.stage = FEED_IDLE
        self.wavemakers_resume_at: datetime | None = None
        self.skimmer_resume_at: datetime | None = None
        self.saved_speeds: dict[str, float] = {}
        self._unsub_wavemakers: Callable[[], None] | None = None
        self._unsub_skimmer: Callable[[], None] | None = None

    async def async_start(self, minutes: float) -> None:
        if self.stage != FEED_IDLE:
            return
        tank = self.tank
        extra = tank.values[VALUE_SKIMMER_EXTRA_OFF]
        now = dt_util.utcnow()

        # Save current pump speeds so they can be restored later
        self.saved_speeds = {}
        for entity_id in tank.option_entities(CONF_PUMP_SPEED_CONTROLS):
            value = tank.read_speed(entity_id)
            if value is not None:
                self.saved_speeds[entity_id] = value

        await tank.async_turn("turn_off", tank.option_entities(CONF_WAVEMAKERS))
        await tank.async_turn("turn_off", tank.option_entities(CONF_SKIMMERS))
        feed_speed = tank.values[VALUE_RETURN_PUMP_FEED_SPEED]
        for entity_id in self.saved_speeds:
            await tank.async_set_speed(entity_id, feed_speed)

        self.stage = FEED_FEEDING
        self.wavemakers_resume_at = now + timedelta(minutes=minutes)
        self.skimmer_resume_at = now + timedelta(minutes=minutes + extra)
        self._schedule()
        self._notify()

    async def async_cancel(self) -> None:
        """Stop Feeding pressed: restore wavemakers + speeds immediately,
        skimmer still waits a full buffer re-timed from now."""
        if self.stage == FEED_IDLE:
            return
        tank = self.tank
        self._cancel_timers()
        await tank.async_turn("turn_on", tank.option_entities(CONF_WAVEMAKERS))
        await self._async_restore_speeds()
        self.stage = FEED_SETTLING
        self.wavemakers_resume_at = None
        self.skimmer_resume_at = dt_util.utcnow() + timedelta(
            minutes=tank.values[VALUE_SKIMMER_EXTRA_OFF]
        )
        self._schedule()
        self._notify()

    async def _async_wavemakers_done(self, _now: datetime) -> None:
        self._unsub_wavemakers = None
        await self.tank.async_turn("turn_on", self.tank.option_entities(CONF_WAVEMAKERS))
        self.stage = FEED_SETTLING
        self.wavemakers_resume_at = None
        self._notify()

    async def _async_skimmer_done(self, _now: datetime) -> None:
        self._unsub_skimmer = None
        await self.tank.async_turn("turn_on", self.tank.option_entities(CONF_SKIMMERS))
        await self._async_restore_speeds()
        self.stage = FEED_IDLE
        self.wavemakers_resume_at = None
        self.skimmer_resume_at = None
        self._notify()

    async def _async_restore_speeds(self) -> None:
        for entity_id, value in self.saved_speeds.items():
            await self.tank.async_set_speed(entity_id, value)
        self.saved_speeds = {}

    def _schedule(self) -> None:
        self._cancel_timers()
        if self.wavemakers_resume_at is not None:
            self._unsub_wavemakers = async_track_point_in_time(
                self.tank.hass, self._async_wavemakers_done, self.wavemakers_resume_at
            )
        if self.skimmer_resume_at is not None:
            self._unsub_skimmer = async_track_point_in_time(
                self.tank.hass, self._async_skimmer_done, self.skimmer_resume_at
            )

    def _cancel_timers(self) -> None:
        if self._unsub_wavemakers:
            self._unsub_wavemakers()
            self._unsub_wavemakers = None
        if self._unsub_skimmer:
            self._unsub_skimmer()
            self._unsub_skimmer = None

    async def async_restore(
        self,
        stage: str,
        wavemakers_resume_at: datetime | None,
        skimmer_resume_at: datetime | None,
        saved_speeds: dict[str, float],
    ) -> None:
        """Rebuild an in-flight sequence after HA restart/reload: overdue
        actions run immediately, future ones are rescheduled. This is a
        capability the blueprint flavor doesn't have (its `delay:` steps die
        with a restart)."""
        if stage == FEED_IDLE:
            return
        self.saved_speeds = dict(saved_speeds)
        now = dt_util.utcnow()

        if stage == FEED_FEEDING and wavemakers_resume_at is not None:
            if wavemakers_resume_at <= now:
                await self.tank.async_turn(
                    "turn_on", self.tank.option_entities(CONF_WAVEMAKERS)
                )
                stage = FEED_SETTLING
                wavemakers_resume_at = None
            else:
                self.stage = FEED_FEEDING
                self.wavemakers_resume_at = wavemakers_resume_at
                self.skimmer_resume_at = skimmer_resume_at
                self._schedule()
                self._notify()
                return

        if stage == FEED_SETTLING:
            if skimmer_resume_at is None or skimmer_resume_at <= now:
                await self.tank.async_turn(
                    "turn_on", self.tank.option_entities(CONF_SKIMMERS)
                )
                await self._async_restore_speeds()
                self.stage = FEED_IDLE
            else:
                self.stage = FEED_SETTLING
                self.skimmer_resume_at = skimmer_resume_at
                self._schedule()
            self._notify()

    @callback
    def async_shutdown(self) -> None:
        self._cancel_timers()


class WaterChangeController(_Notifier):
    """Water change: instant pause of all three device groups; resume runs
    the staged restart (pumps now -> wavemakers +delay1 -> skimmer +delay2).
    Mirrors reef_water_change_mode.yaml, including the safety timeout that
    force-runs the restart if a pause is left on too long."""

    def __init__(self, tank: TankData) -> None:
        super().__init__()
        self.tank = tank
        self.stage = WC_IDLE
        self.wavemakers_restart_at: datetime | None = None
        self.skimmer_restart_at: datetime | None = None
        self.safety_at: datetime | None = None
        self._unsub_wavemakers: Callable[[], None] | None = None
        self._unsub_skimmer: Callable[[], None] | None = None
        self._unsub_safety: Callable[[], None] | None = None

    async def async_pause(self) -> None:
        if self.stage != WC_IDLE:
            return
        tank = self.tank
        await tank.async_turn("turn_off", tank.option_entities(CONF_RETURN_PUMPS))
        await tank.async_turn("turn_off", tank.option_entities(CONF_WAVEMAKERS))
        await tank.async_turn("turn_off", tank.option_entities(CONF_SKIMMERS))
        self.stage = WC_PAUSED
        self.safety_at = dt_util.utcnow() + timedelta(hours=SAFETY_TIMEOUT_HOURS)
        self._schedule()
        self._notify()

    async def async_resume(self) -> None:
        if self.stage != WC_PAUSED:
            return
        tank = self.tank
        self._cancel_timers()
        self.safety_at = None

        # Stage 1: return pump(s) restart immediately
        await tank.async_turn("turn_on", tank.option_entities(CONF_RETURN_PUMPS))
        now = dt_util.utcnow()
        delay1 = tank.values[VALUE_WAVEMAKER_RESTART_DELAY]
        delay2 = tank.values[VALUE_SKIMMER_RESTART_DELAY]
        self.stage = WC_RESTARTING_WAVEMAKERS
        self.wavemakers_restart_at = now + timedelta(minutes=delay1)
        self.skimmer_restart_at = now + timedelta(minutes=delay1 + delay2)
        self._schedule()
        self._notify()

    async def _async_wavemakers_restart(self, _now: datetime) -> None:
        self._unsub_wavemakers = None
        await self.tank.async_turn("turn_on", self.tank.option_entities(CONF_WAVEMAKERS))
        self.stage = WC_RESTARTING_SKIMMER
        self.wavemakers_restart_at = None
        self._notify()

    async def _async_skimmer_restart(self, _now: datetime) -> None:
        self._unsub_skimmer = None
        await self.tank.async_turn("turn_on", self.tank.option_entities(CONF_SKIMMERS))
        self.stage = WC_IDLE
        self.skimmer_restart_at = None
        self._notify()

    async def _async_safety_fired(self, _now: datetime) -> None:
        """Pause left on too long — force the same staged restart."""
        self._unsub_safety = None
        self.safety_at = None
        await self.async_resume()

    def _schedule(self) -> None:
        self._cancel_timers()
        if self.wavemakers_restart_at is not None:
            self._unsub_wavemakers = async_track_point_in_time(
                self.tank.hass, self._async_wavemakers_restart, self.wavemakers_restart_at
            )
        if self.skimmer_restart_at is not None:
            self._unsub_skimmer = async_track_point_in_time(
                self.tank.hass, self._async_skimmer_restart, self.skimmer_restart_at
            )
        if self.safety_at is not None:
            self._unsub_safety = async_track_point_in_time(
                self.tank.hass, self._async_safety_fired, self.safety_at
            )

    def _cancel_timers(self) -> None:
        for attr in ("_unsub_wavemakers", "_unsub_skimmer", "_unsub_safety"):
            unsub = getattr(self, attr)
            if unsub:
                unsub()
                setattr(self, attr, None)

    async def async_restore(
        self,
        stage: str,
        wavemakers_restart_at: datetime | None,
        skimmer_restart_at: datetime | None,
        safety_at: datetime | None,
    ) -> None:
        if stage == WC_IDLE:
            return
        now = dt_util.utcnow()

        if stage == WC_PAUSED:
            self.stage = WC_PAUSED
            self.safety_at = safety_at
            if safety_at is not None and safety_at <= now:
                await self.async_resume()
            else:
                self._schedule()
                self._notify()
            return

        if stage == WC_RESTARTING_WAVEMAKERS and wavemakers_restart_at is not None:
            if wavemakers_restart_at <= now:
                await self.tank.async_turn(
                    "turn_on", self.tank.option_entities(CONF_WAVEMAKERS)
                )
                stage = WC_RESTARTING_SKIMMER
                wavemakers_restart_at = None
            else:
                self.stage = stage
                self.wavemakers_restart_at = wavemakers_restart_at
                self.skimmer_restart_at = skimmer_restart_at
                self._schedule()
                self._notify()
                return

        if stage == WC_RESTARTING_SKIMMER:
            if skimmer_restart_at is None or skimmer_restart_at <= now:
                await self.tank.async_turn(
                    "turn_on", self.tank.option_entities(CONF_SKIMMERS)
                )
                self.stage = WC_IDLE
            else:
                self.stage = stage
                self.skimmer_restart_at = skimmer_restart_at
                self._schedule()
            self._notify()

    @callback
    def async_shutdown(self) -> None:
        self._cancel_timers()


class LightController(_Notifier):
    """Tap-to-run light timer: turn the tank's light group on, optionally
    auto-off after the "Light timer" slider's duration (0 = stay on until
    turned off manually). Tracks the real device states too, so a light
    toggled at the wall or in another card keeps the stage honest."""

    # How long to wait before checking that a commanded on/off actually
    # reached the device. Long enough for slow-polling plug integrations to
    # report back; short enough that a dead plug (e.g. a Tapo that HA has
    # lost) stops showing a phantom "On" within a reasonable time.
    VERIFY_DELAY_S = 15

    def __init__(self, tank: TankData) -> None:
        super().__init__()
        self.tank = tank
        self.stage = LIGHTS_OFF
        self.off_at: datetime | None = None
        self._unsub_timer: Callable[[], None] | None = None
        self._unsub_listener: Callable[[], None] | None = None
        self._unsub_verify: Callable[[], None] | None = None

    @callback
    def async_setup(self) -> None:
        entities = self.tank.option_entities(CONF_LIGHTS)
        if entities:
            self._unsub_listener = async_track_state_change_event(
                self.tank.hass, entities, self._async_member_changed
            )

    def _any_member_on(self) -> bool:
        return any(
            (state := self.tank.hass.states.get(entity_id)) is not None
            and state.state == "on"
            for entity_id in self.tank.option_entities(CONF_LIGHTS)
        )

    def _schedule_verify(self, expect_on: bool) -> None:
        """Confirm the command actually reached the device — if the plug's
        integration is dead (e.g. HA lost a Tapo), the state never changes
        and the card would otherwise lie about being on/off forever."""
        self._cancel_verify()

        async def _verify(_now: datetime) -> None:
            self._unsub_verify = None
            actually_on = self._any_member_on()
            if expect_on and not actually_on and self.stage != LIGHTS_OFF:
                self._cancel_timer()
                self.stage = LIGHTS_OFF
                self.off_at = None
                self._notify()
            elif not expect_on and actually_on and self.stage == LIGHTS_OFF:
                self.stage = LIGHTS_ON
                self.off_at = None
                self._notify()

        self._unsub_verify = async_call_later(
            self.tank.hass, self.VERIFY_DELAY_S, _verify
        )

    def _cancel_verify(self) -> None:
        if self._unsub_verify:
            self._unsub_verify()
            self._unsub_verify = None

    async def async_turn_on(self) -> None:
        tank = self.tank
        await tank.async_turn("turn_on", tank.option_entities(CONF_LIGHTS))
        minutes = tank.values[VALUE_LIGHT_TIMER]
        self._cancel_timer()
        if minutes > 0:
            self.stage = LIGHTS_ON_TIMED
            self.off_at = dt_util.utcnow() + timedelta(minutes=minutes)
            self._schedule()
        else:
            self.stage = LIGHTS_ON
            self.off_at = None
        self._notify()
        self._schedule_verify(expect_on=True)

    async def async_turn_off(self) -> None:
        self._cancel_timer()
        await self.tank.async_turn("turn_off", self.tank.option_entities(CONF_LIGHTS))
        self.stage = LIGHTS_OFF
        self.off_at = None
        self._notify()
        self._schedule_verify(expect_on=False)

    async def _async_timer_fired(self, _now: datetime) -> None:
        self._unsub_timer = None
        await self.async_turn_off()

    async def _async_member_changed(self, _event: Any) -> None:
        """Keep the stage honest when a light is toggled outside the card
        (wall switch, another dashboard, the plug's own button)."""
        any_on = self._any_member_on()
        if not any_on and self.stage != LIGHTS_OFF:
            self._cancel_timer()
            self.stage = LIGHTS_OFF
            self.off_at = None
            self._notify()
        elif any_on and self.stage == LIGHTS_OFF:
            # Turned on externally — reflect it, but don't start a timer the
            # user never asked for.
            self.stage = LIGHTS_ON
            self.off_at = None
            self._notify()

    def _schedule(self) -> None:
        self._cancel_timer()
        if self.off_at is not None:
            self._unsub_timer = async_track_point_in_time(
                self.tank.hass, self._async_timer_fired, self.off_at
            )

    def _cancel_timer(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None

    async def async_restore(self, stage: str, off_at: datetime | None) -> None:
        if stage == LIGHTS_OFF:
            return
        if stage == LIGHTS_ON_TIMED and off_at is not None:
            if off_at <= dt_util.utcnow():
                await self.async_turn_off()
                return
            self.stage = LIGHTS_ON_TIMED
            self.off_at = off_at
            self._schedule()
        else:
            self.stage = LIGHTS_ON
            self.off_at = None
        self._notify()

    @callback
    def async_shutdown(self) -> None:
        self._cancel_timer()
        self._cancel_verify()
        if self._unsub_listener:
            self._unsub_listener()
            self._unsub_listener = None


class PowerLossController:
    """Optional: when the configured mains/UPS power sensor flips back on,
    delay the skimmer's restart so it doesn't foam over from a sudden
    restart. Mirrors reef_skimmer_power_delay.yaml (mode: restart — a new
    power event re-times a pending restart)."""

    def __init__(self, tank: TankData) -> None:
        self.tank = tank
        self._unsub_listener: Callable[[], None] | None = None
        self._unsub_timer: Callable[[], None] | None = None

    @callback
    def async_setup(self) -> None:
        sensor = self.tank.entry.options.get(CONF_POWER_SENSOR)
        if not sensor:
            return
        self._unsub_listener = async_track_state_change_event(
            self.tank.hass, [sensor], self._async_power_changed
        )

    async def _async_power_changed(self, event: Any) -> None:
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if new_state is None or new_state.state != "on":
            return
        if old_state is not None and old_state.state == "on":
            return
        # Power restored: (re-)schedule the delayed skimmer restart
        if self._unsub_timer:
            self._unsub_timer()
        restart_at = dt_util.utcnow() + timedelta(
            minutes=self.tank.values[VALUE_POWER_LOSS_DELAY]
        )
        self._unsub_timer = async_track_point_in_time(
            self.tank.hass, self._async_restart_skimmer, restart_at
        )

    async def _async_restart_skimmer(self, _now: datetime) -> None:
        self._unsub_timer = None
        await self.tank.async_turn("turn_on", self.tank.option_entities(CONF_SKIMMERS))

    @callback
    def async_shutdown(self) -> None:
        if self._unsub_listener:
            self._unsub_listener()
            self._unsub_listener = None
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
