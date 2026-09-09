/**
 * image_overlay — fila #11 ("Upload file to map"), IMAGE half (hito 13; the
 * vector half is `vector_upload.ts`, hito 12).
 *
 * The file itself never passes through this action. The client uploads it
 * through the engine's OWN media door — a fresh `rsc170` (Resources/Image)
 * record + its `rsc29` component_image, staged by `service_upload` and
 * ingested by `tool_upload::process_uploaded_file` — exactly as v6 does
 * (`render_tool_leaflet_special_tools.js:1541`). So by the time this action
 * runs the image is already real, protected media with a served path.
 *
 * What is left is the ONE question the browser cannot answer: WHERE on the
 * map does this image go. v6 answers it by downloading the raw GeoTIFF back
 * into the browser and parsing it there with `georaster` +
 * `georaster-layer-for-leaflet` — two heavy libraries pulled in to read four
 * corner coordinates. This server already has GDAL (hito 3), and `gdalinfo
 * -json` reports `wgs84Extent` directly, so both libraries disappear from the
 * client entirely. Same trade the vector half already made.
 *
 * The corners are returned as the THREE points `L.imageOverlay.rotated` takes
 * (NW / NE / SW), not a bbox: a GeoTIFF is georeferenced in a projected CRS
 * (UTM here), and a projected rectangle reprojected to WGS84 is a skewed
 * quadrilateral, never an axis-aligned lat/lon box. A bbox would misplace
 * every pixel inside it.
 *
 * A non-georeferenced upload (.jpg/.png, or a .tif with no CRS) is NOT an
 * error: it answers `georeferenced:false` and the client places it over the
 * current viewport, v6 parity.
 *
 * NOR is an install with no GDAL. By the time this action runs the record and
 * the media are already written; hard-failing here would leave the user with
 * an error and an image they cannot see. It answers `georeferenced:false`
 * plus `georeference_unavailable:true` — the SAME distinction
 * `get_capabilities` already draws — so the client can say "this server
 * cannot read a GeoTIFF's coordinates" instead of the flat "this image has
 * none". Degraded, and it says so.
 */

import { existsSync } from 'node:fs';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { scanContextFromItem, scanFilesInfo } from '../../../src/core/media/files_info.ts';
import { buildMediaLocation } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { resolveGdalBinary, runToolBinary } from './gdal.ts';

/** What a browser can put in an `<img>`. The overlay is drawn from ONE of
 * these, never from the raw master (`.tif`/`.psd` render nowhere). */
const OVERLAY_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];

/** Extensions worth asking GDAL about. Only a TIFF carries georeferencing
 * through Dédalo's ingest; a JPEG's EXIF GPS tag is a camera POSITION, not an
 * image footprint, and placing an overlay on it would be wrong, not partial. */
const GEOREFERENCED_EXTENSIONS: readonly string[] = ['tif', 'tiff'];

/** One corner, `[lat, lon]` — the order `L.latLng` takes. */
type Corner = [number, number];

export interface OverlayCorners {
	top_left: Corner;
	top_right: Corner;
	bottom_left: Corner;
}

/**
 * The three corners of a GDAL `wgs84Extent` polygon, or null when the file
 * carries no CRS. GDAL emits the ring counter-clockwise from the upper-left
 * (upperLeft, lowerLeft, lowerRight, upperRight, upperLeft) in `[lon, lat]`
 * GeoJSON order — the ring is closed, so a 5th point repeats the 1st.
 */
export function cornersFromWgs84Extent(extent: unknown): OverlayCorners | null {
	if (typeof extent !== 'object' || extent === null) return null;
	const coordinates = (extent as { coordinates?: unknown }).coordinates;
	if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0])) return null;
	const ring = coordinates[0] as unknown[];
	if (ring.length < 4) return null;
	const point = (index: number): Corner | null => {
		const raw = ring[index];
		if (!Array.isArray(raw) || raw.length < 2) return null;
		const lon = Number(raw[0]);
		const lat = Number(raw[1]);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
		return [lat, lon];
	};
	const upper_left = point(0);
	const lower_left = point(1);
	const upper_right = point(3);
	if (upper_left === null || lower_left === null || upper_right === null) return null;
	return { top_left: upper_left, top_right: upper_right, bottom_left: lower_left };
}

/**
 * Ask GDAL where the file sits. `-json` only: no conversion, no write, no
 * scratch dir — this reads metadata off a file the engine's own ingest
 * already put in place.
 *
 * Two outcomes, both deliberate. A TIFF GDAL opens but that carries no CRS
 * exits 0 and simply has no `wgs84Extent` → null, and the caller places the
 * image over the viewport instead. A TIFF GDAL cannot open at all THROWS
 * (`runToolBinary` asserts the exit code): that is a broken or misnamed file,
 * and v6 refuses it too rather than silently dropping it somewhere on screen.
 */
export async function readGeoreference(absolutePath: string): Promise<OverlayCorners | null> {
	const gdalinfo = await resolveGdalBinary('gdalinfo');
	const result = await runToolBinary(
		[gdalinfo, '-json', absolutePath],
		'gdalinfo (image overlay georeference)',
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'gdalinfo -json returned output that is not JSON',
		});
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	return cornersFromWgs84Extent((parsed as { wgs84Extent?: unknown }).wgs84Extent);
}

/**
 * GET_IMAGE_OVERLAY — resolve the served path + map footprint of an image
 * already ingested into a component_image record.
 *
 * Options: `tipo` / `section_tipo` / `section_id` — the IMAGE component's
 * identity (rsc29/rsc170/<new id>), not the map record's. The `record_tipo`
 * gate therefore asserts the caller may read that image section, which is the
 * right question: the answer names a media path they will then load.
 */
export async function getImageOverlay(ctx: ToolActionContext): Promise<ToolResponse> {
	const { spec, identity, pathOpts, items } = await resolveMediaToolContext(ctx.options);
	if (spec.model !== 'component_image') {
		throw new DedaloError('request.invalid_model', {
			message: `tool_uca_maps: an image overlay needs a component_image, got '${spec.model}'`,
			publicMessage: 'Only an image component can be placed on the map.',
			coordinates: { component_tipo: identity.componentTipo, model: spec.model },
		});
	}

	const files_info = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(items[0]));

	// The overlay is drawn from the WEB tier when the ingest built one (the
	// normal case: a .tif upload lands in `original/` and its jpg derivative
	// in the default quality), and only falls back to another existing,
	// browser-renderable tier when it did not.
	const renderable = files_info.filter(
		(entry) =>
			entry.file_exist &&
			typeof entry.file_path === 'string' &&
			OVERLAY_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	const served = renderable.find((entry) => entry.quality === spec.defaultQuality) ?? renderable[0];
	if (!served || typeof served.file_path !== 'string') {
		throw new DedaloError('tool.target_not_found', {
			message: `tool_uca_maps: no renderable image file for ${identity.componentTipo}_${identity.sectionTipo}_${identity.sectionId}`,
			publicMessage: 'The uploaded image has no version this browser can display.',
			coordinates: { section_tipo: identity.sectionTipo, section_id: identity.sectionId },
		});
	}

	// Georeference is read from the MASTER, never from the served derivative:
	// the jpg the ingest built carries no CRS at all.
	const master = files_info.find(
		(entry) =>
			entry.file_exist &&
			spec.masterQualities.includes(entry.quality) &&
			GEOREFERENCED_EXTENSIONS.includes(String(entry.extension ?? '').toLowerCase()),
	);
	let corners: OverlayCorners | null = null;
	let georeferenceUnavailable = false;
	if (master && typeof master.extension === 'string') {
		const location = buildMediaLocation(spec, identity, master.quality, master.extension, pathOpts);
		if (existsSync(location.absolutePath)) {
			// GDAL missing is the ONE failure this swallows, and only into a
			// named flag the client renders (see the module doc): the media is
			// already written, so throwing here would leave an uploaded image
			// the user is told nothing useful about. Every OTHER gdalinfo
			// failure still throws — a .tif GDAL cannot open is a broken file.
			try {
				corners = await readGeoreference(location.absolutePath);
			} catch (error) {
				if (error instanceof DedaloError && error.code === 'tool.dependency_unavailable') {
					georeferenceUnavailable = true;
				} else {
					throw error;
				}
			}
		}
	}

	return ok(
		{
			file_path: served.file_path,
			quality: served.quality,
			georeferenced: corners !== null,
			georeference_unavailable: georeferenceUnavailable,
			corners,
		},
		{ requestId: toolRequestId(ctx) },
	);
}
