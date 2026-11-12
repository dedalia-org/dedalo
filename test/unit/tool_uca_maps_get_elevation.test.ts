/**
 * tool_uca_maps — `get_elevation`: the answer read, where every malformed reply
 * must be null and never 0 (sea level is a real elevation). The question core
 * asks (latitude first) and the handler's validation:
 * tool_uca_maps_service_handlers.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { parseElevation } from '../../tools/tool_uca_maps/server/elevation.ts';

describe('parseElevation — reading the answer', () => {
	test('reads the elevation of the first result', () => {
		expect(parseElevation({ results: [{ latitude: 39.6, longitude: -0.2, elevation: 412 }] })).toBe(
			412,
		);
	});

	test('zero metres is a real elevation, not a failure', () => {
		expect(parseElevation({ results: [{ elevation: 0 }] })).toBe(0);
	});

	test('a negative elevation (below sea level) is read as-is', () => {
		expect(parseElevation({ results: [{ elevation: -31 }] })).toBe(-31);
	});

	test.each([
		['no answer at all', null],
		['no results key', { error: 'rate limited' }],
		['an empty results array', { results: [] }],
		['a non-numeric elevation', { results: [{ elevation: 'high' }] }],
		['a null elevation', { results: [{ elevation: null }] }],
	])('%s reads as null, never as 0', (_label, payload) => {
		expect(parseElevation(payload)).toBeNull();
	});
});
