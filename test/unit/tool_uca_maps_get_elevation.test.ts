/**
 * tool_uca_maps — `get_elevation` (fila #3, "Consola de objeto": la elevación
 * del centro del objeto seleccionado).
 *
 * What this pins:
 *  - `elevationUrl` (pure, no network): the exact `locations=lat,lon` query,
 *    which is the one place an axis swap would report the elevation of a
 *    different continent while the panel still looked right;
 *  - `parseElevation` (pure): a real answer is read, and EVERY malformed one
 *    reads as `null` rather than as 0 — sea level is a legitimate elevation
 *    and must never be how a parse failure looks;
 *  - caller-fault validation: a missing, non-numeric or out-of-range
 *    coordinate is refused as `request.invalid_options`, not swallowed into
 *    the "service unavailable" answer that a transport failure gets.
 *
 * No live call to api.open-elevation.com: this repo's tests never depend on a
 * third-party service being up (same discipline as the search_places gate).
 */

import { describe, expect, test } from 'bun:test';
import {
	elevationUrl,
	getElevation,
	parseElevation,
} from '../../tools/tool_uca_maps/server/elevation.ts';
import { contextOf, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

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
	])('refuses %s as request.invalid_options', async (_label, options) => {
		const error = await failureOf(getElevation(contextOf(options)));
		expect(error.code).toBe('request.invalid_options');
	});

	test('accepts the exact poles and antimeridian — they are real coordinates', () => {
		expect(elevationUrl(90, 180).searchParams.get('locations')).toBe('90,180');
		expect(elevationUrl(-90, -180).searchParams.get('locations')).toBe('-90,-180');
	});
});
