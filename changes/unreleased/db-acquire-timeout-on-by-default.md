---
title: A request now waits at most 30 seconds for a free database connection by default.
type: changed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-db-bounds-on-by-default
---
`DB_POOL_ACQUIRE_TIMEOUT_MS` now defaults to `30000` (it was `0`, wait forever). When every
database connection of the server is busy, a request used to wait silently and indefinitely;
it now answers "the server is busy, try again in a moment" (`db.pool_exhausted`) after 30
seconds, which makes an exhausted pool visible instead of a frozen page.

**Action needed:** none for most installations. If you see that answer under normal load,
raise `DB_POOL_MAX` (within your PostgreSQL `max_connections` budget) or the timeout in
`../private/.env`; `DB_POOL_ACQUIRE_TIMEOUT_MS=0` restores the previous behaviour.
