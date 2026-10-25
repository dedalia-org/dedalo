---
title: Installing or resetting a thesaurus no longer waits without limit behind another session's lock
type: fixed
audience: admin
date: 2026-10-22
---
**Maintenance › Install hierarchies** (both **Install** and **Reset to seed**) imports
a thesaurus in one transaction. If another session held a lock on one of its terms
(for example, an editor's unfinished save, or a database session left idle in a
transaction), the import waited for that lock with no limit. While it waited, it kept
the terms it had already reached locked, so edits to those terms queued behind it,
and nothing could stop it. Now each lock wait gives up after 5 seconds, the same limit
every other maintenance operation uses, and the whole import is retried a few times.
If the lock is still held, the import stops with a message saying that another
session holds a lock on the thesaurus. Nothing is changed, and you can run it again
once the lock is released. If the import is stopped, it ends at once and nothing is
changed. The result names any case where it could not confirm whether the import
was applied.
