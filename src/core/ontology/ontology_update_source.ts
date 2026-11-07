/**
 * THE ONTOLOGY UPDATE'S SOURCE, held by the SERVER (update audit 2026-10-29,
 * U-08 / U-41; owner decisions D-4, D-8, D-10).
 *
 * The panel fetched the master's manifest and sent the file list; the engine
 * re-resolved the server (WC-023 D5) but took each file's URL and declared
 * dependencies from the browser, and never asked whether the master's ontology
 * belongs to this install's data model. Now, before any latch or staging:
 *
 *  1. the engine reads the master's manifest ITSELF (the configured server's
 *     `get_ontology_update_info`, or this master's own export dir);
 *  2. the ontology version it names must be on THIS data model — the code's
 *     and the database's (version_contract.ts ontologyCompatibility): a master
 *     on a newer line, or a database still behind its code, is refused;
 *  3. every requested file must be one the manifest lists, at the manifest's
 *     URL — the browser relays TLDs, the manifest supplies URL, typology, names
 *     and dependencies;
 *  4. each file carries the manifest's sha256 (`info.files_sha256`, U-41), so
 *     the stager refuses bytes the master did not export. A master that
 *     publishes no digests (older) is accepted, with ONE warning per run.
 *
 * Refusals are `update.refused` with `coordinates.rule`, raised before anything
 * is fetched or written. Seams (`readManifest`, `installedDataVersion`) let a
 * gate take every branch without a network or a particular database.
 */

import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { readInstalledDataVersionStrict } from '../area_maintenance/backup.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { DEDALO_VERSION_MAJOR_MINOR } from '../update/version.ts';
import { ontologyCompatibility } from '../update/version_contract.ts';
import {
	fetchOntologyManifest,
	type ManifestResult,
	readLocalOntologyManifest,
} from './ontology_manifest.ts';
import {
	findConfiguredServer,
	type OntologyUpdateCatalog,
	type OntologyUpdateFile,
	type UpdateTarget,
} from './ontology_update_target.ts';

/** The seams of the source check; production passes none. */
export interface OntologySourceDeps {
	/** Read the selected master's manifest. */
	readManifest?: (target: UpdateTarget) => Promise<ManifestResult>;
	/** The installed data version (matrix_updates). */
	installedDataVersion?: () => Promise<number[]>;
	/** Base of this master's own export dir (a local target). */
	ioBaseDir?: string;
	/**
	 * Not a seam — the run's MODE: the operator picked this master and these
	 * TLDs in the panel. Any TLD the picked master lists may come from it, so
	 * the one-source-per-TLD map (D-8) is not applied; it binds the unattended
	 * run only (see assertSourceAssignment).
	 */
	operatorPicked?: boolean;
}

function refuse(rule: string, sentence: string): never {
	throw new DedaloError('update.refused', {
		message: `ontology update refused (${rule}): ${sentence}`,
		publicMessage: sentence,
		coordinates: { rule },
	});
}

/** The production manifest reader: this master's own export, or the configured server's. */
function defaultManifestReader(
	catalog: OntologyUpdateCatalog,
	ioBaseDir: string | undefined,
): (target: UpdateTarget) => Promise<ManifestResult> {
	return async (target) => {
		if (target.isLocal) {
			const base = ioBaseDir ?? config.ops.ontologyDataIoDir;
			return readLocalOntologyManifest(join(base, DEDALO_VERSION_MAJOR_MINOR));
		}
		const server = selectedServer(catalog, target);
		if (server === undefined) return { ok: false, reason: 'the selected server is not configured' };
		return fetchOntologyManifest(
			{ name: server.url, url: server.url, code: server.code },
			catalog.servers,
		);
	};
}

/** The configured entry the target names: by exact url, else (an installer target) by origin. */
function selectedServer(
	catalog: OntologyUpdateCatalog,
	target: UpdateTarget,
): OntologyUpdateCatalog['servers'][number] | undefined {
	if (target.configuredUrl !== undefined)
		return findConfiguredServer(catalog, target.configuredUrl);
	return catalog.servers.find((entry) => originOf(entry.url) === target.configuredOrigin);
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function sameUrl(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return false;
	}
}

/**
 * Each requested file rebuilt from the manifest's own entry (URL, names,
 * typology, dependencies). A LOCAL target compares no URL: its manifest names
 * the export dir as `file://` while the panel was handed the public http one,
 * and staging copies `<tld>.copy.gz` from that dir by name — the URL is unread.
 */
function filesFromManifest(
	files: readonly OntologyUpdateFile[],
	manifest: Extract<ManifestResult, { ok: true }>,
	isLocal: boolean,
): OntologyUpdateFile[] {
	const listedAt = (listed: string | null | undefined, requested: string) =>
		listed !== null && listed !== undefined && (isLocal || sameUrl(listed, requested));
	return files.map((file) => {
		if (file.tld === 'matrix_dd') {
			if (!listedAt(manifest.matrixDdUrl, file.url)) {
				refuse(
					'file_not_in_manifest',
					"the master's manifest does not list the shared value lists at that URL",
				);
			}
			return {
				tld: file.tld,
				url: manifest.matrixDdUrl as string,
				...withSha256(manifest.matrixDdSha256),
			};
		}
		const entry = manifest.ontologies.find((ontology) => ontology.tld === file.tld);
		if (entry === undefined || !listedAt(entry.url, file.url)) {
			refuse('file_not_in_manifest', `the master's manifest does not list ${file.tld} at that URL`);
		}
		return {
			tld: entry.tld,
			url: entry.url,
			typology_id: entry.typology_id,
			name_data: entry.name_data,
			...(entry.dependencies === null ? {} : { dependencies: entry.dependencies }),
			...withSha256(entry.sha256),
		};
	});
}

/** `{sha256}` when the manifest names one (absent ≠ empty). */
function withSha256(sha256: string | undefined): { sha256?: string } {
	return sha256 === undefined ? {} : { sha256 };
}

/**
 * ONE warning per run when the master publishes no digest for some file (an
 * older master): those bytes are staged unverified — the pre-U-41 behaviour.
 */
function warnUnverified(files: readonly OntologyUpdateFile[], target: UpdateTarget): void {
	const unverified = files.filter((file) => file.sha256 === undefined).map((file) => file.tld);
	if (unverified.length === 0) return;
	const master = target.isLocal ? "this master's own export" : (target.configuredOrigin ?? '?');
	console.warn(
		`[ontology_update] ${master} publishes no sha256 for ${unverified.join(', ')}: staged UNVERIFIED (an older master — re-export it to publish digests)`,
	);
}

/**
 * The masters an UNATTENDED run takes from (D-8): those that declare `tlds`,
 * each for its declared TLDs; when none declares, the FIRST configured master
 * serves everything (the installer's primary). The other masters are reachable
 * only by an operator's pick in the panel.
 */
export function unattendedSources(
	servers: OntologyUpdateCatalog['servers'],
): OntologyUpdateCatalog['servers'] {
	const declared = servers.filter((entry) => entry.tlds !== undefined);
	return declared.length > 0 ? declared : servers.slice(0, 1);
}

/**
 * D-8 — in an UNATTENDED run each shared TLD comes from exactly one source:
 * the selected master must be one of {@link unattendedSources}, and every
 * requested TLD must be declared by it alone (an undeclared single primary
 * serves them all). An operator's pick (`picked`) is not mapped: any TLD the
 * picked master lists may come from it. A local target (this install is the
 * master) exports its own TLDs and is not sourced.
 */
export function assertSourceAssignment(
	files: readonly { readonly tld: string }[],
	target: UpdateTarget,
	catalog: OntologyUpdateCatalog,
	picked = false,
): void {
	if (target.isLocal || picked) return;
	const sources = unattendedSources(catalog.servers);
	const selected = unattendedSelected(sources, catalog, target);
	if (selected.tlds === undefined) return;
	for (const { tld } of files) {
		const owners = sources.filter((entry) => entry.tlds?.includes(tld)).map((entry) => entry.url);
		const refusal = sourceRefusal(tld, owners, selected.url);
		if (refusal !== null) refuse(refusal.rule, refusal.sentence);
	}
}

/** The selected master among the unattended sources; refused when it is not one. */
function unattendedSelected(
	sources: OntologyUpdateCatalog['servers'],
	catalog: OntologyUpdateCatalog,
	target: UpdateTarget,
): OntologyUpdateCatalog['servers'][number] {
	const selected = selectedServer({ ...catalog, servers: sources }, target);
	if (selected !== undefined) return selected;
	return refuse(
		'source_unassigned',
		'the selected master is not a source of the unattended update (declare its tlds in ONTOLOGY_SERVERS, or pick it in the panel)',
	);
}

/** Why `tld` may not come from `selected`, given the masters that list it; null = it may. */
function sourceRefusal(
	tld: string,
	owners: readonly string[],
	selected: string | undefined,
): { rule: string; sentence: string } | null {
	if (owners.length === 0)
		return { rule: 'source_mismatch', sentence: `no configured master lists ${tld} in its tlds` };
	if (owners.length > 1) {
		return {
			rule: 'source_ambiguous',
			sentence: `${tld} is listed by several masters (${owners.join(', ')}) — one source per TLD`,
		};
	}
	return owners[0] === selected
		? null
		: {
				rule: 'source_mismatch',
				sentence: `${tld} comes from ${owners[0]}, not from the selected master`,
			};
}

/**
 * Read the master's manifest, refuse an ontology on another data model, and
 * return the requested files as the MANIFEST describes them. Throws
 * `update.refused` (coordinates.rule) — before any latch, download or write.
 */
export async function resolveOntologySource(
	files: readonly OntologyUpdateFile[],
	target: UpdateTarget,
	catalog: OntologyUpdateCatalog,
	deps: OntologySourceDeps = {},
): Promise<OntologyUpdateFile[]> {
	assertSourceAssignment(files, target, catalog, deps.operatorPicked === true);
	const read = deps.readManifest ?? defaultManifestReader(catalog, deps.ioBaseDir);
	const manifest = await read(target);
	if (!manifest.ok)
		refuse(
			'manifest_unreadable',
			`the master's ontology manifest cannot be read: ${manifest.reason}`,
		);
	const installed = await (deps.installedDataVersion ?? readInstalledDataVersionStrict)().catch(
		(error: unknown): never => {
			// The refusal is PUBLIC (update.refused): the database's own text stays in the log.
			console.error('[ontology_update] the installed data version cannot be read:', error);
			return refuse(
				'installed_version_unreadable',
				'the installed data version cannot be read (see the server log)',
			);
		},
	);
	const verdict = ontologyCompatibility(manifest.version, installed);
	if (!verdict.ok) refuse(verdict.refusal ?? 'ontology_model_mismatch', verdict.detail);
	const resolved = filesFromManifest(files, manifest, target.isLocal);
	warnUnverified(resolved, target);
	return resolved;
}
