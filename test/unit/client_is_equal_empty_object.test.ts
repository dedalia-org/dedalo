/**
 * DEEP EQUALITY OF EMPTY OBJECTS — client/dedalo/core/common/js/utils/util.js
 *
 * `object_equals` skipped its key walk for an object with no keys and fell back to `===`,
 * so `is_equal({}, {})` was FALSE: any value holding an empty object never equalled its own
 * clone. Seen as the geolocation orange `.modified` line that a reload could not clear (a
 * stored GeoJSON point carries `properties: {}`), and it equally broke component_common's
 * two unchanged-guards (the save skip and set_changed_data's revert detection).
 *
 * PINNED: empty plain objects (also null-prototype) are equal at any depth; a clone of a
 * value with one equals it; key-less NON-plain objects (Date) stay compared by reference;
 * an empty object never equals an empty array, null, or an object with keys.
 *
 * HARNESS: util.js imported REAL; ui.js and instances.js masked (they reach for a DOM).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE: this file substitutes process-global client modules (see the helper).
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_COMMON = join(
		import.meta.dir,
		'..',
		'..',
		'client',
		'dedalo',
		'core',
		'common',
		'js',
	);

	type IsEqual = (a: unknown, b: unknown) => boolean;
	let is_equal: IsEqual;

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};

	beforeAll(async () => {
		for (const key of ['window', 'page_globals', 'SHOW_DEBUG', 'DEDALO_CORE_URL', 'get_label'])
			saved[key] = globals[key];
		globals.window = globalThis;
		globals.page_globals = {
			dedalo_data_lang: 'lg-eng',
			dedalo_data_nolan: 'lg-nolan',
			stream_readers: [],
		};
		globals.SHOW_DEBUG = false;
		globals.DEDALO_CORE_URL = '/dedalo/core';
		globals.get_label = {};

		mock.module(join(CLIENT_COMMON, 'ui.js'), () => ({ ui: {} }));
		mock.module(join(CLIENT_COMMON, 'instances.js'), () => ({
			get_all_instances: () => [],
			get_instances_custom_map: () => new Map(),
			add_instance: () => {},
			get_instance_by_id: () => undefined,
			find_instances: () => [],
			delete_instance: () => true,
			delete_instances: () => 0,
			key_instances_builder: () => '',
			get_instance: async () => ({}),
		}));

		({ is_equal } = (await import(join(CLIENT_COMMON, 'utils', 'util.js'))) as {
			is_equal: IsEqual;
		});
	});

	afterAll(() => {
		mock.restore();
		for (const [key, value] of Object.entries(saved)) globals[key] = value;
	});

	describe('is_equal: empty objects', () => {
		test('two distinct empty plain objects are equal (also null-prototype)', () => {
			expect(is_equal({}, {})).toBe(true);
			expect(is_equal(Object.create(null), {})).toBe(true);
		});

		test('a value holding an empty object equals its clone (the geolocation feature)', () => {
			const stored = {
				lat: 41.5,
				alt: 0,
				lib_data: [
					{
						layer_id: 1,
						layer_data: {
							type: 'FeatureCollection',
							features: [
								{
									type: 'Feature',
									geometry: { type: 'Point', coordinates: [-3, 41] },
									properties: {},
								},
							],
						},
					},
				],
			};
			expect(is_equal(structuredClone(stored), stored)).toBe(true);
		});

		test('still unequal where it must be', () => {
			expect(is_equal({}, { a: 1 })).toBe(false);
			expect(is_equal({ a: 1 }, {})).toBe(false);
			expect(is_equal({}, [])).toBe(false);
			expect(is_equal({}, null)).toBe(false);
			expect(is_equal({ p: {} }, { p: { x: 0 } })).toBe(false);
		});

		test('key-less non-plain objects stay compared by reference (Date)', () => {
			const d = new Date(0);
			expect(is_equal(d, d)).toBe(true);
			expect(is_equal(new Date(0), new Date(1))).toBe(false);
		});
	});
}
