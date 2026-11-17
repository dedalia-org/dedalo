/**
 * web_mercator — EPSG:3857, the map's own grid: spherical Mercator on the WGS84
 * equatorial radius, as Leaflet projects. `pdf_report.ts` keeps turf's variant
 * on purpose (a rounded half-world, a pole clamp): it gives other numbers.
 */

const EARTH_RADIUS = 6378137;

/** Latitude in degrees → Mercator y on the unit sphere. */
export function mercatorY(lat: number): number {
	return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/** [lat, lon] → EPSG:3857 [x, y] metres. */
export function toWebMercator([lat, lon]: [number, number]): [number, number] {
	return [(EARTH_RADIUS * lon * Math.PI) / 180, EARTH_RADIUS * mercatorY(lat)];
}
