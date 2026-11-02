/**
 * THE MARKER'S TWO CONSTANTS, IN A MODULE THAT IMPORTS NOTHING.
 *
 * Split out of `test_database_marker.ts` (2026-08-25, coverage plan §4.4 D13)
 * for exactly one reason: `scripts/test_db_setup.ts` must ASK a target database
 * for the marker BEFORE it drops it, and it must ask over its own short-lived
 * `psql` subprocess. Importing the marker module would pull in
 * `src/core/db/postgres.ts`, whose pool connects at MODULE SCOPE — and a live
 * session on the target makes the very `DROP DATABASE` this check protects fail
 * with "being accessed by other users". A dependency-free module is the only
 * shape both sides can share.
 *
 * A second COPY of the name was not an option: `test_db_marker_tripwire` rule 5
 * scans `src/`, `tools/` and `scripts/` and allows the literal in exactly one
 * file. So this is the split the media root's protest-duplicate
 * (`test/helpers/test_media_root.ts`) could not have — one definition, zero
 * drift, no equality gate needed.
 *
 * Everything the marker MEANS — the row shape, the five properties, the one
 * producer — stays in `test_database_marker.ts`, which re-exports both names so
 * every engine-side consumer keeps ONE import site. This file is the name and
 * the sentence, and must never grow an import.
 */

/** The marker table. One name, one owner (the marker module + this half) — sql_confinement T4. */
export const TEST_MARKER_TABLE = 'dedalo_test_marker';

/**
 * The literal a CHECK constraint pins the single row's `purpose` to. Long and
 * specific ON PURPOSE: it is the part of the shape that cannot be typed by
 * accident (marker module header, property 2).
 */
export const TEST_MARKER_PURPOSE =
	'DISPOSABLE DEDALO TEST DATABASE — built by `bun run test:db:setup`, dropped and rebuilt at will. Every test-data writer REFUSES without this row. Never create it on a database holding real records.';

/**
 * Is this the NAME of a suite database — `<app db>_test` (test/helpers/test_database.ts,
 * the ONE derivation rule) or one of its shard clones `<…>_test__shard<N>`
 * (scripts/lib/test_shard_db.ts shardDatabaseName, built on {@link SHARD_SUFFIX})?
 *
 * A NAME test, for the few SYNC predicates that cannot ask the database for the marker
 * row (a boot-frozen carve-out, a module-scope test guard). It is never a write licence
 * — writers call `assertTestDatabase()`. It exists because the bare `endsWith('_test')`
 * these predicates used read a shard clone as a NON-suite database: MEASURED 2026-10-31,
 * observer_reconcile_native skipped 3 cases (75 → 51 assertions) on `…_test__shard4`
 * and only the per-file floor noticed. Pinned against shardDatabaseName by
 * shard_partition_tripwire.
 */
export const SHARD_SUFFIX = '__shard';
export function isSuiteDatabaseName(name: string): boolean {
	return /_test(__shard\d+)?$/.test(name);
}
