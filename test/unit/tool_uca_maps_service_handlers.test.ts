/**
 * tool_uca_maps — the handlers of the fixed-host service proxies, with
 * `fetchGuardedText` scripted: a refusal must happen before anything is sent,
 * and a guard that regressed must not reach a real third party. mock.module is
 * process-global, so the real module is put back after this file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realSsrfGuard from '../../src/core/security/ssrf_guard.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { contextOf, dataOf, expectCode, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

const SSRF_GUARD = '../../src/core/security/ssrf_guard.ts';
const REAL_SSRF_GUARD = { ...realSsrfGuard };

/** Every URL the handlers asked for, and the scripted answer by URL. */
const sent: string[] = [];
/** The request headers of each of those, in the same order. */
const sentHeaders: Record<string, string>[] = [];
let reply: (url: URL) => string = () => {
	throw new Error('no scripted answer');
};

type Handler = (ctx: ToolActionContext) => Promise<ToolResponse>;
let searchPlaces: Handler;
let getElevation: Handler;
let getAdministrativeUnit: Handler;
let getCatastroParcel: Handler;

beforeAll(async () => {
	mock.module(SSRF_GUARD, () => ({
		...REAL_SSRF_GUARD,
		fetchGuardedText: async (
			uri: string,
			opts?: { init?: { headers?: Record<string, string> } },
		) => {
			sent.push(uri);
			sentHeaders.push({ ...(opts?.init?.headers ?? {}) });
			return reply(new URL(uri));
		},
	}));
	({ searchPlaces } = await import('../../tools/tool_uca_maps/server/place_search.ts'));
	({ getElevation } = await import('../../tools/tool_uca_maps/server/elevation.ts'));
	({ getAdministrativeUnit } = await import(
		'../../tools/tool_uca_maps/server/administrative_units.ts'
	));
	({ getCatastroParcel } = await import('../../tools/tool_uca_maps/server/catastro.ts'));
});

afterAll(() => {
	mock.module(SSRF_GUARD, () => REAL_SSRF_GUARD);
	mock.restore();
});

beforeEach(() => {
	sent.length = 0;
	sentHeaders.length = 0;
	reply = () => {
		throw new Error('no scripted answer');
	};
});

const VALID_CLICK = { bbox: [-1, 38, -0.9, 38.1], width: 512, height: 400, x: 128, y: 64 };

describe('search_places — a caller fault is refused before anything is sent', () => {
	// the positive control: an empty `sent` below means nothing went out, not
	// that the scripted fetch stopped recording
	test('a valid query is sent, once, and answered by the script', async () => {
		reply = () => '[]';
		expect(dataOf(await searchPlaces(contextOf({ query: 'Sagunto' })))).toEqual({ results: [] });
		expect(sent).toHaveLength(1);
	});

	test.each([
		['an empty query', { query: '   ' }, /search text is required/],
		['no query at all', {}, /search text is required/],
		['an over-long query', { query: 'x'.repeat(201) }, /too long/],
	])('%s', async (_label, options, message) => {
		const error = await failureOf(searchPlaces(contextOf(options)));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(message);
		expect(sent).toEqual([]);
	});
});

describe("search_places — results named in the record's language", () => {
	test.each([
		['lg-spa', 'es'],
		['lg-vlca', 'ca'],
		['lg-glg', 'gl'],
		['lg-eng', 'en'],
	])('%s asks Nominatim for %s', async (lang, iso) => {
		reply = () => '[]';
		await searchPlaces(contextOf({ query: 'Sagunto', lang }));
		expect(sentHeaders).toHaveLength(1);
		expect(sentHeaders[0]?.['Accept-Language']).toBe(iso);
	});

	test('an unmapped or missing lang sends no Accept-Language, only the User-Agent', async () => {
		reply = () => '[]';
		for (const options of [{ query: 'Sagunto', lang: 'lg-xyz' }, { query: 'Sagunto' }]) {
			await searchPlaces(contextOf(options));
		}
		expect(sentHeaders).toHaveLength(2);
		for (const headers of sentHeaders) {
			expect(headers['Accept-Language']).toBeUndefined();
			expect(headers['User-Agent']).toMatch(/tool_uca_maps/);
		}
	});
});

describe('get_elevation — caller-fault validation', () => {
	test.each([
		['no coordinates at all', {}],
		['a missing longitude', { lat: 39.6 }],
		['a non-numeric latitude', { lat: 'north', lon: -0.2 }],
		// `Number(null)` is 0: without a strict reader this one reaches
		// Open-Elevation as the Gulf of Guinea instead of being refused
		['a null latitude', { lat: null, lon: -0.2 }],
		['an empty-string longitude', { lat: 39.6, lon: '' }],
		['a latitude past the pole', { lat: 91, lon: -0.2 }],
		['a longitude past the antimeridian', { lat: 39.6, lon: 181 }],
		// Leaflet's own spelling: the action reads only the `lon` the client sends
		['a longitude sent as lng', { lat: 39.6, lng: -0.2 }],
	])('refuses %s as request.invalid_options, nothing sent', async (_label, options) => {
		expectCode(await failureOf(getElevation(contextOf(options))), 'request.invalid_options');
		expect(sent).toEqual([]);
	});

	test.each([
		[90, 180],
		[-90, -180],
	])(
		'accepts the exact pole and antimeridian %d,%d: they are real coordinates',
		async (lat, lon) => {
			reply = () => '{"results":[{"elevation":5}]}';
			const data = dataOf<{ elevation: number | null }>(
				await getElevation(contextOf({ lat, lon })),
			);
			expect(data.elevation).toBe(5);
			expect(sent.map((uri) => new URL(uri).searchParams.get('locations'))).toEqual([
				`${lat},${lon}`,
			]);
		},
	);
});

describe('get_administrative_unit — handler validation', () => {
	test('a missing bbox is refused as request.invalid_options, before the level check', async () => {
		for (const level of ['Municipio', 'Galaxy']) {
			const error = await failureOf(getAdministrativeUnit(contextOf({ level })));
			expectCode(error, 'request.invalid_options');
			expect(error.message).toMatch(/bounding box/);
		}
		expect(sent).toEqual([]);
	});

	test('a missing/unknown level is refused as request.invalid_options', async () => {
		for (const options of [VALID_CLICK, { ...VALID_CLICK, level: 'Galaxy' }]) {
			const error = await failureOf(getAdministrativeUnit(contextOf(options)));
			expectCode(error, 'request.invalid_options');
			expect(error.message).toMatch(/administrative level/);
		}
		expect(sent).toEqual([]);
	});
});

describe('get_administrative_unit — the IGN reply wired into the handler', () => {
	const LEVEL = 'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/';
	const unit = (order: string, name: string, lon: number) => ({
		type: 'Feature',
		geometry: { type: 'Point', coordinates: [lon, 38.05] },
		properties: { nationallevel: LEVEL + order, nameunit: name },
	});
	const UNITS = [
		unit('3rdOrder', 'Alicante', -0.5),
		unit('4thOrder', 'Elche', -0.7),
		unit('4thOrder', 'Crevillent', -0.8),
	];
	// IGN answers every level under the click; the asked one is picked
	const REPLY = JSON.stringify({ features: UNITS });

	test.each([
		['Municipio', 1],
		['Provincia', 0],
	] as const)(
		'%s answers its own level, the first one IGN lists, as drawn',
		async (level, index) => {
			reply = () => REPLY;
			expect(dataOf(await getAdministrativeUnit(contextOf({ ...VALID_CLICK, level })))).toEqual({
				found: true,
				feature: UNITS[index],
			});
			expect(sent).toHaveLength(1);
		},
	);

	test('a level IGN did not list is not found, with no feature', async () => {
		reply = () => REPLY;
		expect(
			dataOf(await getAdministrativeUnit(contextOf({ ...VALID_CLICK, level: 'CCAA' }))),
		).toEqual({
			found: false,
			feature: null,
		});
	});

	test('an unreadable reply is security.outbound_failed, not a crash', async () => {
		reply = () => '<html>maintenance</html>';
		const error = await failureOf(
			getAdministrativeUnit(contextOf({ ...VALID_CLICK, level: 'Municipio' })),
		);
		expectCode(error, 'security.outbound_failed');
	});
});

describe('get_catastro_parcel — the WFS reply wired into the handler', () => {
	const REFCAT = '6075421YJ2667S';
	const RESULT_PAGE = `<p>Referencia catastral de la parcela:</p><p><a href="https://example.com/rc">${REFCAT}</a></p>`;
	const NOT_FOUND =
		'<ExceptionReport xmlns="http://www.opengis.net/ows/1.1"><Exception exceptionCode="OperationProcessingFailed"><ExceptionText><![CDATA[No se han encontrado registros de la referencia]]></ExceptionText></Exception></ExceptionReport>';
	const FAULT =
		'<ExceptionReport xmlns="http://www.opengis.net/ows/1.1"><Exception exceptionCode="NoApplicableCode"><ExceptionText><![CDATA[Error interno]]></ExceptionText></Exception></ExceptionReport>';
	const PARCEL = `<FeatureCollection xmlns="http://www.opengis.net/wfs/2.0"><member><cp:CadastralParcel gml:id="ES.SDGC.CP.${REFCAT}"><gml:posList>39.1 -0.1 39.2 -0.2 39.3 -0.3</gml:posList></cp:CadastralParcel></member></FeatureCollection>`;
	const MAINTENANCE = '<html><body><h1>INTERRUPCI&Oacute;N DEL SERVICIO</h1></body></html>';

	/** The GetFeatureInfo page, then each stored query's own WFS reply. */
	function catastro(wfs: Record<'getneighbourparcel' | 'getparcel', string>): (url: URL) => string {
		return (url) => {
			const query = url.searchParams.get('STOREDQUERIE_ID');
			return query === 'getneighbourparcel' || query === 'getparcel' ? wfs[query] : RESULT_PAGE;
		};
	}

	test('a click without a bounding box is refused as request.invalid_options, nothing sent', async () => {
		const error = await failureOf(getCatastroParcel(contextOf({})));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/bounding box/);
		expect(sent).toEqual([]);
	});

	test('a "not found" report falls back to the parcel query, whose ring is the answer', async () => {
		reply = catastro({ getneighbourparcel: NOT_FOUND, getparcel: PARCEL });
		const data = dataOf(await getCatastroParcel(contextOf(VALID_CLICK)));
		expect(data).toEqual({
			found: true,
			refcat: REFCAT,
			url: 'https://example.com/rc',
			points: [
				[39.1, -0.1],
				[39.2, -0.2],
				[39.3, -0.3],
			],
		});
		expect(sent.map((uri) => new URL(uri).searchParams.get('STOREDQUERIE_ID'))).toEqual([
			null,
			'getneighbourparcel',
			'getparcel',
		]);
	});

	test('an exception report other than "not found" is the source unavailable: no fallback, no "no parcel"', async () => {
		reply = catastro({ getneighbourparcel: FAULT, getparcel: PARCEL });
		const error = await failureOf(getCatastroParcel(contextOf(VALID_CLICK)));
		expectCode(error, 'security.outbound_failed');
		expect(sent.map((uri) => new URL(uri).searchParams.get('STOREDQUERIE_ID'))).toEqual([
			null,
			'getneighbourparcel',
		]);
	});

	test('a WFS reply that is not an answer (maintenance) is the source unavailable, never "no parcel"', async () => {
		reply = catastro({ getneighbourparcel: MAINTENANCE, getparcel: MAINTENANCE });
		const error = await failureOf(getCatastroParcel(contextOf(VALID_CLICK)));
		expectCode(error, 'security.outbound_failed');
	});
});
