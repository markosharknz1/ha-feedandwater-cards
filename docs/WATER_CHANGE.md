# Water change: staged restart with adjustable delays

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
