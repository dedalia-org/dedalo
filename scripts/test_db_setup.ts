/**
 * Build the DEDICATED TEST DATABASE (`bun run test:db:setup`).
 *
 * WHY THIS EXISTS. `bun test` used to run against whatever database the install was
 * configured with, which made the suite depend on that install's data — and let it WRITE
 * to the app's database. Both bit us:
 *   - on a fresh install 183 of 2039 unit tests failed: ~46 files need the `numisdata`
 *     ontology (a project TLD that ships in NO install seed), others read records of the
 *     old shared dev DB;
 *   - a gate provisioning a scratch ontology node DELETED a real one (test218) on its way
 *     out of the LIVE database.
 * Tests now get their own database. The application's is not theirs to touch.
 *
 * WHAT IT BUILDS — a COMPLETE install, from files vendored in this repo, never by copying
 * a live database, THROUGH THE INSTALLER'S OWN DOORS (installer unification A2: the
 * suite database is an installation first, then a fixture):
 *   1. the install seed via `installDbFromSeed()` — the installer's restore door: the
 *      CORE-ONLY seed (install/db/dedalo_install.pgsql.gz — no domain ontology, no test
 *      TLD, no test3 records), its predated migrations, the derived search stores and
 *      the core hierarchies (`lg` activated), exactly what a
 *      fresh installation gets;
 *   1b. the DEFAULT domain ontologies (`oh`) through the installer's ontology door
 *      (`stageOntologies` + `installOntologies` over `defaultOfflineOntologyRequest()`,
 *      i.e. the ONE vendored file install/import/ontology/<major.minor>/oh.copy.gz) — the
 *      generic test nodes reference `oh` (grafts and diffusion aliases), so the suite
 *      database needs it, and it gets it the way an offline install does;
 *   then the SUITE'S OWN FIXTURES, which no installation receives:
 *   1c. the generic `test` TLD ontology, materialized WHOLE from
 *      src/core/test_data/test_tld_ontology.json through the engine's doors
 *      (records → rebuildOntology), so the suite runs on the REVIEWABLE source;
 *   1d. the canonical test3 playground records (src/core/test_data/seed.ts
 *      restoreCanonicalTest3 — the single verified source, WC-021);
 *   2. the REFERENCED hierarchies via the installer's own installHierarchies()
 *      — the tools/tree/virtual-section gates need them. NOT all 150 vendored
 *      `<tld>1.copy.gz` files: that glob made the fixture 7612 MB, 97.6% of it
 *      geography no test names (measured 2026-08-25 — 2,267,790 geo
 *      matrix_hierarchy rows deriving 13.9M relation-index and 5.6M
 *      string-search rows). The installed set is `imports` DERIVED from the
 *      test tree by scripts/lib/hierarchy_allowlist.ts (2 TLDs after the
 *      consumer-gate migration onto the step-5c SYNTHETIC hierarchies,
 *      2026-08-25; over-inclusive by design — see that header) — `ad`
 *      (10 rows) is held by tier1_install_native's literal filename. The
 *      other vendored files STAY in the repo: a full install still needs
 *      them. Measured 2026-08-25 with the then composition (ad+lg imports +
 *      the 1,312 generated synthetic rows): pg_database_size = 233 MB
 *      (244,586,175 bytes), rebuild ~40-45 s. Since 2026-10-08 `lg` (the
 *      languages thesaurus) is a CORE hierarchy: ACTIVATED against the 21,705
 *      `lg1` terms the seed ships in matrix_langs, never imported — its
 *      vendored `lg1.copy.gz` (which forced unread duplicates into
 *      matrix_hierarchy) is deleted;
 *   3. the registered tools, via the installer's own registerInstallTools();
 * It installs NO installation's PROJECT ontology (only the installer's default domain
 * ontology, oh, as above). It used to load one
 * (`test/fixtures/ontology/numisdata_ontology.copy.gz`) because ~46 gates
 * needed that install's definitions to resolve against; the generic-`test`-TLD
 * migration replaced every one of them with a `test` clone, and that step was
 * dropped on 2026-08-21 after measuring that its absence moves nothing (see
 * below). The fixture FILE stays in the repo — it is the input
 * `scripts/clone_into_test_tld.ts` reads to mint twins, and deleting it would
 * make future cloning impossible from a clone of this repo. It is simply no
 * longer poured into the test database.
 *
 * DEFINITIONS, NOT RECORDS. Every step above installs ONTOLOGY (and the tool
 * registry an install cannot boot without). No fixture RECORDS are seeded here
 * beyond the seed's own and the canonical test3 playground — in particular NOT
 * the derived test corpus
 * (src/core/test_data/test_corpus/): that is a situation, and ambient records
 * change the answer for every census, emptiness and row-count gate in the
 * suite. A gate that needs the corpus ensures and drops it itself; see step 6
 * at the bottom of this file.
 *
 * The ontology fixture carries NO `id` column, so ids come from the sequence and cannot
 * collide with the seed's own rows.
 *
 * ORDER MATTERS: the env is repointed at the test DB BEFORE src/config/config.ts is ever
 * imported (it freezes the connection at import), so the installer code below — which
 * resolves its connection from the config — targets the test database and nothing else.
 *
 * Re-runnable: it drops and rebuilds. It refuses to run when the test database name
 * resolves to the application's, so a fat-fingered env cannot drop your install.
 *
 * AND IT STAMPS THE DATABASE. Right after CREATE DATABASE + the installer's seed
 * restore (which writes only what any installation gets) it writes the
 * `dedalo_test_marker` row (step 2b, src/core/test_data/test_database_marker.ts).
 * That row — not this script's name check, and not the `_test` suffix — is what
 * every test-data writer in the tree asks before it moves a single row. This is
 * the ONLY producer of that row anywhere.
 *
 * AND THE VECTOR DATABASE (P1-16, 2026-08-30). `ragSql` is a SEPARATE pool on a
 * SEPARATE database, outside `assertTestDatabase()` and outside the media
 * marker, and it resolved to the INSTALLATION's semantic index. This command
 * now DROPS and rebuilds `<suite db>_rag` beside the matrix database and the
 * media tree — schema from the vendored install/db/rag_embeddings.sql, stamped
 * with its own `dedalo_test_rag_marker` row — and `bun test` is pointed at it by
 * test/preload/rag_db.ts. Three surfaces, one fixture, one rebuild.
 *
 * AND A READ-ONLY ROLE. Step 5b ensures `dedalo_test_ro` — a LOGIN role with
 * SELECT-only access to this database, for the shard bands that never write.
 * Created idempotently on every rebuild, ONLY behind the guards above (never
 * as a convenience step that runs first), and re-granted after every
 * DROP/CREATE, because the per-database grants and default privileges die with
 * the dropped database — re-issuing them here is what keeps the role from
 * dangling half-granted between rebuilds. Its password is a fixed, committed
 * literal ON PURPOSE: the database it can read is disposable by its own
 * declaration (the marker row), so the credential protects nothing — but the
 * role MUST have one, because config.db carries exactly one user/password pair
 * (src/core/db/postgres.ts buildSqlOptions) and a password-less role would
 * ride this Mac's local `trust` pg_hba and then fail in CI, where the service
 * container forces scram over TCP — green locally, broken where nobody looks.
 *
 * IT REFUSES SHARD CLONES. A third name guard (below, beside the other two)
 * rejects any target matching /__shard\d+$/: the shard workflow teaches
 * developers to export DEDALO_TEST_DATABASE at a clone, and a clone PASSES the
 * app-DB name guard (it only compares against the install's name) and passes
 * the provenance guard's 'marked' branch — precisely BECAUSE the clone's
 * marker was rewritten to name it. Without this guard a leftover export turns
 * `bun run test:db:setup` into a ~15-minute rebuild of a shard-named database
 * and a multi-GiB write aimed at the wrong target. Shards are CLONED from the
 * template, never built directly.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnv } from '../src/config/env.ts';
// DB-free ON PURPOSE (see that module's header): the provenance check below must
// name the marker table WITHOUT importing the marker module, whose postgres.ts
// import connects the pool at module scope — a session held on the target makes
// the DROP fail with "being accessed by other users".
import {
	TEST_MARKER_PURPOSE,
	TEST_MARKER_TABLE,
} from '../src/core/test_data/test_database_marker_constants.ts';
import { suitePsqlConnArgs, suitePsqlEnv } from '../test/helpers/suite_pg.ts';
import { acquireSuiteRunLock } from '../test/helpers/suite_run_lock.ts';
import { readOnlyRoleClusterSql, testDatabaseName } from '../test/helpers/test_database.ts';
import {
	rebuildTestExportArtifactsRoot,
	rebuildTestMediaRoot,
	rebuildTestProcessesDir,
} from '../test/helpers/test_media_root.ts';
import { ensureSuiteRagDatabase, suiteRagDatabaseName } from '../test/helpers/test_rag_database.ts';
import { deriveHierarchyAllowlist } from './lib/hierarchy_allowlist.ts';

const REPO = join(import.meta.dir, '..');
const SEED = join(REPO, 'install', 'db', 'dedalo_install.pgsql.gz');

/**
 * The suite database's collation, as an ICU identifier. `en-US` is the ordering the frozen
 * parity fixtures were harvested under; changing it moves every `ORDER BY` the tier
 * compares, so it is a contract, not a preference.
 */
const SUITE_ICU_LOCALE = 'en-US';
const HIERARCHY_DIR = join(REPO, 'install', 'import', 'hierarchy');

const appDb = readEnv('DB_NAME') ?? readEnv('DEDALO_DATABASE_CONN') ?? '';
const testDb = testDatabaseName();

// The one guard that matters: never operate on the application's database.
//
// LEDGER — coverage plan §4.4 D13 + D12, KNOWN-OPEN AND UNGATED.
//  - D13: this guard is ONLY name-equality with THIS checkout's DB_NAME. Point
//    `DEDALO_TEST_DATABASE` at any OTHER real database on the same host — a
//    second checkout's install, a colleague's, a production restore — and the
//    script passes the guard and DROPS it. What it needs: refuse unless the
//    target is ABSENT, was CREATED BY THIS SCRIPT (a provenance marker row), or
//    `--force` is given.
//  - D12: the database this builds does not stay clean. Measured 2026-08-10 on
//    `dedalo_mib_v7_test`: `matrix_time_machine` 3,385 of 7,708 rows at
//    section_id >= 900000, `matrix_test` carrying 902006, `matrix_stats` 2 rows
//    both leaked, `matrix_users` id 0 a leaked password-reset user (D11). Gates
//    sweep `matrix_*` and forget `matrix_time_machine`, or sweep with a filter
//    that never matched what they wrote. A rebuild clears it; nothing PREVENTS
//    it, and no gate reports it.
if (testDb === appDb || testDb === '') {
	console.error(
		`REFUSING: the test database name (${testDb || '<empty>'}) is not distinct from the application database (${appDb}). This script DROPS the database it builds. Set DEDALO_TEST_DATABASE.`,
	);
	process.exit(1);
}

// it DROPS and rebuilds the suite database: never under a running suite
acquireSuiteRunLock(testDb, 'test:db:setup');

// The name reaches SQL as a double-quoted identifier (the DROP/CREATE below) and
// the provenance probes interpolate it too. A quote or a backslash inside it
// could escape both, so REFUSE rather than escape — escaping is where the next
// injection lives, and no database an operator would really use needs one.
if (!/^[A-Za-z0-9_.-]+$/.test(testDb)) {
	console.error(
		`REFUSING: test database name '${testDb}' contains characters outside [A-Za-z0-9_.-]; it is interpolated into SQL identifiers. Pick a plain name. Nothing was touched.`,
	);
	process.exit(1);
}

// GUARD 3 of the name guards — SHARD CLONES ARE NEVER BUILD TARGETS. Checked
// BEFORE any side effect (the media sweep below is the first one), because a
// shard clone is the one wrong target the OTHER two guards wave through: the
// app-DB guard only compares against this checkout's install name, and the
// provenance guard's 'marked' branch is satisfied precisely BECAUSE the
// clone's marker row was rewritten to name it. The shard workflow teaches
// developers to export DEDALO_TEST_DATABASE at a clone — a leftover export
// must die here, not after a ~15-minute rebuild aimed at a shard name.
if (/__shard\d+$/.test(testDb)) {
	const base = testDb.replace(/__shard\d+$/, '');
	console.error(
		`REFUSING: '${testDb}' is a shard clone of ${base}; rebuild the template with DEDALO_TEST_DATABASE unset, or sweep clones with bun run test:shard:sweep. Nothing was touched.`,
	);
	process.exit(1);
}

// --force is the operator's explicit "yes, I know what that database is". It
// overrides the TWO PROVENANCE GATES, and only those — a target that EXISTS but
// carries no marker this script wrote: the matrix one (guard 2 below) and the
// vector one (`ensureSuiteRagDatabase`, which is handed this same flag and
// refuses to DROP a `<suite db>_rag` without a `dedalo_test_rag_marker` row).
// Both are "prove it is disposable"; neither is a name guard, and --force never
// overrides the app-DB name guard above nor the shard-clone refusal. Parsed
// before any side effect, so a mistyped flag dies here rather than after the
// media tree has been swept.
const cliArgs = process.argv.slice(2);
const force = cliArgs.includes('--force');
{
	const unknown = cliArgs.filter((arg) => arg !== '--force');
	if (unknown.length > 0) {
		console.error(
			`REFUSING: unknown argument(s): ${unknown.join(', ')}. The only flag is --force (drop an existing target this script cannot prove it built). Nothing was touched.`,
		);
		process.exit(1);
	}
}

// Repoint the WHOLE PROCESS before config is imported (see the header). Everything after
// this — connFromConfig(), the pool, the installer helpers — resolves to the test DB.
process.env.DB_NAME = testDb;
process.env.DEDALO_DATABASE_CONN = testDb;

const user = readEnv('DB_USER') ?? readEnv('DEDALO_USERNAME_CONN') ?? '';
const password = readEnv('DB_PASSWORD') ?? readEnv('DEDALO_PASSWORD_CONN') ?? '';

/**
 * `-h/-p` decided by the engine's ONE transport rule (DB_SOCKET wins, a `/`
 * DB_HOST is a socket directory, else TCP; an unset port is 5432) — the route
 * the suite's own pool takes. readEnv already honours the PHP alias spellings.
 * Plus `-w` and a PGCONNECT_TIMEOUT (test/helpers/suite_pg.ts): never a
 * password prompt on the terminal (C3-12).
 */
const conn = suitePsqlConnArgs(readEnv, user);
const pgEnv = suitePsqlEnv(process.env, password);

/**
 * The psql binary, resolved the way the ENGINE resolves it.
 *
 * This script used to spawn a bare `psql`, i.e. PATH only — while the hierarchy
 * import it calls goes through `resolvePgBinary` (src/core/install/pg_exec.ts).
 * So `DEDALO_PG_BIN_PATH` moved one half of the build and not the other, and on a
 * machine whose PATH psql is a different major than the server the two phases
 * could disagree about which client to use. That asymmetry matters most exactly
 * where it was never exercised: a Linux runner, where pg_bin.ts's probe list is
 * Apple-Silicon Homebrew only and PATH is the sole fallback.
 *
 * Imported LAZILY and dynamically: pg_bin reads `config.ops.pgBinPath`, and a
 * static import would pull src/config/config.ts in at parse time — before the
 * env repoint above, which is the one ordering this whole file is built around.
 */
let resolvedPsql: string | undefined;
async function psqlBinary(): Promise<string> {
	if (resolvedPsql === undefined) {
		const { resolvePgBinary } = await import('../src/core/install/pg_bin.ts');
		resolvedPsql = resolvePgBinary('psql');
	}
	return resolvedPsql;
}

async function psql(database: string, args: string[], stdin?: string): Promise<string> {
	const proc = Bun.spawn(
		[await psqlBinary(), ...conn, '-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
		{
			env: pgEnv,
			stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`psql (${database}) exited ${code}: ${err.trim()}`);
	return out;
}

// ---------------------------------------------------------------------------
// GUARD 2 of 2 — PROVENANCE (coverage plan §4.4 D13, closed 2026-08-25).
//
// The name guard above is a claim ABOUT a database; this one asks the database
// itself. Three states may proceed:
//   ABSENT   — nothing to lose; the build creates it fresh.
//   MARKED   — it carries the marker row naming ITSELF with the exact purpose
//              sentence, i.e. a database THIS script built (step 2b below is
//              that row's only producer in the tree). Disposable by its own
//              declaration.
//   --force  — the operator overrides an existing-but-unproven target, by name.
// Anything else — a second checkout's install, a colleague's database, a
// production restore sitting at the configured name — REFUSES, having touched
// nothing.
//
// MECHANICS THAT ARE LOAD-BEARING, not style:
//  - Asked over this script's own short-lived psql subprocesses, NEVER the
//    engine pool: importing the marker module would connect postgres.ts's
//    module-scope pool to the target, and a held session makes the very
//    DROP DATABASE this gate protects fail with "being accessed by other
//    users". Each probe has fully exited before the DROP runs.
//  - The table name and purpose sentence come from the marker's DB-FREE
//    constants module, so this file never types the literal (rule 5 of
//    test_db_marker_tripwire scans scripts/ for it).
//  - Values reach SQL as psql variables (:'db', :'purpose'), never spliced into
//    the statement: the purpose sentence is 200 characters of prose and the one
//    honest way to compare it is to let psql quote it. The statements go in on
//    STDIN (-f -) rather than -c, because psql interpolates variables only when
//    lexing file/stdin input — with -c the `:'db'` arrives at the server
//    literally and it is a syntax error. Verified against psql 18 before use.
//  - FAIL-CLOSED by shape: a probe that ERRORS throws (ON_ERROR_STOP + exit
//    code) and aborts the run. Only a SUCCESSFUL empty result means "absent",
//    so a surprise can over-refuse but never over-drop.
// ---------------------------------------------------------------------------

type TargetProvenance =
	| { state: 'absent' }
	| { state: 'marked' }
	| { state: 'unmarked' }
	| { state: 'wrong_purpose' }
	| { state: 'misrouted'; markerDatabase: string };

async function inspectDropTarget(): Promise<TargetProvenance> {
	// Does the target exist at all? Asked on the `postgres` maintenance database,
	// so a truly absent target is never even connected to.
	const exists = (
		await psql(
			'postgres',
			['-t', '-A', '-v', `db=${testDb}`, '-f', '-'],
			"SELECT 1 FROM pg_database WHERE datname = :'db'\n",
		)
	).trim();
	if (exists === '') return { state: 'absent' };

	// It exists: ask the DATABASE ITSELF whether it is the disposable one.
	const tablePresent = (
		await psql(testDb, [
			'-t',
			'-A',
			'-c',
			`SELECT to_regclass('public.${TEST_MARKER_TABLE}') IS NOT NULL`,
		])
	).trim();
	if (tablePresent !== 't') return { state: 'unmarked' };

	const row = (
		await psql(
			testDb,
			['-t', '-A', '-F', '\t', '-v', `purpose=${TEST_MARKER_PURPOSE}`, '-f', '-'],
			`SELECT (purpose = :'purpose')::text, database_name FROM "${TEST_MARKER_TABLE}" WHERE id = 1\n`,
		)
	).trim();
	if (row === '') return { state: 'unmarked' };
	// Split on the FIRST tab only: database_name is data from a database we do
	// not yet trust, and must not be able to smuggle a field boundary.
	const tab = row.indexOf('\t');
	const purposeMatches = tab === -1 ? row : row.slice(0, tab);
	const markerDatabase = tab === -1 ? '' : row.slice(tab + 1);
	if (purposeMatches !== 'true') return { state: 'wrong_purpose' };
	if (markerDatabase !== testDb) return { state: 'misrouted', markerDatabase };
	return { state: 'marked' };
}

const provenance = await inspectDropTarget();
switch (provenance.state) {
	case 'absent':
		console.log(`[test-db] '${testDb}' does not exist — building it fresh.`);
		break;
	case 'marked':
		console.log(
			`[test-db] '${testDb}' carries its own '${TEST_MARKER_TABLE}' row — a database this script built. Dropping and rebuilding.`,
		);
		break;
	default: {
		if (force) {
			// The operator said so, by flag. Name what is about to happen and to
			// WHICH database, so the scrollback is the audit trail.
			console.warn(
				`[test-db] --force: dropping EXISTING database '${testDb}' WITHOUT provenance (state: ${provenance.state}). If that was someone's real data, this line is where it went.`,
			);
			break;
		}
		const why =
			provenance.state === 'unmarked'
				? `it EXISTS but carries no '${TEST_MARKER_TABLE}' row, so this script did not build it — it may be a real install: a second checkout's, a colleague's, a production restore`
				: provenance.state === 'wrong_purpose'
					? `its '${TEST_MARKER_TABLE}' row does not carry the purpose sentence this engine ships — the marker was not written by this script (a hand-made table, or a different engine version)`
					: `its '${TEST_MARKER_TABLE}' row names database '${provenance.markerDatabase}', not '${testDb}' — a test-database dump restored somewhere it does not belong. Investigate the misrouted restore before anything else`;
		console.error(
			`REFUSING to DROP database '${testDb}': ${why}. Nothing was dropped, nothing was written. If it truly is disposable, re-run with --force; otherwise point DEDALO_TEST_DATABASE elsewhere.`,
		);
		process.exit(1);
	}
}

// AND THE MEDIA ROOT, in the same breath and for the same reason. The database is
// not the only surface the suite shared with the installation: `MEDIA_PATH` was,
// so a client-suite upload, an `ensureMediaKit` and every derivative a gate built
// landed in the install's media tree. `DEDALO_TEST_MEDIA_ROOT` repoints the root
// AND arms the `.dedalo_test_media` guard (src/core/media/test_media_root.ts) —
// one key, so a run cannot be armed at the wrong root or repointed with the guard
// asleep. The tree is SWEPT and rebuilt here, beside the database it belongs to:
// the two are ONE fixture (files_info rows name files in it) — which is why the
// SUITE DATABASE NAME is passed EXPLICITLY: the tree is keyed by it, and the
// derivation (`<DB_NAME>_test`) has just been invalidated by the repoint above.
const mediaRoot = rebuildTestMediaRoot(testDb);
process.env.DEDALO_TEST_MEDIA_ROOT = mediaRoot;
console.log(
	`[test-db] test media root rebuilt: ${mediaRoot} (marked '.dedalo_test_media'; the installation's media tree is never touched)`,
);
// Its sibling, tool_export's export artifacts root (`<media root>.export_artifacts`,
// the jobs and files the export gates build): swept and re-marked with it.
const exportArtifactsRoot = await rebuildTestExportArtifactsRoot(mediaRoot);
console.log(`[test-db] test export artifacts root rebuilt: ${exportArtifactsRoot}`);
// And the job-registry sibling (`<media root>.processes`): under the seam the
// job manager writes its pfiles there, never into ../private/processes.
const processesDir = rebuildTestProcessesDir(mediaRoot);
console.log(`[test-db] test job-registry dir rebuilt: ${processesDir}`);

// AND THE VECTOR DATABASE, in the same breath and for the same reason (audit
// 2026-08-26, P1-16). The matrix pool is not the only pool the suite opens:
// `ragSql` (src/ai/rag/vector_store.ts) is a SEPARATE pool on a SEPARATE
// database, so it sat outside `assertTestDatabase()` and outside the media
// marker alike — and it resolved to `RAG_DB_NAME`, i.e. the INSTALLATION's
// semantic index (`dedalo7_rag`), which every rag gate then upserted into,
// partitioned and DELETEd from. `DEDALO_TEST_RAG_DB_NAME` repoints the pool AND
// arms the `dedalo_test_rag_marker` refusal — one key, the media seam's rule,
// so a run cannot be armed at the installation's index nor repointed with the
// guard asleep.
//
// The name is derived `<suite db>_rag` and the SUITE DATABASE NAME is passed
// EXPLICITLY, for the media root's reason: the derivation was just invalidated
// by the repoint above, and the three surfaces are ONE fixture (an embedding row
// names a matrix record by section_tipo + section_id).
//
// SWEPT AND REBUILT, like the media tree — a fixture is reproducible only if it
// is. The DROP is gated by the vector database's own marker row, not by its
// name, and `--force` is the same override it is for the matrix database. It
// runs HERE, before the matrix DROP, so a refusal costs nothing but the media
// sweep above (itself disposable by declaration) — never a half-built matrix.
const ragDb = suiteRagDatabaseName(testDb);
process.env.DEDALO_TEST_RAG_DB_NAME = ragDb;
const ragOutcome = await ensureSuiteRagDatabase({ database: ragDb, mode: 'rebuild', force });
console.log(
	`[test-db] vector database rebuilt: ${ragDb} (${ragOutcome.dropped ? 'dropped and recreated' : 'created'}; schema from install/db/rag_embeddings.sql, marked 'dedalo_test_rag_marker'; the installation's semantic index is never touched)`,
);

console.log(`[test-db] rebuilding '${testDb}' (application DB '${appDb}' is never touched)`);

// 1. Recreate the database.
//
// THE COLLATION IS DECLARED, NOT INHERITED (2026-08-31).
//
// A bare CREATE DATABASE takes the CLUSTER's locale, so the suite's sort order became a
// property of whoever ran initdb. `ORDER BY` over text then answers differently per host,
// and a parity gate that compares a frozen ordering byte-for-byte is right on one machine
// and wrong on the next. MEASURED: `sqo_differential > order by string component` passes
// under libc en_US.UTF-8 and FAILS under C — and Postgres 18's initdb defaults to the
// builtin C.UTF-8 provider, which is exactly what the hosted db tier's container gets. The
// same gate was green on every developer box and red on every runner.
//
// ICU, not a libc locale name, because the NAME is not portable: macOS spells it
// `en_US.UTF-8` and Debian `en_US.utf8`, and the two libc implementations do not even sort
// that locale the same way. ICU gives one collation for one identifier on every host.
// LC_COLLATE/LC_CTYPE are pinned to `C` — the one locale guaranteed to exist everywhere —
// because with the ICU provider they no longer decide ordering.
//
// This is the generic-TLD law applied to the DATABASE: the suite builds the situation it
// tests instead of borrowing the host's.
await psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${testDb}"`]);
await psql('postgres', [
	'-c',
	`CREATE DATABASE "${testDb}" TEMPLATE template0 ENCODING 'UTF8' ` +
		`LOCALE_PROVIDER icu ICU_LOCALE '${SUITE_ICU_LOCALE}' LC_COLLATE 'C' LC_CTYPE 'C'`,
]);

// 2. The install seed THROUGH THE INSTALLER'S RESTORE DOOR — the same
// `installDbFromSeed()` the installer (and install.sh) runs: restore + the
// predated migrations + the derived search stores + the core hierarchies. Its connection is config's, which the repoint above aimed
// at this database (the config module is first imported HERE, by this dynamic
// import). It writes only what every installation gets, so it runs before the
// marker exists — the marker is the suite's, stamped right below.
const { installDbFromSeed } = await import('../src/core/install/db_restore.ts');
const restored = await installDbFromSeed();
console.log(`[test-db] ${restored.msg}`);

// 2b. THE TEST-DATABASE MARKER — the mechanical half of "tests never write
// production data" (src/core/test_data/test_database_marker.ts).
//
// It is written HERE, on a database this script has just DROPPED and CREATED,
// and nowhere else in the tree: that provenance is what the row means. Every
// step below this line, and every test-data writer in the suite, REFUSES on a
// database that does not carry it — the name guard above is a claim about a
// database, this row is the database itself saying it is disposable.
//
// It carries the provenance a stale test DB is diagnosed by: when it was
// built, from which checkout, from which seed, and from which `test` TLD
// ontology.
const { writeTestDatabaseMarker } = await import('../src/core/test_data/test_database_marker.ts');
const gitRev = await (async (): Promise<string> => {
	const proc = Bun.spawn(['git', '-C', REPO, 'rev-parse', 'HEAD'], {
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return code === 0 ? out.trim() : 'unknown';
})();
const sha256 = (path: string): string =>
	new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
const marker = await writeTestDatabaseMarker({
	build_stamp: new Date().toISOString(),
	git_rev: gitRev,
	seed_sha256: sha256(SEED),
	ontology_sha256: sha256(join(REPO, 'src', 'core', 'test_data', 'test_tld_ontology.json')),
});
console.log(
	`[test-db] marker written: ${marker.database_name} @ ${marker.build_stamp} (git ${marker.git_rev.slice(0, 12)}) — every test-data writer refuses without it`,
);

// 3. The DEFAULT domain ontologies, through the INSTALLER'S ontology door —
// stage (copy + gunzip + COPY-sanity of the vendored file into a private
// staging dir) then install (the update panel's shared import layer, the
// re-derive pass, the reference verification). The request is the offline
// default (`oh`, from the one vendored oh.copy.gz): what an air-gapped install
// gets, and what the generic test nodes reference (test21 hangs under an oh
// node, test39/test108 are diffusion aliases of one).
const { defaultOfflineOntologyRequest } = await import('../src/core/install/ontology_choice.ts');
const { installOntologies, stageOntologies } = await import(
	'../src/core/install/ontology_install.ts'
);
const ontologyStaging = mkdtempSync(join(tmpdir(), 'dedalo_test_ontology_staging_'));
try {
	const staged = await stageOntologies(defaultOfflineOntologyRequest(), {
		stagingDir: ontologyStaging,
	});
	console.log(`[test-db] ${staged.msg}`);
	const ontologies = await installOntologies({ stagingDir: ontologyStaging, userId: -1 });
	console.log(
		`[test-db] ${ontologies.msg}${ontologies.warnings.length > 0 ? ` — ${ontologies.warnings.join(' | ')}` : ''}`,
	);
} finally {
	rmSync(ontologyStaging, { recursive: true, force: true });
}

// 3b. The generic `test` TLD ontology — THE SUITE'S, never an installation's —
// from its ONE source (src/core/test_data/test_tld_ontology.json), WHOLE (the
// hand-authored Test area and the clone twins the parity tier replays against),
// through the engine's own doors: matrix_ontology `<tld>0` records, then
// rebuildOntology(tld) derives dd_ontology. The door refuses without the marker
// written above.
const { materializeTestTldOntology } = await import(
	'../src/core/test_data/test_tld_materialize.ts'
);
const testTld = await materializeTestTldOntology({ expectDatabase: testDb });
console.log(
	`[test-db] test TLD ontology materialized from JSON: ${testTld.nodes} records in ${testTld.tlds.length} TLDs — ${testTld.rebuilt.length} rebuilt${testTld.strays.length > 0 ? ` (STRAY records not in the JSON: ${testTld.strays.join(', ')})` : ''}`,
);

// 3c. The canonical test3 PLAYGROUND records (src/core/test_data/seed.ts — the
// single verified source, WC-021). The seed ships none; the preload restores
// the same set before every run, so this only makes a freshly built database
// complete before its first `bun test`.
const { restoreCanonicalTest3 } = await import('../src/core/test_data/seed.ts');
const playground = await restoreCanonicalTest3();
console.log(`[test-db] canonical test3 playground restored: ${playground.restored} records`);

// 4. The numisdata TEST ontology — definitions only, no records.
//
// The vendored `numisdata` ontology fixture was REMOVED here on 2026-08-21,
// the step this file always said phase 5/6 would delete. It existed because
// ~46 gates needed one installation's ontology to resolve against; after the
// generic-`test`-TLD migration the census is 2 files, both unmigratable by
// construction and neither needing this.
//
// MEASURED, not assumed, before deleting: the whole tier was run with the 1537
// ontology rows present and again with them dropped. Parity was identical
// (263 pass / 105 fail both ways) and exactly ONE unit assertion moved —
// observer_seed_native's "every declared peer is dd621 MULTIDIRECTIONAL",
// whose `>= 2` floor reached its count only because this fixture happened to
// be here. It now floors on the GENERIC peers, so it states the same law
// without requiring an installation's ontology to be in the database.

// 5. Hierarchies + tools, through the INSTALLER'S OWN code paths, from repo-vendored data —
// the tools/tree/virtual-section gates need a complete install, not a bare seed.
//
// NOT the whole vendored set. This used to glob every `*1.copy.gz` (153 TLDs,
// 127 MB gzipped) — which is how the fixture reached 7612 MB, 97.6% of it one
// install's geography no test names (see the header). The set is DERIVED from
// the tests' own references by scripts/lib/hierarchy_allowlist.ts — same
// installer path, same vendored files, over-inclusive where uncertain, and
// LOUD if the scan comes back empty. The derivation is exported so a gate can
// hold the installed set equal to the referenced set: a new test naming a new
// TLD reddens the fixture rather than failing mysteriously on one machine.
const allowlist = deriveHierarchyAllowlist(HIERARCHY_DIR);
const tlds = allowlist.imports;
// CORE hierarchies (`lg`) are not here: the installer's restore door (step 2)
// activated them, as it does for every installation.
const { installHierarchies } = await import('../src/core/install/hierarchy_import.ts');
const hierarchies = await installHierarchies(tlds);
console.log(
	`[test-db] hierarchies imported: ${tlds.length} of ${allowlist.vendored.length} vendored TLDs (${tlds.join(', ')} — derived from test-tree references, see scripts/lib/hierarchy_allowlist.ts)${hierarchies.ok === true ? '' : ` (WITH ERRORS: ${JSON.stringify(hierarchies.errors)})`}`,
);

const { registerInstallTools } = await import('../src/core/install/register_tools.ts');
const tools = await registerInstallTools();
console.log(`[test-db] tools registered (ok: ${tools.ok})`);

// 5c. THE SYNTHETIC HIERARCHIES — the GENERATED replacement for the imported
// geography above (src/core/test_data/synthetic_hierarchy_fixture.ts, whose
// header carries the census and the row-count arithmetic). Two activated
// `test*`-namespace thesauri built through the installer's own
// activateHierarchy door and populated deterministically: hierarchy A carries
// the volume + term-text-distribution corpus the search gates need
// (~1,300 rows, derived from the SEARCH_LATE_ROW_LOOKUP_OFFSET default at
// seed time), hierarchy B the second registry pairing (~10 rows). This is the
// shape every migratable geo-bound gate moves onto; the vendored imports in
// step 5 drain away as those migrations land (`lg` is not among them: it is a
// core hierarchy, activated above, never imported).
const { ensureSyntheticHierarchies } = await import(
	'../src/core/test_data/synthetic_hierarchy_fixture.ts'
);
const synthetic = await ensureSyntheticHierarchies();
console.log(
	`[test-db] synthetic hierarchies generated: ${Object.entries(synthetic.termRows)
		.map(([tld, rows]) => `${tld} (${rows} terms)`)
		.join(', ')} — data lang ${synthetic.dataLang}, activated through the installer's own door`,
);

// 5c'. THE BOOT MIGRATIONS — the same install/db/migrations/*.sql a real
// server applies on its first start (startServer → runBootMigrations), in the
// same position: before the derived-store heal, after the ontology is in.
//
// WHY (audit 2026-08-26, P1-13 / PUB-04). The suite database used to be "the
// seed + fixtures" and NEVER a booted install: the numbered migrations only
// reached it when something else started a server on it (`bun run
// test:client`), so whether a gate saw a corrected or an uncorrected seed
// depended on what had run before it. Migration 0008 is a SHARED-ROW SEED
// CORRECTION of the diffusion vocabulary the shipped ontology speaks — the
// exact state a fresh install boots into is now the state the suite measures,
// and test/unit/diffusion_seed_compiles_native.test.ts asserts the version
// row is present (a rebuild with this step missing is RED, by name).
//
// The marker is already written (2b), so this is a write to a database that
// says it is disposable; the migration lane itself is the install's, not a
// test-data writer, which is why it needs no assertTestDatabase of its own.
//
// A booted install ALSO runs the ONLINE migrations (install/db/online_migration.ts
// — the CONCURRENTLY index builds the boot run DEFERS so they never hold the
// listener; startServer runs them right after it binds). The suite database
// never listens, so without this step its history indexes (0011/0012) existed
// only after some test:client server had happened to start on it — the same
// order-dependence as above, on the plans the TM read gates EXPLAIN. Awaited
// here: nothing is serving, so there is no listener to hold.
const { runMigrations, runOnlineMigrations } = await import('../install/db/migrate.ts');
const migrations = await runMigrations();
console.log(
	`[test-db] boot migrations applied: ${migrations.applied.length} (${migrations.applied.join(', ')}; ${migrations.skipped} already recorded) — the suite database is a BOOTED install`,
);
const onlineMigrations = await runOnlineMigrations();
console.log(
	`[test-db] online migrations applied: ${onlineMigrations.applied.length} (${onlineMigrations.applied.join(', ')})`,
);

// 5d. THE DERIVED-STORE HEAL — the same self-provisioning a real boot runs
// (db_assets.ts ensureSearchStores, startServer): the install seed carries the
// sync trigger FUNCTIONS as they were when the dump was cut, and the declared
// bodies in db_pg_definitions.json move on (the record-address predicate of
// DATA-26 is one such move). A booted install re-creates a drifted function on
// its first start; the suite database never boots, so it takes the same step
// here. Read-only when nothing drifted; per-table refills otherwise.
const { ensureSearchStores } = await import('../src/core/db/db_assets.ts');
const stores = await ensureSearchStores();
console.log(
	`[test-db] derived search stores ensured (healthy: ${stores.healthy}, ddl applied: ${stores.ddlApplied}, refilled: ${JSON.stringify(stores.backfilled)}${stores.errors.length > 0 ? `, errors: ${JSON.stringify(stores.errors)}` : ''})`,
);

// 5b. THE READ-ONLY ROLE for the DB-free shard bands (see the header). Sits
// HERE — after every guard and after the schema exists — never as a
// convenience step that could run before a refusal. Everything is idempotent:
// the role survives rebuilds at the cluster level, while the per-database
// grants and default privileges just died with the DROP above and are
// re-issued in full, so a rebuild can never leave the role half-granted.
//
// The password is a FIXED, COMMITTED literal, deliberately not a secret: the
// only database it can read declares itself disposable (the marker row). It
// exists because the role must authenticate the same way everywhere — a
// password-less role rides local `trust` pg_hba and fails under CI's scram —
// and because config.db carries exactly one user/password credential pair.
// ALTER ROLE re-asserts LOGIN + the password every run, so drift heals.
//
// The role is CLUSTER-shared, so concurrent builds of different suite
// databases (per-lane `DEDALO_TEST_DATABASE`) collide on it — `tuple
// concurrently updated`, measured. The statement text lives in
// readOnlyRoleClusterSql (test/helpers/test_database.ts), serialized under an
// advisory lock, so the gate that proves concurrent runs succeed executes the
// exact text this build does.
await psql('postgres', ['-f', '-'], readOnlyRoleClusterSql(testDb));
await psql(
	testDb,
	['-f', '-'],
	`GRANT USAGE ON SCHEMA public TO dedalo_test_ro;
	GRANT SELECT ON ALL TABLES IN SCHEMA public TO dedalo_test_ro;
	-- Tables created AFTER this build (runtime dedalo_ts_test_* scratch tables,
	-- future migrations) get SELECT too — granted for the building user, which
	-- is the engine's one configured user, i.e. the creator of every such table.
	ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dedalo_test_ro;\n`,
);
console.log(
	`[test-db] read-only role 'dedalo_test_ro' ensured and granted SELECT on '${testDb}' (fixed non-secret credential; the database is disposable by declaration)`,
);

// 6. THE TEST CORPUS IS **NOT** SEEDED HERE — and that is the design, not an
// omission. The corpus (src/core/test_data/test_corpus/, 446 records over 36
// sections) is a SITUATION, and this database is the empty stage every gate
// builds its situation on: ambient rows are not free, because a census gate, a
// scratch-surface emptiness check and a "count the rows this save appended"
// assertion all read whatever the database holds. So a gate that needs the
// corpus calls `ensureTestCorpus(scope)` in its own `beforeAll` and
// `dropTestCorpus(scope)` in `afterAll` (test/unit/test_corpus_fixture.test.ts
// is the reference; test/helpers/zzd_diffusion_fixture.ts is the same pattern
// for the diffusion ontology). The generic `test` ontology above is the
// opposite case and does
// belong here: definitions cost nothing to have present, records do — but they
// must be the REPO's definitions, never a copy of some installation's.
//
// To materialize it by hand for a debugging session:
//   bun -e "await (await import('./src/core/test_data/test_corpus/ensure.ts')).ensureTestCorpus()"

console.log(
	`[test-db] ready — 'bun test' now uses '${testDb}', '${mediaRoot}' and vector database '${ragDb}' automatically.`,
);
process.exit(0);
