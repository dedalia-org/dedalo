/**
 * tool_uca_maps — the three gazetteer searches: index matching, dataset
 * matching, the DARE query (core's service, the filters) and its reply parsing,
 * then the Pleiades and Pelagios actions against a store built in a temp dir.
 * No network: every fixture is written here.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as toolConfig from '../../src/core/tools/config.ts';
import { roman_min_query } from '../../tools/tool_uca_maps/js/roman_min_query.js';
import {
	GAZETTEER_CONFIG_KEY,
	probeGazetteers,
} from '../../tools/tool_uca_maps/server/gazetteer_store.ts';
import {
	dareQuery,
	decodeDareText,
	getPleiadesPlace,
	matchPelagiosFeatures,
	matchPleiadesIndex,
	parseDareResults,
	searchDare,
	searchPelagios,
	searchPleiades,
} from '../../tools/tool_uca_maps/server/roman_empire.ts';
import {
	contextOf,
	dataOf,
	expectCode,
	failureOf,
	refusal,
	thrownBy,
} from './fixtures/tool_uca_maps/helpers.ts';
import { scriptedSite } from './fixtures/tool_uca_maps/scripted_site.ts';

/** v6's own index shape: a flat array of [name, id] pairs. */
const PLEIADES_INDEX = JSON.stringify([
	['Gades', '256135'],
	['Gadir', '256135'],
	['Augusta Emerita', '256155'],
	['Emerita', '256155'],
	['Tarraco', '246343'],
]);

const PELAGIOS_PLACES = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { id: '1', modern: 'Trier', latin: 'Augusta Treverorum' },
			geometry: { type: 'Point', coordinates: [6.64, 49.75] },
		},
		{
			type: 'Feature',
			properties: { id: '2', modern: 'Mérida', latin: 'Augusta Emerita' },
			geometry: { type: 'Point', coordinates: [-6.34, 38.91] },
		},
		{ type: 'Feature', properties: { id: '3' }, geometry: { type: 'Point', coordinates: [0, 0] } },
	],
});

const PELAGIOS_PROVINCES = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { name: 'Baetica' },
			geometry: { type: 'MultiPolygon', coordinates: [] },
		},
	],
});

describe('matchPleiadesIndex', () => {
	test('searches names case-insensitively, as substrings', () => {
		expect(matchPleiadesIndex(PLEIADES_INDEX, 'name', 'gad')).toEqual([
			{ name: 'Gades', id: '256135' },
			{ name: 'Gadir', id: '256135' },
		]);
	});

	test('searches ids by exact match, never as a substring', () => {
		expect(matchPleiadesIndex(PLEIADES_INDEX, 'id', '256155')).toEqual([
			{ name: 'Augusta Emerita', id: '256155' },
			{ name: 'Emerita', id: '256155' },
		]);
		expect(matchPleiadesIndex(PLEIADES_INDEX, 'id', '2561')).toEqual([]);
	});

	test('honours the result limit', () => {
		expect(matchPleiadesIndex(PLEIADES_INDEX, 'name', 'a', 2)).toHaveLength(2);
	});

	test('a malformed or non-array index is an install fault, not zero results', () => {
		expect(() => matchPleiadesIndex('{not json', 'name', 'gad')).toThrow(/not readable/);
		expect(() => matchPleiadesIndex('{"a":1}', 'name', 'gad')).toThrow(/unexpected shape/);
		for (const text of ['{not json', '{"a":1}']) {
			expectCode(
				thrownBy(() => matchPleiadesIndex(text, 'name', 'gad')),
				'tool.dependency_unavailable',
			);
		}
	});
});

describe('matchPelagiosFeatures', () => {
	test('matches the modern name and labels the hit with it', () => {
		const [hit] = matchPelagiosFeatures(PELAGIOS_PLACES, 'places_high', 'trier');
		expect(hit?.name).toBe('Trier');
		expect(hit?.dataset).toBe('places_high');
		expect(hit?.geometry_type).toBe('Point');
		expect(hit?.feature).toBeDefined();
	});

	test('matches the ancient (latin) name too, still labelled by the modern one', () => {
		const [hit] = matchPelagiosFeatures(PELAGIOS_PLACES, 'places_high', 'treverorum');
		expect(hit?.name).toBe('Trier');
	});

	test('matches the `name` property of the boundary layers', () => {
		const [hit] = matchPelagiosFeatures(PELAGIOS_PROVINCES, 'provinces', 'baet');
		expect(hit?.name).toBe('Baetica');
	});

	test('a feature with no name at all is skipped, never returned unnamed', () => {
		expect(matchPelagiosFeatures(PELAGIOS_PLACES, 'places_high', '')).toHaveLength(2);
	});

	test('DIVERGENCE FROM v6: several hits from the SAME dataset all count', () => {
		// v6 keeps one hit per file (its `$exists` check compares the file
		// name), so this search would answer with Trier alone
		const hits = matchPelagiosFeatures(PELAGIOS_PLACES, 'places_high', 'augusta');
		expect(hits.map((hit) => hit.name)).toEqual(['Trier', 'Mérida']);
	});

	test('an unreadable dataset is an install fault, not zero results', () => {
		expect(() => matchPelagiosFeatures('{not json', 'places_high', 'x')).toThrow(/not readable/);
		expect(() => matchPelagiosFeatures('{"type":"X"}', 'places_high', 'x')).toThrow(
			/unexpected shape/,
		);
		for (const text of ['{not json', '{"type":"X"}']) {
			expectCode(
				thrownBy(() => matchPelagiosFeatures(text, 'places_high', 'x')),
				'tool.dependency_unavailable',
			);
		}
	});
});

describe('dareQuery', () => {
	test('each name field asks its own core service', () => {
		expect(dareQuery({ nameType: 'mss' }).service).toBe('dare_search_modern');
		expect(dareQuery({ nameType: 'ass' }).service).toBe('dare_search_ancient');
	});

	test('both filters are kept only when set, the country upper-cased', () => {
		expect(dareQuery({ nameType: 'mss', typeId: '11', country: 'es' })).toMatchObject({
			typeId: '11',
			country: 'ES',
		});
		expect(dareQuery({ nameType: 'mss', typeId: '', country: '' })).toMatchObject({
			typeId: null,
			country: null,
		});
	});

	test('anything outside those vocabularies is refused', () => {
		expect(() => dareQuery({ nameType: 'name' })).toThrow(/name type/);
		expect(() => dareQuery({ nameType: '__proto__' })).toThrow(/name type/);
		expect(() => dareQuery({ nameType: 'mss', typeId: '11&cc=ES' })).toThrow(/site type/);
		expect(() => dareQuery({ nameType: 'mss', country: 'ESP' })).toThrow(/country/);
	});
});

describe('parseDareResults', () => {
	const REPLY = {
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: { name: 'Gades' },
				geometry: { type: 'Point', coordinates: [-6.3, 36.5] },
			},
			{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
		],
	};

	test('keeps the named features, with their geometry, in service order', () => {
		const results = parseDareResults(REPLY);
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe('Gades');
		expect(results[0]?.geometry_type).toBe('Point');
		expect(results[0]?.feature).toBeDefined();
	});

	test('honours the result limit, keeping the first hits in service order', () => {
		const none = { typeId: null, country: null };
		expect(parseDareResults(REPLY, none, 0)).toHaveLength(0);
		const three = {
			features: ['Gades', 'Hispalis', 'Corduba'].map((name) => ({
				properties: { name },
				geometry: { type: 'Point' },
			})),
		};
		expect(parseDareResults(three, none, 2).map((hit) => hit.name)).toEqual(['Gades', 'Hispalis']);
	});

	// v6 sent them as `typeid` / `cc`; core's service takes the name alone
	test('the type and country filters keep only the hits DARE itself labels so', () => {
		const mixed = {
			features: [
				{ properties: { name: 'Sagunto', numType: '11', country: 'ES' } },
				{ properties: { name: 'Sagunto', numType: '14', country: 'ES' } },
				{ properties: { name: 'Saguntum', numType: '11', country: 'IT' } },
			],
		};
		const names = (filters: { typeId: string | null; country: string | null }) =>
			parseDareResults(mixed, filters).map((hit) => hit.feature);
		expect(names({ typeId: '11', country: null })).toHaveLength(2);
		expect(names({ typeId: null, country: 'ES' })).toHaveLength(2);
		expect(names({ typeId: '11', country: 'ES' })).toEqual([
			{ properties: { name: 'Sagunto', numType: '11', country: 'ES' } },
		]);
		expect(names({ typeId: null, country: null })).toHaveLength(3);
	});

	test('A REFUSAL IS NOT ZERO RESULTS (same law as place_search)', () => {
		expect(() => parseDareResults({ error: 'blocked' })).toThrow(/refused/);
		expect(() => parseDareResults(null)).toThrow(/refused/);
	});
});

describe('decodeDareText', () => {
	// as measured on the live service: DARE answers `ass=Gades` with "CÃ¡diz" and
	// "Ã–rektaÅŸÄ±" — UTF-8 bytes that were read as CP1252 upstream
	test('repairs the CP1252 mojibake DARE serves', () => {
		expect(decodeDareText('CÃ¡diz')).toBe('Cádiz');
		expect(decodeDareText('Ã–rektaÅŸÄ±')).toBe('Örektaşı');
	});

	test('leaves clean text alone, in either alphabet', () => {
		expect(decodeDareText('Mainz')).toBe('Mainz');
		expect(decodeDareText('Cádiz')).toBe('Cádiz');
		expect(decodeDareText('Αθήνα')).toBe('Αθήνα');
	});

	test('the repaired name is what a hit carries', () => {
		const reply = {
			features: [{ properties: { name: 'CÃ¡diz' }, geometry: { type: 'Point' } }],
		};
		const hit = parseDareResults(reply)[0];
		expect(hit?.name).toBe('Cádiz');
		// and the OBJECT the user draws carries the repaired name too
		expect((hit?.feature as { properties: { name: string } }).properties.name).toBe('Cádiz');
	});
});

describe('searchPelagios: the dataset list the client sends is filtered, not trusted', () => {
	// reached BEFORE any store/DB access, so this needs no database
	const searching = (datasets: unknown) =>
		contextOf({ query: 'Baetica', datasets }, -1, { record: false });

	test('a name outside the closed list is dropped, and dropping them all is refused', async () => {
		for (const datasets of [['../../etc/passwd', 'places_secret'], [], undefined]) {
			await refusal(
				searchPelagios(searching(datasets)),
				'request.invalid_options',
				'no_dataset_selected',
			);
		}
	});
});

/** A store in a temp dir, named as the install option; `files` are paths under it. */
function configuredStore(files: Record<string, string>): { dir: string; restore: () => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uca_roman_store_')));
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(join(dir, relative, '..'), { recursive: true });
		writeFileSync(join(dir, relative), text);
	}
	const read = spyOn(toolConfig, 'getToolConfigValue').mockImplementation((async (
		tool: string,
		key: string,
		fallback: unknown,
	) =>
		tool === 'tool_uca_maps' && key === GAZETTEER_CONFIG_KEY
			? dir
			: fallback) as typeof toolConfig.getToolConfigValue);
	return {
		dir,
		restore: () => {
			read.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** The reason_key a refusal carried, if any. */
const reasonOf = (error: { details?: unknown }) =>
	(error.details as { reason_key?: string } | undefined)?.reason_key;

describe('searchPleiades', () => {
	// refused BEFORE any store/DB access
	const searching = (options: Record<string, unknown>) => contextOf(options, -1, { record: false });

	test('an unknown search type is refused', async () => {
		expectCode(
			await failureOf(searchPleiades(searching({ type: 'title', value: 'Gades' }))),
			'request.invalid_options',
		);
	});

	test("v6's minimums: 3 characters by name, one by id", async () => {
		for (const options of [
			{ type: 'name', value: 'Ga' },
			{ type: 'name', value: '   ' },
			{ type: 'id', value: '' },
		]) {
			const error = await failureOf(searchPleiades(searching(options)));
			expectCode(error, 'request.invalid_options');
			expect(reasonOf(error)).toBe('search_text_too_short');
		}
	});

	describe('against a configured store', () => {
		let store: { dir: string; restore: () => void } | null = null;
		afterEach(() => {
			store?.restore();
			store = null;
		});

		test('searches the index by name and by id', async () => {
			store = configuredStore({ 'pleiades.json': PLEIADES_INDEX });
			expect(dataOf(await searchPleiades(searching({ type: 'name', value: 'eme' })))).toEqual({
				results: [
					{ name: 'Augusta Emerita', id: '256155' },
					{ name: 'Emerita', id: '256155' },
				],
			});
			expect(dataOf(await searchPleiades(searching({ type: 'id', value: '246343' })))).toEqual({
				results: [{ name: 'Tarraco', id: '246343' }],
			});
		});

		test('a store without the index is an install gap, not zero results', async () => {
			store = configuredStore({ 'pelagios/provinces.geojson': PELAGIOS_PROVINCES });
			const error = await failureOf(searchPleiades(searching({ type: 'name', value: 'Gades' })));
			expectCode(error, 'tool.dependency_unavailable');
			expect(error.message).toMatch(/Pleiades index is missing/);
		});
	});
});

describe('searchPelagios against a configured store', () => {
	let store: { dir: string; restore: () => void } | null = null;
	beforeEach(() => {
		store = configuredStore({
			'pelagios/places_high.geojson': PELAGIOS_PLACES,
			'pelagios/provinces.geojson': PELAGIOS_PROVINCES,
		});
	});
	afterEach(() => {
		store?.restore();
		store = null;
	});
	const searching = (query: string, datasets: string[]) =>
		contextOf({ query, datasets }, -1, { record: false });

	test('finds a place in each selected layer', async () => {
		const { results } = dataOf<{ results: { name: string; dataset: string }[] }>(
			await searchPelagios(searching('ba', ['places_high', 'provinces'])),
		);
		expect(results.map(({ name, dataset }) => [name, dataset])).toEqual([['Baetica', 'provinces']]);
		const merida = dataOf<{ results: { name: string; dataset: string }[] }>(
			await searchPelagios(searching('emerita', ['places_high', 'provinces'])),
		).results;
		expect(merida.map(({ name, dataset }) => [name, dataset])).toEqual([['Mérida', 'places_high']]);
	});

	test('a layer the install lacks is skipped, the others still searched', async () => {
		const { results } = dataOf<{ results: { name: string }[] }>(
			await searchPelagios(searching('Baetica', ['roads_high', 'provinces'])),
		);
		expect(results.map(({ name }) => name)).toEqual(['Baetica']);
	});
});

describe('getPleiadesPlace refuses a non-numeric id before any request', () => {
	test.each([['../1'], ['1a'], ['1234567890123'], ['']])('id %p', async (id) => {
		const site = scriptedSite({});
		const error = await failureOf(getPleiadesPlace(contextOf({ id }), site.deps));
		expectCode(error, 'request.invalid_options');
		expect(site.sent).toEqual([]);
	});
});

describe('probeGazetteers against a configured store', () => {
	let store: { dir: string; restore: () => void } | null = null;
	afterEach(() => {
		store?.restore();
		store = null;
	});

	test('reports what the store holds, never where it is', async () => {
		store = configuredStore({
			'pleiades.json': PLEIADES_INDEX,
			'pelagios/provinces.geojson': PELAGIOS_PROVINCES,
			'pelagios/not_listed.geojson': PELAGIOS_PROVINCES,
		});
		const probe = await probeGazetteers();
		expect(probe).toEqual({ configured: true, pleiades: true, pelagios: ['provinces'] });
		expect(JSON.stringify(probe)).not.toContain(store.dir);
	});

	// an existing directory, relative to where the server runs: it still names no store
	test('a relative path is not a store', async () => {
		const read = spyOn(toolConfig, 'getToolConfigValue').mockImplementation(
			(async () => 'tools/tool_uca_maps/gazetteers') as typeof toolConfig.getToolConfigValue,
		);
		try {
			expect(await probeGazetteers()).toEqual({ configured: false, pleiades: false, pelagios: [] });
		} finally {
			read.mockRestore();
		}
	});
});

// the browser waits for roman_min_query before it sends: the server must refuse
// exactly below it, or a typed query is refused or a short one travels
describe('the server refuses exactly below the minimum the browser waits for', () => {
	const unconfigured = () =>
		spyOn(toolConfig, 'getToolConfigValue').mockImplementation(
			(async () => '') as typeof toolConfig.getToolConfigValue,
		);
	// past the length check each is refused for another reason, before any I/O:
	// no store for Pleiades and Pelagios, a control character core refuses for DARE
	const sources = [
		{
			label: 'Pleiades by name',
			min: roman_min_query('pleiades', 'name'),
			run: (text: string) => searchPleiades(contextOf({ type: 'name', value: text })),
		},
		{
			label: 'Pleiades by id',
			min: roman_min_query('pleiades', 'id'),
			run: (text: string) => searchPleiades(contextOf({ type: 'id', value: text })),
		},
		{
			label: 'Pelagios',
			min: roman_min_query('pelagios'),
			run: (text: string) => searchPelagios(contextOf({ query: text, datasets: ['provinces'] })),
		},
		{
			label: 'DARE',
			min: roman_min_query('dare'),
			run: (text: string) => searchDare(contextOf({ query: `${text.slice(1)}\u0007` })),
		},
	];

	test.each(sources.map((source) => [source.label, source]))('%s', async (_label, source) => {
		const read = unconfigured();
		try {
			const short = await failureOf(source.run('1'.repeat(source.min - 1)));
			expect(reasonOf(short)).toBe('search_text_too_short');
			const enough = await failureOf(source.run('1'.repeat(source.min)));
			expect(reasonOf(enough)).not.toBe('search_text_too_short');
		} finally {
			read.mockRestore();
		}
	});
});
