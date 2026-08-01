# Reef Tank Home Assistant Dashboard Pack

Vendor-agnostic Home Assistant cards + automations for common reef tank
tasks, with a generator for running the whole pack across multiple tanks
without entity_id collisions. Built so anyone in the reefing community can
drop this in regardless of what brand of pumps, dosers, or smart plugs
they run — Tapo, Jebao, Shelly, Red Sea, native Zigbee, whatever — as long
as the device shows up in Home Assistant as a `switch` or `fan` entity
(which nearly everything does, one way or another).

## Prerequisites

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
  variant of the cards instead of the plain ones; see below.

## Structure

```
reef-ha-cards/
├── blueprints/automation/     shared automation logic — one set, reused by every tank
├── templates/                 source templates the generator stamps out per tank
├── generate_tank.py           run this once per tank
└── tanks/                     generated output lands here
    ├── display/
    │   ├── helpers.yaml
    │   ├── off_duration_sensor.yaml
    │   ├── log_water_change_script.yaml
    │   └── dashboard/*.yaml
    └── frag/
        └── ... same structure, fully separate entity_ids
```

## Why it's split this way

- **Blueprints stay generic.** The three automations (feed-mode pause,
  water-change pause, skimmer restart delay) don't know or care which tank
  they're running for — each one just takes entity inputs. You create one
  automation *instance per tank* from the same blueprint, pointing at that
  tank's helpers and that tank's real devices.
- **Helpers and cards get prefixed per tank** so `display` and `frag`
  never collide — `input_boolean.display_feed_mode` vs
  `input_boolean.frag_feed_mode`, etc. This is what `generate_tank.py`
  automates: it takes a slug + display name and stamps every template in
  `templates/` into a fully prefixed set under `tanks/<slug>/`.

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
   Powers the multi-device dashboard (see below).
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
   skimmer plug).
6. **Dashboard cards** — `tanks/<slug>/dashboard/*.yaml`, plain or
   Mushroom, paste into a Lovelace view (one view per tank works well —
   Settings > Dashboards > + Add View).

## Feed mode: wavemakers + return pump speed + skimmer, one sequence

Tapping "Feed Time" ON runs three things at once:

1. **Wavemakers pause** — resume automatically after "Feed Duration"
   (slider, default 20 min).
2. **Return pump(s) drop to a reduced speed** — only if you have
   variable-speed return pump control exposed in HA as a `number` entity
   (percentage set-point). Their pre-feed speed is saved automatically and
   restored later — you don't need to remember what it was set to. If you
   don't have variable-speed control, leave this input empty when setting
   up the automation and it's skipped entirely.
3. **Skimmer pauses** — for Feed Duration **plus** an extra buffer (slider,
   default 10 min), so foam production has time to settle before the
   skimmer restarts. Wavemakers and return pump speed restore at the Feed
   Duration mark; the skimmer (and, if used, the return pump's final
   restore-to-normal) happens at the later Feed Duration + Extra mark.

The feed card shows a live stage indicator: "Feeding" while wavemakers are
paused, then "Settling" once wavemakers are back but the skimmer is still
waiting. Toggling "Feed Time" off manually cancels early — wavemakers and
return pump speed restore immediately, but the **skimmer still waits out
its full buffer time** (re-timed from the moment you cancel, not the
original schedule), so an early cancel can't accidentally skip the
settling period the buffer exists for.

When creating the automation from `reef_feed_mode.yaml`, you'll map:
Wavemaker(s), Return Pump Speed Control(s) (optional `number` entities),
Skimmer, the three sliders, the two countdown timers, and the
`input_text` helper used to remember pre-feed pump speed — all generated
per-tank in `helpers.yaml`.

**If a device's own integration ships a built-in feed/pause feature**
(some Jebao integrations add a "Feed Duration" number + feed-mode
buttons directly on the pump), don't use it alongside this blueprint —
running both independently against the same device means two unrelated
timers fighting over its state. Let this pack's feed mode own the
sequence instead: the `Wavemaker(s)` and `Skimmer` inputs above are
multi-entity selectors, so a single "Feed Time" toggle can pause and
resume several devices (across brands) together on one timer, rather
than triggering each device's own built-in feed feature one at a time.

## Water change: staged restart with adjustable delays

Toggling "Water Change Time" ON immediately pauses return pump(s),
wavemakers, and skimmer together. Toggling it OFF once you're done doesn't
restart everything at once — it runs a sequence:

1. **Return pump(s) restart immediately.**
2. **Wavemakers restart** after the "Wavemaker Restart Delay" — an
   `input_number` slider on the water change card, default 5 minutes.
3. **Skimmer restarts** after the "Skimmer Restart Delay" — a second
   slider, default 10 minutes after the wavemakers.

Both delays are sliders you drag on the dashboard (`input_number`,
`mode: slider`) — no editing the automation to change timing. The card
also shows a live stage indicator ("wavemakers restart in 3 minutes",
etc.) so you always know where the sequence is at. A safety timer
force-runs the same staged restart if "Water Change Time" is accidentally
left on too long.

When creating the automation from `reef_water_change_mode.yaml`, you'll
map three separate device groups — Return Pump(s), Wavemaker(s), and
Skimmer — plus the two `input_number` sliders and the two countdown
timers generated in `helpers.yaml`.

## Multi-device off-duration dashboard

Rather than one template-sensor block per device (which doesn't scale),
each tank gets a **single sensor** (`sensor.<slug>_device_off_durations`)
that reads a list of entity_ids from `input_text.<slug>_tracked_devices`
and computes off-duration for all of them at once. To track a device:

1. Open the tank's dashboard.
2. Tap "Devices to Track" and paste in a comma-separated list of
   entity_ids, e.g.:
   `switch.skimmer_plug, switch.return_pump, fan.wavemaker_1, fan.wavemaker_2`
3. The table below renders automatically — add or remove devices by
   editing that same field, no YAML changes, no restart.

This works for any vendor/domain mix since it only reads `state` and
`last_changed` — a Tapo plug and a Jebao pump behind a local bridge render
identically in the table.

## Why this stays vendor-agnostic

Every HA integration normalises into standard entity domains — a Tapo
plug, a Shelly relay, and a locally-bridged Jebao pump all end up as
`switch.something`. Everything in this pack only ever calls generic
services (`homeassistant.turn_on`/`turn_off`, `timer.*`,
`input_boolean.*`) against entities *you* choose, so brand never matters
for on/off, pause/resume, or timing.

The one place brand *can* matter is features beyond on/off — a Jebao wave
pattern, a Red Sea dosing calibration. For those, wrap the vendor-specific
service call in a small **template switch** so it presents to this pack as
a normal `switch` entity — that's the adapter point, and everything
downstream (blueprints, cards, timers) stays untouched.

## Tested-compatible power sockets

Confirmed against each integration's own HA documentation — all of these
create plain `switch` entities out of the box, so they work directly as
Wavemaker/Return Pump/Skimmer targets with zero adapter needed:

| Brand | HA integration | Entity domain | HACS needed? |
|---|---|---|---|
| TP-Link Kasa *and* Tapo plugs | `tplink` | `switch` | No — core |
| Shelly | `shelly` | `switch` (default; can be set to `light` per-device) | No — core |
| Belkin WeMo | `wemo` | `switch` | No — core |
| Generic Zigbee plug (any brand) via ZHA | `zha` | `switch` | No — core |

Meross and Sonoff/eWeLink smart plugs are also widely used and expose
`switch` entities, but aren't independently verified here — check the
entity domain after adding the device (Settings > Devices & Services)
before wiring it into a blueprint.

One thing worth checking on any multi-outlet power strip (e.g. Kasa
`KP400`/`EP40`-style strips): confirm which entity_id maps to which
physical socket during setup — a mixup there pauses/resumes the wrong
device.

## Mushroom version prerequisites

HACS > Frontend, search and install:
- **Mushroom** (cards used throughout)
- **card-mod** (only needed if you start customizing colors/styling further)

## Editing templates vs. generated output

If you want to change how *every* tank's cards look, edit the files in
`templates/` (they use `{{SLUG}}` and `{{TITLE}}` placeholders) and
re-run `generate_tank.py` for each tank — it overwrites that tank's
generated files cleanly. Don't hand-edit files inside `tanks/<slug>/`
if you plan to regenerate later; edits there get clobbered.

## Known limitations / things to extend

- The off-duration sensor polls every 30 seconds — fine for dashboard
  display, not meant for sub-second precision.
- Timer duration templating assumes standard HH:MM:SS under 24 hours,
  which covers every use case here.
- Dosing pump cards aren't in this pack yet — good next candidate, and
  the same generator pattern extends cleanly to them.
