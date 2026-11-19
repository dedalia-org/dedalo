/**
 * tool_uca_maps — the fixed-host lookup handlers with core's `callGeoService` scripted: a
 * refusal must happen before anything is asked, and a regressed guard must not reach a real
 * third party. Every question first passes core's own grammar (`checkParams`), so one core
 * would refuse fails here, not at the provider. mock.module is process-global, so the real
 * modules are put back after this file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import * as realGeoCall from '../../src/core/geo_services/call.ts';
import { checkParams } from '../../src/core/geo_services/params.ts';
import { type GeoService, geoServiceOf } from '../../src/core/geo_services/table.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { contextOf, dataOf, expectCode, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

const GEO_CALL = '../../src/core/geo_services/call.ts';
const REAL_GEO_CALL = { ...realGeoCall };

/** Every question asked of core's geo services, and the scripted answer (its data). */
const asked: { id: string; params: Record<string, unknown> }[] = [];
let answer: (id: string) => unknown = () => {
	throw new Error('no scripted answer');
};

type Handler = (ctx: ToolActionContext) => Promise<ToolResponse>;
let searchPlaces: Handler;
let getElevation: Handler;
let getAdministrativeUnit: Handler;
let getCatastroParcel: Handler;
let searchDare: Handler;

beforeAll(async () => {
	mock.module(GEO_CALL, () => ({
		...REAL_GEO_CALL,
		callGeoService: async (id: string, params: Record<string, unknown>) => {
			const service = geoServiceOf(id) as GeoService;
			checkParams(id, service.params, service.refine, params);
			asked.push({ id, params });
			const data = answer(id);
			// Catastro's two services answer markup, the rest JSON
			return typeof data === 'string'
				? { service: id, kind: 'markup', text: data, attribution: 'the provider' }
				: { service: id, kind: 'json', data, attribution: 'the provider' };
		},
	}));
	({ searchPlaces } = await import('../../tools/tool_uca_maps/server/place_search.ts'));
	({ getElevation } = await import('../../tools/tool_uca_maps/server/elevation.ts'));
	({ getAdministrativeUnit } = await import(
		'../../tools/tool_uca_maps/server/administrative_units.ts'
	));
	({ getCatastroParcel } = await import('../../tools/tool_uca_maps/server/catastro.ts'));
	({ searchDare } = await import('../../tools/tool_uca_maps/server/roman_empire.ts'));
});

afterAll(() => {
	mock.module(GEO_CALL, () => REAL_GEO_CALL);
	mock.restore();
});

beforeEach(() => {
	asked.length = 0;
	answer = () => {
		throw new Error('no scripted answer');
	};
});

/** A scripted answer that is core's refusal `code`. */
function failWith(code: DedaloError['code'], message: string = code): () => never {
	return () => {
		throw new DedaloError(code, { message });
	};
}

const VALID_CLICK = { bbox: [-1, 38, -0.9, 38.1], width: 512, height: 400, x: 128, y: 64 };

/** The [lat, lon] at the centre of an EPSG:3857 box, inverted by hand. */
function boxCentre(bbox: unknown): [number, number] {
	const [minX, minY, maxX, maxY] = bbox as number[];
	const R = 6378137;
	const x = ((minX as number) + (maxX as number)) / 2;
	const y = ((minY as number) + (maxY as number)) / 2;
	return [(Math.atan(Math.sinh(y / R)) * 180) / Math.PI, (x / R) * (180 / Math.PI)];
}

/** VALID_CLICK's pixel (128, 64): 0.25 across, linear; 0.16 down, Mercator (linear: 38.084). */
function expectCentredOnValidClick(bbox: unknown): void {
	const [lat, lon] = boxCentre(bbox);
	expect(lon).toBeCloseTo(-0.975, 9);
	expect(lat).toBeCloseTo(38.08400918, 7);
}

describe('search_places — a caller fault is refused before anything is asked', () => {
	// the positive control: an empty `asked` below means nothing went out, not
	// that the scripted service stopped recording
	test("a valid query asks nominatim_search, once, for v6's 8 hits", async () => {
		answer = () => [];
		expect(dataOf(await searchPlaces(contextOf({ query: 'Sagunto' })))).toEqual({
			results: [],
			attribution: 'the provider',
		});
		expect(asked).toEqual([
			{ id: 'nominatim_search', params: { q: 'Sagunto', limit: 8, addressdetails: '0' } },
		]);
	});

	test.each([
		['an empty query', { query: '   ' }, 'search_text_required'],
		['no query at all', {}, 'search_text_required'],
		// Nominatim forbids as-you-type search: core's floor, said in the user's words
		['a two-character query', { query: 'Ux' }, 'search_text_too_short'],
		['an over-long query', { query: 'x'.repeat(201) }, 'search_text_too_long'],
		// what else core's grammar refuses, by its own rule, with a reason
		['a bidi override', { query: 'Sag\u202Eunto' }, 'search_text_invalid'],
		['a control character', { query: 'Sag\u0007unto' }, 'search_text_invalid'],
	])('%s', async (_label, options, reason) => {
		const error = await failureOf(searchPlaces(contextOf(options)));
		expectCode(error, 'request.invalid_options');
		expect(error.details).toEqual({ reason_key: reason });
		expect(asked).toEqual([]);
	});

	test.each([
		'external.http_status',
		'external.timeout',
		'external.transport',
		'external.too_large',
		'external.protocol',
	] as const)('a transient %s is the place search unavailable, keyed', async (code) => {
		answer = failWith(code);
		const down = await failureOf(searchPlaces(contextOf({ query: 'Sagunto' })));
		expectCode(down, 'tool.source_unavailable');
		expect(down.details).toEqual({ reason_key: 'place_search_unavailable' });
	});

	// not retryable: a retryable code over them would have the browser ask a
	// provider that already said no again
	test.each(['external.bad_config', 'external.blocked_host', 'external.not_found'] as const)(
		'a final %s passes through as core threw it',
		async (code) => {
			answer = failWith(code);
			expectCode(await failureOf(searchPlaces(contextOf({ query: 'Sagunto' }))), code);
		},
	);

	test("core's busy stays core's", async () => {
		answer = failWith('rate.limited', 'busy');
		expectCode(await failureOf(searchPlaces(contextOf({ query: 'Sagunto' }))), 'rate.limited');
	});
});

describe("search_places — results named in the record's language", () => {
	test.each([
		['lg-spa', 'es'],
		['lg-vlca', 'ca'],
		['lg-glg', 'gl'],
		['lg-eng', 'en'],
	])('%s asks Nominatim for %s', async (lang, iso) => {
		answer = () => [];
		await searchPlaces(contextOf({ query: 'Sagunto', lang }));
		expect(asked.map((question) => question.params.language)).toEqual([iso]);
	});

	test('an unmapped or missing lang asks for no language', async () => {
		answer = () => [];
		for (const options of [{ query: 'Sagunto', lang: 'lg-xyz' }, { query: 'Sagunto' }]) {
			await searchPlaces(contextOf(options));
		}
		expect(asked).toHaveLength(2);
		for (const question of asked) {
			expect('language' in question.params).toBe(false);
		}
	});
});

describe("search_dare — core's DARE services, v6's filters on the answer", () => {
	const SAGUNTO = {
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				geometry: { type: 'Point' },
				properties: { name: 'Sagunto', numType: '11', country: 'ES' },
			},
			{
				type: 'Feature',
				geometry: { type: 'Point' },
				properties: { name: 'Sagunto', numType: '14', country: 'ES' },
			},
		],
	};

	test('each name field asks its own service with the name alone; the filters stay here', async () => {
		answer = () => SAGUNTO;
		const data = dataOf<{ results: unknown[]; attribution: string }>(
			await searchDare(
				contextOf({ query: 'Arse', name_type: 'ass', type_id: '11', country: 'es' }),
			),
		);
		expect(asked).toEqual([{ id: 'dare_search_ancient', params: { name: 'Arse' } }]);
		expect(data.results).toHaveLength(1);
		expect(data.attribution).toBe('the provider');
	});

	test("a name over core's 100 characters is refused here, nothing asked", async () => {
		const error = await failureOf(searchDare(contextOf({ query: 'x'.repeat(101) })));
		expect(error.details).toEqual({ reason_key: 'search_text_too_long' });
		expect(asked).toEqual([]);
	});

	test("a name core's grammar refuses is refused here with a reason, nothing asked", async () => {
		const error = await failureOf(searchDare(contextOf({ query: 'Gad\u200Bes' })));
		expectCode(error, 'request.invalid_options');
		expect(error.details).toEqual({ reason_key: 'search_text_invalid' });
		expect(asked).toEqual([]);
	});

	test("a provider's failure is the gazetteer unavailable, keyed", async () => {
		answer = failWith('external.transport', 'reset');
		const error = await failureOf(searchDare(contextOf({ query: 'Sagunto' })));
		expectCode(error, 'tool.source_unavailable');
		expect(error.details).toEqual({ reason_key: 'gazetteer_service_unavailable' });
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
	])('refuses %s as request.invalid_options, nothing asked', async (_label, options) => {
		expectCode(await failureOf(getElevation(contextOf(options))), 'request.invalid_options');
		expect(asked).toEqual([]);
	});

	test.each([
		[90, 180],
		[-90, -180],
	])(
		'accepts the exact pole and antimeridian %d,%d: they are real coordinates',
		async (lat, lon) => {
			answer = () => ({ results: [{ elevation: 5 }] });
			const data = dataOf<{ elevation: number | null; attribution: string }>(
				await getElevation(contextOf({ lat, lon })),
			);
			expect(data.elevation).toBe(5);
			// the provider's credit, which the console shows beside the value
			expect(data.attribution).toBe('the provider');
			// latitude first: an axis swap would report another continent
			expect(asked).toEqual([{ id: 'open_elevation_lookup', params: { locations: [[lat, lon]] } }]);
		},
	);
});

describe('get_elevation — an outage is "unavailable", a refused question is not', () => {
	test("the provider's failure or core's busy answers unavailable", async () => {
		for (const code of ['external.timeout', 'rate.limited'] as const) {
			answer = failWith(code);
			expect(dataOf(await getElevation(contextOf({ lat: 39.6, lon: -0.2 })))).toEqual({
				elevation: null,
				unavailable: true,
			});
		}
	});

	test("a question core refuses is the tool's own bug and stays loud", async () => {
		answer = failWith('request.invalid_data', 'off grammar');
		expectCode(
			await failureOf(getElevation(contextOf({ lat: 39.6, lon: -0.2 }))),
			'request.invalid_data',
		);
	});
});

describe('get_administrative_unit — handler validation', () => {
	test('a missing bbox is refused as request.invalid_options, nothing asked', async () => {
		const error = await failureOf(getAdministrativeUnit(contextOf({})));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/bounding box/);
		expect(asked).toEqual([]);
	});
});

describe("get_administrative_unit — core's IGN service wired into the handler", () => {
	const LEVEL = 'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/';
	const unit = (order: string, name: string) => ({
		type: 'Feature',
		geometry: null,
		properties: {
			nationallevel: LEVEL + order,
			nationalcode: '34104600000',
			nameunit: name,
		},
	});

	test.each([
		['4thOrder', 'València', 'Municipio'],
		['3rdOrder', 'Valencia', 'Provincia'],
		['2ndOrder', 'Comunitat Valenciana', 'CCAA'],
		['1stOrder', 'España', null],
	] as const)('a %s unit is named with level %s', async (order, name, level) => {
		answer = () => ({ features: [unit(order, name)] });
		expect(dataOf(await getAdministrativeUnit(contextOf(VALID_CLICK)))).toEqual({
			found: true,
			unit: { name, level, code: '34104600000' },
		});
	});

	test("one question for the clicked point, core's 100 m box around it", async () => {
		answer = () => ({ features: [unit('3rdOrder', 'Alicante')] });
		await getAdministrativeUnit(contextOf(VALID_CLICK));
		expect(asked.map((question) => question.id)).toEqual(['ign_admin_units_featureinfo']);
		expect(asked[0]?.params).toMatchObject({
			crs: 'EPSG:3857',
			width: 101,
			height: 101,
			i: 50,
			j: 50,
		});
		expectCentredOnValidClick(asked[0]?.params.bbox);
	});

	test('the first unit IGN lists is the one named', async () => {
		answer = () => ({ features: [unit('3rdOrder', 'Alicante'), unit('4thOrder', 'Elche')] });
		expect(dataOf(await getAdministrativeUnit(contextOf(VALID_CLICK)))).toMatchObject({
			unit: { name: 'Alicante', level: 'Provincia' },
		});
	});

	test('"nothing there" or a unit with no name is not found, not a failure', async () => {
		answer = failWith('external.not_found', 'nothing there');
		expect(dataOf(await getAdministrativeUnit(contextOf(VALID_CLICK)))).toEqual({ found: false });
		answer = () => ({ features: [{ properties: { nameunit: '  ' } }] });
		expect(dataOf(await getAdministrativeUnit(contextOf(VALID_CLICK)))).toEqual({ found: false });
	});

	test("a transient failure is the source unavailable with the tool's reason", async () => {
		answer = failWith('external.timeout', 'slow');
		const error = await failureOf(getAdministrativeUnit(contextOf(VALID_CLICK)));
		expectCode(error, 'tool.source_unavailable');
		expect(error.details).toEqual({ reason_key: 'admin_units_unavailable' });
	});
});

describe("get_catastro_parcel — core's two Catastro services wired into the handler", () => {
	const REFCAT = '5726401YJ2752F';
	const RESULT_PAGE = `<html><body><td class="title">Get Feature Info Response</td><table><tr><td>nationalCadastralReference</td><td>${REFCAT}</td></tr><tr><td>otherReference</td><td><ul class="otherReference"><li><a href="https://example.com/rc?a=1&amp;b=2" target="_blank">Public remote access</a></li></ul></td></tr></table></body></html>`;
	const PARCEL = `<FeatureCollection xmlns="http://www.opengis.net/wfs/2.0"><member><cp:CadastralParcel gml:id="ES.SDGC.CP.${REFCAT}"><gml:posList>725684.13 4372525.27 725685.12 4372525.09 725686.96 4372524.76</gml:posList></cp:CadastralParcel></member></FeatureCollection>`;
	const notFound = failWith('external.not_found', 'nothing there');
	// a click in Valencia: zone 30
	const VALENCIA = { bbox: [-0.4, 39.45, -0.35, 39.5], width: 500, height: 500, x: 250, y: 250 };

	test('a click without a bounding box is refused as request.invalid_options, nothing asked', async () => {
		const error = await failureOf(getCatastroParcel(contextOf({})));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/bounding box/);
		expect(asked).toEqual([]);
	});

	test("the reference, then its ring in the click's UTM zone, converted to [lat, lon]", async () => {
		answer = (id) => (id === 'catastro_wms_featureinfo' ? RESULT_PAGE : PARCEL);
		const data = dataOf<{ found: boolean; refcat: string; url: string; points: number[][] }>(
			await getCatastroParcel(contextOf(VALENCIA)),
		);
		expect(data).toMatchObject({
			found: true,
			refcat: REFCAT,
			url: 'https://example.com/rc?a=1&b=2',
			attribution: 'the provider',
		});
		expect(data.points[0]?.[0]).toBeCloseTo(39.4727395719826, 8);
		expect(data.points[0]?.[1]).toBeCloseTo(-0.376327842685717, 8);
		expect(asked.map((question) => question.id)).toEqual([
			'catastro_wms_featureinfo',
			'catastro_wfs_parcel',
		]);
		expect(asked[0]?.params).toMatchObject({
			crs: 'EPSG:3857',
			width: 101,
			height: 101,
			i: 50,
			j: 50,
		});
		expect(asked[1]?.params).toEqual({ refcat: REFCAT, crs: 'EPSG:25830' });
	});

	test.each([
		[-8.5, 'EPSG:25829'],
		[2.2, 'EPSG:25831'],
	])('a click at longitude %d asks for the ring in %s', async (lon, crs) => {
		answer = (id) => (id === 'catastro_wms_featureinfo' ? RESULT_PAGE : notFound());
		await getCatastroParcel(contextOf({ ...VALENCIA, bbox: [lon - 0.01, 41, lon + 0.01, 41.02] }));
		expect(asked[1]?.params).toEqual({ refcat: REFCAT, crs });
	});

	test('"nothing there" from either service is no parcel, not a failure', async () => {
		answer = notFound;
		expect(dataOf(await getCatastroParcel(contextOf(VALENCIA)))).toEqual({ found: false });
		answer = (id) => (id === 'catastro_wms_featureinfo' ? RESULT_PAGE : notFound());
		expect(dataOf(await getCatastroParcel(contextOf(VALENCIA)))).toEqual({
			found: false,
			refcat: REFCAT,
			url: 'https://example.com/rc?a=1&b=2',
		});
	});

	// core offers EPSG:25829-31 only: a Canary parcel's ring cannot be asked for
	test('a click in the Canary Islands is refused with its reason, nothing asked', async () => {
		const error = await failureOf(
			getCatastroParcel(contextOf({ ...VALENCIA, bbox: [-15.45, 28.1, -15.4, 28.15] })),
		);
		expectCode(error, 'tool.unsupported_target');
		expect(error.details).toEqual({ reason_key: 'catastro_canary_islands' });
		expect(asked).toEqual([]);
	});

	test("outside Spain's zones there is no parcel, and no third party is asked", async () => {
		expect(
			dataOf(await getCatastroParcel(contextOf({ ...VALENCIA, bbox: [10, 45, 10.1, 45.1] }))),
		).toEqual({ found: false });
		expect(asked).toEqual([]);
	});

	test('the feature-info box is centred on the clicked pixel', async () => {
		answer = notFound;
		await getCatastroParcel(contextOf(VALID_CLICK));
		expect(asked.map((question) => question.id)).toEqual(['catastro_wms_featureinfo']);
		expectCentredOnValidClick(asked[0]?.params.bbox);
	});

	test("a transient failure is the Catastro service unavailable; a final one is core's", async () => {
		answer = failWith('external.timeout', 'slow');
		const down = await failureOf(getCatastroParcel(contextOf(VALENCIA)));
		expectCode(down, 'tool.source_unavailable');
		expect(down.details).toEqual({ reason_key: 'catastro_unavailable' });
		answer = failWith('external.bad_config', 'refused');
		expectCode(await failureOf(getCatastroParcel(contextOf(VALENCIA))), 'external.bad_config');
	});

	test('a WFS reply that is not an answer (maintenance) is the source unavailable, never "no parcel"', async () => {
		answer = (id) =>
			id === 'catastro_wms_featureinfo'
				? RESULT_PAGE
				: '<html><body>INTERRUPCI&Oacute;N</body></html>';
		const error = await failureOf(getCatastroParcel(contextOf(VALENCIA)));
		expectCode(error, 'tool.source_unavailable');
	});
});

// the tool's own length windows say "too short" / "too long" in the user's
// words; they must be exactly core's, or a text between the two would reach
// core and come back as a reasonless request.invalid_data
describe("the tool's search-text windows are core's own", () => {
	test.each([
		['nominatim_search', 'q', 200],
		['dare_search_modern', 'name', 100],
		['dare_search_ancient', 'name', 100],
	] as const)('%s.%s takes 3 to %d characters', async (id, param, max) => {
		const { geoParamAccepts } = await import('../../tools/tool_uca_maps/server/geo_call.ts');
		expect(geoParamAccepts(id, param, 'ab')).toBe(false);
		expect(geoParamAccepts(id, param, 'abc')).toBe(true);
		expect(geoParamAccepts(id, param, 'a'.repeat(max))).toBe(true);
		expect(geoParamAccepts(id, param, 'a'.repeat(max + 1))).toBe(false);
	});
});

// the tool picks the ring's CRS by UTM zone; core's grammar is what may be asked
describe("Catastro's UTM zones are the CRSs core offers", () => {
	test('every zone the tool asks in is a CRS core accepts for the ring', async () => {
		const { CATASTRO_ZONES } = await import('../../tools/tool_uca_maps/server/catastro.ts');
		const { geoParamAccepts } = await import('../../tools/tool_uca_maps/server/geo_call.ts');
		expect(Object.keys(CATASTRO_ZONES)).not.toHaveLength(0);
		for (const crs of Object.values(CATASTRO_ZONES)) {
			expect(geoParamAccepts('catastro_wfs_parcel', 'crs', crs)).toBe(true);
		}
	});

	// the day core offers EPSG:25828 this goes red: drop the tool's refusal
	test('the Canary zones are refused because core does not offer their CRS', async () => {
		const { CANARY_ZONES } = await import('../../tools/tool_uca_maps/server/catastro.ts');
		const { geoParamAccepts } = await import('../../tools/tool_uca_maps/server/geo_call.ts');
		expect(CANARY_ZONES).not.toHaveLength(0);
		for (const zone of CANARY_ZONES) {
			expect(geoParamAccepts('catastro_wfs_parcel', 'crs', `EPSG:258${zone}`)).toBe(false);
		}
	});
});
