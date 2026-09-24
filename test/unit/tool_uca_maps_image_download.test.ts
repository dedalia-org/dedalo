/**
 * tool_uca_maps — `image_download` ("Descargar Imagen" of an uploaded image).
 *
 * Pins the declared gate, the caller-fault refusals (all before any database
 * or file access), and — gated on GDAL — the real warp: the output is the
 * image in its CURRENT shape, in EPSG:3857, `width` pixels wide, transparent
 * (or white, for jpg) outside a rotated shape, and never carrying opacity.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	type ImageCorners,
	MAX_IMAGE_DOWNLOAD_SIDE,
	outputSize,
	pickDownloadSource,
	renderImageDownload,
} from '../../tools/tool_uca_maps/server/image_download.ts';
import { mustGet } from '../helpers/assert.ts';

const HAVE_GDAL = [
	'gdalinfo',
	'gdal_create',
	'gdal_translate',
	'gdalwarp',
	'gdallocationinfo',
].every((name) => Bun.which(name) !== null);

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	return mustGet(loaded?.module.apiActions.image_download, 'image_download') as GatedToolActionSpec;
}

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: 1, isGlobalAdmin: true, isDeveloper: true },
		userId: 1,
		options,
		background: false,
	};
}

/** A square rotated ~45°: its bounding box is far larger than the picture, so
 * the corners of the output must fall OUTSIDE the image. */
const ROTATED: ImageCorners = {
	top_left: [39.48, -0.4],
	top_right: [39.49, -0.39],
	bottom_left: [39.47, -0.39],
};

const VALID = {
	corners: ROTATED,
	format: 'png',
	width: 200,
	file_name: 'plan',
};

describe('tool_uca_maps image_download — declared gate', () => {
	test('is record_tipo at read level (1), on the IMAGE record named in the options', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps image_download — caller faults, refused before any lookup', () => {
	const cases: Array<[string, Record<string, unknown>]> = [
		['an unknown format', { format: 'gif' }],
		['no corners', { corners: undefined }],
		['a corner that is not a pair', { corners: { ...ROTATED, top_left: [39.48] } }],
		['a NaN coordinate', { corners: { ...ROTATED, top_right: [Number.NaN, -0.39] } }],
		['a latitude Web Mercator cannot draw', { corners: { ...ROTATED, bottom_left: [86, -0.39] } }],
		[
			'collinear corners',
			{
				corners: {
					top_left: [39.48, -0.4],
					top_right: [39.48, -0.39],
					bottom_left: [39.48, -0.41],
				},
			},
		],
		[
			'coincident corners',
			{
				corners: { top_left: [39.48, -0.4], top_right: [39.48, -0.4], bottom_left: [39.48, -0.4] },
			},
		],
		['a zero width', { width: 0 }],
		['a fractional width', { width: 10.5 }],
		['a name that sanitizes to nothing', { file_name: '///' }],
	];
	for (const [label, override] of cases) {
		test(`refuses ${label}`, async () => {
			const action = await loadAction();
			await expect(action.handler(contextOf({ ...VALID, ...override }))).rejects.toMatchObject({
				code: 'request.invalid_options',
			});
		});
	}
});

describe('tool_uca_maps image_download — pickDownloadSource: the file the map shows, only', () => {
	const entry = (quality: string, file_path: string, extension: string, file_exist = true) => ({
		quality,
		file_exist,
		file_name: file_path.split('/').pop() ?? null,
		file_path,
		file_size: 1,
		file_time: null,
		extension,
	});
	const FILES = [
		entry('original', '/image/original/0/x_1.jpg', 'jpg'),
		entry('original', '/image/original/0/x_1.tif', 'tif'),
		entry('1.5MB', '/image/1.5MB/0/x_1.jpg', 'jpg'),
		entry('thumb', '/image/thumb/0/x_1.jpg', 'jpg'),
		entry('6MB', '/image/6MB/0/x_1.jpg', 'jpg', false),
	];
	const MASTERS = ['original', 'modified'];
	const SERVED = { file_path: '/image/1.5MB/0/x_1.jpg' };

	test('the tier the descriptor names is the one picked', () => {
		expect(pickDownloadSource(FILES, MASTERS, '/image/thumb/0/x_1.jpg', SERVED)?.quality).toBe(
			'thumb',
		);
	});
	test('no name (an older descriptor) takes the served tier', () => {
		expect(pickDownloadSource(FILES, MASTERS, undefined, SERVED)?.quality).toBe('1.5MB');
	});
	test('a named file that is gone is null — a refusal, never a swap to another picture', () => {
		expect(pickDownloadSource(FILES, MASTERS, '/image/6MB/0/x_1.jpg', SERVED)).toBeNull();
	});
	test('the master is never picked, even when named and drawable', () => {
		expect(pickDownloadSource(FILES, MASTERS, '/image/original/0/x_1.jpg', SERVED)).toBeNull();
		expect(pickDownloadSource(FILES, MASTERS, '/image/original/0/x_1.tif', SERVED)).toBeNull();
	});
	test("a path outside the record's own list is never returned", () => {
		expect(pickDownloadSource(FILES, MASTERS, '../../../etc/passwd', SERVED)).toBeNull();
	});
});

describe('tool_uca_maps image_download — outputSize bounds BOTH sides', () => {
	test('keeps the width asked and gives the height the shape has', () => {
		const size = outputSize(ROTATED, 300);
		expect(size.width).toBe(300);
		// the diamond spans as much latitude as longitude: roughly square in 3857
		expect(Math.abs(size.height - 300 * 1.29)).toBeLessThan(10);
	});

	test('a tall, thin shape cannot turn a legal width into a gigantic raster', () => {
		const thin: ImageCorners = {
			top_left: [40, -3],
			top_right: [40, -2.99999],
			bottom_left: [30, -3],
		};
		const size = outputSize(thin, 8000);
		expect(size.height).toBe(MAX_IMAGE_DOWNLOAD_SIDE);
		expect(size.width).toBeGreaterThanOrEqual(1);
	});

	test('a width past the ceiling is scaled down, not refused', () => {
		const size = outputSize(ROTATED, MAX_IMAGE_DOWNLOAD_SIDE * 3);
		expect(Math.max(size.width, size.height)).toBe(MAX_IMAGE_DOWNLOAD_SIDE);
	});
});

describe.if(HAVE_GDAL)('tool_uca_maps image_download — the real warp', () => {
	async function run(argv: string[]): Promise<string> {
		const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code).toBe(0);
		return stdout;
	}

	async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = mkdtempSync(join(tmpdir(), 'uca_maps_image_download_'));
		try {
			return await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	async function master(
		dir: string,
		extra: string[] = ['-bands', '3', '-burn', '200', '-burn', '30', '-burn', '30'],
	) {
		const path = join(mkdtempSync(join(dir, 'master_')), 'master.tif');
		await run([
			mustGet(Bun.which('gdal_create'), 'gdal_create'),
			'-outsize',
			'64',
			'32',
			...extra,
			path,
		]);
		return path;
	}

	async function render(
		dir: string,
		source: string,
		format: string,
		corners = ROTATED,
		width = 120,
	) {
		// a fresh scratch dir per render, as `withScratchDir` gives each request
		const work = mkdtempSync(join(dir, 'work_'));
		const result = await renderImageDownload(work, source, corners, format, width);
		const out = join(work, `out.${result.extension}`);
		await Bun.write(out, Buffer.from(result.content, 'base64'));
		const info = JSON.parse(await run([mustGet(Bun.which('gdalinfo'), 'gdalinfo'), '-json', out]));
		return { out, info, result };
	}

	async function pixel(path: string, band: number, x: number, y: number): Promise<number> {
		const value = await run([
			mustGet(Bun.which('gdallocationinfo'), 'gdallocationinfo'),
			'-valonly',
			'-b',
			String(band),
			path,
			String(x),
			String(y),
		]);
		return Number(value.trim());
	}

	test('GeoTIFF: width as asked, in EPSG:3857, transparent outside the rotated shape, opaque inside', async () => {
		await withDir(async (dir) => {
			const { out, info } = await render(dir, await master(dir), 'geotiff');
			expect(info.size[0]).toBe(120);
			expect(JSON.stringify(info.coordinateSystem)).toContain('3857');
			expect(
				info.bands.map((band: { colorInterpretation: string }) => band.colorInterpretation),
			).toEqual(['Red', 'Green', 'Blue', 'Alpha']);
			expect(await pixel(out, 4, 0, 0)).toBe(0);
			expect(await pixel(out, 4, 60, Math.floor(info.size[1] / 2))).toBe(255);
			// the picture's colour, not its opacity: the red channel comes through whole
			expect(await pixel(out, 1, 60, Math.floor(info.size[1] / 2))).toBe(200);
		});
	});

	test('the GeoTIFF extent is the footprint of the CURRENT shape, from its corners', async () => {
		await withDir(async (dir) => {
			const { info } = await render(dir, await master(dir), 'geotiff');
			// lon of the left-most corner (top_left / bottom_right mirror) in Web Mercator
			const x = (lon: number) => (lon * 20037508.342789244) / 180;
			const west = info.cornerCoordinates.upperLeft[0];
			const east = info.cornerCoordinates.lowerRight[0];
			const pixelSize = (east - west) / info.size[0];
			expect(Math.abs(west - x(-0.4))).toBeLessThan(pixelSize * 1.5);
			expect(Math.abs(east - x(-0.38))).toBeLessThan(pixelSize * 1.5);
		});
	});

	test('png keeps the transparency; jpg paints the outside white and has three bands', async () => {
		await withDir(async (dir) => {
			const source = await master(dir);
			const png = await render(dir, source, 'png');
			expect(png.result.extension).toBe('png');
			expect(png.info.bands.length).toBe(4);
			expect(await pixel(png.out, 4, 0, 0)).toBe(0);

			const jpg = await render(dir, source, 'jpg');
			expect(jpg.result.extension).toBe('jpg');
			expect(jpg.info.bands.length).toBe(3);
			expect(await pixel(jpg.out, 1, 0, 0)).toBeGreaterThan(245);
		});
	});

	test('an RGBA master and a 16-bit master still give a valid jpg', async () => {
		await withDir(async (dir) => {
			const rgba = await master(dir, [
				'-bands',
				'4',
				'-burn',
				'10',
				'-burn',
				'200',
				'-burn',
				'10',
				'-burn',
				'255',
			]);
			expect((await render(dir, rgba, 'jpg')).info.bands.length).toBe(3);

			const deep = await master(dir, [
				'-bands',
				'3',
				'-ot',
				'UInt16',
				'-burn',
				'60000',
				'-burn',
				'100',
				'-burn',
				'100',
			]);
			const jpg = await render(dir, deep, 'jpg');
			expect(jpg.info.bands[0].type).toBe('Byte');
			expect(await pixel(jpg.out, 1, 60, Math.floor(jpg.info.size[1] / 2))).toBeGreaterThan(200);
		});
	});
});
