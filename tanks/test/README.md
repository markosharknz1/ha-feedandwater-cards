# Test Tank — practice tank, not real equipment

This tank exists so you can walk through importing the blueprints and
creating automations from them *before* wiring in real hardware.

It's not a working example like `tanks/display/` or `tanks/frag/` —
those represent actual tank setups. `test` is disposable scaffolding:
paste in `helpers.yaml` (or recreate those handful of `input_boolean`/
`input_number`/`timer` entities via Settings > Helpers if you'd rather
skip YAML), then add Home Assistant's built-in **Demo** integration
(Settings > Devices & Services > Add Integration > "Demo") to get real
`switch`/`fan` entities to point the blueprint automations at — no real
pumps or plugs required.

Once you're comfortable with the automation-creation flow, either:
- delete this tank's helpers/automations and the Demo integration, or
- keep practicing, or
- generate your real tank (`python3 generate_tank.py <slug> "<Title>"`)
  and rewire the same blueprint automations to point at your actual
  hardware entities instead of the Demo ones.

See [docs/INSTALL.md](../../docs/INSTALL.md) for the full install steps.

Note: this file is hand-written, not generated — `generate_tank.py`
won't touch or overwrite it on a re-run of `python3 generate_tank.py test
"Test Tank"`.
