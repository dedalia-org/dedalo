/**
 * THE TEST-DATABASE MARKER TRIPWIRE — "a test never writes production data" is
 * MECHANICAL, not a convention (AGENTS.md hard rules, 2026-08-19).
 *
 * Dédalo runs in production with irreplaceable heritage data, and the suite
 * must be runnable at any moment. Until this gate the guarantee rested on a
 * NAME (`<app db>_test`, test/helpers/test_database.ts) plus each door
 * remembering to check something. A name is a claim ABOUT a database — point
 * `DEDALO_TEST_DATABASE` at a colleague's install, a second checkout or a
 * production restore and the name is "right" while the database is real.
 * `src/core/test_data/test_database_marker.ts` replaces that with the database
 * ITSELF declaring what it is (the `dedalo_test_marker` row), and every
 * test-data writer asking it first.
 *
 * EIGHT RULES, and every one of them has an anti-vacuity probe:
 *
 *  1. THE INVENTORY (source scan). Every file under `src/core/test_data/**` and
 *     `test/helpers/**` that HAS A WRITE SEAM must call `assertTestDatabase(`,
 *     or carry a named reason in `EXEMPT_WRITERS`. The list is DERIVED from the
 *     sources, so a NEW writer that forgets the guard is red the day it lands —
 *     which is the whole point: an enumerated list would rot into a convention
 *     again.
 *  2. EVERY DOOR REFUSES on a marker-less database. Proved for real, on the
 *     real doors: inside ONE transaction the marker row is DELETED, the marker
 *     cache cleared, every door called, and the transaction ROLLED BACK. The
 *     doors see a database with no marker on their own connection; the suite
 *     database never loses its row (dropping it mid-suite would poison every
 *     file that runs after this one).
 *  3. THE MARKER'S SHAPE on the suite database: the purpose sentence verbatim,
 *     the database it names, sha256-shaped provenance, and the DB-level
 *     constraints (one row only, purpose pinned) that make it impossible to
 *     create by accident.
 *  4. NO BYPASS (installer unification A2, 2026-10-09). The installer used to
 *     materialize the `test` TLD on every fresh install through an
 *     `allowAnyDatabase` opt-out; the install seed is now core-only and an
 *     installation receives no test fixture at all, so the opt-out is DELETED.
 *     Asserted as source (the word occurs in no engine source, comments
 *     stripped) AND behaviourally: the old installer call shape, smuggled past
 *     the type checker, REFUSES on a database with no marker.
 *  5. ONE PRODUCER. `writeTestDatabaseMarker` is called from
 *     `scripts/test_db_setup.ts` and nowhere else, and no install seed,
 *     migration or engine module so much as names the table.
 *  6. THE CLIENT RUN IS INSIDE THE LAW TOO (2026-08-19). `bun run test:client`
 *     drives a LIVE SERVER, so its writes never pass this process's guard — the
 *     hole the dmm fixture's exemption used to name. Closed by making the run
 *     OWN its server on the suite database (scripts/client_test_server.ts) and
 *     VERIFY it over the wire (`/health` answers the marker's FINGERPRINT, dev
 *     mode only, never the database name). Asserted as source (the runner has no
 *     unverified path to a target) and behaviourally (the probe refuses a server
 *     with no fingerprint and one with the wrong fingerprint, and accepts the
 *     right one — against real stub servers). And the name-level distinctness
 *     refusal is probed in BOTH directions (2026-08-25): it fires on a genuine
 *     suite-db == app-db collision and stays quiet on a distinct explicit
 *     DEDALO_TEST_DATABASE — the readEnv-based version of that guard was
 *     vacuous inside a test process (the preload rewrites DB_NAME) and this
 *     gate's happy-path-only assertion never noticed.
 *  7. A CLONE INHERITS THE MARKER, AND REWRITES THE ONE FIELD THE COPY MADE A
 *     LIE (2026-08-25, the parallel-shard work). A shard database is a
 *     `CREATE DATABASE … TEMPLATE <suite>` copy — 7612 MB and 907 s is not
 *     something a run can build N times — so it arrives carrying the template's
 *     marker row, which names the TEMPLATE and which rule 3 therefore refuses.
 *     The provisioning path rewrites `database_name = current_database()` (the
 *     connection's own identity, never a caller-supplied name), in INTERPOLATED
 *     form: demanding the literal table name here would demand exactly what
 *     rule 5 forbids, and the two rules could never both be green. Derived, not
 *     enumerated — the set of files performing that rewrite must be empty or
 *     exactly the one provisioner, so a rewrite landing elsewhere is red rather
 *     than a rule that skips forever. Rule 7b is its companion on the other
 *     side: `test:db:setup` builds the TEMPLATE and sweeps the TEMPLATE's media
 *     tree, so it must refuse a `<template>__shard<N>` target BEFORE any side
 *     effect (both existing name guards pass a shard name happily).
 *
 *  6b. THE CLIENT SERVER'S SURFACES FOLLOW THE LANE (2026-09-30). The spawned
 *     server's environment is composed in a CHILD process that starts from a
 *     shell carrying none of the preload-set seams (so a value inherited from
 *     this bun-test process cannot fake the answer): its database, media root
 *     and VECTOR database must all be the suite database's own derivations —
 *     the vector one was missing, so the client server read the installation's
 *     semantic index — and two runs must get distinct session stores/sockets.
 *  8. CONCURRENT LANES CAN BUILD (2026-09-30, closure plan Wave 0). Writer
 *     lanes each own a suite database (`DEDALO_TEST_DATABASE=<db>_lN`) and
 *     are provisioned in parallel — but `test:db:setup` step 5b mutates the
 *     CLUSTER-shared `dedalo_test_ro` role, and two builds at once died with
 *     `tuple concurrently updated` (measured). The step's exact text
 *     (readOnlyRoleClusterSql) is run concurrently here and every run must
 *     succeed; a positive control runs the same text MINUS its advisory lock
 *     and must produce the collision, so the harness provably contends.
 *  9. A TEST PROCESS THE PRELOAD NEVER REACHED OPENS NOTHING (2026-10-02). The
 *     preload is wired through bunfig.toml, which Bun reads from the CURRENT
 *     DIRECTORY: a `bun test` started outside the repo root (a scratch worktree,
 *     an agent's scratchpad) ran with no preload, so DB_NAME still named the
 *     APPLICATION database and every writing test wrote there (`dd128census_*`
 *     rows were found in one; 234 of the 302 writing unit files carry no guard of
 *     their own). The pool now refuses to build in a test process unless the
 *     preload armed that exact database (src/config/suite_database.ts). Proved by
 *     the decision table AND for real: a child `bun test` in a temp directory with
 *     no bunfig.toml, the preload-set seams stripped from its environment, must
 *     be REFUSED before any connection — and, as the positive control, the same
 *     child with DEDALO_TEST_DATABASE armed at the suite database must connect.
 *
 * HONEST LIMITS. The inventory is a REGEX classifier over stripped sources: it
 * sees DML text and the named write doors, not a write reached through an
 * arbitrary dynamic indirection. It covers the two directories test data lives
 * in — a writer someone puts in a third place is outside it, exactly as the
 * corpus of every source-scan gate in this tree is.
 *
 * And rule 7's binding half is PRESENCE-GATED on `scripts/lib/test_shard_db.ts`
 * (written in parallel with this gate, 2026-08-25): while the provisioner is
 * absent those tests do not run. What is NOT gated is the census — the "no
 * other file rewrites the marker" assertion, and every positive control, run
 * either way — so the window this leaves open is "the provisioner exists and is
 * correct", never "someone rewrote the marker somewhere else".
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Glob } from 'bun';
import {
	assertServedDatabase,
	probeServedDatabase,
	resolveSuiteDatabase,
} from '../../scripts/client_test_server.ts';
import { config } from '../../src/config/config.ts';
import {
	currentSuiteDatabaseEnv,
	suiteDatabaseRefusal,
	suitePoolRefusal,
} from '../../src/config/suite_database.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import { type DbConnDescriptor, runPsql } from '../../src/core/install/pg_exec.ts';
import {
	assertTestDatabase,
	clearTestDatabaseMarkerCache,
	currentDatabaseName,
	readTestDatabaseMarker,
	TEST_MARKER_PURPOSE,
	TEST_MARKER_TABLE,
	testDatabaseFingerprint,
} from '../../src/core/test_data/test_database_marker.ts';
import { materializeTestTldOntology } from '../../src/core/test_data/test_tld_materialize.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	applicationDatabaseName,
	READ_ONLY_ROLE_LOCK_KEY,
	readOnlyRoleClusterSql,
} from '../helpers/test_database.ts';
import { testMediaRootPath } from '../helpers/test_media_root.ts';
import { installationRagDatabaseName, suiteRagDatabaseName } from '../helpers/test_rag_database.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8');

// ---------------------------------------------------------------------------
// RULE 1 — the writer inventory, derived from the sources.
// ---------------------------------------------------------------------------

/** The two directories test data is written from. */
const WRITER_ROOTS = ['src/core/test_data', 'test/helpers'] as const;

/**
 * A write seam: raw DML, the unparameterised escape hatch used for DML, the
 * named matrix/ontology write doors, and the filesystem writes the media kit
 * makes. Same spirit as `test/helpers/no_write_scan.ts` (which asks the
 * opposite question of the identify subsystem), narrowed to actual mutation.
 */
const WRITE_SEAMS: readonly RegExp[] = [
	/\bINSERT\s+INTO\b/i,
	/\bUPDATE\s+"?[a-z_]+"?\s+SET\b/i,
	/\bDELETE\s+FROM\b/i,
	/\bTRUNCATE\b/i,
	/\bCREATE\s+TABLE\b/i,
	/\b(?:insert|update|delete)MatrixRecord\w*\s*\(/,
	/\bupsertDdOntologyNode\s*\(/,
	/\bdeleteTldNodes\s*\(/,
	/\b(?:writeFileSync|copyFileSync|mkdirSync|rmSync)\s*\(/,
	// ENGINE write drivers a helper can call without a single SQL string in
	// its own source — a spawned runner child (runJob writes job, dd1758 and
	// run-ledger rows and files), a component save, the ledgers' appenders.
	/\b(?:runJob|saveComponent|appendRunLedger|logDiffusionActivity)\s*\(/,
];

/**
 * Files with a write seam that do NOT call the guard, each with the reason it
 * is not part of the marker law. STALENESS IS FAILURE: an entry that is no
 * longer a writer (or no longer exists) is red, so a dead exemption cannot
 * quietly widen the hole.
 */
const EXEMPT_WRITERS: Readonly<Record<string, string>> = {
	'src/core/test_data/test_database_marker.ts':
		'THE GUARD ITSELF — it is the only writer of the marker row, and a guard that guarded itself could never be written the first time.',
	'test/helpers/test_media_root.ts':
		'WRITES NO DATA — it creates the suite MEDIA root and plants its `.dedalo_test_media` marker. It is the filesystem twin of this file and holds no database connection at all (importing config.ts there would freeze the connection before the preload repoints it); its own guard is test/unit/test_media_root_tripwire.test.ts.',
	'test/helpers/scratch_dir.ts':
		"WRITES NO DATA — the ONE door to OS-temp scratch space: `mkdtempSync` (atomic, random suffix, 0700) and the removal of a `dedalo_*` dir directly under the temp dir (refusing any other path). It creates and removes empty directories only, holds no database connection and imports no config; what a gate writes INTO a scratch dir goes through that gate's own guarded doors. Its own gate is test/unit/predictable_tmp_tripwire.test.ts.",
	'test/helpers/media_scratch_root.ts':
		"WRITES NO DATA — it plants the `.dedalo_test_media` marker in a gate's scratch directory so the media doors will write there. Filesystem only, no database.",
	'test/helpers/seed_contract.ts':
		"WRITES NO SUITE DATA — `restoreSeedRaw` restores an install seed into a scratch database the CALLING gate created moments before (`dedalo_seedcheck_<pid>` / `dedalo_seedcommitted_<pid>`, swept and FORCE-dropped by that gate), via a plain-SQL temp file in tmpdir it removes; it never connects to the suite database. The suite database cannot be its target: a restore refuses a non-empty database (the seed's CREATE TABLEs collide).",
	'test/helpers/install_host_scratch.ts':
		"WRITES NO DATA — `plantOwned` plants a directory or file with an OWNER into the CALLER's own installer scratch host (a mkdtemp root marked `.dedalo_install_scratch`, host/scratch.ts): the real path and the scratch HostFs owners sidecar. No database connection; the installer's host gates never touch the suite database.",
	'test/helpers/dev_serve_isolation.ts':
		"WRITES NO DATA — it makes a mkdtemp scratch dir (removed at process exit) holding a marked media root, its export-store sibling and a marked processes dir, through the media helpers' own doors, and returns ENV for a developer-route install CLI the CALLING gate runs against its own scratch `<prefix><pid>` database. No database connection; the server that env reaches is that scratch install's.",
	'test/helpers/child_driver.ts':
		"WRITES NO DATA — its one write is a throwaway TS driver file in its own mkdtemp scratch dir (removed on cleanup), run in a CHILD bun process that inherits this run's environment: the preload-repointed suite DB and marked media root. It holds no database connection itself; every driver it runs writes only through test-data doors that call assertTestDatabase (PERF-11/OPS-6 gates).",
	'test/helpers/isolated_gate.ts':
		"WRITES NO DATA — its one write is the child's JUnit report in its own mkdtemp scratch dir (removed after reading). The child is `bun test` from the repo root, so bunfig's preloads arm the suite database and the marked media root in it exactly as in any test process (childEnv() pins the suite database explicitly); every write the gate's body makes goes through doors that call assertTestDatabase.",
	'test/helpers/diffusion_rss_child.ts':
		"WRITES NO DATA OF ITS OWN — its one direct write is `5` to `/proc/self/clear_refs` (Linux), which resets the process's own peak-RSS mark at the measurement baseline; no file, no database. Its record files go through the diffusion writer under the parent gate's MARKED scratch media root (DEDALO_DIFFUSION_FILES_ROOT, the media guard inherited armed); it holds no database connection (diffusion_artifact_rss_native, PERF-2).",
	'test/helpers/suite_mariadb_lock.ts':
		"WRITES NO DÉDALO DATA — its one write is the diagnostic pid line of the suite MariaDB lane lock, `../private/test_mariadb/<suite db>/.lock`, inside a root the suite created and marked `.dedalo_test_mariadb` (it refuses a lane with no root). The lock itself is a kernel-held flock; the file's content decides nothing. No database connection of any kind. Guarded by test/unit/suite_mariadb_target_native.test.ts leg (i) (PUB-05).",
	'test/helpers/suite_mariadb.ts':
		"WRITES NO DÉDALO DATA — it installs, starts and provisions the suite's OWN MariaDB server (../private/test_mariadb/<suite db>, marked `.dedalo_test_mariadb`, a unix socket in a 0700 dir, --skip-networking) and writes only to a server it started and marked: its datadir, its target databases, and the `dedalo_test_mariadb_marker` rows the suite user can read but not write. It holds no Postgres connection. Guarded by test/unit/suite_mariadb_target_native.test.ts (PUB-05).",
	'test/helpers/suite_mariadb_lanes.ts':
		"WRITES NO DÉDALO DATA — the suite MariaDB lane SWEEP: it deletes only lane roots under ../private/test_mariadb/ (and a killed sweep's or claim's leftover beside one) that carry `.dedalo_test_mariadb`, the marker the suite writes when it creates a lane; an unmarked root or look-alike is refused and kept. Marker-last, so an interrupted delete stays sweepable. No database connection of any kind (the stop goes through suite_mariadb.ts). Guarded by test/unit/suite_mariadb_target_native.test.ts legs (k)-(m), (r) and test/unit/shard_mariadb_sweep_native.test.ts (PUB-05).",
	'test/helpers/release_identity_trees.ts':
		"WRITES NO DATA — it builds throwaway git repositories (and their `git archive` extractions) under the CALLER's own mkdtemp scratch root, which the calling gate removes; files only, no database connection. The release-identity gates (release_identity_native, release_identity_shell_parity) judge resolvers over those trees.",
	'test/helpers/engine_cli_tree.ts':
		"WRITES NO DATA — it copies the engine sources into the CALLER's own mkdtemp scratch directory (removed by the calling gate) and writes that copy's build_info.txt and version.ts pin, so the image-update channel CLI run from it calls itself a chosen release identity. Files only, no database connection; the CLI's check-target verb reads nothing but its own tree.",
	'test/helpers/matrix_writer_closure.ts':
		'WRITES NO DATA — a STATIC analyser (the write-path census shared by write_obligations and tool_lossless_writeback): it reads source text and holds no database connection. Its `PSQL_MATRIX_DML` regex NAMES the SQL keywords (`TRUNCATE`, `INSERT INTO`…) it looks for in other files, which is what the seam scan matches.',
	'test/helpers/media_seed_sweep.ts':
		"WRITES NO DATABASE DATA — it deletes, by name, the media FILES a gate seeded under the caller's test media root, and REFUSES (throws, deletes nothing) a root without the `.dedalo_test_media` marker: the filesystem twin of the marker law. No database connection.",
	'test/helpers/real_backup_archive.ts':
		"WRITES NO DÉDALO DATA — it READS the suite database (`pg_dump -F c -t dd_ontology`) and writes the archive bytes, a truncated copy and an mtime into the CALLER's scratch directory (the backup gates' mkdtemp). No database write, no media root.",
	'test/helpers/publication_host_fixtures.ts':
		'WRITES NO DATABASE DATA — the phase-3 publication-host helper (the ONLY one: the transport, mock-agent and pair-CLI gates import it). It creates a mkdtemp scratch base under the OS temp dir and plants `.dedalo_test_publication_hosts` in it (the only directory overridePublicationHostsBaseForTests accepts), and mints a throwaway PKI with the openssl CLI in a second mkdtemp dir it removes before returning. No database connection, no media root, never the live <private>.',
	'test/helpers/media_copy_mock_agent.ts':
		"WRITES NO DATABASE DATA — the phase-5 stateful mock copy agent: it keeps the agent's files and markers IN MEMORY, binds a unix socket in a 0700 mkdtemp dir under /tmp, and writes host records, tokens and runtime rows only through the publication-host stores while they resolve under the scratch base publication_host_fixtures.ts declares (useScratchMediaCopyStores arms it, plus a mkdtemp sha-cache dir). No database connection, no media root, never the live <private>.",
	'src/core/test_data/seed.ts':
		"NOT A TEST-ONLY WRITER: `resetTestSection`/`restoreCanonicalTest3` write the test3 PLAYGROUND records, and the reset is also the dev-mode maintenance widget (area_maintenance/widgets/unit_test.ts) on whatever database a DEV server runs — refused there unless the test TLD is installed (the playground is the suite's: the install seed is core-only). The suite reaches it through scripts/test_db_setup.ts and the test preload, both after the marker exists.",
};

/** Every `.ts` under the writer roots (tests excluded), repo-relative. */
function writerRootFiles(): string[] {
	const files: string[] = [];
	for (const root of WRITER_ROOTS) {
		for (const match of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, root) })) {
			if (match.endsWith('.test.ts')) continue;
			files.push(relative(REPO_ROOT, join(REPO_ROOT, root, match)));
		}
	}
	return files.sort();
}

/** Does this source MUTATE anything? Comments are prose ABOUT the rule. */
function hasWriteSeam(source: string): boolean {
	const code = stripComments(source);
	return WRITE_SEAMS.some((pattern) => pattern.test(code));
}

const writerFiles = writerRootFiles().filter((file) => hasWriteSeam(read(file)));

describe('rule 1 — every test-data writer asks the marker', () => {
	test('the scan finds the writers it is meant to see (anti-vacuity)', () => {
		// A floor, plus the load-bearing files BY NAME: a classifier that
		// silently stopped matching would otherwise leave this gate green over
		// an unguarded tree.
		expect(writerFiles.length).toBeGreaterThanOrEqual(8);
		for (const pinned of [
			'src/core/test_data/test_tld_materialize.ts',
			'src/core/test_data/test_corpus/ensure.ts',
			'src/core/test_data/situations/situation.ts',
			'test/helpers/test_data.ts',
			'test/helpers/acl_identity_fixture.ts',
			// The spawned runner children's door: its only write seam is the
			// engine's runJob() — no SQL string in its source.
			'test/helpers/diffusion_runner_door.ts',
			// `observer_term_seed.ts` was pinned here until 2026-08-20, when it
			// stopped writing directly and became a composition over
			// situations/situation.ts (pinned above). A file that writes nothing
			// cannot "ask the marker", and pinning it would force a redundant call.
		]) {
			expect(writerFiles, `${pinned} must be classified as a writer`).toContain(pinned);
		}
	});

	test('every writer calls assertTestDatabase, or is exempt with a reason', () => {
		const unguarded = writerFiles.filter(
			(file) =>
				!stripComments(read(file)).includes('assertTestDatabase(') &&
				EXEMPT_WRITERS[file] === undefined,
		);
		expect(
			unguarded,
			`These files write test data without asking the '${TEST_MARKER_TABLE}' marker. Call assertTestDatabase('<door>') before the first write, or add an entry to EXEMPT_WRITERS with the reason it is not test-only: ${unguarded.join(', ')}`,
		).toEqual([]);
	});

	test('no exemption is stale', () => {
		const stale = Object.keys(EXEMPT_WRITERS).filter((file) => !writerFiles.includes(file));
		expect(
			stale,
			`Exempt files that are no longer writers (or no longer exist). Delete the entry — a dead exemption widens the law silently: ${stale.join(', ')}`,
		).toEqual([]);
	});

	test('the classifier fires on a synthetic offender (anti-vacuity)', () => {
		expect(hasWriteSeam("await sql.unsafe('DELETE FROM matrix WHERE 1=1');")).toBe(true);
		expect(hasWriteSeam('await insertMatrixRecordWithExplicitId(t, s, i, c);')).toBe(true);
		// …and NOT on prose about writing, nor on a pure read.
		expect(hasWriteSeam('// this module would DELETE FROM matrix if it could\n')).toBe(false);
		expect(hasWriteSeam('const rows = await sql`SELECT 1`;')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// RULE 2 — the doors refuse on a marker-less database (rollback probe).
// ---------------------------------------------------------------------------

/**
 * Run `probe` on a connection where the marker row does not exist, then ROLL
 * BACK. The delete is transaction-local, so no other connection — and no later
 * test file — ever sees a database without its marker.
 */
async function withoutMarker<T>(probe: () => Promise<T>): Promise<T> {
	const rollback = new Error('test_db_marker_tripwire: intentional rollback');
	let captured: T | undefined;
	try {
		await withTransaction(async () => {
			await sql.unsafe(`DELETE FROM "${TEST_MARKER_TABLE}"`);
			clearTestDatabaseMarkerCache();
			captured = await probe();
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	} finally {
		// The cache must not carry the probe's view out of the transaction.
		clearTestDatabaseMarkerCache();
	}
	return captured as T;
}

/** The refusal a door produced, or null when it did NOT refuse. */
async function refusalOf(door: () => Promise<unknown>): Promise<string | null> {
	try {
		await door();
		return null;
	} catch (error) {
		if (error instanceof DedaloError) return error.message;
		return `NON-DedaloError: ${String(error)}`;
	}
}

/**
 * THE DOORS, by name, with the call that reaches each one. Every entry is a
 * REAL exported writer — the list is checked against the inventory above, so a
 * door added to a guarded file without a probe here is red.
 */
const DOORS: readonly { name: string; run: () => Promise<unknown> }[] = [
	{
		name: 'materializeTestTldOntology',
		// The name layer is SATISFIED on purpose (`expectDatabase` = the live
		// database), so the refusal below can only come from the marker layer.
		run: async () =>
			materializeTestTldOntology({
				expectDatabase: await currentDatabaseName(),
				doc: { tld: 'zzq', nodes: [] },
			}),
	},
	{
		// The AI spend ledger sweep (test/helpers/ai_spend_ledger.ts): a DELETE of
		// every ledger row — refused, writing nothing, on an unmarked database.
		name: 'sweepAiSpendLedger',
		run: async () => (await import('../helpers/ai_spend_ledger.ts')).sweepAiSpendLedger(),
	},
	{
		name: 'ensureTestCorpus',
		run: async () =>
			(await import('../../src/core/test_data/test_corpus/ensure.ts')).ensureTestCorpus('dd128'),
	},
	{
		name: 'dropTestCorpus',
		run: async () =>
			(await import('../../src/core/test_data/test_corpus/ensure.ts')).dropTestCorpus('dd128'),
	},
	{
		name: 'ensureMediaKit',
		run: async () =>
			(await import('../../src/core/test_data/test_corpus/ensure.ts')).ensureMediaKit({
				mediaRoot: '/nonexistent',
			}),
	},
	{
		name: 'ensureSituation',
		run: async () => {
			const module = await import('../../src/core/test_data/situations/situation.ts');
			return module.ensureSituation(module.situation({ name: 'zzmk', tld: 'zzmk', nodes: [] }));
		},
	},
	{
		name: 'dropSituation',
		run: async () => {
			const module = await import('../../src/core/test_data/situations/situation.ts');
			return module.dropSituation(module.situation({ name: 'zzmk', tld: 'zzmk', nodes: [] }));
		},
	},
	{
		name: 'ensureMapOfGrapesFixture',
		run: async () =>
			(
				await import('../../src/core/test_data/map_of_grapes_fixture.ts')
			).ensureMapOfGrapesFixture(),
	},
	{
		name: 'ensureSuiteProjectsFixture',
		run: async () =>
			(await import('../../src/core/test_data/projects_fixture.ts')).ensureSuiteProjectsFixture(),
	},
	{
		name: 'runCounterMark',
		run: async () =>
			(await import('../../src/core/test_data/run_created_records.ts')).runCounterMark(),
	},
	{
		name: 'sweepRecordsCreatedSince',
		run: async () =>
			(await import('../../src/core/test_data/run_created_records.ts')).sweepRecordsCreatedSince(
				Number.MAX_SAFE_INTEGER,
			),
	},
	{
		name: 'removeSuiteProjectsFixture',
		run: async () =>
			(await import('../../src/core/test_data/projects_fixture.ts')).removeSuiteProjectsFixture(),
	},
	{
		name: 'ensureSuiteLoginPassword',
		run: async () =>
			(await import('../../src/core/test_data/suite_login.ts')).ensureSuiteLoginPassword(
				'root',
				'Dedalo-Suite-Client-7',
			),
	},
	{
		name: 'createScratchRecord',
		run: async () =>
			(await import('../helpers/test_data.ts')).createScratchRecord('test2', 999_997, {}),
	},
	{
		name: 'cleanScratchRecord',
		run: async () => (await import('../helpers/test_data.ts')).cleanScratchRecord('test2', 999_997),
	},
	{
		name: 'cleanScratchTipo',
		run: async () => (await import('../helpers/test_data.ts')).cleanScratchTipo('zzmk1'),
	},
	{
		name: 'insertLegacyBulkRow',
		run: async () =>
			(await import('../helpers/legacy_bulk_run.ts')).insertLegacyBulkRow({
				sectionTipo: 'zzmk1',
				sectionId: 999_997,
				tipo: 'zzmk2',
				lang: 'lg-nolan',
				bulkId: null,
				data: [],
			}),
	},
	{
		// The tree-integrity situation (test/helpers/tree_lock_situation.ts): a raw
		// seed of a node's parent links — refused, writing nothing, unmarked.
		name: 'seedLinks',
		run: async () =>
			(await import('../helpers/tree_lock_situation.ts')).seedLinks(
				{
					section: 'zzmk1',
					term: 'zzmk2',
					parent: 'zzmk3',
					children: 'zzmk4',
					order: null,
					table: 'matrix_test',
				},
				999_997,
				[{ parent: 999_996, itemId: 1 }],
			),
	},
	{
		name: 'demoteToLegacyRun',
		run: async () => (await import('../helpers/legacy_bulk_run.ts')).demoteToLegacyRun(999_997),
	},
	{
		name: 'ensureSyntheticHierarchies',
		run: async () =>
			(
				await import('../../src/core/test_data/synthetic_hierarchy_fixture.ts')
			).ensureSyntheticHierarchies(),
	},
	{
		name: 'dropSyntheticHierarchies',
		run: async () =>
			(
				await import('../../src/core/test_data/synthetic_hierarchy_fixture.ts')
			).dropSyntheticHierarchies(),
	},
	{
		name: 'installAclIdentityFixture',
		run: async () =>
			(await import('../helpers/acl_identity_fixture.ts')).installAclIdentityFixture(),
	},
	{
		name: 'removeAclIdentityFixture',
		run: async () =>
			(await import('../helpers/acl_identity_fixture.ts')).removeAclIdentityFixture(),
	},
	{
		name: 'installReadDoorIdentityFixture',
		run: async () =>
			(await import('../helpers/read_door_identity_fixture.ts')).installReadDoorIdentityFixture(),
	},
	{
		name: 'removeReadDoorIdentityFixture',
		run: async () =>
			(await import('../helpers/read_door_identity_fixture.ts')).removeReadDoorIdentityFixture(),
	},
	{
		name: 'installAuthzDoorFixture',
		run: async () => (await import('../helpers/authz_door_fixture.ts')).installAuthzDoorFixture(),
	},
	{
		name: 'removeAuthzDoorFixture',
		run: async () => (await import('../helpers/authz_door_fixture.ts')).removeAuthzDoorFixture(),
	},
	{
		name: 'createDoorRecord',
		run: async () =>
			(await import('../helpers/authz_door_fixture.ts')).createDoorRecord('test3', 944021),
	},
	{
		name: 'sweepActivityRows',
		run: async () =>
			(await import('../helpers/activity_rows.ts')).sweepActivityRows('zzmk1', [999_997]),
	},
	{
		name: 'dropDoorRecords',
		run: async () => (await import('../helpers/authz_door_fixture.ts')).dropDoorRecords(),
	},
	{
		name: 'installHierarchyPruningFixture',
		run: async () =>
			(await import('../helpers/hierarchy_pruning_fixture.ts')).installHierarchyPruningFixture(),
	},
	{
		name: 'removeHierarchyPruningFixture',
		run: async () =>
			(await import('../helpers/hierarchy_pruning_fixture.ts')).removeHierarchyPruningFixture(),
	},
	{
		name: 'installOntologyAreaAccessFixture',
		run: async () =>
			(
				await import('../helpers/ontology_area_access_fixture.ts')
			).installOntologyAreaAccessFixture(),
	},
	{
		name: 'removeOntologyAreaAccessFixture',
		run: async () =>
			(
				await import('../helpers/ontology_area_access_fixture.ts')
			).removeOntologyAreaAccessFixture(),
	},
	{
		name: 'ensureZzarc',
		run: async () => {
			const module = await import('../helpers/zzarc_archive_situation.ts');
			return module.ensureZzarc(module.zzarcSituation());
		},
	},
	{
		name: 'installScopeBindingFixture',
		run: async () =>
			(await import('../helpers/scope_binding_fixture.ts')).installScopeBindingFixture(),
	},
	{
		name: 'removeScopeBindingFixture',
		run: async () =>
			(await import('../helpers/scope_binding_fixture.ts')).removeScopeBindingFixture(),
	},
	{
		// The spawned runner children (kill / pool legs) reach runJob only here;
		// a child process cannot run inside this rollback, the door can.
		name: 'runGuardedDiffusionJob',
		run: async () =>
			(await import('../helpers/diffusion_runner_door.ts')).runGuardedDiffusionJob(
				'00000000-0000-4000-8000-000000000000',
				1,
			),
	},
	// NOT LISTED, deliberately: `test/helpers/observer_term_seed.ts`. Until
	// 2026-08-20 it wrote an install thesaurus (`on1`) with its own
	// assertTestDatabase call and was a door in its own right. It is now a thin
	// composition over `situation()` — `ensureObserverTerm` / `dropObserverTerm`
	// simply call ensureSituation/dropSituation, which are listed ABOVE and which
	// refuse naming themselves. Listing the wrapper too would demand a SECOND
	// marker check on a function that writes nothing directly, and would make the
	// refusal name the wrapper instead of the door that actually refused.
];

describe('rule 2 — every door refuses without the marker', () => {
	test('all doors refuse, naming themselves — the retired installer bypass included', async () => {
		const outcome = await withoutMarker(async () => {
			const refusals: Record<string, string | null> = {};
			for (const door of DOORS) refusals[door.name] = await refusalOf(door.run);
			// RULE 4, behavioural half: the RETIRED installer call shape (the
			// `allowAnyDatabase` opt-out, smuggled past the type checker) must
			// refuse like any other call — there is no bypass left.
			const installer = await refusalOf(async () =>
				materializeTestTldOntology({
					allowAnyDatabase: true,
					doc: { tld: 'zzq', nodes: [] },
				} as never),
			);
			return { refusals, installer };
		});

		const notRefused = DOORS.filter((door) => outcome.refusals[door.name] === null).map(
			(door) => door.name,
		);
		expect(
			notRefused,
			`These doors WROTE (or tried to) on a database with no '${TEST_MARKER_TABLE}' row: ${notRefused.join(', ')}`,
		).toEqual([]);

		for (const door of DOORS) {
			const message = outcome.refusals[door.name] ?? '';
			expect(message, `${door.name}: the refusal must name the door`).toContain(door.name);
			expect(message, `${door.name}: the refusal must name the marker`).toContain(
				TEST_MARKER_TABLE,
			);
		}

		expect(
			outcome.installer,
			'the retired installer bypass (allowAnyDatabase) must REFUSE on a database with no marker — no bypass exists',
		).not.toBeNull();
		expect(outcome.installer ?? '').toContain('materializeTestTldOntology');
	});

	test('nothing the refused doors touch was written (the rollback restored the marker)', async () => {
		clearTestDatabaseMarkerCache();
		const marker = await readTestDatabaseMarker();
		expect(marker, 'the suite database must still carry its marker').not.toBeNull();
		const scratch = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_test WHERE section_tipo = 'test2' AND section_id = 999997`,
		)) as { n: number }[];
		expect(scratch[0]?.n ?? 0).toBe(0);
	});

	test('the probe itself can observe a marker (anti-vacuity)', async () => {
		// If `withoutMarker` silently failed to remove the row, rule 2 would be
		// asserting nothing at all. Prove both states are reachable.
		const seenInside = await withoutMarker(async () => readTestDatabaseMarker());
		expect(seenInside).toBeNull();
		clearTestDatabaseMarkerCache();
		expect(await readTestDatabaseMarker()).not.toBeNull();
	});

	test('every guarded writer file has at least one door probed here', () => {
		const guarded = writerFiles.filter(
			(file) =>
				EXEMPT_WRITERS[file] === undefined &&
				stripComments(read(file)).includes('assertTestDatabase('),
		);
		const probedIn = new Set<string>();
		for (const file of guarded) {
			const code = stripComments(read(file));
			for (const door of DOORS) {
				if (code.includes(`assertTestDatabase('${door.name}')`)) probedIn.add(file);
			}
		}
		const unprobed = guarded.filter((file) => !probedIn.has(file));
		expect(
			unprobed,
			`These files guard doors that RULE 2 never exercises — add the door to DOORS: ${unprobed.join(', ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 3 — the marker's shape on the suite database.
// ---------------------------------------------------------------------------

describe('rule 3 — the marker on the suite database', () => {
	test('carries the expected shape and provenance', async () => {
		clearTestDatabaseMarkerCache();
		const marker = await readTestDatabaseMarker();
		expect(
			marker,
			`No '${TEST_MARKER_TABLE}' row. Build the test database with 'bun run test:db:setup'.`,
		).not.toBeNull();
		const row = marker as NonNullable<typeof marker>;
		expect(row.database_name).toBe(await currentDatabaseName());
		expect(row.seed_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(row.ontology_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(row.git_rev).toMatch(/^([0-9a-f]{40}|unknown)$/);
		expect(Number.isNaN(Date.parse(row.build_stamp))).toBe(false);
	});

	test('assertTestDatabase returns it (the guard is not vacuous in either direction)', async () => {
		await expect(assertTestDatabase('test_db_marker_tripwire')).resolves.toBeDefined();
	});

	test('the DB itself pins the purpose and forbids a second row', async () => {
		const constraints = (await sql`
			SELECT pg_get_constraintdef(oid) AS def
			  FROM pg_constraint
			 WHERE conrelid = ${TEST_MARKER_TABLE}::regclass
		`) as { def: string }[];
		const defs = constraints.map((row) => row.def).join(' | ');
		expect(defs, 'the single-row CHECK must exist').toMatch(/CHECK \(\(?id = 1\)?\)/);
		expect(defs, 'the purpose CHECK must pin the exact sentence').toContain(
			TEST_MARKER_PURPOSE.slice(0, 40),
		);
		expect(defs, 'id must be the primary key').toMatch(/PRIMARY KEY/);

		// And behaviourally: a second row is refused by Postgres, not by us.
		const refused = await refusalOf(async () =>
			withTransaction(async () => {
				await sql.unsafe(
					`INSERT INTO "${TEST_MARKER_TABLE}" (id, purpose, database_name, build_stamp, git_rev, seed_sha256, ontology_sha256)
					 VALUES (2, $1, 'x', 'x', 'x', 'x', 'x')`,
					[TEST_MARKER_PURPOSE],
				);
			}),
		);
		expect(refused, 'a second marker row must be impossible').not.toBeNull();
	});

	test('a marker naming another database is refused, not accepted (anti-vacuity)', async () => {
		const outcome = await refusalOf(async () =>
			withTransaction(async () => {
				await sql.unsafe(`UPDATE "${TEST_MARKER_TABLE}" SET database_name = $1 WHERE id = 1`, [
					'some_other_database',
				]);
				clearTestDatabaseMarkerCache();
				await assertTestDatabase('test_db_marker_tripwire');
			}),
		);
		clearTestDatabaseMarkerCache();
		expect(outcome ?? '').toContain('does not belong');
		// The UPDATE was rolled back with the failing transaction.
		expect((await readTestDatabaseMarker())?.database_name).toBe(await currentDatabaseName());
	});
});

// ---------------------------------------------------------------------------
// RULES 4 + 5 — no bypass, the one producer.
// ---------------------------------------------------------------------------

/** Every tracked `.ts` under `src/`, `tools/` and `scripts/`, repo-relative. */
function engineSources(): string[] {
	const files: string[] = [];
	for (const dir of ['src', 'tools', 'scripts']) {
		for (const match of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, dir) })) {
			if (match.endsWith('.test.ts')) continue;
			files.push(relative(REPO_ROOT, join(REPO_ROOT, dir, match)));
		}
	}
	return files.sort();
}

describe('rule 4 — no bypass of the marker exists', () => {
	test('`allowAnyDatabase` occurs in no engine source (comments stripped)', () => {
		const users = engineSources().filter((file) =>
			stripComments(read(file)).includes('allowAnyDatabase'),
		);
		expect(
			users,
			'A bypass of the test-database marker came back. An installation receives no test fixture (the install seed is core-only); a writer that needs the test TLD must run on a database built by `bun run test:db:setup`.',
		).toEqual([]);
		// Anti-vacuity: the census reads the door and the installer it used to name.
		expect(engineSources()).toContain('src/core/test_data/test_tld_materialize.ts');
		expect(engineSources()).toContain('src/core/install/db_restore.ts');
	});

	test('the installer restore never calls the test-TLD door', () => {
		expect(stripComments(read('src/core/install/db_restore.ts'))).not.toContain(
			'materializeTestTldOntology',
		);
	});
});

describe('rule 5 — one producer of the marker', () => {
	test('`writeTestDatabaseMarker` is called from the setup script and nowhere else', () => {
		// STILL ONE ITEM after the shard work (2026-08-25), and that was CHECKED,
		// not assumed: the shard provisioning path does NOT produce a marker — a
		// clone INHERITS the template's row and rewrites only `database_name`
		// (rule 7). Minting one there would fabricate provenance the shard never
		// performed, and would create a second path able to stamp the row onto a
		// database nobody proved was a clone. Rule 7 asserts that absence, so this
		// list can only grow through a deliberate edit in both places.
		const callers = engineSources().filter(
			(file) =>
				file !== 'src/core/test_data/test_database_marker.ts' &&
				stripComments(read(file)).includes('writeTestDatabaseMarker'),
		);
		expect(callers).toEqual(['scripts/test_db_setup.ts']);
	});

	test('no install seed, migration or engine module creates the table', () => {
		const namers = engineSources().filter(
			(file) =>
				file !== 'src/core/test_data/test_database_marker.ts' &&
				// The literal's ONE definition site — split DB-free (D13, 2026-08-25) so
				// scripts/test_db_setup.ts can ask a target for the marker over psql
				// without importing the pool (postgres.ts connects at module scope) and
				// without a second copy of the name.
				file !== 'src/core/test_data/test_database_marker_constants.ts' &&
				stripComments(read(file)).includes(TEST_MARKER_TABLE),
		);
		expect(
			namers,
			`Only the marker module may name the '${TEST_MARKER_TABLE}' table (sql_confinement T4).`,
		).toEqual([]);
		const migrations = [
			...new Glob('*.sql').scanSync({ cwd: join(REPO_ROOT, 'install', 'db', 'migrations') }),
		].filter((file) =>
			readFileSync(join(REPO_ROOT, 'install', 'db', 'migrations', file), 'utf-8').includes(
				TEST_MARKER_TABLE,
			),
		);
		expect(migrations, 'a migration must never create the marker on an install').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 6 — the client suite's server is on the suite database.
// ---------------------------------------------------------------------------

describe('rule 6 — the client run cannot drive a server on the app database', () => {
	test('the runner resolves the suite database and verifies the target (source)', () => {
		const runner = stripComments(read('scripts/client_test_runner.ts'));
		for (const call of [
			'resolveSuiteDatabase()',
			'repointProcessToSuiteDatabase(',
			'localSuiteFingerprint()',
			'assertServedDatabase(',
			'startClientTestServer(',
		]) {
			expect(runner, `scripts/client_test_runner.ts must call ${call}`).toContain(call);
		}
		// NO UNVERIFIED DOOR TO A TARGET. The rule is a PROVENANCE rule, not a
		// count: every URL the browser is sent to must derive from the target
		// openTarget verified (it resolves the suite database and probes the
		// server's fingerprint). Counting `page.goto(` sites would say the same
		// thing only while there is exactly one — and the a11y phase legitimately
		// opens a second page ON THE SAME verified origin.
		const gotoArguments = [...runner.matchAll(/page\.goto\(\s*([^,)]+)/g)].map((m) =>
			(m[1] ?? '').trim(),
		);
		expect(gotoArguments.length, 'the scan must find the navigations').toBeGreaterThan(0);
		for (const argument of gotoArguments) {
			// An identifier, never a literal or a concatenation assembled at the call.
			expect(argument, `page.goto(${argument}) — navigate to a named, verified URL`).toMatch(
				/^[A-Za-z_$][\w$]*$/,
			);
			// …and that name is assigned from the VERIFIED target: its url, or a
			// path on the origin derived from it.
			const fromTarget = new RegExp(`const ${argument} = target\\.url;`).test(runner);
			const fromOrigin = new RegExp(`const ${argument} = \`\\$\\{origin\\}`).test(runner);
			expect(
				fromTarget || fromOrigin,
				`${argument} must be assigned from the verified target (target.url, or a path on its origin)`,
			).toBe(true);
		}
		// The only origin the a11y phase can be given is the verified target's.
		expect(runner).toContain('runAxePhase(page, originOf(testUrl))');
		expect(runner).toContain('const suite = await prepareSuiteDatabase();');
		expect(runner).toContain('const target = await openTarget(suite);');
	});

	test('the wire field is dev-mode-only and is a hash, never the database name', () => {
		const server = stripComments(read('src/server.ts'));
		expect(server, 'the /health identity must come from the marker fingerprint').toContain(
			'testDatabaseFingerprint',
		);
		expect(server, 'and it must be gated on dev mode').toContain('DEV_MODE_HEALTH_DB_IDENTITY');
		// The name must not be reachable from the health payload.
		expect(server).not.toContain('currentDatabaseName');
	});

	test('the fingerprint identifies THIS database, and is absent without a marker', async () => {
		clearTestDatabaseMarkerCache();
		const fingerprint = await testDatabaseFingerprint();
		expect(fingerprint, 'the suite database must produce a fingerprint').toMatch(/^[0-9a-f]{64}$/);
		// It is derived from the marker, so it is stable within a build...
		clearTestDatabaseMarkerCache();
		expect(await testDatabaseFingerprint()).toBe(fingerprint as string);
		// ...and it does NOT leak the database name.
		expect(fingerprint).not.toContain(await currentDatabaseName());
		// A database with no marker answers nothing at all (anti-vacuity).
		expect(await withoutMarker(async () => testDatabaseFingerprint())).toBeNull();
		clearTestDatabaseMarkerCache();
	});

	test('the probe refuses a server that is not on this suite database', async () => {
		const expected = (await testDatabaseFingerprint()) as string;
		const cases: { name: string; payload: Record<string, unknown>; refuses: boolean }[] = [
			// A production/app-database server: dev mode off, or no marker at all.
			{ name: 'no fingerprint', payload: { result: 'ok', entity: 'x' }, refuses: true },
			{ name: 'null fingerprint', payload: { result: 'ok', test_database: null }, refuses: true },
			// Someone else's test database (or one rebuilt since that server booted).
			{
				name: 'another suite database',
				payload: { result: 'ok', test_database: 'f'.repeat(64) },
				refuses: true,
			},
			{
				name: 'this suite database',
				payload: { result: 'ok', test_database: expected },
				refuses: false,
			},
		];
		for (const probeCase of cases) {
			const stub = Bun.serve({
				port: 0,
				fetch: (request) =>
					new URL(request.url).pathname === '/health'
						? Response.json(probeCase.payload)
						: new Response('no', { status: 404 }),
			});
			const origin = `http://localhost:${stub.port}`;
			try {
				const served = await probeServedDatabase(origin);
				const outcome = await refusalOf(async () =>
					assertServedDatabase({ origin, expected, served }),
				);
				if (probeCase.refuses) {
					expect(outcome ?? '', `${probeCase.name}: must be refused`).toContain('REFUSING');
				} else {
					expect(outcome, `${probeCase.name}: must be accepted`).toBeNull();
				}
			} finally {
				stub.stop(true);
			}
		}
	});

	test('the suite database name is never the application database', () => {
		// The runner refuses before it does anything else; proved here rather than
		// by pointing a real run at the app database.
		const { suiteDb, appDb } = resolveSuiteDatabase();
		expect(suiteDb).not.toBe(appDb);
		expect(suiteDb).not.toBe('');
		// The app side must be the INSTALLATION's database (../private/.env), not
		// this process's rewritten env — the preload set DB_NAME to the suite DB,
		// so a readEnv-based appDb would silently be the suite's own name.
		expect(appDb).toBe(applicationDatabaseName() ?? '');
	});

	test('the distinctness refusal is not vacuous: a genuine collision refuses', () => {
		// HOW THE HAPPY-PATH-ONLY VERSION OF THIS GATE LET THE DEFECT LIVE.
		// resolveSuiteDatabase() used readEnv('DB_NAME') for the app side, but
		// the preload rewrites process.env.DB_NAME to the SUITE database and
		// readEnv gives process env precedence — so inside every bun test run the
		// guard compared `<suite>_test` against `<suite>`: always distinct, never
		// the application database, and the test above stayed green forever
		// (measured 2026-08-25). Worse, with DEDALO_TEST_DATABASE explicit the
		// same trap FALSE-fired: both sides resolved to the identical explicit
		// value and the guard refused a perfectly safe run. This test drives BOTH
		// directions over a mutated env, so a regression to readEnv on either
		// side of the comparison is red the day it lands.
		// THE APP NAME IS SUPPLIED, NOT REQUIRED FROM DISK. This used to read
		// ../private/.env and THROW when it was absent, on the reasoning that the
		// suite this gate runs on is configured there. True on a developer box,
		// false on the hosted DB tier: scripts/ci/db_tier.sh composes its whole
		// environment in-process precisely so no such file exists, so the probe
		// threw on every runner — the 15th red gate of that tier, and the only one
		// of the fifteen that was about this gate at all.
		//
		// Injecting the name keeps the probe running EVERYWHERE rather than
		// skipping where it matters most. The real file is still preferred when it
		// is there, so the developer-box case is unchanged; the synthetic name is
		// only a stand-in for "some application database", which is all the three
		// cases below need it to be.
		const appDb = applicationDatabaseName() ?? 'dedalo_probe_application_db';
		const savedExplicit = process.env.DEDALO_TEST_DATABASE;
		try {
			// (a) GENUINE COLLISION — the operator points DEDALO_TEST_DATABASE at
			// the application database itself. This is the one mistake the guard
			// exists to make impossible, and it must refuse.
			process.env.DEDALO_TEST_DATABASE = appDb;
			expect(() => resolveSuiteDatabase(appDb)).toThrow(/REFUSING to run the client suite/);
			// (b) EXPLICIT BUT DISTINCT — the parallel-shard shape. The old
			// readEnv-based guard refused exactly this safe case; it must pass.
			process.env.DEDALO_TEST_DATABASE = `${appDb}_test_shard_probe`;
			expect(resolveSuiteDatabase(appDb)).toEqual({
				suiteDb: `${appDb}_test_shard_probe`,
				appDb,
			});
			// (c) UNSET — the everyday derived name. Must pass too, and against the
			// REAL app database name, not this process's rewritten one.
			delete process.env.DEDALO_TEST_DATABASE;
			const derived = resolveSuiteDatabase(appDb);
			expect(derived.appDb).toBe(appDb);
			expect(derived.suiteDb).not.toBe(appDb);
		} finally {
			// Restore the snapshot exactly — other files in this run derive the
			// suite database from the same env.
			if (savedExplicit === undefined) {
				delete process.env.DEDALO_TEST_DATABASE;
			} else {
				process.env.DEDALO_TEST_DATABASE = savedExplicit;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// RULE 7 — CLONE PROVENANCE: a shard database INHERITS the marker, and rewrites
// the ONE field the copy turned into a lie.
// ---------------------------------------------------------------------------

/**
 * WHY THIS RULE EXISTS (2026-08-25, the parallel-shard work).
 *
 * The suite database is 7612 MB and takes 907 s to build from the seed, so a
 * sharded run cannot build N of them: each shard gets a `CREATE DATABASE
 * <shard> TEMPLATE <suite>` clone (Postgres 18.4 here, STRATEGY = FILE_COPY),
 * which copies the template's files — the `dedalo_test_marker` row INCLUDED.
 *
 * That copy is what makes this rule necessary. The inherited row still says
 * `database_name = '<template>'`, and rule 3's law is that a marker naming
 * ANOTHER database is refused (`assertTestDatabase` throws "does not belong").
 * So every shard would refuse every write, on a database that is in fact a
 * disposable clone of a disposable database. The provisioning path therefore
 * rewrites exactly one field, on the clone's own connection:
 *
 *     UPDATE "<marker table>" SET database_name = current_database()
 *
 * `current_database()` and not a name the caller passed in: the value must come
 * from the connection that is about to be written through, so a provisioner
 * pointed at the wrong database cannot stamp a correct-looking marker onto it.
 *
 * THE SHAPE IS INTERPOLATED, NEVER THE LITERAL, and that is not a style
 * preference — it is what keeps this rule and RULE 5 simultaneously
 * satisfiable. Rule 5 allows the string `dedalo_test_marker` in exactly ONE
 * file under `src/`, `tools/` and `scripts/` (the DB-free constants module). A
 * rule 7 that demanded the literal in the provisioner would demand precisely
 * what rule 5 forbids, and the two gates could never both be green. So the
 * provisioner IMPORTS `TEST_MARKER_TABLE` and interpolates it, and this rule
 * asserts THAT — plus the absence of the literal, so the escape hatch is shut
 * from this side too.
 *
 * WHY IT IS NOT A SECOND MARKER PRODUCER (rule 5's list stays one item long).
 * The clone does not MINT a marker: minting one means asserting provenance —
 * `build_stamp`, `git_rev`, `seed_sha256`, `ontology_sha256` — about a build
 * the shard never performed, and it means a path that can create the row on a
 * database nobody proved was a clone (which is exactly the production-shaped
 * accident the whole marker law exists to make impossible). A shard's
 * provenance IS the template's; the only fact the copy invalidated is the name,
 * and the name is the only thing rewritten. `writeTestDatabaseMarker` therefore
 * stays pinned to `scripts/test_db_setup.ts` in rule 5, and this rule asserts
 * the provisioner does not call it — so a future change to a mint-shaped
 * provisioner is a deliberate edit to BOTH lists, not a quiet widening.
 *
 * PRESENCE-GATED, BUT NOT ON `existsSync` ALONE. `scripts/lib/test_shard_db.ts`
 * is being written in parallel with this gate. A rule that merely skipped while
 * the file was missing would also skip forever if the provisioner landed under
 * a different name — a silent narrowing. So the census is DERIVED: every file
 * under `src/`, `tools/` and `scripts/` is classified, and the set that
 * rewrites the marker must be EXACTLY the empty set (tier not landed) or
 * EXACTLY `[SHARD_PROVISIONER]`. A provisioner somewhere else is red, and the
 * fix is to move it or to change the pin on purpose.
 */

/** The ONE provisioning path allowed to rewrite an inherited marker. */
const SHARD_PROVISIONER = 'scripts/lib/test_shard_db.ts';

/**
 * The shard namespace. `<template>__shard<N>` — the double underscore is what
 * makes a shard name recognisable to `scripts/test_db_setup.ts` without a
 * second source of truth about the shard list.
 */
const SHARD_NAME_SHAPE = /__shard\d+$/;

const shardTierLanded = existsSync(join(REPO_ROOT, SHARD_PROVISIONER));

/**
 * Does this source perform the clone's marker rewrite, in the interpolated
 * form? Returns the REASONS it does not, so a half-written provisioner fails
 * naming what is missing instead of vanishing from a census.
 */
function markerRewriteFaults(source: string): string[] {
	const code = stripComments(source);
	const faults: string[] = [];
	if (
		!/import\s*(?:type\s*)?\{[^}]*\bTEST_MARKER_TABLE\b[^}]*\}\s*from\s*['"][^'"]*test_database_marker(?:_constants)?\.ts['"]/.test(
			code,
		)
	) {
		faults.push('it does not IMPORT TEST_MARKER_TABLE from the marker constants module');
	}
	if (!/UPDATE\s+"?\$\{TEST_MARKER_TABLE\}"?\s+SET\b/.test(code)) {
		faults.push('it has no `UPDATE "${TEST_MARKER_TABLE}" SET …` (the interpolated shape)');
	}
	if (!/database_name\s*=\s*current_database\(\)/.test(code)) {
		faults.push(
			'the rewrite does not set database_name = current_database() (the value must come from the connection being written through, never from a caller-supplied name)',
		);
	}
	if (code.includes(TEST_MARKER_TABLE)) {
		faults.push(
			`it spells the marker table LITERALLY; rule 5 allows that literal in one file only, so the literal form would make rules 5 and 7 mutually unsatisfiable — import ${'TEST_MARKER_TABLE'} instead`,
		);
	}
	return faults;
}

/** The files that perform the rewrite, derived — never enumerated. */
function markerRewriters(): string[] {
	return engineSources().filter((file) => markerRewriteFaults(read(file)).length === 0);
}

describe('rule 7 — clone provenance: the shard marker rewrite', () => {
	test('the matcher fires and refuses correctly on synthetic sources (positive control)', () => {
		const importLine = `import { TEST_MARKER_TABLE } from '../../src/core/test_data/test_database_marker_constants.ts';`;
		// The conforming shape, spelled in single quotes so `${…}` stays TEXT.
		const conforming = [
			importLine,
			'await sql.unsafe(`UPDATE "${TEST_MARKER_TABLE}" SET database_name = current_database() WHERE id = 1`);',
		].join('\n');
		expect(markerRewriteFaults(conforming)).toEqual([]);

		// THE POSITIVE CONTROL THAT MATTERS: the literal form. It is what a
		// well-meaning author writes, it would satisfy a naive "does it rewrite
		// the marker" matcher, and it is exactly what rule 5 forbids.
		const literalForm = [
			importLine,
			`await sql.unsafe('UPDATE "${TEST_MARKER_TABLE}" SET database_name = current_database() WHERE id = 1');`,
		].join('\n');
		expect(markerRewriteFaults(literalForm).length).toBeGreaterThan(0);

		// A caller-supplied name instead of the connection's own identity.
		const hardcodedName = [
			importLine,
			'await sql.unsafe(`UPDATE "${TEST_MARKER_TABLE}" SET database_name = ${shardDb}`);',
		].join('\n');
		expect(markerRewriteFaults(hardcodedName).length).toBeGreaterThan(0);

		// No import of the constant at all.
		expect(
			markerRewriteFaults(
				'await sql.unsafe(`UPDATE "${TEST_MARKER_TABLE}" SET database_name = current_database()`);',
			).length,
		).toBeGreaterThan(0);

		// And PROSE about the rewrite is not the rewrite (comments are stripped).
		expect(
			markerRewriteFaults(
				`${importLine}\n// UPDATE "\${TEST_MARKER_TABLE}" SET database_name = current_database()\n`,
			).length,
		).toBeGreaterThan(0);
	});

	test('the source census is not vacuous (anti-vacuity floor)', () => {
		// If engineSources() or the reader broke, every assertion below would pass
		// over an empty tree. Same floor the sibling rules use.
		const sources = engineSources();
		expect(sources.length).toBeGreaterThan(200);
		expect(sources).toContain('scripts/test_db_setup.ts');
		expect(sources).toContain('src/core/test_data/test_database_marker.ts');
	});

	test('exactly one file rewrites the marker, and only the shard provisioner may', () => {
		const rewriters = markerRewriters();
		expect(
			rewriters,
			shardTierLanded
				? `The shard provisioning path (${SHARD_PROVISIONER}) is the ONLY file that may rewrite an inherited marker. A second rewriter is a second way for a database to claim it is a disposable clone: ${rewriters.join(', ')}`
				: `${SHARD_PROVISIONER} is not present, so NOTHING may rewrite the marker yet. A rewrite landing anywhere else would leave this rule permanently skipped — move it to ${SHARD_PROVISIONER}, or change the pin deliberately: ${rewriters.join(', ')}`,
		).toEqual(shardTierLanded ? [SHARD_PROVISIONER] : []);
	});

	test.if(shardTierLanded)('the provisioner rewrites the marker in the interpolated shape', () => {
		const faults = markerRewriteFaults(read(SHARD_PROVISIONER));
		expect(
			faults,
			`${SHARD_PROVISIONER} clones the suite database, so it inherits a marker naming the TEMPLATE — which rule 3 refuses. It must rewrite it, and in the interpolated form: ${faults.join(' | ')}`,
		).toEqual([]);
	});

	test.if(shardTierLanded)(
		'the provisioner is NOT a second marker PRODUCER (rule 5 addendum)',
		() => {
			// Rule 5's first test pins `writeTestDatabaseMarker` callers to exactly
			// ['scripts/test_db_setup.ts']. CHECKED AND DELIBERATELY NOT WIDENED: the
			// provisioner inherits the row through the clone and edits one field, so
			// it never produces a marker and must not appear in that list. This test
			// makes the decision mechanical — the day the provisioner starts minting
			// markers it goes red HERE, forcing the edit to rule 5's list to be an
			// argued one rather than a green side effect.
			expect(
				stripComments(read(SHARD_PROVISIONER)).includes('writeTestDatabaseMarker'),
				`${SHARD_PROVISIONER} must NOT call writeTestDatabaseMarker: minting a marker asserts provenance (build_stamp, git_rev, seed/ontology sha) about a build the shard never performed, and creates a path that can stamp the row onto a database nobody proved was a clone. A shard's provenance IS the template's; only the name is rewritten.`,
			).toBe(false);
		},
	);
});

// ---------------------------------------------------------------------------
// RULE 7b — `test:db:setup` refuses a SHARD name before it touches anything.
// ---------------------------------------------------------------------------

/**
 * `scripts/test_db_setup.ts` builds THE TEMPLATE: it DROPs its target and
 * SWEEPS that target's media tree. Point `DEDALO_TEST_DATABASE` at a shard
 * clone (`<template>__shard3` — a leftover env var from a sharded run is the
 * everyday way this happens) and it would rebuild an ephemeral clone as if it
 * were the fixture, at 907 s, and delete the media tree keyed to that shard.
 * Both existing name guards let it through: a shard name IS distinct from the
 * application database, and it IS `[A-Za-z0-9_.-]+`.
 *
 * So the script must refuse the shard namespace, and refuse it BEFORE any side
 * effect — `rebuildTestMediaRoot()` sweeps a tree before the first psql call,
 * so "it fails eventually" is not the same as "nothing was touched".
 */
const SETUP_SIDE_EFFECTS = [
	'rebuildTestMediaRoot(',
	'DROP DATABASE',
	'CREATE DATABASE',
	'await psql(',
];

/** Reasons the source does NOT refuse shard names before its first side effect. */
function shardRefusalFaults(source: string): string[] {
	const code = stripComments(source);
	const faults: string[] = [];
	const refusalAt = code.indexOf('__shard');
	if (refusalAt === -1) {
		return ['it never mentions the `__shard` namespace at all'];
	}
	const firstSideEffect = SETUP_SIDE_EFFECTS.map((token) => code.indexOf(token))
		.filter((at) => at !== -1)
		.sort((a, b) => a - b)[0];
	if (firstSideEffect === undefined) {
		// The side-effect tokens are the anti-vacuity floor for THIS matcher: if
		// none of them is found the ordering assertion below would be trivially
		// true, so refuse instead of passing.
		return ['none of the known side-effect tokens was found — the ordering check would be vacuous'];
	}
	if (refusalAt > firstSideEffect) {
		faults.push(
			'the shard refusal comes AFTER a side effect (a tree is swept / a database dropped first)',
		);
	}
	const block = code.slice(Math.max(0, refusalAt - 900), refusalAt + 900);
	if (!block.includes('REFUSING'))
		faults.push('the shard check does not REFUSE (no refusal message)');
	if (!block.includes('process.exit(1)')) faults.push('the shard check does not exit non-zero');
	return faults;
}

describe('rule 7b — the setup script refuses a shard name, before touching anything', () => {
	test('the matcher fires on synthetic offenders (positive control)', () => {
		const refusal = [
			'if (SHARD.test(testDb)) {',
			"  console.error(`REFUSING: '${testDb}' is in the __shard namespace`);",
			'  process.exit(1);',
			'}',
		].join('\n');
		const sideEffect = 'const mediaRoot = rebuildTestMediaRoot(testDb);\nawait psql(testDb, []);';
		expect(shardRefusalFaults(`${refusal}\n${sideEffect}`)).toEqual([]);
		// Ordering inverted — the tree is swept before the refusal.
		expect(shardRefusalFaults(`${sideEffect}\n${refusal}`).length).toBeGreaterThan(0);
		// Present, ordered, but not actually a refusal.
		expect(shardRefusalFaults(`const shardish = /__shard/;\n${sideEffect}`).length).toBeGreaterThan(
			0,
		);
		// Absent entirely.
		expect(shardRefusalFaults(sideEffect)).toEqual([
			'it never mentions the `__shard` namespace at all',
		]);
		// Prose is not a refusal.
		expect(
			shardRefusalFaults(`// refuse __shard names here one day\n${sideEffect}`).length,
		).toBeGreaterThan(0);
	});

	test('the shard name shape is the one both sides agree on', () => {
		// The contract between this gate, the provisioner and the setup script.
		expect(SHARD_NAME_SHAPE.test('dedalo_v7_mht_test__shard3')).toBe(true);
		expect(SHARD_NAME_SHAPE.test('dedalo_v7_mht_test')).toBe(false);
		expect(SHARD_NAME_SHAPE.test('dedalo_v7_mht_test__shard')).toBe(false);
	});

	test.if(shardTierLanded)('scripts/test_db_setup.ts refuses before any side effect', () => {
		const faults = shardRefusalFaults(read('scripts/test_db_setup.ts'));
		expect(
			faults,
			`scripts/test_db_setup.ts DROPs its target and SWEEPS that target's media tree. With shard provisioning present, a stale DEDALO_TEST_DATABASE pointing at a '<template>__shard<N>' clone must be refused before either happens: ${faults.join(' | ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 4 — EVERY SQL POOL THE PROCESS CAN OPEN (P1-16, 2026-08-30)
// ---------------------------------------------------------------------------
//
// THE STRUCTURAL HOLE THIS CLOSES, and it is the reason P1-16 existed at all.
//
// Rule 1's inventory is derived over WRITER_ROOTS — `src/core/test_data/**` and
// `test/helpers/**`. That is the right corpus for "which test-data writer forgot to ask
// the marker", and it is the WRONG corpus for "which database can this process open at
// all": production source in neither tree is structurally invisible to it. So when
// `src/ai/rag/vector_store.ts` opened a SECOND Bun SQL pool against
// `RAG_DB_NAME` (default `dedalo7_rag`, a live installation index measured at 5,201
// rows), no rule here could see it, nothing in `test/preload/**` repointed it, and the
// suite issued DELETE + INSERT, DELETE, `CREATE TABLE … PARTITION OF` and
// `DROP TABLE IF EXISTS` against production for months. The audit's own words
// (REMEDIATION.md P1-16): "production source in neither tree is structurally invisible
// to it today, which is exactly how this pool escaped."
//
// A gate that fixed only the RAG pool would leave the blindness intact for the NEXT
// pool. So the census is over POOL CONSTRUCTORS in `src/`, derived, total, and every
// site must carry a verdict:
//
//   marker-guarded — a Dédalo store whose writers ask a marker before writing.
//   read-only      — the pool never mutates; a SELECT cannot corrupt anything.
//   PENDING        — it CAN write a real database and nothing stops it. Shrink-only,
//                    pinned, and each row names the finding, so a known gap is a
//                    counted debt rather than an omission nobody sees.
const POOL_SCAN_ROOT = 'src';

/** Every `new SQL(` site in `src/`, as `<file>:<line>`. Derived, never listed. */
function sqlPoolSites(): string[] {
	const sites: string[] = [];
	for (const match of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, POOL_SCAN_ROOT) })) {
		if (match.endsWith('.test.ts')) continue;
		const file = `${POOL_SCAN_ROOT}/${match}`;
		// Comments describe the rule (core/db/postgres.ts's T1 header names `new SQL(...)`
		// in prose); only real constructor calls are pools.
		const source = stripComments(read(file));
		const lines = source.split('\n');
		for (let index = 0; index < lines.length; index++) {
			if ((lines[index] as string).includes('new SQL(')) sites.push(`${file}:${index + 1}`);
		}
	}
	return sites.sort();
}

type PoolVerdict = 'marker-guarded' | 'read-only' | 'PENDING';

/** Keyed by FILE — a file's pools share a purpose and a guard. */
const POOL_VERDICTS: Readonly<Record<string, { verdict: PoolVerdict; reason: string }>> = {
	'src/core/db/postgres.ts': {
		verdict: 'marker-guarded',
		reason:
			'THE matrix pool. Every test-data writer that reaches it calls assertTestDatabase() before its first write (rule 1 above), and the suite is repointed by test/preload/test_database.ts. This is the guard the other pools are measured against.',
	},
	'src/ai/rag/vector_store.ts': {
		verdict: 'marker-guarded',
		reason:
			'The pgvector pool. Marker-guarded since 2026-08-30 (P1-16): its write doors ask assertTestRagDatabase() and test/preload/rag_db.ts repoints it with the one key that also arms the refusal. Before that it was the hole this rule exists to make impossible.',
	},
	'src/diffusion/targets/mariadb/db.ts': {
		verdict: 'PENDING',
		reason:
			"The diffusion TARGET pools — an operator-configured MariaDB publication database, not a Dédalo store, so neither the matrix marker nor the RAG marker applies. getTargetPool() genuinely writes (CREATE TABLE, DML through src/diffusion/writers/mariadb_sql.ts); probeTargetDatabase() issues only SELECT 1. THE SUITE HALF IS CLOSED (PUB-05, 2026-09-30): test/preload/suite_mariadb.ts arms every `bun test` process at the lane's own suite server, the MariaDB gates acquire it through requireSuiteMariadb() (marker row `dedalo_test_mariadb_marker.targets` naming this lane, read through this pool; no skip path), and test/unit/suite_mariadb_target_native.test.ts holds it. STILL PENDING, and the reason this row stays: the ENGINE's write doors do not ask that marker themselves (no DEDALO_TEST_DIFFUSION_DB_SOCKET seam arming an assertTestMariadbTarget refusal in buildTargetOptions), so a test that bypassed the helper would not be refused by the pool — PUB-05b, the RAG precedent. Also measured: Bun's mariadb adapter given a socket path that does not exist falls back to TCP localhost:3306.",
	},
};

/** PINNED. Shrink-only: a pool may leave PENDING, never join it silently. */
const POOL_PENDING_COUNT = 1;

describe('rule 4 — every SQL pool the process can open is classified', () => {
	const sites = sqlPoolSites();
	const files = [...new Set(sites.map((site) => site.split(':')[0] as string))].sort();

	test('the scan finds the pools it is meant to see (anti-vacuity)', () => {
		// A census over nothing proves nothing, and this one is cheap to break: a
		// stripComments change, a Glob typo, a moved file.
		expect(
			sites.length,
			'no `new SQL(` site found in src/ — the scan is broken',
		).toBeGreaterThanOrEqual(3);
		expect(files).toContain('src/core/db/postgres.ts');
		expect(files).toContain('src/ai/rag/vector_store.ts');
	});

	test('every pool file carries a verdict', () => {
		const unclassified = files.filter((file) => POOL_VERDICTS[file] === undefined);
		expect(
			unclassified,
			`SQL pool(s) opened by src/ with no verdict:\n  ${unclassified.join('\n  ')}\n` +
				'A second pool is how the suite reached the installation vector database for months. Classify it: ' +
				'marker-guarded (its writers ask a marker), read-only (it never mutates), or PENDING with the finding named.',
		).toEqual([]);
	});

	test('no verdict names a file that no longer opens a pool', () => {
		// Staleness the other way: a dead row reads as coverage.
		for (const [file, row] of Object.entries(POOL_VERDICTS)) {
			expect(files, `${file} carries a pool verdict but opens no pool`).toContain(file);
			expect(row.reason.length, `${file}: the reason is too short to be a reason`).toBeGreaterThan(
				60,
			);
		}
	});

	test('the PENDING list is SHRINK-ONLY', () => {
		const pending = Object.entries(POOL_VERDICTS).filter(([, row]) => row.verdict === 'PENDING');
		expect(pending.length).toBeLessThanOrEqual(POOL_PENDING_COUNT);
		expect(
			pending.length,
			`the pool PENDING list shrank to ${pending.length} — lower POOL_PENDING_COUNT so the ratchet keeps biting`,
		).toBe(POOL_PENDING_COUNT);
	});

	test('a marker-guarded pool really names its guard', () => {
		// The verdict is a claim about the source; check it rather than trust it.
		const guards: Readonly<Record<string, string>> = {
			'src/core/db/postgres.ts': 'assertTestDatabase',
			'src/ai/rag/vector_store.ts': 'assertTestRagDatabase',
		};
		for (const [file, symbol] of Object.entries(guards)) {
			if (POOL_VERDICTS[file]?.verdict !== 'marker-guarded') continue;
			const reachable =
				read(file).includes(symbol) || writerFiles.some((writer) => read(writer).includes(symbol));
			expect(
				reachable,
				`${file} is marked marker-guarded but neither it nor any guarded writer mentions ${symbol}`,
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// RULE 8 — concurrent lane builds do not collide on the cluster-shared role.
// ---------------------------------------------------------------------------

describe('rule 8 — concurrent lane builds serialize the cluster-shared role step', () => {
	/** Maintenance-database descriptor: step 5b runs against `postgres`. */
	const admin: DbConnDescriptor = {
		database: 'postgres',
		host: config.db.host,
		port: config.db.port,
		user: config.db.user,
		password: config.db.password,
		socket: config.db.socket,
	};
	const CONCURRENCY = 8;

	/**
	 * THE GATE NEVER TOUCHES THE SHARED ROLE (F8, 2026-09-30). `dedalo_test_ro`
	 * is CLUSTER-shared: every lane's build and client run uses it. A gate that
	 * rewrites it (ALTER ROLE … PASSWORD, and an UNLOCKED positive control that
	 * contends on it by design) collides with another lane's `test:db:setup`
	 * step 5b — the very `tuple concurrently updated` this rule exists to
	 * prevent. So the gate runs the SAME text on a PROBE role named per lane
	 * (`probeSql`: every `dedalo_test_ro` rewritten, the lock line kept), swept
	 * before and after — a crashed run leaves nothing the next run of the same
	 * lane does not reclaim. Measured by OUTCOME: the shared role's catalog
	 * tuple version (pg_authid.xmin — every ALTER ROLE writes a new one) is
	 * unchanged by the whole describe. HONEST LIMIT: another lane's build in
	 * the same window rewrites it legitimately and would red that cell; re-run
	 * it alone.
	 */
	const SHARED_ROLE = 'dedalo_test_ro';
	let db = '';
	let probe = '';
	/** The role-step text retargeted at this lane's probe role, never the shared one. */
	function probeSql(text: string): string {
		const out = text.replaceAll(SHARED_ROLE, probe);
		expect(out, 'probeSql left the shared role in the text').not.toMatch(/\bdedalo_test_ro\b/);
		expect(out).toContain(`SELECT pg_advisory_xact_lock(${READ_ONLY_ROLE_LOCK_KEY});`);
		return out;
	}
	/** Drop this lane's probe role (its CONNECT grant first), if a run left one. */
	async function sweepProbe(): Promise<void> {
		const text = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${probe}') THEN
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', '${db}', '${probe}');
  END IF;
END $$;
DROP ROLE IF EXISTS ${probe};
`;
		const run = await runPsql(admin, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { stdin: text });
		expect(run.exitCode, `probe role sweep failed: ${run.stderr}`).toBe(0);
	}
	async function probeRoles(): Promise<string[]> {
		const rows = (await sql.unsafe('SELECT rolname FROM pg_roles WHERE rolname = $1', [probe])) as {
			rolname: string;
		}[];
		return rows.map((row) => row.rolname);
	}
	async function sharedRoleVersion(): Promise<string | null> {
		const rows = (await sql.unsafe('SELECT xmin::text AS v FROM pg_authid WHERE rolname = $1', [
			SHARED_ROLE,
		])) as { v: string }[];
		return rows[0]?.v ?? null;
	}
	let sharedBefore: string | null = null;
	beforeAll(async () => {
		await assertTestDatabase('test_db_marker_tripwire rule 8');
		db = await currentDatabaseName();
		probe = `dedalo_test_ro_probe_${db.replace(/[^A-Za-z0-9_]/g, '_')}`.toLowerCase().slice(0, 63);
		sharedBefore = await sharedRoleVersion();
		await sweepProbe();
	});
	afterAll(async () => {
		// Nothing this describe creates may outlive it (a failed run included).
		if (probe !== '') await sweepProbe();
	});

	/** Fire `CONCURRENCY` psql runs of `text` at once; return the failed ones' stderr. */
	async function concurrentFailures(text: string): Promise<string[]> {
		const runs = await Promise.all(
			Array.from({ length: CONCURRENCY }, () =>
				runPsql(admin, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { stdin: text }),
			),
		);
		return runs.filter((run) => run.exitCode !== 0).map((run) => run.stderr);
	}

	test('the build sends the role step through the serialized text, and nowhere else', () => {
		const setup = stripComments(read('scripts/test_db_setup.ts'));
		expect(setup).toContain("psql('postgres', ['-f', '-'], readOnlyRoleClusterSql(testDb))");
		// No second, unserialized mutation of the role can sit beside it.
		expect(setup).not.toMatch(/\b(?:ALTER|CREATE)\s+ROLE\b/i);
		expect(readOnlyRoleClusterSql('x')).toContain(
			`SELECT pg_advisory_xact_lock(${READ_ONLY_ROLE_LOCK_KEY});`,
		);
		expect(() => readOnlyRoleClusterSql('a"b')).toThrow(/refusing to interpolate/);
	});

	test('positive control: the same text WITHOUT the lock collides (the harness contends)', async () => {
		const unlocked = probeSql(readOnlyRoleClusterSql(db)).replace(
			`SELECT pg_advisory_xact_lock(${READ_ONLY_ROLE_LOCK_KEY});\n`,
			'',
		);
		expect(unlocked).not.toContain('pg_advisory_xact_lock');
		const failures: string[] = [];
		for (let round = 0; round < 10 && failures.length === 0; round++) {
			failures.push(...(await concurrentFailures(unlocked)));
		}
		expect(
			failures.length,
			'no collision without the lock in 10 rounds — the concurrent harness is not contending, so the locked assertion below would prove nothing',
		).toBeGreaterThan(0);
		expect(failures.join('\n')).toMatch(/tuple concurrently updated|already exists/);
	}, 60_000);

	test('the serialized text: every concurrent run succeeds', async () => {
		const locked = probeSql(readOnlyRoleClusterSql(db));
		for (let round = 0; round < 3; round++) {
			expect(await concurrentFailures(locked)).toEqual([]);
		}
	}, 60_000);

	test('the cluster-shared role was never rewritten by this gate, and no probe role outlives it', async () => {
		expect(sharedBefore, `the suite build creates ${SHARED_ROLE} (anti-vacuity)`).not.toBeNull();
		expect(
			await sharedRoleVersion(),
			`${SHARED_ROLE} was rewritten while rule 8 ran: the gate mutates the role every lane shares`,
		).toBe(sharedBefore);
		expect(await probeRoles(), 'the probe was created by the runs above (anti-vacuity)').toEqual([
			probe,
		]);
		await sweepProbe();
		expect(await probeRoles()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 6b — the client run's server surfaces follow the lane.
// ---------------------------------------------------------------------------

describe("rule 6b — the client server's stateful surfaces are the suite database's own", () => {
	/** Seams the preloads set on THIS process; a fresh `bun run test:client` shell has none. */
	const PRELOAD_SEAMS = [
		'DEDALO_TEST_RAG_DB_NAME',
		'DEDALO_TEST_MEDIA_ROOT',
		'DEDALO_SESSION_DB_PATH',
		'DEDALO_TS_STATE_PATH',
	] as const;

	/** Compose the spawned server's environment in a child, exactly as the runner does. */
	function composeInChild(suiteDb: string): Record<string, string> {
		const env: Record<string, string> = { ...(process.env as Record<string, string>) };
		for (const key of PRELOAD_SEAMS) delete env[key];
		const script = `
			const m = await import(${JSON.stringify(join(REPO_ROOT, 'scripts', 'client_test_server.ts'))});
			const paths = m.suiteServerPaths();
			const out = m.suiteServerEnvironment({ suiteDb: ${JSON.stringify(suiteDb)}, port: 1, ...paths });
			const keys = ['DB_NAME', 'DEDALO_TEST_MEDIA_ROOT', 'DEDALO_TEST_RAG_DB_NAME', 'DEDALO_SESSION_DB_PATH', 'SERVER_UNIX_SOCKET', 'DEDALO_TS_STATE_PATH'];
			console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, out[k] ?? null]))));
		`;
		const child = Bun.spawnSync(['bun', '-e', script], { cwd: REPO_ROOT, env });
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		const lines = child.stdout.toString().trim().split('\n');
		return JSON.parse(lines[lines.length - 1] as string);
	}

	test('database, media root and vector database are the suite derivations — never the installation', async () => {
		const suiteDb = await currentDatabaseName();
		const served = composeInChild(suiteDb);
		expect(served.DB_NAME).toBe(suiteDb);
		expect(served.DEDALO_TEST_MEDIA_ROOT).toBe(testMediaRootPath(suiteDb));
		expect(
			served.DEDALO_TEST_RAG_DB_NAME,
			"the client server's vector database must be the suite's own `<suite db>_rag` — unset, its ragSql resolves to the installation's semantic index",
		).toBe(suiteRagDatabaseName(suiteDb));
		expect(served.DEDALO_TEST_RAG_DB_NAME).not.toBe(installationRagDatabaseName());
	});

	test('two concurrent runs get distinct session stores, sockets and state files', async () => {
		const suiteDb = await currentDatabaseName();
		const [a, b] = [composeInChild(suiteDb), composeInChild(suiteDb)];
		for (const key of ['DEDALO_SESSION_DB_PATH', 'SERVER_UNIX_SOCKET', 'DEDALO_TS_STATE_PATH']) {
			expect(a[key], key).toBeString();
			expect(a[key], `${key} must be per-run`).not.toBe(b[key]);
		}
	});
});

// ---------------------------------------------------------------------------
// RULE 9 — a test process the preload never reached opens no database.
// ---------------------------------------------------------------------------

describe('rule 9 — a bun test run without the preload opens no database', () => {
	const ARMED = {
		nodeEnv: 'test',
		armedDatabase: 'suite_db',
		disabled: undefined,
		applicationDatabase: 'app_db',
	};

	test('matrix database: refused when unarmed, or when it is the .env application database', () => {
		expect(suiteDatabaseRefusal('suite_db', ARMED)).toBeNull();
		// A child a test deliberately points elsewhere (a shard, a scratch install DB).
		expect(suiteDatabaseRefusal('scratch_db', ARMED)).toBeNull();
		// Rule 2: the application database is refused whatever the pin says.
		expect(suiteDatabaseRefusal('app_db', ARMED)).toContain('APPLICATION database');
		expect(suiteDatabaseRefusal('app_db', { ...ARMED, armedDatabase: 'app_db' })).toContain(
			'APPLICATION database',
		);
		// Rule 1: no pin at all — the preload never ran (foreign cwd, bare spawn).
		expect(suiteDatabaseRefusal('suite_db', { ...ARMED, armedDatabase: undefined })).toContain(
			'DEDALO_TEST_DATABASE is unset',
		);
		// No .env (CI composes its env): rule 1 still holds.
		expect(
			suiteDatabaseRefusal('x', {
				...ARMED,
				armedDatabase: undefined,
				applicationDatabase: undefined,
			}),
		).not.toBeNull();
	});

	test('side pools (vector, MariaDB): refused only when unarmed', () => {
		expect(suitePoolRefusal('vector database', 'rag', ARMED)).toBeNull();
		expect(
			suitePoolRefusal('vector database', 'rag', { ...ARMED, armedDatabase: undefined }),
		).toContain("REFUSING to open vector database 'rag'");
	});

	test('the opt-out is the literal "true", and nothing refuses outside a test process', () => {
		const unarmed = { ...ARMED, armedDatabase: undefined };
		expect(suiteDatabaseRefusal('app_db', { ...unarmed, disabled: 'true' })).toBeNull();
		expect(suiteDatabaseRefusal('app_db', { ...unarmed, disabled: 'yes' })).not.toBeNull();
		expect(suitePoolRefusal('vector database', 'rag', { ...unarmed, disabled: 'true' })).toBeNull();
		for (const nodeEnv of [undefined, 'production', 'development']) {
			expect(suiteDatabaseRefusal('app_db', { ...unarmed, nodeEnv }), String(nodeEnv)).toBeNull();
			expect(suitePoolRefusal('mariadb', 't', { ...unarmed, nodeEnv }), String(nodeEnv)).toBeNull();
		}
	});

	test('this process passes for the right reason (anti-vacuity)', () => {
		const env = currentSuiteDatabaseEnv();
		expect(env.nodeEnv).toBe('test');
		expect(env.armedDatabase).toBe(config.db.database);
		expect(env.applicationDatabase).toBe(applicationDatabaseName());
		expect(config.db.database).not.toBe(env.applicationDatabase);
	});

	/** Run `bun test` on a one-test file from a directory with NO bunfig.toml. */
	const MATRIX_PROBE = `const { sql } = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/db/postgres.ts'))});
	const rows = await sql\`SELECT current_database() AS db\`;
	console.log('CONNECTED TO ' + rows[0].db);`;

	/**
	 * The database an UNARMED child really falls back to: the installation's, as
	 * ../private/.env names it — or, on a tier with no private file (the hosted CI
	 * db tier composes its env), a synthetic stand-in, so the child's config still
	 * loads and the GUARD is what answers (deleting DB_NAME there died in config.ts
	 * first: "Missing required config key 'DB_NAME'").
	 */
	const FALLBACK_DB = applicationDatabaseName() ?? 'dedalo_probe_application_db';

	function runOutsideRepo(
		armed: string | null,
		dbName: string = FALLBACK_DB,
		probe: string = MATRIX_PROBE,
		extraEnv: Record<string, string> = {},
	): { exit: number; out: string } {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-nopreload-'));
		try {
			writeFileSync(
				join(dir, 'probe.test.ts'),
				`import { test } from 'bun:test';\ntest('probe', async () => {\n${probe}\n});\n`,
			);
			// The preload-set seams are STRIPPED: an inherited value would fake the answer.
			const env: Record<string, string | undefined> = { ...process.env };
			for (const key of [
				'DEDALO_TEST_DATABASE',
				'DB_NAME',
				'DEDALO_DATABASE_CONN',
				'DEDALO_TEST_DB_DISABLE',
			]) {
				delete env[key];
			}
			if (armed !== null) env.DEDALO_TEST_DATABASE = armed;
			env.DB_NAME = dbName;
			Object.assign(env, extraEnv);
			const child = Bun.spawnSync(['bun', 'test', './probe.test.ts'], {
				cwd: dir,
				env,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			return {
				exit: child.exitCode ?? -1,
				out: `${child.stdout.toString()}${child.stderr.toString()}`,
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test('outside the repo root the pool refuses before connecting', () => {
		const run = runOutsideRepo(null);
		expect(run.out).toContain('DEDALO_TEST_DATABASE is unset');
		expect(run.out).not.toContain('CONNECTED TO');
		expect(run.exit).not.toBe(0);
	}, 60_000);

	test('a pinned child aimed at the APPLICATION database is refused too', () => {
		// The application database is what ../private/.env names. Where there is no
		// such file (hosted CI), give the child one: a throwaway private dir whose
		// .env names a synthetic application database (every other key the child
		// needs comes from the process env there).
		const appDb = applicationDatabaseName();
		const privateDir = appDb === undefined ? mkdtempSync(join(tmpdir(), 'dedalo-private-')) : null;
		try {
			const target = appDb ?? 'dedalo_probe_application_db';
			if (privateDir !== null) writeFileSync(join(privateDir, '.env'), `DB_NAME=${target}\n`);
			const run = runOutsideRepo(
				config.db.database,
				target,
				MATRIX_PROBE,
				privateDir === null ? {} : { DEDALO_PRIVATE_DIR: privateDir },
			);
			expect(run.out).toContain('APPLICATION database named in ../private/.env');
			expect(run.out).not.toContain('CONNECTED TO');
		} finally {
			if (privateDir !== null) rmSync(privateDir, { recursive: true, force: true });
		}
	}, 60_000);

	test('the side pools refuse unarmed too: the vector store (built at import) and a MariaDB target', () => {
		const rag = runOutsideRepo(
			null,
			FALLBACK_DB,
			`await import(${JSON.stringify(join(REPO_ROOT, 'src/ai/rag/vector_store.ts'))}); console.log('CONNECTED TO rag');`,
		);
		expect(rag.out).toContain("REFUSING to open vector database '");
		expect(rag.out).not.toContain('CONNECTED TO');
		const maria = runOutsideRepo(
			null,
			FALLBACK_DB,
			`const { getTargetPool } = await import(${JSON.stringify(join(REPO_ROOT, 'src/diffusion/targets/mariadb/db.ts'))}); getTargetPool('zz_probe_target'); console.log('CONNECTED TO maria');`,
		);
		expect(maria.out).toContain("REFUSING to open diffusion MariaDB database 'zz_probe_target'");
		expect(maria.out).not.toContain('CONNECTED TO');
	}, 60_000);

	test('positive control: the same child, armed at the suite database, connects to it', () => {
		const run = runOutsideRepo(config.db.database, config.db.database);
		expect(run.out).toContain(`CONNECTED TO ${config.db.database}`);
		expect(run.exit).toBe(0);
	}, 60_000);
});
