/**
 * RECONCILE SCHEDULER — runs the registry's `boot` and `{everyMs}` reconciles
 * by themselves (registry.ts, S-10). `operator` ones never run here.
 *
 * A scheduled run REPORTS (dry) unless the definition carries `autoApply`
 * with its reason — `media_index` (at boot and every
 * MEDIA_INDEX_RECONCILE_EVERY_MS; server.ts used to fire `reconcileMediaIndex()`
 * directly, once), `media_copy` (the copy-mode publication hosts, every
 * MEDIA_COPY_PERIOD_MS), and `publication_probe` (every PUBLICATION_PROBE_EVERY_MS:
 * its apply only records the public-URL probe observation). Every outcome
 * goes through `runReconcile`, so the `reconcile` gauge on /api/v1/counters
 * shows the last drift of each, whether an operator or the clock ran it.
 *
 * RE-ARMED UNTIL DONE (D5, owner decision 2026-10-21). A run whose report says
 * `deferred` — the apply could not happen now and is still owed (media_index:
 * its fence budget spent while a publication writer held a target) — is run
 * again after DEFERRED_RETRY_MS (or its period, when that is shorter), and
 * again, until one completes; then a `boot` definition is done and an interval
 * one returns to its period. A THROWN run is not re-armed sooner than its
 * period (a `boot` one is done): a failure is a fault the operator reads in
 * `last_error`, and retrying it every minute would only repeat the log line.
 *
 * ONE RUN IN FLIGHT PER NAME. Each definition is a timer CHAIN — the next run
 * is armed only once the previous one settled, never on a fixed interval that
 * would start a second run beside a slow one — and a run whose name is still in
 * flight from an earlier start (stop → start while it waits on its fence) is put
 * back by the re-arm delay, never started beside it.
 *
 * STOPPED BY THE SHUTDOWN DRAIN (server.ts SIGTERM): stopReconcileScheduler
 * clears every pending timer and retires the schedule, so nothing new starts;
 * a run already in flight never re-arms, and drainReconcileScheduler WAITS for
 * it — bounded by the shutdown's own deadline, before the pool closes — so it
 * ends with its fence unit committed rather than cut. One still in flight at
 * the deadline is named in the log and abandoned with the process: its fence
 * unit dies with the pool (nothing of the unit commits), and what of its
 * filesystem apply landed is an idempotent derivation the next boot's run
 * re-checks.
 *
 * IDENTITY: a scheduled run is nobody's request. A timer inherits the async
 * scope it was armed in, so every run ENTERS the scheduler's own scope — no
 * principal, no session, request id `reconcile:<name>`, the installation's
 * default langs — whatever scope started the scheduler. Arming inside a
 * transaction is refused: its timers would carry a handle that expires with it.
 *
 * Fire-and-forget and NON-FATAL, like every boot chore: a failing reconcile is
 * logged and recorded (`last_error` in the gauge), never blocks serving.
 * Gated by DEDALO_RECONCILE_SCHEDULER_ENABLED (an ephemeral/smoke instance must
 * not heal a shared store from the wrong media root).
 *
 * Gate: test/unit/reconcile_scheduler_native.test.ts.
 */

import { config } from '../../config/config.ts';
import { isInTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { runWithRequestLangs } from '../resolve/request_lang.ts';
import { runWithRequestContext } from '../security/request_context.ts';
import {
	abortInFlightReconciles,
	listReconciles,
	type ReconcileDefinition,
	runReconcile,
} from './registry.ts';

/** How soon a DEFERRED run is tried again (capped by the definition's period). */
export const DEFERRED_RETRY_MS = 60_000;

export interface ReconcileSchedulerOptions {
	/** @internal TEST SEAM (named exemption, DEC-12): arm only these registered names. */
	names?: readonly string[];
	/** @internal TEST SEAM (named exemption, DEC-12): the deferral re-arm delay. */
	deferredRetryMs?: number;
	/** @internal TEST SEAM (named exemption, DEC-12): a period per name, in place of `everyMs`. */
	everyMsFor?: Readonly<Record<string, number>>;
}

/** How one scheduled run ended — what decides when the next one is armed. */
type RunOutcome = 'completed' | 'deferred' | 'failed' | 'in_flight';

/** One started schedule: its pending timers, retired by stopReconcileScheduler. */
interface Schedule {
	stopped: boolean;
	readonly timers: Set<ReturnType<typeof setTimeout>>;
	readonly deferredRetryMs: number;
	readonly everyMsFor: Readonly<Record<string, number>>;
}

// Process-lifetime scheduler state (module_state_tripwire allowlisted): the
// schedule armed by startReconcileScheduler (retired by stopReconcileScheduler,
// SIGTERM) and the runs in flight by name (what the shutdown drain awaits) —
// timers, reconcile NAMES and their settling promises, never a request's identity.
let active: Schedule | null = null;
const inFlight = new Map<string, Promise<RunOutcome>>();

/** The definition's period (a test seam may replace it); null for `boot`. */
function periodOf(schedule: Schedule, definition: ReconcileDefinition): number | null {
	if (typeof definition.schedule !== 'object') return null;
	return schedule.everyMsFor[definition.name] ?? definition.schedule.everyMs;
}

/** When the next run is armed after `outcome` — null: this definition is done. */
function nextDelay(
	schedule: Schedule,
	definition: ReconcileDefinition,
	outcome: RunOutcome,
): number | null {
	const period = periodOf(schedule, definition);
	if (outcome === 'deferred' || outcome === 'in_flight') {
		return period === null ? schedule.deferredRetryMs : Math.min(schedule.deferredRetryMs, period);
	}
	return period;
}

/** Enter the scheduler's own scope (module doc: IDENTITY) around one run. */
function inSchedulerScope<T>(name: string, work: () => Promise<T>): Promise<T> {
	return runWithRequestContext(
		{ session: null, requestId: `reconcile:${name}`, clientIp: '' },
		() =>
			runWithRequestLangs(
				{ applicationLang: config.menu.applicationLang, dataLang: config.lang.dataLangDefault },
				work,
			),
	);
}

async function runScheduled(definition: ReconcileDefinition): Promise<RunOutcome> {
	const apply = definition.autoApply !== undefined;
	try {
		const { report } = await runReconcile(definition.name, { apply });
		if (report.deferred !== undefined) {
			console.warn(
				`[reconcile] ${definition.name}: DEFERRED (${report.deferred.reason}) — drift ${report.drift} left, re-armed`,
			);
			return 'deferred';
		}
		if (report.drift > 0) {
			console.warn(
				`[reconcile] ${definition.name}: drift ${report.drift}${apply ? `, applied ${report.applied}` : ' (reported, not applied)'}`,
			);
		}
		return 'completed';
	} catch {
		// Already logged and recorded (last_error in the gauge) by runReconcile;
		// a scheduled run is non-fatal by contract.
		return 'failed';
	}
}

/** One run of `definition`, unless its name is already running (module doc). */
async function runOnce(definition: ReconcileDefinition): Promise<RunOutcome> {
	if (inFlight.has(definition.name)) return 'in_flight';
	const run = inSchedulerScope(definition.name, () => runScheduled(definition));
	inFlight.set(definition.name, run);
	try {
		return await run;
	} finally {
		inFlight.delete(definition.name);
	}
}

async function tick(schedule: Schedule, definition: ReconcileDefinition): Promise<void> {
	if (schedule.stopped) return;
	const outcome = await runOnce(definition);
	const delay = nextDelay(schedule, definition, outcome);
	if (delay !== null) arm(schedule, definition, delay);
}

function arm(schedule: Schedule, definition: ReconcileDefinition, delayMs: number): void {
	if (schedule.stopped) return;
	const timer = setTimeout(() => {
		schedule.timers.delete(timer);
		void tick(schedule, definition);
	}, delayMs);
	timer.unref?.();
	schedule.timers.add(timer);
}

/**
 * Arm the schedule: `boot` and `atBoot` definitions on the next tick, the
 * other interval ones after their period. Idempotent while armed.
 */
export function startReconcileScheduler(options: ReconcileSchedulerOptions = {}): void {
	if (isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'startReconcileScheduler called inside a transaction: its timers would carry a handle that expires with it',
		});
	}
	if (active !== null) return;
	const schedule = newSchedule(options);
	active = schedule;
	for (const definition of scheduledDefinitions(options.names)) {
		const delay = firstDelay(schedule, definition);
		if (delay !== null) arm(schedule, definition, delay);
	}
}

function newSchedule(options: ReconcileSchedulerOptions): Schedule {
	return {
		stopped: false,
		timers: new Set(),
		deferredRetryMs: options.deferredRetryMs ?? DEFERRED_RETRY_MS,
		everyMsFor: options.everyMsFor ?? {},
	};
}

/** The registered definitions, narrowed to `names` when the test seam gives them. */
function scheduledDefinitions(names: readonly string[] | undefined): ReconcileDefinition[] {
	const all = listReconciles();
	return names === undefined ? all : all.filter((definition) => names.includes(definition.name));
}

/** When a definition first runs: next tick for `boot`/`atBoot`, else its period; null = never. */
function firstDelay(schedule: Schedule, definition: ReconcileDefinition): number | null {
	const when = definition.schedule;
	if (when === 'operator') return null;
	if (when === 'boot' || when.atBoot === true) return 0;
	return periodOf(schedule, definition);
}

/**
 * Retire the schedule (SIGTERM drain): nothing new starts, nothing re-arms — and
 * every run IN FLIGHT through the registry (scheduled, operator, or a sweep an
 * ontology write awaits in its commit lane) is signalled to stop
 * (registry.ts abortInFlightReconciles), so a long sweep ends before the pool
 * closes instead of failing record by record after it.
 */
export function stopReconcileScheduler(): void {
	abortInFlightReconciles('server shutdown');
	if (active === null) return;
	active.stopped = true;
	for (const timer of active.timers) clearTimeout(timer);
	active.timers.clear();
	active = null;
}

/**
 * Wait for the scheduled runs in flight to settle (SIGTERM drain, after
 * stopReconcileScheduler — module doc), until `deadlineMs` (epoch ms). Returns
 * the names STILL in flight at the deadline ([] = every run ended). Never
 * throws: a run's failure is already recorded by runReconcile.
 */
export async function drainReconcileScheduler(deadlineMs: number): Promise<string[]> {
	const pending = new Set(inFlight.keys());
	if (pending.size === 0) return [];
	const settled = [...inFlight].map(([name, run]) =>
		run.then(
			() => pending.delete(name),
			() => pending.delete(name),
		),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all(settled),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
		}),
	]);
	clearTimeout(timer);
	return [...pending];
}
