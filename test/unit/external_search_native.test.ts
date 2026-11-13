/**
 * BEHAVIOUR TWIN — server-side external search (2026-08-06,
 * `WC-2026-08-06-external-search-request`).
 *
 * The path this covers replaces a call the BROWSER used to make directly
 * (service_autocomplete.js `zenon_engine`), so the request form is a live wire
 * contract against a third party: it is asserted BYTE FOR BYTE, not "shaped
 * like". The three deliberate divergences from the browser form — the
 * lang-derived `lng`, the removed empty-query sentinel, the caller-driven
 * limit/offset — each have a test that fails if they are quietly reverted.
 *
 * NO TEST HERE OPENS A SOCKET. Every case injects `fetchImpl` +
 * `assertPublicUrlImpl` through the transport's declared seams; a case that
 * must prove "no request was made" counts the calls on that stub.
 */
// Migrated to the generic `test` TLD 2026-08-19. The emitted-shape cases name the phase-2
// clones of the external section and its display fields (test7342 / test7344-test7347 —
// src/core/test_data/test_tld_tipo_map.json), and the ontology-resolution case — which
// used to be SKIPPED on every database, because the suite carried no external tree with
// an api_config — now BUILDS the external installation it needs (the `zzxs` situation)
// and runs unconditionally. Still no socket: the built api_config points at
// `external.invalid` and nothing here fetches.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getAlpha2FromCode } from '../../src/core/resolve/lang_names.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ExternalSearchResult } from '../../src/external/api/types.ts';
import { resetBreakerForOrigin } from '../../src/external/breaker.ts';
import type { ExternalServiceModel } from '../../src/external/descriptor_types.ts';
import { ExternalSearchUnsupportedError, ExternalServiceError } from '../../src/external/errors.ts';
import {
	assertExternalSearchable,
	drainInFlightExternalSearches,
	MAX_SEARCH_LIMIT,
	searchExternalService,
} from '../../src/external/search.ts';
import { zenon } from '../../src/external/services/zenon.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';
import { type ExternalFetchImpl, fetchExternalJson } from '../../src/external/transport.ts';

const HOST = 'zenon.dainst.org';
const ORIGIN = `https://${HOST}`;
const SEARCH_URL = `${ORIGIN}/api/v1/search`;
/** The generic `test` section the caller of these cases lives in. */
const SECTION = 'test3';

/** A realistic Zenon /search answer — the record sample, in search clothing. */
const SEARCH_PAYLOAD = {
	resultCount: 137,
	records: [
		{
			id: '000848571',
			title: 'Las acuñaciones provinciales romanas de Hispania ',
			authors: {
				primary: { 'Ripollès Alegre, P. P. (Pere Pau)': [] },
				secondary: [],
				corporate: [],
			},
			publicationDates: ['2010'],
		},
		{
			id: '001338683',
			title: 'Coinage of the Roman provinces',
			authors: { primary: { 'Burnett, Andrew': [] }, secondary: [], corporate: [] },
			publicationDates: ['1992', '1999'],
		},
	],
	status: 'OK',
};

const RESPONSE_MAP = [
	{ local: 'ar_records', remote: 'records' },
	{ local: 'msg', remote: 'status' },
] as const;

interface Recorder {
	readonly impl: ExternalFetchImpl;
	readonly urls: string[];
	readonly inits: Record<string, unknown>[];
}

function recordingFetch(payload: unknown = SEARCH_PAYLOAD, status = 200): Recorder {
	const urls: string[] = [];
	const inits: Record<string, unknown>[] = [];
	const impl: ExternalFetchImpl = async (url, init) => {
		urls.push(url);
		inits.push(init as unknown as Record<string, unknown>);
		return new Response(JSON.stringify(payload), { status });
	};
	return { impl, urls, inits };
}

/**
 * A fetch stub whose answer is held until the test releases it — the only way
 * to observe IN-FLIGHT coalescing deterministically. With an immediately
 * resolving stub the first call can run to completion (and delete its
 * coalescing entry) before the second one is even scheduled, which would make
 * the coalescing assertion measure microtask ordering rather than the code.
 */
function gatedFetch(payload: unknown = SEARCH_PAYLOAD): Recorder & { release: () => void } {
	const urls: string[] = [];
	const inits: Record<string, unknown>[] = [];
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const impl: ExternalFetchImpl = async (url, init) => {
		urls.push(url);
		inits.push(init as unknown as Record<string, unknown>);
		await gate;
		return new Response(JSON.stringify(payload), { status: 200 });
	};
	return { impl, urls, inits, release: () => release() };
}

/** Vetting stub — counted, so "refused BEFORE DNS" is an assertion, not a hope. */
function vettingStub(): {
	impl: (uri: string) => Promise<{ url: URL; addresses: string[] }>;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		impl: async (uri: string) => {
			calls.push(uri);
			return { url: new URL(uri), addresses: ['141.100.1.1'] };
		},
	};
}

beforeEach(async () => {
	overrideExternalSettingsForTests({
		enabled: true,
		allowedHosts: [HOST],
		retryAttempts: 0,
	});
	resetBreakerForOrigin('zenon', ORIGIN);
	await clearOntologyDerivedCaches();
});

afterEach(async () => {
	await drainInFlightExternalSearches();
	overrideExternalSettingsForTests(null);
	resetBreakerForOrigin('zenon', ORIGIN);
});

// ---------------------------------------------------------------------------
// buildSearchRequest — the byte form
// ---------------------------------------------------------------------------

describe('buildSearchRequest reproduces the known-good browser request', () => {
	test('byte for byte, including field[] order and percent-encoding', () => {
		const request = zenon.buildSearchRequest?.({
			apiUrlSearch: SEARCH_URL,
			terms: ['casana'],
			dataLang: 'lg-deu',
			// the autocomplete's ddo order — authors, publicationDates, id, title.
			remoteFields: ['authors', 'publicationDates', 'id', 'title'],
			limit: 20,
			offset: 0,
		});
		expect(request).toBeDefined();
		expect(request?.url).toBe(
			`${SEARCH_URL}?lookfor=casana&type=AllFields&sort=relevance&limit=20&prettyPrint=false&lng=de` +
				'&field[]=authors&field[]=publicationDates&field[]=id&field[]=title',
		);
		// POST with the query in the query string and NO body — what the browser
		// engine sent, and what VuFind answers.
		expect(request?.method).toBe('POST');
		expect(request?.body).toBeUndefined();
	});

	test('every VALUE is percent-encoded while the literal field[] stays verbatim', () => {
		const request = zenon.buildSearchRequest?.({
			apiUrlSearch: SEARCH_URL,
			// & = % and a space: each of these would corrupt the query string raw.
			terms: ['Ripollès & Burnett 100% =', 'nuevo'],
			dataLang: 'lg-spa',
			remoteFields: ['title'],
			limit: 5,
			offset: 0,
		});
		expect(request?.url).toContain('lookfor=Ripoll%C3%A8s%20%26%20Burnett%20100%25%20%3D%20nuevo');
		// The bracket literal must NOT be encoded — VuFind matches on the bytes.
		expect(request?.url).toContain('&field[]=title');
		expect(request?.url).not.toContain('field%5B%5D');
	});

	test('limit and offset are caller-driven; offset becomes VuFind 1-based page', () => {
		const first = zenon.buildSearchRequest?.({
			apiUrlSearch: SEARCH_URL,
			terms: ['casana'],
			dataLang: 'lg-deu',
			remoteFields: [],
			limit: 50,
			offset: 0,
		});
		// Page one omits `page` entirely — the byte form with field evidence.
		expect(first?.url).toBe(
			`${SEARCH_URL}?lookfor=casana&type=AllFields&sort=relevance&limit=50&prettyPrint=false&lng=de`,
		);
		const third = zenon.buildSearchRequest?.({
			apiUrlSearch: SEARCH_URL,
			terms: ['casana'],
			dataLang: 'lg-deu',
			remoteFields: [],
			limit: 50,
			offset: 100,
		});
		expect(third?.url).toContain('&limit=50&page=3&');
	});

	test('an offset that is not a whole page is REFUSED, never rounded', () => {
		expect(() =>
			zenon.buildSearchRequest?.({
				apiUrlSearch: SEARCH_URL,
				terms: ['casana'],
				dataLang: 'lg-deu',
				remoteFields: [],
				limit: 20,
				offset: 25,
			}),
		).toThrow(ExternalServiceError);
	});

	test('a field name that is not a bare identifier is refused before the URL exists', () => {
		expect(() =>
			zenon.buildSearchRequest?.({
				apiUrlSearch: SEARCH_URL,
				terms: ['casana'],
				dataLang: 'lg-deu',
				remoteFields: ['title&lookfor=evil'],
				limit: 20,
				offset: 0,
			}),
		).toThrow(ExternalServiceError);
	});
});

describe('lng is derived from the request data lang, not hard-coded', () => {
	// The browser engine sent the literal `lng: "de"` for every user in every
	// installation. This is the assertion that keeps that from coming back.
	for (const [dataLang, expected] of [
		['lg-spa', 'es'],
		['lg-eng', 'en'],
		['lg-deu', 'de'],
	] as const) {
		test(`${dataLang} → lng=${expected}`, () => {
			expect(getAlpha2FromCode(dataLang)).toBe(expected);
			const request = zenon.buildSearchRequest?.({
				apiUrlSearch: SEARCH_URL,
				terms: ['casana'],
				dataLang,
				remoteFields: [],
				limit: 20,
				offset: 0,
			});
			expect(request?.url).toContain(`&lng=${expected}`);
		});
	}

	test('a lang with no ISO 639-1 mapping falls back exactly as the record path does', () => {
		const lang = 'lg-zzz';
		expect(getAlpha2FromCode(lang) ?? null).toBeNull();
		const search = zenon.buildSearchRequest?.({
			apiUrlSearch: SEARCH_URL,
			terms: ['casana'],
			dataLang: lang,
			remoteFields: [],
			limit: 20,
			offset: 0,
		});
		const record = zenon.buildRecordRequest({
			apiUrl: `${ORIGIN}/api/v1/record`,
			remoteId: '000848571',
			dataLang: lang,
			remoteFields: [],
		});
		expect(search?.url).toContain('&lng=en');
		expect(record.url).toContain('&lgn=en');
	});
});

// ---------------------------------------------------------------------------
// The empty query — the sentinel's replacement
// ---------------------------------------------------------------------------

describe('an empty query is refused in the engine, before any socket', () => {
	test('no fetch happens at all and the result is empty', async () => {
		const fetcher = recordingFetch();
		const vetting = vettingStub();
		for (const terms of [[], [''], ['   ', '\t']]) {
			const result = await searchExternalService({
				sectionTipo: SECTION,
				terms,
				remoteFields: ['id', 'title'],
				deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
				dataLang: 'lg-deu',
			});
			expect(result.hits).toEqual([]);
			expect(result.total).toBeNull();
		}
		expect(fetcher.urls, 'an empty query reached the network').toHaveLength(0);
		expect(vetting.calls, 'an empty query reached the resolver').toHaveLength(0);
	});

	test('the sentinel string is gone from the engine entirely', async () => {
		// 'ñññññññ---!!!!!' only ever "worked" while Zenon's tokeniser kept failing
		// to match it. If it is ever reintroduced, this fails.
		const sources = await Promise.all(
			['src/external/search.ts', 'src/external/services/zenon.ts'].map((path) =>
				Bun.file(`${import.meta.dir}/../../${path}`).text(),
			),
		);
		for (const source of sources) {
			expect(source.includes('ñññññññ---!!!!!')).toBe(false);
		}
	});

	test('the ADAPTER refuses an empty query too — an adapter is data, not a private', () => {
		expect(() =>
			zenon.buildSearchRequest?.({
				apiUrlSearch: SEARCH_URL,
				terms: ['   '],
				dataLang: 'lg-deu',
				remoteFields: [],
				limit: 20,
				offset: 0,
			}),
		).toThrow(ExternalServiceError);
	});
});

// ---------------------------------------------------------------------------
// unwrapSearch
// ---------------------------------------------------------------------------

describe('unwrapSearch reads the payload through the section response_map', () => {
	test('a realistic Zenon answer becomes rows + total', () => {
		const decoded = zenon.unwrapSearch?.(SEARCH_PAYLOAD, RESPONSE_MAP);
		expect(decoded?.rows).toHaveLength(2);
		expect(decoded?.rows[0]?.id).toBe('000848571');
		expect(decoded?.total).toBe(137);
	});

	test('the response_map indirection is honoured, exactly as unwrapRows does', () => {
		const renamed = { hits: SEARCH_PAYLOAD.records, resultCount: 4 };
		const decoded = zenon.unwrapSearch?.(renamed, [{ local: 'ar_records', remote: 'hits' }]);
		expect(decoded?.rows).toHaveLength(2);
		// A map may rename the count too.
		const withTotal = zenon.unwrapSearch?.({ records: [], count: 9 }, [
			{ local: 'total', remote: 'count' },
		]);
		expect(withTotal?.total).toBe(9);
	});

	test('total is NULL when the remote gives none — never 0, never rows.length', () => {
		const decoded = zenon.unwrapSearch?.({ records: SEARCH_PAYLOAD.records }, RESPONSE_MAP);
		expect(decoded?.rows).toHaveLength(2);
		expect(decoded?.total).toBeNull();
		// A non-integer or negative count is no answer either.
		expect(
			zenon.unwrapSearch?.({ records: [], resultCount: 'many' }, RESPONSE_MAP)?.total,
		).toBeNull();
		expect(zenon.unwrapSearch?.({ records: [], resultCount: -1 }, RESPONSE_MAP)?.total).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

describe('a service that cannot search is refused BY NAME, never silently empty', () => {
	const binding = (model: ExternalServiceModel) => ({
		sectionTipo: SECTION,
		model,
		apiConfig: {
			entity: 'zenon',
			apiUrl: `${ORIGIN}/api/v1/record`,
			apiUrlSearch: SEARCH_URL,
			uiBaseUrl: null,
			responseMap: RESPONSE_MAP,
		},
	});

	test('capabilities.search === false → ExternalSearchUnsupportedError(reason: service)', () => {
		const forged: ExternalServiceModel = {
			...zenon,
			capabilities: { ...zenon.capabilities, search: false },
		};
		let caught: unknown;
		try {
			assertExternalSearchable(forged, binding(forged));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSearchUnsupportedError);
		expect((caught as ExternalSearchUnsupportedError).reason).toBe('service');
	});

	test('capability declared but the pair unimplemented → reason: engine', () => {
		// Spread everything EXCEPT the builder — an adapter that declares the
		// capability and implements nothing.
		const { buildSearchRequest: _omitted, ...rest } = zenon;
		const forged = rest as ExternalServiceModel;
		let caught: unknown;
		try {
			assertExternalSearchable(
				forged as ExternalServiceModel,
				binding(forged as ExternalServiceModel),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSearchUnsupportedError);
		expect((caught as ExternalSearchUnsupportedError).reason).toBe('engine');
	});

	test('no api_url_search on the section → reason: config', () => {
		const bound = binding(zenon);
		let caught: unknown;
		try {
			assertExternalSearchable(zenon, {
				...bound,
				apiConfig: { ...bound.apiConfig, apiUrlSearch: null },
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSearchUnsupportedError);
		expect((caught as ExternalSearchUnsupportedError).reason).toBe('config');
	});

	test('a limit past the ceiling is refused, not clamped', async () => {
		const fetcher = recordingFetch();
		await expect(
			searchExternalService({
				sectionTipo: SECTION,
				terms: ['casana'],
				remoteFields: ['id'],
				limit: MAX_SEARCH_LIMIT + 1,
				deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vettingStub().impl },
				dataLang: 'lg-deu',
			}),
		).rejects.toThrow(ExternalServiceError);
		expect(fetcher.urls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The one outbound door
// ---------------------------------------------------------------------------

describe('search goes through the transport door, with every step in front of it', () => {
	test('the request reaching the socket is the adapter-built search request', async () => {
		const fetcher = recordingFetch();
		const vetting = vettingStub();
		const result = await searchExternalService({
			sectionTipo: SECTION,
			terms: ['casana'],
			remoteFields: ['id', 'title'],
			deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
			dataLang: 'lg-deu',
		});
		expect(fetcher.urls).toHaveLength(1);
		// The SSRF guard saw the real URL (step 4) before the socket, and the socket
		// was pinned to the vetted address with the real host kept for SNI.
		expect(vetting.calls[0]).toContain('/api/v1/search?lookfor=casana');
		expect(fetcher.urls[0]).toContain('141.100.1.1');
		const init = fetcher.inits[0] as {
			method?: string;
			redirect?: string;
			tls?: { serverName?: string };
		};
		expect(init.method).toBe('POST');
		expect(init.redirect).toBe('error');
		expect(init.tls?.serverName).toBe(HOST);
		expect(result.hits.map((hit) => hit.remoteId)).toEqual(['000848571', '001338683']);
		expect(result.total).toBe(137);
		// Ids stay STRINGS with their padding — a Number() anywhere breaks this.
		expect(result.hits[0]?.remoteId).toBe('000848571');
	});

	test('a non-allowlisted api_url_search is refused BEFORE any DNS traffic', async () => {
		const fetcher = recordingFetch();
		const vetting = vettingStub();
		// Step 3 (the operator's allowlist) runs before step 4 (the first resolver
		// traffic): with the host absent, the guard must never be consulted.
		overrideExternalSettingsForTests({ enabled: true, allowedHosts: [], retryAttempts: 0 });
		let caught: unknown;
		try {
			await fetchExternalJson({
				model: zenon,
				request: {
					url: `${SEARCH_URL}?lookfor=casana`,
					method: 'POST',
					accept: 'application/json',
				},
				sectionTipo: SECTION,
				deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalServiceError);
		expect((caught as ExternalServiceError).kind).toBe('blocked_host');
		expect(vetting.calls, 'the SSRF guard ran before the allowlist').toHaveLength(0);
		expect(fetcher.urls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Caching and coalescing — the stated decision
// ---------------------------------------------------------------------------

describe('search results are NOT cached, but identical in-flight queries coalesce', () => {
	test('two concurrent identical searches cost ONE call', async () => {
		const fetcher = gatedFetch();
		const vetting = vettingStub();
		const options = {
			sectionTipo: SECTION,
			terms: ['casana'],
			remoteFields: ['id', 'title'],
			deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
			dataLang: 'lg-deu',
		};
		const first = searchExternalService(options);
		// Let the first call reach the (held) socket, so the second genuinely
		// arrives while it is in flight.
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = searchExternalService(options);
		fetcher.release();
		const [a, b] = await Promise.all([first, second]);
		expect(fetcher.urls).toHaveLength(1);
		expect(a.hits).toEqual(b.hits);
	});

	test('a SECOND search after the first settles is a second real request', async () => {
		const fetcher = recordingFetch();
		const vetting = vettingStub();
		const options = {
			sectionTipo: SECTION,
			terms: ['casana'],
			remoteFields: ['id', 'title'],
			deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
			dataLang: 'lg-deu',
		};
		await searchExternalService(options);
		await searchExternalService(options);
		// If a result cache were ever added, this becomes 1 and the decision
		// documented in src/external/search.ts has been reversed silently.
		expect(fetcher.urls).toHaveLength(2);
	});

	test('a different query is a different call, and the coalescer drains', async () => {
		const fetcher = recordingFetch();
		const vetting = vettingStub();
		const base = {
			sectionTipo: SECTION,
			remoteFields: ['id'],
			deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
			dataLang: 'lg-deu',
		};
		await Promise.all([
			searchExternalService({ ...base, terms: ['casana'] }),
			searchExternalService({ ...base, terms: ['burnett'] }),
		]);
		expect(fetcher.urls).toHaveLength(2);
		await drainInFlightExternalSearches();
	});
});

// ---------------------------------------------------------------------------
// The client wire shape
// ---------------------------------------------------------------------------

describe('the emitted shape is the one the client already speaks', () => {
	/**
	 * The browser engine fabricated this itself (service_autocomplete.js
	 * format_data ~:1063-1110). Produced server-side now, so the rendering path
	 * downstream is untouched.
	 */
	test('a sections entry of locators, then one record_data per record × ddo', async () => {
		const { formatExternalSearchData } = await import(
			'../../src/core/api/handlers/dd_external_api.ts'
		);
		const { parseFieldsMap } = await import('../../src/external/api/index.ts');
		const hits = SEARCH_PAYLOAD.records.map((row) => ({
			sectionTipo: 'test7342',
			remoteId: row.id,
			row: row as Record<string, unknown>,
		}));
		const result: ExternalSearchResult = {
			service: 'zenon',
			sectionTipo: 'test7342',
			hits,
			total: 137,
			limit: 20,
			offset: 0,
			dropped: 0,
		};
		const target = {
			targetSectionTipo: 'test7342',
			callerTipo: 'test61',
			model: zenon,
			remoteFields: ['id', 'title'],
			context: [],
			ddos: [
				{
					tipo: 'test7344',
					fieldsMap: parseFieldsMap([{ local: 'dato', remote: 'id' }], { tipo: 'test7344' }),
				},
				{
					tipo: 'test7345',
					fieldsMap: parseFieldsMap([{ local: 'dato', remote: 'title' }], { tipo: 'test7345' }),
				},
			],
		};
		const data = await formatExternalSearchData(result, target);

		// 1 sections entry + 2 records × 2 ddos.
		expect(data).toHaveLength(5);
		expect(data[0]).toEqual({
			section_tipo: 'test7342',
			// self.caller.tipo in the browser engine — the CALLER, not the service.
			tipo: 'test61',
			typo: 'sections',
			entries: [
				{ section_tipo: 'test7342', section_id: '000848571' },
				{ section_tipo: 'test7342', section_id: '001338683' },
			],
		});
		const first = data[1] as Record<string, unknown>;
		expect(first.section_tipo).toBe('test7342');
		expect(first.section_id).toBe('000848571'); // a STRING, padding intact
		expect(first.type).toBe('dd687');
		expect(first.tipo).toBe('test7344');
		expect(first.mode).toBe('list');
		expect(first.entries).toEqual(['000848571']);
		const second = data[2] as Record<string, unknown>;
		expect(second.tipo).toBe('test7345');
		expect(second.entries).toEqual(['Las acuñaciones provinciales romanas de Hispania ']);
	});

	test('values come from the ONE emission function — a declared format applies', async () => {
		const { formatExternalSearchData } = await import(
			'../../src/core/api/handlers/dd_external_api.ts'
		);
		const { parseFieldsMap } = await import('../../src/external/api/index.ts');
		const row = SEARCH_PAYLOAD.records[0] as Record<string, unknown>;
		const data = await formatExternalSearchData(
			{
				service: 'zenon',
				sectionTipo: 'test7342',
				hits: [{ sectionTipo: 'test7342', remoteId: '000848571', row }],
				total: null,
				limit: 20,
				offset: 0,
				dropped: 0,
			},
			{
				targetSectionTipo: 'test7342',
				callerTipo: 'test61',
				model: zenon,
				remoteFields: ['authors'],
				context: [],
				ddos: [
					{
						tipo: 'test7346',
						fieldsMap: parseFieldsMap(
							[{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
							{ tipo: 'test7346' },
						),
					},
				],
			},
		);
		// The engine's zenon_authors formatter, not the browser's ad-hoc one.
		expect((data[1] as Record<string, unknown>).entries).toEqual([
			'primary: Ripollès Alegre, P. P. (Pere Pau)',
		]);
	});

	test('an empty remote value is NO entry in a search cell — no blank "| |" column (T1-P06)', async () => {
		const { formatExternalSearchData } = await import(
			'../../src/core/api/handlers/dd_external_api.ts'
		);
		const { parseFieldsMap } = await import('../../src/external/api/index.ts');
		const row = {
			id: '000848571',
			authors: { primary: [], secondary: [], corporate: [] },
			publicationDates: [],
		};
		const data = await formatExternalSearchData(
			{
				service: 'zenon',
				sectionTipo: 'test7342',
				hits: [{ sectionTipo: 'test7342', remoteId: '000848571', row }],
				total: null,
				limit: 20,
				offset: 0,
				dropped: 0,
			},
			{
				targetSectionTipo: 'test7342',
				callerTipo: 'test61',
				model: zenon,
				remoteFields: ['authors', 'publicationDates'],
				context: [],
				ddos: [
					{
						tipo: 'test7346',
						fieldsMap: parseFieldsMap(
							[{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
							{ tipo: 'test7346' },
						),
					},
					{
						tipo: 'test7347',
						fieldsMap: parseFieldsMap(
							[{ local: 'dato', remote: 'publicationDates', format: 'array_values' }],
							{ tipo: 'test7347' },
						),
					},
				],
			},
		);
		expect(data).toHaveLength(3);
		for (const cell of data.slice(1) as Record<string, unknown>[]) {
			expect(cell.entries).toEqual([]);
			expect(cell.source_status).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Ontology resolution — nothing about the target comes from the client
// ---------------------------------------------------------------------------

/**
 * THE EXTERNAL INSTALLATION IS BUILT, NOT BORROWED (2026-08-19).
 *
 * This case used to run only "where the tree exists (the application
 * ontology)" and printed a SKIP everywhere else — which was everywhere: no
 * suite database has ever carried an external section WITH an `api_config`,
 * and the phase-2 clone deliberately strips one (a cloned live endpoint once
 * handed the credless suite a real remote URL). A permanently-skipped case
 * guards nothing, so the situation is now DECLARED and materialized here:
 * an external section carrying an api_config, its four component_external
 * display fields with their fields_map, and a caller whose request_config
 * names the engine. `resolveExternalSearchTarget` then runs end to end.
 *
 * NO SOCKET: the api_config points at `external.invalid` (a TLD that can never
 * resolve), the host allowlist is overridden to exactly that host, and this
 * case only RESOLVES — it never searches.
 */
const EXTERNAL_API_CONFIG = {
	entity: 'zenon',
	api_url: 'https://external.invalid/api/v1/record',
	api_url_search: 'https://external.invalid/api/v1/search',
	ui_base_url: 'https://external.invalid/Record/',
	response_map: [{ local: 'ar_records', remote: 'records' }],
};
const EXT = {
	section: 'zzxs1',
	ddos: ['zzxs2', 'zzxs3', 'zzxs4', 'zzxs5'] as const,
	callerSection: 'zzxs9',
	caller: 'zzxs10',
};
const externalDdoNode = (tipo: string, remote: string) => ({
	tipo,
	model: 'component_external',
	parent: EXT.section,
	properties: { fields_map: [{ local: 'dato', remote }] },
});
const EXTERNAL_SITUATION = situation({
	tld: 'zzxs',
	name: 'external search target resolution',
	nodes: [
		{
			tipo: EXT.section,
			model: 'section',
			parent: 'dd14',
			properties: { api_config: EXTERNAL_API_CONFIG },
		},
		externalDdoNode(EXT.ddos[0], 'id'),
		externalDdoNode(EXT.ddos[1], 'title'),
		externalDdoNode(EXT.ddos[2], 'authors'),
		externalDdoNode(EXT.ddos[3], 'publicationDates'),
		{ tipo: EXT.callerSection, model: 'section', parent: 'dd14' },
		{
			tipo: EXT.caller,
			model: 'component_autocomplete',
			parent: EXT.callerSection,
			properties: {
				source: {
					request_config: [
						{
							api_engine: 'zenon',
							sqo: { section_tipo: [{ value: [EXT.section], source: 'section' }] },
							show: {
								ddo_map: EXT.ddos.map((tipo) => ({
									tipo,
									parent: EXT.section,
									section_tipo: EXT.section,
								})),
							},
						},
					],
				},
			},
		},
	],
});

describe('the target section and the field list are resolved from the ontology', () => {
	beforeAll(async () => {
		await ensureSituation(EXTERNAL_SITUATION);
	});
	afterAll(async () => {
		expect(await dropSituation(EXTERNAL_SITUATION)).toBe(0);
	});

	test('an external-ONLY component resolves to its external section and its fields', async () => {
		overrideExternalSettingsForTests({ allowedHosts: ['external.invalid'] });
		const { resolveExternalSearchTarget } = await import(
			'../../src/core/api/handlers/dd_external_api.ts'
		);
		const target = await resolveExternalSearchTarget(EXT.caller, EXT.callerSection);
		expect(target.targetSectionTipo).toBe(EXT.section);
		expect(target.model.service).toBe('zenon');
		// The ddo declaration order IS the field[] order on the wire.
		expect(target.remoteFields).toEqual(['id', 'title', 'authors', 'publicationDates']);
		expect(target.ddos.map((ddo) => ddo.tipo)).toEqual([...EXT.ddos]);
		// Every fields_map came from the NODE, never from a caller-supplied echo.
		expect(target.ddos[0]?.fieldsMap).toEqual([{ local: 'dato', remote: 'id' }]);
	});

	test('the fields_map is read from the NODE, never from the request', async () => {
		// Credless, and the half that matters for trust: a client that could put a
		// field list on the wire would be the browser-direct call again, with the
		// engine's socket. The resolver must consult the ontology node.
		const source = await Bun.file(
			`${import.meta.dir}/../../src/core/api/handlers/dd_external_api.ts`,
		).text();
		// The fields_map is hydrated from the DDO'S OWN NODE. Asserted on the call
		// SHAPE rather than one spelling of the loop variable, so a rename cannot
		// silently vacate the check: whatever it is called, the argument must be a
		// `.tipo` of the ddo being hydrated — never a value off the request. Since
		// the hydration loop was extracted (hydrateExternalSearchDdos), the reader
		// is a loader lambda whose single parameter IS that tipo, so the bare
		// `tipo` spelling is accepted too; `callerTipo` and friends still do not
		// match, which is the point of the check.
		expect(/getPropertiesByTipo\(\s*(\w+\.)?tipo\s*\)/.test(source)).toBe(true);
		expect(source).toContain('parseFieldsMap(nodeProperties?.fields_map');
		// No branch may read a field list, a url or a host off the incoming rqo.
		for (const forbidden of ['rqo.options.fields', 'api_url', 'apiUrlSearch', 'options.host']) {
			expect(source.includes(forbidden), `the handler reads '${forbidden}' from the request`).toBe(
				false,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// One refused field name — the rest of the search still answers (2026-09-24)
// ---------------------------------------------------------------------------

/**
 * BUILT, end to end minus the socket: an external section whose `title` column
 * maps a name the zenon adapter REFUSES (`dc:title` — not a bare identifier).
 * Before 2026-09-24 the union carried it, `buildSearchRequest` refused the whole
 * request, and the curator saw an empty "misconfigured" search box. Now the
 * target resolves, the request goes out WITHOUT the name, the hits come back,
 * and only the misconfigured column says so.
 */
const PARTIAL = {
	section: 'zzxt1',
	id: 'zzxt2',
	bad: 'zzxt3',
	authors: 'zzxt4',
	callerSection: 'zzxt9',
	caller: 'zzxt10',
};
const PARTIAL_SITUATION = situation({
	tld: 'zzxt',
	name: 'external search with one refused field name',
	nodes: [
		{
			tipo: PARTIAL.section,
			model: 'section',
			parent: 'dd14',
			properties: { api_config: EXTERNAL_API_CONFIG },
		},
		{
			tipo: PARTIAL.id,
			model: 'component_external',
			parent: PARTIAL.section,
			properties: { fields_map: [{ local: 'dato', remote: 'id' }] },
		},
		{
			tipo: PARTIAL.bad,
			model: 'component_external',
			parent: PARTIAL.section,
			properties: { fields_map: [{ local: 'dato', remote: 'dc:title' }] },
		},
		{
			tipo: PARTIAL.authors,
			model: 'component_external',
			parent: PARTIAL.section,
			properties: {
				fields_map: [{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
			},
		},
		{ tipo: PARTIAL.callerSection, model: 'section', parent: 'dd14' },
		{
			tipo: PARTIAL.caller,
			model: 'component_autocomplete',
			parent: PARTIAL.callerSection,
			properties: {
				source: {
					request_config: [
						{
							api_engine: 'zenon',
							sqo: { section_tipo: [{ value: [PARTIAL.section], source: 'section' }] },
							show: {
								ddo_map: [PARTIAL.id, PARTIAL.bad, PARTIAL.authors].map((tipo) => ({
									tipo,
									parent: PARTIAL.section,
									section_tipo: PARTIAL.section,
								})),
							},
						},
					],
				},
			},
		},
	],
});

describe('one refused remote field name does not blank the search', () => {
	beforeAll(async () => {
		await ensureSituation(PARTIAL_SITUATION);
	});
	afterAll(async () => {
		expect(await dropSituation(PARTIAL_SITUATION)).toBe(0);
	});

	test('the request omits the refused name, the hits return, only that column is misconfigured', async () => {
		overrideExternalSettingsForTests({ allowedHosts: ['external.invalid'] });
		resetBreakerForOrigin('zenon', 'https://external.invalid');
		const { formatExternalSearchData, resolveExternalSearchTarget } = await import(
			'../../src/core/api/handlers/dd_external_api.ts'
		);
		const target = await resolveExternalSearchTarget(PARTIAL.caller, PARTIAL.callerSection);
		expect(target.remoteFields).toEqual(['id', 'authors']);

		const fetcher = recordingFetch();
		const vetting = vettingStub();
		const result = await searchExternalService({
			sectionTipo: target.targetSectionTipo,
			terms: ['burnett'],
			remoteFields: target.remoteFields,
			deps: { fetchImpl: fetcher.impl, assertPublicUrlImpl: vetting.impl },
		});
		expect(fetcher.urls).toHaveLength(1);
		const asked = new URL(fetcher.urls[0] as string).searchParams.getAll('field[]');
		expect(asked).toEqual(['id', 'authors']);
		expect(result.hits.map((hit) => hit.remoteId)).toEqual(['000848571', '001338683']);

		const data = await formatExternalSearchData(result, target);
		// 1 sections entry + 2 hits × 3 columns — the refused column keeps its place.
		expect(data).toHaveLength(7);
		const byTipo = (tipo: string) =>
			data.filter((row) => (row as { tipo?: string }).tipo === tipo) as Record<string, unknown>[];
		expect(byTipo(PARTIAL.id).map((row) => row.entries)).toEqual([['000848571'], ['001338683']]);
		expect(byTipo(PARTIAL.authors)[1]?.entries).toEqual(['primary: Burnett, Andrew']);
		for (const row of byTipo(PARTIAL.bad)) {
			expect(row.entries).toEqual([]);
			expect((row.source_status as { state?: string } | undefined)?.state).toBe('misconfigured');
		}
		for (const row of [...byTipo(PARTIAL.id), ...byTipo(PARTIAL.authors)]) {
			expect(row.source_status).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// The failure envelope — what a search box can act on
// ---------------------------------------------------------------------------

/**
 * A search that fails must say WHICH failure, in words the curator's language
 * has. Before 2026-08-06 the browser rejected every one of them with the same
 * built-in string ("There was a network error"), which the caller logged and
 * swallowed: an empty list meant "no matches", "the catalogue is down" and
 * "this install has not allowlisted the host" indistinguishably.
 *
 * Two properties, both load-bearing:
 *
 *  1. HTTP 200, not 4xx. `data_manager.request` reads a non-ok response as a
 *     thrown fetch error (only 401 survives, WC-051), so a 4xx body — every
 *     word of the explanation — is discarded before any caller sees it.
 *  2. The payload is the RECORD PATH'S OWN `source_status`, built by the same
 *     `stateForKind` + `externalSourceStatus` pair. One taxonomy, one
 *     state→label_key map; the client renders it with the same helper.
 */
describe('a failed search answers with a state the client can name', () => {
	const KINDS = [
		'disabled',
		'not_registered',
		'bad_config',
		'circuit_open',
		'blocked_host',
		'timeout',
		'transport',
		'http_status',
		'too_large',
		'protocol',
		'not_found',
	] as const;

	type DegradedBody = {
		ok: boolean;
		data: { context: unknown[]; data: unknown[] };
		notices?: {
			code: string;
			label_key: string;
			retryable: boolean;
			details?: Record<string, unknown>;
		}[];
		source_status?: { label_key: string; state: string };
	};
	const degraded = async (kind: (typeof KINDS)[number], reason?: string) => {
		const { searchDegraded } = await import('../../src/core/api/handlers/dd_external_api.ts');
		const result = await searchDegraded('req-external-search-test', 'zenon', kind, reason);
		return { status: result.status, body: result.body as unknown as DegradedBody };
	};

	test('every error kind is ok:true + an empty result + ONE coded notice with a defined label key', async () => {
		const master = (await Bun.file(
			`${import.meta.dir}/../../src/core/labels/master.json`,
		).json()) as Record<string, string>;
		for (const kind of KINDS) {
			const { status, body } = await degraded(kind);
			// Degradation of the SOURCE is not a failure of the request (ERRORS_SPEC §3).
			expect(status, `${kind} answered ${status}`).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.data).toEqual({ context: [], data: [] });
			expect(body.notices?.length, `${kind} notices`).toBe(1);
			const notice = body.notices?.[0];
			expect(notice?.code).toBe(`external.${kind}`);
			expect(notice?.details?.service).toBe('zenon');
			// The key must EXIST in the catalog: a marker whose text resolves to
			// undefined is the empty box this whole mechanism exists to remove.
			expect(
				master[notice?.label_key ?? ''],
				`${kind} → '${notice?.label_key}' is not in master.json`,
			).toBeString();
			// The compat extension key the autocomplete chip renders from today.
			const status_ = body.source_status;
			expect(status_?.state, `${kind} produced no state`).toBeString();
			expect(master[status_?.label_key ?? '']).toBeString();
		}
	});

	test('the three states a curator must tell apart do not collapse into one', async () => {
		const stateOf = async (kind: (typeof KINDS)[number]): Promise<string | undefined> =>
			(await degraded(kind)).body.source_status?.state;
		// "the catalogue is down" (retry may work) …
		expect(await stateOf('transport')).toBe('unavailable');
		// … "this install has not allowlisted the host" (retrying never helps) …
		expect(await stateOf('blocked_host')).toBe('misconfigured');
		// … "an operator switched it off".
		expect(await stateOf('disabled')).toBe('disabled');
	});

	test('the finer grain the state set folds away survives as the notice code', async () => {
		// blocked_host and not_registered are BOTH 'misconfigured' states — the
		// closed set is what the user reads, the code is what an operator quotes.
		const blocked = await degraded('blocked_host');
		const unknown = await degraded('not_registered');
		expect(blocked.body.source_status?.state).toBe(unknown.body.source_status?.state as string);
		expect(blocked.body.notices?.[0]?.code).not.toBe(unknown.body.notices?.[0]?.code);
	});

	test('an unsupported search names WHICH of the three reasons it was', async () => {
		const { body } = await degraded('bad_config', 'engine');
		expect(body.notices?.[0]?.code).toBe('external.bad_config');
		expect(body.notices?.[0]?.details).toEqual({ service: 'zenon', reason: 'engine' });
	});
});
