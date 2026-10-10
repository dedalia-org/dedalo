/**
 * RESOLVE AN INSTALL'S ONTOLOGY CATALOG — what the selected source offers,
 * merged with the vendored `oh` (ontology_choice.ts mergeOntologyCatalogs:
 * local > vendored > server). The ONE place an install source is read:
 *  - `none` (air-gapped): the vendored catalog, no I/O beyond it;
 *  - `local` (`--ontology-source`): a directory in the server export layout,
 *    or a tar archive of one (extracted first — ontology_archive.ts — into a
 *    scratch dir the returned `cleanup` removes). Its ontology.json version must
 *    be this engine's major.minor;
 *  - `server`: the configured master's manifest, fetched by
 *    src/core/ontology/ontology_manifest.ts fetchOntologyManifest (the
 *    sanctioned bounded transport behind its configured-master address policy —
 *    `allowedServers` is the plan's ONTOLOGY_SERVERS allowlist, never client
 *    text). No other fetch exists here.
 *
 * A source that cannot be read REFUSES (install.invalid_input for an operator
 * path, install.step_failed for an unreachable/refusing server) — before any
 * database write, since the front ends resolve the catalog first.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	fetchOntologyManifest,
	type ManifestOntology,
	type ManifestResult,
	readLocalOntologyManifest,
} from '../ontology/ontology_manifest.ts';
import { DEDALO_VERSION_MAJOR_MINOR } from '../update/version.ts';
import {
	type InstallAnswers,
	normalizeInstallAnswers,
	ontologyServersFor,
	ontologySourceFor,
	planCatalogNeeded,
} from './install_plan.ts';
import { extractOntologyArchive } from './ontology_archive.ts';
import {
	describeOntologyCatalog,
	mergeOntologyCatalogs,
	type OntologyCatalog,
	type OntologyCatalogEntry,
	type OntologyCatalogView,
	type OntologyOrigin,
	type OntologySource,
	ontologySourceLabel,
	vendoredOntologyCatalog,
} from './ontology_choice.ts';
import { readPriorEnv } from './prior_env.ts';
import { refuseInstall } from './refuse.ts';

/** A resolved catalog + what removes its scratch files (a no-op unless an archive was extracted). */
export interface ResolvedOntologyCatalog {
	catalog: OntologyCatalog;
	cleanup: () => void;
}

const NO_CLEANUP = (): void => undefined;

/** A manifest file reference → what the stager reads (a local path, or the URL). */
function fileOf(url: string, origin: OntologyOrigin): string {
	return origin === 'server' ? url : fileURLToPath(url);
}

function catalogEntry(ontology: ManifestOntology, origin: OntologyOrigin): OntologyCatalogEntry {
	return {
		tld: ontology.tld,
		name: ontology.name,
		name_data: ontology.name_data,
		typology_id: ontology.typology_id,
		typology_name: ontology.typology_name,
		dependencies: ontology.dependencies,
		origin,
		file: fileOf(ontology.url, origin),
	};
}

/** A parsed manifest → the source's own catalog (`matrix` is a whole-table dump, never an ontology). */
function manifestCatalog(
	manifest: Extract<ManifestResult, { ok: true }>,
	source: OntologySource,
	origin: 'local' | 'server',
): OntologyCatalog {
	const matrixDdUrl = manifest.matrixDdUrl;
	return {
		source,
		entries: manifest.ontologies
			.filter((ontology) => ontology.tld !== 'matrix')
			.map((ontology) => catalogEntry(ontology, origin)),
		matrixDd: matrixDdUrl === null ? null : { origin, file: fileOf(matrixDdUrl, origin) },
		warnings: manifest.warnings,
	};
}

/** The version a local source was exported for must be this engine's major.minor. */
function assertLocalVersion(path: string, version: string | null): void {
	const majorMinor = version?.split('.').slice(0, 2).join('.') ?? null;
	if (majorMinor === DEDALO_VERSION_MAJOR_MINOR) return;
	refuseInstall(
		'install.invalid_input',
		`--ontology-source ${path}: its ontology.json is for Dédalo ${version ?? '(no version)'} — this engine is ${DEDALO_VERSION_MAJOR_MINOR}`,
	);
}

/** A local directory or archive → its directory (an archive is extracted to a scratch dir). */
async function localDirectory(path: string): Promise<{ dir: string; cleanup: () => void }> {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		refuseInstall('install.invalid_input', `--ontology-source ${path}: no such file or directory`);
	}
	if (isDirectory) return { dir: path, cleanup: NO_CLEANUP };
	const scratch = mkdtempSync(join(tmpdir(), 'dedalo_ontology_source_'));
	const cleanup = (): void => rmSync(scratch, { recursive: true, force: true });
	try {
		await extractOntologyArchive(path, join(scratch, 'source'));
	} catch (error) {
		cleanup();
		throw error;
	}
	return { dir: join(scratch, 'source'), cleanup };
}

async function resolveLocal(
	source: Extract<OntologySource, { kind: 'local' }>,
): Promise<ResolvedOntologyCatalog> {
	const local = await localDirectory(source.path);
	const manifest = readLocalOntologyManifest(local.dir);
	if (!manifest.ok) {
		local.cleanup();
		refuseInstall('install.invalid_input', `--ontology-source ${source.path}: ${manifest.reason}`);
	}
	try {
		assertLocalVersion(source.path, manifest.version);
	} catch (error) {
		local.cleanup();
		throw error;
	}
	return { catalog: manifestCatalog(manifest, source, 'local'), cleanup: local.cleanup };
}

async function resolveServer(
	source: Extract<OntologySource, { kind: 'server' }>,
	allowedServers: readonly { url: string }[],
): Promise<ResolvedOntologyCatalog> {
	const manifest = await fetchOntologyManifest(source.server, allowedServers);
	if (!manifest.ok) {
		refuseInstall(
			'install.step_failed',
			`ontology server '${source.server.name}': ${manifest.reason}`,
		);
	}
	return { catalog: manifestCatalog(manifest, source, 'server'), cleanup: NO_CLEANUP };
}

async function resolveSource(
	source: OntologySource,
	allowedServers: readonly { url: string }[],
): Promise<ResolvedOntologyCatalog> {
	if (source.kind === 'local') return resolveLocal(source);
	if (source.kind === 'server') return resolveServer(source, allowedServers);
	return { catalog: vendoredOntologyCatalog(), cleanup: NO_CLEANUP };
}

/**
 * The catalog of `source`, merged with the vendored one. `allowedServers` =
 * the ONTOLOGY_SERVERS allowlist the manifest URL must be exactly one of.
 * Call `cleanup` when the catalog's files are no longer needed (after staging).
 */
export async function resolveOntologyCatalog(
	source: OntologySource,
	options: { allowedServers: readonly { url: string }[] },
): Promise<ResolvedOntologyCatalog> {
	const resolved = await resolveSource(source, options.allowedServers);
	return {
		catalog: mergeOntologyCatalogs(resolved.catalog, vendoredOntologyCatalog()),
		cleanup: resolved.cleanup,
	};
}

/**
 * The catalog the plan of `raw` answers needs, or undefined when the vendored
 * one suffices. METADATA ONLY (persist_config needs the closure, not the files):
 * an extracted archive is removed before returning — staging re-resolves.
 */
export async function resolvePlanCatalog(
	raw: Readonly<Record<string, unknown>>,
	priorEnv: Readonly<Record<string, string>>,
): Promise<OntologyCatalog | undefined> {
	const answers: InstallAnswers = normalizeInstallAnswers(raw).answers;
	const source = ontologySourceFor(answers, priorEnv);
	if (!planCatalogNeeded(answers, source)) return undefined;
	const resolved = await resolveOntologyCatalog(source, {
		allowedServers: ontologyServersFor(answers, priorEnv),
	});
	resolved.cleanup();
	return resolved.catalog;
}

/** The wizard's get_ontology_catalog answer (a PROBE: `ok` is the verdict, `data` on the wire). */
export interface OntologyCatalogProbeResult {
	ok: boolean;
	msg: string;
	catalog: OntologyCatalogView;
	warnings: string[];
}

function offlineProbe(ok: boolean, msg: string): OntologyCatalogProbeResult {
	const catalog = describeOntologyCatalog(vendoredOntologyCatalog());
	return { ok, msg, catalog, warnings: catalog.warnings };
}

/**
 * What the wizard's Ontologies screen offers. `updateServers` false (the
 * air-gapped box) → the built-in view, no network. True → the catalog of the
 * server the install will configure (ontologySourceFor: a preserved custom list's
 * first entry, else the official master), merged with the built-in one; when
 * it cannot be read the answer is `ok: false` with the reason, and the
 * built-in view so the operator can still install `oh`.
 */
export async function ontologyCatalogProbe(
	updateServers: boolean,
): Promise<OntologyCatalogProbeResult> {
	if (!updateServers)
		return offlineProbe(true, 'Air-gapped: only the built-in ontologies are offered');
	const prior = await readPriorEnv();
	const answers = { update_servers: 'official', ontology_source: '' } as const;
	const source = ontologySourceFor(answers, prior);
	try {
		const { catalog } = await resolveOntologyCatalog(source, {
			allowedServers: ontologyServersFor(answers, prior),
		});
		const view = describeOntologyCatalog(catalog);
		return {
			ok: true,
			msg: `Ontologies offered by ${ontologySourceLabel(source)}`,
			catalog: view,
			warnings: view.warnings,
		};
	} catch (error) {
		return offlineProbe(false, (error as Error).message);
	}
}
