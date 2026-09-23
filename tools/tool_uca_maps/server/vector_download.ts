/**
 * vector_download — hito 3, checkpoint 3a: SHP/KML for the object console's
 * per-object download (`docs/Funcionalidades de tool_leaflet_special_tools.md`
 * fila #3). GeoJSON stays 100% client-side (`object_console.js`
 * `download_vector` — `layer.toGeoJSON()` + Blob, no round-trip); this action
 * only fires for the two formats a browser cannot produce on its own.
 *
 * v6 oracle (`class.tool_leaflet_special_tools.php:90-180`): writes a temp
 * GeoJSON, `shell_exec`s `ogr2ogr` with STRING-INTERPOLATED args, assembles
 * the SHP's 4 sibling files into a zip by hand (PHP `ZipArchive`), writes both
 * to a web-exposed `downloads/` folder and hands back a URL the client
 * `window.open()`s. Three deliberate departures, all documented in
 * `docs/hitos/hito_3.md`:
 *   1. `runBinary` (argv array, no shell) instead of `shell_exec` — injection
 *      is structurally impossible, not escaped away.
 *   2. GDAL's own `.shp.zip` output extension (≥3.1) writes the SHP straight
 *      into a zip in one `ogr2ogr` call — no manual ZipArchive assembly, no
 *      loose temp files to unlink one by one. (The generic `/vsizip/` virtual
 *      filesystem was tried FIRST and refused — the Shapefile driver needs
 *      random write access to patch its own header/index, which a streaming
 *      zip writer cannot offer; `.shp.zip` is GDAL's own special-cased answer
 *      to that same limitation.)
 *   3. No public downloads folder (this encargo has no `src/server.ts` route
 *      — CLAUDE.local.md surface rule): the result travels base64 inside the
 *      envelope instead of behind a served URL.
 *
 * CRS: v6 forces `-a_srs EPSG:3857` and pre-reprojects client-side with
 * `turf.toMercator` (the resulting GeoJSON is no longer valid WGS84 per RFC
 * 7946 — audit bug #4). `layer.toGeoJSON()` is already valid WGS84; it is
 * sent as-is and `-a_srs EPSG:4326` labels it correctly — an assignment, not
 * a reprojection, because the data does not need one.
 */

import { join } from 'node:path';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { readFileBase64, resolveGdalBinary, runToolBinary, withScratchDir } from './gdal.ts';

const VECTOR_FORMATS: ReadonlySet<string> = new Set(['shp', 'kml']);

const VECTOR_MIME: Readonly<Record<string, string>> = {
	shp: 'application/zip',
	kml: 'application/vnd.google-earth.kml+xml',
};

/** A caller fault — bad format, missing/malformed geojson. */
function invalidVectorRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** One converted file, base64-encoded, ready for the envelope. */
interface VectorDownloadResult {
	fileName: string;
	content: string;
}

/**
 * One `ogr2ogr` call, one shared shape — review-diff finding, hito 3:
 * `convertToShp`/`convertToKml` used to be two near-identical copies (driver
 * name, output extension and nothing else genuinely differed). The
 * "did it actually leave its output" check lives in `runToolBinary`
 * (`expectedOutput`) now, not repeated here either.
 */
async function convertWithOgr2Ogr(
	inputFile: string,
	driverName: string,
	outputFile: string,
	fileName: string,
): Promise<VectorDownloadResult> {
	const ogr2ogr = await resolveGdalBinary('ogr2ogr');
	await runToolBinary(
		[ogr2ogr, '-f', driverName, '-a_srs', 'EPSG:4326', outputFile, inputFile],
		`vector_download (${fileName})`,
		{ expectedOutput: outputFile },
	);
	return { fileName, content: await readFileBase64(outputFile) };
}

export async function vectorDownload(ctx: ToolActionContext): Promise<ToolResponse> {
	const format = String(ctx.options.format ?? '');
	if (!VECTOR_FORMATS.has(format)) {
		throw invalidVectorRequest(`Unsupported vector format '${format}' (expected 'shp' or 'kml')`);
	}
	const geojson = ctx.options.geojson;
	if (geojson === null || typeof geojson !== 'object') {
		throw invalidVectorRequest('Missing or invalid geojson');
	}

	const result = await withScratchDir(async (dir) => {
		// Named `uca_maps_object`, not `input`: ogr2ogr's GeoJSON driver names its
		// layer after the SOURCE file's basename when the file carries none of
		// its own — that layer name becomes the shapefile MEMBER basename inside
		// the `.shp.zip` (verified live: an `input.geojson` source produced
		// `input.shp`/`.shx`/`.dbf`/`.prj` inside the zip, regardless of the zip's
		// own output filename).
		const inputFile = join(dir, 'uca_maps_object.geojson');
		await Bun.write(inputFile, JSON.stringify(geojson));
		return format === 'shp'
			? convertWithOgr2Ogr(
					inputFile,
					'ESRI Shapefile',
					join(dir, 'uca_maps_object.shp.zip'),
					'uca_maps_object.shp.zip',
				)
			: convertWithOgr2Ogr(
					inputFile,
					'KML',
					join(dir, 'uca_maps_object.kml'),
					'uca_maps_object.kml',
				);
	});

	return ok(
		{ content_base64: result.content, filename: result.fileName, mime: VECTOR_MIME[format] },
		{ requestId: toolRequestId(ctx) },
	);
}
