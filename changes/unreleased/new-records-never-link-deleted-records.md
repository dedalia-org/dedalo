---
title: Creating or duplicating a record that would link to a deleted record is refused.
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-12-locator-target-deleted-refused
---
A save that links to a record someone else deletes at the same moment is already refused
instead of leaving a broken link. The same protection now covers the two ways a record is BORN
with links: duplicating a record (every link it copies) and creating one whose section gives
new records a default link or a project. If a linked record is deleted meanwhile — or the
original already carried a link to a long-deleted record — the duplicate or creation is refused
with "The linked record was deleted: remove the link (or restore the record from Time Machine)
and save again", and no record is created.
