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

PLATFORMS = [Platform.BUTTON, Platform.NUMBER, Platform.SENSOR, Platform.TEXT]


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
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        tank: TankData = hass.data[DOMAIN].pop(entry.entry_id)
        tank.async_shutdown()
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Options changed (tank rewired) — reload the entry."""
    await hass.config_entries.async_reload(entry.entry_id)
