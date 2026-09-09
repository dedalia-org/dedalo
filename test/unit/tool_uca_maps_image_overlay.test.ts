/**
 * tool_uca_maps — `get_image_overlay` (fila #11, "Upload file to map", IMAGE
 * half — hito 13).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    every other read-shaped action in this tool. It is worth pinning here
 *    for a reason the others do not have: this action's options carry the
 *    IMAGE record's identity, not the map's, so the gate it declares is what
 *    decides whether a caller may learn a media path of a section they may
 *    not read;
 *  - caller-fault validation (missing/absurd identity) throws
 *    `request.invalid_source` before any database or filesystem access —
 *    which is what lets this half of the file run with neither DB nor GDAL;
 *  - the wgs84Extent → three-corner mapping, which is the one piece of real
 *    logic in the module: GDAL's ring order (upperLeft, lowerLeft, lowerRight,
 *    upperRight) is NOT the order `L.imageOverlay.rotated` takes (top-left,
 *    top-right, bottom-left), and getting it wrong mirrors every uploaded
 *    raster without failing anything;
 *  - the REAL `gdalinfo` read, GATED on `Bun.which('gdalinfo')` (same idiom as
 *    the vector half's HAVE_GDAL): a GeoTIFF written in UTM 30N reports its
 *    footprint reprojected to WGS84 — i.e. the reprojection this tool relies
 *    on happens in GDAL and no EPSG table is needed anywhere — and a TIFF
 *    with NO CRS reports none instead of guessing.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	cornersFromWgs84Extent,
	readGeoreference,
} from '../../tools/tool_uca_maps/server/image_overlay.ts';
import { mustGet } from '../helpers/assert.ts';

const HAVE_GDAL = Bun.which('gdalinfo') !== null && Bun.which('gdal_create') !== null;

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.get_image_overlay, 'get_image_overlay');
	return action as GatedToolActionSpec;
}

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: 1, isGlobalAdmin: true, isDeveloper: true },
		userId: 1,
		options,
		background: false,
	};
}

describe('tool_uca_maps get_image_overlay — declared gate', () => {
	test('is record_tipo at read level (1), on the IMAGE record named in the options', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps get_image_overlay — caller-fault validation (no DB/GDAL needed)', () => {
	test('a missing section_id is refused before any database access', async () => {
		const action = await loadAction();
		expect(action.handler(contextOf({ tipo: 'rsc29', section_tipo: 'rsc170' }))).rejects.toThrow(
			/tipo, section_tipo and a positive section_id/,
		);
	});

	test('a section_id of 0 is refused (a record id is always positive)', async () => {
		const action = await loadAction();
		expect(
			action.handler(contextOf({ tipo: 'rsc29', section_tipo: 'rsc170', section_id: 0 })),
		).rejects.toThrow(/positive section_id/);
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

describe.if(HAVE_GDAL)('tool_uca_maps get_image_overlay — real gdalinfo read', () => {
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
});
