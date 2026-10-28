/**
 * THE INSTALLER'S ONTOLOGY DOOR (installer unification A4/A5/A6) — two steps
 * around the seed restore:
 *
 *  1. stage_ontologies (BEFORE the database is touched — the install's ONLY
 *     network phase): every chosen ontology file (deps first, + the source's
 *     matrix_dd lists when it ships them) is copied (vendored / local) or
 *     downloaded (server — the EXISTING pinned downloadRemoteOntologyFile, no
 *     new fetch site) into the private staging dir, gunzipped under the shared
 *     caps and COPY-sanity checked; `staged.json` records each file's sha256.
 *     Any failure refuses `install.step_failed` with the database untouched.
 *     SHAPE-CHECKED, NOT AUTHENTICATED: a downloaded file is trusted as far as
 *     the pinned door takes it (TLS verified, the configured server's origin, the
 *     expected file name) — the master ontology server publishes no per-file
 *     digest or signature to check its bytes against, so a well-formed file that
 *     server serves is staged as served. The sha256 in `staged.json` pins what
 *     was staged against a later change on THIS disk; it says nothing of origin.
 *     (Vendored / local files ride the release tree's own integrity.)
 *  2. install_ontologies (AFTER the seed restore + its migrations, BEFORE the
 *     root password, hierarchies and tools): the staged files are re-verified
 *     (sha256), unpacked through the update panel's own Phase-A stager
 *     (stageOntologyFiles, local mode) and imported through the SHARED LOWER
 *     LAYER of the ontology update (ontology_update.ts importStagedOntologyFiles
 *     — snapshots, per-file import + auto-restore, dd_ontology re-derive), under
 *     the same single-flight latch. That layer's re-derive is the WHOLE of it: a
 *     node whose model lives in a TLD imported after it (a dependency cycle) is
 *     settled there, by its pass 2 (ontology_update.ts deriveOntologyPackages —
 *     every tld through the ONE writer, rebuildOntology). The installer re-derives
 *     nothing of its own: its former upsert-only pass (no orphan sweep, no
 *     transaction, no projection lock) is retired (gate: install_ontology_door_native
 *     (h), ontology_derive_packages_native G1f). Finally the installed TLDs'
 *     structural references are VERIFIED
 *     (verifyInstalledOntologyReferences): a dependency-class reference to a
 *     tipo this installation does not hold is a WARNING naming the remedy. A
 *     reference into a thesaurus the SAME run installs next (install_hierarchies,
 *     `pendingThesauri`) is not missing, and references from an
 *     external-ontology mapping (tch → crm) are soft — campaign 3, C3-28.
 *
 * FAILURE CONTRACT — install-level all-or-nothing: ANY import error refuses
 * `install.step_failed`; the shared layer's snapshot restore runs (its known
 * limits D7/D9 are the update panel's, stated in ontology_update.ts), nothing is
 * sealed, and the operator recreates the database — the contract of every
 * post-restore install step. The staging dir is removed on success only (a
 * failed run leaves it for diagnosis; the next stage wipes it).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { copyFile, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	existingDdOntologyTipos,
	readDdOntologyModelParents,
	readDdOntologyReferenceRows,
} from '../db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import {
	DirectoryBarrier,
	fsyncFile,
	syncCreatedLevels,
	writeFileDurably,
} from '../files/durable.ts';
import { isCoreOntologyTld } from '../ontology/core_tlds.ts';
import {
	copySanityCheck,
	downloadRemoteOntologyFile,
	gunzipWithCaps,
} from '../ontology/data_io_import.ts';
import type { OntologyDependency } from '../ontology/ontology_dependencies.ts';
import {
	danglingDependencies,
	diffusionModelSet,
	externalMappingNodes,
	type OntologyReference,
	type ReferenceRow,
	referencesOfRows,
	unreachableNodes,
} from '../ontology/ontology_references.ts';
import {
	claimOntologyImportLatch,
	importStagedOntologyFiles,
	releaseOntologyImportLatch,
} from '../ontology/ontology_update.ts';
import { type StagedFile, stageOntologyFiles } from '../ontology/ontology_update_target.ts';
import { getTldFromTipo } from '../ontology/tld.ts';
import {
	DEDALO_DATA_VERSION,
	DEDALO_VERSION_MAJOR_MINOR,
	formatVersion,
} from '../update/version.ts';
import {
	type OntologyInstallRequest,
	type OntologyOrigin,
	type OntologySourceView,
	undeclaredWarning,
} from './ontology_choice.ts';
import { installOntologyStagingDir } from './paths.ts';
import { connFromConfig, type DbConnDescriptor, runPsqlScript } from './pg_exec.ts';
import { refuseInstall } from './refuse.ts';

const STAGED_MANIFEST = 'staged.json';

/** One staged file as staged.json records it. */
interface StagedRecord {
	tld: string;
	origin: OntologyOrigin;
	typology_id: number | string | null;
	name_data: unknown;
	dependencies: OntologyDependency[] | null;
	/** Relative to the staging dir. */
	file: string;
	sha256: string;
	bytes: number;
}

/** staged.json — the contract between the two steps. */
interface StagedManifest {
	format: 1;
	engine_version: string;
	created_at: string;
	source: OntologySourceView;
	items: StagedRecord[];
	matrix_dd: Omit<StagedRecord, 'typology_id' | 'name_data' | 'dependencies' | 'tld'> | null;
	warnings: string[];
}

export interface StageOntologiesResult {
	ok: true;
	msg: string;
	staged: { tld: string; origin: OntologyOrigin; bytes: number }[];
	warnings: string[];
}

export interface InstallOntologiesResult {
	ok: true;
	msg: string;
	installed: { tld: string; records: number }[];
	warnings: string[];
}

/** sha256 + size of one staged file — async: the installer is a served route (one event loop). */
async function digestOf(path: string): Promise<{ sha256: string; bytes: number }> {
	const bytes = await readFile(path);
	return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
}

// ── stage ────────────────────────────────────────────────────────────────────

/** The origin a server file must sit on (the configured master's). */
function serverOrigin(source: OntologySourceView): string {
	if (source.kind !== 'server') {
		refuseInstall(
			'install.step_failed',
			'a server ontology file was requested without a server source',
		);
	}
	return new URL(source.server.url).origin;
}

/** Download one server file into `versionDir` through the pinned door. */
async function downloadStaged(
	name: string,
	url: string,
	source: OntologySourceView,
	versionDir: string,
): Promise<void> {
	const downloaded = await downloadRemoteOntologyFile({
		url,
		configuredOrigin: serverOrigin(source),
		expectedBasename: name,
		targetDir: versionDir,
	});
	if (downloaded.ok !== true) {
		refuseInstall('install.step_failed', `${name}: ${downloaded.msg} — nothing was installed`);
	}
}

/** Gunzip under the caps + COPY-shape check (a SHAPE check — see the header); the decompressed copy is removed. */
async function verifyStaged(gzPath: string, name: string): Promise<void> {
	const plain = `${gzPath}.verify`;
	let problem: string | null;
	try {
		await gunzipWithCaps(gzPath, plain);
		problem = copySanityCheck(plain, MATRIX_COPY_COLUMNS.length);
	} catch (error) {
		problem = `cannot decompress (${(error as Error).message})`;
	} finally {
		rmSync(plain, { force: true });
	}
	if (problem !== null) {
		refuseInstall('install.step_failed', `${name}: ${problem} — nothing was installed`);
	}
}

/** Where one stage brings its files: `incomingDir` (fetched, unverified), then `versionDir`. */
interface StageDirs {
	incomingDir: string;
	versionDir: string;
	barrier: DirectoryBarrier;
}

/**
 * Bring one file into the stage (copy or download into `incomingDir`), shape-check it,
 * fsync its bytes, and only then RENAME it into `versionDir` — a staged name always
 * holds a whole, verified file; its directory entry becomes durable at the stage's one
 * barrier flush (stageOntologies). Answers its record fields.
 */
async function stageFile(
	tld: string,
	origin: OntologyOrigin,
	file: string,
	source: OntologySourceView,
	stage: StageDirs,
): Promise<{ file: string; sha256: string; bytes: number }> {
	const name = `${tld}.copy.gz`;
	const incoming = join(stage.incomingDir, name);
	if (origin === 'server') await downloadStaged(name, file, source, stage.incomingDir);
	else await copyLocal(file, incoming, name);
	await verifyStaged(incoming, name);
	fsyncFile(incoming);
	const target = join(stage.versionDir, name);
	renameSync(incoming, target);
	stage.barrier.add(stage.versionDir);
	return { file: join(DEDALO_VERSION_MAJOR_MINOR, name), ...(await digestOf(target)) };
}

async function copyLocal(file: string, target: string, name: string): Promise<void> {
	try {
		await copyFile(file, target);
	} catch (error) {
		refuseInstall(
			'install.step_failed',
			`${name}: cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unreadable'}) — nothing was installed`,
		);
	}
}

async function stageMatrixDd(
	request: OntologyInstallRequest,
	stage: StageDirs,
): Promise<StagedManifest['matrix_dd']> {
	const matrixDd = request.matrixDd;
	if (matrixDd === null) return null;
	const staged = await stageFile(
		'matrix_dd',
		matrixDd.origin,
		matrixDd.file,
		request.source,
		stage,
	);
	return { origin: matrixDd.origin, ...staged };
}

/**
 * STAGE every file of `request` (fetch/copy + shape check) into the staging dir and
 * write staged.json. The database is never touched; any failure refuses
 * `install.step_failed`. DURABLE BEFORE IT RETURNS (cross-ops:r2): the executor
 * checkpoints the step `done` when it returns, and install_ontologies re-verifies the
 * set later — so every staged file is fsynced, staged.json written durably, and the
 * directories created and filled are fsynced (one barrier). A power cut after the
 * checkpoint used to leave a `done` step whose staged set was gone: refused as drift.
 * Gate: install_ontology_staging_durability.
 */
export async function stageOntologies(
	request: OntologyInstallRequest,
	options: { stagingDir?: string } = {},
): Promise<StageOntologiesResult> {
	const stagingDir = options.stagingDir ?? installOntologyStagingDir();
	const versionDir = join(stagingDir, DEDALO_VERSION_MAJOR_MINOR);
	await removeStagingDir(stagingDir);
	const barrier = new DirectoryBarrier();
	syncCreatedLevels(versionDir, mkdirSync(versionDir, { recursive: true, mode: 0o700 }), barrier);
	const stage: StageDirs = { incomingDir: join(stagingDir, '.incoming'), versionDir, barrier };
	mkdirSync(stage.incomingDir, { mode: 0o700 });
	const items: StagedRecord[] = [];
	for (const item of request.items) {
		const staged = await stageFile(item.tld, item.origin, item.file, request.source, stage);
		items.push({
			tld: item.tld,
			origin: item.origin,
			typology_id: item.typology_id,
			name_data: item.name_data,
			dependencies: item.dependencies,
			...staged,
		});
	}
	const manifest: StagedManifest = {
		format: 1,
		engine_version: formatVersion(DEDALO_DATA_VERSION),
		created_at: new Date().toISOString(),
		source: request.source,
		items,
		matrix_dd: await stageMatrixDd(request, stage),
		warnings: stagedWarnings(request),
	};
	rmSync(stage.incomingDir, { recursive: true, force: true });
	writeFileDurably(join(stagingDir, STAGED_MANIFEST), JSON.stringify(manifest, null, '\t'), {
		mode: 0o600,
		barrier,
	});
	barrier.flush();
	return {
		ok: true,
		msg: `Staged ontology files: ${items.map((item) => item.tld).join(', ')}${manifest.matrix_dd === null ? '' : ' + matrix_dd'} — shape-checked, nothing installed yet`,
		staged: items.map((item) => ({ tld: item.tld, origin: item.origin, bytes: item.bytes })),
		warnings: manifest.warnings,
	};
}

/** The undeclared-dependency warnings the request carries forward. */
function stagedWarnings(request: OntologyInstallRequest): string[] {
	return request.items.filter((item) => item.dependencies === null).map(undeclaredWarning);
}

// ── install ──────────────────────────────────────────────────────────────────

async function readStagedManifest(stagingDir: string): Promise<StagedManifest> {
	const path = join(stagingDir, STAGED_MANIFEST);
	if (!existsSync(path)) {
		refuseInstall(
			'install.state_conflict',
			'No staged ontology files — run stage_ontologies first',
		);
	}
	return JSON.parse(await readFile(path, 'utf8')) as StagedManifest;
}

/** The first staged file that is missing or changed since it was verified (its sentence), or null. */
async function firstChangedStagedFile(
	stagingDir: string,
	manifest: StagedManifest,
): Promise<string | null> {
	const records = [...(manifest.matrix_dd === null ? [] : [manifest.matrix_dd]), ...manifest.items];
	for (const record of records) {
		const path = join(stagingDir, record.file);
		if (!existsSync(path) || (await digestOf(path)).sha256 !== record.sha256) {
			return `The staged file ${record.file} changed since it was verified — run stage_ontologies again`;
		}
	}
	return null;
}

/** Every staged file must still be byte-identical to what stage_ontologies verified. */
async function assertStagedIntact(stagingDir: string, manifest: StagedManifest): Promise<void> {
	const changed = await firstChangedStagedFile(stagingDir, manifest);
	if (changed !== null) refuseInstall('install.state_conflict', changed);
}

/** The staged manifest → the update stager's file list (matrix_dd first, then deps-first items). */
function updateFilesOf(stagingDir: string, manifest: StagedManifest) {
	const url = (file: string) => pathToFileURL(join(stagingDir, file)).href;
	return [
		...(manifest.matrix_dd === null
			? []
			: [{ tld: 'matrix_dd', url: url(manifest.matrix_dd.file) }]),
		...manifest.items.map((item) => ({
			tld: item.tld,
			url: url(item.file),
			typology_id: item.typology_id,
			name_data: item.name_data,
			// The declaration travels into the import: the registry record keeps it
			// (hierarchy60), so a re-export of this install re-serves it.
			dependencies: item.dependencies,
		})),
	];
}

/** Unpack (gunzip + re-check) through the update panel's own Phase-A stager, local mode. */
async function unpackStaged(stagingDir: string, manifest: StagedManifest): Promise<StagedFile[]> {
	const unpackDir = join(stagingDir, '.unpacked');
	rmSync(unpackDir, { recursive: true, force: true });
	mkdirSync(unpackDir, { recursive: true, mode: 0o700 });
	const staging = await stageOntologyFiles(
		updateFilesOf(stagingDir, manifest),
		{ isLocal: true, configuredOrigin: null },
		{ ioPath: join(stagingDir, DEDALO_VERSION_MAJOR_MINOR), stagingDir: unpackDir },
	);
	if ('errors' in staging) {
		refuseInstall('install.step_failed', `Ontology staging failed: ${staging.errors.join('; ')}`);
	}
	return staging.staged;
}

/** What failed, in the shared layer's own words. */
function failureDetail(imported: { errors: string[]; msg: string | null }): string {
	if (imported.errors.length > 0) return imported.errors.join('; ');
	return imported.msg ?? 'unknown failure';
}

function importFailure(detail: string): never {
	refuseInstall(
		'install.step_failed',
		`Ontology import failed: ${detail} — the install is not sealed; recreate the database and run the installer again`,
	);
}

/** The shared lower layer, under the one latch; any error is an install failure. */
async function importUnderLatch(
	staged: readonly StagedFile[],
	ctx: { conn: DbConnDescriptor; userId: number; recoveryDir: string },
): Promise<void> {
	if (!claimOntologyImportLatch()) {
		refuseInstall(
			'install.state_conflict',
			'An ontology import is already running — retry when it ends',
		);
	}
	try {
		const imported = await importStagedOntologyFiles(staged, ctx);
		if (!imported.completed || imported.errors.length > 0) importFailure(failureDetail(imported));
	} finally {
		releaseOntologyImportLatch();
	}
}

/** Records per installed TLD (the derived node count). */
async function installedCounts(
	tlds: readonly string[],
): Promise<{ tld: string; records: number }[]> {
	const rows = await readDdOntologyReferenceRows(tlds);
	return tlds.map((tld) => ({ tld, records: rows.filter((row) => row.tld === tld).length }));
}

/**
 * INSTALL the staged ontologies (after the seed restore). Refuses
 * `install.state_conflict` when nothing was staged or a staged file changed,
 * `install.step_failed` on any import error (see the header's contract).
 */
export async function installOntologies(
	options: {
		stagingDir?: string;
		userId?: number;
		conn?: DbConnDescriptor;
		/** The thesauri this run's install_hierarchies provisions next (their TLDs). */
		pendingThesauri?: readonly string[];
	} = {},
): Promise<InstallOntologiesResult> {
	const stagingDir = options.stagingDir ?? installOntologyStagingDir();
	const userId = options.userId ?? -1;
	const manifest = await readStagedManifest(stagingDir);
	await assertStagedIntact(stagingDir, manifest);
	const staged = await unpackStaged(stagingDir, manifest);
	await importUnderLatch(staged, {
		conn: options.conn ?? connFromConfig(),
		userId,
		recoveryDir: join(stagingDir, 'recovery'),
	});
	const tlds = manifest.items.map((item) => item.tld);
	const warnings = [
		...manifest.warnings,
		...(await verifyInstalledOntologyReferences(tlds, options.pendingThesauri)),
	];
	const installed = await installedCounts(tlds);
	await removeStagingDir(stagingDir);
	return {
		ok: true,
		msg: `Installed ontologies: ${tlds.join(', ')} — references verified${warnings.length > 0 ? ` (${warnings.length} warnings)` : ''}`,
		installed,
		warnings,
	};
}

/**
 * Remove the staging dir ATOMICALLY: rename it away first (one syscall — the
 * original path is either the whole staged set or gone), then delete the
 * renamed copy. A kill during the recursive delete leaves only a
 * `<dir>.consumed.<pid>` leftover — never a half-deleted staging dir that the
 * verifies would read as "staged, but changed" — and every call sweeps such
 * leftovers.
 */
export async function removeStagingDir(stagingDir: string): Promise<void> {
	if (existsSync(stagingDir)) {
		const consumed = `${stagingDir}.consumed.${process.pid}`;
		rmSync(consumed, { recursive: true, force: true });
		renameSync(stagingDir, consumed);
	}
	const prefix = `${basename(stagingDir)}.consumed.`;
	const parent = dirname(stagingDir);
	const leftovers = existsSync(parent)
		? (await readdir(parent)).filter((name) => name.startsWith(prefix))
		: [];
	for (const name of leftovers) rmSync(join(parent, name), { recursive: true, force: true });
}

// ── the terminal installer's verifies (executor.ts) ─────────────────────────

/** A step outcome check: did the work land, and if not, why. */
export interface StepVerdict {
	ok: boolean;
	detail: string;
}

/**
 * stage_ontologies' VERIFY: staged.json is present, was written by THIS engine,
 * stages exactly `tlds` (deps first), and every staged file is still
 * byte-identical to what was verified. Never throws.
 */
export async function stagedMatches(
	tlds: readonly string[],
	stagingDir: string = installOntologyStagingDir(),
): Promise<StepVerdict> {
	const manifest = await stagedManifestIfAny(stagingDir);
	if (manifest === null) return { ok: false, detail: 'nothing staged (or staged.json unreadable)' };
	const staged = manifest.items.map((item) => item.tld);
	const problem =
		manifest.engine_version !== formatVersion(DEDALO_DATA_VERSION)
			? `staged by engine ${manifest.engine_version}`
			: staged.join(',') !== tlds.join(',')
				? `staged ${staged.join(', ')}, the plan installs ${tlds.join(', ')}`
				: await firstChangedStagedFile(stagingDir, manifest);
	return problem === null
		? { ok: true, detail: `staged: ${staged.join(', ')}` }
		: { ok: false, detail: problem };
}

/** staged.json parsed, or null when absent or unreadable (a verify never throws). */
async function stagedManifestIfAny(stagingDir: string): Promise<StagedManifest | null> {
	const path = join(stagingDir, STAGED_MANIFEST);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(await readFile(path, 'utf8')) as StagedManifest;
	} catch {
		return null;
	}
}

/** Does `tld` have its `<tld>0` source records AND its derived dd_ontology nodes? */
async function tldInstalled(conn: DbConnDescriptor, tld: string): Promise<boolean> {
	if (!/^[a-z][a-z0-9_]*$/.test(tld)) return false;
	const probe = await runPsqlScript(
		conn,
		`SELECT EXISTS (SELECT 1 FROM matrix_ontology WHERE section_tipo = '${tld}0')`,
		{ flags: ['-tA'] },
	);
	if (probe.exitCode !== 0 || probe.stdout.trim() !== 't') return false;
	return (await readDdOntologyReferenceRows([tld])).length > 0;
}

/**
 * install_ontologies' VERIFY: the import finished — its staging dir is gone
 * (installOntologies removes it only after the references are verified, so a
 * partial import never reads as finished) and every TLD has its `<tld>0`
 * records in matrix_ontology and its nodes in dd_ontology.
 */
export async function ontologyImportComplete(
	tlds: readonly string[],
	stagingDir: string = installOntologyStagingDir(),
): Promise<StepVerdict> {
	if (existsSync(stagingDir)) {
		return {
			ok: false,
			detail: `the staging dir ${stagingDir} is still present (import not finished)`,
		};
	}
	const conn = connFromConfig();
	for (const tld of tlds) {
		if (!(await tldInstalled(conn, tld))) {
			return { ok: false, detail: `ontology '${tld}' is not installed` };
		}
	}
	return { ok: true, detail: `installed: ${tlds.join(', ')}` };
}

// ── verification ─────────────────────────────────────────────────────────────

/** One warning per (from TLD, to TLD) group of dangling dependency references. */
function danglingWarning(group: readonly OntologyReference[]): string {
	const first = group[0] as OntologyReference;
	const toTld = getTldFromTipo(first.to) ?? first.to;
	if (isCoreOntologyTld(toTld)) {
		return `'${first.fromTld}' references ${group.length} node(s) of the core ontology '${toTld}' that this installation's seed does not have — run Maintenance › Update ontology after the install to align the core`;
	}
	return `'${first.fromTld}' references ${group.length} node(s) of '${toTld}' that is not installed (${first.field}: e.g. ${first.from}→${first.to}) — the nodes that use them do not work until '${toTld}' is installed: add it (--ontologies ${first.fromTld},${toTld}) if you use them, or ask the ontology server to declare it`;
}

function groupDangling(dangling: readonly OntologyReference[]): OntologyReference[][] {
	const groups = new Map<string, OntologyReference[]>();
	for (const ref of dangling) {
		const key = `${ref.fromTld}\u0000${getTldFromTipo(ref.to) ?? ref.to}`;
		groups.set(key, [...(groups.get(key) ?? []), ref]);
	}
	return [...groups.values()];
}

/** What the reference warnings are measured over (all of it read by the caller). */
export interface ReferenceWarningInput {
	/** The installed TLDs (the measured set). */
	readonly tlds: readonly string[];
	/** Their dd_ontology-shaped rows. */
	readonly rows: readonly ReferenceRow[];
	/** Whether the installation holds a tipo. */
	readonly isPresent: (tipo: string) => boolean;
	/** The diffusion model set (diffusionModelSet). */
	readonly diffusionModels: ReadonlySet<string>;
	/** Thesaurus TLDs the same run provisions next: a reference into one is not missing. */
	readonly pendingThesauri?: readonly string[];
}

/**
 * PURE: the warnings over measured rows — every DEPENDENCY-class reference
 * (ontology_references.ts: grafts, diffusion relations and external-ontology
 * mappings are soft by rule) to a tipo neither present nor in a pending
 * thesaurus, one warning per (from, to) TLD pair, naming the remedy. A
 * reference FROM a node no tree reaches (under a graft into an absent
 * ontology — unreachableNodes) is not reported either: it cannot break a node
 * anyone uses.
 */
export function referenceWarnings(input: ReferenceWarningInput): string[] {
	const pending = new Set(input.pendingThesauri ?? []);
	const own = new Set(input.tlds);
	const resolvable = (tipo: string) =>
		pending.has(getTldFromTipo(tipo) ?? '') || input.isPresent(tipo);
	const mapping = externalMappingNodes(input.rows);
	const unreachable = unreachableNodes(input.rows, own, resolvable);
	const dangling = danglingDependencies(
		referencesOfRows(input.rows),
		own,
		resolvable,
		input.diffusionModels,
		(tipo) => mapping.has(tipo),
	).filter((ref) => !unreachable.has(ref.from));
	return groupDangling(dangling).map(danglingWarning);
}

/**
 * The installed TLDs' structural references that do not resolve in the
 * dd_ontology table (referenceWarnings over this database's rows).
 */
export async function verifyInstalledOntologyReferences(
	tlds: readonly string[],
	pendingThesauri: readonly string[] = [],
): Promise<string[]> {
	const rows = await readDdOntologyReferenceRows(tlds);
	const present = await existingDdOntologyTipos(referencesOfRows(rows).map((ref) => ref.to));
	return referenceWarnings({
		tlds,
		rows,
		isPresent: (tipo) => present.has(tipo),
		diffusionModels: diffusionModelSet(await readDdOntologyModelParents()),
		pendingThesauri,
	});
}
