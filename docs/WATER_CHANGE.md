# Water change: staged restart with adjustable delays

## The dashboard control

`water_change_card.yaml`/`water_change_card_mushroom.yaml` is a compact
on/off control, matching the same multi-tank-friendly design as
[Feed Mode](FEED_MODE.md) — one status line plus a single button:

- **Start Water Change** — pauses return pump(s), wavemakers, and skimmer
  together, instantly. Shown only when idle.
- **Resume (Staged Restart)** — ends the pause and kicks off the staged
  restart sequence below. Shown only while paused.
- While the staged restart itself is running, no button is shown — the
  status line reports progress ("wavemakers restart in 3 minutes", etc.)
  and there's nothing to tap until it finishes.

There's no duration to set before starting, unlike Feed Mode — pausing is
inherently indefinite until you tap Resume, so the card is just two
states (idle / paused) plus a passive "resuming" status. The restart
delay sliders, safety-timeout setting, last-change log, and volume
tracker live in a separate **`water_change_settings_card.yaml`/
`water_change_settings_card_mushroom.yaml`**, tuned occasionally rather
than part of the pause/resume tap flow.

## What actually happens

Starting a water change (tapping "Start Water Change") immediately pauses
return pump(s), wavemakers, and skimmer together. Tapping "Resume" once
you're done doesn't restart everything at once — it runs a sequence:

1. **Return pump(s) restart immediately.**
2. **Wavemakers restart** after the "Wavemaker Restart Delay" — an
   `input_number` slider on the settings card, default 5 minutes.
3. **Skimmer restarts** after the "Skimmer Restart Delay" — a second
   slider, default 10 minutes after the wavemakers.

Both delays are sliders you drag on the settings card (`input_number`,
`mode: slider`) — no editing the automation to change timing. A safety
timer force-runs the same staged restart if "Start Water Change" is
accidentally left on too long — the card's automatic tap-target
selection (Start vs. Resume vs. no button) reacts correctly regardless of
whether the restart was triggered by you tapping Resume or by the safety
timer firing on its own.

When creating the automation from `reef_water_change_mode.yaml`, you'll
map three separate device groups — Return Pump(s), Wavemaker(s), and
Skimmer — plus the two `input_number` sliders and the two countdown
timers generated in `helpers.yaml`.
