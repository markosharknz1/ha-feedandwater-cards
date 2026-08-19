"""Action buttons for a tank — the tap targets the compact dashboard cards
use (Start Feed / Until I Stop / Stop Feeding / water change / log)."""
from __future__ import annotations

from collections.abc import Awaitable, Callable

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, MAX_FEED_MINUTES, VALUE_FEED_DURATION
from .controllers import TankData
from .entity import FeedAndWaterEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    tank: TankData = hass.data[DOMAIN][entry.entry_id]

    async def start_feed() -> None:
        await tank.feed.async_start(tank.values[VALUE_FEED_DURATION])

    async def feed_until_stop() -> None:
        # Max duration rather than a true no-timer mode — same approach the
        # YAML flavor's start_feed_indefinite script takes; Stop Feeding's
        # early-cancel path handles ending it.
        await tank.feed.async_start(MAX_FEED_MINUTES)

    async def stop_feed() -> None:
        await tank.feed.async_cancel()

    async def start_water_change() -> None:
        await tank.water.async_pause()

    async def resume_water_change() -> None:
        await tank.water.async_resume()

    async def log_water_change() -> None:
        tank.async_log_water_change()

    # Feed/water-change buttons only exist for tanks with pause/resume
    # hardware — a lights-only entry gets just its light buttons.
    buttons = []
    if tank.has_equipment:
        buttons += [
            ("start_feed", "mdi:food-drumstick", start_feed),
            ("feed_until_stop", "mdi:infinity", feed_until_stop),
            ("stop_feed", "mdi:stop-circle-outline", stop_feed),
            ("start_water_change", "mdi:water-sync", start_water_change),
            ("resume_water_change", "mdi:play-circle-outline", resume_water_change),
            ("log_water_change", "mdi:calendar-check", log_water_change),
        ]

    if tank.lights is not None:
        lights = tank.lights

        async def lights_on() -> None:
            await lights.async_turn_on()

        async def lights_off() -> None:
            await lights.async_turn_off()

        buttons += [
            ("lights_on", "mdi:lightbulb-on-outline", lights_on),
            ("lights_off", "mdi:lightbulb-off-outline", lights_off),
        ]

    if tank.is_maintenance:

        async def run_maintenance() -> None:
            await tank.async_run_maintenance()

        buttons.append(("done", "mdi:check-circle-outline", run_maintenance))

    async_add_entities(
        TankButton(tank, suffix, icon, action) for suffix, icon, action in buttons
    )


class TankButton(FeedAndWaterEntity, ButtonEntity):
    def __init__(
        self,
        tank: TankData,
        suffix: str,
        icon: str,
        action: Callable[[], Awaitable[None]],
    ) -> None:
        super().__init__(tank, "button", suffix)
        self._attr_icon = icon
        self._action = action

    async def async_press(self) -> None:
        await self._action()
