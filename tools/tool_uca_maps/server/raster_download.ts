/**
 * raster_download — the map image in the formats a browser cannot write (PNG
 * is client-side): jpg/gif/webp via ImageMagick, GeoTIFF via GDAL. `bounds`
 * arrive already in EPSG:3857 metres, the grid Leaflet's pixels are uniform
 * in, so `-a_srs EPSG:3857 -a_ullr` georeferences with no `gdalwarp` resample.
 */

import { join } from 'node:path';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { withConverterSlot } from '../../../src/core/media/engine/admission.ts';
import {
	magickPolicyEnv,
	magickResourceLimitArgs,
} from '../../../src/core/media/engine/binaries.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	DEFAULT_MAP_IMAGE_NAME,
	sanitize_download_name,
	with_extension,
} from '../js/download_filename.js';
import {
	inputDrivers,
	readFileBase64,
	resolveGdalBinary,
	resolveMagickBinary,
	runToolBinary,
	withScratchDir,
	writeFileBase64,
} from './gdal.ts';

/** Each format's MIME and the extension its file gets (a geotiff is `.tif`). */
const RASTER_FORMATS: Readonly<Record<string, { mime: string; extension: string }>> = {
	jpg: { mime: 'image/jpeg', extension: 'jpg' },
	gif: { mime: 'image/gif', extension: 'gif' },
	webp: { mime: 'image/webp', extension: 'webp' },
	geotiff: { mime: 'image/tiff', extension: 'tif' },
};

/** A caller fault — bad format, missing/malformed image or bounds. */
function invalidRasterRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** The client's already-projected EPSG:3857 corners (`map_image_download.js`
 * `projected_bounds`) — meters, not degrees. */
interface RasterBounds {
	west: number;
	north: number;
	east: number;
	south: number;
}

/** Validate `options.bounds` for the geotiff branch: 4 finite numbers, a
 * non-degenerate box. Never trust client-supplied geometry blindly — a NaN
 * or an inverted box would silently misgeoreference the GeoTIFF instead of
 * refusing. */
function parseBounds(value: unknown): RasterBounds {
	if (value === null || typeof value !== 'object') {
		throw invalidRasterRequest('Missing bounds for geotiff export');
	}
	const { west, north, east, south } = value as Record<string, unknown>;
	for (const [key, n] of Object.entries({ west, north, east, south })) {
		if (typeof n !== 'number' || !Number.isFinite(n)) {
			throw invalidRasterRequest(`bounds.${key} must be a finite number`);
		}
	}
	const bounds = { west, north, east, south } as RasterBounds;
	if (bounds.west >= bounds.east || bounds.south >= bounds.north) {
		throw invalidRasterRequest('bounds are degenerate (west>=east or south>=north)');
	}
	return bounds;
}

/**
 * The download name, sanitized here whatever the client did with it
 * (`js/download_filename.js` is the one rule both sides run). Absent takes
 * `fallback`; a name that sanitizes to nothing is refused, never quietly
 * renamed. It never becomes a path: the scratch files keep fixed names.
 */
export function downloadBaseName(value: unknown, fallback: string): string {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'string') {
		throw invalidRasterRequest('file_name must be a string');
	}
	const base = sanitize_download_name(value);
	if (base === '') {
		throw invalidRasterRequest('file_name has no usable characters');
	}
	return base;
}

/**
 * JPG/GIF/WebP via ImageMagick. The bytes are the client's, so the spawn carries
 * core's hardened policy, the install's `-limit` argv (before the image it
 * governs) and a converter permit. The last two are gated here, since
 * `magick_policy_tripwire` walks `src/core/media/` only; the `.png` input name
 * pins the decoder, so the policy is defence in depth no request can reach.
 */
async function convertWithImageMagick(
	dir: string,
	inputFile: string,
	format: string,
): Promise<string> {
	const outputFile = join(dir, `uca_maps_map.${format}`);
	const magick = resolveMagickBinary();
	// JPEG has no alpha: composite onto white, or the hidden RGB under a
	// transparent area shows through (core's buildConvertArgv does the same)
	const flatten = format === 'jpg' ? ['-background', 'white', '-flatten'] : [];
	const argv = [magick, ...magickResourceLimitArgs(), inputFile, ...flatten, outputFile];
	await withConverterSlot('magick', () =>
		runToolBinary(argv, `raster_download (${format})`, {
			scratchDir: dir,
			env: magickPolicyEnv(dir),
			expectedOutput: outputFile,
		}),
	);
	return readFileBase64(outputFile);
}

/** GeoTIFF, georeferenced as the module header says; LZW because a
 * screenshot compresses well. */
async function convertToGeotiff(
	dir: string,
	inputFile: string,
	bounds: RasterBounds,
): Promise<string> {
	const outputFile = join(dir, 'uca_maps_map.tif');
	const gdalTranslate = await resolveGdalBinary('gdal_translate');
	await runToolBinary(
		[
			gdalTranslate,
			...inputDrivers('PNG'),
			'-a_srs',
			'EPSG:3857',
			'-a_ullr',
			String(bounds.west),
			String(bounds.north),
			String(bounds.east),
			String(bounds.south),
			'-co',
			'COMPRESS=LZW',
			inputFile,
			outputFile,
		],
		'raster_download (geotiff)',
		{ scratchDir: dir, expectedOutput: outputFile },
	);
	return readFileBase64(outputFile);
}

export async function rasterDownload(ctx: ToolActionContext): Promise<ToolResponse> {
	const format = String(ctx.options.format ?? '');
	const spec = Object.hasOwn(RASTER_FORMATS, format) ? RASTER_FORMATS[format] : undefined;
	if (spec === undefined) {
		throw invalidRasterRequest(
			`Unsupported raster format '${format}' (expected 'jpg', 'gif', 'webp' or 'geotiff')`,
		);
	}
	const imageBase64 = ctx.options.image_base64;
	if (typeof imageBase64 !== 'string' || imageBase64 === '') {
		throw invalidRasterRequest('Missing image_base64');
	}
	// Validated BEFORE any file touches disk: a bad bounds object should never
	// spend a GDAL invocation to discover it was invalid.
	const bounds = format === 'geotiff' ? parseBounds(ctx.options.bounds) : null;
	const baseName = downloadBaseName(ctx.options.file_name, DEFAULT_MAP_IMAGE_NAME);

	const content = await withScratchDir(async (dir) => {
		const inputFile = join(dir, 'uca_maps_map.png');
		await writeFileBase64(inputFile, imageBase64);
		return bounds === null
			? convertWithImageMagick(dir, inputFile, format)
			: convertToGeotiff(dir, inputFile, bounds);
	});

	return ok(
		{
			content_base64: content,
			filename: with_extension(baseName, spec.extension),
			mime: spec.mime,
		},
		{ requestId: toolRequestId(ctx) },
	);
}
