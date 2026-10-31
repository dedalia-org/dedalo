/**
 * RECONCILE REGISTRY — the ONE shape every cross-store reconcile takes
 * (audit 2026-08-26 S-10).
 *
 * THE DEFECT THIS CLOSES. Dédalo keeps several derived or paired stores next to
 * the matrix: the media tree, the `files_info` disk cache inside the media
 * column, observer mirror slots, the RAG vector index, the publication marker
 * store, the `dd_ontology` projection of its source records, the hierarchy
 * registry's provisioning. Each pair can drift (a restore, a bypass write, a
 * crash between two commits), and each had grown its OWN reconcile — a widget
 * action here, a CLI there, a boot fire-and-forget, an injected callback —
 * with no common way to LIST them, RUN them dry, or SEE their last verdict.
 * An operator on restore day had to know seven doors.
 *
 * WHAT THIS IS. A registry of `ReconcileDefinition`s. Each owner module keeps
 * its logic untouched and exports ONE definition: what it compares, how it is
 * scheduled, and a `run({apply})` that reports drift without writing (the
 * default) or repairs it. The registry remembers the last run per name and
 * publishes them as ONE ops gauge (`reconcile` on GET /api/v1/counters). The
 * doors are then generic: the `reconcile_status` maintenance widget,
 * `scripts/reconcile.ts`, and the boot/interval scheduler (scheduler.ts).
 *
 * The census gate (test/unit/reconcile_registry_tripwire.test.ts) derives every
 * reconcile-shaped module in the tree and demands it be registered here with
 * every facet, or sit in a shrink-only exemption with a reason — so an eighth
 * reconcile cannot land as an eighth shape.
 *
 * SHRINK-ONLY: `REGISTERED_NAMES` below is the closed set the assembly
 * (catalog.ts) must produce; `registerReconcile` refuses a name outside it, so a
 * new reconcile is a deliberate edit here AND a catalog entry, never a drive-by.
 */

import { registerOpsGauge } from '../api/counters.ts';
import { DedaloError } from '../errors/dedalo_error.ts';

/**
 * When a reconcile runs by itself (scheduler.ts runs them).
 *  - `operator`: only when an operator asks (widget/CLI). The default for
 *    anything that walks a large store or repairs destructively.
 *  - `boot`: after the server listens (cheap hygiene) — until a run completes:
 *    a DEFERRED run (ReconcileReport.deferred) is re-armed.
 *  - `{ everyMs }`: on an interval while the server lives, `atBoot` also once
 *    after it listens; a deferred run is re-armed sooner than the period.
 */
export type ReconcileSchedule = 'operator' | 'boot' | { everyMs: number; atBoot?: boolean };

/** The scope a run may be narrowed to — per definition (see `scopeLabel`). */
export type ReconcileScope = readonly string[];

export interface ReconcileRunOptions {
	/** false (default everywhere) = dry run: report drift, write nothing. */
	apply: boolean;
	/** Narrow the run (definition-specific; `scopeLabel` says what a value is). */
	scope?: ReconcileScope;
	/**
	 * The CALLER's abort (e.g. the running job's stop / deadline — media/job_scope.ts
	 * currentJobSignal). `runReconcile` composes it with the registry's own
	 * shutdown abort ({@link abortInFlightReconciles}) and hands the definition
	 * the composed signal; a long-running definition checks it between units
	 * and throws a typed error, which `runReconcile` records like any failure.
	 * A definition that walks nothing large may ignore it.
	 */
	signal?: AbortSignal;
}

export interface ReconcileReport {
	/** Units of disagreement found between the two stores (0 = in sync). */
	drift: number;
	/** Units repaired by THIS run (always 0 on a dry run). */
	applied: number;
	/** The owner's own report — whatever its consumers already read. */
	detail: Record<string, unknown>;
	/**
	 * Set when an APPLY could not happen NOW and nothing was applied (another
	 * writer held the store past the run's bound — media_index's fence): the
	 * repair is still owed, and the scheduler re-arms the run until one completes.
	 * `reason` names what held it off. Absent on a run that completed.
	 */
	deferred?: { reason: string };
}

export interface ReconcileDefinition {
	/** Stable identifier — the widget/CLI/gauge key. */
	name: string;
	/** The two stores compared, in the owner's words. Must differ. */
	stores: readonly [string, string];
	/** One operator sentence: what drift means here and what apply does. */
	description: string;
	/** What a `scope` entry is (a section tipo, a TLD, …); null when unscopable. */
	scopeLabel: string | null;
	schedule: ReconcileSchedule;
	/**
	 * A SCHEDULED run applies rather than reports. Only for a repair that is
	 * pure hygiene (idempotent, non-destructive) — say why.
	 */
	autoApply?: { reason: string };
	/**
	 * An OPERATOR apply through the maintenance door (reconcile_status.run_reconcile) is
	 * root-only, not merely global admin — say why. Scheduled / post-restore runs carry no
	 * principal and are unaffected; the owner's own root door may still apply.
	 */
	applyRootOnly?: { reason: string };
	/**
	 * An APPLY is never offered through the registry's doors (widget, CLI, scheduler):
	 * the repair has its own door — say which, and why. `runReconcile` refuses such an
	 * apply BEFORE `run` (`request.invalid`, nothing recorded), and the doors publish it
	 * as `applyPolicyOf` = `'refused'` so no client offers a button that cannot succeed.
	 * Exclusive with `applyRootOnly` and `autoApply` (both are about an apply that runs).
	 */
	applyRefused?: { reason: string };
	/** The repo-relative modules this definition wraps (owner + shells) — the census maps hits through it. */
	sources: readonly string[];
	run(options: ReconcileRunOptions): Promise<ReconcileReport>;
}

/** The last outcome the registry saw for one definition. */
export interface ReconcileRunRecord {
	name: string;
	apply: boolean;
	scope: ReconcileScope | null;
	ranAt: string;
	durationMs: number;
	drift: number;
	applied: number;
	/** The report's `deferred.reason` — the apply did not happen and is owed — else null. */
	deferred: string | null;
	/**
	 * Set when the run threw: the DedaloError CODE (or `internal.unexpected`
	 * for an untyped throw) — never the exception text, which goes to the log.
	 * drift/applied are then 0 and meaningless.
	 */
	error: string | null;
}

/**
 * The CLOSED set of registered reconciles (shrink/grow deliberately, with the
 * catalog). Order = the widget/CLI listing order.
 */
export const REGISTERED_NAMES: readonly string[] = [
	'counters_media',
	'files_info',
	'observer_mirrors',
	'media_index',
	'rag_index',
	'ontology',
	'ontology_identifiers',
	'hierarchy',
	'public_tier',
	'publication_apis',
	'media_copy',
	'publication_probe',
	'rich_text_images',
	'web_image_exposure',
	'portal_declared_order',
];

// Process-lifetime registry state (module_state_tripwire allowlisted): the
// definitions are boot-stable wiring, the run records are ops visibility — the
// same lifecycle as core/api/counters.ts gaugeProviders.
const definitions = new Map<string, ReconcileDefinition>();
const lastRuns = new Map<string, ReconcileRunRecord>();
// One controller per run IN FLIGHT through runReconcile, added before `run` and
// removed when it settles — so the SIGTERM drain (scheduler.ts
// stopReconcileScheduler → abortInFlightReconciles) can stop a long sweep a
// request or a job is awaiting, without poisoning a later run (each run gets a
// fresh controller). Holds controllers only, no request identity.
const inFlightAborts = new Set<AbortController>();

/** Register one definition. Idempotent per name (same object re-registered = no-op). */
export function registerReconcile(definition: ReconcileDefinition): void {
	validateDefinition(definition);
	const existing = definitions.get(definition.name);
	if (existing !== undefined && existing !== definition) {
		throw new DedaloError('internal.invariant', {
			message: `reconcile '${definition.name}' registered twice with different definitions`,
		});
	}
	definitions.set(definition.name, definition);
	ensureGauge();
}

/** The reason-required facets: each one declared must say why; a refused apply excludes the others. */
function facetProblems(definition: ReconcileDefinition): string[] {
	const facets = {
		autoApply: definition.autoApply,
		applyRootOnly: definition.applyRootOnly,
		applyRefused: definition.applyRefused,
	};
	const problems = Object.entries(facets).flatMap(([facet, value]) =>
		value !== undefined && value.reason.trim() === '' ? [`${facet} needs a reason`] : [],
	);
	if (
		definition.applyRefused !== undefined &&
		(definition.applyRootOnly !== undefined || definition.autoApply !== undefined)
	) {
		problems.push('applyRefused excludes applyRootOnly and autoApply (an apply that never runs)');
	}
	return problems;
}

/**
 * Who may APPLY a definition through the registry's operator doors — the ONE derivation
 * every door publishes (the reconcile_status row, the CLI listing):
 *  - `'refused'` — nobody: `applyRefused` (the repair has its own door);
 *  - `'root'`    — the root user only: `applyRootOnly`;
 *  - `'admin'`   — whoever may open the door (a global admin).
 */
export type ReconcileApplyPolicy = 'admin' | 'root' | 'refused';

export function applyPolicyOf(definition: ReconcileDefinition): ReconcileApplyPolicy {
	if (definition.applyRefused !== undefined) return 'refused';
	if (definition.applyRootOnly !== undefined) return 'root';
	return 'admin';
}

/** The declared reason behind a non-`'admin'` apply policy (null for `'admin'`). */
export function applyPolicyReason(definition: ReconcileDefinition): string | null {
	return definition.applyRefused?.reason ?? definition.applyRootOnly?.reason ?? null;
}

/** operator | boot | {everyMs > 0, atBoot?: boolean} — nothing else schedules a run. */
function isValidSchedule(schedule: ReconcileSchedule): boolean {
	if (schedule === 'operator' || schedule === 'boot') return true;
	return typeof schedule === 'object' && isValidInterval(schedule);
}

function isValidInterval(schedule: { everyMs: number; atBoot?: boolean }): boolean {
	const atBoot = schedule.atBoot;
	return (
		Number.isFinite(schedule.everyMs) &&
		schedule.everyMs > 0 &&
		(atBoot === undefined || typeof atBoot === 'boolean')
	);
}

/** The facet contract, enforced at registration so a half definition cannot hide. */
export function validateDefinition(definition: ReconcileDefinition): void {
	const problems: string[] = [];
	if (!REGISTERED_NAMES.includes(definition.name)) {
		problems.push(`name '${definition.name}' is not in REGISTERED_NAMES (registry.ts)`);
	}
	if (definition.stores.length !== 2 || definition.stores[0] === definition.stores[1]) {
		problems.push('stores must name two DIFFERENT stores');
	}
	if (definition.description.trim() === '') problems.push('description is empty');
	if (definition.sources.length === 0) problems.push('sources is empty');
	if (typeof definition.run !== 'function') problems.push('run is not a function');
	if (!isValidSchedule(definition.schedule)) {
		problems.push('schedule must be operator | boot | {everyMs > 0, atBoot?: boolean}');
	}
	problems.push(...facetProblems(definition));
	if (problems.length > 0) {
		throw new DedaloError('internal.invariant', {
			message: `reconcile definition '${definition.name}' is incomplete: ${problems.join('; ')}`,
		});
	}
}

/** Every registered definition, in REGISTERED_NAMES order. */
export function listReconciles(): ReconcileDefinition[] {
	return REGISTERED_NAMES.flatMap((name) => {
		const definition = definitions.get(name);
		return definition === undefined ? [] : [definition];
	});
}

export function getReconcile(name: string): ReconcileDefinition | null {
	return definitions.get(name) ?? null;
}

/** The last run record per name (null when it never ran in this process). */
export function lastReconcileRun(name: string): ReconcileRunRecord | null {
	return lastRuns.get(name) ?? null;
}

/**
 * The registered definition `name` names, when this request may run it: unknown
 * names are `resource.not_found`; an APPLY of an `applyRefused` definition is
 * `request.invalid`. Neither is a run, so the caller records nothing.
 */
function runnableDefinition(name: string, apply: boolean): ReconcileDefinition {
	const definition = definitions.get(name);
	if (definition === undefined) {
		throw new DedaloError('resource.not_found', {
			message: `reconcile '${name}' is not registered`,
			coordinates: { reconcile: name },
		});
	}
	if (apply && definition.applyRefused !== undefined) {
		// Not a run: nothing ran, so nothing is recorded (the gauge keeps the last real run).
		throw new DedaloError('request.invalid', {
			message: `reconcile '${name}': apply is refused through the registry — ${definition.applyRefused.reason}`,
			publicMessage: `The '${name}' reconcile cannot be applied here: ${definition.applyRefused.reason}`,
			coordinates: { reconcile: name },
		});
	}
	return definition;
}

/**
 * Run one reconcile through the registry, so the outcome (or the failure) is
 * remembered and published. Rethrows after recording — a caller must still
 * see its error.
 */
export async function runReconcile(
	name: string,
	options: ReconcileRunOptions,
): Promise<{ report: ReconcileReport; record: ReconcileRunRecord }> {
	const definition = runnableDefinition(name, options.apply);
	const startedAt = Date.now();
	const base = {
		name,
		apply: options.apply,
		scope: options.scope ?? null,
		ranAt: new Date(startedAt).toISOString(),
	};
	const controller = new AbortController();
	inFlightAborts.add(controller);
	const signal =
		options.signal === undefined
			? controller.signal
			: AbortSignal.any([controller.signal, options.signal]);
	try {
		const report = await definition.run({ ...options, signal });
		const record: ReconcileRunRecord = {
			...base,
			durationMs: Date.now() - startedAt,
			drift: report.drift,
			applied: report.applied,
			deferred: report.deferred?.reason ?? null,
			error: null,
		};
		lastRuns.set(name, record);
		return { report, record };
	} catch (error) {
		// The gauge is a wire surface: record the CODE, log the text.
		console.error(`[reconcile] ${name} (${options.apply ? 'apply' : 'dry'}) failed:`, error);
		lastRuns.set(name, {
			...base,
			durationMs: Date.now() - startedAt,
			drift: 0,
			applied: 0,
			deferred: null,
			error: error instanceof DedaloError ? error.code : 'internal.unexpected',
		});
		throw error;
	} finally {
		inFlightAborts.delete(controller);
	}
}

/**
 * Abort every run IN FLIGHT through runReconcile (the SIGTERM drain:
 * scheduler.ts stopReconcileScheduler). A definition honouring its signal stops
 * at its next unit and its run is recorded failed (typed); one that ignores it
 * runs on. Returns how many runs were signalled. Later runs are unaffected.
 */
export function abortInFlightReconciles(reason: string): number {
	const count = inFlightAborts.size;
	for (const controller of inFlightAborts) controller.abort(reason);
	return count;
}

/** The gauge payload: per registered name, its schedule and last run. */
export function reconcileGauge(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const definition of listReconciles()) {
		const last = lastRuns.get(definition.name) ?? null;
		out[definition.name] = {
			schedule: definition.schedule,
			auto_apply: definition.autoApply !== undefined,
			last_run_at: last?.ranAt ?? null,
			last_apply: last?.apply ?? null,
			last_drift: last?.drift ?? null,
			last_applied: last?.applied ?? null,
			last_deferred: last?.deferred ?? null,
			last_error: last?.error ?? null,
		};
	}
	return out;
}

let gaugeRegistered = false;
function ensureGauge(): void {
	if (gaugeRegistered) return;
	gaugeRegistered = true;
	registerOpsGauge('reconcile', reconcileGauge);
}

/** Tests only: forget run records (definitions stay — they are wiring). */
export function resetReconcileRunsForTests(): void {
	lastRuns.clear();
}
