---
title: A field whose save failed is no longer forgotten — it stays marked unsaved and is saved again.
type: fixed
audience: user
date: 2026-10-31
wc: WC-2026-10-30-section-record-row-box
---
Before, when saving a field failed (a network interruption, a server error, a
session that changed on re-login), the field showed its orange "modified" bar
and nothing else: leaving the page did not warn, the automatic save on
navigation did not retry it, and a later successful edit of the same field
quietly cleared the warning while the earlier change was still not stored.

Now a failed save keeps the field marked as unsaved. Leaving the page warns
about it, the automatic save on navigation tries it again, and the next save of
that field sends the earlier change along with the new one. A field whose row
scrolls away or is rebuilt while its change is still unsaved keeps that change
until it is saved or you choose to discard it. If you edit the same value of
that field again in the rebuilt row, your newer value is the one that is kept;
the older, unsaved one is dropped instead of being written over it later.
Unsaved changes to OTHER values of the same field (another line of a
multi-value field, another linked record) are kept and saved. Typing a value
back to what is stored no longer clears the warning while another change of
the field is still unsaved. A
change refused while an earlier save of the same field was still on its way
(the session changed on re-login in the meantime) stays unsaved when that
earlier save completes.
