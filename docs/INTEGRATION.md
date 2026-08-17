# Reef Feed & Water integration (HACS install)

The integration is the recommended way to install this pack: no YAML
pasting, no blueprints, no Python — add it via HACS, fill in one form per
tank, and every helper, automation behavior, and sensor is created for
you. The [manual YAML flavor](INSTALL.md) remains available if you prefer
hand-editable configuration.

## Install

1. **HACS > Integrations > ⋮ > Custom repositories** — add
   `https://github.com/markosharknz1/ha-feedandwater-cards` with category
   **Integration**, then install **Reef Feed & Water** and restart HA.
2. **Settings > Devices & Services > + Add Integration** — search
   "Reef Feed & Water".
3. **Step 1 — identity**: tank name (shown on dashboards) and slug (the
   entity_id prefix, e.g. `reef` → `button.reef_start_feed`). Lowercase
   letters/digits/underscores, starting with a letter.
4. **Step 2 — hardware**: pick your entities. Wavemaker(s), Skimmer(s),
   and Return pump(s) accept any `switch` or `fan` entities, any brand.
   Optionally add return-pump speed `number` entities (enables the
   feed-mode speed drop with automatic save/restore) and a mains/UPS
   `binary_sensor` (enables the power-loss skimmer restart delay).

Repeat once per tank — every tank's entities are prefixed with its own
slug, so nothing collides.

**Practicing first?** Add HA's built-in **Demo** integration to get fake
switches, wire a practice tank at them, then later open the tank's
**Configure** (options) dialog and swap in your real hardware — settings
sliders and history are kept.

## What one tank gives you

Everything the YAML flavor's helpers + blueprints provided, as native
entities on a single device (`<slug>` = your slug):

| Entity | Purpose |
|---|---|
| `button.<slug>_start_feed` | Timed feed using the Feed duration slider |
| `button.<slug>_feed_until_stop` | Feed at max duration — tap Stop Feeding when done |
| `button.<slug>_stop_feed` | Early cancel: wavemakers/pump restore now, skimmer still waits its buffer |
| `button.<slug>_start_water_change` | Instant pause of pumps, wavemakers, skimmer |
| `button.<slug>_resume_water_change` | Staged restart: pump now → wavemakers +delay → skimmer +delay |
| `button.<slug>_log_water_change` | Stamp the last-water-change timestamp |
| `sensor.<slug>_feed_stage` | `idle` / `feeding` / `settling` (+ resume times as attributes) |
| `sensor.<slug>_water_change_stage` | `idle` / `paused` / `restarting_wavemakers` / `restarting_skimmer` |
| `sensor.<slug>_last_water_change` | Timestamp of the last logged change |
| `sensor.<slug>_device_off_durations` | Off-duration table for the tracked-devices list |
| `number.<slug>_feed_duration` etc. | The settings sliders |
| `text.<slug>_tracked_devices` | Comma-separated entity_ids for the off-duration table |

Tanks with **lights** configured (optional hardware field — e.g. stand
lights on a smart plug) additionally get:

| Entity | Purpose |
|---|---|
| `button.<slug>_lights_on` | Turn the light group on; auto-off after the Light timer |
| `button.<slug>_lights_off` | Turn them off (or end a running timer early) |
| `number.<slug>_light_timer` | Minutes until auto-off — **0 = stay on until you tap off** |
| `sensor.<slug>_light_stage` | `off` / `on` / `on_timed` (+ the scheduled off time) |

The feed and water-change sequences also **survive HA restarts** — an
in-flight sequence is recovered on startup (overdue steps run immediately,
future ones are rescheduled), which the blueprint flavor's `delay:` steps
can't do.

## Dashboard: the bundled card (recommended)

The integration ships its own Lovelace card — no YAML, no placeholders,
no manual resource registration. Add a card to any dashboard view, search
for **Reef Feed & Water**, done:

```yaml
type: custom:feedandwater-card
```

That's the entire config. The card discovers every tank automatically and
renders each as one compact row: status dot, tank name, live countdown,
and contextual action chips (Feed / Until I Stop / Water Change when
idle; Stop Feeding or Resume while active). The ⚙ on each row opens a
collapsed settings drawer with the duration/speed/delay sliders and the
water-change log — keeping the main face compact even with 5-10 tanks
stacked on one shop-floor screen.

Optional config, and a visual editor provides both as form fields:

```yaml
type: custom:feedandwater-card
title: Fish Room        # heading above the tank rows
tanks: [reef, frag]     # limit to specific tank slugs (default: all tanks)
```

**YAML-mode dashboards only** (`lovelace: mode: yaml` in
configuration.yaml — if you don't know what that is, you're not using
it): the automatic resource registration can't reach YAML-mode resource
lists, so declare it yourself:

```yaml
lovelace:
  mode: yaml
  resources:
    - url: /feedandwater/feedandwater-card.js
      type: module
```

## Dashboard: stock-card snippets (alternative)

If you'd rather compose from stock HA cards (more customizable, more
work), the same compact design as plain YAML. Replace `<slug>` and the
title, paste into a Lovelace view:

```yaml
type: vertical-stack
cards:
  - type: markdown
    content: >
      {% if is_state('sensor.<slug>_feed_stage', 'feeding') %}
      🔵 **<Tank Title> — Feeding** · wavemakers resume {{ relative_time(as_datetime(state_attr('sensor.<slug>_feed_stage','wavemakers_at'))) }}
      {% elif is_state('sensor.<slug>_feed_stage', 'settling') %}
      🟡 **<Tank Title> — Settling** · skimmer resumes {{ relative_time(as_datetime(state_attr('sensor.<slug>_feed_stage','skimmer_at'))) }}
      {% else %}
      🟢 **<Tank Title> — Idle**
      {% endif %}
  - type: horizontal-stack
    cards:
      - type: conditional
        conditions:
          - entity: sensor.<slug>_feed_stage
            state: idle
        card:
          type: button
          name: Start Feed
          icon: mdi:food-drumstick
          tap_action:
            action: call-service
            service: button.press
            target: {entity_id: button.<slug>_start_feed}
      - type: conditional
        conditions:
          - entity: sensor.<slug>_feed_stage
            state: idle
        card:
          type: button
          name: Until I Stop
          icon: mdi:infinity
          tap_action:
            action: call-service
            service: button.press
            target: {entity_id: button.<slug>_feed_until_stop}
      - type: conditional
        conditions:
          - entity: sensor.<slug>_feed_stage
            state_not: idle
        card:
          type: button
          name: Stop Feeding
          icon: mdi:stop-circle-outline
          tap_action:
            action: call-service
            service: button.press
            target: {entity_id: button.<slug>_stop_feed}
```

```yaml
type: vertical-stack
cards:
  - type: markdown
    content: >
      {% if is_state('sensor.<slug>_water_change_stage', 'paused') %}
      🔵 **<Tank Title> — Water Change Paused** · tap Resume when done
      {% elif is_state('sensor.<slug>_water_change_stage', 'restarting_wavemakers') %}
      🟡 **<Tank Title> — Resuming** · wavemakers restart {{ relative_time(as_datetime(state_attr('sensor.<slug>_water_change_stage','wavemakers_at'))) }}
      {% elif is_state('sensor.<slug>_water_change_stage', 'restarting_skimmer') %}
      🟠 **<Tank Title> — Resuming** · skimmer restarts {{ relative_time(as_datetime(state_attr('sensor.<slug>_water_change_stage','skimmer_at'))) }}
      {% else %}
      🟢 **<Tank Title> — Idle**
      {% endif %}
  - type: conditional
    conditions:
      - entity: sensor.<slug>_water_change_stage
        state: idle
    card:
      type: button
      name: Start Water Change
      icon: mdi:water-sync
      tap_action:
        action: call-service
        service: button.press
        target: {entity_id: button.<slug>_start_water_change}
  - type: conditional
    conditions:
      - entity: sensor.<slug>_water_change_stage
        state: paused
    card:
      type: button
      name: Resume (Staged Restart)
      icon: mdi:play-circle-outline
      tap_action:
        action: call-service
        service: button.press
        target: {entity_id: button.<slug>_resume_water_change}
```

Settings view (sliders live here, off the main multi-tank screen):

```yaml
type: entities
title: "<Tank Title> — Settings"
show_header_toggle: false
entities:
  - number.<slug>_feed_duration
  - number.<slug>_return_pump_feed_speed
  - number.<slug>_skimmer_extra_off
  - type: divider
  - number.<slug>_wavemaker_restart_delay
  - number.<slug>_skimmer_restart_delay
  - number.<slug>_power_loss_delay
  - type: divider
  - sensor.<slug>_last_water_change
  - number.<slug>_last_water_change_volume
  - type: divider
  - text.<slug>_tracked_devices
```

Tracked-devices table:

```yaml
type: markdown
content: >
  {% set devices = state_attr('sensor.<slug>_device_off_durations', 'devices') %}
  {% if not devices %}
  _No devices being tracked yet — add entity_ids to the Tracked devices field._
  {% else %}
  | Device | Status | Off For |
  |---|---|---|
  {% for d in devices %}
  | {{ d.name }} | {{ '🔴 OFF' if d.state == 'off' else '🟢 ON' if d.state == 'on' else d.state }} | {{ d.off_minutes ~ ' min' if d.state == 'off' else '—' }} |
  {% endfor %}
  {% endif %}
```

## Notes

- The water-change safety timeout (force-runs the staged restart if a
  pause is left on) is fixed at 2 hours in this version.
- The power-loss skimmer delay runs only if you picked a power sensor;
  there's no dedicated countdown sensor for it yet.
