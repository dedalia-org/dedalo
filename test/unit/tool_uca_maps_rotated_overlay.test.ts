/**
 * tool_uca_maps — `js/rotated_image_overlay.js` `corner_transform`, the matrix
 * that decides where every pixel of an uploaded image lands. A swapped column
 * mirrors or transposes the picture and still paints something, so nothing else
 * fails: the gate maps the picture's own corners and checks each one.
 */

import { describe, expect, test } from 'bun:test';
import { corner_transform } from '../../tools/tool_uca_maps/js/rotated_image_overlay.js';

type Point = { x: number; y: number };

/** Where picture pixel `p` lands in layer pixels: the box origin plus the matrix applied to it. */
function land(t: ReturnType<typeof corner_transform>, p: Point): Point {
	const [a, b, c, d, e, f] = t.matrix as [number, number, number, number, number, number];
	return {
		x: t.min.x + a * p.x + c * p.y + e,
		y: t.min.y + b * p.x + d * p.y + f,
	};
}

function expectPoint(actual: Point, expected: Point): void {
	expect(actual.x).toBeCloseTo(expected.x, 9);
	expect(actual.y).toBeCloseTo(expected.y, 9);
}

// rotated, skewed and reaching left of / above its top-left corner, so the box
// origin is NOT the top-left corner and the translation column is exercised
const CASES: { name: string; tl: Point; tr: Point; bl: Point; w: number; h: number }[] = [
	{
		name: 'axis-aligned',
		tl: { x: 10, y: 20 },
		tr: { x: 110, y: 20 },
		bl: { x: 10, y: 70 },
		w: 200,
		h: 100,
	},
	{
		name: 'rotated and skewed',
		tl: { x: 40, y: 5 },
		tr: { x: 130, y: 45 },
		bl: { x: -15, y: 90 },
		w: 640,
		h: 480,
	},
	{
		name: 'turned upside down',
		tl: { x: 300, y: 200 },
		tr: { x: 100, y: 210 },
		bl: { x: 290, y: 20 },
		w: 37,
		h: 911,
	},
];

describe('tool_uca_maps corner_transform — the picture lands on its corners', () => {
	for (const c of CASES) {
		test(`${c.name}: the three corners land where they were given, the fourth closes the parallelogram`, () => {
			const t = corner_transform(c.tl, c.tr, c.bl, c.w, c.h);
			expectPoint(land(t, { x: 0, y: 0 }), c.tl);
			expectPoint(land(t, { x: c.w, y: 0 }), c.tr);
			expectPoint(land(t, { x: 0, y: c.h }), c.bl);
			expectPoint(land(t, { x: c.w, y: c.h }), {
				x: c.tr.x + c.bl.x - c.tl.x,
				y: c.tr.y + c.bl.y - c.tl.y,
			});
		});

		test(`${c.name}: the box is exactly the hull of the four corners`, () => {
			const t = corner_transform(c.tl, c.tr, c.bl, c.w, c.h);
			const br = { x: c.tr.x + c.bl.x - c.tl.x, y: c.tr.y + c.bl.y - c.tl.y };
			const xs = [c.tl.x, c.tr.x, c.bl.x, br.x];
			const ys = [c.tl.y, c.tr.y, c.bl.y, br.y];
			expect(t.min).toEqual({ x: Math.min(...xs), y: Math.min(...ys) });
			expect(t.size).toEqual({
				x: Math.max(...xs) - Math.min(...xs),
				y: Math.max(...ys) - Math.min(...ys),
			});
		});
	}

	test('an axis-aligned picture at half its size is a pure scale, no rotation, no shift', () => {
		const t = corner_transform({ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 10, y: 70 }, 200, 100);
		expect(t.matrix).toEqual([0.5, 0, 0, 0.5, 0, 0]);
	});

	test('a picture with no size yet (not loaded) gets its box but no matrix', () => {
		const sizes: [number, number][] = [
			[0, 100],
			[200, 0],
			[Number.NaN, 100],
		];
		for (const [w, h] of sizes) {
			const t = corner_transform({ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 10, y: 70 }, w, h);
			expect(t.matrix).toBeNull();
			expect(t.min).toEqual({ x: 10, y: 20 });
			expect(t.size).toEqual({ x: 100, y: 50 });
		}
	});
});
