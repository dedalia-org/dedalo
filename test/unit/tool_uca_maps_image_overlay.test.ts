/**
 * tool_uca_maps — `get_image_overlay`: where on the map an uploaded image goes.
 * GDAL's ring order (upperLeft, lowerLeft, lowerRight, upperRight) is not the
 * order `L.imageOverlay.rotated` takes (top-left, top-right, bottom-left), and
 * getting it wrong mirrors every uploaded raster without failing anything.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../../src/core/errors/index.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import * as gdal from '../../tools/tool_uca_maps/server/gdal.ts';
import {
	cornersFromWgs84Extent,
	overlayFallbackOf,
	readGeoreference,
} from '../../tools/tool_uca_maps/server/image_overlay.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	dataOf,
	expectCode,
	failureOf,
	haveGdal,
	loadAction,
} from './fixtures/tool_uca_maps/helpers.ts';
import { withImageFiles } from './fixtures/tool_uca_maps/image_slot.ts';

const HAVE_GDAL = haveGdal('gdalinfo', 'gdal_create');

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: 1, isGlobalAdmin: true, isDeveloper: true },
		userId: 1,
		options,
		background: false,
	};
}

describe('tool_uca_maps get_image_overlay — caller-fault validation (no DB/GDAL needed)', () => {
	// a record id is always positive
	test.each([
		['missing', {}],
		['0', { section_id: 0 }],
	])('a section_id %s is refused before any database access', async (_, id) => {
		const action = await loadAction('get_image_overlay');
		const error = await failureOf(
			action.handler(contextOf({ tipo: 'test99', section_tipo: 'test3', ...id })),
		);
		expectCode(error, 'request.invalid_source');
		expect(error.message).toMatch(/tipo, section_tipo and a positive section_id/);
	});
});

describe('tool_uca_maps get_image_overlay — wgs84Extent → three corners', () => {
	// GDAL's own ring order for a north-up raster, in [lon, lat] GeoJSON order.
	const RING = {
		type: 'Polygon',
		coordinates: [
			[
				[-0.5, 39.5], // upperLeft
				[-0.5, 39.0], // lowerLeft
				[0.5, 39.0], // lowerRight
				[0.5, 39.5], // upperRight
				[-0.5, 39.5], // closing point, repeats upperLeft
			],
		],
	};

	test('maps GDAL ring order to the rotated overlay control points, lat first', () => {
		const corners = mustGet(cornersFromWgs84Extent(RING), 'corners');
		expect(corners.top_left).toEqual([39.5, -0.5]);
		expect(corners.top_right).toEqual([39.5, 0.5]);
		expect(corners.bottom_left).toEqual([39.0, -0.5]);
	});

	test('a missing / malformed extent yields no corners rather than a wrong placement', () => {
		expect(cornersFromWgs84Extent(undefined)).toBeNull();
		expect(cornersFromWgs84Extent(null)).toBeNull();
		expect(cornersFromWgs84Extent({})).toBeNull();
		expect(cornersFromWgs84Extent({ coordinates: [[[0, 0]]] })).toBeNull();
		expect(
			cornersFromWgs84Extent({
				coordinates: [
					[
						['x', 0],
						[0, 0],
						[0, 0],
						[0, 0],
					],
				],
			}),
		).toBeNull();
	});
});

const missing = (binary: string) =>
	new DedaloError('tool.dependency_unavailable', {
		coordinates: { tool: 'tool_uca_maps', binary },
	});

describe('tool_uca_maps get_image_overlay — a failed georeference read', () => {
	test('GDAL missing leaves the image unplaced, flagged so the client says why', () => {
		expect(overlayFallbackOf(missing('gdalinfo'))).toEqual({
			corners: null,
			georeferenceUnavailable: true,
		});
	});

	// a .tif GDAL cannot open is a broken file, and the media root missing is
	// the same code as GDAL missing without being it
	test.each([
		['a file GDAL cannot open', new DedaloError('tool.action_failed', {})],
		['another binary missing', missing('ogr2ogr')],
		['the media root missing', new DedaloError('tool.dependency_unavailable', {})],
		['an error that is no DedaloError', new Error('boom')],
	])('%s is rethrown as is', (_, error) => {
		let thrown: unknown = null;
		try {
			overlayFallbackOf(error);
		} catch (caught) {
			thrown = caught;
		}
		expect(thrown).toBe(error);
	});
});

// the handler's own catch: what the answer says when the TIFF master cannot be read
describe('tool_uca_maps get_image_overlay — the handler on a planted TIFF master', () => {
	const SLOT = { section_tipo: 'test3', tipo: 'test99', section_id: 905105 };
	const FILES = [
		{ quality: 'original', extension: 'tif' },
		{ quality: 'default', extension: 'jpg' },
	] as const;

	/** The handler's answer (or refusal) with the georeference read throwing `error`. */
	async function overlayWhenReadThrows(error: unknown) {
		const read = spyOn(gdal, 'readGdalInfoJson').mockImplementation(async () => {
			throw error;
		});
		try {
			return await withImageFiles(SLOT, FILES, async (planted) => {
				const handler = (await loadAction('get_image_overlay')).handler;
				return { planted, outcome: await handler(contextOf(SLOT)).catch((thrown) => thrown) };
			});
		} finally {
			read.mockRestore();
		}
	}

	test('GDAL missing answers the served image unplaced, flagged unavailable', async () => {
		const { planted, outcome } = await overlayWhenReadThrows(missing('gdalinfo'));
		expect(dataOf<Record<string, unknown>>(outcome)).toEqual({
			file_path: planted[1],
			quality: expect.any(String),
			georeferenced: false,
			georeference_unavailable: true,
			corners: null,
		});
	});

	test('any other read failure is not swallowed into an unplaced image', async () => {
		const broken = new DedaloError('tool.action_failed', { message: 'gdalinfo: not a TIFF' });
		expect((await overlayWhenReadThrows(broken)).outcome).toBe(broken);
	});
});

describe.skipIf(!HAVE_GDAL)(
	'tool_uca_maps get_image_overlay — real gdalinfo read (needs GDAL)',
	() => {
		// `gdal_create` writes a raster from nothing (no source file, no MEM
		// driver dance), which is exactly what a georeference fixture needs: the
		// pixels are irrelevant here, only the CRS + corner coordinates are.
		async function createTiff(dir: string, name: string, argv: readonly string[]): Promise<string> {
			const path = join(dir, name);
			const proc = Bun.spawn([mustGet(Bun.which('gdal_create'), 'gdal_create'), ...argv, path], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(await proc.exited).toBe(0);
			return path;
		}

		test('a GeoTIFF in UTM 30N reports its footprint already reprojected to WGS84', async () => {
			const dir = mkdtempSync(join(tmpdir(), 'uca_maps_overlay_'));
			try {
				// A 1 km square anchored in UTM zone 30N (EPSG:25830) over Valencia.
				const path = await createTiff(dir, 'utm.tif', [
					'-outsize',
					'10',
					'10',
					'-a_srs',
					'EPSG:25830',
					'-a_ullr',
					'720000',
					'4380000',
					'721000',
					'4379000',
				]);

				const corners = mustGet(await readGeoreference(path), 'corners');

				// The whole point of asking the server: what comes back is DEGREES,
				// reprojected by GDAL/PROJ — the client never sees a UTM number and
				// no EPSG table exists anywhere in this tool.
				expect(corners.top_left[0]).toBeCloseTo(39.54, 1);
				expect(corners.top_left[1]).toBeCloseTo(-0.44, 1);
				// north-up in the source CRS: the top edge is north of the bottom-left
				// corner, and the right edge east of the left one
				expect(corners.top_left[0]).toBeGreaterThan(corners.bottom_left[0]);
				expect(corners.top_right[1]).toBeGreaterThan(corners.top_left[1]);
				// and the reason three points are stored instead of a bbox: a square
				// in UTM is NOT axis-aligned once reprojected — the two top corners
				// do not share a latitude
				expect(corners.top_left[0]).not.toBe(corners.top_right[0]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test('a TIFF with no CRS reports no footprint instead of guessing one', async () => {
			const dir = mkdtempSync(join(tmpdir(), 'uca_maps_overlay_'));
			try {
				const plain = await createTiff(dir, 'plain.tif', ['-outsize', '10', '10']);
				expect(await readGeoreference(plain)).toBeNull();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
