/**
 * THE BATCHED-PRUNE DRIVER (T1-24 / S17 + D02) — the control flow every
 * age-window prune runs under, so none of them is one unbounded statement.
 *
 * WHY. An append-only log reaches tens of millions of rows (33 M measured on a
 * matrix_activity). A prune written as ONE `DELETE … WHERE "timestamp" < cutoff`
 * either runs for minutes under the request statement ceiling
 * (`DB_STATEMENT_TIMEOUT_MS`) and is rolled back — every day, forever, never
 * making progress — or forces the ceiling off for the whole engine. Batched,
 * each step is a short AUTOCOMMIT statement: progress persists across a
 * timeout, a lock conflict or a shutdown, and the next pass resumes where the
 * last stopped (the rows already removed stay removed).
 *
 * THE SPLIT (sql_confinement): this module owns NO SQL. Each store's owner
 * (matrix_write.ts for matrix_activity, diffusion_delete.ts for the dd1758
 * ledger) writes its own keyset step — the same predicate for dry and apply,
 * so what an operator is shown is what the commit removes — and hands it here.
 *
 * NEVER WRAP THE LOOP IN A TRANSACTION: a batch that commits only with the
 * whole run is the unbatched prune again.
 */

/**
 * Rows per step. Sized so one step is far below the default 60 s statement
 * ceiling (default 60 s): measured 2026-11-12 on the suite database against a
 * 500 000-row scratch ledger (dd1758 shape, `btree("timestamp")`, every row
 * settled and aged, the pending predicate evaluated per row) — 51 steps, ~48 ms
 * per apply step and ~20 ms per dry step; three orders of magnitude of headroom
 * for a cold cache, a wide row or a slow disk.
 */
export const RETENTION_PRUNE_BATCH_ROWS = 10_000;

/**
 * The keyset position after a step: the last row it SAW, in `("timestamp", id)`
 * order. `ts` is the column's own text form (`"timestamp"::text`), never a JS
 * `Date` — a Date truncates to milliseconds, and a µs-precision log would then
 * skip or repeat the rows sharing a millisecond across a batch boundary.
 */
export interface PruneCursor {
	ts: string;
	id: number;
}

/** What one keyset step saw and (apply) removed. */
export interface PruneStepResult {
	/** Rows the step matched (≤ limit). Fewer than `limit` = the window is exhausted. */
	seen: number;
	/** Rows the step removed (0 on a dry step). */
	deleted: number;
	/** The last row seen, or null when the step saw none. */
	last: PruneCursor | null;
}

/**
 * The row every owner's keyset step statement answers (one row: `seen`,
 * `deleted`, and the last row's `"timestamp"::text` / id — null when the step
 * saw nothing). The shape is shared; the statement is the owner's.
 */
export interface PruneStepRow {
	seen: number | string;
	deleted: number | string;
	last_ts: string | null;
	last_id: number | string | null;
}

/** Fold a step statement's row into a PruneStepResult. */
export function pruneStepResult(row: PruneStepRow | undefined): PruneStepResult {
	if (row === undefined) return { seen: 0, deleted: 0, last: null };
	const last =
		row.last_ts === null || row.last_id === null
			? null
			: { ts: row.last_ts, id: Number(row.last_id) };
	return { seen: Number(row.seen), deleted: Number(row.deleted), last };
}

/** One keyset step: the rows after `after` (null = from the start), at most `limit`. */
export type PruneStep = (
	after: PruneCursor | null,
	limit: number,
	apply: boolean,
) => Promise<PruneStepResult>;

/** The options every batched prune takes (threaded from RetentionRunOptions). */
export interface PruneBatchOptions {
	apply: boolean;
	/** Rows per step (default RETENTION_PRUNE_BATCH_ROWS); a test seam and an ops override. */
	batchRows?: number;
	/** Stop BETWEEN steps when aborted (SIGTERM drain) — what committed so far stands. */
	signal?: AbortSignal;
}

/** The outcome of a batched prune. */
export interface PruneBatchOutcome {
	/** Rows the window made eligible (sum of `seen`; dry = the full count). */
	candidates: number;
	/** Rows removed (always 0 on a dry run). */
	deleted: number;
	/** Steps run. */
	batches: number;
	/** The rows-per-step used. */
	batchRows: number;
	/** 'aborted' when the signal stopped the loop before the window was exhausted. */
	stopped: 'aborted' | null;
}

/** The effective rows-per-step: a positive integer, else the default. */
export function effectiveBatchRows(batchRows: number | undefined): number {
	if (batchRows === undefined || !Number.isInteger(batchRows) || batchRows <= 0) {
		return RETENTION_PRUNE_BATCH_ROWS;
	}
	return batchRows;
}

/**
 * Run `step` until a step sees fewer rows than the batch size, or the signal
 * aborts between steps. Each step is its own committed statement.
 */
export async function pruneInBatches(
	step: PruneStep,
	options: PruneBatchOptions,
): Promise<PruneBatchOutcome> {
	const batchRows = effectiveBatchRows(options.batchRows);
	const outcome: PruneBatchOutcome = {
		candidates: 0,
		deleted: 0,
		batches: 0,
		batchRows,
		stopped: null,
	};
	let after: PruneCursor | null = null;
	for (;;) {
		if (options.signal?.aborted === true) {
			outcome.stopped = 'aborted';
			return outcome;
		}
		const result = await step(after, batchRows, options.apply);
		outcome.batches++;
		outcome.candidates += result.seen;
		outcome.deleted += result.deleted;
		if (result.seen < batchRows || result.last === null) return outcome;
		after = result.last;
	}
}
