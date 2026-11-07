/**
 * THE GEOMETRY OF A TILE REQUEST — where on the earth a tile or a free image is,
 * in the coordinate system a WMS source declared.
 *
 * A WMS source stores its CRS (geo/map_source.ts: EPSG:3857, EPSG:4326 or
 * EPSG:4258) and the server, not the browser, turns the request into the GetMap
 * bbox:
 *
 *   - a TILE (z, x, y) is placed on the slippy-map grid (Web Mercator, 256 px) and
 *     its corners are expressed in the source's CRS. For EPSG:3857 that is exact.
 *     For the geographic CRSs the tile's longitude/latitude corners are asked for, and the
 *     picture that comes back is a PLATE CARRÉE crop: latitude runs linearly down its 256
 *     rows, while the map draws it as a mercator tile, where latitude is not linear. The two
 *     agree better the smaller the tile: the worst vertical misregistration over a tile is
 *     about 47 px at zoom 2, 12 px at 4, 3 px at 6, under 1 px from zoom 8 and under 0.2 px
 *     from zoom 10. (This is NOT what Leaflet's own WMS layer does: it asks the service for
 *     the MAP's CRS, EPSG:3857 here, and projects the tile bounds itself. A source that only
 *     offers a geographic CRS cannot be asked that way, which is why it is relayed at all.)
 *     Below `GEOGRAPHIC_TILE_MIN_ZOOM` a tile view of a geographic-CRS source is therefore
 *     REFUSED by the caller (upstream_url.ts), not relayed misregistered; a FREE IMAGE view
 *     carries its own bbox and size and is not affected. (EPSG:4258 is ETRS89, a geographic
 *     CRS the Web Mercator world treats as WGS 84 to well under a metre.)
 *   - a FREE IMAGE (bbox, width, height) carries its own bbox, and is checked to be
 *     a real, non-empty box inside the CRS's world.
 *
 * AXIS ORDER is the server's business too. The request always says
 * minx,miny,maxx,maxy with x the easting / longitude. WMS 1.3.0 reverses the two
 * axes of a geographic CRS (latitude first); 1.1.1 never does. Doing it here, once,
 * means no client has to know the rule — the commonest way a WMS layer comes back
 * blank.
 *
 * PURE. Numbers leave as plain decimals (never an exponent), because a few WMS
 * servers read `1e-7` as a different parameter.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';
import { type Checked, fail, pass } from '../checked.ts';
import type { WmsCrs, WmsVersion } from '../map_source.ts';
import type { Bbox } from './tile_request.ts';

/** Half the width of the Web Mercator world, in metres. */
const MERCATOR_HALF_WORLD = 20037508.342789244;
/** A little slack for the float noise of an edge tile computed in the browser. */
const MERCATOR_TOLERANCE = 0.01;
/** Decimals kept in a coordinate (about a nanometre of a metre, a hundred-nanodegree of a degree). */
const DECIMALS = 9;

const GEOGRAPHIC_CRS: ReadonlySet<WmsCrs> = new Set<WmsCrs>(['EPSG:4326', 'EPSG:4258']);

/**
 * The first zoom at which a plate carrée crop of a tile sits within a pixel of the mercator
 * tile it is drawn as (the worst case, at the tile nearest a pole, is 0.78 px; one zoom
 * below it is 1.56 px). The gate measures this from the geometry rather than trusting the
 * number (map_tile_geometry_native).
 */
export const GEOGRAPHIC_TILE_MIN_ZOOM = 8;

/** True when `crs` is a geographic one (latitude/longitude in degrees). */
export function isGeographicCrs(crs: WmsCrs): boolean {
	return GEOGRAPHIC_CRS.has(crs);
}

/** The bbox of slippy-map tile (z, x, y) in `crs`, as minx, miny, maxx, maxy. */
export function tileBbox(crs: WmsCrs, z: number, x: number, y: number): Bbox {
	const grid = 2 ** z;
	if (crs === 'EPSG:3857') {
		const size = (2 * MERCATOR_HALF_WORLD) / grid;
		const minx = -MERCATOR_HALF_WORLD + x * size;
		const maxy = MERCATOR_HALF_WORLD - y * size;
		return [minx, maxy - size, minx + size, maxy];
	}
	return [
		tileLongitude(x, grid),
		tileLatitude(y + 1, grid),
		tileLongitude(x + 1, grid),
		tileLatitude(y, grid),
	];
}

/** The longitude, in degrees, of the west edge of column `x` of a `grid`-wide world. */
function tileLongitude(x: number, grid: number): number {
	return (x / grid) * 360 - 180;
}

/** The latitude, in degrees, of the north edge of row `y` of a `grid`-high world. */
function tileLatitude(y: number, grid: number): number {
	const radians = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / grid)));
	return (radians * 180) / Math.PI;
}

/** The world a CRS covers, as [minx, miny, maxx, maxy]. */
function worldOf(crs: WmsCrs): Bbox {
	return crs === 'EPSG:3857'
		? [-MERCATOR_HALF_WORLD, -MERCATOR_HALF_WORLD, MERCATOR_HALF_WORLD, MERCATOR_HALF_WORLD]
		: [-180, -90, 180, 90];
}

/** `value` inside `[low, high]`, with the CRS's tolerance. */
function within(value: number, low: number, high: number, tolerance: number): boolean {
	return value >= low - tolerance && value <= high + tolerance;
}

/** Both ends of one axis inside the world's span on it. */
function axisInside(low: number, high: number, spanLow: number, spanHigh: number, slack: number) {
	return within(low, spanLow, spanHigh, slack) && within(high, spanLow, spanHigh, slack);
}

/** True when the box lies inside the world of `crs`. */
function insideWorld(crs: WmsCrs, [minx, miny, maxx, maxy]: Bbox): boolean {
	const [worldMinX, worldMinY, worldMaxX, worldMaxY] = worldOf(crs);
	const slack = crs === 'EPSG:3857' ? MERCATOR_TOLERANCE : 0;
	return (
		axisInside(minx, maxx, worldMinX, worldMaxX, slack) &&
		axisInside(miny, maxy, worldMinY, worldMaxY, slack)
	);
}

/** A free image's bbox: finite, a real box, inside the CRS's world. */
export function checkBbox(crs: WmsCrs, bbox: Bbox): Checked<Bbox> {
	const [minx, miny, maxx, maxy] = bbox;
	if (![minx, miny, maxx, maxy].every(Number.isFinite)) return fail('bbox: not finite');
	if (minx >= maxx || miny >= maxy) return fail('bbox: empty or inverted');
	return insideWorld(crs, bbox) ? pass(bbox) : fail('bbox: outside the world of its CRS');
}

/** The largest magnitude `plainDecimal` writes: past it `toFixed` switches to an exponent. */
const MAX_PLAIN = 1e15;

/**
 * A number as a plain decimal, trailing zeros trimmed (`-0` is `0`). It never writes an
 * exponent: a value that cannot be written plainly is a defect in the caller, which
 * validates first (`checkBbox`, the tile grid), so it throws instead of emitting `1e+21`.
 */
export function plainDecimal(value: number): string {
	if (!Number.isFinite(value) || Math.abs(value) >= MAX_PLAIN) {
		throw new DedaloError('internal.invariant', {
			message: 'plainDecimal: not a number that can be written without an exponent',
		});
	}
	const fixed = value.toFixed(DECIMALS);
	const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
	return trimmed === '-0' ? '0' : trimmed;
}

/** True when WMS `version` reverses the axes of `crs` (1.3.0 and a geographic CRS: latitude first). */
export function reversesAxes(version: WmsVersion, crs: WmsCrs): boolean {
	return version === '1.3.0' && isGeographicCrs(crs);
}

/** The `bbox` parameter value for a GetMap request, in the axis order the version and CRS ask for. */
export function bboxParameter(version: WmsVersion, crs: WmsCrs, bbox: Bbox): string {
	const [minx, miny, maxx, maxy] = bbox;
	const ordered = reversesAxes(version, crs) ? [miny, minx, maxy, maxx] : [minx, miny, maxx, maxy];
	return ordered.map(plainDecimal).join(',');
}
