---
title: Database statements slower than five seconds are now logged by default.
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-11-12-db-bounds-on-by-default
---
`DEDALO_SLOW_QUERY_MS` now defaults to `5000` (it was `0`, off). A statement taking longer
than 5 seconds — on any connection, the write path included — writes one warning line to
the server log naming the statement and the lane it ran on. Nothing is interrupted and
nothing changes for users: it is the measure to read before sizing the request statement
ceiling (`DB_STATEMENT_TIMEOUT_MS`).

**Action needed:** none. If the lines are noise on a slow machine, raise the value in
`../private/.env`; `DEDALO_SLOW_QUERY_MS=0` restores the previous silence.
