/**
 * vector_download — SHP and KML of one object (GeoJSON is client-side). GDAL's
 * `.shp.zip` writes the zip itself (`/vsizip/` cannot: the driver patches its
 * header in place). `layer.toGeoJSON()` is WGS84, so `-a_srs EPSG:4326` labels
 * it where v6 forced EPSG:3857: an assignment, no reprojection.
 */

import { join } from 'node:path';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	assertOfflineGeoJsonCrs,
	inputDrivers,
	readFileBase64,
	resolveGdalBinary,
	runToolBinary,
	withScratchDir,
} from './gdal.ts';

/** Each format's OGR driver, download name and MIME. */
const VECTOR_FORMATS: Readonly<Record<string, { driver: string; fileName: string; mime: string }>> =
	{
		shp: { driver: 'ESRI Shapefile', fileName: 'uca_maps_object.shp.zip', mime: 'application/zip' },
		kml: {
			driver: 'KML',
			fileName: 'uca_maps_object.kml',
			mime: 'application/vnd.google-earth.kml+xml',
		},
	};

/** A caller fault — bad format, missing/malformed geojson. */
function invalidVectorRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** One `ogr2ogr` call into `fileName`, returned base64. */
async function convertWithOgr2Ogr(
	dir: string,
	inputFile: string,
	driverName: string,
	fileName: string,
): Promise<string> {
	const outputFile = join(dir, fileName);
	const ogr2ogr = await resolveGdalBinary('ogr2ogr');
	await runToolBinary(
		[
			ogr2ogr,
			...inputDrivers('GeoJSON'),
			'-f',
			driverName,
			'-a_srs',
			'EPSG:4326',
			outputFile,
			inputFile,
		],
		`vector_download (${fileName})`,
		{ scratchDir: dir, expectedOutput: outputFile },
	);
	return readFileBase64(outputFile);
}

export async function vectorDownload(ctx: ToolActionContext): Promise<ToolResponse> {
	const format = String(ctx.options.format ?? '');
	const spec = Object.hasOwn(VECTOR_FORMATS, format) ? VECTOR_FORMATS[format] : undefined;
	if (spec === undefined) {
		throw invalidVectorRequest(`Unsupported vector format '${format}' (expected 'shp' or 'kml')`);
	}
	const geojson = ctx.options.geojson;
	if (geojson === null || typeof geojson !== 'object') {
		throw invalidVectorRequest('Missing or invalid geojson');
	}
	// `-a_srs` replaces the CRS only after GDAL has read the one the file names
	assertOfflineGeoJsonCrs(geojson);

	const content = await withScratchDir(async (dir) => {
		// ogr2ogr names the layer after the source file, and the layer names the
		// members inside the `.shp.zip`: `input.geojson` would give `input.shp`
		const inputFile = join(dir, 'uca_maps_object.geojson');
		await Bun.write(inputFile, JSON.stringify(geojson));
		return convertWithOgr2Ogr(dir, inputFile, spec.driver, spec.fileName);
	});

	return ok(
		{ content_base64: content, filename: spec.fileName, mime: spec.mime },
		{ requestId: toolRequestId(ctx) },
	);
}
