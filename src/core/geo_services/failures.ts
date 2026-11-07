/**
 * FROM THE TEXT DOOR'S FAILURES TO THE GEO SERVICES' — one translation table.
 *
 * `fetchGuardedText` fails in its own words: `security.ssrf_blocked` for a refused
 * address (operator disclosure that names the address in its LOG text),
 * `security.outbound_failed` with `status` for a non-2xx answer (message `HTTP
 * <n>`, the error page cancelled unread) or `reason` for the wire (`redirect`,
 * `timeout`, `idle`, `body_cap`, `transport`, `aborted`). A caller of a geo service
 * should read ONE taxonomy — the `external.*` codes — and learn which provider and
 * which service failed, not which address. This file is that translation:
 *
 *   address refused            → external.blocked_host   (a policy verdict: never retried)
 *   name did not resolve       → external.transport      (reason `dns`: the resolver failed or
 *                                answered nothing — a lookup blip, not a block; retryable)
 *   HTTP 404 / 410             → external.not_found      (the provider answered: nothing)
 *   HTTP 429 / 503             → external.http_status    (carries `retryAfterMs`)
 *   HTTP 408 / 425 / 5xx / odd → external.http_status    (transient: retryable)
 *   any other 4xx              → external.bad_config     (the provider REFUSED this request:
 *                                a 400, 401, 403… — not retryable, see below)
 *   redirect, transport        → external.transport      (a redirect re-chooses the target)
 *   timeout, idle              → external.timeout
 *   body_cap                   → external.too_large
 *   aborted (the job stopped)  → passed through UNCHANGED (it is not the provider's fault)
 *   anything else              → passed through UNCHANGED (a defect surfaces as one)
 *
 * WHY A REFUSED REQUEST IS NOT RETRYABLE. `retryable` is a property of the CODE, and the browser
 * transport re-sends a retryable failure up to five times. A 400 (the table sent something the
 * provider does not read) and a 401 or 403 (the client is blocked, or not accepted) are the
 * provider's verdict on THIS request: the same bytes get the same answer, and for a block the
 * repeats are what the provider objects to. So they leave as `external.bad_config` — registered,
 * operator-disclosure, not retryable — with the status in the LOG-ONLY coordinates. A refused
 * request asks the origin for no back-off: the limiter's pacing already holds the installation
 * to the provider's rate, and the block is the operator's to read.
 *
 * A 429 or a 503 also reports the provider's BACK-OFF (`GeoOrigin.backoffMs`): the
 * caller gives it to the limiter, which then refuses newcomers to that origin
 * quickly instead of queueing them behind a pause they cannot outlast. The text door
 * does not hand back the response headers, so a provider's own `Retry-After` cannot be
 * read; the table's back-off is the stand-in.
 *
 * The original failure rides as `cause` (log only), because its text may name the
 * address; nothing here copies that text into the new error.
 */

import { DedaloError } from '../errors/index.ts';
import { isSsrfRefusal, isUnresolvedRefusal } from '../security/ssrf_guard.ts';
import { type GeoErrorCode, geoError } from './errors.ts';
import { GEO_ORIGINS, type GeoOriginId } from './table.ts';

/** A failure to throw, and how long the origin should be left alone after it. */
export interface GeoFailure {
	readonly error: unknown;
	readonly backoffMs: number;
}

/** The text door's transport reasons that map onto an external code. */
const REASON_CODES: Readonly<Record<string, GeoErrorCode>> = Object.freeze({
	timeout: 'external.timeout',
	idle: 'external.timeout',
	body_cap: 'external.too_large',
	transport: 'external.transport',
	redirect: 'external.transport',
});

/** The statuses that mean "the record is not there". */
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);
/** The statuses that mean "come back later". */
const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** The 4xx that are about the moment, not about the request: a second send can succeed. */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** True for a 4xx that refuses THIS request (see "why a refused request is not retryable"). */
function isRefusalStatus(status: number): boolean {
	return status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status);
}

/** A failure that is thrown as it is, and asks the origin for no back-off. */
const unchanged = (error: unknown): GeoFailure => ({ error, backoffMs: 0 });

/** A non-2xx answer: not found for a gone record, otherwise an HTTP failure. */
function statusFailure(
	service: string,
	origin: GeoOriginId,
	status: number,
	cause: unknown,
): GeoFailure {
	if (GONE_STATUSES.has(status)) {
		return unchanged(geoError('external.not_found', service, origin, { status, cause }));
	}
	if (isRefusalStatus(status)) {
		return unchanged(geoError('external.bad_config', service, origin, { status, cause }));
	}
	const busy = BUSY_STATUSES.has(status);
	const backoffMs = busy ? GEO_ORIGINS[origin].backoffMs : 0;
	const error = geoError('external.http_status', service, origin, {
		status,
		cause,
		...(busy ? { retryAfterMs: backoffMs } : {}),
	});
	return { error, backoffMs };
}

/** A transport failure of the text door: mapped by its reason, or thrown as it is (a stop, say). */
function reasonFailure(
	service: string,
	origin: GeoOriginId,
	reason: string,
	error: DedaloError,
): GeoFailure {
	if (!Object.hasOwn(REASON_CODES, reason)) return unchanged(error);
	const code = REASON_CODES[reason] as GeoErrorCode;
	return unchanged(geoError(code, service, origin, { reason, cause: error }));
}

/**
 * What the text door's `security.outbound_failed` stands for. The REASON comes first: a
 * refused redirect carries the 3xx `status` too, and is a transport failure, not an
 * HTTP error of the provider.
 */
function outboundFailure(service: string, origin: GeoOriginId, error: DedaloError): GeoFailure {
	const reason = error.coordinates?.reason;
	if (typeof reason === 'string') return reasonFailure(service, origin, reason, error);
	const status = error.coordinates?.status;
	if (typeof status === 'number') return statusFailure(service, origin, status, error);
	return unchanged(error);
}

/**
 * The failure a geo service throws for what `fetchGuardedText` threw. Pure: it only
 * builds errors; the caller throws.
 */
export function classifyFailure(service: string, origin: GeoOriginId, error: unknown): GeoFailure {
	if (isUnresolvedRefusal(error)) {
		return unchanged(
			geoError('external.transport', service, origin, { reason: 'dns', cause: error }),
		);
	}
	if (isSsrfRefusal(error)) {
		return unchanged(geoError('external.blocked_host', service, origin, { cause: error }));
	}
	if (error instanceof DedaloError && error.code === 'security.outbound_failed') {
		return outboundFailure(service, origin, error);
	}
	return unchanged(error);
}
