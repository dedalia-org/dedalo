/**
 * tool_uca_maps — fila #14 ("Imperio Romano"), hito 18. The PURE halves of the
 * three gazetteer searches: index matching, dataset matching, the DARE query
 * URL and its reply parsing. No network, no data directory — every fixture is
 * written here.
 */

import { describe, expect, test } from 'bun:test';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec } from '../../src/core/tools/module.ts';
import {
	dareApiUrl,
	decodeDareText,
	matchPelagiosFeatures,
	matchPleiadesIndex,
	parseDareResults,
	pleiadesPlaceUrl,
	searchPelagios,
} from '../../tools/tool_uca_maps/server/roman_empire.ts';
import { mustGet } from '../helpers/assert.ts';

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
	});
});

describe('dareApiUrl', () => {
	test('queries HTTPS, where v6 calls the same API over plain HTTP', () => {
		const url = dareApiUrl({ query: 'Gades', nameType: 'mss' });
		expect(url.protocol).toBe('https:');
		expect(url.host).toBe('imperium.ahlfeldt.se');
		expect(url.searchParams.get('mss')).toBe('Gades');
		expect(url.searchParams.get('ass')).toBeNull();
	});

	test('the ancient-name search uses DARE’s own `ass` parameter', () => {
		expect(dareApiUrl({ query: 'Gadir', nameType: 'ass' }).searchParams.get('ass')).toBe('Gadir');
	});

	test('both filters ride only when set, and only in DARE’s own shape', () => {
		const url = dareApiUrl({ query: 'Gades', nameType: 'mss', typeId: '11', country: 'es' });
		expect(url.searchParams.get('typeid')).toBe('11');
		expect(url.searchParams.get('cc')).toBe('ES');

		const bare = dareApiUrl({ query: 'Gades', nameType: 'mss', typeId: '', country: '' });
		expect(bare.searchParams.get('typeid')).toBeNull();
		expect(bare.searchParams.get('cc')).toBeNull();
	});

	test('anything outside those vocabularies is refused, never forwarded', () => {
		expect(() => dareApiUrl({ query: 'x', nameType: 'name' })).toThrow(/name type/);
		expect(() => dareApiUrl({ query: 'x', nameType: 'mss', typeId: '11&cc=ES' })).toThrow(
			/site type/,
		);
		expect(() => dareApiUrl({ query: 'x', nameType: 'mss', country: 'ESP' })).toThrow(/country/);
	});
});

describe('parseDareResults', () => {
	const REPLY = JSON.stringify({
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: { name: 'Gades' },
				geometry: { type: 'Point', coordinates: [-6.3, 36.5] },
			},
			{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
		],
	});

	test('keeps the named features, with their geometry, in service order', () => {
		const results = parseDareResults(REPLY);
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe('Gades');
		expect(results[0]?.geometry_type).toBe('Point');
		expect(results[0]?.feature).toBeDefined();
	});

	test('honours the result limit', () => {
		expect(parseDareResults(REPLY, 0)).toHaveLength(0);
	});

	test('A REFUSAL IS NOT ZERO RESULTS (same law as place_search)', () => {
		expect(() => parseDareResults('{"error":"blocked"}')).toThrow(/refused/);
		expect(() => parseDareResults('<html>')).toThrow(/unreadable/);
	});
});

describe('decodeDareText', () => {
	// measured live 2026-09-16: DARE answers `ass=Gades` with "CÃ¡diz" and
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
		const reply = JSON.stringify({
			features: [{ properties: { name: 'CÃ¡diz' }, geometry: { type: 'Point' } }],
		});
		const hit = parseDareResults(reply)[0];
		expect(hit?.name).toBe('Cádiz');
		// and the OBJECT the user draws carries the repaired name too
		expect((hit?.feature as { properties: { name: string } }).properties.name).toBe('Cádiz');
	});
});

describe('pleiadesPlaceUrl', () => {
	test('asks Pleiades itself over HTTPS, not v6’s GitHub mirror', () => {
		const url = pleiadesPlaceUrl('256135');
		expect(url.protocol).toBe('https:');
		expect(url.host).toBe('pleiades.stoa.org');
		expect(url.pathname).toBe('/places/256135/json');
	});
});

describe('searchPelagios: the dataset list the client sends is filtered, not trusted', () => {
	// reached BEFORE any store/DB access, so this needs no database
	const contextOf = (datasets: unknown) => ({
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { query: 'Baetica', datasets },
		background: false,
	});

	test('a name outside the closed list is dropped, and dropping them all is refused', async () => {
		await expect(searchPelagios(contextOf(['../../etc/passwd', 'places_secret']))).rejects.toThrow(
			/at least one dataset/,
		);
		await expect(searchPelagios(contextOf([]))).rejects.toThrow(/at least one dataset/);
		await expect(searchPelagios(contextOf(undefined))).rejects.toThrow(/at least one dataset/);
	});
});

describe('the four gazetteer actions are registered, and gated like every other lookup', () => {
	// without this, deleting an action from `server/index.ts` leaves every
	// assertion above green while the panel 404s — and a downgrade to a plain
	// 'section'/'tipo' gate would silently drop half of the record_tipo check
	test.each(['search_pleiades', 'get_pleiades_place', 'search_pelagios', 'search_dare'])(
		'%s: record_tipo at read level',
		async (name) => {
			const loaded = await getLoadedTool('tool_uca_maps');
			const action = mustGet(
				loaded?.module.apiActions[name as string],
				name as string,
			) as GatedToolActionSpec;
			expect(action.permission).toBe('record_tipo');
			expect(action.minLevel).toBe(1);
		},
	);
});
