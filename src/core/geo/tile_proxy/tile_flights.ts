/**
 * ONE PROVIDER CALL FOR EVERY VIEWER ASKING THE SAME TILE AT THE SAME TIME.
 *
 * A kiosk wall, or a dozen people on one record, open the same map within a second: the same
 * tiles at the same instant, none of them in the memory yet. Without this each of them goes
 * to the provider for the very same image. With it the first request starts a FLIGHT (the
 * door's queue wait, the fetch and the verification) and every identical request that
 * arrives while it is in the air JOINS it, so the provider is asked once and each viewer is
 * answered from that one outcome.
 *
 * WHAT IS SHARED, and why that is safe. The outcome of asking the provider for ONE UPSTREAM
 * ADDRESS: an image, or "there is none", or a typed fault. The key is that address (public
 * provider data, the same question whoever asks; it may carry a provider token, so it lives
 * in memory only and is never logged). It is joined only AFTER the route's gates, exactly
 * like the memory (tile_cache.ts): a caller who failed a gate never reaches here, so the
 * flight is no way to learn what someone else asked. Each viewer then builds its OWN
 * response from the outcome; nothing request-specific is inside it.
 *
 * WHO PAYS. Only the request that STARTS a flight spends a token of the person's budget
 * (`admit`, principal_budget.ts): a request that joins adds no provider call. A start
 * `admit` refuses starts nothing.
 *
 * STOPPING. The flight runs under a signal of its own, not the first viewer's: a viewer who
 * panned away leaves ITS wait without cancelling a call another viewer still needs, and the
 * flight is cancelled only when the LAST holder has gone (then the door's queue place is
 * given up and the socket released, which is the reason the door insists on a job signal).
 * A viewer already gone when it arrives never starts or joins one.
 *
 * The same shape as the geo services' flights (`geo_services/flights.ts`), kept apart on
 * purpose: its answer is a text body for a closed table of services, this one is an image
 * outcome for a tile route, and neither should be able to clear, join or fill the other's map.
 *
 * Lifecycle of the one map: SELF-DRAINING. An entry is deleted the moment its flight settles
 * or when its last holder leaves; the flights keep nothing after an answer (the memory beside
 * them keeps tiles). Its size is bounded by what the door lets be in the air (a person's own line
 * at an origin holds 512, an origin's queue 256 and the installation's 512; past that the door
 * refuses the call and it settles at once) and, before the door, by the people's budgets: a
 * flight starts only on a token. `clearTileFlightsForTests` empties it for gate isolation.
 */

import { jobStoppedError, untilJobStopped } from '../../harvest/abort.ts';
import { runWithJobSignal } from '../../media/job_scope.ts';

/** Calls in the air, by upstream address. */
const FLIGHTS = new Map<string, Flight<unknown>>();

/** One call in the air, and who is waiting on it. */
class Flight<T> {
	/** Viewers still waiting for the outcome. */
	holders = 0;
	settled = false;
	/** The signal the call runs under: aborted when the last holder leaves. */
	readonly stop = new AbortController();
	/** The outcome; `work` reports a failure as an outcome, so it does not reject. */
	readonly done: Promise<T>;

	constructor(key: string, work: () => Promise<T>) {
		this.done = runWithJobSignal(this.stop.signal, work).finally(() => {
			this.settled = true;
			if (FLIGHTS.get(key) === this) FLIGHTS.delete(key);
		});
		// A holder that left no longer observes the outcome; the flight's own failure (a defect,
		// since `work` reports its failures as outcomes) must not surface as an unhandled
		// rejection because of it.
		this.done.catch(() => {});
	}
}

/** The last holder of a flight has gone: cancel what is left of it. */
function leave(key: string, flight: Flight<unknown>): void {
	flight.holders--;
	if (flight.holders > 0 || flight.settled) return;
	if (FLIGHTS.get(key) === flight) FLIGHTS.delete(key);
	flight.stop.abort();
}

/**
 * The outcome of the call `key` stands for: the flight already in the air, or the one `work`
 * starts. `admit` is asked only when there is NO flight to join; it returns an outcome to
 * refuse with (nothing is started), or null to go ahead. `signal` is THIS viewer's stop
 * (`request.signal`): it ends this viewer's wait with the job-stopped failure and nothing else.
 */
export async function shareTileFlight<T>(
	key: string,
	signal: AbortSignal | undefined,
	admit: () => T | null,
	work: () => Promise<T>,
): Promise<T> {
	if (signal?.aborted === true) throw jobStoppedError('limiter');
	let flight = FLIGHTS.get(key) as Flight<T> | undefined;
	if (flight === undefined) {
		const refused = admit();
		if (refused !== null) return refused;
		flight = new Flight<T>(key, work);
		FLIGHTS.set(key, flight as Flight<unknown>);
	}
	flight.holders++;
	try {
		return await untilJobStopped(flight.done, signal, 'limiter');
	} finally {
		leave(key, flight as Flight<unknown>);
	}
}

/** Flights in the air right now — observability for the gates. */
export function tileFlightsInProgress(): number {
	return FLIGHTS.size;
}

/** Forget every flight — TEST ISOLATION ONLY. A flight in the air keeps running for its holders. */
export function clearTileFlightsForTests(): void {
	FLIGHTS.clear();
}
