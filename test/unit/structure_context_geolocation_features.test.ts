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
 *   2. the SIMPLE context (addRequestConfig:false) carries `tile_direct` ALONE — no
 *      geo_provider, no camera: list/portal views render no map, but the search
 *      panel builds its components simple and DOES draw one, whose base layer must
 *      know whether to ask the proxy;
 *   3. an instance properties.default_view overrides the config camera,
 *      all-or-nothing, accepting numbers AND numeric strings (the client's
 *      fn_finite_number coerces; server and client must agree), range-checked;
 *   4. CACHE SAFETY: features is stamped on the FRESH entry, never on the shared
 *      cached core — a leak there bleeds across requests, so a simple build
 *      AFTER a full build must still come back with `tile_direct` alone.
 *   5. `features.tile_direct` (the built-ins the BROWSER loads directly because the
 *      tile proxy may not relay them without the installation's own identity —
 *      geo/tile_proxy/direct_tiles.ts) follows the configured origin PER BUILD,
 *      over the one table the senders and the route are driven by
 *      (test/helpers/public_origin_table.ts): a context built after a DEDALO_HOST
 *      change says the new answer, never a cached one — in the full AND the simple
 *      context.
 *
 * Fixture: test3/test100 (the playground geolocation component). Read-only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Preload the component-model registry (buildStructureContext resolves models).
import '../../src/core/components/registry.ts';
import { config } from '../../src/config/config.ts';
import { reachablePublicOrigin } from '../../src/core/resolve/public_reach.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { PUBLIC_ORIGIN_TABLE } from '../helpers/public_origin_table.ts';

const GEO = { tipo: 'test100', sectionTipo: 'test3', mode: 'edit', lang: 'lg-spa', permissions: 3 };

const WORLD_VIEW = {
	lat: config.geoDefaultView.lat,
	lon: config.geoDefaultView.lon,
	zoom: config.geoDefaultView.zoom,
};

function featuresOf(entry: Awaited<ReturnType<typeof buildStructureContext>>) {
	return entry?.features as
		| {
				geo_provider?: unknown;
				default_view?: { lat: number; lon: number; zoom: number };
				tile_direct?: unknown;
		  }
		| undefined;
}

/** Build the geolocation context with an optional properties override. */
async function geoFeatures(propertiesOverride?: Record<string, unknown>, full = true) {
	return featuresOf(
		await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			propertiesOverride,
			...(full ? {} : { addRequestConfig: false }),
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

	test('the SIMPLE context (addRequestConfig:false) emits tile_direct ALONE — no provider, no camera', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			...GEO,
			addRequestConfig: false,
		});
		expect(entry).toBeDefined();
		expect(Object.keys(featuresOf(entry) ?? {})).toEqual(['tile_direct']);
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
		expect(Object.keys(featuresOf(simple) ?? {})).toEqual(['tile_direct']);
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
				tile_direct: reachablePublicOrigin() === null ? ['osm'] : [],
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

describe('component_geolocation context.features.tile_direct', () => {
	const KEYS = ['DEDALO_PROTOCOL', 'DEDALO_HOST'] as const;
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of KEYS) saved.set(key, process.env[key]);
	});
	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test('the built-ins the browser loads directly follow the configured origin on EVERY build — one table with the senders and the route', async () => {
		let direct = 0;
		let proxied = 0;
		for (const [protocol, host, origin] of PUBLIC_ORIGIN_TABLE) {
			process.env.DEDALO_PROTOCOL = protocol;
			process.env.DEDALO_HOST = host;
			const label = JSON.stringify([protocol, host]);
			// the same cached core every time: only the per-call stamp can follow the change
			const expected = origin === null ? ['osm'] : [];
			expect((await geoFeatures())?.tile_direct, label).toEqual(expected);
			// the search panel's simple context says the same: it draws a map too
			expect((await geoFeatures(undefined, false))?.tile_direct, `${label} simple`).toEqual(
				expected,
			);
			if (origin === null) direct++;
			else proxied++;
		}
		expect(direct).toBeGreaterThan(10);
		expect(proxied).toBeGreaterThan(10);
	});
});
