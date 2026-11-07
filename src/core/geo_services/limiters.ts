/**
 * THE GEO SERVICES' PACING — one per-key limiter per provider, with state of its own.
 *
 * A provider's terms are a property of its ORIGIN: Nominatim asks for one request a
 * second from the whole installation, however many users, tools and services ask. So
 * the limiter is built per origin from the table's numbers (`GEO_ORIGINS`: calls in
 * flight at once, the spacing between starts, the queue, the longest a caller waits)
 * and every service of that origin goes through the same one. The primitive is the
 * harvesting door's (`core/harvest/origin_limiter.ts`) — one limiter implementation in
 * the engine — and each instance here closes over its own state: nothing in it is
 * shared with the harvest pace, the interactive profile, or another provider.
 *
 * The table is CLOSED, so the state is too: five limiters, each keyed by its one
 * origin id (a constant, never a user, a session, a language or a URL), built when the
 * module loads. Lifecycle: SELF-DRAINING — a key is forgotten the moment nobody holds
 * or awaits it and its spacing has passed, and until then it holds ONE drain timer
 * however many callers a back-off refuses meanwhile — and `clearGeoServicesForTests`
 * empties all of them for a gate. The binding is module state that outlives every request, so
 * `module_state_tripwire` lists it with that lifecycle.
 *
 * A caller that cannot get a slot inside its ceiling is refused with the limiter's own
 * `rate.limited` (reasons `queue_full` / `wait_exceeded`), quickly: that is also how a
 * provider's back-off after a 429 shows to a newcomer (the table keeps every origin's
 * back-off longer than its wait ceiling, so the refusal is always the fast one). A
 * stopped job (the running job's signal) leaves the queue at once and hands its place on.
 *
 * THE RATE IS KEPT ON THE WIRE, not only between starts. A start is reserved BEFORE the
 * guard resolves the name, connects and handshakes, and how long that takes differs from
 * one call to the next (a cold lookup before one, a warm one before the next), so two
 * starts a second apart can reach the provider half a second apart. For an origin that
 * lets ONE call fly at a time (Nominatim, DARE, open-elevation) the spacing is therefore
 * also counted from the END of the previous call (`restAfterCallMs`): the next start waits
 * a full interval after the slot is given back, and since the wire moment of a call lies
 * before its slot comes back, the gap between two requests at the provider is at least the
 * interval whatever the resolver and the handshake did. An origin that lets several calls
 * fly at once keeps the start-to-start spacing alone: it states no rate of that kind.
 */

import { createOriginLimiter, type OriginLimiter } from '../harvest/origin_limiter.ts';
import { clearAnswerMemoryForTests } from './answer_memory.ts';
import { clearGeoFlightsForTests } from './flights.ts';
import { GEO_ORIGIN_IDS, GEO_ORIGINS, type GeoOriginId } from './table.ts';

const GEO_LIMITERS: Readonly<Record<GeoOriginId, OriginLimiter>> = Object.freeze(
	Object.fromEntries(
		GEO_ORIGIN_IDS.map((id) => [
			id,
			createOriginLimiter({
				maxConcurrent: GEO_ORIGINS[id].maxConcurrent,
				maxQueue: GEO_ORIGINS[id].maxQueue,
				maxWaitMs: GEO_ORIGINS[id].maxWaitMs,
				minIntervalMs: GEO_ORIGINS[id].minIntervalMs,
			}),
		]),
	) as Record<GeoOriginId, OriginLimiter>,
);

/** The limiter of one provider. */
export function geoLimiter(origin: GeoOriginId): OriginLimiter {
	return GEO_LIMITERS[origin];
}

/**
 * How long an origin is left alone once a call has ENDED (its slot given back): the
 * interval of an origin that lets one call fly at a time, else none. See the header.
 */
export function restAfterCallMs(origin: GeoOriginId): number {
	const { maxConcurrent, minIntervalMs } = GEO_ORIGINS[origin];
	return maxConcurrent === 1 ? minIntervalMs : 0;
}

/** Origins with a key currently tracked, across all providers — observability for the gates. */
export function geoOriginsTracked(): number {
	return GEO_ORIGIN_IDS.reduce((total, id) => total + GEO_LIMITERS[id].tracked(), 0);
}

/**
 * Forget every key of every provider, every call in the air and every kept answer — TEST
 * ISOLATION ONLY.
 */
export function clearGeoServicesForTests(): void {
	for (const id of GEO_ORIGIN_IDS) GEO_LIMITERS[id].clear();
	clearGeoFlightsForTests();
	clearAnswerMemoryForTests();
}
