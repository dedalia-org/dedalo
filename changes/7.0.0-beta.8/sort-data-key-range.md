---
title: Reordering a related record to an invalid position no longer removes it.
type: fixed
audience: user
date: 2026-10-30
wc: WC-2026-10-30-sort-data-key-range
---
Moving a record inside a portal to a position outside the list (for example a drag on the second page, or a malformed request) used to drop the moved record from the field and still report the save as successful. The server now refuses such a move with an error and leaves the field exactly as it was; moves to a valid position behave as before.
