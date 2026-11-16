/**
 * RETENTION REGISTRY — the ONE place that says, for every APPEND-ONLY store the
 * engine writes, how long its rows are kept and how an operator removes them
 * (audit 2026-08-26 P2-9; SEC-20, SEC-21, PUB-14).
 *
 * THE DEFECT THIS CLOSES. The engine already pruned some of its stores and not
 * others, with no way to tell which was which: terminal diffusion jobs at 7
 * days, media process files at 30, error reports at 90 — while `matrix_activity`
 * (one row per state-changing action, one per DENIED LOGIN) and the `dd1758`
 * publication ledger (one row per record per publish run — measured 293 MB for
 * a single 500k-record run) had ZERO prune code anywhere in `src/`, `tools/` or
 * `scripts/`. The job purge even justified itself by pointing at the dd1758
 * ledger as "the durable audit trail", so the one store expected to hold history
 * was the one store with no policy for it. All of it sits inside the database
 * `pg_dump` copies on every backup, which is how unbounded growth becomes a
 * RECOVERY defect before it is a disk defect.
 *
 * WHAT THIS IS. One `RetentionDefinition` per store. Each declares the modules
 * that INSERT into it (`writers` — what the census gate maps its scan hits
 * through) and exactly ONE of two policies:
 *
 *   - `window`  — a configured number of days plus an EXECUTABLE `prune`. The
 *                 engine can run it: `runRetention(name, {apply:true})`, the
 *                 scheduler, or `scripts/`-level callers.
 *   - `forever` — kept permanently, with a REASON. Legitimate for the heritage
 *                 record itself; never legitimate as a default nobody chose.
 *
 * A window whose configured value is 0 keeps rows until an operator sets a
 * window — the difference from before is that the door EXISTS and is named, and
 * a museum can open it without a DBA writing DELETE statements by hand.
 *
 * SHRINK-ONLY: `REGISTERED_NAMES` is the closed set; `registerRetention` refuses
 * a name outside it, so a new append-only store is a deliberate edit here and in
 * the catalog (prune.ts), never a drive-by INSERT.
 */

import { DedaloError } from '../errors/dedalo_error.ts';

/** What one prune run did (or, dry, would do). */
export interface RetentionReport {
	/** Rows the window makes eligible for removal. */
	candidates: number;
	/** Rows this run actually removed (always 0 on a dry run). */
	deleted: number;
	/** The owner's own detail (table name, window, ceilings…). */
	detail: Record<string, unknown>;
}

export interface RetentionRunOptions {
	/** false (the default everywhere) = dry run: count candidates, delete nothing. */
	apply: boolean;
	/** Test seam: the instant the window is measured from. */
	now?: Date;
	/**
	 * Rows per prune step for the BATCHED stores (matrix_activity, the dd1758
	 * ledger — core/db/batched_prune.ts); default RETENTION_PRUNE_BATCH_ROWS.
	 * Stores bounded otherwise (error_reports' row ceiling, the jobs table, the
	 * sqlite session store) ignore it.
	 */
	batchRows?: number;
	/** Stop a batched prune BETWEEN steps (the scheduler's SIGTERM drain). */
	signal?: AbortSignal;
}

/** A store kept for a configured number of days, with an executable prune. */
export interface RetentionWindowPolicy {
	kind: 'window';
	/** The config key an operator sets (0 = keep until they choose a window). */
	configKey: string;
	/** The window as configured RIGHT NOW (read per run, never captured at boot). */
	windowDays: () => number;
	/** Count (dry) or remove (apply) the rows outside the window. */
	prune: (options: RetentionRunOptions) => Promise<RetentionReport>;
}

/** A store kept permanently, on purpose, with the purpose written down. */
export interface RetentionForeverPolicy {
	kind: 'forever';
	/** Why permanence is the CORRECT rule for this store — not "nobody got to it". */
	reason: string;
}

export type RetentionPolicy = RetentionWindowPolicy | RetentionForeverPolicy;

export interface RetentionDefinition {
	/** Stable identifier — the CLI/scheduler key. */
	name: string;
	/** The store in operator words (a table name, a directory). */
	store: string;
	/** One operator sentence: what accumulates here and what a prune removes. */
	description: string;
	/**
	 * The repo-relative modules that INSERT into this store. The census gate
	 * (test/unit/store_retention_tripwire.test.ts) derives every INSERT site in
	 * `src/` from the tree and maps it through these lists, so a new writer for a
	 * classified store is free and a writer for an UNCLASSIFIED store is RED.
	 */
	writers: readonly string[];
	policy: RetentionPolicy;
}

/**
 * The closed set of store names. Shrink-only: removing an entry means the store
 * itself is gone, adding one is a deliberate decision recorded in prune.ts.
 */
export const REGISTERED_NAMES: readonly string[] = [
	'matrix_records',
	'matrix_time_machine',
	'matrix_activity',
	'diffusion_publication_ledger',
	'diffusion_jobs',
	'error_reports',
	'session_store',
	'rag_index',
	'ontology_projection',
];

const definitions = new Map<string, RetentionDefinition>();

/** Register one store's retention rule (called from prune.ts, once per store). */
export function registerRetention(definition: RetentionDefinition): void {
	if (!REGISTERED_NAMES.includes(definition.name)) {
		throw new DedaloError('internal.invariant', {
			message: `retention: '${definition.name}' is not in REGISTERED_NAMES — add it there and in the catalog, deliberately`,
		});
	}
	if (definition.writers.length === 0) {
		throw new DedaloError('internal.invariant', {
			message: `retention: '${definition.name}' declares no writer module`,
		});
	}
	definitions.set(definition.name, definition);
}

/** Every registered store, in registration order. */
export function listRetentions(): RetentionDefinition[] {
	return [...definitions.values()];
}

export function getRetention(name: string): RetentionDefinition | undefined {
	return definitions.get(name);
}

/**
 * Run ONE store's retention. A `forever` store reports zero and writes nothing —
 * the caller does not have to know which kind it asked for.
 */
export async function runRetention(
	name: string,
	options: RetentionRunOptions,
): Promise<RetentionReport> {
	const definition = definitions.get(name);
	if (definition === undefined) {
		throw new DedaloError('internal.invariant', { message: `retention: unknown store '${name}'` });
	}
	if (definition.policy.kind === 'forever') {
		return { candidates: 0, deleted: 0, detail: { kept_forever: definition.policy.reason } };
	}
	return definition.policy.prune(options);
}
