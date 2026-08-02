# Feed mode: wavemakers + return pump speed + skimmer, one sequence

## The dashboard control

`feed_card.yaml`/`feed_card_mushroom.yaml` is deliberately compact — a
one-line status ("Idle" / "Feeding" / "Settling") plus two or three small
buttons, sized so a shop floor with 5-10 tank screens stacked together
stays scannable rather than turning into a wall of sliders:

- **Start Feed** — begins feeding using whatever duration/speed/buffer
  values are currently set (see below).
- **Until I Stop** — starts feeding at the *maximum* duration (60 min,
  far longer than any real feeding session) instead of whatever the
  duration slider is currently set to. There's no true "no timer" mode —
  it's the same timed automation underneath, just started with a duration
  long enough that you'll always tap "Stop Feeding" yourself first.
- **Stop Feeding** (replaces the two buttons above while feeding) — ends
  the sequence early. Wavemakers and return pump speed restore
  immediately; the skimmer still finishes its safety buffer (see below).

The duration/return-pump-speed/skimmer-buffer sliders live in a separate
**`feed_settings_card.yaml`/`feed_settings_card_mushroom.yaml`** — tuned
occasionally, not part of the per-feed tap flow, and meant for a
secondary "settings" view rather than the main multi-tank dashboard.

## What actually happens

Starting feed mode (via either button above) runs three things at once:

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

The feed card's status line reflects this live: "Feeding" while wavemakers
are paused, then "Settling" once wavemakers are back but the skimmer is
still waiting. Tapping "Stop Feeding" cancels early — wavemakers and
return pump speed restore immediately, but the **skimmer still waits out
its full buffer time** (re-timed from the moment you cancel, not the
original schedule), so an early cancel can't accidentally skip the
settling period the buffer exists for. This is exactly what "Until I
Stop" relies on in practice — it starts a long-duration feed and expects
you to end it with "Stop Feeding" rather than waiting for the timer.

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
