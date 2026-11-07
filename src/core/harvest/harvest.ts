/**
 * THE HARVESTING DOOR — how a tool fetches pages from another institution's site.
 *
 * Acquisition tools read auction catalogues, journal OAI endpoints, publisher
 * pages: HTML, XML, JSON and the images and PDFs they link to. They need what an
 * API call must refuse (following redirects) and owe what an API call does not
 * (asking robots.txt, keeping a polite pace). Before this door each tool built
 * its own fetch layer, and each copy missed something different — unchecked
 * redirects, a dead IPv6 check, an unguarded robots.txt fetch, an unbounded
 * Crawl-delay, module state racing across jobs (PR #114 review, 2026-09-29).
 *
 * `harvestFetch` gives every tool the whole contract — the DEFAULT profile — in
 * this order, for EVERY hop of a redirect chain (`follow.ts`):
 *
 *   1. URL shape — http(s), no embedded credentials, never https → http (https
 *      only with `requireHttps`) — refused with `harvest.refused`;
 *   2. the caller's HOST policy — `'public'`, or an allowlist of sites;
 *   3. robots.txt for the hop's origin (`robots.ts`, RFC 9309) — refused with
 *      `harvest.robots_disallowed` / `harvest.robots_unavailable`;
 *   4. the per-origin pace (`pacing.ts`), the site's Crawl-delay clamped; the turn
 *      is held for the whole hop, and a 429/503 `Retry-After` lengthens the next
 *      caller's wait;
 *   5. `fetchPinnedHop` (core/security/ssrf_guard.ts): every address public, the
 *      socket PINNED to the vetted one, a TOTAL deadline and an idle deadline,
 *      the job's abort signal, a streamed byte ceiling (`harvest.too_large`), and
 *      — with `expectContentType` — a 2xx of another media type refused before
 *      its body is read (`harvest.unexpected_type`).
 *
 * A non-2xx answer is RETURNED (`ok:false`, with its status) — a 404 lot or a 403
 * from a bot wall is information the tool reports, not a transport failure.
 *
 * What the door does NOT do: parse, decide what a page means, or detect a bot
 * challenge page served with 200. Those are the tool's.
 *
 * THE INTERACTIVE PROFILE (`interactiveFetch`, engineering/OUTBOUND_SPEC.md §3.1) is
 * the door's second, CLOSED profile, for a request a person is waiting for that a
 * CORE route relays (a map tile). It runs steps 1, 2 and 5 above for every hop (step 2
 * with the port rule below added), and swaps steps 3 and 4: NO robots.txt (a viewer's browser asks for a tile;
 * robots.txt governs crawlers) and, instead of the strictly serial 3 s pace, a
 * per-origin concurrency cap with an optional spacing and a bounded queue, in state
 * of its own (`origin_limiter.ts`, `interactive_limits.ts`) — and, for an address an
 * editor wrote rather than an administrator chose, only a part of the global budget
 * (`InteractiveRequest.addressFrom`), of which one person (`InteractiveRequest.holder`)
 * holds at most a few slots; for an address an administrator chose, no person is more than
 * a few places deep in an origin's queue, so one person's hundreds of tiles are not the whole
 * of the line everyone shares. Its `User-Agent` carries the installation's public origin when
 * an outside machine could reach it (`installation_identity.ts`): a provider that sees this
 * profile's requests sees one installation per origin, not one anonymous Dédalo. Its limits are shorter,
 * its allowlist is required and only the scheme's own port is reachable on any hop,
 * its media types are matched exactly, a request names no method, body or header but
 * Accept, Referer and the two validators of a revalidation (`If-None-Match`,
 * `If-Modified-Since`), its answer also carries the headers a cache needs
 * (`Cache-Control`, `Expires`, `Age`, `Date`), and it refuses to run without the job's
 * stop signal (a person who went away must free the place they hold). A profile is a
 * module-private value: `HarvestRequest` and `HarvestDeps` have no field that selects
 * one, `harvestFetch` REFUSES a request or deps that carry one anyway, and
 * `interactiveFetch` itself is held by no tool (`ssrf_one_guard_tripwire`).
 */

import { isIP } from 'node:net';
import { DedaloError, isDedaloError } from '../errors/index.ts';
import { currentJobSignal } from '../media/job_scope.ts';
import { type PinnedHopResponse, parseRetryAfterMs } from '../security/ssrf_guard.ts';
import { refusedAfterRequest } from './abort.ts';
import {
	type FollowDeps,
	type FollowOptions,
	followVetted,
	type HarvestHosts,
	type HopDone,
	type HopPlan,
	siteKey,
} from './follow.ts';
import { HARVEST_USER_AGENT } from './identity.ts';
import { installationUserAgent } from './installation_identity.ts';
import {
	acquireInteractive,
	INTERACTIVE_ADDRESS_FROM,
	INTERACTIVE_DEFAULT_IDLE_TIMEOUT_MS,
	INTERACTIVE_DEFAULT_MAX_BYTES,
	INTERACTIVE_DEFAULT_TIMEOUT_MS,
	INTERACTIVE_FALLBACK_BACKOFF_MS,
	INTERACTIVE_MAX_BACKOFF_MS,
	INTERACTIVE_MAX_BYTES,
	INTERACTIVE_MAX_HOLDER_LENGTH,
	INTERACTIVE_MAX_INTERVAL_MS,
	INTERACTIVE_MAX_TIMEOUT_MS,
	type InteractiveAddressFrom,
} from './interactive_limits.ts';
import type { LimiterDeps } from './origin_limiter.ts';
import {
	acquireTurn,
	MAX_INTERVAL_MS,
	type PacingDeps,
	paceInterval,
	type WaitObserver,
} from './pacing.ts';
import { harvestRefused, harvestTooLarge, siteOf, unexpectedType } from './refusals.ts';
import { assertRobotsAllow, type RobotsPolicy } from './robots.ts';

export type { HarvestHosts } from './follow.ts';
export { HARVEST_USER_AGENT } from './identity.ts';

/** Default body ceiling: a large catalogue page or a typical PDF. */
export const HARVEST_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** No caller may raise the ceiling past this (a book-length PDF). */
export const HARVEST_MAX_BYTES = 100 * 1024 * 1024;
/** Default TOTAL time for one hop, its body included. */
export const HARVEST_DEFAULT_TIMEOUT_MS = 120_000;
/** The longest total a caller may ask for: 100 MiB on a slow (≈ 200 KiB/s) link. */
export const HARVEST_MAX_TIMEOUT_MS = 10 * 60_000;
/** Default time the body may stall without a single byte before the peer is dropped. */
export const HARVEST_DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * The request headers a caller may set. Everything else is the door's: `Host`
 * and TLS identity belong to the socket pin, `User-Agent` to the identity robots
 * rules are written against, and a cookie or credential has no business on a
 * request whose target a redirect may still change.
 */
const CALLER_HEADERS: ReadonlySet<string> = new Set([
	'accept',
	'accept-language',
	'content-type',
	'referer',
	'x-requested-with',
]);

/**
 * The response headers a caller may read. A tool needs these to name a file,
 * notice a bot wall (`cf-mitigated`), back off, or skip an unchanged resource;
 * the rest (cookies above all) is the door's business, not the tool's.
 */
const EXPOSED_RESPONSE_HEADERS: readonly string[] = [
	'cf-mitigated',
	'content-disposition',
	'content-length',
	'content-type',
	'etag',
	'last-modified',
	'retry-after',
];

/**
 * What the INTERACTIVE profile exposes: the default list plus what a route that caches
 * what it relays needs to follow the provider's own lifetime (RFC 9111) — the freshness
 * headers and the clock they are measured against. A field of the profile, not a widening
 * of the default: a tool's view of a response is exactly what it was.
 */
const INTERACTIVE_EXPOSED_RESPONSE_HEADERS: readonly string[] = Object.freeze([
	...EXPOSED_RESPONSE_HEADERS,
	'age',
	'cache-control',
	'date',
	'expires',
]);

export interface HarvestRequest {
	readonly url: string;
	readonly hosts: HarvestHosts;
	readonly method?: 'GET' | 'POST';
	/**
	 * A POST body. A `URLSearchParams` is sent as a form
	 * (`application/x-www-form-urlencoded`, unless you set a Content-Type).
	 */
	readonly body?: string | URLSearchParams;
	readonly headers?: Readonly<Record<string, string>>;
	/** Body ceiling; clamped to `HARVEST_MAX_BYTES`. */
	readonly maxBytes?: number;
	/** TOTAL time per hop, body included; clamped to `HARVEST_MAX_TIMEOUT_MS`. */
	readonly timeoutMs?: number;
	/** How long the body may stall without a byte; never longer than `timeoutMs`. */
	readonly idleTimeoutMs?: number;
	/**
	 * Media-type prefixes a 2xx answer must match (`['image/']`,
	 * `['application/pdf']`); another type is refused before its body is read.
	 */
	readonly expectContentType?: readonly string[];
	/** Refuse any hop that is not https, the first one included. */
	readonly requireHttps?: boolean;
	/** Told how long a hop will wait for its turn at the site, before it waits. */
	readonly onWait?: WaitObserver;
}

export interface HarvestResponse {
	/** The URL that finally answered, after redirects. */
	readonly url: string;
	readonly status: number;
	/** 200–299. */
	readonly ok: boolean;
	/** The `Content-Type` header, lowercased; '' when absent. */
	readonly contentType: string;
	/** The exposed response headers that were present (the profile's list), keyed in lower case. Frozen. */
	readonly headers: Readonly<Record<string, string>>;
	readonly bytes: Uint8Array;
	/** The body as text, in the charset the response declares (UTF-8 otherwise). */
	text(): string;
}

/** Injectable seams. Tests supply them; production supplies none. */
export interface HarvestDeps extends FollowDeps, PacingDeps {}

/**
 * What one harvest profile is: its limits, how an expected media type is matched,
 * and the gate each hop passes before its socket opens. Module-private on purpose —
 * a profile is chosen by WHICH FUNCTION the caller imported, never by a field.
 */
interface HarvestProfile {
	readonly defaultMaxBytes: number;
	readonly maxBytes: number;
	readonly defaultTimeoutMs: number;
	readonly maxTimeoutMs: number;
	readonly defaultIdleTimeoutMs: number;
	/** `prefix`: the type STARTS with an entry (`image/`). `exact`: it IS an entry (`image/png`). */
	readonly typeMatch: 'prefix' | 'exact';
	/** The response headers the caller may read (lower case). */
	readonly exposedHeaders: readonly string[];
	/** The request headers a caller of this profile may set (lower case); any other is a defect. */
	readonly callerHeaders: ReadonlySet<string>;
	/** Every hop must use its scheme's own port (80, 443): the host is the allowlist's, the port is not. */
	readonly defaultPortsOnly: boolean;
	/** The `User-Agent` of every request of the profile, read per request (never a caller's). */
	readonly userAgent: () => string;
	readonly gate: (request: HarvestRequest, deps: HarvestDeps) => (url: URL) => Promise<HopDone>;
}

/** A caller-supplied header name is refused unless it is one the profile lets a caller set. */
function assertCallerHeader(name: string, allowed: ReadonlySet<string>): void {
	if (allowed.has(name.toLowerCase())) return;
	throw new DedaloError('internal.invariant', {
		message: `harvestFetch: header '${name}' is the door's, not the caller's`,
		coordinates: { header: name },
	});
}

/** The request headers, with ours set and the caller's checked. */
function buildHeaders(
	request: HarvestRequest,
	userAgent: string,
	allowed: ReadonlySet<string>,
): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		assertCallerHeader(name, allowed);
		headers.set(name, value);
	}
	if (request.body instanceof URLSearchParams && !headers.has('content-type')) {
		headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
	}
	headers.set('User-Agent', userAgent);
	return headers;
}

/**
 * A caller's limit, as a positive whole number no larger than `ceiling`. Absent
 * means the default; anything else that is not a positive finite number (NaN
 * would make `total > NaN` false forever, i.e. no ceiling at all) is a defect. A
 * fraction rounds down, but never to 0.
 */
function bounded(value: number | undefined, fallback: number, ceiling: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) {
		throw new DedaloError('internal.invariant', {
			message: `harvestFetch: a limit must be a positive finite number, got ${value}`,
			coordinates: { value: String(value) },
		});
	}
	return Math.min(Math.max(1, Math.floor(value)), ceiling);
}

/**
 * An allowlist in the form hostnames arrive in: each entry parsed as a URL host
 * (lower-cased, IDN in punycode, no trailing dot; an IPv6 literal bracketed or
 * bare). An entry that is not a host is a defect, never a silent no-match — nor,
 * if empty, a match for `a..`.
 */
function normalizeHosts(hosts: HarvestHosts): HarvestHosts {
	if (hosts === 'public') return hosts;
	return hosts.map(normalizeHost);
}

function normalizeHost(entry: string): string {
	const trimmed = entry.trim();
	const literal = isIP(trimmed) === 6 ? `[${trimmed}]` : trimmed;
	const parsed = URL.parse(`http://${literal}`);
	const host = parsed?.hostname.replace(/\.$/, '') ?? '';
	if (host === '' || parsed?.pathname !== '/' || parsed.port !== '') {
		throw new DedaloError('internal.invariant', {
			message: `harvestFetch: '${entry}' is not a host name`,
			coordinates: { entry },
		});
	}
	return host;
}

/** `expectContentType` as lower-case prefixes; an empty list or prefix is a defect. */
function expectedTypes(request: HarvestRequest): readonly string[] | undefined {
	const expected = request.expectContentType;
	if (expected === undefined) return undefined;
	const prefixes = expected.map((prefix) => prefix.trim().toLowerCase());
	if (prefixes.length === 0 || prefixes.includes('')) {
		throw new DedaloError('internal.invariant', {
			message: 'harvestFetch: expectContentType needs at least one non-empty media-type prefix',
		});
	}
	return prefixes;
}

/** Read a body only when it is not a 2xx, or its media type is one the caller expects. */
function bodyFilter(
	prefixes: readonly string[],
	match: HarvestProfile['typeMatch'] = 'prefix',
): (status: number, headers: Headers) => boolean {
	return (status, headers) => {
		if (status < 200 || status >= 300) return true;
		const type = (headers.get('content-type') ?? '').toLowerCase().trim();
		if (match === 'exact') return prefixes.includes((type.split(';', 1)[0] ?? '').trim());
		return prefixes.some((prefix) => type.startsWith(prefix));
	};
}

/** The first hop's plan: the caller's URL, method and body — or a refusal. */
function startPlan(request: HarvestRequest): HopPlan {
	const url = URL.parse(request.url);
	if (url === null) throw harvestRefused('unparseable', siteOf(request.url));
	const plan: HopPlan = { url, method: request.method ?? 'GET' };
	if (request.body === undefined) return plan;
	if (plan.method !== 'POST') {
		throw new DedaloError('internal.invariant', {
			message: 'harvestFetch: a body needs method POST',
		});
	}
	plan.body = request.body.toString();
	return plan;
}

/**
 * How long a 429/503 asked us to stay away — the guard's one `Retry-After` reader,
 * clamped to the pace's ceiling; 0 when it asked nothing we can read.
 */
export function retryAfterMs(value: string | null, now: number): number {
	return Math.min(parseRetryAfterMs(value, now) ?? 0, MAX_INTERVAL_MS);
}

/** The wait a finished hop asks of the next request to its origin. */
function backoffOf(response: PinnedHopResponse | null, now: number): number {
	if (response === null || (response.status !== 429 && response.status !== 503)) return 0;
	return retryAfterMs(response.headers.get('retry-after'), now);
}

function crawlDelayOf(policy: RobotsPolicy): number | null {
	return policy.kind === 'rules' ? policy.crawlDelayMs : null;
}

/** The per-hop gate: robots.txt, then this origin's turn — released with the hop's back-off. */
function hopGate(request: HarvestRequest, deps: HarvestDeps): (url: URL) => Promise<HopDone> {
	const now = deps.now ?? Date.now;
	return async (url) => {
		const policy = await assertRobotsAllow(url, now(), deps);
		const interval = paceInterval(crawlDelayOf(policy));
		const done = await acquireTurn(siteKey(url), interval, deps, request.onWait);
		return (response) => done(backoffOf(response, now()));
	};
}

/** The default profile: the numbers above, and robots.txt then the paced turn for every hop. */
const DEFAULT_PROFILE: HarvestProfile = Object.freeze({
	defaultMaxBytes: HARVEST_DEFAULT_MAX_BYTES,
	maxBytes: HARVEST_MAX_BYTES,
	defaultTimeoutMs: HARVEST_DEFAULT_TIMEOUT_MS,
	maxTimeoutMs: HARVEST_MAX_TIMEOUT_MS,
	defaultIdleTimeoutMs: HARVEST_DEFAULT_IDLE_TIMEOUT_MS,
	typeMatch: 'prefix',
	exposedHeaders: EXPOSED_RESPONSE_HEADERS,
	callerHeaders: CALLER_HEADERS,
	defaultPortsOnly: false,
	userAgent: () => HARVEST_USER_AGENT,
	gate: hopGate,
});

/** Everything `followVetted` needs for this request, limits validated and clamped. */
function followOptions(
	request: HarvestRequest,
	deps: HarvestDeps,
	profile: HarvestProfile,
): FollowOptions {
	const timeoutMs = bounded(request.timeoutMs, profile.defaultTimeoutMs, profile.maxTimeoutMs);
	const idle = bounded(request.idleTimeoutMs, profile.defaultIdleTimeoutMs, timeoutMs);
	const expected = expectedTypes(request);
	return {
		hosts: normalizeHosts(request.hosts),
		...(request.requireHttps === true ? { requireHttps: true } : {}),
		...(profile.defaultPortsOnly ? { defaultPortsOnly: true } : {}),
		headers: buildHeaders(request, profile.userAgent(), profile.callerHeaders),
		maxBytes: bounded(request.maxBytes, profile.defaultMaxBytes, profile.maxBytes),
		timeoutMs,
		idleTimeoutMs: Math.min(idle, timeoutMs),
		...(expected === undefined ? {} : { acceptBody: bodyFilter(expected, profile.typeMatch) }),
		beforeHop: profile.gate(request, deps),
		deps,
	};
}

/**
 * The primitive's body-cap failure, as the door's own code. Every other failure
 * (a refusal, a timeout, a stopped job) passes through as it is.
 */
function doorFailure(error: unknown, site: string, maxBytes: number): unknown {
	const bodyCap = isDedaloError(error) && error.coordinates?.reason === 'body_cap';
	return bodyCap ? harvestTooLarge(site, maxBytes, error) : error;
}

/**
 * The keys by which a caller could try to pick a profile. No type has one; a tool
 * is JavaScript at run time, and a payload spread into the request would carry one
 * in. Such a request is a defect, loudly — never a silent fall back to the default
 * (the caller believes it asked for something else) and never honoured.
 */
const PROFILE_SELECTORS = ['profile', 'interactive'] as const;

function assertNoProfileSelector(request: object, deps: object): void {
	for (const [where, carrier] of [
		['request', request],
		['deps', deps],
	] as const) {
		const selector = PROFILE_SELECTORS.find((key) => key in carrier);
		if (selector === undefined) continue;
		throw new DedaloError('internal.invariant', {
			message: `harvestFetch: the ${where} names a '${selector}' — a caller cannot select a harvest profile (the interactive profile is the core's: interactiveFetch)`,
			coordinates: { where, selector },
		});
	}
}

/** Fetch one resource from another site, through the whole harvesting contract. */
export async function harvestFetch(
	request: HarvestRequest,
	deps: HarvestDeps = {},
): Promise<HarvestResponse> {
	assertNoProfileSelector(request, deps);
	return harvestWith(DEFAULT_PROFILE, request, deps);
}

/** The one pipeline both profiles run: the plan, the options, the vetted loop, the answer. */
async function harvestWith(
	profile: HarvestProfile,
	request: HarvestRequest,
	deps: HarvestDeps,
): Promise<HarvestResponse> {
	const plan = startPlan(request);
	const options = followOptions(request, deps, profile);
	const site = siteOf(plan.url);
	const result = await followVetted(plan, options).catch((error: unknown) => {
		throw doorFailure(error, site, options.maxBytes);
	});
	const { response } = result;
	if (response.bodySkipped) {
		throw unexpectedType(site, response.headers.get('content-type') ?? '');
	}
	return toHarvestResponse(result.url, response, profile.exposedHeaders);
}

/** The subset of the response headers a profile exposes (`HarvestProfile.exposedHeaders`), frozen. */
function exposedHeaders(
	headers: Headers,
	names: readonly string[],
): Readonly<Record<string, string>> {
	const exposed: Record<string, string> = {};
	for (const name of names) {
		const value = headers.get(name);
		if (value !== null) exposed[name] = value;
	}
	return Object.freeze(exposed);
}

function toHarvestResponse(
	url: URL,
	response: PinnedHopResponse,
	exposed: readonly string[],
): HarvestResponse {
	const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
	const { status, bytes } = response;
	return {
		url: url.toString(),
		status,
		ok: status >= 200 && status < 300,
		contentType,
		headers: exposedHeaders(response.headers, exposed),
		bytes,
		text: () => decodeBody(bytes, contentType),
	};
}

// ---------------------------------------------------------------------------
// The interactive profile
// ---------------------------------------------------------------------------

/**
 * The request headers an interactive request may set. A relayed tile needs to say what it
 * accepts, who the referrer is for a provider whose terms ask for it — the CORE route sets
 * that, from configuration, never from a stored template — and, to revalidate a tile it kept
 * past its freshness, the validators the provider itself gave for it (`If-None-Match`,
 * `If-Modified-Since`: RFC 9111 §4.3.2; a provider's usage policy may ask for exactly that).
 */
const INTERACTIVE_CALLER_HEADERS: ReadonlySet<string> = new Set([
	'accept',
	'referer',
	'if-none-match',
	'if-modified-since',
]);

/**
 * One relayed request, for a person who is waiting. Narrower than `HarvestRequest`
 * on purpose: GET only, no body, no wait observer, an allowlist and an exact media
 * type are REQUIRED, and nothing here can select a profile or raise a limit.
 */
export interface InteractiveRequest {
	readonly url: string;
	/**
	 * The sites it may visit, redirects included — an allowlist of at least one
	 * entry, never `'public'`: a stored address that redirects elsewhere is refused
	 * (`harvest.refused` reason `host_not_allowed`). A name admits its subdomains. Only
	 * on the scheme's own port (80, 443): a host in the list is not a licence to reach
	 * every service on it (`port_not_allowed`).
	 */
	readonly hosts: readonly string[];
	/**
	 * The exact media types a 2xx answer may have (`image/png`), parameters aside; any
	 * other 2xx is refused before its body is read (`harvest.unexpected_type`). At
	 * least one. Not prefixes: `image/` would admit `image/svg+xml`.
	 */
	readonly mediaTypes: readonly string[];
	/**
	 * Who chose this host — REQUIRED, so a route cannot forget to say. `'stored'`: an
	 * address a record's editor wrote; it shares a smaller part of the global budget
	 * (`INTERACTIVE_MAX_STORED_TOTAL`), so the hosts an editor picks can never hold every
	 * slot and starve the rest. `'registry'`: one the administrators chose — the core's
	 * closed built-in registry or an ontology default — which draws on the whole budget.
	 * Anything else is a defect (`internal.invariant`, before any wait).
	 */
	readonly addressFrom: InteractiveAddressFrom;
	/**
	 * Who is waiting — REQUIRED, an opaque name the route established (the user id of the
	 * session: `user:957`), never anything the client sent. A STORED address draws on the stored
	 * budget through THIS holder's own cap (`INTERACTIVE_MAX_STORED_PER_HOLDER`), so one person's
	 * slow hosts cannot hold the whole stored budget; a REGISTRY address through this holder's own
	 * places at its origin (`INTERACTIVE_MAX_REGISTRY_PER_HOLDER`), so one person's view cannot be
	 * the whole queue of an origin everybody shares. At most 64 characters, non-empty; anything
	 * else is a defect (`internal.invariant`, before any wait).
	 */
	readonly holder: string;
	/** Only `Accept`, `Referer`, `If-None-Match` and `If-Modified-Since`; any other name is a defect. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Body ceiling; clamped to `INTERACTIVE_MAX_BYTES`. */
	readonly maxBytes?: number;
	/** TOTAL time per hop, body included; clamped to `INTERACTIVE_MAX_TIMEOUT_MS`. */
	readonly timeoutMs?: number;
	/** How long the body may stall without a byte; never longer than `timeoutMs`. */
	readonly idleTimeoutMs?: number;
	/** Refuse any hop that is not https, the first one included. */
	readonly requireHttps?: boolean;
	/**
	 * The spacing THIS start owes every later start at its origin — a provider's own
	 * terms: no later start sooner than this after it, whatever the later one asks for
	 * itself. Not a promise about the gap before this start, so a caller whose origin has
	 * terms passes them on EVERY request to that origin (a stored source on a host a
	 * closed built-in also names included). Default 0 (the concurrency cap alone);
	 * clamped to `INTERACTIVE_MAX_INTERVAL_MS`.
	 */
	readonly minIntervalMs?: number;
}

/** The seams of `HarvestDeps`, plus the limiter's wait-ceiling timer. */
export interface InteractiveDeps extends HarvestDeps, LimiterDeps {}

function assertInteractiveHeaders(headers: Readonly<Record<string, string>> | undefined): void {
	for (const name of Object.keys(headers ?? {})) {
		if (INTERACTIVE_CALLER_HEADERS.has(name.toLowerCase())) continue;
		throw new DedaloError('internal.invariant', {
			message: `interactiveFetch: header '${name}' is the door's, not the caller's`,
			coordinates: { header: name },
		});
	}
}

function assertNonEmptyList(what: string, value: readonly string[] | undefined): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new DedaloError('internal.invariant', {
			message: `interactiveFetch: ${what} needs at least one entry`,
		});
	}
	return value;
}

/** Who chose the host: one of the two closed values, or a defect (a route that forgot, or an untyped caller). */
function interactiveAddressFrom(value: unknown): InteractiveAddressFrom {
	const known = INTERACTIVE_ADDRESS_FROM.find((candidate) => candidate === value);
	if (known !== undefined) return known;
	throw new DedaloError('internal.invariant', {
		message: `interactiveFetch: addressFrom must be one of ${INTERACTIVE_ADDRESS_FROM.join(', ')}, got ${String(value)}`,
		coordinates: { value: String(value) },
	});
}

/** Who is waiting: a non-empty name of at most 64 characters, or a defect (a route that forgot, or an untyped caller). */
function interactiveHolder(value: unknown): string {
	if (typeof value === 'string' && value !== '' && value.length <= INTERACTIVE_MAX_HOLDER_LENGTH) {
		return value;
	}
	throw new DedaloError('internal.invariant', {
		message: `interactiveFetch: holder must be a non-empty string of at most ${INTERACTIVE_MAX_HOLDER_LENGTH} characters`,
		coordinates: { type: typeof value },
	});
}

/** The spacing a request asks for: absent is none; anything not a finite number >= 0 is a defect. */
function interactiveSpacing(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value < 0) {
		throw new DedaloError('internal.invariant', {
			message: `interactiveFetch: minIntervalMs must be a finite number >= 0, got ${value}`,
			coordinates: { value: String(value) },
		});
	}
	return Math.min(value, INTERACTIVE_MAX_INTERVAL_MS);
}

/**
 * The shared pipeline's request for an interactive one. Built field by field, so
 * nothing the caller's object carries beyond `InteractiveRequest` (a method, a
 * body, a `profile`) can reach the pipeline.
 */
function interactiveAsHarvest(request: InteractiveRequest): HarvestRequest {
	assertInteractiveHeaders(request.headers);
	return {
		url: request.url,
		hosts: assertNonEmptyList('hosts', request.hosts),
		method: 'GET',
		expectContentType: assertNonEmptyList('mediaTypes', request.mediaTypes),
		...(request.headers === undefined ? {} : { headers: request.headers }),
		...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
		...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
		...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
		...(request.requireHttps === true ? { requireHttps: true } : {}),
	};
}

/**
 * How long a 429/503 asks us to stay away from the origin: its `Retry-After` (the
 * guard's one reader) up to the interactive ceiling, else a short fixed hold — a
 * provider that said "slow down" is not asked again at once. 0 for any other answer.
 */
function interactiveBackoff(response: PinnedHopResponse | null, now: number): number {
	if (response === null || (response.status !== 429 && response.status !== 503)) return 0;
	const asked = parseRetryAfterMs(response.headers.get('retry-after'), now);
	return Math.min(asked ?? INTERACTIVE_FALLBACK_BACKOFF_MS, INTERACTIVE_MAX_BACKOFF_MS);
}

/**
 * The interactive per-hop gate: this origin's slot, the shared ones (a stored address's
 * budget, then the global one) and the spacing, released with the hop's back-off. A
 * redirect hop draws on the same budgets as the first. It never asks robots.txt — see the
 * header.
 */
function interactiveGate(
	minIntervalMs: number,
	addressFrom: InteractiveAddressFrom,
	holder: string,
	deps: InteractiveDeps,
): (url: URL) => Promise<HopDone> {
	const now = deps.now ?? Date.now;
	// Hops this call has taken a place for: a wait that is stopped, or refused (`rate.limited`), AFTER
	// the first is not "nothing of this call ever left" (abort.ts `stoppedBeforeAnyRequest`,
	// `reachedProviderBeforeRefusal`), and the error says so.
	let hopsPlaced = 0;
	return async (url) => {
		let release: Awaited<ReturnType<typeof acquireInteractive>>;
		try {
			release = await acquireInteractive(siteKey(url), minIntervalMs, addressFrom, holder, deps);
		} catch (error) {
			throw hopsPlaced === 0 ? error : refusedAfterRequest(error);
		}
		hopsPlaced++;
		return (response) => release(interactiveBackoff(response, now()));
	};
}

/**
 * Fetch one resource for a person who is waiting, through the INTERACTIVE profile.
 *
 * CORE ONLY. A tool never holds this function (`ssrf_one_guard_tripwire` refuses the
 * import), and the one route that does passes a request that names a stored source
 * and never a URL a client wrote. The waits honour the ambient job signal
 * (`media/job_scope.ts`), and the call REFUSES to run without one
 * (`internal.invariant`, before any wait): a viewer who pans away aborts requests
 * constantly, and a call that could not be stopped would keep its place in the queue,
 * and then go to the provider, for a person who is no longer there. A route serving a
 * plain HTTP request wraps the call in `runWithJobSignal(request.signal, …)`.
 */
export async function interactiveFetch(
	request: InteractiveRequest,
	deps: InteractiveDeps = {},
): Promise<HarvestResponse> {
	assertStoppable();
	const addressFrom = interactiveAddressFrom(request.addressFrom);
	const holder = interactiveHolder(request.holder);
	const minIntervalMs = interactiveSpacing(request.minIntervalMs);
	const profile: HarvestProfile = Object.freeze({
		defaultMaxBytes: INTERACTIVE_DEFAULT_MAX_BYTES,
		maxBytes: INTERACTIVE_MAX_BYTES,
		defaultTimeoutMs: INTERACTIVE_DEFAULT_TIMEOUT_MS,
		maxTimeoutMs: INTERACTIVE_MAX_TIMEOUT_MS,
		defaultIdleTimeoutMs: INTERACTIVE_DEFAULT_IDLE_TIMEOUT_MS,
		typeMatch: 'exact',
		exposedHeaders: INTERACTIVE_EXPOSED_RESPONSE_HEADERS,
		callerHeaders: INTERACTIVE_CALLER_HEADERS,
		defaultPortsOnly: true,
		userAgent: installationUserAgent,
		gate: () => interactiveGate(minIntervalMs, addressFrom, holder, deps),
	});
	return harvestWith(profile, interactiveAsHarvest(request), deps);
}

/** A request someone waits for must be stoppable: no ambient job signal is a defect in the route. */
function assertStoppable(): void {
	if (currentJobSignal() !== undefined) return;
	throw new DedaloError('internal.invariant', {
		message:
			'interactiveFetch: no job signal in scope — wrap the call in runWithJobSignal(request.signal, …) so a client that went away frees its place',
	});
}

/** A charset label as the three declaration forms spell it. */
const CHARSET_LABEL = '([\\w.:-]+)';
const HEADER_CHARSET = new RegExp(`charset=["']?${CHARSET_LABEL}`, 'i');
const META_CHARSET = new RegExp(`<meta[^>]+charset=["']?${CHARSET_LABEL}`, 'i');
const XML_ENCODING = new RegExp(`^\\s*<\\?xml[^>]+encoding=["']${CHARSET_LABEL}`, 'i');

/**
 * Decode in the declared charset: the `Content-Type` parameter first; then, in
 * the first KiB, an XML declaration's `encoding=` or an HTML `<meta charset>`
 * (many catalogue sites and OAI endpoints declare Latin-1 only there); else
 * UTF-8. An unknown label falls back to UTF-8, never throws.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
	const declared = HEADER_CHARSET.exec(contentType)?.[1] ?? sniffCharset(bytes);
	try {
		return new TextDecoder(declared ?? 'utf-8').decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

function sniffCharset(bytes: Uint8Array): string | undefined {
	const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
	return XML_ENCODING.exec(head)?.[1] ?? META_CHARSET.exec(head)?.[1];
}
