/**
 * update_full_drill — THE WHOLE UPDATE RUN, ACROSS RELEASES, WITH REAL EFFECTS
 * (`bun run test:update:full`; update audit 2026-10-29, finding U-50, design §6
 * Phase 3.1).
 *
 * The unit gates (test/unit/update_run_*_native.test.ts) drive the run engine
 * (src/core/update/run/) through fakes: every effect is a closure over an
 * in-memory world. `bun run test:update` (scripts/update_drill.ts) proves the
 * real CODE SWAP between two real engine processes, but runs no update run.
 * What nothing proved is the run itself with its real effects: the journal on
 * disk across a process that dies, the PostgreSQL advisory lock released by a
 * SIGKILL, the boot migration runner applying (and failing) real files, the
 * data engine's atomic transaction rolled back by a death mid-rung, the code
 * sentinel flipped by the real boot_confirm functions, the maintenance flag in
 * the real state file, and /health's `update_run` facts as each process sees
 * them. This drill is that, end to end, on scratch surfaces of the SUITE
 * database (every process calls assertTestDatabase first — an unmarked database is refused):
 *
 *   LEG 0  a scratch catalog (install/update/catalog.json shape, ontology
 *          steps included) loaded by the real loader (catalog_file.ts
 *          loadCatalogFile) — the data rungs' descriptors; the plans travel as
 *          a MASTER'S MANIFEST: the master side (release_plans_wire.ts
 *          wirePlansAbove) → JSON → the consumer parser (readWirePlans),
 *          merged over this tree's RELEASE_PLANS exactly as run/start.ts
 *          plansFromMaster does; the planner's walk is asserted.
 *
 *   RUN 1  7.0.1 → 7.1.0 while the ontology source offers 7.0.1: the 7.1.0
 *          ontology PRECONDITION (`min: 7.0.2`) refuses before the swap →
 *          FAILED_PRE_SWAP; nothing mutated, maintenance back to the operator's.
 *   RUN 2  7.0.1 → 7.1.0 across 7.0.2 (compatible) once the source offers
 *          7.0.2: ontology precondition → CODE (the process "restarts": the
 *          phase stays running) → a second run is refused while this one is in
 *          flight → CHILD A boots as 7.1.0 and resumes from the journal: the
 *          code phase settles on the booted tree, 7.0.2 ontology + schema,
 *          7.1.0 ontology + schema, the 7.1.0 DATA RUNG — whose checkpoint
 *          script parks the child INSIDE the rung's transaction, where it is
 *          SIGKILLed → PostgreSQL rolls the rung back and frees the lock →
 *          CHILD B resumes: the interrupted phase is closed `failed
 *          {interrupted}` and runs again → verify → VERIFIED → CONFIRMED.
 *   RUN 3  7.1.0 → 7.2.0 (incompatible): CODE → CHILD C boots as 7.2.0: the
 *          schema phase applies a good file, then a PLANTED failing migration →
 *          NEEDS_DB_RESTORE (D-2: the model was crossed — no automatic
 *          rollback; maintenance stays ON; the sentinel says needs_restore; the
 *          journal names the backup and the loss window).
 *
 * Every leg asserts OUTCOMES: the journal's states and phases (read from
 * disk), the rows the migrations and the rung wrote (and did not), the
 * maintenance flag in the state file, the code sentinel's status, the
 * advisory lock in pg_locks, and the /health payload each process builds
 * (buildHealthPayload over updateRunFacts — what server.ts /health serves).
 *
 * WHAT IS A SEAM HERE (honest limits):
 *   - the CODE SWAP: the code phase writes a pending sentinel and answers
 *     `restarting`; the "new tree" is a fresh process told its release
 *     identity. The real swap is scripts/update_drill.ts's job.
 *   - the ONTOLOGY IMPORT DOOR: the phase is the real runOntologyPhase (source
 *     selection, manifest read from a real export directory through
 *     readLocalOntologyManifest, the `min` precondition, file selection by
 *     ACTIVE_ONTOLOGY_TLDS); only updateOntology — whose model check would read
 *     this checkout's real data version, not the drill's scratch releases — is
 *     replaced by a door that verifies each file's digest (the real
 *     digestRefusal) and records it in a scratch table. The real door is
 *     gated by ontology_update_source_native / ontology_update_tld_scope_native.
 *   - the SCHEMA phase runs the real runMigrations over the scratch TREE's
 *     migrations directory + ledger and a scratch version table (production
 *     runs the shipped directory and table — the call is otherwise identical).
 *   - the DATA phase runs the real atomic engine (engine.ts updateVersion) with
 *     the scratch descriptors; its version row goes to a scratch table, not
 *     matrix_updates (the engine's own `writeVersionRow` test seam), so the
 *     suite database's data version never moves.
 *   - VERIFY runs the real verifyRun predicates over those scratch reads; the
 *     `data_model` predicate is re-bound to the run's own plans (production
 *     reads the target tree's RELEASE_PLANS, which here is not the drill's).
 *   - CONFIRM / NEEDS_RESTORE: the real confirmBootedCodeUpdate /
 *     markFailedBootSchema over a scratch sentinel. The online-migration lane
 *     production starts after a confirm is NOT started (it would run the
 *     shipped directory on the suite database).
 *   - the BACKUP: RUN 1/2 take the production waiver path (journaled); RUN 3
 *     names a scratch file so the restore report's backup + loss window are
 *     asserted.
 *   - no ANCILLARY step is declared (its reconcilers write the suite's real
 *     registry, search stores and media rules) — update_run_ancillary_native.
 * Everything else — executor, journal, plan, lock, preflight, maintenance,
 * rollback predicate, restore report, resume, /health facts — is production
 * code with no seam.
 *
 * KNOWN ENGINE BUGS are pinned (BugProbe): each probe must still REPRODUCE, or
 * the drill is red — the pin, and any workaround it forces, go in the same
 * change that fixes the engine. None open (B1–B4 fixed 2026-10-30, each now a
 * positive assertion).
 *
 * Tier: the instance tier (engineering/CI.md) — the suite database, child
 * processes, ~10-30 s. Prerequisite: `bun run test:db:setup`. `--keep` leaves
 * the scratch dir (journals, sentinel, child logs) for post-mortem. Scratch
 * tables (`dedalo_ts_test_updfull_*`) are swept at both ends and their absence
 * asserted; a drill-wide advisory lock refuses a concurrent drill.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleasePlan } from '../src/core/update/catalog_file.ts';
import type { PhaseResult, RunEffects } from '../src/core/update/run/executor.ts';
import type { RunJournal } from '../src/core/update/run/journal.ts';
import { removeScratchDir, scratchDir } from '../test/helpers/scratch_dir.ts';

const SCRIPT = fileURLToPath(import.meta.url);
const TOTAL_DEADLINE_MS = 5 * 60_000;
const MARKER_WAIT_MS = 90_000;
const LOCK_FREE_WAIT_MS = 20_000;

/** The scratch ontology TLD the planted master export offers (a manifest string only — no node is created). */
const DRILL_TLD = 'zzupfull';
/** The drill-wide session lock: one drill per database at a time (its scratch tables have fixed names). */
const DRILL_LOCK_KEY = 7_020_930_077;
/** The run engine's UPDATE_RUN advisory key pair (run/lock.ts) — read in pg_locks. */
const RUN_LOCK = { namespace: 7_020_930, key: 1 };

const T = {
	migrations: 'dedalo_ts_test_updfull_migrations',
	dataVersion: 'dedalo_ts_test_updfull_data_version',
	ontology: 'dedalo_ts_test_updfull_ontology',
	s1: 'dedalo_ts_test_updfull_s1',
	s2: 'dedalo_ts_test_updfull_s2',
	s3: 'dedalo_ts_test_updfull_s3',
	s4: 'dedalo_ts_test_updfull_s4',
	rung: 'dedalo_ts_test_updfull_rung',
} as const;

// ---------------------------------------------------------------------------
// the scratch releases
// ---------------------------------------------------------------------------

/** Migration files per release (each tree carries every file up to its own release). */
const MIGRATIONS: readonly {
	file: string;
	release: string;
	class: 'compatible' | 'incompatible';
	sql: string;
}[] = [
	{
		file: '0001_updfull_s1.sql',
		release: '7.0.2',
		class: 'compatible',
		sql: [
			'CREATE TABLE IF NOT EXISTS dedalo_ts_test_updfull_s1 (id text PRIMARY KEY, note text);',
			'CREATE INDEX IF NOT EXISTS dedalo_ts_test_updfull_s1_note ON dedalo_ts_test_updfull_s1 (note);',
		].join('\n'),
	},
	{
		file: '0002_updfull_s2.sql',
		release: '7.1.0',
		class: 'incompatible',
		sql: [
			'CREATE TABLE dedalo_ts_test_updfull_s2 (id text PRIMARY KEY);',
			"INSERT INTO dedalo_ts_test_updfull_s2 (id) VALUES ('schema 7.1.0');",
			'CREATE TABLE dedalo_ts_test_updfull_rung (id text PRIMARY KEY, note text);',
		].join('\n'),
	},
	{
		file: '0003_updfull_s3.sql',
		release: '7.2.0',
		class: 'incompatible',
		sql: [
			'CREATE TABLE dedalo_ts_test_updfull_s3 (id text PRIMARY KEY);',
			"INSERT INTO dedalo_ts_test_updfull_s3 (id) VALUES ('schema 7.2.0');",
		].join('\n'),
	},
	{
		// THE PLANTED FAILURE: a table and a row, then a statement that fails —
		// the file's own transaction must leave neither behind.
		file: '0004_updfull_planted_failure.sql',
		release: '7.2.0',
		class: 'incompatible',
		sql: [
			'CREATE TABLE dedalo_ts_test_updfull_s4 (id text PRIMARY KEY);',
			"INSERT INTO dedalo_ts_test_updfull_s4 (id) VALUES ('never');",
			'SELECT 1 / 0;',
		].join('\n'),
	},
];

/** The data rungs' SQL files (install/update/<release>/<name>.sql). */
const RUNG_SQL: Readonly<Record<string, string>> = {
	'7.1.0/01_rung.sql':
		"INSERT INTO dedalo_ts_test_updfull_rung (id, note) VALUES ('rung 7.1.0', 'data rung')",
	'7.2.0/01_rung.sql':
		"INSERT INTO dedalo_ts_test_updfull_rung (id, note) VALUES ('rung 7.2.0', 'data rung')",
};

const CHECKPOINT_SCRIPT = {
	id: 'drill_checkpoint',
	info: 'the drill parks a child here, inside the rung transaction',
	stop_on_error: true,
};

/** The scratch catalog (install/update/catalog.json shape): four releases, two data models crossed. */
function fullCatalog(): unknown {
	return {
		format: 1,
		releases: {
			'7.0.1': {},
			'7.0.2': {
				compat: 'compatible',
				steps: [{ kind: 'code' }, { kind: 'ontology' }, { kind: 'schema' }],
			},
			'7.1.0': {
				compat: 'incompatible',
				steps: [
					{ kind: 'ontology', min: '7.0.2' },
					{ kind: 'code' },
					{ kind: 'ontology' },
					{ kind: 'schema' },
					{ kind: 'data', sql: ['7.1.0/01_rung.sql'], scripts: [CHECKPOINT_SCRIPT] },
				],
			},
			'7.2.0': {
				compat: 'incompatible',
				steps: [{ kind: 'code' }, { kind: 'schema' }, { kind: 'data', sql: ['7.2.0/01_rung.sql'] }],
			},
		},
	};
}

// ---------------------------------------------------------------------------
// the world: every scratch path, shared parent → child through one JSON file
// ---------------------------------------------------------------------------

interface World {
	scratch: string;
	journalRoot: string;
	sentinelPath: string;
	stateFile: string;
	exportDir: string;
	catalogDir: string;
	markerDir: string;
	logPath: string;
	/** Per release identity of a tree: its migrations dir + ledger file. */
	trees: Record<string, { dir: string; ledger: string }>;
}

function sha256(content: string | Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`);
}

function readJson<V>(path: string): V {
	return JSON.parse(readFileSync(path, 'utf8')) as V;
}

function buildWorld(scratch: string): World {
	const world: World = {
		scratch,
		journalRoot: join(scratch, 'update', 'runs'),
		sentinelPath: join(scratch, 'code_backups', 'last_code_update.json'),
		stateFile: join(scratch, 'ts_state.json'),
		exportDir: join(scratch, 'ontology_export', '7.0'),
		catalogDir: join(scratch, 'catalog'),
		markerDir: join(scratch, 'markers'),
		logPath: join(scratch, 'update.log'),
		trees: {},
	};
	for (const dir of [
		world.journalRoot,
		join(scratch, 'code_backups'),
		world.exportDir,
		world.markerDir,
	]) {
		mkdirSync(dir, { recursive: true });
	}
	writeJson(world.stateFile, { maintenance_mode: false });
	mkdirSync(world.catalogDir, { recursive: true });
	writeJson(join(world.catalogDir, 'catalog.json'), fullCatalog());
	for (const [path, text] of Object.entries(RUNG_SQL)) {
		mkdirSync(join(world.catalogDir, path.split('/')[0] as string), { recursive: true });
		writeFileSync(join(world.catalogDir, path), `${text}\n`);
	}
	for (const release of ['7.1.0', '7.2.0']) {
		const dir = join(scratch, `tree_${release}`, 'migrations');
		mkdirSync(dir, { recursive: true });
		const carried = MIGRATIONS.filter((entry) => compareTriples(entry.release, release) <= 0);
		const migrations: Record<string, { sha256: string; class: string; release: string }> = {};
		for (const entry of carried) {
			writeFileSync(join(dir, entry.file), entry.sql);
			migrations[entry.file] = {
				sha256: sha256(entry.sql),
				class: entry.class,
				release: entry.release,
			};
		}
		const ledger = join(scratch, `tree_${release}`, 'migrations.lock.json');
		writeJson(ledger, { format: 1, migrations });
		world.trees[release] = { dir, ledger };
	}
	plantOntologyExport(world, '7.0.1');
	return world;
}

function compareTriples(a: string, b: string): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The master's export directory (data_io layout): ontology.json + the two files, at `version`. */
function plantOntologyExport(world: World, version: string): void {
	const files: Record<string, Uint8Array> = {
		[`${DRILL_TLD}.copy.gz`]: Bun.gzipSync(new TextEncoder().encode(`${DRILL_TLD} ${version}\n`)),
		'matrix_dd.copy.gz': Bun.gzipSync(new TextEncoder().encode(`matrix_dd ${version}\n`)),
	};
	const digests: Record<string, string> = {};
	for (const [name, bytes] of Object.entries(files)) {
		writeFileSync(join(world.exportDir, name), bytes);
		digests[name] = sha256(bytes);
	}
	writeJson(join(world.exportDir, 'ontology.json'), {
		version,
		active_ontologies: [{ tld: DRILL_TLD, name: 'update drill' }],
		files_sha256: digests,
	});
}

// ---------------------------------------------------------------------------
// the engine (imported only after the process points at the suite database)
// ---------------------------------------------------------------------------

async function loadEngine() {
	const [
		executor,
		journal,
		plan,
		production,
		verify,
		rollback,
		ontologyPhase,
		manifest,
		dataIo,
		migrate,
		migrationLedger,
		engine,
		catalog,
		catalogFile,
		wire,
		bootConfirm,
		bootState,
		health,
		postgres,
		marker,
		permissions,
		versionContract,
	] = await Promise.all([
		import('../src/core/update/run/executor.ts'),
		import('../src/core/update/run/journal.ts'),
		import('../src/core/update/run/plan.ts'),
		import('../src/core/update/run/production.ts'),
		import('../src/core/update/run/verify.ts'),
		import('../src/core/update/run/rollback.ts'),
		import('../src/core/update/run/ontology_phase.ts'),
		import('../src/core/ontology/ontology_manifest.ts'),
		import('../src/core/ontology/data_io_import.ts'),
		import('../install/db/migrate.ts'),
		import('../install/db/migration_ledger.ts'),
		import('../src/core/update/engine.ts'),
		import('../src/core/update/catalog.ts'),
		import('../src/core/update/catalog_file.ts'),
		import('../src/core/update/release_plans_wire.ts'),
		import('../src/core/update/boot_confirm.ts'),
		import('../src/core/update/boot_state.ts'),
		import('../src/core/api/health_payload.ts'),
		import('../src/core/db/postgres.ts'),
		import('../src/core/test_data/test_database_marker.ts'),
		import('../src/core/security/permissions.ts'),
		import('../src/core/update/version_contract.ts'),
	]);
	return {
		executor,
		journal,
		plan,
		production,
		verify,
		rollback,
		ontologyPhase,
		manifest,
		dataIo,
		migrate,
		migrationLedger,
		engine,
		catalog,
		catalogFile,
		wire,
		bootConfirm,
		bootState,
		health,
		postgres,
		marker,
		permissions,
		versionContract,
	};
}

type Engine = Awaited<ReturnType<typeof loadEngine>>;

/** The suite database's identity is the marker: every process asserts it before its first write. */
async function engineForSuite(): Promise<Engine> {
	const engine = await loadEngine();
	await engine.marker.assertTestDatabase('update_full_drill');
	return engine;
}

// ---------------------------------------------------------------------------
// scratch reads / writes
// ---------------------------------------------------------------------------

async function q<R>(e: Engine, text: string, params: unknown[] = []): Promise<R[]> {
	return (await e.postgres.sql.unsafe(text, params as never[])) as R[];
}

async function readDrillDataVersion(e: Engine): Promise<number[]> {
	const [row] = await q<{ version: string }>(
		e,
		'SELECT version FROM dedalo_ts_test_updfull_data_version ORDER BY id DESC LIMIT 1',
	);
	if (row === undefined) throw new Error('the drill data-version table holds no row');
	return row.version.split('.').map(Number);
}

async function writeDrillDataVersion(e: Engine, version: string): Promise<void> {
	await q(e, 'INSERT INTO dedalo_ts_test_updfull_data_version (version) VALUES ($1)', [version]);
}

async function tableExists(e: Engine, table: string): Promise<boolean> {
	const [row] = await q<{ present: boolean }>(e, 'SELECT to_regclass($1) IS NOT NULL AS present', [
		`public.${table}`,
	]);
	return row?.present === true;
}

async function idsOf(e: Engine, table: string): Promise<string[]> {
	if (!(await tableExists(e, table))) return [];
	// `table` is one of the fixed names in T (never input).
	const rows = await q<{ id: string }>(e, `SELECT id FROM ${quoteIdent(table)} ORDER BY id`);
	return rows.map((row) => row.id);
}

function quoteIdent(name: string): string {
	if (!/^dedalo_ts_test_updfull_[a-z0-9_]+$/.test(name))
		throw new Error(`not a drill table: ${name}`);
	return `"${name}"`;
}

async function recordedMigrations(
	e: Engine,
): Promise<{ version: string; sha256: string | null; release: string | null }[]> {
	if (!(await tableExists(e, T.migrations))) return [];
	return q(
		e,
		'SELECT version, sha256, release FROM dedalo_ts_test_updfull_migrations ORDER BY version',
	);
}

async function ontologyImports(e: Engine): Promise<{ tld: string; version: string }[]> {
	return q(e, 'SELECT tld, version FROM dedalo_ts_test_updfull_ontology ORDER BY id');
}

async function runLockHolders(e: Engine): Promise<number> {
	const [row] = await q<{ held: number }>(
		e,
		"SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 2",
		[RUN_LOCK.namespace, RUN_LOCK.key],
	);
	return row?.held ?? -1;
}

async function sweepTables(e: Engine): Promise<void> {
	for (const table of Object.values(T)) await q(e, `DROP TABLE IF EXISTS ${quoteIdent(table)}`);
}

async function residue(e: Engine): Promise<string[]> {
	const rows = await q<{ table_name: string }>(
		e,
		"SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'dedalo\\_ts\\_test\\_updfull\\_%'",
	);
	return rows.map((row) => row.table_name);
}

async function seedTables(e: Engine): Promise<void> {
	await q(
		e,
		'CREATE TABLE dedalo_ts_test_updfull_data_version (id serial PRIMARY KEY, version text NOT NULL)',
	);
	await q(
		e,
		'CREATE TABLE dedalo_ts_test_updfull_ontology (id serial PRIMARY KEY, tld text NOT NULL, version text)',
	);
	await writeDrillDataVersion(e, '7.0.0');
}

// ---------------------------------------------------------------------------
// the run's effects: production, with the seams the header names
// ---------------------------------------------------------------------------

interface ProcessOptions {
	/** The release identity this process's tree calls itself. */
	booted: string;
	/** A run started here (the panel's context) — null: a run resumed at boot. */
	starting: boolean;
	/** A name for this process's /health snapshot file. */
	role: string;
	/** Park inside the data rung's transaction (the kill leg's child A). */
	pauseInData?: boolean;
	backup?: RunEffects['backup'];
	preflight?: RunEffects['preflight'];
}

function healthNow(e: Engine, booted: string) {
	return e.health.buildHealthPayload({
		dbOk: true,
		entity: 'update_full_drill',
		version: booted,
		installDigest: null,
		requestId: 'update_full_drill',
		updateRun: e.bootState.updateRunFacts(),
	});
}

function healthFile(world: World, role: string): string {
	return join(world.markerDir, `health_${role}.json`);
}

/** The descriptors of the scratch tree (the real catalog loader). */
function drillDescriptors(e: Engine, world: World) {
	const parsed = e.catalogFile.loadCatalogFile(world.catalogDir);
	const refusal = e.catalog.descriptorRefusal(parsed.violations);
	if (refusal !== null) throw refusal;
	return parsed.descriptors;
}

/** The data phase: production's dataPhase over the scratch descriptors and version table. */
async function drillDataPhase(e: Engine, world: World, pause: boolean): Promise<PhaseResult> {
	const descriptors = drillDescriptors(e, world);
	const current = await readDrillDataVersion(e);
	const descriptor = e.catalog.getMatchedDescriptor(current, descriptors);
	const checked = Object.fromEntries([
		...(descriptor?.sqlUpdate ?? []).map((_, index) => [`SQL_update_${index}`, true]),
		...(descriptor?.runScripts ?? []).map((_, index) => [`run_scripts_${index}`, true]),
	]);
	const response = await e.engine.updateVersion(checked, {
		catalog: descriptors,
		scripts: {
			drill_checkpoint: async () => {
				if (pause) {
					writeFileSync(join(world.markerDir, 'paused_in_data'), String(process.pid));
					// Parked for the SIGKILL. The timer keeps the event loop alive: a bare
					// never-settling promise lets Bun EXIT the process (pooled sockets are unref'd).
					setInterval(() => {}, 60_000);
					await new Promise<never>(() => {});
				}
				return { ok: true, msg: 'drill checkpoint passed' };
			},
		},
		currentVersion: current,
		readVersionInTx: () => readDrillDataVersion(e),
		writeVersionRow: (version) => writeDrillDataVersion(e, version),
		logPath: world.logPath,
		reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
		lockRetryDelaysMs: [],
	});
	return {
		outcome: response.ok ? 'ok' : 'failed',
		evidence: { msg: response.msg, errors: response.errors },
	};
}

/** The import door stand-in: the file's digest (the real check), then a scratch row. */
function drillOntologyDoor(e: Engine, world: World) {
	return async (options: unknown) => {
		const { files } = options as { files: { tld: string; url: string }[] };
		const info = readJson<{ version: string; files_sha256: Record<string, string> }>(
			join(world.exportDir, 'ontology.json'),
		);
		const errors: string[] = [];
		for (const file of files) {
			const path = fileURLToPath(file.url);
			const refusal = await e.dataIo.digestRefusal(path, info.files_sha256[`${file.tld}.copy.gz`]);
			if (refusal !== null) errors.push(refusal.error);
			else
				await q(e, 'INSERT INTO dedalo_ts_test_updfull_ontology (tld, version) VALUES ($1, $2)', [
					file.tld,
					info.version,
				]);
		}
		return { ok: errors.length === 0, msg: `drill door: ${files.length} file(s)`, errors };
	};
}

function drillEffects(e: Engine, world: World, options: ProcessOptions): RunEffects {
	const principal = {
		userId: e.permissions.SUPERUSER_ID,
		isGlobalAdmin: true,
		isDeveloper: true,
	};
	const base = e.production.productionRunEffects(
		options.starting ? { principal, codeRequest: null, waiveBackup: true } : null,
	);
	const tree = world.trees[options.booted];
	const ledgerOf = async () =>
		tree === undefined ? null : await e.migrationLedger.readMigrationLedger(tree.ledger);
	const okVerdict = {
		state: 'ok' as const,
		applied: [],
		deferred: [],
		schemaMoved: false,
		error: null,
	};
	return {
		...base,
		root: world.journalRoot,
		...(options.preflight === undefined ? {} : { preflight: options.preflight }),
		...(options.backup === undefined ? {} : { backup: options.backup }),
		runners: {
			code: options.starting
				? async (entry, journal) => {
						// THE SWAP SEAM: the pending sentinel code_update.ts writes, then the restart.
						writeJson(world.sentinelPath, {
							version: entry.release,
							previousVersion: journal.from.release,
							updateMode: 'update_full_drill',
							stamp: new Date().toISOString(),
							backupDir: join(world.scratch, 'code_backups', `dedalo_${journal.from.release}`),
							status: 'pending',
							rollback_attempted: false,
						});
						return { outcome: 'ok', evidence: { swapped_to: entry.release }, restarting: true };
					}
				: base.runners.code,
			ontology: (entry) =>
				e.ontologyPhase.runOntologyPhase(entry.step, principal.userId, {
					catalog: { servers: [], isOntologyServer: true },
					activeTlds: [DRILL_TLD],
					readManifest: async () => e.manifest.readLocalOntologyManifest(world.exportDir),
					update: drillOntologyDoor(e, world),
				}),
			schema: async (entry) => {
				if (tree === undefined) throw new Error(`no scratch tree for ${options.booted}`);
				// as run/production.ts schemaPhase: this release's files only (B2, fixed 2026-10-30)
				const run = await e.migrate.runMigrations({
					throughRelease: entry.release,
					dir: tree.dir,
					versionTable: T.migrations,
					ledger: await ledgerOf(),
					lockRetryDelaysMs: [],
				});
				return { outcome: 'ok', evidence: { applied: run.applied, deferred: run.deferred } };
			},
			data: () => drillDataPhase(e, world, options.pauseInData === true),
			ancillary: async () => ({
				outcome: 'failed',
				evidence: { summary: 'the drill declares no ancillary step' },
			}),
		},
		verify: async (journal) => {
			if (tree === undefined) throw new Error(`no scratch tree for ${options.booted}`);
			const ledger = await ledgerOf();
			const reads = {
				pendingBootMigrations: async () =>
					(await e.migrate.pendingMigrations({ dir: tree.dir, versionTable: T.migrations }))
						.pending,
				recordedHashes: async () => recordedMigrations(e),
				ledger: async () => ledger ?? { format: 1, migrations: {} },
				installedDataVersion: () => readDrillDataVersion(e),
			};
			const plans = { ...e.catalog.RELEASE_PLANS, ...journal.release_plans };
			const predicates = e.verify.RUN_VERIFY_PREDICATES.map((predicate) =>
				predicate.id !== 'data_model'
					? predicate
					: {
							id: predicate.id,
							check: async (run: RunJournal) => {
								const model = e.versionContract.dataModelOf(await readDrillDataVersion(e), plans);
								const named = model === null ? 'unknown' : model.join('.');
								return {
									ok: named === run.to.model,
									detail: `database on model ${named}, target model ${run.to.model}`,
								};
							},
						},
			);
			return e.verify.verifyRun(journal, reads, predicates);
		},
		confirm: async (journal) => {
			if (!journal.plan.some((entry) => entry.step.kind === 'code')) return;
			await e.bootConfirm.confirmBootedCodeUpdate(
				world.sentinelPath,
				options.booted,
				null,
				null,
				okVerdict,
			);
		},
		markNeedsRestore: (journal) =>
			e.bootConfirm.markFailedBootSchema(
				{
					state: 'failed',
					applied: [],
					deferred: [],
					schemaMoved: true,
					error: `update run ${journal.run_id}: the data model is being crossed — a rollback needs a database restore`,
				},
				world.sentinelPath,
				options.booted,
				null,
			),
		bootedRelease: () => options.booted,
		bootedDigest: () => null,
		report: (journal) => {
			// production's facts, with `on_target` judged against THIS process's
			// tree (production reads the checkout's own build stamp).
			const facts = e.production.runFactsOf(journal);
			e.bootState.recordUpdateRunFacts(
				facts === null
					? null
					: {
							...facts,
							on_target: e.executor.runsTargetTree(journal, {
								release: options.booted,
								digest: null,
							}),
						},
			);
			writeJson(healthFile(world, options.role), healthNow(e, options.booted));
		},
	};
}

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

class DrillFailure extends Error {}

function check(condition: boolean, label: string, detail: unknown = ''): void {
	if (condition) return;
	const said = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
	throw new DrillFailure(`ASSERTION FAILED — ${label}${said === '' ? '' : `\n${said}`}`);
}

function equal(actual: unknown, expected: unknown, label: string): void {
	check(
		JSON.stringify(actual) === JSON.stringify(expected),
		label,
		`expected ${JSON.stringify(expected)}\n  actual ${JSON.stringify(actual)}`,
	);
}

function say(line: string): void {
	console.log(`[full-drill] ${line}`);
}

function phaseLine(journal: RunJournal): string[] {
	return journal.phases.map((phase) => `${phase.release} ${phase.step.kind} ${phase.outcome}`);
}

async function onlyJournal(e: Engine, world: World, runId: string): Promise<RunJournal> {
	const read = await e.journal.readRunJournal(join(world.journalRoot, `${runId}.json`));
	check(read.ok, `journal ${runId} is readable from disk`, read);
	return (read as { ok: true; journal: RunJournal }).journal;
}

function maintenanceFlag(world: World): boolean {
	return readJson<{ maintenance_mode?: boolean }>(world.stateFile).maintenance_mode === true;
}

function sentinelStatus(world: World): string | null {
	return existsSync(world.sentinelPath)
		? readJson<{ status: string }>(world.sentinelPath).status
		: null;
}

type Health = ReturnType<Engine['health']['buildHealthPayload']>;

function assertHealth(
	health: Health,
	journal: RunJournal,
	expected: { on_target: boolean; result: 'ok' | 'error' },
	label: string,
): void {
	equal(
		health.update_run,
		{
			run_id: journal.run_id,
			state: journal.state,
			target: journal.to.release,
			owns_boot: journal.phases.some((phase) => phase.step.kind === 'code'),
			on_target: expected.on_target,
		},
		`${label}: /health update_run reads the run as it is`,
	);
	equal(health.result, expected.result, `${label}: /health result`);
}

async function waitFor(
	predicate: () => Promise<boolean> | boolean,
	ms: number,
	label: string,
): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (await predicate()) return;
		await Bun.sleep(100);
	}
	throw new DrillFailure(`TIMED OUT after ${ms} ms waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// child processes (the "next boot" of a tree)
// ---------------------------------------------------------------------------

interface ChildResult {
	outcome: string | null;
	state: string | null;
	run_id: string | null;
	health: Health;
}

function spawnChild(world: World, role: string, booted: string, pauseInData: boolean) {
	const log = join(world.scratch, `child_${role}.log`);
	const fd = openSync(log, 'w');
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'run',
			SCRIPT,
			'--child',
			role,
			'--booted',
			booted,
			'--world',
			join(world.scratch, 'world.json'),
			...(pauseInData ? ['--pause-in-data'] : []),
		],
		env: { ...process.env },
		stdout: fd,
		stderr: fd,
	});
	closeSync(fd);
	return { child, log, result: join(world.markerDir, `result_${role}.json`) };
}

async function childFinished(
	spawned: ReturnType<typeof spawnChild>,
	label: string,
): Promise<ChildResult> {
	const code = await spawned.child.exited;
	if (code !== 0 || !existsSync(spawned.result)) {
		throw new DrillFailure(
			`${label}: child exited ${code} without a result — log ${spawned.log}:\n${readFileSync(spawned.log, 'utf8').slice(-4000)}`,
		);
	}
	return readJson<ChildResult>(spawned.result);
}

/** One "next boot": the run in flight resumed from the journal by a tree that calls itself `booted`. */
async function resumeAsBoot(
	e: Engine,
	world: World,
	role: string,
	booted: string,
	pauseInData: boolean,
): Promise<ChildResult> {
	const effects = drillEffects(e, world, { booted, starting: false, role, pauseInData });
	// The boot's own sequence (run/boot.ts resumeBootRun), with the drill's effects.
	const outcome = await e.executor.resumeUpdateRun(effects);
	return {
		outcome: outcome?.state ?? null,
		state: outcome?.journal.state ?? null,
		run_id: outcome?.journal.run_id ?? null,
		health: healthNow(e, booted),
	};
}

async function childMain(argv: readonly string[]): Promise<void> {
	const arg = (name: string) => argv[argv.indexOf(name) + 1] as string;
	const world = readJson<World>(arg('--world'));
	const role = arg('--child');
	const e = await engineForSuite();
	const result = await resumeAsBoot(
		e,
		world,
		role,
		arg('--booted'),
		argv.includes('--pause-in-data'),
	);
	writeJson(join(world.markerDir, `result_${role}.json`), result);
	await e.postgres.closeDatabasePool();
	process.exit(0);
}

/** The next boot: a real child process (the drill), or this process (the suite's in-process subset). */
async function nextBoot(c: Context, role: string, booted: string): Promise<ChildResult> {
	if (!c.children) return resumeAsBoot(c.e, c.world, role, booted, false);
	return childFinished(spawnChild(c.world, role, booted, false), `child ${role}`);
}

// ---------------------------------------------------------------------------
// KNOWN ENGINE BUGS — each must still reproduce (see the header)
// ---------------------------------------------------------------------------

interface BugProbe {
	id: string;
	where: string;
	what: string;
	reproduces: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// the legs
// ---------------------------------------------------------------------------

interface Context {
	e: Engine;
	/** Real child processes (+ the SIGKILL leg); false = every boot resumes in this process. */
	children: boolean;
	world: World;
	plans: Record<string, ReleasePlan>;
	targetData: Record<string, number[]>;
	pinned: BugProbe[];
}

const PRE_EXPECTED_PLAN_710 = [
	'7.1.0 ontology',
	'7.1.0 code',
	'7.0.2 ontology',
	'7.0.2 schema',
	'7.1.0 ontology',
	'7.1.0 schema',
	'7.1.0 data',
];

function planFor(c: Context, installedRelease: string, installedData: number[], target: string) {
	const planned = c.e.plan.planRun({
		installedRelease,
		installedData,
		target,
		plans: c.plans,
		...(c.targetData[target] === undefined ? {} : { targetData: c.targetData[target] }),
	});
	check(planned.ok, `plan ${installedRelease} → ${target}`, planned);
	return planned;
}

/** LEG 0: the catalog the drill releases ship, through the real loader and the real wire parser. */
async function legCatalog(c: Context): Promise<void> {
	const { e, world } = c;
	const loaded = e.catalogFile.loadCatalogFile(world.catalogDir);
	equal(loaded.violations, [], 'the scratch catalog (ontology steps included) loads clean');
	// THE MASTER SIDE: its manifest's `plans` for an asker on 7.0.1, through the wire (JSON).
	const wire = JSON.parse(
		JSON.stringify(e.wire.wirePlansAbove([7, 0, 1], loaded.plans, loaded.descriptors)),
	) as {
		version: string;
		data: string;
		steps: { kind: string; min?: string }[];
	}[];
	equal(
		wire.map((plan) => [plan.version, plan.data]),
		[
			['7.0.2', '7.0.0'],
			['7.1.0', '7.1.0'],
			['7.2.0', '7.2.0'],
		],
		"the master's plans: each release's data version (dataVersionOf over the catalog)",
	);
	equal(
		wire[1]?.steps[0],
		{ kind: 'ontology', min: '7.0.2' },
		'the 7.1.0 ontology precondition travels on the wire',
	);
	const read = e.wire.readWirePlans(wire);
	check(read !== null, "the consumer parser (readWirePlans) accepts the master's plans", wire);
	const parsed = read as NonNullable<typeof read>;
	c.plans = { ...e.catalog.RELEASE_PLANS, ...parsed.plans };
	c.targetData = parsed.data;
	const planned = planFor(c, '7.0.1', [7, 0, 0], '7.1.0');
	if (!planned.ok) return;
	equal(
		planned.plan.map((entry) => `${entry.release} ${entry.step.kind}`),
		PRE_EXPECTED_PLAN_710,
		'the 7.0.1 → 7.1.0 walk: ontology precondition, ONE code swap, then each release in order',
	);
	equal(
		[planned.from.model, planned.to.model],
		['7.0.0', '7.1.0'],
		'the walk crosses the 7.0 → 7.1 data model (journaled up front)',
	);
	say('LEG 0 PASS — catalog: loader + master wire plans + planner');
}

/** RUN 1: the ontology precondition refuses before the swap. */
async function legOntologyMinRefusal(c: Context): Promise<void> {
	const { e, world } = c;
	const planned = planFor(c, '7.0.1', [7, 0, 0], '7.1.0');
	const effects = drillEffects(e, world, { booted: '7.0.1', starting: true, role: 'run1' });
	const outcome = await e.executor.startPlannedRun(planned, { ...effects, plans: c.plans });
	const journal = await onlyJournal(e, world, outcome.journal.run_id);
	equal([outcome.state, journal.state], ['ended', 'FAILED_PRE_SWAP'], 'RUN 1 ends FAILED_PRE_SWAP');
	equal(
		phaseLine(journal),
		['7.1.0 ontology failed'],
		'RUN 1: only the ontology precondition ran; the code phase never started',
	);
	check(
		/needs 7\.0\.2 first/.test(journal.note ?? ''),
		'RUN 1: the note names the precondition',
		journal.note,
	);
	equal(
		journal.backup?.waivedBy,
		e.permissions.SUPERUSER_ID,
		'RUN 1: the backup waiver is journaled with who waived it',
	);
	check(!maintenanceFlag(world), "RUN 1: maintenance restored to the operator's (off)");
	equal(await ontologyImports(e), [], 'RUN 1: no ontology file was imported');
	check(!(await tableExists(e, T.migrations)), 'RUN 1: no migration ran (no version table)');
	equal(await readDrillDataVersion(e), [7, 0, 0], 'RUN 1: data version unchanged');
	equal(sentinelStatus(world), null, 'RUN 1: no code sentinel (nothing swapped)');
	equal(await runLockHolders(e), 0, 'RUN 1: the UPDATE_RUN lock is released');
	assertHealth(
		readJson<Health>(healthFile(world, 'run1')),
		journal,
		{ on_target: false, result: 'ok' },
		'RUN 1',
	);
	say(`RUN 1 PASS — ontology-min refusal: ${journal.run_id} FAILED_PRE_SWAP ("${journal.note}")`);
}

/** RUN 2's kill leg: child A parks inside the rung's transaction and is SIGKILLed. */
async function killMidRung(c: Context, runId: string): Promise<void> {
	const { e, world } = c;
	let journal: RunJournal;
	// CHILD A — the new tree's boot; parks inside the data rung's transaction.
	const a = spawnChild(world, 'a', '7.1.0', true);
	const marker = join(world.markerDir, 'paused_in_data');
	await waitFor(
		async () =>
			existsSync(marker) ||
			(await Promise.race([a.child.exited.then(() => true), Bun.sleep(1).then(() => false)])),
		MARKER_WAIT_MS,
		'child A parks inside the data rung',
	);
	check(
		existsSync(marker),
		`RUN 2: child A reached the rung checkpoint — log ${a.log}`,
		existsSync(a.log) ? readFileSync(a.log, 'utf8').slice(-4000) : '',
	);
	journal = await onlyJournal(e, world, runId);
	equal(
		phaseLine(journal),
		[
			'7.1.0 ontology ok',
			'7.1.0 code ok',
			'7.0.2 ontology ok',
			'7.0.2 schema ok',
			'7.1.0 ontology ok',
			'7.1.0 schema ok',
			'7.1.0 data running',
		],
		'RUN 2 (child A, parked): every phase before the rung ok, the rung RUNNING',
	);
	equal(
		journal.phases[1]?.evidence,
		{ booted: '7.1.0' },
		'RUN 2: the code phase settled on the booted tree',
	);
	equal(journal.state, 'SCHEMA_APPLIED', 'RUN 2 (child A, parked): state');
	equal(
		await idsOf(e, T.rung),
		[],
		"RUN 2 (parked): the rung's INSERT is not visible outside its transaction",
	);
	equal(a.child.exitCode, null, 'RUN 2: child A is alive, parked inside the rung');
	equal(await runLockHolders(e), 1, 'RUN 2 (parked): child A holds the UPDATE_RUN lock');
	assertHealth(
		readJson<Health>(healthFile(world, 'a')),
		journal,
		{ on_target: true, result: 'ok' },
		'RUN 2 (child A, parked)',
	);

	// SIGKILL — PostgreSQL ends the session: the rung rolls back, the lock is freed.
	a.child.kill('SIGKILL');
	const killed = await a.child.exited;
	check(killed !== 0, 'RUN 2: child A died by the signal', killed);
	await waitFor(
		async () => (await runLockHolders(e)) === 0,
		LOCK_FREE_WAIT_MS,
		"PostgreSQL frees the dead session's UPDATE_RUN lock",
	);
	equal(
		await idsOf(e, T.rung),
		[],
		"RUN 2 (killed): the rung's statements rolled back with the session",
	);
	equal(await readDrillDataVersion(e), [7, 0, 0], 'RUN 2 (killed): data version not stamped');
	check(maintenanceFlag(world), 'RUN 2 (killed): maintenance still ON');
	journal = await onlyJournal(e, world, runId);
	equal(
		journal.phases.at(-1)?.outcome,
		'running',
		'RUN 2 (killed): the journal still holds the rung RUNNING',
	);
}

/** RUN 2: the walk across 7.0.2 to 7.1.0, the code restart, the kill mid-rung, the resume. */
async function legWalkKillResume(c: Context): Promise<RunJournal> {
	const { e, world } = c;
	plantOntologyExport(world, '7.0.2');
	const planned = planFor(c, '7.0.1', [7, 0, 0], '7.1.0');
	const effects = drillEffects(e, world, { booted: '7.0.1', starting: true, role: 'run2_start' });
	const started = await e.executor.startPlannedRun(planned, { ...effects, plans: c.plans });
	let journal = await onlyJournal(e, world, started.journal.run_id);
	equal(started.state, 'restarting', 'RUN 2: the code phase hands over to the next boot');
	equal(
		phaseLine(journal),
		['7.1.0 ontology ok', '7.1.0 code running'],
		'RUN 2: precondition ok, code phase left RUNNING across the restart',
	);
	equal(journal.state, 'ONTOLOGY_APPLIED', 'RUN 2: state before the restart');
	check(maintenanceFlag(world), 'RUN 2: maintenance ON across the restart');
	equal(sentinelStatus(world), 'pending', 'RUN 2: the swap left a pending sentinel');
	equal(await runLockHolders(e), 0, 'RUN 2: the dying process released the lock');
	assertHealth(
		readJson<Health>(healthFile(world, 'run2_start')),
		journal,
		{ on_target: false, result: 'ok' },
		'RUN 2 (old tree)',
	);

	// A second run while this one is in flight is refused, nothing written.
	const second = await e.executor
		.startPlannedRun(planned, { ...effects, plans: c.plans })
		.then(() => null)
		.catch((error: unknown) => error);
	check(
		second !== null &&
			(second as { coordinates?: { rule?: string } }).coordinates?.rule === 'run_in_flight',
		'RUN 2: a second run is refused (run_in_flight) while one is in flight',
		String(second),
	);
	equal(
		(await e.journal.readRunJournals(world.journalRoot)).length,
		2,
		'RUN 2: the refused second run wrote no journal',
	);

	// The master moved on: the new tree's ontology source offers 7.1.0.
	plantOntologyExport(world, '7.1.0');

	if (c.children) await killMidRung(c, journal.run_id);

	// CHILD B — the next boot resumes from the journal alone.
	const b = await nextBoot(c, 'b', '7.1.0');
	journal = await onlyJournal(e, world, journal.run_id);
	equal(
		[b.outcome, b.state, journal.state],
		['ended', 'CONFIRMED', 'CONFIRMED'],
		'RUN 2: child B drives the run to CONFIRMED',
	);
	equal(
		phaseLine(journal),
		[
			'7.1.0 ontology ok',
			'7.1.0 code ok',
			'7.0.2 ontology ok',
			'7.0.2 schema ok',
			'7.1.0 ontology ok',
			'7.1.0 schema ok',
			...(c.children ? ['7.1.0 data failed'] : []),
			'7.1.0 data ok',
		],
		c.children
			? 'RUN 2: the interrupted rung is closed failed and runs again'
			: 'RUN 2: every phase ok once',
	);
	if (c.children)
		equal(
			journal.phases[6]?.evidence,
			{ interrupted: true, rerun: true },
			'RUN 2: the interrupted phase says so',
		);
	check(
		journal.verify?.every((verdict) => verdict.ok) === true && journal.verify.length === 3,
		'RUN 2: every post-verify predicate ok',
		journal.verify,
	);
	equal(await idsOf(e, T.rung), ['rung 7.1.0'], 'RUN 2: the rung wrote its row exactly once');
	equal(await idsOf(e, T.s2), ['schema 7.1.0'], "RUN 2: the 7.1.0 migration's row");
	check(await tableExists(e, T.s1), "RUN 2: the 7.0.2 migration's table");
	const recorded = await recordedMigrations(e);
	equal(
		recorded.map((row) => [row.version, row.release]),
		[
			['0001_updfull_s1.sql', '7.0.2'],
			['0002_updfull_s2.sql', '7.1.0'],
		],
		'RUN 2: both files recorded with the release that shipped them',
	);
	check(
		recorded.every(
			(row) => row.sha256 === sha256(MIGRATIONS.find((m) => m.file === row.version)?.sql ?? ''),
		),
		'RUN 2: recorded hashes = the files',
		recorded,
	);
	equal(await readDrillDataVersion(e), [7, 1, 0], 'RUN 2: data version 7.1.0');
	equal(
		(await ontologyImports(e)).map((row) => `${row.tld}@${row.version}`),
		[
			`${DRILL_TLD}@7.0.2`,
			'matrix_dd@7.0.2',
			`${DRILL_TLD}@7.1.0`,
			'matrix_dd@7.1.0',
			`${DRILL_TLD}@7.1.0`,
			'matrix_dd@7.1.0',
		],
		'RUN 2: three ontology phases, each the shared TLD + matrix_dd from the source',
	);
	equal(sentinelStatus(world), 'confirmed', 'RUN 2: the sentinel is confirmed only after VERIFIED');
	check(!maintenanceFlag(world), "RUN 2: maintenance restored to the operator's (off)");
	equal(await runLockHolders(e), 0, 'RUN 2: lock released');
	assertHealth(b.health, journal, { on_target: true, result: 'ok' }, 'RUN 2 (child B)');

	// B2 (fixed 2026-10-30): each schema phase applies its OWN release's files —
	// 7.1.0's incompatible file runs in '7.1.0 schema', after the 7.1.0 ontology step.
	const applied = (index: number) =>
		(journal.phases[index]?.evidence as { applied?: string[] } | undefined)?.applied;
	equal(applied(3), ['0001_updfull_s1.sql'], "RUN 2: '7.0.2 schema' applied 7.0.2's file only");
	equal(applied(5), ['0002_updfull_s2.sql'], "RUN 2: '7.1.0 schema' applied 7.1.0's file");
	say(
		`RUN 2 PASS — walk 7.0.1 → 7.0.2 → 7.1.0, code restart${c.children ? ', SIGKILL mid-rung' : ''}, resume: ${journal.run_id} CONFIRMED`,
	);
	return journal;
}

/** RUN 3: the planted failing migration after the model moved → NEEDS_DB_RESTORE. */
async function legNeedsDbRestore(c: Context): Promise<void> {
	const { e, world } = c;
	const backupPath = join(world.scratch, 'db_backups', 'run3.custom.backup');
	mkdirSync(join(world.scratch, 'db_backups'), { recursive: true });
	writeFileSync(backupPath, 'drill stand-in: the run backup the restore report names\n');
	const taken = new Date().toISOString();
	const planned = planFor(c, '7.1.0', [7, 1, 0], '7.2.0');
	if (planned.ok) {
		equal(
			planned.plan.map((entry) => `${entry.release} ${entry.step.kind}`),
			['7.2.0 code', '7.2.0 schema', '7.2.0 data'],
			'RUN 3 plan',
		);
	}
	const effects = drillEffects(e, world, {
		booted: '7.1.0',
		starting: true,
		role: 'run3_start',
		backup: async () => ({ path: backupPath, taken, waivedBy: null }),
	});
	const started = await e.executor.startPlannedRun(planned, { ...effects, plans: c.plans });
	equal(started.state, 'restarting', 'RUN 3: the code phase hands over');
	equal(sentinelStatus(world), 'pending', 'RUN 3: a new pending sentinel');

	const result = await nextBoot(c, 'c', '7.2.0');
	const journal = await onlyJournal(e, world, started.journal.run_id);
	equal(
		[result.outcome, result.state, journal.state],
		['ended', 'NEEDS_DB_RESTORE', 'NEEDS_DB_RESTORE'],
		'RUN 3 ends NEEDS_DB_RESTORE',
	);
	equal(
		phaseLine(journal),
		['7.2.0 code ok', '7.2.0 schema failed'],
		'RUN 3: the schema phase failed; the data rung never ran',
	);
	equal(
		await idsOf(e, T.s3),
		['schema 7.2.0'],
		'RUN 3: the good 7.2.0 file committed (the model moved)',
	);
	check(
		!(await tableExists(e, T.s4)),
		'RUN 3: the planted file left nothing (its transaction rolled back)',
	);
	equal(
		(await recordedMigrations(e)).map((row) => row.version),
		['0001_updfull_s1.sql', '0002_updfull_s2.sql', '0003_updfull_s3.sql'],
		'RUN 3: the planted file is NOT recorded (the next attempt retries it)',
	);
	equal(await idsOf(e, T.rung), ['rung 7.1.0'], 'RUN 3: the 7.2.0 rung did not run');
	equal(await readDrillDataVersion(e), [7, 1, 0], 'RUN 3: data version not stamped');
	equal(
		journal.restore,
		{
			run_id: journal.run_id,
			crossedBy: '7.2.0 schema',
			backup: backupPath,
			lossWindowFrom: taken,
			previousRelease: '7.1.0',
			actions: journal.restore?.actions,
		},
		'RUN 3: the restore report names the crossing phase, the run backup, the loss window, the previous release',
	);
	equal(journal.restore?.actions.length, 4, 'RUN 3: the restore report lists the human actions');
	check(maintenanceFlag(world), 'RUN 3: maintenance stays ON (a human decides)');
	equal(
		sentinelStatus(world),
		'needs_restore',
		'RUN 3: the sentinel says needs_restore — no supervisor rolls back',
	);
	equal(await runLockHolders(e), 0, 'RUN 3: lock released');
	assertHealth(result.health, journal, { on_target: true, result: 'ok' }, 'RUN 3 (child C)');

	// D-2 after the stop (B3/B4, fixed 2026-10-30): a new run is refused until a
	// human closes the run with the report's own step 4 (`bun run update abort`).
	const probeOf = async (role: string) => {
		const probeEffects = drillEffects(e, world, {
			booted: '7.2.0',
			starting: true,
			role,
			preflight: async () => 'drill probe: stopped at preflight',
		});
		return e.executor
			.startPlannedRun(planFor(c, '7.1.0', [7, 1, 0], '7.2.0'), { ...probeEffects, plans: c.plans })
			.then((outcome) => outcome.journal.state)
			.catch((error: unknown) => `refused: ${String(error)}`);
	};
	const blocked = await probeOf('run3_probe');
	check(
		blocked.includes('restore_pending'),
		'RUN 3: a new run is refused until the restore is closed',
		blocked,
	);
	check(
		journal.restore?.actions.some((action) => action.includes('bun run update abort')) === true,
		'RUN 3: the report tells the human how to close the run',
		journal.restore?.actions,
	);
	const { runUpdateCli } = await import('./update.ts');
	const closed = await runUpdateCli(['abort', 'drill: restored', '--root', world.journalRoot]);
	check(
		closed.code === 0,
		'RUN 3: `bun run update abort` closes the NEEDS_DB_RESTORE run',
		closed.lines,
	);
	equal(await e.journal.unclosedRestore(world.journalRoot), null, 'RUN 3: no restore left open');
	const after = await probeOf('run3_probe_after');
	equal(after, 'REFUSED', 'RUN 3: after the close a new run reaches the preflight');
	say(
		`RUN 3 PASS — planted failing migration after the model moved: ${journal.run_id} NEEDS_DB_RESTORE (crossed by ${journal.restore?.crossedBy})`,
	);
}

export interface DrillResult {
	legs: string[];
	/** The known engine bugs that still reproduce (each one MUST, or the drill throws). */
	pinned: string[];
}

/**
 * The drill, on the database this process already points at (asserted to be
 * the suite's). Throws on the first failed assertion, AFTER the cleanup: the
 * scratch tables swept and their absence asserted, the scratch dir removed
 * (unless `keep`), the state-file repoint undone.
 */
export async function runUpdateFullDrill(options: {
	children: boolean;
	keep?: boolean;
}): Promise<DrillResult> {
	const scratch = scratchDir('update_full_drill', { realpath: true });
	const previousState = process.env.DEDALO_TS_STATE_PATH;
	// Maintenance mode lives in a scratch state file for this process and every child.
	process.env.DEDALO_TS_STATE_PATH = join(scratch, 'ts_state.json');
	const e = await engineForSuite();
	const reserved = await e.postgres.sql.reserve();
	const pinned: BugProbe[] = [];
	const legs: string[] = [];
	let failure: unknown = null;
	try {
		const [lock] = (await reserved.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS got', [
			DRILL_LOCK_KEY,
		])) as { got: boolean }[];
		check(lock?.got === true, 'no other update_full_drill holds the drill lock on this database');
		try {
			await sweepTables(e);
			await seedTables(e);
			const world = buildWorld(scratch);
			writeJson(join(scratch, 'world.json'), world);
			say(
				`database ${await currentDatabase(e)}, scratch ${scratch}, ${options.children ? 'child processes' : 'in-process boots (no kill leg)'}`,
			);
			const c: Context = {
				e,
				world,
				children: options.children,
				plans: {},
				targetData: {},
				pinned,
			};
			await legCatalog(c);
			legs.push('catalog');
			await legOntologyMinRefusal(c);
			legs.push('ontology_min_refusal');
			await legWalkKillResume(c);
			legs.push(
				options.children ? 'walk_code_kill_resume_confirmed' : 'walk_code_resume_confirmed',
			);
			await legNeedsDbRestore(c);
			legs.push('planted_failure_needs_db_restore');
			for (const bug of pinned) {
				const still = await bug.reproduces();
				say(
					`${still ? 'KNOWN ENGINE BUG' : 'PIN STALE'} ${bug.id} — ${bug.where}\n    ${bug.what}`,
				);
				check(
					still,
					`${bug.id} no longer reproduces: remove its pin (and any workaround it forced) in the change that fixed it`,
				);
			}
		} finally {
			await reserved
				.unsafe('SELECT pg_advisory_unlock($1::bigint)', [DRILL_LOCK_KEY])
				.catch(() => {});
		}
	} catch (error) {
		failure = error;
	} finally {
		reserved.release();
		await sweepTables(e).catch((error: unknown) => {
			failure ??= error;
		});
		const left = await residue(e).catch(() => ['<unreadable>']);
		if (left.length > 0) failure ??= new DrillFailure(`RESIDUE: ${left.join(', ')}`);
		if (options.keep === true) say(`--keep: scratch left at ${scratch}`);
		else removeScratchDir(scratch);
		if (previousState === undefined) delete process.env.DEDALO_TS_STATE_PATH;
		else process.env.DEDALO_TS_STATE_PATH = previousState;
	}
	if (failure !== null) throw failure;
	return { legs, pinned: pinned.map((bug) => bug.id) };
}

async function currentDatabase(e: Engine): Promise<string> {
	const [row] = await q<{ name: string }>(e, 'SELECT current_database() AS name');
	return row?.name ?? '?';
}

async function main(): Promise<void> {
	const deadline = setTimeout(() => {
		console.error(`[full-drill] TOTAL DEADLINE (${TOTAL_DEADLINE_MS} ms) exceeded`);
		process.exit(2);
	}, TOTAL_DEADLINE_MS);
	// Point THIS process (and every child, which inherits the environment) at
	// the suite database BEFORE any engine import.
	const { resolveSuiteDatabase } = await import('./client_test_server.ts');
	const { suiteDb } = resolveSuiteDatabase();
	process.env.DB_NAME = suiteDb;
	process.env.DEDALO_DATABASE_CONN = suiteDb;
	let code = 0;
	try {
		const result = await runUpdateFullDrill({
			children: true,
			keep: process.argv.includes('--keep'),
		});
		say(
			`PASS — legs: ${result.legs.join(', ')}; known engine bugs pinned: ${result.pinned.join(', ') || 'none'}`,
		);
	} catch (error) {
		code = 1;
		console.error(`[full-drill] FAIL — ${error instanceof Error ? error.message : String(error)}`);
		if (!(error instanceof DrillFailure)) console.error(error);
	}
	clearTimeout(deadline);
	const { closeDatabasePool } = await import('../src/core/db/postgres.ts');
	await closeDatabasePool();
	process.exit(code);
}

if (import.meta.main) {
	if (process.argv.includes('--child')) {
		childMain(process.argv).catch((error: unknown) => {
			console.error('[full-drill child] failed:', error);
			process.exit(1);
		});
	} else {
		main().catch((error: unknown) => {
			console.error('[full-drill] FAIL —', error);
			process.exit(1);
		});
	}
}
