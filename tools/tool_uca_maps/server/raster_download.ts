/**
 * raster_download — the map image in the formats a browser cannot write (PNG is
 * client-side): jpg/gif/webp via ImageMagick, GeoTIFF via GDAL. `bounds` arrive in
 * EPSG:3857 metres, the grid Leaflet's pixels are uniform in, so `-a_srs EPSG:3857 -a_ullr`
 * georeferences with no `gdalwarp` resample. The PNG capture arrives staged by core's upload
 * door: a real map is MB, far above the request `options` cap (`scalar_bounds.ts`).
 */

import { join } from 'node:path';
import { withConverterSlot } from '../../../src/core/media/engine/admission.ts';
import {
	magickPolicyEnv,
	magickResourceLimitArgs,
} from '../../../src/core/media/engine/binaries.ts';
import type { ToolActionContext, ToolResponse } from '../../../src/core/tools/module.ts';
import { DEFAULT_MAP_IMAGE_NAME, with_extension } from '../js/download_filename.js';
import { MAP_IMAGE_KEY_DIR } from '../js/upload_formats.js';
import { downloadAnswer, downloadBaseName } from './download_answer.ts';
import {
	inputDrivers,
	readFileBase64,
	resolveGdalBinary,
	resolveMagickBinary,
	runToolBinary,
	withScratchDir,
} from './gdal.ts';
import { invalidOptions } from './reasons.ts';
import { claimStagedUpload } from './staged_upload.ts';

/** Each format's MIME and the extension its file gets (a geotiff is `.tif`). */
const RASTER_FORMATS: Readonly<Record<string, { mime: string; extension: string }>> = {
	jpg: { mime: 'image/jpeg', extension: 'jpg' },
	gif: { mime: 'image/gif', extension: 'gif' },
	webp: { mime: 'image/webp', extension: 'webp' },
	geotiff: { mime: 'image/tiff', extension: 'tif' },
};

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
		throw invalidOptions('Missing bounds for geotiff export');
	}
	const { west, north, east, south } = value as Record<string, unknown>;
	for (const [key, n] of Object.entries({ west, north, east, south })) {
		if (typeof n !== 'number' || !Number.isFinite(n)) {
			throw invalidOptions(`bounds.${key} must be a finite number`);
		}
	}
	const bounds = { west, north, east, south } as RasterBounds;
	if (bounds.west >= bounds.east || bounds.south >= bounds.north) {
		throw invalidOptions('bounds are degenerate (west>=east or south>=north)');
	}
	return bounds;
}

/**
 * JPG/GIF/WebP via ImageMagick. On the client's bytes the spawn carries core's
 * hardened policy, the install's `-limit` argv (before the image) and a converter
 * permit, the last two gated here as `magick_policy_tripwire` walks only
 * `src/core/media/`; the `.png` input name pins the decoder (defence in depth).
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
	const capture = claimStagedUpload(ctx, MAP_IMAGE_KEY_DIR, 'tool_uca_maps.rasterDownload');
	try {
		const format = String(ctx.options.format ?? '');
		const spec = Object.hasOwn(RASTER_FORMATS, format) ? RASTER_FORMATS[format] : undefined;
		if (spec === undefined) {
			throw invalidOptions(
				`Unsupported raster format '${format}' (expected 'jpg', 'gif', 'webp' or 'geotiff')`,
			);
		}
		// Validated BEFORE the capture is copied: a bad bounds object should never
		// spend a GDAL invocation to discover it was invalid.
		const bounds = format === 'geotiff' ? parseBounds(ctx.options.bounds) : null;
		const baseName = downloadBaseName(ctx.options.file_name, DEFAULT_MAP_IMAGE_NAME);

		const content = await withScratchDir(async (dir) => {
			const inputFile = join(dir, 'uca_maps_map.png');
			await Bun.write(inputFile, Bun.file(capture.path));
			return bounds === null
				? convertWithImageMagick(dir, inputFile, format)
				: convertToGeotiff(dir, inputFile, bounds);
		});

		return downloadAnswer(ctx, content, with_extension(baseName, spec.extension), spec.mime);
	} finally {
		// one capture per download, refused or not: core keeps a completed staged file
		capture.release();
	}
}
