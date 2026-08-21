"""Reef Feed & Water — vendor-agnostic reef tank orchestration.

One config entry per tank. TankData (controllers + shared values) is built
once, stored in hass.data[DOMAIN][entry_id], then platforms are forwarded —
same lifecycle shape as the maintainer's jebao_local integration.
"""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .controllers import TankData
from .frontend import async_register_card

PLATFORMS = [
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.TEXT,
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    tank = TankData(hass, entry)
    if tank.power:
        tank.power.async_setup()
    if tank.lights:
        tank.lights.async_setup()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = tank

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await async_register_card(hass)
    _async_register_services(hass)
    return True


def _async_register_services(hass: HomeAssistant) -> None:
    """Domain-wide services used by the Speed card's per-pump pause timers
    (registered once, idempotent)."""
    if hass.data.get("feedandwater_services_registered"):
        return
    hass.data["feedandwater_services_registered"] = True

    def _find_tank(entity_id: str) -> TankData | None:
        for tank in hass.data.get(DOMAIN, {}).values():
            if isinstance(tank, TankData) and entity_id in tank.monitored_speed_entities():
                return tank
        return None

    async def _pause_pump(call) -> None:
        entity_id = call.data["entity_id"]
        minutes = float(call.data.get("minutes", 0))
        tank = _find_tank(entity_id)
        if tank is None:
            raise ValueError(
                f"{entity_id} is not a monitored pump of any Reef Feed & Water tank"
            )
        await tank.async_pause_pump(entity_id, minutes)

    async def _resume_pump(call) -> None:
        entity_id = call.data["entity_id"]
        tank = _find_tank(entity_id)
        if tank is None:
            raise ValueError(
                f"{entity_id} is not a monitored pump of any Reef Feed & Water tank"
            )
        await tank.async_resume_pump(entity_id)

    hass.services.async_register(DOMAIN, "pause_pump", _pause_pump)
    hass.services.async_register(DOMAIN, "resume_pump", _resume_pump)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        tank: TankData = hass.data[DOMAIN].pop(entry.entry_id)
        tank.async_shutdown()
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Options changed (tank rewired) — reload the entry."""
    await hass.config_entries.async_reload(entry.entry_id)
