---
title: "The activity log no longer records actions on the search presets being edited, on the Time Machine itself or on the daily activity statistics."
type: changed
audience: admin
date: 2026-11-22
---
Three system sections keep no Time Machine history: the search preset a user is editing
(rewritten on every change of a filter), the Time Machine itself and the daily user-activity
statistics (rebuilt from the activity log). Actions on them — a save, a new or deleted record —
are no longer written to the activity log either, as in previous versions: they filled it with
entries nobody reads. Every other action is logged as before.

**Action needed:** none.
