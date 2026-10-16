/**
 * tool_uca_maps — `image_download` ("Descargar Imagen" of an uploaded image).
 *
 * Pins the caller-fault refusals (all before any database or file access),
 * and — gated on GDAL — the real warp: the output is the image in its CURRENT
 * shape, in EPSG:3857, `width` pixels wide, transparent (or white, for jpg)
 * outside a rotated shape, and never carrying opacity.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import {
	type ImageCorners,
	isCmykSource,
	MAX_IMAGE_DOWNLOAD_SIDE,
	outputSize,
	pickDownloadSource,
	renderImageDownload,
} from '../../tools/tool_uca_maps/server/image_download.ts';
import { mustGet } from '../helpers/assert.ts';
import { haveGdal, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

const HAVE_GDAL = haveGdal(
	'gdalinfo',
	'gdal_create',
	'gdal_translate',
	'gdalwarp',
	'gdallocationinfo',
);

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

describe('tool_uca_maps image_download — caller faults, refused before any lookup', () => {
	const cases: Array<[string, Record<string, unknown>]> = [
		['an unknown format', { format: 'gif' }],
		['no corners', { corners: undefined }],
		['a corner that is not a pair', { corners: { ...ROTATED, top_left: [39.48] } }],
		['a NaN coordinate', { corners: { ...ROTATED, top_right: [Number.NaN, -0.39] } }],
		['a latitude Web Mercator cannot draw', { corners: { ...ROTATED, bottom_left: [86, -0.39] } }],
		['a longitude past 180', { corners: { ...ROTATED, top_right: [39.49, 181] } }],
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
			const action = await loadAction('image_download');
			await expect(action.handler(contextOf({ ...VALID, ...override }))).rejects.toMatchObject({
				code: 'request.invalid_options',
			});
		});
	}

	// a key every object inherits is no format: the format table is read by own keys only
	test.each(['toString', 'constructor', '__proto__'])(
		"refuses the inherited key '%s' as a format",
		async (format) => {
			const action = await loadAction('image_download');
			await expect(action.handler(contextOf({ ...VALID, format }))).rejects.toMatchObject({
				code: 'request.invalid_options',
				message: expect.stringMatching(/^Unsupported image format/),
			});
		},
	);
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
	// null is a refusal, never a swap to another picture
	test.each([
		['a named file that is gone', '/image/6MB/0/x_1.jpg'],
		['the master, named and drawable', '/image/original/0/x_1.jpg'],
		['the master, named as its tif', '/image/original/0/x_1.tif'],
		["a path outside the record's own list", '../../../etc/passwd'],
	])('%s is never picked', (_, named) => {
		expect(pickDownloadSource(FILES, MASTERS, named, SERVED)).toBeNull();
	});
});

describe('tool_uca_maps image_download — outputSize bounds BOTH sides', () => {
	test('keeps the width asked and gives the height the shape has', () => {
		const size = outputSize(ROTATED, 300);
		expect(size.width).toBe(300);
		// the box spans as many degrees of latitude as of longitude, and in 3857
		// a degree of latitude here is 1/cos(lat) times longer
		expect(Math.abs(size.height - 300 / Math.cos((39.48 * Math.PI) / 180))).toBeLessThan(2);
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

describe('tool_uca_maps image_download — isCmykSource: only the source colour space says CMYK', () => {
	const info = (space: unknown) => ({
		metadata: { IMAGE_STRUCTURE: { SOURCE_COLOR_SPACE: space } },
	});

	test.each([
		['CMYK', info('CMYK'), true],
		["YCbCrK (Adobe's CMYK)", info('YCbCrK'), true],
		['YCbCr (an ordinary JPEG)', info('YCbCr'), false],
		['no colour space at all', { metadata: { IMAGE_STRUCTURE: {} } }, false],
		['no metadata', {}, false],
		['a colour space that is not a string', info(['CMYK']), false],
	])('%s', (_, gdalinfo, cmyk) => {
		expect(isCmykSource(gdalinfo)).toBe(cmyk);
	});
});

/** An 8x8 Adobe CMYK JPEG (YCCK, as image editors write it), from
 * `magick -size 8x8 xc:#c81e1e -colorspace CMYK -strip -quality 50`. */
const YCCK_JPEG_BASE64 =
	'/9j/7gAOQWRvYmUAZAAAAAAC/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAFAgACAAIBAEiAAIRAQMRAQQiAP/EABYAAQEBAAAAAAAAAAAAAAAAAAAEBv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAOBAEAAhEDEQQAAD8AsAIoxpAH/9k=';

describe.skipIf(!HAVE_GDAL)('tool_uca_maps image_download — the real warp (needs GDAL)', () => {
	async function run(argv: string[]): Promise<string> {
		// the env spread, as `spawn.ts` does: Bun.spawn's default misses a runtime change
		const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
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
			// the box of the four corners (the fourth mirrors top_left) in Web Mercator
			const x = (lon: number) => (lon * 20037508.342789244) / 180;
			const y = (lat: number) => 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
			const [west, north] = info.cornerCoordinates.upperLeft;
			const [east, south] = info.cornerCoordinates.lowerRight;
			const pixelWidth = (east - west) / info.size[0];
			const pixelHeight = (north - south) / info.size[1];
			expect(Math.abs(west - x(-0.4))).toBeLessThan(pixelWidth * 1.5);
			expect(Math.abs(east - x(-0.38))).toBeLessThan(pixelWidth * 1.5);
			expect(Math.abs(north - y(39.49))).toBeLessThan(pixelHeight * 1.5);
			expect(Math.abs(south - y(39.47))).toBeLessThan(pixelHeight * 1.5);
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

	test("png is written at zlib's fastest level: a large one stays inside the client's wait", async () => {
		await withDir(async (dir) => {
			const { out } = await render(dir, await master(dir), 'png');
			const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
			// the first IDAT chunk's data opens with the zlib header; FLEVEL (the
			// top two bits of its second byte) is 0 for level 1, 2 for GDAL's default 6
			let offset = 8;
			while (offset + 8 < bytes.length) {
				const length = new DataView(bytes.buffer).getUint32(offset);
				const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
				if (type === 'IDAT') break;
				offset += 12 + length;
			}
			expect(new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))).toBe('IDAT');
			const flg = bytes[offset + 9] ?? 0xff;
			expect(flg >> 6).toBe(0);
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

	/** The served file is a JPEG, never a TIFF: a 4-band source is written as
	 * plain CMYK, a 3-band one as ordinary YCbCr. */
	async function jpegOf(dir: string, source: string): Promise<string> {
		const path = join(mkdtempSync(join(dir, 'served_')), 'served.jpg');
		await run([
			mustGet(Bun.which('gdal_translate'), 'gdal_translate'),
			'-q',
			'-of',
			'JPEG',
			source,
			path,
		]);
		return path;
	}

	/** What GDAL reports for a file: the band names and the source colour space. */
	async function colourOf(path: string) {
		const info = JSON.parse(await run([mustGet(Bun.which('gdalinfo'), 'gdalinfo'), '-json', path]));
		return {
			bands: info.bands.map((band: { colorInterpretation: string }) => band.colorInterpretation),
			space: info.metadata?.IMAGE_STRUCTURE?.SOURCE_COLOR_SPACE,
		};
	}

	async function expectCmykRefusal(dir: string, source: string) {
		const refusal = await renderImageDownload(
			mkdtempSync(join(dir, 'work_')),
			source,
			ROTATED,
			'png',
			120,
		).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refusal).toMatchObject({ code: 'tool.unsupported_target' });
		expect(toErrorBody(refusal as Parameters<typeof toErrorBody>[0]).message).toBe(
			'This image is stored in CMYK, which cannot be downloaded from the map.',
		);
	}

	const CMYK_BANDS = ['-bands', '4', '-burn', '10', '-burn', '20', '-burn', '30', '-burn', '40'];

	test('a CMYK JPEG is refused with its reason on the wire, though GDAL hands it over as RGB', async () => {
		await withDir(async (dir) => {
			const cmyk = await jpegOf(dir, await master(dir, CMYK_BANDS));
			// the bands never say CMYK: only the source colour space does
			expect(await colourOf(cmyk)).toEqual({ bands: ['Red', 'Green', 'Blue'], space: 'CMYK' });
			await expectCmykRefusal(dir, cmyk);
		});
	});

	// every spawn inherits the server's env: there, GDAL_JPEG_TO_RGB=NO would hand
	// the C/M/Y bands over as R/G/B with no SOURCE_COLOR_SPACE to refuse on
	test('a CMYK JPEG is refused even where the server environment says GDAL_JPEG_TO_RGB=NO', async () => {
		const previous = process.env.GDAL_JPEG_TO_RGB;
		process.env.GDAL_JPEG_TO_RGB = 'NO';
		try {
			await withDir(async (dir) => {
				const cmyk = await jpegOf(dir, await master(dir, CMYK_BANDS));
				expect(await colourOf(cmyk)).toEqual({
					bands: ['Cyan', 'Magenta', 'Yellow', 'Black'],
					space: undefined,
				});
				await expectCmykRefusal(dir, cmyk);
			});
		} finally {
			if (previous === undefined) delete process.env.GDAL_JPEG_TO_RGB;
			else process.env.GDAL_JPEG_TO_RGB = previous;
		}
	});

	test('an Adobe CMYK JPEG (YCCK, as image editors write it) is refused too', async () => {
		await withDir(async (dir) => {
			const ycck = join(mkdtempSync(join(dir, 'served_')), 'served.jpg');
			await Bun.write(ycck, Buffer.from(YCCK_JPEG_BASE64, 'base64'));
			expect(await colourOf(ycck)).toEqual({ bands: ['Red', 'Green', 'Blue'], space: 'YCbCrK' });
			await expectCmykRefusal(dir, ycck);
		});
	});

	test('an ordinary RGB JPEG is not mistaken for CMYK: it downloads with its colour', async () => {
		await withDir(async (dir) => {
			const rgb = await jpegOf(dir, await master(dir));
			expect(await colourOf(rgb)).toEqual({ bands: ['Red', 'Green', 'Blue'], space: 'YCbCr' });
			const { out, info } = await render(dir, rgb, 'png');
			const middle = Math.floor(info.size[1] / 2);
			expect(await pixel(out, 4, 60, middle)).toBe(255);
			expect(Math.abs((await pixel(out, 1, 60, middle)) - 200)).toBeLessThanOrEqual(3);
		});
	});
});
