/**
 * A PER-KEY LIMITER: at most N requests in flight per key, optionally spaced
 * start to start, with a bounded queue and a bounded wait.
 *
 * A request that a PERSON is waiting for (a map tile, a geocoding lookup) cannot
 * take the harvesting pace (`pacing.ts`): that one is strictly serial per origin
 * with a 3 s floor, which is right for a crawler and unusable for a viewer that
 * asks for a dozen tiles at once. It cannot be loosened either — the default pace
 * is the contract every acquisition tool was written against. So an interactive
 * caller gets this primitive, built from a FACTORY (`createOriginLimiter`), each
 * instance closing over its own state: an instance can never share a queue, a
 * count or a spacing with the harvest pace or with another instance.
 *
 * TWO PHASES, so that a caller who needs more than this limiter can take its START
 * last. `acquireSlot` waits for a slot (the queue); `slot.start(spacingMs)` then
 * reserves the start and waits out the spacing. A caller that also queues at another
 * limiter (the interactive profile's global one) takes that slot BETWEEN the two, so
 * the spacing is counted from the moment the request really can go — a start reserved
 * before a second queue would be released by it together with its neighbours. `acquire`
 * is both phases for the caller that needs only this limiter.
 *
 * What one instance guarantees, per key (an origin, `siteKey` in `follow.ts`):
 *
 *   - `maxConcurrent` requests hold a slot at once; the rest QUEUE, first in,
 *     first out, and at most `maxQueue` of them — the next caller is refused at
 *     once (`rate.limited`), never parked without bound;
 *   - SPACING IS OWED FORWARD. A start with `spacingMs` S keeps every LATER start of
 *     the key at least S away from it, whatever S those later starts ask for
 *     themselves (not end to start: the point is to cap the rate a provider sees,
 *     not to serialize it — `maxConcurrent` does that). It is not a promise about the
 *     gap BEFORE that start: after a start that asked 0, a start that asks 1000 may
 *     go at once. So a provider's terms are a property of the ORIGIN, and a caller
 *     with terms passes them on every request to that origin. A start is RESERVED
 *     when `start` is called, so starts reserved together are spread over time and
 *     the cap holds across `await`s; a reservation whose caller leaves before its
 *     start (a stopped job, a refusal at a second limiter) is given back, so a
 *     caller who never started owes nobody anything. A reserved start can be moved
 *     LATER while it waits (see the back-off below), never earlier, and the order
 *     and the spacing between reserved starts hold when it is;
 *   - a caller never waits longer than `maxWaitMs` for its start, counted from
 *     `since` — when it began waiting, which a second limiter inherits (`LimiterSlot`)
 *     so ONE ceiling covers both queues and the spacing: a start that cannot happen
 *     inside it is refused the moment that is known (`rate.limited`) — which is also
 *     how a provider's `Retry-After` shows up: while it runs, newcomers fail fast
 *     instead of queueing behind a pause they cannot outlast;
 *   - a release may carry a back-off (`Retry-After`): no start before it ends — a start
 *     ALREADY reserved and pausing when the back-off lands included. When that pause
 *     ends the start is checked against what is owed NOW: it waits again if the back-off
 *     (or a start ahead of it that had to wait again) moved it, and is refused
 *     (`wait_exceeded`, its slot given back) if that carries it past its ceiling. A pause
 *     is not cut short when the back-off lands, so the refusal comes when it ends, never
 *     later than the start's own planned time;
 *   - the waits honour the running job's signal (`media/job_scope.ts`): a stopped
 *     caller leaves the queue or its pause at once, gives its slot back (and the next
 *     in line gets it), and leaves no abort listener and no wait timer behind. A job
 *     already stopped when its turn comes does not start.
 *
 * Lifecycle: SELF-DRAINING. A key's entry is deleted once nobody holds or awaits
 * it and its spacing has passed, so an idle key holds nothing; `clear()` empties
 * an instance for test isolation. Keys are origins, never request identity. Every
 * timer is unref'd and cleared however the wait ends (the drain timer re-arms
 * itself instead). A key owing spacing or a back-off holds ONE drain timer, however
 * many callers come and go meanwhile: every newcomer refused during a back-off settles
 * the key again, and a timer per refusal would have made the number of live timers
 * proportional to the request rate times the back-off (30 s for some providers) — and
 * a refused caller that retries would have fed it. The pending timer re-arms itself
 * for whatever is still owed when it fires; one that is overdue and has not fired is
 * treated as lost, and replaced.
 *
 * Failures: `rate.limited` (operator disclosure — the key rides only in the log),
 * reasons `queue_full` / `wait_exceeded`; a stopped job is the harvesting door's
 * `security.outbound_failed` reason `aborted`, stage `limiter`.
 *
 * A limiter bound to a module-level name is module state that outlives every
 * request: `module_state_tripwire` lists each one with its lifecycle.
 */

import { DedaloError } from '../errors/index.ts';
import { currentJobSignal } from '../media/job_scope.ts';
import { jobStoppedError, untilJobStopped } from './abort.ts';

export interface OriginLimiterOptions {
	/** Requests holding a slot at once, per key. At least 1. */
	readonly maxConcurrent: number;
	/** Callers that may wait for a slot, per key; one more is refused. 0: none may wait. */
	readonly maxQueue: number;
	/** The longest a caller waits for its start: queue, spacing and a second limiter's queue together. */
	readonly maxWaitMs: number;
	/** The default spacing a start owes later starts on one key (0: none). A caller may ask for its own. */
	readonly minIntervalMs?: number;
}

/** Injectable clock, sleep and timers. Tests supply them; production supplies none. */
export interface LimiterDeps {
	readonly now?: () => number;
	/** The spacing pause. Raced against the job's stop signal whatever it does with it. */
	readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	/** Schedules the idle-key drain (a real, unref'd timer by default). */
	readonly setTimer?: (callback: () => void, ms: number) => void;
	/** Starts the wait ceiling's timer and returns its cancel (a real, unref'd timer by default). */
	readonly startTimer?: (callback: () => void, ms: number) => () => void;
}

/**
 * Gives the slot back. `backoffMs` (a provider's `Retry-After`) holds the next start
 * of this key until it has passed. A second call is a no-op.
 */
export type LimiterRelease = (backoffMs?: number) => void;

export type LimiterRefusal = 'queue_full' | 'wait_exceeded';

/** A slot a caller holds before its start: the first phase's result. */
export interface LimiterSlot {
	/**
	 * When the caller began waiting, on the `now` clock of its deps. Hand it to the
	 * next limiter's `acquireSlot` so one ceiling covers both.
	 */
	readonly since: number;
	/**
	 * Reserve this caller's START and wait it out; resolves when it may go. `spacingMs`
	 * (default: the instance's) is what this start owes the later ones. Once only.
	 * Refused (`rate.limited`) or stopped, the slot is given back BEFORE the failure is
	 * thrown, so a failed start leaves nothing to release.
	 */
	readonly start: (spacingMs?: number) => Promise<void>;
	readonly release: LimiterRelease;
}

/** Where a caller stands: waiting for a slot, holding one it has not used yet, or out. */
type WaiterState = 'queued' | 'admitted' | 'gone';

interface Waiter {
	readonly since: number;
	/** Settles when the waiter is granted a slot (resolve) or refused (reject). */
	readonly ticket: Promise<void>;
	state: WaiterState;
	admit: () => void;
	refuse: (error: Error) => void;
}

/** A start reserved and not yet taken: when it goes, and until when it owes spacing. */
interface Reservation {
	/** Moved later (never earlier) when a back-off lands while this start waits. */
	startAt: number;
	endsAt: number;
	/** What this start owes the later ones: `endsAt` is always `startAt` plus this. */
	readonly spacingMs: number;
}

interface KeyState {
	/** Slots held (granted and not yet released). */
	active: number;
	readonly queue: Waiter[];
	/** No start before this: a provider's back-off (`Retry-After`). */
	holdUntil: number;
	/** The spacing owed by the starts that have happened. */
	spacedUntil: number;
	/** Starts reserved and not yet taken — each held by a slot; returned if its caller leaves. */
	readonly reserved: Reservation[];
	/** When this key's pending drain timer is due (0: none armed): at most ONE per key. */
	drainDueAt: number;
}

function invalid(what: string, value: unknown): DedaloError {
	return new DedaloError('internal.invariant', {
		message: `origin limiter: ${what} is invalid, got ${String(value)}`,
		coordinates: { value: String(value) },
	});
}

function wholeAtLeast(what: string, value: number, least: number): number {
	if (!Number.isInteger(value) || value < least) throw invalid(what, value);
	return value;
}

function finiteAtLeastZero(what: string, value: number): number {
	if (!Number.isFinite(value) || value < 0) throw invalid(what, value);
	return value;
}

function refusal(reason: LimiterRefusal, key: string): DedaloError {
	const why =
		reason === 'queue_full'
			? 'its queue is full'
			: 'its next start is further off than a caller may wait';
	return new DedaloError('rate.limited', {
		message: `origin limiter: ${key} is busy (${why})`,
		coordinates: { reason, key },
	});
}

function unrefTimer(callback: () => void, ms: number): void {
	setTimeout(callback, ms).unref?.();
}

function realTimer(callback: () => void, ms: number): () => void {
	const timer = setTimeout(callback, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

const NO_CANCEL = (): void => {};

function clockOf(deps: LimiterDeps): () => number {
	return deps.now ?? Date.now;
}

function newWaiter(since: number): Waiter {
	let admit: Waiter['admit'] = () => {};
	let refuse: Waiter['refuse'] = () => {};
	const ticket = new Promise<void>((resolve, reject) => {
		admit = resolve;
		refuse = reject;
	});
	// A refusal can land before anyone awaits the ticket (the caller left first).
	ticket.catch(() => {});
	return { since, ticket, state: 'queued', admit, refuse };
}

/** The earliest moment the next start of this key may go: back-off, spacing owed, starts reserved. */
function nextStartOf(state: KeyState): number {
	const owed = Math.max(state.holdUntil, state.spacedUntil);
	return state.reserved.reduce((latest, held) => Math.max(latest, held.endsAt), owed);
}

/**
 * The earliest moment `reservation` may go NOW: the back-off, the spacing owed by the
 * starts that happened, and the starts reserved AHEAD of it in the line (the array is in
 * reservation order) — never those behind it, which wait for this one.
 */
function earliestStartOf(state: KeyState, reservation: Reservation): number {
	let earliest = Math.max(state.holdUntil, state.spacedUntil);
	for (const held of state.reserved) {
		if (held === reservation) break;
		earliest = Math.max(earliest, held.endsAt);
	}
	return earliest;
}

function forgetReservation(state: KeyState, reservation: Reservation): void {
	const at = state.reserved.indexOf(reservation);
	if (at >= 0) state.reserved.splice(at, 1);
}

/** The start happened: its reservation becomes spacing owed. */
function startTaken(state: KeyState, reservation: Reservation): void {
	forgetReservation(state, reservation);
	state.spacedUntil = Math.max(state.spacedUntil, reservation.endsAt);
}

/**
 * Wait out the spacing. The stop signal always wins the race (`untilJobStopped`
 * removes its listener), even against a `sleep` seam that ignores it; a real timer
 * is cleared however the wait ends.
 */
async function pause(
	ms: number,
	deps: LimiterDeps,
	signal: AbortSignal | undefined,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const elapsed =
		deps.sleep?.(ms, signal) ??
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
			timer.unref?.();
		});
	try {
		await untilJobStopped(elapsed, signal, 'limiter');
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export class OriginLimiter {
	private readonly states = new Map<string, KeyState>();
	private readonly maxConcurrent: number;
	private readonly maxQueue: number;
	private readonly maxWaitMs: number;
	private readonly minIntervalMs: number;

	constructor(options: OriginLimiterOptions) {
		this.maxConcurrent = wholeAtLeast('maxConcurrent', options.maxConcurrent, 1);
		this.maxQueue = wholeAtLeast('maxQueue', options.maxQueue, 0);
		this.maxWaitMs = finiteAtLeastZero('maxWaitMs', options.maxWaitMs);
		this.minIntervalMs = finiteAtLeastZero('minIntervalMs', options.minIntervalMs ?? 0);
	}

	/**
	 * Wait for a start on `key` and HOLD its slot until the returned release is
	 * called (success or failure alike). `spacingMs` replaces the instance's default
	 * spacing for THIS start. Both phases — see the header.
	 */
	async acquire(
		key: string,
		deps: LimiterDeps = {},
		spacingMs: number = this.minIntervalMs,
	): Promise<LimiterRelease> {
		finiteAtLeastZero('spacingMs', spacingMs);
		const slot = await this.acquireSlot(key, deps);
		await slot.start(spacingMs);
		return slot.release;
	}

	/**
	 * The first phase: wait for a slot on `key` and hold it. `since` is when the
	 * caller began waiting, when an earlier limiter already made it wait (default: now).
	 */
	async acquireSlot(key: string, deps: LimiterDeps = {}, since?: number): Promise<LimiterSlot> {
		const signal = currentJobSignal();
		if (signal?.aborted === true) throw jobStoppedError('limiter');
		const state = this.stateFor(key);
		const waiter = this.join(key, state, since ?? clockOf(deps)(), deps);
		await this.waitForSlot(key, state, waiter, deps, signal);
		return this.slotOf(key, state, waiter, deps);
	}

	/** Keys currently tracked — observability for the gates. */
	tracked(): number {
		return this.states.size;
	}

	/** Slots held on `key` right now (0 for an unknown key). */
	inFlight(key: string): number {
		return this.states.get(key)?.active ?? 0;
	}

	/** Callers waiting for a slot on `key` right now (0 for an unknown key). */
	waiting(key: string): number {
		return this.states.get(key)?.queue.length ?? 0;
	}

	/**
	 * Forget every key — TEST ISOLATION ONLY. A caller already holding a slot keeps
	 * it (its release still works); one already queued keeps its place.
	 */
	clear(): void {
		this.states.clear();
	}

	private stateFor(key: string): KeyState {
		const known = this.states.get(key);
		if (known !== undefined) return known;
		const created: KeyState = {
			active: 0,
			queue: [],
			holdUntil: 0,
			spacedUntil: 0,
			reserved: [],
			drainDueAt: 0,
		};
		this.states.set(key, created);
		return created;
	}

	/** Join the queue and let a free slot take the caller at once; past `maxQueue` it is refused. */
	private join(key: string, state: KeyState, since: number, deps: LimiterDeps): Waiter {
		const waiter = newWaiter(since);
		state.queue.push(waiter);
		this.pump(key, state, clockOf(deps));
		if (waiter.state === 'queued' && state.queue.length > this.maxQueue) {
			this.abandon(key, state, waiter, deps);
			throw refusal('queue_full', key);
		}
		return waiter;
	}

	/**
	 * Wait for the waiter's slot, leaving at once when the job stops. The ceiling's
	 * timer is cancelled however the wait ends.
	 */
	private async waitForSlot(
		key: string,
		state: KeyState,
		waiter: Waiter,
		deps: LimiterDeps,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const cancelTimer = this.armWaitCeiling(key, state, waiter, deps);
		try {
			await untilJobStopped(waiter.ticket, signal, 'limiter');
		} catch (error) {
			this.abandon(key, state, waiter, deps);
			throw error;
		} finally {
			cancelTimer();
		}
	}

	/**
	 * Hand free slots to the waiters in line. A waiter whose start could not fall inside
	 * its wait ceiling even now (a back-off, a spacing backlog) is refused here — without
	 * taking the slot — which is what makes a back-off fail fast.
	 */
	private pump(key: string, state: KeyState, now: () => number): void {
		while (state.active < this.maxConcurrent) {
			const waiter = state.queue.shift();
			if (waiter === undefined) return;
			if (Math.max(now(), nextStartOf(state)) - waiter.since > this.maxWaitMs) {
				waiter.state = 'gone';
				waiter.refuse(refusal('wait_exceeded', key));
				continue;
			}
			state.active++;
			waiter.state = 'admitted';
			waiter.admit();
		}
	}

	/** The timer that refuses a waiter still in the queue when its ceiling arrives. */
	private armWaitCeiling(
		key: string,
		state: KeyState,
		waiter: Waiter,
		deps: LimiterDeps,
	): () => void {
		if (waiter.state !== 'queued') return NO_CANCEL;
		const remainingMs = Math.max(0, waiter.since + this.maxWaitMs - clockOf(deps)());
		return (deps.startTimer ?? realTimer)(() => {
			if (waiter.state !== 'queued') return;
			waiter.refuse(refusal('wait_exceeded', key));
			this.abandon(key, state, waiter, deps);
		}, remainingMs);
	}

	/**
	 * A caller that will not use its place: out of the queue, or — already granted —
	 * its slot given back to the next in line.
	 */
	private abandon(key: string, state: KeyState, waiter: Waiter, deps: LimiterDeps): void {
		if (waiter.state === 'queued') {
			const at = state.queue.indexOf(waiter);
			if (at >= 0) state.queue.splice(at, 1);
		} else if (waiter.state === 'admitted') {
			state.active--;
			this.pump(key, state, clockOf(deps));
		}
		waiter.state = 'gone';
		this.settle(key, state, deps);
	}

	private slotOf(key: string, state: KeyState, waiter: Waiter, deps: LimiterDeps): LimiterSlot {
		const release = this.releaseOf(key, state, deps);
		let begun = false;
		const start = async (spacingMs: number = this.minIntervalMs): Promise<void> => {
			if (begun) throw invalid('start', 'a second call');
			begun = true;
			try {
				await this.startNow(key, state, waiter.since, spacingMs, deps);
			} catch (error) {
				release();
				throw error;
			}
		};
		return { since: waiter.since, start, release };
	}

	/** The second phase: reserve the start, wait it out, take it. A failure returns the reservation. */
	private async startNow(
		key: string,
		state: KeyState,
		since: number,
		spacingMs: number,
		deps: LimiterDeps,
	): Promise<void> {
		finiteAtLeastZero('spacingMs', spacingMs);
		const signal = currentJobSignal();
		if (signal?.aborted === true) throw jobStoppedError('limiter');
		const now = clockOf(deps);
		const reservation = this.reserve(key, state, since, spacingMs, now);
		try {
			await this.waitOut(key, state, since, reservation, deps, signal);
		} catch (error) {
			forgetReservation(state, reservation);
			throw error;
		}
		startTaken(state, reservation);
	}

	/**
	 * Wait until the reserved start may go. What lands DURING a pause can move it: a
	 * release that carries a provider's back-off, or a start ahead of this one that had to
	 * wait again. So when a pause ends the start is checked against what is owed now — a
	 * later floor makes it wait again (refused when that passes its ceiling), an unmoved one
	 * lets it go. It terminates: the floor only moves forward, and a check that finds it
	 * unmoved ends the loop, whatever the clock did during the pause.
	 */
	private async waitOut(
		key: string,
		state: KeyState,
		since: number,
		reservation: Reservation,
		deps: LimiterDeps,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const now = clockOf(deps);
		for (;;) {
			const delayMs = reservation.startAt - now();
			if (delayMs > 0) await pause(delayMs, deps, signal);
			const earliest = earliestStartOf(state, reservation);
			if (earliest <= reservation.startAt) return;
			if (earliest - since > this.maxWaitMs) throw refusal('wait_exceeded', key);
			reservation.startAt = earliest;
			reservation.endsAt = earliest + reservation.spacingMs;
		}
	}

	/** Reserve the next start of the key, or refuse a caller whose start falls past its ceiling. */
	private reserve(
		key: string,
		state: KeyState,
		since: number,
		spacingMs: number,
		now: () => number,
	): Reservation {
		const startAt = Math.max(now(), nextStartOf(state));
		if (startAt - since > this.maxWaitMs) throw refusal('wait_exceeded', key);
		const reservation: Reservation = { startAt, endsAt: startAt + spacingMs, spacingMs };
		state.reserved.push(reservation);
		return reservation;
	}

	private releaseOf(key: string, state: KeyState, deps: LimiterDeps): LimiterRelease {
		const now = clockOf(deps);
		let released = false;
		return (backoffMs = 0) => {
			if (released) return;
			released = true;
			state.active--;
			if (Number.isFinite(backoffMs) && backoffMs > 0) {
				state.holdUntil = Math.max(state.holdUntil, now() + backoffMs);
			}
			this.pump(key, state, now);
			this.settle(key, state, deps);
		};
	}

	/**
	 * Forget a key once nobody holds or awaits it and its spacing has passed. A key
	 * still spaced re-arms its own drain, so no idle entry is ever stranded.
	 */
	private settle(key: string, state: KeyState, deps: LimiterDeps): void {
		if (state.active > 0 || state.queue.length > 0) return;
		if (this.states.get(key) !== state) return;
		const now = clockOf(deps)();
		const waitMs = nextStartOf(state) - now;
		if (waitMs <= 0) this.states.delete(key);
		else this.armDrain(key, state, deps, now, waitMs);
	}

	/**
	 * Arm the key's drain unless one is already pending. Owed time only grows while a key
	 * is idle (a back-off and spacing never move earlier, and nothing is reserved without a
	 * slot), so a pending timer never fires later than the key's spacing needs, and when it
	 * fires early or finds more owed it re-arms itself. A pending timer that is overdue
	 * and has not run is lost, not pending.
	 */
	private armDrain(
		key: string,
		state: KeyState,
		deps: LimiterDeps,
		now: number,
		waitMs: number,
	): void {
		if (state.drainDueAt > now) return;
		state.drainDueAt = now + waitMs;
		(deps.setTimer ?? unrefTimer)(() => {
			state.drainDueAt = 0;
			this.settle(key, state, deps);
		}, waitMs);
	}
}

/** A new limiter with state of its own — see the header. */
export function createOriginLimiter(options: OriginLimiterOptions): OriginLimiter {
	return new OriginLimiter(options);
}
