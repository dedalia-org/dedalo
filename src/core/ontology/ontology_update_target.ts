/**
 * Two pure-ish halves of the UPDATE_PROCESS Phase 2 orchestrator
 * (`ontology_update.ts` updateOntology), extracted so they are reachable
 * WITHOUT the ONTOLOGY_SERVERS / IS_AN_ONTOLOGY_SERVER config the live
 * orchestrator returns on:
 *
 *   1. resolveUpdateTarget  — WC-023 D5: the network target is re-resolved
 *      from the CONFIG catalog by origin; the client-supplied `server.url`
 *      only selects a configured entry — an unlisted origin is refused.
 *   2. stageOntologyFiles   — Phase A: download (or copy, for a local master)
 *      every manifest file into the staging dir, gunzip under caps, sanity
 *      check the COPY payload, and build the StagedFile list. Wholly
 *      non-destructive and fully abortable — nothing here touches the DB.
 *
 * `stageOntologyFiles` RECOMPUTES each file's `section_tipo` from its tld
 * (`es` → `es0`, `matrix_dd` → `matrix_dd`): the options schema still accepts
 * a client `section_tipo`, so honouring it would let an `es` package aim its
 * scoped DELETE at `dd0`. The recompute is the guard.
 */

import { cpSync, statSync } from 'node:fs';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import {
	confinedPath,
	copySanityCheck,
	downloadRemoteOntologyFile,
	gunzipWithCaps,
} from './data_io_import.ts';
import { normalizeOntologyDependencies, type OntologyDependency } from './ontology_dependencies.ts';

/** One manifest entry as the client sends it (updateOntologyOptionsSchema shape). */
export interface OntologyUpdateFile {
	tld: string;
	/** Accepted by the schema but IGNORED — recomputed from `tld`. */
	section_tipo?: string | undefined;
	url: string;
	typology_id?: number | string | null | undefined;
	name_data?: unknown;
	/**
	 * The manifest's declared dependencies (`info.active_ontologies[i].dependencies`),
	 * forwarded as the source declared them (`{tld, main, mandatory}` objects);
	 * absent = NOT declared. Normalized by the stager (ontology_dependencies.ts
	 * normalizeOntologyDependencies — WC-2026-10-10-ontology-dependencies-hierarchy60).
	 */
	dependencies?: unknown;
}

export interface StagedFile {
	tld: string;
	/** RECOMPUTED from the tld — never the client's value. */
	sectionTipo: string;
	/** Decompressed, sanity-checked `.copy` payload ready for \copy. */
	stagedPath: string;
	typologyId?: number | string | null;
	nameData?: unknown;
	/**
	 * Declared dependencies (normalized); null = not declared — the import leaves
	 * the registry row's hierarchy60 as it is.
	 */
	dependencies?: OntologyDependency[] | null;
}

/** The config catalog slice resolveUpdateTarget adjudicates against. */
export interface OntologyUpdateCatalog {
	readonly servers: readonly { readonly code: string; readonly url: string }[];
	readonly isOntologyServer: boolean;
}

export interface UpdateTarget {
	isLocal: boolean;
	configuredOrigin: string | null;
}

/**
 * Match the client-selected server against the configured catalog by the
 * ORIGIN of its url, or accept the `localhost` pseudo-server when this
 * instance is itself an ontology master. Returns the resolved target, or the
 * refusal (`error` + the operator-facing `msg`).
 *
 * Never by code: masters routinely share one access code, and `find` by code
 * handed the FIRST such entry's origin to a panel that had picked another —
 * every file then refused with an "origin mismatch". The origin is exactly
 * what the target yields (the download pin), so origin identity is both
 * unambiguous and sufficient. The client url only SELECTS among configured
 * entries; the returned origin is the catalog's, so an unlisted host is
 * refused, never reached (D5).
 */
export function resolveUpdateTarget(
	server: { name: string; url: string; code: string },
	catalog: OntologyUpdateCatalog,
): UpdateTarget | { error: string; msg: string } {
	if (server.code === 'localhost' && catalog.isOntologyServer) {
		return { isLocal: true, configuredOrigin: null };
	}
	const selected = originOf(server.url);
	const configured =
		selected === null
			? undefined
			: catalog.servers.find((entry) => originOf(entry.url) === selected);
	if (configured === undefined) {
		return {
			error: `unknown ontology server: ${selected ?? server.url}`,
			msg: 'Error. The selected server is not configured on this instance',
		};
	}
	return { isLocal: false, configuredOrigin: selected };
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/**
 * Phase A — stage EVERY manifest file (non-destructive, fully abortable).
 * The caller owns the staging dir lifecycle (create before, remove after).
 * Failure returns `{errors, msg?}`; a missing `msg` means the caller keeps its
 * current message (PHP/TS parity with the inline original).
 */
export async function stageOntologyFiles(
	files: readonly OntologyUpdateFile[],
	target: UpdateTarget,
	dirs: { ioPath: string; stagingDir: string },
): Promise<{ staged: StagedFile[]; messages: string[] } | { errors: string[]; msg?: string }> {
	const { isLocal, configuredOrigin } = target;
	const { ioPath, stagingDir } = dirs;
	const messages: string[] = [];
	const staged: StagedFile[] = [];
	const seenTlds = new Set<string>();
	for (const file of files) {
		if (seenTlds.has(file.tld)) {
			return { errors: [`duplicate tld in file list: ${file.tld}`] };
		}
		seenTlds.add(file.tld);
		const expectedBasename = `${file.tld}.copy.gz`;
		const gzPath = confinedPath(stagingDir, expectedBasename);
		if (gzPath === null) {
			return { errors: [`unconfined staging name: ${expectedBasename}`] };
		}
		if (isLocal) {
			// Local-package source: the files already sit in the IO dir —
			// no self-HTTP round trip (wire-invisible shortcut).
			const source = confinedPath(ioPath, expectedBasename);
			if (source === null || !statSafe(source)) {
				return {
					errors: [`local ontology file missing: ${expectedBasename}`],
					msg: `Error. Local ontology file missing: ${expectedBasename}`,
				};
			}
			cpSync(source, gzPath);
		} else {
			const downloaded = await downloadRemoteOntologyFile({
				url: file.url,
				configuredOrigin: configuredOrigin as string,
				expectedBasename,
				targetDir: stagingDir,
			});
			messages.push(downloaded.msg);
			if (downloaded.ok !== true) {
				return {
					errors: [...downloaded.errors],
					msg: `Error. Download failed for ${expectedBasename}`,
				};
			}
		}
		const stagedPath = gzPath.slice(0, -'.gz'.length);
		await gunzipWithCaps(gzPath, stagedPath);
		const sanity = copySanityCheck(stagedPath, MATRIX_COPY_COLUMNS.length);
		if (sanity !== null) {
			return {
				errors: [`${expectedBasename}: ${sanity}`],
				msg: `Error. Staged file failed validation: ${expectedBasename}`,
			};
		}
		staged.push({
			tld: file.tld,
			sectionTipo: file.tld === 'matrix_dd' ? 'matrix_dd' : `${file.tld}0`,
			stagedPath,
			typologyId: file.typology_id ?? null,
			nameData: file.name_data ?? null,
			dependencies: stagedDependencies(file, messages),
		});
	}
	return { staged, messages };
}

/** A file's declared dependencies, normalized (notes into `messages`); matrix_dd declares none. */
function stagedDependencies(
	file: OntologyUpdateFile,
	messages: string[],
): OntologyDependency[] | null {
	if (file.tld === 'matrix_dd') return null;
	return normalizeOntologyDependencies(file.tld, file.dependencies, messages);
}

function statSafe(path: string): boolean {
	try {
		return statSync(path).size >= 0;
	} catch {
		return false;
	}
}
