/**
 * THE MAP TILE PROXY — `GET /dedalo/core/api/v1/map_tile` (src/core/api/map_tile.ts), driven
 * end to end: the real session gate, the real permission resolvers, the real record scope,
 * the real SSRF guard and harvesting door, against a loopback peer that stands in for the
 * provider (the resolver and the socket are the door's test seams; the route reads them from
 * the geo outbound scope, which only a gate can open — geo_services/geo_seams.ts).
 *
 * THE SITUATION (scratch TLD `zztile`, matrix_test, torn down; no ontology node of the engine
 * is touched). Section zztile1 with a geolocation component zztile2 (carrying ontology
 * DEFAULT map sources), a text component zztile3, a projects filter zztile4; zztile10, a
 * VIRTUAL section of zztile1; zztile20 with a geolocation zztile21 of its own. Records hold
 * stored sources — including hostile ones written PAST the save gate, because a restore, a
 * revert or an old row can carry anything. Five non-admin identities differ in exactly one
 * thing each (the component grant, the section grant, the project, the virtual-section key).
 *
 * WHAT IS PROVED (each clause is a test below):
 *   PERMISSION  no session, a garbage cookie, a cross-site or speculative request, the
 *               component denied, the section denied, another project, an unknown source, an
 *               unknown record, another model's tipo, a component of another section: ONE
 *               refusal — byte-identical bodies, so "forbidden" cannot be told from "unknown".
 *               The grant is read on the section AS ADDRESSED (a virtual twin).
 *   ORDER       a denied caller is refused with the tile SITTING IN THE MEMORY; the memory is
 *               keyed by the upstream address and never by a user.
 *   SSRF        a private literal in a stored template, a redirect to a private resolution, to
 *               another host, to another port, credentials in the template: nothing reaches a
 *               socket the guard did not vet.
 *   ANSWER      SVG, HTML, an image whose bytes are not its type, an oversize body, a failing
 *               provider: one refusal that names no host, address or token, and nothing cached.
 *               A provider that says "no such tile" (404, 410, no content) or answers a 2xx that
 *               is not an image is the uniform not-found, NOT a fault.
 *   BUDGET      one person cannot use the provider up: past their burst a miss is `rate.limited`
 *               before the door sees it, a memory hit and a joined call cost nothing, a second
 *               person is untouched, and a caller who failed a gate learns nothing from it.
 *   FLIGHT      identical concurrent misses are ONE provider call; a caller who fails a gate never
 *               joins one; the call survives a viewer leaving while another waits and is stopped
 *               when the last one goes.
 *   NOISE       what a caller controls is counted, not logged; what the operator can act on is
 *               one line per source and reason per window, however many tiles fail.
 *   INJECTION   a WMS value written past the gate, a bbox/size/extra key in the query: no
 *               parameter the server did not set reaches the provider.
 *   MEMORY      keyed by upstream URL; only verified images — the provider's "no such tile" is
 *               NOT remembered (the browser is told it may remember it, and that is all); the
 *               provider's lifetime; its no-store; the byte ceiling. A source that is DATA is kept
 *               by a browser for minutes, not a day.
 *   REVALIDATE  a tile past its freshness that came with a validator is asked about with
 *               `If-None-Match` / `If-Modified-Since`: a 304 renews it, a 200 replaces it, a 404
 *               drops it; the condition goes to the provider that gave the validator and nowhere else.
 *   IMAGE       a header that declares a decode bomb (or no size at all) is not relayed.
 *   CAPACITY    a viewport of a 4K display loads whole; what the door cannot take in time is BUSY
 *               (429, Retry-After, counted apart, never a failing provider) and is not charged.
 *   FAIRNESS    one person's storm of tiles at a registry origin is a few places in its queue,
 *               never the whole of it: a second person's tile is served after ONE turnover.
 *   ABANDONED   a call every viewer left while it waited for its place was never sent: not charged.
 *   HOLDER      one person's slow hosts hold a few stored slots, never the stored budget.
 *   DOOR        names `addressFrom` truthfully, honours the client going away, sends the Referer
 *               only where a provider's terms ask. (That the request passes the ORIGIN's spacing is
 *               gated where it can be seen: relay_request in map_tile_geometry_native, with a
 *               synthetic non-zero spacing, because no registry row owes one today.)
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from 'bun:test';
import { getCounters } from '../../src/core/api/counters.ts';
import { handleMapTile } from '../../src/core/api/map_tile.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { readNestedItemsById } from '../../src/core/db/matrix_entry_read.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithQueryTap } from '../../src/core/db/query_tap.ts';
import {
	clearPrincipalBudgetsForTests,
	PRINCIPAL_BUDGET_LIMITS,
	principalBudgetsTracked,
} from '../../src/core/geo/tile_proxy/principal_budget.ts';
import {
	clearTileCacheForTests,
	TILE_CACHE_LIMITS,
	tilesKept,
} from '../../src/core/geo/tile_proxy/tile_cache.ts';
import {
	clearTileFlightsForTests,
	tileFlightsInProgress,
} from '../../src/core/geo/tile_proxy/tile_flights.ts';
import {
	clearTileLogForTests,
	TILE_LOG_LIMITS,
	tileLogKeys,
} from '../../src/core/geo/tile_proxy/tile_log.ts';
import {
	type GeoServiceDeps,
	runWithGeoServiceSeams,
} from '../../src/core/geo_services/geo_seams.ts';
import { siteKey } from '../../src/core/harvest/follow.ts';
import { HARVEST_USER_AGENT } from '../../src/core/harvest/identity.ts';
import {
	clearInteractiveForTests,
	INTERACTIVE_MAX_CONCURRENT,
	INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
	INTERACTIVE_MAX_STORED_PER_HOLDER,
	interactiveHolderAtOriginState,
	interactiveHolderState,
	interactiveState,
} from '../../src/core/harvest/interactive_limits.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
} from '../../src/core/security/permissions.ts';
import { READ_DOOR_EXTRA_DOORS, READ_DOOR_POSTURE } from '../../src/core/security/read_door.ts';
import { createSession, SESSION_COOKIE } from '../../src/core/security/session_store.ts';
import {
	type AddressLookup,
	nat64DiscoveryState,
	type PinnedFetchInit,
	setNat64DiscoveryForTests,
} from '../../src/core/security/ssrf_guard.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { handleRequest } from '../../src/server.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { gifHeader, jpegHeader, pngHeader, webpHeader } from '../helpers/image_headers.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

// ---------------------------------------------------------------------------
// The scratch structure and identities
// ---------------------------------------------------------------------------

const SECTION = 'zztile1';
const GEO = 'zztile2';
const TEXT = 'zztile3';
const FILTER = 'zztile4';
const VIRTUAL = 'zztile10';
const OTHER_SECTION = 'zztile20';
const OTHER_GEO = 'zztile21';
const RECORD = 1;
const OUT_OF_PROJECT_RECORD = 2;
/** A record whose drawn layers run to megabytes, beside one small source (the narrow-read gate). */
const BIG_RECORD = 4;
const VIRTUAL_RECORD = 1;
const MISSING_RECORD = 999;
const P_IN = 957121;
const P_OUT = 957122;

const TILE_PATH = '/dedalo/core/api/v1/map_tile';
const TILE = 'z=3&x=4&y=2';

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

/** Stored sources: ids 1-6 are legitimate, 7-10 are hostile bytes written PAST the save gate. */
const xyz = (url: string, over: Record<string, unknown> = {}) => ({
	type: 'xyz',
	url,
	params: {},
	attribution: 'Example',
	...over,
});
const wms = (
	over: Record<string, unknown> = {},
	url = 'https://wms.example.org/service?map=abc',
) => ({
	type: 'wms',
	url,
	params: {
		version: '1.3.0',
		layers: 'roads,rail',
		styles: '',
		format: 'image/png',
		transparent: true,
		crs: 'EPSG:4326',
		...over,
	},
	attribution: '',
});

const STORED_SOURCES = [
	{ id: 1, ...xyz('https://tiles.example.org/{z}/{x}/{y}.png') },
	{ id: 2, ...wms() },
	{ id: 3, ...wms({ version: '1.1.1', crs: 'EPSG:3857' }) },
	{ id: 4, ...xyz('https://tiles.example.org/{z}/{x}/{y}.png', { attribution: 'Same address' }) },
	{ id: 5, ...xyz('https://zoom.example.org/{z}/{x}/{y}.png', { params: { max_zoom: 5 } }) },
	{ id: 6, ...xyz('https://redirect.example.org/{z}/{x}/{y}.png') },
	// hostile — never valid, written straight into the column
	{ id: 7, ...xyz('http://127.0.0.1/{z}/{x}/{y}.png') },
	{ id: 8, ...wms({ layers: 'a&service=WFS' }) },
	{ id: 9, ...xyz('https://user:pw@tiles.example.org/{z}/{x}/{y}.png') },
	// hostile — another port: the validator refuses it at save, import and fetch time alike, because
	// the door reaches only the scheme's own port (the door's own refusal is driven by the redirects)
	{ id: 10, ...xyz('https://tiles.example.org:8443/{z}/{x}/{y}.png') },
	{ id: 11, ...xyz('https://secret.example.org/{z}/{x}/{y}.png?key=tok_STORED_SECRET') },
	{ id: 12, ...xyz('https://slow.example.org/{z}/{x}/{y}.png') },
	{ id: 13, ...wms({ crs: 'EPSG:3857', version: '1.3.0' }, 'https://wms2.example.org/service') },
	// an editor's address that names a registry host
	{ id: 14, ...xyz('https://tile.openstreetmap.org/{z}/{x}/{y}.png') },
	// the same registry host spelled with its root dot, and a name under it
	{ id: 15, ...xyz('https://TILE.openstreetmap.org./{z}/{x}/{y}.png') },
	{ id: 16, ...xyz('https://a.tile.openstreetmap.org/{z}/{x}/{y}.png') },
];

const geoValue = (sources: unknown[]) => ({
	[GEO]: [{ id: 1, lat: 39.47, lon: -0.37, zoom: 5, sources }],
});

/** About 1.6 MB of drawn layers: the weight a geolocation value can carry beside its sources. */
const BIG_LAYERS = [
	{
		layer_id: 1,
		layer_data: {
			type: 'FeatureCollection',
			features: Array.from({ length: 4000 }, (_, index) => ({
				type: 'Feature',
				properties: { n: index, pad: 'x'.repeat(300) },
				geometry: { type: 'Point', coordinates: [index / 100, index / 100] },
			})),
		},
	},
];
const BIG_SOURCE = xyz('https://tiles.example.org/{z}/{x}/{y}.png', { id: 1 });

const DEFAULT_SOURCES = [
	{
		id: 'regional',
		label: 'Regional',
		type: 'xyz',
		url: 'https://default.example.org/{z}/{x}/{y}.png?key=tok_DEFAULT_SECRET',
		params: {},
		attribution: 'Regional',
	},
	{
		id: 'broken',
		label: 'Broken',
		type: 'xyz',
		url: 'http://localhost/{z}/{x}/{y}.png',
		params: {},
		attribution: '',
	},
];

const SITUATION = situation({
	name: 'map tile proxy',
	tld: 'zztile',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'zztile host' } },
		{
			tipo: GEO,
			parent: SECTION,
			model: 'component_geolocation',
			order_number: 1,
			term: { 'lg-eng': 'Map' },
			properties: { map_sources: DEFAULT_SOURCES },
		},
		{ tipo: TEXT, parent: SECTION, model: 'component_input_text', order_number: 2 },
		{
			tipo: FILTER,
			parent: SECTION,
			model: 'component_filter',
			order_number: 3,
			term: { 'lg-eng': 'Projects' },
			relations: [{ tipo: 'dd153' }],
		},
		{
			tipo: VIRTUAL,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'zztile virtual' },
			relations: [{ tipo: SECTION }],
		},
		{ tipo: OTHER_SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'zztile other' } },
		{
			tipo: OTHER_GEO,
			parent: OTHER_SECTION,
			model: 'component_geolocation',
			order_number: 1,
			term: { 'lg-eng': 'Other map' },
		},
	],
	records: [
		{
			section_tipo: SECTION,
			section_id: RECORD,
			columns: {
				relation: { [FILTER]: [locator(FILTER, 'dd153', P_IN)] },
				geo: geoValue(STORED_SOURCES),
			},
		},
		{
			section_tipo: SECTION,
			section_id: OUT_OF_PROJECT_RECORD,
			columns: {
				relation: { [FILTER]: [locator(FILTER, 'dd153', P_OUT)] },
				geo: geoValue(STORED_SOURCES.slice(0, 1)),
			},
		},
		{
			section_tipo: SECTION,
			section_id: BIG_RECORD,
			columns: {
				relation: { [FILTER]: [locator(FILTER, 'dd153', P_IN)] },
				geo: {
					[GEO]: [
						{ id: 1, lat: 39.47, lon: -0.37, zoom: 5, lib_data: BIG_LAYERS, sources: [BIG_SOURCE] },
					],
				},
			},
		},
		{
			section_tipo: VIRTUAL,
			section_id: VIRTUAL_RECORD,
			columns: {
				relation: { [FILTER]: [locator(FILTER, 'dd153', P_IN)] },
				geo: geoValue(STORED_SOURCES.slice(0, 1)),
			},
		},
	],
});

const grant = (id: number, sectionTipo: string, tipo: string, value: number) => ({
	id,
	tipo,
	section_tipo: sectionTipo,
	value,
});

const FULL_GRANTS = [
	grant(1, SECTION, SECTION, 1),
	grant(2, SECTION, GEO, 1),
	grant(3, SECTION, FILTER, 1),
	// A misconfigured matrix the ontology must still overrule: the text component and a
	// component of ANOTHER section, granted under this section's key.
	grant(4, SECTION, TEXT, 1),
	grant(5, SECTION, OTHER_GEO, 1),
];

interface Identity {
	readonly user: number;
	readonly profile: number;
	readonly project: number;
	readonly grants: ReturnType<typeof grant>[];
}

const IDENTITIES = {
	allowed: { user: 957101, profile: 957111, project: P_IN, grants: FULL_GRANTS },
	noComponent: {
		user: 957102,
		profile: 957112,
		project: P_IN,
		grants: [
			grant(1, SECTION, SECTION, 1),
			grant(2, SECTION, FILTER, 1),
			grant(3, SECTION, GEO, 0),
		],
	},
	noSection: {
		user: 957103,
		profile: 957113,
		project: P_IN,
		grants: [grant(1, SECTION, GEO, 1), grant(2, SECTION, FILTER, 1)],
	},
	otherProject: { user: 957104, profile: 957114, project: P_OUT, grants: FULL_GRANTS },
	virtualOnly: {
		user: 957105,
		profile: 957115,
		project: P_IN,
		grants: [
			grant(1, VIRTUAL, VIRTUAL, 1),
			grant(2, VIRTUAL, GEO, 1),
			grant(3, VIRTUAL, FILTER, 1),
		],
	},
} as const satisfies Record<string, Identity>;

type Who = keyof typeof IDENTITIES;

async function insertRow(table: string, sectionTipo: string, sectionId: number, columns: object) {
	const entries = Object.entries(columns);
	const names = entries.map(([name]) => `"${name}"`).join(', ');
	const values = entries.map((_, index) => `$${index + 3}::text::jsonb`).join(', ');
	await sql.unsafe(
		`INSERT INTO "${table}" (section_tipo, section_id, ${names}) VALUES ($1, $2, ${values})`,
		[sectionTipo, sectionId, ...entries.map(([, value]) => encodeForJsonb(value))],
	);
}

async function mintIdentity(identity: Identity) {
	await insertRow('matrix_profiles', 'dd234', identity.profile, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zztile profile ${identity.profile}` }] },
		misc: { dd774: identity.grants },
	});
	await insertRow('matrix_users', 'dd128', identity.user, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `zztile_${identity.user}` }] },
		relation: {
			dd131: [locator('dd131', 'dd64', 1)],
			dd244: [locator('dd244', 'dd64', 2)],
			dd515: [locator('dd515', 'dd64', 2)],
			dd1725: [locator('dd1725', 'dd234', identity.profile)],
			dd170: [locator('dd170', 'dd153', identity.project)],
		},
	});
}

function clearSecurityCaches() {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	clearUserFilterRecordsCache();
}

async function sweepIdentities() {
	await assertTestDatabase('map_tile_proxy_native sweep');
	for (const identity of Object.values(IDENTITIES)) {
		await deleteMatrixRecord('matrix_users', 'dd128', identity.user);
		await deleteMatrixRecord('matrix_profiles', 'dd234', identity.profile);
	}
	clearSecurityCaches();
}

// ---------------------------------------------------------------------------
// The environment, the loopback provider, the door's seams
// ---------------------------------------------------------------------------

const originalDiscovery = nat64DiscoveryState();
const PINNED_SETTINGS = [
	'DEDALO_DEBUG_API_ERRORS',
	'DEDALO_NAT64_PREFIXES',
	'DEDALO_HOST',
	'DEDALO_PROTOCOL',
] as const;
const originalSettings = new Map(PINNED_SETTINGS.map((key) => [key, process.env[key]]));

const PUBLIC_V4 = '93.184.216.34';
const PRIVATE_V4 = '10.0.0.5';

/** Every name resolves to a public address except the one that stands for an internal resolution. */
const lookup: AddressLookup = async (host) => [
	{ address: host === 'internal.redirect.example.org' ? PRIVATE_V4 : PUBLIC_V4, family: 4 },
];

interface Received {
	readonly host: string;
	readonly pathname: string;
	readonly search: string;
	readonly query: URLSearchParams;
	readonly headers: Headers;
}

type Responder = (received: Received) => Response | Promise<Response>;

const peer = {
	received: [] as Received[],
	pinned: [] as string[],
	respond: (() => new Response('')) as Responder,
};

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const received: Received = {
			host: request.headers.get('x-test-host') ?? '',
			pathname: url.pathname,
			search: url.search,
			query: url.searchParams,
			headers: request.headers,
		};
		peer.received.push(received);
		return await peer.respond(received);
	},
});

afterAll(() => {
	server.stop(true);
});

/** The door's socket seam: record the pinned address, then talk to the loopback peer instead. */
const socketSeam: NonNullable<GeoServiceDeps['fetch']> = (url, init: PinnedFetchInit) => {
	const target = new URL(url);
	const headers = new Headers(init.headers);
	peer.pinned.push(target.hostname);
	headers.set('x-test-host', headers.get('host') ?? '');
	headers.delete('host');
	return fetch(`http://127.0.0.1:${server.port}${target.pathname}${target.search}`, {
		method: init.method,
		headers,
		redirect: 'manual',
		signal: init.signal ?? null,
	});
};

const clock = { now: 5_000_000_000 };

function depsOf(withClock = false): GeoServiceDeps {
	return { lookup, fetch: socketSeam, ...(withClock ? { limiter: { now: () => clock.now } } : {}) };
}

beforeEach(() => {
	for (const key of PINNED_SETTINGS) process.env[key] = '';
	setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
	peer.received = [];
	peer.pinned = [];
	peer.respond = () => imageResponse(pngBytes());
	clock.now = 5_000_000_000;
	clearInteractiveForTests();
	clearTileCacheForTests();
	clearPrincipalBudgetsForTests();
	clearTileFlightsForTests();
	clearTileLogForTests();
});

afterEach(() => {
	for (const [key, value] of originalSettings) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setNat64DiscoveryForTests(originalDiscovery);
	clearInteractiveForTests();
	clearTileCacheForTests();
	clearPrincipalBudgetsForTests();
	clearTileFlightsForTests();
	clearTileLogForTests();
});

/** A 256 px PNG: a real header (signature + IHDR), zeros for the rest, `total` bytes long. */
function pngBytes(total = 80): Uint8Array {
	return pngHeader(256, 256, total);
}

function imageResponse(
	body: Uint8Array | string,
	type = 'image/png',
	headers: Record<string, string> = {},
): Response {
	return new Response(body as BodyInit, {
		headers: { 'content-type': type, 'cache-control': 'max-age=3600', ...headers },
	});
}

// ---------------------------------------------------------------------------
// Asking the route
// ---------------------------------------------------------------------------

const tokens = new Map<string, string>();

function tokenOf(who: Who | 'root'): string {
	const cached = tokens.get(who);
	if (cached !== undefined) return cached;
	const token =
		who === 'root'
			? createSession(-1, 'root', true)
			: createSession(IDENTITIES[who].user, `zztile_${IDENTITIES[who].user}`, false);
	tokens.set(who, token);
	return token;
}

const stored = (id: number, view = TILE, record = RECORD, section = SECTION, component = GEO) =>
	`section_tipo=${section}&section_id=${record}&component_tipo=${component}&source_id=${id}&${view}`;
const named = (id: string, view = TILE, section = SECTION, component = GEO) =>
	`section_tipo=${section}&component_tipo=${component}&default_id=${id}&${view}`;
const builtin = (id: string, view = TILE, section = SECTION, component = GEO) =>
	`section_tipo=${section}&component_tipo=${component}&builtin=${id}&${view}`;

interface AskOptions {
	readonly who?: Who | 'root' | null;
	readonly headers?: Record<string, string>;
	readonly signal?: AbortSignal;
	readonly deps?: GeoServiceDeps;
}

function ask(queryText: string, options: AskOptions = {}): Promise<Response> {
	const who = options.who === undefined ? 'allowed' : options.who;
	const headers = new Headers(options.headers);
	if (who !== null) headers.set('cookie', `${SESSION_COOKIE}=${tokenOf(who)}`);
	const request = new Request(`http://localhost${TILE_PATH}?${queryText}`, {
		headers,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	return runWithGeoServiceSeams(options.deps ?? depsOf(), () =>
		handleMapTile(request, new URL(request.url), 'tile-gate'),
	);
}

/** What a response shows a caller, without the request id (unique per response). */
async function shown(
	response: Response,
): Promise<{ status: number; type: string | null; body: unknown }> {
	const text = await response.text();
	let body: unknown = text;
	try {
		const { request_id: _requestId, ...rest } = JSON.parse(text) as Record<string, unknown>;
		body = rest;
	} catch {
		/* not JSON: an image */
	}
	return { status: response.status, type: response.headers.get('content-type'), body };
}

async function errorCode(response: Response): Promise<string | null> {
	const parsed = JSON.parse(await response.text()) as { error?: { code?: string } };
	return parsed.error?.code ?? null;
}

/** Strings no refusal may carry: the provider's names, the pinned address, the token. */
const FORBIDDEN_IN_REFUSALS = [
	'example.org',
	PUBLIC_V4,
	PRIVATE_V4,
	'127.0.0.1',
	'tok_STORED_SECRET',
	'tok_DEFAULT_SECRET',
	'https://',
	'robots',
];

async function expectOneRefusal(response: Response, code: string, status: number) {
	const text = await response.clone().text();
	expect(response.status).toBe(status);
	expect(await errorCode(response)).toBe(code);
	for (const forbidden of FORBIDDEN_IN_REFUSALS) {
		expect(text, `a refusal showed "${forbidden}"`).not.toContain(forbidden);
	}
}

async function imageBytes(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turn = 0; turn < 400 && !condition(); turn++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(condition(), what).toBe(true);
}

// ---------------------------------------------------------------------------
// Database situation
// ---------------------------------------------------------------------------

describe.if(DB_READY)('map tile proxy — gates, door and memory, end to end', () => {
	beforeAll(async () => {
		await assertTestDatabase('map_tile_proxy_native');
		await sweepIdentities();
		await ensureSituation(SITUATION);
		for (const identity of Object.values(IDENTITIES)) await mintIdentity(identity);
		clearSecurityCaches();
	});

	afterAll(async () => {
		await sweepIdentities();
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	// -----------------------------------------------------------------------
	// PERMISSION
	// -----------------------------------------------------------------------

	test('the allowed caller is served a stored source’s tile, exactly as the provider sent it', async () => {
		const response = await ask(stored(1));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(await imageBytes(response)).toEqual(pngBytes());
		expect(peer.received.map((r) => [r.host, r.pathname])).toEqual([
			['tiles.example.org', '/3/4/2.png'],
		]);
		expect(peer.pinned).toEqual([PUBLIC_V4]);
	});

	test('no session, a garbage cookie and a missing cookie are ONE refusal, and nothing leaves the server', async () => {
		const noCookie = await shown(await ask(stored(1), { who: null }));
		const garbage = await shown(
			await ask(stored(1), { who: null, headers: { cookie: `${SESSION_COOKIE}=not-a-session` } }),
		);
		const foreignName = await shown(
			await ask(stored(1), { who: null, headers: { cookie: 'other=1' } }),
		);
		expect(noCookie.status).toBe(404);
		expect(garbage).toEqual(noCookie);
		expect(foreignName).toEqual(noCookie);
		// …and a malformed query with no session is the SAME refusal: no oracle before the session
		expect(await shown(await ask('url=https://evil.example.org/', { who: null }))).toEqual(
			noCookie,
		);
		expect(peer.received).toEqual([]);
	});

	test('FORBIDDEN is indistinguishable from UNKNOWN: a dozen ways to not get a source, one body', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(await errorCode(await ask(stored(1), { who: null }))).toBe('resource.not_found');
		const refusals: [string, Promise<Response>][] = [
			['component denied', ask(stored(1), { who: 'noComponent' })],
			['section denied', ask(stored(1), { who: 'noSection' })],
			['another project', ask(stored(1), { who: 'otherProject' })],
			[
				'allowed, but the record is in another project',
				ask(stored(1, TILE, OUT_OF_PROJECT_RECORD)),
			],
			['unknown source id', ask(stored(99))],
			['unknown record', ask(stored(1, TILE, MISSING_RECORD))],
			[
				'another model’s tipo (a text component granted under this section)',
				ask(stored(1, TILE, RECORD, SECTION, TEXT)),
			],
			[
				'a geolocation of ANOTHER section, granted under this one',
				ask(stored(1, TILE, RECORD, SECTION, OTHER_GEO)),
			],
			['unknown default id', ask(named('nope'))],
			['unknown built-in id', ask(builtin('nope'))],
			['a rejected (broken) default', ask(named('broken'))],
			['a component that does not exist', ask(stored(1, TILE, RECORD, SECTION, 'zztile77'))],
		];
		for (const [label, pending] of refusals) {
			expect({ label, ...(await shown(await pending)) }).toEqual({ label, ...reference });
		}
		expect(peer.received, 'no refusal reached a provider').toEqual([]);
	});

	test('the grant is read on the section AS ADDRESSED: a virtual twin needs its own key', async () => {
		const virtualQuery = stored(1, TILE, VIRTUAL_RECORD, VIRTUAL);
		// the real section's grants do not open the virtual one…
		expect((await ask(virtualQuery, { who: 'allowed' })).status).toBe(404);
		// …and the virtual key alone does, with the component resolving to the REAL section’s child
		const served = await ask(virtualQuery, { who: 'virtualOnly' });
		expect(served.status).toBe(200);
		expect(await imageBytes(served)).toEqual(pngBytes());
		// the same identity has no grant on the real section
		expect((await ask(stored(1), { who: 'virtualOnly' })).status).toBe(404);
	});

	test('the superuser is unscoped; a record id below 1 is never a record', async () => {
		expect((await ask(stored(1), { who: 'root' })).status).toBe(200);
		expect((await ask(stored(1, TILE, OUT_OF_PROJECT_RECORD), { who: 'root' })).status).toBe(200);
		const zero = await ask(stored(1, TILE, 0), { who: 'root' });
		expect(zero.status, 'section_id 0 fails the grammar before any gate').toBe(400);
		expect(await errorCode(zero)).toBe('request.invalid');
	});

	test('a cross-site request and a speculative one (prefetch, prerender) are refused like any other no', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		const refused: Record<string, string>[] = [
			{ 'sec-fetch-site': 'cross-site' },
			{ 'sec-purpose': 'prefetch' },
			{ 'sec-purpose': 'prefetch;prerender' },
			{ purpose: 'prefetch' },
		];
		for (const headers of refused) {
			expect(await shown(await ask(stored(1), { headers })), JSON.stringify(headers)).toEqual(
				reference,
			);
		}
		expect(peer.received).toEqual([]);
		for (const site of ['same-origin', 'same-site', 'none']) {
			const response = await ask(stored(1), { headers: { 'sec-fetch-site': site } });
			expect(response.status, site).toBe(200);
		}
	});

	test('the query is a CLOSED grammar: no URL, no extra key, no repeat — a 400 with no echo, only after the session', async () => {
		for (const text of [
			`${stored(1)}&url=https://evil.example.org/x.png`,
			`${stored(1)}&service=WMS`,
			`${stored(1)}&${stored(1)}`,
			`${stored(1)}&section_id=2`,
			'section_tipo=zztile1&component_tipo=zztile2',
			`${named('regional')}&source_id=1`,
			stored(1, 'z=40&x=0&y=0'),
			stored(1, 'z=3&x=9&y=0'),
			stored(1, 'bbox=1,2,3&width=10&height=10'),
		]) {
			const response = await ask(text);
			expect(response.status, text).toBe(400);
			const body = await response.text();
			expect(JSON.parse(body).error.code, text).toBe('request.invalid');
			expect(body).not.toContain('evil.example.org');
		}
		expect(peer.received).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// ORDER: the gates come before the memory
	// -----------------------------------------------------------------------

	test('a denied caller is refused with the tile SITTING IN THE MEMORY; the memory serves nobody who failed a gate', async () => {
		expect((await ask(stored(1))).status).toBe(200);
		expect(tilesKept()).toBe(1);
		expect(peer.received.length).toBe(1);
		const reference = await shown(await ask(stored(1), { who: null }));
		for (const who of ['noComponent', 'noSection', 'otherProject'] as const) {
			expect(await shown(await ask(stored(1), { who })), who).toEqual(reference);
		}
		expect(await shown(await ask(stored(1, TILE, OUT_OF_PROJECT_RECORD)))).toEqual(reference);
		expect(tilesKept(), 'the entry is still there, and still not theirs').toBe(1);
		// the entitled caller is served it from memory: no second provider request
		expect((await ask(stored(1))).status).toBe(200);
		expect(peer.received.length).toBe(1);
	});

	test('the memory is keyed by the UPSTREAM ADDRESS: two sources with one template share an entry, two tiles do not', async () => {
		expect((await ask(stored(1))).status).toBe(200);
		expect((await ask(stored(4))).status, 'source 4 builds the very same address as source 1').toBe(
			200,
		);
		expect(peer.received.length).toBe(1);
		expect((await ask(stored(1, 'z=3&x=4&y=3'))).status).toBe(200);
		expect(peer.received.length).toBe(2);
		expect(tilesKept()).toBe(2);
		// another caller allowed on a record in ANOTHER project reaches the same bytes only
		// through its own gates (record 2 stores a source with the same template)
		expect(
			(await ask(stored(1, TILE, OUT_OF_PROJECT_RECORD), { who: 'otherProject' })).status,
		).toBe(200);
		expect(peer.received.length, 'same address, same entry').toBe(2);
	});

	// -----------------------------------------------------------------------
	// DEFAULTS and BUILT-INS
	// -----------------------------------------------------------------------

	test('an ontology default is relayed with its token on the wire to the provider and nowhere in the answer', async () => {
		const response = await ask(named('regional'));
		expect(response.status).toBe(200);
		expect(peer.received.map((r) => [r.host, r.pathname, r.search])).toEqual([
			['default.example.org', '/3/4/2.png', '?key=tok_DEFAULT_SECRET'],
		]);
		const headers = JSON.stringify([...response.headers.entries()]);
		expect(headers).not.toContain('tok_DEFAULT_SECRET');
		expect(headers).not.toContain('default.example.org');
	});

	test('a built-in goes to its provider with the door’s identity, the installation as Referer and no cookie of ours', async () => {
		process.env.DEDALO_PROTOCOL = 'https://';
		process.env.DEDALO_HOST = 'maps.museum-example.org';
		const response = await ask(builtin('osm'), {
			headers: { authorization: 'Bearer tok_CLIENT', 'x-forwarded-for': '203.0.113.9' },
		});
		expect(response.status).toBe(200);
		const [request] = peer.received;
		expect(request?.host).toBe('tile.openstreetmap.org');
		expect(request?.pathname).toBe('/3/4/2.png');
		// THIS INSTALLATION as the contact (`+<its public origin>`), the same origin as the Referer:
		// a provider whose policy forbids tunnelling every client behind one anonymous identity sees
		// one installation per origin
		const product = HARVEST_USER_AGENT.slice(0, HARVEST_USER_AGENT.indexOf(' '));
		expect(request?.headers.get('user-agent')).toBe(
			`${product} (+https://maps.museum-example.org)`,
		);
		expect(request?.headers.get('referer')).toBe('https://maps.museum-example.org/');
		for (const name of ['cookie', 'authorization', 'x-forwarded-for', 'origin']) {
			expect(request?.headers.get(name), name).toBeNull();
		}
		expect(request?.headers.get('accept')).toBe('image/png,image/jpeg,image/gif,image/webp');
	});

	test('the identity is not part of the cache key, and the Referer and the contact identity follow ONE rule for a malformed and an IDN address', async () => {
		process.env.DEDALO_PROTOCOL = 'https://';
		process.env.DEDALO_HOST = 'maps.museum-example.org';
		expect((await ask(builtin('osm'))).status).toBe(200);
		expect(peer.received).toHaveLength(1);
		// another identity (an intranet name: the shared one) asks for the same tile: served from the one entry
		process.env.DEDALO_HOST = 'intranet-srv01';
		expect((await ask(builtin('osm'))).status).toBe(200);
		expect(peer.received).toHaveLength(1);
		// a configured address with credentials and a path is not a clean origin and is not repaired:
		// ONE rule for both headers — no Referer AND the shared identity; the tile is still served
		clearTileCacheForTests();
		peer.received = [];
		process.env.DEDALO_HOST = 'curator:secret@maps.museum-example.org/dedalo';
		expect((await ask(builtin('osm'))).status).toBe(200);
		const [request] = peer.received;
		expect(request?.headers.get('referer')).toBeNull();
		expect(request?.headers.get('user-agent')).toBe(HARVEST_USER_AGENT);
		expect(JSON.stringify([...(request?.headers.entries() ?? [])])).not.toContain('secret');
		// an IDN host IS a clean origin: the Referer and the contact say the same punycode origin
		clearTileCacheForTests();
		peer.received = [];
		process.env.DEDALO_HOST = 'mapas.museú-example.org';
		expect((await ask(builtin('osm'))).status).toBe(200);
		const [idn] = peer.received;
		const product = HARVEST_USER_AGENT.slice(0, HARVEST_USER_AGENT.indexOf(' '));
		expect(idn?.headers.get('referer')).toBe('https://mapas.xn--muse-example-pkb.org/');
		expect(idn?.headers.get('user-agent')).toBe(
			`${product} (+https://mapas.xn--muse-example-pkb.org)`,
		);
	});

	test('the Referer is sent only where a provider’s terms ask for it, and only an origin an outside machine could reach', async () => {
		process.env.DEDALO_PROTOCOL = 'https://';
		// a stored source never receives the installation’s address…
		process.env.DEDALO_HOST = 'maps.museum-example.org';
		expect((await ask(stored(1))).status).toBe(200);
		expect(peer.received[0]?.headers.get('referer')).toBeNull();
		// (its User-Agent names the installation all the same: a stored host is a provider too)
		expect(peer.received[0]?.headers.get('user-agent')).toContain(
			'https://maps.museum-example.org',
		);
		// …and OSM gets none from an installation nobody outside can reach
		for (const host of [
			'',
			'localhost',
			'192.168.1.5',
			'intranet.local',
			'museum',
			'10.1.2.3:8443',
		]) {
			process.env.DEDALO_HOST = host;
			clearTileCacheForTests();
			peer.received = [];
			expect((await ask(builtin('osm'))).status, host).toBe(200);
			expect(peer.received[0]?.headers.get('referer'), `host "${host}"`).toBeNull();
			// an internal name is not published to a third party in the User-Agent either: the door's plain identity
			expect(peer.received[0]?.headers.get('user-agent'), `host "${host}"`).toBe(
				HARVEST_USER_AGENT,
			);
		}
	});

	test('the registry is closed: DARE, Catastro, Carto, ArcGIS and Google are not built-ins, nor is anything by its prototype', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		for (const id of ['dare', 'catastro', 'carto', 'arcgis', 'google', 'constructor', 'valueof']) {
			expect(await shown(await ask(builtin(id))), id).toEqual(reference);
		}
		expect(peer.received).toEqual([]);
	});

	test('a WMS built-in is asked for the IGN’s own layer, with the server’s parameters only', async () => {
		const response = await ask(builtin('ign_admin_units'));
		expect(response.status).toBe(200);
		const [request] = peer.received;
		expect(request?.host).toBe('www.ign.es');
		expect(request?.pathname).toBe('/wms-inspire/unidades-administrativas');
		expect([...(request?.query.keys() ?? [])]).toEqual([
			'service',
			'request',
			'version',
			'layers',
			'styles',
			'format',
			'transparent',
			'crs',
			'bbox',
			'width',
			'height',
		]);
		expect(request?.query.get('layers')).toBe('AU.AdministrativeBoundary');
		expect(request?.query.get('crs')).toBe('EPSG:3857');
	});

	// -----------------------------------------------------------------------
	// SSRF
	// -----------------------------------------------------------------------

	test('SSRF: a private literal, a loopback, credentials or a placeholder-moved host stored past the gate never reach a socket', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		for (const id of [7, 9]) {
			expect(await shown(await ask(stored(id))), `source ${id}`).toEqual(reference);
		}
		expect(peer.received).toEqual([]);
		expect(peer.pinned).toEqual([]);
	});

	test('SSRF: a redirect to an internal RESOLUTION is refused by the guard, and the private address is never dialled', async () => {
		peer.respond = (received) =>
			received.host === 'redirect.example.org'
				? new Response(null, {
						status: 302,
						headers: { location: 'https://internal.redirect.example.org/x.png' },
					})
				: imageResponse(pngBytes());
		const response = await ask(stored(6));
		await expectOneRefusal(response, 'external.transport', 503);
		expect(peer.received.map((r) => r.host)).toEqual(['redirect.example.org']);
		expect(peer.pinned).toEqual([PUBLIC_V4]);
		expect(tilesKept()).toBe(0);
	});

	test('SSRF: a redirect to another host, a private literal, or another port of the same host is refused before any socket', async () => {
		for (const location of [
			'https://other.example.org/x.png',
			'http://127.0.0.1:8080/x.png',
			'http://169.254.169.254/latest/meta-data/',
			'https://redirect.example.org:8443/x.png',
			'//other.example.org/x.png',
			'file:///etc/passwd',
		]) {
			peer.received = [];
			peer.pinned = [];
			peer.respond = () => new Response(null, { status: 302, headers: { location } });
			await expectOneRefusal(await ask(stored(6)), 'external.transport', 503);
			expect(peer.received.length, location).toBe(1);
			expect(peer.pinned, location).toEqual([PUBLIC_V4]);
		}
	});

	test('a stored address on another port is not relayed: the validator refuses it with the door, so it reads as an unknown source', async () => {
		// Written past the save gate (a restore, an old row). The shared validator now refuses an
		// explicit non-default port at fetch time, the same verdict as every other hostile value.
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(await shown(await ask(stored(10)))).toEqual(reference);
		expect(peer.received).toEqual([]);
		expect(peer.pinned).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// THE ANSWER
	// -----------------------------------------------------------------------

	test('SVG and HTML are refused — by type, and an image type over a markup body is refused by its bytes', async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
		const html = '<!doctype html><script>alert(1)</script>';
		// [label, body, type, the refusal]: an answer that is not an image TYPE is the provider
		// saying "not a tile" (the uniform not-found); an image type whose BYTES are not one is a
		// fault (a provider mislabelling markup as an image is not routine).
		const notAnImage = ['resource.not_found', 404] as const;
		const fault = ['external.transport', 503] as const;
		const cases: [string, Uint8Array | string, string, readonly [string, number]][] = [
			['svg by type', svg, 'image/svg+xml', notAnImage],
			['svg under an image/png label', svg, 'image/png', fault],
			['html by type', html, 'text/html', notAnImage],
			['html under an image/png label', html, 'image/png', fault],
			['html under an image/jpeg label', html, 'image/jpeg', fault],
			[
				'a PNG that is really a JPEG',
				Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]),
				'image/png',
				fault,
			],
			['an empty body', new Uint8Array(0), 'image/png', fault],
			['an image type that only starts like one', pngBytes(), 'image/pngx', notAnImage],
			['no content type', pngBytes(), '', ['resource.not_found', 404]],
		];
		for (const [label, body, type, [code, status]] of cases) {
			peer.received = [];
			peer.respond = () =>
				new Response(body as BodyInit, type === '' ? {} : { headers: { 'content-type': type } });
			const response = await ask(stored(1, 'z=3&x=0&y=0'));
			expect({ label, status: response.status }).toEqual({ label, status });
			expect(await errorCode(response), label).toBe(code);
			expect(tilesKept(), `${label}: nothing refused is kept`).toBe(0);
		}
	});

	test('the four image types are relayed when their bytes are what they claim, parameters on the type aside', async () => {
		const samples: [string, Uint8Array][] = [
			['image/png; charset=binary', pngBytes()],
			['image/jpeg', jpegHeader(256, 256)],
			['image/gif', gifHeader(256, 256)],
			['image/webp', webpHeader('VP8 ', 256, 256)],
			['image/webp', webpHeader('VP8L', 512, 512)],
			['image/webp', webpHeader('VP8X', 256, 256)],
		];
		for (const [index, [type, bytes]] of samples.entries()) {
			peer.respond = () => imageResponse(bytes, type);
			const response = await ask(stored(1, `z=4&x=${index}&y=0`));
			expect(response.status, type).toBe(200);
			expect(response.headers.get('content-type'), type).toBe(type.split(';')[0] ?? '');
			expect(await imageBytes(response), type).toEqual(bytes);
		}
	});

	test('the byte ceiling: an oversize body is refused; a big tile is served and not kept', async () => {
		peer.respond = () => imageResponse(pngBytes(2 * 1024 * 1024 + 1));
		await expectOneRefusal(await ask(stored(1)), 'external.transport', 503);
		expect(tilesKept()).toBe(0);

		const big = pngBytes(TILE_CACHE_LIMITS.entryBytes + 1024);
		peer.respond = () => imageResponse(big);
		const served = await ask(stored(1, 'z=5&x=1&y=1'));
		expect(served.status).toBe(200);
		expect((await imageBytes(served)).byteLength).toBe(big.byteLength);
		expect(tilesKept(), 'over the per-entry ceiling: served, not kept').toBe(0);
	});

	test('IMAGE: a header that declares a decode bomb, or no size at all, is a fault — never relayed, never kept — in all four formats', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const bombs: [string, string, Uint8Array][] = [
				['image/png', 'png', pngHeader(30_000, 30_000, 4_096)],
				['image/jpeg', 'jpeg', jpegHeader(30_000, 30_000, 4_096)],
				['image/gif', 'gif', gifHeader(60_000, 60_000, 4_096)],
				['image/webp', 'webp x', webpHeader('VP8X', 100_000, 100_000, 4_096)],
				['image/webp', 'webp lossless', webpHeader('VP8L', 16_000, 16_000, 4_096)],
				['image/png', 'png past the area ceiling', pngHeader(2_048, 2_049, 4_096)],
			];
			const noSize: [string, string, Uint8Array][] = [
				['image/png', 'a signature and nothing else', pngHeader(1, 1).subarray(0, 8)],
				['image/jpeg', 'a scan before any frame', Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])],
				['image/gif', 'a header cut short', gifHeader(1, 1).subarray(0, 8)],
			];
			for (const [index, [type, label, body]] of [...bombs, ...noSize].entries()) {
				peer.respond = () => imageResponse(body, type);
				const response = await ask(stored(1, `z=7&x=${index}&y=0`));
				await expectOneRefusal(response, 'external.transport', 503);
				expect(tilesKept(), `${label}: nothing refused is kept`).toBe(0);
			}
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(lines.some((line) => line.includes('why=image_too_large'))).toBe(true);
			expect(lines.some((line) => line.includes('why=not_the_image_it_claims'))).toBe(true);
			// the ceiling is a ceiling, not a ban on size: a retina tile and the largest free image pass
			for (const [index, side] of [512, 1024, 2048].entries()) {
				peer.respond = () => imageResponse(pngHeader(side, side, 4_096));
				expect((await ask(stored(1, `z=8&x=${index}&y=0`))).status, `${side} px`).toBe(200);
			}
		} finally {
			warn.mockRestore();
		}
	});

	test('a failing provider is ONE refusal that names nothing: 500, 429, 403, a mislabelled body and a dead socket alike, none cached', async () => {
		const failures: Responder[] = [
			() =>
				new Response('<html>internal error at db01.example.org tok_STORED_SECRET</html>', {
					status: 500,
					headers: { 'content-type': 'text/html' },
				}),
			() =>
				new Response('slow down', {
					status: 429,
					headers: { 'retry-after': '1', 'content-type': 'text/plain' },
				}),
			() => new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } }),
			() =>
				new Response(pngBytes() as BodyInit, {
					status: 500,
					headers: { 'content-type': 'image/png' },
				}),
		];
		for (const respond of failures) {
			clearInteractiveForTests();
			peer.respond = respond;
			await expectOneRefusal(await ask(stored(11)), 'external.transport', 503);
		}
		expect(tilesKept()).toBe(0);
		// the socket itself failing (the seam throws): the same refusal
		clearInteractiveForTests();
		const response = await ask(stored(11), {
			deps: {
				lookup,
				fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED 93.184.216.34:443')),
			},
		});
		await expectOneRefusal(response, 'external.transport', 503);
	});

	test('a provider that says there is NO SUCH TILE (404, 410, no content) is the uniform not-found — quiet, counted, never a failure', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const reference = await shown(await ask(stored(1), { who: null }));
			const before = getCounters();
			const answers: [string, Responder][] = [
				['404', () => new Response('missing', { status: 404 })],
				[
					'410',
					() => new Response('gone', { status: 410, headers: { 'content-type': 'text/html' } }),
				],
				['204', () => new Response(null, { status: 204 })],
				[
					'an exception report under a 200',
					() =>
						new Response('<ServiceException>LayerNotDefined</ServiceException>', {
							headers: { 'content-type': 'text/xml' },
						}),
				],
			];
			for (const [index, [label, respond]] of answers.entries()) {
				peer.respond = respond;
				expect(await shown(await ask(stored(1, `z=3&x=${index}&y=0`))), label).toEqual(reference);
			}
			expect(tilesKept()).toBe(0);
			const after = getCounters();
			const grew = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
			expect(grew('map_tile_relay_failed'), 'a missing tile is not a failure').toBe(0);
			expect(grew('map_tile_absent'), '404, 410 and the empty 204').toBe(3);
			expect(grew('map_tile_not_an_image'), 'the exception report').toBe(1);
			// …and nothing was said to the operator for the three routine ones (the exception
			// report is the one thing worth a line: it is also what a wrong layer name looks like)
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain('why=not_an_image');
		} finally {
			warn.mockRestore();
		}
	});

	test('a 429 holds the origin off: the next request to it is refused at once, with no second provider request', async () => {
		peer.respond = () =>
			new Response('slow down', {
				status: 429,
				headers: { 'retry-after': '20', 'content-type': 'text/plain' },
			});
		await expectOneRefusal(await ask(stored(11)), 'external.transport', 503);
		expect(peer.received.length).toBe(1);
		peer.respond = () => imageResponse(pngBytes());
		// the provider asked us to slow down: the next tile is BUSY (retryable, 429 with a Retry-After),
		// not a fault of a provider that is failing — and it never reached the provider
		const held = await ask(stored(11, 'z=4&x=1&y=1'));
		await expectOneRefusal(held.clone(), 'rate.limited', 429);
		expect(held.headers.get('retry-after')).toBe('2');
		expect(peer.received.length, 'the back-off refused it before the provider').toBe(1);
	});

	test('a failing provider is reported as ONE line naming the door’s code and the source — no stack, no address — and a viewer who went away is not reported at all', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		const tileLines = () =>
			warn.mock.calls.filter((call) => String(call[0]).startsWith('[map_tile]'));
		try {
			peer.respond = () =>
				new Response('boom tok_STORED_SECRET', {
					status: 500,
					headers: { 'content-type': 'text/plain' },
				});
			await ask(stored(11));
			expect(tileLines().length).toBe(1);
			expect(tileLines()[0]?.length, 'the line alone: no Error object, so no stack').toBe(1);
			expect(String(tileLines()[0]?.[0])).toBe(
				'[map_tile] external.transport why=status source=stored:zztile1.zztile2#1/11 [req tile-gate]',
			);

			warn.mockClear();
			peer.respond = (received) =>
				received.host === 'redirect.example.org'
					? new Response(null, {
							status: 302,
							headers: { location: 'https://internal.redirect.example.org/x.png' },
						})
					: imageResponse(pngBytes());
			await ask(stored(6));
			expect(String(tileLines()[0]?.[0])).toBe(
				'[map_tile] external.transport why=door door_code=security.ssrf_blocked source=stored:zztile1.zztile2#1/6 [req tile-gate]',
			);
			for (const line of tileLines().map((call) => String(call[0]))) {
				for (const forbidden of FORBIDDEN_IN_REFUSALS) expect(line).not.toContain(forbidden);
			}

			// a viewer who panned on: their abort is routine, not a fault
			warn.mockClear();
			peer.received = [];
			peer.respond = () => new Promise<Response>(() => undefined);
			const controller = new AbortController();
			const pending = ask(stored(12), { signal: controller.signal });
			await until(() => peer.received.length === 1, 'the hop reached the provider');
			controller.abort();
			await pending;
			expect(tileLines()).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test('NOISE: a provider that is down fails every tile of every viewer and writes ONE line per source and reason a minute; the rest are counted', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		const tileLines = () =>
			warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.startsWith('[map_tile]'));
		try {
			peer.respond = () => new Response('down', { status: 503, headers: { 'retry-after': '0' } });
			const before = getCounters();
			// forty tiles of one source, two viewers: one line
			for (let tile = 0; tile < 40; tile++) {
				clearInteractiveForTests(); // a 503 holds the origin off; this gate is about the log
				const who = tile % 2 === 0 ? 'allowed' : 'root';
				expect((await ask(stored(11, `z=6&x=${tile}&y=1`), { who })).status).toBe(503);
			}
			expect(tileLines().length, 'one line, not forty').toBe(1);
			const after = getCounters();
			expect((after.map_tile_relay_failed ?? 0) - (before.map_tile_relay_failed ?? 0)).toBe(40);
			expect((after.map_tile_log_suppressed ?? 0) - (before.map_tile_log_suppressed ?? 0)).toBe(39);
			// another source is another line; the same source after the window is said once more
			clearInteractiveForTests();
			await ask(stored(12, 'z=6&x=1&y=1'));
			expect(tileLines().length).toBe(2);
			const depsAt = (now: number) => ({ ...depsOf(), limiter: { now: () => now } });
			const day = 24 * 60 * 60 * 1000;
			clearInteractiveForTests();
			await ask(stored(11, 'z=6&x=2&y=1'), { deps: depsAt(Date.now() + day) });
			expect(tileLines().length, 'a day later the source is reported again').toBe(3);
			expect(tileLogKeys()).toBeLessThanOrEqual(TILE_LOG_LIMITS.maxKeys);
		} finally {
			warn.mockRestore();
		}
	});

	test('NOISE: what a caller controls writes nothing — a zoom outside the source, a view it does not take — and a stored source that fails today’s rules is said once, not per tile', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const before = getCounters();
			for (let tile = 0; tile < 25; tile++) {
				// OpenStreetMap stops at zoom 19; the grammar's own ceiling is 22
				expect((await ask(builtin('osm', `z=21&x=${tile}&y=0`))).status).toBe(404);
				// a free image of an xyz source
				expect((await ask(stored(1, `bbox=0,0,1,1&width=${tile + 1}&height=10`))).status).toBe(404);
			}
			expect(warn.mock.calls, 'a counter, never a line').toEqual([]);
			expect((getCounters().map_tile_no_address ?? 0) - (before.map_tile_no_address ?? 0)).toBe(50);
			// a hostile stored value (a layer list smuggling a parameter): a viewport asks dozens
			for (let tile = 0; tile < 30; tile++) {
				expect((await ask(stored(8, `z=3&x=${tile % 8}&y=${tile % 4}`))).status).toBe(404);
			}
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(lines.length, 'one line for the source, not thirty').toBe(1);
			expect(lines[0]).toContain('stored source 8 of zztile1.zztile2#1 fails today');
			expect(peer.received).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test('NOISE: asking for a map one may not read writes at most ONE line a window per person — a caller names pairs at will, so they are counted', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const before = getCounters();
			const reference = await shown(await ask(stored(1), { who: null }));
			warn.mockClear();
			for (let request = 0; request < 25; request++) {
				// no component grant, no section grant, and (with a distinct pair each time) a pair nobody spelled before
				for (const who of ['noComponent', 'noSection'] as const) {
					const query = stored(1, `z=3&x=${request % 8}&y=${request % 4}`);
					expect(await shown(await ask(query, { who })), `${who} ${request}`).toEqual(reference);
				}
				const odd = `section_tipo=zzq${request + 1}&component_tipo=zzr${request + 1}&builtin=osm&${TILE}`;
				expect((await ask(odd, { who: 'noComponent' })).status).toBe(404);
			}
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(
				lines.filter((line) => line.startsWith('[frontier]')),
				'the refusal is not a narrowed answer: no [frontier] line per request',
			).toEqual([]);
			const denied = lines.filter((line) => line.startsWith('[map_tile] perm.denied'));
			expect(denied.length, 'one line per person, not one per request').toBe(2);
			expect(denied.some((line) => line.includes(`user=${IDENTITIES.noComponent.user}`))).toBe(
				true,
			);
			expect(denied.some((line) => line.includes(`user=${IDENTITIES.noSection.user}`))).toBe(true);
			for (const line of denied) {
				expect(line, 'a caller-chosen name never reaches the log').not.toContain('zz');
				expect(line).not.toContain(SECTION);
			}
			const after = getCounters();
			expect((after.map_tile_denied ?? 0) - (before.map_tile_denied ?? 0)).toBe(75);
			expect(peer.received).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	// -----------------------------------------------------------------------
	// INJECTION
	// -----------------------------------------------------------------------

	test('WMS: a layer list written past the gate that smuggles a parameter is refused AGAIN at fetch time', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(await shown(await ask(stored(8)))).toEqual(reference);
		expect(peer.received).toEqual([]);
	});

	test('WMS: the server fixes service/request and the stored values; the query adds nothing the server did not set', async () => {
		const response = await ask(stored(2, 'bbox=-10.5,35,4.25,44&width=512&height=400'));
		expect(response.status).toBe(200);
		const [request] = peer.received;
		expect(request?.host).toBe('wms.example.org');
		expect(request?.pathname).toBe('/service');
		expect([...(request?.query.entries() ?? [])]).toEqual([
			['map', 'abc'],
			['service', 'WMS'],
			['request', 'GetMap'],
			['version', '1.3.0'],
			['layers', 'roads,rail'],
			['styles', ''],
			['format', 'image/png'],
			['transparent', 'TRUE'],
			['crs', 'EPSG:4326'],
			['bbox', '35,-10.5,44,4.25'], // 1.3.0 + a geographic CRS: latitude first
			['width', '512'],
			['height', '400'],
		]);
	});

	test('WMS: a tile of a 1.1.1 source is asked in `srs`, in metres, from the grid the server computed', async () => {
		const response = await ask(stored(3));
		expect(response.status).toBe(200);
		const query = peer.received[0]?.query;
		expect(query?.get('srs')).toBe('EPSG:3857');
		expect(query?.has('crs')).toBe(false);
		expect(query?.get('version')).toBe('1.1.1');
		expect(query?.get('bbox')).toBe('0,5009377.085697311,5009377.085697311,10018754.171394622');
		expect([query?.get('width'), query?.get('height')]).toEqual(['256', '256']);
	});

	test('WMS: nothing in the query can inject — every attempt is a 400 or the same no, and no provider is asked', async () => {
		for (const view of [
			'bbox=0,0,1,1%26request%3DGetFeatureInfo&width=10&height=10',
			'bbox=0,0,1,1;service=WFS&width=10&height=10',
			'bbox=0,0,1,1&width=10&height=10&layers=other',
			'bbox=0,0,1,1&width=10&height=10&request=GetFeatureInfo',
			'bbox=0,0,1,1&width=2000&height=10',
			'bbox=0,0,1,1&width=10&height=1e3',
		]) {
			const response = await ask(stored(2, view));
			expect(response.status, view).toBe(400);
		}
		// a free image outside the CRS’s world, and one that does not fit the source’s type
		const outside = await shown(await ask(stored(2, 'bbox=-10,35,400,44&width=10&height=10')));
		const typeMismatch = await shown(await ask(stored(1, 'bbox=0,0,1,1&width=10&height=10')));
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(outside).toEqual(reference);
		expect(typeMismatch).toEqual(reference);
		expect(peer.received).toEqual([]);
	});

	test('xyz: a zoom outside the source’s own bounds is not asked of the provider', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(await shown(await ask(stored(5, 'z=6&x=0&y=0')))).toEqual(reference);
		expect(peer.received).toEqual([]);
		expect((await ask(stored(5, 'z=5&x=0&y=0'))).status).toBe(200);
	});

	// -----------------------------------------------------------------------
	// MEMORY
	// -----------------------------------------------------------------------

	test('the provider’s own freshness rules the memory: kept while fresh, asked again after, never past a week', async () => {
		peer.respond = () =>
			imageResponse(pngBytes(), 'image/png', { 'cache-control': 'max-age=3600' });
		const deps = depsOf(true);
		const first = await ask(builtin('osm'), { deps });
		expect(first.headers.get('cache-control')).toBe('private, max-age=3600');
		clock.now += 3_599_000;
		const second = await ask(builtin('osm'), { deps });
		expect(second.status).toBe(200);
		expect(peer.received.length, 'still fresh: from memory').toBe(1);
		expect(second.headers.get('cache-control'), 'the browser is told what is LEFT').toBe(
			'private, max-age=1',
		);
		clock.now += 2_000;
		await ask(builtin('osm'), { deps });
		expect(peer.received.length, 'stale: asked again').toBe(2);
	});

	test('no-store, private and a freshness below the floor are served and NOT kept; the browser is told no-store for the first', async () => {
		for (const [cacheControl, expected] of [
			['no-store', 'private, no-store'],
			['private, max-age=3600', 'private, no-store'],
			['no-cache', 'private, no-store'],
			['max-age=2', 'private, max-age=2'],
			['max-age=0', 'private, max-age=0'],
		] as const) {
			clearTileCacheForTests();
			peer.respond = () =>
				imageResponse(pngBytes(), 'image/png', { 'cache-control': cacheControl });
			const response = await ask(stored(1));
			expect(response.status, cacheControl).toBe(200);
			expect(response.headers.get('cache-control'), cacheControl).toBe(expected);
			expect(tilesKept(), cacheControl).toBe(0);
		}
	});

	test('an answer with no freshness at all keeps the ORIGIN’s default: a stored host an hour, OpenStreetMap a week', async () => {
		peer.respond = () =>
			new Response(pngBytes() as BodyInit, { headers: { 'content-type': 'image/png' } });
		const stored1 = await ask(stored(1), { deps: depsOf(true) });
		expect(
			stored1.headers.get('cache-control'),
			'a stored source: the browser’s share is minutes',
		).toBe('private, max-age=300');
		const osm = await ask(builtin('osm'), { deps: depsOf(true) });
		expect(osm.headers.get('cache-control'), 'the browser’s share is capped at a day').toBe(
			'private, max-age=86400',
		);
		clock.now += 2 * 24 * 3600 * 1000;
		peer.received = [];
		await ask(builtin('osm'), { deps: depsOf(true) });
		expect(peer.received.length, 'two days later OSM’s tile is still held (its week)').toBe(0);
		await ask(stored(1), { deps: depsOf(true) });
		expect(peer.received.length, 'the stored host’s hour is long gone').toBe(1);
	});

	test('a failed answer is never kept: the next request asks the provider again', async () => {
		peer.respond = () => new Response('boom', { status: 500 });
		await ask(stored(1));
		peer.respond = () => imageResponse(pngBytes());
		expect((await ask(stored(1))).status).toBe(200);
		expect(peer.received.length).toBe(2);
		expect(tilesKept()).toBe(1);
	});

	test('MEMORY: the proxy remembers NO refusal — a provider with no such tile is asked every time — and tells the BROWSER it may remember it', async () => {
		const deps = depsOf(true);
		const reference = await shown(await ask(stored(1), { who: null }));
		peer.respond = () => new Response('missing', { status: 404 });
		const first = await ask(stored(1, 'z=6&x=1&y=1'), { deps });
		expect(await shown(first.clone())).toEqual(reference);
		expect(first.headers.get('cache-control')).toBe('private, max-age=120');
		expect(first.headers.get('vary'), 'a cached "no" is never another session’s').toBe('Cookie');
		expect(first.headers.get('content-type')).toBe('application/json');
		expect(tilesKept(), 'nothing is kept: the memory holds successful images only').toBe(0);
		const before = getCounters();
		for (let again = 0; again < 5; again++) {
			const repeat = await ask(stored(1, 'z=6&x=1&y=1'), { deps });
			expect(await shown(repeat.clone())).toEqual(reference);
			expect(repeat.headers.get('cache-control')).toBe('private, max-age=120');
		}
		expect(peer.received.length, 'every ask went to the provider again').toBe(6);
		expect((getCounters().map_tile_absent ?? 0) - (before.map_tile_absent ?? 0)).toBe(5);
		// the 410 and the empty 204 are the provider's word too
		for (const [index, respond] of [
			() => new Response('gone', { status: 410 }),
			() => new Response(null, { status: 204 }),
		].entries()) {
			peer.respond = respond;
			const answered = await ask(stored(1, `z=6&x=${index + 2}&y=1`), { deps });
			expect(answered.status).toBe(404);
			expect(answered.headers.get('cache-control')).toBe('private, max-age=120');
		}
		expect(tilesKept()).toBe(0);
	});

	test('BUDGET: a missing tile is a call that reached the provider and is charged like any other — the browser’s own cache is what spares the repeat', async () => {
		const { burst } = PRINCIPAL_BUDGET_LIMITS;
		const deps = depsOf(true);
		peer.respond = () => new Response('missing', { status: 404 });
		for (let index = 0; index < burst; index++) {
			expect((await ask(osmTile(index), { deps })).status, `tile ${index}`).toBe(404);
		}
		expect(peer.received.length).toBe(burst);
		// the burst is spent: a NEW tile is refused for the budget, and so is the same one again —
		// the proxy keeps nothing of "there is none", so there is no exemption to give it
		expect((await ask(osmTile(burst), { deps })).status).toBe(429);
		expect((await ask(osmTile(0), { deps })).status).toBe(429);
		expect(peer.received.length, 'neither reached the provider').toBe(burst);
	});

	test('MEMORY: "no such tile" tells a caller who failed a gate nothing, and a failure is never told as one', async () => {
		const deps = depsOf(true);
		peer.respond = () => new Response('missing', { status: 404 });
		const entitled = await ask(stored(1, 'z=6&x=5&y=5'), { deps });
		expect(entitled.headers.get('cache-control'), 'only an entitled caller sees the max-age').toBe(
			'private, max-age=120',
		);
		// a caller without the component grant is refused as ever, with no trace of it
		const denied = await ask(stored(1, 'z=6&x=5&y=5'), { who: 'noComponent', deps });
		expect(denied.status).toBe(404);
		expect(denied.headers.get('cache-control')).toBe('no-store');
		expect(await shown(denied)).toEqual(await shown(await ask(stored(1), { who: null })));
		expect(peer.received.length, 'the refused caller reached no provider').toBe(1);
		// a provider failing is not a fact about the tile: no "it is not there" for the browser to keep
		peer.respond = () => new Response('down', { status: 503, headers: { 'retry-after': '0' } });
		const failed = await ask(stored(1, 'z=6&x=6&y=6'), { deps });
		expect(failed.status).toBe(503);
		expect(failed.headers.get('cache-control')).toBe('no-store');
		clearInteractiveForTests();
		peer.respond = () => imageResponse(pngBytes());
		expect((await ask(stored(1, 'z=6&x=6&y=6'), { deps })).status).toBe(200);
	});

	// -----------------------------------------------------------------------
	// REVALIDATE
	// -----------------------------------------------------------------------

	test('REVALIDATE: an expired tile with a validator is asked about conditionally — a 304 renews it, a 200 replaces it, a 404 drops it', async () => {
		const deps = depsOf(true);
		const conditional = () => peer.received.map((request) => request.headers.get('if-none-match'));
		peer.respond = () =>
			imageResponse(pngBytes(80), 'image/png', {
				'cache-control': 'max-age=60',
				etag: '"v1"',
				'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
			});
		const first = await ask(builtin('osm'), { deps });
		expect(first.status).toBe(200);
		const firstBytes = await imageBytes(first);
		expect(conditional(), 'a first fetch is a plain request').toEqual([null]);
		expect(peer.received[0]?.headers.get('if-modified-since')).toBeNull();

		// still fresh: the memory answers, the provider hears nothing
		clock.now += 59_000;
		await ask(builtin('osm'), { deps });
		expect(peer.received.length).toBe(1);

		// freshness over: the tile is NOT served from the memory and NOT fetched in full — the provider is
		// asked "is it still v1?" and answers 304 with a header and no body
		clock.now += 2_000;
		peer.respond = (received) =>
			received.headers.get('if-none-match') === '"v1"'
				? new Response(null, {
						status: 304,
						headers: { 'cache-control': 'max-age=600', etag: '"v1"' },
					})
				: imageResponse(pngBytes(120));
		const renewed = await ask(builtin('osm'), { deps });
		expect(renewed.status).toBe(200);
		expect(await imageBytes(renewed), 'the kept tile, renewed').toEqual(firstBytes);
		expect(renewed.headers.get('content-type')).toBe('image/png');
		expect(renewed.headers.get('cache-control'), 'the freshness the 304 states').toBe(
			'private, max-age=600',
		);
		expect(conditional()).toEqual([null, '"v1"']);
		expect(peer.received[1]?.headers.get('if-modified-since')).toBe(
			'Wed, 21 Oct 2026 07:28:00 GMT',
		);
		expect(peer.received[1]?.headers.get('cookie'), 'nothing of ours rides along').toBeNull();
		expect(tilesKept()).toBe(1);

		// renewed for ten minutes: the memory answers again
		clock.now += 300_000;
		await ask(builtin('osm'), { deps });
		expect(peer.received.length).toBe(2);

		// the tile changed: the provider answers 200 with a new body and a new validator, which replaces it
		clock.now += 400_000;
		peer.respond = () =>
			imageResponse(pngBytes(140), 'image/png', { 'cache-control': 'max-age=60', etag: '"v2"' });
		const replaced = await ask(builtin('osm'), { deps });
		expect((await imageBytes(replaced)).byteLength).toBe(140);
		expect(conditional().at(-1), 'the old validator was still the one asked').toBe('"v1"');
		clock.now += 61_000;
		peer.respond = () => new Response('gone', { status: 404 });
		const gone = await ask(builtin('osm'), { deps });
		expect(conditional().at(-1), 'and now the new one').toBe('"v2"');
		// the provider says the tile is gone: dropped, and the next ask is a plain fetch again
		expect(gone.status).toBe(404);
		expect(tilesKept()).toBe(0);
		peer.respond = () => imageResponse(pngBytes(), 'image/png', { 'cache-control': 'max-age=60' });
		await ask(builtin('osm'), { deps });
		expect(conditional().at(-1)).toBeNull();
	});

	test('REVALIDATE: it is a provider call like any other — charged, and a viewer who fails a gate is refused with the stale tile sitting there', async () => {
		const deps = depsOf(true);
		peer.respond = () =>
			imageResponse(pngBytes(), 'image/png', { 'cache-control': 'max-age=60', etag: '"v1"' });
		await ask(builtin('osm'), { deps });
		clock.now += 61_000;
		const denied = await ask(builtin('osm'), { who: 'noComponent', deps });
		expect(denied.status).toBe(404);
		expect(await shown(denied)).toEqual(await shown(await ask(stored(1), { who: null })));
		expect(
			peer.received.length,
			'the stale tile was asked about for nobody who failed a gate',
		).toBe(1);
		// the entitled caller revalidates; the 304 costs a token of THEIR budget, as a call does
		const { burst } = PRINCIPAL_BUDGET_LIMITS;
		peer.respond = () =>
			new Response(null, { status: 304, headers: { 'cache-control': 'max-age=600' } });
		expect((await ask(builtin('osm'), { deps })).status).toBe(200);
		let more = 0;
		peer.respond = () => imageResponse(pngBytes());
		for (; more < burst; more++) {
			if ((await ask(osmTile(100 + more), { deps })).status === 429) break;
		}
		// (the first fetch's token came back with the minute that passed; the revalidation's did not)
		expect(more, 'the revalidation was charged like a call').toBe(burst - 1);
	});

	test('REVALIDATE: a provider failing the question leaves the stale tile to be asked about again, and a 304 nobody asked for is a fault', async () => {
		const deps = depsOf(true);
		peer.respond = () =>
			imageResponse(pngBytes(), 'image/png', { 'cache-control': 'max-age=60', etag: '"v1"' });
		await ask(builtin('osm'), { deps });
		clock.now += 61_000;
		peer.respond = () => new Response('down', { status: 500 });
		await expectOneRefusal(await ask(builtin('osm'), { deps }), 'external.transport', 503);
		expect(tilesKept(), 'a fault says nothing about the tile: it waits').toBe(1);
		clearInteractiveForTests();
		peer.respond = (received) =>
			received.headers.get('if-none-match') === '"v1"'
				? new Response(null, { status: 304, headers: { 'cache-control': 'max-age=600' } })
				: imageResponse(pngBytes());
		expect((await ask(builtin('osm'), { deps })).status).toBe(200);

		// a 304 to a request that carried no condition is not an answer for anything
		peer.respond = () => new Response(null, { status: 304 });
		await expectOneRefusal(
			await ask(stored(1, 'z=7&x=7&y=7'), { deps }),
			'external.transport',
			503,
		);
	});

	test('MEMORY: a source that is DATA is kept by a browser for minutes — a stored one and an ontology default — and the registry’s for the day', async () => {
		peer.respond = () =>
			imageResponse(pngBytes(), 'image/png', { 'cache-control': 'max-age=86400' });
		const deps = depsOf(true);
		for (const [label, query] of [
			['stored', stored(1)],
			['default', named('regional')],
		] as const) {
			const response = await ask(query, { deps });
			expect(response.headers.get('cache-control'), label).toBe('private, max-age=300');
			// the memory hit answers with the same cap, and with the time left when that is shorter
			const hit = await ask(query, { deps });
			expect(hit.headers.get('cache-control'), `${label} from memory`).toBe('private, max-age=300');
		}
		const registry = await ask(builtin('osm'), { deps });
		expect(
			registry.headers.get('cache-control'),
			'the closed registry changes only with the engine',
		).toBe('private, max-age=86400');
		const registryHit = await ask(builtin('osm'), { deps });
		expect(registryHit.headers.get('cache-control')).toBe('private, max-age=86400');
		// an edit of a stored source changes its UPSTREAM address, so the server memory is right at once;
		// the browser’s copy of the old tile is what the cap bounds
		clock.now += 200_000;
		expect((await ask(stored(1), { deps })).headers.get('cache-control')).toBe(
			'private, max-age=300',
		);
	});

	// -----------------------------------------------------------------------
	// THE RESPONSE
	// -----------------------------------------------------------------------

	test('the tile is a same-origin, inert, private image: nosniff, sandboxed, never public, never cross-origin', async () => {
		const response = await ask(stored(1));
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
		expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('vary')).toBe('Cookie');
		expect(response.headers.get('cache-control')).toStartWith('private, max-age=');
		expect(response.headers.get('cache-control')).not.toContain('public');
		expect(response.headers.has('access-control-allow-origin')).toBe(false);
		expect(response.headers.has('set-cookie')).toBe(false);
		// the provider's own headers do not pass through
		peer.respond = () =>
			imageResponse(pngBytes(), 'image/png', {
				'set-cookie': 'track=1',
				'access-control-allow-origin': '*',
				'content-security-policy': 'default-src *',
				server: 'nginx/1.0',
			});
		clearTileCacheForTests();
		const filtered = await ask(stored(1));
		for (const name of ['set-cookie', 'access-control-allow-origin', 'server']) {
			expect(filtered.headers.has(name), name).toBe(false);
		}
		expect(filtered.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
	});

	test('a refusal is not cacheable and says nothing: JSON, no-store, the converter’s own envelope', async () => {
		const refusal = await ask(stored(99));
		expect(refusal.headers.get('content-type')).toBe('application/json');
		expect(refusal.headers.get('cache-control')).toBe('no-store');
		const body = JSON.parse(await refusal.text()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.request_id).toBe('tile-gate');
		expect(body).not.toHaveProperty('result');
	});

	// -----------------------------------------------------------------------
	// THE STORED READ is narrow
	// -----------------------------------------------------------------------

	test('a stored source is read NARROWLY: a viewport asks dozens of tiles, and a record whose drawn layers run to megabytes costs the engine the source alone', async () => {
		const table = await getMatrixTableFromTipo(SECTION);
		if (table === null) throw new Error('the scratch section has no matrix table');
		const query = {
			tableName: table,
			sectionTipo: SECTION,
			sectionId: BIG_RECORD,
			column: 'geo',
			componentTipo: GEO,
			key: 'sources',
			itemId: 1,
		} as const;
		// the database returns the one object, as stored — and nothing of the layers beside it
		const narrow = await readNestedItemsById(query);
		expect(narrow).toEqual([BIG_SOURCE]);
		expect(JSON.stringify(narrow).length).toBeLessThan(1_000);
		// anti-vacuity: the value it sits in IS megabytes, so the full read is what this avoids
		const full = await readMatrixRecord(table, SECTION, BIG_RECORD);
		expect(JSON.stringify(full?.columns.geo).length).toBeGreaterThan(1_000_000);
		// nothing there: an unknown source, record or component is an empty answer, not a failure
		expect(await readNestedItemsById({ ...query, itemId: 99 })).toEqual([]);
		expect(await readNestedItemsById({ ...query, sectionId: MISSING_RECORD })).toEqual([]);
		expect(await readNestedItemsById({ ...query, componentTipo: 'zztile77' })).toEqual([]);
		// the route asks for it that way: no statement of the request reads a whole row
		const { result, report } = await runWithQueryTap('narrow stored read', () =>
			ask(stored(1, TILE, BIG_RECORD)),
		);
		expect(result.status).toBe(200);
		const frames = report.callers.map((caller) => caller.frames);
		expect(frames.some((frame) => frame.includes('readMatrixRecord'))).toBe(false);
		expect(frames.some((frame) => frame.includes('readNestedItemsById'))).toBe(true);
	});

	test('the narrow read builds its path from checked pieces only: a component, a key or an id outside its grammar is a defect, never SQL', async () => {
		const base = {
			tableName: 'matrix_test',
			sectionTipo: SECTION,
			sectionId: 1,
			column: 'geo',
			componentTipo: GEO,
			key: 'sources',
			itemId: 1,
		} as const;
		for (const hostile of [
			{ componentTipo: 'zz"]) || (1' },
			{ key: 'sources"][*] ? (@.id == 1' },
			{ key: 'Sources' },
			{ itemId: 0 },
			{ itemId: 1.5 },
			{ itemId: Number.NaN },
			{ column: 'geo"; DROP TABLE x; --' },
			{ tableName: 'matrix_test"; DROP TABLE x; --' },
		]) {
			await expect(
				readNestedItemsById({ ...base, ...hostile } as unknown as Parameters<
					typeof readNestedItemsById
				>[0]),
			).rejects.toMatchObject({ code: 'internal.invariant' });
		}
	});

	// -----------------------------------------------------------------------
	// BUDGET: one person cannot use the provider up
	// -----------------------------------------------------------------------

	/** Distinct OpenStreetMap tiles, as a scraper (or a very large map) would ask for them. */
	const osmTile = (index: number) => builtin('osm', `z=12&x=${index}&y=7`);

	test('BUDGET: past their burst a person’s misses are `rate.limited` before the door; a second person is untouched; the refill is a few a second', async () => {
		const { burst, refillPerSecond } = PRINCIPAL_BUDGET_LIMITS;
		const deps = depsOf(true);
		for (let index = 0; index < burst; index++) {
			expect((await ask(osmTile(index), { deps })).status, `tile ${index}`).toBe(200);
		}
		expect(peer.received.length).toBe(burst);
		const refused = await ask(osmTile(burst), { deps });
		expect(refused.status).toBe(429);
		expect(await errorCode(refused.clone())).toBe('rate.limited');
		expect(refused.headers.get('retry-after'), 'how long until a token is back').toBe('1');
		expect(refused.headers.get('cache-control')).toBe('no-store');
		expect(await refused.text()).not.toContain('openstreetmap');
		expect(peer.received.length, 'the refusal never reached the provider').toBe(burst);

		// …another person has a bucket of their own
		expect((await ask(osmTile(burst), { who: 'root', deps })).status).toBe(200);
		expect(principalBudgetsTracked()).toBe(2);

		// …and a token comes back every 1/refill seconds
		clock.now += (1000 / refillPerSecond) * 3;
		for (let index = burst + 1; index <= burst + 3; index++) {
			expect((await ask(osmTile(index), { deps })).status, `refilled ${index}`).toBe(200);
		}
		expect((await ask(osmTile(burst + 4), { deps })).status).toBe(429);
	});

	test('BUDGET: only a call to the provider is charged — a memory hit costs nothing, and a caller who failed a gate is neither charged nor told about the budget', async () => {
		const { burst } = PRINCIPAL_BUDGET_LIMITS;
		const deps = depsOf(true);
		expect((await ask(osmTile(0), { deps })).status).toBe(200);
		for (let again = 0; again < burst + 20; again++) {
			expect((await ask(osmTile(0), { deps })).status, 'a hit').toBe(200);
		}
		expect(peer.received.length, 'one provider call however often it is asked').toBe(1);
		// 99 tokens left: the person can still go to the provider 99 more times, and no more
		for (let index = 1; index < burst; index++) {
			expect((await ask(osmTile(index), { deps })).status).toBe(200);
		}
		expect((await ask(osmTile(burst), { deps })).status).toBe(429);
		// a caller without the component grant gets the uniform 404 whatever any budget says
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(await shown(await ask(osmTile(burst + 1), { who: 'noComponent', deps }))).toEqual(
			reference,
		);
		expect(principalBudgetsTracked(), 'the refused caller opened no bucket').toBe(1);
	});

	test('BUDGET: the refusal is reported once a minute, and counted every time', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const { burst } = PRINCIPAL_BUDGET_LIMITS;
			const deps = depsOf(true);
			for (let index = 0; index < burst; index++) await ask(osmTile(index), { deps });
			const before = getCounters().map_tile_rate_limited ?? 0;
			for (let index = 0; index < 30; index++) await ask(osmTile(burst + index), { deps });
			expect((getCounters().map_tile_rate_limited ?? 0) - before).toBe(30);
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(lines.length).toBe(1);
			expect(lines[0]).toBe(
				`[map_tile] rate.limited why=principal_budget user=${IDENTITIES.allowed.user} [req tile-gate]`,
			);
		} finally {
			warn.mockRestore();
		}
	});

	// -----------------------------------------------------------------------
	// CAPACITY: a map asks for every tile at once
	// -----------------------------------------------------------------------

	test('CAPACITY: the 160 tiles of a 4K display load whole in one burst, and the second layer is another host’s queue', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		peer.respond = async () => {
			await held;
			return imageResponse(pngBytes());
		};
		const before = getCounters();
		// 16 x 10 distinct tiles of one layer (OSM), and the same grid of the IGN overlay (another origin)
		const grid = (builder: (view: string) => string) =>
			Array.from({ length: 160 }, (_, index) =>
				ask(builder(`z=12&x=${100 + (index % 16)}&y=${100 + Math.floor(index / 16)}`)),
			);
		const requests = [
			...grid((view) => builtin('osm', view)),
			...grid((view) => builtin('ign_admin_units', view)),
		];
		const osmOrigin = siteKey(new URL('https://tile.openstreetmap.org/'));
		await until(
			() => interactiveState(osmOrigin).inFlight === INTERACTIVE_MAX_CONCURRENT,
			'the origin’s slots are in use',
		);
		release();
		const responses = await Promise.all(requests);
		const statuses = responses.map((response) => response.status);
		expect(statuses.filter((status) => status === 200).length, 'every tile of both layers').toBe(
			320,
		);
		const after = getCounters();
		expect((after.map_tile_busy ?? 0) - (before.map_tile_busy ?? 0)).toBe(0);
		expect((after.map_tile_relay_failed ?? 0) - (before.map_tile_relay_failed ?? 0)).toBe(0);
		expect(320, 'two such layers fit the burst').toBeLessThanOrEqual(PRINCIPAL_BUDGET_LIMITS.burst);
	});

	const OSM_ORIGIN = siteKey(new URL('https://tile.openstreetmap.org/'));

	/** The `x` of the OSM tile `/12/<x>/7.png` the loopback provider was asked for (osmTile's shape). */
	const osmX = (received: { readonly pathname: string }): number =>
		Number(/^\/12\/(\d+)\/7\.png$/.exec(received.pathname)?.[1] ?? Number.NaN);

	test('CAPACITY: what the door cannot take in time is BUSY — 429 with a Retry-After, counted apart, never a failing provider, not charged, and fine on the next ask', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			let release: () => void = () => undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			peer.respond = async () => {
				await held;
				return imageResponse(pngBytes());
			};
			// the wait ceiling of the person's own line is fired by hand (the limiter's timer seam)
			const ceilings: (() => void)[] = [];
			const deps: GeoServiceDeps = {
				lookup,
				fetch: socketSeam,
				limiter: {
					now: () => clock.now,
					startTimer: (fire) => {
						ceilings.push(fire);
						return () => undefined;
					},
				},
			};
			const before = getCounters();
			const admitted = INTERACTIVE_MAX_REGISTRY_PER_HOLDER;
			const waiting = 40;
			const total = admitted + waiting;
			const requests = Array.from({ length: total }, (_, index) => ask(osmTile(index), { deps }));
			const holder = `user:${IDENTITIES.allowed.user}`;
			await until(
				() => ceilings.length === waiting,
				'the person’s other tiles wait in their own line',
			);
			expect(interactiveHolderAtOriginState(holder, OSM_ORIGIN)).toMatchObject({
				inFlight: admitted,
				waiting,
			});
			// a person’s tiles that wait are NOT places in the origin’s queue
			expect(interactiveState(OSM_ORIGIN)).toMatchObject({ inFlight: admitted, waiting: 0 });
			// their ceiling arrives (a provider too slow for the line to move)
			for (const fire of ceilings) fire();
			await until(
				() => (getCounters().map_tile_busy ?? 0) - (before.map_tile_busy ?? 0) === waiting,
				'the tiles that waited too long were refused',
			);
			release();
			const responses = await Promise.all(requests);
			const busy = responses.filter((response) => response.status === 429);
			expect(busy.length).toBe(waiting);
			expect(responses.filter((response) => response.status === 200).length).toBe(admitted);
			expect(responses.filter((response) => response.status === 503).length, 'no fault').toBe(0);
			for (const response of busy) {
				expect(await errorCode(response.clone())).toBe('rate.limited');
				expect(response.headers.get('retry-after')).toBe('2');
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(await response.text()).not.toContain('openstreetmap');
			}
			const after = getCounters();
			expect((after.map_tile_relay_failed ?? 0) - (before.map_tile_relay_failed ?? 0)).toBe(0);
			expect((after.map_tile_rate_limited ?? 0) - (before.map_tile_rate_limited ?? 0)).toBe(0);
			// one line for the operator, in the installation’s own terms — not a provider fault
			const lines = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.startsWith('[map_tile]'));
			expect(lines.length, 'one line, not forty').toBe(1);
			expect(lines[0]).toBe(
				'[map_tile] rate.limited why=upstream_busy door_reason=wait_exceeded source=builtin:osm [req tile-gate]',
			);
			// the refused calls never reached the provider and were not charged: the person has spent only what was admitted
			expect(peer.received.length).toBe(admitted);
			const { burst } = PRINCIPAL_BUDGET_LIMITS;
			let more = 0;
			const clocked = depsOf(true);
			for (; more < burst; more++) {
				const response = await ask(osmTile(1_000 + more), { deps: clocked });
				if (response.status === 429) break;
			}
			expect(more, 'the budget left is the burst less what was admitted').toBe(burst - admitted);
			// and the busy tiles are fine on the next ask (a viewer’s retry)
			clearPrincipalBudgetsForTests();
			expect((await ask(osmTile(total - 1))).status).toBe(200);
		} finally {
			warn.mockRestore();
		}
	});

	// -----------------------------------------------------------------------
	// FAIRNESS: one person’s storm is not everyone’s line
	// -----------------------------------------------------------------------

	test('FAIRNESS: one person’s 300 tiles at OpenStreetMap hold a few places in its queue — a second person’s single tile is served after ONE turnover, not 429, not after the 300', async () => {
		const gates = new Map<number, () => void>();
		let holding = true;
		peer.respond = async (received) => {
			const x = osmX(received);
			if (holding && x < 300) await new Promise<void>((resolve) => gates.set(x, resolve));
			return imageResponse(pngBytes());
		};
		const storm = 300;
		const holder = `user:${IDENTITIES.allowed.user}`;
		const mine = Array.from({ length: storm }, (_, index) => ask(osmTile(index)));
		await until(
			() => gates.size === INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			'the person’s places reached the wire',
		);
		await until(
			() => interactiveHolderAtOriginState(holder, OSM_ORIGIN).waiting === storm - gates.size,
			'the rest wait in the person’s own line',
		);
		// the finding: they used to fill the origin’s whole queue (256) and the next person was `queue_full`
		expect(interactiveState(OSM_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			waiting: 0,
		});

		const second = ask(osmTile(1_000), { who: 'root' });
		await until(
			() => interactiveState(OSM_ORIGIN).waiting === 1,
			'the second person is first in the origin’s line',
		);
		expect(peer.received.some((received) => osmX(received) === 1_000)).toBe(false);

		// ONE of the first person’s requests finishes
		const [finished] = gates.keys();
		gates.get(finished as number)?.();
		const response = await second;
		expect(response.status, 'served, not refused').toBe(200);
		expect(peer.received.some((received) => osmX(received) === 1_000)).toBe(true);
		expect(
			interactiveHolderAtOriginState(holder, OSM_ORIGIN).waiting,
			'while the first person still has hundreds waiting',
		).toBeGreaterThan(storm - 20);

		holding = false;
		for (const open of gates.values()) open();
		const responses = await Promise.all(mine);
		expect(
			responses.every((answered) => answered.status === 200),
			'and every one of theirs is served in the end',
		).toBe(true);
		expect(interactiveHolderAtOriginState(holder, OSM_ORIGIN).holders).toBe(0);
	});

	// -----------------------------------------------------------------------
	// ABANDONED: a call nobody waits for is not charged
	// -----------------------------------------------------------------------

	test('ABANDONED: tiles whose viewers left while they waited for their place were never sent and are NOT charged — quick zoom steps do not spend the burst', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		peer.respond = async () => {
			await held;
			return imageResponse(pngBytes());
		};
		const holder = `user:${IDENTITIES.allowed.user}`;
		const count = 60;
		const controllers = Array.from({ length: count }, () => new AbortController());
		const requests = controllers.map((controller, index) =>
			ask(osmTile(index), { signal: controller.signal }),
		);
		await until(
			() => peer.received.length === INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			'the places reached the wire',
		);
		await until(
			() =>
				interactiveHolderAtOriginState(holder, OSM_ORIGIN).waiting === count - peer.received.length,
			'the rest wait for a place',
		);
		// the viewer pans: every tile still waiting is abandoned (the four on the wire are not)
		const onTheWire = new Set(peer.received.map(osmX));
		controllers.forEach((controller, index) => {
			if (!onTheWire.has(index)) controller.abort();
		});
		await until(
			() => interactiveHolderAtOriginState(holder, OSM_ORIGIN).waiting === 0,
			'the abandoned tiles left the line',
		);
		release();
		const responses = await Promise.all(requests);
		expect(responses.filter((response) => response.status === 200).length).toBe(onTheWire.size);
		expect(peer.received.length, 'the abandoned tiles never reached the provider').toBe(
			onTheWire.size,
		);
		// the person has spent only the four that were sent: the rest of the burst is untouched
		const { burst } = PRINCIPAL_BUDGET_LIMITS;
		const deps = depsOf(true);
		let more = 0;
		for (; more < burst; more++) {
			if ((await ask(osmTile(1_000 + more), { deps })).status === 429) break;
		}
		expect(more, 'abandoned calls refunded: the burst less only what was sent').toBe(
			burst - onTheWire.size,
		);
	});

	test('REDIRECT CHARGE: a same-host redirect whose SECOND hop the door refuses for capacity is busy — and stays charged, the provider was asked', async () => {
		// the first tile (x=0) answers 301 -> /new.png when let go; every other tile is held
		let answerFirst: () => void = () => undefined;
		const firstHeld = new Promise<void>((resolve) => {
			answerFirst = resolve;
		});
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		peer.respond = async (received) => {
			if (received.pathname === '/new.png') return imageResponse(pngBytes());
			if (osmX(received) === 0) {
				await firstHeld;
				return new Response(null, { status: 301, headers: { location: '/new.png' } });
			}
			await held;
			return imageResponse(pngBytes());
		};
		// the wait ceilings of the person's line are fired by hand (the limiter's timer seam)
		const ceilings: (() => void)[] = [];
		const deps: GeoServiceDeps = {
			lookup,
			fetch: socketSeam,
			limiter: {
				now: () => clock.now,
				startTimer: (fire) => {
					ceilings.push(fire);
					return () => undefined;
				},
			},
		};
		const holder = `user:${IDENTITIES.allowed.user}`;
		const places = INTERACTIVE_MAX_REGISTRY_PER_HOLDER;
		const redirected = ask(osmTile(0), { deps });
		await until(
			() => peer.received.some((received) => osmX(received) === 0),
			'the first hop was sent',
		);
		// the person's other places fill, and one more tile waits in their line
		const others = Array.from({ length: places }, (_, index) => ask(osmTile(index + 1), { deps }));
		await until(() => {
			const state = interactiveHolderAtOriginState(holder, OSM_ORIGIN);
			return state.inFlight === places && state.waiting === 1;
		}, 'every place is in use and one tile waits');
		const waitingBefore = ceilings.length;
		// the provider answers the first hop: its place goes to the tile in line, the second hop waits
		answerFirst();
		await until(() => ceilings.length === waitingBefore + 1, 'the second hop waits for a place');
		await until(
			() => peer.received.some((received) => osmX(received) === places),
			'the tile that waited took the freed place',
		);
		// its ceiling arrives: the door refuses the second hop for its own capacity
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
		let response: Response;
		let lines: string[];
		try {
			ceilings[ceilings.length - 1]?.();
			response = await redirected;
			lines = warn.mock.calls.map((call) => String(call[0]));
		} finally {
			warn.mockRestore();
		}
		expect(response.status).toBe(429);
		expect(await errorCode(response)).toBe('rate.limited');
		// the DOOR's capacity, not the person's budget
		expect(lines).toContain(
			'[map_tile] rate.limited why=upstream_busy door_reason=wait_exceeded source=builtin:osm [req tile-gate]',
		);
		expect(
			peer.received.some((received) => received.pathname === '/new.png'),
			'the second hop never left',
		).toBe(false);
		release();
		const answered = await Promise.all(others);
		expect(answered.every((other) => other.status === 200)).toBe(true);
		// charged: the redirected call AND every other one — the redirect was NOT refunded
		const sent = places + 1;
		const { burst } = PRINCIPAL_BUDGET_LIMITS;
		const clocked = depsOf(true);
		let more = 0;
		for (; more < burst; more++) {
			if ((await ask(osmTile(1_000 + more), { deps: clocked })).status === 429) break;
		}
		expect(
			more,
			'the burst less every call that reached the provider, the redirected one included',
		).toBe(burst - sent);
	});

	// -----------------------------------------------------------------------
	// HOLDER: one person’s slow hosts
	// -----------------------------------------------------------------------

	test('HOLDER: a person with two slow hosts of their own holds a few stored slots, and another person’s stored source is served at once', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowHosts = ['slow.example.org', 'secret.example.org'];
		peer.respond = async (received) => {
			if (slowHosts.includes(received.host)) await held;
			return imageResponse(pngBytes());
		};
		const holder = `user:${IDENTITIES.allowed.user}`;
		const tiles = Array.from({ length: 6 }, (_, index) => `z=5&x=${index}&y=1`);
		const mine = tiles.flatMap((view) => [ask(stored(12, view)), ask(stored(11, view))]);
		await until(
			() => peer.received.length === INTERACTIVE_MAX_STORED_PER_HOLDER,
			'the person’s cap reached the wire',
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(peer.received.length, 'and no more, with 12 asked on two hosts').toBe(
			INTERACTIVE_MAX_STORED_PER_HOLDER,
		);
		expect(interactiveHolderState(holder)).toMatchObject({
			inFlight: INTERACTIVE_MAX_STORED_PER_HOLDER,
			waiting: 12 - INTERACTIVE_MAX_STORED_PER_HOLDER,
		});
		expect(interactiveState(siteKey(new URL('https://slow.example.org/'))).stored).toBe(
			INTERACTIVE_MAX_STORED_PER_HOLDER,
		);
		// another person, another source of the same record: not starved
		const other = await ask(stored(1), { who: 'root' });
		expect(other.status).toBe(200);
		release();
		const responses = await Promise.all(mine);
		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect(interactiveHolderState(holder)).toMatchObject({ holders: 0, inFlight: 0, waiting: 0 });
	});

	// -----------------------------------------------------------------------
	// FLIGHT: one provider call for identical concurrent misses
	// -----------------------------------------------------------------------

	test('FLIGHT: identical concurrent misses are ONE provider call, however many viewers and however they differ; joining is free', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		peer.respond = async () => {
			await held;
			return imageResponse(pngBytes());
		};
		const waiting = [
			ask(builtin('osm')),
			ask(builtin('osm')),
			ask(builtin('osm'), { who: 'root' }),
			ask(builtin('osm'), { who: 'root' }),
		];
		await until(() => peer.received.length === 1, 'the first call reached the provider');
		await until(() => tileFlightsInProgress() === 1, 'one flight in the air');
		// a caller that fails a gate does NOT join: it is refused as ever, the flight is not theirs
		const reference = await shown(await ask(stored(1), { who: null }));
		expect(await shown(await ask(builtin('osm'), { who: 'noComponent' }))).toEqual(reference);
		release();
		for (const response of await Promise.all(waiting)) {
			expect(response.status).toBe(200);
			expect(await imageBytes(response)).toEqual(pngBytes());
		}
		expect(peer.received.length, 'one question, one answer, four viewers').toBe(1);
		expect(tileFlightsInProgress(), 'the flight is over').toBe(0);
		expect(tilesKept()).toBe(1);
		// only the viewer that STARTED the call paid a token: root joined, root has no bucket
		expect(principalBudgetsTracked()).toBe(1);
	});

	test('FLIGHT: a shared failure is every joiner’s refusal, and the next request asks again', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		peer.respond = async () => {
			await held;
			return new Response('down', { status: 500 });
		};
		const waiting = [ask(builtin('osm')), ask(builtin('osm'), { who: 'root' })];
		await until(() => peer.received.length === 1, 'the call reached the provider');
		release();
		for (const response of await Promise.all(waiting)) {
			await expectOneRefusal(response, 'external.transport', 503);
		}
		expect(peer.received.length).toBe(1);
		expect(tilesKept()).toBe(0);
		peer.respond = () => imageResponse(pngBytes());
		clearInteractiveForTests();
		expect((await ask(builtin('osm'))).status).toBe(200);
		expect(peer.received.length, 'a failure is not remembered').toBe(2);
	});

	test('FLIGHT: a viewer who leaves does not cancel a call another still needs; the last one to leave stops it and frees the slot', async () => {
		peer.respond = () => new Promise<Response>(() => undefined);
		const origin = siteKey(new URL('https://tile.openstreetmap.org/'));
		const first = new AbortController();
		const second = new AbortController();
		const one = ask(builtin('osm'), { signal: first.signal });
		const two = ask(builtin('osm'), { signal: second.signal, who: 'root' });
		await until(() => interactiveState(origin).inFlight === 1, 'the shared call is in flight');
		first.abort();
		await one;
		expect(interactiveState(origin).inFlight, 'the other viewer still needs it').toBe(1);
		expect(tileFlightsInProgress()).toBe(1);
		second.abort();
		await two;
		await until(
			() => interactiveState(origin).inFlight === 0,
			'the last viewer left: the slot came back',
		);
		expect(tileFlightsInProgress()).toBe(0);
		expect(peer.received.length).toBe(1);
	});

	test('FLIGHT: a call that finishes while a viewer is still joining it serves them the same tile', async () => {
		peer.respond = async () => imageResponse(pngBytes());
		const answers = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				ask(builtin('osm'), { who: index % 2 ? 'root' : 'allowed' }),
			),
		);
		for (const response of answers) expect(response.status).toBe(200);
		expect(peer.received.length, 'a flight, or the memory it left').toBe(1);
	});

	// -----------------------------------------------------------------------
	// WMS in a geographic CRS: tiles from a minimum zoom
	// -----------------------------------------------------------------------

	test('a tile of a geographic-CRS WMS source is relayed from zoom 8 up and refused below: a plate carrée crop is only registered from there', async () => {
		const reference = await shown(await ask(stored(1), { who: null }));
		for (const z of [0, 3, 7]) {
			expect(await shown(await ask(stored(2, `z=${z}&x=0&y=0`))), `z=${z}`).toEqual(reference);
		}
		expect(peer.received, 'the refused zooms never reached the provider').toEqual([]);
		const served = await ask(stored(2, 'z=8&x=130&y=97'));
		expect(served.status).toBe(200);
		expect(peer.received.length).toBe(1);
		// the same source as a FREE IMAGE is not tied to the tile grid, and is unaffected
		expect((await ask(stored(2, 'bbox=-10.5,35,4.25,44&width=512&height=400'))).status).toBe(200);
		// a mercator WMS source is exact at any zoom
		expect((await ask(stored(13, 'z=0&x=0&y=0'))).status).toBe(200);
	});

	// -----------------------------------------------------------------------
	// THE DOOR
	// -----------------------------------------------------------------------

	test('addressFrom is truthful: an editor’s stored address draws on the stored budget, a default and a built-in do not', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		peer.respond = async () => {
			await held;
			return imageResponse(pngBytes());
		};
		const storedOrigin = siteKey(new URL('https://tiles.example.org/'));
		const defaultOrigin = siteKey(new URL('https://default.example.org/'));
		const builtinOrigin = siteKey(new URL('https://tile.openstreetmap.org/'));

		const pendingStored = ask(stored(1));
		await until(() => interactiveState(storedOrigin).inFlight === 1, 'the stored hop is in flight');
		expect(
			interactiveState(storedOrigin).stored,
			'a stored address counts against the stored budget',
		).toBe(1);

		const pendingDefault = ask(named('regional'));
		const pendingBuiltin = ask(builtin('osm'));
		await until(
			() =>
				interactiveState(defaultOrigin).inFlight === 1 &&
				interactiveState(builtinOrigin).inFlight === 1,
			'the registry hops are in flight',
		);
		expect(interactiveState(defaultOrigin).total).toBe(3);
		expect(
			interactiveState(defaultOrigin).stored,
			'a default and a built-in are the registry’s',
		).toBe(1);
		release();
		for (const response of await Promise.all([pendingStored, pendingDefault, pendingBuiltin])) {
			expect(response.status).toBe(200);
		}
		expect(interactiveState(storedOrigin).stored).toBe(0);
	});

	test('a client that went away frees its place: the request’s signal reaches the queue and the socket', async () => {
		peer.respond = () => new Promise<Response>(() => undefined);
		const controller = new AbortController();
		const origin = siteKey(new URL('https://slow.example.org/'));
		const pending = ask(stored(12), { signal: controller.signal });
		await until(() => interactiveState(origin).inFlight === 1, 'the hop is in flight');
		controller.abort();
		const response = await pending;
		await expectOneRefusal(response, 'external.transport', 503);
		await until(() => interactiveState(origin).inFlight === 0, 'the slot came back');
		expect(interactiveState(origin).stored).toBe(0);
	});

	test('the terms follow the ORIGIN: a stored source on a registry host is owed what the registry host is owed', async () => {
		process.env.DEDALO_PROTOCOL = 'https://';
		process.env.DEDALO_HOST = 'maps.museum-example.org';
		// Source 14 is an EDITOR's address that happens to name OpenStreetMap's tile host. It
		// stays `stored` for the budget, but OpenStreetMap's Referer term is the ORIGIN's.
		const response = await ask(stored(14));
		expect(response.status).toBe(200);
		expect(peer.received[0]?.host).toBe('tile.openstreetmap.org');
		expect(peer.received[0]?.headers.get('referer')).toBe('https://maps.museum-example.org/');
		const origin = siteKey(new URL('https://tile.openstreetmap.org/'));
		expect(interactiveState(origin).stored, 'the hop is over: nothing is held').toBe(0);
	});

	test('the terms follow the origin under its other SPELLINGS — a root dot, upper case — and a name under a registry host is another, unreviewed origin', async () => {
		process.env.DEDALO_PROTOCOL = 'https://';
		process.env.DEDALO_HOST = 'maps.museum-example.org';
		peer.respond = () =>
			new Response(pngBytes() as BodyInit, { headers: { 'content-type': 'image/png' } });
		// `TILE.openstreetmap.org.` is OpenStreetMap's server: its Referer…
		const dotted = await ask(stored(15), { deps: depsOf(true) });
		expect(dotted.status).toBe(200);
		expect(peer.received[0]?.headers.get('referer')).toBe('https://maps.museum-example.org/');
		// …and a name under it is not: no Referer
		peer.received = [];
		expect((await ask(stored(16), { deps: depsOf(true) })).status).toBe(200);
		expect(peer.received[0]?.host).toBe('a.tile.openstreetmap.org');
		expect(peer.received[0]?.headers.get('referer') ?? null).toBeNull();
		// two days on, the dotted spelling is still held (OSM's week); the other's default hour is gone
		clock.now += 2 * 24 * 3600 * 1000;
		peer.received = [];
		await ask(stored(15), { deps: depsOf(true) });
		expect(peer.received.length, 'OSM’s week').toBe(0);
		await ask(stored(16), { deps: depsOf(true) });
		expect(peer.received.length, 'the default hour').toBe(1);
	});

	// -----------------------------------------------------------------------
	// REGISTRATION and the census
	// -----------------------------------------------------------------------

	test('the server routes the path to the handler, with its request id, and classifies it as a read door', async () => {
		const request = new Request(`http://localhost${TILE_PATH}?${stored(1)}`, {
			headers: { cookie: `${SESSION_COOKIE}=${tokenOf('allowed')}` },
		});
		const response = await runWithGeoServiceSeams(depsOf(), () =>
			handleRequest(request, { requestId: 'tile-routed', startedAt: 0 }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		const refused = await runWithGeoServiceSeams(depsOf(), () =>
			handleRequest(new Request(`http://localhost${TILE_PATH}?${stored(1)}`), {
				requestId: 'tile-routed',
				startedAt: 0,
			}),
		);
		expect((JSON.parse(await refused.text()) as { request_id: string }).request_id).toBe(
			'tile-routed',
		);
		const key = 'http:GET /dedalo/core/api/v1/map_tile';
		expect(READ_DOOR_POSTURE.get(key)?.posture).toBe('component');
		expect(READ_DOOR_EXTRA_DOORS.map((door) => door.key)).toContain(key);
	});

	test('the module exports its handler and nothing a caller could hand a URL to', async () => {
		const module = await import('../../src/core/api/map_tile.ts');
		expect(Object.keys(module)).toEqual(['handleMapTile']);
		expect(handleMapTile).toBe(module.handleMapTile);
		expect(handleMapTile.length, 'a request, a URL, an optional request id — no seam').toBe(2);
	});
});
