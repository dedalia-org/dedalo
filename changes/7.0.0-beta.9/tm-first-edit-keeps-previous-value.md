---
title: Time Machine keeps the previous value on the first edit of imported data.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-09-27-bulk-revert-undo-log
---
Editing a value that had no history yet — imported from a file, migrated from Dédalo
v6, or written by a process that keeps no history — left only the new value in the Time
Machine: what the edit replaced was gone, and there was nothing to restore. Now the first
edit of such a value records the previous value first, stamped one minute before the
edit, as Dédalo v6 did. This covers every way of editing: the edit form, translation,
restoring from the Time Machine, removing a linked record, and bulk changes. Only the
language that was edited gets the extra entry. Values overwritten by earlier v7 betas
before this fix cannot be recovered from the Time Machine; a backup taken before the edit
is the only source for them.
