/**
 * Shared click-position parsing for `catastro.ts`/`administrative_units.ts`
 * (rows #8/#9): both proxy a WMS GetFeatureInfo query built from the SAME
 * five numbers the client already has after a map click — the visible bbox,
 * the map's pixel size, and the clicked pixel. One parser, one shape, so a
 * malformed request is refused identically for both actions instead of two
 * near-duplicate ad hoc checks drifting apart.
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
