/**
 * image_download — "Descargar Imagen" of an uploaded image: the picture in its
 * CURRENT shape, without the display opacity. The SERVED file is warped —
 * the one the map shows and its corners were measured on (v6 redraws that
 * same image, `special_tools.js:1217-1659`) — with GDAL, the three corners as
 * control points, into EPSG:3857, the grid Leaflet draws. `width` is v6's
 * quality: a factor over the on-screen size, map fitted.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import type { FileInfoEntry } from '../../../src/core/media/files_info.ts';
import { buildMediaLocation } from '../../../src/core/media/path.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	DEFAULT_IMAGE_DOWNLOAD_NAME,
	sanitize_download_name,
	with_extension,
} from '../js/download_filename.js';
import { readFileBase64, resolveGdalBinary, runToolBinary, withScratchDir } from './gdal.ts';
import { OVERLAY_EXTENSIONS, resolveRenderableImage } from './image_media.ts';

export const IMAGE_DOWNLOAD_FORMATS: readonly string[] = ['geotiff', 'png', 'jpg'];

/** Largest output SIDE, width or height — the shape decides the height, so
 * both are bounded (`outputSize`). Above v6's own ceiling, "Excelente" (2x)
 * on a screen. */
export const MAX_IMAGE_DOWNLOAD_SIDE = 8000;

/** EPSG:3857 stops short of the poles; a corner past this cannot be warped. */
const MAX_MERCATOR_LAT = 85.0511;

const EARTH_RADIUS = 6378137;

const IMAGE_DOWNLOAD_MIME: Readonly<Record<string, string>> = {
	geotiff: 'image/tiff',
	png: 'image/png',
	jpg: 'image/jpeg',
};

const IMAGE_DOWNLOAD_EXTENSION: Readonly<Record<string, string>> = {
	geotiff: 'tif',
	png: 'png',
	jpg: 'jpg',
};

/** A caller fault — bad format, corners, width or name. */
function invalidImageDownload(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** The descriptor's three control points, [lat, lon] each — the same shape
 * `L.imageOverlay.rotated` takes and `image_edit.js` moves. */
export interface ImageCorners {
	top_left: [number, number];
	top_right: [number, number];
	bottom_left: [number, number];
}

/** Never trust client geometry: a NaN or an out-of-range degree would warp
 * the image somewhere absurd instead of refusing. */
export function parseCorners(value: unknown): ImageCorners {
	if (value === null || typeof value !== 'object') {
		throw invalidImageDownload('Missing corners');
	}
	const out: Partial<ImageCorners> = {};
	for (const key of ['top_left', 'top_right', 'bottom_left'] as const) {
		const point = (value as Record<string, unknown>)[key];
		if (!Array.isArray(point) || point.length !== 2) {
			throw invalidImageDownload(`corners.${key} must be a [lat, lon] pair`);
		}
		const [lat, lon] = point;
		if (
			typeof lat !== 'number' ||
			typeof lon !== 'number' ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lon) ||
			Math.abs(lat) > MAX_MERCATOR_LAT ||
			Math.abs(lon) > 180
		) {
			throw invalidImageDownload(`corners.${key} is not a valid [lat, lon]`);
		}
		out[key] = [lat, lon];
	}
	const corners = out as ImageCorners;
	// coincident or collinear corners make the control-point transform
	// singular: a caller fault, not a GDAL failure
	const [tlx, tly] = toMercator(corners.top_left);
	const [trx, try_] = toMercator(corners.top_right);
	const [blx, bly] = toMercator(corners.bottom_left);
	const [ax, ay] = [trx - tlx, try_ - tly];
	const [dx, dy] = [blx - tlx, bly - tly];
	const area = Math.abs(ax * dy - ay * dx);
	const side = Math.max(Math.hypot(ax, ay), Math.hypot(dx, dy));
	if (!(side > 0) || area < side * side * 1e-6) {
		throw invalidImageDownload('corners do not span an area');
	}
	return corners;
}

/** [lat, lon] → EPSG:3857 [x, y] meters (spherical Mercator, as Leaflet). */
function toMercator([lat, lon]: [number, number]): [number, number] {
	const x = (EARTH_RADIUS * lon * Math.PI) / 180;
	const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
	return [x, y];
}

/**
 * The output raster's pixel size: `width` as asked, the height the shape's
 * EPSG:3857 footprint gives it, then both scaled down together if either side
 * passes MAX_IMAGE_DOWNLOAD_SIDE — a tall, thin shape is bounded as surely as
 * a wide one. The footprint is the four corners' box: x is linear in longitude
 * and y monotonic in latitude, so no edge bulges past its end points.
 */
export function outputSize(
	corners: ImageCorners,
	width: number,
): { width: number; height: number } {
	const { top_left, top_right, bottom_left } = corners;
	const bottom_right: [number, number] = [
		top_right[0] + bottom_left[0] - top_left[0],
		top_right[1] + bottom_left[1] - top_left[1],
	];
	const points = [top_left, top_right, bottom_left, bottom_right].map(toMercator);
	const xs = points.map((point) => point[0]);
	const ys = points.map((point) => point[1]);
	const aspect = (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs));
	const height = width * aspect;
	const scale = Math.min(1, MAX_IMAGE_DOWNLOAD_SIDE / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** A positive integer. Not capped here: `outputSize` bounds the result, so
 * "Excelente" on a very wide screen gets the largest allowed file, not an error. */
export function parseWidth(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw invalidImageDownload('width must be a positive integer');
	}
	return value;
}

/** Same rule as the map download (`raster_download.ts`), run here whatever
 * the client did: absent takes the default, sanitized-to-nothing is refused. */
function downloadBaseName(value: unknown): string {
	if (value === undefined || value === null) return DEFAULT_IMAGE_DOWNLOAD_NAME;
	if (typeof value !== 'string') {
		throw invalidImageDownload('file_name must be a string');
	}
	const base = sanitize_download_name(value);
	if (base === '') {
		throw invalidImageDownload('file_name has no usable characters');
	}
	return base;
}

/** What the conversion needs to know about the source raster. */
interface RasterShape {
	width: number;
	height: number;
	colorBands: number;
	palette: boolean;
	sixteenBit: boolean;
}

async function readRasterShape(path: string): Promise<RasterShape> {
	const gdalinfo = await resolveGdalBinary('gdalinfo');
	const result = await runToolBinary([gdalinfo, '-json', path], 'gdalinfo (image download)');
	let info: {
		size?: unknown;
		bands?: Array<{ type?: string; colorInterpretation?: string }>;
	};
	try {
		info = JSON.parse(result.stdout);
	} catch {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'gdalinfo -json returned output that is not JSON',
		});
	}
	const size = Array.isArray(info.size) ? info.size : [];
	const bands = Array.isArray(info.bands) ? info.bands : [];
	const interps = bands.map((band) => String(band.colorInterpretation ?? ''));
	// a CMYK source would come out with the wrong colours in every format —
	// refused loudly rather than downloaded wrong
	if (interps.some((interp) => ['Cyan', 'Magenta', 'Yellow', 'Black'].includes(interp))) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'image download: CMYK sources are not supported',
			publicMessage: 'This image is stored in CMYK, which cannot be downloaded from the map.',
		});
	}
	return {
		width: Number(size[0]),
		height: Number(size[1]),
		colorBands: interps.filter((interp) => interp !== 'Alpha').length,
		palette: interps[0] === 'Palette',
		sixteenBit: bands.some((band) => band.type === 'UInt16'),
	};
}

/**
 * The conversion itself, apart from the record lookup so a test can drive it
 * with a raster written on the spot. Pixel EDGES carry the control points
 * ((0,0), (W,0), (0,H)): the corners are where the picture's own corners sit
 * on the map, not the centres of its corner pixels.
 */
export async function renderImageDownload(
	dir: string,
	sourcePath: string,
	corners: ImageCorners,
	format: string,
	width: number,
): Promise<{ extension: string; content: string }> {
	const shape = await readRasterShape(sourcePath);
	if (!(shape.width > 0) || !(shape.height > 0)) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'image download: gdalinfo reported no raster size',
		});
	}

	const gdalTranslate = await resolveGdalBinary('gdal_translate');
	const gdalwarp = await resolveGdalBinary('gdalwarp');
	const size = outputSize(corners, width);

	const gcp = (column: number, row: number, [lat, lon]: [number, number]) => [
		'-gcp',
		String(column),
		String(row),
		String(lon),
		String(lat),
	];
	const vrt = join(dir, 'uca_maps_image_in.vrt');
	await runToolBinary(
		[
			gdalTranslate,
			'-of',
			'VRT',
			'-a_srs',
			'EPSG:4326',
			// a palette cannot be resampled — it is expanded to real colour first
			...(shape.palette ? ['-expand', 'rgba'] : []),
			...gcp(0, 0, corners.top_left),
			...gcp(shape.width, 0, corners.top_right),
			...gcp(0, shape.height, corners.bottom_left),
			sourcePath,
			vrt,
		],
		'image_download (control points)',
		{ expectedOutput: vrt },
	);

	// JPEG has no alpha: what falls outside the shape is painted white, the
	// same choice `raster_download.ts` makes for the map as jpg
	const warped = join(dir, format === 'geotiff' ? 'uca_maps_image.tif' : 'uca_maps_image_warp.tif');
	await runToolBinary(
		[
			gdalwarp,
			'-q',
			'-order',
			'1',
			'-t_srs',
			'EPSG:3857',
			'-ts',
			String(size.width),
			String(size.height),
			'-r',
			'bilinear',
			...(format === 'jpg' ? ['-dstnodata', '255'] : ['-dstalpha']),
			...(format === 'geotiff' ? ['-co', 'COMPRESS=LZW'] : []),
			vrt,
			warped,
		],
		`image_download (warp, ${format})`,
		{ expectedOutput: warped },
	);

	if (format === 'geotiff') {
		return { extension: 'tif', content: await readFileBase64(warped) };
	}

	const output = join(dir, `uca_maps_image.${IMAGE_DOWNLOAD_EXTENSION[format]}`);
	const colorBands = shape.palette ? 3 : shape.colorBands;
	const bandArgs =
		format === 'jpg' ? (colorBands >= 3 ? ['-b', '1', '-b', '2', '-b', '3'] : ['-b', '1']) : [];
	// JPEG is 8-bit only; a 16-bit source is scaled over its full range
	const depthArgs =
		format === 'jpg' && shape.sixteenBit ? ['-ot', 'Byte', '-scale', '0', '65535', '0', '255'] : [];
	await runToolBinary(
		[
			gdalTranslate,
			'-of',
			format === 'jpg' ? 'JPEG' : 'PNG',
			...bandArgs,
			...depthArgs,
			'-co',
			'WORLDFILE=NO',
			warped,
			output,
		],
		`image_download (${format})`,
		{ expectedOutput: output },
	);
	return {
		extension: IMAGE_DOWNLOAD_EXTENSION[format] as string,
		content: await readFileBase64(output),
	};
}

/**
 * WHICH FILE is warped: the one the MAP shows, never the master — the corners
 * were measured on it, and a master can differ (a retouched `modified` tier,
 * EXIF rotation the derivatives were built upright from). The descriptor's
 * `file_path` is only MATCHED against this record's drawable tiers; named but
 * gone is null (a refusal), never a quiet swap to another picture. Unnamed —
 * an older descriptor — takes the served tier.
 */
export function pickDownloadSource(
	files_info: readonly FileInfoEntry[],
	masterQualities: readonly string[],
	shown: unknown,
	served: { file_path: string },
): FileInfoEntry | null {
	const drawable = files_info.filter(
		(entry) =>
			entry.file_exist &&
			typeof entry.file_path === 'string' &&
			!masterQualities.includes(entry.quality) &&
			OVERLAY_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	const wanted = typeof shown === 'string' && shown !== '' ? shown : served.file_path;
	return drawable.find((entry) => entry.file_path === wanted) ?? null;
}

/**
 * IMAGE_DOWNLOAD — options: the IMAGE record's `tipo`/`section_tipo`/
 * `section_id` (so the `record_tipo` gate asks whether the caller may read
 * that image, as `get_image_overlay` does), the descriptor's `file_path`,
 * `corners`, `format`, `width`, `file_name`. Everything the caller sends is validated before a file is read.
 */
export async function imageDownload(ctx: ToolActionContext): Promise<ToolResponse> {
	const format = String(ctx.options.format ?? '');
	if (!IMAGE_DOWNLOAD_FORMATS.includes(format)) {
		throw invalidImageDownload(
			`Unsupported image format '${format}' (expected 'geotiff', 'png' or 'jpg')`,
		);
	}
	const corners = parseCorners(ctx.options.corners);
	const width = parseWidth(ctx.options.width);
	const baseName = downloadBaseName(ctx.options.file_name);

	const { spec, identity, pathOpts, files_info, served } = await resolveRenderableImage(
		ctx.options,
	);

	const source = pickDownloadSource(
		files_info,
		spec.masterQualities,
		ctx.options.file_path,
		served,
	);
	const location =
		source && typeof source.extension === 'string'
			? buildMediaLocation(spec, identity, source.quality, source.extension, pathOpts)
			: null;
	if (!location || !existsSync(location.absolutePath)) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { section_tipo: identity.sectionTipo, section_id: identity.sectionId },
			message: `image_download: no file for ${String(ctx.options.file_path ?? served.file_path)}`,
			publicMessage: 'The image shown on the map is no longer on the server.',
		});
	}

	const result = await withScratchDir((dir) =>
		renderImageDownload(dir, location.absolutePath, corners, format, width),
	);

	return ok(
		{
			content_base64: result.content,
			filename: with_extension(baseName, result.extension),
			mime: IMAGE_DOWNLOAD_MIME[format],
		},
		{ requestId: toolRequestId(ctx) },
	);
}
