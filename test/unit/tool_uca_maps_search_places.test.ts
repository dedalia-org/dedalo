/**
 * tool_uca_maps — `search_places` (fila #1, "Buscador de lugares").
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    every other read-only proxy this tool ships (get_wms_layers,
 *    get_catastro_parcel, get_administrative_unit) — the action writes
 *    nothing, it asks a public gazetteer on the caller's behalf;
 *  - `placeSearchUrl` + `parsePlaceResults` (pure, no network): the exact
 *    query built, and the reduction of Nominatim's own JSON — INCLUDING the
 *    boundingbox permutation (Nominatim S/N/W/E → Leaflet S/W/N/E), which is
 *    the one place a silent axis swap would send the map to the wrong
 *    continent while every row still looked right;
 *  - caller-fault validation (empty/over-long query) refused as
 *    `request.invalid_options`, not as a server failure.
 *
 * No live call to nominatim.openstreetmap.org: this repo's tests never depend
 * on a third-party service being up (same discipline as
 * `tool_uca_maps_get_wms_layers.test.ts`).
 */

import { describe, expect, test } from 'bun:test';
import type { DedaloError } from '../../src/core/errors/index.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	parsePlaceResults,
	placeSearchUrl,
} from '../../tools/tool_uca_maps/server/place_search.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.search_places, 'search_places');
	return action as GatedToolActionSpec;
}

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps search_places — declared gate', () => {
	test("is record_tipo at read level (1), same criterion as the tool's other read actions", async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

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

	test('a hit with no usable boundingbox keeps its point and reports bbox null', () => {
		const results = parsePlaceResults(
			JSON.stringify([{ display_name: 'A well', lat: '39.5', lon: '-0.4' }]),
		);
		expect(results[0]?.bbox).toBeNull();
		expect(results[0]?.point).toEqual([39.5, -0.4]);
	});

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
	test('a service error object is a refusal, not an empty result set', () => {
		expect(() => parsePlaceResults('{"error":"Bad Request"}')).toThrow(/refused the request/);
	});

	test('a refusal carries the outbound class, not a caller fault', () => {
		try {
			parsePlaceResults('{"error":"Bad Request"}');
			throw new Error('expected a refusal');
		} catch (error) {
			expect((error as DedaloError).code).toBe('security.outbound_failed');
		}
	});

	test('an unparseable body is a refusal, not a silent empty list', () => {
		expect(() => parsePlaceResults('<html>502</html>')).toThrow(/unreadable response/);
	});
});

describe('tool_uca_maps search_places — handler validation (no network)', () => {
	test('an empty query is refused as a caller fault', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({ query: '   ' }))).rejects.toThrow(
			/search text is required/,
		);
		await expect(action.handler(contextOf({}))).rejects.toThrow(/search text is required/);
	});

	test('an over-long query is refused before anything is sent to a third party', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({ query: 'x'.repeat(201) }))).rejects.toThrow(/too long/);
	});
});
