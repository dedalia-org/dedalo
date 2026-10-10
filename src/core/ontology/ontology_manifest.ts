/**
 * THE ONTOLOGY MANIFEST, CLIENT SIDE — read an ontology source's catalog (which
 * TLDs it offers, their metadata and their DECLARED dependencies) on the
 * SERVER, for the installer (CLI and wizard) and anything else that must choose
 * ontologies before importing them.
 *
 * The manifest is what the master builds (data_io_import.ts
 * buildOntologyUpdateInfo, served by dd_utils_api.get_ontology_update_info):
 * `{info: ontology.json verbatim, files: [{tld, section_tipo, url}]}`.
 * `info.active_ontologies[i].dependencies` — `{tld, main, mandatory}` objects
 * (main `ontology35` = the TLD's ontology, `hierarchy1` = its thesaurus) — is
 * present only when the master DECLARES them (registry field hierarchy60 —
 * WC-2026-10-10-ontology-dependencies-hierarchy60); ABSENT means "not
 * declared" (an older server, or a registry row without the field) and is
 * reported as `null` here, never as `[]`, so a caller cannot mistake it for
 * "needs nothing". The list goes through THE shared normalizer
 * (ontology_dependencies.ts normalizeOntologyDependencies — the one the
 * master's export applies too): a bad item is a WARNING, never a refused
 * manifest.
 *
 * TWO SOURCES, ONE PARSER:
 *   - a local directory in the server export layout (`ontology.json` +
 *     `<tld>.copy.gz` [+ `matrix_dd.copy.gz`]): readLocalOntologyManifest reuses
 *     the master's own builder with a `file://` base;
 *   - a configured master: fetchOntologyManifest.
 *
 * THE NETWORK CALL (engineering/OUTBOUND_SPEC.md §2): `fetchBoundedText`, the
 * transport core without the public-address policy — a master on the
 * institution's LAN is legitimate — behind THIS module's NAMED policy,
 * `assertConfiguredMasterUrl`: the URL must be EXACTLY a configured master API
 * URL (operator configuration: ONTOLOGY_SERVERS or the plan's official
 * constant), never client text. Explicit total deadline and byte ceiling; any
 * redirect refused; failures reported in words that never echo an address.
 * Census: test/unit/outbound_fetch_tripwire.test.ts (ADDRESS_POLICY).
 */

import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DedaloError } from '../errors/index.ts';
import { fetchBoundedText } from '../security/ssrf_guard.ts';
import { DEDALO_VERSION } from '../update/version.ts';
import {
	assertTlsVerificationOn,
	buildOntologyUpdateInfo,
	type ManifestFileItem,
	manifestFileItemSchema,
} from './data_io_import.ts';
import { normalizeOntologyDependencies, type OntologyDependency } from './ontology_dependencies.ts';

/** Total deadline of the manifest request. */
export const MANIFEST_TIMEOUT_MS = 30_000;
/** Byte ceiling of the manifest body (ontology.json name_data grows per language). */
export const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

const activeOntologySchema = z
	.object({
		tld: z.string(),
		name: z.string().nullable().optional(),
		name_data: z.unknown().optional(),
		typology_id: z.union([z.number(), z.string()]).nullable().optional(),
		typology_name: z.string().nullable().optional(),
		// Normalized by hand (normalizeOntologyDependencies): a bad item is a WARNING, not a refused manifest.
		dependencies: z.unknown().optional(),
	})
	.passthrough();

/** The manifest wire shape (the `data` of get_ontology_update_info). */
export const ontologyManifestSchema = z.object({
	info: z
		.object({
			version: z.string().optional(),
			active_ontologies: z.array(activeOntologySchema).optional(),
		})
		.passthrough()
		.nullable(),
	files: z.array(manifestFileItemSchema),
});

/** One ontology a source offers. */
export interface ManifestOntology {
	tld: string;
	name: string;
	name_data: unknown;
	typology_id: number | string | null;
	typology_name: string | null;
	/** Declared dependencies (normalized `{tld, main, mandatory}`); null = NOT declared. */
	dependencies: OntologyDependency[] | null;
	/** The file's URL (`file://` for a local source). */
	url: string;
}

export type ManifestResult =
	| {
			ok: true;
			version: string | null;
			ontologies: ManifestOntology[];
			/** The private-lists file (matrix_dd.copy.gz), when the source ships one. */
			matrixDdUrl: string | null;
			warnings: string[];
	  }
	| { ok: false; reason: string };

type ActiveOntology = z.infer<typeof activeOntologySchema>;

const TLD_RE = /^[a-z]{2,}$/;

/** info.active_ontologies by (lowercased) TLD. */
function infoByTld(
	info: { active_ontologies?: ActiveOntology[] } | null,
): Map<string, ActiveOntology> {
	const byTld = new Map<string, ActiveOntology>();
	for (const entry of info?.active_ontologies ?? [])
		byTld.set(entry.tld.trim().toLowerCase(), entry);
	return byTld;
}

/** One file + its metadata (or the bare-TLD fallback, warned). */
function manifestOntology(
	file: ManifestFileItem,
	meta: ActiveOntology | undefined,
	warnings: string[],
): ManifestOntology {
	if (meta === undefined) {
		warnings.push(`the manifest lists '${file.tld}' without metadata (no active_ontologies entry)`);
		return { ...bareOntology(file.tld), url: file.url };
	}
	return {
		tld: file.tld,
		name: meta.name ?? file.tld,
		name_data: meta.name_data ?? null,
		typology_id: meta.typology_id ?? null,
		typology_name: meta.typology_name ?? null,
		dependencies: normalizeOntologyDependencies(file.tld, meta.dependencies, warnings),
		url: file.url,
	};
}

function bareOntology(tld: string): Omit<ManifestOntology, 'url'> {
	return {
		tld,
		name: tld,
		name_data: null,
		typology_id: null,
		typology_name: null,
		dependencies: null,
	};
}

/** The first schema issue, as a path + message (never the payload itself). */
function shapeReason(error: z.ZodError): string {
	const issue = error.issues[0];
	const path = issue?.path.join('.') || '(root)';
	return `the manifest does not have the expected shape (${path}: ${issue?.message ?? 'invalid'})`;
}

/**
 * Parse a manifest (`{info, files}`): the files joined with their info entries by
 * TLD. Non-TLD files are not ontologies: `matrix` is dropped, `matrix_dd`
 * becomes `matrixDdUrl`. A file without an info entry is offered under its bare
 * TLD, with a warning.
 */
export function parseOntologyManifest(raw: unknown): ManifestResult {
	const parsed = ontologyManifestSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, reason: shapeReason(parsed.error) };
	const { info, files } = parsed.data;
	const metadata = infoByTld(info);
	const warnings: string[] = [];
	const ontologies = files
		.filter((file) => TLD_RE.test(file.tld))
		.map((file) => manifestOntology(file, metadata.get(file.tld), warnings));
	return {
		ok: true,
		version: info?.version ?? null,
		ontologies,
		matrixDdUrl: files.find((file) => file.tld === 'matrix_dd')?.url ?? null,
		warnings,
	};
}

/**
 * The manifest of a local directory in the server export layout, built by the
 * master's own builder with a `file://` base (so every `url` is a file URL).
 */
export function readLocalOntologyManifest(dir: string): ManifestResult {
	let built: ReturnType<typeof buildOntologyUpdateInfo>;
	try {
		built = buildOntologyUpdateInfo(dir, pathToFileURL(dir).href);
	} catch (error) {
		return {
			ok: false,
			reason: `the ontology directory cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`,
		};
	}
	return parseOntologyManifest(built.data);
}

// ---------------------------------------------------------------------------
// the network source
// ---------------------------------------------------------------------------

/** A URL in its normalized form, or null when it does not parse. */
function normalizedUrl(url: string): string | null {
	try {
		return new URL(url).href;
	} catch {
		return null;
	}
}

/**
 * THE ADDRESS POLICY of this module: `url` must be EXACTLY (after URL
 * normalization) one of the `allowed` configured master URLs. Throws
 * `internal.invariant` otherwise — a caller that passes anything else has a
 * bug, never a user error (the URL is operator configuration, not request text).
 */
export function assertConfiguredMasterUrl(url: string, allowed: readonly { url: string }[]): void {
	const target = normalizedUrl(url);
	const configured = allowed.some(
		(entry) => target !== null && normalizedUrl(entry.url) === target,
	);
	if (!configured) {
		throw new DedaloError('internal.invariant', {
			message: 'ontology manifest: the URL is not a configured ontology server',
		});
	}
}

/** A thrown transport failure, in words that never echo an address. */
function failureReason(serverName: string, error: unknown): string {
	const coordinates = (error as { coordinates?: { status?: unknown; reason?: unknown } })
		.coordinates;
	const status = coordinates?.status;
	if (status === 403) {
		return `HTTP 403 — the ontology server '${serverName}' refused this request (access code or Dédalo version not accepted)`;
	}
	if (typeof status === 'number') return `unreachable (HTTP ${status})`;
	return `unreachable (${typeof coordinates?.reason === 'string' ? coordinates.reason : 'transport'})`;
}

/** The envelope's failure message, when it carries a usable one. */
function envelopeFailure(envelope: { error?: { message?: unknown } }): string {
	const message = envelope.error?.message;
	return typeof message === 'string' && message !== ''
		? message
		: 'the ontology server refused the request';
}

/** An envelope-v2 body → the parsed manifest, or the server's refusal. */
function manifestFromBody(text: string): ManifestResult {
	let envelope: { ok?: unknown; data?: unknown; error?: { message?: unknown } };
	try {
		envelope = JSON.parse(text) as typeof envelope;
	} catch {
		return { ok: false, reason: 'the ontology server answered something that is not JSON' };
	}
	if (envelope?.ok === true) return parseOntologyManifest(envelope.data);
	if (envelope?.ok === false) return { ok: false, reason: envelopeFailure(envelope) };
	return { ok: false, reason: 'the ontology server answered an unrecognised envelope' };
}

/**
 * Fetch and parse a configured master's manifest
 * (`dd_utils_api.get_ontology_update_info`, this engine's version + the
 * server's access code). Refuses BEFORE any socket when `server.url` is not one
 * of `allowed` (assertConfiguredMasterUrl). Never throws for a network or server
 * failure: `{ok:false, reason}`.
 */
export async function fetchOntologyManifest(
	server: { name: string; url: string; code: string },
	allowed: readonly { url: string }[],
	options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ManifestResult> {
	assertTlsVerificationOn();
	const body = JSON.stringify({
		dd_api: 'dd_utils_api',
		action: 'get_ontology_update_info',
		options: { version: DEDALO_VERSION, code: server.code },
	});
	let text: string;
	assertConfiguredMasterUrl(server.url, allowed);
	try {
		text = await fetchBoundedText(server.url, {
			init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
			timeoutMs: options.timeoutMs ?? MANIFEST_TIMEOUT_MS,
			maxBytes: options.maxBytes ?? MANIFEST_MAX_BYTES,
		});
	} catch (error) {
		return { ok: false, reason: failureReason(server.name, error) };
	}
	return manifestFromBody(text);
}
