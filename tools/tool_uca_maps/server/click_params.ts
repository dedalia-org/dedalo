/**
 * The click payload `catastro.ts` and `administrative_units.ts` both turn into
 * core's WMS GetFeatureInfo question: visible bbox, map pixel size, clicked
 * pixel. One parser and one question, so both actions refuse and ask alike.
 */

import { invalidOptions } from './reasons.ts';
import { mercatorY, toWebMercator } from './web_mercator.ts';

export interface ClickParams {
	bbox: [number, number, number, number]; // [west, south, east, north]
	width: number;
	height: number;
	x: number;
	y: number;
}

/** Parses+vets the client's click payload. Throws on anything malformed. */
export function parseClickParams(options: Record<string, unknown>): ClickParams {
	const bbox = options.bbox;
	if (
		!Array.isArray(bbox) ||
		bbox.length !== 4 ||
		!bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
	) {
		throw invalidOptions('A valid bounding box is required.');
	}
	const width = Number(options.width);
	const height = Number(options.height);
	const x = Number(options.x);
	const y = Number(options.y);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw invalidOptions('A valid map size is required.');
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw invalidOptions('A valid click position is required.');
	}
	return { bbox: bbox as [number, number, number, number], width, height, x, y };
}

/**
 * The clicked [lat, lon]: the map is Web Mercator, so a pixel is linear in
 * longitude but not in latitude. Exported for unit coverage.
 */
export function clickedPoint({ bbox, height, width, x, y }: ClickParams): [number, number] {
	const [west, south, east, north] = bbox;
	const top = mercatorY(north);
	const yAt = top - (y / height) * (top - mercatorY(south));
	const lat = (Math.atan(Math.sinh(yAt)) * 180) / Math.PI;
	return [lat, west + (x / width) * (east - west)];
}

/**
 * The feature-info question for one point: a 100 m box around it in EPSG:3857
 * at one metre a pixel, the point at its centre. Asking for the user's whole
 * view would refuse a wide one (core caps the box): only the clicked point
 * matters. Exported for unit coverage.
 */
export function featureInfoQuery([lat, lon]: [number, number]): Record<string, unknown> {
	const [x, y] = toWebMercator([lat, lon]);
	return {
		crs: 'EPSG:3857',
		bbox: [x - 50, y - 50, x + 50, y + 50],
		width: 101,
		height: 101,
		i: 50,
		j: 50,
	};
}
