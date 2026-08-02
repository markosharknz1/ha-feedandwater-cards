"""Base entity for the Reef Feed & Water integration."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .controllers import TankData


class FeedAndWaterEntity(Entity):
    """One HA device per tank (config entry) groups all of its entities.

    The object_id is anchored to the tank slug so entity_ids come out
    predictable (`number.reef_feed_duration`, `button.reef_start_feed`, ...)
    — the same `<slug>_*` naming guarantee the YAML flavor gives, which the
    documented dashboard card snippets rely on. Setting self.entity_id
    before add is the mechanism that works across HA versions: 2026.7+
    removed `_attr_suggested_object_id` and derives the suggestion from a
    pre-set entity_id instead, while older versions honor it too.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, tank: TankData, domain: str, suffix: str) -> None:
        self.tank = tank
        self._attr_unique_id = f"{tank.entry.entry_id}_{suffix}"
        self.entity_id = f"{domain}.{tank.slug}_{suffix}"
        self._attr_translation_key = suffix
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, tank.entry.entry_id)},
            name=tank.entry.title,
            manufacturer="Reef Feed & Water",
            model="Tank pack",
        )
