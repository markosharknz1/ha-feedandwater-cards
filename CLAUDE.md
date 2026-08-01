# CLAUDE.md — Reef Tank HA Cards

Drop this file in the repo root (it already is) and open the folder in
Claude Code — it'll read this automatically for context on what the
project is and what's been done so far.

## What this is

A vendor-agnostic Home Assistant automation blueprint + dashboard card
pack for reef tanks, built for sharing with the reefing community.
Works with any switch/fan/number entity regardless of brand (Tapo,
Jebao, Shelly, Red Sea, native Zigbee, etc.) because it only calls
generic HA services against entities the installer chooses.

Multi-tank support works via a generator script (`generate_tank.py`)
that stamps prefixed entity_ids and cards out of `templates/` into
`tanks/<slug>/`, so `display` and `frag` tanks never collide.

## Structure

```
blueprints/automation/   3 shared automations (not tank-specific — take entity inputs)
  reef_feed_mode.yaml           wavemakers pause, return pump speed drops, skimmer pauses longer
  reef_water_change_mode.yaml   pause all, then staged restart: pump → wavemakers → skimmer
  reef_skimmer_power_delay.yaml delayed skimmer restart after a power outage
templates/                Source files with {{SLUG}}/{{TITLE}} placeholders
generate_tank.py          python3 generate_tank.py <slug> "<Title>" — stamps out a tank
tanks/display/, tanks/frag/   Two already-generated example tanks
README.md                 Short landing page + quick start, links into docs/
docs/                      Full documentation, split by topic (PREREQUISITES,
                           INSTALL, FEED_MODE, WATER_CHANGE, DASHBOARD,
                           COMPATIBILITY, CUSTOMIZING) — was one long README
                           until 2026-08-01, split for readability
```

## Status — what's built vs. what's unverified

Everything is written and internally consistent (YAML validated, template
substitution tested, no leftover `{{SLUG}}`/`{{TITLE}}` tokens). **None
of it has been tested against a live Home Assistant instance.** The
riskiest pieces to verify first, in order:

1. **`reef_feed_mode.yaml`** — the return-pump speed save/restore via
   `input_text` + `tojson`/`from_json` round-trip, and the "cancel early"
   branch that re-times the skimmer buffer from the moment of
   cancellation rather than turning the skimmer straight back on.
2. **`reef_water_change_mode.yaml`** — the safety-timeout path (toggle
   left on too long); this was restructured once already to fix a
   retrigger bug (see `mode: single` + `max_exceeded: silent` and the
   comment above the toggle-off action — don't revert that without
   understanding why it's there).
3. **`timer.*` `finishes_at` attribute usage** in the Mushroom card
   templates (`relative_time(as_datetime(state_attr(...)))`) — timer
   entity attributes have shifted slightly across HA versions in the
   past.
4. **`off_duration_sensor.yaml.tmpl`** — polls every 30s via
   `time_pattern`; confirm this doesn't cause noticeable dashboard lag
   with a large tracked-device list.

## Conventions to preserve

- Every card/helper template uses only `{{SLUG}}` (entity_id prefix,
  lowercase/underscore) and `{{TITLE}}` (display name) as placeholders —
  nothing else. `generate_tank.py` does a dumb string `.replace()`, so
  don't introduce a third placeholder without updating the generator.
- Blueprints stay generic and are never templated/duplicated per tank —
  only helpers and cards get prefixed.
- Automations that restore state after a pause (feed mode, water change)
  use `homeassistant.turn_on`/`turn_off` (domain-agnostic) rather than
  `switch.turn_on` etc., so switch and fan entities both work.
- Don't hand-edit files under `tanks/<slug>/` — edit `templates/` and
  regenerate, or edits get clobbered on the next run.

## Suggested next tasks

- Push to GitHub (not yet done — see README for the git commands, or
  just run them from here).
- Test blueprint logic against a real (or test) HA instance, starting
  with the four risk points above.
- Dosing pump cards are the natural next addition — same generator
  pattern extends cleanly (see README > Known limitations).
- Consider a GitHub Actions workflow that lints the YAML on push, since
  this is meant for community use and YAML typos are the most likely
  contribution-breaking mistake.
