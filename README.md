# Reef Tank Home Assistant Dashboard Pack

Vendor-agnostic Home Assistant cards + automations for common reef tank
tasks, with a generator for running the whole pack across multiple tanks
without entity_id collisions. Built so anyone in the reefing community can
drop this in regardless of what brand of pumps, dosers, or smart plugs
they run — Tapo, Jebao, Shelly, Red Sea, native Zigbee, whatever — as long
as the device shows up in Home Assistant as a `switch` or `fan` entity
(which nearly everything does, one way or another).

## Two ways to install

**1. HACS integration (recommended)** — add this repo to HACS as an
Integration, then Settings > Devices & Services > Add Integration >
"Reef Feed & Water". One form per tank: name it, pick your wavemaker/
skimmer/pump entities, done — every helper, automation behavior, and
sensor is created for you, and in-flight feed/water-change sequences even
survive HA restarts. Full walkthrough + dashboard card snippets:
**[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

**2. Manual YAML** — the original flavor: transparent, hand-editable
helpers + blueprints + card YAML you paste in yourself. Some HA folks
prefer owning every line. Steps below.

## Quick start (manual YAML flavor)

1. Check [Prerequisites](docs/PREREQUISITES.md) — what you need before
   you start.
2. Run the generator for your tank — `<slug>` is a short lowercase
   entity_id prefix, `"<Display Title>"` is the name shown on the
   dashboard (replace both, don't type the `<>`):
   ```bash
   python3 generate_tank.py <slug> "<Display Title>"

   # example:
   python3 generate_tank.py display "Display Tank"
   ```
3. Follow [Installation](docs/INSTALL.md) — paste in helpers, import the
   blueprints, wire up automations, add the dashboard cards.
4. Read [Feed Mode](docs/FEED_MODE.md) and
   [Water Change Mode](docs/WATER_CHANGE.md) to understand what each
   automation actually does before you map your devices to it.

That's it — one dashboard view and two automations per tank, working with
whatever hardware you already have.

## Docs

| Guide | What's in it |
|---|---|
| [Integration install](docs/INTEGRATION.md) | HACS install, config flow, card snippets — the recommended path |
| [Prerequisites](docs/PREREQUISITES.md) | What you need before installing (YAML flavor) |
| [Installation](docs/INSTALL.md) | Adding a tank, per-tank install steps, one-click blueprint import |
| [Feed Mode](docs/FEED_MODE.md) | Wavemakers + return pump speed + skimmer, one sequence |
| [Water Change Mode](docs/WATER_CHANGE.md) | Staged restart with adjustable delays |
| [Dashboard & Device Tracking](docs/DASHBOARD.md) | Multi-device off-duration table, Mushroom cards |
| [Vendor Compatibility](docs/COMPATIBILITY.md) | Why this stays vendor-agnostic, tested power sockets |
| [Customizing & Limitations](docs/CUSTOMIZING.md) | Editing templates, known limitations |

## Structure

```
reef-ha-cards/
├── custom_components/feedandwater/   the HACS integration (recommended install)
├── blueprints/automation/     shared automation logic — one set, reused by every tank (YAML flavor)
├── templates/                 source templates the generator stamps out per tank
├── docs/                      full documentation (see table above)
├── generate_tank.py           run this once per tank
└── tanks/                     generated output lands here
    ├── display/
    │   ├── helpers.yaml
    │   ├── off_duration_sensor.yaml
    │   ├── log_water_change_script.yaml
    │   └── dashboard/*.yaml
    ├── frag/
    │   └── ... same structure, fully separate entity_ids
    └── test/
        └── practice tank for walking through blueprint import +
            automation creation against HA's built-in Demo integration,
            before wiring in real hardware — see tanks/test/README.md
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
