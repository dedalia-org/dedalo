---
title: Update cache never overwrites an edit saved while it runs
type: fixed
audience: user
date: 2026-10-21
wc: WC-2026-10-21-update-cache-locked-resave
---
*Update cache* regenerates a field by saving its current value again. It used to read each
record once, at the start of that record's turn, and save that copy later, possibly
minutes later when a media field of the same record was rebuilt first. A change someone
saved to the field in between was silently replaced by the old value, and a record deleted
in between was brought back. Now each field is read and saved again in one step, with the
record locked, so a change saved meanwhile is kept and a deleted record stays deleted. A
record that stays locked by someone else is skipped and listed, and a re-save the system
refuses is listed instead of being counted as done.
A record whose stored value the system refuses to save again (for example an old value in
a shape the field no longer accepts) is now listed and left untouched, and the run goes on
with the next record: it used to stop the whole run at that record.
