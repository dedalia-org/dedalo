---
title: A publication run or unpublish no longer waits without limit on a lock held outside Dédalo
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-target-statement-lock-wait
---
Publishing to a MariaDB database waited as long as MariaDB let it (a day, by
default) when another session held a lock on the table — for example a long read
on the public website while a run added a column. Meanwhile every other
publication to that database waited too, and deleted records stayed published.
Now a statement waits at most 30 seconds for such a lock: the run fails and
releases the database (re-run it), a deleted record's unpublish stays pending and
is retried, and the language sweep and the media-index rebuild report the table.
