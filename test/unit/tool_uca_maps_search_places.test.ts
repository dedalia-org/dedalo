/**
 * tool_uca_maps — `search_places`: Nominatim's JSON reduced, no network (the
 * question core asks: tool_uca_maps_service_handlers.test.ts). The boundingbox reorder is where a silent axis swap
 * would send the map to the wrong continent with every row looking right.
 * The handler's refusals: tool_uca_maps_service_handlers.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { parsePlaceResults } from '../../tools/tool_uca_maps/server/place_search.ts';

describe('parsePlaceResults — Nominatim JSON → PlaceResult[]', () => {
	test('keeps name and point, and REORDERS boundingbox S/N/W/E → Leaflet S/W/N/E', () => {
		const results = parsePlaceResults([
			{
				display_name: 'Sagunt, Camp de Morvedre, València',
				lat: '39.6795',
				lon: '-0.2733',
				boundingbox: ['39.60', '39.75', '-0.35', '-0.20'],
			},
		]);
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
			const results = parsePlaceResults([
				{ display_name: 'A well', lat: '39.5', lon: '-0.4', boundingbox },
			]);
			expect(results[0]?.bbox).toBeNull();
			expect(results[0]?.point).toEqual([39.5, -0.4]);
		},
	);

	test('a hit with no usable coordinates is DROPPED, not returned half-built', () => {
		const results = parsePlaceResults([
			{ display_name: 'broken', lat: 'not-a-number', lon: '-0.4' },
			{ display_name: 'good', lat: '39.5', lon: '-0.4' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe('good');
	});

	test('a nameless hit falls back to its own coordinates, never an empty row', () => {
		const results = parsePlaceResults([{ lat: '39.5', lon: '-0.4' }]);
		expect(results[0]?.name).toBe('39.5, -0.4');
	});

	test('an empty result set is an empty array, not a failure', () => {
		expect(parsePlaceResults([])).toEqual([]);
	});

	// The distinction the whole panel rests on: "this place does not exist" and
	// "the service did not answer me" must not reach the user as the same line.
	test('a service error object is the source unavailable, not an empty result set', () => {
		expect(() => parsePlaceResults({ error: 'Bad Request' })).toThrow(
			expect.objectContaining({
				code: 'tool.source_unavailable',
				details: { reason_key: 'place_search_unavailable' },
				message: expect.stringMatching(/refused the request/),
			}),
		);
	});
});
