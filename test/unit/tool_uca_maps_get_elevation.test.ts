/**
 * tool_uca_maps — `get_elevation`: the `locations=lat,lon` query, where an
 * axis swap would report another continent, and the answer read, where every
 * malformed reply must be null and never 0 (sea level is a real elevation).
 * The handler's validation: tool_uca_maps_service_handlers.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { elevationUrl, parseElevation } from '../../tools/tool_uca_maps/server/elevation.ts';

describe('elevationUrl — the query built (no network)', () => {
	test('asks Open-Elevation for one point, latitude first', () => {
		const url = elevationUrl(39.6766, -0.2726);
		expect(url.origin + url.pathname).toBe('https://api.open-elevation.com/api/v1/lookup');
		expect(url.searchParams.get('locations')).toBe('39.6766,-0.2726');
	});

	test('a southern/western point keeps its signs', () => {
		expect(elevationUrl(-33.45, -70.66).searchParams.get('locations')).toBe('-33.45,-70.66');
	});
});

describe('parseElevation — reading the answer', () => {
	test('reads the elevation of the first result', () => {
		expect(parseElevation('{"results":[{"latitude":39.6,"longitude":-0.2,"elevation":412}]}')).toBe(
			412,
		);
	});

	test('zero metres is a real elevation, not a failure', () => {
		expect(parseElevation('{"results":[{"elevation":0}]}')).toBe(0);
	});

	test('a negative elevation (below sea level) is read as-is', () => {
		expect(parseElevation('{"results":[{"elevation":-31}]}')).toBe(-31);
	});

	test.each([
		['not json at all', '<html>502 Bad Gateway</html>'],
		['no results key', '{"error":"rate limited"}'],
		['an empty results array', '{"results":[]}'],
		['a non-numeric elevation', '{"results":[{"elevation":"high"}]}'],
		['a null elevation', '{"results":[{"elevation":null}]}'],
	])('%s reads as null, never as 0', (_label, text) => {
		expect(parseElevation(text)).toBeNull();
	});
});
