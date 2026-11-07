/**
 * WHAT THE PROVIDER'S ANSWER MEANS — the one place that decides whether an upstream
 * outcome is a tile, a routine "there is none", or a fault the operator should hear about.
 *
 * A map asks for tiles over a whole viewport, and a source rarely covers all of it: a
 * stored xyz source of one region answers 404 for every tile outside it, a WMS answers an
 * exception report or no content for a bbox with no data. That is the provider doing its job.
 * Treating each of those as a FAILURE (a 503, a log line, a failure counter, a 5xx in the
 * access log) made a healthy provider look like an outage and wrote one line per missing
 * tile. So the outcomes are told apart, and each has its own response and its own noise:
 *
 *   tile          a 2xx, an exact image type, bytes that begin like it and a header that
 *                 states a size within the limits (image_bytes.ts). Relayed, and kept when the
 *                 provider's headers allow. Also a `304` to a conditional request: the tile the
 *                 proxy kept, renewed by what the `304` states (validators.ts).
 *   absent        the provider says there is no such tile: 404, 410, or a 2xx with no
 *                 content type (a 204 / an empty body). The uniform "not found" refusal;
 *                 COUNTED, never logged.
 *   not_an_image  a 2xx whose media type is not one of the four (a WMS ServiceException is
 *                 XML under a 200; a login page is HTML). Also the uniform not-found, and
 *                 not a failure: but it is also what a wrong layer name looks like for
 *                 every tile, so it is logged ONCE per source per window (tile_log.ts).
 *   fault         everything else: a status the provider should not answer a tile request
 *                 with (401, 403, 5xx, a back-off), an image whose bytes are not its type or
 *                 whose declared size is past the limits, and every failure of the door
 *                 ITSELF but one (below). One typed refusal (503 `external.transport`),
 *                 counted, and logged once per source and reason per window.
 *   busy          the proxy could not take this request NOW, which says nothing about the
 *                 provider: this person has used their share of the upstream
 *                 (principal_budget.ts, decided by the route before any call), or the
 *                 harvesting door refused it for its own capacity (`rate.limited`: the origin's
 *                 queue is full, or the start could not happen inside the wait ceiling — which
 *                 is also what an origin held off by a provider's `Retry-After` looks like).
 *                 A viewport asks tens to hundreds of tiles at once, and a busy moment is a
 *                 moment: the answer is retryable (429 with a Retry-After), counted apart from
 *                 the faults, and never reported as a failing provider.
 *
 * PURE: the clock is a parameter, and nothing here reads a request.
 */

import { type DedaloError, isDedaloError } from '../../errors/dedalo_error.ts';
import { reachedProviderBeforeRefusal, stoppedBeforeAnyRequest } from '../../harvest/abort.ts';
import type { HarvestResponse } from '../../harvest/harvest.ts';
import type { ProviderTerms } from './builtin_sources.ts';
import { freshnessMs, keepLifetimeMs } from './freshness.ts';
import {
	bareMediaType,
	bytesMatchMediaType,
	declaredImageSize,
	withinRelayedLimits,
} from './image_bytes.ts';
import { readValidators, renewedValidators, type TileValidators } from './validators.ts';

/** A verified image: its bytes and the exact media type they were checked against. */
export interface RelayedTile {
	readonly bytes: Uint8Array;
	readonly contentType: string;
}

export type TileOutcome =
	| {
			readonly kind: 'tile';
			readonly tile: RelayedTile;
			/** The freshness left for the browser: null when the provider forbade keeping the tile. */
			readonly freshMs: number | null;
			/** How long the shared memory may keep it (0: do not). */
			readonly keepMs: number;
			/** What to recognise it by when its freshness has run out; null: nothing to ask with. */
			readonly validators: TileValidators | null;
	  }
	| { readonly kind: 'absent' }
	| { readonly kind: 'not_an_image' }
	| {
			readonly kind: 'busy';
			/** Whose limit it was: the person's share (`principal_budget`) or the door's capacity (`upstream_busy`). */
			readonly why: 'principal_budget' | 'upstream_busy';
			readonly retryAfterMs: number;
			/** The door's own reason (`queue_full`, `wait_exceeded`), for the operator's line. */
			readonly doorReason?: string;
			/**
			 * The door refused a LATER hop of a redirect chain whose first hop the provider had
			 * answered (`after: request_sent`): the call reached the provider, so it stays charged.
			 */
			readonly reachedProvider?: true;
	  }
	| { readonly kind: 'fault'; readonly why: string; readonly doorCode?: string };

/** The status by which a provider says a conditional request's tile is unchanged. */
const NOT_MODIFIED = 304;

/** Statuses by which a provider says "no such tile" (a tile source's coverage is not the whole world). */
const NO_SUCH_TILE: ReadonlySet<number> = new Set([404, 410]);

/** What a refused-for-capacity answer tells the viewer to wait: a queue turns over in a moment. */
export const DOOR_BUSY_RETRY_MS = 2_000;

/** The `content_type` a door refusal reports for a 2xx that sent none (a 204, an empty answer). */
const NO_CONTENT_TYPE = 'none';

/** The tile the proxy kept and is revalidating: what a `304` is an answer FOR. */
export interface StaleTile {
	readonly bytes: Uint8Array;
	readonly contentType: string;
	readonly validators: TileValidators | null;
}

/**
 * The outcome of an answer the door returned. `mediaTypes` are the exact types the upstream
 * address allows (a WMS source: the format it declared). `revalidating` is the stale tile the
 * request asked about conditionally, if any: only then is a `304` a tile; a `304` nobody asked
 * for is a provider answering what it should not, a fault.
 */
export function judgeAnswer(
	answer: HarvestResponse,
	mediaTypes: readonly string[],
	terms: ProviderTerms,
	now: number,
	revalidating: StaleTile | null = null,
): TileOutcome {
	if (NO_SUCH_TILE.has(answer.status)) return { kind: 'absent' };
	if (answer.status === NOT_MODIFIED)
		return judgeNotModified(answer, mediaTypes, terms, now, revalidating);
	if (!answer.ok) return { kind: 'fault', why: 'status' };
	const contentType = bareMediaType(answer.contentType);
	const fault = imageFault(answer.bytes, contentType, mediaTypes);
	if (fault !== null) return fault;
	return {
		kind: 'tile',
		tile: { bytes: answer.bytes, contentType },
		freshMs: freshnessMs(answer.headers, now, terms.defaultLifetimeMs),
		keepMs: keepLifetimeMs(answer.headers, now, terms.defaultLifetimeMs),
		validators: readValidators(answer.headers),
	};
}

/**
 * The fault in a 2xx answer's body, or null when it is a tile: its type must be one the address
 * allows and its bytes that type's, and its header must state a size within the relay's limits.
 */
function imageFault(
	bytes: Uint8Array,
	contentType: string,
	mediaTypes: readonly string[],
): TileOutcome | null {
	if (!mediaTypes.includes(contentType) || !bytesMatchMediaType(bytes, contentType)) {
		return { kind: 'fault', why: 'not_the_image_it_claims' };
	}
	// A header that states no size is not an image a browser would draw; one that states a huge one
	// is a decode bomb (a few KiB of PNG can declare 30000 x 30000)
	const size = declaredImageSize(bytes, contentType);
	if (size === null) return { kind: 'fault', why: 'not_the_image_it_claims' };
	if (!withinRelayedLimits(size)) return { kind: 'fault', why: 'image_too_large' };
	return null;
}

/**
 * A `304`: the provider says the tile the proxy asked about is unchanged. The bytes are the
 * ones the proxy kept — verified when they were kept, and their type still one this address
 * allows — and the freshness is what the `304` states (RFC 9111 §4.3.4), which a conformant
 * provider repeats from its `200`.
 */
function judgeNotModified(
	answer: HarvestResponse,
	mediaTypes: readonly string[],
	terms: ProviderTerms,
	now: number,
	revalidating: StaleTile | null,
): TileOutcome {
	if (revalidating === null || !mediaTypes.includes(revalidating.contentType)) {
		return { kind: 'fault', why: 'status' };
	}
	return {
		kind: 'tile',
		tile: { bytes: revalidating.bytes, contentType: revalidating.contentType },
		freshMs: freshnessMs(answer.headers, now, terms.defaultLifetimeMs),
		keepMs: keepLifetimeMs(answer.headers, now, terms.defaultLifetimeMs),
		validators: renewedValidators(readValidators(answer.headers), revalidating.validators),
	};
}

/**
 * The outcome of a failure the door THREW. A 2xx of a media type the route did not ask for
 * (`harvest.unexpected_type`) is the provider answering something that is not a tile: with no
 * content type at all it is "nothing here" (`absent`), with another one `not_an_image`. The
 * door refusing for its own capacity (`rate.limited`) is `busy`: nothing is wrong with the
 * provider, and the viewer should ask again in a moment — and when it refused a redirect's later
 * hop, the outcome says the provider had already been asked (`reachedProvider`). Everything else the door refuses or
 * loses is a `fault`, reported by the door's code.
 */
export function judgeDoorFailure(error: unknown): TileOutcome {
	if (!isDedaloError(error)) return { kind: 'fault', why: 'door' };
	if (error.code === 'harvest.unexpected_type') return unexpectedTypeOutcome(error);
	if (error.code === 'rate.limited') return doorBusyOutcome(error);
	return { kind: 'fault', why: 'door', doorCode: error.code };
}

/** `harvest.unexpected_type`: no content type at all is "nothing here", another one is not an image. */
function unexpectedTypeOutcome(error: DedaloError): TileOutcome {
	return error.coordinates?.content_type === NO_CONTENT_TYPE
		? { kind: 'absent' }
		: { kind: 'not_an_image' };
}

/** `rate.limited`: the door refused for its own capacity, with its reason and whether the provider was already asked. */
function doorBusyOutcome(error: DedaloError): TileOutcome {
	const reason = error.coordinates?.reason;
	return {
		kind: 'busy',
		why: 'upstream_busy',
		retryAfterMs: DOOR_BUSY_RETRY_MS,
		...(typeof reason === 'string' ? { doorReason: reason } : {}),
		...(reachedProviderBeforeRefusal(error) ? { reachedProvider: true } : {}),
	};
}

/**
 * True when the call's failure proves the provider was never asked: the call was stopped while
 * it waited for its first place at the door (the viewers who needed it all left), so no request
 * of it left. The route gives such a call's token back — a call that never reached the provider
 * is not charged. A stop in the middle of a request, or after an earlier hop of a redirect
 * chain was sent, is not that.
 */
export function neverReachedProvider(error: unknown): boolean {
	return stoppedBeforeAnyRequest(error);
}
