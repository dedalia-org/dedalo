/**
 * vector_upload — fila #11 ("Upload file to map"), vector half only (hito 12;
 * the raster/image-overlay half is a separate later hito — see
 * `docs/hitos/hito_12.md`).
 *
 * v6 (`special_tools_upload.js` + `class.tool_leaflet_special_tools.php:2178`)
 * branches THREE ways client-side (zip/geojson/kml), vendors a 500+ line
 * `L.Shapefile`/`L.KML` reader pair, and reprojects in the BROWSER with a
 * hardcoded 18-entry EPSG table + zone/band UI — proj4js there cannot resolve
 * an arbitrary EPSG code without a network fetch to epsg.io. This port
 * converts all three formats to WGS84 GeoJSON SERVER-SIDE with one `ogr2ogr`
 * call (same `withScratchDir`/`runToolBinary` plumbing as `vector_download.ts`,
 * hito 3), so the client only ever draws `L.geoJSON` — same pattern already
 * proven for Catastro/UA (hito 11). GDAL/PROJ carries the full EPSG database,
 * so a `.prj` sidecar inside the shapefile zip or a legacy GeoJSON `crs`
 * member reprojects automatically with NO lookup table; the one case GDAL
 * cannot solve alone — a source with NO embedded CRS at all (bare UTM
 * numbers) — keeps a single optional EPSG-code override, verified live
 * against GDAL 3.13.2 in the dev container (see hito 12 dossier): omitting it
 * on a CRS-less file fails cleanly ("no coordinate system … use -s_srs"),
 * supplying one fixes the reprojection.
 *
 * Confirmed live: GDAL's shapefile-in-zip driver keys off the LITERAL
 * `.shp.zip` extension, not a plain `.zip` — a bare `.zip` (any content)
 * fails to open with every driver tried. The staged upload's real name is
 * never trusted for this; `.shp.zip` is what this file writes for the `zip`
 * case, always.
 */

import { existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { config } from '../../../src/config/config.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { sanitizeSegment } from '../../../src/core/media/ingest/add_file.ts';
import { assertTestMediaRoot } from '../../../src/core/media/test_media_root.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { resolveGdalBinary, runToolBinary, withScratchDir } from './gdal.ts';

// client extension -> the scratch-file extension ogr2ogr needs to pick the
// right driver by name (the shapefile-in-zip case is the one that does NOT
// match its own client extension — see module doc comment).
const VECTOR_UPLOAD_SCRATCH_EXTENSION: Readonly<Record<string, string>> = {
	zip: 'shp.zip',
	geojson: 'geojson',
	kml: 'kml',
};

// v6 parity (`process_uploaded_vector`'s own $response->size check).
const MAX_UPLOAD_BYTES = 10_000_000;

function invalidVectorUpload(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/**
 * Resolve + confine the staged upload path — same rebuild-from-userId pattern
 * as `tool_import_dedalo_csv`'s `processUploadedFile` (CLAUDE.local.md: never
 * trust a client-supplied path, only a name to sanitize under the CALLER's
 * OWN staging directory, rebuilt server-side from the authenticated user id).
 */
function resolveStagedUpload(userId: number, rawKeyDir: string, rawTmpName: string): string {
	if (rawTmpName === '') throw invalidVectorUpload('Missing staged file (tmp_name)');
	const keyDir = rawKeyDir === '' ? '' : sanitizeSegment(rawKeyDir);
	const tmpName = sanitizeSegment(rawTmpName);
	const configuredRoot = config.media.rootPath;
	if (configuredRoot === null || configuredRoot === '') {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'media root is not configured',
		});
	}
	const root = assertTestMediaRoot(configuredRoot, 'tool_uca_maps.vectorUpload');
	const staged = join(root, config.media.upload.tmpSubdir, String(userId), keyDir, tmpName);
	const stagingBase = join(root, config.media.upload.tmpSubdir);
	if (!staged.startsWith(stagingBase + sep)) {
		throw new DedaloError('internal.invariant', {
			message: 'staged path escapes the upload root',
		});
	}
	if (!existsSync(staged)) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'staged file not found',
		});
	}
	return staged;
}

/** A parsed GeoJSON FeatureCollection, loosely typed — the client is the one
 * that walks `features` to build Leaflet layers. */
interface GeoJsonFeatureCollection {
	type: 'FeatureCollection';
	features: unknown[];
	[key: string]: unknown;
}

export async function uploadVectorLayer(ctx: ToolActionContext): Promise<ToolResponse> {
	const fileData = (ctx.options.file_data ?? {}) as {
		key_dir?: unknown;
		tmp_name?: unknown;
		extension?: unknown;
	};
	const extension = String(fileData.extension ?? '')
		.toLowerCase()
		.replace(/^\./, '');
	const scratchExtension = VECTOR_UPLOAD_SCRATCH_EXTENSION[extension];
	if (scratchExtension === undefined) {
		throw invalidVectorUpload(
			`Unsupported vector file extension '${extension}' (expected zip, geojson or kml)`,
		);
	}

	const epsgOption = String(ctx.options.epsg ?? '').trim();
	if (epsgOption !== '' && !/^[0-9]{4,6}$/.test(epsgOption)) {
		throw invalidVectorUpload(`Invalid EPSG code '${epsgOption}'`);
	}

	const staged = resolveStagedUpload(
		ctx.userId,
		String(fileData.key_dir ?? ''),
		String(fileData.tmp_name ?? ''),
	);
	const size = statSync(staged).size;
	if (size > MAX_UPLOAD_BYTES) {
		throw invalidVectorUpload(
			`The uploaded file (${size} bytes) exceeds the ${MAX_UPLOAD_BYTES}-byte limit`,
		);
	}

	const geojson = await withScratchDir(async (dir) => {
		// input/output MUST NOT share a name: the .geojson case would otherwise
		// collide (scratchExtension IS 'geojson' there) and ogr2ogr refuses with
		// "Source and destination datasets must be different in non-update
		// mode" — caught live against GDAL 3.13.2 (hito 12 dossier).
		const inputFile = join(dir, `uca_maps_upload_in.${scratchExtension}`);
		await Bun.write(inputFile, Bun.file(staged));
		const outputFile = join(dir, 'uca_maps_upload_out.geojson');

		const ogr2ogr = await resolveGdalBinary('ogr2ogr');
		const argv = [ogr2ogr, '-f', 'GeoJSON', '-t_srs', 'EPSG:4326'];
		if (epsgOption !== '') argv.push('-s_srs', `EPSG:${epsgOption}`);
		argv.push(outputFile, inputFile);

		try {
			await runToolBinary(argv, `vector_upload (${extension})`, { expectedOutput: outputFile });
		} catch (error) {
			// The one failure GDAL cannot recover from on its own: a source with
			// no embedded CRS and no override given — ogr2ogr's own stderr names
			// it exactly ("has no coordinate system … Use -s_srs", verified live
			// against GDAL 3.13.2, see module doc comment). Matched on the actual
			// message rather than assumed from `epsgOption === ''`: a WRONG
			// override (a real CRS, just not this file's) fails differently and
			// must keep its own generic error, not this one.
			const message = error instanceof Error ? error.message : String(error);
			if (epsgOption === '' && /coordinate system/i.test(message)) {
				throw invalidVectorUpload(
					'This file has no embedded coordinate system (no .prj / crs member) — ' +
						'provide an EPSG code to reproject it',
				);
			}
			throw error;
		}

		const parsed = (await Bun.file(outputFile)
			.json()
			.catch(() => null)) as GeoJsonFeatureCollection | null;
		if (parsed === null || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
			throw new DedaloError('tool.action_failed', {
				coordinates: { tool: 'tool_uca_maps' },
				message: 'vector_upload: ogr2ogr produced no usable GeoJSON',
			});
		}
		return parsed;
	});

	return ok({ geojson, feature_count: geojson.features.length }, { requestId: toolRequestId(ctx) });
}
