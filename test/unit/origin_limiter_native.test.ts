/**
 * THE PER-KEY LIMITER (src/core/harvest/origin_limiter.ts) — every clause of its
 * header, driven.
 *
 * NO WALL CLOCK. The clock, the spacing sleep, the drain timer and the wait-ceiling
 * timer are seams: a negative claim ("the third caller has NOT started") is checked
 * after `settle()`, which drains every pending microtask — deterministic, because
 * nothing here waits on a timer or on I/O.
 *
 * The limiter is the interactive harvesting profile's pacing (engineering/
 * OUTBOUND_SPEC.md §3.1) and the geo services' per-origin limiter, so what is pinned
 * here is the primitive; the profile's numbers and its wiring are pinned in
 * harvest_door_native.test.ts.
 *
 * The timer claims of the header (every timer unref'd, the wait ceiling's and the
 * pause's cleared however the wait ends) are measured against FAKE global timers
 * (`withFakeTimers`): the defaults — the paths production runs — are driven, and
 * nothing waits on a wall clock.
 */

import { describe, expect, test } from 'bun:test';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	createOriginLimiter,
	type LimiterDeps,
	type LimiterRelease,
	type OriginLimiter,
	type OriginLimiterOptions,
} from '../../src/core/harvest/origin_limiter.ts';
import { runWithJobSignal } from '../../src/core/media/job_scope.ts';

interface FakeClock {
	readonly deps: LimiterDeps;
	readonly clock: { now: number };
	/** Every spacing pause, in ms (each advances the clock by itself). */
	readonly slept: number[];
	/** Drain timers scheduled (never run unless a test runs them). */
	readonly drains: { callback: () => void; ms: number }[];
	/** Wait-ceiling timers still armed: fire one to let its ceiling arrive. */
	readonly ceilings: { fire: () => void; ms: number; cancelled: boolean }[];
}

function fakeClock(): FakeClock {
	const clock = { now: 1_000_000 };
	const slept: number[] = [];
	const drains: FakeClock['drains'] = [];
	const ceilings: FakeClock['ceilings'] = [];
	return {
		clock,
		slept,
		drains,
		ceilings,
		deps: {
			now: () => clock.now,
			sleep: async (ms) => {
				slept.push(ms);
				clock.now += ms;
			},
			setTimer: (callback, ms) => {
				drains.push({ callback, ms });
			},
			startTimer: (callback, ms) => {
				const armed = { fire: callback, ms, cancelled: false };
				ceilings.push(armed);
				return () => {
					armed.cancelled = true;
				};
			},
		},
	};
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Pauses the test lifts by hand: unlike `fakeClock`'s sleep (which moves the clock at
 * once), these let several callers be paused at the same time, in a known order.
 */
function manualPauses(clock: { now: number }) {
	const waiting: { at: number; wake: () => void }[] = [];
	const sleep: NonNullable<LimiterDeps['sleep']> = (ms) =>
		new Promise<void>((wake) => {
			waiting.push({ at: clock.now + ms, wake });
		});
	return {
		sleep,
		pending: () => waiting.length,
		/** Move the clock on and wake the pauses that came due. */
		advance: async (ms: number) => {
			clock.now += ms;
			for (const due of waiting.filter((pause) => pause.at <= clock.now)) {
				waiting.splice(waiting.indexOf(due), 1);
				due.wake();
			}
			await settle();
		},
	};
}

interface FakeTimer {
	readonly callback: () => void;
	readonly ms: number;
	unrefd: boolean;
	cleared: boolean;
	fired: boolean;
	unref: () => FakeTimer;
}

/**
 * Run `scenario` with the global `setTimeout`/`clearTimeout` replaced by recorders that
 * schedule NOTHING: a test fires a timer by hand, so the DEFAULT timer paths of the
 * limiter (its real ceiling and pause timers) are driven with no wall clock. The
 * originals come back whatever the scenario does.
 */
async function withFakeTimers(
	scenario: (timers: FakeTimer[], fire: (timer: FakeTimer | undefined) => void) => Promise<void>,
): Promise<void> {
	const timers: FakeTimer[] = [];
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	globalThis.setTimeout = ((callback: () => void, ms?: number) => {
		const timer: FakeTimer = {
			callback,
			ms: ms ?? 0,
			unrefd: false,
			cleared: false,
			fired: false,
			unref: () => {
				timer.unrefd = true;
				return timer;
			},
		};
		timers.push(timer);
		return timer;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((timer: FakeTimer) => {
		timer.cleared = true;
	}) as unknown as typeof clearTimeout;
	const fire = (timer: FakeTimer | undefined): void => {
		if (timer === undefined) throw new Error('no such timer');
		timer.fired = true;
		timer.callback();
	};
	try {
		await scenario(timers, fire);
	} finally {
		globalThis.setTimeout = realSet;
		globalThis.clearTimeout = realClear;
	}
}

/** Every timer the scenario made was unref'd, and none is left armed (cleared or fired). */
function expectNoTimerLeft(timers: readonly FakeTimer[]): void {
	expect(timers.length).toBeGreaterThan(0); // anti-vacuity: the scenario did make timers
	for (const timer of timers) {
		expect(timer.unrefd, `a ${timer.ms} ms timer was not unref'd`).toBe(true);
		expect(timer.cleared || timer.fired, `a ${timer.ms} ms timer was left armed`).toBe(true);
	}
}

async function failureOf(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (isDedaloError(error)) return error;
		throw new Error(`untyped failure: ${String(error)}`);
	}
	throw new Error('expected a failure, the promise resolved');
}

/** Start an acquire and report, after a settle, whether it has been granted. */
function watch(limiter: OriginLimiter, key: string, deps: LimiterDeps, spacingMs?: number) {
	const state: { release: LimiterRelease | null; error: unknown } = { release: null, error: null };
	const promise = (
		spacingMs === undefined ? limiter.acquire(key, deps) : limiter.acquire(key, deps, spacingMs)
	).then(
		(release) => {
			state.release = release;
		},
		(error: unknown) => {
			state.error = error;
		},
	);
	return { state, promise };
}

const BASE: OriginLimiterOptions = { maxConcurrent: 2, maxQueue: 2, maxWaitMs: 10_000 };

describe('origin limiter — the concurrency cap and the queue', () => {
	test('at most maxConcurrent callers hold a slot; the rest wait in order', async () => {
		const limiter = createOriginLimiter(BASE);
		const { deps } = fakeClock();
		const first = await limiter.acquire('a', deps);
		const second = await limiter.acquire('a', deps);
		expect(limiter.inFlight('a')).toBe(2);

		const third = watch(limiter, 'a', deps);
		const fourth = watch(limiter, 'a', deps);
		await settle();
		expect(third.state.release).toBeNull();
		expect(fourth.state.release).toBeNull();
		expect(limiter.waiting('a')).toBe(2);

		first();
		await settle();
		expect(third.state.release).not.toBeNull(); // first in, first out
		expect(fourth.state.release).toBeNull();
		expect(limiter.inFlight('a')).toBe(2);

		second();
		await settle();
		expect(fourth.state.release).not.toBeNull();
		third.state.release?.();
		fourth.state.release?.();
		await Promise.all([third.promise, fourth.promise]);
		expect(limiter.inFlight('a')).toBe(0);
	});

	test('keys are independent: a saturated key does not slow another', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const { deps } = fakeClock();
		await limiter.acquire('a', deps);
		const other = await limiter.acquire('b', deps);
		expect(limiter.inFlight('a')).toBe(1);
		expect(limiter.inFlight('b')).toBe(1);
		other();
	});

	test('instances share nothing: the same key on two limiters is two queues', async () => {
		const one = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const two = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const { deps } = fakeClock();
		await one.acquire('a', deps);
		await two.acquire('a', deps); // would wait forever if the state were shared
		expect(one.inFlight('a')).toBe(1);
		expect(two.inFlight('a')).toBe(1);
	});

	test('the caller past maxQueue is refused at once, and nothing it did lingers', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, maxQueue: 1 });
		const { deps } = fakeClock();
		const holder = await limiter.acquire('a', deps);
		const waiter = watch(limiter, 'a', deps);
		await settle();
		const refused = await failureOf(limiter.acquire('a', deps));
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('queue_full');
		expect(limiter.waiting('a')).toBe(1);
		expect(limiter.inFlight('a')).toBe(1);

		holder();
		await settle();
		expect(waiter.state.release).not.toBeNull(); // the one that fit still got its turn
		waiter.state.release?.();
	});

	test('maxQueue 0 means a busy key refuses instead of queueing', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, maxQueue: 0 });
		const { deps } = fakeClock();
		const holder = await limiter.acquire('a', deps);
		expect((await failureOf(limiter.acquire('a', deps))).code).toBe('rate.limited');
		holder();
		(await limiter.acquire('a', deps))();
	});

	test('a release is idempotent: a second call does not free a second slot', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const { deps } = fakeClock();
		const first = await limiter.acquire('a', deps);
		const waiter = watch(limiter, 'a', deps);
		await settle();
		first();
		first();
		await settle();
		const late = watch(limiter, 'a', deps);
		await settle();
		expect(waiter.state.release).not.toBeNull();
		expect(late.state.release).toBeNull(); // one slot, still held by the waiter
		expect(limiter.inFlight('a')).toBe(1);
		waiter.state.release?.();
		await settle();
		late.state.release?.();
	});
});

describe('origin limiter — the spacing between starts', () => {
	test('starts are spaced start to start, whatever the releases do', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 4, minIntervalMs: 1_000 });
		const fake = fakeClock();
		const t0 = fake.clock.now;
		const releases = [
			await limiter.acquire('a', fake.deps),
			await limiter.acquire('a', fake.deps),
			await limiter.acquire('a', fake.deps),
		];
		// Three slots held at once: the 2nd and 3rd start 1 s and 2 s after the 1st.
		expect(fake.slept).toEqual([1_000, 1_000]);
		expect(fake.clock.now - t0).toBe(2_000);
		for (const release of releases) release();
	});

	test('a start that is already due waits for nothing', async () => {
		const limiter = createOriginLimiter({ ...BASE, minIntervalMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))();
		fake.clock.now += 5_000;
		(await limiter.acquire('a', fake.deps))();
		expect(fake.slept).toEqual([]);
	});

	test('a caller may ask for its own spacing, and 0 asks for none', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 4, minIntervalMs: 1_000 });
		const fake = fakeClock();
		const first = await limiter.acquire('a', fake.deps, 250);
		const second = await limiter.acquire('a', fake.deps, 0);
		const third = await limiter.acquire('a', fake.deps);
		expect(fake.slept).toEqual([250]); // the 2nd waited the 1st's 250; the 3rd (due at once) none
		for (const release of [first, second, third]) release();
	});

	test('SPACING IS OWED FORWARD: a start binds the later starts, not itself (mixed spacing, pinned)', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 8, maxQueue: 8 });
		const fake = fakeClock();
		const t0 = fake.clock.now;
		const startedAt: number[] = [];
		// A asks 1000, B and C ask none, D asks 1000, E none. Each start waits for what the
		// start BEFORE it asked; what it asks itself is for the ones after.
		for (const spacing of [1_000, 0, 0, 1_000, 0]) {
			(await limiter.acquire('a', fake.deps, spacing))();
			startedAt.push(fake.clock.now - t0);
		}
		// B waits A's 1000; C and D follow a start that asked nothing, so they go with B
		// (D's own 1000 is not a promise about the gap BEFORE D); E waits D's 1000.
		expect(startedAt).toEqual([0, 1_000, 1_000, 1_000, 2_000]);
		// Hence the contract for a caller with a provider's terms: pass them on EVERY request.
	});

	test('the spacing is reserved when the start is taken, not when the slot is granted', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 4, minIntervalMs: 1_000 });
		const fake = fakeClock();
		const first = await limiter.acquireSlot('a', fake.deps);
		const second = await limiter.acquireSlot('a', fake.deps);
		expect(limiter.inFlight('a')).toBe(2);
		await second.start(); // reserved first, so it goes first…
		expect(fake.slept).toEqual([]);
		await first.start(); // …and the one that held its slot longer waits behind it
		expect(fake.slept).toEqual([1_000]);
		first.release();
		second.release();
	});

	test('starts reserved together are spread over time, in order, and a pause may overlap another', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 4, minIntervalMs: 1_000 });
		const fake = fakeClock();
		const pauses = manualPauses(fake.clock);
		const deps: LimiterDeps = { ...fake.deps, sleep: pauses.sleep };
		const t0 = fake.clock.now;
		const started: number[] = [];
		const callers = [0, 1, 2].map((index) =>
			limiter.acquire('a', deps).then((release) => {
				started[index] = fake.clock.now - t0;
				return release;
			}),
		);
		await settle();
		expect(started).toEqual([0]); // the first goes; two pauses are running
		expect(pauses.pending()).toBe(2);
		await pauses.advance(1_000);
		expect(started).toEqual([0, 1_000]);
		await pauses.advance(1_000);
		expect(started).toEqual([0, 1_000, 2_000]);
		for (const release of await Promise.all(callers)) release();
	});

	test('a start that cannot happen inside the wait ceiling is refused at once, taking no slot', async () => {
		const limiter = createOriginLimiter({
			maxConcurrent: 4,
			maxQueue: 4,
			maxWaitMs: 1_500,
			minIntervalMs: 1_000,
		});
		// A pause that returns at once and leaves the clock where it is: the three
		// callers ask in the same instant, as a burst of tiles does.
		const deps: LimiterDeps = { ...fakeClock().deps, sleep: async () => {} };
		const first = await limiter.acquire('a', deps);
		const second = await limiter.acquire('a', deps); // starts at +1 s, inside 1.5 s
		const refused = await failureOf(limiter.acquire('a', deps)); // would start at +2 s
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(limiter.inFlight('a')).toBe(2);
		first();
		second();
	});

	test('a start refused at start() gives its slot back, and the ones that went keep theirs', async () => {
		const limiter = createOriginLimiter({
			maxConcurrent: 4,
			maxQueue: 4,
			maxWaitMs: 1_500,
			minIntervalMs: 1_000,
		});
		const deps: LimiterDeps = { ...fakeClock().deps, sleep: async () => {} };
		// Three slots are granted before any start is reserved…
		const slots = [
			await limiter.acquireSlot('a', deps),
			await limiter.acquireSlot('a', deps),
			await limiter.acquireSlot('a', deps),
		];
		await slots[0]?.start(); // at +0
		await slots[1]?.start(); // at +1 s, inside the 1.5 s ceiling
		const refused = await failureOf(slots[2]?.start() as Promise<void>); // would be +2 s
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(limiter.inFlight('a')).toBe(2); // the refused start took nothing, owes nothing
		slots[0]?.release();
		slots[1]?.release();
	});

	test('start() is for once: a second call is a defect, and a spacing that is not a number too', async () => {
		const limiter = createOriginLimiter(BASE);
		const { deps } = fakeClock();
		const slot = await limiter.acquireSlot('a', deps);
		await slot.start();
		expect((await failureOf(slot.start())).code).toBe('internal.invariant');
		slot.release();
		const other = await limiter.acquireSlot('a', deps);
		expect((await failureOf(other.start(Number.NaN))).code).toBe('internal.invariant');
		expect(limiter.inFlight('a')).toBe(0); // the defect gave the slot back
	});

	test('a back-off holds the next start; one the wait ceiling cannot outlast fails fast', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxWaitMs: 10_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))(5_000);
		(await limiter.acquire('a', fake.deps))(); // outlastable: it sleeps the 5 s
		expect(fake.slept).toEqual([5_000]);

		(await limiter.acquire('a', fake.deps))(30_000);
		const refused = await failureOf(limiter.acquire('a', fake.deps));
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(limiter.inFlight('a')).toBe(0); // the refused one took nothing
	});

	describe('a back-off that lands while a start is already reserved and pausing', () => {
		/** A limiter with 1 s spacing, 4 slots and a 10 s ceiling; pauses the test lifts by hand. */
		function paused(options: Partial<OriginLimiterOptions> = {}) {
			const limiter = createOriginLimiter({
				maxConcurrent: 4,
				maxQueue: 4,
				maxWaitMs: 10_000,
				minIntervalMs: 1_000,
				...options,
			});
			const fake = fakeClock();
			const pauses = manualPauses(fake.clock);
			const deps: LimiterDeps = { ...fake.deps, sleep: pauses.sleep };
			const t0 = fake.clock.now;
			/** Acquire and record when (relative to t0) the start was taken. */
			const startAfter = (startedAt: number[]) =>
				limiter.acquire('a', deps).then((release) => {
					startedAt.push(fake.clock.now - t0);
					return release;
				});
			return { limiter, fake, pauses, deps, t0, startAfter };
		}

		test('holds that start too: it waits again until the back-off ends', async () => {
			const { limiter, pauses, deps, startAfter } = paused();
			const startedAt: number[] = [];
			const first = await limiter.acquire('a', deps); // goes at +0
			const second = startAfter(startedAt); // reserved for +1 s, pausing
			await settle();
			expect(pauses.pending()).toBe(1);

			await pauses.advance(50);
			first(5_000); // +50 ms: the provider says wait 5 s — a hold to +5050
			await pauses.advance(950); // +1 s: the second's planned time, inside the hold
			expect(startedAt).toEqual([]); // it did NOT go
			expect(pauses.pending()).toBe(1); // it waits again
			expect(limiter.inFlight('a')).toBe(1);

			await pauses.advance(4_050); // +5050: the back-off ends
			expect(startedAt).toEqual([5_050]);
			(await second)();
			expect(limiter.inFlight('a')).toBe(0);
		});

		test('keeps the order and the spacing of the starts behind it', async () => {
			const { limiter, pauses, deps, startAfter } = paused();
			const startedAt: number[] = [];
			const first = await limiter.acquire('a', deps);
			const second = startAfter(startedAt); // +1 s
			const third = startAfter(startedAt); // +2 s
			await settle();
			expect(pauses.pending()).toBe(2);

			await pauses.advance(50);
			first(5_000); // hold to +5050
			await pauses.advance(950); // +1 s: the second wakes, finds the hold, waits again
			await pauses.advance(1_000); // +2 s: the third wakes, finds the second still ahead of it
			expect(startedAt).toEqual([]);
			await pauses.advance(3_050); // +5050: the back-off ends — the second goes…
			expect(startedAt).toEqual([5_050]);
			await pauses.advance(1_000); // …and the third a whole spacing after it, not with it
			expect(startedAt).toEqual([5_050, 6_050]);
			for (const release of await Promise.all([second, third])) release();
		});

		test('a back-off that cannot be outlasted refuses the paused start, taking nothing', async () => {
			const { limiter, pauses, deps, startAfter } = paused({ maxWaitMs: 3_000 });
			const first = await limiter.acquire('a', deps);
			const startedAt: number[] = [];
			const second = failureOf(startAfter(startedAt)); // reserved for +1 s, inside the 3 s ceiling
			await settle();

			await pauses.advance(50);
			first(5_000); // hold to +5050, past the ceiling
			await pauses.advance(950); // the second wakes, finds a start the ceiling cannot hold
			const refused = await second;
			expect(refused.code).toBe('rate.limited');
			expect(refused.coordinates?.reason).toBe('wait_exceeded');
			expect(startedAt).toEqual([]);
			expect(limiter.inFlight('a')).toBe(0); // its slot went back with the refusal
			expect(pauses.pending()).toBe(0);

			// Its reservation went back too: when the hold ends the next start owes nothing for it,
			// so it is granted without a pause (a pause here would never be lifted).
			await pauses.advance(4_100); // +5050
			const next = watch(limiter, 'a', deps);
			await settle();
			expect(next.state.release).not.toBeNull();
			expect(pauses.pending()).toBe(0);
			next.state.release?.();
		});

		test('a job stopped during the second pause still leaves at once and gives everything back', async () => {
			const { limiter, pauses, fake, startAfter } = paused();
			const first = await limiter.acquire('a', {
				...fake.deps,
				sleep: pauses.sleep,
			});
			const controller = new AbortController();
			const startedAt: number[] = [];
			const second = failureOf(runWithJobSignal(controller.signal, () => startAfter(startedAt)));
			await settle();
			await pauses.advance(50);
			first(5_000);
			await pauses.advance(950); // woke, found the hold, waits again
			expect(limiter.inFlight('a')).toBe(1);

			controller.abort();
			expect((await second).coordinates).toMatchObject({ reason: 'aborted', stage: 'limiter' });
			expect(limiter.inFlight('a')).toBe(0);
			expect(startedAt).toEqual([]);
		});

		test('an unmoved start goes at its planned time, and a seam that returns early cannot loop it', async () => {
			// No back-off: the check after the pause finds nothing moved and lets it go, even when the
			// pause returns without the clock having moved (a sleep seam, a timer that fired early).
			const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 4, minIntervalMs: 1_000 });
			const fake = fakeClock();
			const early: LimiterDeps = { ...fake.deps, sleep: async () => {} };
			const releases = [
				await limiter.acquire('a', early),
				await limiter.acquire('a', early),
				await limiter.acquire('a', early),
			];
			expect(limiter.inFlight('a')).toBe(3);
			for (const release of releases) release();
		});
	});

	test('a back-off that is not a positive finite number holds nothing', async () => {
		const limiter = createOriginLimiter({ ...BASE });
		const fake = fakeClock();
		for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
			(await limiter.acquire('a', fake.deps))(odd);
		}
		(await limiter.acquire('a', fake.deps))();
		expect(fake.slept).toEqual([]);
	});
});

describe('origin limiter — the wait ceiling on the queue', () => {
	test('a waiter still queued when its ceiling arrives is refused and leaves the queue', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const fake = fakeClock();
		const holder = await limiter.acquire('a', fake.deps);
		const waiter = watch(limiter, 'a', fake.deps);
		await settle();
		expect(fake.ceilings.length).toBe(1);
		expect(fake.ceilings[0]?.ms).toBe(BASE.maxWaitMs);

		fake.ceilings[0]?.fire();
		await settle();
		expect(isDedaloError(waiter.state.error) && waiter.state.error.code).toBe('rate.limited');
		expect(limiter.waiting('a')).toBe(0);
		expect(limiter.inFlight('a')).toBe(1); // the holder is untouched

		holder();
		(await limiter.acquire('a', fake.deps))(); // nothing is wedged
	});

	test('the ceiling timer is cancelled once the caller is granted (none is left running)', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const fake = fakeClock();
		const holder = await limiter.acquire('a', fake.deps);
		const waiter = watch(limiter, 'a', fake.deps);
		await settle();
		holder();
		await waiter.promise;
		expect(fake.ceilings.map((c) => c.cancelled)).toEqual([true]);
		waiter.state.release?.();
	});

	test('a caller granted at once arms no ceiling timer at all', async () => {
		const limiter = createOriginLimiter(BASE);
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))();
		expect(fake.ceilings).toEqual([]);
	});
});

describe('origin limiter — one ceiling across limiters', () => {
	test('the ceiling counts from `since`: a second queue gets what the first one left', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const fake = fakeClock();
		const holder = await limiter.acquire('a', fake.deps);
		const waiting = limiter.acquireSlot('a', fake.deps, fake.clock.now - 6_000);
		await settle();
		expect(fake.ceilings.map((ceiling) => ceiling.ms)).toEqual([BASE.maxWaitMs - 6_000]);
		holder();
		const slot = await waiting;
		expect(slot.since).toBe(fake.clock.now - 6_000);
		slot.release();
	});

	test('a caller whose ceiling is already spent is refused when its turn comes, taking no slot', async () => {
		const limiter = createOriginLimiter(BASE);
		const fake = fakeClock();
		const refused = await failureOf(
			limiter.acquireSlot('a', fake.deps, fake.clock.now - BASE.maxWaitMs - 1),
		);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(limiter.inFlight('a')).toBe(0);
		expect(limiter.tracked()).toBe(0);
		// …and one with a single millisecond left is served.
		const slot = await limiter.acquireSlot('a', fake.deps, fake.clock.now - BASE.maxWaitMs);
		slot.release();
	});

	test('the spacing counts inside the same ceiling: the wait before it leaves less room for it', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 4, maxWaitMs: 3_000 });
		const fake = fakeClock();
		const slot = await limiter.acquireSlot('a', fake.deps, fake.clock.now - 2_500);
		(await limiter.acquire('a', fake.deps, 1_000))(); // owes 1 s to the start after it
		// 500 ms are left; this start would be 1 s away.
		const refused = await failureOf(slot.start());
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(limiter.inFlight('a')).toBe(0);
	});

	test('a slot with no `since` asked for starts its clock now', async () => {
		const limiter = createOriginLimiter(BASE);
		const fake = fakeClock();
		const slot = await limiter.acquireSlot('a', fake.deps);
		expect(slot.since).toBe(fake.clock.now);
		slot.release();
	});
});

describe('origin limiter — the running job’s stop signal', () => {
	/** An abort signal whose abort listeners are counted (added and still live). */
	function countedSignal() {
		const controller = new AbortController();
		const { signal } = controller;
		const live = new Set<unknown>();
		const tally = { added: 0 };
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((type: string, listener: EventListener, options?: object) => {
			if (type === 'abort') {
				tally.added++;
				live.add(listener);
			}
			add(type, listener, options);
		}) as typeof signal.addEventListener;
		signal.removeEventListener = ((type: string, listener: EventListener, options?: object) => {
			if (type === 'abort') live.delete(listener);
			remove(type, listener, options);
		}) as typeof signal.removeEventListener;
		return { controller, live, tally };
	}

	test('a stopped job leaves the queue at once, and its place is not handed a slot', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const fake = fakeClock();
		const holder = await limiter.acquire('a', fake.deps);
		const { controller, live, tally } = countedSignal();
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () => limiter.acquire('a', fake.deps)),
		);
		const behind = watch(limiter, 'a', fake.deps);
		await settle();
		expect(limiter.waiting('a')).toBe(2);

		controller.abort();
		const error = await stopped;
		expect(error.code).toBe('security.outbound_failed');
		expect(error.coordinates).toMatchObject({ reason: 'aborted', stage: 'limiter' });
		expect(limiter.waiting('a')).toBe(1);

		holder();
		await settle();
		expect(behind.state.release).not.toBeNull(); // the next in line, not the stopped caller
		expect(limiter.inFlight('a')).toBe(1);
		expect(tally.added).toBeGreaterThan(0); // the wait did listen (anti-vacuity)
		expect(live.size).toBe(0);
		// Neither wait ceiling is left running: the stopped caller's was cancelled when it left.
		expect(fake.ceilings.map((ceiling) => ceiling.cancelled)).toEqual([true, true]);
		behind.state.release?.();
	});

	test('a job already stopped is refused before it queues', async () => {
		const limiter = createOriginLimiter(BASE);
		const controller = new AbortController();
		controller.abort();
		const error = await failureOf(
			runWithJobSignal(controller.signal, () => limiter.acquire('a', fakeClock().deps)),
		);
		expect(error.coordinates).toMatchObject({ reason: 'aborted' });
		expect(limiter.tracked()).toBe(0);
	});

	test('a job stopped during the spacing pause gives its slot back and clears its timer', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, minIntervalMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))(); // the next start is now 1 s away
		const { controller, live } = countedSignal();
		// A pause that never ends: only the job's stop can finish it.
		const deps: LimiterDeps = { ...fake.deps, sleep: () => new Promise<void>(() => {}) };
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () => limiter.acquire('a', deps)),
		);
		await settle();
		expect(limiter.inFlight('a')).toBe(1); // the slot is reserved while it pauses

		controller.abort();
		expect((await stopped).coordinates).toMatchObject({ reason: 'aborted', stage: 'limiter' });
		expect(limiter.inFlight('a')).toBe(0);
		expect(live.size).toBe(0);
		(await limiter.acquire('a', fake.deps))(); // the slot really is free
	});

	test('a job stopped during the spacing pause hands its slot to the caller queued behind it', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, minIntervalMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))(); // the next start is now 1 s away
		const { controller } = countedSignal();
		const hang: LimiterDeps = { ...fake.deps, sleep: () => new Promise<void>(() => {}) };
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () => limiter.acquire('a', hang)),
		);
		const behind = watch(limiter, 'a', fake.deps);
		await settle();
		expect(limiter.inFlight('a')).toBe(1); // the pausing caller's
		expect(limiter.waiting('a')).toBe(1);

		controller.abort();
		await stopped;
		await settle();
		// Granted at once — not left waiting for a release that will never come, nor for its ceiling.
		expect(limiter.waiting('a')).toBe(0);
		expect(behind.state.release).not.toBeNull();
		expect(limiter.inFlight('a')).toBe(1);
		behind.state.release?.();
		expect(limiter.inFlight('a')).toBe(0);
	});

	test('a stop that lands in the instant a slot is granted hands that slot on to the next in line', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const fake = fakeClock();
		const holder = await limiter.acquire('a', fake.deps);
		const { controller } = countedSignal();
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () => limiter.acquire('a', fake.deps)),
		);
		const behind = watch(limiter, 'a', fake.deps);
		await settle();
		expect(limiter.waiting('a')).toBe(2);

		// The stop first, the release right after, with no microtask in between: the release
		// still finds the stopped caller in the queue and grants it the slot, and only then
		// does the caller learn it was stopped — and must give that slot on.
		controller.abort();
		holder();
		expect((await stopped).coordinates).toMatchObject({ reason: 'aborted' });
		await settle();
		expect(behind.state.release).not.toBeNull();
		expect(limiter.inFlight('a')).toBe(1);
		expect(limiter.waiting('a')).toBe(0);
		behind.state.release?.();
	});

	test('a job stopped between its slot and its start does not start, though no pause is due', async () => {
		const limiter = createOriginLimiter(BASE);
		const { deps } = fakeClock();
		const controller = new AbortController();
		const error = await failureOf(
			runWithJobSignal(controller.signal, async () => {
				const slot = await limiter.acquireSlot('a', deps);
				controller.abort(); // the viewer went away while the request was granted its slot
				await slot.start();
			}),
		);
		expect(error.coordinates).toMatchObject({ reason: 'aborted', stage: 'limiter' });
		expect(limiter.inFlight('a')).toBe(0);
	});

	test('the starts a stopped job had reserved are given back: panning a map away burns nothing', async () => {
		const limiter = createOriginLimiter({
			maxConcurrent: 32,
			maxQueue: 8,
			maxWaitMs: 1_000,
			minIntervalMs: 100,
		});
		const fake = fakeClock();
		const t0 = fake.clock.now;
		(await limiter.acquire('a', fake.deps))(); // the one start that really happens; it owes 100 ms
		const { controller } = countedSignal();
		const never: LimiterDeps = { ...fake.deps, sleep: () => new Promise<void>(() => {}) };
		const stopped = Array.from({ length: 8 }, () =>
			failureOf(runWithJobSignal(controller.signal, () => limiter.acquire('a', never))),
		);
		await settle();
		expect(limiter.inFlight('a')).toBe(8); // eight starts reserved, +100 ms … +800 ms
		controller.abort();
		for (const error of await Promise.all(stopped)) {
			expect(error.coordinates).toMatchObject({ reason: 'aborted' });
		}
		expect(limiter.inFlight('a')).toBe(0);

		// A caller who comes now waits for what the real start owes — not for eight that never
		// happened (that was 900 ms, or a refusal once the backlog passed the ceiling).
		(await limiter.acquire('a', fake.deps))();
		expect(fake.slept).toEqual([100]);
		expect(fake.clock.now - t0).toBe(100);
	});
});

describe('origin limiter — the timers it makes (the default paths, fake timers)', () => {
	/** A clock that stands still: the timers' lengths are then exact. */
	const still: LimiterDeps = { now: () => 5_000_000 };

	test('a caller stopped while queued leaves no ceiling timer armed', async () => {
		await withFakeTimers(async (timers) => {
			const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
			const holder = await limiter.acquire('a', still);
			const controller = new AbortController();
			const stopped = failureOf(
				runWithJobSignal(controller.signal, () => limiter.acquire('a', still)),
			);
			await settle();
			expect(timers.map((timer) => timer.ms)).toEqual([BASE.maxWaitMs]);
			controller.abort();
			expect((await stopped).code).toBe('security.outbound_failed');
			expectNoTimerLeft(timers);
			holder();
		});
	});

	test('the ceiling timer is cleared once the caller is granted, and fires into a refusal otherwise', async () => {
		await withFakeTimers(async (timers, fire) => {
			const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, maxQueue: 4 });
			const holder = await limiter.acquire('a', still);
			const granted = watch(limiter, 'a', still);
			const late = watch(limiter, 'a', still);
			await settle();
			expect(timers).toHaveLength(2);
			holder();
			await granted.promise;
			expect(granted.state.release).not.toBeNull();
			expect(timers[0]?.cleared).toBe(true); // granted: its ceiling is no longer running
			expect(timers[1]?.cleared).toBe(false);
			fire(timers[1]); // the other one's ceiling arrives while it still waits
			await late.promise;
			expect(isDedaloError(late.state.error) && late.state.error.coordinates?.reason).toBe(
				'wait_exceeded',
			);
			expect(limiter.waiting('a')).toBe(0);
			expectNoTimerLeft(timers);
			granted.state.release?.();
		});
	});

	test('a caller refused for a full queue arms no ceiling at all', async () => {
		await withFakeTimers(async (timers) => {
			const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, maxQueue: 0 });
			const holder = await limiter.acquire('a', still);
			expect((await failureOf(limiter.acquire('a', still))).code).toBe('rate.limited');
			expect(timers).toEqual([]);
			holder();
		});
	});

	test('a caller stopped during the spacing pause leaves its pause timer cleared', async () => {
		await withFakeTimers(async (timers) => {
			const limiter = createOriginLimiter({ ...BASE, maxWaitMs: 120_000, minIntervalMs: 60_000 });
			(await limiter.acquire('a', { ...still, setTimer: () => {} }))(); // the next start is a minute away
			const controller = new AbortController();
			const stopped = failureOf(
				runWithJobSignal(controller.signal, () => limiter.acquire('a', still)),
			);
			await settle();
			expect(timers.map((timer) => timer.ms)).toEqual([60_000]); // the pause, and nothing else yet
			controller.abort();
			expect((await stopped).code).toBe('security.outbound_failed');
			expect(limiter.inFlight('a')).toBe(0);
			const pauseTimer = timers[0] as FakeTimer;
			expect(pauseTimer.cleared).toBe(true);
			for (const timer of timers) expect(timer.unrefd).toBe(true); // the key's drain too
		});
	});

	test('a pause that runs its course clears its own timer, and the idle key drains on an unref’d one — the only drain it ever holds', async () => {
		await withFakeTimers(async (timers, fire) => {
			const limiter = createOriginLimiter({ ...BASE, minIntervalMs: 1_000 });
			const clock = { now: 5_000_000 };
			const deps: LimiterDeps = { now: () => clock.now };
			// The first release owes spacing, so it arms the key's drain — unref'd.
			(await limiter.acquire('a', deps))();
			const drain = timers[0] as FakeTimer;
			expect(drain.ms).toBe(1_000);
			expect(drain.unrefd).toBe(true);
			const second = limiter.acquire('a', deps);
			await settle();
			const pauseTimer = timers[1] as FakeTimer;
			expect(pauseTimer.ms).toBe(1_000);
			fire(pauseTimer);
			(await second)();
			expect(pauseTimer.cleared).toBe(true);
			// The second release finds that drain still pending and arms no second one.
			expect(timers.length).toBe(2);
			expect(limiter.tracked()).toBe(1);
			clock.now += 10_000;
			fire(drain);
			expect(limiter.tracked()).toBe(0);
		});
	});
});

describe('origin limiter — lifecycle', () => {
	test('an idle, unspaced key is forgotten at once', async () => {
		const limiter = createOriginLimiter(BASE);
		const fake = fakeClock();
		const release = await limiter.acquire('a', fake.deps);
		expect(limiter.tracked()).toBe(1);
		release();
		expect(limiter.tracked()).toBe(0);
		expect(fake.drains).toEqual([]);
	});

	test('a spaced key drains once its spacing has passed, re-arming if the timer fires early', async () => {
		const limiter = createOriginLimiter({ ...BASE, minIntervalMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))();
		expect(limiter.tracked()).toBe(1);
		expect(fake.drains.map((d) => d.ms)).toEqual([1_000]);

		fake.drains[0]?.callback(); // fired early: still inside the spacing
		expect(limiter.tracked()).toBe(1);
		expect(fake.drains.length).toBe(2);

		fake.clock.now += 1_000;
		fake.drains[1]?.callback();
		expect(limiter.tracked()).toBe(0);
	});

	test('a key holds ONE drain timer however many callers a back-off refuses: the live timers do not follow the request rate', async () => {
		// Every newcomer refused during a back-off settles the key, and each settle armed a fresh
		// timer of up to the back-off: 1 release + 1000 refusals left 1001 live timers, and a
		// refused caller that retried fed it.
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1, maxWaitMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))(30_000); // a back-off longer than anyone waits
		expect(fake.drains.map((drain) => drain.ms)).toEqual([30_000]);
		for (let newcomer = 0; newcomer < 500; newcomer++) {
			const refused = await failureOf(limiter.acquire('a', fake.deps));
			expect(refused.coordinates?.reason).toBe('wait_exceeded');
		}
		expect(fake.drains.length, '500 refusals added no timer').toBe(1);
		expect(limiter.tracked()).toBe(1);
		expect(limiter.waiting('a')).toBe(0);
		fake.clock.now += 30_000;
		fake.drains[0]?.callback();
		expect(limiter.tracked(), 'forgotten once the back-off has passed').toBe(0);
		expect(fake.drains.length).toBe(1);
	});

	test('a drain that is overdue and never ran is lost, not pending: the next settle replaces it, so a lost timer cannot strand a key', async () => {
		const limiter = createOriginLimiter({ ...BASE, minIntervalMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))(); // arms a drain that this test never runs
		expect(fake.drains.length).toBe(1);
		fake.clock.now += 5_000; // far past its due moment
		(await limiter.acquire('a', fake.deps))();
		expect(fake.drains.length, 'the overdue one was replaced').toBe(2);
		fake.clock.now += 5_000;
		fake.drains[1]?.callback();
		expect(limiter.tracked()).toBe(0);
	});

	test('a key that is busy again is not drained by an old timer', async () => {
		const limiter = createOriginLimiter({ ...BASE, minIntervalMs: 1_000 });
		const fake = fakeClock();
		(await limiter.acquire('a', fake.deps))();
		const old = fake.drains[0];
		const holder = await limiter.acquire('a', fake.deps);
		fake.clock.now += 10_000;
		old?.callback();
		expect(limiter.tracked()).toBe(1);
		expect(limiter.inFlight('a')).toBe(1);
		holder();
	});

	test('clear() forgets every key but leaves a held slot’s release working', async () => {
		const limiter = createOriginLimiter({ ...BASE, maxConcurrent: 1 });
		const { deps } = fakeClock();
		const holder = await limiter.acquire('a', deps);
		limiter.clear();
		expect(limiter.tracked()).toBe(0);
		holder();
		(await limiter.acquire('a', deps))();
	});
});

describe('origin limiter — the options are validated', () => {
	test('a limit that is not a whole number or a finite number >= 0 is a defect', () => {
		const bad: Partial<OriginLimiterOptions>[] = [
			{ maxConcurrent: 0 },
			{ maxConcurrent: 1.5 },
			{ maxConcurrent: Number.NaN },
			{ maxQueue: -1 },
			{ maxQueue: 0.5 },
			{ maxWaitMs: -1 },
			{ maxWaitMs: Number.POSITIVE_INFINITY },
			{ minIntervalMs: -1 },
			{ minIntervalMs: Number.NaN },
		];
		for (const override of bad) {
			let code = 'none';
			try {
				createOriginLimiter({ ...BASE, ...override });
			} catch (error) {
				code = isDedaloError(error) ? error.code : 'untyped';
			}
			expect(code, JSON.stringify(override)).toBe('internal.invariant');
		}
	});

	test('a per-call spacing that is not a finite number >= 0 is a defect, before any state', async () => {
		const limiter = createOriginLimiter(BASE);
		for (const odd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect((await failureOf(limiter.acquire('a', {}, odd))).code).toBe('internal.invariant');
		}
		expect(limiter.tracked()).toBe(0);
	});
});
