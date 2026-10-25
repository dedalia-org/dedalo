---
title: Change history no longer fails, and restore no longer writes a broken value, when an old history entry holds a malformed link value.
type: fixed
audience: user
date: 2026-10-24
wc: WC-2026-10-24-tm-malformed-relation-cell
---
Opening the history of a linked field (for example a user's profile in the inspector's
*Component history*) could answer with an unexpected error, and no entry at all was shown, when one
very old history entry stored the value in a shape earlier versions used (a bare record number
instead of a link). The history now opens: every well-formed entry shows as usual, and an entry
whose stored value cannot be read as a link is shown empty instead (the response flags it with the
reason, for developers). The same entry previews empty in the Time Machine tool, and restoring it
(the field alone, the whole record, or a deleted record) is refused with a message saying the entry is in an old format, instead of writing the broken value
into the record (before, the restore stored it and the field showed nothing usable). The current
value stays as it is. The stored history itself is not changed.
