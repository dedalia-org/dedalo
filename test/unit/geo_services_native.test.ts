/**
 * THE GEO SERVICES MODULE (src/core/geo_services/) — every clause of its headers,
 * driven. engineering/OUTBOUND_SPEC.md §2 names the class: a `fetchGuardedText` CALLER
 * with a closed table, not a door.
 *
 * NO REAL NETWORK. The situation is BUILT through the text door's own seams: a
 * resolver that answers a public address, and a socket seam that retargets the pinned
 * connection to a LOOPBACK `Bun.serve` peer this file starts. What the peer receives is
 * exactly what a provider would (method, path, query, headers); what the seam records is
 * where the guard pointed the socket (the VETTED address, the real name kept for Host
 * and SNI). The limiter's clock, sleep and timers are fakes, so pacing is measured
 * without a wall clock; a stalled provider is measured under fake timers.
 *
 * WHAT IS PINNED, by outcome:
 *   - the table is CLOSED and consistent (no service outside it, no parameter that
 *     shadows a fixed one, every ceiling finite, every back-off longer than its wait ceiling,
 *     every queue able to fill inside its wait), FROZEN TO ITS LEAVES (a write to a row throws;
 *     a shallow freeze had left `GEO_ORIGINS.nominatim.base` writable) and what the providers
 *     were verified against is written out as LITERALS (PINNED_WIRE, PINNED_ORIGINS: every
 *     origin, path, ordered query, byte ceiling, deadline, `Accept`, attribution, answer
 *     lifetime and pacing number), none of it read from the row it checks;
 *   - the request names NO ADDRESS: an id outside the table, a URL passed as an id, an
 *     unknown key, a missing or malformed value are `request.invalid_data` BEFORE any
 *     socket, slot or call in the air; a value full of `& # = / @` stays one value of its own
 *     key; a box is accepted at its ceiling and refused one step over;
 *   - every service of the table is driven end to end on a plausible answer;
 *   - answers are checked against the service's contract (`external.protocol`), and
 *     "nothing there" is `external.not_found` for the services that ask a question with
 *     one answer, an empty list for a search; free text is bounded by its RAW length before
 *     it is normalized (a hostile run of combining marks costs a comparison, not seconds);
 *   - failures are one typed taxonomy that names no address, host or query — a 404 is
 *     not found, a 429/503 is `external.http_status` with `retryAfterMs` AND leaves the
 *     origin alone for its back-off on every origin, any other 4xx is a REFUSED request
 *     (`external.bad_config`, not retryable: the browser would re-send a retryable failure
 *     five times), a name that does not resolve is `external.transport` (not a policy
 *     block), a redirect is never followed, the byte ceiling and the deadline of every
 *     service hold exactly;
 *   - pacing: spacing between starts, the RATE ON THE WIRE for an origin with one call in
 *     flight (measured where the provider would, with a slow lookup before one call and a
 *     fast one before the next; and one slot is ONE request: a reset after the request left
 *     is not sent to a second address), the cap on calls in flight, the bounded queue, the
 *     wait ceiling at the millisecond with calls that take time, a stopped job leaving the
 *     queue, origins independent, state self-draining with one drain timer per origin;
 *   - identical calls in the air are one call (a re-send joins it, each caller reads the
 *     answer for itself, a failure is shared, a stopped caller leaves its own wait and the
 *     call is cancelled only when the last has gone, a call with no signal is not refused);
 *   - the answer memory Nominatim's policy asks for (an identical question inside the hour
 *     reaches the provider once; only a good answer or "nothing there" is kept; bounded by
 *     bytes, the oldest evicted first, exact lifetime);
 *   - the identity header (a public origin only when a provider could reach it; never a
 *     person's address) and the module's surface: one entry point that takes no seam, and a
 *     closed list of imports with nothing of src/config/.
 */

import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { DedaloError, toErrorBody } from '../../src/core/errors/index.ts';
import {
	ANSWER_MEMORY_LIMITS,
	answerBytesKept,
	answersKept,
	recallAnswer,
	rememberAnswer,
} from '../../src/core/geo_services/answer_memory.ts';
import * as callModule from '../../src/core/geo_services/call.ts';
import { callGeoService, type GeoServiceResult } from '../../src/core/geo_services/call.ts';
import { geoError } from '../../src/core/geo_services/errors.ts';
import { classifyFailure } from '../../src/core/geo_services/failures.ts';
import { geoFlightsInProgress } from '../../src/core/geo_services/flights.ts';
import {
	type GeoServiceDeps,
	geoServiceSeams,
	runWithGeoServiceSeams,
} from '../../src/core/geo_services/geo_seams.ts';
import {
	clearGeoServicesForTests,
	geoLimiter,
	geoOriginsTracked,
	restAfterCallMs,
} from '../../src/core/geo_services/limiters.ts';
import {
	choice,
	decimal,
	formatNumber,
	integer,
	matching,
	NFC_SHRINK_LIMIT,
	numbers,
	points,
	text,
	token,
} from '../../src/core/geo_services/params.ts';
import { buildGeoUrl } from '../../src/core/geo_services/request.ts';
import {
	GEO_ORIGIN_IDS,
	GEO_ORIGINS,
	GEO_SERVICE_IDS,
	GEO_SERVICES,
	type GeoService,
	geoServiceOf,
	isGeoServiceId,
} from '../../src/core/geo_services/table.ts';
import { geoUserAgent } from '../../src/core/geo_services/user_agent.ts';
import type { LimiterDeps } from '../../src/core/harvest/origin_limiter.ts';
import { currentJobSignal, runWithJobSignal } from '../../src/core/media/job_scope.ts';
import {
	type AddressLookup,
	nat64DiscoveryState,
	type PinnedFetchInit,
	type PinnedHopDeps,
	SSRF_REFUSAL_KINDS,
	setNat64DiscoveryForTests,
} from '../../src/core/security/ssrf_guard.ts';
import { DEDALO_ENGINE_VERSION } from '../../src/core/update/build_stamp.ts';
import { type AstNode, literalSpecifier, nameOf, walkAst } from '../helpers/ast_walk.ts';

// ---------------------------------------------------------------------------
// The environment: hermetic discovery, no declared NAT64 prefix, a known identity
// ---------------------------------------------------------------------------

const originalDiscovery = nat64DiscoveryState();
const PINNED_SETTINGS = [
	// The debug block of an error body (cause chain, stack) is a developer switch; the wire a
	// production caller sees is what these gates read.
	'DEDALO_DEBUG_API_ERRORS',
	'DEDALO_NAT64_PREFIXES',
	'DEDALO_SMTP_FROM',
	'DEDALO_HOST',
	'DEDALO_PROTOCOL',
] as const;
const originalSettings = new Map(PINNED_SETTINGS.map((key) => [key, process.env[key]]));

beforeEach(() => {
	// An empty value, not a deleted key: a deleted key falls back to ../private/.env.
	for (const key of PINNED_SETTINGS) process.env[key] = '';
	setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
	clearGeoServicesForTests();
});

afterEach(() => {
	jest.useRealTimers();
	for (const [key, value] of originalSettings) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setNat64DiscoveryForTests(originalDiscovery);
	clearGeoServicesForTests();
});

// ---------------------------------------------------------------------------
// The loopback peer and the socket seam
// ---------------------------------------------------------------------------

const PUBLIC_V4 = '93.184.216.34';
const publicLookup: AddressLookup = async () => [{ address: PUBLIC_V4, family: 4 }];

/** What the peer received. */
interface Received {
	readonly method: string;
	readonly pathname: string;
	readonly search: string;
	readonly query: URLSearchParams;
	readonly headers: Headers;
}

/** Where the guard pointed the socket. */
interface Pinned {
	readonly address: string;
	readonly protocol: string;
	readonly hostHeader: string | null;
	readonly serverName: string | undefined;
}

type Responder = (received: Received) => Response | Promise<Response>;

const peer = {
	received: [] as Received[],
	pinned: [] as Pinned[],
	inFlight: 0,
	peak: 0,
	respond: (() => new Response('')) as Responder,
};

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		peer.received.push({
			method: request.method,
			pathname: url.pathname,
			search: url.search,
			query: url.searchParams,
			headers: request.headers,
		});
		peer.inFlight++;
		peer.peak = Math.max(peer.peak, peer.inFlight);
		try {
			return await peer.respond(peer.received[peer.received.length - 1] as Received);
		} finally {
			peer.inFlight--;
		}
	},
});

afterAll(() => {
	server.stop(true);
});

beforeEach(() => {
	peer.received = [];
	peer.pinned = [];
	peer.inFlight = 0;
	peer.peak = 0;
	peer.respond = () => new Response('');
});

/** The text door's socket seam: record the pin, then talk to the loopback peer instead. */
const socketSeam: NonNullable<PinnedHopDeps['fetch']> = (url, init: PinnedFetchInit) => {
	const target = new URL(url);
	const headers = new Headers(init.headers);
	peer.pinned.push({
		address: target.hostname,
		protocol: target.protocol,
		hostHeader: headers.get('host'),
		serverName: init.tls?.serverName,
	});
	headers.delete('host');
	return fetch(`http://127.0.0.1:${server.port}${target.pathname}${target.search}`, {
		method: init.method,
		headers,
		redirect: 'manual',
		signal: init.signal ?? null,
	});
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

function markup(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}

// ---------------------------------------------------------------------------
// The limiter's fake clock
// ---------------------------------------------------------------------------

interface FakeClock {
	readonly limiter: LimiterDeps;
	readonly clock: { now: number };
	/** Every spacing pause, in ms (each moves the clock on by itself). */
	readonly slept: number[];
	/** Drain timers scheduled and not yet run. */
	readonly drains: { callback: () => void; ms: number }[];
	/** Wait-ceiling timers armed (a queued caller's): fire one to let its ceiling arrive. */
	readonly ceilings: { fire: () => void; ms: number; cancelled: boolean }[];
}

function fakeClock(): FakeClock {
	const clock = { now: 5_000_000 };
	const slept: number[] = [];
	const drains: FakeClock['drains'] = [];
	const ceilings: FakeClock['ceilings'] = [];
	return {
		clock,
		slept,
		drains,
		ceilings,
		limiter: {
			now: () => clock.now,
			sleep: async (ms) => {
				slept.push(ms);
				clock.now += ms;
			},
			setTimer: (callback, ms) => {
				drains.push({ callback, ms });
			},
			startTimer: (callback, ms) => {
				const armed = { fire: callback, ms, cancelled: false };
				ceilings.push(armed);
				return () => {
					armed.cancelled = true;
				};
			},
		},
	};
}

/** The deps of a call: the public resolver, the loopback socket, a fake limiter clock. */
function depsOf(clock: FakeClock = fakeClock()): GeoServiceDeps & { readonly fake: FakeClock } {
	return { lookup: publicLookup, fetch: socketSeam, limiter: clock.limiter, fake: clock };
}

/**
 * One geo service call under the test seams. The entry point takes none (`geo_seams.ts`):
 * the seams ride a scope that only a gate can open.
 */
function ask(id: string, params: unknown, deps: GeoServiceDeps): Promise<GeoServiceResult> {
	return runWithGeoServiceSeams(deps, () => callGeoService(id, params));
}

/** Let every queued continuation run (no timer involved: the clock may be fake). */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 50; turn++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

/** Microtasks only: usable while the timers are fake. */
async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

/** Wait until `condition` holds, a few turns at a time (real sockets need real turns). */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turn = 0; turn < 400 && !condition(); turn++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(condition(), what).toBe(true);
}

async function failureOf(work: Promise<unknown>): Promise<DedaloError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof DedaloError) return error;
		throw error;
	}
	throw new Error('the call was expected to fail');
}

/** Everything a failure could show anyone: its log text, its coordinates, its wire body. */
function disclosure(error: DedaloError): string {
	return JSON.stringify({
		message: error.message,
		coordinates: error.coordinates,
		details: error.details,
		wire: toErrorBody(error),
	});
}

/** The strings a failure must never carry. */
const FORBIDDEN_IN_FAILURES = [
	PUBLIC_V4,
	'127.0.0.1',
	'nominatim.openstreetmap.org',
	'imperium.ahlfeldt.se',
	'ovc.catastro.meh.es',
	'www.ign.es',
	'api.open-elevation.com',
	'https://',
	'secret place name',
];

function expectNoLeak(error: DedaloError): void {
	const shown = disclosure(error);
	for (const forbidden of FORBIDDEN_IN_FAILURES) {
		expect(shown, `a failure showed "${forbidden}"`).not.toContain(forbidden);
	}
}

// ---------------------------------------------------------------------------
// A valid call for every service of the table, with a plausible answer
// ---------------------------------------------------------------------------

const FEATURE = {
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [-0.37564, 39.47533] },
			properties: { id: '16823', name: 'Valencia' },
		},
	],
};

const WMS_GEOMETRY = {
	crs: 'EPSG:25830',
	bbox: [725000, 4372000, 725400, 4372300],
	width: 400,
	height: 300,
	i: 200,
	j: 150,
};

interface Sample {
	readonly params: Record<string, unknown>;
	readonly answer: () => Response;
}

const SAMPLES: Record<string, Sample> = {
	nominatim_search: {
		params: { q: 'Valencia', countrycodes: 'ES,fr', limit: 3, language: 'es', addressdetails: 1 },
		answer: () => json([{ place_id: 1, lat: '39.47', lon: '-0.37', display_name: 'Valencia' }]),
	},
	nominatim_reverse: {
		params: { lat: 39.4699, lon: -0.3763, zoom: 10 },
		answer: () => json({ place_id: 1, display_name: 'Valencia' }),
	},
	dare_search_modern: { params: { name: 'Valentia' }, answer: () => json(FEATURE) },
	dare_search_ancient: { params: { name: 'Valentia' }, answer: () => json(FEATURE) },
	dare_nearest: {
		params: { point: [-0.37, 39.47], zoom: 8, count: 1 },
		answer: () => json(FEATURE),
	},
	dare_place: { params: { id: '16823' }, answer: () => json(FEATURE) },
	catastro_wms_featureinfo: {
		params: WMS_GEOMETRY,
		answer: () => markup('<?xml version="1.0"?><html><body>Parcel 5324524YJ2752C</body></html>'),
	},
	catastro_wfs_parcel: {
		params: { refcat: '5121101yj2752c', crs: 'EPSG:25830' },
		answer: () => markup('<?xml version="1.0"?><FeatureCollection numberReturned="1"/>'),
	},
	catastro_wfs_parcels_bbox: {
		params: { crs: 'EPSG:25830', bbox: [725000, 4372000, 725050, 4372050] },
		answer: () => markup('<?xml version="1.0"?><FeatureCollection numberReturned="8"/>'),
	},
	ign_admin_units_featureinfo: {
		params: { ...WMS_GEOMETRY, crs: 'EPSG:3857', bbox: [-42000, 4780000, -38000, 4784000] },
		answer: () => json(FEATURE),
	},
	open_elevation_lookup: {
		params: { locations: [[39.47, -0.37]] },
		answer: () => json({ results: [{ latitude: 39.47, longitude: -0.37, elevation: 15 }] }),
	},
};

/**
 * `count` DISTINCT valid parameter sets for a service. Identical calls in the air are ONE
 * call (`flights.ts`), so a gate that wants the limiter to see several must not repeat one.
 */
function distinctParams(id: string, count: number): Record<string, unknown>[] {
	const base = (SAMPLES[id] as Sample).params;
	return Array.from({ length: count }, (_, index) => {
		if (id === 'nominatim_search') return { ...base, q: `Valencia ${index}` };
		if (id === 'catastro_wfs_parcel')
			return { ...base, refcat: `5121101YJ2752${'ABCDEFGH'[index]}` };
		throw new Error(`no way to vary ${id}`);
	});
}

/**
 * A body that is a valid answer of `id` of EXACTLY `bytes` bytes, for the ceiling gates: the
 * service's shape with a padding string sized to fit.
 */
function bodyOfSize(id: string, bytes: number): string {
	const answer = GEO_SERVICES[id as keyof typeof GEO_SERVICES].answer;
	const shell =
		answer.kind === 'markup'
			? ['<doc>', '</doc>']
			: answer.shape === 'array'
				? ['["', '"]']
				: answer.shape === 'object'
					? ['{"pad":"', '"}']
					: answer.shape === 'results'
						? ['{"results":[],"pad":"', '"}']
						: ['{"type":"FeatureCollection","features":[{"type":"Feature"}],"pad":"', '"}'];
	const [head, tail] = shell as [string, string];
	const padding = bytes - head.length - tail.length;
	if (padding < 0) throw new Error(`${id}: no body fits ${bytes} bytes`);
	// Every character is ASCII, so the string's length is its size in bytes.
	return `${head}${'x'.repeat(padding)}${tail}`;
}

/** Run one call against the peer, answering as the sample says. */
async function callSample(id: string, deps: GeoServiceDeps = depsOf()) {
	const sample = SAMPLES[id] as Sample;
	peer.respond = sample.answer;
	return ask(id, sample.params, deps);
}

/**
 * WHAT THE PROVIDERS WERE VERIFIED AGAINST, written out. Every value below is a LITERAL:
 * none is read from the table it checks, so an edit of a table row — a path, a parameter, a
 * ceiling, a deadline, an `Accept`, an attribution, a pacing number — fails here until a
 * human has changed this gate on purpose. (A comparison of a row with itself passes whatever
 * the row says; the header of `table.ts` promises that a change to a provider's terms is a
 * reviewed edit, and this is what makes that so.) `url` is the address the sample's
 * parameters build, in the order they go on the wire.
 */
interface PinnedWire {
	readonly url: string;
	readonly accept: string;
	readonly maxBytes: number;
	readonly timeoutMs: number;
	/** How long an identical question is answered from memory (Nominatim only: its policy asks for it). */
	readonly keepAnswerMs?: number;
}

const PINNED_WIRE: Record<string, PinnedWire> = {
	nominatim_search: {
		url: 'https://nominatim.openstreetmap.org/search?format=jsonv2&q=Valencia&countrycodes=es%2Cfr&limit=3&accept-language=es&addressdetails=1',
		accept: 'application/json',
		maxBytes: 262_144,
		timeoutMs: 10_000,
		keepAnswerMs: 3_600_000,
	},
	nominatim_reverse: {
		url: 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=39.4699&lon=-0.3763&zoom=10',
		accept: 'application/json',
		maxBytes: 65_536,
		timeoutMs: 10_000,
		keepAnswerMs: 3_600_000,
	},
	dare_search_modern: {
		url: 'https://imperium.ahlfeldt.se/api/geojson.php?mss=Valentia',
		accept: 'application/json',
		maxBytes: 524_288,
		timeoutMs: 12_000,
	},
	dare_search_ancient: {
		url: 'https://imperium.ahlfeldt.se/api/geojson.php?ass=Valentia',
		accept: 'application/json',
		maxBytes: 524_288,
		timeoutMs: 12_000,
	},
	dare_nearest: {
		url: 'https://imperium.ahlfeldt.se/api/geojson.php?point=-0.37%2C39.47&zoom=8&count=1',
		accept: 'application/json',
		maxBytes: 524_288,
		timeoutMs: 12_000,
	},
	dare_place: {
		url: 'https://imperium.ahlfeldt.se/api/geojson.php?full=1&id=16823',
		accept: 'application/json',
		maxBytes: 524_288,
		timeoutMs: 12_000,
	},
	catastro_wms_featureinfo: {
		url:
			'https://ovc.catastro.meh.es/cartografia/INSPIRE/spadgcwms.aspx?SERVICE=WMS&VERSION=1.3.0' +
			'&REQUEST=GetFeatureInfo&LAYERS=CP.CadastralParcel&QUERY_LAYERS=CP.CadastralParcel&STYLES=' +
			'&FORMAT=image%2Fpng&INFO_FORMAT=text%2Fhtml&FEATURE_COUNT=1&CRS=EPSG%3A25830' +
			'&BBOX=725000%2C4372000%2C725400%2C4372300&WIDTH=400&HEIGHT=300&I=200&J=150',
		accept: 'text/html, text/xml;q=0.8',
		maxBytes: 65_536,
		timeoutMs: 15_000,
	},
	catastro_wfs_parcel: {
		url:
			'https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx?service=wfs&version=2&request=getfeature' +
			'&STOREDQUERY_ID=GetParcel&refcat=5121101YJ2752C&srsname=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A25830',
		accept: 'text/xml, application/xml;q=0.9',
		maxBytes: 262_144,
		timeoutMs: 15_000,
	},
	catastro_wfs_parcels_bbox: {
		url:
			'https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx?service=wfs&version=2.0.0&request=GetFeature' +
			'&typenames=CP%3ACadastralParcel&srsname=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A25830' +
			'&bbox=725000%2C4372000%2C725050%2C4372050',
		accept: 'text/xml, application/xml;q=0.9',
		maxBytes: 1_048_576,
		timeoutMs: 20_000,
	},
	ign_admin_units_featureinfo: {
		url:
			'https://www.ign.es/wms-inspire/unidades-administrativas?SERVICE=WMS&VERSION=1.3.0' +
			'&REQUEST=GetFeatureInfo&LAYERS=AU.AdministrativeUnit&QUERY_LAYERS=AU.AdministrativeUnit' +
			'&STYLES=&FORMAT=image%2Fpng&INFO_FORMAT=application%2Fjson&FEATURE_COUNT=1' +
			'&propertyName=inspireid%2Ccountry%2Cnationallevel%2Cnationalcode%2Cnameunit' +
			'&CRS=EPSG%3A3857&BBOX=-42000%2C4780000%2C-38000%2C4784000&WIDTH=400&HEIGHT=300&I=200&J=150',
		accept: 'application/json',
		maxBytes: 262_144,
		timeoutMs: 15_000,
	},
	open_elevation_lookup: {
		url: 'https://api.open-elevation.com/api/v1/lookup?locations=39.47%2C-0.37',
		accept: 'application/json',
		maxBytes: 65_536,
		timeoutMs: 15_000,
	},
};

/** Each provider's terms, as the table must state them. */
const PINNED_ORIGINS: Record<
	string,
	{
		readonly base: string;
		readonly maxConcurrent: number;
		readonly minIntervalMs: number;
		readonly maxQueue: number;
		readonly maxWaitMs: number;
		readonly backoffMs: number;
		readonly attribution: string;
	}
> = {
	nominatim: {
		base: 'https://nominatim.openstreetmap.org',
		maxConcurrent: 1,
		minIntervalMs: 1_100,
		maxQueue: 4,
		maxWaitMs: 6_000,
		backoffMs: 30_000,
		attribution: '© OpenStreetMap contributors (ODbL)',
	},
	dare: {
		base: 'https://imperium.ahlfeldt.se',
		maxConcurrent: 1,
		minIntervalMs: 500,
		maxQueue: 6,
		maxWaitMs: 8_000,
		backoffMs: 10_000,
		attribution:
			'Digital Atlas of the Roman Empire (DARE), Johan Åhlfeldt, Centre for Digital Humanities, University of Gothenburg, CC BY',
	},
	catastro: {
		base: 'https://ovc.catastro.meh.es',
		maxConcurrent: 2,
		minIntervalMs: 250,
		maxQueue: 8,
		maxWaitMs: 8_000,
		backoffMs: 15_000,
		attribution: 'Dirección General del Catastro (Spain)',
	},
	ign: {
		base: 'https://www.ign.es',
		maxConcurrent: 2,
		minIntervalMs: 250,
		maxQueue: 8,
		maxWaitMs: 8_000,
		backoffMs: 10_000,
		attribution: 'CC BY 4.0 ign.es',
	},
	open_elevation: {
		base: 'https://api.open-elevation.com',
		maxConcurrent: 1,
		minIntervalMs: 1_000,
		maxQueue: 3,
		maxWaitMs: 6_000,
		backoffMs: 30_000,
		attribution: 'NASA/USGS SRTM 1 arc-second, resampled by Open-Elevation',
	},
};

/** The pinned row of a service id. */
function pinnedOf(id: string): PinnedWire {
	return PINNED_WIRE[id] as PinnedWire;
}

/** The pinned address of a service id, parsed. */
function pinnedUrl(id: string): URL {
	return new URL(pinnedOf(id).url);
}

// ===========================================================================
// 1. The table
// ===========================================================================

describe('the table is closed and consistent', () => {
	test('exactly these services exist: a new one is a reviewed edit of the table AND of this gate', () => {
		expect(([...GEO_SERVICE_IDS] as string[]).sort()).toEqual(
			[
				'catastro_wfs_parcel',
				'catastro_wfs_parcels_bbox',
				'catastro_wms_featureinfo',
				'dare_nearest',
				'dare_place',
				'dare_search_ancient',
				'dare_search_modern',
				'ign_admin_units_featureinfo',
				'nominatim_reverse',
				'nominatim_search',
				'open_elevation_lookup',
			].sort(),
		);
		expect(Object.keys(SAMPLES).sort(), 'every service has a driven sample').toEqual(
			[...GEO_SERVICE_IDS].sort(),
		);
		expect(([...GEO_ORIGIN_IDS] as string[]).sort()).toEqual(
			['catastro', 'dare', 'ign', 'nominatim', 'open_elevation'].sort(),
		);
		expect(Object.isFrozen(GEO_SERVICES) && Object.isFrozen(GEO_ORIGINS)).toBe(true);
	});

	/** Every object and array reachable from `root` by own properties (a function is not walked). */
	function objectsUnder(root: unknown, found: Set<object> = new Set()): Set<object> {
		if (root === null || typeof root !== 'object' || found.has(root)) return found;
		found.add(root);
		for (const member of Object.values(root)) objectsUnder(member, found);
		return found;
	}

	test('"no override moves an endpoint" holds at run time: both tables are frozen to their LEAVES, and a write to a row throws', () => {
		// A shallow freeze left every row writable: `GEO_ORIGINS.nominatim.base = 'https://evil.example'`
		// succeeded, and buildGeoUrl then built that address (its own check compares the URL with
		// the row it was just handed), so a cataloguer's query went to a host a tool had chosen.
		for (const [name, table] of [
			['GEO_ORIGINS', GEO_ORIGINS],
			['GEO_SERVICES', GEO_SERVICES],
		] as const) {
			const objects = objectsUnder(table);
			expect(
				objects.size,
				`${name}: the walk reaches rows, tuples and parameter lists`,
			).toBeGreaterThan(GEO_ORIGIN_IDS.length);
			for (const object of objects) {
				expect(
					Object.isFrozen(object),
					`${name}: a ${Array.isArray(object) ? 'list' : 'record'} of ${Object.keys(object).slice(0, 4).join(', ')} is writable`,
				).toBe(true);
				// A RegExp cannot be made immutable (compile() rewrites it even when frozen), so none may be reachable.
				expect(object instanceof RegExp, `${name}: a RegExp is reachable from the table`).toBe(
					false,
				);
			}
		}
		const origins = GEO_ORIGINS as unknown as Record<string, Record<string, unknown>>;
		const services = GEO_SERVICES as unknown as Record<
			string,
			{ path: string; fixed: string[][]; params: Record<string, unknown>[] }
		>;
		const nominatim = origins.nominatim as Record<string, unknown>;
		const search = services.nominatim_search as (typeof services)[string];
		expect(() => {
			nominatim.base = 'https://evil.example';
		}, 'an origin row').toThrow(TypeError);
		expect(() => {
			nominatim.minIntervalMs = 0;
		}, 'a pacing number').toThrow(TypeError);
		expect(() => {
			search.path = '/elsewhere';
		}, 'a service row').toThrow(TypeError);
		expect(() => search.fixed.push(['format', 'xml']), 'the fixed list').toThrow(TypeError);
		expect(() => {
			(search.fixed[0] as string[])[1] = 'xml';
		}, 'a fixed tuple').toThrow(TypeError);
		expect(() => search.params.pop(), 'the parameter list').toThrow(TypeError);
		expect(() => {
			(search.params[0] as Record<string, unknown>).required = false;
		}, 'a parameter definition').toThrow(TypeError);
		// Nothing moved: the address is still the table's own.
		expect(origins.nominatim?.base).toBe('https://nominatim.openstreetmap.org');
		expect(buildGeoUrl('nominatim_search', GEO_SERVICES.nominatim_search, { q: 'Valencia' })).toBe(
			'https://nominatim.openstreetmap.org/search?format=jsonv2&q=Valencia',
		);
	});

	test('every service sits on a table origin, over https, on a fixed absolute path', () => {
		for (const id of GEO_SERVICE_IDS) {
			const service: GeoService = GEO_SERVICES[id];
			const origin = GEO_ORIGINS[service.origin];
			expect(origin, `${id}: its origin is in the table`).toBeDefined();
			expect(origin.base, `${id}: scheme and host only`).toMatch(/^https:\/\/[a-z0-9.-]+$/);
			expect(service.path, `${id}: an absolute path`).toMatch(/^\/[A-Za-z0-9_./-]+$/);
			expect(service.path.includes('..') || service.path.includes('//')).toBe(false);
			expect(
				origin.attribution.length,
				`${id}: the provider's attribution is stated`,
			).toBeGreaterThan(5);
		}
	});

	test('parameters are unambiguous: unique names, unique wire names, none shadowing a fixed one', () => {
		for (const id of GEO_SERVICE_IDS) {
			const service: GeoService = GEO_SERVICES[id];
			const names = service.params.map((def) => def.name);
			const wires = service.params.map((def) => def.wire.toLowerCase());
			const fixed = service.fixed.map(([name]) => name.toLowerCase());
			expect(new Set(names).size, `${id}: caller names`).toBe(names.length);
			expect(new Set(wires).size, `${id}: wire names`).toBe(wires.length);
			expect(
				wires.filter((wire) => fixed.includes(wire)),
				`${id}: a caller parameter shadows a fixed one`,
			).toEqual([]);
		}
	});

	test('every ceiling is finite: a body cap, a deadline, a queue, a wait, a back-off', () => {
		for (const id of GEO_SERVICE_IDS) {
			const service: GeoService = GEO_SERVICES[id];
			expect(service.maxBytes).toBeGreaterThan(0);
			expect(service.maxBytes, `${id}: a response ceiling of at most 1 MiB`).toBeLessThanOrEqual(
				1024 * 1024,
			);
			expect(service.timeoutMs).toBeGreaterThan(0);
			expect(service.timeoutMs, `${id}: a deadline of at most 20 s`).toBeLessThanOrEqual(20_000);
		}
		for (const id of GEO_ORIGIN_IDS) {
			const origin = GEO_ORIGINS[id];
			expect(origin.maxConcurrent).toBeGreaterThanOrEqual(1);
			expect(origin.maxQueue).toBeGreaterThanOrEqual(0);
			expect(origin.maxWaitMs).toBeGreaterThan(0);
			expect(origin.backoffMs, `${id}: a back-off after 429/503`).toBeGreaterThan(0);
			expect(origin.minIntervalMs).toBeGreaterThanOrEqual(0);
		}
	});

	test('a back-off outlasts the wait ceiling: that is what makes a newcomer after a 429 fail FAST, on every origin', () => {
		// `failures.ts` and `limiters.ts` promise that a caller who arrives during a back-off is
		// refused at once with `rate.limited` instead of queueing behind a pause it cannot outlast.
		// That holds only while the back-off is longer than the longest a caller waits.
		for (const id of GEO_ORIGIN_IDS) {
			const { backoffMs, maxWaitMs } = GEO_ORIGINS[id];
			expect(backoffMs, `${id}: backoffMs must exceed maxWaitMs`).toBeGreaterThan(maxWaitMs);
		}
	});

	test('an origin\u2019s queue could fill with instantaneous calls: maxQueue rounds of the interval fit inside the wait ceiling (a queue that never could is a dead bound)', () => {
		// The Nth caller in line starts about N x (call time + interval) after it arrived, per slot.
		// With calls that take no time that is `ceil(maxQueue / maxConcurrent)` intervals; with calls
		// that last, the ceiling refuses the last in line first (driven below). Both bounds are real.
		for (const id of GEO_ORIGIN_IDS) {
			const { maxConcurrent, maxQueue, minIntervalMs, maxWaitMs } = GEO_ORIGINS[id];
			const rounds = Math.ceil(maxQueue / maxConcurrent);
			expect(
				rounds * minIntervalMs,
				`${id}: ${rounds} intervals vs ${maxWaitMs} ms`,
			).toBeLessThanOrEqual(maxWaitMs);
		}
	});

	test('the table states what the providers were verified against: every origin, path, query, ceiling, deadline, Accept and attribution, as literals', () => {
		expect(Object.keys(PINNED_WIRE).sort()).toEqual([...GEO_SERVICE_IDS].sort());
		expect(Object.keys(PINNED_ORIGINS).sort()).toEqual([...GEO_ORIGIN_IDS].sort());
		for (const id of GEO_SERVICE_IDS) {
			const service: GeoService = GEO_SERVICES[id];
			const pinned = pinnedOf(id);
			const sample = SAMPLES[id] as Sample;
			expect(buildGeoUrl(id, service, sample.params), `${id}: the address`).toBe(pinned.url);
			expect(service.accept, `${id}: Accept`).toBe(pinned.accept);
			expect(service.maxBytes, `${id}: the response ceiling`).toBe(pinned.maxBytes);
			expect(service.timeoutMs, `${id}: the deadline`).toBe(pinned.timeoutMs);
			expect(
				service.keepAnswerMs,
				`${id}: how long an identical question is answered from memory`,
			).toBe(pinned.keepAnswerMs);
		}
		for (const id of GEO_ORIGIN_IDS) {
			expect(
				{ ...GEO_ORIGINS[id] } as Record<string, unknown>,
				`${id}: the provider's terms`,
			).toEqual(PINNED_ORIGINS[id] as Record<string, unknown>);
		}
	});

	test('an origin that lets one call fly at a time rests its interval after a call ENDS; one that lets several fly does not', () => {
		for (const id of GEO_ORIGIN_IDS) {
			expect(restAfterCallMs(id), id).toBe(
				GEO_ORIGINS[id].maxConcurrent === 1 ? GEO_ORIGINS[id].minIntervalMs : 0,
			);
		}
		expect(Object.fromEntries(GEO_ORIGIN_IDS.map((id) => [id, restAfterCallMs(id)]))).toEqual({
			nominatim: 1_100,
			dare: 500,
			catastro: 0,
			ign: 0,
			open_elevation: 1_000,
		});
	});

	test('a "nothing there" test is a function over provider text, stateless across calls: the table holds no RegExp, whose test() would be stateful with a g or y flag and recompilable by anyone', () => {
		let tested = 0;
		for (const id of GEO_SERVICE_IDS) {
			const { answer } = GEO_SERVICES[id];
			if (answer.kind !== 'markup') continue;
			expect(typeof answer.notFound, id).toBe('function');
			// A stateful pattern (g or y) alternates its verdict on a repeated test(); this does not.
			const verdicts = [1, 2, 3, 4].map(() => answer.notFound('Parcel not found'));
			expect(verdicts, id).toEqual([true, true, true, true]);
			expect(answer.notFound('a perfectly good parcel'), id).toBe(false);
			tested++;
		}
		expect(tested, 'the markup services were found').toBeGreaterThan(0);
		expect(() => matching(/a/g)).toThrow();
		expect(() => matching(/a/y)).toThrow();
		expect(matching(/^a$/)('a')).toBe(true);
	});

	test("Nominatim's terms: one call in flight and at least a second between starts", () => {
		expect(GEO_ORIGINS.nominatim.maxConcurrent).toBe(1);
		expect(GEO_ORIGINS.nominatim.minIntervalMs).toBeGreaterThanOrEqual(1000);
		// as-you-type search is forbidden: the query has a floor
		const query = GEO_SERVICES.nominatim_search.params.find((def) => def.name === 'q');
		expect(query?.check('ab')).toBeNull();
		expect(query?.check('abc')?.wire).toBe('abc');
	});

	test('the lookup is own-keys only, and a URL is not a service', () => {
		expect(geoServiceOf('nominatim_search')).not.toBeNull();
		for (const id of [
			'__proto__',
			'constructor',
			'toString',
			'hasOwnProperty',
			'',
			'NOMINATIM_SEARCH',
			'https://evil.test/x',
		]) {
			expect(geoServiceOf(id), id).toBeNull();
			expect(isGeoServiceId(id), id).toBe(false);
		}
	});

	test('a pattern with the g or y flag is refused at construction (it would make test() stateful)', () => {
		expect(() => token(/a/g, 5)).toThrow();
		expect(() => token(/a/y, 5)).toThrow();
		expect(token(/^a$/, 5)('a')?.wire).toBe('a');
	});
});

// ===========================================================================
// 2. The grammar of a parameter
// ===========================================================================

describe('what a parameter may be', () => {
	test('text: trimmed, NFC, a length window, no control or bidi character', () => {
		const check = text(3, 10);
		expect(check('  València ')?.wire).toBe('València');
		expect(check('é' + 'abc')?.wire, 'NFC').toBe('éabc');
		for (const bad of [
			'ab',
			'x'.repeat(11),
			'a\nb c',
			'abc\u0000',
			'abc‮',
			'a bc',
			7,
			null,
			['abc'],
		]) {
			expect(check(bad), String(bad)).toBeNull();
		}
	});

	test('text bounds the RAW input before it normalizes: a long run of combining marks costs a comparison, not seconds of the one event loop', () => {
		// String.prototype.normalize is quadratic on marks whose canonical classes run against
		// canonical order (measured, Bun 1.4.4: 50,001 units took 5.7 s, 100,001 took 23 s) and the
		// request body may be hundreds of MiB. Bounded first, the refusal is a trim and a comparison.
		const check = text(3, 200);
		const hostile = `e${'\u0301'.repeat(25_000)}${'\u0316'.repeat(25_000)}`;
		expect(hostile.length).toBe(50_001);
		for (const [what, value] of [
			['marks in reverse canonical order', hostile],
			['the same behind a megabyte of white space', `${' '.repeat(1_000_000)}${hostile}`],
			['a plain over-long string', 'a'.repeat(5_000_000)],
		] as const) {
			const started = performance.now();
			const verdict = check(value);
			const tookMs = performance.now() - started;
			expect(verdict, what).toBeNull();
			expect(tookMs, `${what}: refused in ${tookMs.toFixed(1)} ms`).toBeLessThan(100);
		}
	});

	test('…and the bound refuses nothing that would normalize into the window: the tightest case is accepted, one unit over is not', () => {
		// U+1F82 is the longest shrink in NFC: four units (alpha, psili, varia, ypogegrammeni) for one.
		const check = text(3, 200);
		const decomposed = '\u03b1\u0313\u0300\u0345';
		expect(decomposed.normalize()).toBe('\u1f82');
		const atTheBound = decomposed.repeat(200);
		expect(atTheBound.length).toBe(200 * NFC_SHRINK_LIMIT);
		expect(check(atTheBound)?.wire, 'raw 800 units normalize to exactly 200').toBe(
			'\u1f82'.repeat(200),
		);
		expect(check(`${atTheBound}a`), 'raw 801 units cannot normalize into 200').toBeNull();
		// White space around the text is trimmed first, however long.
		expect(check(`${' '.repeat(2_000_000)}Valencia${'\n'.repeat(2_000_000)}`)?.wire).toBe(
			'Valencia',
		);
	});

	test('NFC_SHRINK_LIMIT holds for EVERY code point of this runtime\u2019s Unicode tables: no unit decomposes into more than it allows', () => {
		// NFC(s).length >= NFD(s).length / (the most units one NFC unit stands for) >= s.length / limit.
		// A Unicode update that lengthens a canonical decomposition turns this red instead of
		// letting the bound refuse good input.
		let longest = 0;
		const over: string[] = [];
		for (let codePoint = 0xc0; codePoint <= 0x10ffff; codePoint++) {
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
			const unit = String.fromCodePoint(codePoint);
			const ratio = unit.normalize('NFD').length / unit.length;
			longest = Math.max(longest, ratio);
			if (ratio > NFC_SHRINK_LIMIT) over.push(`U+${codePoint.toString(16)}`);
		}
		expect(over, 'code points whose decomposition outgrows the limit').toEqual([]);
		expect(longest, 'the limit is tight: a looser one would only widen the window').toBe(
			NFC_SHRINK_LIMIT,
		);
	});

	test('numbers are written plainly: no exponent, no negative zero, 8 places at most', () => {
		expect(formatNumber(39.47533)).toBe('39.47533');
		expect(formatNumber(100)).toBe('100');
		expect(formatNumber(0.5)).toBe('0.5');
		expect(formatNumber(1e-7)).toBe('0.0000001');
		expect(formatNumber(1e-9)).toBe('0');
		expect(formatNumber(-0)).toBe('0');
		expect(formatNumber(-1e-12)).toBe('0');
		expect(formatNumber(-0.37)).toBe('-0.37');
		expect(formatNumber(725000)).toBe('725000');
		expect(formatNumber(10.05)).toBe('10.05');
	});

	test('integer, decimal, choice, token', () => {
		expect(integer(1, 10)(5)?.wire).toBe('5');
		expect(integer(1, 10)('7')?.wire).toBe('7');
		for (const bad of [0, 11, 1.5, '1.5', '1e3', '0x5', NaN, Infinity, null, [], '']) {
			expect(integer(1, 10)(bad), String(bad)).toBeNull();
		}
		expect(decimal(-90, 90)(39.4699)?.wire).toBe('39.4699');
		for (const bad of [91, -91, NaN, Infinity, '39', null])
			expect(decimal(-90, 90)(bad)).toBeNull();
		expect(choice(['0', '1'])(1)?.wire).toBe('1');
		expect(choice(['0', '1'])(true)).toBeNull();
		expect(choice(['EPSG:25830'], { 'EPSG:25830': 'urn:x' })('EPSG:25830')).toEqual({
			wire: 'urn:x',
			key: 'EPSG:25830',
			numbers: [],
		});
		expect(choice(['a'])('toString')).toBeNull();
		expect(token(/^[A-Z]{3}$/, 3, 'upper')(' abc ')?.wire).toBe('ABC');
		expect(token(/^[A-Z]{3}$/, 3, 'upper')('ab1')).toBeNull();
	});

	test('numbers and points: fixed length, every member finite and in its range', () => {
		const point = numbers([
			[-180, 180],
			[-90, 90],
		]);
		expect(point([-0.37, 39.47])?.wire).toBe('-0.37,39.47');
		for (const bad of [[1], [1, 2, 3], [181, 0], [0, 91], [NaN, 0], ['1', '2'], 'a,b', null, {}]) {
			expect(point(bad), JSON.stringify(bad)).toBeNull();
		}
		// The array is copied once: a proxy that answers differently the second time cannot make
		// the wire say what the check did not see.
		let reads = 0;
		const sneaky = new Proxy([1, 2], {
			get(target, key, receiver) {
				if (typeof key === 'string' && /^\d+$/.test(key)) {
					reads++;
					return reads > 2 ? 'x&y=1' : target[Number(key)];
				}
				return Reflect.get(target, key, receiver);
			},
		});
		expect(point(sneaky)?.wire).toBe('1,2');
		const list = points(2);
		expect(
			list([
				[39.47, -0.37],
				[40, 3],
			])?.wire,
		).toBe('39.47,-0.37|40,3');
		expect(
			list([
				[39.47, -0.37],
				[40, 3],
			])?.numbers,
		).toEqual([39.47, -0.37, 40, 3]);
		for (const bad of [
			[],
			[
				[1, 2],
				[3, 4],
				[5, 6],
			],
			[[91, 0]],
			[[0, 181]],
			[[1]],
			'x',
			null,
		]) {
			expect(list(bad), JSON.stringify(bad)).toBeNull();
		}
	});
});

// ===========================================================================
// 3. The request names no address
// ===========================================================================

describe('the request names no address: refused before any socket or slot', () => {
	async function refused(id: string, params: unknown): Promise<DedaloError> {
		const deps = depsOf();
		const error = await failureOf(ask(id, params, deps));
		expect(error.code, `${id} ${JSON.stringify(params)}`).toBe('request.invalid_data');
		expect(peer.received.length, 'no request reached the peer').toBe(0);
		expect(peer.pinned.length, 'no socket was opened').toBe(0);
		expect(geoOriginsTracked(), 'no limiter slot was ever taken').toBe(0);
		expect(geoFlightsInProgress(), 'no call was ever put in the air').toBe(0);
		expect(deps.fake.slept, 'no spacing was reserved').toEqual([]);
		return error;
	}

	test('an id outside the table — a URL, a prototype key, another case — is refused', async () => {
		for (const id of [
			'https://nominatim.openstreetmap.org/search?q=x',
			'//evil.test/search',
			'__proto__',
			'constructor',
			'toString',
			'NOMINATIM_SEARCH',
			'nominatim_search ',
			'nominatim_search/../x',
			'',
		]) {
			await refused(id, { q: 'Valencia' });
		}
		// An id that is not even a string cannot be a service.
		await refused(undefined as unknown as string, {});
		await refused({ toString: () => 'nominatim_search' } as unknown as string, { q: 'Valencia' });
	});

	test('a key the service does not name — a URL, a header, a fixed parameter, __proto__ — is refused', async () => {
		const base = { q: 'Valencia' };
		for (const extra of [
			{ url: 'https://evil.test/' },
			{ host: 'evil.test' },
			{ headers: { Cookie: 'x' } },
			{ format: 'xml' },
			{ 'accept-language': 'es' },
			{ Q: 'x' },
		]) {
			await refused('nominatim_search', { ...base, ...extra });
		}
		await refused('nominatim_search', JSON.parse('{"q":"Valencia","__proto__":{"a":1}}'));
		// The service's own fixed names cannot be overridden through a caller key either.
		await refused('catastro_wms_featureinfo', { ...WMS_GEOMETRY, REQUEST: 'GetMap' });
		await refused('ign_admin_units_featureinfo', { ...WMS_GEOMETRY, propertyName: '*' });
	});

	test('a missing required key, a wrong type or a value off its grammar is refused', async () => {
		await refused('nominatim_search', {});
		await refused('nominatim_search', { q: 'ab' });
		await refused('nominatim_search', { q: 'x'.repeat(201) });
		await refused('nominatim_search', { q: ['Valencia'] });
		await refused('nominatim_search', { q: 'Valencia', limit: 11 });
		await refused('nominatim_search', { q: 'Valencia', countrycodes: 'esp' });
		await refused('nominatim_search', { q: 'Valencia', language: 'es;q=0' });
		await refused('nominatim_search', { q: 'Valencia', viewbox: [0, 0, 1, 91] });
		await refused('nominatim_reverse', { lat: 39.47 });
		await refused('nominatim_reverse', { lat: '39.47', lon: -0.37 });
		await refused('dare_place', { id: '16823 OR 1=1' });
		await refused('dare_place', { id: 'abc' });
		await refused('dare_nearest', { point: [-0.37, 39.47], count: 21 });
		await refused('catastro_wfs_parcel', { refcat: '5121101YJ2752C&x=1', crs: 'EPSG:25830' });
		await refused('catastro_wfs_parcel', { refcat: '5121101YJ2752', crs: 'EPSG:25830' });
		await refused('catastro_wfs_parcel', { refcat: '5121101YJ2752C', crs: 'EPSG:4326' });
		await refused('open_elevation_lookup', { locations: [] });
		await refused('open_elevation_lookup', { locations: [[91, 0]] });
		await refused('open_elevation_lookup', {
			locations: Array.from({ length: 26 }, () => [39.47, -0.37]),
		});
	});

	test('parameters that are not a plain object are refused', async () => {
		for (const params of [null, 'q=Valencia', 7, ['q'], true]) {
			await refused('nominatim_search', params);
		}
	});

	test('the refusal names the service and the parameter, never the rejected value', async () => {
		const error = await refused('nominatim_search', { q: 'ab', limit: 'secret place name' });
		expect(error.message).toContain('nominatim_search');
		expect(error.coordinates?.service).toBe('nominatim_search');
		expect(disclosure(error)).not.toContain('secret place name');
		const second = await refused('nominatim_search', { q: 'Valencia', 'secret place name': 1 });
		expect(second.message, 'the log names the key, quoted').toContain('"secret place name"');
		// A key is the caller's own text, so it is logged QUOTED and bounded — never on the wire.
		expect(toErrorBody(second).message).not.toContain('secret');
	});

	test('the WMS cross-checks: a real box under the ceiling, the pixel inside the image, a safe CRS', async () => {
		const wms = (over: Record<string, unknown>) => ({ ...WMS_GEOMETRY, ...over });
		await refused('catastro_wms_featureinfo', wms({ bbox: [725400, 4372000, 725000, 4372300] }));
		await refused('catastro_wms_featureinfo', wms({ bbox: [725000, 4372300, 725400, 4372000] }));
		await refused('catastro_wms_featureinfo', wms({ i: 400 }));
		await refused('catastro_wms_featureinfo', wms({ j: 300 }));
		await refused('catastro_wms_featureinfo', wms({ bbox: [0, 0, 50_001, 100] }));
		await refused('catastro_wms_featureinfo', wms({ bbox: [0, 0, 100, 50_001] }));
		await refused('catastro_wms_featureinfo', wms({ crs: 'CRS:84', bbox: [0, 0, 0.51, 0.1] }));
		// EPSG:4326 would swap the axes of a WMS 1.3.0 box: it is not offered at all.
		await refused('catastro_wms_featureinfo', wms({ crs: 'EPSG:4326' }));
		await refused('catastro_wms_featureinfo', wms({ crs: 'EPSG:4258' }));
		await refused('catastro_wms_featureinfo', wms({ width: 2049 }));
		await refused('catastro_wms_featureinfo', wms({ width: 0 }));
		await refused('catastro_wms_featureinfo', wms({ bbox: [725000, 4372000, 725400] }));
		await refused('catastro_wms_featureinfo', wms({ bbox: [725000, 4372000, 725400, Number.NaN] }));
		await refused('ign_admin_units_featureinfo', wms({ bbox: [0, 0, 200_001, 100] }));
		await refused('catastro_wfs_parcels_bbox', { crs: 'EPSG:25830', bbox: [0, 0, 1001, 10] });
		await refused('catastro_wfs_parcels_bbox', { crs: 'EPSG:25830', bbox: [10, 0, 0, 10] });
		await refused('catastro_wfs_parcels_bbox', { crs: 'EPSG:3857', bbox: [0, 0, 10, 10] });
	});

	test('a box is accepted AT its ceiling and refused one step over it — per service, per unit of the CRS', async () => {
		// `at` is the widest box the service takes; `over` the first one it refuses. The numbers
		// are literals: the ceilings are the providers' "no massive downloads" terms.
		const cases: [id: string, params: Record<string, unknown>, over: Record<string, unknown>][] = [
			[
				'catastro_wms_featureinfo',
				{ ...WMS_GEOMETRY, bbox: [725000, 4372000, 775000, 4372300] },
				{ ...WMS_GEOMETRY, bbox: [725000, 4372000, 775001, 4372300] },
			],
			[
				'catastro_wms_featureinfo',
				{ ...WMS_GEOMETRY, crs: 'CRS:84', bbox: [0, 0, 0.5, 0.1] },
				{ ...WMS_GEOMETRY, crs: 'CRS:84', bbox: [0, 0, 0.51, 0.1] },
			],
			[
				'ign_admin_units_featureinfo',
				{ ...WMS_GEOMETRY, crs: 'EPSG:3857', bbox: [0, 0, 200_000, 100] },
				{ ...WMS_GEOMETRY, crs: 'EPSG:3857', bbox: [0, 0, 200_001, 100] },
			],
			[
				'ign_admin_units_featureinfo',
				{ ...WMS_GEOMETRY, crs: 'CRS:84', bbox: [-1, 39, 0, 39.5] },
				{ ...WMS_GEOMETRY, crs: 'CRS:84', bbox: [-1, 39, 0.01, 39.5] },
			],
			[
				'ign_admin_units_featureinfo',
				{ ...WMS_GEOMETRY, crs: 'CRS:84', bbox: [-1, 39, 0, 40] },
				{ ...WMS_GEOMETRY, crs: 'CRS:84', bbox: [-1, 39, 0, 40.01] },
			],
			[
				'catastro_wfs_parcels_bbox',
				{ crs: 'EPSG:25830', bbox: [725000, 4372000, 726000, 4372500] },
				{ crs: 'EPSG:25830', bbox: [725000, 4372000, 726001, 4372500] },
			],
		];
		for (const [id, at, over] of cases) {
			await refused(id, over);
			const sample = SAMPLES[id] as Sample;
			peer.respond = sample.answer;
			const deps = depsOf();
			await ask(id, at, deps);
			expect(
				peer.received.length,
				`${id} ${JSON.stringify(at)}: the box at the ceiling is sent`,
			).toBe(1);
			peer.received = [];
			peer.pinned = [];
			clearGeoServicesForTests();
		}
	});

	test('the built address is CHECKED against its table row: a row whose path would not survive is an invariant failure, nothing leaves', () => {
		const row: GeoService = { ...GEO_SERVICES.dare_place, path: '/api/geojson.php?x=1#frag' };
		let thrown: unknown;
		try {
			buildGeoUrl('dare_place', row, { id: '16823' });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as DedaloError).code).toBe('internal.invariant');
		expect(peer.received.length).toBe(0);
		// …and a sound row builds exactly its origin and path.
		const built = new URL(buildGeoUrl('dare_place', GEO_SERVICES.dare_place, { id: '16823' }));
		expect(built.origin).toBe(GEO_ORIGINS.dare.base);
		expect(built.pathname).toBe('/api/geojson.php');
		expect(built.search).toBe('?full=1&id=16823');
		expect(built.hash + built.username + built.password).toBe('');
	});

	test('a value full of delimiters stays ONE value of its own key; the path, the host and the other keys do not move', async () => {
		peer.respond = () => json([]);
		const nasty = 'x&format=xml&limit=99#frag/../../etc?a=b=c @evil.test \\ \' " ;';
		await ask('nominatim_search', { q: nasty, limit: 2 }, depsOf());
		const seen = peer.received[0] as Received;
		expect(seen.pathname).toBe('/search');
		expect(seen.query.get('q')).toBe(nasty);
		expect(seen.query.getAll('format')).toEqual(['jsonv2']);
		expect(seen.query.getAll('limit')).toEqual(['2']);
		expect([...seen.query.keys()]).toEqual(['format', 'q', 'limit']);
		expect(peer.pinned[0]?.address, 'the vetted address, never the name').toBe(PUBLIC_V4);
		expect(peer.pinned[0]?.hostHeader).toBe('nominatim.openstreetmap.org');
	});
});

// ===========================================================================
// 4. Every service, end to end
// ===========================================================================

describe('every service of the table, driven on a plausible answer', () => {
	for (const id of GEO_SERVICE_IDS) {
		test(`${id}: its fixed parameters, then the caller's, on its own path — pinned, identified, read-only`, async () => {
			const service: GeoService = GEO_SERVICES[id];
			const expected = pinnedUrl(id);
			const result = await callSample(id);
			const seen = peer.received[0] as Received;
			expect(peer.received.length).toBe(1);
			expect(seen.method).toBe('GET');
			// What the provider receives is the pinned literal: path and the whole query, in order.
			expect(seen.pathname).toBe(expected.pathname);
			expect(seen.search).toBe(expected.search);
			const keys = [...seen.query.keys()];
			expect(keys.slice(0, service.fixed.length)).toEqual(service.fixed.map(([name]) => name));
			for (const [name, value] of service.fixed) expect(seen.query.get(name), name).toBe(value);
			const given = Object.keys((SAMPLES[id] as Sample).params);
			const wires = service.params.filter((def) => given.includes(def.name)).map((def) => def.wire);
			expect(keys.slice(service.fixed.length), 'the caller parameters, in table order').toEqual(
				wires,
			);
			// The guard pinned the socket to the vetted address and kept the real name.
			const pinned = peer.pinned[0] as Pinned;
			expect(pinned.address).toBe(PUBLIC_V4);
			expect(pinned.protocol).toBe('https:');
			expect(pinned.hostHeader).toBe(expected.host);
			expect(pinned.serverName).toBe(expected.hostname);
			// An identifying User-Agent, the service's Accept, and nothing else of the caller's.
			expect(seen.headers.get('user-agent')).toBe(geoUserAgent());
			expect(seen.headers.get('accept')).toBe(pinnedOf(id).accept);
			for (const header of ['cookie', 'authorization', 'referer', 'x-forwarded-for']) {
				expect(seen.headers.get(header), header).toBeNull();
			}
			expect(result.service).toBe(id);
			expect(result.attribution).toBe(
				(PINNED_ORIGINS[service.origin] as { attribution: string }).attribution,
			);
			expect(result.kind).toBe(service.answer.kind);
		});
	}

	test('the exact query of the WMS and WFS shapes (what the providers were verified against)', async () => {
		await callSample('catastro_wms_featureinfo');
		expect((peer.received[0] as Received).search).toBe(
			'?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=CP.CadastralParcel' +
				'&QUERY_LAYERS=CP.CadastralParcel&STYLES=&FORMAT=image%2Fpng&INFO_FORMAT=text%2Fhtml' +
				'&FEATURE_COUNT=1&CRS=EPSG%3A25830&BBOX=725000%2C4372000%2C725400%2C4372300' +
				'&WIDTH=400&HEIGHT=300&I=200&J=150',
		);
		peer.received = [];
		await callSample('catastro_wfs_parcel');
		expect((peer.received[0] as Received).search).toBe(
			'?service=wfs&version=2&request=getfeature&STOREDQUERY_ID=GetParcel' +
				'&refcat=5121101YJ2752C&srsname=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A25830',
		);
		peer.received = [];
		await callSample('open_elevation_lookup');
		expect((peer.received[0] as Received).query.get('locations')).toBe('39.47,-0.37');
	});

	test('numbers reach the wire canonical: a bounding box, a point list, an upper-cased reference', async () => {
		peer.respond = () => json({ results: [] });
		await ask(
			'open_elevation_lookup',
			{
				locations: [
					[39.470000001, -0.37],
					[40, 3.5],
				],
			},
			depsOf(),
		);
		expect((peer.received[0] as Received).query.get('locations')).toBe('39.47,-0.37|40,3.5');
		peer.respond = () => json(FEATURE);
		await ask('dare_nearest', { point: [-0.37, 39.47], count: '2' }, depsOf());
		const seen = peer.received[1] as Received;
		expect(seen.query.get('point')).toBe('-0.37,39.47');
		expect(seen.query.get('count')).toBe('2');
		expect(seen.query.has('zoom'), 'an optional key absent stays absent').toBe(false);
	});

	test('the DARE services share one endpoint and differ in the parameter they send', async () => {
		peer.respond = () => json(FEATURE);
		const deps = depsOf();
		await ask('dare_search_modern', { name: 'Valentia' }, deps);
		await ask('dare_search_ancient', { name: 'Valentia' }, deps);
		await ask('dare_place', { id: '16823' }, deps);
		expect(peer.received.map((seen) => seen.search)).toEqual([
			'?mss=Valentia',
			'?ass=Valentia',
			'?full=1&id=16823',
		]);
	});
});

// ===========================================================================
// 5. The answer is checked against the contract
// ===========================================================================

describe('an answer is checked against its service', () => {
	async function answered(id: string, response: Response): Promise<unknown> {
		peer.respond = () => response;
		return ask(id, (SAMPLES[id] as Sample).params, depsOf());
	}

	test('a body that is not the service’s shape is external.protocol', async () => {
		const cases: [string, Response][] = [
			['nominatim_search', new Response('<html>maintenance</html>')],
			['nominatim_search', json({ not: 'an array' })],
			['nominatim_search', new Response('')],
			['nominatim_reverse', json([])],
			['dare_nearest', json({ type: 'Feature' })],
			['dare_nearest', json({ type: 'FeatureCollection' })],
			['ign_admin_units_featureinfo', json([])],
			['open_elevation_lookup', json({ results: 'x' })],
			['catastro_wms_featureinfo', json({ a: 1 })],
			['catastro_wfs_parcel', new Response('plain text, not markup')],
			['catastro_wfs_parcel', new Response('')],
		];
		for (const [id, response] of cases) {
			const error = await failureOf(answered(id, response));
			expect(error.code, id).toBe('external.protocol');
			expectNoLeak(error);
		}
	});

	test('a search that finds nothing is an EMPTY RESULT; a question with one answer is external.not_found', async () => {
		const empty = await answered('nominatim_search', json([]));
		expect(empty).toMatchObject({ kind: 'json', data: [] });
		const none = await answered(
			'dare_search_modern',
			json({ type: 'FeatureCollection', features: [] }),
		);
		expect(none).toMatchObject({ kind: 'json' });
		const nearest = await answered(
			'dare_nearest',
			json({ type: 'FeatureCollection', features: [] }),
		);
		expect(nearest).toMatchObject({ kind: 'json' });

		const missing: [string, Response][] = [
			['nominatim_reverse', json({ error: 'Unable to geocode' })],
			['dare_place', json({ type: 'FeatureCollection', features: [] })],
			['ign_admin_units_featureinfo', json({ type: 'FeatureCollection', features: [] })],
			[
				'catastro_wms_featureinfo',
				markup(
					'<?xml version="1.0"?><ServiceExceptionReport><ServiceException>Cadastral parcel not found</ServiceException></ServiceExceptionReport>',
				),
			],
			[
				'catastro_wfs_parcel',
				markup(
					'<?xml version="1.0"?><ExceptionReport xmlns="http://www.opengis.net/ows/1.1"><ExceptionText>No se ha encontrado la parcela 0000000XX0000X</ExceptionText></ExceptionReport>',
				),
			],
			[
				'catastro_wfs_parcels_bbox',
				markup(
					'<?xml version="1.0"?><ows:ExceptionReport><ows:ExceptionText>No records founded for BBOX and SRS provided</ows:ExceptionText></ows:ExceptionReport>',
				),
			],
		];
		for (const [id, response] of missing) {
			const error = await failureOf(answered(id, response));
			expect(error.code, id).toBe('external.not_found');
			expect(error.spec.retryable, 'a retry can never succeed').toBe(false);
			expectNoLeak(error);
		}
	});

	test('an exception report that is not "nothing there" is external.protocol, not a result', async () => {
		const error = await failureOf(
			answered(
				'catastro_wfs_parcel',
				markup(
					'<?xml version="1.0"?><ExceptionReport><ExceptionText>Invalid SRS</ExceptionText></ExceptionReport>',
				),
			),
		);
		expect(error.code).toBe('external.protocol');
	});

	test('a good markup answer is returned as text, with the attribution beside it', async () => {
		const result = await answered(
			'catastro_wms_featureinfo',
			markup('﻿  <?xml version="1.0"?><html><body>ok</body></html>'),
		);
		expect(result).toMatchObject({
			service: 'catastro_wms_featureinfo',
			kind: 'markup',
			attribution: GEO_ORIGINS.catastro.attribution,
		});
	});
});

// ===========================================================================
// 6. Failures: one taxonomy, no address
// ===========================================================================

describe('a failure is typed, retryable only when a retry can help, and names no address', () => {
	async function failing(
		id: string,
		response: Response | (() => Response),
		deps: GeoServiceDeps = depsOf(),
	): Promise<DedaloError> {
		peer.respond = () => (typeof response === 'function' ? response() : response);
		const error = await failureOf(ask(id, (SAMPLES[id] as Sample).params, deps));
		expectNoLeak(error);
		return error;
	}

	test('404 and 410 are external.not_found: the provider answered, nothing is there', async () => {
		for (const status of [404, 410]) {
			const error = await failing('dare_place', new Response('gone', { status }));
			expect(error.code).toBe('external.not_found');
			expect(error.coordinates).toMatchObject({ service: 'dare_place', origin: 'dare', status });
			expect(error.retryAfterMs).toBeUndefined();
		}
	});

	test('a TRANSIENT non-2xx is external.http_status with the status, retryable; none of them asks the origin to wait', async () => {
		const deps = depsOf();
		for (const status of [408, 425, 500, 502, 504, 599]) {
			peer.respond = () => new Response('<html>error page</html>', { status });
			const error = await failureOf(ask('nominatim_search', { q: 'Valencia' }, deps));
			expect(error.code, String(status)).toBe('external.http_status');
			expect(error.coordinates?.status).toBe(status);
			expect(error.retryAfterMs).toBeUndefined();
			expect(error.spec.retryable, `${status}: a later attempt can plausibly succeed`).toBe(true);
			expectNoLeak(error);
		}
		// The next call is not held back by a back-off: only the spacing between starts.
		peer.respond = () => json([]);
		await ask('nominatim_search', { q: 'Valencia' }, deps);
	});

	test('a REFUSED request — any other 4xx — is external.bad_config and NOT retryable: the same bytes cannot change a 400, and repeating a 403 is what a block objects to', async () => {
		// `retryable` is a property of the code and the browser transport re-sends a retryable failure up
		// to five times, so a 400, 401 or 403 under `external.http_status` was sent to the provider five
		// times — the Nominatim 403 of a blocked client being exactly where repeated sends hurt.
		const deps = depsOf();
		for (const status of [400, 401, 402, 403, 405, 406, 409, 414, 415, 422, 451]) {
			peer.respond = () => new Response('<html>refused</html>', { status });
			const error = await failureOf(ask('nominatim_search', { q: 'Valencia' }, deps));
			expect(error.code, String(status)).toBe('external.bad_config');
			expect(error.coordinates).toMatchObject({
				service: 'nominatim_search',
				origin: 'nominatim',
				status,
			});
			expect(error.spec.retryable, `${status}: resending the same request cannot help`).toBe(false);
			expect(error.spec.disclosure).toBe('operator');
			expect(error.retryAfterMs).toBeUndefined();
			expectNoLeak(error);
		}
		// It asks the origin for no back-off (the limiter's pacing holds the rate): only the spacing between starts.
		peer.respond = () => json([]);
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		// …and the two statuses that DO say "later" are still the busy pair: retryable, with a back-off.
		for (const status of [429, 503]) {
			clearGeoServicesForTests();
			peer.respond = () => new Response('slow down', { status });
			const busy = await failureOf(ask('dare_place', { id: '16823' }, depsOf()));
			expect(busy.code).toBe('external.http_status');
			expect(busy.spec.retryable).toBe(true);
		}
	});

	test('429 and 503 carry retryAfterMs and leave the origin alone: on EVERY origin a newcomer fails FAST with rate.limited', async () => {
		// One service per provider. The claim ("refused at once, not queued behind the pause") is
		// the origin's own, so it is driven on each of the five, not on Nominatim alone.
		const onOrigin: [origin: keyof typeof PINNED_ORIGINS, id: string, other: string][] = [
			['nominatim', 'nominatim_search', 'dare_search_modern'],
			['dare', 'dare_search_modern', 'nominatim_search'],
			['catastro', 'catastro_wfs_parcel', 'dare_search_modern'],
			['ign', 'ign_admin_units_featureinfo', 'dare_search_modern'],
			['open_elevation', 'open_elevation_lookup', 'dare_search_modern'],
		];
		expect(onOrigin.map(([origin]) => origin).sort()).toEqual([...GEO_ORIGIN_IDS].sort());
		for (const [origin, id, other] of onOrigin) {
			const backoffMs = PINNED_ORIGINS[origin]?.backoffMs as number;
			for (const status of [429, 503]) {
				clearGeoServicesForTests();
				const deps = depsOf();
				const error = await failing(id, new Response('slow down', { status }), deps);
				expect(error.code, `${id} ${status}`).toBe('external.http_status');
				expect(error.retryAfterMs, `${id} ${status}`).toBe(backoffMs);

				const received = peer.received.length;
				const sleptBefore = deps.fake.slept.length;
				peer.respond = (SAMPLES[id] as Sample).answer;
				const refusal = await failureOf(ask(id, (SAMPLES[id] as Sample).params, deps));
				expect(refusal.code, `${id} ${status}: a newcomer is refused`).toBe('rate.limited');
				expect(peer.received.length, `${id}: the busy origin was not contacted again`).toBe(
					received,
				);
				expect(deps.fake.slept.length, `${id}: it did not wait the back-off out`).toBe(sleptBefore);

				// Another provider is unaffected.
				peer.respond = (SAMPLES[other] as Sample).answer;
				await ask(other, (SAMPLES[other] as Sample).params, deps);

				// Once the back-off has passed, the origin answers again.
				deps.fake.clock.now += backoffMs + 1;
				peer.respond = (SAMPLES[id] as Sample).answer;
				await ask(id, (SAMPLES[id] as Sample).params, deps);
			}
		}
	});

	test('a redirect is never followed: external.transport, and the Location is never contacted', async () => {
		const error = await failing(
			'nominatim_search',
			new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1/admin' } }),
		);
		expect(error.code).toBe('external.transport');
		expect(error.coordinates?.reason).toBe('redirect');
		expect(peer.received.length, 'one request only').toBe(1);
	});

	test('the byte ceiling of EVERY service holds exactly: a body of that size is read, one byte more is external.too_large', async () => {
		for (const id of GEO_SERVICE_IDS) {
			const ceiling = pinnedOf(id).maxBytes;
			clearGeoServicesForTests();
			const deps = depsOf();
			const inside = bodyOfSize(id, ceiling);
			expect(
				new TextEncoder().encode(inside).byteLength,
				`${id}: the probe body is built to the byte`,
			).toBe(ceiling);
			peer.respond = () => new Response(inside);
			await ask(id, (SAMPLES[id] as Sample).params, deps);

			clearGeoServicesForTests();
			peer.respond = () => new Response(bodyOfSize(id, ceiling + 1));
			const error = await failureOf(ask(id, (SAMPLES[id] as Sample).params, deps));
			expect(error.code, `${id}: one byte over`).toBe('external.too_large');
			expect(error.coordinates?.reason).toBe('body_cap');
			expectNoLeak(error);
		}
	});

	test('a socket that fails is external.transport', async () => {
		const deps: GeoServiceDeps = {
			...depsOf(),
			fetch: () =>
				Promise.reject(Object.assign(new Error('refused'), { code: 'ConnectionRefused' })),
		};
		const error = await failureOf(ask('dare_search_modern', { name: 'Valentia' }, deps));
		expect(error.code).toBe('external.transport');
		expectNoLeak(error);
	});

	test('a provider that never answers ends at the SERVICE’s own deadline as external.timeout — every service, to the millisecond', async () => {
		jest.useFakeTimers();
		for (const id of GEO_SERVICE_IDS) {
			clearGeoServicesForTests();
			const deps: GeoServiceDeps = { ...depsOf(), fetch: () => new Promise<Response>(() => {}) };
			const deadline = pinnedOf(id).timeoutMs;
			const outcome = failureOf(ask(id, (SAMPLES[id] as Sample).params, deps));
			let settled = false;
			outcome.then(() => {
				settled = true;
			});
			await flushMicrotasks();
			jest.advanceTimersByTime(deadline - 1);
			await flushMicrotasks();
			expect(settled, `${id}: not before ${deadline} ms`).toBe(false);
			jest.advanceTimersByTime(1);
			const error = await outcome;
			expect(error.code, id).toBe('external.timeout');
			expect(error.coordinates?.reason).toBe('timeout');
			expectNoLeak(error);
		}
	});

	test('an address the guard judges non-public is external.blocked_host, and the failure names no address, host or query', async () => {
		for (const lookup of [
			async () => [{ address: '10.0.0.5', family: 4 }],
			async () => [{ address: '127.0.0.1', family: 4 }],
			async () => [{ address: '169.254.169.254', family: 4 }],
			async () => [{ address: 'fd00:ec2::254', family: 6 }],
		] as AddressLookup[]) {
			const deps: GeoServiceDeps = { ...depsOf(), lookup };
			const error = await failureOf(ask('nominatim_search', { q: 'secret place name' }, deps));
			expect(error.code).toBe('external.blocked_host');
			expect(error.spec.disclosure).toBe('operator');
			expect(error.spec.retryable).toBe(false);
			for (const forbidden of ['10.0.0.5', '169.254.169.254', 'fd00:ec2::254']) {
				expect(disclosure(error)).not.toContain(forbidden);
			}
			expectNoLeak(error);
			expect(peer.pinned.length, 'no socket opened').toBe(0);
		}
	});

	test('a name that does not RESOLVE is external.transport (reason dns), retryable — a resolver blip is not a policy block, and it names no host', async () => {
		// Both used to read as `external.blocked_host`: permanent, "The external host is not allowed",
		// pointing the operator at the SSRF configuration for what was a network fault.
		for (const lookup of [
			async () => {
				throw new Error('ENOTFOUND nominatim.openstreetmap.org');
			},
			async () => [],
		] as AddressLookup[]) {
			const deps: GeoServiceDeps = { ...depsOf(), lookup };
			const error = await failureOf(ask('nominatim_search', { q: 'secret place name' }, deps));
			expect(error.code).toBe('external.transport');
			expect(error.coordinates?.reason).toBe('dns');
			expect(error.spec.retryable, 'a later attempt can resolve').toBe(true);
			expect(error.spec.disclosure).toBe('operator');
			expect(error.retryAfterMs).toBeUndefined();
			expect(disclosure(error)).not.toContain('ENOTFOUND');
			expectNoLeak(error);
			expect(peer.pinned.length, 'no socket opened').toBe(0);
		}
	});

	test('every refusal the guard can make is classified: the two that mean "did not resolve" are transport, all others — address or URL shape — are blocked_host', () => {
		const resolution = new Set(['dns_failed', 'no_addresses']);
		for (const reason of Object.keys(SSRF_REFUSAL_KINDS)) {
			const refusal = new DedaloError('security.ssrf_blocked', {
				message: `ssrf: refused 10.1.2.3 (${reason})`,
				coordinates: { reason, host: 'nominatim.openstreetmap.org' },
			});
			const { error, backoffMs } = classifyFailure('nominatim_search', 'nominatim', refusal);
			expect((error as DedaloError).code, reason).toBe(
				resolution.has(reason) ? 'external.transport' : 'external.blocked_host',
			);
			expect((error as DedaloError).cause, reason).toBe(refusal);
			expect(backoffMs, reason).toBe(0);
		}
	});

	test('a stop of the running job is passed through UNCHANGED, and so is a defect', () => {
		const stopped = new DedaloError('security.outbound_failed', {
			coordinates: { reason: 'aborted', stage: 'connect' },
		});
		expect(classifyFailure('dare_place', 'dare', stopped).error).toBe(stopped);
		const defect = new RangeError('a bug');
		expect(classifyFailure('dare_place', 'dare', defect).error).toBe(defect);
		const limited = new DedaloError('rate.limited');
		expect(classifyFailure('dare_place', 'dare', limited).error).toBe(limited);
		// Every reason of the text door maps onto exactly one external code.
		const reason = (name: string) =>
			(
				classifyFailure(
					'dare_place',
					'dare',
					new DedaloError('security.outbound_failed', { coordinates: { reason: name } }),
				).error as DedaloError
			).code;
		expect(reason('timeout')).toBe('external.timeout');
		expect(reason('idle')).toBe('external.timeout');
		expect(reason('body_cap')).toBe('external.too_large');
		expect(reason('transport')).toBe('external.transport');
		expect(reason('redirect')).toBe('external.transport');
		expect(reason('constructor'), 'a prototype key is not a reason').toBe(
			'security.outbound_failed',
		);
		expect(reason('unheard_of')).toBe('security.outbound_failed');
	});

	test('a failure carries the original only as its cause', () => {
		const inner = new DedaloError('security.outbound_failed', {
			message: 'hop connect failed to 93.184.216.34',
			coordinates: { status: 500 },
		});
		const { error } = classifyFailure('dare_place', 'dare', inner);
		expect((error as DedaloError).cause).toBe(inner);
		expect(disclosure(error as DedaloError)).not.toContain('93.184.216.34');
		expect(geoError('external.not_found', 'dare_place', 'dare').coordinates).toEqual({
			service: 'dare_place',
			origin: 'dare',
		});
	});
});

// ===========================================================================
// 7. Pacing
// ===========================================================================

describe("the provider's terms are kept", () => {
	test('Nominatim: the second start waits out the spacing; a provider that is not asked is not waited for', async () => {
		peer.respond = () => json([]);
		const deps = depsOf();
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(deps.fake.slept, 'the first call of a quiet origin starts at once').toEqual([]);
		// A different question: an identical one inside the hour is answered from memory (below).
		await ask('nominatim_search', { q: 'Sagunto' }, deps);
		expect(deps.fake.slept).toEqual([GEO_ORIGINS.nominatim.minIntervalMs]);
		// The spacing is owed by BOTH Nominatim services: it is the origin's term.
		peer.respond = () => json({ display_name: 'Valencia' });
		await ask('nominatim_reverse', { lat: 39.4, lon: -0.3 }, deps);
		expect(deps.fake.slept).toEqual([
			GEO_ORIGINS.nominatim.minIntervalMs,
			GEO_ORIGINS.nominatim.minIntervalMs,
		]);
	});

	test('origins are independent: another provider owes nothing to Nominatim’s spacing', async () => {
		const deps = depsOf();
		peer.respond = () => json([]);
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		peer.respond = () => json(FEATURE);
		await ask('dare_search_modern', { name: 'Valentia' }, deps);
		peer.respond = () => json({ results: [] });
		await ask('open_elevation_lookup', { locations: [[1, 1]] }, deps);
		expect(deps.fake.slept).toEqual([]);
	});

	test('each provider’s spacing is its table row’s, on every service of it', async () => {
		for (const [id, origin] of [
			['dare_search_modern', 'dare'],
			['catastro_wfs_parcel', 'catastro'],
			['ign_admin_units_featureinfo', 'ign'],
			['open_elevation_lookup', 'open_elevation'],
		] as const) {
			clearGeoServicesForTests();
			const deps = depsOf();
			await callSample(id, deps);
			await callSample(id, deps);
			expect(deps.fake.slept, id).toEqual([GEO_ORIGINS[origin].minIntervalMs]);
		}
	});

	describe('the rate holds ON THE WIRE, not only between the limiter’s starts', () => {
		// The limiter reserves a start BEFORE the guard resolves the name, connects and handshakes,
		// and how long that takes differs from call to call (a cold lookup before one, a warm one
		// before the next). The probe measures where the provider would: the moment each connection
		// is opened, on the clock the limiter keeps. `coldMs` is the first lookup's duration.
		function wireProbe(coldMs: number) {
			const fake = fakeClock();
			const arrivals: number[] = [];
			let lookups = 0;
			const deps: GeoServiceDeps = {
				lookup: async () => {
					lookups++;
					if (lookups === 1) fake.clock.now += coldMs;
					return [{ address: PUBLIC_V4, family: 4 }];
				},
				fetch: (url, init) => {
					arrivals.push(fake.clock.now);
					return socketSeam(url, init);
				},
				limiter: fake.limiter,
			};
			return { deps, fake, arrivals, startedAt: fake.clock.now };
		}

		const PAIRS: [origin: string, first: [string, unknown], second: [string, unknown]][] = [
			[
				'nominatim',
				['nominatim_search', { q: 'Valencia' }],
				['nominatim_search', { q: 'Sagunto' }],
			],
			[
				'dare',
				['dare_search_modern', { name: 'Valentia' }],
				['dare_search_modern', { name: 'Saguntum' }],
			],
			[
				'open_elevation',
				['open_elevation_lookup', { locations: [[1, 1]] }],
				['open_elevation_lookup', { locations: [[2, 2]] }],
			],
		];

		test('one call at a time: a slow lookup before the first and a fast one before the second leave at least the provider’s interval between the two connections', async () => {
			for (const [origin, first, second] of PAIRS) {
				clearGeoServicesForTests();
				const interval = PINNED_ORIGINS[origin]?.minIntervalMs as number;
				// Cold enough that the START gap alone (the interval) would leave less than the interval on the wire.
				const probe = wireProbe(interval - 100);
				peer.respond = (SAMPLES[first[0]] as Sample).answer;
				await Promise.all([
					ask(first[0], first[1], probe.deps),
					ask(second[0], second[1], probe.deps),
				]);
				expect(probe.arrivals.length, origin).toBe(2);
				expect(probe.arrivals[0], `${origin}: the first lookup was the slow one`).toBe(
					probe.startedAt + interval - 100,
				);
				const gap = (probe.arrivals[1] as number) - (probe.arrivals[0] as number);
				expect(gap, `${origin}: ${gap} ms between the connections`).toBeGreaterThanOrEqual(
					interval,
				);
			}
		});

		test('the same holds after a call that FAILED, and after one the job stopped', async () => {
			for (const outcome of ['http_500', 'stopped'] as const) {
				clearGeoServicesForTests();
				const interval = GEO_ORIGINS.nominatim.minIntervalMs;
				const probe = wireProbe(interval - 100);
				const controller = new AbortController();
				const gate = Promise.withResolvers<void>();
				peer.respond = async () => {
					if (outcome === 'stopped') await gate.promise;
					return outcome === 'http_500' ? new Response('oops', { status: 500 }) : json([]);
				};
				const first = failureOf(
					runWithJobSignal(controller.signal, () =>
						ask('nominatim_search', { q: 'Valencia' }, probe.deps),
					),
				);
				if (outcome === 'stopped') {
					await until(() => peer.inFlight === 1, 'the first call is at the provider');
					controller.abort();
				}
				expect((await first).code).toBe(
					outcome === 'http_500' ? 'external.http_status' : 'security.outbound_failed',
				);
				peer.respond = () => json([]);
				await ask('nominatim_search', { q: 'Sagunto' }, probe.deps);
				gate.resolve();
				const gap = (probe.arrivals[1] as number) - (probe.arrivals[0] as number);
				expect(gap, `${outcome}: ${gap} ms between the connections`).toBeGreaterThanOrEqual(
					interval,
				);
			}
		});

		test('an origin that lets several calls fly at once keeps the start-to-start spacing alone: it does not rest after a call', async () => {
			const probe = wireProbe(100);
			peer.respond = (SAMPLES.catastro_wfs_parcel as Sample).answer;
			const [first, second] = distinctParams('catastro_wfs_parcel', 2);
			await ask('catastro_wfs_parcel', first, probe.deps);
			await ask('catastro_wfs_parcel', second, probe.deps);
			// The first lookup took 100 ms of the 250 ms between starts; the second start waits the other 150.
			expect(probe.fake.slept).toEqual([150]);
		});

		describe('one slot is ONE request at the provider: the guard moves on to another address only when nothing was sent', () => {
			// The guard's default sends a GET to the NEXT vetted address after any connect-level failure.
			// A reset that arrives after the request left therefore put a second request on the wire
			// inside the same slot — 0 ms after the first, measured — exactly when the provider is
			// struggling and the rate matters most.
			const TWO_ADDRESSES: AddressLookup = async () => [
				{ address: PUBLIC_V4, family: 4 },
				{ address: '2606:4700:4700::1111', family: 6 },
			];

			/** A socket whose FIRST connection fails with `code`; every later one reaches the peer. */
			function failsOnce(
				code: string,
				attempts: { count: number },
			): NonNullable<PinnedHopDeps['fetch']> {
				return (url, init) => {
					attempts.count++;
					if (attempts.count > 1) return socketSeam(url, init);
					return Promise.reject(Object.assign(new TypeError(`socket failed: ${code}`), { code }));
				};
			}

			test('a reset AFTER the request left is not sent to the second address — for every service — and the slot still rests its interval', async () => {
				for (const id of GEO_SERVICE_IDS) {
					clearGeoServicesForTests();
					peer.received = [];
					const attempts = { count: 0 };
					const fake = fakeClock();
					const deps: GeoServiceDeps = {
						lookup: TWO_ADDRESSES,
						fetch: failsOnce('ECONNRESET', attempts),
						limiter: fake.limiter,
					};
					const sample = SAMPLES[id] as Sample;
					const error = await failureOf(ask(id, sample.params, deps));
					expect(error.code, id).toBe('external.transport');
					expect(attempts.count, `${id}: the second address was not tried`).toBe(1);
					expect(peer.received.length, `${id}: nothing reached the provider`).toBe(0);
					expectNoLeak(error);
					// The failed call still rests the slot (one-at-a-time origins), then the next call goes out.
					peer.respond = sample.answer;
					const before = fake.slept.length;
					await ask(id, sample.params, deps);
					const origin = GEO_SERVICES[id as keyof typeof GEO_SERVICES].origin;
					expect(attempts.count, `${id}: the second call opened one connection`).toBe(2);
					expect(fake.slept.slice(before), `${id}: the rest after the failed call`).toEqual(
						restAfterCallMs(origin) === 0
							? [GEO_ORIGINS[origin].minIntervalMs]
							: [restAfterCallMs(origin)],
					);
				}
			});

			test('a connection REFUSED (nothing sent) still moves on to the next address: a dual-stack provider with an unreachable AAAA is not failed', async () => {
				for (const code of ['ConnectionRefused', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']) {
					clearGeoServicesForTests();
					peer.received = [];
					const attempts = { count: 0 };
					const deps: GeoServiceDeps = {
						...depsOf(),
						lookup: TWO_ADDRESSES,
						fetch: failsOnce(code, attempts),
					};
					peer.respond = (SAMPLES.dare_search_modern as Sample).answer;
					const answer = await ask('dare_search_modern', { name: 'Valentia' }, deps);
					expect(answer.kind, code).toBe('json');
					expect(attempts.count, `${code}: the second address was tried`).toBe(2);
					expect(peer.received.length, `${code}: one request reached the provider`).toBe(1);
				}
			});
		});
	});

	describe('the wait ceiling is driven: the table’s maxWaitMs refuses the caller whose start would fall past it', () => {
		/** Deps whose every call TAKES `callMs` on the limiter's clock (spent where the connection opens). */
		function slowDeps(callMs: number): GeoServiceDeps & { readonly fake: FakeClock } {
			const base = depsOf();
			const fetch: NonNullable<PinnedHopDeps['fetch']> = (url, init) => {
				base.fake.clock.now += callMs;
				return socketSeam(url, init);
			};
			return { ...base, fetch };
		}

		/** Five distinct Nominatim questions asked together, in order: 'done', or the failure. */
		async function fiveTogether(deps: GeoServiceDeps): Promise<unknown[]> {
			peer.respond = () => json([]);
			return Promise.all(
				distinctParams('nominatim_search', 5).map((params) =>
					ask('nominatim_search', params, deps).then(
						() => 'done',
						(error: unknown) => error,
					),
				),
			);
		}

		test('with calls that take time the ceiling bites before the queue is full: the fourth caller starts AT 6 s and is served, one millisecond more per call and it is refused (rate.limited, wait_exceeded)', async () => {
			// Callers start one call + one rest apart: the fourth, 3 x (call + 1100 ms) after it arrived.
			// 900 ms calls put that start at exactly 6000 ms — the table’s wait — and 901 ms past it.
			const nominatim = PINNED_ORIGINS.nominatim as (typeof PINNED_ORIGINS)[string];
			const callMs = nominatim.maxWaitMs / 3 - nominatim.minIntervalMs;
			expect(callMs).toBe(900);
			for (const [duration, served] of [
				[callMs, 4],
				[callMs + 1, 3],
			] as const) {
				clearGeoServicesForTests();
				peer.received = [];
				const outcomes = await fiveTogether(slowDeps(duration));
				expect(
					outcomes.slice(0, served),
					`calls of ${duration} ms: the first ${served} in line are served`,
				).toEqual(Array(served).fill('done'));
				const refused = outcomes.slice(served);
				expect(refused.length).toBe(5 - served);
				for (const error of refused as DedaloError[]) {
					expect(error.code, `calls of ${duration} ms`).toBe('rate.limited');
					expect(error.coordinates?.reason).toBe('wait_exceeded');
					expectNoLeak(error);
				}
				expect(peer.received.length, 'the refused callers never reached the provider').toBe(served);
				expect(geoLimiter('nominatim').inFlight('nominatim'), 'no slot is held').toBe(0);
			}
		});

		test('a queued caller’s ceiling timer is armed with the table’s wait; when it arrives it refuses THAT caller alone and the others go on', async () => {
			const gate = Promise.withResolvers<void>();
			peer.respond = async () => {
				await gate.promise;
				return json([]);
			};
			const deps = depsOf();
			const calls = distinctParams('nominatim_search', 3).map((params) =>
				ask('nominatim_search', params, deps).then(
					() => 'done',
					(error: unknown) => error,
				),
			);
			await until(() => peer.inFlight === 1, 'the first call holds the slot');
			await flush();
			const { ceilings } = deps.fake;
			expect(
				ceilings.map((ceiling) => ceiling.ms),
				'one timer for each caller in the queue, each the origin’s wait',
			).toEqual([GEO_ORIGINS.nominatim.maxWaitMs, GEO_ORIGINS.nominatim.maxWaitMs]);
			(ceilings[0] as (typeof ceilings)[number]).fire();
			const refused = (await calls[1]) as DedaloError;
			expect(refused.code).toBe('rate.limited');
			expect(refused.coordinates?.reason).toBe('wait_exceeded');
			expect(
				geoLimiter('nominatim').waiting('nominatim'),
				'it left the queue; the other did not',
			).toBe(1);
			gate.resolve();
			expect(await Promise.all([calls[0], calls[2]])).toEqual(['done', 'done']);
			expect(peer.received.length, 'the refused caller never reached the provider').toBe(2);
			expect(
				ceilings.every((ceiling) => ceiling.cancelled),
				'every ceiling timer is cancelled however its wait ended',
			).toBe(true);
		});
	});

	test('a back-off holds ONE drain timer per origin however many newcomers it refuses; the origin is forgotten when it ends', async () => {
		// Every newcomer refused during a back-off settles the key again, and each settle armed a
		// fresh timer of up to the back-off: 1 release + 1000 refusals left 1001 live timers.
		const deps = depsOf();
		peer.respond = () => new Response('slow down', { status: 429 });
		expect((await failureOf(ask('nominatim_search', { q: 'Valencia' }, deps))).code).toBe(
			'external.http_status',
		);
		expect(deps.fake.drains.length, 'the release arms the key’s drain').toBe(1);
		for (let newcomer = 0; newcomer < 200; newcomer++) {
			const refusal = await failureOf(ask('nominatim_search', { q: `Sagunto ${newcomer}` }, deps));
			expect(refusal.code).toBe('rate.limited');
		}
		expect(deps.fake.drains.length, '200 refusals added no timer').toBe(1);
		expect(geoOriginsTracked()).toBe(1);
		// When the back-off has passed, the one timer fires and the origin is forgotten.
		deps.fake.clock.now += GEO_ORIGINS.nominatim.backoffMs + 1;
		(deps.fake.drains[0] as FakeClock['drains'][number]).callback();
		expect(geoOriginsTracked(), 'nothing is remembered about an idle provider').toBe(0);
		expect(deps.fake.drains.length).toBe(1);
	});

	test('calls in flight at one origin never exceed the table’s cap', async () => {
		for (const [id, origin] of [
			['nominatim_search', 'nominatim'],
			['catastro_wfs_parcel', 'catastro'],
		] as const) {
			clearGeoServicesForTests();
			peer.received = [];
			peer.peak = 0;
			const cap = GEO_ORIGINS[origin].maxConcurrent;
			const gate = Promise.withResolvers<void>();
			const sample = SAMPLES[id] as Sample;
			peer.respond = async () => {
				await gate.promise;
				return sample.answer();
			};
			const deps = depsOf();
			const calls = distinctParams(id, cap + 2).map((params) =>
				ask(id, params, deps).catch((error: unknown) => error),
			);
			await until(() => peer.inFlight === cap, `${id}: ${cap} in flight`);
			await flush();
			expect(peer.inFlight, `${id}: the rest wait for a slot`).toBe(cap);
			gate.resolve();
			const results = await Promise.all(calls);
			expect(
				results.filter((result) => result instanceof Error),
				`${id}: all answered`,
			).toEqual([]);
			expect(peer.peak, id).toBe(cap);
			expect(peer.received.length).toBe(cap + 2);
		}
	});

	test('the queue is bounded: the caller past it is refused with rate.limited, and nothing is sent for it', async () => {
		const cap = GEO_ORIGINS.nominatim.maxQueue;
		const gate = Promise.withResolvers<void>();
		peer.respond = async () => {
			await gate.promise;
			return json([]);
		};
		const deps = depsOf();
		const calls = distinctParams('nominatim_search', cap + 3).map((params) =>
			ask('nominatim_search', params, deps).then(
				() => 'done',
				(error: unknown) => error,
			),
		);
		await until(() => peer.inFlight === 1, 'one call in flight');
		await flush();
		gate.resolve();
		const outcomes = await Promise.all(calls);
		const refused = outcomes.filter((outcome) => outcome instanceof DedaloError) as DedaloError[];
		expect(refused.length, 'one in flight + a full queue; the others are refused').toBe(2);
		for (const error of refused) {
			expect(error.code).toBe('rate.limited');
			expect(error.coordinates?.reason).toBe('queue_full');
			expectNoLeak(error);
		}
		expect(outcomes.filter((outcome) => outcome === 'done').length).toBe(cap + 1);
		expect(peer.received.length).toBe(cap + 1);
	});

	test('a stopped job leaves the queue at once and hands its place on; no slot is lost', async () => {
		const gate = Promise.withResolvers<void>();
		peer.respond = async () => {
			await gate.promise;
			return json([]);
		};
		const deps = depsOf();
		const first = ask('nominatim_search', { q: 'Valencia' }, deps);
		await until(() => peer.inFlight === 1, 'the first call holds the slot');
		const controller = new AbortController();
		const waiting = runWithJobSignal(controller.signal, () =>
			ask('nominatim_search', { q: 'Sagunto' }, deps),
		);
		const third = ask('nominatim_search', { q: 'Gandia' }, deps);
		await flush();
		expect(geoLimiter('nominatim').waiting('nominatim'), 'two wait behind the first').toBe(2);
		controller.abort();
		const stopped = await failureOf(waiting);
		expect(stopped.code).toBe('security.outbound_failed');
		expect(stopped.coordinates?.reason).toBe('aborted');
		expect(geoLimiter('nominatim').waiting('nominatim'), 'it left the queue').toBe(1);
		gate.resolve();
		await Promise.all([first, third]);
		expect(peer.received.length, 'the stopped call never reached the provider').toBe(2);
		expect(geoLimiter('nominatim').inFlight('nominatim'), 'no slot is held').toBe(0);
	});

	test('a job already stopped does not start, and a stop reaches a call in flight', async () => {
		const controller = new AbortController();
		controller.abort();
		const before = await failureOf(
			runWithJobSignal(controller.signal, () =>
				ask('dare_search_modern', { name: 'Valentia' }, depsOf()),
			),
		);
		expect(before.coordinates?.reason).toBe('aborted');
		expect(peer.received.length).toBe(0);

		const live = new AbortController();
		const gate = Promise.withResolvers<void>();
		peer.respond = async () => {
			await gate.promise;
			return json(FEATURE);
		};
		const running = failureOf(
			runWithJobSignal(live.signal, () =>
				ask('dare_search_modern', { name: 'Valentia' }, depsOf()),
			),
		);
		await until(() => peer.inFlight === 1, 'in flight');
		live.abort();
		const stopped = await running;
		expect(stopped.coordinates?.reason).toBe('aborted');
		gate.resolve();
		await flush();
		expect(geoLimiter('dare').inFlight('dare'), 'the slot came back').toBe(0);
	});

	test('the state is closed and self-draining: one key per provider, forgotten once idle', async () => {
		const deps = depsOf();
		expect(geoOriginsTracked()).toBe(0);
		for (const id of GEO_SERVICE_IDS) await callSample(id, deps);
		expect(geoOriginsTracked(), 'at most one key per provider').toBeLessThanOrEqual(
			GEO_ORIGIN_IDS.length,
		);
		// A key still owing spacing re-arms its drain; once the spacing has passed it is dropped.
		deps.fake.clock.now += 60_000;
		for (let round = 0; round < 5 && deps.fake.drains.length > 0; round++) {
			for (const drain of deps.fake.drains.splice(0)) drain.callback();
		}
		expect(geoOriginsTracked(), 'nothing is remembered about an idle provider').toBe(0);
	});
});

// ===========================================================================
// 7b. Identical calls in the air are ONE call
// ===========================================================================

describe('identical calls in the air are ONE call: a re-send joins it, and each caller reads the answer for itself', () => {
	/** A provider that answers once `release()` is called, counting the requests it saw. */
	function heldProvider(answer: () => Response = () => json([{ place_id: 1 }])) {
		const gate = Promise.withResolvers<void>();
		peer.respond = async () => {
			await gate.promise;
			return answer();
		};
		return { release: () => gate.resolve() };
	}

	test('the browser transport’s re-send (the first attempt is abandoned, never told) takes no second slot and no second provider request', async () => {
		const provider = heldProvider();
		const deps = depsOf();
		const abandoned = ask('nominatim_search', { q: 'Valencia' }, deps);
		await until(() => peer.inFlight === 1, 'the first attempt is at the provider');
		const resend = ask('nominatim_search', { q: 'Valencia' }, deps);
		await flush();
		expect(geoFlightsInProgress(), 'one call in the air').toBe(1);
		expect(geoLimiter('nominatim').waiting('nominatim'), 'the re-send waits for nothing').toBe(0);
		expect(geoLimiter('nominatim').inFlight('nominatim'), 'one slot').toBe(1);
		provider.release();
		const [first, second] = await Promise.all([abandoned, resend]);
		expect(peer.received.length, 'the provider was asked once').toBe(1);
		expect(first).toEqual(second);
		expect(first, 'two callers never hold one parsed object').not.toBe(second);
		(first as { data: unknown[] }).data.push('mutated by the first caller');
		expect((second as { data: unknown[] }).data).toHaveLength(1);
		expect(geoFlightsInProgress(), 'nothing is kept after the answer').toBe(0);
		expect(geoLimiter('nominatim').inFlight('nominatim')).toBe(0);
	});

	test('the retry cannot be refused for a full queue by its own ancestors: re-sends add no place to the queue', async () => {
		const provider = heldProvider();
		const deps = depsOf();
		const first = ask('nominatim_search', { q: 'Valencia' }, deps);
		await until(() => peer.inFlight === 1, 'in flight');
		// Far more re-sends than the queue holds.
		const resends = Array.from({ length: GEO_ORIGINS.nominatim.maxQueue * 3 }, () =>
			ask('nominatim_search', { q: 'Valencia' }, deps),
		);
		await flush();
		expect(geoLimiter('nominatim').waiting('nominatim')).toBe(0);
		provider.release();
		const results = await Promise.all([first, ...resends].map((call) => call.then(() => 'ok')));
		expect(results.every((result) => result === 'ok')).toBe(true);
		expect(peer.received.length).toBe(1);
	});

	test('a different question is its own call: other parameters, or the same name asked of another service', async () => {
		const provider = heldProvider(() => json(FEATURE));
		const deps = depsOf();
		const calls = [
			ask('dare_search_modern', { name: 'Valentia' }, deps),
			ask('dare_search_modern', { name: 'Saguntum' }, deps),
			ask('dare_search_ancient', { name: 'Valentia' }, deps),
		];
		await flush();
		expect(geoFlightsInProgress()).toBe(3);
		provider.release();
		await Promise.all(calls);
		expect(peer.received.map((seen) => seen.search).sort()).toEqual([
			'?ass=Valentia',
			'?mss=Saguntum',
			'?mss=Valentia',
		]);
	});

	test('the flights remember nothing: the same question AFTER the answer asks a provider that did not ask to be spared again', async () => {
		// (A provider that asks for its results to be kept — Nominatim — is spared by the answer
		// memory, not by the flights: see the next section.)
		peer.respond = () => json(FEATURE);
		const deps = depsOf();
		await ask('dare_search_modern', { name: 'Valentia' }, deps);
		expect(geoFlightsInProgress()).toBe(0);
		await ask('dare_search_modern', { name: 'Valentia' }, deps);
		expect(peer.received.length).toBe(2);
	});

	test('a failure is shared like an answer: one provider error for everyone who asked, one request', async () => {
		const provider = heldProvider(() => new Response('oops', { status: 500 }));
		const deps = depsOf();
		const calls = [1, 2, 3].map(() => failureOf(ask('dare_place', { id: '16823' }, deps)));
		await flush();
		provider.release();
		for (const error of await Promise.all(calls)) {
			expect(error.code).toBe('external.http_status');
			expectNoLeak(error);
		}
		expect(peer.received.length).toBe(1);
		expect(geoFlightsInProgress()).toBe(0);
	});

	test('each caller gets the typed verdict on the body for itself: nothing there is external.not_found for all', async () => {
		const provider = heldProvider(() => json({ type: 'FeatureCollection', features: [] }));
		const deps = depsOf();
		const calls = [1, 2].map(() => failureOf(ask('dare_place', { id: '16823' }, deps)));
		await flush();
		provider.release();
		for (const error of await Promise.all(calls)) expect(error.code).toBe('external.not_found');
		expect(peer.received.length).toBe(1);
	});

	test('a stopped caller leaves ITS wait and the call goes on for the caller that remains', async () => {
		const provider = heldProvider();
		const deps = depsOf();
		const jobStop = new AbortController();
		const job = failureOf(
			runWithJobSignal(jobStop.signal, () => ask('nominatim_search', { q: 'Valencia' }, deps)),
		);
		await until(() => peer.inFlight === 1, 'the job’s call is at the provider');
		// A plain request (no signal: the tool action's case) joins the same call.
		const request = ask('nominatim_search', { q: 'Valencia' }, deps);
		await flush();
		jobStop.abort();
		const stopped = await job;
		expect(stopped.code).toBe('security.outbound_failed');
		expect(stopped.coordinates?.reason).toBe('aborted');
		expect(geoFlightsInProgress(), 'the call survives its first caller').toBe(1);
		expect(geoLimiter('nominatim').inFlight('nominatim'), 'the slot is still held').toBe(1);
		provider.release();
		const answer = await request;
		expect(answer.kind).toBe('json');
		expect(peer.received.length, 'the stopped job did not cost a second request').toBe(1);
		expect(geoFlightsInProgress()).toBe(0);
		expect(geoLimiter('nominatim').inFlight('nominatim')).toBe(0);
	});

	test('the call is cancelled when the LAST caller has gone: the socket is released and the slot handed on', async () => {
		const provider = heldProvider();
		const deps = depsOf();
		const stops = [new AbortController(), new AbortController()];
		const callers = stops.map((stop) =>
			failureOf(
				runWithJobSignal(stop.signal, () => ask('nominatim_search', { q: 'Valencia' }, deps)),
			),
		);
		await until(() => peer.inFlight === 1, 'at the provider');
		(stops[0] as AbortController).abort();
		expect((await (callers[0] as Promise<DedaloError>)).coordinates?.reason).toBe('aborted');
		expect(geoFlightsInProgress(), 'one caller remains: the call goes on').toBe(1);
		expect(geoLimiter('nominatim').inFlight('nominatim')).toBe(1);
		(stops[1] as AbortController).abort();
		expect((await (callers[1] as Promise<DedaloError>)).coordinates?.reason).toBe('aborted');
		expect(geoFlightsInProgress(), 'the last caller took the call with it').toBe(0);
		await until(
			() => geoLimiter('nominatim').inFlight('nominatim') === 0,
			'the slot came back once the fetch was cancelled',
		);
		provider.release();
		// A later question is a new call, not a join of the cancelled one.
		peer.respond = () => json([]);
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(peer.received.length).toBe(2);
	});

	test('a call still waiting in the limiter’s queue leaves it when its last caller goes: nothing is sent for it', async () => {
		const provider = heldProvider();
		const deps = depsOf();
		const holder = ask('nominatim_search', { q: 'Valencia' }, deps);
		await until(() => peer.inFlight === 1, 'the slot is held');
		const stop = new AbortController();
		const queued = failureOf(
			runWithJobSignal(stop.signal, () => ask('nominatim_search', { q: 'Sagunto' }, deps)),
		);
		await flush();
		expect(geoLimiter('nominatim').waiting('nominatim')).toBe(1);
		stop.abort();
		expect((await queued).coordinates?.reason).toBe('aborted');
		expect(geoLimiter('nominatim').waiting('nominatim'), 'it left the queue').toBe(0);
		provider.release();
		await holder;
		expect(peer.received.length, 'the abandoned question never reached the provider').toBe(1);
	});

	test('a caller already stopped never puts a call in the air', async () => {
		const stop = new AbortController();
		stop.abort();
		const error = await failureOf(
			runWithJobSignal(stop.signal, () => ask('nominatim_search', { q: 'Valencia' }, depsOf())),
		);
		expect(error.coordinates?.reason).toBe('aborted');
		expect(geoFlightsInProgress()).toBe(0);
		expect(peer.received.length).toBe(0);
	});

	test('a call with no job signal in scope — a tool action in a plain request — is not refused: it runs to its bounds and its re-send shares it', async () => {
		// The interactive profile demands a signal because its route is core and wraps the request's.
		// A tool action has none today (api/dispatch.ts gate 4), so demanding one here would refuse
		// every foreground action; what protects the provider is the sharing above, and the bounds.
		expect(currentJobSignal()).toBeUndefined();
		peer.respond = () => json([]);
		await ask('nominatim_search', { q: 'Valencia' }, depsOf());
		expect(peer.received.length).toBe(1);
	});
});

// ===========================================================================
// 7c. The answer memory
// ===========================================================================

describe('the answer memory: a provider that asks for its results to be cached is not asked the same question twice', () => {
	const HOUR = 3_600_000;

	test('only Nominatim keeps answers, as its policy asks: every other provider is asked every time', async () => {
		const kept = GEO_SERVICE_IDS.filter(
			(id) => (GEO_SERVICES[id] as GeoService).keepAnswerMs !== undefined,
		);
		expect([...kept].sort()).toEqual(['nominatim_reverse', 'nominatim_search']);
		for (const id of GEO_SERVICE_IDS) {
			clearGeoServicesForTests();
			peer.received = [];
			const deps = depsOf();
			await callSample(id, deps);
			await callSample(id, deps);
			expect(peer.received.length, id).toBe((kept as string[]).includes(id) ? 1 : 2);
		}
	});

	test('the same question inside the hour is answered from memory — no flight, no slot, no wait, no socket, no request — and each caller still gets an answer of its own', async () => {
		peer.respond = () => json([{ place_id: 1, display_name: 'Valencia' }]);
		const deps = depsOf();
		const first = await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(peer.received.length).toBe(1);
		deps.fake.clock.now += 5;
		const pinnedBefore = peer.pinned.length;
		const again = await ask('nominatim_search', { q: 'Valencia' }, deps);
		const third = await ask('nominatim_search', { q: ' Valencia ' }, deps);
		expect(peer.received.length, 'the provider was asked once').toBe(1);
		expect(peer.pinned.length, 'no socket was opened').toBe(pinnedBefore);
		expect(deps.fake.slept, 'no limiter wait: the origin was not touched').toEqual([]);
		expect(again).toEqual(first);
		expect(third, 'the canonical question: white space around it is not another question').toEqual(
			first,
		);
		expect(again, 'two callers never hold one parsed object').not.toBe(first);
		(first as { data: unknown[] }).data.push('mutated by the first caller');
		expect((again as { data: unknown[] }).data).toHaveLength(1);
		expect(again.attribution, 'the attribution rides every answer, kept or not').toBe(
			GEO_ORIGINS.nominatim.attribution,
		);
		expect(geoFlightsInProgress()).toBe(0);
	});

	test('a different question, or the other Nominatim service, is asked of the provider', async () => {
		peer.respond = () => json([]);
		const deps = depsOf();
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		await ask('nominatim_search', { q: 'Valencia', limit: 2 }, deps);
		await ask('nominatim_search', { q: 'Sagunto' }, deps);
		peer.respond = () => json({ display_name: 'Valencia' });
		await ask('nominatim_reverse', { lat: 39.47, lon: -0.37 }, deps);
		await ask('nominatim_reverse', { lat: 39.47, lon: -0.37 }, deps);
		expect(peer.received.length, 'three searches and one reverse; the repeat was kept').toBe(4);
	});

	test('an answer lives exactly as long as the table says: served one millisecond before the hour is out, asked again at it', async () => {
		peer.respond = () => json([]);
		const deps = depsOf();
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		deps.fake.clock.now += HOUR - 1;
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(peer.received.length, 'one millisecond before: still kept').toBe(1);
		deps.fake.clock.now += 1;
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(peer.received.length, 'at the hour: asked again').toBe(2);
		deps.fake.clock.now += HOUR - 1;
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(peer.received.length, 'and the new answer is kept for its own hour').toBe(2);
	});

	test('“nothing there” is the provider’s word too and is kept; a failure, an answer off the contract and an answer too big to keep are not', async () => {
		const deps = depsOf();
		// Nominatim reverse answers 200 with an error key where there is nothing: kept like an answer.
		peer.respond = () => json({ error: 'Unable to geocode' });
		for (let round = 0; round < 3; round++) {
			expect(
				(await failureOf(ask('nominatim_reverse', { lat: 0, lon: 0 }, deps))).code,
				'nothing there',
			).toBe('external.not_found');
		}
		expect(peer.received.length, 'asked once').toBe(1);

		// A failure is never kept: the next attempt asks again.
		peer.received = [];
		peer.respond = () => new Response('oops', { status: 500 });
		expect((await failureOf(ask('nominatim_search', { q: 'Valencia' }, deps))).code).toBe(
			'external.http_status',
		);
		peer.respond = () => json([]);
		await ask('nominatim_search', { q: 'Valencia' }, deps);
		expect(peer.received.length, 'the failure was not kept').toBe(2);

		// An answer off the contract (an object for a list) is not kept.
		peer.received = [];
		peer.respond = () => json({ not: 'a list' });
		for (let round = 0; round < 2; round++) {
			expect((await failureOf(ask('nominatim_search', { q: 'Sagunto' }, deps))).code).toBe(
				'external.protocol',
			);
		}
		expect(peer.received.length, 'an off-contract body is asked for again').toBe(2);

		// An answer whose entry costs more than the limit is served, not kept.
		peer.received = [];
		const big = JSON.stringify([{ pad: 'x'.repeat(ANSWER_MEMORY_LIMITS.entryBytes) }]);
		peer.respond = () => new Response(big, { headers: { 'content-type': 'application/json' } });
		for (let round = 0; round < 2; round++) {
			expect((await ask('nominatim_search', { q: 'Gandia' }, deps)).kind).toBe('json');
		}
		expect(peer.received.length, 'too big to keep').toBe(2);
	});

	test('the memory is bounded BY BYTES and the oldest go first: it never holds more than its ceiling, the newest answer is served, the oldest is asked again', async () => {
		const deps = depsOf();
		const padded = JSON.stringify([{ pad: 'x'.repeat(30_000) }]);
		peer.respond = () => new Response(padded, { headers: { 'content-type': 'application/json' } });
		const entries = Math.ceil((ANSWER_MEMORY_LIMITS.totalBytes * 1.5) / 30_000);
		for (let index = 0; index < entries; index++) {
			await ask('nominatim_search', { q: `Valencia ${index}` }, deps);
		}
		expect(peer.received.length).toBe(entries);
		expect(answerBytesKept(), 'the ceiling holds').toBeLessThanOrEqual(
			ANSWER_MEMORY_LIMITS.totalBytes,
		);
		expect(answersKept(), 'older answers were evicted').toBeLessThan(entries);
		peer.received = [];
		await ask('nominatim_search', { q: `Valencia ${entries - 1}` }, deps);
		expect(peer.received.length, 'the newest is still kept').toBe(0);
		await ask('nominatim_search', { q: 'Valencia 0' }, deps);
		expect(peer.received.length, 'the oldest was evicted and is asked again').toBe(1);
	});

	describe('the store', () => {
		const key = (index: number): string =>
			`nominatim_search https://example.test/search?q=${index}`;

		/** Admit fresh entries of `body` (keys from 1000 up) until one admission evicts an older entry. */
		function fillUntilFirstEviction(body: string): void {
			for (let index = 1_000; index < 1_500; index++) {
				const before = answersKept();
				rememberAnswer(key(index), body, HOUR, 1_000);
				if (answersKept() <= before) return;
			}
			throw new Error('the memory never evicted');
		}

		test('a flood of tiny answers is bounded by bytes too: each entry counts its key and a fixed overhead, not just its body', () => {
			// A long question (a query typed at length is percent-encoded into a long address) with an
			// empty answer: the body is two bytes, the entry is not.
			const longKey = (index: number): string => `${key(index)}&${'p'.repeat(1_500)}`;
			const floods = 1_200;
			for (let index = 0; index < floods; index++)
				rememberAnswer(longKey(index), '[]', HOUR, 1_000);
			expect(answerBytesKept()).toBeLessThanOrEqual(ANSWER_MEMORY_LIMITS.totalBytes);
			const cheapest = 2 + longKey(0).length * 2 + ANSWER_MEMORY_LIMITS.overheadBytes;
			expect(answersKept(), 'by count too, through the bytes').toBeLessThanOrEqual(
				Math.ceil(ANSWER_MEMORY_LIMITS.totalBytes / cheapest),
			);
			expect(answersKept(), 'older entries were evicted').toBeLessThan(floods);
			expect(recallAnswer(longKey(floods - 1), 1_001), 'the newest').toBe('[]');
			expect(recallAnswer(longKey(0), 1_001), 'the oldest').toBeNull();
		});

		test('an entry is stale at its own moment, a stale one is dropped when asked for, never served, and costs nothing extra', () => {
			rememberAnswer(key(1), 'one', 100, 1_000);
			expect(recallAnswer(key(1), 1_099)).toBe('one');
			expect(recallAnswer(key(1), 1_100)).toBeNull();
			expect(answersKept(), 'dropped when recalled').toBe(0);
			rememberAnswer(key(2), 'two', 100, 1_000);
			rememberAnswer(key(3), 'three', 100, 5_000);
			// No sweep on admission (constant-time): the stale one waits for eviction, but is never served.
			expect(recallAnswer(key(2), 5_000), 'a stale entry is never served').toBeNull();
			expect(recallAnswer(key(3), 5_001)).toBe('three');
			expect(answersKept()).toBe(1);
		});

		test('an entry that is too big is not kept, and the older answer for its key is forgotten rather than served', () => {
			rememberAnswer(key(1), 'small', HOUR, 1_000);
			rememberAnswer(key(1), 'x'.repeat(ANSWER_MEMORY_LIMITS.entryBytes), HOUR, 1_000);
			expect(recallAnswer(key(1), 1_001)).toBeNull();
			expect(answersKept()).toBe(0);
		});

		test('a re-admitted key moves to the newest end: it is the last to be evicted', () => {
			const body = 'x'.repeat(30_000);
			rememberAnswer(key(1), body, HOUR, 1_000);
			rememberAnswer(key(2), body, HOUR, 1_000);
			rememberAnswer(key(1), body, HOUR, 1_000);
			// Keep adding until the FIRST eviction (the count stops growing) — probing key 2 on the way would
			// itself be a use of it: the re-admitted key 1 is next in line, key 2 gone.
			fillUntilFirstEviction(body);
			expect(recallAnswer(key(2), 1_001), 'never re-admitted: evicted first').toBeNull();
			expect(recallAnswer(key(1), 1_001), 'moved to the newest end: still kept').toBe(body);
			expect(answerBytesKept()).toBeLessThanOrEqual(ANSWER_MEMORY_LIMITS.totalBytes);
		});

		test('a recall HIT moves the entry to the newest end — eviction is least recently USED — with its cost and its lifetime unchanged', () => {
			const body = 'x'.repeat(30_000);
			rememberAnswer(key(1), body, 100, 1_000);
			rememberAnswer(key(2), body, HOUR, 1_000);
			const bytes = answerBytesKept();
			// key 1 is the oldest admitted, but the one just asked for
			expect(recallAnswer(key(1), 1_050)).toBe(body);
			expect(answerBytesKept(), 'a hit costs nothing').toBe(bytes);
			expect(answersKept()).toBe(2);
			fillUntilFirstEviction(body);
			expect(recallAnswer(key(2), 1_051), 'never used again: evicted first').toBeNull();
			expect(recallAnswer(key(1), 1_051), 'the hot entry survived the eviction').toBe(body);
			// the hit renewed its place, not its life: stale at its own moment, as admitted
			expect(recallAnswer(key(1), 1_100), 'stale at remember + keepMs').toBeNull();
			expect(answerBytesKept()).toBeLessThanOrEqual(ANSWER_MEMORY_LIMITS.totalBytes);
		});

		test('the limits are the ones the module states', () => {
			expect(ANSWER_MEMORY_LIMITS).toEqual({
				totalBytes: 2_097_152,
				entryBytes: 65_536,
				overheadBytes: 64,
			});
		});
	});
});

// ===========================================================================
// 8. Identity, surface, configuration
// ===========================================================================

describe('who the geo services say they are', () => {
	const SITE_ONLY = `dedalo/${DEDALO_ENGINE_VERSION} (+https://dedalo.dev)`;
	const withOrigin = (origin: string): string =>
		`dedalo/${DEDALO_ENGINE_VERSION} (+https://dedalo.dev; ${origin})`;

	function configure(host: string, protocol = 'https://'): string {
		process.env.DEDALO_PROTOCOL = protocol;
		process.env.DEDALO_HOST = host;
		return geoUserAgent();
	}

	test('the product token and the release identity, the project site, and nothing else on a bare box', () => {
		expect(geoUserAgent()).toBe(SITE_ONLY);
	});

	test('a public origin joins the header; canonical, so the case and a default port do not matter', () => {
		expect(configure('museum.example.org')).toBe(withOrigin('https://museum.example.org'));
		expect(configure('MUSEUM.Example.ORG')).toBe(withOrigin('https://museum.example.org'));
		expect(configure('museum.example.org:443')).toBe(withOrigin('https://museum.example.org'));
		expect(configure('museum.example.org:8443')).toBe(
			withOrigin('https://museum.example.org:8443'),
		);
		expect(configure('museum.example.org', 'http://')).toBe(
			withOrigin('http://museum.example.org'),
		);
		// A public IP literal is as reachable as a name, IPv6 bracketed; an IDN is its punycode.
		expect(configure('93.184.216.34')).toBe(withOrigin('https://93.184.216.34'));
		expect(configure('[2001:4860:4860::8888]')).toBe(withOrigin('https://[2001:4860:4860::8888]'));
		expect(configure('museú.example.org')).toBe(withOrigin('https://xn--muse-tra.example.org'));
		// A path or credentials typed into the host are not part of an origin and are never sent.
		expect(configure('museum.example.org/dedalo')).toBe(withOrigin('https://museum.example.org'));
		expect(configure('curator:secret@museum.example.org')).toBe(
			withOrigin('https://museum.example.org'),
		);
	});

	test('the mail From address is NEVER sent: it configures the mailer, it is not a contact anyone agreed to publish', () => {
		process.env.DEDALO_SMTP_FROM = 'curator.jane@museum.example';
		expect(geoUserAgent()).toBe(SITE_ONLY);
		expect(configure('museum.example.org')).toBe(withOrigin('https://museum.example.org'));
		expect(geoUserAgent()).not.toContain('curator');
		expect(geoUserAgent()).not.toContain('@');
	});

	test('an origin no provider could reach is left out — loopback, private and reserved addresses, single-label names, names no outside resolver answers', () => {
		const unreachable = [
			// unset, loopback names and addresses
			'',
			'localhost',
			'localhost:3500',
			'dedalo.localhost',
			'127.0.0.1',
			'127.1.2.3',
			'[::1]',
			// private and reserved IP literals: RFC 1918, shared address space, link-local, ULA, mapped, documentation
			'192.168.1.20',
			'10.0.0.5:8080',
			'172.16.0.9',
			'100.64.0.1',
			'169.254.169.254',
			'198.18.0.1',
			'203.0.113.5',
			'[fd00::1]',
			'[fe80::1]',
			'[::ffff:10.0.0.1]',
			'[2001:db8::1]',
			// a single label never resolves outside its own network
			'intranet-srv01',
			'dedalo',
			'museo-srv:8080',
			// suffixes that are special-use or conventionally private
			'dedalo.museo.local',
			'museo.internal',
			'museo.intranet',
			'museo.corp',
			'museo.home',
			'museo.private',
			'museo.lan',
			'museo.localdomain',
			'museo.home.arpa',
			'museo.test',
			'museo.example',
			'museo.invalid',
			'abcdefghijklmnop.onion',
			// the fully-qualified spelling and the upper case are the same name
			'museo.local.',
			'MUSEO.LOCAL',
			'museo.LAN',
			// the suffix ITSELF is under it
			'local',
		];
		for (const host of unreachable) {
			expect(configure(host), `DEDALO_HOST=${JSON.stringify(host)}`).toBe(SITE_ONLY);
		}
	});

	test('the name of a suffix inside a public name does not hide it: the match is on whole labels at the end', () => {
		for (const host of [
			'localhost.museum.org',
			'lan.museum.org',
			'local-museum.org',
			'internal.example.org',
			'museum.homepage.org',
			'mytest.org',
			'museum.org.uk',
		]) {
			expect(configure(host), host).toBe(withOrigin(`https://${host.toLowerCase()}`));
		}
	});

	test('a value is checked, not repaired: whatever cannot be sent whole is left out, never stripped to something else', () => {
		for (const host of [
			'museu.example.org) (injected; x\r\nX-Evil: 1',
			'museu.example.org) (injected',
			'a);b.org',
			"it's.example.org",
			'museum example.org',
			`${'a'.repeat(95)}.example.org`,
		]) {
			const header = configure(host);
			expect(header, JSON.stringify(host)).toBe(SITE_ONLY);
		}
		// Only http and https origins are an origin.
		expect(configure('museum.example.org', 'ftp://')).toBe(SITE_ONLY);
		expect(configure('museum.example.org', '')).toBe(SITE_ONLY);
		expect(configure('museum.example.org', 'javascript:')).toBe(SITE_ONLY);
	});

	test('whatever is configured, the header is ASCII, one line and one comment', () => {
		for (const host of ['museum.example.org', '93.184.216.34', 'museú.example.org', 'a(b).org']) {
			const header = configure(host);
			expect(header, host).toMatch(/^[\x20-\x7e]+$/);
			expect(header, 'one comment').toMatch(/^dedalo\/\S+ \([^()]*\)$/);
		}
	});
});

describe('the module’s surface and configuration', () => {
	const SRC = join(import.meta.dir, '..', '..', 'src');
	const MODULE_DIR = join(SRC, 'core', 'geo_services');

	/** What the module may import from OUTSIDE itself, per file — a reviewed, closed list. */
	const OUTSIDE_IMPORTS: Record<string, readonly string[]> = {
		'answer_memory.ts': [],
		'answers.ts': [],
		'call.ts': ['core/media/job_scope.ts', 'core/security/ssrf_guard.ts'],
		'errors.ts': ['core/errors/index.ts'],
		'failures.ts': ['core/errors/index.ts', 'core/security/ssrf_guard.ts'],
		'flights.ts': ['core/harvest/abort.ts', 'core/media/job_scope.ts'],
		'frozen.ts': [],
		'geo_seams.ts': [
			'core/harvest/origin_limiter.ts',
			'core/security/ssrf_guard.ts',
			'node:async_hooks',
		],
		'limiters.ts': ['core/harvest/origin_limiter.ts'],
		'params.ts': ['core/errors/index.ts'],
		'request.ts': ['core/errors/index.ts'],
		'table.ts': [],
		// The ONE file that reads any configuration, and only through the public origin
		// (`public_reach.ts` reads it, and owns the rule of which origin may be sent: shared
		// with the tile proxy's Referer, one rule for both senders).
		'user_agent.ts': [
			'core/harvest/identity.ts',
			'core/resolve/public_reach.ts',
			'core/update/build_stamp.ts',
		],
	};

	interface Reference {
		/** The module named, or null when a dynamic load names it by an expression. */
		readonly specifier: string | null;
		readonly how: string;
	}

	/** Every module a file loads, however it spells the load; a type-only import counts too. */
	function referencesOf(name: string): Reference[] {
		const source = readFileSync(join(MODULE_DIR, name), 'utf8');
		const program = parse(source, { sourceType: 'module', plugins: ['typescript'] })
			.program as unknown as AstNode;
		const found: Reference[] = [];
		walkAst(program.body, [], (node) => {
			if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') {
				found.push({ specifier: literalSpecifier(node.source), how: node.type });
			} else if (node.type === 'ExportNamedDeclaration' && node.source) {
				found.push({ specifier: literalSpecifier(node.source), how: node.type });
			} else if (node.type === 'TSImportEqualsDeclaration') {
				const expression = (node.moduleReference as AstNode).expression;
				found.push({ specifier: literalSpecifier(expression), how: node.type });
			} else if (node.type === 'ImportExpression') {
				found.push({ specifier: literalSpecifier(node.source), how: 'import()' });
			} else if (node.type === 'CallExpression') {
				const callee = node.callee as AstNode;
				const loads =
					callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require');
				if (loads) {
					const argument = (node.arguments as unknown[])[0];
					found.push({ specifier: literalSpecifier(argument), how: 'require()/import()' });
				}
			}
		});
		return found;
	}

	/** `core/harvest/abort.ts` for `../harvest/abort.ts` from `core/geo_services/x.ts`; `./x.ts` stays inside. */
	function resolved(specifier: string): string {
		if (!specifier.startsWith('.')) return specifier;
		const target = join(MODULE_DIR, specifier);
		const relative = target.slice(SRC.length + 1);
		return relative.startsWith('core/geo_services/') ? `./${relative.slice(18)}` : relative;
	}

	test('the entry point is the only runtime export of call.ts: nothing a URL could be handed to', () => {
		expect(Object.keys(callModule)).toEqual(['callGeoService']);
	});

	test('the entry point takes the id and the parameters and NOTHING else: no seam, no transport, no header', () => {
		const source = readFileSync(join(MODULE_DIR, 'call.ts'), 'utf8');
		const program = parse(source, { sourceType: 'module', plugins: ['typescript'] })
			.program as unknown as AstNode;
		const declared: string[][] = [];
		walkAst(program.body, [], (node) => {
			if (node.type === 'FunctionDeclaration' && nameOf(node.id) === 'callGeoService') {
				declared.push(
					(node.params as AstNode[]).map((param) => {
						const target = param.type === 'AssignmentPattern' ? (param.left as AstNode) : param;
						return `${param.type === 'RestElement' ? '...' : ''}${nameOf(target)}`;
					}),
				);
			}
		});
		expect(declared, 'one declaration, with exactly these parameters').toEqual([['id', 'params']]);
		expect(callGeoService.length, 'one required parameter and one with a default').toBe(1);
	});

	test('no key of the configuration moves an endpoint: the module imports nothing of src/config, reads no environment, and the public origin is read by the identity header alone', () => {
		const files = readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'));
		expect(files.sort(), 'every file of the module has a reviewed row of imports').toEqual(
			Object.keys(OUTSIDE_IMPORTS).sort(),
		);
		for (const name of files) {
			const outside: string[] = [];
			for (const reference of referencesOf(name)) {
				expect(
					reference.specifier,
					`${name}: a ${reference.how} must name its module`,
				).not.toBeNull();
				const target = resolved(reference.specifier as string);
				expect(
					target.startsWith('config/') || target.includes('/config/'),
					`${name}: imports the configuration (${target})`,
				).toBe(false);
				if (!target.startsWith('./')) outside.push(target);
				else {
					const sibling = target.slice(2);
					expect(files, `${name}: ${target} is a file of the module`).toContain(sibling);
				}
			}
			expect(
				[...new Set(outside)].sort(),
				`${name}: what it may import from outside the module`,
			).toEqual([...(OUTSIDE_IMPORTS[name] ?? [])].sort());
		}
		// …and no file reads the environment by hand either.
		for (const name of files) {
			const source = readFileSync(join(MODULE_DIR, name), 'utf8');
			const program = parse(source, { sourceType: 'module', plugins: ['typescript'] })
				.program as unknown as AstNode;
			walkAst(program.body, [], (node) => {
				if (node.type !== 'MemberExpression') return;
				const object = node.object as AstNode;
				const reads = (owner: string): boolean =>
					object.type === 'Identifier' &&
					object.name === owner &&
					(node.property as AstNode).type === 'Identifier' &&
					(node.property as AstNode).name === 'env';
				expect(reads('process') || reads('Bun'), `${name}: reads the environment`).toBe(false);
			});
		}
	});

	test('the only configuration the module can see is the installation’s public origin, and it moves the User-Agent and nothing else', async () => {
		const before = new Map<string, string>();
		for (const id of GEO_SERVICE_IDS) {
			before.set(id, buildGeoUrl(id, GEO_SERVICES[id], (SAMPLES[id] as Sample).params));
		}
		process.env.DEDALO_PROTOCOL = 'http://';
		process.env.DEDALO_HOST = 'override.attacker.example.net:9';
		process.env.DEDALO_SMTP_FROM = 'override@attacker.example.net';
		for (const id of GEO_SERVICE_IDS) {
			expect(buildGeoUrl(id, GEO_SERVICES[id], (SAMPLES[id] as Sample).params), id).toBe(
				before.get(id) as string,
			);
		}
		await callSample('nominatim_search');
		const seen = peer.received[0] as Received;
		const pinned = peer.pinned[0] as Pinned;
		expect(pinned.hostHeader).toBe('nominatim.openstreetmap.org');
		expect(pinned.protocol).toBe('https:');
		expect(pinned.address).toBe(PUBLIC_V4);
		expect(seen.pathname).toBe('/search');
		expect(seen.headers.get('user-agent')).toBe(geoUserAgent());
	});

	test('the test seams are a scope, not a switch: none outside it, and two scopes at once never see each other’s', async () => {
		const first: AddressLookup = async () => [{ address: '203.0.113.1', family: 4 }];
		const second: AddressLookup = async () => [{ address: '203.0.113.2', family: 4 }];
		expect(geoServiceSeams(), 'outside a scope: the real resolver, socket and clock').toEqual({});
		const readLater = (deps: GeoServiceDeps) =>
			runWithGeoServiceSeams(deps, async () => {
				await flush();
				return geoServiceSeams().lookup;
			});
		const [a, b] = await Promise.all([readLater({ lookup: first }), readLater({ lookup: second })]);
		expect(a).toBe(first);
		expect(b).toBe(second);
		expect(geoServiceSeams(), 'the scope ended with its work').toEqual({});
		// An entry-point call outside any scope is handed no seam at all.
		expect(Object.isFrozen(geoServiceSeams())).toBe(true);
	});

	test('a service id is a key of the table, and the table yields the same row each time', () => {
		for (const id of GEO_SERVICE_IDS) {
			expect(isGeoServiceId(id)).toBe(true);
			expect(geoServiceOf(id)).toBe(GEO_SERVICES[id]);
		}
	});
});
