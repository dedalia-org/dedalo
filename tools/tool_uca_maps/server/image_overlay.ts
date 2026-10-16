/**
 * get_image_overlay — where on the map an uploaded image goes. v6 parsed the
 * GeoTIFF in the browser with georaster to read its corners; `gdalinfo -json`
 * answers here. They are the three `L.imageOverlay.rotated` takes, not a bbox:
 * a projected rectangle reprojected to WGS84 is a skewed quadrilateral.
 */

import { existsSync } from 'node:fs';
import { ok } from '../../../src/core/errors/index.ts';
import { buildMediaLocation } from '../../../src/core/media/path.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { isMissingGdalBinary, readGdalInfoJson, withScratchDir } from './gdal.ts';
import { resolveRenderableImage } from './image_media.ts';

// exported for the unit gate
/** Extensions worth asking GDAL about. Only a TIFF carries georeferencing
 * through Dédalo's ingest; a JPEG's EXIF GPS tag is a camera POSITION, not an
 * image footprint, and placing an overlay on it would be wrong, not partial. */
export const GEOREFERENCED_EXTENSIONS: readonly string[] = ['tif', 'tiff'];

/** One corner, `[lat, lon]` — the order `L.latLng` takes. */
type Corner = [number, number];

interface OverlayCorners {
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
 * Ask GDAL where the file sits, read in place. A TIFF with no CRS has no
 * `wgs84Extent`: null, and the client places it over the viewport (v6 parity).
 * A TIFF GDAL cannot open throws: a broken or misnamed file, which v6 refuses
 * too rather than dropping it somewhere on screen.
 */
export async function readGeoreference(absolutePath: string): Promise<OverlayCorners | null> {
	const parsed = await withScratchDir((dir) =>
		readGdalInfoJson(dir, absolutePath, 'gdalinfo (image overlay georeference)'),
	);
	if (typeof parsed !== 'object' || parsed === null) return null;
	return cornersFromWgs84Extent((parsed as { wgs84Extent?: unknown }).wgs84Extent);
}

// exported for the unit gate
/**
 * What a failed georeference read leaves the answer with. GDAL missing is the
 * one failure swallowed, into the flag the client renders: the media is
 * already written, so an error would leave an uploaded image the user is told
 * nothing useful about. Any other failure (a .tif GDAL cannot open) is rethrown.
 */
export function overlayFallbackOf(error: unknown): {
	corners: null;
	georeferenceUnavailable: true;
} {
	if (isMissingGdalBinary(error, 'gdalinfo'))
		return { corners: null, georeferenceUnavailable: true };
	throw error;
}

/**
 * GET_IMAGE_OVERLAY — the served path and map footprint of an ingested image.
 * Options name the IMAGE component, not the map record, so the `record_tipo`
 * gate asks whether the caller may read the media path the answer names.
 */
export async function getImageOverlay(ctx: ToolActionContext): Promise<ToolResponse> {
	// WHICH file is served is `image_media.ts`'s single answer, shared with
	// `get_image_file` so the two can never disagree about the tier
	const { spec, identity, pathOpts, files_info, served } = await resolveRenderableImage(
		ctx.options,
	);

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
			try {
				corners = await readGeoreference(location.absolutePath);
			} catch (error) {
				({ corners, georeferenceUnavailable } = overlayFallbackOf(error));
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
