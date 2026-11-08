/**
 * MEDIA COPY WORKER (PUBLICATION_HOST_SPEC §5.2, decisions M3/M4): the in-process,
 * per-host SERIALIZED lane between the pub/ transition seam (and every other copy
 * caller) and the copy apply.
 *
 *  - Unpublish (`published:false`) is flushed on the next microtask, to every host,
 *    three ways: (1) AT ONCE, outside the lane (deps.withdrawNow → media_copy_apply.ts
 *    withdrawNowWith: recorded pending, `media.mark false`), never behind a running unit;
 *    (2) into the host's PRE-EMPT set, which the round running there drains before its
 *    next unit (ApplyOptions.takeWithdrawn: drops the key from the round's known markers,
 *    withdraws again); (3) into the queued sync (withdraw-only pass first, then the plan
 *    deletes the files and verifies). Publish is debounced (PUBLISH_DEBOUNCE_MS): one
 *    planning walk.
 *  - (1) BEFORE (3): no lane unit starts while an immediate withdrawal begun before it is
 *    in flight on its host (settledWithdrawals). (1) records its marker pending only once
 *    the agent's status answers; a round that verified meanwhile would leave that record
 *    behind every verify — a pending deletion nothing settles until some later round.
 *  - THE LATENCY BOUND of a withdrawal (M2) is path (1)'s, independent of any transfer:
 *    after the flip, one status read (hostTakesCopy; AGENT_TIMEOUTS_MS.read, plus the
 *    pairing proof's AGENT_TIMEOUTS_MS.health when not yet proved) and one runtime write,
 *    then the `mark false` (AGENT_TIMEOUTS_MS.media); the keys of one flush go in order,
 *    each after the previous answered. Without withdrawNow the bound would be the next
 *    unit boundary — after the running unit, i.e. a whole put (its hash on a cache miss
 *    plus a transfer of up to mediaPutDeadlineMs(size)), which is why it is wired at boot.
 *  - Per host: ONE run at a time, and at most ONE queued sync, which absorbs every
 *    transition arriving meanwhile (its withdrawn keys merge). Hosts never wait on
 *    each other. A failed run is logged; the lane goes on.
 *  - ONE LANE FOR EVERY CALLER: `exclusive(host, work)` / `inMediaCopyLane` chain
 *    arbitrary work (the media_copy reconcile's plan → apply → re-plan, the widget's
 *    round) onto the same tail, so no caller applies a stale plan beside a hook run.
 *  - In-process only: a long AV transfer must not hold a diffusion runner slot.
 *    Cross-process ordering is the advisory target lock each unit takes
 *    (media_copy_apply.ts, `media:<host>`; held for control calls only, never a
 *    transfer); an immediate withdrawal takes none (see withdrawNowWith).
 *  - OTHER PROCESSES FLIP pub/ TOO. The seam (pub_transitions.ts) reaches only sinks of
 *    its own process, and a diffusion job runs in a SPAWNED runner. So the runner starts
 *    a MediaCopyRelay (below; runner.ts main): path (1) only — `mark false` at once, no
 *    lane, no round — drained (bounded) before the runner exits. Whatever a relay misses
 *    (killed, out of time, an out-of-machine runner) the media_copy reconcile's apply
 *    withdraws BEFORE it queues behind a running unit (media_copy.ts
 *    withdrawStrayMarkers), never after the round.
 *  - DETACHED FROM THE WRITER'S TRANSACTION. A flip is emitted from inside a marker
 *    writer's transaction (a runner batch's fenced unit, the fenced media_index
 *    reconcile), and a timer or microtask scheduled there inherits its async context.
 *    A run is background work that outlives that writer (its handle expires at COMMIT),
 *    so the sink, every immediate withdrawal and every queued run leave the transaction
 *    context (runDetachedFromTransaction) — a run never joins, or outlives, a batch's
 *    transaction. So does every `exclusive` / `inMediaCopyLane` unit, worker or not.
 *    Each layer is pinned on its own (media_copy_worker_native "detach layer").
 *
 * Correctness does not depend on this worker: the media_copy reconcile recomputes
 * from ground truth whatever it missed (a registry it could not read, a crash).
 * Lanes and queues are INSTANCE state; the one module binding is `activeWorker`.
 */

import { runDetachedFromTransaction } from '../../../core/db/postgres.ts';
import { DedaloError } from '../../../core/errors/index.ts';
import { isAgentMarkerKey } from '../../../core/publication_host/agent_client.ts';
import { registerMediaCopySink } from './media_copy.ts';
import type { CopyApplyReport } from './media_copy_apply.ts';

export const PUBLISH_DEBOUNCE_MS = 2_000;

export interface MediaCopyWorkerDeps {
	/** Every registry host name (copy mode is decided per run by syncHost). */
	listHosts(): string[];
	/**
	 * One run for one host (media_copy.ts syncHost). `takeWithdrawn` drains the keys
	 * withdrawn while the run is in flight (the run pre-empts its units with them).
	 */
	syncHost(
		host: string,
		withdrawnKeys: readonly string[],
		takeWithdrawn: () => readonly string[],
	): Promise<CopyApplyReport | null>;
	publishDebounceMs: number;
	/**
	 * Withdraw `keys` on `host` AT ONCE, outside the lane (media_copy_apply.ts
	 * withdrawNowWith): never behind a running put unit. Absent = only the lane withdraws.
	 */
	withdrawNow?(host: string, keys: readonly string[]): Promise<void>;
	/** Told after every run that produced a report (the phase-6 probe trigger). */
	afterSync?(host: string, report: CopyApplyReport): void;
}

interface QueuedRun {
	keys: Set<string>;
	done: Promise<CopyApplyReport | null>;
}

interface HostLane {
	tail: Promise<void>;
	queued: QueuedRun | null;
	/** Keys withdrawn since the running unit began: drained by it between its units. */
	preempt: Set<string>;
	/**
	 * This host's immediate withdrawals in flight. Every lane unit starts only after the
	 * ones begun before it settled (see settledWithdrawals) — never the reverse.
	 */
	withdrawing: Set<Promise<void>>;
}

/** What a lane unit drains to pre-empt itself with the keys withdrawn meanwhile. */
export type TakeWithdrawn = () => readonly string[];

export class MediaCopyWorker {
	private readonly lanes = new Map<string, HostLane>();
	private readonly withdrawn = new Set<string>();
	/** Immediate withdrawals in flight (idle() waits for them). */
	private readonly withdrawals = new Set<Promise<void>>();
	private publishTimer: ReturnType<typeof setTimeout> | null = null;
	private flushScheduled = false;
	private stopped = false;
	private readonly deps: MediaCopyWorkerDeps;

	constructor(deps: MediaCopyWorkerDeps) {
		this.deps = deps;
	}

	/**
	 * A pub/ flip from the seam. Never throws, only enqueues. An unpublished key outside the
	 * agent's marker grammar is dropped (logged): the agent can hold no marker for it, so
	 * there is nothing to withdraw — and media.mark would refuse it inside the batch.
	 */
	notify(key: string, published: boolean): void {
		if (this.stopped) return;
		if (published) {
			this.armPublishTimer();
			return;
		}
		if (!isAgentMarkerKey(key)) {
			console.error(
				`[media_copy] unpublished key ${JSON.stringify(key)} is outside the agent marker grammar: nothing to withdraw (dropped)`,
			);
			return;
		}
		this.withdrawn.add(key);
		this.scheduleFlush();
	}

	/** One run for `host` (joins the queued one when there is one). */
	sync(host: string): Promise<CopyApplyReport | null> {
		return this.enqueue(host, []);
	}

	/**
	 * Run `work` in `host`'s lane: after everything already queued there, before anything
	 * later. `work` gets the lane's pre-empt drain (pass it to applyCopy's takeWithdrawn).
	 */
	exclusive<T>(host: string, work: (takeWithdrawn: TakeWithdrawn) => Promise<T>): Promise<T> {
		const lane = this.lane(host);
		const before = settledWithdrawals(lane);
		// Detached: a caller inside a transaction must not lend it to the lane's units.
		const done = Promise.all([lane.tail, before]).then(() =>
			runDetachedFromTransaction(() => work(() => this.drain(lane))),
		);
		this.advance(host, lane, done);
		return done;
	}

	/** Resolves once nothing is queued, running or about to be flushed (gates, shutdown). */
	async idle(): Promise<void> {
		for (;;) {
			if (this.withdrawals.size > 0) await Promise.all([...this.withdrawals]);
			else if (this.lanes.size > 0)
				await Promise.all([...this.lanes.values()].map((lane) => lane.tail));
			else if (this.flushScheduled || this.publishTimer !== null) await Bun.sleep(1);
			else return;
		}
	}

	stop(): void {
		this.stopped = true;
		this.withdrawn.clear();
		this.clearPublishTimer();
	}

	private armPublishTimer(): void {
		if (this.publishTimer !== null) return;
		this.publishTimer = setTimeout(() => this.flush(), this.deps.publishDebounceMs);
		this.publishTimer.unref?.();
	}

	private clearPublishTimer(): void {
		if (this.publishTimer === null) return;
		clearTimeout(this.publishTimer);
		this.publishTimer = null;
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => this.flush());
	}

	private flush(): void {
		this.flushScheduled = false;
		this.clearPublishTimer();
		const keys = [...this.withdrawn];
		this.withdrawn.clear();
		if (this.stopped) return;
		for (const host of this.hostsOrNone()) {
			const lane = this.lane(host);
			for (const key of keys) lane.preempt.add(key);
			this.withdrawAtOnce(host, lane, keys);
			this.enqueue(host, keys).catch((error) => {
				console.error(
					`[media_copy] ${host}: sync failed (the media_copy reconcile retries):`,
					error,
				);
			});
		}
	}

	/** The out-of-lane withdrawal (deps.withdrawNow), detached, logged, never thrown. */
	private withdrawAtOnce(host: string, lane: HostLane, keys: readonly string[]): void {
		const withdrawNow = this.deps.withdrawNow;
		if (withdrawNow === undefined || keys.length === 0) return;
		const sent: Promise<void> = runDetachedFromTransaction(() => withdrawNow(host, keys))
			.catch((error: unknown) => {
				console.error(
					`[media_copy] ${host}: immediate withdrawal failed (the queued run withdraws again):`,
					error,
				);
			})
			.finally(() => {
				this.withdrawals.delete(sent);
				lane.withdrawing.delete(sent);
			});
		this.withdrawals.add(sent);
		lane.withdrawing.add(sent);
	}

	private hostsOrNone(): string[] {
		try {
			return this.deps.listHosts();
		} catch (error) {
			console.error(
				'[media_copy] publication host registry unreadable — pub/ transition not forwarded (the media_copy reconcile retries):',
				error,
			);
			return [];
		}
	}

	private lane(host: string): HostLane {
		const existing = this.lanes.get(host);
		if (existing !== undefined) return existing;
		const created: HostLane = {
			tail: Promise.resolve(),
			queued: null,
			preempt: new Set(),
			withdrawing: new Set(),
		};
		this.lanes.set(host, created);
		return created;
	}

	/** Make `done` the lane's new tail; drop the lane once it drains. */
	private advance(host: string, lane: HostLane, done: Promise<unknown>): void {
		const tail = done.then(
			() => undefined,
			() => undefined,
		);
		lane.tail = tail;
		void tail.then(() => {
			if (this.lanes.get(host) === lane && lane.tail === tail) this.lanes.delete(host);
		});
	}

	private enqueue(host: string, keys: readonly string[]): Promise<CopyApplyReport | null> {
		const lane = this.lane(host);
		if (lane.queued !== null) {
			for (const key of keys) lane.queued.keys.add(key);
			return lane.queued.done;
		}
		const run: QueuedRun = { keys: new Set(keys), done: Promise.resolve(null) };
		const before = settledWithdrawals(lane);
		run.done = Promise.all([lane.tail, before]).then(() =>
			runDetachedFromTransaction(() => this.runQueued(host, lane, run)),
		);
		lane.queued = run;
		this.advance(host, lane, run.done);
		return run.done;
	}

	private async runQueued(
		host: string,
		lane: HostLane,
		run: QueuedRun,
	): Promise<CopyApplyReport | null> {
		if (lane.queued === run) lane.queued = null;
		// Every key pre-empt holds now was merged into this run's keys at the same flush.
		lane.preempt.clear();
		if (this.stopped) return null;
		const report = await this.deps.syncHost(host, [...run.keys], () => this.drain(lane));
		if (report !== null) this.tell(host, report);
		return report;
	}

	private drain(lane: HostLane): string[] {
		const keys = [...lane.preempt];
		lane.preempt.clear();
		return keys;
	}

	private tell(host: string, report: CopyApplyReport): void {
		try {
			this.deps.afterSync?.(host, report);
		} catch (error) {
			console.error(`[media_copy] ${host}: afterSync listener failed:`, error);
		}
	}
}

/**
 * Resolves once every immediate withdrawal ALREADY in flight on the lane's host has
 * settled (each is caught and logged in withdrawAtOnce, so this never rejects). A lane unit
 * waits for it: a withdrawal records its marker pending only after the agent's status
 * answers, so a round that ran meanwhile could verify the marker gone BEFORE that record —
 * which then outlived every verify (the stale pending deletion the drill caught). The
 * withdrawal never waits for the lane (its latency bound, M2, is unchanged).
 */
function settledWithdrawals(lane: HostLane): Promise<unknown> {
	return Promise.all([...lane.withdrawing]);
}

/** How long a runner waits, at exit, for its relay's withdrawals (the reconcile catches the rest). */
export const MEDIA_COPY_RELAY_DRAIN_MS = 60_000;

export interface MediaCopyRelayDeps {
	listHosts(): string[];
	withdrawNow(host: string, keys: readonly string[]): Promise<void>;
}

/**
 * THE RUNNER'S RELAY: the worker's path (1) and nothing else. An unpublished key is
 * withdrawn on every registry host at once (deps.withdrawNow — detached from the writer's
 * transaction, logged, never thrown); a publish is ignored (the server's reconcile plans
 * the copy: a runner never streams a transfer). `drain` waits for what is in flight.
 */
export class MediaCopyRelay {
	private readonly keys = new Set<string>();
	private readonly inFlight = new Set<Promise<void>>();
	private flushScheduled = false;
	private readonly deps: MediaCopyRelayDeps;
	private unregister: (() => void) | null = null;

	constructor(deps: MediaCopyRelayDeps) {
		this.deps = deps;
	}

	notify(key: string, published: boolean): void {
		if (published || this.unregister === null) return;
		if (!isAgentMarkerKey(key)) {
			console.error(
				`[media_copy] relay: unpublished key ${JSON.stringify(key)} is outside the agent marker grammar (dropped)`,
			);
			return;
		}
		this.keys.add(key);
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => this.flush());
	}

	/** Hook the relay to this process's pub/ seam. */
	start(): this {
		this.unregister = registerMediaCopySink((key, published) =>
			runDetachedFromTransaction(() => this.notify(key, published)),
		);
		return this;
	}

	/** Unhook, then wait up to `boundMs` for the withdrawals in flight. True = all settled. */
	async stop(boundMs: number = MEDIA_COPY_RELAY_DRAIN_MS): Promise<boolean> {
		await Promise.resolve(); // a flush scheduled by the last flip runs first
		this.unregister?.();
		this.unregister = null;
		const settled = Promise.all([...this.inFlight]).then(() => true);
		const timeout = new Promise<false>((resolve) =>
			setTimeout(() => resolve(false), boundMs).unref?.(),
		);
		const drained = await Promise.race([settled, timeout]);
		if (!drained) {
			console.error(
				`[media_copy] relay: ${this.inFlight.size} withdrawal(s) still in flight after ${boundMs} ms (the media_copy reconcile withdraws them)`,
			);
		}
		return drained;
	}

	private flush(): void {
		this.flushScheduled = false;
		const keys = [...this.keys];
		this.keys.clear();
		for (const host of this.hostsOrNone()) {
			const sent: Promise<void> = runDetachedFromTransaction(() =>
				this.deps.withdrawNow(host, keys),
			)
				.catch((error: unknown) => {
					console.error(
						`[media_copy] relay: ${host}: withdrawal failed (the media_copy reconcile withdraws again):`,
						error,
					);
				})
				.finally(() => this.inFlight.delete(sent));
			this.inFlight.add(sent);
		}
	}

	private hostsOrNone(): string[] {
		try {
			return this.deps.listHosts();
		} catch (error) {
			console.error(
				'[media_copy] relay: publication host registry unreadable (not forwarded):',
				error,
			);
			return [];
		}
	}
}

/** Start a relay (a runner process). Its stop drains the withdrawals in flight, bounded. */
export function startMediaCopyRelay(deps: MediaCopyRelayDeps): MediaCopyRelay {
	return new MediaCopyRelay(deps).start();
}

// The one started worker (module_state_tripwire LET row): boot wiring set by
// startMediaCopyWorker and cleared by its stop — never request identity.
let activeWorker: MediaCopyWorker | null = null;

/** Start THE worker and hook it to the pub/ seam. Returns its stop (shutdown drain). */
export function startMediaCopyWorker(deps: MediaCopyWorkerDeps): () => void {
	if (activeWorker !== null) {
		throw new DedaloError('internal.invariant', { message: 'media copy worker started twice' });
	}
	const worker = new MediaCopyWorker(deps);
	// Detached: the flip may come from inside a writer's transaction (see the header).
	const unregister = registerMediaCopySink((key, published) =>
		runDetachedFromTransaction(() => worker.notify(key, published)),
	);
	activeWorker = worker;
	return () => {
		unregister();
		worker.stop();
		if (activeWorker === worker) activeWorker = null;
	};
}

/** The started worker, or null (a CLI process, a disabled scheduler). */
export function activeMediaCopyWorker(): MediaCopyWorker | null {
	return activeWorker;
}

/**
 * Run a copy round for `host` in THE host lane: through the started worker when there
 * is one (serialized with the hook's runs), else directly (a CLI process — the advisory
 * lock orders it against the server). Never call it from inside a lane run (syncHost):
 * that would wait on itself.
 */
export function inMediaCopyLane<T>(
	host: string,
	work: (takeWithdrawn: TakeWithdrawn) => Promise<T>,
): Promise<T> {
	return activeWorker === null
		? runDetachedFromTransaction(() => work(() => []))
		: activeWorker.exclusive(host, work);
}
