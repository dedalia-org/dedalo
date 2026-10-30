/**
 * THE EXPORT SELECTION CURSOR (PERF-1) — an export's record selection, paged
 * out of ONE snapshot instead of loaded whole.
 *
 * Before: `openExportGrid` fetched every (section_tipo, section_id) of the
 * filtered selection with one statement before the first line — a million-row
 * export held a million rows in the process before hydrating the first. Now the
 * selection is a server-side cursor on a reserved connection:
 *
 *   BEGIN
 *   SELECT set_config('transaction_timeout', current_setting('statement_timeout'), true)
 *   DECLARE <name> SCROLL CURSOR WITH HOLD FOR <selection>
 *   COMMIT
 *
 * The COMMIT MATERIALIZES the result once, in ONE snapshot (a hold cursor
 * outlives its transaction by being computed in full at commit), so the order
 * is the one-statement order by construction and a record written mid-export
 * is neither emitted nor counted. `MOVE FORWARD ALL` answers the exact total
 * from its command tag (Bun's `.count`) without moving a row to the process;
 * `MOVE ABSOLUTE 0` rewinds; each page is one `FETCH FORWARD <pageRows>`.
 *
 * THE MATERIALIZATION IS BOUNDED BY THE CONNECTION'S OWN CEILING. PostgreSQL
 * disarms `statement_timeout` BEFORE a commit runs (postgres.c
 * finish_xact_command), so the commit that computes a hold cursor ran the
 * whole selection with no ceiling at all — an autocommit DECLARE outlived a
 * 300 ms ceiling by seconds (W3 review, measured). `transaction_timeout`
 * (PostgreSQL 17+; the engine targets 18) stays armed THROUGH the commit, so
 * the cursor's transaction carries it, set transaction-locally to the reserved
 * connection's own `statement_timeout`: the request pool's
 * DB_STATEMENT_TIMEOUT_MS, the maintenance pool's 0 (unbounded) — the same
 * ceiling the single selection statement had, never a second key. A selection
 * past it is the typed 503 `db.statement_timeout` (PostgreSQL ends that
 * backend — 25P04 is FATAL — and the pool replaces the connection).
 * Transaction-local (`set_config(…, true)`), so no exit — commit, rollback, a
 * killed backend — leaves the GUC on a pooled connection; a failed open ROLLs
 * BACK before the connection goes back (close()).
 *
 * A SELECTION CARRYING A `referenced_by` LEAF arms the SEARCH budget instead
 * (core/search/search_statement.ts searchCursorSource: REFERENCED_BY_SEARCH_BUDGET_MS,
 * never above the connection's own ceiling): the same transaction_timeout,
 * because the expensive part is the materializing COMMIT, not a FETCH (the
 * FETCHes read the materialized rows). Past it: `db.statement_timeout` with the
 * search door's coordinates `{ door: 'referenced_by_search', ceiling_ms }`.
 *
 * A STOP CUTS THE SELECTION WHILE IT IS BUILT. The caller's signal firing
 * DURING the open (the user's Stop, the lane deadline, a shutdown) cancels the
 * statement the cursor's transaction is running at that moment — the
 * materializing COMMIT included — on the server (postgres.ts
 * cancelBackendStatement: pg_cancel_backend on a dedicated connection, guarded
 * by the transaction's start, so it never reaches a later statement on that
 * backend), and is STICKY at the open's statement door: a cancel that lands
 * while the backend sits idle between two statements reaches nothing, so no
 * further statement is sent once the signal fired (that also covers an abort
 * while the open still waits for a pooled connection). The open rejects with
 * `export.cancelled` — the user's Stop, never a raw 57014 — the transaction
 * rolled back, the slot and the connection released. A signal that had ALREADY
 * fired when the open began is not a Stop of this open: it still answers its
 * total and serves no page (below). The request path carries no signal (the
 * server has no request.signal plumbing — api/dispatch.ts GATE 4), so a
 * disconnect there is bounded by the ceiling alone.
 *
 * ONE TOTAL PATH, measured: the command tag's count is the only source of the
 * total. A driver that stopped surfacing it is refused loudly at open
 * (`internal.invariant`) — never answered by a second, unexercised counting
 * path (the earlier count(*)-in-a-snapshot fallback was deleted: its snapshot
 * property had no gate that could fail). The gate pins the driver fact itself
 * (export_selection_cursor_native leg 8: a raw MOVE carries a numeric count).
 *
 * ADMISSION FIRST. A cursor holds a pooled connection for the export's whole
 * life, so the number open at once is bounded per process:
 * EXPORT_SELECTION_SLOTS = max(1, floor(DB_POOL_MAX / 4)) — derived, no key of
 * its own. Two admissions, by who is waiting (`admission`):
 *
 *  - `'refuse'` (the default — the REQUEST path: get_export_grid buffered or
 *    streamed): with every slot held the open is refused EAGERLY with
 *    `export.busy` (503, retryable) before any connection is reserved — never
 *    queued on the pool, where it would starve the request path;
 *  - `'queue'` (the BACKGROUND export lane, export_job.ts runExportArtifact): a
 *    job the lane already admitted WAITS for a slot, FIFO, instead of failing —
 *    the lane's budget (DEDALO_JOB_LANE_EXPORT_CONCURRENCY) may exceed the
 *    slots, and a queued export must never die of "busy". A freed slot is HANDED
 *    to the first waiter (it never returns to the free count while one waits),
 *    so a stream of eager opens cannot starve a queued job. The wait ends with
 *    the job's signal (`export.cancelled`): a stop, a deadline or a shutdown
 *    reaches a waiting export too.
 *
 * NO RESERVED SLOT (owner decision 2026-10-21, D4). Both admissions draw on the
 * ONE shared pool of EXPORT_SELECTION_SLOTS; neither lane has a slot the other
 * cannot take. So background exports that hold every slot make a request-path
 * open answer `export.busy` (retryable) until one ends, and request-path cursors
 * that hold every slot make a background export wait — the hand-off above is
 * what keeps that wait finite. A reserved request slot was considered and
 * declined: below DB_POOL_MAX 8 there is ONE slot, so reserving it would leave
 * the background lane none at all; above, it caps the background lane one slot
 * short of the pool while the reserved slot mostly idles.
 * Gate: export_selection_cursor_native legs 6 + 6b (no slot reserved for either
 * lane) and 12 (hand-off).
 *
 * A pool of ONE connection admits no cursor at all, in either admission: the
 * cursor would hold the only connection the export's own hydration needs (a
 * self-deadlock), so such a server refuses exports with `export.busy` and says
 * why in the operator message — a queued job too, since no slot will ever free.
 *
 * RELEASE IS TOTAL. `close()` is idempotent (CLOSE, release the connection,
 * free the slot, clear the timer) and runs on: exhaustion (an empty FETCH), the
 * iterator's `return()` / `throw()` — even before the first pull — the caller's
 * abort signal, and a CONSUMER-IDLE expiry. Any failure while opening closes
 * and rethrows, so the caller's eager-refusal contract (a refusal is a rejected
 * promise, never a half-written stream) holds.
 *
 * IDLE IS THE CONSUMER'S, NEVER THE PRODUCER'S. The window
 * (EXPORT_CURSOR_IDLE_MS) runs ONLY while control sits with the export's
 * consumer — the HTTP client of an NDJSON body that stopped reading, a caller
 * that never pulls — and is stopped while the export works for it (hydrating a
 * page, external prefetch, tabulation): an export that runs for hours at a few
 * records a second is legitimate (the export lane has no deadline by design,
 * src/core/media/jobs.ts) and must never be cut by it. The OWNER drives the
 * window (`consumerWaiting`): the grid stops it when its consumer pulls a line
 * and restarts it when the line is handed over (grid.ts closingLines). It is
 * armed at open (nobody has pulled yet), and a page pull stops it (a pull is
 * the consumer acting). On expiry the cursor closes and the next pull throws
 * `export.consumer_idle` — its own code, never `export.cancelled`, so a stalled
 * reader is never reported as the user's Stop.
 *
 * Gate: test/unit/export_selection_cursor_native.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/config.ts';
import {
	type BackendCancelTarget,
	cancelBackendStatement,
	readCancelTarget,
	sql,
	sqlStateOf,
} from '../../core/db/postgres.ts';
import { DedaloError } from '../../core/errors/index.ts';
import {
	referencedBySearchTimeout,
	type SearchStatement,
	searchCursorSource,
} from '../../core/search/search_statement.ts';

/** Selection cursors open at once in this process (see module doc). */
export const EXPORT_SELECTION_SLOTS =
	config.ops.dbPoolMax >= 2 ? Math.max(1, Math.floor(config.ops.dbPoolMax / 4)) : 0;

/**
 * The most rows ONE FETCH may move to the process — the cursor's whole point
 * is that the selection arrives in pages, so a page size past this would bring
 * back the whole-selection load it removed. The grid's page (grid.ts) is this.
 */
export const SELECTION_PAGE_ROWS_MAX = 10_000;

/** A consumer that holds control this long without pulling is closed out (see module doc). */
export const EXPORT_CURSOR_IDLE_MS = 15 * 60 * 1000;

/** A background export waiting for a slot (admission 'queue'). */
interface SlotWaiter {
	/** The slot is now this waiter's (handed over by releaseSlot). */
	grant(): void;
}

/**
 * The admission state: slots taken right now, and the background exports
 * waiting for one (FIFO). Process-local by design: it bounds THIS process's
 * pooled connections, which is what the pool it protects is. Request-
 * independent (no identity lands in it): a counter and resolvers.
 */
const selectionAdmission: { inUse: number; waiters: SlotWaiter[] } = { inUse: 0, waiters: [] };

/** Observability / gates: the admission bound, its current use, and the queue. */
export function exportSelectionSlots(): { slots: number; inUse: number; waiting: number } {
	return {
		slots: EXPORT_SELECTION_SLOTS,
		inUse: selectionAdmission.inUse,
		waiting: selectionAdmission.waiters.length,
	};
}

/** Give a slot back: to the first waiter when one waits (handed over), else free. */
function releaseSlot(): void {
	const next = selectionAdmission.waiters.shift();
	if (next !== undefined) next.grant();
	else selectionAdmission.inUse--;
}

/**
 * Take a slot (see the module doc's ADMISSION). Resolves holding it; rejects
 * with `export.busy` (refused, or no slot can ever exist) or, for a queued
 * waiter whose signal fired, `export.cancelled` — holding nothing.
 */
async function acquireSlot(
	admission: SelectionAdmission,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (EXPORT_SELECTION_SLOTS === 0) {
		throw exportBusy(
			`DB_POOL_MAX=${config.ops.dbPoolMax}: a cursor would hold the only pooled connection the export's own hydration needs — exports need DB_POOL_MAX >= 2`,
		);
	}
	if (selectionAdmission.inUse < EXPORT_SELECTION_SLOTS) {
		selectionAdmission.inUse++;
		return;
	}
	if (admission !== 'queue') {
		throw exportBusy(`all ${EXPORT_SELECTION_SLOTS} selection slot(s) are held`);
	}
	if (signal?.aborted === true) throw waitCancelled();
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			const at = selectionAdmission.waiters.indexOf(waiter);
			if (at >= 0) selectionAdmission.waiters.splice(at, 1);
			reject(waitCancelled());
		};
		const waiter: SlotWaiter = {
			grant: () => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			},
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		selectionAdmission.waiters.push(waiter);
	});
}

function waitCancelled(): DedaloError {
	return new DedaloError('export.cancelled', {
		message: 'export selection cursor: the export was stopped while it waited for a selection slot',
	});
}

/** An open selection: its exact total, its pages, and the one way to end it. */
export interface SelectionCursor<Row> {
	/** Rows in the snapshot — exactly what `pages` yields when drained. */
	readonly total: number;
	/** One FETCH per page; `[]` from the server ends it (and closes). */
	readonly pages: AsyncIterableIterator<Row[]>;
	/** Idempotent: CLOSE, release the connection and the slot. */
	close(): Promise<void>;
	/**
	 * The consumer-idle window (see module doc): `true` — control is with the
	 * consumer, the window runs (restarted); `false` — the export is working
	 * for it, the window stops. A no-op once closed.
	 */
	consumerWaiting(waiting: boolean): void;
}

/** How an open with every slot held is answered (see the module doc's ADMISSION). */
export type SelectionAdmission = 'refuse' | 'queue';

export interface SelectionCursorOptions {
	/** Rows per FETCH (an integer in [1, SELECTION_PAGE_ROWS_MAX]). */
	pageRows: number;
	/**
	 * Closes the cursor when it fires (fired already: the total is counted, no
	 * page served); for admission 'queue', also ends the wait for a slot.
	 */
	signal?: AbortSignal;
	/** Default 'refuse' (the request path); 'queue' only for the background lane. */
	admission?: SelectionAdmission;
	/**
	 * @internal TEST SEAM (named exemption, DEC-12): the consumer-idle window in
	 * ms (default EXPORT_CURSOR_IDLE_MS). Only a gate moves it, to prove a
	 * stalled consumer is closed out while a slow export is not.
	 */
	idleMs?: number;
}

/** The cursor transaction's control statements (see the module doc). */
const CURSOR_TX = { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' } as const;

/** SQLSTATE transaction_timeout — the materialization's ceiling (see the module doc). */
const TRANSACTION_TIMEOUT = '25P04';

/**
 * The leaf selection's transaction_timeout: the search budget, never above the
 * connection's own statement ceiling (0 = none). pg_settings reports it in ms.
 * Answers the applied value as `<n>ms`.
 */
const LEAF_TRANSACTION_TIMEOUT =
	"SELECT set_config('transaction_timeout', (SELECT CASE WHEN setting::bigint = 0 THEN $1::bigint " +
	"ELSE least(setting::bigint, $1::bigint) END FROM pg_settings WHERE name = 'statement_timeout')::text || 'ms', true) AS ceiling";

/**
 * A 25P04 out of the open IS the ceiling → the typed 503; else raw. For a
 * selection carrying a referenced_by leaf the ceiling is the search budget,
 * stated with the search door's coordinates.
 */
function ceilingFailure(error: unknown, ceiling: string, leafBudgetMs: number | null): unknown {
	if (sqlStateOf(error) !== TRANSACTION_TIMEOUT) return error;
	if (leafBudgetMs !== null) {
		const appliedMs = Number.parseInt(ceiling, 10);
		return referencedBySearchTimeout(Number.isFinite(appliedMs) ? appliedMs : leafBudgetMs, error);
	}
	return new DedaloError('db.statement_timeout', {
		message: `export selection cursor: materializing the selection ran past the connection's ${ceiling} statement ceiling`,
		cause: error,
		coordinates: { lane: 'reserved', ceiling },
	});
}

/** The open was stopped while its selection was being built (see the module doc). */
function openStopped(cause: unknown): DedaloError {
	return new DedaloError('export.cancelled', {
		message: 'export selection cursor: the export was stopped while its selection was being built',
		cause,
	});
}

function exportBusy(reason: string): DedaloError {
	return new DedaloError('export.busy', {
		message: `export selection cursor refused: ${reason}`,
		details: { slots: EXPORT_SELECTION_SLOTS },
	});
}

/**
 * Open a selection cursor over `statement` (an idsOnly buildSearchSql
 * statement, no LIMIT). With no slot free: refused with `export.busy` before
 * reserving (admission 'refuse'), or queued for the next slot (admission
 * 'queue').
 */
export async function openSelectionCursor<Row>(
	statement: SearchStatement,
	options: SelectionCursorOptions,
): Promise<SelectionCursor<Row>> {
	if (
		!Number.isInteger(options.pageRows) ||
		options.pageRows < 1 ||
		options.pageRows > SELECTION_PAGE_ROWS_MAX
	) {
		throw new DedaloError('internal.invariant', {
			message: `openSelectionCursor: pageRows must be an integer in [1, ${SELECTION_PAGE_ROWS_MAX}] (got ${options.pageRows})`,
		});
	}
	// THE REFERENCED_BY BOUND (module doc): a selection a referenced_by leaf
	// rendered into arms the search budget as its transaction_timeout. Read
	// BEFORE a slot is taken: a budget refusal must not hold one.
	const source = searchCursorSource(statement);
	const selection = source.selection;
	const params = [...source.params] as never;
	const leafBudgetMs = source.budgetMs;
	// A Stop of THIS open is a signal that fires after it began (module doc).
	const abortedAtEntry = options.signal?.aborted === true;
	await acquireSlot(options.admission ?? 'refuse', options.signal);
	const name = `export_sel_${randomUUID().replaceAll('-', '')}`;
	let connection: Awaited<ReturnType<typeof sql.reserve>> | null = null;
	let declared = false;
	/** BEGIN sent, COMMIT not yet answered (close() rolls back). */
	let inTransaction = false;
	/** The connection's statement ceiling, as PostgreSQL spells it (the typed refusal names it). */
	let ceiling = '';
	let closed = false;
	/** The one close in flight — every caller awaits the SAME release. */
	let closing: Promise<void> | null = null;
	let expired = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const signal = options.signal;
	const idleMs =
		Number.isInteger(options.idleMs) && (options.idleMs as number) > 0
			? (options.idleMs as number)
			: EXPORT_CURSOR_IDLE_MS;

	// Idempotent AND joinable: a second caller (the producer's finally racing
	// an abort-listener close) awaits the release already in flight, so "close
	// returned" always means the slot and the connection are back.
	const close = (): Promise<void> => {
		closing ??= (async () => {
			closed = true;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			signal?.removeEventListener('abort', onAbort);
			const held = connection;
			connection = null;
			try {
				if (held !== null) {
					// An open that failed inside its bounded transaction: the connection
					// goes back OUT of it (an aborted transaction on a pooled connection
					// fails every statement the next borrower sends).
					if (inTransaction) await held.unsafe(CURSOR_TX.rollback).catch(() => undefined);
					if (declared) await held.unsafe(`CLOSE ${name}`).catch(() => undefined);
					held.release();
				}
			} finally {
				releaseSlot();
			}
		})();
		return closing;
	};
	const onAbort = () => {
		void close();
	};
	const stopIdle = () => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const consumerWaiting = (waiting: boolean): void => {
		stopIdle();
		if (!waiting || closed) return;
		idleTimer = setTimeout(() => {
			expired = true;
			void close();
		}, idleMs);
		idleTimer.unref?.();
	};

	// THE STOP DURING THE OPEN (module doc): cancel the statement running now,
	// and refuse every statement after the signal fired (stoppedDuringOpen).
	const stoppedDuringOpen = (): boolean => !abortedAtEntry && signal?.aborted === true;
	let cancelTarget: BackendCancelTarget | undefined;
	const cancelOpenStatement = () => {
		if (cancelTarget !== undefined) {
			void cancelBackendStatement(cancelTarget, 'export selection cursor stop');
		}
	};
	if (!abortedAtEntry) signal?.addEventListener('abort', cancelOpenStatement, { once: true });

	let total: number;
	try {
		const held = await sql.reserve();
		connection = held;
		/** One statement of the open — never sent once a Stop fired. */
		const step = async (statement: string, stepParams: never = [] as never): Promise<unknown> => {
			if (stoppedDuringOpen()) throw openStopped(undefined);
			return held.unsafe(statement, stepParams);
		};
		await step(CURSOR_TX.begin);
		inTransaction = true;
		cancelTarget = await readCancelTarget(held);
		const bound = (await step(
			leafBudgetMs === null
				? "SELECT set_config('transaction_timeout', current_setting('statement_timeout'), true) AS ceiling"
				: LEAF_TRANSACTION_TIMEOUT,
			(leafBudgetMs === null ? [] : [leafBudgetMs]) as never,
		)) as { ceiling: string }[];
		ceiling = String(bound[0]?.ceiling ?? '');
		await step(`DECLARE ${name} SCROLL CURSOR WITH HOLD FOR ${selection}`, params);
		await step(CURSOR_TX.commit);
		inTransaction = false;
		declared = true;
		const moved = (await step(`MOVE FORWARD ALL IN ${name}`)) as { count?: unknown };
		if (typeof moved.count !== 'number' || !Number.isSafeInteger(moved.count)) {
			// ONE total path (module doc): no command-tag count, no export.
			throw new DedaloError('internal.invariant', {
				message: `export selection cursor: the driver surfaced no MOVE command-tag count (got ${typeof moved.count}) — the selection total has no other source`,
			});
		}
		total = moved.count;
		await step(`MOVE ABSOLUTE 0 IN ${name}`);
	} catch (error) {
		await close();
		if (stoppedDuringOpen()) {
			// The step's own refusal, or what the cancel made of the running
			// statement (57014) — either way the user's Stop.
			throw error instanceof DedaloError && error.code === 'export.cancelled'
				? error
				: openStopped(error);
		}
		throw ceilingFailure(error, ceiling, leafBudgetMs);
	} finally {
		signal?.removeEventListener('abort', cancelOpenStatement);
	}

	// An export aborted before it opened still answers its total (the protocol's
	// meta line) and then no page: release now. Otherwise the abort releases.
	if (signal?.aborted === true) {
		await close();
	} else {
		signal?.addEventListener('abort', onAbort, { once: true });
		// Armed at open: the consumer has not pulled yet.
		consumerWaiting(true);
	}

	const pages: AsyncIterableIterator<Row[]> = {
		[Symbol.asyncIterator]() {
			return pages;
		},
		async next(): Promise<IteratorResult<Row[]>> {
			if (closed || connection === null) {
				if (expired) {
					throw new DedaloError('export.consumer_idle', {
						message: `export selection cursor: the consumer held control for more than ${idleMs} ms without pulling — closed`,
						details: { idle_s: Math.ceil(idleMs / 1000) },
					});
				}
				return { done: true, value: undefined };
			}
			const held = connection;
			// A pull is the consumer acting: the window stops (the owner restarts it).
			stopIdle();
			let rows: Row[];
			try {
				rows = (await held.unsafe(`FETCH FORWARD ${options.pageRows} FROM ${name}`)) as Row[];
			} catch (error) {
				await close();
				throw error;
			}
			if (rows.length === 0) {
				await close();
				return { done: true, value: undefined };
			}
			return { done: false, value: [...rows] };
		},
		async return(): Promise<IteratorResult<Row[]>> {
			await close();
			return { done: true, value: undefined };
		},
		async throw(error?: unknown): Promise<IteratorResult<Row[]>> {
			await close();
			throw error;
		},
	};

	return { total, pages, close, consumerWaiting };
}
