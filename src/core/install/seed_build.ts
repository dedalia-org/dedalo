/**
 * The install SEED COMPILER — build_database_version.build_install_version and
 * `bun run seed:build`. Compiles the vendored install/db/dedalo_install.pgsql.gz
 * (paths.ts SEED_DUMP_PATH, restored by installDbFromSeed into every fresh
 * install) FROM REPO-OWNED SOURCES ONLY (seed_sources.ts). No installation's
 * database is read: Postgres is the compiler, never a source (decision
 * 2026-10-09 — a seed cloned out of a working database shipped that database's
 * 2022 data typo and broke every fresh install).
 *
 * THE STEPS — each database below is one this compiler CREATED and MARKED
 * (dedalo_seed_build_marker), dropped by the oid captured at CREATE:
 *   1. a cluster-wide advisory lock (one compile per cluster), held by a psql
 *      session for the whole run; marked orphans of earlier runs are swept;
 *   2. schema.sql, then every migration file, into `dedalo_seed_build_<pid>`,
 *      then the parser scaffold (seed_sources.ts SEED_SCAFFOLD_PATH);
 *   3. the COMPILE child (scripts/seed_build_child.ts — the engine, bound to
 *      the scratch database) applies the release ontology packages through the
 *      update door's own per-package body (the CORE TLDs only — seed_sources.ts
 *      SEED_ONTOLOGY_TLDS) and requires zero ontology drift. Its clock is pinned to the release
 *      date, so the same sources compile the same content anywhere;
 *   4. psql empties every table that does not ship (the search stores
 *      included — they fill at the install's first boot, in ITS locale), loads
 *      langs + registry, writes the canonical records + the data version; then
 *      CLUSTERs every table on its primary key and restarts idle sequences
 *      (a deterministic dump);
 *      the registry must be the CORE rows only (nonCoreRegistryRows),
 *      activatable (provisionBlocker) and inactive;
 *   5. pg_dump → `<out>.part`;
 *   6. VERIFIED BY A REAL INSTALL: the VERIFY child restores `.part` into a
 *      second marked database through installDbFromSeed (the whole fresh
 *      install: search stores, engine ontology, lg activation — no test fixture,
 *      no domain ontology: the seed promises the core), runs the boot
 *      migrations, and checks drift, lg and the root password;
 *   7. only then `.part` → seed, and the manifest (seed_manifest.ts) beside it.
 * Any failure leaves the last good seed untouched.
 *
 * One channel: this file reaches Postgres only through pg client child
 * processes on explicit descriptors (sql_confinement_tripwire psql channel).
 * Gates: seed_build_native (compile + contract + reproducibility),
 * install_seed_manifest_tripwire (committed seed ↔ manifest ↔ sources).
 */

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { isOnlineMigration } from '../../../install/db/online_migration.ts';
import { envSnapshot, privateFileValue, projectRoot } from '../../config/env.ts';
import { SEARCH_STORE_BACKFILLS } from '../db/db_assets.ts';
import definitions from '../db/db_pg_definitions.json';
import { DD_ONTOLOGY_TLDS_SQL } from '../db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import { DedaloError, isDedaloError } from '../errors/index.ts';
import { copySanityCheck, gunzipWithCaps } from '../ontology/data_io_import.ts';
import {
	provisionBlocker,
	REGISTRY_PROVISION_INPUTS_SQL,
	type RegistryRow,
} from '../ontology/hierarchy_state.ts';
import {
	normalizeOntologyDependencies,
	type OntologyDependency,
} from '../ontology/ontology_dependencies.ts';
import { gzipStreamToFile } from '../ontology/recovery_file.ts';
import { DEDALO_VERSION } from '../update/version.ts';
import { isCoreHierarchyTld } from './hierarchy_meta.ts';
import { SEED_DUMP_PATH, SEED_MANIFEST_PATH } from './paths.ts';
import { resolvePgBinary } from './pg_bin.ts';
import {
	connArgs,
	connFromConfig,
	type DbConnDescriptor,
	pgClientEnv,
	runPsql,
} from './pg_exec.ts';
import { buildSeedManifest, type SeedManifest, writeSeedManifest } from './seed_manifest.ts';
import {
	DD_ONTOLOGY_SCAFFOLD_COLUMNS,
	ONTOLOGY_RELEASE_DIR,
	SEED_BUILD_MARKER_TABLE,
	SEED_LANGS_PATH,
	SEED_MIGRATIONS_DIR,
	SEED_ONTOLOGY_TLDS,
	SEED_RECORDS,
	SEED_REGISTRY_PATH,
	SEED_SCAFFOLD_PATH,
	SEED_SCHEMA_PATH,
	SEED_SCRATCH_PREFIXES,
	SEED_SHIPPED_TABLES,
	SEED_VERIFY_ROOT_PASSWORD,
} from './seed_sources.ts';

/**
 * A compile that SUCCEEDED. A refused or failed compile THROWS
 * `maintenance.action_failed` (public disclosure: its sentence is the
 * operator's answer), carrying the same readout as extension keys —
 * `extend.steps` (what finished) and `extend.findings`.
 */
export interface SeedBuildResult {
	msg: string;
	/** Non-fatal findings (an unmarked look-alike scratch name left alone…). */
	findings: string[];
	/** One line per finished step, with its duration — the operator's readout. */
	steps: string[];
	file_size: string;
	manifest: SeedManifest;
}

/** The running readout of a compile (steps + findings), success or not. */
interface SeedReadout {
	findings: string[];
	steps: string[];
}

export interface SeedBuildOptions {
	/** The cluster to compile on (only host/port/user/password are used). Default: config.db. */
	conn?: DbConnDescriptor;
	/** Where the gzipped seed lands. Default: SEED_DUMP_PATH. */
	outFile?: string;
	/** Where its manifest lands. Default: SEED_MANIFEST_PATH for the vendored seed, else `<outFile>.manifest.json`. */
	manifestFile?: string;
}

/** The ontology release manifest entry for one TLD (ontology.json active_ontologies). */
export interface ReleaseOntology {
	tld: string;
	name_data?: unknown;
	typology_id?: number | string | null;
	/** hierarchy60 declaration (raw; normalized by releaseDependencies). Absent = not declared. */
	dependencies?: unknown;
}

/** One package staged (decompressed, sanity-checked) for the compile child. */
export interface StagedPackage {
	tld: string;
	sectionTipo: string;
	stagedPath: string;
	typologyId?: number | string | null;
	nameData?: unknown;
	/**
	 * The release entry's declared dependencies (normalized) — the import door
	 * (syncMainSectionFromDefinition) writes them as the core row's hierarchy60;
	 * null = the release declares nothing (no key written).
	 */
	dependencies: OntologyDependency[] | null;
}

/** What the compile child is told to do (JSON, through a file). */
export interface CompilePlan {
	task: 'compile';
	database: string;
	/** The installation's own DB_NAME (../private/.env) — the child refuses to bind to it. */
	installationDatabase: string | null;
	clock: string;
	packages: StagedPackage[];
	privateListsPath: string;
	driftTlds: string[];
}

/** What the verify child is told to do. */
export interface VerifyPlan {
	task: 'verify';
	database: string;
	installationDatabase: string | null;
	seedPath: string;
	rootPassword: string;
	driftTlds: string[];
}

/** The one line of JSON a child answers last on stdout. */
export interface ChildAnswer {
	ok: boolean;
	checks: string[];
	errors: string[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SAFE_PATH = /^[A-Za-z0-9_/.-]+$/;
const LOCK_KEY = 'dedalo_seed_build';
const CHILD_SCRIPT = join(projectRoot, 'scripts/seed_build_child.ts');

/** A refused / failed step: the operator's sentence, under the registered code. */
function fail(sentence: string): never {
	throw new DedaloError('maintenance.action_failed', { publicMessage: `Error. ${sentence}` });
}

/** The operator's sentence of a caught failure: ours verbatim; anything else is logged, not echoed. */
function failureSentence(error: unknown): string {
	if (isDedaloError(error) && error.publicMessage !== undefined) return error.publicMessage;
	console.error('seed_build: unexpected failure', error);
	return 'an unexpected failure (see the server log)';
}

/** Repo-relative inside the checkout, absolute elsewhere. */
function displayPath(path: string): string {
	const inRepo = relative(projectRoot, path);
	return inRepo.startsWith('..') ? path : inRepo;
}

/** psql that must succeed: its stdout, or a failure naming `what`. */
async function psqlOk(
	conn: DbConnDescriptor,
	database: string,
	args: string[],
	what: string,
	stdin?: string,
): Promise<string> {
	const run = await runPsql(conn, ['-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args], {
		database,
		...(stdin === undefined ? {} : { stdin }),
	});
	if (run.exitCode !== 0) fail(`${what}: ${run.stderr || `psql exit ${run.exitCode}`}`);
	return run.stdout;
}

/** `-tA` rows of a one-column query. */
async function psqlColumn(
	conn: DbConnDescriptor,
	database: string,
	query: string,
	what: string,
): Promise<string[]> {
	const out = await psqlOk(conn, database, ['-tA', '-c', query], what);
	return out === '' ? [] : out.split('\n');
}

/** `$seed$…$seed$::jsonb` — psql never interpolates inside a dollar-quoted literal. */
function jsonbLiteral(value: unknown): string {
	if (value === undefined) return 'NULL';
	const json = JSON.stringify(value);
	if (json.includes('$seed$')) fail('a seed value carries the $seed$ delimiter');
	return `$seed$${json}$seed$::jsonb`;
}

function safePath(path: string): string {
	if (!SAFE_PATH.test(path)) fail(`refusing a path psql would have to quote: ${path}`);
	return path;
}

// ---------------------------------------------------------------------------
// The lock and the scratch databases
// ---------------------------------------------------------------------------

/** Held until `release()`: a psql session owning the cluster-wide advisory lock. */
interface ClusterLock {
	/** The backend holding the lock — re-checked before the seed is replaced. */
	pid: string;
	release: () => Promise<void>;
}

/** One `\n`-terminated line from a stream (a chunk is not a line). */
async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let text = '';
	while (!text.includes('\n')) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	return text.split('\n')[0]?.trim() ?? '';
}

/** Refuse to replace the seed unless this run still holds the cluster lock. */
async function assertLockHeld(conn: DbConnDescriptor, lock: ClusterLock): Promise<void> {
	const held = await psqlColumn(
		conn,
		'postgres',
		`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = ${Number(lock.pid)}`,
		'check the seed compile lock',
	);
	if (held.length === 0) fail('the seed compile lock was lost during the run — nothing written');
}

async function acquireClusterLock(conn: DbConnDescriptor): Promise<ClusterLock> {
	const session = Bun.spawn(
		[
			resolvePgBinary('psql'),
			'--dbname=postgres',
			...connArgs(conn),
			'-X',
			'-w',
			'-q',
			'-tA',
			'-v',
			'ON_ERROR_STOP=1',
		],
		{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(conn) },
	);
	session.stdin.write(
		`SELECT pg_try_advisory_lock(hashtext('${LOCK_KEY}'));\nSELECT pg_backend_pid();\n`,
	);
	await session.stdin.flush();
	const reader = session.stdout.getReader();
	const answer = await readLine(reader);
	const pid = await readLine(reader);
	reader.releaseLock();
	const release = async () => {
		session.stdin.end();
		await session.exited;
	};
	if (answer !== 't') {
		await release();
		fail(
			answer === 'f'
				? 'another seed compile is running on this cluster (advisory lock held)'
				: `cannot take the seed compile lock: ${(await new Response(session.stderr).text()).trim()}`,
		);
	}
	return { pid, release };
}

async function isMarked(conn: DbConnDescriptor, database: string): Promise<boolean> {
	const rows = await psqlColumn(
		conn,
		database,
		`SELECT to_regclass('public.${SEED_BUILD_MARKER_TABLE}') IS NOT NULL`,
		`probe the marker of '${database}'`,
	);
	return rows[0] === 't';
}

/** A scratch database this run created: its name and the oid captured at CREATE. */
export interface Scratch {
	name: string;
	oid: string;
}

export async function createScratch(
	conn: DbConnDescriptor,
	name: string,
	purpose: string,
): Promise<Scratch> {
	if (!IDENTIFIER.test(name)) fail(`refusing scratch database name '${name}'`);
	await psqlOk(
		conn,
		'postgres',
		['-c', `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`],
		'create a scratch database (the database user needs CREATEDB)',
	);
	const [oid = ''] = await psqlColumn(
		conn,
		'postgres',
		`SELECT oid FROM pg_database WHERE datname = '${name}'`,
		'read the scratch oid',
	);
	await psqlOk(
		conn,
		name,
		[
			'-c',
			`CREATE TABLE ${SEED_BUILD_MARKER_TABLE} (purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO ${SEED_BUILD_MARKER_TABLE} (purpose) VALUES ('${purpose}')`,
		],
		'mark the scratch database',
	);
	return { name, oid };
}

/** Drop a database this run created — by the identity captured at CREATE, marker or not. */
export async function dropScratch(conn: DbConnDescriptor, scratch: Scratch): Promise<void> {
	const [oid] = await psqlColumn(
		conn,
		'postgres',
		`SELECT oid FROM pg_database WHERE datname = '${scratch.name}'`,
		'probe the scratch database',
	);
	if (oid === undefined) return;
	if (oid !== scratch.oid) {
		fail(`'${scratch.name}' is not the database this run created (oid ${oid} ≠ ${scratch.oid})`);
	}
	await psqlOk(
		conn,
		'postgres',
		['-c', `DROP DATABASE "${scratch.name}" WITH (FORCE)`],
		'drop the scratch database',
	);
}

/**
 * Under the lock, any `<prefix><digits>` database is an orphan of a run that
 * died — dropped when MARKED; an unmarked one is someone else's and only named.
 */
async function sweepOrphans(conn: DbConnDescriptor, findings: string[]): Promise<void> {
	const alternatives = SEED_SCRATCH_PREFIXES.join('|');
	const names = await psqlColumn(
		conn,
		'postgres',
		`SELECT datname FROM pg_database WHERE datname ~ '^(${alternatives})[0-9]+$'`,
		'list orphaned scratch databases',
	);
	for (const name of names.filter((candidate) => IDENTIFIER.test(candidate))) {
		if (await isMarked(conn, name)) {
			await psqlOk(
				conn,
				'postgres',
				['-c', `DROP DATABASE "${name}" WITH (FORCE)`],
				`drop orphan '${name}'`,
			);
		} else {
			findings.push(
				`left alone: database '${name}' has the scratch naming but no ${SEED_BUILD_MARKER_TABLE}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Sources → scratch
// ---------------------------------------------------------------------------

/** schema.sql, then every migration file. */
async function applySchema(conn: DbConnDescriptor, database: string): Promise<number> {
	await psqlOk(conn, database, ['-1', '-f', SEED_SCHEMA_PATH], 'apply install/db/seed/schema.sql');
	return applyMigrationFiles(conn, database);
}

/**
 * Every install/db/migrations file, in filename order — the boot runner's own
 * files: boot files one transaction each, online files (CREATE INDEX
 * CONCURRENTLY) without one. Idempotent by the migration law.
 */
export async function applyMigrationFiles(
	conn: DbConnDescriptor,
	database: string,
): Promise<number> {
	const files = readdirSync(SEED_MIGRATIONS_DIR)
		.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
		.sort();
	for (const file of files) {
		const path = join(SEED_MIGRATIONS_DIR, file);
		const online = isOnlineMigration(await readFile(path, 'utf8'));
		await psqlOk(
			conn,
			database,
			[...(online ? [] : ['-1']), '-f', path],
			`apply migration ${file}`,
		);
	}
	return files.length;
}

/** The ontology release the seed ships (ontology.json). */
export interface OntologyRelease {
	version: string;
	date: string;
	entries: ReleaseOntology[];
}

/** The release manifest (ontology.json) of the shipped ontology. */
export async function readOntologyRelease(): Promise<OntologyRelease> {
	const manifest = JSON.parse(
		await readFile(join(ONTOLOGY_RELEASE_DIR, 'ontology.json'), 'utf8'),
	) as {
		version?: string;
		date?: string;
		active_ontologies?: ReleaseOntology[];
	};
	if (typeof manifest.date !== 'string' || Number.isNaN(Date.parse(manifest.date))) {
		fail(`${displayPath(ONTOLOGY_RELEASE_DIR)}/ontology.json carries no valid release date`);
	}
	return {
		version: String(manifest.version ?? ''),
		date: manifest.date,
		entries: manifest.active_ontologies ?? [],
	};
}

/** Decompress + sanity-check one COPY source into the staging dir. */
async function stageCopy(
	source: string,
	stagingDir: string,
	name: string,
	columnCount: number = MATRIX_COPY_COLUMNS.length,
): Promise<string> {
	const staged = join(stagingDir, `${name}.copy`);
	await gunzipWithCaps(source, staged);
	const problem = copySanityCheck(staged, columnCount);
	if (problem !== null) fail(`${displayPath(source)}: ${problem}`);
	return safePath(staged);
}

/** The release entry of a TLD the seed ships — refused when the release lacks it. */
function releaseEntry(entries: readonly ReleaseOntology[], tld: string): ReleaseOntology {
	const entry = entries.find((candidate) => candidate.tld === tld);
	if (entry === undefined) fail(`the ontology release has no active_ontologies entry for '${tld}'`);
	return entry;
}

/**
 * A release entry's declared dependencies, normalized by THE shared normalizer
 * (ontology_dependencies.ts) — the seed is compiled through the import door, so
 * its core registry rows carry the release's hierarchy60 exactly as an ontology
 * update would write it (the installer's CLI plan reads the same declaration
 * from the vendored ontology.json, the wizard's install_hierarchies step from
 * those rows: one truth). The seed must be EXACT: any normalizer warning (a
 * malformed item, a non-list) refuses the compile instead of dropping it.
 */
export function releaseDependencies(entry: ReleaseOntology): OntologyDependency[] | null {
	const warnings: string[] = [];
	const dependencies = normalizeOntologyDependencies(entry.tld, entry.dependencies, warnings);
	if (warnings.length > 0) {
		fail(`the ontology release declares invalid dependencies: ${warnings.join('; ')}`);
	}
	return dependencies;
}

/** Every ontology package, staged with its release entry. */
async function stagePackages(
	stagingDir: string,
	entries: readonly ReleaseOntology[],
): Promise<StagedPackage[]> {
	const staged: StagedPackage[] = [];
	for (const tld of SEED_ONTOLOGY_TLDS) {
		const entry = releaseEntry(entries, tld);
		staged.push({
			tld,
			sectionTipo: `${tld}0`,
			stagedPath: await stageCopy(join(ONTOLOGY_RELEASE_DIR, `${tld}.copy.gz`), stagingDir, tld),
			typologyId: entry.typology_id ?? null,
			nameData: entry.name_data,
			dependencies: releaseDependencies(entry),
		});
	}
	return staged;
}

/**
 * The configuration a compile/verify child runs with — PINNED, never inherited.
 * Everything the engine stamps into the seed (record labels in the application
 * language, timestamps in the configured zone) reads config, so a child that
 * inherited the installation's ../private/.env compiled different bytes on a
 * machine with other settings (measured 2026-10-09: every ontology35 label came
 * out in the installation's application language). The private dir is an EMPTY
 * scratch dir, so no installation file — .env, state, sessions, media — is
 * readable or writable from the child.
 */
export const SEED_CHILD_CONFIG: Readonly<Record<string, string>> = Object.freeze({
	ENTITY: 'dedalo_seed_build',
	APPLICATION_LANG: 'lg-eng',
	DEDALO_APPLICATION_LANGS: '{"lg-eng":"English"}',
	DEDALO_APPLICATION_LANGS_DEFAULT: 'lg-eng',
	DEDALO_DATA_LANG_DEFAULT: 'lg-eng',
	PROJECTS_DEFAULT_LANGS: '["lg-eng"]',
	DEDALO_TIMEZONE: 'UTC',
	// The PROCESS clock zone too: some stamps read the host's local time, not
	// DEDALO_TIMEZONE (measured: the dd199 created-date component came out 16:08
	// on a Europe/Madrid desk and 14:08 in the UTC CI image — one seed, two contents).
	TZ: 'UTC',
});

/** The process-level variables a child needs to RUN (bun, psql) — nothing of Dédalo's. */
const CHILD_PROCESS_KEYS = ['PATH', 'HOME', 'TMPDIR'] as const;

/**
 * The child's whole environment: the process basics, the pinned configuration,
 * a scratch private dir + media root, and the scratch database on this cluster.
 * Pure (gated: nothing of the parent's Dédalo environment reaches it).
 */
export function childEnv(
	conn: DbConnDescriptor,
	database: string,
	scratchDir: string,
	inherited: Readonly<Record<string, string | undefined>> = envSnapshot(),
): Record<string, string> {
	return {
		...processBasics(inherited),
		...SEED_CHILD_CONFIG,
		DEDALO_PRIVATE_DIR: join(scratchDir, 'private'),
		MEDIA_PATH: join(scratchDir, 'media'),
		...databaseEnv(conn, database),
	};
}

/** The few process variables a child needs to start (CHILD_PROCESS_KEYS), when set. */
function processBasics(
	inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const basics: Record<string, string> = {};
	for (const key of CHILD_PROCESS_KEYS) {
		const value = inherited[key];
		if (value !== undefined) basics[key] = value;
	}
	return basics;
}

/** The scratch database on this cluster, as the engine's DB_* keys (+ PGPASSWORD for psql). */
function databaseEnv(conn: DbConnDescriptor, database: string): Record<string, string> {
	const env: Record<string, string> = {
		DB_NAME: database,
		DB_HOST: String(conn.host ?? ''),
		DB_PORT: String(conn.port ?? ''),
		DB_USER: String(conn.user ?? ''),
	};
	Object.assign(env, socketEnv(conn));
	if (conn.password !== '') {
		env.DB_PASSWORD = conn.password;
		env.PGPASSWORD = conn.password;
	}
	return env;
}

/**
 * The socket route the parent compiles over (pg_transport.ts: DB_SOCKET wins),
 * so the child's engine pool reaches the SAME server as the parent's psql.
 */
function socketEnv(conn: DbConnDescriptor): Record<string, string> {
	return conn.socket ? { DB_SOCKET: conn.socket } : {};
}

/** Run a child task against a scratch database; its last stdout line is the answer. */
async function runChild(
	conn: DbConnDescriptor,
	plan: CompilePlan | VerifyPlan,
	stagingDir: string,
): Promise<ChildAnswer> {
	const planPath = join(stagingDir, `${plan.task}.plan.json`);
	await writeFile(planPath, JSON.stringify(plan));
	const scratchDir = join(stagingDir, `${plan.task}_env`);
	mkdirSync(join(scratchDir, 'private'), { recursive: true });
	mkdirSync(join(scratchDir, 'media'), { recursive: true });
	const child = Bun.spawn([process.execPath, 'run', CHILD_SCRIPT, planPath], {
		cwd: projectRoot,
		stdout: 'pipe',
		stderr: 'pipe',
		env: childEnv(conn, plan.database, scratchDir),
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	try {
		const answer = JSON.parse(stdout.trim().split('\n').pop() ?? '') as ChildAnswer;
		if (exitCode !== 0) answer.ok = false;
		return answer;
	} catch {
		const tail = stderr.trim().split('\n').slice(-5).join(' | ');
		fail(`the ${plan.task} child died (exit ${exitCode}): ${tail}`);
	}
}

/** Tables of the scratch database (public; the compiler's own excluded). */
async function scratchTables(conn: DbConnDescriptor, database: string): Promise<string[]> {
	const tables = await psqlColumn(
		conn,
		database,
		`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
		'list the scratch tables',
	);
	return tables.filter((table) => !table.startsWith('dedalo_') && IDENTIFIER.test(table));
}

/**
 * The tables the data script keeps: what the compile child wrote, plus the
 * langs, loaded ONCE before the compile (compile(): the registry door resolves
 * STRUCTURE_LANG's lg1 record from them). Loaded once, never reloaded: the
 * langs id sequence is not OWNED by its column, so a TRUNCATE … RESTART
 * IDENTITY would not reset it and a reload would ship shifted ids.
 */
const CHILD_WRITTEN: ReadonlySet<string> = new Set([
	'dd_ontology',
	'matrix_ontology',
	'matrix_ontology_main',
	'matrix_dd',
	'matrix_langs',
]);

/**
 * The derived search stores ship EMPTY. Their rows fold text with lower() in
 * the DATABASE'S locale, and a store built in the compiling cluster's locale is
 * wrong on an install with another one (measured 2026-10-09: 971 Greek/Cyrillic
 * rows not folded under a C-locale compile, never matching on en_US.UTF-8). An
 * empty store with source rows present is exactly what the boot self-heal
 * (db_assets.ts ensureSearchStores) refills, in the install's own locale — and
 * the verify step proves it does.
 */
export const SEED_EMPTY_STORES: readonly string[] = Object.freeze(
	SEARCH_STORE_BACKFILLS.map(({ store }) => store),
);

/** Tables with no primary key: they must ship empty (nothing to order). */
const KEYLESS_TABLES: ReadonlySet<string> = new Set([
	...SEED_EMPTY_STORES,
	'matrix_counter',
	'matrix_counter_dd',
]);

/**
 * The data version row, built SERVER-SIDE (jsonb_build_object) from two
 * literals validated to carry no quote: the release date and DEDALO_VERSION.
 */
function dataVersionInsert(releaseDate: string): string {
	// The engine's own 'YYYY-MM-DD HH:MM:SS' (update/engine.ts), in UTC — the
	// child's pinned zone.
	const stamp = new Date(releaseDate).toISOString().slice(0, 19).replace('T', ' ');
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp))
		fail(`refusing release date '${releaseDate}'`);
	if (!/^\d+\.\d+\.\d+$/.test(DEDALO_VERSION)) fail(`refusing engine version '${DEDALO_VERSION}'`);
	return `INSERT INTO matrix_updates (data) VALUES (jsonb_build_object('update_date', '${stamp}', 'dedalo_version', '${DEDALO_VERSION}'));`;
}

/** The canonical records + the data version row. */
function recordInserts(releaseDate: string): string[] {
	return [
		...SEED_RECORDS.map(
			(record) =>
				`INSERT INTO "${record.table}" (section_id, section_tipo, data, relation, string, date, meta) VALUES (${record.section_id}, '${record.section_tipo}', ${jsonbLiteral(record.data)}, ${jsonbLiteral(record.relation)}, ${jsonbLiteral(record.string)}, ${jsonbLiteral(record.date)}, ${jsonbLiteral(record.meta)});`,
		),
		dataVersionInsert(releaseDate),
	];
}

/**
 * The ONE-transaction data script (step 4). Pure: gated on its text. Empties
 * every table the compile child did not write (RESTART IDENTITY: an install
 * starts its own ids at 1 — and the child's writes left time-machine rows and
 * counters behind), then loads what ships.
 */
export function seedDataSql(input: {
	tables: readonly string[];
	registryPath: string;
	releaseDate: string;
}): string {
	const columns = MATRIX_COPY_COLUMNS.join(', ');
	const emptied = input.tables.filter((table) => !CHILD_WRITTEN.has(table));
	const lines = [
		...(emptied.length === 0
			? []
			: [`TRUNCATE ${emptied.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY;`]),
		`\\copy matrix_hierarchy_main (${columns}) FROM '${safePath(input.registryPath)}'`,
		...recordInserts(input.releaseDate),
	];
	return `${lines.join('\n')}\n`;
}

/**
 * The finishing script (step 4b). Pure. Two things a fresh install must not
 * inherit from HOW the seed was compiled:
 *  - ROW ORDER: pg_dump writes heap order, and the compile's DELETE + COPY passes
 *    leave it to chance (measured: two compiles dumped the same rows in another
 *    order). Every keyed table is CLUSTERed on its primary key, the CLUSTER
 *    marker removed again (the shipped schema stays the schema). A table with no
 *    key is refused unless it is declared key-less (it ships empty).
 *  - SEQUENCES: a sequence serving only EMPTY tables restarts at 1 — TRUNCATE …
 *    RESTART IDENTITY reaches only OWNED sequences (measured: the activity
 *    sequences shipped at 8 after the child's own writes).
 * The migrations' NOT VALID constraints stay NOT VALID: the seed's schema is
 * exactly schema.sql + the migrations, which is what the boot self-heals
 * reproduce (tm_role_self_heal_native compares them).
 */
export function seedFinishSql(input: {
	tables: readonly string[];
	primaryKeys: Readonly<Record<string, string>>;
	idleSequences: readonly string[];
}): string {
	// The stores LAST-emptied: their sync triggers re-fill them on every row the
	// data script loads (measured: 130 889 relation-index rows after an early TRUNCATE).
	const lines = [
		...SEED_EMPTY_STORES.filter((store) => input.tables.includes(store)).map(
			(store) => `TRUNCATE "${store}";`,
		),
		...clusterStatements(input.tables, input.primaryKeys),
		...sequenceRestarts(input.idleSequences),
	];
	return `${lines.join('\n')}\n`;
}

/** CLUSTER every keyed table on its key, the marker removed; an unkeyed one must be declared key-less. */
function clusterStatements(
	tables: readonly string[],
	primaryKeys: Readonly<Record<string, string>>,
): string[] {
	const lines: string[] = [];
	for (const table of tables) {
		const key = primaryKeys[table];
		if (key === undefined) {
			if (!KEYLESS_TABLES.has(table))
				fail(`table '${table}' has no primary key to order the dump by`);
			continue;
		}
		if (!IDENTIFIER.test(key)) fail(`refusing primary key name '${key}'`);
		lines.push(`CLUSTER "${table}" USING "${key}";`, `ALTER TABLE "${table}" SET WITHOUT CLUSTER;`);
	}
	return lines;
}

function sequenceRestarts(sequences: readonly string[]): string[] {
	return sequences.map((sequence) => {
		if (!IDENTIFIER.test(sequence)) fail(`refusing sequence name '${sequence}'`);
		return `ALTER SEQUENCE "${sequence}" RESTART WITH 1;`;
	});
}

/**
 * Sequences no NON-EMPTY table uses (owner or column default) — the ones a
 * fresh install must find at 1. Run after ANALYZE (reltuples).
 */
const IDLE_SEQUENCES_SQL = `SELECT s.relname FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
	WHERE n.nspname = 'public' AND s.relkind = 'S' AND NOT EXISTS (
		SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = (
			CASE WHEN d.classid = 'pg_attrdef'::regclass THEN (SELECT ad.adrelid FROM pg_attrdef ad WHERE ad.oid = d.objid)
			     ELSE d.refobjid END)
		WHERE ((d.classid = 'pg_attrdef'::regclass AND d.refobjid = s.oid)
		    OR (d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype IN ('a','i')))
		  AND t.relkind = 'r' AND t.reltuples > 0
	) ORDER BY 1`;

/** table → its primary-key constraint (public schema). */
async function primaryKeys(
	conn: DbConnDescriptor,
	database: string,
): Promise<Record<string, string>> {
	const rows = await psqlColumn(
		conn,
		database,
		`SELECT c.conrelid::regclass::text || ':' || c.conname FROM pg_constraint c
		 JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.contype = 'p'`,
		'list primary keys',
	);
	return Object.fromEntries(rows.map((row) => row.split(':') as [string, string]));
}

// ---------------------------------------------------------------------------
// What the seed must be before it is dumped
// ---------------------------------------------------------------------------

/** One shipped registry record as REGISTRY_PROVISION_INPUTS_SQL answers it. */
export interface RegistryProvisionInput extends RegistryRow {
	section_id: number;
	source_model: string | null;
}

/**
 * The shipped registry records activation would REFUSE, one line each — the
 * rule ensureHierarchy applies (provisionBlocker). Pure.
 */
export function registryBlockers(inputs: readonly RegistryProvisionInput[]): string[] {
	const lines: string[] = [];
	for (const input of inputs) {
		const blocker = provisionBlocker(input, input.source_model);
		if (blocker === null) continue;
		const tld = String(input.string?.hierarchy6?.[0]?.value ?? '?');
		lines.push(`hierarchy1/${input.section_id} (${tld}): ${blocker}`);
	}
	return lines;
}

/**
 * The shipped registry records that are NOT a core hierarchy, one line each.
 * Pure. The seed ships the CORE registry rows only (hierarchy_meta.ts
 * CORE_HIERARCHIES — `lg`, whose terms are the seed's own matrix_langs): an
 * optional thesaurus's row is written at ACTIVATION from its
 * install/import/hierarchy/hierarchy.json entry
 * (WC-2026-10-10-hierarchy-json-manifest), so a second, frozen copy here would
 * be the metadata the manifest replaced — and the seed promises the core.
 */
export function nonCoreRegistryRows(inputs: readonly RegistryProvisionInput[]): string[] {
	const lines: string[] = [];
	for (const input of inputs) {
		const tld = String(input.string?.hierarchy6?.[0]?.value ?? '');
		if (isCoreHierarchyTld(tld)) continue;
		lines.push(`hierarchy1/${input.section_id} (${tld === '' ? '?' : tld})`);
	}
	return lines;
}

/** Records whose active (hierarchy4) or active-in-thesaurus (hierarchy125) flag is not NO (dd64/2, int or legacy string). */
export const ACTIVE_REGISTRY_SQL = `SELECT lower(string->'hierarchy6'->0->>'value') FROM matrix_hierarchy_main
	WHERE NOT (COALESCE(relation->'hierarchy4', '[]'::jsonb) @> '[{"section_id":2,"section_tipo":"dd64"}]'
	        OR COALESCE(relation->'hierarchy4', '[]'::jsonb) @> '[{"section_id":"2","section_tipo":"dd64"}]')
	   OR NOT (COALESCE(relation->'hierarchy125', '[]'::jsonb) @> '[{"section_id":2,"section_tipo":"dd64"}]'
	        OR COALESCE(relation->'hierarchy125', '[]'::jsonb) @> '[{"section_id":"2","section_tipo":"dd64"}]')`;

/** Extensions the seed may carry: the declared set (db_pg_definitions) + plpgsql. */
function allowedExtensions(): Set<string> {
	const names = definitions.ar_extensions.map(
		(statement) => statement.match(/EXISTS\s+([a-z_]+)/i)?.[1] ?? '',
	);
	return new Set(['plpgsql', ...names.filter((name) => name !== '')]);
}

/** Refuse a non-core registry row, a registry an install could not activate, an active hierarchy, or a foreign extension. */
async function assertShippable(conn: DbConnDescriptor, database: string): Promise<number> {
	const [json = '[]'] = await psqlColumn(
		conn,
		database,
		REGISTRY_PROVISION_INPUTS_SQL,
		'read the hierarchy registry',
	);
	const inputs = JSON.parse(json) as RegistryProvisionInput[];
	const foreign = nonCoreRegistryRows(inputs);
	if (foreign.length > 0) {
		fail(
			`${displayPath(SEED_REGISTRY_PATH)} must hold the CORE hierarchy registry rows only (optional thesauri are activated from hierarchy.json); not core: ${foreign.slice(0, 20).join('; ')}`,
		);
	}
	const blocked = registryBlockers(inputs);
	if (blocked.length > 0) {
		fail(
			`${blocked.length} hierarchy registry record(s) in ${displayPath(SEED_REGISTRY_PATH)} cannot be activated — a fresh install would fail: ${blocked.slice(0, 20).join('; ')}`,
		);
	}
	const active = await psqlColumn(conn, database, ACTIVE_REGISTRY_SQL, 'list active hierarchies');
	if (active.length > 0)
		fail(`the registry must ship every hierarchy inactive; active: ${active.join(', ')}`);
	await assertNoForeignContent(conn, database);
	return inputs.length;
}

/** Refuse an ontology row of a TLD the seed does not ship (a stale scaffold row) or a foreign extension. */
async function assertNoForeignContent(conn: DbConnDescriptor, database: string): Promise<void> {
	const tlds = await psqlColumn(conn, database, DD_ONTOLOGY_TLDS_SQL, 'list ontology tlds');
	const foreign = tlds.filter((tld) => !SEED_ONTOLOGY_TLDS.includes(tld));
	if (foreign.length > 0)
		fail(`dd_ontology carries TLD(s) the seed does not ship: ${foreign.join(', ')}`);
	const extensions = await psqlColumn(
		conn,
		database,
		'SELECT extname FROM pg_extension',
		'list extensions',
	);
	const allowed = allowedExtensions();
	const extra = extensions.filter((name) => !allowed.has(name));
	if (extra.length > 0) fail(`extension(s) the seed must not ship: ${extra.join(', ')}`);
}

/** VACUUM, then pg_dump → gzip → `.part` (the compiler's own tables excluded). */
async function dumpTo(conn: DbConnDescriptor, database: string, partFile: string): Promise<void> {
	await psqlOk(conn, database, ['-c', 'VACUUM ANALYZE'], 'vacuum the scratch database');
	mkdirSync(dirname(partFile), { recursive: true });
	const dump = Bun.spawn(
		[
			resolvePgBinary('pg_dump'),
			`--dbname=${database}`,
			...connArgs(conn),
			'--no-owner',
			'--no-privileges',
			'--exclude-table=public.dedalo_*',
		],
		{ stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(conn) },
	);
	const [, exitCode, stderr] = await Promise.all([
		gzipStreamToFile(dump.stdout, partFile),
		dump.exited,
		new Response(dump.stderr).text(),
	]);
	if (exitCode !== 0) fail(`pg_dump of '${database}' failed: ${stderr.trim()}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface SeedBuild {
	conn: DbConnDescriptor;
	outFile: string;
	manifestFile: string;
	partFile: string;
	stagingDir: string;
	readout: SeedReadout;
	step: (line: string) => void;
	scratches: Scratch[];
}

function stepClock(readout: SeedReadout): (line: string) => void {
	let started = performance.now();
	return (line) => {
		const now = performance.now();
		readout.steps.push(`${line} (${((now - started) / 1000).toFixed(1)}s)`);
		started = now;
	};
}

/** Step 3: the release ontology into the scratch database, through the compile child. */
async function compileOntology(
	build: SeedBuild,
	database: string,
	release: OntologyRelease,
): Promise<void> {
	const plan: CompilePlan = {
		task: 'compile',
		database,
		installationDatabase: privateFileValue('DB_NAME') ?? null,
		clock: release.date,
		packages: await stagePackages(build.stagingDir, release.entries),
		privateListsPath: await stageCopy(
			join(ONTOLOGY_RELEASE_DIR, 'matrix_dd.copy.gz'),
			build.stagingDir,
			'matrix_dd',
		),
		driftTlds: [...SEED_ONTOLOGY_TLDS],
	};
	const compiled = await runChild(build.conn, plan, build.stagingDir);
	if (!compiled.ok) fail(`compiling the ontology release failed: ${compiled.errors.join('; ')}`);
	build.step(
		`ontology release ${release.version} (${release.date}) applied: ${SEED_ONTOLOGY_TLDS.join(', ')}`,
	);
}

/** Steps 2–5: sources → compiled scratch database → `.part`. */
async function compile(build: SeedBuild, release: OntologyRelease): Promise<void> {
	const scratch = await createScratch(build.conn, `dedalo_seed_build_${process.pid}`, 'compile');
	build.scratches.push(scratch);
	const migrations = await applySchema(build.conn, scratch.name);
	build.step(`schema.sql + ${migrations} migrations into '${scratch.name}'`);
	const scaffold = await stageCopy(
		SEED_SCAFFOLD_PATH,
		build.stagingDir,
		'dd_ontology_scaffold',
		DD_ONTOLOGY_SCAFFOLD_COLUMNS.length,
	);
	await psqlOk(
		build.conn,
		scratch.name,
		['-c', `\\copy dd_ontology (${DD_ONTOLOGY_SCAFFOLD_COLUMNS.join(', ')}) FROM '${scaffold}'`],
		'load the dd_ontology scaffold',
	);
	// The langs BEFORE the compile: the registry door files every ontology35 row
	// under STRUCTURE_LANG's lg1 record, RESOLVED from matrix_langs (no
	// hard-coded id — ontology_write.ts resolveRegistryLangId), so an empty
	// langs table would refuse the first package. Loaded once: the data script
	// keeps them (CHILD_WRITTEN).
	const langsPath = await stageCopy(SEED_LANGS_PATH, build.stagingDir, 'matrix_langs');
	await psqlOk(
		build.conn,
		scratch.name,
		['-c', `\\copy matrix_langs (${MATRIX_COPY_COLUMNS.join(', ')}) FROM '${safePath(langsPath)}'`],
		'load the langs the registry rows are filed under',
	);
	await compileOntology(build, scratch.name, release);
	const sql = seedDataSql({
		tables: await scratchTables(build.conn, scratch.name),
		registryPath: await stageCopy(SEED_REGISTRY_PATH, build.stagingDir, 'matrix_hierarchy_main'),
		releaseDate: release.date,
	});
	await psqlOk(build.conn, scratch.name, ['-1', '-f', '-'], 'load the seed data', sql);
	await psqlOk(build.conn, scratch.name, ['-c', 'ANALYZE'], 'analyze the scratch database');
	await psqlOk(
		build.conn,
		scratch.name,
		['-1', '-f', '-'],
		'order the tables, reset idle sequences',
		seedFinishSql({
			tables: await scratchTables(build.conn, scratch.name),
			primaryKeys: await primaryKeys(build.conn, scratch.name),
			idleSequences: await psqlColumn(
				build.conn,
				scratch.name,
				IDLE_SEQUENCES_SQL,
				'list idle sequences',
			),
		}),
	);
	const registry = await assertShippable(build.conn, scratch.name);
	build.step(
		`data loaded (${registry} hierarchy registry records, ${SEED_RECORDS.length} canonical records, ${Object.keys(SEED_SHIPPED_TABLES).length} shipped tables)`,
	);
	await dumpTo(build.conn, scratch.name, build.partFile);
	build.step('dumped');
}

/** Step 6: the `.part` proves itself by a real fresh install. */
async function verifyByInstall(build: SeedBuild): Promise<string[]> {
	const scratch = await createScratch(build.conn, `dedalo_seed_verify_${process.pid}`, 'verify');
	build.scratches.push(scratch);
	const verified = await runChild(
		build.conn,
		{
			task: 'verify',
			database: scratch.name,
			installationDatabase: privateFileValue('DB_NAME') ?? null,
			seedPath: build.partFile,
			rootPassword: SEED_VERIFY_ROOT_PASSWORD,
			driftTlds: [...SEED_ONTOLOGY_TLDS],
		},
		build.stagingDir,
	);
	if (!verified.ok) fail(`the compiled seed did not install: ${verified.errors.join('; ')}`);
	build.step(`verified by a fresh install (${verified.checks.length} checks)`);
	return verified.checks;
}

/** Teardown that must run whatever happened. */
async function finishBuild(build: SeedBuild): Promise<void> {
	rmSync(build.partFile, { force: true });
	rmSync(build.stagingDir, { recursive: true, force: true });
	for (const scratch of build.scratches) {
		try {
			await dropScratch(build.conn, scratch);
		} catch (error) {
			build.readout.findings.push(`scratch database not dropped: ${failureSentence(error)}`);
		}
	}
}

/** Step 7: the manifest is built from `.part` FIRST, then `.part` → seed, then the manifest. */
async function landSeed(
	build: SeedBuild,
	release: OntologyRelease,
	checks: string[],
): Promise<SeedManifest> {
	const manifest = await buildSeedManifest({
		seedPath: build.partFile,
		seedFile: build.outFile,
		ontologyRelease: { version: release.version, date: release.date },
		verifiedChecks: checks,
	});
	renameSync(build.partFile, build.outFile);
	await writeSeedManifest(manifest, build.manifestFile);
	build.step(`wrote ${displayPath(build.outFile)} + ${displayPath(build.manifestFile)}`);
	return manifest;
}

function successMessage(build: SeedBuild): string {
	if (build.readout.findings.length > 0) return 'Warning: install seed compiled with findings';
	return `OK. Install seed compiled from the repository sources, verified by a fresh install, written to '${displayPath(build.outFile)}'`;
}

/** A failure, re-thrown with the readout the operator needs to see what ran. */
function withReadout(error: unknown, readout: SeedReadout): DedaloError {
	return new DedaloError('maintenance.action_failed', {
		publicMessage: failureSentence(error),
		extend: { steps: readout.steps, findings: readout.findings },
		cause: error,
	});
}

/**
 * Compile the install seed from the repo sources (PHP installer::
 * build_install_version, rebuilt as a compiler). With no options it writes the
 * vendored seed + manifest of this checkout.
 */
export async function buildInstallVersion(
	options: SeedBuildOptions = {},
): Promise<SeedBuildResult> {
	const readout: SeedReadout = { findings: [], steps: [] };
	const outFile = options.outFile ?? SEED_DUMP_PATH;
	const build: SeedBuild = {
		conn: options.conn ?? connFromConfig(),
		outFile,
		manifestFile:
			options.manifestFile ??
			(outFile === SEED_DUMP_PATH ? SEED_MANIFEST_PATH : `${outFile}.manifest.json`),
		partFile: `${outFile}.part`,
		stagingDir: mkdtempSync(join(tmpdir(), 'dedalo_seed_build_')),
		readout,
		step: stepClock(readout),
		scratches: [],
	};
	let lock: ClusterLock | null = null;
	try {
		safePath(build.partFile);
		lock = await acquireClusterLock(build.conn);
		await sweepOrphans(build.conn, readout.findings);
		const release = await readOntologyRelease();
		await compile(build, release);
		const checks = await verifyByInstall(build);
		await assertLockHeld(build.conn, lock);
		const manifest = await landSeed(build, release, checks);
		return {
			msg: successMessage(build),
			findings: readout.findings,
			steps: readout.steps,
			file_size: `${statSync(outFile).size} Bytes`,
			manifest,
		};
	} catch (error) {
		throw withReadout(error, readout);
	} finally {
		await finishBuild(build);
		await lock?.release();
	}
}
