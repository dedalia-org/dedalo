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
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestFixtureTld } from '../ontology/core_tlds.ts';
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
	mergeOntologyCatalogs,
	type OntologyCatalog,
	type OntologyCatalogEntry,
	type OntologyOrigin,
	type OntologySource,
	vendoredOntologyCatalog,
} from './ontology_choice.ts';
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
export function manifestCatalog(
	manifest: Extract<ManifestResult, { ok: true }>,
	source: OntologySource,
	origin: 'local' | 'server',
): OntologyCatalog {
	const matrixDdUrl = manifest.matrixDdUrl;
	// An installation receives no test fixture: a source that exports the suite's
	// `test` TLD (a master with it registered) has it dropped here — WITHOUT a
	// warning (campaign C4 S4: the Review told every operator about a TLD that
	// was never theirs to choose). It is the master's export, not the operator's
	// answer, that carries it; --list-ontologies does not list it either.
	const offered = manifest.ontologies.filter(
		(ontology) => ontology.tld !== 'matrix' && !isTestFixtureTld(ontology.tld),
	);
	return {
		source,
		entries: offered.map((ontology) => catalogEntry(ontology, origin)),
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
	} catch (error) {
		// EACCES is not ENOENT (campaign C4 RHEL10 F1): a source behind a 0700 home
		// exists for root and not for the service user the engine steps run as.
		const code = (error as NodeJS.ErrnoException).code;
		refuseInstall(
			'install.invalid_input',
			code === 'EACCES' || code === 'EPERM'
				? `--ontology-source ${path}: permission denied for ${userInfo().username} — the engine steps read the source as that user: open the directories on the way to others (chmod o+x), or copy the source where every user can read it and pass that path`
				: `--ontology-source ${path}: no such file or directory`,
		);
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
