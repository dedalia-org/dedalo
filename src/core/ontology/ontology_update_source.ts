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
import type {
	OntologyUpdateCatalog,
	OntologyUpdateFile,
	UpdateTarget,
} from './ontology_update_target.ts';

/** The seams of the source check; production passes none. */
export interface OntologySourceDeps {
	/** Read the selected master's manifest. */
	readManifest?: (target: UpdateTarget) => Promise<ManifestResult>;
	/** The installed data version (matrix_updates). */
	installedDataVersion?: () => Promise<number[]>;
	/** Base of this master's own export dir (a local target). */
	ioBaseDir?: string;
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
		const server = catalog.servers.find((entry) => originOf(entry.url) === target.configuredOrigin);
		if (server === undefined) return { ok: false, reason: 'the selected server is not configured' };
		return fetchOntologyManifest(
			{ name: server.url, url: server.url, code: server.code },
			catalog.servers,
		);
	};
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
 * D-8 — EACH SHARED TLD COMES FROM EXACTLY ONE SOURCE. With one configured
 * master and no `tlds`, everything comes from it. Otherwise every requested
 * TLD must be listed by exactly one master — the selected one. A local target
 * (this install is the master) exports its own TLDs and is not sourced.
 */
export function assertSourceAssignment(
	files: readonly { readonly tld: string }[],
	target: UpdateTarget,
	catalog: OntologyUpdateCatalog,
): void {
	if (target.isLocal) return;
	const servers = catalog.servers;
	const selected = servers.find((entry) => originOf(entry.url) === target.configuredOrigin);
	const authoring = authoringMasterRefusal(catalog);
	if (authoring !== null) refuse('source_unassigned', authoring);
	// An ontology server never takes "everything" from one remote: the single-
	// source shortcut below is for ordinary installs only.
	if (!catalog.isOntologyServer && servers.length === 1 && selected?.tlds === undefined) return;
	requireDeclaredSources(servers);
	for (const { tld } of files) {
		const owners = servers.filter((entry) => entry.tlds?.includes(tld)).map((entry) => entry.url);
		const refusal = sourceRefusal(tld, owners, selected?.url);
		if (refusal !== null) refuse(refusal.rule, refusal.sentence);
	}
}

/**
 * An ontology SERVER (an authoring master) that lists remote providers takes
 * from them ONLY the TLDs each entry names: an entry without `tlds` (absent or
 * empty) would let a remote replace the master's whole authored ontology by
 * accident, so it is refused. Null = nothing to refuse (no entries, not a
 * server, or every entry declares). Shared by the update door and the run's
 * ontology phase (run/ontology_phase.ts).
 */
export function authoringMasterRefusal(catalog: OntologyUpdateCatalog): string | null {
	if (!catalog.isOntologyServer) return null;
	const undeclared = catalog.servers
		.filter((entry) => entry.tlds === undefined || entry.tlds.length === 0)
		.map((entry) => entry.url);
	if (undeclared.length === 0) return null;
	return `this install is an ontology server: each ONTOLOGY_SERVERS entry must list the TLDs it provides in tlds, so a remote never replaces the whole authored ontology (missing for ${undeclared.join(', ')})`;
}

/** With several masters, every one declares its tlds. */
function requireDeclaredSources(servers: OntologyUpdateCatalog['servers']): void {
	const undeclared = servers.filter((entry) => entry.tlds === undefined).map((entry) => entry.url);
	if (undeclared.length === 0) return;
	refuse(
		'source_unassigned',
		`several ontology masters are configured: each needs its tlds in ONTOLOGY_SERVERS (missing for ${undeclared.join(', ')})`,
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
	assertSourceAssignment(files, target, catalog);
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
