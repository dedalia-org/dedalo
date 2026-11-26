---
title: Restoring a Time Machine version that equals the current value no longer adds history.
type: fixed
audience: user
wc: WC-2026-11-10-tm-restore-unchanged-notice
date: 2026-11-10
---
Before, applying a Time Machine version whose value was already the current one
(for example the first of two identical saves, or an empty version onto an empty
field) still wrote a new history row, moved the record's modification date and
logged a "recover" activity entry — so the history said a value changed when
nothing had. Now such a restore writes nothing at all: no history row, no date
change, no activity entry. Restoring a version that differs is recorded as before.
The Time Machine window now says so ("The selected version is the same as the
current value. Nothing was restored") and stays open, without first asking you to
confirm an overwrite that would not happen.
