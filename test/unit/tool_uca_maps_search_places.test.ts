/**
 * tool_uca_maps — `search_places`: the Nominatim query built and its JSON
 * reduced, no network. The boundingbox reorder is where a silent axis swap
 * would send the map to the wrong continent with every row looking right.
 * The handler's refusals: tool_uca_maps_service_handlers.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import {
	parsePlaceResults,
	placeSearchUrl,
} from '../../tools/tool_uca_maps/server/place_search.ts';

describe('placeSearchUrl — the query built (no network)', () => {
	test('asks Nominatim for the search text, in jsonv2, capped at 8 hits', () => {
		const url = placeSearchUrl('Sagunto');
		expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
		expect(url.searchParams.get('q')).toBe('Sagunto');
		expect(url.searchParams.get('format')).toBe('jsonv2');
		expect(url.searchParams.get('limit')).toBe('8');
	});

	test('the search text is a query PARAM, so its own punctuation cannot reshape the url', () => {
		const url = placeSearchUrl('a&limit=999#x');
		expect(url.searchParams.get('q')).toBe('a&limit=999#x');
		expect(url.searchParams.get('limit')).toBe('8');
	});
});

describe('parsePlaceResults — Nominatim JSON → PlaceResult[]', () => {
	test('keeps name and point, and REORDERS boundingbox S/N/W/E → Leaflet S/W/N/E', () => {
		const results = parsePlaceResults(
			JSON.stringify([
				{
					display_name: 'Sagunt, Camp de Morvedre, València',
					lat: '39.6795',
					lon: '-0.2733',
					boundingbox: ['39.60', '39.75', '-0.35', '-0.20'],
				},
			]),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe('Sagunt, Camp de Morvedre, València');
		expect(results[0]?.point).toEqual([39.6795, -0.2733]);
		// south, west, north, east — NOT Nominatim's own south, north, west, east
		expect(results[0]?.bbox).toEqual([39.6, -0.35, 39.75, -0.2]);
	});

	test.each([
		['absent', undefined],
		['too short', ['39.60', '39.75', '-0.35']],
		['non-numeric', ['39.60', '39.75', 'west', '-0.20']],
		['not an array', '39.60,39.75,-0.35,-0.20'],
	])(
		'a hit whose boundingbox is %s keeps its point and reports bbox null',
		(_label, boundingbox) => {
			const results = parsePlaceResults(
				JSON.stringify([{ display_name: 'A well', lat: '39.5', lon: '-0.4', boundingbox }]),
			);
			expect(results[0]?.bbox).toBeNull();
			expect(results[0]?.point).toEqual([39.5, -0.4]);
		},
	);

	test('a hit with no usable coordinates is DROPPED, not returned half-built', () => {
		const results = parsePlaceResults(
			JSON.stringify([
				{ display_name: 'broken', lat: 'not-a-number', lon: '-0.4' },
				{ display_name: 'good', lat: '39.5', lon: '-0.4' },
			]),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe('good');
	});

	test('a nameless hit falls back to its own coordinates, never an empty row', () => {
		const results = parsePlaceResults(JSON.stringify([{ lat: '39.5', lon: '-0.4' }]));
		expect(results[0]?.name).toBe('39.5, -0.4');
	});

	test('an empty result set is an empty array, not a failure', () => {
		expect(parsePlaceResults('[]')).toEqual([]);
	});

	// The distinction the whole panel rests on: "this place does not exist" and
	// "the service did not answer me" must not reach the user as the same line.
	test('a service error object is an outbound refusal, not an empty result set', () => {
		expect(() => parsePlaceResults('{"error":"Bad Request"}')).toThrow(
			expect.objectContaining({
				code: 'security.outbound_failed',
				message: expect.stringMatching(/refused the request/),
			}),
		);
	});

	test('an unparseable body is a refusal, not a silent empty list', () => {
		expect(() => parsePlaceResults('<html>502</html>')).toThrow(/unreadable response/);
	});
});
