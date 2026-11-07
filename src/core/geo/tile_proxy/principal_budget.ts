/**
 * EACH PERSON'S SHARE OF THE UPSTREAM — a token bucket per user, charged when a tile
 * request must go to the provider (a memory miss that starts a call of its own).
 *
 * WHY. The harvesting door's limiters bound an ORIGIN (four calls at a time to one host) and
 * the installation (sixteen in all); for an address an editor wrote they also bound how many
 * slots ONE person holds at once (interactive_limits.ts: three), and for one an administrator
 * chose how many places in an origin's queue (four). Nothing there bounds how MANY calls a
 * person STARTS over time, and the memory cannot: a cache miss on a distinct `{z}/{x}/{y}` is
 * the normal case. So any user who may read a geolocation field could ask OpenStreetMap for
 * distinct tiles as fast as the four slots turn over (tens per second), which is bulk tile
 * scraping under the provider's policy and risks the provider refusing the installation's whole
 * address, after which every map on it breaks. The origin cap protects the provider's capacity;
 * this protects the installation's STANDING with the provider.
 *
 * WHAT IT DOES NOT DO, so nobody reads more into it: a token counts call STARTS, not how long
 * a call holds a slot, and it does not keep one person's burst out of other people's way. The
 * burst (400) is larger than an origin's whole queue (260), so a person's own line is what
 * stands between their burst and everyone else's single tile — the door's per-holder cap, which
 * sees the places and slots, never this bucket. (Two slow hosts of an editor's own hold all
 * eight stored slots on about 1.3 starts a second, a quarter of the refill: also the door's.)
 *
 * THE RULE. A bucket holds up to `burst` tokens and refills `refillPerSecond`; a call that
 * goes upstream spends one. The numbers are a map's real shape: Leaflet asks for EVERY tile of
 * the viewport at once, 20 to 54 on a laptop or a phone, up to 160 on a 3840x2160 display at
 * one device pixel per CSS pixel (16 x 10), and a second layer doubles it; then a pan asks for
 * a row or a column at a time. So a burst of 400 lets the largest real view with two layers
 * load whole, 5 a second sustains any real pan, while a scraper walking thousands of tiles is
 * held to 5 a second, 300 a minute. A request that finds the bucket empty is refused
 * (`rate.limited`, with how long until a token) BEFORE it takes a slot of the door, so it costs
 * the other people nothing.
 *
 * WHAT IS NOT CHARGED. A tile answered from the memory (no provider call), a request that
 * JOINS a call already in the air for the same address (tile_flights.ts: it adds no provider
 * call), and a call the provider never heard of: one the harvesting door REFUSED for its own
 * capacity, or one every viewer who needed it LEFT while it waited for its place (a pan or a
 * zoom abandons every tile still queued) — `refundUpstreamToken` gives the token back, so a
 * moment of load or a few quick zoom steps do not drain the budget of the people who retry. A
 * call that did reach the provider is charged whatever it answered, a "no such tile" included —
 * and so is a redirect chain whose LATER hop the door refused after the first had been answered:
 * the proxy remembers no refusal, so the browser's own cache is what spares a repeat. Only the
 * request that starts the call pays, so a wall of kiosks on one record is one token, not one
 * per screen.
 *
 * KEYED BY THE USER (`Principal.userId`, a number the session established), never by anything
 * the client sent. State: a module Map in `module_state_tripwire`, SIZE-BOUNDED (the oldest
 * bucket goes first past `MAX_PRINCIPALS`) and SELF-DRAINING (a bucket that has refilled is
 * the same as no bucket, so the oldest ones are dropped as soon as they are full again);
 * `clearPrincipalBudgetsForTests` empties it for gate isolation. The clock is a parameter.
 */

/** Tokens a bucket holds when full: what one person may ask of the provider at once (see THE RULE). */
const BURST = 400;

/** Tokens a bucket regains each second: the sustained rate of one person. */
const REFILL_PER_SECOND = 5;

/** The most buckets kept; the oldest is dropped for a newcomer past it. */
const MAX_PRINCIPALS = 2048;

/** The limits, for the gate. */
export const PRINCIPAL_BUDGET_LIMITS = Object.freeze({
	burst: BURST,
	refillPerSecond: REFILL_PER_SECOND,
	maxPrincipals: MAX_PRINCIPALS,
});

/** One person's tokens as of `at`. */
interface Bucket {
	readonly tokens: number;
	readonly at: number;
}

/** Buckets by user id, least recently charged first. */
const BUCKETS = new Map<number, Bucket>();

export type BudgetDecision =
	| { readonly ok: true }
	| { readonly ok: false; readonly retryAfterMs: number };

/** The tokens `bucket` holds at `now` (time never runs backwards for a bucket). */
function refilled(bucket: Bucket, now: number): number {
	const elapsedSeconds = Math.max(0, now - bucket.at) / 1000;
	return Math.min(BURST, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND);
}

/** Drop the buckets that are full again, oldest first: a full bucket is no bucket. */
function dropFull(now: number): void {
	for (const [userId, bucket] of BUCKETS) {
		if (refilled(bucket, now) < BURST) return;
		BUCKETS.delete(userId);
	}
}

/** Make room for one more bucket: the full ones first, then the oldest. */
function makeRoomForBucket(now: number): void {
	dropFull(now);
	while (BUCKETS.size >= MAX_PRINCIPALS) {
		const oldest = BUCKETS.keys().next().value;
		if (oldest === undefined) return;
		BUCKETS.delete(oldest);
	}
}

/**
 * Spend one token of `userId`'s bucket at `now`: `{ok: true}`, or `{ok: false}` with how
 * long until a token is back. A refused call spends nothing.
 */
export function takeUpstreamToken(userId: number, now: number): BudgetDecision {
	const known = BUCKETS.get(userId);
	const tokens = known === undefined ? BURST : refilled(known, now);
	if (tokens < 1) {
		return { ok: false, retryAfterMs: Math.ceil(((1 - tokens) / REFILL_PER_SECOND) * 1000) };
	}
	BUCKETS.delete(userId);
	if (known === undefined) makeRoomForBucket(now);
	BUCKETS.set(userId, { tokens: tokens - 1, at: now });
	return { ok: true };
}

/**
 * Give back the token `takeUpstreamToken` spent for a call that never reached the provider.
 * The bucket moves to `now` with one more token (never past the burst); a person with no
 * bucket (it refilled to full and was dropped) has nothing to give back.
 */
export function refundUpstreamToken(userId: number, now: number): void {
	const known = BUCKETS.get(userId);
	if (known === undefined) return;
	BUCKETS.delete(userId);
	BUCKETS.set(userId, { tokens: Math.min(BURST, refilled(known, now) + 1), at: now });
}

/** Buckets held right now — observability for the gates. */
export function principalBudgetsTracked(): number {
	return BUCKETS.size;
}

/** Forget every bucket — TEST ISOLATION ONLY. */
export function clearPrincipalBudgetsForTests(): void {
	BUCKETS.clear();
}
