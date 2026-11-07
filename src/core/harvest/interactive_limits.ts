/**
 * THE INTERACTIVE PROFILE'S NUMBERS AND ITS OWN STATE.
 *
 * `interactiveFetch` (`harvest.ts`) is the harvesting door's second, closed profile:
 * a request a person is waiting for (a map tile, an image that frames a record),
 * relayed by a core route. Its limits are short because a viewer is waiting, and
 * its pacing is a CAP, not a queue of one: see `origin_limiter.ts` for why the
 * default pace (`pacing.ts`) cannot serve it and is not loosened for it.
 *
 * The state here is the profile's own — five `OriginLimiter` instances, closed over
 * their own maps — and nothing in it is shared with the default pace: a tile
 * storm cannot delay a catalogue crawl, and a crawl cannot delay a tile. Keys are
 * origins (`siteKey`), two constants for the shared counts and — for the per-holder caps
 * only — the opaque name of whoever is waiting (`InteractiveRequest.holder`, a user id the
 * route established), alone or paired with the origin; a holder's key exists only while it
 * holds or awaits a slot, so the key set is bounded by the slots and queues below and an idle
 * one holds nothing. The instances are module state that outlives every request, so
 * `module_state_tripwire` lists each with its lifecycle: self-draining, emptied for a gate by
 * `clearInteractiveForTests`.
 *
 * FIVE BUDGETS, because the limit that matters differs by who chose the host and who is
 * asking: the origin's own (one host cannot take the installation), the global one (the
 * installation cannot be fanned out past it), for an address an EDITOR wrote a stored-address
 * budget inside the global one, so the hosts a record's editor picks can never hold every
 * global slot (`InteractiveAddressFrom`) — and, inside THAT, a per-holder one: no single
 * person holds more than `INTERACTIVE_MAX_STORED_PER_HOLDER` stored slots at once. The
 * stored budget bounds what editors as a class can take; the per-holder one bounds what ONE
 * editor can, so a person with two slow hosts of their own (4 per origin x 2 = the whole
 * stored budget) cannot starve every other viewer's stored source on their own. Several
 * colluding sessions can still fill it: that needs several accounts that may edit a record,
 * which is the cost of the attack, not a way round it.
 *
 * THE FIFTH is the fair share of an origin the administrators chose. A registry origin (the
 * built-in OpenStreetMap, an ontology default) is the one EVERY viewer of the installation
 * draws on, and its queue is first in, first out: a person whose view asks for hundreds of
 * tiles would otherwise be the whole queue, and everyone else's single tile would be refused
 * `queue_full` until they drained. So a registry request first takes a place in its holder's
 * OWN line for that origin (`INTERACTIVE_MAX_REGISTRY_PER_HOLDER`, as many as the origin has
 * slots: a lone viewer is not slowed at all), waits there holding NOTHING, and joins the
 * origin's queue only with a place; each person is at most that many places deep in it, so
 * a newcomer is served after at most that many of anyone else's, however big the other's view
 * is. The line is the person's alone (`INTERACTIVE_MAX_HOLDER_QUEUE`, more than the budget
 * that feeds it): it can crowd out nobody.
 *
 * Every number is a constant of the profile and no caller can raise one: a request
 * may only ask for LESS (a smaller body, a shorter deadline) or for a longer
 * spacing, and is clamped to the ceilings below. A tool can never reach the
 * profile at all (`ssrf_one_guard_tripwire`, engineering/OUTBOUND_SPEC.md §3.1).
 */

import {
	createOriginLimiter,
	type LimiterDeps,
	type LimiterRelease,
	type LimiterSlot,
} from './origin_limiter.ts';

const MIB = 1024 * 1024;

/** Default body ceiling: a map tile is tens of KiB, a busy one a few hundred. */
export const INTERACTIVE_DEFAULT_MAX_BYTES = 1 * MIB;
/** No caller may raise the ceiling past this: one large rendered map image. */
export const INTERACTIVE_MAX_BYTES = 8 * MIB;
/** Default TOTAL time for one hop, its body included. */
export const INTERACTIVE_DEFAULT_TIMEOUT_MS = 10_000;
/** The longest total a caller may ask for. */
export const INTERACTIVE_MAX_TIMEOUT_MS = 20_000;
/** Default time the body may stall without a single byte before the peer is dropped. */
export const INTERACTIVE_DEFAULT_IDLE_TIMEOUT_MS = 5_000;

/** Requests in flight to ONE origin at once (a browser's own per-host cap is 6). */
export const INTERACTIVE_MAX_CONCURRENT = 4;
/**
 * Callers that may wait for a slot at ONE origin; the next is refused (`rate.limited`).
 * Sized for a map, not for a page: Leaflet asks for EVERY tile of the viewport at once, and a
 * wall display (3840x2160 at one device pixel per CSS pixel) shows up to 16 x 10 = 160 tiles
 * of ONE layer (another layer is usually another host, with a queue of its own), and a second
 * viewer arriving in the same moment is the rest of this size. The wait ceiling below is the
 * other half of the bound: four slots turning over at the usual tens of milliseconds a tile
 * clear a queue of this size well inside it, and a queue that could not drain is cut by the
 * ceiling anyway.
 */
export const INTERACTIVE_MAX_QUEUE = 256;
/** Requests in flight across ALL origins: many distinct origins cannot fan out past it. */
export const INTERACTIVE_MAX_TOTAL = 16;
/** Callers that may wait for a slot across all origins (two such viewers at once). */
export const INTERACTIVE_MAX_TOTAL_QUEUE = 512;
/**
 * Of those, the most that origins an EDITOR chose (`addressFrom: 'stored'`) hold at once.
 * The per-origin cap bounds one host, the global cap bounds the installation, but neither
 * bounds WHO picked the hosts: stored hosts are written by whoever may edit a record, so
 * four slow ones of their own (4 per origin x 4) would otherwise hold all 16 slots for a
 * whole hop and starve every other viewer, the closed registry's origins included. Half
 * the global budget, so the registry always keeps the other half.
 */
export const INTERACTIVE_MAX_STORED_TOTAL = 8;
/** Callers that may wait for one of those: each already holds an origin slot, so this bounds how many origins can queue. */
export const INTERACTIVE_MAX_STORED_QUEUE = 32;
/**
 * Of the stored budget, the most ONE holder (a person) has in flight at once. Under the per-origin
 * cap (4) on purpose: a person with a single slow host leaves a slot for everyone else who
 * reads the same source, and one with two cannot hold the 8 stored slots on their own.
 */
export const INTERACTIVE_MAX_STORED_PER_HOLDER = 3;
/**
 * Callers of ONE holder that may wait for one of those — for a stored address, across every
 * origin; for a registry address, at ONE origin: a full viewport of one person (160 tiles, two
 * layers 320) waits here, holding nothing, so a person at their cap parks neither an origin slot
 * nor a shared one. The queue is the holder's own: it can crowd out nobody. It is larger than a
 * person's whole burst of provider calls (`principal_budget.ts`), so a person's own storm is
 * paced by the line, and only the wait ceiling ends it.
 */
export const INTERACTIVE_MAX_HOLDER_QUEUE = 512;
/**
 * Of ONE registry origin (an address an administrator chose), the most places ONE holder has at
 * once — in flight at the origin or queued in it. As many as the origin has slots, on purpose:
 * unlike an editor's host, an origin everybody shares is not one to leave a slot free on, and
 * a lone viewer then loads at the origin's full speed. What the cap buys is the QUEUE: the rest
 * of a person's tiles wait in their own line (`INTERACTIVE_MAX_HOLDER_QUEUE`), holding no place
 * of the origin's, so the queue of 256 is never one person's.
 */
export const INTERACTIVE_MAX_REGISTRY_PER_HOLDER = INTERACTIVE_MAX_CONCURRENT;
/**
 * The longest a caller waits for its start, per hop: its origin's queue, the shared
 * queues (the global one, and for a stored address the stored one) and the spacing
 * together. ONE ceiling covers all of them (every limiter counts from the moment the
 * request first queued), so this number is the whole wait.
 */
export const INTERACTIVE_MAX_WAIT_MS = 10_000;
/** The longest spacing a start may owe the later ones at its origin (a provider's own terms). */
export const INTERACTIVE_MAX_INTERVAL_MS = 5_000;
/** The longest a provider's `Retry-After` is honoured for. */
export const INTERACTIVE_MAX_BACKOFF_MS = 30_000;
/** What a 429/503 that names no usable `Retry-After` still holds the origin off for. */
export const INTERACTIVE_FALLBACK_BACKOFF_MS = 2_000;

/**
 * Where an interactive request's address came from — a CLOSED field of the request, because
 * the budget a hop draws from depends on who chose its host:
 *
 *   - `'stored'`: an address a record's editor wrote (a stored source). Counts against
 *     `INTERACTIVE_MAX_STORED_TOTAL` as well as the global cap.
 *   - `'registry'`: one the installation's administrators chose — the core's closed
 *     built-in registry or an ontology default (`properties.map_sources`). Counts against
 *     the global cap only, which stored addresses can never fill.
 *
 * The route names it, and a route that labels an editor's address `'registry'` defeats
 * the split: the door cannot tell, so the route owes it truthfully and its own gate drives
 * it (OUTBOUND_SPEC.md §3.1).
 */
export type InteractiveAddressFrom = 'stored' | 'registry';

/** The same two values, for the run-time check (`interactiveFetch` is called by TypeScript, but a gate drives it untyped). */
export const INTERACTIVE_ADDRESS_FROM: readonly InteractiveAddressFrom[] = Object.freeze([
	'stored',
	'registry',
]);

/** The longest a holder's name may be (the route sends `user:<id>`). */
export const INTERACTIVE_MAX_HOLDER_LENGTH = 64;

/** The one key the global limiter counts under. */
const ALL_ORIGINS = 'interactive';
/** The one key the stored-address limiter counts under. */
const STORED_ORIGINS = 'stored';

const perOrigin = createOriginLimiter({
	maxConcurrent: INTERACTIVE_MAX_CONCURRENT,
	maxQueue: INTERACTIVE_MAX_QUEUE,
	maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
});

const acrossOrigins = createOriginLimiter({
	maxConcurrent: INTERACTIVE_MAX_TOTAL,
	maxQueue: INTERACTIVE_MAX_TOTAL_QUEUE,
	maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
});

const acrossStored = createOriginLimiter({
	maxConcurrent: INTERACTIVE_MAX_STORED_TOTAL,
	maxQueue: INTERACTIVE_MAX_STORED_QUEUE,
	maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
});

const perHolder = createOriginLimiter({
	maxConcurrent: INTERACTIVE_MAX_STORED_PER_HOLDER,
	maxQueue: INTERACTIVE_MAX_HOLDER_QUEUE,
	maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
});

const perHolderAtOrigin = createOriginLimiter({
	maxConcurrent: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
	maxQueue: INTERACTIVE_MAX_HOLDER_QUEUE,
	maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
});

/**
 * The key one holder's places at one origin are counted under. An origin (`siteKey`) never
 * contains a space, so the first space ends it whatever the holder's name is: two different
 * pairs can never share a key.
 */
function holderAtOriginKey(origin: string, holder: string): string {
	return `${origin} ${holder}`;
}

/**
 * A start at `origin`: first the holder's own place (for a STORED address the holder's cap
 * across all its hosts, for a REGISTRY address its cap at THIS origin), then the origin's slot,
 * then — for a stored address — one of the few the stored addresses share, then one of the
 * global few, then the spacing. The order matters four times.
 *
 *   - The holder's place comes FIRST, so a person at their cap waits in their own queue
 *     holding nothing: it parks no origin slot (which another reader of the same source
 *     needs) and no shared one, and it takes no position in the origin's queue — which is
 *     what keeps one person's hundreds of tiles from being the whole of a registry origin's
 *     line.
 *   - A request holds its origin's slot while it waits for the shared ones, so a saturated
 *     origin can never use the shared queues to starve the rest.
 *   - The stored budget comes BEFORE the global one, so a stored request waiting for its
 *     budget holds no global slot: the narrower budget is the one it can be starved of, and
 *     a global slot is never parked behind it. A stored request that does hold a global slot
 *     holds a stored one too, so stored requests hold at most `INTERACTIVE_MAX_STORED_TOTAL`
 *     global slots, however many origins an editor writes.
 *   - The spacing is reserved LAST, holding all of them. Reserved earlier, the starts
 *     of one origin would be spread out, queue together at the global limiter and be
 *     released by it in one breath: the provider would see them at the same instant,
 *     which is exactly when a viewer fires many requests. The price is that a request
 *     keeps its shared slots while it waits out its spacing — bounded by the ceiling,
 *     and by the origin's own concurrency cap.
 *
 * One ceiling covers all of it: every queue and the spacing count from when the request
 * first queued.
 */
export async function acquireInteractive(
	origin: string,
	minIntervalMs: number,
	addressFrom: InteractiveAddressFrom,
	holder: string,
	deps: LimiterDeps,
): Promise<LimiterRelease> {
	const holderSlot =
		addressFrom === 'stored'
			? await perHolder.acquireSlot(holder, deps)
			: await perHolderAtOrigin.acquireSlot(holderAtOriginKey(origin, holder), deps);
	const held: LimiterSlot[] = [holderSlot];
	try {
		const originSlot = await perOrigin.acquireSlot(origin, deps, holderSlot.since);
		held.push(originSlot);
		if (addressFrom === 'stored') {
			held.push(await acrossStored.acquireSlot(STORED_ORIGINS, deps, originSlot.since));
		}
		held.push(await acrossOrigins.acquireSlot(ALL_ORIGINS, deps, originSlot.since));
		await originSlot.start(minIntervalMs);
		return (backoffMs) => releaseAll(held, originSlot, backoffMs);
	} catch (error) {
		// A refusal at any step gives back every place already held.
		releaseAll(held, null);
		throw error;
	}
}

/**
 * Give back every slot held, newest first. The origin's slot is the one that carries a
 * provider's back-off, so it is released with it (`originSlot`; null when none was taken yet).
 * Every release is idempotent, so a failed `start` (which returned the origin's slot itself)
 * can be followed by this without freeing anything twice.
 */
function releaseAll(
	held: readonly LimiterSlot[],
	originSlot: LimiterSlot | null,
	backoffMs?: number,
): void {
	for (const slot of [...held].reverse()) {
		if (slot === originSlot) slot.release(backoffMs);
		else slot.release();
	}
}

/** Where one holder stands at one REGISTRY origin — observability for the gates. */
export function interactiveHolderAtOriginState(
	holder: string,
	origin: string,
): {
	readonly holders: number;
	readonly inFlight: number;
	readonly waiting: number;
} {
	const key = holderAtOriginKey(origin, holder);
	return {
		holders: perHolderAtOrigin.tracked(),
		inFlight: perHolderAtOrigin.inFlight(key),
		waiting: perHolderAtOrigin.waiting(key),
	};
}

/** Where one holder stands across its STORED hosts — observability for the gates (slots held and callers waiting, and holders tracked). */
export function interactiveHolderState(holder: string): {
	readonly holders: number;
	readonly inFlight: number;
	readonly waiting: number;
} {
	return {
		holders: perHolder.tracked(),
		inFlight: perHolder.inFlight(holder),
		waiting: perHolder.waiting(holder),
	};
}

/** Where the profile stands — observability for the gates. */
export function interactiveState(origin: string): {
	readonly origins: number;
	readonly inFlight: number;
	readonly waiting: number;
	readonly total: number;
	readonly totalWaiting: number;
	readonly stored: number;
	readonly storedWaiting: number;
} {
	return {
		origins: perOrigin.tracked(),
		inFlight: perOrigin.inFlight(origin),
		waiting: perOrigin.waiting(origin),
		total: acrossOrigins.inFlight(ALL_ORIGINS),
		totalWaiting: acrossOrigins.waiting(ALL_ORIGINS),
		stored: acrossStored.inFlight(STORED_ORIGINS),
		storedWaiting: acrossStored.waiting(STORED_ORIGINS),
	};
}

/** Forget the profile's state — TEST ISOLATION ONLY (a gate must not inherit another's slots). */
export function clearInteractiveForTests(): void {
	perOrigin.clear();
	acrossOrigins.clear();
	acrossStored.clear();
	perHolder.clear();
	perHolderAtOrigin.clear();
}
