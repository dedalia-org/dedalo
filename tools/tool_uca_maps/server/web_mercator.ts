/**
 * web_mercator — EPSG:3857, the map's own grid: spherical Mercator on the WGS84
 * equatorial radius, as Leaflet projects.
 */

const EARTH_RADIUS = 6378137;

/** Leaflet's `SphericalMercator.MAX_LATITUDE`, where the grid is square: past
 * it the projection runs to Infinity at the pole. */
export const MAX_LATITUDE = 85.0511287798;

/** Latitude in degrees → Mercator y on the unit sphere. */
export function mercatorY(lat: number): number {
	return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/** [lat, lon] → EPSG:3857 [x, y] metres, the latitude clamped to the grid. */
export function toWebMercator([lat, lon]: [number, number]): [number, number] {
	const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
	return [(EARTH_RADIUS * lon * Math.PI) / 180, EARTH_RADIUS * mercatorY(clamped)];
}
