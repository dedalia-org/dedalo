---
title: Search filters and user-activity statistics no longer fill the Time Machine
type: fixed
audience: user
date: 2026-11-12
---
Every change to the search panel's current filter was saved with a new Time Machine entry,
and so was every edit or deletion of a daily user-activity statistics record. Over time this
filled the Time Machine with history nobody restores.

Now the search panel's current filter and the daily
user-activity statistics are not versioned: saving them works as before, but no Time Machine
history is kept, and a deleted one cannot be recovered from the Time Machine (statistics can
always be rebuilt from the activity log). History already recorded for them is left as it is.
