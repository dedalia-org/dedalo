/**
 * R2 gate: tool_import_rdf. The RDF/XML parser and the class-map are covered by
 * rdf_xml.test.ts / rdf_map.test.ts; this file gates the TOOL — its action
 * surface, the argument validation, and how it dereferences an IRI through the
 * harvesting door (`harvestFetch`): content negotiation, the redirects a
 * linked-data server answers with, the `.rdf` fallback, robots.txt, and what it
 * reports per URI when the door or the SSRF guard refuses (SEC-072). The door
 * itself is gated in harvest_door_native.test.ts, the guard in ssrf_guard.test.ts
 * and ssrf_one_guard_tripwire.test.ts.
 *
 * Network-free by construction: a refused URI never reaches fetch(), and every
 * other case runs against a scripted site through the door's `hop` seam (or the
 * guard's resolver + socket seam), so every assertion runs credless and offline.
 */
// Migrated to the generic `test` TLD 2026-08-19: the sectionTipos extractor is pure, so
// its ontology tipo and locator are opaque — they now name generic `test` nodes.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError, toErrorBody } from '../../src/core/errors/index.ts';
import type { HarvestDeps } from '../../src/core/harvest/harvest.ts';
import { clearPacingForTests } from '../../src/core/harvest/pacing.ts';
import { clearRobotsCache } from '../../src/core/harvest/robots.ts';
import { currentJobSignal } from '../../src/core/media/job_scope.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import type {
	AddressLookup,
	PinnedHopRequest,
	PinnedHopResponse,
} from '../../src/core/security/ssrf_guard.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { parseRdfGraph } from '../../src/core/tools/rdf_graph.ts';
import {
	importRdfBatch,
	loadRdf,
	loadRdfBatch,
	RDF_IRI_DEADLINE_MS,
	RDF_MAX_URIS,
	type RdfOutcome,
	rdfFileUrl,
} from '../../tools/tool_import_rdf/server/index.ts';
import {
	executeRdfImport,
	findTermRecord,
	RDF_EQUIVALENT_WITHHELD,
	RDF_EQUIVALENTS_PER_SEARCH,
} from '../../tools/tool_import_rdf/server/rdf_import_execute.ts';
import {
	engineRdfOntologyReader,
	loadRdfImportOntology,
	type RdfFindOrCreateOp,
	type RdfImportOp,
} from '../../tools/tool_import_rdf/server/rdf_import_plan.ts';
import { withoutKey } from '../../tools/tool_import_rdf/server/rdf_import_prune.ts';
import {
	equivalentsOf,
	importsInto,
	RDF_LINKED_MIN_MS,
	RDF_MAX_LINKED_FETCHES,
	RDF_MAX_LINKED_LOOKUPS,
	RDF_NOT_FETCHED,
	RDF_TOO_MANY_LINKED,
	type RdfImportResult,
	runRdfImport,
	subjectOf,
} from '../../tools/tool_import_rdf/server/rdf_import_run.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	type AuthzIdentities,
	assertAuthzDoorContrast,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { cleanScratchRecord, cleanScratchTipo } from '../helpers/test_data.ts';

/**
 * A wire body without its `debug` block — what a production install sends. The
 * block is the operator's own disclosure ladder (DEDALO_DEBUG_API_ERRORS / dev
 * mode, ERRORS_SPEC), present when this suite runs in dev mode.
 */
function publicPart(body: object | undefined): object {
	const { debug: _debug, ...rest } = (body ?? {}) as Record<string, unknown>;
	return rest;
}

describe('tool_import_rdf module', () => {
	test('loads with get_rdf_data only, gated at READ level, not backgroundRunnable', async () => {
		const loaded = await getLoadedTool('tool_import_rdf');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions)).toEqual(['get_rdf_data']);
		const spec = mustGet(actions.get_rdf_data, 'get_rdf_data');
		// PHP gates WRITE (level 2) on the LOCATOR's section, and the client sends
		// the target ONLY inside options.locator — so the gate must read the
		// payload, not options.section_tipo.
		expect(spec.permission).toBe('section_list');
		expect(spec.minLevel).toBe(2);
		// Nothing forks: the fetch answers the request that made it.
		expect(loaded!.module.backgroundRunnable).toBeUndefined();
	});

	test('the gate reads the target out of options.locator (the wire the client posts)', async () => {
		const loaded = await getLoadedTool('tool_import_rdf');
		const spec = mustGet(loaded!.module.apiActions.get_rdf_data, 'get_rdf_data');
		// The EXACT options tool_import_rdf.js get_rdf_data (:218-227) posts — note
		// there is NO top-level section_tipo. Reading one gave an empty target and
		// a fail-closed denial, i.e. the action was unreachable from the UI.
		expect(
			spec.sectionTipos?.({
				// ontology_tipo is opaque to the extractor (only `locator` is read).
				ontology_tipo: 'test6',
				ar_values: ['http://viaf.org/viaf/1'],
				locator: { section_tipo: 'test3', section_id: 1 },
			}),
		).toEqual(['test3']);
		// No locator → no target → the 'section_list' gate denies (fail-closed).
		expect(spec.sectionTipos?.({ ar_values: [] })).toEqual([]);
	});

	test('an empty ar_values is refused before any fetch', async () => {
		const loaded = await getLoadedTool('tool_import_rdf');
		const refusal = await refusalOf(
			mustGet(loaded!.module.apiActions.get_rdf_data, 'get_rdf_data').handler({
				principal: await resolvePrincipal(-1),
				userId: -1,
				background: false,
				options: { ar_values: [] },
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain('Missing ar_values');
	});
});

beforeEach(() => {
	// The door remembers robots verdicts and per-site turns process-wide.
	clearRobotsCache();
	clearPacingForTests();
});

/**
 * THE DOOR'S OWN WIRE on a transport failure (WC-2026-09-30-guarded-text-pinned-typed-transport):
 * the per-URI `error` is the registry body of `security.outbound_failed` — category
 * `unavailable`, retryable, the registry's fixed sentence — never `internal.unexpected`
 * and never a host, an address or Bun's own text. Built through the guard's seam (a
 * public answer for the name, a socket that fails), so it runs offline.
 */
describe('tool_import_rdf: a transport failure is published as the typed registry body', () => {
	const PUBLIC: AddressLookup = async () => [{ address: '93.184.216.34', family: 4 }];
	/** No robots.txt: everything allowed (RFC 9309 §2.3.1.3). */
	const NO_ROBOTS = (): Response => new Response(null, { status: 404 });

	function failureOf(outcome: RdfOutcome): {
		code: string;
		category: string;
		retryable: boolean;
		message: string;
	} {
		expect(outcome.kind).toBe('failed');
		if (outcome.kind !== 'failed') throw new Error('loaded');
		return outcome.failure.error as unknown as ReturnType<typeof failureOf>;
	}

	test('a refused connection: tool.source_unavailable naming the IRI’s site, no address or runtime text', async () => {
		const asked: string[] = [];
		const outcome = await loadRdf('https://vocab.example.test/term/1', [], {
			pinned: {
				lookup: PUBLIC,
				fetch: async (url) => {
					asked.push(url);
					if (url.endsWith('/robots.txt')) return NO_ROBOTS();
					throw Object.assign(
						new TypeError('Unable to connect. Is the computer able to access the url?'),
						{ code: 'ConnectionRefused' },
					);
				},
			},
		});
		const body = failureOf(outcome);
		expect(outcome.kind === 'failed' && outcome.failure.uri).toBe(
			'https://vocab.example.test/term/1',
		);
		// For the cataloguer a source that does not answer is out of service: the
		// label names its site and sends them to its maintainer.
		expect(body.code).toBe('tool.source_unavailable');
		expect(body.category).toBe('unavailable');
		expect(body.retryable).toBe(true);
		expect((body as { label_key?: string }).label_key).toBe('error_tool_source_unavailable');
		expect((body as { details?: unknown }).details).toEqual({ site: 'https://vocab.example.test' });
		// A transport failure is final: no `.rdf` retry against the same dead host.
		// (The pinned socket is handed the VETTED address, not the name.)
		expect(asked).toEqual(['https://93.184.216.34/robots.txt', 'https://93.184.216.34/term/1']);
		const wire = JSON.stringify(publicPart(body));
		for (const leak of ['/term/1', '93.184.216.34', 'Unable to connect', 'hop connect'])
			expect(wire, leak).not.toContain(leak);
	});

	test('a redirect inward is FOLLOWED, its target refused by address, and not retried at `.rdf`', async () => {
		// The address refusal surfaces from the target origin's robots.txt read (the
		// first thing the door does for a new origin); that the document hop itself
		// is vetted is the door's own property, gated in harvest_door_native.
		const asked: string[] = [];
		const outcome = await loadRdf('https://vocab.example.test/term/2', [], {
			pinned: {
				lookup: PUBLIC,
				fetch: async (url) => {
					asked.push(url);
					if (url.endsWith('/robots.txt')) return NO_ROBOTS();
					return new Response(null, { status: 303, headers: { location: 'https://127.0.0.1/' } });
				},
			},
		});
		expect(failureOf(outcome).code).toBe('security.ssrf_blocked');
		// Followed (a refused redirect would be outbound_failed), the inward target
		// never connected to (its robots.txt included), and no `.rdf` retry.
		expect(asked).toEqual(['https://93.184.216.34/robots.txt', 'https://93.184.216.34/term/2']);
		expect(JSON.stringify(publicPart(failureOf(outcome)))).not.toContain('127.0.0.1');
	});
});

// ---------------------------------------------------------------------------
// The harvesting door, driven through its `hop` seam: a scripted linked-data
// site, no network, no wall clock.
// ---------------------------------------------------------------------------

interface Scripted {
	status: number;
	/** Thrown by the hop instead of answering (a network failure). */
	error?: unknown;
	contentType?: string;
	location?: string;
	body?: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** One scripted answer, shaped as the pinned primitive would return it. */
function answer(request: PinnedHopRequest, scripted: Scripted): PinnedHopResponse {
	const headers = new Headers();
	if (scripted.contentType !== undefined) headers.set('content-type', scripted.contentType);
	const location = REDIRECTS.has(scripted.status) ? (scripted.location ?? null) : null;
	const base = { status: scripted.status, headers, location, truncated: false };
	if (location !== null || request.acceptBody?.(scripted.status, headers) === false) {
		return { ...base, bytes: new Uint8Array(0), bodySkipped: true };
	}
	return { ...base, bytes: new TextEncoder().encode(scripted.body ?? ''), bodySkipped: false };
}

interface LinkedDataSite {
	deps: HarvestDeps;
	/** Every request the door sent, in order. */
	sent: PinnedHopRequest[];
}

/** The URL as it goes on the wire: a fragment is never sent. */
function wireUrl(request: PinnedHopRequest): string {
	const url = new URL(request.url);
	url.hash = '';
	return url.toString();
}

/** A site answering by URL (404 for anything unscripted), with a fake clock. */
function linkedDataSite(routes: Record<string, Scripted>): LinkedDataSite {
	const sent: PinnedHopRequest[] = [];
	let now = 1_000_000;
	const deps: HarvestDeps = {
		hop: async (request) => {
			sent.push(request);
			const scripted = routes[wireUrl(request)] ?? { status: 404 };
			if (scripted.error !== undefined) throw scripted.error;
			return answer(request, scripted);
		},
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		setTimer: () => undefined,
	};
	return { deps, sent };
}

/** The non-robots URLs the door asked for, in order. */
function documentsAsked(site: LinkedDataSite): string[] {
	return site.sent.map(wireUrl).filter((url) => !url.endsWith('/robots.txt'));
}

const RDF_DOC = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:skos="http://www.w3.org/2004/02/skos/core#">
  <skos:Concept rdf:about="http://ld.test/id/rome">
    <skos:prefLabel xml:lang="en">Rome</skos:prefLabel>
  </skos:Concept>
</rdf:RDF>`;

const RDF_OK: Scripted = { status: 200, contentType: 'application/rdf+xml', body: RDF_DOC };
const HTML_OK: Scripted = { status: 200, contentType: 'text/html; charset=utf-8', body: '<html/>' };

/** The subjects of a loaded outcome (fails the test on a failure). */
function subjectsOf(outcome: RdfOutcome): unknown[] {
	if (outcome.kind !== 'loaded') {
		throw new Error(`expected loaded, got ${JSON.stringify(outcome.failure.error)}`);
	}
	return outcome.entry.subjects;
}

/** The code of a failed outcome (fails the test when it loaded). */
function codeOf(outcome: RdfOutcome): string {
	if (outcome.kind !== 'failed') throw new Error('expected a failure, it loaded');
	return outcome.failure.error.code;
}

/** The parsed subject of RDF_DOC, as the parser names it. */
function aboutRome(subjects: unknown[]): boolean {
	return JSON.stringify(subjects).includes('http://ld.test/id/rome');
}

describe('tool_import_rdf: dereferencing an IRI through the harvesting door', () => {
	test('content negotiation: the IRI itself answers RDF/XML — asked once, with an RDF Accept', async () => {
		const site = linkedDataSite({ 'https://ld.test/id/rome': RDF_OK });
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(aboutRome(subjectsOf(outcome))).toBe(true);
		expect(outcome.kind === 'loaded' && outcome.entry.uri).toBe('https://ld.test/id/rome');
		expect(documentsAsked(site)).toEqual(['https://ld.test/id/rome']);
		const accept = site.sent.find((r) => r.url.pathname === '/id/rome')?.headers.get('accept');
		expect(accept).toBe('application/rdf+xml');
	});

	test('a 303 See Other is followed to the document', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': { status: 303, location: 'https://ld.test/data/rome.rdf' },
			'https://ld.test/data/rome.rdf': RDF_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(aboutRome(subjectsOf(outcome))).toBe(true);
		// The IRI the cataloguer selected names the entry, not the URL that answered.
		expect(outcome.kind === 'loaded' && outcome.entry.uri).toBe('https://ld.test/id/rome');
		expect(documentsAsked(site)).toEqual([
			'https://ld.test/id/rome',
			'https://ld.test/data/rome.rdf',
		]);
	});

	test('a 301 from http to https is followed', async () => {
		const site = linkedDataSite({
			'http://ld.test/id/rome': { status: 301, location: 'https://ld.test/id/rome' },
			'https://ld.test/id/rome': RDF_OK,
		});
		const outcome = await loadRdf('http://ld.test/id/rome', [], site.deps);
		expect(aboutRome(subjectsOf(outcome))).toBe(true);
		expect(documentsAsked(site)).toEqual(['http://ld.test/id/rome', 'https://ld.test/id/rome']);
	});

	test('the `.rdf` fallback: an IRI that answers HTML is retried once at `<iri>.rdf`', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': HTML_OK,
			'https://ld.test/id/rome.rdf': RDF_OK,
		});
		expect(aboutRome(subjectsOf(await loadRdf('https://ld.test/id/rome', [], site.deps)))).toBe(
			true,
		);
		expect(documentsAsked(site)).toEqual([
			'https://ld.test/id/rome',
			'https://ld.test/id/rome.rdf',
		]);
	});

	test('both attempts: the RDF Accept, a bounded hop, the body ceiling', async () => {
		const site = linkedDataSite({ 'https://ld.test/id/rome': HTML_OK });
		await loadRdf('https://ld.test/id/rome', [], site.deps);
		const documents = site.sent.filter((r) => r.url.pathname !== '/robots.txt');
		expect(documents).toHaveLength(2);
		for (const request of documents) {
			expect(request.headers.get('accept')).toBe('application/rdf+xml');
			// Bounded well inside the client's 60 s wait (the door's default is 120 s).
			expect(request.timeoutMs).toBe(15_000);
			// The door's 30 s idle default, clamped to the total.
			expect(request.idleTimeoutMs).toBe(15_000);
			expect(request.maxBytes).toBe(20 * 1024 * 1024);
		}
	});

	test('a fragment IRI: the fallback asks the document’s file form (the drop itself: rdfFileUrl test)', async () => {
		const site = linkedDataSite({
			'https://ld.test/vocab': HTML_OK,
			'https://ld.test/vocab.rdf': RDF_OK,
		});
		subjectsOf(await loadRdf('https://ld.test/vocab#Rome', [], site.deps));
		expect(documentsAsked(site)).toEqual(['https://ld.test/vocab', 'https://ld.test/vocab.rdf']);
	});

	test('the reported failure: a wrong media type wins, else the IRI’s own status', async () => {
		// IRI answers a web page, the guessed `.rdf` is 404: the page is the news.
		const htmlThen404 = linkedDataSite({ 'https://ld.test/id/rome': HTML_OK });
		expect(codeOf(await loadRdf('https://ld.test/id/rome', [], htmlThen404.deps))).toBe(
			'harvest.unexpected_type',
		);
		const notFoundThenHtml = linkedDataSite({ 'https://ld.test/id/rome.rdf': HTML_OK });
		expect(codeOf(await loadRdf('https://ld.test/id/rome', [], notFoundThenHtml.deps))).toBe(
			'harvest.unexpected_type',
		);
		clearRobotsCache();
		const bothMissing = linkedDataSite({});
		expect(codeOf(await loadRdf('https://ld.test/id/rome', [], bothMissing.deps))).toBe(
			'security.outbound_failed',
		);
	});

	test('a door refusal is final even when the `.rdf` form would load', async () => {
		// https → http is refused (`downgrade`); the file form is scripted to load.
		const site = linkedDataSite({
			'https://ld.test/id/rome': { status: 303, location: 'http://ld.test/data/rome' },
			'https://ld.test/id/rome.rdf': RDF_OK,
		});
		expect(codeOf(await loadRdf('https://ld.test/id/rome', [], site.deps))).toBe('harvest.refused');
		expect(documentsAsked(site)).toEqual(['https://ld.test/id/rome']);
	});

	test('every accepted media type, per attempt', async () => {
		const negotiated = ['application/rdf+xml', 'application/xml; charset=utf-8', 'text/xml'];
		for (const contentType of negotiated) {
			clearRobotsCache();
			const site = linkedDataSite({ 'https://ld.test/id/rome': { ...RDF_OK, contentType } });
			subjectsOf(await loadRdf('https://ld.test/id/rome', [], site.deps));
			expect(documentsAsked(site), contentType).toEqual(['https://ld.test/id/rome']);
		}
		for (const contentType of [...negotiated, 'application/octet-stream', 'text/plain']) {
			clearRobotsCache();
			const site = linkedDataSite({ 'https://ld.test/id/rome.rdf': { ...RDF_OK, contentType } });
			subjectsOf(await loadRdf('https://ld.test/id/rome', [], site.deps));
		}
		// Bytes or text are the FILE form's allowance only: the IRI itself must negotiate.
		for (const contentType of ['application/octet-stream', 'text/plain']) {
			clearRobotsCache();
			const site = linkedDataSite({
				'https://ld.test/id/rome': { ...RDF_OK, contentType },
				'https://ld.test/id/rome.rdf': RDF_OK,
			});
			subjectsOf(await loadRdf('https://ld.test/id/rome', [], site.deps));
			expect(documentsAsked(site), contentType).toEqual([
				'https://ld.test/id/rome',
				'https://ld.test/id/rome.rdf',
			]);
		}
	});

	test('the `.rdf` fallback: a non-2xx answer is retried too, and the file may be served as bytes', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome.rdf': { ...RDF_OK, contentType: 'application/octet-stream' },
		});
		expect(aboutRome(subjectsOf(await loadRdf('https://ld.test/id/rome', [], site.deps)))).toBe(
			true,
		);
		expect(documentsAsked(site)).toEqual([
			'https://ld.test/id/rome',
			'https://ld.test/id/rome.rdf',
		]);
	});

	test('no double suffix: an IRI already naming a `.rdf` file is asked once', async () => {
		const site = linkedDataSite({});
		const outcome = await loadRdf('https://ld.test/id/rome.rdf', [], site.deps);
		expect(codeOf(outcome)).toBe('security.outbound_failed');
		expect(documentsAsked(site)).toEqual(['https://ld.test/id/rome.rdf']);
	});

	test('the `.rdf` form drops the fragment and keeps the query', () => {
		expect(rdfFileUrl('https://ld.test/vocab#Rome')).toBe('https://ld.test/vocab.rdf');
		expect(rdfFileUrl('https://ld.test/id/rome?lang=en')).toBe(
			'https://ld.test/id/rome.rdf?lang=en',
		);
		expect(rdfFileUrl('https://ld.test/id/rome.rdf')).toBeNull();
		expect(rdfFileUrl('https://ld.test/id/rome/')).toBe('https://ld.test/id/rome.rdf');
		expect(rdfFileUrl('https://ld.test/id/rome//')).toBe('https://ld.test/id/rome.rdf');
		expect(rdfFileUrl('https://ld.test/')).toBeNull();
		expect(rdfFileUrl('https://ld.test//')).toBeNull();
		expect(rdfFileUrl('https://ld.test')).toBeNull();
		// Any case already names the file.
		expect(rdfFileUrl('https://ld.test/id/ROME.RDF')).toBeNull();
		// No file form outside the web: the IRI itself is refused by the door.
		expect(rdfFileUrl('urn:isbn:1')).toBeNull();
		expect(rdfFileUrl('mailto:a@ld.test')).toBeNull();
		expect(rdfFileUrl('file:///etc/passwd')).toBeNull();
		expect(rdfFileUrl('not a url')).toBeNull();
	});

	test('an HTML 200 is refused (harvest.unexpected_type), the fallback included', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': HTML_OK,
			'https://ld.test/id/rome.rdf': HTML_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(codeOf(outcome)).toBe('harvest.unexpected_type');
		// The page body was never read: the door refuses before the body.
		expect(documentsAsked(site)).toEqual([
			'https://ld.test/id/rome',
			'https://ld.test/id/rome.rdf',
		]);
	});

	test('robots.txt disallow is reported per URI, and not retried at `.rdf`', async () => {
		// The rule disallows the IRI only (`$`), so the `.rdf` form WOULD be allowed
		// and would load: a refusal is final, never a reason to try the other form.
		const site = linkedDataSite({
			'https://ld.test/robots.txt': {
				status: 200,
				contentType: 'text/plain',
				body: 'User-agent: *\nDisallow: /id/rome$',
			},
			'https://ld.test/id/rome': RDF_OK,
			'https://ld.test/id/rome.rdf': RDF_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(codeOf(outcome)).toBe('harvest.robots_disallowed');
		expect(outcome.kind === 'failed' && outcome.failure.error.details).toEqual({
			site: 'https://ld.test',
		});
		expect(documentsAsked(site)).toEqual([]);
	});

	test('a network failure between two good IRIs: the batch goes on, in order', async () => {
		const site = linkedDataSite({
			'https://a.test/id/1': RDF_OK,
			'https://down.test/id/2': {
				status: 0,
				error: new DedaloError('security.outbound_failed', {
					message: 'connect refused',
					coordinates: { reason: 'transport', stage: 'connect' },
				}),
			},
			'https://c.test/id/3': RDF_OK,
		});
		const batch = await loadRdfBatch(
			['https://a.test/id/1', 'https://down.test/id/2', 'https://c.test/id/3'],
			[],
			site.deps,
		);
		expect(batch.rdf.map((entry) => entry.uri)).toEqual([
			'https://a.test/id/1',
			'https://c.test/id/3',
		]);
		expect(batch.errors.map((entry) => [entry.uri, entry.error.code])).toEqual([
			['https://down.test/id/2', 'tool.source_unavailable'],
		]);
	});

	test('one bad URI never fails the batch', async () => {
		const site = linkedDataSite({ 'https://ld.test/id/rome': RDF_OK });
		const batch = await loadRdfBatch(['not a url', 'https://ld.test/id/rome'], [], site.deps);
		expect(batch.rdf.map((entry) => entry.uri)).toEqual(['https://ld.test/id/rome']);
		expect(batch.errors.map((entry) => [entry.uri, entry.error.code])).toEqual([
			['not a url', 'harvest.refused'],
		]);
	});
});

/** Run `body` with the operator's debug ladder on (status coordinates on the wire). */
async function withDebugErrors<T>(body: () => Promise<T>): Promise<T> {
	const previous = process.env.DEDALO_DEBUG_API_ERRORS;
	process.env.DEDALO_DEBUG_API_ERRORS = 'true';
	try {
		return await body();
	} finally {
		if (previous === undefined) Reflect.deleteProperty(process.env, 'DEDALO_DEBUG_API_ERRORS');
		else process.env.DEDALO_DEBUG_API_ERRORS = previous;
	}
}

/** The log-only HTTP status a failed outcome carries (debug ladder on). */
function statusOf(outcome: RdfOutcome): unknown {
	if (outcome.kind !== 'failed') throw new Error('expected a failure, it loaded');
	const debug = (outcome.failure.error as { debug?: { coordinates?: { status?: unknown } } }).debug;
	return debug?.coordinates?.status;
}

describe('tool_import_rdf: which failures end the attempt, and which one is told', () => {
	test('between two error statuses the IRI’s own is told (410 over the guess’s 404)', async () => {
		const site = linkedDataSite({ 'https://ld.test/id/rome': { status: 410 } });
		const outcome = await withDebugErrors(() => loadRdf('https://ld.test/id/rome', [], site.deps));
		expect(codeOf(outcome)).toBe('security.outbound_failed');
		expect(statusOf(outcome)).toBe(410);
		expect(documentsAsked(site)).toEqual([
			'https://ld.test/id/rome',
			'https://ld.test/id/rome.rdf',
		]);
	});

	test('a 406 Not Acceptable (a server matching Accept literally) falls back to `.rdf`', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': { status: 406 },
			'https://ld.test/id/rome.rdf': RDF_OK,
		});
		subjectsOf(await loadRdf('https://ld.test/id/rome', [], site.deps));
		expect(documentsAsked(site)).toEqual([
			'https://ld.test/id/rome',
			'https://ld.test/id/rome.rdf',
		]);
	});

	test('two wrong media types: the IRI’s own is told, not the guess’s', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': { status: 200, contentType: 'text/turtle', body: '@prefix' },
			'https://ld.test/id/rome.rdf': HTML_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(codeOf(outcome)).toBe('harvest.unexpected_type');
		expect(outcome.kind === 'failed' && outcome.failure.error.details?.content_type).toBe(
			'text/turtle',
		);
	});

	test('a refusal of the GUESSED address never replaces the IRI’s own answer', async () => {
		// robots.txt disallows only the `.rdf` form; the IRI answered a web page.
		const site = linkedDataSite({
			'https://ld.test/robots.txt': {
				status: 200,
				contentType: 'text/plain',
				body: 'User-agent: *\nDisallow: /id/rome.rdf',
			},
			'https://ld.test/id/rome': HTML_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(codeOf(outcome)).toBe('harvest.unexpected_type');
		expect(documentsAsked(site)).toEqual(['https://ld.test/id/rome']);
	});

	for (const status of [408, 429, 500, 503]) {
		test(`a ${status} says the SITE is unwell or busy: told, never retried at \`.rdf\``, async () => {
			const site = linkedDataSite({
				'https://ld.test/id/rome': { status },
				'https://ld.test/id/rome.rdf': RDF_OK,
			});
			const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
			expect(codeOf(outcome)).toBe('tool.source_unavailable');
			expect(outcome.kind === 'failed' && outcome.failure.error.details).toEqual({
				site: 'https://ld.test',
			});
			expect(documentsAsked(site)).toEqual(['https://ld.test/id/rome']);
		});
	}

	test('a body over the ceiling is harvest.too_large, and not retried', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': {
				status: 0,
				error: new DedaloError('security.outbound_failed', {
					coordinates: { reason: 'body_cap', max_bytes: 20 * 1024 * 1024 },
				}),
			},
			'https://ld.test/id/rome.rdf': RDF_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(codeOf(outcome)).toBe('harvest.too_large');
		expect(outcome.kind === 'failed' && outcome.failure.error.details?.max_bytes).toBe(
			20 * 1024 * 1024,
		);
		expect(documentsAsked(site)).toEqual(['https://ld.test/id/rome']);
	});

	test('an unreadable robots.txt: the source is out of service, nothing is fetched', async () => {
		const site = linkedDataSite({
			'https://ld.test/robots.txt': { status: 500 },
			'https://ld.test/id/rome': RDF_OK,
			'https://ld.test/id/rome.rdf': RDF_OK,
		});
		const outcome = await loadRdf('https://ld.test/id/rome', [], site.deps);
		expect(codeOf(outcome)).toBe('tool.source_unavailable');
		expect(documentsAsked(site)).toEqual([]);
	});

	test('a source slower than the deadline is out of service, told in time', async () => {
		// A hop that never answers on its own — it ends only when the job signal
		// aborts, as the real primitive does (core/security/ssrf_guard.ts).
		const site = linkedDataSite({});
		const hung: HarvestDeps = {
			...site.deps,
			hop: (request) => {
				if (request.url.pathname === '/robots.txt') return site.deps.hop!(request);
				return new Promise((_, reject) => {
					const signal = currentJobSignal();
					signal?.addEventListener('abort', () =>
						reject(
							new DedaloError('security.outbound_failed', {
								coordinates: { reason: 'aborted', stage: 'connect' },
							}),
						),
					);
				});
			},
		};
		const started = Date.now();
		const outcome = await loadRdf('https://slow.test/id/rome', [], hung, 50);
		expect(codeOf(outcome)).toBe('tool.source_unavailable');
		expect(outcome.kind === 'failed' && outcome.failure.error.details).toEqual({
			site: 'https://slow.test',
		});
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test('the batch passes the deadline to every IRI', async () => {
		const site = linkedDataSite({});
		const hung: HarvestDeps = {
			...site.deps,
			hop: (request) =>
				request.url.pathname === '/robots.txt'
					? site.deps.hop!(request)
					: new Promise((_, reject) => {
							currentJobSignal()?.addEventListener('abort', () =>
								reject(
									new DedaloError('security.outbound_failed', {
										coordinates: { reason: 'aborted', stage: 'connect' },
									}),
								),
							);
						}),
		};
		const batch = await loadRdfBatch(['https://slow.test/id/1'], [], hung, 50);
		expect(batch.errors.map((entry) => entry.error.code)).toEqual(['tool.source_unavailable']);
	});

	test('only a site that does not answer is an outage: another transport failure stays generic', async () => {
		const site = linkedDataSite({
			'https://ld.test/id/rome': {
				status: 0,
				error: new DedaloError('security.outbound_failed', {
					coordinates: { reason: 'redirect', stage: 'connect' },
				}),
			},
		});
		expect(codeOf(await loadRdf('https://ld.test/id/rome', [], site.deps))).toBe(
			'security.outbound_failed',
		);
	});

	test('the deadline is the cataloguer’s wait: 15 s per IRI, inside the client’s 60 s', () => {
		expect(RDF_IRI_DEADLINE_MS).toBe(15_000);
		expect(RDF_IRI_DEADLINE_MS * RDF_MAX_URIS).toBeLessThan(60_000);
	});

	test('a 404 is not an outage: the source answered', async () => {
		const site = linkedDataSite({});
		expect(codeOf(await loadRdf('https://ld.test/id/rome', [], site.deps))).toBe(
			'security.outbound_failed',
		);
	});

	test('any public host is reachable (hosts: public, not an allowlist)', async () => {
		const site = linkedDataSite({ 'https://viaf.org/viaf/1': RDF_OK });
		subjectsOf(await loadRdf('https://viaf.org/viaf/1', [], site.deps));
	});

	test('a class-map is applied to the parsed subjects', async () => {
		const site = linkedDataSite({ 'https://ld.test/id/rome': RDF_OK });
		const outcome = await loadRdf(
			'https://ld.test/id/rome',
			[{ predicate: 'skos:prefLabel', component_tipo: 'test52' }],
			site.deps,
		);
		expect(subjectsOf(outcome)).toEqual([
			{ sectionId: null, fields: [{ component_tipo: 'test52', values: ['Rome'] }] },
		]);
	});
});

describe('tool_import_rdf: the per-call cap', () => {
	async function call(values: unknown[]) {
		const loaded = await getLoadedTool('tool_import_rdf');
		return mustGet(loaded!.module.apiActions.get_rdf_data, 'get_rdf_data').handler({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: { ar_values: values },
		});
	}

	test(`more than ${RDF_MAX_URIS} IRIs is refused with a public typed error`, async () => {
		// Addresses the guard refuses without a lookup, so nothing leaves this machine
		// whatever the order. That the cap runs BEFORE the fetch is the handler's
		// order (rdfValues, then loadRdfBatch); this test does not observe it.
		const values = Array.from({ length: RDF_MAX_URIS + 1 }, (_, i) => `http://127.0.0.${i + 1}/id`);
		const refusal = await refusalOf(call(values));
		expect(refusal.code).toBe('tool.too_many_items');
		expect(refusal.details).toEqual({ count: RDF_MAX_URIS + 1, limit: RDF_MAX_URIS });
		// Public on the wire: the counts reach the cataloguer's label.
		const body = toErrorBody(refusal);
		expect(body.category).toBe('caller');
		expect(body.label_key).toBe('error_tool_too_many_items');
		expect(body.details).toEqual({ count: RDF_MAX_URIS + 1, limit: RDF_MAX_URIS });
	});

	test('ar_values must be a list of strings', async () => {
		for (const ar_values of [
			'https://ld.test/id/rome',
			'x',
			[42],
			['https://ld.test/id/1', null],
		]) {
			const refusal = await refusalOf(call(ar_values as unknown[]));
			expect(refusal.code, JSON.stringify(ar_values)).toBe('request.invalid_options');
		}
	});
});

// ---------------------------------------------------------------------------
// THE IMPORT: graph → external ontology → plan → linked terms → executor, on
// the suite database (the generic `test` bench: test3 records created here,
// test52 input_text translatable, test140 component_iri, test80 portal → test3,
// test91 select → dd64), under a scratch external ontology (`zzrdfwire`).
// ---------------------------------------------------------------------------

const W_ROOT = 'zzrdfwire1';
const W_MAIN_IRI = 'zzrdfwire9';
const W_VIRTUAL = 'zzrdfwire30';
const SECTION = 'test3';
const TITLE = 'test52';
const IRI = 'test140';
const PORTAL = 'test80';
const SELECT = 'test91';
const ROOT_PRINCIPAL = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const EX = 'http://ld.test/ns#';

/** Coin → test3 (prefLabel → title, ex:mint → portal of Mint); Mint → test3 matched by IRI. */
const WIRE_SITUATION = situation({
	tld: 'zzrdfwire',
	name: 'tool_import_rdf_wire',
	nodes: [
		{
			tipo: W_ROOT,
			parent: null,
			model: 'external_ontology',
			term: { 'lg-spa': 'Wire import' },
			order_number: 1,
			properties: { xmlns: { ex: EX, skos: SKOS } },
		},
		...[
			['zzrdfwire2', W_ROOT, 'owl:Class', 'ex:Coin', [SECTION], { match: IRI }],
			['zzrdfwire3', 'zzrdfwire2', 'owl:ObjectProperty', 'skos:prefLabel', [TITLE], null],
			['zzrdfwire4', 'zzrdfwire2', 'owl:ObjectProperty', 'ex:mint', [PORTAL, 'zzrdfwire5'], null],
			['zzrdfwire5', W_ROOT, 'owl:Class', 'ex:Mint', [SECTION], { match: IRI }],
			['zzrdfwire6', 'zzrdfwire5', 'owl:ObjectProperty', 'skos:prefLabel', [TITLE], null],
			[
				'zzrdfwire10',
				'zzrdfwire5',
				'owl:ObjectProperty',
				'ex:sibling',
				[PORTAL, 'zzrdfwire5'],
				null,
			],
			// A Mint property mapped OFF TARGET (test91 selects dd64): reached only
			// through a FETCHED Mint's own document.
			['zzrdfwire15', 'zzrdfwire5', 'owl:ObjectProperty', 'ex:bad', [SELECT, 'zzrdfwire5'], null],
			['zzrdfwire7', W_ROOT, 'owl:Class', 'ex:Broken', [SECTION], { match: IRI }],
			['zzrdfwire8', 'zzrdfwire7', 'owl:ObjectProperty', 'ex:other', [SELECT, 'zzrdfwire5'], null],
			['zzrdfwire14', 'zzrdfwire7', 'owl:ObjectProperty', 'skos:prefLabel', [TITLE], null],
			// ex:creator goes through an INTERMEDIATE (caller.test80 → test3 .test80 → the Mint).
			[
				'zzrdfwire11',
				'zzrdfwire2',
				'owl:ObjectProperty',
				'ex:creator',
				[PORTAL],
				{
					ddo_map: [
						{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
						{ section_tipo: SECTION, component_tipo: PORTAL, parent: PORTAL },
						{ section_tipo: SECTION, component_tipo: IRI, parent: PORTAL },
					],
				},
			],
			[
				'zzrdfwire12',
				'zzrdfwire11',
				'owl:ObjectProperty',
				'ex:creator',
				[PORTAL, 'zzrdfwire5'],
				null,
			],
			// A SECOND component linking a Mint (after ex:mint's portal, in order).
			[
				'zzrdfwire13',
				'zzrdfwire2',
				'owl:ObjectProperty',
				'ex:issuer',
				[SELECT, 'zzrdfwire5'],
				null,
			],
			// A Mint's OTHER identifiers, written into its MATCH component (the live
			// Nomisma mapping's skos:exactMatch → hierarchy89): the equivalents a
			// fetched term is looked up by (decision 2026-10-02).
			['zzrdfwire16', 'zzrdfwire5', 'owl:ObjectProperty', 'skos:exactMatch', [IRI], null],
		].map(([tipo, parent, model, term, related, properties], index) => ({
			tipo: tipo as string,
			parent: parent as string,
			model: model as string,
			term: { 'lg-spa': term as string },
			order_number: index + 2,
			is_translatable: true,
			properties: properties as Record<string, unknown> | null,
			relations: (related as string[]).map((t) => ({ tipo: t })),
		})),
		{
			// A VIRTUAL section of test3 (its relation names a section): a test3 class imports into it.
			tipo: W_VIRTUAL,
			parent: null,
			model: 'section',
			term: { 'lg-spa': 'Virtual test3' },
			order_number: 21,
			relations: [{ tipo: SECTION }],
		},
		{
			tipo: W_MAIN_IRI,
			parent: null,
			model: 'component_iri',
			term: { 'lg-spa': 'IRI' },
			order_number: 20,
			properties: { ar_tools_name: { tool_import_rdf: { external_ontology: W_ROOT } } },
		},
	],
});

const W_RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const wIri = (name: string): string => `https://ld.test/id/${name}-${W_RUN}`;
const wRecords = new Set<number>();
const wBulk = new Set<number>();

function coinDoc(
	name: string,
	mints: readonly string[],
	type = 'Coin',
	predicate = 'mint',
): string {
	const links = mints.map((m) => `<ex:${predicate} rdf:resource="${wIri(m)}"/>`).join('');
	return `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:skos="${SKOS}" xmlns:ex="${EX}">
  <ex:${type} rdf:about="${wIri(name)}"><skos:prefLabel xml:lang="en">Quinarius ${name}</skos:prefLabel>${links}</ex:${type}>
</rdf:RDF>`;
}

function mintDoc(name: string, sibling?: string): string {
	const link = sibling === undefined ? '' : `<ex:sibling rdf:resource="${wIri(sibling)}"/>`;
	return `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:skos="${SKOS}" xmlns:ex="${EX}">
  <ex:Mint rdf:about="${wIri(name)}"><skos:prefLabel xml:lang="en">Mint ${name}</skos:prefLabel>${link}</ex:Mint>
</rdf:RDF>`;
}

/** A Mint whose document names its EQUIVALENTS (`skos:exactMatch`, into the match component). */
function mintEqDoc(name: string, equivalents: readonly string[]): string {
	const links = equivalents.map((iri) => `<skos:exactMatch rdf:resource="${iri}"/>`).join('');
	return `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:skos="${SKOS}" xmlns:ex="${EX}">
  <ex:Mint rdf:about="${wIri(name)}"><skos:prefLabel xml:lang="en">Mint ${name}</skos:prefLabel>${links}</ex:Mint>
</rdf:RDF>`;
}

/** An equivalent identifier on ANOTHER site (never fetched: the fake fetch does not know it). */
const eqIri = (name: string): string => `https://eq.test/id/${name}-${W_RUN}`;

const rdfAnswer = (body: string): Scripted => ({
	status: 200,
	contentType: 'application/rdf+xml',
	body,
});

async function wRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, -1);
	wRecords.add(id);
	return id;
}

/** A test3 record already carrying `iri` (a term the import must find, never fetch). */
async function knownTerm(iri: string): Promise<number> {
	const id = await wRecord();
	const saved = await saveComponentData({
		componentTipo: IRI,
		sectionTipo: SECTION,
		sectionId: id,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value: [{ iri }] }],
		userId: -1,
	});
	expect(saved.ok).toBe(true);
	return id;
}

function track(result: RdfImportResult): RdfImportResult {
	if (result.bulk_process_id !== null) wBulk.add(result.bulk_process_id);
	for (const entry of result.report) for (const c of entry.created) wRecords.add(c.section_id);
	return result;
}

async function wItems(
	id: number,
	column: string,
	tipo: string,
): Promise<Record<string, unknown>[]> {
	const record = await readMatrixRecord('matrix_test', SECTION, id);
	const bag = (record?.columns as Record<string, Record<string, unknown> | null> | undefined)?.[
		column
	];
	return ((bag?.[tipo] as Record<string, unknown>[] | undefined) ?? []).filter((x) => x !== null);
}

const linkedIds = async (id: number, tipo = PORTAL): Promise<number[]> =>
	(await wItems(id, 'relation', tipo)).map((item) => Number(item.section_id));

describe.if(DB_READY)('tool_import_rdf: the import (graph → ontology → records)', () => {
	let ids: AuthzIdentities;

	beforeAll(async () => {
		await assertTestDatabase('tool_import_rdf');
		await ensureSituation(WIRE_SITUATION);
		await installAuthzDoorFixture();
		ids = await resolveAuthzIdentities();
	});

	afterAll(async () => {
		await assertTestDatabase('tool_import_rdf');
		for (const id of wRecords) await cleanScratchRecord(SECTION, id, 'matrix_test');
		// The scratch VIRTUAL section's records (its tipo is this file's own): all of them.
		const virtualTable = (await getMatrixTableFromTipo(W_VIRTUAL)) ?? 'matrix_test';
		await cleanScratchTipo(W_VIRTUAL, virtualTable);
		await sweepActivityRows(W_VIRTUAL);
		expect(await countActivityRows(W_VIRTUAL)).toBe(0);
		const bulkTable = (await getMatrixTableFromTipo('dd800')) ?? 'matrix_notes';
		for (const id of wBulk) await cleanScratchRecord('dd800', id, bulkTable);
		await removeAuthzDoorFixture();
		expect(await dropSituation(WIRE_SITUATION)).toBe(0);
		await sweepActivityRows(SECTION, [...wRecords]);
		await sweepActivityRows('dd800', [...wBulk]);
		expect(await countActivityRows(SECTION, [...wRecords])).toBe(0);
		expect(await countActivityRows('dd800', [...wBulk])).toBe(0);
		// ZERO RESIDUE, on the rows.
		const left = (await sql.unsafe(
			`SELECT (SELECT count(*)::int FROM matrix_test WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[]))
			      + (SELECT count(*)::int FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])) AS n`,
			[SECTION, [...wRecords].join(',')],
		)) as { n: number }[];
		expect(left[0]?.n ?? -1).toBe(0);
	});

	async function handler(options: Record<string, unknown>, principal?: Principal) {
		const loaded = await getLoadedTool('tool_import_rdf');
		const as = principal ?? (await resolvePrincipal(-1));
		return mustGet(loaded!.module.apiActions.get_rdf_data, 'get_rdf_data').handler({
			principal: as,
			userId: as.userId,
			background: false,
			options,
		});
	}

	test('an unsafe URI is reported per-value, never dereferenced, nothing written', async () => {
		const id = await wRecord();
		const res = await handler({
			ontology_tipo: W_ROOT,
			ar_values: ['http://169.254.169.254/latest/meta-data'],
			locator: { section_tipo: SECTION, section_id: id },
		});
		const data = res.data as RdfImportResult;
		expect(data.rdf).toEqual([]);
		expect(data.report).toEqual([]);
		expect(data.bulk_process_id).toBeNull();
		// The per-URI refusals are PAYLOAD (`data.errors`), never the envelope's
		// failure channel — each one the error system's wire body, never the guard's
		// `Error.message`, which names the address a refused host resolved to.
		expect(data.errors).toHaveLength(1);
		expect(data.errors[0]?.uri).toBe('http://169.254.169.254/latest/meta-data');
		expect(data.errors[0]?.error.code).toBe('security.ssrf_blocked');
		const wire = JSON.stringify(publicPart(data.errors[0]?.error));
		expect(wire).not.toContain('169.254');
		expect(wire).not.toContain('ssrf:');
	});

	test('a NAME that resolves inward is reported without the address it resolved to', async () => {
		const id = await wRecord();
		const res = await handler({
			ontology_tipo: W_ROOT,
			ar_values: ['http://localhost/vocab/term'],
			locator: { section_tipo: SECTION, section_id: String(id) },
		});
		const data = res.data as RdfImportResult;
		expect(data.errors[0]?.error.code).toBe('security.ssrf_blocked');
		const wire = JSON.stringify(publicPart(data.errors[0]?.error));
		for (const address of ['127.0.0.1', '::1']) expect(wire).not.toContain(address);
	});

	test(`exactly ${RDF_MAX_URIS} IRIs pass the cap`, async () => {
		const id = await wRecord();
		// Unparseable text: refused per URI by the door, offline.
		const res = await handler({
			ontology_tipo: W_ROOT,
			ar_values: Array.from({ length: RDF_MAX_URIS }, (_, i) => `not a url ${i}`),
			locator: { section_tipo: SECTION, section_id: id },
		});
		const data = res.data as RdfImportResult;
		expect(data.errors.map((entry) => entry.error.code)).toEqual(
			Array(RDF_MAX_URIS).fill('harvest.refused'),
		);
	});

	test('the record to import into is required: no locator, a bad id, an empty section', async () => {
		for (const locator of [
			undefined,
			{ section_tipo: SECTION },
			{ section_tipo: SECTION, section_id: 0 },
			{ section_tipo: SECTION, section_id: 'x' },
			{ section_tipo: '', section_id: 1 },
		]) {
			const refusal = await refusalOf(
				handler({ ontology_tipo: W_ROOT, ar_values: ['https://ld.test/id/1'], locator }),
			);
			expect(refusal.code, JSON.stringify(locator)).toBe('request.invalid_options');
			expect(refusal.publicMessage).toContain('locator');
		}
	});

	test('the handler itself refuses a user without WRITE on the record’s section (behind the declarative gate)', async () => {
		await assertAuthzDoorContrast(ids);
		const id = await wRecord();
		const refusal = await refusalOf(
			handler(
				{
					ontology_tipo: W_ROOT,
					ar_values: ['http://169.254.169.254/x'],
					locator: { section_tipo: SECTION, section_id: id },
				},
				ids.level1,
			),
		);
		expect(refusal.code).toBe('perm.denied');
	});

	test('only an external_ontology node maps: a component, an unknown tipo or none is refused', async () => {
		const id = await wRecord();
		for (const ontology_tipo of [TITLE, 'zzrdfwire999', 'zzrdfwire2', undefined, '']) {
			const refusal = await refusalOf(
				handler({
					ontology_tipo,
					ar_values: ['https://ld.test/id/1'],
					locator: { section_tipo: SECTION, section_id: id },
				}),
			);
			expect(refusal.code, String(ontology_tipo)).toBe('request.invalid_options');
			expect(refusal.publicMessage).toContain('external ontology');
		}
	});

	test('no ontology_tipo: the main component’s configured external_ontology is used', async () => {
		const id = await wRecord();
		const res = await handler({
			main_component_tipo: W_MAIN_IRI,
			ar_values: ['http://169.254.169.254/x'],
			locator: { section_tipo: SECTION, section_id: id },
		});
		// It reached the fetch (refused there, per URI): the ontology was accepted.
		expect((res.data as RdfImportResult).errors[0]?.error.code).toBe('security.ssrf_blocked');
		// A main component WITHOUT the configuration names none: refused.
		const refusal = await refusalOf(
			handler({
				main_component_tipo: TITLE,
				ar_values: ['https://ld.test/id/1'],
				locator: { section_tipo: SECTION, section_id: id },
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
	});

	test('fills the record, links a KNOWN term without fetching it, fetches + creates + links a NEW one; a rerun changes nothing', async () => {
		const caller = await wRecord();
		const known = await knownTerm(wIri('known'));
		const site = linkedDataSite({
			[wIri('coin1')]: rdfAnswer(coinDoc('coin1', ['mint1', 'known'])),
			[wIri('mint1')]: rdfAnswer(mintDoc('mint1')),
		});
		const call = {
			uris: [wIri('coin1')],
			ontologyTipo: W_ROOT,
			caller: { section_tipo: SECTION, section_id: caller },
			principal: ROOT_PRINCIPAL,
		};
		const first = track(await importRdfBatch(call, site.deps));
		expect(first.errors).toEqual([]);
		expect(first.bulk_process_id).toBeGreaterThan(0);
		// Match first: the known term was never asked for.
		expect(documentsAsked(site)).toEqual([wIri('coin1'), wIri('mint1')]);
		const [report] = first.report;
		expect(report?.uri).toBe(wIri('coin1'));
		expect(report?.created).toHaveLength(1);
		const mint = report?.created[0]?.section_id as number;
		expect(report?.created[0]).toMatchObject({ section_tipo: SECTION, label: wIri('mint1') });
		expect(report?.created[0]?.section_label).toBeTruthy();
		expect(report?.skipped).toEqual([]);
		expect(report?.written.map((w) => [w.section_id, w.component_tipo, w.value_summary])).toEqual([
			[caller, TITLE, 'Quinarius coin1'],
			[mint, IRI, wIri('mint1')],
			[caller, PORTAL, `${SECTION}/${mint}`],
			[caller, PORTAL, `${SECTION}/${known}`],
			[mint, TITLE, 'Mint mint1'],
		]);
		expect(report?.written[0]?.component_label).toBeTruthy();
		expect((await wItems(caller, 'string', TITLE)).map((i) => i.value)).toEqual([
			'Quinarius coin1',
		]);
		expect(await linkedIds(caller)).toEqual([mint, known]);
		expect((await wItems(mint, 'string', TITLE)).map((i) => i.value)).toEqual(['Mint mint1']);

		// A second run: both terms are known now — one fetch (the coin), nothing written or created.
		const again = linkedDataSite({
			[wIri('coin1')]: rdfAnswer(coinDoc('coin1', ['mint1', 'known'])),
		});
		const second = track(await importRdfBatch(call, again.deps));
		expect(documentsAsked(again)).toEqual([wIri('coin1')]);
		expect(second.report[0]?.created).toEqual([]);
		expect(second.report[0]?.written).toEqual([]);
		// Nothing written, nothing created: no dd800 either (it is minted by the first write).
		expect(second.bulk_process_id).toBeNull();
		expect(await linkedIds(caller)).toEqual([mint, known]);
	});

	test('an unmapped type is a per-URI tool.rdf_class_unmapped: dumped, nothing written, no dd800', async () => {
		const caller = await wRecord();
		const site = linkedDataSite({
			[wIri('odd')]: rdfAnswer(coinDoc('odd', [], 'Odd')),
		});
		const result = track(
			await importRdfBatch(
				{
					uris: [wIri('odd')],
					ontologyTipo: W_ROOT,
					caller: { section_tipo: SECTION, section_id: caller },
					principal: ROOT_PRINCIPAL,
				},
				site.deps,
			),
		);
		expect(result.rdf.map((entry) => entry.uri)).toEqual([wIri('odd')]);
		expect(result.report).toEqual([]);
		expect(result.bulk_process_id).toBeNull();
		expect(result.errors).toHaveLength(1);
		const body = publicPart(result.errors[0]?.error) as Record<string, unknown>;
		expect(body).toMatchObject({
			code: 'tool.rdf_class_unmapped',
			category: 'caller',
			label_key: 'error_tool_rdf_class_unmapped',
			details: { type: 'ex:Odd' },
		});
		expect(await wItems(caller, 'string', TITLE)).toEqual([]);
	});

	test('a class of ANOTHER section is unmapped for this record (its components are not the caller’s)', async () => {
		const ontology = await loadRdfImportOntology(W_ROOT, engineRdfOntologyReader());
		const result = await runRdfImport({
			...runBase(await wRecord(), { [wIri('c-other')]: coinDoc('c-other', []) }),
			caller: { section_tipo: 'dd64', section_id: 1 },
			ontology,
		});
		expect(result.errors[0]?.error.code).toBe('tool.rdf_class_unmapped');
		expect(result.report).toEqual([]);
	});

	/** The run's input with a fake fetch (docs by IRI) and a clock the fetch advances. */
	function runBase(
		caller: number,
		docs: Record<string, string | DedaloError>,
		costMs: Record<string, number> = {},
	) {
		let now = 0;
		const asked: string[] = [];
		return {
			asked,
			uris: Object.keys(docs).slice(0, 1),
			langs: { data: [{ code: 'lg-eng', alpha2: 'en' }], current: 'lg-eng' },
			caller: { section_tipo: SECTION, section_id: caller },
			principal: ROOT_PRINCIPAL,
			deadlineMs: 10_000,
			now: () => now,
			lookup: findTermRecord,
			readDocument: async (iri: string, budget: number) => {
				asked.push(`${iri} ${budget}`);
				now += costMs[iri] ?? 0;
				const doc = docs[iri];
				if (doc === undefined) throw new DedaloError('security.outbound_failed');
				if (doc instanceof DedaloError) throw doc;
				return doc;
			},
		};
	}

	async function run(base: ReturnType<typeof runBase>): Promise<RdfImportResult> {
		const ontology = await loadRdfImportOntology(W_ROOT, engineRdfOntologyReader());
		return track(await runRdfImport({ ...base, ontology }));
	}

	test('a term that does not fit the IRI’s budget is NOT linked — "not fetched — run again" — and the next run completes it', async () => {
		const caller = await wRecord();
		const docs = {
			[wIri('coin2')]: coinDoc('coin2', ['mint2']),
			[wIri('mint2')]: mintDoc('mint2'),
		};
		const slow = runBase(caller, docs, { [wIri('coin2')]: 10_000 - RDF_LINKED_MIN_MS + 1 });
		const first = await run(slow);
		expect(slow.asked).toEqual([`${wIri('coin2')} 10000`]);
		expect(first.report[0]?.created).toEqual([]);
		expect(first.report[0]?.skipped).toEqual([
			{
				component_tipo: PORTAL,
				reason: RDF_NOT_FETCHED,
				iri: wIri('mint2'),
				component_label: expect.any(String),
			},
		]);
		expect(await linkedIds(caller)).toEqual([]);

		// The budget left is what the linked fetch is given.
		const timely = runBase(caller, docs, { [wIri('coin2')]: 4_000 });
		const second = await run(timely);
		expect(timely.asked).toEqual([`${wIri('coin2')} 10000`, `${wIri('mint2')} 6000`]);
		const mint = second.report[0]?.created[0]?.section_id as number;
		expect(mint).toBeGreaterThan(0);
		// The title the first run wrote is never overwritten.
		expect(second.report[0]?.skipped.map((s) => s.reason)).toEqual([
			'not empty in lg-eng — never overwritten',
		]);
		expect(await linkedIds(caller)).toEqual([mint]);
	});

	test('a fetched term linking a term the main plan names LATER: fetched once, linked after it exists', async () => {
		const caller = await wRecord();
		const base = runBase(caller, {
			[wIri('coin6')]: coinDoc('coin6', ['m6a', 'm6b']),
			[wIri('m6a')]: mintDoc('m6a', 'm6b'),
			[wIri('m6b')]: mintDoc('m6b'),
		});
		const result = await run(base);
		expect(result.errors).toEqual([]);
		expect(base.asked.map((line) => line.split(' ')[0])).toEqual([
			wIri('coin6'),
			wIri('m6a'),
			wIri('m6b'),
		]);
		const [report] = result.report;
		expect(report?.skipped).toEqual([]);
		const [a, b] = (report?.created ?? []).map((c) => c.section_id) as [number, number];
		expect(report?.created.map((c) => c.label)).toEqual([wIri('m6a'), wIri('m6b')]);
		expect(await linkedIds(caller)).toEqual([a, b]);
		expect(await linkedIds(a)).toEqual([b]);
	});

	test('a site out of service drops the term for the next run; a permanent failure links it by IRI only', async () => {
		const caller = await wRecord();
		const down = runBase(caller, {
			[wIri('coin3')]: coinDoc('coin3', ['mint3a', 'mint3b']),
			[wIri('mint3a')]: new DedaloError('tool.source_unavailable', {
				details: { site: 'https://ld.test' },
			}),
			[wIri('mint3b')]: new DedaloError('harvest.unexpected_type'),
		});
		const result = await run(down);
		const [report] = result.report;
		expect(report?.created.map((c) => c.label)).toEqual([wIri('mint3b')]);
		const mint = report?.created[0]?.section_id as number;
		expect(report?.skipped.map((s) => [s.component_tipo, s.reason, s.iri])).toEqual([
			[PORTAL, RDF_NOT_FETCHED, wIri('mint3a')],
			[IRI, 'not fetched (harvest.unexpected_type) — linked by its IRI only', wIri('mint3b')],
		]);
		expect(await linkedIds(caller)).toEqual([mint]);
		expect((await wItems(mint, 'iri', IRI)).map((i) => i.iri)).toEqual([wIri('mint3b')]);
		expect(await wItems(mint, 'string', TITLE)).toEqual([]);
	});

	test('the linked-fetch cap: past RDF_MAX_LINKED_FETCHES a term waits for the next run', async () => {
		const caller = await wRecord();
		const names = Array.from({ length: RDF_MAX_LINKED_FETCHES + 1 }, (_, i) => `m4-${i}`);
		const docs: Record<string, string> = { [wIri('coin4')]: coinDoc('coin4', names) };
		for (const name of names) docs[wIri(name)] = mintDoc(name);
		const base = runBase(caller, docs);
		const result = await run(base);
		expect(base.asked).toHaveLength(RDF_MAX_LINKED_FETCHES + 1);
		expect(result.report[0]?.created).toHaveLength(RDF_MAX_LINKED_FETCHES);
		expect(result.report[0]?.skipped.map((s) => [s.reason, s.iri])).toEqual([
			[RDF_NOT_FETCHED, wIri(names[RDF_MAX_LINKED_FETCHES] as string)],
		]);
	});

	test('a FETCHED term’s own off-target link is pruned before its target is looked up or fetched', async () => {
		const caller = await wRecord();
		const badMint = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:skos="${SKOS}" xmlns:ex="${EX}">
  <ex:Mint rdf:about="${wIri('mintM')}"><skos:prefLabel xml:lang="en">Mint mintM</skos:prefLabel><ex:bad rdf:resource="${wIri('farM')}"/></ex:Mint>
</rdf:RDF>`;
		const base = runBase(caller, {
			[wIri('coinM')]: coinDoc('coinM', ['mintM']),
			[wIri('mintM')]: badMint,
			[wIri('farM')]: mintDoc('farM'),
		});
		let lookups = 0;
		const ontology = await loadRdfImportOntology(W_ROOT, engineRdfOntologyReader());
		const result = track(
			await runRdfImport({
				...base,
				ontology,
				lookup: async (op, principal) => {
					lookups += 1;
					return findTermRecord(op, principal);
				},
			}),
		);
		expect(result.errors).toEqual([]);
		// farM is reached only through mintM's off-target ex:bad: never looked up, never fetched.
		expect(base.asked.map((line) => line.split(' ')[0])).toEqual([wIri('coinM'), wIri('mintM')]);
		expect(lookups).toBe(1);
		const [report] = result.report;
		expect(report?.created.map((c) => c.label)).toEqual([wIri('mintM')]);
		const reason = `ontology zzrdfwire5 maps ${SECTION}, but ${SELECT} targets dd64 — fix the ontology node`;
		expect(report?.skipped.map((s) => [s.component_tipo, s.reason, s.code])).toEqual([
			[SELECT, reason, 'relation.insert_refused'],
		]);
		expect(await linkedIds(caller)).toEqual([report?.created[0]?.section_id as number]);
	});

	test('a link the ontology maps OFF TARGET is skipped before any lookup or fetch; the rest of the IRI is written', async () => {
		const caller = await wRecord();
		await knownTerm(wIri('known5'));
		// ex:other (zzrdfwire8) links a Mint (test3) from test91, a select over dd64: the
		// ontology node maps a section the component does not target. Neither term is
		// looked up, fetched or created; the title of the same IRI is written.
		const doc = coinDoc('coin5', ['known5', 'mint5'], 'Broken', 'other');
		const base = runBase(caller, { [wIri('coin5')]: doc, [wIri('mint5')]: mintDoc('mint5') });
		let lookups = 0;
		const ontology = await loadRdfImportOntology(W_ROOT, engineRdfOntologyReader());
		const result = track(
			await runRdfImport({
				...base,
				ontology,
				lookup: async (op, principal) => {
					lookups += 1;
					return findTermRecord(op, principal);
				},
			}),
		);
		expect(lookups).toBe(0);
		expect(base.asked).toEqual([`${wIri('coin5')} 10000`]);
		expect(result.errors).toEqual([]);
		const [report] = result.report;
		expect(report?.created).toEqual([]);
		expect(report?.written.map((w) => [w.section_id, w.component_tipo, w.value_summary])).toEqual([
			[caller, TITLE, 'Quinarius coin5'],
		]);
		const reason = `ontology zzrdfwire5 maps ${SECTION}, but ${SELECT} targets dd64 — fix the ontology node`;
		expect(report?.skipped.map((s) => [s.component_tipo, s.reason, s.code])).toEqual([
			[SELECT, reason, 'relation.insert_refused'],
			[SELECT, reason, 'relation.insert_refused'],
		]);
		expect((await wItems(caller, 'string', TITLE)).map((i) => i.value)).toEqual([
			'Quinarius coin5',
		]);
		expect(await linkedIds(caller, SELECT)).toEqual([]);
		expect(
			await findTermRecord(
				{ section_tipo: SECTION, match_component_tipo: IRI, match_value: wIri('mint5') },
				ROOT_PRINCIPAL,
			),
		).toBeNull();

		// Through the harvesting door itself: the hop seam is asked for the coin only.
		const other = await wRecord();
		const site = linkedDataSite({
			[wIri('coin5')]: rdfAnswer(doc),
			[wIri('mint5')]: rdfAnswer(mintDoc('mint5')),
		});
		const door = track(
			await importRdfBatch(
				{
					uris: [wIri('coin5')],
					ontologyTipo: W_ROOT,
					caller: { section_tipo: SECTION, section_id: other },
					principal: ROOT_PRINCIPAL,
				},
				site.deps,
			),
		);
		expect(documentsAsked(site)).toEqual([wIri('coin5')]);
		expect(door.errors).toEqual([]);
		expect(door.report[0]?.created).toEqual([]);
		expect(door.report[0]?.skipped.map((s) => s.code)).toEqual([
			'relation.insert_refused',
			'relation.insert_refused',
		]);
	});

	test('a fetched term held by NO record under its own IRI but by ONE under an exactMatch: linked, its IRI appended, nothing created; the next run fetches nothing', async () => {
		const existing = await knownTerm(eqIri('eqA'));
		const caller = await wRecord();
		const docs = {
			[wIri('coinEqA')]: coinDoc('coinEqA', ['mintEqA']),
			[wIri('mintEqA')]: mintEqDoc('mintEqA', [eqIri('eqA'), eqIri('eqA-other')]),
		};
		const first = runBase(caller, docs);
		const result = await run(first);
		expect(result.errors).toEqual([]);
		expect(first.asked.map((line) => line.split(' ')[0])).toEqual([
			wIri('coinEqA'),
			wIri('mintEqA'),
		]);
		expect(result.report[0]?.created).toEqual([]);
		expect(await linkedIds(caller)).toEqual([existing]);
		// ONLY the source IRI is appended (after what it held); the term's other
		// equivalent and its label are not written into the matched record.
		expect((await wItems(existing, 'iri', IRI)).map((i) => i.iri)).toEqual([
			eqIri('eqA'),
			wIri('mintEqA'),
		]);
		expect(await wItems(existing, 'string', TITLE)).toEqual([]);
		expect(
			result.report[0]?.written.map((w) => [w.section_id, w.component_tipo, w.value_summary]),
		).toEqual([
			[caller, TITLE, 'Quinarius coinEqA'],
			[existing, IRI, wIri('mintEqA')],
			[caller, PORTAL, `${SECTION}/${existing}`],
		]);

		// The record now holds the term's own IRI: matched directly, never fetched.
		const second = runBase(caller, docs);
		const again = await run(second);
		expect(second.asked.map((line) => line.split(' ')[0])).toEqual([wIri('coinEqA')]);
		expect(again.report[0]?.created).toEqual([]);
		expect(again.report[0]?.written).toEqual([]);
		expect(await linkedIds(caller)).toEqual([existing]);

		// The append is the ONE write into a record the import did not create: the
		// run's revert takes it back with the rest — the record holds what it held.
		const reverted = (await toolTimeMachineBulkRevert({
			principal: ROOT_PRINCIPAL,
			userId: -1,
			background: false,
			options: {
				section_tipo: SECTION,
				bulk_process_id: mustGet(result.bulk_process_id, 'run bulk id'),
			},
		} as ToolActionContext)) as { data: { bulk_process_id: number; skipped: unknown[] } };
		wBulk.add(reverted.data.bulk_process_id);
		expect(reverted.data.skipped).toEqual([]);
		expect((await wItems(existing, 'iri', IRI)).map((i) => i.iri)).toEqual([eqIri('eqA')]);
		expect(await linkedIds(caller)).toEqual([]);
		expect(await wItems(caller, 'string', TITLE)).toEqual([]);
	});

	test('ONE record holding SEVERAL of the term’s exactMatch IRIs is the term: linked, its IRI appended once', async () => {
		const existing = await knownTerm(eqIri('eqE1'));
		const appended = await saveComponentData({
			componentTipo: IRI,
			sectionTipo: SECTION,
			sectionId: existing,
			lang: 'lg-nolan',
			changedData: [
				{
					action: 'set_data',
					id: null,
					value: [{ iri: eqIri('eqE1') }, { iri: eqIri('eqE2') }],
				},
			],
			userId: -1,
		});
		expect(appended.ok).toBe(true);
		const caller = await wRecord();
		const result = await run(
			runBase(caller, {
				[wIri('coinEqE')]: coinDoc('coinEqE', ['mintEqE']),
				[wIri('mintEqE')]: mintEqDoc('mintEqE', [eqIri('eqE1'), eqIri('eqE2')]),
			}),
		);
		expect(result.errors).toEqual([]);
		expect(result.report[0]?.created).toEqual([]);
		expect(result.report[0]?.skipped).toEqual([]);
		expect(await linkedIds(caller)).toEqual([existing]);
		expect((await wItems(existing, 'iri', IRI)).map((i) => i.iri)).toEqual([
			eqIri('eqE1'),
			eqIri('eqE2'),
			wIri('mintEqE'),
		]);
	});

	test('a term matched by an exactMatch drops its WHOLE fetched plan: its own off-target link is not reported (never attempted)', async () => {
		const existing = await knownTerm(eqIri('eqQ'));
		const caller = await wRecord();
		const mint = mintEqDoc('mintEqQ', [eqIri('eqQ')]).replace(
			'</ex:Mint>',
			`<ex:bad rdf:resource="${wIri('farQ')}"/></ex:Mint>`,
		);
		const base = runBase(caller, {
			[wIri('coinEqQ')]: coinDoc('coinEqQ', ['mintEqQ']),
			[wIri('mintEqQ')]: mint,
			[wIri('farQ')]: mintDoc('farQ'),
		});
		const result = await run(base);
		expect(result.errors).toEqual([]);
		expect(base.asked.map((line) => line.split(' ')[0])).toEqual([
			wIri('coinEqQ'),
			wIri('mintEqQ'),
		]);
		expect(result.report[0]?.created).toEqual([]);
		expect(result.report[0]?.skipped).toEqual([]);
		expect(await linkedIds(caller)).toEqual([existing]);
	});

	test('two NEW terms sharing an exactMatch in one run: the first is created, the second matched by it — given ONLY its own IRI, its fetched fields withheld', async () => {
		// Both are unknown when the run looks them up (before anything executes), so
		// both are fetched and keep their plans; at execute time the second finds the
		// first's record by the shared equivalent.
		const caller = await wRecord();
		const result = await run(
			runBase(caller, {
				[wIri('coinEqH')]: coinDoc('coinEqH', ['mintEqH1', 'mintEqH2']),
				[wIri('mintEqH1')]: mintEqDoc('mintEqH1', [eqIri('eqH')]),
				[wIri('mintEqH2')]: mintEqDoc('mintEqH2', [eqIri('eqH'), eqIri('eqH-2')]),
			}),
		);
		expect(result.errors).toEqual([]);
		const [report] = result.report;
		expect(report?.created.map((c) => c.label)).toEqual([wIri('mintEqH1')]);
		const mint = report?.created[0]?.section_id as number;
		expect(await linkedIds(caller)).toEqual([mint]);
		// ONLY the second's own IRI (appended when it is matched), then the first's
		// own fields — never the second's other equivalent (eqH-2) nor its label.
		expect((await wItems(mint, 'iri', IRI)).map((i) => i.iri)).toEqual([
			wIri('mintEqH1'),
			wIri('mintEqH2'),
			eqIri('eqH'),
		]);
		expect((await wItems(mint, 'string', TITLE)).map((i) => i.value)).toEqual(['Mint mintEqH1']);
		const withheld = report?.skipped.filter((s) => s.section_id === mint) ?? [];
		expect(withheld.map((s) => [s.component_tipo, s.reason])).toEqual([
			[TITLE, RDF_EQUIVALENT_WITHHELD],
			[IRI, RDF_EQUIVALENT_WITHHELD],
		]);
	});

	test('a term an EARLIER IRI of the run created is matched by its equivalent at execute time: given ONLY its own IRI, its fetched fields withheld', async () => {
		// Both IRIs are prepared (looked up, fetched) before either executes: the
		// second's term is unknown then, so its fetched plan is kept — and must still
		// not be applied to the record the first IRI created.
		const caller = await wRecord();
		const base = runBase(caller, {
			[wIri('coinEqJ1')]: coinDoc('coinEqJ1', ['mintEqJ1']),
			[wIri('coinEqJ2')]: coinDoc('coinEqJ2', ['mintEqJ2']),
			[wIri('mintEqJ1')]: mintEqDoc('mintEqJ1', [eqIri('eqJ')]),
			[wIri('mintEqJ2')]: mintEqDoc('mintEqJ2', [eqIri('eqJ'), eqIri('eqJ-2')]),
		});
		const result = await run({ ...base, uris: [wIri('coinEqJ1'), wIri('coinEqJ2')] });
		expect(result.errors).toEqual([]);
		const [first, second] = result.report;
		expect(first?.created.map((c) => c.label)).toEqual([wIri('mintEqJ1')]);
		expect(second?.created).toEqual([]);
		const mint = first?.created[0]?.section_id as number;
		expect(await linkedIds(caller)).toEqual([mint]);
		expect((await wItems(mint, 'iri', IRI)).map((i) => i.iri)).toEqual([
			wIri('mintEqJ1'),
			eqIri('eqJ'),
			wIri('mintEqJ2'),
		]);
		expect((await wItems(mint, 'string', TITLE)).map((i) => i.value)).toEqual(['Mint mintEqJ1']);
		expect(
			second?.skipped.filter((s) => s.section_id === mint).map((s) => [s.component_tipo, s.reason]),
		).toEqual([
			[TITLE, RDF_EQUIVALENT_WITHHELD],
			[IRI, RDF_EQUIVALENT_WITHHELD],
		]);
	});

	test('ONE exactMatch IRI that TWO records already share: a conflict — nothing created, linked or appended', async () => {
		const one = await knownTerm(eqIri('eqF'));
		const two = await knownTerm(eqIri('eqF'));
		const caller = await wRecord();
		const result = await run(
			runBase(caller, {
				[wIri('coinEqF')]: coinDoc('coinEqF', ['mintEqF']),
				[wIri('mintEqF')]: mintEqDoc('mintEqF', [eqIri('eqF')]),
			}),
		);
		expect(result.errors).toEqual([]);
		expect(result.report[0]?.created).toEqual([]);
		expect(result.report[0]?.skipped.map((s) => s.reason)).toEqual([
			expect.stringContaining(`held by 2 different records (${one}, ${two})`),
			expect.stringMatching(/^record '.+' not resolved$/),
		]);
		expect(await linkedIds(caller)).toEqual([]);
		expect((await wItems(one, 'iri', IRI)).map((i) => i.iri)).toEqual([eqIri('eqF')]);
		expect((await wItems(two, 'iri', IRI)).map((i) => i.iri)).toEqual([eqIri('eqF')]);
	});

	test('EVERY equivalent is searched, however many (RDF_EQUIVALENTS_PER_SEARCH per search) — its own and blanks not counted', async () => {
		const op = { section_tipo: SECTION, match_component_tipo: IRI, match_value: wIri('mintCap') };
		const many = (tag: string, n: number) =>
			Array.from({ length: n }, (_, i) => eqIri(`${tag}-${i}`));
		// Past two searches' worth, its own IRI and blanks in front.
		const full = many('capA', 2 * RDF_EQUIVALENTS_PER_SEARCH + 1);
		const padded = [` ${op.match_value} `, '', '  ', ...full];
		// None held: no record is the term (the creation case — never a refusal).
		expect(await findTermRecord({ ...op, match_equivalents: padded }, ROOT_PRINCIPAL)).toBeNull();
		// Only the LAST held (the third search): found.
		const last = await knownTerm(full.at(-1) as string);
		expect(await findTermRecord({ ...op, match_equivalents: padded }, ROOT_PRINCIPAL)).toBe(last);
		// The second (first search) and the last held by TWO records: a conflict naming both.
		const second = await knownTerm(full[1] as string);
		expect(await findTermRecord({ ...op, match_equivalents: full }, ROOT_PRINCIPAL)).toEqual(
			expect.stringContaining(`held by 2 different records (${second}, ${last})`),
		);
	});

	test('a fetched term naming more equivalents than one search: CREATED when none is held, LINKED when one past the first search is', async () => {
		const many = (tag: string) =>
			Array.from({ length: RDF_EQUIVALENTS_PER_SEARCH + 2 }, (_, i) => eqIri(`${tag}-${i}`));
		const caller = await wRecord();
		const fresh = many('capD');
		const created = await run(
			runBase(caller, {
				[wIri('coinCapD')]: coinDoc('coinCapD', ['mintCapD']),
				[wIri('mintCapD')]: mintEqDoc('mintCapD', fresh),
			}),
		);
		expect(created.errors).toEqual([]);
		expect(created.report[0]?.skipped).toEqual([]);
		expect(created.report[0]?.created.map((c) => c.label)).toEqual([wIri('mintCapD')]);
		const mint = created.report[0]?.created[0]?.section_id as number;
		expect((await wItems(mint, 'iri', IRI)).map((i) => i.iri)).toEqual([
			wIri('mintCapD'),
			...fresh,
		]);

		const held = many('capE');
		const holder = await knownTerm(held[RDF_EQUIVALENTS_PER_SEARCH + 1] as string);
		const caller2 = await wRecord();
		const linked = await run(
			runBase(caller2, {
				[wIri('coinCapE')]: coinDoc('coinCapE', ['mintCapE']),
				[wIri('mintCapE')]: mintEqDoc('mintCapE', held),
			}),
		);
		expect(linked.errors).toEqual([]);
		expect(linked.report[0]?.created).toEqual([]);
		expect(await linkedIds(caller2)).toEqual([holder]);
	});

	test('an equivalent (or the own IRI) held under the OTHER http scheme is the same identifier: linked, nothing created', async () => {
		const httpOf = (iri: string) => iri.replace('https://', 'http://');
		// The record holds the http form of the term's exactMatch; the document names https.
		const existing = await knownTerm(httpOf(eqIri('eqT')));
		const caller = await wRecord();
		const result = await run(
			runBase(caller, {
				[wIri('coinEqT')]: coinDoc('coinEqT', ['mintEqT']),
				[wIri('mintEqT')]: mintEqDoc('mintEqT', [eqIri('eqT')]),
			}),
		);
		expect(result.errors).toEqual([]);
		expect(result.report[0]?.created).toEqual([]);
		expect(await linkedIds(caller)).toEqual([existing]);
		expect((await wItems(existing, 'iri', IRI)).map((i) => i.iri)).toEqual([
			httpOf(eqIri('eqT')),
			wIri('mintEqT'),
		]);

		// The record holds the http form of the term's OWN IRI: found before any fetch.
		const own = await knownTerm(httpOf(wIri('mintOwnT')));
		const caller2 = await wRecord();
		const base = runBase(caller2, {
			[wIri('coinOwnT')]: coinDoc('coinOwnT', ['mintOwnT']),
			[wIri('mintOwnT')]: mintDoc('mintOwnT'),
		});
		const second = await run(base);
		expect(base.asked.map((line) => line.split(' ')[0])).toEqual([wIri('coinOwnT')]);
		expect(second.report[0]?.created).toEqual([]);
		expect(await linkedIds(caller2)).toEqual([own]);
		// A trailing slash is ANOTHER identifier (compared byte for byte).
		expect(
			await findTermRecord(
				{ section_tipo: SECTION, match_component_tipo: IRI, match_value: `${wIri('mintOwnT')}/` },
				ROOT_PRINCIPAL,
			),
		).toBeNull();
	});

	test('equivalentsOf reads ONLY the term’s own identity sets — never a sibling’s in the same match component', () => {
		const termOp = {
			op: 'find_or_create',
			key: 'mint',
			section_tipo: SECTION,
			match_component_tipo: IRI,
			match_value: wIri('eqG'),
		} as unknown as RdfFindOrCreateOp;
		const identity = (key: string, iri: string, component = IRI) =>
			({
				op: 'set',
				target: { kind: 'found_or_created', key },
				section_tipo: SECTION,
				component_tipo: component,
				lang: 'lg-nolan',
				value: [{ iri }],
			}) as unknown as RdfImportOp;
		expect(
			equivalentsOf(termOp, [
				identity('mint', wIri('eqG')),
				identity('mint', eqIri('eqG-own')),
				identity('sibling', eqIri('eqG-sibling')),
				identity('mint', eqIri('eqG-title'), TITLE),
				{
					...(identity('mint', eqIri('eqG-caller')) as object),
					target: { kind: 'caller' },
				} as RdfImportOp,
			]),
		).toEqual([eqIri('eqG-own')]);
	});

	test('a fetched term whose exactMatch IRIs are held by TWO different records: a conflict naming both — nothing created, linked or appended', async () => {
		const one = await knownTerm(eqIri('eqB1'));
		const two = await knownTerm(eqIri('eqB2'));
		const caller = await wRecord();
		const result = await run(
			runBase(caller, {
				[wIri('coinEqB')]: coinDoc('coinEqB', ['mintEqB']),
				[wIri('mintEqB')]: mintEqDoc('mintEqB', [eqIri('eqB1'), eqIri('eqB2')]),
			}),
		);
		expect(result.errors).toEqual([]);
		expect(result.report[0]?.created).toEqual([]);
		const reasons = result.report[0]?.skipped.map((s) => s.reason) ?? [];
		expect(reasons).toEqual([
			expect.stringContaining(`held by 2 different records (${one}, ${two})`),
			expect.stringMatching(/^record '.+' not resolved$/),
		]);
		expect(await linkedIds(caller)).toEqual([]);
		expect((await wItems(one, 'iri', IRI)).map((i) => i.iri)).toEqual([eqIri('eqB1')]);
		expect((await wItems(two, 'iri', IRI)).map((i) => i.iri)).toEqual([eqIri('eqB2')]);
	});

	test('a fetched term whose exactMatch IRIs no record holds is CREATED, holding its IRI and them', async () => {
		const caller = await wRecord();
		const result = await run(
			runBase(caller, {
				[wIri('coinEqC')]: coinDoc('coinEqC', ['mintEqC']),
				[wIri('mintEqC')]: mintEqDoc('mintEqC', [eqIri('eqC')]),
			}),
		);
		expect(result.errors).toEqual([]);
		const created = result.report[0]?.created ?? [];
		expect(created).toHaveLength(1);
		const mint = created[0]?.section_id as number;
		expect(await linkedIds(caller)).toEqual([mint]);
		expect((await wItems(mint, 'iri', IRI)).map((i) => i.iri)).toEqual([
			wIri('mintEqC'),
			eqIri('eqC'),
		]);
	});

	test('the ONE lookup rule (run and executor): own IRI first, then the equivalents an op carries — trimmed, blanks and its own dropped', async () => {
		const existing = await knownTerm(eqIri('eqD'));
		const op = {
			section_tipo: SECTION,
			match_component_tipo: IRI,
			match_value: wIri('mintEqD'),
		};
		expect(await findTermRecord(op, ROOT_PRINCIPAL)).toBeNull();
		expect(
			await findTermRecord({ ...op, match_equivalents: [` ${eqIri('eqD')} `, ''] }, ROOT_PRINCIPAL),
		).toBe(existing);
		// An equivalent equal to the own IRI is not searched twice.
		expect(
			await findTermRecord(
				{ ...op, match_value: eqIri('eqD'), match_equivalents: [eqIri('eqD')] },
				ROOT_PRINCIPAL,
			),
		).toBe(existing);
		// The own IRI WINS: one record holds it, ANOTHER holds an equivalent — the
		// first is the term (an equivalents-first rule would bind the second and give
		// it the own IRI too: two records sharing it, every later lookup a conflict).
		const ownHolder = await knownTerm(wIri('mintOwnWins'));
		const eqHolder = await knownTerm(eqIri('eqOwnWins'));
		expect(
			await findTermRecord(
				{ ...op, match_value: wIri('mintOwnWins'), match_equivalents: [eqIri('eqOwnWins')] },
				ROOT_PRINCIPAL,
			),
		).toBe(ownHolder);
		expect(eqHolder).not.toBe(ownHolder);
	});

	test('an AMBIGUOUS linked term (two records share its IRI) is never fetched; the executor reports it', async () => {
		await knownTerm(wIri('mintAmb'));
		await knownTerm(wIri('mintAmb'));
		const caller = await wRecord();
		const base = runBase(caller, {
			[wIri('coinAmb')]: coinDoc('coinAmb', ['mintAmb']),
			[wIri('mintAmb')]: mintDoc('mintAmb'),
		});
		const result = await run(base);
		expect(base.asked).toEqual([`${wIri('coinAmb')} 10000`]);
		expect(result.report[0]?.created).toEqual([]);
		expect(result.report[0]?.skipped.map((s) => s.reason)).toEqual([
			expect.stringContaining('more than one record'),
			expect.stringMatching(/^record '.+' not resolved$/),
		]);
		expect(await linkedIds(caller)).toEqual([]);
	});

	test('a linked term described under the OTHER http scheme (a redirect) is planned from its document', async () => {
		const caller = await wRecord();
		const mintIri = wIri('mint12');
		const httpForm = mintIri.replace('https://', 'http://');
		const base = runBase(caller, {
			[wIri('coin12')]: coinDoc('coin12', ['mint12']),
			[mintIri]: mintDoc('mint12').replace(`rdf:about="${mintIri}"`, `rdf:about="${httpForm}"`),
		});
		const result = await run(base);
		expect(result.errors).toEqual([]);
		const [report] = result.report;
		expect(report?.created.map((c) => c.label)).toEqual([mintIri]);
		const mint = report?.created[0]?.section_id as number;
		expect(
			report?.written.filter((w) => w.section_id === mint).map((w) => w.component_tipo),
		).toEqual([IRI, TITLE]);
		expect((await wItems(mint, 'string', TITLE)).map((i) => i.value)).toEqual(['Mint mint12']);
	});

	test('a dropped term linked through TWO components is reported on the FIRST that links it', async () => {
		const caller = await wRecord();
		const term = wIri('mint13');
		const coin = coinDoc('coin13', ['mint13']).replace(
			'</ex:Coin>',
			`<ex:issuer rdf:resource="${term}"/></ex:Coin>`,
		);
		const base = runBase(caller, {
			[wIri('coin13')]: coin,
			[term]: new DedaloError('tool.source_unavailable', { details: { site: 'https://ld.test' } }),
		});
		const result = await run(base);
		expect(result.report[0]?.created).toEqual([]);
		// ex:issuer (test91 → dd64) is OFF TARGET for a Mint: pruned first, with the
		// ontology's reason. The dropped term is still reported once, on the portal.
		expect(result.report[0]?.skipped.map((s) => [s.component_tipo, s.reason, s.iri])).toEqual([
			[
				SELECT,
				`ontology zzrdfwire5 maps ${SECTION}, but ${SELECT} targets dd64 — fix the ontology node`,
				undefined,
			],
			[PORTAL, RDF_NOT_FETCHED, term],
		]);
		expect(await linkedIds(caller)).toEqual([]);
	});

	test('a link to a VIRTUAL section’s record never completes an intermediate whose path names the real one', async () => {
		// The rerun walks the path through locators INTO the step's own section
		// (linkedIntermediate): a creator linking a person of the virtual section
		// would never be found again — so it is never created.
		const person = wIri('vperson');
		const caller = await wRecord();
		const base = { ontology_tipo: 'zzrdfwire11', rdf_predicate: 'ex:creator' } as const;
		const ops: RdfImportOp[] = [
			{
				...base,
				op: 'intermediate',
				key: 'creator',
				target: { kind: 'caller' },
				section_tipo: SECTION,
				component_tipo: PORTAL,
				model: null,
				intermediate_section_tipo: SECTION,
				match_value: person,
				path: [
					{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
					{ section_tipo: SECTION, component_tipo: PORTAL, parent: PORTAL },
					{ section_tipo: SECTION, component_tipo: IRI, parent: PORTAL },
				],
			},
			{
				...base,
				op: 'find_or_create',
				key: 'person',
				class_tipo: 'zzrdfwire5',
				section_tipo: W_VIRTUAL,
				match_component_tipo: IRI,
				match_model: 'component_iri',
				match_lang: 'lg-nolan',
				match_value: person,
				match_item: { iri: person },
				needs_fetch_iri: null,
			},
			{
				...base,
				op: 'link',
				target: { kind: 'found_or_created', key: 'creator' },
				section_tipo: SECTION,
				component_tipo: PORTAL,
				model: null,
				to: { kind: 'found_or_created', key: 'person' },
				to_section_tipo: W_VIRTUAL,
			},
		];
		const report = await executeRdfImport({
			caller: { section_tipo: SECTION, section_id: caller },
			plans: [{ subject: wIri('vcoin'), class_tipo: 'zzrdfwire2', section_tipo: SECTION, ops }],
			principal: ROOT_PRINCIPAL,
		});
		if (report.bulk_process_id !== null) wBulk.add(report.bulk_process_id);
		expect(report.iris[0]?.error).toBeNull();
		expect(report.created.map((c) => c.section_tipo)).toEqual([W_VIRTUAL]);
		expect(report.skipped.map((s) => s.reason)).toEqual([
			`intermediate not created — no record of ${person} was linked`,
			"record 'creator' not created",
		]);
		expect(await linkedIds(caller)).toEqual([]);
	});

	test('a term dropped as "not fetched" takes its INTERMEDIATE with it: no empty orphan, the next run links ONE', async () => {
		const caller = await wRecord();
		const docs = { [wIri('coin11')]: coinDoc('coin11', ['p11'], 'Coin', 'creator') };
		const down = runBase(caller, {
			...docs,
			[wIri('p11')]: new DedaloError('tool.source_unavailable', {
				details: { site: 'https://ld.test' },
			}),
		});
		const first = await run(down);
		expect(first.report[0]?.created).toEqual([]);
		expect(first.report[0]?.skipped.map((s) => [s.component_tipo, s.reason, s.iri])).toEqual([
			[PORTAL, RDF_NOT_FETCHED, wIri('p11')],
		]);
		expect(await linkedIds(caller)).toEqual([]);

		const up = runBase(caller, { ...docs, [wIri('p11')]: mintDoc('p11') });
		const second = await run(up);
		expect(second.errors).toEqual([]);
		// The person first: the creator is created by the link that completes its path.
		const [personId, creatorId] = (second.report[0]?.created ?? []).map((c) => c.section_id);
		expect(second.report[0]?.created.map((c) => c.label)).toEqual([wIri('p11'), wIri('p11')]);
		expect(await linkedIds(caller)).toEqual([creatorId as number]);
		expect(await linkedIds(creatorId as number)).toEqual([personId as number]);

		// A third run finds the intermediate through its path: nothing new.
		const third = await run(runBase(caller, docs));
		expect(third.report[0]?.created).toEqual([]);
		expect(await linkedIds(caller)).toEqual([creatorId as number]);
	});

	test(`linked terms are LOOKED UP at most ${RDF_MAX_LINKED_LOOKUPS} per IRI, and dropped in one pass however many a document names`, async () => {
		const caller = await wRecord();
		const count = 5_000;
		const names = Array.from({ length: count }, (_, i) => `m12-${i}`);
		const doc = coinDoc('coin12', names);
		const base = runBase(caller, { [wIri('coin12')]: doc });
		let lookups = 0;
		const ontology = await loadRdfImportOntology(W_ROOT, engineRdfOntologyReader());
		const started = performance.now();
		const result = track(
			await runRdfImport({
				...base,
				ontology,
				lookup: async () => {
					lookups += 1;
					return null;
				},
				readDocument: async (iri: string, budget: number) => {
					base.asked.push(`${iri} ${budget}`);
					if (iri === wIri('coin12')) return doc;
					throw new DedaloError('tool.source_unavailable', {
						details: { site: 'https://ld.test' },
					});
				},
			}),
		);
		const elapsed = performance.now() - started;
		expect(lookups).toBe(RDF_MAX_LINKED_LOOKUPS);
		expect(base.asked).toHaveLength(1 + RDF_MAX_LINKED_FETCHES);
		const skipped = result.report[0]?.skipped ?? [];
		expect(skipped.map((s) => s.iri)).toEqual(names.map((name) => wIri(name)));
		expect(skipped.map((s) => s.reason)).toEqual([
			...Array(RDF_MAX_LINKED_LOOKUPS).fill(RDF_NOT_FETCHED),
			...Array(count - RDF_MAX_LINKED_LOOKUPS).fill(RDF_TOO_MANY_LINKED),
		]);
		expect(new Set(skipped.map((s) => s.component_tipo))).toEqual(new Set([PORTAL]));
		expect(result.report[0]?.created).toEqual([]);
		expect(await linkedIds(caller)).toEqual([]);
		// Linear, not one op-list rebuild per dropped term (quadratic: seconds at this size).
		expect(elapsed).toBeLessThan(4_000);
	});

	test('a plan imports into its own section or a VIRTUAL one of it, never another', async () => {
		expect(await importsInto(SECTION, SECTION)).toBe(true);
		expect(await importsInto(SECTION, W_VIRTUAL)).toBe(true);
		// A class relating the VIRTUAL section itself, the tool opened on it (or on its real one).
		expect(await importsInto(W_VIRTUAL, W_VIRTUAL)).toBe(true);
		expect(await importsInto(W_VIRTUAL, SECTION)).toBe(true);
		expect(await importsInto(W_VIRTUAL, 'dd64')).toBe(false);
		expect(await importsInto(SECTION, 'dd64')).toBe(false);
		expect(await importsInto(null, SECTION)).toBe(false);
	});

	test('withoutKey drops the record, what reaches it, and what reaches an intermediate under it', () => {
		const base = { ontology_tipo: 'zzrdfwire4', rdf_predicate: 'ex:p', section_tipo: SECTION };
		const ref = (key: string) => ({ kind: 'found_or_created' as const, key });
		const caller = { kind: 'caller' as const };
		const fc = (key: string): RdfImportOp => ({
			...base,
			op: 'find_or_create',
			key,
			class_tipo: 'zzrdfwire5',
			match_component_tipo: IRI,
			match_model: 'component_iri',
			match_lang: 'lg-nolan',
			match_value: key,
			match_item: { iri: key },
			needs_fetch_iri: null,
		});
		const ops: RdfImportOp[] = [
			fc('a'),
			fc('b'),
			{
				...base,
				op: 'link',
				target: caller,
				component_tipo: PORTAL,
				model: null,
				to: ref('a'),
				to_section_tipo: SECTION,
			},
			{
				...base,
				op: 'intermediate',
				key: 'i',
				target: ref('a'),
				component_tipo: PORTAL,
				model: null,
				intermediate_section_tipo: SECTION,
				match_value: 'x',
				path: [],
			},
			{
				...base,
				op: 'link',
				target: ref('i'),
				component_tipo: PORTAL,
				model: null,
				to: ref('b'),
				to_section_tipo: SECTION,
			},
			{
				...base,
				op: 'set',
				target: ref('b'),
				component_tipo: TITLE,
				model: null,
				lang: 'lg-eng',
				value: [],
			},
			{ ...base, op: 'skip', target: ref('a'), component_tipo: null, reason: 'blank_node' },
		];
		const { kept, removed } = withoutKey(ops, 'a');
		expect(kept.map((op) => op.op)).toEqual(['find_or_create', 'set']);
		expect(removed.map((op) => op.op)).toEqual([
			'find_or_create',
			'link',
			'intermediate',
			'link',
			'skip',
		]);
	});

	test('withoutKey: an intermediate dies with the record of ITS OWN identifier (nested too), never with another', () => {
		const base = {
			ontology_tipo: 'zzrdfwire11',
			rdf_predicate: 'ex:creator',
			section_tipo: SECTION,
		};
		const ref = (key: string) => ({ kind: 'found_or_created' as const, key });
		const fc = (key: string, identifier: string): RdfImportOp => ({
			...base,
			op: 'find_or_create',
			key,
			class_tipo: 'zzrdfwire5',
			match_component_tipo: IRI,
			match_model: 'component_iri',
			match_lang: 'lg-nolan',
			match_value: identifier,
			match_item: { iri: identifier },
			needs_fetch_iri: identifier,
		});
		const inter = (
			key: string,
			target: ReturnType<typeof ref> | { kind: 'caller' },
		): RdfImportOp => ({
			...base,
			op: 'intermediate',
			key,
			target,
			component_tipo: PORTAL,
			model: null,
			intermediate_section_tipo: SECTION,
			match_value: 'p',
			path: [],
		});
		const linkOp = (from: string, to: string): RdfImportOp => ({
			...base,
			op: 'link',
			target: ref(from),
			component_tipo: PORTAL,
			model: null,
			to: ref(to),
			to_section_tipo: SECTION,
		});
		const ops: RdfImportOp[] = [
			inter('I', { kind: 'caller' }),
			inter('J', ref('I')), // nested, pinned to the same resource
			fc('P', 'p'),
			linkOp('J', 'P'),
			fc('R', 'r'), // a second term under J (a role): not what J is found by
			linkOp('J', 'R'),
		];
		const keysOf = (list: RdfImportOp[]) =>
			list.map((op) =>
				'key' in op ? op.key : `${op.op}>${(op as { to: { key: string } }).to.key}`,
			);
		// The role dropped: the intermediates stay (their path still leads to p).
		expect(keysOf(withoutKey(ops, 'R').kept)).toEqual(['I', 'J', 'P', 'link>P']);
		// The person dropped: both intermediates go — they could never be found again.
		// The role's own record is not under them: it stays (only the links from J go).
		expect(keysOf(withoutKey(ops, ['P']).removed)).toEqual(['I', 'J', 'P', 'link>P', 'link>R']);
		expect(keysOf(withoutKey(ops, ['P']).kept)).toEqual(['R']);
	});

	test('the subject: the IRI, its `.rdf`-less form, or the other http scheme', () => {
		const graph = parseRdfGraph(coinDoc('s1', []));
		expect(subjectOf(graph, wIri('s1'))).toBe(wIri('s1'));
		expect(subjectOf(graph, `${wIri('s1')}.rdf`)).toBe(wIri('s1'));
		expect(subjectOf(graph, `${wIri('s1')}.RDF`)).toBe(wIri('s1'));
		expect(subjectOf(graph, wIri('s1').replace('https://', 'http://'))).toBe(wIri('s1'));
		const http = parseRdfGraph(coinDoc('s2', []).replace('https://', 'http://'));
		expect(subjectOf(http, wIri('s2'))).toBe(wIri('s2').replace('https://', 'http://'));
		expect(subjectOf(graph, 'urn:x:nothing')).toBe('urn:x:nothing');
	});
});
