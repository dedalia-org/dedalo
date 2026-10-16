/**
 * tool_uca_maps — `raster_download`: the map image as jpg/gif/webp
 * (ImageMagick) or GeoTIFF (GDAL). The caller faults are refused before any
 * binary; the GeoTIFF's corners are the EPSG:3857 metres sent in `bounds`,
 * never v6's degrees read as metres.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { converterAdmission } from '../../src/core/media/engine/admission.ts';
import { identifyAvailable } from '../../src/core/media/engine/binaries.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { resolveMagickBinary, withScratchDir } from '../../tools/tool_uca_maps/server/gdal.ts';
import {
	contextOf,
	dataOf,
	expectCode,
	failureOf,
	haveGdal,
	loadAction,
} from './fixtures/tool_uca_maps/helpers.ts';

const HAVE_MAGICK = identifyAvailable();
const HAVE_GDAL = haveGdal('gdal_translate');

/** A real 4x4 red PNG: GDAL's GTiff writer was measured to fail silently on a
 * 1x1 RGBA source, and 4x4 is the smallest that works. */
const SAMPLE_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gkDCRIfnoMZcgAAAAtJREFUCNdjYIAAAAAIAAEvIN0xAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA5LTAzVDA5OjE4OjMxKzAwOjAw9NKM1gAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOS0wM1QwOToxODozMSswMDowMIWPNGoAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDktMDNUMDk6MTg6MzErMDA6MDDSmhW1AAAAAElFTkSuQmCC';

/** A 16x16 red PNG whose top-left 8x8 block is transparent black: a jpg not
 * flattened onto white shows the black. */
const TRANSPARENT_CORNER_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVQ4y2NkIAD+MzD8xyfPRMgAQmDUgMFgACOheB78Xhg1gAoGAAAd1gQbP24IDAAAAABJRU5ErkJggg==';

/** A real, non-degenerate Web Mercator meter bounding box (roughly Cádiz). */
const SAMPLE_BOUNDS = { west: -692000, north: 4322000, east: -690000, south: 4320000 };

describe('tool_uca_maps raster_download — caller-fault validation (no binary needed)', () => {
	test('an unsupported format is refused', async () => {
		const action = await loadAction('raster_download');
		await expect(
			action.handler(contextOf({ format: 'bmp', image_base64: SAMPLE_PNG_BASE64 })),
		).rejects.toThrow(/Unsupported raster format/);
	});

	test('missing image_base64 is refused', async () => {
		const action = await loadAction('raster_download');
		await expect(action.handler(contextOf({ format: 'jpg' }))).rejects.toThrow(
			/Missing image_base64/,
		);
	});

	test('geotiff without bounds is refused', async () => {
		const action = await loadAction('raster_download');
		await expect(
			action.handler(contextOf({ format: 'geotiff', image_base64: SAMPLE_PNG_BASE64 })),
		).rejects.toThrow(/Missing bounds/);
	});

	test.each([
		['a string', 'nope'],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
		['NaN', Number.NaN],
		['null', null],
		['absent', undefined],
	])('geotiff with a west bound that is %s is refused', async (_, west) => {
		const action = await loadAction('raster_download');
		const error = await failureOf(
			action.handler(
				contextOf({
					format: 'geotiff',
					image_base64: SAMPLE_PNG_BASE64,
					bounds: { ...(west === undefined ? {} : { west }), north: 1, east: 2, south: 0 },
				}),
			),
		);
		expectCode(error, 'request.invalid_options');
		expect(error.message).toBe('bounds.west must be a finite number');
	});

	test('a non-string file_name is refused', async () => {
		const action = await loadAction('raster_download');
		await expect(
			action.handler(contextOf({ format: 'jpg', image_base64: SAMPLE_PNG_BASE64, file_name: 42 })),
		).rejects.toThrow(/file_name must be a string/);
	});

	test('a file_name with nothing usable in it is refused, never quietly renamed', async () => {
		const action = await loadAction('raster_download');
		for (const file_name of ['', '   ', '/\\', '...']) {
			await expect(
				action.handler(contextOf({ format: 'jpg', image_base64: SAMPLE_PNG_BASE64, file_name })),
			).rejects.toThrow(/file_name has no usable characters/);
		}
	});

	test.each([
		['west>=east', { west: 10, north: 5, east: 0, south: 0 }],
		['south>=north', { west: 0, north: 5, east: 10, south: 5 }],
	])('geotiff with a degenerate box (%s) is refused', async (_, bounds) => {
		const action = await loadAction('raster_download');
		await expect(
			action.handler(contextOf({ format: 'geotiff', image_base64: SAMPLE_PNG_BASE64, bounds })),
		).rejects.toThrow(/degenerate/);
	});
});

describe.skipIf(!HAVE_MAGICK)(
	'tool_uca_maps raster_download — real ImageMagick conversion (needs ImageMagick)',
	() => {
		test('jpg: flattened onto white, envelope v2, no result mirror', async () => {
			const action = await loadAction('raster_download');
			const response: ToolResponse = await action.handler(
				contextOf({ format: 'jpg', image_base64: TRANSPARENT_CORNER_PNG_BASE64 }),
			);

			const data = dataOf(response);
			expect('result' in response).toBe(false); // forbidden PHP-era mirror key

			expect(data.filename).toBe('map.jpg');
			expect(data.mime).toBe('image/jpeg');
			const bytes = Buffer.from(data.content_base64 as string, 'base64');
			// JPEG magic bytes (SOI marker).
			expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');

			const corner = await withScratchDir(async (dir) => {
				const jpg = join(dir, 'map.jpg');
				await Bun.write(jpg, bytes);
				const channel = (c: string) => `%[fx:int(255*p{0,0}.${c})]`;
				const read = await runBinary(
					[resolveMagickBinary(), jpg, '-format', ['r', 'g', 'b'].map(channel).join(' '), 'info:'],
					{ timeoutMs: 10_000 },
				);
				expect(read.ok).toBe(true);
				return read.stdout.trim().split(' ').map(Number);
			});
			expect(corner).toHaveLength(3);
			for (const value of corner) expect(value).toBeGreaterThan(245);
		});

		test("jpg: the user's own file_name is honoured, sanitized here and not trusted", async () => {
			const action = await loadAction('raster_download');
			const response: ToolResponse = await action.handler(
				contextOf({
					format: 'jpg',
					image_base64: SAMPLE_PNG_BASE64,
					// A traversal attempt AND a name the user could plausibly type.
					file_name: '../../Necrópolis de Cádiz',
				}),
			);

			const data = dataOf(response);
			// Separators gone, no basename reduction, extension appended once.
			expect(data.filename).toBe('Necrópolis de Cádiz.jpg');
		});

		test('gif and webp: real conversions, each in its own format', async () => {
			const action = await loadAction('raster_download');
			for (const [format, filename, mime, magic] of [
				['gif', 'map.gif', 'image/gif', [[0, 'GIF8']]],
				[
					'webp',
					'map.webp',
					'image/webp',
					[
						[0, 'RIFF'],
						[8, 'WEBP'],
					],
				],
			] as const) {
				const response: ToolResponse = await action.handler(
					contextOf({ format, image_base64: SAMPLE_PNG_BASE64 }),
				);
				const data = dataOf(response);
				expect(data.filename).toBe(filename);
				expect(data.mime).toBe(mime);
				const bytes = Buffer.from(data.content_base64 as string, 'base64');
				for (const [offset, text] of magic) {
					expect(bytes.subarray(offset, offset + 4).toString('latin1')).toBe(text);
				}
			}
		});
	},
);

/** A GIF89a of `frames` 1x1 scenes, built by hand. The image bytes come from
 * the client and ImageMagick sniffs them, so a "screenshot" may be any
 * sequence; a sequence is what `-limit list-length` bounds. */
function gifOfFrames(frames: number): string {
	const header = [
		0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff,
	];
	const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
	const bytes: number[] = [...header];
	for (let i = 0; i < frames; i++) bytes.push(...frame);
	bytes.push(0x3b);
	return Buffer.from(bytes).toString('base64');
}

describe.skipIf(!HAVE_MAGICK)(
	'tool_uca_maps raster_download — the install operating limits (needs ImageMagick)',
	() => {
		// The policy's ceiling lets far more scenes through than the operating
		// default: only the spliced `-limit` argv can refuse in that gap.
		const listLength = config.media.magickLimits.listLength;
		const policy = readFileSync(
			new URL('../../src/core/media/engine/imagemagick-policy/policy.xml', import.meta.url),
			'utf8',
		);
		const ceiling = Number(/name="list-length" value="(\d+)"/.exec(policy)?.[1]);

		// four ImageMagick runs over thousands of frames: ~5 s alone, at bun's default
		// timeout, so it failed by load, not by behaviour
		test('a sequence over the list-length limit is refused in every format, one well under it converts', async () => {
			expect(listLength + 1).toBeLessThan(ceiling);
			const action = await loadAction('raster_download');

			const under = await action.handler(
				contextOf({ format: 'gif', image_base64: gifOfFrames(Math.floor(listLength / 2)) }),
			);
			expect(under.ok).toBe(true);

			const over = gifOfFrames(listLength + 1);
			for (const format of ['jpg', 'gif', 'webp']) {
				await expect(
					action.handler(contextOf({ format, image_base64: over })),
				).rejects.toMatchObject({
					code: 'tool.action_failed',
					message: expect.stringMatching(/list length exceeds limit/i),
				});
			}
		}, 30_000);

		test('the conversion waits for a converter permit like every engine spawn', async () => {
			const admission = converterAdmission();
			const action = await loadAction('raster_download');
			// hold every permit, so the export can only queue behind them
			let release = (): void => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const holders = Array.from({ length: admission.concurrency }, () =>
				admission.run('test_hold', () => gate),
			);
			try {
				const exported = action.handler(
					contextOf({ format: 'gif', image_base64: SAMPLE_PNG_BASE64 }),
				);
				const deadline = performance.now() + 2000;
				while (admission.queued === 0 && performance.now() < deadline) {
					await Bun.sleep(10);
				}
				expect(admission.queued).toBe(1);

				release();
				expect((await exported).ok).toBe(true);
			} finally {
				release();
				await Promise.all(holders);
			}
		});
	},
);

describe.skipIf(!HAVE_GDAL)(
	'tool_uca_maps raster_download — real GeoTIFF georeference (needs gdal_translate)',
	() => {
		test("geotiff: assigns the REAL EPSG:3857 corners sent in bounds, not v6's degrees-as-meters", async () => {
			const action = await loadAction('raster_download');
			const response: ToolResponse = await action.handler(
				contextOf({
					format: 'geotiff',
					image_base64: SAMPLE_PNG_BASE64,
					bounds: SAMPLE_BOUNDS,
					file_name: 'mapa',
				}),
			);

			const data = dataOf(response);
			// the extension is the format's, not its menu name: '.tif', never '.geotiff'
			expect(data.filename).toBe('mapa.tif');
			expect(data.mime).toBe('image/tiff');

			// read back: the SRS and the corners are what was sent, not merely an exit 0
			const info = await withScratchDir(async (dir) => {
				const tif = join(dir, 'map.tif');
				await Bun.write(tif, Buffer.from(data.content_base64 as string, 'base64'));
				const probe = await runBinary(['gdalinfo', '-json', tif], { timeoutMs: 10_000 });
				expect(probe.ok).toBe(true);
				return JSON.parse(probe.stdout) as {
					coordinateSystem: { wkt: string };
					cornerCoordinates: { upperLeft: number[]; lowerRight: number[] };
				};
			});
			expect(info.coordinateSystem.wkt).toMatch(/ID\["EPSG",3857\]\]$/);
			expect(info.cornerCoordinates.upperLeft[0]).toBeCloseTo(SAMPLE_BOUNDS.west, 0);
			expect(info.cornerCoordinates.upperLeft[1]).toBeCloseTo(SAMPLE_BOUNDS.north, 0);
			expect(info.cornerCoordinates.lowerRight[0]).toBeCloseTo(SAMPLE_BOUNDS.east, 0);
			expect(info.cornerCoordinates.lowerRight[1]).toBeCloseTo(SAMPLE_BOUNDS.south, 0);
		});
	},
);
