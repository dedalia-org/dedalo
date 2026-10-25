---
title: An export's record selection now respects the database statement ceiling.
type: fixed
audience: admin
date: 2026-10-21
breaking: false
wc: WC-2026-10-11-export-buffered-cap-and-admission
---
With `DB_STATEMENT_TIMEOUT_MS` set, computing an export's record selection could still run
far past it: PostgreSQL lifts the statement ceiling at the moment it builds the selection.
Now the selection runs under the same ceiling as every other request: an export whose
selection takes longer to compute is stopped at the ceiling with `db.statement_timeout`,
before its first line, and its database connection is freed. Installations that keep the
default `0` (no ceiling) see no change.
