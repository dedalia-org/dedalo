/**
 * Leaving a wait when the job is stopped — the one helper every wait of the
 * harvesting door goes through (the per-origin queue and pace in `pacing.ts`,
 * the shared robots.txt load in `robots.ts`, the interactive profile's slot queue
 * and spacing pause in `origin_limiter.ts`).
 *
 * A wait here is on something SHARED: a queue place other jobs stand behind, a
 * robots.txt fetch other jobs await. So a stopped job must leave its OWN wait at
 * once, without cancelling the shared thing — `untilJobStopped` races the caller's
 * await against the job's signal and leaves the awaited promise untouched.
 */

import { DedaloError, isDedaloError } from '../errors/index.ts';
import { untilAborted } from '../security/ssrf_guard.ts';

/**
 * The failure a stopped job's wait ends with. The same code and reason the
 * primitive (`fetchPinnedHop`) uses when the job is stopped mid-request, so a
 * caller reads one "the job was stopped" whatever it was waiting on.
 */
export function jobStoppedError(stage: string): DedaloError {
	return new DedaloError('security.outbound_failed', {
		message: `harvest: the job was stopped while waiting (${stage})`,
		coordinates: { reason: 'aborted', stage },
	});
}

/** The stage a wait for the interactive profile's places (queue, spacing) reports. */
const LIMITER_STAGE = 'limiter';
/** The coordinate `stoppedAfterRequest` adds: an earlier hop of the same call had been sent. */
const AFTER_REQUEST = 'request_sent';

/**
 * The same stop, for a wait that came AFTER a request of the same call had already gone out
 * (the second hop of a redirect chain): it names that, so a reader that asks "did the provider
 * hear from us?" is not told "no". Same code, reason and stage; one more coordinate.
 */
export function stoppedAfterRequest(error: unknown): unknown {
	if (!isStoppedAtLimiter(error)) return error;
	return taggedAfterRequest(error, `${error.message}, after an earlier hop was sent`);
}

/**
 * `error` again, tagged `after: request_sent`: the same code and EVERY field it carried (details,
 * coordinates, publicMessage, retryAfterMs, extend) — only the log message gains the clause and the
 * original rides as `cause`. A field dropped here would change what the wire or a reader sees.
 */
function taggedAfterRequest(error: DedaloError, message: string): DedaloError {
	return new DedaloError(error.code, {
		message,
		details: error.details,
		coordinates: { ...error.coordinates, after: AFTER_REQUEST },
		publicMessage: error.publicMessage,
		retryAfterMs: error.retryAfterMs,
		extend: error.extend,
		cause: error,
	});
}

/**
 * A refusal of a LATER hop's wait for its place, tagged as `stoppedAfterRequest` tags a stop: the
 * job stopped (`stoppedAfterRequest`), or the limiter refused it (`rate.limited`, `queue_full` /
 * `wait_exceeded`) — the second hop of a redirect chain whose first hop the provider already
 * answered. Same code, same coordinates plus `after`; any other failure is returned as it is.
 * A reader asking "did the provider hear from this call?" (`reachedProviderBeforeRefusal`) is
 * told yes, so a route that charges each call that reached the provider does not refund it.
 */
export function refusedAfterRequest(error: unknown): unknown {
	if (isStoppedAtLimiter(error)) return stoppedAfterRequest(error);
	if (!isDedaloError(error) || error.code !== 'rate.limited') return error;
	return taggedAfterRequest(error, `${error.message}, after an earlier hop was sent`);
}

/** True when the failure says an earlier hop of the same call had been sent (`refusedAfterRequest`). */
export function reachedProviderBeforeRefusal(error: unknown): boolean {
	return isAfterRequest(error);
}

/**
 * True for the failure `jobStoppedError('limiter')` makes — a stop that ended a wait for a place at
 * the interactive profile's limiters (stage `limiter`) ONLY. A stop of any other wait (`queue`,
 * `pace`, `robots`, …) or of a request in flight (`resolve` / `connect` / `body`) is not matched.
 */
function isStoppedAtLimiter(error: unknown): error is DedaloError {
	return (
		isDedaloError(error) &&
		error.code === 'security.outbound_failed' &&
		error.coordinates?.reason === 'aborted' &&
		error.coordinates.stage === LIMITER_STAGE
	);
}

/**
 * True when the call was stopped while it waited for its FIRST place at the interactive profile's
 * limiters (a queue, the spacing pause), so no request of it ever left: the provider was never
 * asked. A stop in the middle of a request (stage `resolve` / `connect` / `body`), or a wait after
 * an earlier hop of a redirect chain had been sent (`stoppedAfterRequest`), is not that.
 */
export function stoppedBeforeAnyRequest(error: unknown): boolean {
	return isStoppedAtLimiter(error) && !isAfterRequest(error);
}

function isAfterRequest(error: unknown): boolean {
	return isDedaloError(error) && error.coordinates?.after === AFTER_REQUEST;
}

/**
 * `work`, or `jobStoppedError(stage)` as soon as `signal` aborts — whichever comes
 * first. The guard's one race primitive (`untilAborted`, core/security/ssrf_guard.ts)
 * with this door's typed reason: the abort listener never outlives the call, and
 * `work` itself is never cancelled (others may be waiting on it too).
 */
export function untilJobStopped<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
	stage: string,
): Promise<T> {
	return untilAborted(work, signal, () => jobStoppedError(stage));
}
