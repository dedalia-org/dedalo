/**
 * THE MAP TILE PROXY — `GET /dedalo/core/api/v1/map_tile`: a same-origin, authenticated
 * relay of ONE map tile (or one WMS image) from the source a record, an ontology default
 * or the core's built-in registry names.
 *
 * WHY IT EXISTS. A map in the browser used to ask OpenStreetMap, ArcGIS, … directly: the
 * installation's CSP had to admit each host in `img-src`, the provider saw every viewer's
 * address, a canvas export of the map was tainted (a cross-origin image cannot be read
 * back), and a source stored in a record — an editor-chosen URL — would have meant letting
 * the page load images from wherever an editor typed. Through the server, the page loads
 * ONLY from itself, the provider sees the installation (as its terms ask), and the tile is
 * a same-origin image that a DOM-to-image export can draw.
 *
 * THE REQUEST NEVER CARRIES A URL (geo/tile_proxy/tile_request.ts). It names a stored
 * source `{section_tipo, section_id, component_tipo, source_id}`, an ontology default
 * `{section_tipo, component_tipo, default_id}` or a built-in `{…, builtin}`, and the tile
 * `z/x/y` (or a WMS image `bbox/width/height`). The server finds the source, builds the
 * upstream address itself (geo/tile_proxy/upstream_url.ts: only numbers it formats are
 * substituted) and fetches it.
 *
 * THE ORDER (each step is the same refusal on failure, so nothing says which gate said no):
 *
 *   0. not a cross-site or speculative request  (Sec-Fetch-Site, Sec-Purpose)
 *   1. an authenticated session, its Principal resolved NOW (maintenance applies)
 *   2. the query is in the closed grammar        (400 `request.invalid`: no oracle, it
 *                                                  depends on the query alone)
 *   3. THE GATES (geo/tile_proxy/tile_source.ts): the section grant and the component grant
 *      of the section as addressed (asked QUIETLY: a refusal is counted and said once a
 *      window per person, not a `[frontier]` line per request), the ontology's word that it
 *      is a geolocation of that section (virtual sections resolve to their real one), the
 *      record scope — and only then the source itself, re-validated at fetch time
 *   4. the upstream address, built — and, for a provider that lets a relay through only under
 *      the INSTALLATION's own identity (OpenStreetMap), the installation's public origin: an
 *      installation without one does not relay it (503 `external.disabled`; its browsers load
 *      that provider directly, geo/tile_proxy/direct_tiles.ts). After the gates, before the memory
 *   5. THE MEMORY, keyed by that address — consulted only AFTER 1-4, so a hit can never
 *      answer a caller who failed a gate (geo/tile_proxy/tile_cache.ts): a successful, verified
 *      image held for the provider's own freshness (no provider call, no token). A tile that has
 *      run out of freshness but came with a validator is not served: it is asked about
 *      CONDITIONALLY (step 7). Nothing else is kept: not a failure, and not the provider's "no
 *      such tile" either
 *   6. ONE CALL PER ADDRESS (geo/tile_proxy/tile_flights.ts): a request for an address
 *      already in the air JOINS that call; only a request that STARTS one spends a token of
 *      the person's budget (geo/tile_proxy/principal_budget.ts: a person who has used their
 *      share is refused `rate.limited` before the door sees them; a call the provider never
 *      heard of gives the token back — the door refused it for its own capacity, or every
 *      viewer who needed it left while it waited for its place)
 *   7. THE FETCH, through the harvesting door's INTERACTIVE profile (`interactiveFetch`,
 *      engineering/OUTBOUND_SPEC.md §3.1): the SSRF guard on every hop, the redirect
 *      allowlist pinned to the template's host, the scheme's own port, a per-origin cap with
 *      the provider's spacing, one person's places in the line (for an address an editor wrote,
 *      the slots; for one an administrator chose, the places in the origin's queue), a byte
 *      ceiling, exact media types, the installation's identity in the User-Agent, and — for a
 *      stale tile — the validators the provider itself gave (`If-None-Match`, `If-Modified-Since`)
 *   8. THE ANSWER IS JUDGED before it is relayed or kept (geo/tile_proxy/tile_outcome.ts): a
 *      tile (a 2xx, the exact image type — png, jpeg, gif, webp, never svg, never html —
 *      bytes that begin like that type and a header that states a size within the limits; or a
 *      `304` to a conditional request, which renews the stale tile the proxy kept), "there is no
 *      such tile" (404, 410, no content), a 2xx that is not an image, the proxy being busy (the
 *      door's own capacity, not the provider), or a fault
 *
 * WHAT THIS ROUTE OWES THE DOOR (OUTBOUND_SPEC.md §3.1) and how it pays:
 *   - names the source, never a URL                     tile_request.ts: no key carries one
 *   - checks session + permission before fetching or answering from the memory   steps 1-3, 5
 *   - names `addressFrom` truthfully                    tile_source.ts: a stored source is
 *                                                         `'stored'`; only the closed registry and
 *                                                         an ontology default are `'registry'`
 *   - passes the origin's spacing on every request      `relayRequest(…, termsFor(host))`
 *                                                         (geo/tile_proxy/relay_request.ts), whose own
 *                                                         gate drives it with a synthetic non-zero
 *                                                         spacing: today's registry rows owe none, so
 *                                                         this route's gate cannot see it
 *   - wraps the call in the request's signal            the flight runs under a signal of its own that
 *                                                         is aborted when its LAST holder has gone: a
 *                                                         viewer who panned away frees the queue place
 *   - maps EVERY failure of the door to ONE refusal     `external.transport` (503): the door's
 *                                                         `harvest.*` details name a site and a media
 *                                                         type, which would make this route an oracle
 *                                                         for which port or service answered. (A
 *                                                         provider's ANSWER is not a failure of the
 *                                                         door: "no such tile" is the uniform
 *                                                         not-found, as is a 2xx that is not an image.
 *                                                         The door's own `rate.limited` is its
 *                                                         capacity, not a failure: `429` with a
 *                                                         Retry-After, the viewer asks again)
 *   - names who is waiting                              `relayRequest(…, userId)`: the door's holder
 *                                                         is the session's user, so one person's slow
 *                                                         stored hosts hold a few of the shared slots
 *                                                         and one person's big view is a few places
 *                                                         deep in a registry origin's queue
 *   - forwards no cookie or credential, either way      the door sets the request headers and exposes
 *                                                         only the freshness headers of the answer
 *   - relays no prefetch                                step 0, and the route fetches exactly the tile
 *                                                         asked for, never its neighbours
 *   - exports a handler and nothing that takes a URL    this module's only export
 *
 * WHAT IT SAYS TO THE OPERATOR, and how rarely (geo/tile_proxy/tile_log.ts). A viewport asks
 * dozens of tiles (up to 160 on a 4K display), a provider that is down fails all of them for
 * every viewer, and anyone holding a session can ask for a view the source does not take or a
 * map they may not read. So what a caller controls (a zoom outside a source, a view it does
 * not take, a provider with no such tile, a map it may not read) is COUNTED and never logged
 * (the last one is said once a window per person, naming the user and no tipo), and what the
 * operator can act on (a provider failing, a source that no longer validates, a person held
 * to their budget, the proxy at capacity) is one line per distinct reason per source per
 * minute, without a stack, naming the door's code and the source and never an address. A
 * viewer who went away is not reported at all.
 *
 * THE RESPONSE: the verified image type; `private, max-age=<the freshness left>`, at most a
 * day for a built-in source and five minutes for a stored source or an ontology default (a
 * source that is DATA is edited without its proxy URL changing: freshness.ts) — `no-store`
 * when the provider forbade keeping the tile — `private`, never `public`, because the route
 * is authenticated; `nosniff`; `default-src 'none'; sandbox`;
 * `Cross-Origin-Resource-Policy: same-origin`; `Vary: Cookie`; `Referrer-Policy: no-referrer`.
 * Every refusal is `no-store`, but "the provider has no such tile", which is `private,
 * max-age=120` (and `Vary: Cookie`) so a BROWSER does not ask again: the proxy itself
 * remembers no refusal, the browser's own per-person cache is what stops the repeats.
 *
 * TEST SEAMS. The resolver, the socket and the limiter's clock the door takes ride the geo
 * outbound scope (`geo_services/geo_seams.ts`), which only a gate can open — production
 * passes none. They are exactly what a caller must never choose (whoever replaces the
 * resolver replaces the SSRF guard's pin), which is why they are not a parameter.
 *
 * Gate: test/unit/map_tile_proxy_native.test.ts.
 */

import { toErrorEnvelope } from '../errors/convert.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { formatErrorLine } from '../errors/log.ts';
import { termsFor } from '../geo/tile_proxy/builtin_sources.ts';
import { relayWithheld } from '../geo/tile_proxy/direct_tiles.ts';
import {
	absentCacheControl,
	browserCacheControl,
	type SourceStability,
} from '../geo/tile_proxy/freshness.ts';
import { refundUpstreamToken, takeUpstreamToken } from '../geo/tile_proxy/principal_budget.ts';
import { relayRequest } from '../geo/tile_proxy/relay_request.ts';
import {
	forgetTile,
	type KeptTile,
	recallStale,
	recallTile,
	rememberTile,
} from '../geo/tile_proxy/tile_cache.ts';
import { shareTileFlight } from '../geo/tile_proxy/tile_flights.ts';
import { reportOncePerWindow } from '../geo/tile_proxy/tile_log.ts';
import {
	judgeAnswer,
	judgeDoorFailure,
	neverReachedProvider,
	type RelayedTile,
	type TileOutcome,
} from '../geo/tile_proxy/tile_outcome.ts';
import { parseTileRequest, type TileRef, type TileView } from '../geo/tile_proxy/tile_request.ts';
import { type ResolvedTileSource, resolveTileSource } from '../geo/tile_proxy/tile_source.ts';
import { buildUpstream, type UpstreamRequest } from '../geo/tile_proxy/upstream_url.ts';
import { geoServiceSeams } from '../geo_services/geo_seams.ts';
import { type InteractiveDeps, interactiveFetch } from '../harvest/harvest.ts';
import { sessionPrincipalFromCookie } from '../security/session_gate.ts';
import { incrementCounter } from './counters.ts';
import { SECURITY_HEADERS } from './static_asset.ts';

/** The response headers of a relayed tile, over the app's own security headers. */
const TILE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	...SECURITY_HEADERS,
	'Content-Security-Policy': "default-src 'none'; sandbox",
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Referrer-Policy': 'no-referrer',
	Vary: 'Cookie',
});

/** What the steps after the gates need to know about one request. */
interface RelayContext {
	readonly request: Request;
	readonly requestId: string;
	readonly userId: number;
	readonly ref: TileRef;
	readonly resolved: ResolvedTileSource;
	readonly upstream: UpstreamRequest;
}

/**
 * The refusal body: the CONVERTER builds it (registry status, no existence or permission leak).
 * Never cacheable (`no-store`) but for what `extraHeaders` overrides: "the provider has no such
 * tile", which says so itself.
 */
function refuse(
	error: DedaloError,
	requestId: string,
	extraHeaders: Readonly<Record<string, string>> = {},
): Response {
	const converted = toErrorEnvelope(error, { requestId });
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...extraHeaders,
	};
	if (converted.retryAfterMs !== undefined) {
		headers['Retry-After'] = String(Math.ceil(converted.retryAfterMs / 1000));
	}
	return new Response(JSON.stringify(converted.body), { status: converted.status, headers });
}

/** THE refusal for "no such source for you": unknown, forbidden, not a geolocation, out of scope. */
function refuseNotFound(requestId: string): Response {
	return refuse(new DedaloError('resource.not_found'), requestId);
}

/**
 * The source a request names, for the operator's line: tipos, ids and names the closed
 * grammar already admitted — never an address (`stored:zztile1.zztile2#1/11`).
 */
function sourceLabel(ref: TileRef): string {
	if (ref.kind === 'stored') {
		return `stored:${ref.sectionTipo}.${ref.componentTipo}#${ref.sectionId}/${ref.sourceId}`;
	}
	if (ref.kind === 'default') return `default:${ref.componentTipo}/${ref.defaultId}`;
	return `builtin:${ref.builtinId}`;
}

/** The operator's line for `error`, once per distinct line per window; a viewer who left reports nothing. */
function reportOnce(context: RelayContext, error: DedaloError, now: number): void {
	if (context.request.signal.aborted) return;
	const key = formatErrorLine(error, { subsystem: 'map_tile' });
	const line = formatErrorLine(error, { subsystem: 'map_tile', requestId: context.requestId });
	reportOncePerWindow(key, now, () => console.warn(line));
}

/**
 * THE refusal for every FAULT upstream of this server: the door's, a bad answer, a busy
 * provider. One typed refusal whatever the cause, so the body is no oracle for which port or
 * service answered; the cause rides in the operator's line (the door's code and the source).
 */
function refuseFault(
	context: RelayContext,
	fault: Extract<TileOutcome, { kind: 'fault' }>,
	now: number,
): Response {
	const error = new DedaloError('external.transport', {
		message: `map tile relay failed (${fault.why})`,
		coordinates: {
			why: fault.why,
			...(fault.doorCode === undefined ? {} : { door_code: fault.doorCode }),
			source: sourceLabel(context.ref),
		},
	});
	if (!context.request.signal.aborted) incrementCounter('map_tile_relay_failed');
	reportOnce(context, error, now);
	return refuse(error, context.requestId);
}

/**
 * A 2xx that is not an image. It is routine for a WMS (an exception report under a 200) and
 * it is also what a wrong layer name looks like for EVERY tile, so it is one line per source
 * per minute, and the answer is the uniform not-found, not a fault.
 */
function refuseNotAnImage(context: RelayContext, now: number): Response {
	incrementCounter('map_tile_not_an_image');
	reportOnce(
		context,
		new DedaloError('resource.not_found', {
			message: 'map tile provider answered something that is not an image',
			coordinates: { why: 'not_an_image', source: sourceLabel(context.ref) },
		}),
		now,
	);
	return refuseNotFound(context.requestId);
}

/**
 * The proxy could not take this request now: 429 with how long to wait, one line a minute.
 * Two causes, told apart for the operator and never for the body: this person has used their
 * share of the upstream, or the harvesting door is at capacity (a viewport asks tens to hundreds
 * of tiles at once, and an origin held off by its provider looks the same). Neither says
 * anything is wrong with the provider, so neither is a fault.
 */
function refuseBusy(
	context: RelayContext,
	busy: Extract<TileOutcome, { kind: 'busy' }>,
	now: number,
): Response {
	const byBudget = busy.why === 'principal_budget';
	incrementCounter(byBudget ? 'map_tile_rate_limited' : 'map_tile_busy');
	const error = new DedaloError('rate.limited', {
		message: byBudget ? 'map tile budget of this user is used up' : 'map tile relay is at capacity',
		coordinates: byBudget
			? { why: busy.why, user: context.userId }
			: {
					why: busy.why,
					...(busy.doorReason === undefined ? {} : { door_reason: busy.doorReason }),
					source: sourceLabel(context.ref),
				},
		retryAfterMs: busy.retryAfterMs,
	});
	reportOnce(context, error, now);
	return refuse(error, context.requestId);
}

/**
 * "The provider has no such tile": the uniform not-found, with the one difference that a BROWSER
 * may remember it. The body is the very same as every other "no" (so nothing in it tells a
 * caller which gate or answer said it); only a caller who passed every gate sees the
 * `Cache-Control`, and what it tells them is that the tile is not there — which is the answer.
 * `private, max-age` so the browser stops asking (and logging a failed load) for the same missing
 * tile on every pan, `Vary: Cookie` so that cached "no" is never another session's. The proxy
 * keeps nothing of it (tile_cache.ts keeps only successful images).
 */
function refuseAbsent(context: RelayContext): Response {
	incrementCounter('map_tile_absent');
	return refuse(new DedaloError('resource.not_found'), context.requestId, {
		'Cache-Control': absentCacheControl(),
		Vary: 'Cookie',
	});
}

/** A cross-site request, or one a browser made speculatively (prefetch, prerender): never relayed. */
function isForeignOrSpeculative(headers: Headers): boolean {
	if (headers.get('sec-fetch-site') === 'cross-site') return true;
	const purpose =
		`${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''}`.toLowerCase();
	return purpose.includes('prefetch') || purpose.includes('prerender');
}

/** The seams of the door in scope (none in production). */
function relayDeps(): InteractiveDeps {
	const seams = geoServiceSeams();
	return Object.keys(seams).length === 0 ? {} : { pinned: seams, ...(seams.limiter ?? {}) };
}

/** The clock the memory uses: the gate's fake one when a scope sets it. */
function clockNow(): number {
	return (geoServiceSeams().limiter?.now ?? Date.now)();
}

/**
 * What can change a source behind its proxy URL (freshness.ts): only the core's own registry
 * is fixed; a stored source or an ontology default is data and is edited without its URL
 * changing, so the browser keeps its tiles for minutes, not a day.
 */
function stabilityOf(ref: TileRef): SourceStability {
	return ref.kind === 'builtin' ? 'fixed' : 'editable';
}

/** A verified tile as the browser gets it. */
function tileResponse(tile: RelayedTile, cacheControl: string): Response {
	return new Response(tile.bytes as BodyInit, {
		status: 200,
		headers: { ...TILE_HEADERS, 'Content-Type': tile.contentType, 'Cache-Control': cacheControl },
	});
}

/** The response a viewer gets for the outcome of its request. */
function respond(context: RelayContext, outcome: TileOutcome, now: number): Response {
	switch (outcome.kind) {
		case 'tile':
			return tileResponse(
				outcome.tile,
				browserCacheControl(outcome.freshMs, stabilityOf(context.ref)),
			);
		case 'absent':
			return refuseAbsent(context);
		case 'not_an_image':
			return refuseNotAnImage(context, now);
		case 'busy':
			return refuseBusy(context, outcome, now);
		case 'fault':
			return refuseFault(context, outcome, now);
	}
}

/**
 * Steps 7-8, the call a flight makes: the door, then the judgement of what it returned,
 * keeping a good tile if the provider's headers allow. `stale` is the tile the memory held past
 * its freshness, if any: its validators ride the request and a `304` renews it. A failure is an
 * OUTCOME here, so the flight never rejects and every viewer who joined reads the same one.
 */
async function fetchTile(
	context: RelayContext,
	deps: InteractiveDeps,
	stale: KeptTile | null,
): Promise<TileOutcome> {
	const outcome = await askProvider(context, deps, stale);
	settleOutcome(context, outcome);
	return outcome;
}

/** Step 7, the door: the request (conditional when `stale` is held) and the judgement of its answer or failure. */
async function askProvider(
	context: RelayContext,
	deps: InteractiveDeps,
	stale: KeptTile | null,
): Promise<TileOutcome> {
	const { resolved, upstream } = context;
	const terms = termsFor(upstream.host);
	try {
		const answer = await interactiveFetch(
			relayRequest(resolved, upstream, terms, context.userId, stale?.validators ?? null),
			deps,
		);
		return judgeAnswer(answer, upstream.mediaTypes, terms, clockNow(), stale);
	} catch (error) {
		const outcome = judgeDoorFailure(error);
		// Every viewer who needed this call left while it waited for its place: it was never sent
		if (neverReachedProvider(error)) refundUpstreamToken(context.userId, clockNow());
		return outcome;
	}
}

/** Step 8, what the outcome does to the memory and to the person's budget. */
function settleOutcome(context: RelayContext, outcome: TileOutcome): void {
	const { upstream } = context;
	// A tile is kept (or, when the provider forbade it, the older copy is dropped); a 404/410 or empty
	// answer ends a stale copy: it is no longer asked about. A fault leaves it for the next try.
	if (outcome.kind === 'tile') {
		rememberTile(upstream.url, outcome.tile, outcome.keepMs, clockNow(), outcome.validators);
	}
	if (outcome.kind === 'absent') forgetTile(upstream.url);
	// The door refused for its own capacity: the provider was never asked, so the call is not charged —
	// unless the refusal was of a redirect's later hop, after the first had reached the provider
	if (outcome.kind === 'busy' && outcome.reachedProvider !== true) {
		refundUpstreamToken(context.userId, clockNow());
	}
}

/** The person's budget, asked only by the request that would start a call of its own. */
function admitUpstream(userId: number, now: number): TileOutcome | null {
	const decision = takeUpstreamToken(userId, now);
	return decision.ok
		? null
		: { kind: 'busy', why: 'principal_budget', retryAfterMs: decision.retryAfterMs };
}

/**
 * Steps 5-8: the memory (a tile held fresh), then the one call per address. The caller has
 * passed every gate, and a memory answer costs no token. A tile held past its freshness with a
 * validator is not served: the call asks the provider about it conditionally.
 */
async function relay(context: RelayContext): Promise<Response> {
	const { request, upstream } = context;
	const now = clockNow();
	const kept = recallTile(upstream.url, now);
	if (kept !== null) {
		return tileResponse(kept, browserCacheControl(kept.freshUntil - now, stabilityOf(context.ref)));
	}
	const stale = recallStale(upstream.url, now);
	const deps = relayDeps();
	let outcome: TileOutcome;
	try {
		outcome = await shareTileFlight(
			upstream.url,
			request.signal,
			() => admitUpstream(context.userId, now),
			() => fetchTile(context, deps, stale),
		);
	} catch (error) {
		// Only this viewer's own stop (the signal) reaches here: a flight reports its failures as outcomes.
		outcome = judgeDoorFailure(error);
	}
	return respond(context, outcome, now);
}

/**
 * Handle `GET /dedalo/core/api/v1/map_tile`. Returns a Response; server.ts only routes by
 * path and method — every decision lives here.
 */
export async function handleMapTile(
	request: Request,
	url: URL,
	requestId: string = crypto.randomUUID(),
): Promise<Response> {
	if (isForeignOrSpeculative(request.headers)) return refuseNotFound(requestId);
	const caller = await sessionPrincipalFromCookie(request.headers.get('cookie'));
	if (caller === null) return refuseNotFound(requestId);
	const parsed = parseTileRequest(url.searchParams);
	if (!parsed.ok) {
		return refuse(
			new DedaloError('request.invalid', { publicMessage: 'Invalid map tile request' }),
			requestId,
		);
	}
	const { ref, view } = parsed.value;
	const resolved = await resolveTileSource(caller.principal, ref);
	if (resolved === null) return refuseNotFound(requestId);
	const upstream = addressOrRefusal(resolved, view, ref, requestId);
	if (upstream instanceof Response) return upstream;
	return relay({
		request,
		requestId,
		userId: caller.principal.userId,
		ref,
		resolved,
		upstream,
	});
}

/**
 * Step 4, and the one refusal that depends on the ORIGIN rather than the caller: the upstream
 * address, or why it is not asked.
 *
 *   - a view the source does not take, a zoom outside it: the caller's to cause at will, so
 *     counted, never logged — the uniform not-found;
 *   - a provider that lets a relay through only under the installation's own identity, from an
 *     installation that has none (`relayWithheld`, geo/tile_proxy/direct_tiles.ts): the closed
 *     `external.disabled`, one operator line per source a window. It comes AFTER every gate
 *     (a caller who may not read the map learns nothing of the provider) and BEFORE the memory,
 *     so a tile kept while the installation still had an identity is not served once it has
 *     none: the decision does not depend on the cache key at all. The client never asks for a
 *     built-in it was told to load directly (`features.tile_direct`); what reaches this is a
 *     stored source or a default on that provider's host, or a client older than the field.
 */
function addressOrRefusal(
	resolved: ResolvedTileSource,
	view: TileView,
	ref: TileRef,
	requestId: string,
): UpstreamRequest | Response {
	const upstream = buildUpstream(resolved.source, view);
	if (!upstream.ok) {
		incrementCounter('map_tile_no_address');
		return refuseNotFound(requestId);
	}
	if (relayWithheld(upstream.value.host)) return refuseWithheld(ref, requestId);
	return upstream.value;
}

/** The refusal of a provider this installation may not relay (see `addressOrRefusal`). */
function refuseWithheld(ref: TileRef, requestId: string): Response {
	incrementCounter('map_tile_identity_withheld');
	const error = new DedaloError('external.disabled', {
		message:
			'map tile provider requires the installation’s own identity: set a public DEDALO_HOST to relay it',
		coordinates: { why: 'installation_identity_required', source: sourceLabel(ref) },
	});
	const key = formatErrorLine(error, { subsystem: 'map_tile' });
	reportOncePerWindow(key, clockNow(), () =>
		console.warn(formatErrorLine(error, { subsystem: 'map_tile', requestId })),
	);
	return refuse(error, requestId);
}
