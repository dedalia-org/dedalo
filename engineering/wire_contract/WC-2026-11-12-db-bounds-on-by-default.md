# WC-2026-11-12-db-bounds-on-by-default — the database bounds are on by default

- **Date:** 2026-11-12 (RC-closure item T1-24, audit S17 + D02; PERF-11 C4).
- **Decision:** owner ruling 2026-11-11 — the retention prunes are BATCHED (not
  unbounded); the statement ceiling, the acquire timeout and the slow-query log
  flip SEPARATELY. DEC-12 (each flip lands with its config-census leg).
- **Envelope / fields:** none new. The typed 503s already exist
  (WC-2026-09-30-db-typed-503); this entry records that an installation which
  never set the keys now meets them.

## Shape before

- **PHP (v6):** `DEDALO_DB_STATEMENT_TIMEOUT` optional, sample default `0` — no
  bound; a runaway statement held its connection until it finished.
- **TS until this entry:** `DB_STATEMENT_TIMEOUT_MS` default `0` (no ceiling);
  the flip was gated on the long statements still running on the request pool
  (the boot search-store builds, the observer reconcile, the retention prunes).

## Shape after

- `DB_STATEMENT_TIMEOUT_MS` defaults to `60000`: a request-lane statement running
  past one minute answers 503 `db.statement_timeout` (it used to run unbounded).
  Exports whose record selection takes longer are refused before their first line
  (WC-2026-10-11-export-buffered-cap-and-admission).
- Unbounded at the SOURCE (`withUnboundedStatements`, the maintenance lane):
  `ensureSearchStores`, `backfillSearchStores`, `reconcileObserverMirrors`, and
  the discovery read + post-verify census of `scripts/migrate_section_id_locators.ts`.
  Entering any of them inside a request-lane transaction is the loud
  `internal.invariant` refusal.
- The retention prunes (matrix_activity, the dd1758 ledger) run in committed
  keyset batches; their reports gain `detail.batches`, `detail.batch_rows`,
  `detail.stopped` (`'aborted'` when SIGTERM stopped the pass between batches).
- `DB_POOL_ACQUIRE_TIMEOUT_MS` defaults to `30000` (flipped in its own commit): a
  caller that queues past 30 s for a connection of either pool answers 503
  `db.pool_exhausted` (retryable) instead of hanging. PHP v6 had no such bound.
- `DEDALO_SLOW_QUERY_MS` defaults to `5000` (flipped in its own commit, 2026-11-13,
  owner ruling A3): a statement slower than 5 s on ANY lane logs one `[db] slow
  query` warn line naming the lane. Log only — nothing on the wire changes and no
  statement is interrupted. PHP v6 sample default was `6000`.
- `0` restores the previous behaviour for each key.

## Reason

One runaway statement (a deliberately unindexed search reads a 33 M-row log for
~175 s; a closed browser does not cancel it) must not be able to hold a
connection forever on an install whose operator never read §4 of PRODUCTION.md.

## Gate reconciliation

No parity gate reads these defaults; the frozen fixtures are unaffected (no
re-harvest). Gates: `config_census_tripwire` (one leg per flipped key),
`retention_prune_batched_native`, `statement_ceiling_long_work_native`. Amends
WC-055 and WC-2026-09-30-db-typed-503 ("defaults unchanged").
