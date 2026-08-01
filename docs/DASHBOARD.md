# Dashboard & Device Tracking

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

## Mushroom version prerequisites

HACS > Frontend, search and install:
- **Mushroom** (cards used throughout)
- **card-mod** (only needed if you start customizing colors/styling further)
