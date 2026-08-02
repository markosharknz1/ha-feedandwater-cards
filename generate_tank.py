#!/usr/bin/env python3
"""
generate_tank.py — stamp out a full prefixed Reef HA card/helper set for one tank.

Usage:
    python3 generate_tank.py <slug> "<Display Title>"

Example:
    python3 generate_tank.py display "Display Tank"
    python3 generate_tank.py frag "Frag Tank"
    python3 generate_tank.py qt "Quarantine Tank"

Each run creates tanks/<slug>/ containing:
    helpers.yaml
    off_duration_sensor.yaml
    log_water_change_script.yaml
    dashboard/flow_wavemaker_card.yaml (+ _mushroom)
    dashboard/water_change_card.yaml (+ _mushroom)
    dashboard/skimmer_card.yaml (+ _mushroom)
    dashboard/off_duration_dashboard.yaml (+ _mushroom)

Run it once per tank. Slugs must be unique, lowercase, no spaces
(use underscores) — they become entity_id prefixes, e.g. "display" gives
you input_boolean.display_feed_mode, timer.display_skimmer_restart_delay,
etc. Re-running with the same slug overwrites that tank's generated files
only — other tanks are untouched.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
TEMPLATES = ROOT / "templates"
TANKS = ROOT / "tanks"

FILES = [
    ("helpers.yaml.tmpl", "helpers.yaml"),
    ("off_duration_sensor.yaml.tmpl", "off_duration_sensor.yaml"),
    ("log_water_change_script.yaml.tmpl", "log_water_change_script.yaml"),
    ("flow_wavemaker_card.yaml.tmpl", "dashboard/flow_wavemaker_card.yaml"),
    ("flow_wavemaker_card_mushroom.yaml.tmpl", "dashboard/flow_wavemaker_card_mushroom.yaml"),
    ("feed_card.yaml.tmpl", "dashboard/feed_card.yaml"),
    ("feed_card_mushroom.yaml.tmpl", "dashboard/feed_card_mushroom.yaml"),
    ("water_change_card.yaml.tmpl", "dashboard/water_change_card.yaml"),
    ("water_change_card_mushroom.yaml.tmpl", "dashboard/water_change_card_mushroom.yaml"),
    ("skimmer_card.yaml.tmpl", "dashboard/skimmer_card.yaml"),
    ("skimmer_card_mushroom.yaml.tmpl", "dashboard/skimmer_card_mushroom.yaml"),
    ("off_duration_dashboard.yaml.tmpl", "dashboard/off_duration_dashboard.yaml"),
    ("off_duration_dashboard_mushroom.yaml.tmpl", "dashboard/off_duration_dashboard_mushroom.yaml"),
]


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    slug, title = sys.argv[1], sys.argv[2]

    if not re.fullmatch(r"[a-z][a-z0-9_]*", slug):
        print(f'Error: slug "{slug}" must be lowercase letters/digits/underscores, starting with a letter.')
        sys.exit(1)

    out_dir = TANKS / slug
    (out_dir / "dashboard").mkdir(parents=True, exist_ok=True)

    for tmpl_name, out_name in FILES:
        tmpl_path = TEMPLATES / tmpl_name
        if not tmpl_path.exists():
            print(f"  (skipping missing template: {tmpl_name})")
            continue
        content = tmpl_path.read_text(encoding="utf-8")
        content = content.replace("{{SLUG}}", slug).replace("{{TITLE}}", title)
        out_path = out_dir / out_name
        out_path.write_text(content, encoding="utf-8")
        print(f"  wrote {out_path.relative_to(ROOT)}")

    print(f"\nDone. Tank '{title}' generated under tanks/{slug}/")
    print(f"Next: install tanks/{slug}/helpers.yaml, tanks/{slug}/off_duration_sensor.yaml,")
    print(f"tanks/{slug}/log_water_change_script.yaml, then create automations from the")
    print(f"blueprints in blueprints/automation/ pointing at the tanks/{slug}/ helpers,")
    print(f"then add the tanks/{slug}/dashboard/*.yaml cards to your Lovelace dashboard.")


if __name__ == "__main__":
    main()
