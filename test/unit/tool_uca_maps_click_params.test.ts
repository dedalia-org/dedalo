/**
 * tool_uca_maps — `parseClickParams`, the click payload both Catastro and the
 * administrative units turn into a query. Pure, no network.
 */

import { describe, expect, test } from 'bun:test';
import { parseClickParams } from '../../tools/tool_uca_maps/server/click_params.ts';

const VALID = { bbox: [-1, 38, -0.9, 38.1], width: 512, height: 400, x: 128, y: 64 };

describe('parseClickParams', () => {
	test('a valid payload round-trips unchanged', () => {
		expect(parseClickParams(VALID)).toEqual({
			bbox: [-1, 38, -0.9, 38.1],
			width: 512,
			height: 400,
			x: 128,
			y: 64,
		});
	});

	test('a missing/malformed bbox is refused', () => {
		expect(() => parseClickParams({ ...VALID, bbox: undefined })).toThrow(/bounding box/);
		expect(() => parseClickParams({ ...VALID, bbox: [1, 2, 3] })).toThrow(/bounding box/);
		expect(() => parseClickParams({ ...VALID, bbox: [1, 2, 3, 'x'] })).toThrow(/bounding box/);
		// both would ship to the third party as text in the bbox param
		expect(() => parseClickParams({ ...VALID, bbox: [1, 2, 3, Number.NaN] })).toThrow(
			/bounding box/,
		);
		expect(() => parseClickParams({ ...VALID, bbox: [1, 2, 3, Infinity] })).toThrow(/bounding box/);
	});

	test('a non-positive or missing width/height is refused', () => {
		expect(() => parseClickParams({ ...VALID, width: 0 })).toThrow(/map size/);
		expect(() => parseClickParams({ ...VALID, height: -1 })).toThrow(/map size/);
		expect(() => parseClickParams({ ...VALID, width: undefined })).toThrow(/map size/);
	});

	test('a missing/non-finite click position is refused', () => {
		expect(() => parseClickParams({ ...VALID, x: undefined })).toThrow(/click position/);
		expect(() => parseClickParams({ ...VALID, y: Number.NaN })).toThrow(/click position/);
	});
});
