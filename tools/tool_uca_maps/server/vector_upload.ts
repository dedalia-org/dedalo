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
 * numbers) — takes a manual projection, verified live against GDAL 3.13.2 in
 * the dev container (see hito 12 dossier): omitting it on a CRS-less file
 * fails cleanly ("no coordinate system … use -s_srs"), supplying one fixes
 * the reprojection. The manual projection is v6's fields (EPSG, plus zone
 * and band for a UTM code) — see `parseManualProjection`.
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

/** v6's manual projection: GDAL applies the EPSG; zone+band describe a UTM one. */
export interface ManualProjection {
	epsg: string;
	utm: { zone: number; south: boolean } | null;
}

// MGRS latitude bands (no I, no O); v6 reads them through Leaflet.UTM, where
// a band before N is the southern hemisphere (`L.LatLng.UTM.js:604`)
const UTM_BANDS = 'CDEFGHJKLMNPQRSTUVWX';

/**
 * v6's fields, format only (no GDAL). v6's table gives non-UTM codes no zone
 * or band (`special_tools_upload.js:402-406`), so the EPSG may come alone and
 * `assertProjectionMatches` decides per code. A partial set is refused where
 * v6 drops it without a word: a typed field that silently does nothing is
 * the failure these fields exist to prevent.
 */
export function parseManualProjection(options: Record<string, unknown>): ManualProjection | null {
	const epsg = String(options.epsg ?? '').trim();
	const zone = String(options.zone ?? '').trim();
	const band = String(options.band ?? '')
		.trim()
		.toUpperCase();
	if (epsg === '' && zone === '' && band === '') return null;
	if (epsg === '') {
		throw invalidVectorUpload('Zone and band describe an EPSG code: fill in the EPSG too');
	}
	if ((zone === '') !== (band === '')) {
		throw invalidVectorUpload('Zone and band go together: fill in both, or neither');
	}
	if (!/^[0-9]{4,6}$/.test(epsg)) throw invalidVectorUpload(`Invalid EPSG code '${epsg}'`);
	if (zone === '') return { epsg, utm: null };
	const zoneNumber = /^[0-9]{1,2}$/.test(zone) ? Number(zone) : 0;
	if (zoneNumber < 1 || zoneNumber > 60) {
		throw invalidVectorUpload(`Invalid UTM zone '${zone}' (expected 1 to 60)`);
	}
	if (band.length !== 1 || !UTM_BANDS.includes(band)) {
		throw invalidVectorUpload(`Invalid UTM band '${band}' (expected one letter, C to X)`);
	}
	return {
		epsg,
		utm: { zone: zoneNumber, south: UTM_BANDS.indexOf(band) < UTM_BANDS.indexOf('N') },
	};
}

/**
 * The EPSG's own PROJ string (`gdalsrsinfo -o proj4`) decides: a UTM code
 * needs the zone and band that describe it (v6's "include projection for
 * UTM"), any other code takes neither — either way no field is decoration.
 */
export function assertProjectionMatches(projection: ManualProjection, proj4: string): void {
	const zone = /\+proj=utm\b/.test(proj4) ? /\+zone=([0-9]+)/.exec(proj4) : null;
	if (zone === null) {
		if (projection.utm !== null) {
			throw invalidVectorUpload(
				`EPSG:${projection.epsg} is not a UTM projection: leave zone and band empty`,
			);
		}
		return;
	}
	const south = /\+south\b/.test(proj4);
	// in the band's own terms: an MGRS "S" is northern, so "19S" would mislead
	const actual = `UTM zone ${zone[1]}, ${south ? 'southern hemisphere (band C to M)' : 'northern hemisphere (band N to X)'}`;
	if (projection.utm === null) {
		throw invalidVectorUpload(
			`EPSG:${projection.epsg} is ${actual}: fill in its zone and band too`,
		);
	}
	if (Number(zone[1]) !== projection.utm.zone || south !== projection.utm.south) {
		throw invalidVectorUpload(
			`EPSG:${projection.epsg} is ${actual}, not the zone and band given ` +
				`(zone ${projection.utm.zone}, ${projection.utm.south ? 'southern' : 'northern'} hemisphere)`,
		);
	}
}

/**
 * Only PROJ's own "crs not found" is the caller's; a timeout or a broken PROJ
 * install stays the server fault it is (tool.action_failed), rethrown as is.
 */
export function classifyProjectionLookupError(error: unknown, epsg: string): unknown {
	if (error instanceof Error && /crs not found/i.test(error.message)) {
		return invalidVectorUpload(`Unknown EPSG code '${epsg}'`);
	}
	return error;
}

async function checkManualProjection(projection: ManualProjection): Promise<void> {
	const gdalsrsinfo = await resolveGdalBinary('gdalsrsinfo');
	let proj4: string;
	try {
		const result = await runToolBinary(
			[gdalsrsinfo, '-o', 'proj4', `EPSG:${projection.epsg}`],
			'vector_upload (projection lookup)',
		);
		proj4 = result.stdout;
	} catch (error) {
		throw classifyProjectionLookupError(error, projection.epsg);
	}
	assertProjectionMatches(projection, proj4);
}

/**
 * Whether the file names its own CRS. In v6 the file's `crs` always wins and
 * a typed code only matters when it equals it (`projections.js:31-46`); here
 * `-s_srs` would override it silently, so a declaring file refuses the fields
 * instead. A GeoJSON without `crs` counts as undeclared although GDAL reads it
 * as WGS84 (RFC 7946): legacy UTM files without it are what the fields are for.
 */
export async function declaresOwnCrs(inputFile: string, extension: string): Promise<boolean> {
	if (extension === 'kml') return true; // WGS84 by definition
	if (extension === 'geojson') {
		const parsed = (await Bun.file(inputFile)
			.json()
			.catch(() => null)) as { crs?: unknown } | null;
		// fail closed: GDAL's parser accepts what strict JSON refuses, so an
		// unreadable file may still carry a crs that -s_srs would override
		if (parsed === null) {
			throw invalidVectorUpload(
				'This GeoJSON is not strict JSON, so its own projection cannot be checked: ' +
					'leave EPSG, zone and band empty',
			);
		}
		return typeof parsed.crs === 'object' && parsed.crs !== null;
	}
	const ogrinfo = await resolveGdalBinary('ogrinfo');
	const result = await runToolBinary(
		[ogrinfo, '-json', '-so', '-ro', inputFile],
		`vector_upload (${extension} crs probe)`,
	);
	const info = JSON.parse(result.stdout) as {
		layers?: { geometryFields?: { coordinateSystem?: unknown }[] }[];
	};
	return (info.layers ?? []).some((layer) =>
		(layer.geometryFields ?? []).some((field) => field.coordinateSystem != null),
	);
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

	const projection = parseManualProjection(ctx.options);

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

		// the declared-CRS refusal goes BEFORE the EPSG lookup: on a file that
		// declares its own, "fill in its zone and band" would send the user to
		// fill in fields that must end up empty
		if (projection !== null && (await declaresOwnCrs(inputFile, extension))) {
			throw invalidVectorUpload(
				'This file already declares its own projection: leave EPSG, zone and band empty',
			);
		}
		if (projection !== null) await checkManualProjection(projection);

		const ogr2ogr = await resolveGdalBinary('ogr2ogr');
		const argv = [ogr2ogr, '-f', 'GeoJSON', '-t_srs', 'EPSG:4326'];
		if (projection !== null) argv.push('-s_srs', `EPSG:${projection.epsg}`);
		argv.push(outputFile, inputFile);

		try {
			await runToolBinary(argv, `vector_upload (${extension})`, { expectedOutput: outputFile });
		} catch (error) {
			// The one failure GDAL cannot recover from on its own: a source with
			// no embedded CRS and no override given — ogr2ogr's own stderr names
			// it exactly ("has no coordinate system … Use -s_srs", verified live
			// against GDAL 3.13.2, see module doc comment). Matched on the actual
			// message rather than assumed from `projection === null`: a WRONG
			// override (a real CRS, just not this file's) fails differently and
			// must keep its own generic error, not this one.
			const message = error instanceof Error ? error.message : String(error);
			if (projection === null && /coordinate system/i.test(message)) {
				throw invalidVectorUpload(
					'This file has no embedded coordinate system (no .prj / crs member) — ' +
						'provide its EPSG code (and, for a UTM one, its zone and band) to reproject it',
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
