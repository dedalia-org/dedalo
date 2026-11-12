---
title: A database statement of ordinary request traffic is now stopped after one minute by default.
type: changed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-db-bounds-on-by-default
---
`DB_STATEMENT_TIMEOUT_MS` now defaults to `60000` (it was `0`, no limit). A single runaway
query — for example a search on a deliberately unindexed field of a very large table — can no
longer hold a database connection for minutes while other users wait; it answers "the server
is busy" (`db.statement_timeout`) instead.

Long maintenance work is not affected: the maintenance-area actions, the data update, the
search-store builds a start-up runs when it finds one missing or damaged, and the observer
mirror reconcile (`scripts/observer_reconcile.ts`) run on the separate maintenance connections,
which have no limit. The retention prunes run in short batches.

**Action needed:** if searches or exports on very large sections are part of daily work on your
installation, measure them first (`DEDALO_SLOW_QUERY_MS`). An export whose record selection
takes longer than the limit is refused before its first line. Raise the value in
`../private/.env`, or set `DB_STATEMENT_TIMEOUT_MS=0` to restore the previous unbounded
behaviour.
