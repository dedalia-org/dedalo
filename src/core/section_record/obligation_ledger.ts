/**
 * THE OBLIGATION LEDGER — the observer half of every record write, owned by the
 * write chokepoint instead of remembered by the doors (CLOSURE_PLAN Step 2:
 * CORE-1; WC-2026-09-30-record-write-obligation-ledger).
 *
 * A record write owes the observer cascade (PHP component_common::Save() →
 * propagate_to_observers): every OBSERVER of a changed key must recompute, and
 * the records a write DROPPED must be visited too — a removed locator's mirror
 * still lists the record, and only its before-image names it. That was a call
 * each door made for itself, and the doors that forgot are the findings: the
 * time machine's whole-record restore and both undelete doors never propagated,
 * so an undeleted referencer was missing from every mirror it feeds until a
 * reconcile, and a restored term brought its mirror slot back VERBATIM.
 *
 * THE SHAPE. `afterRecordWrite` (record_write.ts) declares WHAT changed — a
 * per-key before/after (`keys`, `replace`), a whole record born or gone
 * (`birth`, `death`), or nothing to observe (`none`, `cascade-owned`) — and this
 * module turns it into ONE entry per write:
 *
 *   - `saved` = the value after, `removed` = `removedLocators(before, after)`
 *     (the ONE removed-set rule — the save door, the restores and the undeletes
 *     share it; it used to be two copies kept in step by a test);
 *   - `selfRecompute` = the COVERED OBSERVER slots of a write that must not
 *     declare them (a replace keeps the live mirror, an undelete writes the
 *     snapshot's, a restore its past value): never propagated, recomputed from
 *     truth — and the recompute ALWAYS hops, its own observers' one news of it.
 *
 * WHEN IT DRAINS (B6). Inside a transaction the entry is queued on the
 * COMMIT-ONLY lane (postgres.ts registerCommitAction), ONE registration per
 * write: a ROLLBACK discards it with the state it would have propagated, and a
 * savepoint rollback truncates exactly the entries queued after the savepoint
 * (the commit queue records its savepoint positions). Entries are NEVER
 * coalesced — merging a first before-image with a last after-image loses the
 * target a rolled-back middle write removed. With no transaction at all the
 * entry drains inline. Either way the recompute reads COMMITTED state and opens
 * its own transactions, which is why propagation refuses to run inside one.
 *
 * DEDUP. One CascadeGuard per transaction (its memo, keyed by a module symbol):
 * every entry of one transaction shares its visited/recomputed sets, so a
 * target touched by N writes of one logical operation (a record delete
 * rewriting 1,189 holders) recomputes once. The recompute is idempotent and
 * reads truth, so for FIRST-ORDER mirrors the order entries drain in cannot
 * change the result. LIMIT, stated (execute-once — the ledgered divergence
 * WC-2026-08-02-observer-cascade-bounded-flag): a mirror OF a mirror is read
 * once per operation. When an earlier entry's cascade recomputes it while a
 * LATER entry's restored mirror still holds its snapshot (committed, not yet
 * converged — a save queued before a soft-cascade restore in one transaction),
 * it reads the snapshot's phantom, and the restored mirror's own convergence
 * hop is deduplicated away: that observer stays stale until observer_reconcile
 * (measured 2026-10-01; WC-2026-09-30-record-write-obligation-ledger, stated limits).
 *
 * FAILURE. A drain never rethrows and never drops silently: propagation counts
 * its own failures (`observers_propagation_failed`), the drain counts anything
 * that escapes it, and `scripts/observer_reconcile.ts` repairs a stale mirror.
 * A committed write is never undone because a DERIVED recompute failed.
 *
 * Dynamic imports only toward section/record/ (import_scc_tripwire): this module
 * is loaded by the chokepoint every write goes through.
 */

import { incrementCounter } from '../api/counters.ts';
import { DATAFRAME_RELATION_TYPE } from '../concepts/subdatum.ts';
import { getTransactionMemo, isInTransaction, registerCommitAction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import type { CascadeGuard } from '../section/record/observers.ts';
import type { RecordWriteTarget } from './record_write.ts';

/** One key a write changed: its value before (read under the row lock) and after. */
export interface KeyChange {
	column: string;
	tipo: string;
	before: readonly unknown[];
	after: readonly unknown[];
}

/**
 * WHAT A WRITE CHANGED, declared by the writer — required on every
 * afterRecordWrite call, so no writer can leave the observer half unstated.
 *
 *  - `keys`: a per-key write (persistRecordKeys and its siblings);
 *  - `replace`: a whole-column write over a live row (persistRecordColumns),
 *    with the covered observer slots it pinned to the live value;
 *  - `birth`: a whole record that did not exist before (create, duplicate, an
 *    undelete) — before is empty;
 *  - `death`: a whole record that exists no more (the record delete) — after is
 *    empty;
 *  - `recompute`: nothing written to the slots, but the record's COVERED
 *    OBSERVER slots named must be recomputed from truth (the soft-cascade
 *    restore, which puts a wiped record's keys back but never its mirrors —
 *    record_write.ts requestCoveredSlotRecompute);
 *  - `cascade-owned`: the observer recompute's own mirror write — the cascade
 *    hops itself (observers.ts emitCascadeHop), a ledger entry would re-enter it;
 *  - `none`: nothing observable (a stamp-only write), with the reason.
 *
 * `verbatim` (birth, recompute): the write kept the record's OWN modified stamps
 * (a verbatim undelete — the bulk revert's; a restore whose run owns the
 * record's stamps). A derived recompute of THIS record's
 * covered slots, drained for any write of the same transaction, then writes the
 * mirror WITHOUT stamping it: the stamps are the snapshot's, and a revert of the
 * revert compares them (see transactionGuard / VERBATIM below).
 */
export type ObservedDeclaration =
	| { kind: 'keys'; changes: readonly KeyChange[]; actor: number; now?: Date }
	| {
			kind: 'replace';
			changes: readonly KeyChange[];
			selfRecompute: readonly string[];
			actor: number;
			now?: Date;
	  }
	| {
			kind: 'birth';
			columns: Readonly<Record<string, unknown>>;
			selfRecompute?: readonly string[];
			verbatim?: boolean;
			actor: number;
			now?: Date;
	  }
	| {
			kind: 'recompute';
			slots: readonly string[];
			verbatim?: boolean;
			actor: number;
			now?: Date;
	  }
	| { kind: 'death'; columns: Readonly<Record<string, unknown>>; actor: number; now?: Date }
	| { kind: 'cascade-owned' }
	| { kind: 'none'; reason: string };

/**
 * What the drain hands back to an interactive caller: the recomputed observer
 * data items whose target IS the written record (PHP observers_data — the save
 * response carries them so the edited record's info widget refreshes). Filled
 * after COMMIT; empty when an ambient transaction defers the drain past the
 * caller's return.
 */
export interface WriteReceipt {
	observersData: unknown[];
}

/** One queued write: what to propagate, for whom, as whom. */
interface LedgerEntry {
	target: RecordWriteTarget;
	/**
	 * One per observed key: the value after, the locators removed (the ONE
	 * removed-set rule) and the before-image itself — the `refresh_data`
	 * perform's change trigger reads it (observers.ts / refresh_data.ts
	 * observedValueChanged: an unchanged re-save must not clear).
	 */
	changes: { tipo: string; saved: unknown[]; removed: unknown[]; before: unknown[] }[];
	selfRecompute: string[];
	/** A verbatim birth: its record's covered-slot recomputes leave its stamps alone. */
	verbatim: boolean;
	/**
	 * The declaration's kind, handed to propagation as the change's ORIGIN
	 * (observers.ts ObservedChange.origin): the `refresh_data` clear fires from a
	 * component save (`keys`) and never from a whole-record write.
	 */
	origin: LedgerObserved['kind'];
	/**
	 * Every component tipo this write TOUCHED on its record — the declared
	 * changes' tipos plus the door's touched keys (an unobserved key the save
	 * wrote too). Marked on the guard's `written` set AT ENQUEUE
	 * (writtenSlotKey): a slot the operation wrote itself is never cleared by a
	 * `refresh_data` edge drained later in the same transaction.
	 */
	written: string[];
	actor: number;
	now: Date;
	receipt: WriteReceipt | undefined;
}

/** The address a guard's `verbatim` set is keyed by (observers.ts reads the same shape). */
export function verbatimAddress(sectionTipo: string, sectionId: number): string {
	return `${sectionTipo}|${String(sectionId)}`;
}

/** The key a guard's `written` set holds per slot (observers.ts applyRefreshDataClear reads the same shape). */
export function writtenSlotKey(tipo: string, sectionTipo: string, sectionId: number): string {
	return `${tipo}|${sectionTipo}|${String(sectionId)}`;
}

/** Transaction-memo key of the one CascadeGuard a transaction's entries share. */
const LEDGER_GUARD = Symbol('obligation_ledger.guard');

/**
 * Locators present BEFORE a write and absent after it, identified by the RECORD
 * they point at (section_tipo + section_id) — dataframe frames (dd490) excluded,
 * they are pairing records, not edges. Keyed on the target, NEVER on the item
 * id: an `update` that retargets a locator keeps its id, so an id-keyed diff
 * would see neither the old target leaving nor the new one arriving.
 *
 * THE ONE RULE (it moved here from tool_time_machine's restore_common.ts, and
 * the save door's own copy retired): every door's removed set is computed here,
 * from the before-image the chokepoint read under the row lock.
 */
export function removedLocators(before: readonly unknown[], after: unknown): unknown[] {
	if (before.length === 0) return [];
	const afterKeys = edgeTargetKeys(after);
	const removed: unknown[] = [];
	const seen = new Set<string>();
	for (const entry of before) {
		const entryKey = edgeTargetKey(entry);
		if (entryKey === null || afterKeys.has(entryKey) || seen.has(entryKey)) continue;
		seen.add(entryKey);
		removed.push(entry);
	}
	return removed;
}

/** The record an EDGE locator points at (`section_tipo|section_id`); null for a non-locator or a dd490 frame. */
function edgeTargetKey(entry: unknown): string | null {
	if (entry === null || typeof entry !== 'object') return null;
	const locator = entry as { section_tipo?: unknown; section_id?: unknown; type?: unknown };
	if (typeof locator.section_tipo !== 'string' || locator.section_id === undefined) return null;
	if (locator.type === DATAFRAME_RELATION_TYPE) return null;
	return `${locator.section_tipo}|${String(locator.section_id)}`;
}

/** {@link edgeTargetKey} of every entry of a value (a non-array value has none). */
function edgeTargetKeys(value: unknown): Set<string> {
	const keys = new Set<string>();
	for (const entry of Array.isArray(value) ? value : []) {
		const entryKey = edgeTargetKey(entry);
		if (entryKey !== null) keys.add(entryKey);
	}
	return keys;
}

/**
 * Does any DISPATCHABLE subscription observe `tipo`? The registry's own
 * predicate (a subscription with a server block): a client-only observer never
 * fires on the server, so a key it alone observes needs no entry — and no
 * before-image read.
 */
export async function isObservedTipo(tipo: string): Promise<boolean> {
	const { entryServerBlock, getObserverSubscriptions } = await import(
		'../section/record/observer_subscriptions.ts'
	);
	const subscriptions = await getObserverSubscriptions(tipo);
	return subscriptions.some((subscription) => entryServerBlock(subscription.entry) !== undefined);
}

/** A stored key value as an item list (`[]` when absent or not an array). */
function asItems(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * A whole record's EDGES as key changes — the `relation` column only. A birth
 * or a death changes which records this one points at, and those targets'
 * mirrors are what must recompute; a literal value names no record, and
 * dispatching every literal observer of a record on its birth/death (a history
 * row per component_info target) is not what a delete or a clone ever did.
 */
function recordEdges(
	columns: Readonly<Record<string, unknown>>,
	side: 'before' | 'after',
): KeyChange[] {
	const bag = columns.relation;
	if (bag === null || typeof bag !== 'object' || Array.isArray(bag)) return [];
	return Object.entries(bag as Record<string, unknown>).map(([tipo, value]) => ({
		column: 'relation',
		tipo,
		before: side === 'before' ? asItems(value) : [],
		after: side === 'after' ? asItems(value) : [],
	}));
}

/**
 * The declaration's key changes, whatever its kind. A birth's COVERED slots
 * (its selfRecompute — an undelete writes the snapshot's mirror back, a past
 * derivation) are never edges: propagated, a phantom referencer would reach the
 * mirror's own observers as truth. Their recompute's hop is what tells them.
 */
function declaredChanges(observed: ObservedDeclaration): readonly KeyChange[] {
	switch (observed.kind) {
		case 'keys':
		case 'replace':
			return observed.changes;
		case 'birth': {
			const derived = new Set(observed.selfRecompute ?? []);
			return recordEdges(observed.columns, 'after').filter((edge) => !derived.has(edge.tipo));
		}
		case 'death':
			return recordEdges(observed.columns, 'before');
		default:
			return [];
	}
}

/** A declaration the ledger enqueues (`none` / `cascade-owned` never reach it). */
type LedgerObserved = Exclude<ObservedDeclaration, { kind: 'none' } | { kind: 'cascade-owned' }>;

/** Build the entry: the OBSERVED keys only, each with its saved/removed halves. */
async function buildEntry(
	target: RecordWriteTarget,
	observed: LedgerObserved,
	receipt: WriteReceipt | undefined,
	touched: readonly string[],
): Promise<LedgerEntry> {
	return {
		target,
		changes: await observedKeyChanges(observed),
		selfRecompute: selfRecomputeSlots(observed),
		verbatim: isVerbatimDeclaration(observed),
		origin: observed.kind,
		written: [...new Set([...touched, ...declaredTipos(observed)])],
		actor: observed.actor,
		now: observed.now ?? new Date(),
		receipt,
	};
}

/**
 * Every component tipo the declaration says the write touched — the changes'
 * tipos (a per-key save, a replace), or every key of every column bag a birth
 * carries. A death and a recompute write no slot of their own.
 */
function declaredTipos(observed: LedgerObserved): string[] {
	switch (observed.kind) {
		case 'keys':
		case 'replace':
			return observed.changes.map((change) => change.tipo);
		case 'birth':
			return columnBagTipos(observed.columns);
		default:
			return [];
	}
}

/** The keys of every column that is a bag (`relation`, `string`, …) of a whole-record payload. */
function columnBagTipos(columns: Readonly<Record<string, unknown>>): string[] {
	const tipos: string[] = [];
	for (const bag of Object.values(columns)) {
		if (bag === null || typeof bag !== 'object' || Array.isArray(bag)) continue;
		tipos.push(...Object.keys(bag as Record<string, unknown>));
	}
	return tipos;
}

/** The declared changes on OBSERVED tipos, one per tipo (a key is observed by tipo, whatever column holds it). */
async function observedKeyChanges(observed: LedgerObserved): Promise<LedgerEntry['changes']> {
	const changes: LedgerEntry['changes'] = [];
	const seen = new Set<string>();
	for (const change of declaredChanges(observed)) {
		if (seen.has(change.tipo)) continue;
		seen.add(change.tipo);
		if (!(await isObservedTipo(change.tipo))) continue;
		changes.push({
			tipo: change.tipo,
			saved: [...change.after],
			removed: removedLocators(change.before, change.after),
			before: [...change.before],
		});
	}
	return changes;
}

/** The covered slots the write itself recomputes (never propagated — see DERIVED). */
function selfRecomputeSlots(observed: LedgerObserved): string[] {
	switch (observed.kind) {
		case 'replace':
		case 'birth':
			return [...(observed.selfRecompute ?? [])];
		case 'recompute':
			return [...observed.slots];
		default:
			return [];
	}
}

/** A birth/recompute declared verbatim writes its mirrors without modified stamps. */
function isVerbatimDeclaration(observed: LedgerObserved): boolean {
	return (observed.kind === 'birth' || observed.kind === 'recompute') && observed.verbatim === true;
}

/** A fresh root guard (the propagation's own root shape, one chain label). */
async function rootGuard(label: string): Promise<CascadeGuard> {
	const { MAX_CASCADE_DEPTH } = await import('../section/record/observers.ts');
	return {
		depth: 0,
		maxDepth: MAX_CASCADE_DEPTH,
		visited: new Set(),
		recomputed: new Set(),
		verbatim: new Set(),
		written: new Set(),
		chain: [label],
	};
}

/**
 * The ONE guard every entry of the ambient transaction shares (see DEDUP).
 *
 * VERBATIM. A verbatim birth (the bulk revert's undelete) marks its record on
 * this guard AT ENQUEUE, not at drain: entries drain in queue order, so a
 * referencer undeleted in the same transaction and queued FIRST reaches the
 * record's mirror through its own propagation before the record's own entry
 * drains. Every recompute of a marked record's covered slot in this transaction
 * — whichever entry reaches it — then writes the mirror without the modified
 * stamps (observers.ts recomputeMirrorAndHop). LIMIT, stated: a record undeleted
 * in one transaction and re-reached by a LATER transaction's drain (a referencer
 * undeleted separately) is stamped by that recompute like any live record.
 */
async function transactionGuard(): Promise<CascadeGuard> {
	const memo = getTransactionMemo();
	const existing = memo?.get(LEDGER_GUARD) as CascadeGuard | undefined;
	if (existing !== undefined) return existing;
	const guard = await rootGuard('ledger:transaction');
	memo?.set(LEDGER_GUARD, guard);
	return guard;
}

/**
 * Every kind an ObservedDeclaration may carry — the runtime twin of the type,
 * EXHAUSTIVE by construction (a Record over the union: a new kind that is not
 * listed here does not compile). Exported for ONE reader: the gate that holds
 * the kernel's origin set (section/record/refresh_data.ts OBSERVED_CHANGE_ORIGINS)
 * equal to these kinds minus the two that never reach propagation, plus 'hop'.
 */
export const DECLARATION_KINDS: Readonly<Record<ObservedDeclaration['kind'], true>> = {
	keys: true,
	replace: true,
	birth: true,
	recompute: true,
	death: true,
	'cascade-owned': true,
	none: true,
};

/**
 * REFUSE a write that declared no observer change. The type makes `observed`
 * required, but a caller the compiler does not see (plain JS, an `as never`
 * cast, a stale call site outside a type-checked commit) would otherwise reach
 * `observed.kind` as a bare TypeError AFTER its row landed — a crash that names
 * nothing. This names the door, before the hook fans anything out.
 */
export function assertObservedDeclared(
	target: RecordWriteTarget,
	observed: unknown,
	door: string,
): asserts observed is ObservedDeclaration {
	const kind =
		observed !== null && typeof observed === 'object'
			? (observed as { kind?: unknown }).kind
			: undefined;
	if (typeof kind === 'string' && Object.hasOwn(DECLARATION_KINDS, kind)) return;
	throw new DedaloError('internal.invariant', {
		message: `obligation ledger: the write door '${door}' called the post-write hook on ${target.sectionTipo}/${String(target.sectionId)} without an observer declaration (\`observed\`) — every writer states WHAT changed, or \`{ kind: 'none', reason }\`; an undeclared write would leave every mirror it feeds stale`,
		coordinates: {
			table: target.table,
			section_tipo: target.sectionTipo,
			section_id: target.sectionId,
		},
	});
}

/**
 * Record one write's observer obligation. Called by `afterRecordWrite` (and by
 * the record delete for the record it removes); drains after COMMIT, or inline
 * when no transaction is ambient.
 */
export async function enqueueObservedChange(
	target: RecordWriteTarget,
	observed: ObservedDeclaration,
	receipt?: WriteReceipt,
	/** The door's touched keys (record_write.ts RecordWriteObligations.touchedKeys) — see LedgerEntry.written. */
	touched: readonly string[] = [],
): Promise<void> {
	assertObservedDeclared(target, observed, 'enqueueObservedChange');
	if (observed.kind === 'none' || observed.kind === 'cascade-owned') return;
	const entry = await buildEntry(target, observed, receipt, touched);
	// The guard is marked for EVERY declared write, propagating or not: a save of
	// an unobserved slot (the milestone alone) must still shield that slot from
	// a refresh_data clear drained later in the same transaction.
	const inTransaction = isInTransaction();
	const guard = markEntry(
		entry,
		inTransaction
			? await transactionGuard()
			: await rootGuard(`ledger:${target.sectionTipo}/${target.sectionId}`),
	);
	if (!owesPropagation(entry)) return;
	if (inTransaction) queueOnCommit(entry, guard);
	else await drainEntry(entry, guard);
}

/** An entry with no observed change and no covered slot to recompute drains nothing. */
function owesPropagation(entry: LedgerEntry): boolean {
	return entry.changes.length > 0 || entry.selfRecompute.length > 0;
}

/**
 * An entry marks the guard it drains under AT ENQUEUE (see {@link transactionGuard}):
 * a verbatim entry its record on `verbatim`, every entry the slots it wrote on
 * `written` (CascadeGuard.written — the refresh_data clear's self-write shield).
 */
function markEntry(entry: LedgerEntry, guard: CascadeGuard): CascadeGuard {
	const { sectionTipo, sectionId } = entry.target;
	if (entry.verbatim) guard.verbatim?.add(verbatimAddress(sectionTipo, sectionId));
	guard.written ??= new Set();
	for (const tipo of entry.written) guard.written.add(writtenSlotKey(tipo, sectionTipo, sectionId));
	return guard;
}

/** Queue the entry's drain on the ambient transaction's commit-only lane. */
function queueOnCommit(entry: LedgerEntry, guard: CascadeGuard): void {
	const target = entry.target;
	if (!registerCommitAction(() => drainEntry(entry, guard))) {
		// The ambient handle is present but its commit lane already settled: a
		// LEAKED CONTINUATION (an unawaited write that outlived its
		// withTransaction). Running the drain here would run it inside a
		// transaction that no longer exists; dropping it would lose the obligation
		// silently. Neither — the write is refused loudly.
		throw new DedaloError('internal.invariant', {
			message: `obligation ledger: the commit lane of the ambient transaction is closed — a write to ${target.sectionTipo}/${target.sectionId} ran after its withTransaction settled (a leaked continuation); its observer obligation cannot be queued`,
			coordinates: {
				table: target.table,
				section_tipo: target.sectionTipo,
				section_id: target.sectionId,
			},
		});
	}
}

/**
 * DRAIN one entry, outside any transaction: propagate every observed key's
 * change (with the before-image's removed set), then recompute every covered
 * observer slot the write pinned. Never rethrows (see FAILURE).
 */
async function drainEntry(entry: LedgerEntry, guard: CascadeGuard): Promise<void> {
	const { propagateToObservers, recomputeMirrorAndHop } = await import(
		'../section/record/observers.ts'
	);
	const { sectionTipo, sectionId } = entry.target;
	for (const change of entry.changes) {
		try {
			const data = await propagateToObservers(
				change.tipo,
				sectionTipo,
				sectionId,
				{
					saved: change.saved,
					removed: change.removed,
					before: change.before,
					origin: entry.origin,
				},
				entry.actor,
				entry.now,
				guard,
			);
			entry.receipt?.observersData.push(...data);
		} catch (error) {
			console.error(
				`[obligation_ledger] propagation of '${change.tipo}' @ ${sectionTipo}/${String(sectionId)} failed — the mirrors are stale until observer_reconcile:`,
				error,
			);
			incrementCounter('observers_propagation_failed');
		}
	}
	for (const observerTipo of entry.selfRecompute) {
		try {
			// ALWAYS hop: no write declared this slot (a restore, a birth, a replace
			// never propagate a covered slot), so its recompute's hop is the ONLY way
			// its own observers learn its value — also when the recompute finds the
			// written value already true and writes nothing (an undelete whose
			// snapshot mirror is still truth: the delete's death told those
			// observers the record was gone).
			await recomputeMirrorAndHop(
				observerTipo,
				sectionTipo,
				sectionId,
				entry.actor,
				entry.now,
				guard,
				'always',
			);
		} catch (error) {
			console.error(
				`[obligation_ledger] recompute of the covered slot '${observerTipo}' @ ${sectionTipo}/${String(sectionId)} failed — the mirror is stale until observer_reconcile:`,
				error,
			);
			incrementCounter('observers_propagation_failed');
		}
	}
}
