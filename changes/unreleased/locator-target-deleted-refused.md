---
title: Linking to a record that was just deleted is now refused instead of leaving a broken link.
type: fixed
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-locator-target-deleted-refused
---
When one person linked a record (in a portal, an autocomplete, a dataframe…) at the same
moment another person deleted that record, the save answered OK and the link stayed behind
pointing at nothing — and nobody was told. The two operations now wait for each other:
if the link was saved first, the delete removes it like every other link to the deleted
record; if the delete came first, the save is refused with the message "The linked record
… was deleted — remove the link (or restore the record from Time Machine) and save again",
and nothing is written. Links that a record already carried are not affected, so a record
with an older broken link stays editable.
