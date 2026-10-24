/**
 * THE TEST-DATABASE MARKER — the MECHANICAL half of "a test never writes to
 * production data" (AGENTS.md hard rules, 2026-08-19).
 *
 * WHY A MARKER AT ALL. Until now the guarantee rested on two conventions:
 * the suite runs on a database whose NAME is derived (`<app db>_test`,
 * test/helpers/test_database.ts), and each test-data door REMEMBERS to check
 * something (`test_tld_materialize`'s `expectDatabase`, the media kit's
 * `.dedalo_test_media` file). Dédalo runs in production with irreplaceable
 * heritage data and the suite must be runnable at any moment, so "the name
 * looks like a test name" and "the author remembered" are not the class of
 * guarantee this needs. A NAME is a claim about a database; the marker is the
 * database ITSELF asserting what it is, and every writer asks it.
 *
 * THE SHAPE, AND WHY IT CANNOT HAPPEN BY ACCIDENT. One dedicated table,
 * `dedalo_test_marker`, holding exactly one row:
 *
 *   id              integer PRIMARY KEY CHECK (id = 1)   — one row, by the DB
 *   purpose         text CHECK (purpose = <the literal below>)
 *   database_name   text  — the database this marker was WRITTEN INTO
 *   build_stamp     text  — ISO instant of the `test:db:setup` run
 *   git_rev         text  — the checkout that built it
 *   seed_sha256     text  — sha256 of install/db/dedalo_install.pgsql.gz
 *   ontology_sha256 text  — sha256 of src/core/test_data/test_tld_ontology.json
 *   created_at      timestamptz
 *
 * Five properties make it a real guarantee rather than a second convention:
 *
 *  1. NO OTHER PRODUCER. The table is in no install seed, in no
 *     `install/db/migrations/` file, and the engine never creates it at boot.
 *     `scripts/test_db_setup.ts` writes it, immediately after CREATE DATABASE
 *     on a database it has just dropped and rebuilt — nothing else in the tree
 *     calls `writeTestDatabaseMarker`.
 *  2. THE PURPOSE SENTENCE IS A CHECK CONSTRAINT. A hand-typed
 *     `CREATE TABLE dedalo_test_marker(...)` on a production database does not
 *     accidentally reproduce a 130-character sentence, an id-is-1 constraint
 *     and six mandatory columns. Creating this by mistake is not a slip; it is
 *     a paragraph of deliberate typing that says what it is doing.
 *  3. IT NAMES ITS OWN DATABASE. `database_name` is verified against
 *     `current_database()` on every read. Restoring a dump OF the test database
 *     into the application's database — the one realistic way a marker could
 *     travel — produces a marker naming the wrong database, and the guard
 *     refuses LOUDER than if there were none (that is a misrouted restore, and
 *     the operator should hear about it).
 *  4. IT IS ASSERTED, NOT ASSUMED. `assertTestDatabase(door)` is the ONE door
 *     every test-data writer calls first; `test/unit/test_db_marker_tripwire.test.ts`
 *     enumerates the writers from the SOURCE, so a new writer that forgets is red.
 *  5. IT IS PROVENANCE, NOT JUST A FLAG. The three stamps answer "which build
 *     is this database, and is it stale?" — the question that used to be
 *     answered by guessing.
 *
 * CHEAP TO READ. The hit path is a Map lookup, the miss path two small
 * queries. The Map comes from the sanctioned cache factory (module_state_tripwire
 * forbids module-level mutable state), and a NEGATIVE is never cached: a
 * database that has no marker must be re-asked, because a probe may have
 * removed the row inside a transaction it then rolls back (that is exactly how
 * the tripwire proves the refusal is real). Caching a POSITIVE for the process
 * is safe: the connection is frozen at config import (src/config/config.ts),
 * so one process never changes database under itself.
 *
 * THE ONE BYPASS. `src/core/install/db_restore.ts` materializes the `test` TLD
 * ONTOLOGY on a fresh REAL install (definitions, no records) — the one
 * legitimate test-data call outside a test database. It opts out explicitly
 * with `allowAnyDatabase: true` on `materializeTestTldOntology`, which is the
 * ONLY bypass in the tree and is asserted to be by the tripwire.
 */

import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';

// The name and the purpose sentence live in a DB-FREE sibling so the setup
// script's pre-DROP provenance check can use them over psql WITHOUT importing
// this module — whose postgres.ts import connects the pool at module scope, and
// a held session would make the very DROP it guards fail. Re-exported here so
// every engine-side consumer keeps one import site.
import { TEST_MARKER_PURPOSE, TEST_MARKER_TABLE } from './test_database_marker_constants.ts';

export { TEST_MARKER_PURPOSE, TEST_MARKER_TABLE };

/** The one row, as every reader sees it. */
export interface TestDatabaseMarker {
	/** The database the marker was written into — verified against `current_database()`. */
	database_name: string;
	/** ISO instant of the `test:db:setup` run that built this database. */
	build_stamp: string;
	/** The checkout that built it (`git rev-parse HEAD`, or `unknown`). */
	git_rev: string;
	/** sha256 of the install seed the database was restored from. */
	seed_sha256: string;
	/** sha256 of the `test` TLD ontology JSON materialized into it. */
	ontology_sha256: string;
	/** When the row was written. */
	created_at: string;
}

/**
 * Process cache of the POSITIVE marker (module header: "cheap to read").
 * The factory registration is incidental here — the marker is DDL, not
 * ontology-derived content — but it is the sanctioned way to own a
 * module-level Map, and an extra clear costs one small query.
 */
const markerCache = createOntologyCache<string, TestDatabaseMarker>();
const CACHE_KEY = 'marker';

/**
 * Process cache of the FINGERPRINT (below), which — unlike the marker itself —
 * caches the NEGATIVE too. Deliberate, and the reason is the surface it serves:
 * `/health` answers a watchdog on a tight cadence, and on a production database
 * (no marker, forever) an uncached negative would put two small queries on every
 * probe. The connection is frozen at config import, so a process never changes
 * database under itself; a test database REBUILT under a running server is
 * answered by restarting it, which the client-test runner does by owning the
 * server process it probes.
 */
const fingerprintCache = createOntologyCache<string, string>();
/** Cached stand-in for "this database carries no marker" (`''` is not a sha256). */
const NO_MARKER = '';

/** The module's named clearer — used by the tripwire's rollback probe. */
export function clearTestDatabaseMarkerCache(): void {
	markerCache.clear();
	fingerprintCache.clear();
}

function refuse(message: string, coordinates: Record<string, string> = {}): never {
	throw new DedaloError('internal.invariant', { message, coordinates });
}

/** `current_database()` — the database this process is actually connected to. */
export async function currentDatabaseName(): Promise<string> {
	const rows = (await sql`SELECT current_database() AS db`) as { db: string }[];
	return rows[0]?.db ?? '';
}

/** The single row, or null when the table or the row is absent. */
async function selectMarkerRow(): Promise<TestDatabaseMarker | null> {
	const present = (await sql`
		SELECT to_regclass(${`public.${TEST_MARKER_TABLE}`}) IS NOT NULL AS present
	`) as { present: boolean }[];
	if (present[0]?.present !== true) return null;
	const rows = (await sql.unsafe(
		`SELECT database_name, purpose, build_stamp, git_rev, seed_sha256, ontology_sha256,
		        created_at::text AS created_at
		   FROM "${TEST_MARKER_TABLE}" WHERE id = 1`,
	)) as (TestDatabaseMarker & { purpose: string })[];
	const row = rows[0];
	if (row === undefined) return null;
	if (row.purpose !== TEST_MARKER_PURPOSE) {
		refuse(
			`${TEST_MARKER_TABLE}: the row's purpose does not match the constant this engine ships — the marker was not written by 'bun run test:db:setup'. Nothing was written.`,
		);
	}
	return row;
}

/**
 * The marker of the CONNECTED database, or null when there is none.
 * A marker naming a DIFFERENT database is a misrouted restore, not an absence:
 * it refuses (module header, property 3).
 */
export async function readTestDatabaseMarker(): Promise<TestDatabaseMarker | null> {
	const cached = markerCache.get(CACHE_KEY);
	if (cached !== undefined) return cached;
	const row = await selectMarkerRow();
	if (row === null) return null;
	const live = await currentDatabaseName();
	if (row.database_name !== live) {
		refuse(
			`${TEST_MARKER_TABLE}: this marker names database '${row.database_name}' but the connection is to '${live}' — a test-database dump has been restored somewhere it does not belong. REFUSING every test-data write until that is resolved.`,
			{ marker_database: row.database_name, live },
		);
	}
	markerCache.set(CACHE_KEY, row);
	return row;
}

/**
 * THE ONE DOOR. Every test-data writer calls this FIRST, before any
 * transaction, and passes its own name so the refusal says who was refused.
 *
 * @param door  the writer's public name, e.g. `ensureTestCorpus`.
 */
export async function assertTestDatabase(door: string): Promise<TestDatabaseMarker> {
	const marker = await readTestDatabaseMarker();
	if (marker !== null) return marker;
	const live = await currentDatabaseName();
	return refuse(
		`${door}: REFUSING to write test data into database '${live}' — it carries no '${TEST_MARKER_TABLE}' row, so it is not a database this suite built and may hold real records. Build the test database with 'bun run test:db:setup'. Nothing was written.`,
		{ door, live },
	);
}

/**
 * THE MARKER, AS SOMETHING A REMOTE CALLER MAY BE TOLD — an opaque sha256 over
 * the marker's five fields, or `null` on a database that carries none.
 *
 * WHY A HASH AND NOT THE NAME. `bun run test:client` drives a LIVE SERVER, so
 * the runner must be able to verify WHICH DATABASE THAT SERVER IS ON before it
 * lets a browser write through it (scripts/client_test_server.ts). The only
 * honest way to ask is over the wire — and a wire field that carried the
 * database NAME would hand every anonymous caller of `/health` a piece of the
 * install's internals for the sake of a test. The fingerprint leaks nothing: it
 * is verifiable only by a caller that can ALREADY read the same marker row (it
 * recomputes it and compares), which is exactly the runner and nobody else.
 *
 * It changes on every `bun run test:db:setup` (build_stamp), so a runner
 * pointed at a server on a DIFFERENT test database — a colleague's, a second
 * checkout's — mismatches instead of quietly agreeing on "some test DB".
 */
export async function testDatabaseFingerprint(): Promise<string | null> {
	const cached = fingerprintCache.get(CACHE_KEY);
	if (cached !== undefined) return cached === NO_MARKER ? null : cached;
	const marker = await readTestDatabaseMarker();
	const fingerprint =
		marker === null
			? NO_MARKER
			: new Bun.CryptoHasher('sha256')
					.update(
						[
							marker.database_name,
							marker.build_stamp,
							marker.git_rev,
							marker.seed_sha256,
							marker.ontology_sha256,
						].join('\0'),
					)
					.digest('hex');
	fingerprintCache.set(CACHE_KEY, fingerprint);
	return fingerprint === NO_MARKER ? null : fingerprint;
}

/** The provenance a `test:db:setup` run stamps into the marker. */
export interface TestDatabaseMarkerInput {
	build_stamp: string;
	git_rev: string;
	seed_sha256: string;
	ontology_sha256: string;
}

/**
 * Create the table and write the single row. Called by `scripts/test_db_setup.ts`
 * ONLY, on a database it has just dropped and recreated (module header,
 * property 1). Idempotent: a re-run replaces the row.
 */
export async function writeTestDatabaseMarker(
	input: TestDatabaseMarkerInput,
): Promise<TestDatabaseMarker> {
	const live = await currentDatabaseName();
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS "${TEST_MARKER_TABLE}" (
		id              integer PRIMARY KEY CHECK (id = 1),
		purpose         text NOT NULL CHECK (purpose = '${TEST_MARKER_PURPOSE}'),
		database_name   text NOT NULL,
		build_stamp     text NOT NULL,
		git_rev         text NOT NULL,
		seed_sha256     text NOT NULL,
		ontology_sha256 text NOT NULL,
		created_at      timestamptz NOT NULL DEFAULT now()
	)`);
	await sql.unsafe(
		`INSERT INTO "${TEST_MARKER_TABLE}"
		   (id, purpose, database_name, build_stamp, git_rev, seed_sha256, ontology_sha256)
		 VALUES (1, $1, $2, $3, $4, $5, $6)
		 ON CONFLICT (id) DO UPDATE SET
		   purpose = EXCLUDED.purpose, database_name = EXCLUDED.database_name,
		   build_stamp = EXCLUDED.build_stamp, git_rev = EXCLUDED.git_rev,
		   seed_sha256 = EXCLUDED.seed_sha256, ontology_sha256 = EXCLUDED.ontology_sha256,
		   created_at = now()`,
		[
			TEST_MARKER_PURPOSE,
			live,
			input.build_stamp,
			input.git_rev,
			input.seed_sha256,
			input.ontology_sha256,
		],
	);
	clearTestDatabaseMarkerCache();
	const marker = await readTestDatabaseMarker();
	if (marker === null) refuse(`${TEST_MARKER_TABLE}: the row did not read back after writing it.`);
	return marker;
}
