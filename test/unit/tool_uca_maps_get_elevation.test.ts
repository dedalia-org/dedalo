/**
 * tool_uca_maps — `get_elevation` (fila #3, "Consola de objeto": la elevación
 * del centro del objeto seleccionado).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), the criterion every
 *    read-only proxy in this tool ships with;
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
import type { DedaloError } from '../../src/core/errors/index.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	elevationUrl,
	getElevation,
	parseElevation,
} from '../../tools/tool_uca_maps/server/elevation.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.get_elevation, 'get_elevation');
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

async function refusalOf(options: Record<string, unknown>): Promise<DedaloError> {
	try {
		await getElevation(contextOf(options));
	} catch (error) {
		return error as DedaloError;
	}
	throw new Error('expected get_elevation to refuse these options');
}

describe('tool_uca_maps get_elevation — declared gate', () => {
	test("is record_tipo at read level (1), same criterion as the tool's other read actions", async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

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
		const error = await refusalOf(options);
		expect(error.code).toBe('request.invalid_options');
	});

	test('accepts the exact poles and antimeridian — they are real coordinates', () => {
		expect(elevationUrl(90, 180).searchParams.get('locations')).toBe('90,180');
		expect(elevationUrl(-90, -180).searchParams.get('locations')).toBe('-90,-180');
	});
});
