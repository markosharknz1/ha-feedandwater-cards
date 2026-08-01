# Vendor Compatibility

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
