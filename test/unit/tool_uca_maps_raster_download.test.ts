/**
 * tool_uca_maps — `raster_download` (hito 3, checkpoint 3b).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    `get_capabilities`/`vector_download`;
 *  - caller-fault validation (unsupported format, missing image, missing/
 *    malformed/degenerate bounds) THROWS `request.invalid_options`
 *    unconditionally — no binary involved, runs even without GDAL/ImageMagick;
 *  - the real conversions: JPG/GIF/WebP gated on `identifyAvailable()`
 *    (`media/engine/binaries.ts` — ImageMagick's own install probe, reused
 *    rather than reinvented), GeoTIFF gated on `Bun.which('gdal_translate')`
 *    (same idiom as `tool_uca_maps_vector_download.test.ts`'s HAVE_GDAL);
 *  - the download NAME (audit row #10, H-04, 2026-09-22): the user's
 *    `file_name` is re-sanitized SERVER-SIDE whatever the client did with it,
 *    absent means the default, and a name that sanitizes to nothing is a
 *    refusal rather than a quiet rename;
 *  - the CRS decision (`raster_download.ts` file header): the GeoTIFF's
 *    `-a_srs EPSG:3857` corners are asserted to be the REAL Mercator meters
 *    passed in `bounds` (via `gdalinfo`'s reported corner coordinates), never
 *    v6's implicit degrees-as-meters assumption.
 */

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { identifyAvailable } from '../../src/core/media/engine/binaries.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type {
	GatedToolActionSpec,
	ToolActionContext,
	ToolResponse,
} from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';

const HAVE_MAGICK = identifyAvailable();
const HAVE_GDAL = Bun.which('gdal_translate') !== null;

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.raster_download, 'raster_download');
	return action as GatedToolActionSpec;
}

/** A real 4x4 red PNG (not 1x1 — GDAL's GTiff writer was measured to fail
 * silently on a 1x1 RGBA source during this hito's implementation; 4x4 is
 * the smallest verified-working fixture, not an arbitrary round number). */
const SAMPLE_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gkDCRIfnoMZcgAAAAtJREFUCNdjYIAAAAAIAAEvIN0xAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA5LTAzVDA5OjE4OjMxKzAwOjAw9NKM1gAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOS0wM1QwOToxODozMSswMDowMIWPNGoAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDktMDNUMDk6MTg6MzErMDA6MDDSmhW1AAAAAElFTkSuQmCC';

/** A real, non-degenerate Web Mercator meter bounding box (roughly Cádiz). */
const SAMPLE_BOUNDS = { west: -692000, north: 4322000, east: -690000, south: 4320000 };

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps raster_download — declared gate', () => {
	test('is record_tipo at read level (1), same criterion as vector_download', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps raster_download — caller-fault validation (no binary needed)', () => {
	test('an unsupported format is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(contextOf({ format: 'bmp', image_base64: SAMPLE_PNG_BASE64 })),
		).rejects.toThrow(/Unsupported raster format/);
	});

	test('missing image_base64 is refused', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({ format: 'jpg' }))).rejects.toThrow(
			/Missing image_base64/,
		);
	});

	test('geotiff without bounds is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(contextOf({ format: 'geotiff', image_base64: SAMPLE_PNG_BASE64 })),
		).rejects.toThrow(/Missing bounds/);
	});

	test('geotiff with a non-finite bound is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(
				contextOf({
					format: 'geotiff',
					image_base64: SAMPLE_PNG_BASE64,
					bounds: { west: 'nope', north: 1, east: 2, south: 0 },
				}),
			),
		).rejects.toThrow(/finite number/);
	});

	test('a non-string file_name is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(contextOf({ format: 'jpg', image_base64: SAMPLE_PNG_BASE64, file_name: 42 })),
		).rejects.toThrow(/file_name must be a string/);
	});

	test('a file_name with nothing usable in it is refused, never quietly renamed', async () => {
		const action = await loadAction();
		for (const file_name of ['', '   ', '/\\', '...']) {
			await expect(
				action.handler(contextOf({ format: 'jpg', image_base64: SAMPLE_PNG_BASE64, file_name })),
			).rejects.toThrow(/file_name has no usable characters/);
		}
	});

	test('geotiff with a degenerate box (west>=east) is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(
				contextOf({
					format: 'geotiff',
					image_base64: SAMPLE_PNG_BASE64,
					bounds: { west: 10, north: 5, east: 0, south: 0 },
				}),
			),
		).rejects.toThrow(/degenerate/);
	});
});

describe.if(HAVE_MAGICK)('tool_uca_maps raster_download — real ImageMagick conversion', () => {
	test('jpg: flattened onto white, envelope v2, no result mirror', async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({ format: 'jpg', image_base64: SAMPLE_PNG_BASE64 }),
		);

		expect(response.ok).toBe(true);
		expect('result' in response).toBe(false); // forbidden PHP-era mirror key

		const data = (response as { data: Record<string, unknown> }).data;
		expect(data.filename).toBe('uca_maps_map.jpg');
		expect(data.mime).toBe('image/jpeg');
		const bytes = Buffer.from(data.content_base64 as string, 'base64');
		expect(bytes.length).toBeGreaterThan(0);
		// JPEG magic bytes (SOI marker).
		expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
	});

	test("jpg: the user's own file_name is honoured, sanitized here and not trusted", async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({
				format: 'jpg',
				image_base64: SAMPLE_PNG_BASE64,
				// A traversal attempt AND a name the user could plausibly type.
				file_name: '../../Necrópolis de Cádiz',
			}),
		);

		expect(response.ok).toBe(true);
		const data = (response as { data: Record<string, unknown> }).data;
		// Separators gone, no basename reduction, extension appended once.
		expect(data.filename).toBe('Necrópolis de Cádiz.jpg');
	});

	test('jpg: a file_name that already carries the extension is not doubled', async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({ format: 'jpg', image_base64: SAMPLE_PNG_BASE64, file_name: 'mapa.jpg' }),
		);
		const data = (response as { data: Record<string, unknown> }).data;
		expect(data.filename).toBe('mapa.jpg');
	});

	test('gif and webp: real, non-empty conversions', async () => {
		const action = await loadAction();
		for (const [format, filename, mime] of [
			['gif', 'uca_maps_map.gif', 'image/gif'],
			['webp', 'uca_maps_map.webp', 'image/webp'],
		] as const) {
			const response: ToolResponse = await action.handler(
				contextOf({ format, image_base64: SAMPLE_PNG_BASE64 }),
			);
			expect(response.ok).toBe(true);
			const data = (response as { data: Record<string, unknown> }).data;
			expect(data.filename).toBe(filename);
			expect(data.mime).toBe(mime);
			expect(Buffer.from(data.content_base64 as string, 'base64').length).toBeGreaterThan(0);
		}
	});
});

describe.if(HAVE_GDAL)('tool_uca_maps raster_download — real GeoTIFF georeference', () => {
	test("geotiff: assigns the REAL EPSG:3857 corners sent in bounds, not v6's degrees-as-meters", async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({ format: 'geotiff', image_base64: SAMPLE_PNG_BASE64, bounds: SAMPLE_BOUNDS }),
		);

		expect(response.ok).toBe(true);
		const data = (response as { data: Record<string, unknown> }).data;
		expect(data.filename).toBe('uca_maps_map.tif');
		expect(data.mime).toBe('image/tiff');
		// The extension follows the FORMAT, not the format's menu name: a
		// geotiff is '.tif', whatever the user called the file.

		// Round-trip the produced GeoTIFF through `gdalinfo -json` and check the
		// corner coordinates are the SAME Mercator meters that were sent — the
		// end-to-end proof that -a_srs/-a_ullr actually landed, not just that
		// gdal_translate exited 0.
		const tmpFile = `/tmp/dedalo_uca_maps_test_${Date.now()}.tif`;
		await Bun.write(tmpFile, Buffer.from(data.content_base64 as string, 'base64'));
		try {
			const probe = await runBinary(['gdalinfo', '-json', tmpFile], { timeoutMs: 10_000 });
			expect(probe.ok).toBe(true);
			const info = JSON.parse(probe.stdout) as {
				cornerCoordinates: { upperLeft: number[]; lowerRight: number[] };
			};
			expect(info.cornerCoordinates.upperLeft[0]).toBeCloseTo(SAMPLE_BOUNDS.west, 0);
			expect(info.cornerCoordinates.upperLeft[1]).toBeCloseTo(SAMPLE_BOUNDS.north, 0);
			expect(info.cornerCoordinates.lowerRight[0]).toBeCloseTo(SAMPLE_BOUNDS.east, 0);
			expect(info.cornerCoordinates.lowerRight[1]).toBeCloseTo(SAMPLE_BOUNDS.south, 0);
		} finally {
			rmSync(tmpFile, { force: true });
		}
	});

	test("geotiff: a named file still gets '.tif', the format's extension, not 'geotiff'", async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({
				format: 'geotiff',
				image_base64: SAMPLE_PNG_BASE64,
				bounds: SAMPLE_BOUNDS,
				file_name: 'mapa',
			}),
		);
		const data = (response as { data: Record<string, unknown> }).data;
		expect(data.filename).toBe('mapa.tif');
	});
});
