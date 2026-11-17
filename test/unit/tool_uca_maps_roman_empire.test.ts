/**
 * tool_uca_maps — the pure halves of the three gazetteer searches: index
 * matching, dataset matching, the DARE query (core's service, the filters)
 * and its reply parsing. No
 * network, no data directory: every fixture is written here.
 */

import { describe, expect, test } from 'bun:test';
import {
	dareQuery,
	decodeDareText,
	matchPelagiosFeatures,
	matchPleiadesIndex,
	parseDareResults,
	searchPelagios,
} from '../../tools/tool_uca_maps/server/roman_empire.ts';
import { contextOf, expectCode, thrownBy } from './fixtures/tool_uca_maps/helpers.ts';

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
		await expect(searchPelagios(searching(['../../etc/passwd', 'places_secret']))).rejects.toThrow(
			/at least one dataset/,
		);
		await expect(searchPelagios(searching([]))).rejects.toThrow(/at least one dataset/);
		await expect(searchPelagios(searching(undefined))).rejects.toThrow(/at least one dataset/);
	});
});
