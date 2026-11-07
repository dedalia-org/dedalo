/**
 * THE GEO SERVICES' TYPED FAILURES — the `external.*` codes of the registry, named
 * by service and origin, never by address.
 *
 * A caller (a tool action, a job) and the browser's retry design read a failure by
 * its CODE — and the browser re-sends a retryable one up to five times, so the code
 * decides whether a provider that has already refused us is asked again:
 *   - `external.not_found` (the provider answered and there is nothing there — never
 *     retried);
 *   - `external.http_status` (the provider answered with a TRANSIENT error — a 5xx, a 408
 *     or a 425 — retryable, and a 429 or 503 carries `retryAfterMs`);
 *   - `external.bad_config` (the provider REFUSED this request — any other 4xx: a 400 our
 *     table should not have sent, a 401 or 403 that says the client is blocked or unknown —
 *     NOT retryable: sending the same bytes again cannot change the answer, and a block is
 *     exactly where repeated sends hurt; the operator reads the status in the log);
 *   - `external.timeout`, `external.transport` (no usable answer, a failed DNS lookup
 *     included — retryable), `external.too_large` (an answer past the service's byte
 *     ceiling), `external.protocol` (an answer that is not the shape the service's
 *     contract says);
 *   - `external.blocked_host` (the address guard judged the provider's resolved address
 *     non-public — a policy verdict, never retried);
 *   - `rate.limited` (our own pacing: the limiter's refusal, passed through unchanged).
 *
 * DISCLOSURE. All of them are `operator` disclosure: the wire sentence is the
 * registry's fixed English. What a failure knows rides only in the LOG-ONLY
 * `coordinates` — the service id, the origin id, the HTTP status, the transport
 * reason — and `Error.message` repeats those. Never a URL (its query holds what a
 * cataloguer typed), never a host name, never a resolved address: the guard's own
 * refusal names the address it refused, and `cause` keeps it for the operator's log
 * only.
 */

import { DedaloError } from '../errors/index.ts';
import type { GeoOriginId } from './table.ts';

/** The registry codes a geo service fails with (its own pacing excepted: `rate.limited`). */
export type GeoErrorCode =
	| 'external.bad_config'
	| 'external.blocked_host'
	| 'external.http_status'
	| 'external.not_found'
	| 'external.protocol'
	| 'external.timeout'
	| 'external.too_large'
	| 'external.transport';

/** What a failure adds to its code. */
export interface GeoErrorDetail {
	/** The HTTP status the provider answered, when it answered one. */
	readonly status?: number;
	/** The transport reason the shared door gave (`timeout`, `body_cap`…), when it gave one. */
	readonly reason?: string;
	/** How long the provider should be left alone, for a 429 or a 503. */
	readonly retryAfterMs?: number;
	/** The failure behind this one (log only, never serialized). */
	readonly cause?: unknown;
}

/** One line of log grammar per code. */
const LOG_TEXT: Readonly<Record<GeoErrorCode, string>> = Object.freeze({
	'external.bad_config': 'the provider refused the request',
	'external.blocked_host': 'the address guard refused the provider',
	'external.http_status': 'the provider answered with an error status',
	'external.not_found': 'the provider has nothing for this request',
	'external.protocol': 'the answer is not the shape the service returns',
	'external.timeout': 'the provider did not answer in time',
	'external.too_large': 'the answer exceeded the service ceiling',
	'external.transport': 'the provider could not be reached',
});

/** The coordinates of a failure: scalars only, none of them an address. */
function coordinatesOf(
	service: string,
	origin: GeoOriginId,
	detail: GeoErrorDetail,
): Record<string, string | number> {
	const coordinates: Record<string, string | number> = { service, origin };
	if (detail.status !== undefined) coordinates.status = detail.status;
	if (detail.reason !== undefined) coordinates.reason = detail.reason;
	return coordinates;
}

/** A geo service's failure, typed. */
export function geoError(
	code: GeoErrorCode,
	service: string,
	origin: GeoOriginId,
	detail: GeoErrorDetail = {},
): DedaloError {
	const status = detail.status === undefined ? '' : ` (HTTP ${detail.status})`;
	return new DedaloError(code, {
		message: `geo service ${service}: ${LOG_TEXT[code]}${status}`,
		coordinates: coordinatesOf(service, origin, detail),
		...(detail.retryAfterMs === undefined ? {} : { retryAfterMs: detail.retryAfterMs }),
		...(detail.cause === undefined ? {} : { cause: detail.cause }),
	});
}

/**
 * True when `error` is the typed "the provider has nothing for this request" — a provider's
 * word, not a failure of the call (the answer memory keeps such a 200 like any answer).
 */
export function isNotFoundFailure(error: unknown): boolean {
	return error instanceof DedaloError && error.code === 'external.not_found';
}
