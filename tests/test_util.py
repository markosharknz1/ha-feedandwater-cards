"""Pure-logic tests for custom_components/feedandwater/util.py.

Plain pytest, no Home Assistant test harness — same deliberate convention
as the maintainer's jebao_local repo (pytest-homeassistant-custom-component
breaks plain tests on native Windows via its import-time event-loop-policy
side effects).
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from custom_components.feedandwater.util import (  # noqa: E402
    compute_off_durations,
    parse_tracked_devices,
    valid_slug,
)


def test_valid_slugs() -> None:
    assert valid_slug("reef")
    assert valid_slug("frag_2")
    assert valid_slug("a")


def test_invalid_slugs() -> None:
    assert not valid_slug("")
    assert not valid_slug("Reef")
    assert not valid_slug("2tank")
    assert not valid_slug("my tank")
    assert not valid_slug("tank-1")
    assert not valid_slug("_tank")


def test_parse_tracked_devices() -> None:
    assert parse_tracked_devices("") == []
    assert parse_tracked_devices(" ,  , ") == []
    assert parse_tracked_devices("switch.a, fan.b ,switch.c") == [
        "switch.a",
        "fan.b",
        "switch.c",
    ]


@dataclass
class FakeState:
    state: str
    last_changed: datetime
    attributes: dict[str, Any] = field(default_factory=dict)


def test_compute_off_durations() -> None:
    now = datetime(2026, 8, 2, 12, 0, 0, tzinfo=timezone.utc)
    states = {
        "switch.skimmer": FakeState(
            "off", now - timedelta(minutes=90), {"friendly_name": "Skimmer"}
        ),
        "fan.wavemaker": FakeState("on", now - timedelta(hours=5)),
        "switch.gone": FakeState("unavailable", now),
    }
    result = compute_off_durations(
        ["switch.skimmer", "fan.wavemaker", "switch.gone", "switch.missing"],
        states.get,
        now,
    )
    # unavailable and missing entities are skipped, matching the YAML template
    assert [d["entity_id"] for d in result] == ["switch.skimmer", "fan.wavemaker"]
    assert result[0] == {
        "entity_id": "switch.skimmer",
        "name": "Skimmer",
        "state": "off",
        "off_minutes": 90.0,
    }
    # entities that are on report zero off-time and fall back to entity_id as name
    assert result[1]["off_minutes"] == 0.0
    assert result[1]["name"] == "fan.wavemaker"
