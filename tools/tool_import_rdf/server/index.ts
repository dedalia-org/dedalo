/**
 * tool_import_rdf server module (v6 tool_import_rdf::get_rdf_data). Dereferences
 * each IRI the cataloguer selected through the HARVESTING DOOR (`harvestFetch`,
 * src/core/harvest/harvest.ts) — every redirect hop re-vetted and pinned, the
 * site's robots.txt obeyed, the per-site pace kept — reads the RDF/XML graph
 * (core/tools/rdf_graph.ts, no 3rd-party lib), maps it through the EXTERNAL
 * ONTOLOGY (`ontology_tipo`, a node of model `external_ontology`: its xmlns, its
 * owl:Class / owl:ObjectProperty children) and WRITES the result into the caller
 * record and the records it links to (rdf_import_run.ts → rdf_import_plan.ts →
 * rdf_import_execute.ts): fill empty fields, append IRIs and links, never
 * overwrite; linked terms matched first and fetched only when new; one dd800
 * bulk process per call, so the import is revertable.
 *
 * Linked-data servers answer an IRI with a 303 See Other (content negotiation) or a
 * 301 to https; the door follows both. An IRI is asked for RDF/XML first; a server
 * that only answers the `<iri>.rdf` form gets one retry there (see `fetchRdfXml`).
 *
 * GATE: WRITE (level 2) on the LOCATOR's section — the record the values are
 * written into — matching v6's assert_section_permission(…, 2). The target rides
 * inside `options.locator`, so the gate is declared as 'section_list' (see
 * rdfSectionTipos): a plain 'section' spec reads `options.section_tipo`, which
 * this tool's client never sends. Every single write is then asked again of the
 * write door by the executor, as the importing principal (record scope, the
 * component pair, creates in linked sections).
 */

import {
	type ApiErrorBody,
	DedaloError,
	isDedaloError,
	ok,
	toDedaloError,
	toErrorBody,
} from '../../../src/core/errors/index.ts';
import {
	type HarvestDeps,
	type HarvestRequest,
	harvestFetch,
} from '../../../src/core/harvest/harvest.ts';
import { siteOf } from '../../../src/core/harvest/refusals.ts';
import { currentJobSignal, runWithJobSignal } from '../../../src/core/media/job_scope.ts';
import { getModelByTipo, getPropertiesByTipo } from '../../../src/core/ontology/resolver.ts';
import { getPermissions, type Principal } from '../../../src/core/security/permissions.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { applyRdfMap, parseRdfXml, type RdfMapEntry } from '../../../src/core/tools/rdf_xml.ts';
import { findTermRecord, type RdfCallerLocator } from './rdf_import_execute.ts';
import {
	engineRdfOntologyReader,
	engineRdfPlanLangs,
	loadRdfImportOntology,
} from './rdf_import_plan.ts';
import { type RdfImportResult, runRdfImport } from './rdf_import_run.ts';

/**
 * The action's permission target (the 'section_list' gate reads this).
 *
 * The client posts the target section INSIDE `options.locator` and sends NO
 * top-level `section_tipo` (tool_import_rdf.js get_rdf_data :218-227). The
 * declarative 'section' gate reads `options.section_tipo`, so it saw nothing,
 * failed closed, and EVERY real request — even a global admin's — was denied
 * with "invalid section target": the action was unreachable from the UI.
 * 'section_list' exists precisely for a target that rides inside the payload,
 * and it still runs BEFORE the handler.
 */
function rdfSectionTipos(options: Record<string, unknown>): unknown[] {
	const locator = (options.locator ?? {}) as { section_tipo?: unknown };
	return locator.section_tipo === undefined ? [] : [locator.section_tipo];
}

/** One IRI's outcome: its (mapped) subjects, or the wire body of why it failed. */
export type RdfOutcome =
	| { kind: 'loaded'; entry: { uri: string; subjects: unknown[] } }
	| { kind: 'failed'; failure: { uri: string; error: ApiErrorBody } };

/**
 * Defense in depth behind the declarative gate — same level, so a direct call can
 * never reach the fetch loop on a weaker check than the wire.
 */
async function assertLocatorWrite(ctx: ToolActionContext, sectionTipo: string): Promise<void> {
	if ((await getPermissions(ctx.principal, sectionTipo, sectionTipo)) >= 2) return;
	throw new DedaloError('perm.denied', {
		coordinates: { tool: 'tool_import_rdf', section_tipo: sectionTipo },
	});
}

/**
 * The most IRIs one call may dereference. The call is interactive (the cataloguer
 * waits; the client gives up after 60 s) and the door paces each site — at least
 * 3 s between two requests, longer when its robots.txt asks (Crawl-delay, clamped
 * to 60 s) or when other callers are queued on the same site. A 301, a 303 and a
 * `.rdf` retry are several paced hops for ONE IRI, so even one IRI can outlast the
 * client on a slow or Crawl-delayed site: the cap bounds the work a call may
 * queue, it does not guarantee the answer arrives in time. The client sends one
 * (its picker is a radio group).
 */
export const RDF_MAX_URIS = 3;

/** `ar_values` as a non-empty list of strings, or a caller error. */
function rdfValueList(options: Record<string, unknown>): string[] {
	const values = options.ar_values ?? [];
	if (!Array.isArray(values) || values.length === 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'Missing ar_values (RDF URIs)',
		});
	}
	if (!values.every((value) => typeof value === 'string')) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'ar_values must be a list of RDF URIs (strings)',
		});
	}
	return values;
}

/** The IRIs to dereference; none, a non-string, or more than `RDF_MAX_URIS` is a caller error. */
function rdfValues(options: Record<string, unknown>): string[] {
	const values = rdfValueList(options);
	if (values.length > RDF_MAX_URIS) {
		throw new DedaloError('tool.too_many_items', {
			details: { count: values.length, limit: RDF_MAX_URIS },
			coordinates: { tool: 'tool_import_rdf' },
		});
	}
	return values;
}

/** The media types an RDF/XML document is served as. */
const RDF_XML_TYPES = ['application/rdf+xml', 'application/xml', 'text/xml'];
/**
 * Content negotiation: the ONE media type RDF/XML is registered as. A single type,
 * not a weighted list: linked-data servers that match the header literally
 * (numismatics.org's OCRE, measured 2026-10-01) answer `application/rdf+xml` and
 * refuse any list with 406 Not Acceptable — which the `.rdf` fallback then covers.
 */
const RDF_XML_ACCEPT = 'application/rdf+xml';
/**
 * The `.rdf` form names the file itself, and static file servers often label it
 * as bytes or text; an HTML page is still refused.
 */
const RDF_FILE_TYPES = [...RDF_XML_TYPES, 'application/octet-stream', 'text/plain'];
/** The body ceiling (a large authority graph). */
const RDF_MAX_BYTES = 20 * 1024 * 1024;
/** Total time per hop, body included (the IRI's deadline below bounds them all). */
const RDF_HOP_TIMEOUT_MS = 15_000;
/**
 * How long ONE IRI may take, everything included: robots.txt, the site's pace,
 * every redirect, the `.rdf` retry. A cataloguer waits for the answer, and a
 * source that needs longer is, for them, out of service (`tool.source_unavailable`).
 * At `RDF_MAX_URIS` IRIs a call stays inside the client's 60 s wait.
 */
export const RDF_IRI_DEADLINE_MS = 15_000;
/**
 * The guard's reasons for a request that ended because the SITE did not answer
 * (core/security/ssrf_guard.ts `hopFailureReason` + the idle body): a deadline
 * (ours included — it aborts the job signal), a dropped connection, a stall.
 */
const SITE_DOWN_REASONS: readonly string[] = ['timeout', 'transport', 'idle', 'aborted'];

/** The door request for one RDF document. */
function rdfRequest(url: string, accepted: readonly string[]): HarvestRequest {
	return {
		url,
		hosts: 'public',
		headers: { Accept: RDF_XML_ACCEPT },
		expectContentType: accepted,
		maxBytes: RDF_MAX_BYTES,
		timeoutMs: RDF_HOP_TIMEOUT_MS,
	};
}

/** What one request gave: the document's text, or why it was not RDF/XML. */
type RdfAttempt = { kind: 'document'; text: string } | { kind: 'not_rdf'; error: DedaloError };

/**
 * Ask for one document. A 4xx answer (the document is not at this address) or a
 * 2xx of another media type means "not RDF/XML here" (`not_rdf`). Every other
 * failure is thrown, because asking the same site again would only meet it again:
 * a refused address, a robots.txt that says no, a timeout — and a 5xx, a 408 or a
 * 429, which say the SITE is unwell or busy (asking again would also wait out its
 * `Retry-After`).
 */
async function attemptRdf(
	url: string,
	accepted: readonly string[],
	deps: HarvestDeps,
): Promise<RdfAttempt> {
	try {
		const response = await harvestFetch(rdfRequest(url, accepted), deps);
		if (response.ok) return { kind: 'document', text: response.text() };
		if (meansNotHere(response.status)) {
			return { kind: 'not_rdf', error: statusFailure(response.status) };
		}
		throw statusFailure(response.status);
	} catch (error) {
		if (isDedaloError(error) && error.code === 'harvest.unexpected_type') {
			return { kind: 'not_rdf', error };
		}
		throw error;
	}
}

/** A 4xx that says "not at this address" — not a timeout (408) nor a rate limit (429). */
function meansNotHere(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A non-2xx final answer, typed as the single-call door types it (status log-only). */
function statusFailure(status: number): DedaloError {
	return new DedaloError('security.outbound_failed', {
		message: `HTTP ${status}`,
		coordinates: { tool: 'tool_import_rdf', status },
	});
}

/**
 * The `<iri>.rdf` file form of an IRI, or null when there is none to try: the
 * IRI is not an http(s) URL, has no path, or already names a `.rdf` file (any
 * case). The fragment is dropped (a `vocab#Term` IRI's document is `vocab`, never
 * `vocab#Term.rdf`), and so are trailing slashes (`id/` → `id.rdf`).
 */
export function rdfFileUrl(iri: string): string | null {
	const url = URL.parse(iri);
	if (url === null || !WEB_PROTOCOLS.has(url.protocol)) return null;
	const path = url.pathname.replace(/\/+$/, '');
	if (path === '' || path.toLowerCase().endsWith('.rdf')) return null;
	url.hash = '';
	url.pathname = `${path}.rdf`;
	return url.toString();
}

/** The schemes an `.rdf` file form exists for. */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The RDF/XML document for `iri`: content negotiation on the IRI itself, then —
 * only when that answer was not RDF/XML — one retry at its `.rdf` file form, the
 * convention of servers that do not negotiate (the tool's behaviour before the
 * door followed redirects).
 */
async function fetchRdfXml(iri: string, deps: HarvestDeps): Promise<string> {
	const negotiated = await attemptRdf(iri, RDF_XML_TYPES, deps);
	if (negotiated.kind === 'document') return negotiated.text;
	const file = rdfFileUrl(iri);
	if (file === null) throw negotiated.error;
	const retried = await attemptRdf(file, RDF_FILE_TYPES, deps).catch(
		(error: unknown): RdfAttempt => ({ kind: 'not_rdf', error: toDedaloError(error) }),
	);
	if (retried.kind === 'document') return retried.text;
	throw tellingFailure(negotiated.error, retried.error);
}

/**
 * Which failure the cataloguer is told when both forms failed. The IRI is what
 * they picked; the `.rdf` form was our guess. So the IRI's own answer wins —
 * also over any refusal of the guessed address (its own robots.txt rule, say) —
 * with ONE exception: when the IRI only answered an error status and the guess
 * answered a file of the wrong type, that type says more about the site.
 */
function tellingFailure(negotiated: DedaloError, retried: DedaloError): DedaloError {
	const statusOnly = negotiated.code === 'security.outbound_failed';
	return statusOnly && retried.code === 'harvest.unexpected_type' ? retried : negotiated;
}

/**
 * Fetch, parse and map ONE IRI. A failure is reported as the error system's wire
 * body, never `error.message`: the guard's message names the address a refused
 * host resolved to (an internal-network oracle). `uri` is the IRI as the
 * cataloguer selected it, whichever URL finally answered.
 *
 * EXPORTED with the door's `deps` seam (`hop` fakes a site; `pinned` a resolver +
 * socket) for tool_import_rdf.test.ts: the per-URI outcome is this function's
 * decision, not the door's. The action handler never passes `deps` — production
 * resolves and connects for real.
 */
export async function loadRdf(
	uri: string,
	map: RdfMapEntry[],
	deps: HarvestDeps = {},
	deadlineMs: number = RDF_IRI_DEADLINE_MS,
): Promise<RdfOutcome> {
	try {
		const xml = await fetchRdfDocument(uri, deps, deadlineMs);
		const { subjects } = parseRdfXml(xml);
		// A class-map yields the mapped fields (the dd_object the client form
		// consumes); without one, the raw subjects.
		const mapped = map.length > 0 ? applyRdfMap(subjects, map) : subjects;
		return { kind: 'loaded', entry: { uri, subjects: mapped } };
	} catch (error) {
		return { kind: 'failed', failure: { uri, error: toErrorBody(toDedaloError(error)) } };
	}
}

/**
 * The RDF/XML text of ONE IRI within `deadlineMs` (everything included), or the
 * error the cataloguer is told (`reported`: a site that is not answering is
 * `tool.source_unavailable`). The ONE fetch of the tool: the IRI's own document
 * and every linked term the import dereferences go through it. Exported with the
 * door's `deps` seam (tests fake a site).
 */
export async function fetchRdfDocument(
	uri: string,
	deps: HarvestDeps = {},
	deadlineMs: number = RDF_IRI_DEADLINE_MS,
): Promise<string> {
	try {
		return await withDeadline(deadlineMs, () => fetchRdfXml(uri, deps));
	} catch (error) {
		throw reported(uri, error);
	}
}

/**
 * Run `work` under a deadline: the door ends every wait and request of the IRI
 * when the job signal aborts, so the deadline IS a job signal — composed with an
 * enclosing job's, when there is one.
 */
function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
	const deadline = AbortSignal.timeout(ms);
	const job = currentJobSignal();
	return runWithJobSignal(job === undefined ? deadline : AbortSignal.any([job, deadline]), work);
}

/**
 * Whether a failure means the site is not answering: no answer in time, a dropped
 * connection, a 5xx / 408 / 429, or a robots.txt it could not deliver.
 */
function siteIsDown(error: DedaloError): boolean {
	if (error.code === 'harvest.robots_unavailable') return true;
	if (error.code !== 'security.outbound_failed') return false;
	const { reason, status } = error.coordinates ?? {};
	if (typeof status === 'number') return !meansNotHere(status);
	return SITE_DOWN_REASONS.includes(String(reason));
}

/**
 * What the cataloguer is told: a site that is not answering is `tool.source_unavailable`
 * (out of service — contact its maintainer), naming the IRI's own origin, never a
 * redirect target; anything else as it was thrown.
 */
function reported(uri: string, error: unknown): DedaloError {
	const typed = toDedaloError(error);
	if (!siteIsDown(typed)) return typed;
	return new DedaloError('tool.source_unavailable', {
		details: { site: siteOf(uri) },
		coordinates: { tool: 'tool_import_rdf', cause_code: typed.code },
		cause: typed,
	});
}

/** What one call reports: each loaded IRI's subjects, each failed IRI's wire body. */
export interface RdfBatch {
	rdf: { uri: string; subjects: unknown[] }[];
	errors: { uri: string; error: ApiErrorBody }[];
}

/**
 * Load every IRI in turn. One bad IRI never fails the batch: its outcome is a
 * per-URI entry in `errors`. Exported with the same `deps` seam as `loadRdf`.
 */
export async function loadRdfBatch(
	values: readonly string[],
	map: RdfMapEntry[],
	deps: HarvestDeps = {},
	deadlineMs: number = RDF_IRI_DEADLINE_MS,
): Promise<RdfBatch> {
	const batch: RdfBatch = { rdf: [], errors: [] };
	for (const raw of values) {
		const outcome = await loadRdf(raw, map, deps, deadlineMs);
		if (outcome.kind === 'loaded') batch.rdf.push(outcome.entry);
		else batch.errors.push(outcome.failure);
	}
	return batch;
}

/** What one import call is: the IRIs, the mapping, the record, the importer. */
export interface RdfImportCall {
	uris: readonly string[];
	/** A node of model `external_ontology` (checked by the action). */
	ontologyTipo: string;
	caller: RdfCallerLocator;
	principal: Principal;
}

/**
 * Import every IRI into the caller record: the ontology read once, then
 * rdf_import_run.ts (fetch → plan → linked terms → execute). Exported with the
 * door's `deps` seam, like `loadRdf`; the action never passes it.
 */
export async function importRdfBatch(
	call: RdfImportCall,
	deps: HarvestDeps = {},
	deadlineMs: number = RDF_IRI_DEADLINE_MS,
): Promise<RdfImportResult> {
	const ontology = await loadRdfImportOntology(call.ontologyTipo, engineRdfOntologyReader());
	return runRdfImport({
		...call,
		ontology,
		langs: await engineRdfPlanLangs(),
		deadlineMs,
		readDocument: (iri, ms) => fetchRdfDocument(iri, deps, ms),
		lookup: findTermRecord,
	});
}

/** The record the import writes into: `options.locator`, a section tipo and a positive id. */
function rdfCaller(options: Record<string, unknown>): RdfCallerLocator {
	const locator = (options.locator ?? {}) as { section_tipo?: unknown; section_id?: unknown };
	const sectionTipo = asTipo(locator.section_tipo);
	const sectionId = Number(locator.section_id);
	if (sectionTipo === null || !Number.isSafeInteger(sectionId) || sectionId < 1) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'Missing or invalid locator (the record to import into)',
		});
	}
	return { section_tipo: sectionTipo, section_id: sectionId };
}

/**
 * The external ontology to map through: `options.ontology_tipo`, else the one the
 * main component names (`ar_tools_name.tool_import_rdf.external_ontology` of
 * `options.main_component_tipo`, where the client reads it). Refused unless it is
 * a node of model `external_ontology` — any other tipo would be read as a mapping.
 */
async function rdfOntologyTipo(options: Record<string, unknown>): Promise<string> {
	const tipo = asTipo(options.ontology_tipo) ?? (await mainElementOntology(options));
	if (tipo !== null && (await getModelByTipo(tipo)) === 'external_ontology') return tipo;
	throw new DedaloError('request.invalid_options', {
		publicMessage: 'No external ontology to map the RDF with (ontology_tipo)',
		coordinates: { tool: 'tool_import_rdf', ontology_tipo: tipo ?? '' },
	});
}

function asTipo(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

async function mainElementOntology(options: Record<string, unknown>): Promise<string | null> {
	const component = asTipo(options.main_component_tipo);
	if (component === null) return null;
	const properties = (await getPropertiesByTipo(component)) as {
		ar_tools_name?: { tool_import_rdf?: { external_ontology?: unknown } };
	} | null;
	return asTipo(properties?.ar_tools_name?.tool_import_rdf?.external_ontology);
}

async function getRdfData(ctx: ToolActionContext): Promise<ToolResponse> {
	const values = rdfValues(ctx.options);
	const caller = rdfCaller(ctx.options);
	await assertLocatorWrite(ctx, caller.section_tipo);
	const ontologyTipo = await rdfOntologyTipo(ctx.options);
	// `errors` is the PER-URI refusal list: payload, not a wire failure — so it
	// rides inside `data`, one `{uri, error}` per URI, `error` the same body a
	// failed call would carry. `report` is what each IRI wrote, created, skipped.
	const result = await importRdfBatch({
		uris: values,
		ontologyTipo,
		caller,
		principal: ctx.principal,
	});
	return ok(result, { requestId: toolRequestId(ctx) });
}

export const tool: ToolServerModule = {
	name: 'tool_import_rdf',
	apiActions: {
		// PHP asserts WRITE (level 2) on the LOCATOR's section (SEC-024 §9.2): the
		// action dereferences external URIs so the resolved values can be written
		// into that record. minLevel 1 let a read-only user drive the server's
		// outbound fetcher.
		get_rdf_data: {
			permission: 'section_list',
			minLevel: 2,
			sectionTipos: rdfSectionTipos,
			handler: getRdfData,
		},
	},
};
