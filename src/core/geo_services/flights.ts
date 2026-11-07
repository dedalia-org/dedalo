/**
 * ONE CALL FOR EVERY CALLER ASKING THE SAME THING AT THE SAME TIME.
 *
 * A tool action runs inside an HTTP request, and the browser transport re-sends a
 * request when its own 5 s attempt deadline fires (`api/dispatch.ts`, gate 4): the
 * aborted attempt's handler is never told, so it keeps its place in the provider's
 * queue and then calls the provider, while its re-send takes a place of its own and
 * calls the provider again. Two upstream requests for one question, a provider
 * budget spent twice, and a legitimate retry that can find the queue full of its own
 * ancestors.
 *
 * So the calls are SHARED. A call is keyed by the service and the address the engine
 * built for it (`request.ts`): public data, the same for everyone, no user, session or
 * language in the key. The first caller starts a FLIGHT — the limiter wait, the fetch
 * and the slot — and every identical call that arrives while it is in the air JOINS it
 * instead of taking a slot of its own; each caller then reads the answer for itself
 * (`call.ts` interprets the body per caller, so no two callers hold the same parsed
 * object). A failure is shared the same way: one refusal, one timeout, one 429 for
 * everyone who asked.
 *
 * STOPPING. The flight runs under a signal of its own, not the first caller's: a stopped
 * caller must leave ITS wait without cancelling a call that another still needs
 * (`untilJobStopped` leaves the shared promise alone), and the flight is cancelled only
 * when the LAST caller has gone — then the limiter's queue place is given up, the socket
 * released and the slot handed on. A caller that carries no signal (a plain HTTP request:
 * the process has no `request.signal` plumbing) is never "stopped", so a flight it joined
 * runs to its bound: the limiter's `maxWaitMs` plus the service's deadline.
 *
 * Lifecycle of the one map: SELF-DRAINING. An entry is deleted the moment its flight
 * settles, or when its last caller leaves; the flights keep nothing after an answer (they
 * are NOT a cache — a provider that asks for its results to be kept has them kept by the
 * answer memory beside them, `answer_memory.ts`, and everyone else is asked again), and
 * `clearGeoFlightsForTests` empties it for a gate. Keys are bounded by the closed table
 * and by what a caller can have in flight at once. `module_state_tripwire` lists the map
 * with this lifecycle.
 */

import { jobStoppedError, untilJobStopped } from '../harvest/abort.ts';
import { runWithJobSignal } from '../media/job_scope.ts';

/** Calls in the air, by service and built address. */
const FLIGHTS = new Map<string, Flight>();

/** One call in the air, and who is waiting on it. */
class Flight {
	/** Callers still waiting for the answer. */
	holders = 0;
	settled = false;
	/** The signal the call runs under: aborted when the last holder leaves. */
	readonly stop = new AbortController();
	/** The body, or the typed failure; never rejects unobserved. */
	readonly done: Promise<string>;

	constructor(key: string, work: () => Promise<string>) {
		this.done = runWithJobSignal(this.stop.signal, work).finally(() => {
			this.settled = true;
			if (FLIGHTS.get(key) === this) FLIGHTS.delete(key);
		});
		// A holder that left (stopped) no longer observes the outcome; the flight's own
		// failure must not surface as an unhandled rejection because of it.
		this.done.catch(() => {});
	}
}

/** The caller that was the last to wait on a flight no longer needs it: cancel what is left of it. */
function leave(key: string, flight: Flight): void {
	flight.holders--;
	if (flight.holders > 0 || flight.settled) return;
	if (FLIGHTS.get(key) === flight) FLIGHTS.delete(key);
	flight.stop.abort();
}

/**
 * The outcome of the call `key` stands for: the flight already in the air, or the one
 * `work` starts. `signal` is THIS caller's stop (the running job's, undefined for a plain
 * request): it ends this caller's wait with the job-stopped failure and nothing else.
 *
 * @param key service id + built address; equal keys are the same question.
 * @param work the call itself (limiter, fetch, slot), started at most once per flight.
 */
export async function shareFlight(
	key: string,
	signal: AbortSignal | undefined,
	work: () => Promise<string>,
): Promise<string> {
	if (signal?.aborted === true) throw jobStoppedError('limiter');
	let flight = FLIGHTS.get(key);
	if (flight === undefined) {
		flight = new Flight(key, work);
		FLIGHTS.set(key, flight);
	}
	flight.holders++;
	try {
		return await untilJobStopped(flight.done, signal, 'limiter');
	} finally {
		leave(key, flight);
	}
}

/** Flights in the air right now — observability for the gates. */
export function geoFlightsInProgress(): number {
	return FLIGHTS.size;
}

/** Forget every flight — TEST ISOLATION ONLY. A flight in the air keeps running for its holders. */
export function clearGeoFlightsForTests(): void {
	FLIGHTS.clear();
}
