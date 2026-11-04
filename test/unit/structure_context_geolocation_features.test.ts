/**
 * GATE — component_geolocation context.features (geo_provider + default_view).
 *
 * `features.default_view` is a WIRE KEY the client depends on: it is the map's
 * opening CAMERA on a record that stores no coordinate (WC-2026-08-08-
 * geolocation-emptiness-explicit). It is TS-only — PHP emitted no such key,
 * because PHP fabricated a stored coordinate instead — so no parity gate can
 * pin it and it needs a native one. Without this file, deleting or renaming the
 * key, or dropping the properties override, is silently green.
 *
 * Asserted here:
 *   1. the FULL context carries {lat,lon,zoom} from config (exact shape);
 *   2. the SIMPLE context (addRequestConfig:false) carries no features at all —
 *      list/portal views render no interactive map;
 *   3. an instance properties.default_view overrides the config camera,
 *      all-or-nothing, accepting numbers AND numeric strings (the client's
 *      fn_finite_number coerces; server and client must agree), range-checked;
 *   4. CACHE SAFETY: features is stamped on the FRESH entry, never on the shared
 *      cached core — a leak there bleeds across requests, so a simple build
 *      AFTER a full build must still come back featureless.
 *
 * Fixture: test3/test100 (the playground geolocation component). Read-only.
 */

import { describe, expect, test } from 'bun:test';
// Preload the component-model registry (buildStructureContext resolves models).
import '../../src/core/components/registry.ts';
import { config } from '../../src/config/config.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';

const GEO = { tipo: 'test100', sectionTipo: 'test3', mode: 'edit', lang: 'lg-spa', permissions: 3 };

const WORLD_VIEW = {
	lat: config.geoDefaultView.lat,
	lon: config.geoDefaultView.lon,
	zoom: config.geoDefaultView.zoom,
};

function featuresOf(entry: Awaited<ReturnType<typeof buildStructureContext>>) {
	return entry?.features as
		| { geo_provider?: unknown; default_view?: { lat: number; lon: number; zoom: number } }
		| undefined;
}

/** Build the geolocation context with an optional properties override. */
async function geoFeatures(propertiesOverride?: Record<string, unknown>) {
	return featuresOf(
		await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			propertiesOverride,
		}),
	);
}

describe('component_geolocation context.features', () => {
	test('the FULL context carries geo_provider AND default_view from config', async () => {
		const features = await geoFeatures();
		expect(features).toBeDefined();
		expect(features?.geo_provider).toBe(config.geoProvider);
		// Exact shape: {lat,lon,zoom} and nothing else (no alt — a camera has no
		// altitude, and the client reads the three keys positionally).
		expect(features?.default_view).toEqual(WORLD_VIEW);
		expect(Object.keys(features?.default_view ?? {}).sort()).toEqual(['lat', 'lon', 'zoom']);
		for (const value of Object.values(features?.default_view ?? {})) {
			expect(typeof value).toBe('number');
		}
	});

	test('the SIMPLE context (addRequestConfig:false) emits NO features', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			addRequestConfig: false,
		});
		expect(entry).toBeDefined();
		expect(featuresOf(entry)).toBeUndefined();
	});

	test('CACHE SAFETY: a full build never leaks features onto the shared cached core', async () => {
		// Order is the point: full FIRST (populates the cached core), simple
		// second. A features object stamped on the cached core would surface here.
		expect(await geoFeatures()).toBeDefined();
		const simple = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			addRequestConfig: false,
		});
		expect(featuresOf(simple)).toBeUndefined();
		// And the full build is still correct after the simple one (no erosion).
		expect((await geoFeatures())?.default_view).toEqual(WORLD_VIEW);
	});

	test('properties.default_view overrides the config camera', async () => {
		const features = await geoFeatures({ default_view: { lat: 41.65, lon: -4.72, zoom: 9 } });
		expect(features?.default_view).toEqual({ lat: 41.65, lon: -4.72, zoom: 9 });
		// The override is scoped to default_view: geo_provider still resolves.
		expect(features?.geo_provider).toBe(config.geoProvider);
	});

	test('quoted numbers are accepted (the client predicate coerces too)', async () => {
		const features = await geoFeatures({
			default_view: { lat: '41.65', lon: '-4.72', zoom: '9' },
		});
		expect(features?.default_view).toEqual({ lat: 41.65, lon: -4.72, zoom: 9 });
	});

	test('an incomplete or invalid override falls back to the config camera, all-or-nothing', async () => {
		const rejected: unknown[] = [
			{ lat: 41.65, lon: -4.72 }, // zoom missing
			{ lat: 41.65, lon: -4.72, zoom: null },
			{ lat: 41.65, lon: -4.72, zoom: '' },
			{ lat: 'north', lon: -4.72, zoom: 9 },
			{ lat: Number.NaN, lon: -4.72, zoom: 9 },
			{ lat: 91, lon: -4.72, zoom: 9 }, // lat out of range
			{ lat: 41.65, lon: 181, zoom: 9 }, // lon out of range
			{ lat: 41.65, lon: -4.72, zoom: 23 }, // zoom out of range
			{ lat: 41.65, lon: -4.72, zoom: -1 },
			'41.65,-4.72,9',
			[41.65, -4.72, 9],
			null,
		];
		for (const default_view of rejected) {
			expect(await geoFeatures({ default_view })).toEqual({
				geo_provider: config.geoProvider,
				default_view: WORLD_VIEW,
			});
		}
	});

	test('0 is a legal override value (Greenwich / the equator / zoom 0)', async () => {
		const features = await geoFeatures({ default_view: { lat: 0, lon: 0, zoom: 0 } });
		expect(features?.default_view).toEqual({ lat: 0, lon: 0, zoom: 0 });
	});

	test('the emission is model-scoped: a NON-geolocation component carries no default_view', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			tipo: 'test159',
		}); // input_text
		expect(entry?.model).toBe('component_input_text');
		expect(featuresOf(entry)?.default_view).toBeUndefined();
	});

	test('a SECOND geolocation instance gets the same camera (per-tipo, not cached once)', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			tipo: 'test31',
		});
		expect(entry?.model).toBe('component_geolocation');
		expect(featuresOf(entry)?.default_view).toEqual(WORLD_VIEW);
	});
});
