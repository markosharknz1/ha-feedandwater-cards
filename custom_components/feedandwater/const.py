"""Constants for the Reef Feed & Water integration."""
from __future__ import annotations

DOMAIN = "feedandwater"

# Config entry data (immutable identity)
CONF_SLUG = "slug"

# Config entry options (hardware wiring — editable via OptionsFlow)
CONF_WAVEMAKERS = "wavemakers"
CONF_SKIMMERS = "skimmers"
CONF_RETURN_PUMPS = "return_pumps"
CONF_PUMP_SPEED_CONTROLS = "pump_speed_controls"
CONF_POWER_SENSOR = "power_sensor"

# TankData.values keys — one per settings number entity
VALUE_FEED_DURATION = "feed_duration"
VALUE_RETURN_PUMP_FEED_SPEED = "return_pump_feed_speed"
VALUE_SKIMMER_EXTRA_OFF = "skimmer_extra_off"
VALUE_WAVEMAKER_RESTART_DELAY = "wavemaker_restart_delay"
VALUE_SKIMMER_RESTART_DELAY = "skimmer_restart_delay"
VALUE_POWER_LOSS_DELAY = "power_loss_delay"
VALUE_LAST_WATER_CHANGE_VOLUME = "last_water_change_volume"

# (default, min, max, step, unit) per number entity
NUMBER_SPECS: dict[str, tuple[float, float, float, float, str]] = {
    VALUE_FEED_DURATION: (20, 1, 60, 1, "min"),
    VALUE_RETURN_PUMP_FEED_SPEED: (30, 0, 100, 5, "%"),
    VALUE_SKIMMER_EXTRA_OFF: (10, 0, 30, 1, "min"),
    VALUE_WAVEMAKER_RESTART_DELAY: (5, 0, 30, 1, "min"),
    VALUE_SKIMMER_RESTART_DELAY: (10, 0, 30, 1, "min"),
    VALUE_POWER_LOSS_DELAY: (5, 0, 60, 1, "min"),
    VALUE_LAST_WATER_CHANGE_VOLUME: (0, 0, 500, 1, "L"),
}

# "Until I Stop" starts a feed at the max duration rather than a true
# no-timer mode — the user always taps Stop Feeding first in practice, and
# the early-cancel path (immediate restore + skimmer buffer) handles it.
MAX_FEED_MINUTES = 60

# Water change safety timeout: if a pause is left on this long, the staged
# restart force-runs (same guard the YAML blueprint has, fixed at its
# default rather than exposed as a setting in v1).
SAFETY_TIMEOUT_HOURS = 2

# Feed stages
FEED_IDLE = "idle"
FEED_FEEDING = "feeding"
FEED_SETTLING = "settling"

# Water change stages
WC_IDLE = "idle"
WC_PAUSED = "paused"
WC_RESTARTING_WAVEMAKERS = "restarting_wavemakers"
WC_RESTARTING_SKIMMER = "restarting_skimmer"
