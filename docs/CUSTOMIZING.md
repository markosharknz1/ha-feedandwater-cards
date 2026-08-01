# Customizing & Limitations

## Editing templates vs. generated output

If you want to change how *every* tank's cards look, edit the files in
`templates/` (they use `{{SLUG}}` and `{{TITLE}}` placeholders) and
re-run `generate_tank.py` for each tank — it overwrites that tank's
generated files cleanly. Don't hand-edit files inside `tanks/<slug>/`
if you plan to regenerate later; edits there get clobbered.

## Known limitations / things to extend

- The off-duration sensor polls every 30 seconds — fine for dashboard
  display, not meant for sub-second precision.
- Timer duration templating assumes standard HH:MM:SS under 24 hours,
  which covers every use case here.
- Dosing pump cards aren't in this pack yet — good next candidate, and
  the same generator pattern extends cleanly to them.
