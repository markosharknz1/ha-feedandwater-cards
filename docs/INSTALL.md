# Installation

Make sure you've covered [Prerequisites](PREREQUISITES.md) first.

## Adding a new tank

```bash
python3 generate_tank.py <slug> "<Display Title>"

# examples:
python3 generate_tank.py display "Display Tank"
python3 generate_tank.py frag "Frag Tank"
python3 generate_tank.py qt "Quarantine Tank"
```

Slug rules: lowercase, letters/digits/underscores, must start with a
letter — it becomes the entity_id prefix, so keep it short (`display`,
`frag`, `qt`, `sump`). Re-running for the same slug regenerates only that
tank's files; other tanks are untouched. Two tanks already generated as a
working example: `tanks/display/` and `tanks/frag/`.

## Install order (per tank)

1. **Helpers** — `tanks/<slug>/helpers.yaml`. Paste into `configuration.yaml`
   and restart, or recreate manually via Settings > Helpers if you prefer
   no YAML.
2. **Off-duration sensor** — `tanks/<slug>/off_duration_sensor.yaml`.
   Powers the multi-device dashboard (see
   [Dashboard & Device Tracking](DASHBOARD.md)).
3. **Water-change script** — `tanks/<slug>/log_water_change_script.yaml`.
4. **Blueprints** (once, shared) — import each file in
   `blueprints/automation/` via Settings > Automations & Scenes >
   Blueprints > Import Blueprint, or place them in
   `config/blueprints/automation/reef/`. One-click import, if your HA
   instance is reachable from this browser (via
   [My Home Assistant](https://www.home-assistant.io/integrations/my/)):

   [![Open your Home Assistant instance and show the blueprint import dialog with the Feed Mode blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarkosharknz1%2Fha-feedandwater-cards%2Fmain%2Fblueprints%2Fautomation%2Freef_feed_mode.yaml)
   [![Open your Home Assistant instance and show the blueprint import dialog with the Water Change Mode blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarkosharknz1%2Fha-feedandwater-cards%2Fmain%2Fblueprints%2Fautomation%2Freef_water_change_mode.yaml)
   [![Open your Home Assistant instance and show the blueprint import dialog with the Skimmer Power-Loss Delay blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarkosharknz1%2Fha-feedandwater-cards%2Fmain%2Fblueprints%2Fautomation%2Freef_skimmer_power_delay.yaml)
5. **Automations** — for *each* tank, create one automation from each of
   the three blueprints, selecting that tank's helpers as inputs (e.g.
   "Feed Mode Toggle" → `input_boolean.display_feed_mode`) and that tank's
   real hardware entities (its actual wavemaker switches, its actual
   skimmer plug). See [Feed Mode](FEED_MODE.md) and
   [Water Change Mode](WATER_CHANGE.md) for what each blueprint's inputs
   mean.
6. **Dashboard cards** — `tanks/<slug>/dashboard/*.yaml`, plain or
   Mushroom, paste into a Lovelace view (one view per tank works well —
   Settings > Dashboards > + Add View). `feed_settings_card.yaml` and
   `water_change_settings_card.yaml` (sliders, delays, logging) are meant
   for a separate, less-frequently viewed settings view rather than the
   main tank dashboard — see [Feed Mode](FEED_MODE.md) and
   [Water Change Mode](WATER_CHANGE.md) for why.

Next: [Feed Mode](FEED_MODE.md) and [Water Change Mode](WATER_CHANGE.md).
