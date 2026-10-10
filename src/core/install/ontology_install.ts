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
 *  2. install_ontologies (AFTER the seed restore + its migrations, BEFORE the
 *     root password, hierarchies and tools): the staged files are re-verified
 *     (sha256), unpacked through the update panel's own Phase-A stager
 *     (stageOntologyFiles, local mode) and imported through the SHARED LOWER
 *     LAYER of the ontology update (ontology_update.ts importStagedOntologyFiles
 *     — snapshots, per-file import + auto-restore, dd_ontology re-derive), under
 *     the same single-flight latch. ONE re-derive pass then settles nodes whose
 *     model lives in a TLD imported after them (a dependency cycle). Finally the
 *     installed TLDs' structural references are VERIFIED
 *     (verifyInstalledOntologyReferences): a dependency-class reference to a
 *     tipo this installation does not hold is a WARNING naming the remedy.
 *
 * FAILURE CONTRACT — install-level all-or-nothing: ANY import error refuses
 * `install.step_failed`; the shared layer's snapshot restore runs (its known
 * limits D7/D9 are the update panel's, stated in ontology_update.ts), nothing is
 * sealed, and the operator recreates the database — the contract of every
 * post-restore install step. The staging dir is removed on success only (a
 * failed run leaves it for diagnosis; the next stage wipes it).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../../config/config.ts';
import {
	existingDdOntologyTipos,
	readDdOntologyModelParents,
	readDdOntologyReferenceRows,
} from '../db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
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
	type OntologyReference,
	referencesOfRows,
} from '../ontology/ontology_references.ts';
import {
	claimOntologyImportLatch,
	importStagedOntologyFiles,
	releaseOntologyImportLatch,
} from '../ontology/ontology_update.ts';
import { type StagedFile, stageOntologyFiles } from '../ontology/ontology_update_target.ts';
import { setRecordsInDdOntology } from '../ontology/ontology_write.ts';
import { getTldFromTipo } from '../ontology/tld.ts';
import { DEDALO_VERSION, DEDALO_VERSION_MAJOR_MINOR } from '../update/version.ts';
import { resolveOntologyCatalog } from './ontology_catalog.ts';
import {
	listedPolicy,
	type OntologyInstallRequest,
	type OntologyOrigin,
	type OntologySource,
	type OntologySourceView,
	ontologyCatalogNeeded,
	ontologyRequestFromActive,
	undeclaredWarning,
	vendoredOntologyCatalog,
} from './ontology_choice.ts';
import { installOntologyStagingDir } from './paths.ts';
import { connFromConfig, type DbConnDescriptor } from './pg_exec.ts';
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

/** Gunzip under the caps + COPY-shape check; the decompressed copy is removed. */
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

/** Bring one file into `versionDir` (copy or download), verify it, answer its record fields. */
async function stageFile(
	tld: string,
	origin: OntologyOrigin,
	file: string,
	source: OntologySourceView,
	versionDir: string,
): Promise<{ file: string; sha256: string; bytes: number }> {
	const name = `${tld}.copy.gz`;
	const target = join(versionDir, name);
	if (origin === 'server') await downloadStaged(name, file, source, versionDir);
	else await copyLocal(file, target, name);
	await verifyStaged(target, name);
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
	versionDir: string,
): Promise<StagedManifest['matrix_dd']> {
	const matrixDd = request.matrixDd;
	if (matrixDd === null) return null;
	const staged = await stageFile(
		'matrix_dd',
		matrixDd.origin,
		matrixDd.file,
		request.source,
		versionDir,
	);
	return { origin: matrixDd.origin, ...staged };
}

/**
 * STAGE every file of `request` (fetch/copy + verify) into the staging dir and
 * write staged.json. The database is never touched; any failure refuses
 * `install.step_failed`.
 */
export async function stageOntologies(
	request: OntologyInstallRequest,
	options: { stagingDir?: string } = {},
): Promise<StageOntologiesResult> {
	const stagingDir = options.stagingDir ?? installOntologyStagingDir();
	const versionDir = join(stagingDir, DEDALO_VERSION_MAJOR_MINOR);
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(versionDir, { recursive: true, mode: 0o700 });
	const items: StagedRecord[] = [];
	for (const item of request.items) {
		const staged = await stageFile(item.tld, item.origin, item.file, request.source, versionDir);
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
		engine_version: DEDALO_VERSION,
		created_at: new Date().toISOString(),
		source: request.source,
		items,
		matrix_dd: await stageMatrixDd(request, versionDir),
		warnings: stagedWarnings(request),
	};
	await writeFile(join(stagingDir, STAGED_MANIFEST), JSON.stringify(manifest, null, '\t'), {
		mode: 0o600,
	});
	return {
		ok: true,
		msg: `Staged ontology files: ${items.map((item) => item.tld).join(', ')}${manifest.matrix_dd === null ? '' : ' + matrix_dd'} — verified, nothing installed yet`,
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

/** Every staged file must still be byte-identical to what stage_ontologies verified. */
async function assertStagedIntact(stagingDir: string, manifest: StagedManifest): Promise<void> {
	const records = [...(manifest.matrix_dd === null ? [] : [manifest.matrix_dd]), ...manifest.items];
	for (const record of records) {
		const path = join(stagingDir, record.file);
		if (!existsSync(path) || (await digestOf(path)).sha256 !== record.sha256) {
			refuseInstall(
				'install.state_conflict',
				`The staged file ${record.file} changed since it was verified — run stage_ontologies again`,
			);
		}
	}
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

/**
 * ONE re-derive pass: a node derived before the TLD holding its model was
 * imported (a declared dependency cycle) has `model` NULL while its model_tipo
 * now resolves — its TLD is derived once more.
 */
async function rederiveUnresolvedModels(tlds: readonly string[], userId: number): Promise<void> {
	const rows = await readDdOntologyReferenceRows(tlds);
	const pending = rows.filter((row) => row.model === null && row.model_tipo !== null);
	const present = await existingDdOntologyTipos(pending.map((row) => row.model_tipo as string));
	const stale = new Set(
		pending.filter((row) => present.has(row.model_tipo as string)).map((row) => row.tld ?? ''),
	);
	for (const tld of [...stale].filter((item) => item !== '')) {
		const rebuilt = await setRecordsInDdOntology({
			sectionTipo: `${tld}0`,
			wholeSection: true,
			userId,
		});
		if (rebuilt.ok !== true) importFailure(`re-derive of ${tld}: ${rebuilt.errors.join('; ')}`);
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
	options: { stagingDir?: string; userId?: number; conn?: DbConnDescriptor } = {},
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
	await rederiveUnresolvedModels(tlds, userId);
	const warnings = [...manifest.warnings, ...(await verifyInstalledOntologyReferences(tlds))];
	const installed = await installedCounts(tlds);
	rmSync(stagingDir, { recursive: true, force: true });
	return {
		ok: true,
		msg: `Installed ontologies: ${tlds.join(', ')} — references verified${warnings.length > 0 ? ` (${warnings.length} warnings)` : ''}`,
		installed,
		warnings,
	};
}

// ── verification ─────────────────────────────────────────────────────────────

/** One warning per (from TLD, to TLD) group of dangling dependency references. */
function danglingWarning(group: readonly OntologyReference[]): string {
	const first = group[0] as OntologyReference;
	const toTld = getTldFromTipo(first.to) ?? first.to;
	if (isCoreOntologyTld(toTld)) {
		return `'${first.fromTld}' references ${group.length} node(s) of the core ontology '${toTld}' that this installation's seed does not have — run Maintenance › Update ontology after the install to align the core`;
	}
	return `'${first.fromTld}' references ${group.length} node(s) of '${toTld}' that is not installed (${first.field}: e.g. ${first.from}→${first.to}) — install '${toTld}' too (--ontologies ${first.fromTld},${toTld}) or ask the ontology server to declare it`;
}

function groupDangling(dangling: readonly OntologyReference[]): OntologyReference[][] {
	const groups = new Map<string, OntologyReference[]>();
	for (const ref of dangling) {
		const key = `${ref.fromTld}\u0000${getTldFromTipo(ref.to) ?? ref.to}`;
		groups.set(key, [...(groups.get(key) ?? []), ref]);
	}
	return [...groups.values()];
}

/**
 * The installed TLDs' structural references that do not resolve: every
 * DEPENDENCY-class reference (ontology_references.ts — grafts and diffusion
 * relations are soft by rule) to a tipo the dd_ontology table does not hold, one warning per
 * (from, to) TLD pair, naming the remedy.
 */
export async function verifyInstalledOntologyReferences(
	tlds: readonly string[],
): Promise<string[]> {
	const rows = await readDdOntologyReferenceRows(tlds);
	const refs = referencesOfRows(rows);
	const diffusionModels = diffusionModelSet(await readDdOntologyModelParents());
	const present = await existingDdOntologyTipos(refs.map((ref) => ref.to));
	const dangling = danglingDependencies(refs, new Set(tlds), present, diffusionModels);
	return groupDangling(dangling).map(danglingWarning);
}

// ── the wizard path ──────────────────────────────────────────────────────────

/** The ontology source the RUNNING configuration names (its first ontology server, or none). */
function configuredSource(): OntologySource {
	const server = config.ontologyIo.servers[0];
	return server === undefined ? { kind: 'none' } : { kind: 'server', server: { ...server } };
}

/**
 * The install request the written configuration stands for — the wizard's
 * stage_ontologies runs in the process restarted after persist_config, so it
 * reads ACTIVE_ONTOLOGY_TLDS (core + the install order) and the configured
 * ontology servers, and re-resolves the catalog only when the vendored one does
 * not suffice.
 */
export async function ontologyRequestFromConfig(): Promise<OntologyInstallRequest> {
	if (!config.ontologyIo.activeOntologyTldsConfigured) {
		refuseInstall(
			'install.state_conflict',
			'ACTIVE_ONTOLOGY_TLDS was not written — save the configuration first',
		);
	}
	const active = config.ontologyIo.activeOntologyTlds;
	const source = configuredSource();
	const domain = active.filter((tld) => !isCoreOntologyTld(tld));
	const catalog = ontologyCatalogNeeded(domain, source, listedPolicy(domain))
		? (await resolveOntologyCatalog(source, { allowedServers: config.ontologyIo.servers })).catalog
		: vendoredOntologyCatalog();
	const { request, errors } = ontologyRequestFromActive(active, catalog);
	if (request === null) {
		refuseInstall('install.invalid_input', `Install answers invalid: ${errors.join('; ')}`);
	}
	return request;
}
