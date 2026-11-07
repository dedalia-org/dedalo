/**
 * component_geolocation edit context (2026-07-04, user-reported: the map rendered
 * as an empty blue box in the client). PHP appends a `features` object carrying
 * geo_provider to the FULL edit context (component_geolocation_json.php:106-115);
 * the client map widget reads context.features.geo_provider to select its Leaflet
 * tile backend. TS omitted it, so the map could not initialise a tile layer.
 *
 * This gate drives the section read (the client render path) and asserts the
 * geolocation context carries features.geo_provider matching PHP. Fixture:
 * test3/1 component test100. See rewrite/STATUS.md "component_geolocation features".
 *
 * DELIBERATE WIRE DIVERGENCE (WC-2026-08-08-geolocation-emptiness-explicit):
 * TS adds ONE key to this object, `features.default_view` — the map's opening
 * CAMERA, which PHP never emitted because it fabricated a stored coordinate
 * instead. Reconciled the WC-001 way: the ONE known-diverging key is lifted off
 * the TS object by name and asserted STRICTLY on its own (exact shape, exact
 * values from config); EVERY remaining byte is still compared verbatim with
 * toEqual against the PHP/fixture response. A subset match is NOT used — a
 * second additive key, a dropped or renamed geo_provider, or any value drift
 * still fails here.
 *
 * A SECOND ledgered TS-only key (WC-2026-11-06-map-tile-proxy, 2026-11-07):
 * `features.tile_direct`, the built-ins the browser loads directly because the
 * tile proxy may not relay them without the installation's own identity. PHP
 * had no proxy, so no counterpart; lifted by name the same way and asserted
 * strictly (the rule's own answer for this configuration).
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { directBuiltinIds } from '../../src/core/geo/tile_proxy/direct_tiles.ts';
import { readSection } from '../../src/core/section/read.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

const SECTION_READ_RQO = {
	action: 'read',
	source: {
		type: 'section',
		model: 'section',
		tipo: 'test3',
		section_tipo: 'test3',
		section_id: 1,
		mode: 'edit',
		lang: 'lg-spa',
	},
	sqo: {
		section_tipo: ['test3'],
		limit: 1,
		offset: 0,
		filter_by_locators: [{ section_tipo: 'test3', section_id: 1 }],
	},
};

describe.if(hasPhpCredentials())('component_geolocation features (edit context)', () => {
	let phpFeatures: unknown;
	let tsFeatures: unknown;

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(SECTION_READ_RQO));
		phpFeatures = (
			(body.result as { context: { tipo: string; features?: unknown }[] }).context ?? []
		).find((c) => c.tipo === 'test100')?.features;
		const ts = await readSection(SECTION_READ_RQO as unknown as Rqo);
		tsFeatures = (ts.context as { tipo: string; features?: unknown }[]).find(
			(c) => c.tipo === 'test100',
		)?.features;
		// S3-70: explicit hook budget — under full-suite load PHP serializes
		// parity requests and the default 5 s hook timeout flaked this file
		// (the run1↔run2 wobble); 60 s matches the other differentials.
	}, 60000);

	test('geolocation edit context carries features.geo_provider matching PHP', () => {
		expect(phpFeatures).toBeDefined(); // PHP always appends it (full context)
		// Lift ONLY the ledgered divergence off the TS side, by name; everything
		// else stays a strict byte comparison against PHP.
		const { default_view, tile_direct, ...tsFeaturesRest } = tsFeatures as {
			default_view?: unknown;
			tile_direct?: unknown;
			[key: string]: unknown;
		};
		// The lift is honest only while PHP has no counterpart key: if the fossil
		// ever carried one, this must go back to a plain strict comparison.
		expect((phpFeatures as { default_view?: unknown }).default_view).toBeUndefined();
		expect((phpFeatures as { tile_direct?: unknown }).tile_direct).toBeUndefined();
		expect(tile_direct).toEqual(directBuiltinIds());
		expect(tsFeaturesRest).toEqual(phpFeatures as Record<string, unknown>);
		expect((tsFeatures as { geo_provider?: unknown })?.geo_provider).toBeDefined();
		// The lifted key is asserted TS-side, strictly: exact shape, exact values.
		// PHP has no counterpart — it fabricated a stored coordinate instead.
		expect(default_view).toEqual({
			lat: config.geoDefaultView.lat,
			lon: config.geoDefaultView.lon,
			zoom: config.geoDefaultView.zoom,
		});
	});
});
