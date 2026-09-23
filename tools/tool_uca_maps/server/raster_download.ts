/**
 * raster_download — hito 3, checkpoint 3b: "Download map as image"
 * (`docs/Funcionalidades de tool_leaflet_special_tools.md` fila #10, a
 * control that did not exist before this hito). PNG stays 100% client-side
 * (`map_image_download.js` — the browser already produced it, same principle
 * as 2b/3a's GeoJSON); this action covers the 4 formats that need a real
 * conversion GDAL/ImageMagick are not a browser capability:
 *
 *   - jpg/gif/webp: ImageMagick, via `gdal.ts`'s `resolveMagickBinary()` —
 *     `identifyAvailable()`-gated (review-diff finding: a bare
 *     `resolveMagick()` never throws, so a missing install would spawn a
 *     nonexistent binary and surface as an opaque `internal.unexpected`
 *     instead of `tool.dependency_unavailable`) — plus `magickPolicyEnv()`
 *     (`media/engine/binaries.ts`), the SAME hardened-policy env every other
 *     media conversion in this engine uses; MEDIA-02 exists precisely so an
 *     ImageMagick process never runs with the stock, delegate-enabled
 *     policy.xml a content-sniffed Ghostscript RCE needs. JPG gets
 *     `-background white -flatten` first (no alpha channel in JPEG; GIF/WebP
 *     keep transparency, no flatten needed).
 *   - geotiff: GDAL, with a REAL georeference — see the CRS note below.
 *
 * Both families run through `gdal.ts`'s shared `runToolBinary` (argv, no
 * shell; one 60s bound; one "did it actually leave its output" check) —
 * review-diff finding: an earlier revision spawned the ImageMagick calls via
 * a bare `runBinary`, which silently inherited `spawn.ts`'s 10-minute
 * DEFAULT_TIMEOUT_MS instead of the 60s every other binary call here gets.
 *
 * v6 oracle (`class.tool_leaflet_special_tools.php:230-300` raster download,
 * `:990-1057` the sibling map-image-download path;
 * `special_tools_map_image_download.js:276` client capture via the ORIGINAL
 * `dom-to-image`): writes the captured PNG + a `gdal_translate -a_srs
 * EPSG:3857 -a_ullr …` straight from client-supplied bounds, zips it, writes
 * to a web-exposed `downloads/` folder, hands back a URL. Same three
 * departures as `vector_download.ts` (no shell, no manual zip where GDAL/a
 * single file already avoids one, base64-in-envelope instead of a public
 * route this encargo cannot add).
 *
 * CRS — the actual correction the plan's "reproyectado de verdad" asks for.
 * A Leaflet map's on-screen pixel grid is uniform in WEB MERCATOR METERS,
 * never in degrees (Mercator compresses degree-spacing away from the
 * equator). v6's `-a_srs EPSG:3857 -a_ullr <bounds>` is only correct if
 * `bounds` are ALREADY true Mercator meters — the audit could not confirm
 * that from the code alone and flagged it "revisar si es correcto" (bug #4).
 * This port computes the REAL corners: the client projects the map's WGS84
 * viewport bounds through Leaflet's own `L.CRS.EPSG3857.project()`
 * (`map_image_download.js` `projected_bounds`) before sending, so
 * `bounds.{west,north,east,south}` arriving here are ALREADY EPSG:3857
 * meters — one `gdal_translate -a_srs EPSG:3857 -a_ullr …` labels them
 * correctly. No `gdalwarp` resample: the pixels already ARE uniform in that
 * CRS, so warping would only resample a raster that needed no correction.
 */

import { join } from 'node:path';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { magickPolicyEnv } from '../../../src/core/media/engine/binaries.ts';
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
	readFileBase64,
	resolveGdalBinary,
	resolveMagickBinary,
	runToolBinary,
	withScratchDir,
	writeFileBase64,
} from './gdal.ts';

const IMAGEMAGICK_FORMATS: ReadonlySet<string> = new Set(['jpg', 'gif', 'webp']);
const RASTER_FORMATS: ReadonlySet<string> = new Set(['jpg', 'gif', 'webp', 'geotiff']);

const RASTER_MIME: Readonly<Record<string, string>> = {
	jpg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	geotiff: 'image/tiff',
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

/** One converted file, base64-encoded, ready for the envelope. It carries the
 * EXTENSION, not a name: the download name is the user's (`options.file_name`)
 * and is built once, in `rasterDownload`. */
interface RasterDownloadResult {
	extension: string;
	content: string;
}

/**
 * The download name, sanitized HERE whatever the client did with it
 * (`js/download_filename.js` is the one rule both sides run). Absent means
 * "no name supplied" and takes the default; a supplied name that survives
 * sanitizing as nothing is a caller fault, refused rather than quietly
 * renamed. It never becomes a path — the scratch file below keeps its own
 * fixed name, so nothing user-typed reaches `join()`.
 */
function downloadBaseName(value: unknown): string {
	if (value === undefined || value === null) return DEFAULT_MAP_IMAGE_NAME;
	if (typeof value !== 'string') {
		throw invalidRasterRequest('file_name must be a string');
	}
	const base = sanitize_download_name(value);
	if (base === '') {
		throw invalidRasterRequest('file_name has no usable characters');
	}
	return base;
}

/** JPG/GIF/WebP via ImageMagick. Deliberately SIMPLER than
 * `media/engine/imagemagick.ts`'s internal `runMagickTo` (multi-scene
 * verification, resize budgets, CMYK profiles) — a screenshot is always one
 * scene and needs none of that; `resolveMagickBinary`/`magickPolicyEnv` are
 * reused verbatim, the rest is not, on purpose.
 * (!) MEDIA-01 has TWO halves and this path carries only one: the hardened
 * policy env, never the operating `-limit` argv (`magickResourceLimitArgs`).
 * `magick_policy_tripwire`'s census walks `src/core/media/` only, so nothing
 * goes red about it — which is precisely why it is written here. */
async function convertWithImageMagick(
	dir: string,
	inputFile: string,
	format: 'jpg' | 'gif' | 'webp',
): Promise<RasterDownloadResult> {
	const outputFile = join(dir, `uca_maps_map.${format}`);
	const magick = resolveMagickBinary();
	// JPG has no alpha channel: `-background white -flatten` first, mirroring
	// `imagemagick.ts buildConvertArgv`'s own reasoning for the same problem
	// (a bare JPEG encode keeps the source's hidden RGB under a transparent
	// area instead of compositing it). GIF/WebP keep transparency as-is.
	const argv =
		format === 'jpg'
			? [magick, inputFile, '-background', 'white', '-flatten', outputFile]
			: [magick, inputFile, outputFile];
	// `dir` is this action's scratch directory, so the pixel cache spills inside
	// the tree `withScratchDir` sweeps rather than loose in the OS temp root.
	// (!) It does NOT satisfy what `magickPolicyEnv` asks for: `withScratchDir`
	// mkdtemps under `tmpdir()` (gdal.ts), so the spill still lands on the OS
	// temp VOLUME — on both shipped compose stacks, the database's. Moving the
	// tool's scratch root under the media root is the real fix and is not this
	// change's scope; recorded in the tool's ledger, not hidden here.
	await runToolBinary(argv, `raster_download (${format})`, {
		env: magickPolicyEnv(dir),
		expectedOutput: outputFile,
	});
	return { extension: format, content: await readFileBase64(outputFile) };
}

/** GeoTIFF — see the module header for why a single `-a_srs EPSG:3857
 * -a_ullr <real Mercator meters>` is the correct, complete georeference
 * (no `gdalwarp` resample needed). `-co COMPRESS=LZW`: a raw screenshot
 * compresses well and a map export nobody asked to be uncompressed. */
async function convertToGeotiff(
	dir: string,
	inputFile: string,
	bounds: RasterBounds,
): Promise<RasterDownloadResult> {
	const outputFile = join(dir, 'uca_maps_map.tif');
	const gdalTranslate = await resolveGdalBinary('gdal_translate');
	await runToolBinary(
		[
			gdalTranslate,
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
		{ expectedOutput: outputFile },
	);
	return { extension: 'tif', content: await readFileBase64(outputFile) };
}

export async function rasterDownload(ctx: ToolActionContext): Promise<ToolResponse> {
	const format = String(ctx.options.format ?? '');
	if (!RASTER_FORMATS.has(format)) {
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
	const baseName = downloadBaseName(ctx.options.file_name);

	const result = await withScratchDir(async (dir) => {
		const inputFile = join(dir, 'uca_maps_map.png');
		await writeFileBase64(inputFile, imageBase64);
		return IMAGEMAGICK_FORMATS.has(format)
			? convertWithImageMagick(dir, inputFile, format as 'jpg' | 'gif' | 'webp')
			: convertToGeotiff(dir, inputFile, bounds as RasterBounds);
	});

	return ok(
		{
			content_base64: result.content,
			filename: with_extension(baseName, result.extension),
			mime: RASTER_MIME[format],
		},
		{ requestId: toolRequestId(ctx) },
	);
}
