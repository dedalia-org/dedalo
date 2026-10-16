/**
 * The click payload `catastro.ts` and `administrative_units.ts` both turn into
 * a WMS GetFeatureInfo query: visible bbox, map pixel size, clicked pixel. One
 * parser, so a malformed click is refused the same way by both actions.
 */

import { DedaloError } from '../../../src/core/errors/index.ts';

export interface ClickParams {
	bbox: [number, number, number, number]; // [west, south, east, north]
	width: number;
	height: number;
	x: number;
	y: number;
}

function invalidClickRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** Parses+vets the client's click payload. Throws on anything malformed. */
export function parseClickParams(options: Record<string, unknown>): ClickParams {
	const bbox = options.bbox;
	if (
		!Array.isArray(bbox) ||
		bbox.length !== 4 ||
		!bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
	) {
		throw invalidClickRequest('A valid bounding box is required.');
	}
	const width = Number(options.width);
	const height = Number(options.height);
	const x = Number(options.x);
	const y = Number(options.y);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw invalidClickRequest('A valid map size is required.');
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw invalidClickRequest('A valid click position is required.');
	}
	return { bbox: bbox as [number, number, number, number], width, height, x, y };
}
