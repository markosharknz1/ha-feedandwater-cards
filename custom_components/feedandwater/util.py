"""Pure helpers, kept free of Home Assistant imports so plain pytest can
run them (same testing convention as the maintainer's jebao_local repo —
no pytest-homeassistant-custom-component)."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Protocol

SLUG_PATTERN = re.compile(r"[a-z][a-z0-9_]*")


def valid_slug(slug: str) -> bool:
    """Lowercase letters/digits/underscores, starting with a letter —
    identical rule to generate_tank.py in the YAML flavor."""
    return bool(SLUG_PATTERN.fullmatch(slug))


def slugify_name(name: str) -> str:
    """Derive a valid slug from a tank name, so the config flow's prefix
    field can be optional ("Main Display Tank" -> "main_display_tank").

    Returns "" when nothing valid can be derived (e.g. all digits/symbols);
    the caller decides how to error in that case.
    """
    cleaned = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    cleaned = cleaned.lstrip("0123456789_")
    return cleaned if valid_slug(cleaned) else ""


def parse_tracked_devices(raw: str) -> list[str]:
    """Comma-separated entity_ids -> cleaned list."""
    return [item.strip() for item in raw.split(",") if item.strip()]


class _StateLike(Protocol):
    state: str
    last_changed: datetime

    @property
    def attributes(self) -> dict[str, Any]: ...


def compute_off_durations(
    tracked: list[str],
    get_state: Any,
    now: datetime,
) -> list[dict[str, Any]]:
    """Port of the YAML flavor's off-duration Jinja template.

    get_state is hass.states.get (or any callable returning an object with
    .state, .last_changed, .attributes, or None). Entities that are
    missing/unknown/unavailable are skipped, matching the template.
    """
    result: list[dict[str, Any]] = []
    for entity_id in tracked:
        state: _StateLike | None = get_state(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            continue
        off_minutes = 0.0
        if state.state == "off":
            off_minutes = round((now - state.last_changed).total_seconds() / 60, 1)
        result.append(
            {
                "entity_id": entity_id,
                "name": state.attributes.get("friendly_name") or entity_id,
                "state": state.state,
                "off_minutes": off_minutes,
            }
        )
    return result
