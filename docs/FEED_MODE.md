# Feed mode: wavemakers + return pump speed + skimmer, one sequence

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
