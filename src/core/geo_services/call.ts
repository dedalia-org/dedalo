/**
 * THE GEO SERVICES' ONE ENTRY POINT.
 *
 * `callGeoService(id, params)` asks one provider one question and returns its
 * answer, typed. It is a `fetchGuardedText` CALLER with a closed table, not a door
 * (engineering/OUTBOUND_SPEC.md §2): the guard's contract — resolve and vet every
 * address, connect to the one vetted, refuse a redirect, bound the deadline and the
 * body — is the text door's, used unchanged, and what this module adds is the part a
 * single-call door cannot know:
 *
 *   1. THE REQUEST NAMES NO ADDRESS. `id` is a key of the closed table
 *      (`GEO_SERVICES`); `params` are checked against that service's grammar
 *      (`params.ts`); the URL is built from the table's origin and path
 *      (`request.ts`). A URL, a host, a path, a header or a transport is not something
 *      a caller can pass — this function takes none, and no other function of the
 *      module takes one either (this file's export set is pinned by
 *      `ssrf_one_guard_tripwire`). The test seams of the text door ride a scope no
 *      production module can open (`geo_seams.ts`), not a parameter.
 *   2. THE PROVIDER'S TERMS ARE KEPT. Every call to an origin goes through that
 *      origin's limiter (`limiters.ts`): calls in flight at once, the spacing between
 *      starts — and, for an origin that lets one call fly at a time, between the end of
 *      one call and the start of the next, so the rate holds ON THE WIRE (Nominatim: at
 *      most one a second for the whole installation) — a bounded queue and wait. After a
 *      429 or a 503 the origin is left alone for its table back-off. A slot is ONE request
 *      at the provider: the call asks the guard to move on to another address only when
 *      nothing was sent (`resendOnlyUnsent`), because the guard's default — a GET goes to
 *      the next address after any connect-level failure — would send a second request inside
 *      the same slot when a reset arrives after the first one left, and it would do so exactly
 *      when the provider is struggling. And where the provider asks for its results to be
 *      cached (Nominatim, `keepAnswerMs`), an identical question inside that time is answered
 *      from memory (`answer_memory.ts`) and costs the provider nothing.
 *   3. THE IDENTITY IS THE INSTALLATION'S (`user_agent.ts`) and no header is the
 *      caller's. No cookie, no credential, no `Referer` is ever sent.
 *   4. THE ANSWER IS CHECKED against the service's contract (`answers.ts`) and the
 *      failure is TYPED in one taxonomy (`failures.ts`), none of it naming an address.
 *   5. IDENTICAL CALLS IN THE AIR ARE ONE CALL (`flights.ts`). A re-send of the same
 *      question (the browser transport re-sends when its 5 s attempt deadline fires, and
 *      the aborted attempt is never told) joins the call already flying instead of
 *      taking a second slot and a second provider request. Each caller reads the body
 *      for itself. The flights keep nothing after the answer; the answer memory does, for
 *      the services whose provider asks for it.
 *
 * Order, and why: the request is validated BEFORE any flight, slot or socket exists, so
 * a malformed request costs the provider and the other callers nothing. The limiter's
 * slot is held for the fetch alone and given back BEFORE the answer is interpreted. The
 * pacing, the deadline and the byte ceiling are all per service and none is a parameter
 * of the call.
 *
 * Read-only by construction: every service is a GET that writes nothing here or there.
 *
 * STOPPING, stated for the two places a call runs. A background job's signal
 * (media/job_scope.ts) reaches the limiter's wait and the fetch: a stopped job leaves
 * the queue and releases its socket — unless another caller shares the flight, which
 * then goes on for it and is cancelled only when the last caller has gone. A tool action
 * in a plain HTTP request has NO signal today (the process has no `request.signal`
 * plumbing, api/dispatch.ts gate 4; `ToolActionContext.signal` exists only under the
 * background executor), so the call runs to its bounds — the wait ceiling plus the
 * service's deadline — and its re-send shares it; the sibling interactive profile can
 * demand a signal because its route is core and wraps `runWithJobSignal(request.signal)`,
 * which a tool action cannot do. When the dispatcher hands a foreground action its
 * request's signal, an action that wraps its calls in `runWithJobSignal` makes them
 * stoppable with no change here.
 */

import { currentJobSignal } from '../media/job_scope.ts';
import { fetchGuardedText } from '../security/ssrf_guard.ts';
import { recallAnswer, rememberAnswer } from './answer_memory.ts';
import { type GeoServiceResult, interpretAnswer } from './answers.ts';
import { isNotFoundFailure } from './errors.ts';
import { classifyFailure } from './failures.ts';
import { shareFlight } from './flights.ts';
import { type GeoServiceDeps, geoServiceSeams } from './geo_seams.ts';
import { geoLimiter, restAfterCallMs } from './limiters.ts';
import { invalidRequest } from './params.ts';
import { buildGeoUrl } from './request.ts';
import { GEO_ORIGINS, type GeoService, type GeoServiceId, geoServiceOf } from './table.ts';
import { geoUserAgent } from './user_agent.ts';

export type { GeoServiceResult } from './answers.ts';

/** The headers of a call: the installation's identity and the service's `Accept`. Nothing else. */
function headersOf(service: GeoService): Headers {
	return new Headers({ 'User-Agent': geoUserAgent(), Accept: service.accept });
}

/**
 * One GET inside the origin's limits: wait for a start, fetch, give the slot back —
 * with the origin's back-off when it answered 429 or 503, and at least its rest after
 * a call (see `restAfterCallMs`). Any failure leaves typed.
 */
async function fetchWithinLimits(
	id: string,
	service: GeoService,
	url: string,
	deps: GeoServiceDeps,
): Promise<string> {
	const origin = GEO_ORIGINS[service.origin];
	const rest = restAfterCallMs(service.origin);
	const release = await geoLimiter(service.origin).acquire(
		service.origin,
		deps.limiter,
		origin.minIntervalMs,
	);
	try {
		const body = await fetchGuardedText(
			url,
			{
				maxBytes: service.maxBytes,
				timeoutMs: service.timeoutMs,
				init: { method: 'GET', headers: headersOf(service) },
				// One slot is one request at the provider (header, item 2).
				resendOnlyUnsent: true,
			},
			deps,
		);
		release(rest);
		return body;
	} catch (error) {
		const failure = classifyFailure(id, service.origin, error);
		release(Math.max(failure.backoffMs, rest));
		throw failure.error;
	}
}

/** The moment, on the clock the limiter keeps (a gate's fake one, else the wall clock). */
function nowOf(deps: GeoServiceDeps): number {
	return (deps.limiter?.now ?? Date.now)();
}

/**
 * The typed result of a body, keeping the body in the answer memory when the service's
 * provider asks for its results to be cached and this body is the provider's own word: an
 * answer, or "nothing there". An answer off the contract (`external.protocol`) is never kept.
 * `fresh` is false for a body that came out of the memory already.
 */
function interpretAndKeep(
	id: string,
	service: GeoService,
	key: string,
	body: string,
	fresh: boolean,
	deps: GeoServiceDeps,
): GeoServiceResult {
	const keep = (): void => {
		if (fresh && service.keepAnswerMs !== undefined) {
			rememberAnswer(key, body, service.keepAnswerMs, nowOf(deps));
		}
	};
	try {
		const result = interpretAnswer(id as GeoServiceId, service, body);
		keep();
		return result;
	} catch (error) {
		if (isNotFoundFailure(error)) keep();
		throw error;
	}
}

/**
 * Ask one geo service one question.
 *
 * @param id a key of the closed table (`GEO_SERVICE_IDS`); anything else is refused.
 * @param params the service's parameters (see its table row); anything else is refused.
 * @returns the provider's data with the attribution it asks to be shown.
 * @throws `request.invalid_data` for an unknown id or parameters off the grammar (before
 *   any flight, slot or socket); `rate.limited` when the origin is busy;
 *   `external.not_found`, `external.http_status` (transient), `external.bad_config` (the
 *   provider refused the request: not retryable), `external.timeout`, `external.transport`,
 *   `external.too_large`, `external.protocol`, `external.blocked_host` for the provider's
 *   side; the job-stopped `security.outbound_failed` (reason `aborted`) when the running
 *   job is stopped.
 */
export async function callGeoService(id: string, params: unknown = {}): Promise<GeoServiceResult> {
	const service = geoServiceOf(id);
	if (service === null) throw invalidRequest('(unknown)', 'no such service');
	const url = buildGeoUrl(id, service, params);
	const deps = geoServiceSeams();
	const key = `${id} ${url}`;
	const kept = service.keepAnswerMs === undefined ? null : recallAnswer(key, nowOf(deps));
	const body =
		kept ??
		(await shareFlight(key, currentJobSignal(), () => fetchWithinLimits(id, service, url, deps)));
	return interpretAndKeep(id, service, key, body, kept === null, deps);
}
