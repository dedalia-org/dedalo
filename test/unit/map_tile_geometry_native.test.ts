/**
 * THE PURE HALF OF THE TILE PROXY — the pieces of `src/core/geo/tile_proxy/` that decide
 * what the server asks a provider for and what it keeps, with no database and no network.
 * The route that wires them (gates, door, memory) is `map_tile_proxy_native.test.ts`.
 *
 *   tile_request   the CLOSED query grammar: three source shapes x two views, an unknown key,
 *                  a repeated key and every malformed value refused; a URL is not a key
 *   tile_geometry  a tile's bbox in each CRS (checked against the closed-form values), a free
 *                  bbox validated against its CRS's world, the AXIS ORDER WMS 1.3.0 asks of a
 *                  geographic CRS (and 1.1.1 does not), plain decimals, and the MISREGISTRATION of
 *                  a plate carrée crop drawn as a mercator tile — measured from the geometry, so
 *                  the zoom from which a geographic-CRS tile is relayed is not a number taken on
 *                  trust
 *   upstream_url   the xyz template and the WMS GetMap query: only numbers the server formats
 *                  are substituted, the endpoint's own query survives, the six stored values and
 *                  the fixed `service=WMS&request=GetMap` appear exactly once, a hostile stored
 *                  value is refused again at FETCH time
 *   freshness      the provider's Cache-Control / Expires / Age, the clamps, "do not keep"
 *   tile_cache     the memory bounded BY BYTES AND BY COUNT: eviction oldest-first, an oversize
 *                  entry served and not kept, an overwrite accounted once, a stale entry dropped
 *                  when asked for, a tiny tile costing a whole entry, and an admission whose cost
 *                  does not grow with the memory; it keeps successful images ONLY (its export
 *                  list is pinned: no refusal can be remembered) and a stale tile that came with
 *                  a validator stays to be revalidated
 *   validators     the ETag / Last-Modified a kept tile is recognised by, and the conditional
 *                  request headers made of them
 *   tile_outcome   what a provider's answer MEANS: a tile (a 304 renews the stale one the proxy
 *                  asked about), "no such tile", a 2xx that is not an image, a fault; and which
 *                  stopped calls never reached the provider
 *   relay_request  the request handed the door carries the ORIGIN's spacing (driven through the
 *                  real door with a synthetic non-zero spacing, because no registry row owes one)
 *   budget/flight  the per-person token bucket and the one-call-per-address board (their pure
 *                  halves; the route drives them end to end)
 *   log            what the operator is told, once per distinct line per window
 *   public_reach   ONE rule for the origin the installation tells a provider, over the senders —
 *                  and, over the same table (test/helpers/public_origin_table.ts), who loads an
 *                  identity-bound provider: the proxy, or the browser (direct_tiles.ts)
 *   image_bytes    the signature of each of the four types; markup and SVG are none of them
 *   builtin        the registry is CLOSED to the providers whose terms were verified, its rows
 *                  pass the stored-source validator, and the terms (and the identity
 *                  requirement, with every name under its host) follow the ORIGIN
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCounters } from '../../src/core/api/counters.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { MapSourceBody } from '../../src/core/geo/map_source.ts';
import { WMS_CRS } from '../../src/core/geo/map_source.ts';
import {
	BUILTIN_SOURCE_IDS,
	builtinPickerEntries,
	builtinProblems,
	DEFAULT_TERMS,
	findBuiltinSource,
	identityRequiredFor,
	termsFor,
} from '../../src/core/geo/tile_proxy/builtin_sources.ts';
import { directBuiltinIds, relayWithheld } from '../../src/core/geo/tile_proxy/direct_tiles.ts';
import {
	ABSENT_BROWSER_LIFETIME_MS,
	absentCacheControl,
	browserCacheControl,
	freshnessMs,
	keepLifetimeMs,
	MAX_BROWSER_LIFETIME_MS,
	MAX_EDITABLE_BROWSER_LIFETIME_MS,
	MAX_LIFETIME_MS,
	MIN_LIFETIME_MS,
	parseCacheControl,
} from '../../src/core/geo/tile_proxy/freshness.ts';
import {
	bareMediaType,
	bytesMatchMediaType,
	declaredImageSize,
	RELAYED_IMAGE_LIMITS,
	withinRelayedLimits,
} from '../../src/core/geo/tile_proxy/image_bytes.ts';
import {
	clearPrincipalBudgetsForTests,
	PRINCIPAL_BUDGET_LIMITS,
	principalBudgetsTracked,
	takeUpstreamToken,
} from '../../src/core/geo/tile_proxy/principal_budget.ts';
import { tileReferer } from '../../src/core/geo/tile_proxy/referer.ts';
import {
	relayRequest,
	STORED_TIMEOUT_MS,
	TILE_MAX_BYTES,
} from '../../src/core/geo/tile_proxy/relay_request.ts';
import * as tileCacheModule from '../../src/core/geo/tile_proxy/tile_cache.ts';
import {
	clearTileCacheForTests,
	forgetTile,
	recallStale,
	recallTile,
	rememberTile,
	TILE_CACHE_LIMITS,
	tileBytesKept,
	tileCost,
	tilesKept,
} from '../../src/core/geo/tile_proxy/tile_cache.ts';
import {
	clearTileFlightsForTests,
	shareTileFlight,
	tileFlightsInProgress,
} from '../../src/core/geo/tile_proxy/tile_flights.ts';
import {
	bboxParameter,
	checkBbox,
	GEOGRAPHIC_TILE_MIN_ZOOM,
	isGeographicCrs,
	plainDecimal,
	tileBbox,
} from '../../src/core/geo/tile_proxy/tile_geometry.ts';
import {
	clearTileLogForTests,
	reportOncePerWindow,
	TILE_LOG_LIMITS,
	tileLogKeys,
} from '../../src/core/geo/tile_proxy/tile_log.ts';
import {
	DOOR_BUSY_RETRY_MS,
	judgeAnswer,
	judgeDoorFailure,
	neverReachedProvider,
} from '../../src/core/geo/tile_proxy/tile_outcome.ts';
import {
	MAX_IMAGE_SIDE,
	parseTileRequest,
	TILE_PX,
} from '../../src/core/geo/tile_proxy/tile_request.ts';
import { buildUpstream } from '../../src/core/geo/tile_proxy/upstream_url.ts';
import {
	MAX_VALIDATOR_LENGTH,
	readValidators,
	renewedValidators,
	validatorHeaders,
} from '../../src/core/geo/tile_proxy/validators.ts';
import { geoUserAgent } from '../../src/core/geo_services/user_agent.ts';
import {
	jobStoppedError,
	refusedAfterRequest,
	stoppedAfterRequest,
} from '../../src/core/harvest/abort.ts';
import type { HarvestResponse } from '../../src/core/harvest/harvest.ts';
import { HARVEST_USER_AGENT, interactiveFetch } from '../../src/core/harvest/harvest.ts';
import { installationUserAgent } from '../../src/core/harvest/installation_identity.ts';
import { clearInteractiveForTests } from '../../src/core/harvest/interactive_limits.ts';
import { runWithJobSignal } from '../../src/core/media/job_scope.ts';
import {
	isReachableFromOutside,
	reachablePublicOrigin,
} from '../../src/core/resolve/public_reach.ts';
import type { PinnedHopRequest, PinnedHopResponse } from '../../src/core/security/ssrf_guard.ts';
import { gifHeader, jpegHeader, pngHeader, webpHeader } from '../helpers/image_headers.ts';
import { PUBLIC_ORIGIN_TABLE } from '../helpers/public_origin_table.ts';

const SECONDS = 1000;
const NOW = 1_700_000_000_000;

const query = (text: string) => new URLSearchParams(text);

const STORED = 'section_tipo=test3&section_id=7&component_tipo=test100&source_id=4';
const DEFAULT = 'section_tipo=test3&component_tipo=test100&default_id=regional';
const BUILTIN = 'section_tipo=test3&component_tipo=test100&builtin=osm';
const TILE = 'z=3&x=4&y=2';
const IMAGE = 'bbox=-10.5,35,4.25,44&width=512&height=400';

const XYZ: MapSourceBody = {
	type: 'xyz',
	url: 'https://tiles.example.org/{z}/{x}/{y}.png?key=tok_SECRET_pure',
	params: { min_zoom: 2, max_zoom: 12 },
	attribution: 'Example',
};

const WMS = (over: Record<string, unknown> = {}): MapSourceBody =>
	({
		type: 'wms',
		url: 'https://wms.example.org/service?map=abc',
		params: {
			version: '1.3.0',
			layers: 'roads,rail',
			styles: '',
			format: 'image/png',
			transparent: true,
			crs: 'EPSG:3857',
			...over,
		},
		attribution: '',
	}) as MapSourceBody;

describe('tile_request — the closed grammar', () => {
	test('the three source shapes parse, with a tile view and with a free image', () => {
		const stored = parseTileRequest(query(`${STORED}&${TILE}`));
		expect(stored.ok && stored.value).toEqual({
			ref: {
				kind: 'stored',
				sectionTipo: 'test3',
				sectionId: 7,
				componentTipo: 'test100',
				sourceId: 4,
			},
			view: { kind: 'tile', z: 3, x: 4, y: 2 },
		});
		const named = parseTileRequest(query(`${DEFAULT}&${IMAGE}`));
		expect(named.ok && named.value).toEqual({
			ref: {
				kind: 'default',
				sectionTipo: 'test3',
				componentTipo: 'test100',
				defaultId: 'regional',
			},
			view: { kind: 'image', bbox: [-10.5, 35, 4.25, 44], width: 512, height: 400 },
		});
		const builtin = parseTileRequest(query(`${BUILTIN}&${TILE}`));
		expect(builtin.ok && builtin.value.ref).toEqual({
			kind: 'builtin',
			sectionTipo: 'test3',
			componentTipo: 'test100',
			builtinId: 'osm',
		});
	});

	test('a URL is not a key: no spelling of an address, a host or a header is accepted', () => {
		for (const extra of [
			'url=https://evil.example.org/x.png',
			'src=https://evil.example.org/x.png',
			'host=evil.example.org',
			'template=https://evil.example.org/{z}/{x}/{y}',
			'referer=https://evil.example.org/',
			'cookie=a',
			'layers=other',
			'service=WMS',
			'request=GetFeatureInfo',
			'srs=EPSG:4326',
			'format=image/svg+xml',
		]) {
			expect(parseTileRequest(query(`${STORED}&${TILE}&${extra}`)).ok, extra).toBe(false);
		}
		// …and a request that names no source at all, or two, is not a request.
		expect(parseTileRequest(query(TILE)).ok).toBe(false);
		expect(parseTileRequest(query(`${STORED}&default_id=x&${TILE}`)).ok).toBe(false);
		expect(
			parseTileRequest(query(`${BUILTIN}&builtin=osm&${TILE}`)).ok,
			'a repeated key is refused (parsers disagree on which one wins)',
		).toBe(false);
	});

	test('the keys must fit the shape: no section_id on a default, none missing on a stored source, no half a view', () => {
		for (const text of [
			`${DEFAULT}&section_id=7&${TILE}`,
			`${BUILTIN}&section_id=7&${TILE}`,
			'section_tipo=test3&component_tipo=test100&source_id=4&z=3&x=4&y=2',
			`${STORED}&z=3&x=4`,
			`${STORED}&${TILE}&bbox=0,0,1,1`,
			`${STORED}&bbox=0,0,1,1&width=10`,
			`${STORED}&${TILE}&width=10&height=10`,
		]) {
			expect(parseTileRequest(query(text)).ok, text).toBe(false);
		}
	});

	test('every identifier and number has its own grammar', () => {
		const bad = [
			'section_tipo=Test3&component_tipo=test100&builtin=osm',
			'section_tipo=test3&component_tipo=a b&builtin=osm',
			'section_tipo=test3&component_tipo=test100&builtin=OSM',
			'section_tipo=test3&component_tipo=test100&builtin=osm%00',
			'section_tipo=test3&component_tipo=test100&builtin=',
			'section_tipo=test3&section_id=0&component_tipo=test100&source_id=4',
			'section_tipo=test3&section_id=-3&component_tipo=test100&source_id=4',
			'section_tipo=test3&section_id=01&component_tipo=test100&source_id=4',
			'section_tipo=test3&section_id=2147483648&component_tipo=test100&source_id=4',
			'section_tipo=test3&section_id=1.5&component_tipo=test100&source_id=4',
			'section_tipo=test3&section_id=7&component_tipo=test100&source_id=0',
		];
		for (const text of bad) expect(parseTileRequest(query(`${text}&${TILE}`)).ok, text).toBe(false);
	});

	test('a tile must lie on its grid; an image must be a real box of bounded size', () => {
		for (const view of [
			'z=23&x=0&y=0', // above the zoom ceiling
			'z=3&x=8&y=0', // x outside 2^3
			'z=3&x=0&y=8',
			'z=-1&x=0&y=0',
			'z=3&x=1e1&y=0',
			'z=3&x=0x4&y=0',
			'z=3&x=%204&y=0',
		]) {
			expect(parseTileRequest(query(`${BUILTIN}&${view}`)).ok, view).toBe(false);
		}
		expect(parseTileRequest(query(`${BUILTIN}&z=22&x=4194303&y=0`)).ok).toBe(true);
		for (const view of [
			'bbox=1,2,3&width=10&height=10',
			'bbox=1,2,3,4,5&width=10&height=10',
			'bbox=1,2,3,x&width=10&height=10',
			'bbox=1e3,2,3,4&width=10&height=10',
			'bbox=1,2,3,4&request=GetFeatureInfo&width=10&height=10',
			'bbox=1,2,3,4%26request%3DGetFeatureInfo&width=10&height=10',
			'bbox=0,0,1,1;service=WFS&width=10&height=10',
			`bbox=0,0,1,1&width=${MAX_IMAGE_SIDE + 1}&height=10`,
			'bbox=0,0,1,1&width=0&height=10',
			'bbox=0,0,1,1&width=10.5&height=10',
			'bbox=0,0,1,1&width=10',
		]) {
			expect(parseTileRequest(query(`${BUILTIN}&${view}`)).ok, view).toBe(false);
		}
		expect(
			parseTileRequest(query(`${BUILTIN}&bbox=0,0,1,1&width=${MAX_IMAGE_SIDE}&height=1`)).ok,
		).toBe(true);
	});

	test('a reason names the parameter and never quotes the value', () => {
		const secret = 'tok_SECRET_value';
		const refused = parseTileRequest(query(`${BUILTIN}&z=${secret}&x=0&y=0`));
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).not.toContain(secret);
		const unknown = parseTileRequest(query(`${BUILTIN}&${TILE}&${secret}=1`));
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.reason).not.toContain(secret);
	});
});

describe('tile_geometry — where a tile is, and the order of its axes', () => {
	test('Web Mercator tiles are the closed-form squares of the world', () => {
		const half = 20037508.342789244;
		expect(tileBbox('EPSG:3857', 0, 0, 0)).toEqual([-half, -half, half, half]);
		const [minx, miny, maxx, maxy] = tileBbox('EPSG:3857', 1, 1, 0);
		expect([minx, miny, maxx, maxy]).toEqual([0, 0, half, half]);
		const [x0, y0, x1, y1] = tileBbox('EPSG:3857', 3, 4, 2);
		expect(x1 - x0).toBeCloseTo((2 * half) / 8, 6);
		expect(y1 - y0).toBeCloseTo((2 * half) / 8, 6);
		expect(x0).toBeCloseTo(0, 6); // column 4 of 8 starts at the meridian
		expect(y1).toBeCloseTo(half / 2, 6); // row 2 of 8 starts at three quarters up
	});

	test('the geographic CRSs get the tile’s longitude/latitude corners — a plate carrée crop, which is NOT what Leaflet’s WMS layer asks', () => {
		for (const crs of ['EPSG:4326', 'EPSG:4258'] as const) {
			const [west, south, east, north] = tileBbox(crs, 3, 4, 2);
			expect(west).toBeCloseTo(0, 9);
			expect(east).toBeCloseTo(45, 9);
			expect(north).toBeCloseTo(66.51326044, 6);
			expect(south).toBeCloseTo(40.97989807, 6);
		}
		const [, south, , north] = tileBbox('EPSG:4326', 0, 0, 0);
		expect(north).toBeCloseTo(85.0511287798, 6);
		expect(south).toBeCloseTo(-85.0511287798, 6);
	});

	/** Where, from the top of a mercator tile (0..1), the mercator projection puts latitude `lat`. */
	const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

	/**
	 * The worst vertical misregistration, in pixels, of a plate carrée crop drawn as the mercator
	 * tile of the same corners, over the tiles of zoom `z` that are worst (the polar ones and a
	 * few more): the service spaces latitude linearly down the 256 rows, the map spaces it as
	 * mercator does.
	 */
	function worstMisregistrationPx(z: number): number {
		const grid = 2 ** z;
		const rows = [...new Set([0, 1, Math.floor(grid / 2), grid - 2, grid - 1])].filter(
			(y) => y >= 0 && y < grid,
		);
		let worst = 0;
		for (const y of rows) {
			const [, south, , north] = tileBbox('EPSG:4326', z, 0, y);
			const span = mercatorY(north) - mercatorY(south);
			for (let row = 0; row <= TILE_PX; row++) {
				const lat = north + (south - north) * (row / TILE_PX);
				const drawnAt = (mercatorY(north) - mercatorY(lat)) / span;
				worst = Math.max(worst, Math.abs(drawnAt - row / TILE_PX) * TILE_PX);
			}
		}
		return worst;
	}

	test('a geographic-CRS tile is registered to within a pixel only from GEOGRAPHIC_TILE_MIN_ZOOM up — measured, not asserted', () => {
		// the figures that justify the floor (a tile at zoom 2 is off by tens of pixels)
		expect(worstMisregistrationPx(2)).toBeGreaterThan(40);
		expect(worstMisregistrationPx(4)).toBeGreaterThan(10);
		expect(worstMisregistrationPx(6)).toBeGreaterThan(2.5);
		// the floor is the first zoom whose worst case is under a pixel, and every zoom above it is
		expect(worstMisregistrationPx(GEOGRAPHIC_TILE_MIN_ZOOM)).toBeLessThan(1);
		expect(worstMisregistrationPx(GEOGRAPHIC_TILE_MIN_ZOOM - 1)).toBeGreaterThanOrEqual(1);
		for (let z = GEOGRAPHIC_TILE_MIN_ZOOM; z <= 14; z++) {
			expect(worstMisregistrationPx(z), `zoom ${z}`).toBeLessThan(1);
		}
		// …and each zoom halves it (the error is quadratic in the tile’s height)
		expect(worstMisregistrationPx(10)).toBeLessThan(worstMisregistrationPx(9) * 0.6);
	});

	test('the client mirrors the floor and the geographic CRSs: a layer below it would ask for tiles the server refuses', () => {
		const client = readFileSync(
			join(
				import.meta.dir,
				'..',
				'..',
				'client/dedalo/core/component_geolocation/js/component_geolocation.js',
			),
			'utf8',
		);
		const floor = /^const GEOGRAPHIC_WMS_MIN_ZOOM = (\d+)$/m.exec(client)?.[1];
		expect(Number(floor), 'the client declares the floor').toBe(GEOGRAPHIC_TILE_MIN_ZOOM);
		const listed = /^const GEOGRAPHIC_CRS = \[(.*)\]$/m.exec(client)?.[1] ?? '';
		const clientCrs = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
		expect(clientCrs.sort()).toEqual(WMS_CRS.filter((crs) => isGeographicCrs(crs)).sort());
	});

	test('WMS 1.3.0 reverses the axes of a geographic CRS and nothing else', () => {
		const box = [-10.5, 35, 4.25, 44] as const;
		expect(bboxParameter('1.3.0', 'EPSG:4326', box)).toBe('35,-10.5,44,4.25');
		expect(bboxParameter('1.3.0', 'EPSG:4258', box)).toBe('35,-10.5,44,4.25');
		expect(bboxParameter('1.1.1', 'EPSG:4326', box)).toBe('-10.5,35,4.25,44');
		expect(bboxParameter('1.3.0', 'EPSG:3857', [-1000, -2000, 3000, 4000])).toBe(
			'-1000,-2000,3000,4000',
		);
		expect(bboxParameter('1.1.1', 'EPSG:3857', [-1000, -2000, 3000, 4000])).toBe(
			'-1000,-2000,3000,4000',
		);
	});

	test('numbers leave as plain decimals: no exponent, trailing zeros trimmed, no negative zero', () => {
		expect(plainDecimal(1e-7)).toBe('0.0000001');
		expect(plainDecimal(12.5)).toBe('12.5');
		expect(plainDecimal(3)).toBe('3');
		expect(plainDecimal(-0.0000000001)).toBe('0');
		expect(plainDecimal(-20037508.342789244)).toBe('-20037508.342789244');
		expect(plainDecimal(123456789012345)).toBe('123456789012345');
		// never an exponent: a value that cannot be written plainly is refused, not emitted as 1e+21
		for (const value of [1e21, 1e15, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => plainDecimal(value), String(value)).toThrow(DedaloError);
		}
	});

	test('a free bbox must be finite, a real box, and inside the world of its CRS', () => {
		expect(checkBbox('EPSG:4326', [-10, 35, 4, 44]).ok).toBe(true);
		expect(checkBbox('EPSG:4326', [-181, 35, 4, 44]).ok).toBe(false);
		expect(checkBbox('EPSG:4326', [-10, 35, 4, 91]).ok).toBe(false);
		expect(checkBbox('EPSG:4326', [4, 35, -10, 44]).ok).toBe(false);
		expect(checkBbox('EPSG:4326', [-10, 35, -10, 44]).ok).toBe(false);
		expect(checkBbox('EPSG:4326', [Number.NaN, 35, 4, 44]).ok).toBe(false);
		expect(checkBbox('EPSG:3857', [-20037508.34, -1, 20037508.34, 1]).ok).toBe(true);
		expect(checkBbox('EPSG:3857', [-20037510, -1, 20037508.34, 1]).ok).toBe(false);
		// the same numbers are fine as metres and nonsense as degrees
		expect(checkBbox('EPSG:3857', [-1_000_000, 4_000_000, 500_000, 5_500_000]).ok).toBe(true);
		expect(checkBbox('EPSG:4326', [-1_000_000, 4_000_000, 500_000, 5_500_000]).ok).toBe(false);
	});
});

describe('upstream_url — the one place an address is built', () => {
	const tile = { kind: 'tile', z: 3, x: 4, y: 2 } as const;

	test('xyz: the three placeholders are replaced by integers and by nothing else; the token stays', () => {
		const built = buildUpstream(XYZ, tile);
		expect(built.ok && built.value.url).toBe(
			'https://tiles.example.org/3/4/2.png?key=tok_SECRET_pure',
		);
		expect(built.ok && built.value.host).toBe('tiles.example.org');
		expect(built.ok && built.value.mediaTypes).toEqual([
			'image/png',
			'image/jpeg',
			'image/gif',
			'image/webp',
		]);
		// every placeholder, wherever it stands in the path or the query
		const twice = buildUpstream(
			{ ...XYZ, url: 'https://t.example.org/{z}/{x}/{y}?again={z}-{x}-{y}' } as MapSourceBody,
			tile,
		);
		expect(twice.ok && twice.value.url).toBe('https://t.example.org/3/4/2?again=3-4-2');
	});

	test('xyz: the source’s own zoom bounds and the kind of view are respected', () => {
		expect(buildUpstream(XYZ, { kind: 'tile', z: 1, x: 0, y: 0 }).ok).toBe(false); // min_zoom 2
		expect(buildUpstream(XYZ, { kind: 'tile', z: 13, x: 0, y: 0 }).ok).toBe(false); // max_zoom 12
		expect(buildUpstream(XYZ, { kind: 'tile', z: 12, x: 0, y: 0 }).ok).toBe(true);
		expect(
			buildUpstream(XYZ, { kind: 'image', bbox: [0, 0, 1, 1], width: 10, height: 10 }).ok,
		).toBe(false);
	});

	test('wms: the server fixes service/request and the six stored values, once each, in order, keeping the endpoint’s query', () => {
		const built = buildUpstream(WMS(), tile);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const url = new URL(built.value.url);
		expect(url.origin + url.pathname).toBe('https://wms.example.org/service');
		expect([...url.searchParams.entries()]).toEqual([
			['map', 'abc'],
			['service', 'WMS'],
			['request', 'GetMap'],
			['version', '1.3.0'],
			['layers', 'roads,rail'],
			['styles', ''],
			['format', 'image/png'],
			['transparent', 'TRUE'],
			['crs', 'EPSG:3857'],
			['bbox', '0,5009377.085697311,5009377.085697311,10018754.171394622'],
			['width', String(TILE_PX)],
			['height', String(TILE_PX)],
		]);
		expect(built.value.mediaTypes).toEqual(['image/png']);
		expect(built.value.host).toBe('wms.example.org');
	});

	test('wms: 1.1.1 uses srs and keeps lon/lat; 1.3.0 with EPSG:4326 puts latitude first', () => {
		const geographic = { kind: 'tile', z: GEOGRAPHIC_TILE_MIN_ZOOM + 1, x: 260, y: 190 } as const;
		const old = buildUpstream(WMS({ version: '1.1.1', crs: 'EPSG:4326' }), geographic);
		const current = buildUpstream(WMS({ version: '1.3.0', crs: 'EPSG:4326' }), geographic);
		if (!old.ok || !current.ok) throw new Error('both must build');
		const oldQuery = new URL(old.value.url).searchParams;
		const currentQuery = new URL(current.value.url).searchParams;
		expect(oldQuery.get('srs')).toBe('EPSG:4326');
		expect(oldQuery.has('crs')).toBe(false);
		expect(currentQuery.get('crs')).toBe('EPSG:4326');
		expect(currentQuery.has('srs')).toBe(false);
		const [west, south, east, north] = (oldQuery.get('bbox') ?? '').split(',').map(Number) as [
			number,
			number,
			number,
			number,
		];
		const [expectWest, expectSouth, expectEast, expectNorth] = tileBbox(
			'EPSG:4326',
			geographic.z,
			geographic.x,
			geographic.y,
		);
		expect([west, south, east, north].map((v) => v.toFixed(7))).toEqual(
			[expectWest, expectSouth, expectEast, expectNorth].map((v) => v.toFixed(7)),
		);
		expect((currentQuery.get('bbox') ?? '').split(',').map(Number)).toEqual([
			south,
			west,
			north,
			east,
		]);
	});

	test('wms: a TILE of a geographic-CRS source is built from the minimum zoom up and refused below; a mercator source and a free image are not tied to it', () => {
		for (const crs of ['EPSG:4326', 'EPSG:4258'] as const) {
			for (let z = 0; z < GEOGRAPHIC_TILE_MIN_ZOOM; z++) {
				const refused = buildUpstream(WMS({ crs }), { kind: 'tile', z, x: 0, y: 0 });
				expect(refused.ok, `${crs} z${z}`).toBe(false);
				expect(refused.ok ? '' : refused.reason).not.toContain('wms.example.org');
			}
			const built = buildUpstream(WMS({ crs }), {
				kind: 'tile',
				z: GEOGRAPHIC_TILE_MIN_ZOOM,
				x: 130,
				y: 97,
			});
			expect(built.ok, `${crs} at the floor`).toBe(true);
			const image = buildUpstream(WMS({ crs }), {
				kind: 'image',
				bbox: [-10.5, 35, 4.25, 44],
				width: 512,
				height: 400,
			});
			expect(image.ok, `${crs} free image`).toBe(true);
		}
		expect(buildUpstream(WMS({ crs: 'EPSG:3857' }), { kind: 'tile', z: 0, x: 0, y: 0 }).ok).toBe(
			true,
		);
		expect(isGeographicCrs('EPSG:3857')).toBe(false);
	});

	test('wms: a free image keeps its own size and a validated bbox; one outside the CRS is refused', () => {
		const built = buildUpstream(WMS({ crs: 'EPSG:4326', version: '1.1.1' }), {
			kind: 'image',
			bbox: [-10.5, 35, 4.25, 44],
			width: 512,
			height: 400,
		});
		if (!built.ok) throw new Error(built.reason);
		const query = new URL(built.value.url).searchParams;
		expect([query.get('bbox'), query.get('width'), query.get('height')]).toEqual([
			'-10.5,35,4.25,44',
			'512',
			'400',
		]);
		const outside = buildUpstream(WMS({ crs: 'EPSG:4326' }), {
			kind: 'image',
			bbox: [-10.5, 35, 400, 44],
			width: 512,
			height: 400,
		});
		expect(outside.ok).toBe(false);
	});

	test('a stored value that smuggles a parameter is refused AGAIN at fetch time, and the reason holds no secret', () => {
		const hostile = [
			WMS({ layers: 'a&service=WFS' }),
			WMS({ layers: 'a#frag' }),
			WMS({ layers: 'a\r\nHost: evil' }),
			WMS({ styles: 'x&request=GetFeatureInfo' }),
			WMS({ format: 'image/svg+xml' }),
			WMS({ crs: 'EPSG:25830' }),
			WMS({ version: '2.0.0' }),
			{ ...WMS(), url: 'https://wms.example.org/service?request=GetFeatureInfo' } as MapSourceBody,
			{ ...WMS(), url: 'https://user:pw@wms.example.org/service' } as MapSourceBody,
			{ ...WMS(), url: 'http://127.0.0.1/service' } as MapSourceBody,
		];
		for (const source of hostile) {
			expect(buildUpstream(source, tile).ok, JSON.stringify(source)).toBe(false);
		}
		const bad = buildUpstream(
			{ ...XYZ, url: 'http://10.0.0.5/{z}/{x}/{y}.png?key=tok_SECRET_pure' } as MapSourceBody,
			tile,
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.reason).not.toContain('tok_SECRET_pure');
	});

	test('a template whose host would move is refused: a placeholder in the authority, a fragment, a credential', () => {
		for (const url of [
			'https://{x}.example.org/{z}/{y}',
			'https://tiles.example.org:{x}/{z}/{y}',
			'https://tiles.example.org/{z}/{x}/{y}#frag',
			'https://user@tiles.example.org/{z}/{x}/{y}',
			'ftp://tiles.example.org/{z}/{x}/{y}',
			'https://tiles.example.org/{z}/{x}/{y}/{s}',
		]) {
			expect(buildUpstream({ ...XYZ, url } as MapSourceBody, tile).ok, url).toBe(false);
		}
	});
});

describe('freshness — the provider’s word, clamped', () => {
	test('Cache-Control directives parse by name, quotes and case aside', () => {
		const parsed = parseCacheControl('Public, MAX-AGE="3600", s-maxage=60 ,no-transform');
		expect(parsed.get('max-age')).toBe('3600');
		expect(parsed.get('s-maxage')).toBe('60');
		expect(parsed.has('public')).toBe(true);
		expect(parseCacheControl(undefined).size).toBe(0);
	});

	test('s-maxage beats max-age, which beats Expires; Age is subtracted; a malformed number is stale', () => {
		const fresh = (headers: Record<string, string>) => freshnessMs(headers, NOW, 111);
		expect(fresh({ 'cache-control': 'max-age=3600' })).toBe(3600 * SECONDS);
		expect(fresh({ 'cache-control': 'max-age=3600, s-maxage=60' })).toBe(60 * SECONDS);
		expect(fresh({ 'cache-control': 'max-age=3600', age: '600' })).toBe(3000 * SECONDS);
		expect(fresh({ 'cache-control': 'max-age=60', age: '600' })).toBe(0);
		expect(fresh({ 'cache-control': 'max-age=soon' })).toBe(0);
		expect(fresh({ 'cache-control': 'max-age=-5' })).toBe(0);
		const date = new Date(NOW).toUTCString();
		const expires = new Date(NOW + 120 * SECONDS).toUTCString();
		expect(fresh({ expires, date })).toBe(120 * SECONDS);
		expect(fresh({ expires: new Date(NOW - SECONDS).toUTCString(), date })).toBe(0);
		expect(fresh({ expires: '0' })).toBe(0);
		expect(
			fresh({ expires, 'cache-control': 'max-age=5' }),
			'Cache-Control wins over Expires',
		).toBe(5 * SECONDS);
	});

	test('an answer that states nothing keeps the ORIGIN’s default', () => {
		expect(freshnessMs({}, NOW, 7 * 24 * 3600 * SECONDS)).toBe(7 * 24 * 3600 * SECONDS);
		expect(
			freshnessMs({ etag: '"x"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }, NOW, 5),
		).toBe(5);
	});

	test('no-store, no-cache and private are NOT kept, and the browser is told the same', () => {
		for (const directive of [
			'no-store',
			'no-cache',
			'private',
			'max-age=3600, private',
			'No-Store',
		]) {
			const headers = { 'cache-control': directive };
			expect(freshnessMs(headers, NOW, 3600 * SECONDS), directive).toBeNull();
			expect(keepLifetimeMs(headers, NOW, 3600 * SECONDS), directive).toBe(0);
		}
		expect(browserCacheControl(null, 'fixed')).toBe('private, no-store');
	});

	test('the shared memory clamps: a week at most, and nothing fresher than the floor is worth keeping', () => {
		expect(keepLifetimeMs({ 'cache-control': 'max-age=31536000' }, NOW, 0)).toBe(MAX_LIFETIME_MS);
		expect(keepLifetimeMs({ 'cache-control': 'max-age=3600' }, NOW, 0)).toBe(3600 * SECONDS);
		expect(keepLifetimeMs({ 'cache-control': 'max-age=0' }, NOW, 0)).toBe(0);
		expect(
			keepLifetimeMs({ 'cache-control': `max-age=${MIN_LIFETIME_MS / SECONDS - 1}` }, NOW, 0),
		).toBe(0);
		expect(
			keepLifetimeMs({ 'cache-control': `max-age=${MIN_LIFETIME_MS / SECONDS}` }, NOW, 0),
		).toBe(MIN_LIFETIME_MS);
	});

	test('the browser is told `private` always, the time left, and never longer than a day', () => {
		expect(browserCacheControl(3_600_000, 'fixed')).toBe('private, max-age=3600');
		expect(browserCacheControl(7 * 24 * 3600 * SECONDS, 'fixed')).toBe('private, max-age=86400');
		expect(browserCacheControl(0, 'fixed')).toBe('private, max-age=0');
		expect(browserCacheControl(1500, 'fixed')).toBe('private, max-age=1');
		for (const stability of ['fixed', 'editable'] as const) {
			for (const value of [null, 0, 1, 3_600_000, 1e12]) {
				expect(browserCacheControl(value, stability)).not.toContain('public');
			}
			expect(browserCacheControl(null, stability)).toBe('private, no-store');
		}
	});

	test('a source that is DATA is kept by a browser for minutes, not a day: its id survives an edit, its URL does not change', () => {
		// stored and default sources are edited, restored and updated without the proxy URL moving,
		// so a browser told "a day" would show the old tiles for up to a day after the edit
		expect(MAX_EDITABLE_BROWSER_LIFETIME_MS).toBe(300 * SECONDS);
		expect(MAX_EDITABLE_BROWSER_LIFETIME_MS).toBeLessThan(MAX_BROWSER_LIFETIME_MS);
		expect(browserCacheControl(7 * 24 * 3600 * SECONDS, 'editable')).toBe('private, max-age=300');
		expect(browserCacheControl(3_600_000, 'editable')).toBe('private, max-age=300');
		// …and the time left still wins when it is shorter than the cap
		expect(browserCacheControl(42_000, 'editable')).toBe('private, max-age=42');
		expect(browserCacheControl(42_000, 'fixed')).toBe('private, max-age=42');
	});

	test('"no such tile" is told to the BROWSER as private and short — a constant, because the proxy itself remembers nothing of it', () => {
		expect(ABSENT_BROWSER_LIFETIME_MS, 'minutes, not days').toBeLessThanOrEqual(300_000);
		expect(ABSENT_BROWSER_LIFETIME_MS).toBeGreaterThanOrEqual(60_000);
		expect(absentCacheControl()).toBe(`private, max-age=${ABSENT_BROWSER_LIFETIME_MS / SECONDS}`);
		expect(absentCacheControl()).toBe('private, max-age=120');
		expect(absentCacheControl()).not.toContain('public');
	});
});

describe('tile_cache — bounded by bytes and by count, with a flat admission', () => {
	beforeEach(() => clearTileCacheForTests());

	const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const png = (bytes: number) => {
		const out = new Uint8Array(bytes);
		out.set(PNG);
		return { bytes: out, contentType: 'image/png' };
	};

	test('a kept tile is recalled until its freshness ends; a stale one is dropped on the ask', () => {
		expect(rememberTile('k1', png(100), 5000, NOW)).toBe(true);
		expect(recallTile('k1', NOW + 4999)?.contentType).toBe('image/png');
		expect(recallTile('k1', NOW + 5000)).toBeNull();
		expect(tilesKept(), 'the stale entry left the memory').toBe(0);
		expect(recallTile('never', NOW)).toBeNull();
	});

	test('the byte ceiling holds: the oldest go first, the newest stay', () => {
		const each = TILE_CACHE_LIMITS.entryBytes - 4096;
		const fits = Math.floor(TILE_CACHE_LIMITS.totalBytes / (each + 200));
		for (let i = 0; i < fits + 5; i++) rememberTile(`k${i}`, png(each), 60_000, NOW);
		expect(tileBytesKept()).toBeLessThanOrEqual(TILE_CACHE_LIMITS.totalBytes);
		expect(recallTile('k0', NOW), 'the oldest was evicted').toBeNull();
		expect(recallTile(`k${fits + 4}`, NOW), 'the newest is held').not.toBeNull();
		expect(tilesKept()).toBeLessThanOrEqual(fits + 1);
		expect(tilesKept()).toBeGreaterThan(fits - 3);
	});

	test('an entry over the per-entry ceiling is not kept — and an older answer for the key is forgotten, not left to be served', () => {
		expect(rememberTile('big', png(100), 60_000, NOW)).toBe(true);
		const oversize = png(TILE_CACHE_LIMITS.entryBytes);
		expect(tileCost('big', oversize.bytes)).toBeGreaterThan(TILE_CACHE_LIMITS.entryBytes);
		expect(rememberTile('big', oversize, 60_000, NOW)).toBe(false);
		expect(recallTile('big', NOW)).toBeNull();
		expect(tileBytesKept()).toBe(0);
	});

	test('an overwrite is counted once, at the newest end; a non-positive lifetime keeps nothing', () => {
		rememberTile('a', png(1000), 60_000, NOW);
		rememberTile('b', png(1000), 60_000, NOW);
		const before = tileBytesKept();
		rememberTile('a', png(1000), 60_000, NOW);
		expect(tileBytesKept()).toBe(before);
		expect(tilesKept()).toBe(2);
		expect(rememberTile('c', png(100), 0, NOW)).toBe(false);
		expect(rememberTile('c', png(100), -5, NOW)).toBe(false);
		expect(rememberTile('c', png(100), Number.NaN, NOW)).toBe(false);
		expect(recallTile('c', NOW)).toBeNull();
	});

	test('a stale entry is dropped when it is asked for or when eviction reaches it, never by a sweep of everything', () => {
		rememberTile('old', png(1000), 1000, NOW);
		rememberTile('new', png(1000), 60_000, NOW + 2000);
		// 'old' is stale at NOW + 2000 but nobody asked and nothing needed its room: it is still held
		expect(tilesKept()).toBe(2);
		expect(recallTile('old', NOW + 2000), 'asked for: dropped, never served').toBeNull();
		expect(tilesKept()).toBe(1);
		expect(recallTile('new', NOW + 2000)).not.toBeNull();
		// and eviction takes the oldest first, stale or not, so a dead tile cannot outlive the room it was given
		clearTileCacheForTests();
		const each = TILE_CACHE_LIMITS.entryBytes - 4096;
		const fits = Math.floor(TILE_CACHE_LIMITS.totalBytes / (each + 200));
		rememberTile('dead', png(each), 1, NOW);
		for (let i = 0; i < fits + 2; i++) rememberTile(`live${i}`, png(each), 60_000, NOW + 10);
		expect(recallTile('dead', NOW)).toBeNull();
		expect(tileBytesKept()).toBeLessThanOrEqual(TILE_CACHE_LIMITS.totalBytes);
	});

	const tinyKey = (index: number) => `https://t.example.org/${index}/0/0.png`;

	test('a tiny tile is a whole entry: it costs at least the floor, so a flood of 70-byte tiles cannot fill the byte budget with a hundred thousand entries', () => {
		const tiny = png(70);
		expect(tileCost(tinyKey(0), tiny.bytes)).toBe(TILE_CACHE_LIMITS.minEntryCostBytes);
		const { maxEntries, minEntryCostBytes, totalBytes } = TILE_CACHE_LIMITS;
		expect(
			maxEntries * minEntryCostBytes,
			'the count cap binds before the byte budget',
		).toBeLessThanOrEqual(totalBytes);
		for (let i = 0; i < maxEntries + 500; i++) rememberTile(tinyKey(i), tiny, 60_000, NOW);
		expect(tilesKept()).toBe(maxEntries);
		// the running total is the arithmetic of what is held: every entry costs the floor
		expect(tileBytesKept()).toBe(maxEntries * minEntryCostBytes);
		expect(recallTile(tinyKey(0), NOW), 'the oldest went first').toBeNull();
		expect(recallTile(tinyKey(499), NOW), 'the oldest 500 went').toBeNull();
		expect(recallTile(tinyKey(500), NOW)).not.toBeNull();
		expect(recallTile(tinyKey(maxEntries + 499), NOW), 'the newest is held').not.toBeNull();
	});

	test('an admission costs the same however full the memory is: there is no scan of what is held', () => {
		const tiny = png(70);
		const { maxEntries } = TILE_CACHE_LIMITS;
		/** Milliseconds to admit tiles [from, to). */
		const admit = (from: number, to: number): number => {
			const started = performance.now();
			for (let i = from; i < to; i++) rememberTile(tinyKey(i), tiny, 60_000, NOW);
			return performance.now() - started;
		};
		const early = admit(0, 500); // the memory is all but empty
		admit(500, maxEntries); // fill it
		const late = admit(maxEntries, maxEntries + 500); // full: each admission also evicts one
		expect(tilesKept()).toBe(maxEntries);
		// A scan of everything held (the first draft did two per admission) makes the late
		// batch tens of times the early one: 500 admissions over 16 000 entries is ~100 ms of
		// event loop, against under 2 ms for a constant-time admission. The margin is wide so
		// a busy machine does not turn this red; the scan does.
		expect(late, `early ${early.toFixed(2)} ms, late ${late.toFixed(2)} ms`).toBeLessThan(
			Math.max(early * 10, 20),
		);
	});

	test('the running total survives every way an entry leaves: an overwrite, a stale recall, an over-ceiling replacement, an eviction', () => {
		rememberTile('a', png(1000), 60_000, NOW);
		rememberTile('b', png(3000), 1000, NOW);
		const costA = tileCost('a', png(1000).bytes);
		const costB = tileCost('b', png(3000).bytes);
		expect(tileBytesKept()).toBe(costA + costB);
		rememberTile('a', png(2000), 60_000, NOW); // an overwrite
		expect(tileBytesKept()).toBe(tileCost('a', png(2000).bytes) + costB);
		expect(recallTile('b', NOW + 1000)).toBeNull(); // stale
		expect(tileBytesKept()).toBe(tileCost('a', png(2000).bytes));
		rememberTile('a', png(TILE_CACHE_LIMITS.entryBytes), 60_000, NOW); // too big: the old answer goes
		expect(tileBytesKept()).toBe(0);
		expect(tilesKept()).toBe(0);
	});
});

describe('tile_cache — only successful images are kept, and a stale one with a validator waits to be revalidated', () => {
	beforeEach(() => clearTileCacheForTests());

	const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const tile = { bytes: PNG, contentType: 'image/png' };
	const VALIDATORS = { etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' };

	test('the memory keeps successful images and NOTHING ELSE: its exports can remember no refusal (the maintainers’ decision for the cache)', () => {
		// The provider's "no such tile" once had a memory of its own here. The decision for this cache
		// is "only successful image responses", so the export list is pinned: a way to remember an
		// absent tile, a fault or a redirect would be a way to break it.
		expect(Object.keys(tileCacheModule).sort()).toEqual([
			'TILE_CACHE_LIMITS',
			'clearTileCacheForTests',
			'forgetTile',
			'recallStale',
			'recallTile',
			'rememberTile',
			'tileBytesKept',
			'tileCost',
			'tilesKept',
		]);
		expect(Object.keys(TILE_CACHE_LIMITS).sort()).toEqual([
			'entryBytes',
			'maxEntries',
			'minEntryCostBytes',
			'overheadBytes',
			'staleRetentionMs',
			'totalBytes',
		]);
	});

	test('a tile past its freshness WITH a validator is not served, stays for revalidation, and is dropped after its retention', () => {
		expect(rememberTile('k', tile, 5_000, NOW, VALIDATORS)).toBe(true);
		expect(recallTile('k', NOW + 4_999)?.validators).toEqual(VALIDATORS);
		expect(recallStale('k', NOW + 4_999), 'a fresh tile is not stale').toBeNull();
		// freshness over: never served as a hit, kept as a stale entry, validators intact
		expect(recallTile('k', NOW + 5_000)).toBeNull();
		expect(tilesKept()).toBe(1);
		const stale = recallStale('k', NOW + 5_000);
		expect(stale?.validators).toEqual(VALIDATORS);
		expect(stale?.bytes).toEqual(PNG);
		// …until the retention ends, which is when it is dropped
		const edge = NOW + 5_000 + TILE_CACHE_LIMITS.staleRetentionMs;
		expect(recallStale('k', edge - 1)).not.toBeNull();
		expect(recallStale('k', edge)).toBeNull();
		expect(tilesKept()).toBe(0);
		expect(tileBytesKept()).toBe(0);
	});

	test('a tile with NO validator has nothing to ask with: dropped on the ask, as ever', () => {
		rememberTile('plain', tile, 5_000, NOW);
		rememberTile('empty', tile, 5_000, NOW, null);
		expect(recallStale('plain', NOW + 5_000)).toBeNull();
		expect(recallTile('empty', NOW + 5_000)).toBeNull();
		expect(tilesKept()).toBe(0);
		expect(recallStale('never', NOW)).toBeNull();
	});

	test('a renewal replaces the stale entry in place — new freshness, same accounting, the newest end — and forgetting takes it out', () => {
		rememberTile('a', tile, 5_000, NOW, VALIDATORS);
		rememberTile('b', tile, 60_000, NOW);
		const before = tileBytesKept();
		const renewed = { etag: '"v2"', lastModified: null };
		expect(rememberTile('a', tile, 60_000, NOW + 6_000, renewed)).toBe(true);
		expect(tileBytesKept()).toBe(before);
		expect(tilesKept()).toBe(2);
		expect(recallTile('a', NOW + 7_000)?.validators).toEqual(renewed);
		// the provider forbade keeping the renewed answer: the older copy goes, nothing is left to serve
		expect(rememberTile('a', tile, 0, NOW + 8_000, renewed)).toBe(false);
		expect(recallTile('a', NOW + 8_000)).toBeNull();
		expect(recallStale('a', NOW + 100_000)).toBeNull();
		// the provider says the tile is gone: forgotten, and its bytes are given back
		rememberTile('c', tile, 5_000, NOW, VALIDATORS);
		expect(forgetTile('c')).toBe(true);
		expect(forgetTile('c')).toBe(false);
		expect(recallStale('c', NOW + 6_000)).toBeNull();
		expect(tileBytesKept()).toBe(tileCost('b', PNG));
	});

	test('a stale entry is no extra bound: it is the same Map slot, so the byte and count ceilings hold with them in', () => {
		const tiny = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const { maxEntries, minEntryCostBytes } = TILE_CACHE_LIMITS;
		for (let i = 0; i < maxEntries + 100; i++) {
			rememberTile(
				`https://t.example.org/${i}.png`,
				{ bytes: tiny, contentType: 'image/png' },
				5_000,
				NOW,
				VALIDATORS,
			);
		}
		expect(tilesKept()).toBe(maxEntries);
		expect(tileBytesKept()).toBe(maxEntries * minEntryCostBytes);
		expect(
			recallStale('https://t.example.org/0.png', NOW + 6_000),
			'the oldest went first',
		).toBeNull();
		expect(recallStale(`https://t.example.org/${maxEntries + 99}.png`, NOW + 6_000)).not.toBeNull();
	});
});

describe('validators — what a kept tile is recognised by, and the conditional request made of it', () => {
	test('an entity-tag and a date are read as the provider gave them; weak tags and both together are fine', () => {
		expect(
			readValidators({ etag: '"abc"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
		).toEqual({
			etag: '"abc"',
			lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
		});
		expect(readValidators({ etag: 'W/"weak-1"' })).toEqual({
			etag: 'W/"weak-1"',
			lastModified: null,
		});
		expect(readValidators({ 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' })).toEqual({
			etag: null,
			lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
		});
		expect(readValidators({})).toBeNull();
		expect(readValidators({ 'cache-control': 'max-age=60' })).toBeNull();
	});

	test('anything that is not an entity-tag or a readable date is NO validator — never sent back to a provider', () => {
		for (const etag of [
			'abc', // not quoted
			'"unterminated',
			'"a"b"', // a quote inside
			'W/abc',
			'"tab\there"', // a control character inside
			'"line\nbreak"',
			`"${'x'.repeat(MAX_VALIDATOR_LENGTH)}"`, // too long
			'',
		]) {
			expect(readValidators({ etag }), JSON.stringify(etag)).toBeNull();
		}
		for (const date of [
			'yesterday',
			'not a date',
			'',
			`${'x'.repeat(MAX_VALIDATOR_LENGTH)}`,
			'Wed, 21 Oct 2026 07:28:00 GMT\r\nX: y',
		]) {
			expect(readValidators({ 'last-modified': date }), JSON.stringify(date)).toBeNull();
		}
		// one bad does not poison the good one
		expect(
			readValidators({ etag: 'bad', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
		).toEqual({
			etag: null,
			lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
		});
	});

	test('what a 304 states replaces what was kept, what it does not state stays', () => {
		const kept = { etag: '"old"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' };
		expect(renewedValidators(null, kept)).toEqual(kept);
		expect(renewedValidators({ etag: '"new"', lastModified: null }, kept)).toEqual({
			etag: '"new"',
			lastModified: kept.lastModified,
		});
		expect(renewedValidators(null, null)).toBeNull();
		expect(renewedValidators({ etag: null, lastModified: null }, null)).toBeNull();
	});

	test('the conditional-request headers are exactly If-None-Match and If-Modified-Since, from the validators and nothing else', () => {
		expect(validatorHeaders(null)).toEqual({});
		expect(validatorHeaders({ etag: null, lastModified: null })).toEqual({});
		expect(validatorHeaders({ etag: '"v1"', lastModified: null })).toEqual({
			'If-None-Match': '"v1"',
		});
		expect(validatorHeaders({ etag: null, lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' })).toEqual(
			{ 'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT' },
		);
		expect(
			validatorHeaders({ etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' }),
		).toEqual({ 'If-None-Match': '"v1"', 'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT' });
	});
});

describe('tile_outcome — what a provider’s answer means', () => {
	const TERMS = { minIntervalMs: 0, sendReferer: false, defaultLifetimeMs: 3_600_000 };
	const PNG_BYTES = pngHeader(256, 256, 40);
	const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

	const answer = (over: Partial<HarvestResponse> = {}): HarvestResponse => ({
		url: 'https://tiles.example.org/3/4/2.png',
		status: 200,
		ok: true,
		contentType: 'image/png',
		headers: { 'cache-control': 'max-age=600' },
		bytes: PNG_BYTES,
		text: () => '',
		...over,
	});

	test('a 2xx of the exact image type whose bytes begin like it is a tile, with its freshness and how long it may be kept', () => {
		const outcome = judgeAnswer(answer(), IMAGES, TERMS, NOW);
		expect(outcome.kind).toBe('tile');
		if (outcome.kind !== 'tile') return;
		expect(outcome.tile.contentType).toBe('image/png');
		expect(outcome.freshMs).toBe(600_000);
		expect(outcome.keepMs).toBe(600_000);
		const forbidden = judgeAnswer(
			answer({ headers: { 'cache-control': 'no-store' } }),
			IMAGES,
			TERMS,
			NOW,
		);
		expect(forbidden.kind === 'tile' && [forbidden.freshMs, forbidden.keepMs]).toEqual([null, 0]);
	});

	test('404 and 410 are "there is no such tile": routine, not a fault', () => {
		for (const status of [404, 410]) {
			expect(judgeAnswer(answer({ status, ok: false }), IMAGES, TERMS, NOW), `${status}`).toEqual({
				kind: 'absent',
			});
		}
	});

	test('any other non-2xx, an image type over the wrong bytes, and a type the address does not allow are FAULTS', () => {
		for (const status of [400, 401, 403, 429, 500, 503]) {
			expect(judgeAnswer(answer({ status, ok: false }), IMAGES, TERMS, NOW), `${status}`).toEqual({
				kind: 'fault',
				why: 'status',
			});
		}
		const wrongBytes = judgeAnswer(
			answer({ bytes: new Uint8Array([1, 2, 3]) }),
			IMAGES,
			TERMS,
			NOW,
		);
		expect(wrongBytes).toEqual({ kind: 'fault', why: 'not_the_image_it_claims' });
		const wrongType = judgeAnswer(answer(), ['image/jpeg'], TERMS, NOW);
		expect(wrongType).toEqual({ kind: 'fault', why: 'not_the_image_it_claims' });
	});

	test('the door’s refusal of a 2xx that is not an image: nothing at all is "nothing here", another type is "not an image"; every other refusal is a fault by the door’s code', () => {
		const unexpected = (contentType: string) =>
			new DedaloError('harvest.unexpected_type', {
				coordinates: { site: 'tiles.example.org', content_type: contentType },
			});
		expect(judgeDoorFailure(unexpected('none'))).toEqual({ kind: 'absent' });
		for (const type of ['text/xml', 'text/html', 'image/svg+xml', 'application/json']) {
			expect(judgeDoorFailure(unexpected(type)), type).toEqual({ kind: 'not_an_image' });
		}
		expect(judgeDoorFailure(new DedaloError('harvest.refused'))).toEqual({
			kind: 'fault',
			why: 'door',
			doorCode: 'harvest.refused',
		});
		expect(judgeDoorFailure(new TypeError('boom'))).toEqual({ kind: 'fault', why: 'door' });
	});

	test('the door refusing for its OWN capacity is BUSY — retryable, not a failing provider — whatever its reason', () => {
		for (const reason of ['queue_full', 'wait_exceeded']) {
			expect(
				judgeDoorFailure(new DedaloError('rate.limited', { coordinates: { reason, key: 'k' } })),
				reason,
			).toEqual({
				kind: 'busy',
				why: 'upstream_busy',
				retryAfterMs: DOOR_BUSY_RETRY_MS,
				doorReason: reason,
			});
		}
		expect(judgeDoorFailure(new DedaloError('rate.limited'))).toEqual({
			kind: 'busy',
			why: 'upstream_busy',
			retryAfterMs: DOOR_BUSY_RETRY_MS,
		});
		// refused on a redirect's LATER hop, after the first reached the provider: still busy, but the
		// outcome says the provider was asked, so the route keeps the call charged (no refund)
		for (const reason of ['queue_full', 'wait_exceeded']) {
			const later = refusedAfterRequest(
				new DedaloError('rate.limited', { coordinates: { reason, key: 'k' } }),
			);
			expect(judgeDoorFailure(later), reason).toEqual({
				kind: 'busy',
				why: 'upstream_busy',
				retryAfterMs: DOOR_BUSY_RETRY_MS,
				doorReason: reason,
				reachedProvider: true,
			});
			expect(neverReachedProvider(later), reason).toBe(false);
		}
		// the tag carries EVERY field of what it tags: only `after` and the log clause are added
		const full = new DedaloError('rate.limited', {
			details: { limit: 4 },
			coordinates: { reason: 'queue_full', key: 'k' },
			publicMessage: 'The map is busy.',
			retryAfterMs: 1234,
			extend: { hint: 'retry' },
		});
		const tagged = refusedAfterRequest(full) as DedaloError;
		expect(tagged).not.toBe(full);
		expect({
			code: tagged.code,
			details: tagged.details,
			coordinates: tagged.coordinates,
			publicMessage: tagged.publicMessage,
			retryAfterMs: tagged.retryAfterMs,
			extend: tagged.extend,
			cause: tagged.cause,
		}).toEqual({
			code: 'rate.limited',
			details: { limit: 4 },
			coordinates: { reason: 'queue_full', key: 'k', after: 'request_sent' },
			publicMessage: 'The map is busy.',
			retryAfterMs: 1234,
			extend: { hint: 'retry' },
			cause: full,
		});
		expect(tagged.message).toBe(`${full.message}, after an earlier hop was sent`);
		// the tag touches only a wait's refusal or stop: anything else passes through as it is
		const other = new DedaloError('harvest.refused');
		expect(refusedAfterRequest(other)).toBe(other);
		// a PROVIDER's 429 is its word about the provider, not the door's capacity: still a fault
		expect(judgeAnswer(answer({ status: 429, ok: false }), IMAGES, TERMS, NOW)).toEqual({
			kind: 'fault',
			why: 'status',
		});
	});

	test('an image whose header declares a decode bomb, or no size at all, is a FAULT — not relayed, not kept', () => {
		const bomb = judgeAnswer(answer({ bytes: pngHeader(30_000, 30_000, 80) }), IMAGES, TERMS, NOW);
		expect(bomb).toEqual({ kind: 'fault', why: 'image_too_large' });
		const wide = judgeAnswer(answer({ bytes: pngHeader(100_000, 1, 80) }), IMAGES, TERMS, NOW);
		expect(wide).toEqual({ kind: 'fault', why: 'image_too_large' });
		// right signature, header cut short or not an IHDR: no size, no image
		const cut = judgeAnswer(
			answer({ bytes: pngHeader(256, 256).subarray(0, 20) }),
			IMAGES,
			TERMS,
			NOW,
		);
		expect(cut).toEqual({ kind: 'fault', why: 'not_the_image_it_claims' });
		// a tile, a retina tile and the largest free image are all inside
		for (const side of [256, 512, MAX_IMAGE_SIDE]) {
			expect(
				judgeAnswer(answer({ bytes: pngHeader(side, side, 80) }), IMAGES, TERMS, NOW).kind,
			).toBe('tile');
		}
	});

	// -- revalidation ------------------------------------------------------

	const STALE = {
		bytes: PNG_BYTES,
		contentType: 'image/png',
		validators: { etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
	} as const;
	const notModified = (headers: Record<string, string> = {}): HarvestResponse =>
		answer({
			status: 304,
			ok: false,
			contentType: '',
			bytes: new Uint8Array(0),
			headers,
		});

	test('a 200 carries the validators the provider gave, to be kept with the tile', () => {
		const outcome = judgeAnswer(
			answer({
				headers: {
					'cache-control': 'max-age=600',
					etag: '"v1"',
					'last-modified': STALE.validators.lastModified,
				},
			}),
			IMAGES,
			TERMS,
			NOW,
		);
		expect(outcome.kind === 'tile' && outcome.validators).toEqual(STALE.validators);
		const none = judgeAnswer(answer(), IMAGES, TERMS, NOW);
		expect(
			none.kind === 'tile' && none.validators,
			'a provider that gave none: nothing to ask with',
		).toBeNull();
	});

	test('a 304 to a conditional request is the tile the proxy KEPT, renewed by what the 304 states', () => {
		const outcome = judgeAnswer(
			notModified({ 'cache-control': 'max-age=900', etag: '"v2"' }),
			IMAGES,
			TERMS,
			NOW,
			STALE,
		);
		expect(outcome.kind).toBe('tile');
		if (outcome.kind !== 'tile') return;
		expect(outcome.tile.bytes, 'the bytes are the kept ones: a 304 has no body').toBe(STALE.bytes);
		expect(outcome.tile.contentType).toBe('image/png');
		expect(outcome.freshMs, 'the freshness the 304 states').toBe(900_000);
		expect(outcome.keepMs).toBe(900_000);
		// what the 304 states replaces; what it does not state stays
		expect(outcome.validators).toEqual({
			etag: '"v2"',
			lastModified: STALE.validators.lastModified,
		});
		// a 304 that states no freshness at all keeps the ORIGIN's default, like any answer that says nothing
		const silent = judgeAnswer(notModified(), IMAGES, TERMS, NOW, STALE);
		expect(silent.kind === 'tile' && [silent.freshMs, silent.keepMs, silent.validators]).toEqual([
			TERMS.defaultLifetimeMs,
			TERMS.defaultLifetimeMs,
			STALE.validators,
		]);
		// and one that forbids keeping renews nothing: served this once, the kept copy is to be dropped
		const forbidding = judgeAnswer(
			notModified({ 'cache-control': 'no-store' }),
			IMAGES,
			TERMS,
			NOW,
			STALE,
		);
		expect(forbidding.kind === 'tile' && [forbidding.freshMs, forbidding.keepMs]).toEqual([
			null,
			0,
		]);
	});

	test('a 304 NOBODY asked for, or for a type the address does not allow, is a fault — never a tile out of nothing', () => {
		expect(judgeAnswer(notModified(), IMAGES, TERMS, NOW)).toEqual({
			kind: 'fault',
			why: 'status',
		});
		expect(judgeAnswer(notModified(), IMAGES, TERMS, NOW, null)).toEqual({
			kind: 'fault',
			why: 'status',
		});
		expect(judgeAnswer(notModified(), ['image/jpeg'], TERMS, NOW, STALE)).toEqual({
			kind: 'fault',
			why: 'status',
		});
		// 404 still wins over the conditional: the tile is gone
		expect(judgeAnswer(answer({ status: 404, ok: false }), IMAGES, TERMS, NOW, STALE)).toEqual({
			kind: 'absent',
		});
		// a 200 to a conditional request is a new tile, verified like any other
		const replaced = judgeAnswer(
			answer({ bytes: new Uint8Array([1, 2, 3]) }),
			IMAGES,
			TERMS,
			NOW,
			STALE,
		);
		expect(replaced).toEqual({ kind: 'fault', why: 'not_the_image_it_claims' });
	});

	test('a call stopped while it waited for its FIRST place never reached the provider — and nothing else is that', () => {
		expect(neverReachedProvider(jobStoppedError('limiter'))).toBe(true);
		// the second hop of a redirect chain was stopped after the first had been sent
		const later = stoppedAfterRequest(jobStoppedError('limiter'));
		expect(later).toBeInstanceOf(DedaloError);
		expect((later as DedaloError).code).toBe('security.outbound_failed');
		expect((later as DedaloError).coordinates).toMatchObject({
			reason: 'aborted',
			stage: 'limiter',
		});
		expect(neverReachedProvider(later)).toBe(false);
		// a stop in the middle of a request, a timeout, another wait, the door's capacity, anything untyped
		for (const stage of ['resolve', 'connect', 'body']) {
			expect(
				neverReachedProvider(
					new DedaloError('security.outbound_failed', {
						coordinates: { reason: 'aborted', stage },
					}),
				),
				stage,
			).toBe(false);
		}
		expect(
			neverReachedProvider(
				new DedaloError('security.outbound_failed', {
					coordinates: { reason: 'timeout', stage: 'limiter' },
				}),
			),
		).toBe(false);
		expect(neverReachedProvider(jobStoppedError('pace'))).toBe(false);
		expect(
			neverReachedProvider(
				new DedaloError('rate.limited', { coordinates: { reason: 'queue_full' } }),
			),
		).toBe(false);
		expect(neverReachedProvider(new TypeError('boom'))).toBe(false);
		expect(neverReachedProvider(undefined)).toBe(false);
		// stoppedAfterRequest touches only a stop that ended a wait at the LIMITER (no other stage)
		const other = new DedaloError('harvest.refused');
		expect(stoppedAfterRequest(other)).toBe(other);
		const paced = jobStoppedError('pace');
		expect(stoppedAfterRequest(paced)).toBe(paced);
		expect(refusedAfterRequest(paced)).toBe(paced);
	});
});

describe('principal_budget — each person’s share of the upstream', () => {
	beforeEach(() => clearPrincipalBudgetsForTests());
	afterEach(() => clearPrincipalBudgetsForTests());
	const { burst, refillPerSecond, maxPrincipals } = PRINCIPAL_BUDGET_LIMITS;

	test('a person may go to the provider `burst` times at once, then is refused with how long until a token', () => {
		for (let i = 0; i < burst; i++) expect(takeUpstreamToken(7, NOW).ok, `${i}`).toBe(true);
		const refused = takeUpstreamToken(7, NOW);
		expect(refused).toEqual({ ok: false, retryAfterMs: Math.ceil(1000 / refillPerSecond) });
		expect(takeUpstreamToken(7, NOW).ok, 'a refusal spends nothing').toBe(false);
	});

	test('tokens come back at the refill rate and never past the burst; time going backwards gives none', () => {
		for (let i = 0; i < burst; i++) takeUpstreamToken(7, NOW);
		expect(takeUpstreamToken(7, NOW - 60_000).ok, 'a clock that ran back').toBe(false);
		expect(takeUpstreamToken(7, NOW + 1000 / refillPerSecond - 1).ok).toBe(false);
		expect(takeUpstreamToken(7, NOW + 1000 / refillPerSecond).ok).toBe(true);
		// a long idle refills to the burst and no further
		let spent = 0;
		while (takeUpstreamToken(7, NOW + 10_000_000).ok) spent++;
		expect(spent).toBe(burst);
	});

	test('one person’s bucket is not another’s', () => {
		for (let i = 0; i < burst; i++) takeUpstreamToken(1, NOW);
		expect(takeUpstreamToken(1, NOW).ok).toBe(false);
		expect(takeUpstreamToken(2, NOW).ok).toBe(true);
		expect(takeUpstreamToken(-1, NOW).ok).toBe(true);
	});

	test('the buckets are bounded: a full bucket is no bucket, and past the ceiling the oldest goes', () => {
		for (let user = 1; user <= maxPrincipals + 50; user++) takeUpstreamToken(user, NOW);
		expect(principalBudgetsTracked()).toBeLessThanOrEqual(maxPrincipals);
		// buckets that have refilled are dropped as the next newcomer arrives
		takeUpstreamToken(900_001, NOW + 60_000);
		expect(principalBudgetsTracked(), 'everyone else had refilled').toBe(1);
	});
});

describe('tile_flights — one call per address', () => {
	beforeEach(() => clearTileFlightsForTests());
	afterEach(() => clearTileFlightsForTests());

	const deferred = <T>() => {
		let resolve: (value: T) => void = () => undefined;
		const promise = new Promise<T>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	};

	test('a request that finds a flight joins it: the work runs once, and the budget is asked only by the one that starts it', async () => {
		const gate = deferred<string>();
		let started = 0;
		let asked = 0;
		const call = () =>
			shareTileFlight(
				'k',
				undefined,
				() => {
					asked++;
					return null;
				},
				() => {
					started++;
					return gate.promise;
				},
			);
		const all = [call(), call(), call()];
		expect(tileFlightsInProgress()).toBe(1);
		gate.resolve('tile');
		expect(await Promise.all(all)).toEqual(['tile', 'tile', 'tile']);
		expect([started, asked]).toEqual([1, 1]);
		expect(tileFlightsInProgress()).toBe(0);
		// a flight leaves nothing behind: the next request starts its own
		expect(await call()).toBe('tile');
		expect([started, asked]).toEqual([2, 2]);
	});

	test('an admission that says no starts nothing and joins nothing', async () => {
		let started = 0;
		const outcome = await shareTileFlight(
			'k',
			undefined,
			() => 'busy',
			() => {
				started++;
				return Promise.resolve('tile');
			},
		);
		expect(outcome).toBe('busy');
		expect(started).toBe(0);
		expect(tileFlightsInProgress()).toBe(0);
	});

	test('the work runs under a signal of its own: it is stopped when the LAST holder leaves, not the first', async () => {
		let workSignal: AbortSignal | undefined;
		const never = new Promise<string>(() => undefined);
		const { currentJobSignal } = await import('../../src/core/media/job_scope.ts');
		const first = new AbortController();
		const second = new AbortController();
		const work = () => {
			workSignal = currentJobSignal();
			return never;
		};
		const one = shareTileFlight('k', first.signal, () => null, work);
		const two = shareTileFlight('k', second.signal, () => null, work);
		first.abort();
		await expect(one).rejects.toMatchObject({ code: 'security.outbound_failed' });
		expect(workSignal?.aborted, 'one holder is still waiting').toBe(false);
		second.abort();
		await expect(two).rejects.toMatchObject({ code: 'security.outbound_failed' });
		expect(workSignal?.aborted, 'the last one left').toBe(true);
		expect(tileFlightsInProgress()).toBe(0);
		// a viewer already gone never starts or joins a flight
		await expect(shareTileFlight('k', first.signal, () => null, work)).rejects.toMatchObject({
			code: 'security.outbound_failed',
		});
	});
});

describe('tile_log — what the operator is told, and how rarely', () => {
	beforeEach(() => clearTileLogForTests());
	afterEach(() => clearTileLogForTests());
	const { windowMs, maxKeys } = TILE_LOG_LIMITS;

	test('a distinct line is written once per window and the repeats are counted', () => {
		const written: string[] = [];
		const say = (key: string, now: number) =>
			reportOncePerWindow(key, now, () => written.push(key));
		const before = getCounters().map_tile_log_suppressed ?? 0;
		expect(say('a', NOW)).toBe(true);
		for (let i = 1; i < 20; i++) expect(say('a', NOW + i * 100)).toBe(false);
		expect(say('b', NOW)).toBe(true);
		expect(say('a', NOW + windowMs - 1)).toBe(false);
		expect(say('a', NOW + windowMs)).toBe(true);
		expect(written).toEqual(['a', 'b', 'a']);
		expect((getCounters().map_tile_log_suppressed ?? 0) - before).toBe(20);
	});

	test('the ledger is bounded and time-cleared; a clock that ran back is not "recent"', () => {
		for (let i = 0; i < maxKeys + 40; i++) reportOncePerWindow(`line ${i}`, NOW, () => undefined);
		expect(tileLogKeys()).toBeLessThanOrEqual(maxKeys);
		reportOncePerWindow('later', NOW + windowMs * 2, () => undefined);
		expect(tileLogKeys(), 'the window passed for everything else').toBe(1);
		let again = 0;
		reportOncePerWindow('later', NOW - 5000, () => again++);
		expect(again).toBe(1);
	});
});

describe('relay_request — the request the door gets carries the ORIGIN’s terms', () => {
	const TILE_UPSTREAM = {
		url: 'https://spaced.example.org/3/4/2.png',
		host: 'spaced.example.org',
		mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
	} as const;
	const PNG_HOP: PinnedHopResponse = {
		status: 200,
		headers: new Headers({ 'content-type': 'image/png' }),
		location: null,
		truncated: false,
		bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		bodySkipped: false,
	};

	beforeEach(() => clearInteractiveForTests());
	afterEach(() => clearInteractiveForTests());

	/** The pause lengths (ms) the real door slept across `count` requests built from `terms`. */
	async function pausesFor(minIntervalMs: number, count: number): Promise<number[]> {
		const slept: number[] = [];
		const clock = { now: 1_000_000 };
		const deps = {
			hop: async (_request: PinnedHopRequest) => PNG_HOP,
			now: () => clock.now,
			sleep: async (ms: number) => {
				slept.push(ms);
				clock.now += ms;
			},
			setTimer: () => undefined,
		};
		const terms = { minIntervalMs, sendReferer: false, defaultLifetimeMs: 3_600_000 };
		for (let i = 0; i < count; i++) {
			await runWithJobSignal(new AbortController().signal, () =>
				interactiveFetch(relayRequest({ addressFrom: 'registry' }, TILE_UPSTREAM, terms, 7), deps),
			);
		}
		return slept;
	}

	test('the origin’s spacing rides EVERY request: two starts are `minIntervalMs` apart through the real door, and a request built without it is not', async () => {
		expect(
			relayRequest({ addressFrom: 'registry' }, TILE_UPSTREAM, DEFAULT_TERMS, 7).minIntervalMs,
		).toBe(0);
		expect(await pausesFor(0, 3), 'no terms, no pause').toEqual([]);
		expect(await pausesFor(1_000, 1), 'the first start owes nothing yet').toEqual([]);
		clearInteractiveForTests();
		expect(await pausesFor(1_000, 3), 'each later start waits out the spacing').toEqual([
			1_000, 1_000,
		]);
		const asked = relayRequest(
			{ addressFrom: 'registry' },
			TILE_UPSTREAM,
			{ minIntervalMs: 1_000, sendReferer: false, defaultLifetimeMs: 1 },
			7,
		);
		expect(asked.minIntervalMs).toBe(1_000);
	});

	test('it names the source’s `addressFrom`, allows only the template’s host and the address’s media types, and sends nothing of the browser’s', () => {
		const terms = { minIntervalMs: 0, sendReferer: false, defaultLifetimeMs: 1 };
		const fromStored = relayRequest({ addressFrom: 'stored' }, TILE_UPSTREAM, terms, 957);
		const fromRegistry = relayRequest({ addressFrom: 'registry' }, TILE_UPSTREAM, terms, 957);
		expect(fromStored.addressFrom).toBe('stored');
		expect(fromRegistry.addressFrom).toBe('registry');
		// who is waiting is the session's user, so the door can cap one person's slots
		expect(fromStored.holder).toBe('user:957');
		expect(fromRegistry.holder).toBe('user:957');
		expect(relayRequest({ addressFrom: 'stored' }, TILE_UPSTREAM, terms, 958).holder).toBe(
			'user:958',
		);
		expect(fromStored.timeoutMs, 'an editor’s slow host holds its slots for a shorter hop').toBe(
			STORED_TIMEOUT_MS,
		);
		expect(fromRegistry.timeoutMs).toBeUndefined();
		for (const request of [fromStored, fromRegistry]) {
			expect(request.hosts).toEqual(['spaced.example.org']);
			expect(request.mediaTypes).toEqual(TILE_UPSTREAM.mediaTypes);
			expect(request.maxBytes).toBe(TILE_MAX_BYTES);
			expect(Object.keys(request.headers ?? {})).toEqual(['Accept']);
		}
	});

	test('a stale tile’s validators ride as If-None-Match / If-Modified-Since — through the real door to the wire — and nothing of the browser’s with them', async () => {
		const terms = { minIntervalMs: 0, sendReferer: false, defaultLifetimeMs: 1 };
		const validators = { etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' };
		const request = relayRequest({ addressFrom: 'registry' }, TILE_UPSTREAM, terms, 7, validators);
		expect(request.headers).toEqual({
			Accept: TILE_UPSTREAM.mediaTypes.join(','),
			'If-None-Match': '"v1"',
			'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT',
		});
		// no validators, no condition: a first fetch is a plain request
		for (const none of [null, undefined, { etag: null, lastModified: null }]) {
			expect(
				Object.keys(
					relayRequest({ addressFrom: 'registry' }, TILE_UPSTREAM, terms, 7, none).headers ?? {},
				),
			).toEqual(['Accept']);
		}
		// the door sends them (and its own User-Agent), and answers a 304 as the non-2xx it is
		const sent: PinnedHopRequest[] = [];
		const hop = async (hopRequest: PinnedHopRequest): Promise<PinnedHopResponse> => {
			sent.push(hopRequest);
			return {
				...PNG_HOP,
				status: 304,
				bytes: new Uint8Array(0),
				headers: new Headers({ etag: '"v1"' }),
			};
		};
		const answer = await runWithJobSignal(new AbortController().signal, () =>
			interactiveFetch(request, { hop, now: () => 1_000_000, setTimer: () => undefined }),
		);
		expect(answer.status).toBe(304);
		expect(answer.ok).toBe(false);
		expect(answer.headers.etag).toBe('"v1"');
		expect(sent).toHaveLength(1);
		const wire = sent[0]?.headers;
		expect(wire?.get('if-none-match')).toBe('"v1"');
		expect(wire?.get('if-modified-since')).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
		expect(wire?.get('cookie')).toBeNull();
		expect(wire?.get('authorization')).toBeNull();
	});
});

describe('public_reach — ONE rule for the origin the installation tells a provider', () => {
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

	/** `dedalo/<release identity>`: the product part every identity shares. */
	const PRODUCT = HARVEST_USER_AGENT.slice(0, HARVEST_USER_AGENT.indexOf(' '));

	/** The origin a `User-Agent` names after `marker`, or null when it names none. */
	const namedIn = (agent: string, marker: string): string | null => {
		const at = agent.indexOf(marker);
		return at === -1 ? null : agent.slice(at + marker.length, -1);
	};

	test('the Referer of the tile proxy and the User-Agents of the geo services and of the interactive door: one derivation — byte-equal origins, present or absent together — over one table', () => {
		for (const [protocol, host, origin] of PUBLIC_ORIGIN_TABLE) {
			process.env.DEDALO_PROTOCOL = protocol;
			process.env.DEDALO_HOST = host;
			const label = JSON.stringify([protocol, host]);
			expect(reachablePublicOrigin(), label).toBe(origin);
			const referer = tileReferer();
			const contact = installationUserAgent();
			const geo = geoUserAgent();
			// the exact bytes each sender puts on the wire
			expect(referer, label).toBe(origin === null ? null : `${origin}/`);
			expect(contact, label).toBe(origin === null ? HARVEST_USER_AGENT : `${PRODUCT} (+${origin})`);
			// the three agree by OUTCOME: the origin read back out of each header is the same, or absent from all
			const fromReferer = referer === null ? null : referer.slice(0, -1);
			const fromContact = contact === HARVEST_USER_AGENT ? null : namedIn(contact, ' (+');
			expect(fromContact, label).toBe(fromReferer);
			expect(namedIn(geo, '+https://dedalo.dev; '), label).toBe(fromReferer);
			// every header is printable ASCII: nothing configured reaches the wire as a delimiter or a control
			for (const header of [referer ?? '', contact, geo]) {
				expect(/^[ -~]*$/.test(header), label).toBe(true);
				expect(header, label).not.toContain('secret');
				expect(header, label).not.toContain('curator');
			}
		}
	});

	test('the SAME table decides who loads OpenStreetMap: relayed only under the installation’s own identity, else listed for the browser — never relayed under the shared one', () => {
		const osmHost = new URL(findBuiltinSource('osm')?.source.url ?? '').hostname;
		const ignHost = new URL(findBuiltinSource('ign_admin_units')?.source.url ?? '').hostname;
		let withheld = 0;
		let relayed = 0;
		for (const [protocol, host, origin] of PUBLIC_ORIGIN_TABLE) {
			process.env.DEDALO_PROTOCOL = protocol;
			process.env.DEDALO_HOST = host;
			const label = JSON.stringify([protocol, host]);
			const withholdsOsm = relayWithheld(osmHost);
			// the route's refusal and the client's signal are one rule: present or absent together
			expect(withholdsOsm, label).toBe(origin === null);
			expect(directBuiltinIds(), label).toEqual(withholdsOsm ? ['osm'] : []);
			// the outcome the policy asks for: OSM is relayed ONLY with the contact identity
			if (!withholdsOsm) {
				expect(installationUserAgent(), label).not.toBe(HARVEST_USER_AGENT);
				expect(tileReferer(), label).not.toBeNull();
			}
			// a provider that asks no identity of the relay is relayed either way (shared identity)
			expect(relayWithheld(ignHost), label).toBe(false);
			if (withholdsOsm) withheld++;
			else relayed++;
		}
		// anti-vacuity: the table holds both kinds
		expect(withheld).toBeGreaterThan(10);
		expect(relayed).toBeGreaterThan(10);
	});

	test('isReachableFromOutside judges a bare host the same way: whole well-formed labels, the suffix itself included', () => {
		for (const host of [
			'museum.org',
			'lan.museum.org',
			'internal.example.org',
			'xn--muse-tra.example.org',
			'8.8.8.8',
			'MUSEUM.ORG.',
		]) {
			expect(isReachableFromOutside(host), host).toBe(true);
		}
		for (const host of [
			'lan',
			'museo.lan',
			'MUSEO.LOCAL.',
			'localhost',
			'10.0.0.1',
			'::1',
			'[::1]',
			'arpa',
			'alt',
			'home.arpa',
			'.museum.org',
			'foo..org',
			'-.org',
			'museum.org-',
			'museum..',
			'',
		]) {
			expect(isReachableFromOutside(host), host).toBe(false);
		}
	});
});

describe('image_bytes — the bytes are the image they claim', () => {
	const bytes = (...values: number[]) => Uint8Array.from(values);
	const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56);

	test('the four signatures match their own type and no other', () => {
		const samples: [string, Uint8Array][] = [
			['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
			['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0)],
			['image/gif', bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0)],
			['image/webp', WEBP],
		];
		for (const [type, sample] of samples) {
			for (const [otherType] of samples) {
				expect(bytesMatchMediaType(sample, otherType), `${type} bytes as ${otherType}`).toBe(
					type === otherType,
				);
			}
		}
		expect(bytesMatchMediaType(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61), 'image/gif')).toBe(true);
	});

	test('markup, SVG, text and the empty body are none of them', () => {
		const html = new TextEncoder().encode('<!doctype html><html><body>error</body></html>');
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
		for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
			expect(bytesMatchMediaType(html, type), type).toBe(false);
			expect(bytesMatchMediaType(svg, type), type).toBe(false);
			expect(bytesMatchMediaType(new Uint8Array(0), type), type).toBe(false);
		}
		// a truncated signature, and a RIFF that is not WebP
		expect(bytesMatchMediaType(bytes(0x89, 0x50, 0x4e), 'image/png')).toBe(false);
		expect(
			bytesMatchMediaType(
				bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45),
				'image/webp',
			),
		).toBe(false);
	});

	test('only the four image types have a signature: SVG and HTML are refused by type, whatever the bytes', () => {
		for (const type of [
			'image/svg+xml',
			'text/html',
			'application/xml',
			'image/pngx',
			'image/',
			'',
		]) {
			expect(
				bytesMatchMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), type),
				type,
			).toBe(false);
		}
		expect(bareMediaType('Image/PNG; charset=binary')).toBe('image/png');
		expect(
			bytesMatchMediaType(bytes(0xff, 0xd8, 0xff), 'IMAGE/JPEG; q=1'),
			'parameters and case are aside',
		).toBe(true);
	});
});

describe('image_bytes — the size an image declares is read from its header, and a bomb is not relayed', () => {
	const bytes = (...values: number[]) => Uint8Array.from(values);

	const SIZES: readonly [number, number][] = [
		[1, 1],
		[256, 256],
		[512, 384],
		[1024, 1024],
		[2048, 2048],
		[65_535, 3],
	];

	test('PNG, GIF, JPEG and all three WebP chunk kinds state their size in the header, and it is read back exactly', () => {
		for (const [width, height] of SIZES) {
			const label = `${width}x${height}`;
			const png = pngHeader(width, height, 100);
			const jpeg = jpegHeader(width, height, 100);
			const gif = gifHeader(width, height, 100);
			expect(declaredImageSize(png, 'image/png'), `png ${label}`).toEqual({ width, height });
			expect(declaredImageSize(jpeg, 'image/jpeg'), `jpeg ${label}`).toEqual({ width, height });
			expect(declaredImageSize(gif, 'image/gif'), `gif ${label}`).toEqual({ width, height });
			// WebP lossy and lossless carry 14 bits per side, the extended header 24
			if (width <= 16_383 && height <= 16_383) {
				const lossy = webpHeader('VP8 ', width, height, 100);
				const lossless = webpHeader('VP8L', width, height, 100);
				expect(declaredImageSize(lossy, 'image/webp'), `vp8 ${label}`).toEqual({ width, height });
				expect(declaredImageSize(lossless, 'image/webp'), `vp8l ${label}`).toEqual({
					width,
					height,
				});
			}
			const extended = webpHeader('VP8X', width, height, 100);
			expect(declaredImageSize(extended, 'image/webp'), `vp8x ${label}`).toEqual({ width, height });
			// each image still begins like its own type, so the signature check and the size check agree
			expect(bytesMatchMediaType(png, 'image/png')).toBe(true);
			expect(bytesMatchMediaType(jpeg, 'image/jpeg')).toBe(true);
			expect(bytesMatchMediaType(gif, 'image/gif')).toBe(true);
			expect(bytesMatchMediaType(extended, 'image/webp')).toBe(true);
		}
		// the type decides how the header is read: parameters aside, case aside
		expect(declaredImageSize(pngHeader(7, 9), 'IMAGE/PNG; q=1')).toEqual({ width: 7, height: 9 });
	});

	test('a JPEG frame header is found past an APP segment that carries a thumbnail of its own', () => {
		// an EXIF-style APP1 segment holding a whole smaller JPEG: its SOF must not be mistaken for the frame
		const thumbnail = jpegHeader(160, 120);
		const app1 = [
			0xff,
			0xe1,
			(thumbnail.length + 2) >> 8,
			(thumbnail.length + 2) & 0xff,
			...thumbnail,
		];
		const real = jpegHeader(4000, 3000);
		const withThumbnail = new Uint8Array([0xff, 0xd8, ...app1, ...real.subarray(2)]);
		expect(declaredImageSize(withThumbnail, 'image/jpeg')).toEqual({ width: 4000, height: 3000 });
		// progressive (SOF2) is a frame header too; a DHT (0xc4) is not
		const progressive = jpegHeader(300, 200);
		const sof = progressive.indexOf(0xc0, 2);
		progressive[sof] = 0xc2;
		expect(declaredImageSize(progressive, 'image/jpeg')).toEqual({ width: 300, height: 200 });
		progressive[sof] = 0xc4;
		expect(declaredImageSize(progressive, 'image/jpeg'), 'DHT is no frame').toBeNull();
	});

	test('no size is a refusal: a header cut short, a scan before any frame, an empty image, an unknown type', () => {
		expect(declaredImageSize(pngHeader(256, 256).subarray(0, 23), 'image/png')).toBeNull();
		expect(
			declaredImageSize(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'),
		).toBeNull();
		expect(declaredImageSize(pngHeader(0, 256), 'image/png'), 'zero wide').toBeNull();
		expect(declaredImageSize(pngHeader(256, 0), 'image/png'), 'zero high').toBeNull();
		expect(declaredImageSize(gifHeader(0, 0), 'image/gif')).toBeNull();
		expect(declaredImageSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3), 'image/jpeg')).toBeNull();
		expect(
			declaredImageSize(bytes(0xff, 0xd8, 0xff, 0xda, 0, 2), 'image/jpeg'),
			'scan first',
		).toBeNull();
		expect(declaredImageSize(bytes(0xff, 0xd8, 0xff, 0xd9), 'image/jpeg'), 'end first').toBeNull();
		expect(
			declaredImageSize(jpegHeader(10, 10).subarray(0, 28), 'image/jpeg'),
			'cut in the SOF',
		).toBeNull();
		expect(declaredImageSize(webpHeader('VP8 ', 9, 9).subarray(0, 28), 'image/webp')).toBeNull();
		const unknownChunk = webpHeader('VP8X', 9, 9);
		unknownChunk.set([0x58, 0x58, 0x58, 0x58], 12);
		expect(declaredImageSize(unknownChunk, 'image/webp')).toBeNull();
		expect(declaredImageSize(pngHeader(9, 9), 'image/svg+xml')).toBeNull();
		expect(declaredImageSize(new Uint8Array(0), 'image/png')).toBeNull();
	});

	test('the limit is per side AND in all: a decode bomb in any of the four formats is outside it, a map’s images are inside', () => {
		expect(RELAYED_IMAGE_LIMITS.maxSide).toBe(2048);
		expect(RELAYED_IMAGE_LIMITS.maxPixels).toBe(4 * 1024 * 1024);
		// the largest thing the proxy itself asks for (a free image) and a retina tile are inside, with room
		expect(MAX_IMAGE_SIDE).toBeLessThanOrEqual(RELAYED_IMAGE_LIMITS.maxSide);
		expect(withinRelayedLimits({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE })).toBe(true);
		expect(withinRelayedLimits({ width: 512, height: 512 })).toBe(true);
		expect(withinRelayedLimits({ width: 2048, height: 2048 })).toBe(true);
		expect(withinRelayedLimits({ width: 2049, height: 1 })).toBe(false);
		expect(withinRelayedLimits({ width: 1, height: 2049 })).toBe(false);
		// each side inside, the area not: not a shape a map ever asks for
		expect(withinRelayedLimits({ width: 2048, height: 2049 })).toBe(false);
		for (const bomb of [
			pngHeader(30_000, 30_000, 2 * 1024 * 1024),
			jpegHeader(30_000, 30_000, 2 * 1024 * 1024),
			gifHeader(60_000, 60_000, 2 * 1024 * 1024),
			webpHeader('VP8X', 100_000, 100_000, 2 * 1024 * 1024),
		]) {
			const type = bytesMatchMediaType(bomb, 'image/png')
				? 'image/png'
				: bytesMatchMediaType(bomb, 'image/jpeg')
					? 'image/jpeg'
					: bytesMatchMediaType(bomb, 'image/gif')
						? 'image/gif'
						: 'image/webp';
			const size = declaredImageSize(bomb, type);
			expect(size, type).not.toBeNull();
			expect(withinRelayedLimits(size as { width: number; height: number }), type).toBe(false);
		}
	});
});

describe('builtin_sources — a closed registry of verified providers', () => {
	test('exactly the providers whose terms were verified; DARE, Catastro, Carto, ArcGIS and Google are not in it', () => {
		expect([...BUILTIN_SOURCE_IDS]).toEqual(['osm', 'ign_admin_units']);
		expect(builtinPickerEntries().map((entry) => entry.id)).toEqual([...BUILTIN_SOURCE_IDS]);
		for (const id of [
			'dare',
			'catastro',
			'carto',
			'arcgis',
			'google',
			'esri',
			'mapbox',
			'toString',
		]) {
			expect(findBuiltinSource(id), id).toBeNull();
		}
		expect(findBuiltinSource(undefined)).toBeNull();
		expect(findBuiltinSource({ toString: () => 'osm' })).toBeNull();
		expect(findBuiltinSource('osm')?.source.type).toBe('xyz');
	});

	test('every row passes the validator a STORED source passes, over https, with an attribution and no markup', () => {
		expect(builtinProblems()).toEqual([]);
		for (const id of BUILTIN_SOURCE_IDS) {
			const row = findBuiltinSource(id);
			expect(row?.source.url.startsWith('https://'), id).toBe(true);
			expect(row?.source.attribution.length, id).toBeGreaterThan(0);
			expect(row?.source.attribution, id).not.toMatch(/[<>]/);
		}
	});

	test('the registry is read-only to everyone who imports it, to its leaves', () => {
		const osm = findBuiltinSource('osm');
		expect(Object.isFrozen(osm)).toBe(true);
		expect(Object.isFrozen(osm?.source)).toBe(true);
		expect(Object.isFrozen(osm?.source.params)).toBe(true);
		expect(Object.isFrozen(osm?.terms)).toBe(true);
		expect(() => {
			(osm as { source: { url: string } }).source.url = 'https://evil.example.org/{z}/{x}/{y}';
		}).toThrow();
		expect(findBuiltinSource('osm')?.source.url).toBe(
			'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
		);
	});

	test('the terms are a property of the ORIGIN: OSM’s are owed to its host, whoever’s record asked', () => {
		const osm = termsFor('tile.openstreetmap.org');
		expect(osm.sendReferer).toBe(true);
		expect(osm.defaultLifetimeMs).toBe(7 * 24 * 3600 * SECONDS);
		expect(termsFor('TILE.OpenStreetMap.org')).toEqual(osm);
		expect(termsFor('www.ign.es').sendReferer).toBe(false);
		expect(termsFor('tiles.example.org')).toEqual(DEFAULT_TERMS);
		// compared as the redirect allowlist compares a host (root dot, case, padding) — but exactly
		expect(termsFor('tile.openstreetmap.org.')).toEqual(osm);
		expect(termsFor(' TILE.OpenStreetMap.org. ')).toEqual(osm);
		expect(termsFor('WWW.ign.es.')).toEqual(termsFor('www.ign.es'));
		expect(termsFor('www.ign.es.')).not.toEqual(DEFAULT_TERMS);
		expect(termsFor('ign.es'), 'a parent is another origin').toEqual(DEFAULT_TERMS);
		expect(termsFor('a.tile.openstreetmap.org'), 'an unreviewed alias').toEqual(DEFAULT_TERMS);
		expect(termsFor('tile.openstreetmap.org.evil.test')).toEqual(DEFAULT_TERMS);
		expect(
			termsFor('evil.tile.openstreetmap.org'),
			'a look-alike subdomain is another origin',
		).toEqual(DEFAULT_TERMS);
		expect(
			DEFAULT_TERMS.sendReferer,
			'a stored host never receives the installation’s address',
		).toBe(false);
	});

	test('the identity requirement follows the PROVIDER — every host under each of its domains, any root dots or case — not only its template host', () => {
		expect(findBuiltinSource('osm')?.requiresInstallationIdentity).toBe(true);
		expect(findBuiltinSource('ign_admin_units')?.requiresInstallationIdentity).toBe(false);
		expect(findBuiltinSource('ign_admin_units')?.identityDomains).toEqual([]);
		for (const host of [
			'tile.openstreetmap.org',
			'TILE.OpenStreetMap.org.',
			'tile.openstreetmap.org..',
			' tile.openstreetmap.org ',
			'a.tile.openstreetmap.org',
			'evil.tile.openstreetmap.org',
			'openstreetmap.org',
			// the same tile servers under the foundation's other names
			'tile.osm.org',
			'a.tile.osm.org',
			'osm.org.',
			'tile.openstreetmap.com',
			'TILE.OPENSTREETMAP.COM..',
		]) {
			expect(identityRequiredFor(host), host).toBe(true);
		}
		for (const host of [
			'www.ign.es',
			'tiles.example.org',
			'tile.openstreetmap.org.evil.test',
			'osm.org.evil.test',
			'notosm.org',
			'myopenstreetmap.com',
			'tile.openstreetmap.de',
			'',
		]) {
			expect(identityRequiredFor(host), host).toBe(false);
		}
	});
});
