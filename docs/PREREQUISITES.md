# Prerequisites

- **A running Home Assistant instance** with either file access to edit
  `configuration.yaml` (add-on/HAOS file editor, Samba, SSH, etc.) or
  willingness to recreate the generated `helpers.yaml` entries by hand via
  Settings > Helpers if you'd rather avoid YAML.
- **Python 3** to run `generate_tank.py` — run it on your own machine, not
  on the HA host; it just writes files into `tanks/<slug>/` that you then
  copy/paste into HA.
- **Your devices exposed in HA as standard entities** — no custom
  integration needed as long as each device already shows up as one of:
  - `switch` or `fan` — wavemakers, return pump(s), skimmer (required)
  - `number` — only if you want variable-speed return pump control during
    feed mode (optional; skip the input during automation setup if you
    don't have this)
  - `binary_sensor` — only if you use the power-loss restart blueprint
    (`reef_skimmer_power_delay.yaml`), reflecting mains/UPS power state
    (e.g. a UPS integration's "AC Power" sensor, or a smart plug's
    connectivity sensor)
- **Helper entities** (`input_boolean`, `input_number`, `input_text`,
  `timer`) — all generated for you per-tank in `helpers.yaml`; you don't
  need to create these by hand unless you opted out of YAML above.
- **Ability to import blueprints** — Settings > Automations & Scenes >
  Blueprints > Import Blueprint (or drop the files into
  `config/blueprints/automation/reef/` directly).
- **A Lovelace dashboard you can edit** to paste in the generated cards
  (Settings > Dashboards; YAML mode or the card-by-card UI editor both
  work).
- **Mushroom + card-mod (optional)** — only if you want the Mushroom
  variant of the cards instead of the plain ones; see
  [Dashboard & Device Tracking](DASHBOARD.md#mushroom-version-prerequisites).

Next: [Installation](INSTALL.md).
