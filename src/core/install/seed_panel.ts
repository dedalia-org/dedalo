/**
 * The install-seed build as the maintenance panel offers it (build_database_version widget):
 * WHERE the ontology release comes from, WHETHER this machine can build, WHERE the result goes,
 * and the build itself. The compiler is `seed_build.ts`; this module only chooses its inputs.
 *
 * Release sources:
 *   - `shipped`         the release vendored with this code (install/import/ontology/<major.minor>);
 *   - `local_export`    this server's own export dir — only on an ontology master, only when it is
 *                       not the shipped dir itself;
 *   - `master:<name>`   pulled from an ONTOLOGY_SERVERS entry (ontology_release_pull.ts).
 *
 * Output targets:
 *   - `private`   `<private>/seed_builds/<stamp>/` — the seed, its manifest, `build.json` (where it
 *                 came from) and, for a non-shipped source, the release it was compiled from under
 *                 `ontology/`. Only the newest successful build is kept (one release is ~80 MB).
 *   - `checkout`  this checkout's vendored seed + release dir (the developer's commit flow) — only
 *                 when the code tree is a writable git checkout.
 */

import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statfsSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { config } from '../../config/config.ts';
import { privateDir, projectRoot } from '../../config/env.ts';
import { toDedaloError } from '../errors/convert.ts';
import { DedaloError } from '../errors/index.ts';
import { logError } from '../errors/log.ts';
import { getOntologyIoPath } from '../ontology/data_io_import.ts';
import { fetchOntologyManifest } from '../ontology/ontology_manifest.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import { ontologyCompatibility } from '../update/version_contract.ts';
import {
	copyLocalRelease,
	pullOntologyRelease,
	type ReleasePullResult,
} from './ontology_release_pull.ts';
import { SEED_DUMP_PATH, SEED_MANIFEST_PATH } from './paths.ts';
import { probePgDump, probePsql } from './pg_bin.ts';
import { connFromConfig, type DbConnDescriptor, runPsqlScript } from './pg_exec.ts';
import {
	buildInstallVersion,
	SEED_BUILD_LOCK_KEY,
	type SeedBuildOptions,
	type SeedBuildResult,
} from './seed_build.ts';
import { manifestFindings, observeCommittedSeed, type SeedManifest } from './seed_manifest.ts';
import { ONTOLOGY_RELEASE_DIR } from './seed_sources.ts';

export type SeedSource =
	| { kind: 'shipped' }
	| { kind: 'local_export' }
	| { kind: 'master'; name: string };
export type SeedTarget = 'private' | 'checkout';

export const SEED_BUILDS_DIR: string = join(privateDir, 'seed_builds');
const SEED_FILE = 'dedalo_install.pgsql.gz';
// shortcut: a fixed floor for the staging + output disk; a measured per-release need when one bites.
const MIN_FREE_BYTES = 1024 ** 3;

function refuse(sentence: string): never {
	throw new DedaloError('maintenance.action_failed', { publicMessage: `Error. ${sentence}` });
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** `shipped` | `local_export` | `master:<name>` → a source; anything else refuses. */
export function parseSeedSource(raw: unknown): SeedSource {
	if (raw === undefined || raw === 'shipped') return { kind: 'shipped' };
	if (raw === 'local_export') return { kind: 'local_export' };
	const name = masterName(raw);
	if (name !== null) return { kind: 'master', name };
	return refuse(`unknown ontology source '${String(raw)}'`);
}

/** `master:<name>` → `<name>` (non-empty), else null. */
function masterName(raw: unknown): string | null {
	const prefix = 'master:';
	if (typeof raw !== 'string' || !raw.startsWith(prefix)) return null;
	return raw.length > prefix.length ? raw.slice(prefix.length) : null;
}

export function seedSourceId(source: SeedSource): string {
	return source.kind === 'master' ? `master:${source.name}` : source.kind;
}

export function parseSeedTarget(raw: unknown): SeedTarget {
	if (raw === undefined || raw === 'private') return 'private';
	if (raw === 'checkout') return 'checkout';
	return refuse(`unknown output '${String(raw)}'`);
}

/** What an `ontology.json` says about its release (null when the dir holds none). */
export interface ReleaseSummary {
	version: string | null;
	/** The export date. */
	date: string | null;
	/** The server that exported it. */
	host: string | null;
	entity: string | null;
	/** `<tld>.copy.gz` packages in the dir. */
	packages: number;
	/** Every package listed with a sha256 (`files_sha256`). */
	digests: boolean;
}

export async function summarizeRelease(dir: string): Promise<ReleaseSummary | null> {
	let info: Record<string, unknown>;
	try {
		info = JSON.parse(await readFile(join(dir, 'ontology.json'), 'utf8')) as Record<
			string,
			unknown
		>;
	} catch {
		return null;
	}
	const packages = readdirSync(dir).filter((name) => name.endsWith('.copy.gz'));
	const digests = (info.files_sha256 ?? {}) as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
	return {
		version: text(info.version),
		date: text(info.date),
		host: text(info.host),
		entity: text(info.entity_label) ?? text(info.entity),
		packages: packages.length,
		digests: packages.length > 0 && packages.every((name) => typeof digests[name] === 'string'),
	};
}

/** This server's export dir, when it is an ontology master with one that is not the shipped dir. */
export function localExportDir(): string | null {
	if (config.ontologyIo.isOntologyServer !== true) return null;
	const dir = getOntologyIoPath(config.ops.ontologyDataIoDir, DEDALO_DATA_VERSION);
	if (dir === false || dir === ONTOLOGY_RELEASE_DIR) return null;
	return existsSync(join(dir, 'ontology.json')) ? dir : null;
}

export interface SeedSourceOption {
	id: string;
	kind: SeedSource['kind'];
	/** Where it is: a path, or a master's origin (never its access code). */
	location: string;
	/** What is there now (local sources only; a master is asked at preflight). */
	release: ReleaseSummary | null;
}

/** Every source this server can offer, the recommended one first. */
export async function seedSourceOptions(): Promise<SeedSourceOption[]> {
	const options: SeedSourceOption[] = [];
	const exportDir = localExportDir();
	if (exportDir !== null) {
		options.push({
			id: 'local_export',
			kind: 'local_export',
			location: shown(exportDir),
			release: await summarizeRelease(exportDir),
		});
	}
	for (const server of config.ontologyIo.servers) {
		options.push({
			id: `master:${server.name}`,
			kind: 'master',
			location: originOf(server.url),
			release: null,
		});
	}
	options.push({
		id: 'shipped',
		kind: 'shipped',
		location: shown(ONTOLOGY_RELEASE_DIR),
		release: await summarizeRelease(ONTOLOGY_RELEASE_DIR),
	});
	return options;
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '(invalid url)';
	}
}

/** Repo-relative inside the checkout, absolute elsewhere. */
function shown(path: string): string {
	const rel = relative(projectRoot, path);
	return rel.startsWith('..') ? path : rel;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** The code tree is a git checkout this process may write the seed and release into. */
export function checkoutWritable(): boolean {
	if (!existsSync(join(projectRoot, '.git'))) return false;
	try {
		accessSync(join(projectRoot, 'install/db'), constants.W_OK);
		accessSync(ONTOLOGY_RELEASE_DIR, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** What `build.json` records next to a private build. */
export interface SeedBuildRecord {
	built_at: string;
	built_by: number | null;
	engine_version: string;
	source: { id: string; location: string };
	release: ReleaseSummary | null;
	seed: { file: string; bytes: number; sha256: string };
	checks: string[];
	findings: string[];
}

/** The newest successful private build (null when none). */
export async function latestPrivateBuild(
	buildsDir: string = SEED_BUILDS_DIR,
): Promise<(SeedBuildRecord & { dir: string }) | null> {
	if (!existsSync(buildsDir)) return null;
	for (const stamp of readdirSync(buildsDir).sort().reverse()) {
		if (!BUILD_STAMP.test(stamp)) continue; // only build dirs; nothing else under seed_builds is a build
		const dir = join(buildsDir, stamp);
		try {
			const record = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8')) as SeedBuildRecord;
			return { ...record, dir };
		} catch {
			// a build without its record is an unfinished one: not a result
		}
	}
	return null;
}

/** The vendored seed against this checkout's sources (the install_seed_manifest_tripwire's reading). */
export async function checkoutSeedState(): Promise<{
	file: string;
	bytes: number | null;
	release: SeedManifest['ontology_release'] | null;
	engine_version: string | null;
	state: 'current' | 'stale' | 'missing';
	findings: string[];
}> {
	const file = shown(SEED_DUMP_PATH);
	if (!existsSync(SEED_DUMP_PATH) || !existsSync(SEED_MANIFEST_PATH)) {
		return {
			file,
			bytes: null,
			release: null,
			engine_version: null,
			state: 'missing',
			findings: [],
		};
	}
	const manifest = JSON.parse(await readFile(SEED_MANIFEST_PATH, 'utf8')) as SeedManifest;
	const findings = manifestFindings(manifest, await observeCommittedSeed(SEED_DUMP_PATH));
	return {
		file,
		bytes: manifest.seed.bytes,
		release: manifest.ontology_release,
		engine_version: manifest.engine_version,
		state: findings.length === 0 ? 'current' : 'stale',
		findings,
	};
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightCheck {
	id: 'database_role' | 'pg_tools' | 'build_lock' | 'source' | 'output' | 'disk';
	ok: boolean;
	/** What was found, in a sentence. */
	detail: string;
	/** What the administrator does about a failed check. */
	fix?: string;
}

export interface PreflightDeps {
	conn?: DbConnDescriptor;
	psql?: (sql: string) => Promise<{ ok: boolean; out: string; err: string }>;
	fetchManifest?: typeof fetchOntologyManifest;
	freeBytes?: (dir: string) => number;
}

/** Every check a build needs, each with its fix. Never throws for a failed check. */
export async function seedPreflight(
	source: SeedSource,
	target: SeedTarget,
	deps: PreflightDeps = {},
): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
	const conn = deps.conn ?? connFromConfig();
	const psql =
		deps.psql ??
		(async (sql: string) => {
			try {
				const run = await runPsqlScript(conn, sql, { flags: ['-q', '-tA'], database: 'postgres' });
				return { ok: run.exitCode === 0, out: run.stdout.trim(), err: run.stderr.trim() };
			} catch (error) {
				// psql missing / not executable: a failed check (pg_tools names the fix), never a throw
				logError(toDedaloError(error), { subsystem: 'seed_panel' });
				return { ok: false, out: '', err: 'psql could not be started' };
			}
		});
	const checks = [
		toolsCheck(),
		await roleCheck(conn, psql),
		await lockCheck(psql),
		await sourceCheck(source, deps.fetchManifest ?? fetchOntologyManifest),
		outputCheck(target),
		diskCheck(target, deps.freeBytes ?? freeBytesAt),
	];
	return { ok: checks.every((check) => check.ok), checks };
}

function toolsCheck(): PreflightCheck {
	const missing = [probePsql(), probePgDump()].filter((probe) => probe.state !== 'found');
	return missing.length === 0
		? { id: 'pg_tools', ok: true, detail: 'psql and pg_dump found' }
		: {
				id: 'pg_tools',
				ok: false,
				detail: `not usable: ${missing.map((probe) => probe.path).join(', ')}`,
				fix: 'install the PostgreSQL client tools, or point PG_BIN_PATH at their directory',
			};
}

async function roleCheck(
	conn: DbConnDescriptor,
	psql: NonNullable<PreflightDeps['psql']>,
): Promise<PreflightCheck> {
	const run = await psql(
		'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user;',
	);
	if (!run.ok) {
		return {
			id: 'database_role',
			ok: false,
			detail: `the database cannot be asked: ${run.err}`,
			fix: 'check the database connection settings',
		};
	}
	return run.out === 't'
		? { id: 'database_role', ok: true, detail: `database user '${conn.user}' may create databases` }
		: {
				id: 'database_role',
				ok: false,
				detail: `database user '${conn.user}' may not create databases (the build compiles in a scratch database and drops it after)`,
				fix: `a PostgreSQL superuser runs: ALTER ROLE "${conn.user}" CREATEDB;`,
			};
}

async function lockCheck(psql: NonNullable<PreflightDeps['psql']>): Promise<PreflightCheck> {
	// READ pg_locks, never take the lock: a probe that took it, even for an instant, could make a
	// starting build fail at its own try-lock. Same key + database as seed_build.ts acquireClusterLock.
	const key = `hashtext('${SEED_BUILD_LOCK_KEY}')::bigint`;
	const run = await psql(
		`SELECT NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid::bigint = ((${key} >> 32) & 4294967295) AND objid::bigint = (${key} & 4294967295));`,
	);
	if (run.ok && run.out === 't')
		return { id: 'build_lock', ok: true, detail: 'no other seed build is running' };
	return {
		id: 'build_lock',
		ok: false,
		detail: run.ok
			? 'another seed build is running on this database server'
			: `the lock cannot be probed: ${run.err}`,
		fix: 'wait for it to finish',
	};
}

async function sourceCheck(
	source: SeedSource,
	fetchManifest: typeof fetchOntologyManifest,
): Promise<PreflightCheck> {
	return source.kind === 'master'
		? masterSourceCheck(source.name, fetchManifest)
		: releaseDirSourceCheck(source.kind);
}

/** The shipped release, or this server's own export: present, and (an export) digested. */
async function releaseAt(dir: string | null): Promise<ReleaseSummary | null> {
	return dir === null ? null : summarizeRelease(dir);
}

function releaseSentence(release: ReleaseSummary): string {
	const by = release.host === null ? '' : ` by ${release.host}`;
	return `release ${release.version} exported ${release.date ?? '(no date)'}${by}, ${release.packages} packages`;
}

async function releaseDirSourceCheck(kind: 'shipped' | 'local_export'): Promise<PreflightCheck> {
	const dir = kind === 'shipped' ? ONTOLOGY_RELEASE_DIR : localExportDir();
	const release = await releaseAt(dir);
	if (dir === null || release === null) {
		return {
			id: 'source',
			ok: false,
			detail: 'this server has no ontology export',
			fix: 'export the ontology on this server first (Ontology export panel)',
		};
	}
	if (kind === 'local_export' && !release.digests) {
		return {
			id: 'source',
			ok: false,
			detail: `the export in ${shown(dir)} lists no sha256 for every package`,
			fix: 'export the ontology again',
		};
	}
	return { id: 'source', ok: true, detail: releaseSentence(release) };
}

/** A configured master that answers with a compatible, fully digested release. */
async function masterSourceCheck(
	name: string,
	fetchManifest: typeof fetchOntologyManifest,
): Promise<PreflightCheck> {
	const server = config.ontologyIo.servers.find((entry) => entry.name === name);
	if (server === undefined) {
		return {
			id: 'source',
			ok: false,
			detail: `no ONTOLOGY_SERVERS entry named '${name}'`,
			fix: 'add the master to ONTOLOGY_SERVERS in the private .env',
		};
	}
	const manifest = await fetchManifest(
		{ name: server.name, url: server.url, code: server.code },
		config.ontologyIo.servers,
	);
	if (!manifest.ok) {
		return {
			id: 'source',
			ok: false,
			detail: `${name} does not answer: ${manifest.reason}`,
			fix: "check the master is reachable and this server's code is accepted there",
		};
	}
	return manifestSourceCheck(name, manifest);
}

function manifestSourceCheck(
	name: string,
	manifest: Extract<Awaited<ReturnType<typeof fetchOntologyManifest>>, { ok: true }>,
): PreflightCheck {
	const verdict = ontologyCompatibility(manifest.version, DEDALO_DATA_VERSION);
	if (!verdict.ok) {
		return {
			id: 'source',
			ok: false,
			detail: verdict.detail,
			fix: 'use a master on this data version',
		};
	}
	const unverified = manifest.ontologies.some((entry) => entry.sha256 === undefined);
	const matrixUnverified = manifest.matrixDdUrl !== null && manifest.matrixDdSha256 === undefined;
	if (unverified || matrixUnverified) {
		return {
			id: 'source',
			ok: false,
			detail: `${name} publishes packages without a sha256`,
			fix: `export the ontology again on ${name}`,
		};
	}
	return {
		id: 'source',
		ok: true,
		detail: `${name} offers release ${manifest.version} (${manifest.ontologies.length} packages, all with sha256)`,
	};
}

function outputCheck(target: SeedTarget): PreflightCheck {
	if (target === 'checkout') {
		return checkoutWritable()
			? {
					id: 'output',
					ok: true,
					detail: `writes ${shown(SEED_DUMP_PATH)} and its release in this checkout`,
				}
			: {
					id: 'output',
					ok: false,
					detail: 'this code tree is not a writable git checkout',
					fix: 'build to the private directory instead',
				};
	}
	try {
		// Read-only probe: the build creates the dir; its parent (the private dir) must take it.
		accessSync(existsSync(SEED_BUILDS_DIR) ? SEED_BUILDS_DIR : privateDir, constants.W_OK);
		return { id: 'output', ok: true, detail: `writes to ${SEED_BUILDS_DIR}` };
	} catch {
		return {
			id: 'output',
			ok: false,
			detail: `${SEED_BUILDS_DIR} is not writable`,
			fix: 'give the Dédalo process user write access to its private directory',
		};
	}
}

function freeBytesAt(dir: string): number {
	const stats = statfsSync(dir);
	return Number(stats.bavail) * Number(stats.bsize);
}

function diskCheck(target: SeedTarget, freeBytes: (dir: string) => number): PreflightCheck {
	const dirs = [
		tmpdir(),
		target === 'checkout'
			? projectRoot
			: existsSync(SEED_BUILDS_DIR)
				? SEED_BUILDS_DIR
				: privateDir,
	];
	const low = dirs.filter((dir) => freeBytes(dir) < MIN_FREE_BYTES);
	return low.length === 0
		? { id: 'disk', ok: true, detail: 'at least 1 GB free for staging and output' }
		: {
				id: 'disk',
				ok: false,
				detail: `less than 1 GB free in ${low.join(', ')}`,
				fix: 'free disk space',
			};
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export interface PanelBuildResult extends SeedBuildResult {
	target: SeedTarget;
	/** Where the seed landed (shown path). */
	output: string;
	source: { id: string; location: string };
	release: ReleaseSummary | null;
	pulled: Pick<ReleasePullResult, 'written' | 'removed' | 'warnings'> | null;
}

/** Bring the source's release into `releaseDir` (nothing to do for the shipped one compiled in place). */
async function materialize(
	source: SeedSource,
	releaseDir: string,
): Promise<ReleasePullResult | null> {
	if (source.kind === 'master') return pullOntologyRelease(source.name, { releaseDir });
	if (source.kind === 'local_export') {
		const dir = localExportDir();
		if (dir === null) refuse('this server has no ontology export');
		return copyLocalRelease(dir, releaseDir);
	}
	return null;
}

async function sourceLocation(source: SeedSource): Promise<string> {
	return (
		(await seedSourceOptions()).find((option) => option.id === seedSourceId(source))?.location ??
		seedSourceId(source)
	);
}

/**
 * A source's release staged in a scratch dir: `prepareRelease` pulls/copies it there and
 * `promoteRelease` mirrors the VERIFIED copy into this checkout's release dir — both handed to
 * buildInstallVersion, which runs them under the cluster lock, so a build that fails or stops before
 * its verify never touches the checkout and no concurrent build reads a half-written release. The shipped source
 * needs neither (compiled in place). Shared by the panel and `bun run seed:build --from`.
 */
export function stagedRelease(
	source: SeedSource,
	options: { promote: boolean; onPulled?: (pulled: ReleasePullResult) => void },
): {
	releaseDir: string;
	prepareRelease?: () => Promise<string | null>;
	promoteRelease?: () => Promise<void>;
	pulled: () => ReleasePullResult | null;
	/** What the promotion changed in the checkout's release dir (null until promoted). */
	promoted: () => ReleasePullResult | null;
	dispose: () => void;
} {
	if (source.kind === 'shipped') {
		return {
			releaseDir: ONTOLOGY_RELEASE_DIR,
			pulled: () => null,
			promoted: () => null,
			dispose: () => {},
		};
	}
	const releaseDir = mkdtempSync(join(tmpdir(), 'dedalo_seed_release_'));
	let pulled: ReleasePullResult | null = null;
	let promoted: ReleasePullResult | null = null;
	return {
		releaseDir,
		prepareRelease: async () => {
			pulled = await materialize(source, releaseDir);
			if (pulled === null) return null;
			options.onPulled?.(pulled);
			return pulledLine(pulled, sourceLabel(source));
		},
		...(options.promote
			? {
					promoteRelease: async () => {
						promoted = await copyLocalRelease(releaseDir, ONTOLOGY_RELEASE_DIR);
					},
				}
			: {}),
		pulled: () => pulled,
		promoted: () => promoted,
		dispose: () => rmSync(releaseDir, { recursive: true, force: true }),
	};
}

/** The panel's build: preflight, then compile (release staged + promoted under the lock), record. */
export async function runPanelSeedBuild(request: PanelBuildRequest): Promise<PanelBuildResult> {
	await assertPreflight(request.source, request.target);
	const sourceInfo = {
		id: seedSourceId(request.source),
		location: await sourceLocation(request.source),
	};
	return request.target === 'checkout'
		? buildIntoCheckout(request, sourceInfo)
		: buildIntoPrivate(request, sourceInfo);
}

interface PanelBuildRequest {
	source: SeedSource;
	target: SeedTarget;
	userId: number | null;
	onStep: (line: string) => void;
	/** The job's stop signal (seed_build.ts SeedBuildOptions.signal). */
	signal?: AbortSignal;
}

type SourceInfo = PanelBuildResult['source'];

/** The preflight again at build time: a failed check refuses, naming every failure. */
async function assertPreflight(source: SeedSource, target: SeedTarget): Promise<void> {
	const preflight = await seedPreflight(source, target);
	if (preflight.ok) return;
	const failed = preflight.checks.filter((check) => !check.ok).map((check) => check.detail);
	refuse(failed.join('; '));
}

/** The compiler options every panel build shares (progress + stop). */
function sharedOptions(request: PanelBuildRequest): Pick<SeedBuildOptions, 'onStep' | 'signal'> {
	return request.signal === undefined
		? { onStep: request.onStep }
		: { onStep: request.onStep, signal: request.signal };
}

/** Into this checkout: the release staged in scratch, promoted only after the verify. */
async function buildIntoCheckout(
	request: PanelBuildRequest,
	sourceInfo: SourceInfo,
): Promise<PanelBuildResult> {
	const staged = stagedRelease(request.source, { promote: true });
	try {
		const built = await buildInstallVersion({
			...sharedOptions(request),
			releaseDir: staged.releaseDir,
			...(staged.prepareRelease ? { prepareRelease: staged.prepareRelease } : {}),
			...(staged.promoteRelease ? { promoteRelease: staged.promoteRelease } : {}),
		});
		return {
			...built,
			target: 'checkout',
			output: shown(SEED_DUMP_PATH),
			source: sourceInfo,
			release: await summarizeRelease(ONTOLOGY_RELEASE_DIR),
			pulled: checkoutPulled(staged.pulled(), staged.promoted()),
		};
	} finally {
		staged.dispose();
	}
}

/** Into `<private>/seed_builds/<stamp>/`: seed, manifest, build.json and the copied release. */
async function buildIntoPrivate(
	request: PanelBuildRequest,
	sourceInfo: SourceInfo,
): Promise<PanelBuildResult> {
	const { source } = request;
	const dir = join(SEED_BUILDS_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
	mkdirSync(dir, { recursive: true });
	try {
		const releaseDir = source.kind === 'shipped' ? ONTOLOGY_RELEASE_DIR : join(dir, 'ontology');
		let pulled: ReleasePullResult | null = null;
		const outFile = join(dir, SEED_FILE);
		const built = await buildInstallVersion({
			...sharedOptions(request),
			outFile,
			releaseDir,
			// under the lock: a concurrent build fails at the lock before touching anything
			prepareRelease: async () => {
				pulled = await materialize(source, releaseDir);
				return pulled === null ? null : pulledLine(pulled, sourceLabel(source));
			},
		});
		const release = await summarizeRelease(releaseDir);
		await writeBuildRecord(dir, { request, sourceInfo, release, built });
		pruneOlderBuilds(dir);
		return {
			...built,
			target: 'private',
			output: outFile,
			source: sourceInfo,
			release,
			pulled: pickPulled(pulled),
		};
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

/** The build's `build.json` — what the panel's "Last build" and the download route read. */
async function writeBuildRecord(
	dir: string,
	parts: {
		request: PanelBuildRequest;
		sourceInfo: SourceInfo;
		release: SeedBuildRecord['release'];
		built: SeedBuildResult;
	},
): Promise<void> {
	const { built } = parts;
	const record: SeedBuildRecord = {
		built_at: new Date().toISOString(),
		built_by: parts.request.userId,
		engine_version: formatVersion(DEDALO_DATA_VERSION),
		source: parts.sourceInfo,
		release: parts.release,
		seed: {
			file: SEED_FILE,
			bytes: built.manifest.seed.bytes,
			sha256: built.manifest.seed.sha256,
		},
		checks: built.manifest.verified.checks,
		findings: built.findings,
	};
	await writeFile(join(dir, 'build.json'), `${JSON.stringify(record, null, '\t')}\n`);
}

/** Where a non-shipped release came from, for its step line. */
function sourceLabel(source: SeedSource): string {
	return source.kind === 'master' ? `master '${source.name}'` : "this server's ontology export";
}

function pulledLine(pulled: ReleasePullResult, from: string): string {
	return `ontology release ${pulled.version} copied from ${from}: ${pulled.written.length} files verified`;
}

/** The checkout's change: what the promotion wrote/removed there, with the pull's warnings. */
function checkoutPulled(
	pulled: ReleasePullResult | null,
	promoted: ReleasePullResult | null,
): PanelBuildResult['pulled'] {
	if (pulled === null || promoted === null) return null;
	return { written: promoted.written, removed: promoted.removed, warnings: pulled.warnings };
}

function pickPulled(pulled: ReleasePullResult | null): PanelBuildResult['pulled'] {
	return pulled === null
		? null
		: { written: pulled.written, removed: pulled.removed, warnings: pulled.warnings };
}

/** A build dir name (`new Date().toISOString()` with `:` and `.` replaced). */
const BUILD_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Retention: only the newest successful build stays. Only OLDER build stamps go — a newer one
 * is a build that started after this one took the lock (it fails at the lock and removes its own
 * dir); anything that is not a build stamp is never touched.
 */
export function pruneOlderBuilds(keep: string, buildsDir: string = SEED_BUILDS_DIR): void {
	const kept = basename(keep);
	for (const name of readdirSync(buildsDir)) {
		if (BUILD_STAMP.test(name) && name < kept) {
			rmSync(join(buildsDir, name), { recursive: true, force: true });
		}
	}
}
