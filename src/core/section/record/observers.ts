/**
 * Server-side observers (PHP component_common::propagate_to_observers →
 * update_observer_data): when an OBSERVED component saves, its declared
 * observers recompute.
 *
 * HOME (moved from api/handlers 2026-07-24): this is WRITE-CASCADE domain
 * logic. Since CLOSURE_PLAN Step 2 (the obligation ledger) it is fired by the
 * RECORD-WRITE CHOKEPOINT itself, never by a door: every writer in
 * section_record/record_write.ts declares what it changed to afterRecordWrite,
 * and section_record/obligation_ledger.ts drains the propagation post-commit.
 * So EVERY write propagates — the save, the time machine's restores and
 * undeletes, the bulk revert, the delete doors, a duplicate, a create with
 * relation defaults. The doors that used to call propagateToObservers
 * themselves (and the ones that forgot to — CORE-1) are gone; the exclusivity
 * is gated (write_obligations_tripwire leg B4: the ledger's drain and the
 * cascade hop are the ONLY callers). A writer that does NOT reach the
 * chokepoint is in that census with its reason and is healed by
 * scripts/observer_reconcile.ts (standing case: the v6→v7 update lane,
 * portalize included).
 *
 * EVERY write states BOTH halves of what changed — the saved value AND the
 * locators the change REMOVED (ObservedChange, 2026-08-06), computed by the
 * ledger from the before-image the chokepoint read under the row lock.
 * Propagation used to see the post-save value alone, so a dropped locator's
 * mirror was never revisited and kept a dead reference forever.
 *
 * Coverage (measured on this ontology):
 *   - 58/66 observer configs are CLIENT-only (no `server` key) → nothing to
 *     do on the server;
 *   - the dominant server config is {config:{use_observable_dato}, perform:
 *     set_dato_external} — the hierarchy93 ← rsc387 family: the observer
 *     component AT EACH TARGET of the saved data recomputes its EXTERNAL
 *     value = every record referencing the target through
 *     properties.source.component_to_search, order-preserved (existing
 *     entries kept in place, new ones appended with the next item id —
 *     PHP-oracle-verified byte shape);
 *   - component_info observers (incl. the component_state/calculation
 *     aliases) — 2026-07-10, oracle-verified on scratch twins: BOTH server
 *     shapes recompute the widgets. `filter:{SQO}` (numisdata595/oh87 — the
 *     observed component lives on ANOTHER section) fills every clause's q
 *     with the saved record's locator (+ from_component_tipo from the
 *     clause's last path step) and searches the observer's section for the
 *     referencing records; `filter:false` (rsc19/test180/numisdata1125 —
 *     same-record observers) targets the saved record itself. Per target
 *     PHP writes ONE matrix_time_machine row (lg-nolan, the computed live
 *     shape) and — measured, deliberate — does NOT touch the live misc
 *     column (stored misc values are LEGACY; live reads fall back to live
 *     compute). Targets equal to the saved record additionally ride the
 *     save response's data array (mode 'list', the client refresh);
 *   - other `server.filter` + perform shapes remain LEDGERED (logged skip,
 *     never guessed).
 *
 * DISCOVERY (Act 2, 2026-08-02): edges come from the ontology-wide
 * SUBSCRIPTION REGISTRY (./observer_subscriptions.ts) — no longer from the
 * saved node's `properties.observers` alone. THE DISPATCH RULE (owner ruling
 * 2026-08-02): an edge dispatches iff the OBSERVER declares it in
 * `properties.observe` with a `server` block (plus wildcard edges compiled
 * from forward specs) — the ontology decides; no code table gates it. A
 * reverse-only declaration (observe half alone) dispatches like any other —
 * the single-declaration model that closes the rsc19 -> oh28 defect. The
 * SQO-filter recompute's host section comes from the registry's 4-step
 * resolution (observe-entry scope → forward spec → observer's own section
 * with virtual↔real equivalence → loud refusal); dead config (forward-only
 * specs, dead wildcards, unresolved hosts) is a LOUD contract violation
 * (gate-RED where the suite ontology carries it; boot-probe/gauge/counter on
 * a production ontology — see observer_subscriptions.ts header).
 * Classification, the resolvers and every perform below are untouched.
 *
 * VALUE LAWS (2026-10-30, ./external_laws/): a set_dato_external edge's
 * targets come from the closed resolver table (resolvers.ts — PHP's config
 * switch: self_and_observable / observable / inverse / self), and what the
 * recompute stores comes from the observer's ONE classified law (classify.ts:
 * law (c) inverse_search, source_overwrite, observed_data — or a refusal). The
 * Phase-0 disarm that refused both PHP sub-laws is gone; the kernel below
 * (recomputeExternalRelation) runs every law through one merge and one tail,
 * and a mirror is only BORN on a record whose section declares the observer.
 * refreshExternalMirror is the on-demand door (the portal's update-external
 * button, through section/record/external_refresh.ts).
 */

import { incrementCounter } from '../../api/counters.ts';
import { isInTransaction, registerCommitAction, sql } from '../../db/postgres.ts';
import { ensureTmHistoryReady, withTmHistory } from '../../db/record_generation.ts';
import { recordTimeMachine } from '../../db/time_machine.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo, getNode } from '../../ontology/resolver.ts';
import { dbTimestamp } from './create_record.ts';
// type-only: the law registry (external_laws/) is reached by DYNAMIC import on
// the compute path; these erase at build.
import type { ExternalLawRefusalReason, StoredLocator } from './external_laws/types.ts';
import {
	entryServerBlock,
	getObserverSubscriptions,
	isSqoFilter,
	type ObserveEntry,
} from './observer_subscriptions.ts';

/**
 * MOVED to external_laws/ (2026-10-30) — law (c)'s seed and the mirror item-id
 * rule live behind the ExternalValueLaw interface now; re-exported here so the
 * gates and scripts that pinned them by this path keep one name for them.
 */
export {
	buildExternalSeed,
	collectExternalSeed,
	type ExternalSeedIO,
	type ExternalSeedLocator,
} from './external_laws/inverse_search.ts';
export { nextObserverItemId } from './external_laws/merge.ts';

/**
 * D2 — THE BOUNDED CASCADE GUARD. PHP's propagation is transitively recursive
 * (every recompute/relay ends in Save() → propagate_to_observers) and
 * UNGUARDED — no visited set, no depth budget: a cyclic observe graph
 * infinite-loops the PHP engine. TS re-enters propagation ONLY through
 * emitCascadeHop/runObserverCascadeHop below, carrying this guard as a
 * PARAMETER (never module state — module_state_tripwire): a shared visited
 * set keyed `observerTipo|performKind|section_tipo|section_id` and a depth
 * budget (MAX_CASCADE_DEPTH). Exceeding either is a LOUD, counted stop
 * naming the full chain — never a silent truncation, never a hang. The
 * measured real graph is depth ≤ 2 with zero cycles, so the budget is a
 * backstop, not a workload.
 *
 * The cascade is UNCONDITIONAL (2026-08-02): the ontology's observers/observe
 * declarations are the source of truth, and the mirrors are STORED relation
 * data — gating declared edges behind a config key made two installs with the
 * same ontology store different values. The DEDALO_OBSERVER_CASCADE rollout
 * flag was retired the day the benchmark cleared it (typical external hop p50
 * 1.3ms / p90 3.1ms; worst real case 22ms; depth ≤ 2, zero cycles —
 * WC-2026-08-02-observer-cascade-bounded-flag).
 */
export interface CascadeGuard {
	/** Hops taken to REACH the current propagation (root = 0). */
	depth: number;
	/** MAX_CASCADE_DEPTH at the root; tests may plant a smaller budget. */
	maxDepth: number;
	/** SHARED across the whole cascade tree — one re-entry per node, ever. */
	visited: Set<string>;
	/**
	 * Recomputes already performed in this logical operation, keyed
	 * `observerTipo|section_tipo|section_id`. SHARED like `visited`, and for
	 * the same reason: a recompute is idempotent, so doing it twice is pure
	 * waste — and a door that propagates in a LOOP (delete_record step 9 fires
	 * once per rewritten owner) would otherwise redo the same class over and
	 * over. Measured: deleting numisdata3/17463 rewrites 1,189 owners, and
	 * without sharing this set every type shared by those coins had its whole
	 * equivalence class recomputed up to 1,189 times, synchronously, inside
	 * the HTTP request. Execute-once matches the visited set's own semantics
	 * (a ledgered divergence from PHP's re-execute-to-fixpoint —
	 * WC-2026-08-02-observer-cascade-bounded-flag).
	 */
	recomputed: Set<string>;
	/**
	 * Records born VERBATIM in this logical operation (`section_tipo|section_id`,
	 * obligation_ledger.ts verbatimAddress): a bulk revert's undelete keeps the
	 * snapshot's own modified stamps, so a recompute of a covered slot ON such a
	 * record writes the mirror WITHOUT stamping it — a derived write must not
	 * turn a verbatim undelete into a stamped one (a revert of the revert
	 * compares those stamps). SHARED like `visited`; absent = none.
	 */
	verbatim?: Set<string>;
	/** Per-branch human-readable path (`tipo@section/id`) for loud failures. */
	chain: string[];
}

/** The depth ceiling — a backstop over a measured depth-≤2 graph. Exported
 * for the depth-budget gate in observer_cascade_native.test.ts. */
export const MAX_CASCADE_DEPTH = 8;

/**
 * Emit one cascade hop: guard-check (visited + depth budget), then either run
 * it immediately (no ambient transaction) or defer it to the COMMIT-ONLY lane
 * (B6/W12: inside an ambient tx — import_csv wraps whole rows — the hop must
 * fire only after the outer COMMIT, reading committed state; on ROLLBACK it is
 * discarded with the state it would have propagated). Pre-gated on the
 * observer itself declaring `observers` (a hop into a leaf is a no-op by
 * construction — skipping it keeps the commit lane and the guard log honest).
 *
 * Exported ONLY for the leaked-continuation drop gate in
 * observer_cascade_native.test.ts — production re-entry goes through
 * propagateToObservers.
 */
export async function emitCascadeHop(
	guard: CascadeGuard,
	observerTipo: string,
	kind: 'relay' | 'external' | 'info',
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date,
	/**
	 * The locators the written observer DROPPED (an external recompute's
	 * `droppedLocators`): the hop propagates their removal, so an observer of
	 * this observer re-derives the records that left it. Absent = none.
	 */
	removed: readonly unknown[] = [],
): Promise<void> {
	// Leaf pre-gate (Act 2: registry, not the node's own `observers` array):
	// a hop is worth scheduling only when the observer's OWN saves would
	// dispatch something — any subscription registered for it (forward-
	// declared, or a reverse-only observe+server declaration: those dispatch
	// by the ontology rule). A node with no subscriptions at all is a leaf —
	// no commit-lane task / guard entry / read appears for it.
	const hopSubscriptions = await getObserverSubscriptions(observerTipo);
	if (hopSubscriptions.length === 0) return; // leaf — nothing to relay into
	const chainLabel = `${observerTipo}@${sectionTipo}/${sectionId}`;
	const key = `${observerTipo}|${kind}|${sectionTipo}|${sectionId}`;
	if (guard.visited.has(key)) {
		// A revisit stops the branch either way (execute-once dispatch — the
		// visited set is shared across the whole cascade tree), but the TWO cases
		// are different signals (review 2026-08-02): the node already on the
		// CURRENT branch's chain is a TRUE CYCLE (PHP would infinite-loop —
		// incident signal, counter must stay 0); a node reached through a
		// DIFFERENT branch is a CONVERGED DIAMOND — legitimate graph shape,
		// deduped by design (execute-once vs PHP's re-execute-to-fixpoint is a
		// ledgered divergence: WC-2026-08-02-observer-cascade-bounded-flag).
		if (guard.chain.includes(chainLabel)) {
			console.error(
				`observer cascade CYCLE refused (node '${key}' is on its own chain) — chain: ${[...guard.chain, chainLabel].join(' -> ')}`,
			);
			incrementCounter('observers_cascade_cycle_refused');
		} else {
			console.warn(
				`observer cascade converged path skipped (node '${key}' already dispatched via another branch — benign dedup) — chain: ${[...guard.chain, chainLabel].join(' -> ')}`,
			);
			incrementCounter('observers_cascade_converged_skipped');
		}
		return;
	}
	const nextDepth = guard.depth + 1;
	if (nextDepth > guard.maxDepth) {
		console.error(
			`observer cascade DEPTH BUDGET exceeded (hop ${nextDepth} > max ${guard.maxDepth}) — chain: ${[...guard.chain, chainLabel].join(' -> ')} — cascade STOPPED here (counted: observers_cascade_depth_exceeded)`,
		);
		incrementCounter('observers_cascade_depth_exceeded');
		return;
	}
	guard.visited.add(key);
	const childGuard: CascadeGuard = {
		maxDepth: guard.maxDepth,
		visited: guard.visited,
		recomputed: guard.recomputed,
		verbatim: guard.verbatim,
		depth: nextDepth,
		chain: [...guard.chain, chainLabel],
	};
	const hop = () =>
		runObserverCascadeHop(observerTipo, sectionTipo, sectionId, userId, now, childGuard, removed);
	if (isInTransaction()) {
		if (!registerCommitAction(hop)) {
			// The commit lane refused the registration: the ambient tx context is
			// present but its queue already drained — an S2-14 LEAKED CONTINUATION
			// (unawaited promise from inside a settled withTransaction). Running
			// the hop inline here would trip the B6 assert (isInTransaction() is
			// deliberately still true on an expired handle), so the hop is DROPPED
			// — but never silently: loud + counted (review 2026-08-02; this was
			// the dispatch's one silent-truncation path).
			console.error(
				`observer cascade hop DROPPED (commit lane closed — leaked continuation past withTransaction?) — chain: ${childGuard.chain.join(' -> ')} (counted: observers_cascade_hop_dropped)`,
			);
			incrementCounter('observers_cascade_hop_dropped');
		}
	} else {
		await hop();
	}
}

/**
 * One cascade hop: read the observer's CURRENT value "with references" (PHP
 * sets observable_dato = get_dato_with_references() for
 * component_relation_related, get_dato() otherwise, before the re-save —
 * getStoredWithReferences dispatches on the model and degrades to the stored
 * bag for every other model) and re-enter propagation as if the observer had
 * just saved. WRITES NOTHING itself (WC-2026-08-02-observer-relay-writes-nothing).
 *
 * MUST NOT run inside an ambient transaction (B6): withTransaction JOINS an
 * ambient tx, so the hop's recompute writes would ride a transaction it does
 * not own — and escaping onto a second connection would deadlock on the
 * outer tx's row locks undetectably. The assert throws WITH the chain (the
 * caller coordinates); scheduling through emitCascadeHop can never trip it
 * (in-tx emission defers to the commit lane). Per-hop errors below the assert
 * are swallowed LOUDLY — permitted precisely because the hop owns every
 * transaction it opens (an ambient tx would be poisoned by a swallowed error;
 * that is what the assert forbids).
 */
export async function runObserverCascadeHop(
	observerTipo: string,
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date,
	guard: CascadeGuard,
	removed: readonly unknown[] = [],
): Promise<void> {
	if (isInTransaction()) {
		incrementCounter('observers_cascade_in_transaction_refused');
		throw new DedaloError('internal.invariant', {
			message: `runObserverCascadeHop: refusing to run inside an ambient transaction — hop '${observerTipo}' @ ${sectionTipo}/${sectionId}, chain: ${guard.chain.join(' -> ')}. Cascade hops read committed state and open their own transactions (B6); schedule through registerCommitAction / emitCascadeHop instead.`,
			coordinates: { tipo: observerTipo, section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	try {
		const node = await getNode(observerTipo);
		// alias lookup registration (see collectExternalSeed for why this load
		// is dynamic and unconditional).
		await import('../../components/registry.ts');
		const model = node === null ? null : await getModelByTipo(observerTipo);
		const { getStoredWithReferences } = await import('../../relations/related.ts');
		const payload = await getStoredWithReferences(
			observerTipo,
			sectionTipo,
			sectionId,
			node?.properties ?? null,
			model,
			'lg-nolan',
		);
		await propagateToObservers(
			observerTipo,
			sectionTipo,
			sectionId,
			// A hop is a CURRENT-STATE event: it re-reads the observer's value and
			// re-enters propagation. Its removal knowledge is what the WRITE that
			// scheduled it dropped (an external recompute's droppedLocators): without
			// it, an observer of this observer never re-derives a record that left —
			// that record is in no current value, so no saved target reaches it.
			{ saved: payload, removed: [...removed] },
			userId,
			now,
			guard,
		);
	} catch (error) {
		// Hop-owned containment (B6): safe to swallow ONLY because the assert
		// above guarantees no ambient transaction can be poisoned. Loud + counted.
		console.error(
			`observer cascade hop failed (swallowed) — '${observerTipo}' @ ${sectionTipo}/${sectionId}, chain: ${guard.chain.join(' -> ')}:`,
			error,
		);
		incrementCounter('observers_cascade_hop_failed');
	}
}

/**
 * Fires the server-side observers of a just-written component. REFUSES to run
 * inside a transaction (B6): the recomputes read COMMITTED state and open their
 * own transactions, and the ledger (section_record/obligation_ledger.ts)
 * drains every write's propagation post-commit — so an in-transaction call is
 * a programming error, thrown before anything runs. Below that assert it never
 * throws: a failure is swallowed loudly and counted
 * (`observers_propagation_failed`), because a committed write must never be
 * undone by a DERIVED recompute — observer_reconcile repairs the mirror.
 * Returns the recomputed observer DATA ITEMS whose target IS the saved
 * record (PHP observers_data — merged into the save response so the
 * actively-edited record's info widget refreshes client-side).
 *
 * `cascade` is the bounded-dispatch guard (D2) threaded through relay /
 * recompute re-entries; the ledger passes ONE per transaction, so every write
 * of one logical operation shares its visited/recomputed sets. Absent, the
 * root guard is created here (the cascade always fires for a declared edge;
 * see the CascadeGuard header).
 */

/**
 * WHAT CHANGED at the saved component — both halves, because both name
 * records whose observers must recompute (2026-08-06).
 *
 * `removed` is REQUIRED, deliberately: propagation used to receive the
 * post-save value alone, so a locator the save DROPPED was never visited and
 * its mirror silently kept a dead reference (the reported numisdata36
 * equivalence case — removing the link recomputed neither side). A trailing
 * optional parameter would have defaulted to exactly that bug, which is the
 * same shape as the omitted-argument hole that armed the 2026-08-02 wipe.
 * Every call site must state its removed set, even when it is `[]`.
 */
export interface ObservedChange {
	/** The component's value AFTER the save (PHP's observable data). */
	saved: unknown[];
	/** Locators present BEFORE the save and absent after it. */
	removed: unknown[];
}
export async function propagateToObservers(
	observedTipo: string,
	sectionTipo: string,
	sectionId: number,
	observed: ObservedChange,
	userId: number,
	now: Date = new Date(),
	cascade?: CascadeGuard,
): Promise<unknown[]> {
	// B6 — see the docstring. Outside the try: this is the caller's bug, not a
	// recompute failure to swallow.
	if (isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message: `propagateToObservers: refusing to run inside a transaction — '${observedTipo}' @ ${sectionTipo}/${sectionId}. Propagation reads committed state and opens its own transactions (B6); a write declares its change to the obligation ledger (section_record/obligation_ledger.ts), which drains after COMMIT.`,
			coordinates: { tipo: observedTipo, section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	const observersData: unknown[] = [];
	try {
		// Act 2 discovery: the ontology-wide subscription registry (forward
		// specs in their declared order first — the historical iteration order
		// — then reverse-only declarations). Dispatchability is the ontology's
		// decision alone: an entry with a server block fires, full stop.
		const subscriptions = await getObserverSubscriptions(observedTipo);
		if (subscriptions.length === 0) return observersData;

		// D2 root guard: created ONCE per user-initiated propagation and threaded
		// through every re-entry (relay/external/info hops share the visited set).
		const guard: CascadeGuard = cascade ?? {
			depth: 0,
			maxDepth: MAX_CASCADE_DEPTH,
			visited: new Set(),
			recomputed: new Set(),
			chain: [`${observedTipo}@${sectionTipo}/${sectionId}`],
		};

		// The saved data's target locators (the observable data) and — since
		// 2026-08-06 — the locators this save REMOVED. Both name records whose
		// mirrors must recompute: a removed target's mirror still lists the
		// saved record, and only visiting it can drop that dead entry. The
		// recompute is idempotent (it re-reads truth from matrix_relation_index
		// under the row lock), so visiting a record that turns out unaffected
		// costs one no-drift compute and writes nothing.
		const asTargets = (items: unknown[]): StoredLocator[] =>
			(items as StoredLocator[]).filter(
				(item) =>
					item !== null &&
					typeof item === 'object' &&
					typeof item.section_tipo === 'string' &&
					item.section_id !== undefined,
			);
		const targets = asTargets(observed.saved);
		const removedTargets = asTargets(observed.removed);
		if (removedTargets.length > 0) {
			incrementCounter('observers_removed_targets_visited', removedTargets.length);
		}

		// Recompute dedup (recomputeMirrorAndHop) lives on the GUARD: every write
		// of one transaction shares it through the ledger, so an
		// already-recomputed target is skipped across the whole operation (see
		// CascadeGuard.recomputed).
		for (const sub of subscriptions) {
			const observerTipo = sub.observerTipo;
			// entryServerBlock is THE dispatchability predicate: undefined for a
			// client-only observer (most of them) AND for a malformed non-object
			// server value (build-time RED — never dispatched, never thrown on).
			const server = entryServerBlock(sub.entry);
			if (server === undefined) continue;
			// No further gate: a declared server edge dispatches — the ontology
			// decides (see the header's DISPATCH RULE).

			const performFunction = server.perform?.function;
			const useObservable = server.config?.use_observable_dato === true;

			// component_info observers (incl. the state/calculation aliases):
			// recompute the widgets per target + TM row; same-record targets
			// ride the save response (see header — oracle-verified 2026-07-10).
			const { getModelByTipo } = await import('../../ontology/resolver.ts');
			const { getComponentModel } = await import('../../components/registry.ts');
			const observerModel = await getModelByTipo(observerTipo);
			const isInfoObserver =
				observerModel !== null &&
				(observerModel === 'component_info' ||
					getComponentModel(observerModel)?.alias === 'component_info');
			if (isInfoObserver && performFunction === undefined) {
				// R5 host-section law: an SQO-filter recompute searches the section
				// the registry's 4-step resolution produced (observe-entry scope →
				// forward spec → the observer's own section, virtual↔real-aware —
				// see observer_subscriptions.ts). Unresolved = step 4: REFUSE
				// LOUDLY, never guess a section (a wrong fallback would search the
				// saved record's section, wrong for a cross-section observer). The
				// validator flags the same edges RED at build/boot.
				if (isSqoFilter(server.filter) && sub.hostSection === undefined) {
					console.error(
						`observer '${observerTipo}' ← '${observedTipo}': SQO-filter edge with UNRESOLVED host section — recompute REFUSED; add a section scope (section_tipo) to the observe entry`,
					);
					incrementCounter('observers_host_section_unresolved');
					continue;
				}
				observersData.push(
					...(await recomputeInfoObserver(
						observerTipo,
						sub.hostSection,
						server,
						sectionTipo,
						sectionId,
						userId,
						now,
						guard,
					)),
				);
				continue;
			}

			// DEFAULT branch, filter:false → PHP re-saves the observer on the
			// changed record. ORACLE-VERIFIED NO-OP for the hi family on this
			// install (an rsc36 save leaves rsc860's relation_search untouched —
			// pinned in the observer differential), so TS matches the no-op.
			// DISTINCT from `filter` ABSENT + config, the relay below — the two
			// shapes were previously indistinguishable here.
			if (performFunction === undefined && server.filter === false) {
				continue;
			}

			// D1 — THE TRIGGER RELAY (PHP's DEFAULT observer branch, v6
			// class.component_common.php:1651-1660 → Save() :1306 →
			// propagate_to_observers :1372): no `perform`, `filter` ABSENT
			// (filter:false is the written-out terminal no-op ABOVE), a config
			// naming use_observable_dato, observer not an info model (handled
			// earlier). PHP reads the observer's value, sets observable_dato =
			// the value WITH REFERENCES and re-SAVES the observer PURELY to
			// re-enter propagation — the value never changes; the branch is a
			// dependency EDGE (numisdata161→numisdata36, tch241→tch40; the
			// ontology's own comment documents the chain: numisdata161 saves →
			// fires numisdata36 → fires numisdata77). TS models it as
			// write:'none' + payload 'with references' — NO TM row, NO dd197/
			// dd201 bump, NO live write (deliberate divergence from PHP's
			// re-save side effects: WC-2026-08-02-observer-relay-writes-nothing)
			// — re-entering through the D2 bounded dispatch.
			if (performFunction === undefined && server.filter === undefined && useObservable) {
				// Removed targets relay too: the hop re-reads the target's CURRENT
				// value with references and re-enters propagation there, which is
				// how the split-off half of an equivalence class gets reached.
				// Writes nothing itself (WC-2026-08-02-observer-relay-writes-nothing).
				const relayTargets = [...targets, ...removedTargets];
				if (server.config?.use_self_section === true) {
					relayTargets.push({ section_tipo: sectionTipo, section_id: sectionId });
				}
				const relayDone = new Set<string>(); // in-loop duplicate targets are not "revisits"
				for (const target of relayTargets) {
					const relayKey = `${target.section_tipo}|${target.section_id}`;
					if (relayDone.has(relayKey)) continue;
					relayDone.add(relayKey);
					await emitCascadeHop(
						guard,
						observerTipo,
						'relay',
						String(target.section_tipo),
						Number(target.section_id),
						userId,
						now,
					);
				}
				continue;
			}

			// THE TARGET RESOLVERS (2026-10-30, external_laws/resolvers.ts): PHP
			// update_observer_data's config switch, CLOSED — self_and_observable /
			// observable / inverse / self. The shape is classified FIRST (a named
			// exemption such as refresh_data is not an external-value law and must
			// not be reported as a refused one), then the observer's law: the
			// resolvers need it (the pointer of the inverse lookup, law (c)'s
			// equivalence-class expansion). Every refusal is logged AND counted —
			// the bare "server shape not covered" log line is gone.
			const { classifyObserverServerShape, reportServerShapeRefusal, resolveObserverTargets } =
				await import('./external_laws/resolvers.ts');
			const shape = classifyObserverServerShape(server);
			if ('refused' in shape) {
				reportServerShapeRefusal(shape, observerTipo, observedTipo);
				continue;
			}
			const { getExternalLaw, reportRefusedLaw } = await import('./external_laws/classify.ts');
			const law = await getExternalLaw(observerTipo);
			if (law.kind === 'refused') {
				// Once per edge and save: no target can run a refused law, so none is
				// resolved (the kernel refuses the same way when called directly).
				reportRefusedLaw(law, `${sectionTipo}/${sectionId} (← '${observedTipo}')`);
				continue;
			}
			const resolved = await resolveObserverTargets({
				observerTipo,
				observedTipo,
				server,
				law,
				saved: { section_tipo: sectionTipo, section_id: sectionId },
				observableSaved: targets,
				observableRemoved: removedTargets,
			});
			if ('refused' in resolved) {
				reportServerShapeRefusal(resolved, observerTipo, observedTipo);
				continue;
			}
			// The targets arrive in the deterministic lock order (resolvers.ts
			// sortTargets): each recompute takes the target row's FOR UPDATE lock,
			// and two concurrent recomputes of one equivalence class must take its
			// locks in the same order. Not deduplicated — the guard's recompute set
			// is the dedup (recomputeMirrorAndHop). A target in a section that does
			// not host the observer is the kernel's counted no-op.
			for (const target of resolved.targets) {
				await recomputeMirrorAndHop(
					observerTipo,
					String(target.section_tipo),
					Number(target.section_id),
					userId,
					now,
					guard,
					// the dispatch loop: a written observer hops, a no-drift one has nothing new to say
					'on-write',
				);
			}
		}
	} catch (error) {
		// Post-commit by construction (the B6 assert above): no ambient
		// transaction can be poisoned, so the swallow is the documented posture —
		// a derived recompute must never fail the write it follows. COUNTED
		// (P1-8 / DATA-29, 2026-09-03): the mirror is STORED, SEARCHABLE relation
		// data, and every other swallow in this file is loud AND counted. The
		// in-transaction rethrow lane (and its `_in_tx` counter) is gone with the
		// ledger: propagation never runs inside a transaction any more, which
		// also closed the residual deadlock window two import rows editing each
		// other's equivalence class used to open.
		console.error(
			`observer propagation failed (swallowed) — '${observedTipo}' @ ${sectionTipo}/${sectionId}; the mirrors are stale until observer_reconcile:`,
			error,
		);
		incrementCounter('observers_propagation_failed');
	}
	return observersData;
}

/**
 * ONE external-mirror recompute and, when it wrote, the cascade hop it owes —
 * the unit of work both the dispatch loop above and the obligation ledger's
 * covered-slot recompute (a whole-record restore never writes a mirror back —
 * section_record/record_write.ts §3e) perform.
 *
 * Deduplicated on the guard (`observerTipo|section_tipo|section_id` — the
 * recompute identity): a recompute is idempotent and reads truth, so doing it
 * twice within one operation is pure waste. D2: a PERSISTED recompute is a
 * save — PHP's Save() re-enters propagate_to_observers, so the written observer
 * fires its own observers, bounded and post-commit — with the locators it
 * DROPPED as the hop's removed set, like any save's before-image, so an
 * observer of this mirror re-derives the records that left it. A
 * refused/withheld/no-drift recompute wrote nothing → no hop (PHP:
 * `$changed=false` skips the Save and therefore the propagation too).
 *
 * The dedup premise ("reads truth") holds because no TRANSIENT mirror value is
 * ever propagated: a restored covered slot is declared as its recompute, never
 * as a change (record_write.ts persistRestoredKeys) — else an observer of it
 * would be recomputed once on the transient value and never again.
 *
 * `hop` 'always' (the obligation ledger's covered-slot recompute): the slot
 * was written by a door that never declared it — an undelete's snapshot mirror,
 * a restored past value — so its observers were told nothing, and a no-drift
 * recompute (the written value IS truth) must hop all the same. Once per
 * operation: a recompute already done on this guard (a referencer's propagation
 * reached the slot first) is not redone, and a hop it already emitted is not
 * emitted twice.
 *
 * Returns the recompute's outcome, or `undefined` when this guard had already
 * recomputed the slot (nothing was computed by THIS call).
 */
export async function recomputeMirrorAndHop(
	observerTipo: string,
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date,
	guard: CascadeGuard,
	/** When the recompute hops: only after it WROTE, or ALWAYS (see above). Required — every caller states it. */
	hop: 'on-write' | 'always',
	/** The kernel's lock-wait bound (recomputeExternalRelation `lockTimeout`) — the refresh door's only. */
	bound: { lockTimeout?: string } = {},
): Promise<ExternalRecomputeOutcome | undefined> {
	const key = `${observerTipo}|${sectionTipo}|${sectionId}`;
	const always = hop === 'always';
	if (guard.recomputed.has(key)) {
		// The earlier recompute of this slot may have been the strict host no-op:
		// the same "not this section's value" rule holds for the hop (below).
		if (always && (await hostsObserver(observerTipo, sectionTipo))) {
			await hopUnlessEmitted(guard, observerTipo, sectionTipo, sectionId, userId, now);
		}
		return undefined;
	}
	guard.recomputed.add(key);
	const outcome = await recomputeExternalRelation(
		observerTipo,
		sectionTipo,
		sectionId,
		userId,
		now,
		// The full law persists, drops included (2026-08-06). The only thing that
		// can still withhold a drop is a DEGRADED SEED, and the kernel derives
		// that for itself — see recomputeExternalRelation. A record born VERBATIM
		// in this operation keeps its snapshot's stamps (CascadeGuard.verbatim).
		{
			...verbatimStampOptions(guard, sectionTipo, sectionId),
			...(bound.lockTimeout === undefined ? {} : { lockTimeout: bound.lockTimeout }),
		},
	);
	if (outcome.wrote === true) {
		await emitCascadeHop(
			guard,
			observerTipo,
			'external',
			sectionTipo,
			sectionId,
			userId,
			now,
			outcome.droppedLocators ?? [],
		);
		return outcome;
	}
	// STRICT host precondition: a slot stored on a record whose section does not
	// declare the observer is not that record's value — the kernel neither
	// computed nor healed it, so it is not a value with observers either. Hopping
	// would propagate its stored bytes (a restored past value, a phantom
	// referencer) as a current-state `saved` (obligation_ledger_native 16c).
	if (always && outcome.targetNotHost !== true) {
		await hopUnlessEmitted(guard, observerTipo, sectionTipo, sectionId, userId, now);
	}
	return outcome;
}

/** The kernel's host predicate (external_laws/resolvers.ts isObserverHostSection — cached ontology reads). */
async function hostsObserver(observerTipo: string, sectionTipo: string): Promise<boolean> {
	const { isObserverHostSection } = await import('./external_laws/resolvers.ts');
	return isObserverHostSection(observerTipo, sectionTipo);
}

/**
 * THE ON-DEMAND REFRESH (the portal's "update external" button — the read
 * door's external_refresh.ts maybeRefreshExternal is its one caller): recompute
 * ONE external mirror from committed truth, NOW, and hop when it wrote — the
 * same unit the dispatch loop performs (recomputeMirrorAndHop 'on-write'),
 * rooted on a fresh cascade guard because a refresh is its own logical
 * operation, not a step of a write's propagation.
 *
 * - IDEMPOTENT: the result is a pure function of committed data, whoever asks.
 *   A no-drift refresh writes NOTHING (no TM row, no stamp) and does not hop.
 * - REFUSES inside a transaction (B6, like propagation): the recompute opens
 *   its own transaction and must COMMIT before the caller reads; joining an
 *   ambient one would hold the target lock across the read and hop on
 *   uncommitted state. Thrown before anything runs — the caller's bug.
 * - Every kernel escape is in the outcome: `refusedLaw`, `targetNotHost`,
 *   `refusedBigResult`, `skippedShrink` (the caller turns them into a notice).
 *   A recompute ERROR propagates: the caller serves its read regardless and
 *   counts the failure (observers_external_refresh_failed) — nothing is
 *   swallowed here, so nothing here can hide one.
 *
 * `actor` is the requesting user: the recompute's TM rows and modified stamps
 * name who asked for it (audit honesty — the value is derived, the act is
 * theirs).
 *
 * `bound.lockTimeout` bounds the recompute's own lock waits (the kernel's
 * `lockTimeout`): past it the recompute throws SQLSTATE 55P03 having written
 * nothing — the door turns that into a retryable withheld `busy`. It bounds
 * THIS recompute's transaction only; the hop a write owes runs after COMMIT
 * under the cascade's own (unbounded) posture — owner ruling 2026-10-30: a
 * timed-out hop would leave downstream mirrors stale.
 */
export async function refreshExternalMirror(
	observerTipo: string,
	sectionTipo: string,
	sectionId: number,
	actor: number,
	now: Date,
	bound: { lockTimeout?: string } = {},
): Promise<ExternalRecomputeOutcome> {
	if (isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message: `refreshExternalMirror: refusing to run inside a transaction — '${observerTipo}' @ ${sectionTipo}/${sectionId}. The refresh opens its own transaction and must commit before the read that asked for it (B6).`,
			coordinates: { tipo: observerTipo, section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	const guard: CascadeGuard = {
		depth: 0,
		maxDepth: MAX_CASCADE_DEPTH,
		visited: new Set(),
		recomputed: new Set(),
		chain: [`${observerTipo}@${sectionTipo}/${sectionId}(refresh)`],
	};
	const outcome = await recomputeMirrorAndHop(
		observerTipo,
		sectionTipo,
		sectionId,
		actor,
		now,
		guard,
		'on-write',
		bound,
	);
	// A fresh guard has recomputed nothing, so the unit always computes.
	if (outcome === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `refreshExternalMirror: a fresh cascade guard reported '${observerTipo}' @ ${sectionTipo}/${sectionId} as already recomputed`,
			coordinates: { tipo: observerTipo, section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	return outcome;
}

/**
 * recomputeExternalRelation's `lockTimeout` contract: the `<digits>ms|s`
 * grammar (it is interpolated into SET LOCAL), and never inside an ambient
 * transaction — the SET LOCAL would bound the CALLER's later statements too.
 */
function assertRecomputeLockTimeout(
	lockTimeout: string | undefined,
	observerTipo: string,
	sectionTipo: string,
	sectionId: number,
): void {
	if (lockTimeout === undefined) return;
	const coordinates = { tipo: observerTipo, section_tipo: sectionTipo, section_id: sectionId };
	if (!/^[1-9]\d*(ms|s)$/.test(lockTimeout)) {
		throw new DedaloError('internal.invariant', {
			message: `recomputeExternalRelation: invalid lockTimeout '${lockTimeout}' (want <digits>ms|s) — '${observerTipo}' @ ${sectionTipo}/${sectionId}`,
			coordinates,
		});
	}
	if (isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message: `recomputeExternalRelation: a lockTimeout inside an ambient transaction would bound the caller's statements too — '${observerTipo}' @ ${sectionTipo}/${sectionId}`,
			coordinates,
		});
	}
}

/** A record born VERBATIM in this operation is recomputed without modified stamps. */
function verbatimStampOptions(
	guard: CascadeGuard,
	sectionTipo: string,
	sectionId: number,
): { stamp: false } | Record<string, never> {
	return guard.verbatim?.has(`${sectionTipo}|${String(sectionId)}`) === true
		? { stamp: false }
		: {};
}

/** The external mirror's hop, unless this operation already emitted it (the guard's visited key). */
async function hopUnlessEmitted(
	guard: CascadeGuard,
	observerTipo: string,
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date,
): Promise<void> {
	if (guard.visited.has(`${observerTipo}|external|${sectionTipo}|${sectionId}`)) return;
	await emitCascadeHop(guard, observerTipo, 'external', sectionTipo, sectionId, userId, now);
}

/**
 * Covered-observer detection (every external-value law — 2026-10-30): such a
 * component's stored bag is DERIVED state, never source data. With the frames
 * its dataframe slots hold for it, it is one UNIT (section_record/record_write.ts
 * §3e): a duplicate copies neither, a replace keeps the live unit, an undelete
 * writes the snapshot's back (its item ids pair its frames) — never declared,
 * always recomputed, and the recompute hops (gated by observer_reconcile_native's
 * duplicate-strip test and obligation_ledger_native cases 2b, 9, 17a–d).
 *
 * ONE predicate (external_laws/resolvers.ts isCoveredExternalObserverNode):
 * the node's law classifies as a STORED law (external_laws/classify.ts — a
 * refused node is not derived state the engine can rebuild, so it is never
 * stripped) AND some `observe` entry dispatches set_dato_external through a
 * shape the resolver table covers. The dispatch, the reconciler, the duplicate
 * strip, the restores and the refresh door share it, so "derived" cannot mean
 * two things. It reads the node's raw declaration, not the Act-2 registry: the
 * question is "is this bag derived state by declaration?".
 */
export async function isCoveredObserverTipo(tipo: string): Promise<boolean> {
	const { isCoveredExternalObserverTipo } = await import('./external_laws/resolvers.ts');
	return isCoveredExternalObserverTipo(tipo);
}

/**
 * component_info observer recompute (PHP update_observer_data for a
 * use_db_data=false compute component — oracle-verified on scratch twins
 * 2026-07-10): resolve the target records, recompute the widgets per target,
 * write ONE matrix_time_machine row each (lg-nolan, the computed live
 * shape), NEVER touch the live misc column, and return the response data
 * item for targets equal to the saved record.
 *
 * WHY WRITING ONLY HISTORY IS SOUND (P1-8 / DATA-15, 2026-09-03,
 * WC-2026-09-03-info-stored-value-never-served): a component_info value is a
 * DERIVED DISPLAY value, computed per principal at read time — the read path
 * (components/component_info/emit.ts) never serves a stored `misc` array, so
 * a Time Machine restore of one of the rows written here is INERT for what is
 * served, and the served value can never freeze at a stale snapshot. The TM
 * row remains what it is: a dated record of what the widgets computed then.
 */
async function recomputeInfoObserver(
	observerTipo: string,
	hostSectionTipo: string | undefined,
	server: NonNullable<ObserveEntry['server']>,
	savedSectionTipo: string,
	savedSectionId: number,
	userId: number,
	now: Date,
	cascade: CascadeGuard,
): Promise<unknown[]> {
	// targets
	const targets: { sectionTipo: string; sectionId: number }[] = [];
	const filter = server.filter;
	if (isSqoFilter(filter)) {
		// PHP: every clause's q := the saved record's locator, with
		// from_component_tipo taken from the FIRST clause's last path step (the
		// portal/relation the observer's section references the record through).
		const mutated = structuredClone(filter) as Record<
			string,
			{ q?: unknown; path?: { component_tipo?: string }[] }[]
		>;
		const firstKey = Object.keys(mutated)[0];
		const clauses = firstKey !== undefined ? mutated[firstKey] : undefined;
		if (!Array.isArray(clauses) || clauses.length === 0 || clauses[0] === undefined) {
			console.error(`observer '${observerTipo}': no elements in server.filter (PHP parity skip)`);
			return [];
		}
		const firstPath = clauses[0].path;
		const fromComponentTipo = Array.isArray(firstPath)
			? firstPath[firstPath.length - 1]?.component_tipo
			: undefined;
		// The q locator is the SAVED RECORD'S ADDRESS: int, the canonical form
		// (WC-2026-08-10-section-id-int-canonical repeals the String() minting
		// that used to be needed to match the stored string bytes). The relation
		// search builder probes both typed forms of section_id, so an int q still
		// finds rows whose stored locators are the legacy strings.
		const qLocator: Record<string, unknown> = {
			section_tipo: savedSectionTipo,
			section_id: savedSectionId,
		};
		if (fromComponentTipo !== undefined) qLocator.from_component_tipo = fromComponentTipo;
		for (const clause of clauses) {
			clause.q = qLocator;
		}
		// The registry's 4-step host resolution supplies the search section; the
		// caller refused the recompute if it was unresolved (step 4 — never a
		// guessed fallback).
		if (hostSectionTipo === undefined) {
			console.error(
				`observer '${observerTipo}': SQO recompute reached with an unresolved host section — refused (defense in depth; the dispatch guard should have caught this)`,
			);
			incrementCounter('observers_host_section_unresolved');
			return [];
		}
		const searchSection = hostSectionTipo;
		const { sanitizeClientSqo } = await import('../../concepts/sqo.ts');
		const { buildSearchSql } = await import('../../search/sql_assembler.ts');
		const { runSearch } = await import('../../search/search_statement.ts');
		const sqo = sanitizeClientSqo({
			section_tipo: [searchSection],
			filter: mutated,
			limit: 1,
		});
		sqo.limit = 'all'; // PHP set_limit(0) = every referencing record
		const query = await buildSearchSql(sqo);
		const rows = (await runSearch(query)) as ({
			section_tipo: string;
			section_id: number;
		} & Record<string, unknown>)[];
		for (const row of rows) {
			targets.push({ sectionTipo: row.section_tipo, sectionId: Number(row.section_id) });
		}
	} else {
		// filter:false — the observer lives on the SAME record that changed
		targets.push({ sectionTipo: savedSectionTipo, sectionId: savedSectionId });
	}

	const { computeInfoWidgets } = await import(
		'../../components/component_info/widgets/registry.ts'
	);
	const { normalizeWidgetEntryKeys } = await import(
		'../../components/component_info/widgets/widget_common.ts'
	);
	const { currentDataLang } = await import('../../resolve/request_lang.ts');
	const { currentPrincipal } = await import('../../security/request_context.ts');
	const principal = currentPrincipal();

	const responseItems: unknown[] = [];
	for (const target of targets) {
		const items = await computeInfoWidgets(observerTipo, {
			sectionTipo: target.sectionTipo,
			sectionId: target.sectionId,
			mode: 'list',
			lang: currentDataLang(),
			userId: principal?.userId ?? userId,
			isAdmin: principal?.isGlobalAdmin,
		});
		// TM row — the computed live shape (lg-nolan; PHP writes one per save;
		// the live misc column is deliberately NOT touched, matching PHP).
		await recordTimeMachine(
			{
				sectionTipo: target.sectionTipo,
				sectionId: target.sectionId,
				componentTipo: observerTipo,
				lang: 'lg-nolan',
				userId,
				data: items !== null && items.length > 0 ? items : null,
			},
			dbTimestamp(now),
		);
		// D2: PHP's info recompute also ends in Save() →
		// propagate_to_observers of the info component — in practice a leaf
		// (no shipped info component declares `observers`; emitCascadeHop's
		// pre-gate no-ops on leaves), carried for parity completeness.
		await emitCascadeHop(
			cascade,
			observerTipo,
			'info',
			target.sectionTipo,
			target.sectionId,
			userId,
			now,
		);
		// same-record target → the save response carries the recomputed item
		// (PHP observers_data). WC-2026-08-10-section-id-int-canonical repeals
		// the "section_id STRING as PHP emits it here" law: a record address on
		// the app wire is emitted in canonical INT form; the client compares
		// section_ids loosely (same_section_id), so both forms still match.
		if (target.sectionTipo === savedSectionTipo && target.sectionId === savedSectionId) {
			responseItems.push({
				section_id: target.sectionId,
				section_tipo: target.sectionTipo,
				tipo: observerTipo,
				mode: 'list',
				lang: 'lg-nolan',
				from_component_tipo: observerTipo,
				entries: normalizeWidgetEntryKeys(items ?? []),
			});
		}
	}
	return responseItems;
}

/**
 * PHP's big-result freeze (v6 class.component_relation_common.php:2087,
 * `$total_ar_result>2000`): above this the order-preserving merge is skipped
 * AND the save is withheld (`$changed = false; // avoid expensive save`) —
 * PHP computes but never persists. TS ports it as an explicit WRITE REFUSAL
 * (counted + logged; the compute still reports the diff). Reachable on this
 * install: rsc387 → cult1/5 holds 4,547 referencers.
 */
const EXTERNAL_REFERENCES_FREEZE = 2000;

/**
 * The classifier refusals that are a law-less node, not a refused law (the
 * historical `observers_component_to_search_missing` family): the kernel
 * returns them as the plain counted skip, with no `refusedLaw` flag.
 */
const COUNTED_SKIP_REASONS: readonly ExternalLawRefusalReason[] = Object.freeze([
	'node_missing',
	'source_not_object',
	'component_to_search_missing',
]);

/** The numeric item `id`s of `before` that `after` no longer holds (the dropped locators). */
function droppedItemIds(before: readonly unknown[], after: readonly unknown[]): number[] {
	const idOf = (entry: unknown): number | null => {
		const id = Number((entry as { id?: unknown } | null)?.id);
		return Number.isInteger(id) && id > 0 ? id : null;
	};
	const kept = new Set(after.map(idOf));
	return before.map(idOf).filter((id): id is number => id !== null && !kept.has(id));
}

/**
 * What one external-mirror recompute did (recomputeExternalRelation's return
 * contract — see its docstring for the escapes and the before/after rule).
 */
export interface ExternalRecomputeOutcome {
	changed: boolean;
	before: number;
	after: number;
	/** Drops were withheld: this record's computed value was DEGRADED (see
	 * seedDefects). The only remaining shrink escape — there is no caller-supplied one. */
	skippedShrink?: boolean;
	/** The never-narrow escapes that degraded this record's value, verbatim —
	 * present exactly when skippedShrink is. Names the ontology to fix. */
	seedDefects?: string[];
	/**
	 * MEMBERSHIP counts, not length deltas: `dropped` = stored entries the law
	 * no longer matches, `added` = desired entries not stored yet. `before -
	 * after` cannot substitute — a 1-drop+1-add swap has an equal length and
	 * would report 0/0, which is exactly the regression shape a drop budget must
	 * catch. Present on every computed outcome (absent only on pre-compute
	 * refusals, which computed nothing).
	 */
	dropped?: number;
	added?: number;
	/**
	 * The observer's node classifies as NO stored law (external_laws/classify.ts
	 * — an ambiguous, malformed or law-less node): refused wholesale,
	 * pre-compute, never run under a fallback law. Kept distinct so callers
	 * that aggregate outcomes (the reconciler) never report such a node as
	 * clean. Replaces the Phase-0 `refusedSublaw` (both sub-laws are ported).
	 */
	refusedLaw?: { reason: ExternalLawRefusalReason };
	/**
	 * The target record's section does not HOST the observer (it is not in
	 * declaredSectionComponents(section)): a counted no-op, pre-compute — a
	 * mirror is never written onto a record whose section does not declare it.
	 */
	targetNotHost?: true;
	possiblyTruncated?: boolean;
	refusedBigResult?: boolean;
	/** True ONLY when a live-column write actually persisted (D2: the cascade
	 * hops on this — PHP re-propagates only after a real Save()). Absent on
	 * dry runs, refusals, no-drift skips and pure withheld shrinks. */
	wrote?: boolean;
	/**
	 * (`options.repairIndex` only — the reconcile's sweep.) The VALUE stays as
	 * stored — it agrees with the law (`changed` false), or its write is
	 * refused/withheld: the freeze, a pure degraded-value shrink (`changed`
	 * true) — but the stored `_hi` ancestor index (`relation_search[observerTipo]`)
	 * does not agree with it: a mirror the recompute wrote before CORE-2 carries
	 * a value and no index. Dry run: an apply would rewrite the index; apply: the
	 * index was rewritten (through the cascade-owned chokepoint entry, UNSTAMPED
	 * — nothing a curator sees changed). `wrote` stays absent: the value did not
	 * move, so there is nothing to hop.
	 */
	indexDrift?: boolean;
	/**
	 * (`wrote` only.) The stored locators this write DROPPED
	 * (section_record removedLocators — the ledger's one removal rule): the
	 * cascade hop propagates their removal (recomputeMirrorAndHop).
	 */
	droppedLocators?: unknown[];
}

/**
 * THE EXTERNAL-MIRROR KERNEL: the component's data := what its classified
 * value law says (external_laws/ — ONE closed classifier picks exactly one):
 *   - law (c), `inverse_search` — every record referencing (targetSection,
 *     targetId) through source.component_to_search, OR any equivalent of the
 *     target reachable through source.data_from_field (the D3 seed law,
 *     collectExternalSeed), limited to source.section_to_search; existing
 *     entries kept in stored order, new references appended;
 *   - sub-law (b), `source_overwrite` — the bag of the record the pointer
 *     component names, copied in the source's order;
 *   - sub-law (a), `observed_data` — the locators inside a same-record text's
 *     tags (document order), or a same-record relation bag copied.
 * The law computes the DESIRED set; this kernel owns everything after it: the
 * one merge (external_laws/merge.ts mergeMirror — the mirror owns its item
 * ids), the escapes, the persist, the history and the hop's dropped set.
 *
 * EXPORTED for scripts/observer_reconcile.ts: the reconciler heals mirrors
 * that doors outside the chokepoint that state they do not propagate (see
 * the module header) left stale by replaying THIS exact recompute per candidate record — one law,
 * one implementation. `write:false` = dry run (diff only, no persist/TM).
 *
 * CONCURRENCY (review 2026-07-24): the write phase runs inside ONE
 * withTransaction with the target row locked FOR UPDATE and the bag + index
 * (+ a copy law's pointer) truth RE-READ under the lock by the law itself —
 * two concurrent saves referencing the same term serialize instead of
 * last-writer-wins dropping the newer referencer, and the TM pair + live write
 * commit atomically. A copy law reads its source row FOR SHARE, always AFTER
 * the target (one lock order). The dry run stays lock-free. The adjudication
 * happens INSIDE the lock — no TOCTOU — and is MEMBERSHIP-based, so a
 * 1-drop+1-add swap is decided per entry, not by length.
 *
 * THE FULL LAW ALWAYS PERSISTS, drops included (2026-08-06). The escapes are
 * ALL derived by this kernel — there is no caller-supplied shrink switch
 * (`allowShrink` was removed; a parameter that can mean "allow" is the hole
 * that armed the 2026-08-02 wipe):
 *   1. a node no law may run on (the classifier's refusal) — refused
 *      wholesale, pre-compute → `refusedLaw`;
 *   2. a target whose section does not host the observer → `targetNotHost`
 *      (pre-compute, counted, never logged per record: every
 *      use_observable_dato edge whose saved value also names foreign records
 *      reaches it by design);
 *   3. the >2000-reference freeze, law (c) only (PHP :2087 — the copy laws
 *      never had it) → `refusedBigResult`;
 *   4. a finite non-zero `referencesLimit` → `possiblyTruncated`;
 *   5. a DEGRADED VALUE (this record's own never-narrow escapes — a degraded
 *      seed, an unreadable source node) → the drop half alone is withheld,
 *      additions still land → `skippedShrink` + `seedDefects`.
 *
 * RETURN CONTRACT: `before`/`after` always describe the FULL-LAW diff
 * (stored → the merged bag, the truth target) so a dry run, a degraded-value
 * refusal and a clean apply all report the same numbers; when
 * `skippedShrink` is set in apply mode the record actually holds
 * `before + additions` entries (drops withheld). `options` stays REQUIRED so
 * `write` intent is always stated at the call site.
 */
export async function recomputeExternalRelation(
	observerTipo: string,
	targetSection: string,
	targetId: number,
	userId: number,
	now: Date,
	options: {
		write?: boolean;
		referencesLimit?: number;
		/**
		 * `false` = write the mirror WITHOUT the owner's modified stamps: the
		 * record was born VERBATIM in this operation (CascadeGuard.verbatim — a
		 * bulk revert's undelete keeps its snapshot's stamps). Absent = stamped,
		 * like every PHP observer Save().
		 */
		stamp?: false;
		/**
		 * `true` = THE RECONCILE'S LEGACY-INDEX SWEEP: whenever the VALUE stays
		 * as stored (it agrees, the >2000 freeze, a pure degraded-value withheld
		 * shrink), also compare the stored `_hi` ancestor index with the save law's
		 * derivation and (apply) rewrite it — see `indexDrift`. Absent on the
		 * interactive propagation path ON PURPOSE: the comparison walks every
		 * mirror item's thesaurus chain (one SELECT per ancestor level per item,
		 * uncached), and under the row lock of every no-drift recompute that is
		 * N×D queries paid forever for a condition only a mirror written before
		 * CORE-2 (or a raw drift) can be in — every mirror write since derives its
		 * index in the same UPDATE. The one-off repair is the reconcile's
		 * (scripts/observer_reconcile.ts, the reconcile registry).
		 */
		repairIndex?: true;
		/**
		 * A BOUND on every lock wait of the write phase: `SET LOCAL lock_timeout`
		 * is the FIRST statement of its transaction, so the target's FOR UPDATE
		 * (and a copy law's FOR SHARE) give up past it — SQLSTATE 55P03, the
		 * transaction rolls back, nothing is written, and the error propagates
		 * to the caller. Grammar `<digits>ms|s`. Set ONLY by the read-level
		 * refresh door (refreshExternalMirror ← external_refresh.ts
		 * EXTERNAL_REFRESH_LOCK_TIMEOUT): a READ must never park a request-pool
		 * connection behind a long write. Refused inside an ambient transaction
		 * (a SET LOCAL there would outlive this recompute into the caller's).
		 */
		lockTimeout?: string;
	},
): Promise<ExternalRecomputeOutcome> {
	const unchanged = { changed: false, before: 0, after: 0 };
	assertRecomputeLockTimeout(options.lockTimeout, observerTipo, targetSection, targetId);
	// REFERENCES_LIMIT IS NEVER HONOURED (deliberate divergence from PHP —
	// WC-2026-08-02-observer-references-limit-not-honoured). PHP threads
	// perform.params.references_limit into the search as a naked SQL LIMIT; on
	// the write path a capped result set is indistinguishable from "these
	// records stopped referencing you", and the order-preserving merge removes
	// by OMISSION. MEASURED: tchi1/162 stores 1,023 numisdata250 locators
	// against a declared references_limit:200 — honouring the cap would
	// persist a 200-entry bag and destroy 823 locators. The recompute always
	// searches with limit:false; a caller that ever passes a finite NONZERO
	// limit is refused OUTRIGHT (counted + logged) instead of truncating — the
	// refusal is the tripwire for anyone "completing" the params port later.
	// 0 is PHP's UNCAPPED sentinel (`$sqo->set_limit($references_limit)` with
	// 0 = 'ALL', v6 :2040 — most shipped observe configs declare 0), so a
	// faithful params port passing 0 means "no limit" and falls through
	// (review 2026-08-02: refusing 0 would dead-stop every recompute
	// install-wide the day the params port lands).
	if (options.referencesLimit !== undefined && options.referencesLimit !== 0) {
		console.error(
			`observer '${observerTipo}' @ ${targetSection}/${targetId}: finite referencesLimit (${options.referencesLimit}) REFUSED — a capped recompute is possibly truncated and the merge removes by omission (tchi1/162: cap 200 would destroy 823 of 1,023 locators)`,
		);
		incrementCounter('observers_references_limit_refused');
		return { ...unchanged, possiblyTruncated: true };
	}
	// THE LAW (2026-10-30): ONE closed classifier decides which value law this
	// node's bag obeys, and refuses a node no law may run on — BEFORE any read.
	// This replaces the Phase-0 disarm that refused every `set_observed_data` /
	// `source_overwrite` node (both sub-laws are ported now): law (c) run on a
	// source_overwrite node was the measured full wipe (numisdata665/3120
	// 1077→0; exposure 118,449 + 13,357 locators), which is why the classifier
	// never falls back from one law to another — an ambiguous node is refused.
	// Observers run post-commit with errors swallowed, so a refusal is a loud
	// log + ops counter (reportRefusedLaw), never a throw. A malformed scalar
	// source (oh55 a string, oh90 a number) is one such refusal, counted under
	// the historical observers_component_to_search_missing like a missing
	// pointer — duplicate_record reaches this kernel with no try/catch.
	const { getExternalLaw, reportRefusedLaw } = await import('./external_laws/classify.ts');
	const law = await getExternalLaw(observerTipo);
	if (law.kind === 'refused') {
		reportRefusedLaw(law, `${targetSection}/${targetId}`);
		// A node with no law at all (no node, no source, no pointer) keeps its
		// historical shape — the counted skip, `unchanged` alone: there is no
		// mirror law to be refused. A node whose declared law is ambiguous or
		// malformed is a REFUSAL the aggregating callers must see.
		return COUNTED_SKIP_REASONS.includes(law.reason)
			? unchanged
			: { ...unchanged, refusedLaw: { reason: law.reason } };
	}

	const table = await getMatrixTableFromTipo(targetSection);
	if (table === null) return unchanged;

	// THE HOST PRECONDITION (2026-10-30, STRICT — owner ruling): the kernel
	// computes a mirror ONLY on records of a section that DECLARES the observer —
	// the one section census the record wipe and the covered-slot birth share
	// (declaredSectionComponents: own ∪ real subtree, so a term stored under a
	// VIRTUAL catalog section is hosted through its real section). Before the
	// copy laws ran this was harmless by accident; it is not: a
	// use_observable_dato edge's saved value names records of every section it
	// links to (the type a catalog term points at), and a copy law computed there
	// writes a mirror onto a record that never declared it. Law (c) already did,
	// measured 2026-10-30: hierarchy93 ← rsc387 onto numisdata6/tchi1/numisdata3
	// records, numisdata321 ← numisdata282 onto tchi1 — slots no edit form
	// renders. PHP instantiates the observer on any target (a WC-ledgered
	// divergence, `WC-2026-10-30-observer-target-not-host`).
	//
	// STRICT: a slot ALREADY STORED on such a record (a PHP-era orphan, a key
	// left by an ontology move, a Time Machine restore of one) is skipped too —
	// neither grown, shrunk nor healed. The section does not declare the
	// component, so it is not this section's value: nothing renders it, and a
	// recompute there is a write the record's own definition never asked for
	// (the 2026-10-30 corpus dry run wanted 742 drops on 3 such records). No
	// data is repaired either (owner ruling). A counted no-op, no lock, no read,
	// NOT logged per record: every such edge reaches it by design.
	const { externalValueLawOf, isObserverHostSection } = await import(
		'./external_laws/resolvers.ts'
	);
	if (!(await isObserverHostSection(observerTipo, targetSection))) {
		incrementCounter('observers_target_not_host');
		return { ...unchanged, targetNotHost: true };
	}

	const { mergeMirror } = await import('./external_laws/merge.ts');
	const valueLaw = externalValueLawOf(law);
	// The recompute law over one consistent snapshot, in PIECES so the
	// degraded-value rule below decides what persists. The LAW reads the target
	// row (bag, `_hi` index, a copy law's pointer — FOR UPDATE when locked) and
	// answers the desired set; the ONE merge turns it into the bag: `kept` =
	// stored entries still wanted, `additions` = new ones with the next item ids
	// (the mirror owns its ids), `merged` = the full law, in the law's order.
	// Degraded-value merge = existing+additions.
	const compute = async (lock: boolean) => {
		const result = await valueLaw.compute(law, { targetSection, targetId, table, lock });
		const { merged, kept, additions } = mergeMirror(
			result.existing,
			result.desired,
			observerTipo,
			result.order,
			{
				fallbackType: result.fallbackType,
				...(result.dropSelf
					? { dropSelf: { section_tipo: targetSection, section_id: targetId } }
					: {}),
			},
		);
		return { ...result, merged, kept, additions };
	};

	// Dry run: diff only, no lock, no writes. Reports the FULL-LAW diff (the
	// truth target — this is the diagnostic that measured the wipe), plus
	// skippedShrink when an apply under these options would withhold drops and
	// refusedBigResult when an apply would hit the PHP >2000 freeze.
	if (options.write === false) {
		const {
			exists,
			existing,
			storedIndex,
			merged,
			kept,
			additions,
			referenceCount,
			freeze,
			defects,
		} = await compute(false);
		if (!exists) return unchanged;
		const replaced = merged;
		const changed = JSON.stringify(replaced) !== JSON.stringify(existing);
		const wouldWithhold = kept.length < existing.length && defects.length > 0;
		const wouldFreeze = changed && freeze && referenceCount > EXTERNAL_REFERENCES_FREEZE;
		// An apply that would leave the VALUE as stored — no drift, the freeze, or a
		// pure withheld shrink — is where the index sweep acts (see keepStoredValue).
		const valueStays = !changed || wouldFreeze || (wouldWithhold && additions.length === 0);
		const indexDrift =
			valueStays &&
			options.repairIndex === true &&
			(await legacyIndexDisagrees(observerTipo, existing, storedIndex));
		if (!changed) {
			return {
				changed: false,
				before: existing.length,
				after: replaced.length,
				dropped: 0,
				added: 0,
				...(indexDrift ? { indexDrift: true } : {}),
			};
		}
		return {
			changed,
			before: existing.length,
			after: replaced.length,
			dropped: existing.length - kept.length,
			added: additions.length,
			...(wouldWithhold ? { skippedShrink: true, seedDefects: [...defects] } : {}),
			...(wouldFreeze ? { refusedBigResult: true } : {}),
			...(indexDrift ? { indexDrift: true } : {}),
		};
	}

	const { withTransaction } = await import('../../db/postgres.ts');
	return withTransaction(async () => {
		// THE LOCK-WAIT BOUND (the refresh door's only): the FIRST statement, so
		// every lock this transaction waits for is bounded (validated above).
		if (options.lockTimeout !== undefined) {
			await sql.unsafe(`SET LOCAL lock_timeout = '${options.lockTimeout}'`, []);
		}
		// LOCK-HOLD OBSERVABILITY (review 2026-08-02): compute(true) holds the
		// target row's FOR UPDATE lock through the D3 closure walk + the uncapped
		// inverse search — on big observers (tchi1/162: 1,023 locators behind a
		// dd621 closure) that is seconds of lock hold, and under an ambient
		// import tx the lock lives until the whole row commits. Accepted trade
		// (the merge must adjudicate under the lock), but MONITORED: a slow
		// locked compute is logged + counted so contention shows up in the
		// counters page before it shows up as editor stalls.
		const lockedStart = performance.now();
		const {
			exists,
			existing,
			storedIndex,
			merged,
			kept,
			additions,
			referenceCount,
			freeze,
			defects,
		} = await compute(true);
		const lockedMs = performance.now() - lockedStart;
		if (lockedMs > 2000) {
			console.warn(
				`observer '${observerTipo}' @ ${targetSection}/${targetId}: locked recompute took ${Math.round(lockedMs)}ms holding FOR UPDATE (counted: observers_recompute_lock_slow)`,
			);
			incrementCounter('observers_recompute_lock_slow');
		}
		if (!exists) return unchanged; // target record does not exist
		const replaced = merged;
		// THE VALUE STAYS AS STORED (no drift, the freeze, a pure withheld shrink):
		// the VALUE not moving does not make its `_hi` index agree — a mirror
		// written before CORE-2 holds its value and no index. On the RECONCILE's
		// sweep (options.repairIndex — never the interactive path, see the option)
		// the index alone is rewritten: same value, derived index, under this lock,
		// NO stamps and no history (nothing a curator can see changed), and no hop.
		// Every branch that returns without writing the value asks it — a frozen
		// or degraded-seed mirror is exactly the one no later write re-indexes.
		const keepStoredValue = async (): Promise<{ indexDrift?: true }> => {
			if (
				options.repairIndex !== true ||
				!(await legacyIndexDisagrees(observerTipo, existing, storedIndex))
			) {
				return {};
			}
			const { persistObserverMirrorKeys } = await import('../../section_record/index.ts');
			await persistObserverMirrorKeys(
				{ table, sectionTipo: targetSection, sectionId: targetId },
				[{ column: 'relation', key: observerTipo, value: existing }],
				false,
				{ actor: userId, now },
			);
			incrementCounter('observers_index_repaired');
			return { indexDrift: true };
		};
		// No drift → no write (PHP re-saves anyway; we skip the no-op to
		// avoid TM noise — the stored VALUE converges either way).
		if (JSON.stringify(replaced) === JSON.stringify(existing)) {
			return {
				changed: false,
				before: existing.length,
				after: replaced.length,
				dropped: 0,
				added: 0,
				...(await keepStoredValue()),
			};
		}
		// BIG-RESULT FREEZE (PHP :2087 ported as a write refusal — see
		// EXTERNAL_REFERENCES_FREEZE): PHP skips the merge above 2000 results
		// and withholds the save ("avoid expensive save", changed stays false).
		// TS computes the full-law diff for honest reporting but persists
		// NOTHING — a counted, logged refusal, adjudicated inside the row lock.
		// Law (c) only (the law says so — LawComputeResult.freeze): PHP's copy
		// laws never froze, and a copied bag is bounded by its source's.
		if (freeze && referenceCount > EXTERNAL_REFERENCES_FREEZE) {
			console.error(
				`observer '${observerTipo}' @ ${targetSection}/${targetId}: ${referenceCount} references exceed the ${EXTERNAL_REFERENCES_FREEZE}-reference freeze (PHP parity) — write REFUSED (${existing.length} stored, law wants ${replaced.length})`,
			);
			incrementCounter('observers_big_result_refused');
			return {
				changed: true,
				before: existing.length,
				after: replaced.length,
				dropped: existing.length - kept.length,
				added: additions.length,
				refusedBigResult: true,
				...(await keepStoredValue()),
			};
		}
		// DEGRADED-SEED SHRINK REFUSAL (2026-08-06) — the ONE thing that can
		// still withhold a drop, and the kernel computes it for itself. Every
		// law reports its own never-narrow escapes as `defects` (law (c)'s seed;
		// a copy law's missing source node or table), so the rule is one rule.
		//
		// It replaces the Phase-0 GROW-ONLY fail-safe (2026-08-02), whose
		// premise expired: that guard existed because the value law was known
		// TOO SMALL (the data_from_field closure was unported), so every drop
		// was suspect. The closure landed (D3 — 19,885/19,908 exact) and the
		// blanket guard became the defect: a mirror that can only grow is not a
		// mirror, and a legitimate removal was never propagated (the reported
		// numisdata36 equivalence case — measured corpus-wide 2026-08-06 as 22
		// records / 1,673 locators of accumulated wrong data, every drop
		// verified genuine).
		//
		// What remains suspect is a seed this call KNOWS it could not build:
		// a missing peer ontology node, a non-tipo data_from_field entry, a
		// malformed peer locator. Those are the measured 247,933-locator-loss
		// shape. Under grow-only they cost nothing; under the full law they
		// would be a mass delete. So the drop half — and ONLY the drop half —
		// is withheld exactly when this record's own seed was degraded.
		//
		// Deliberately NOT a caller option: `allowShrink` was removed with this
		// change (an omitted argument armed the 2026-08-02 wipe; a parameter
		// that can mean "allow" is a hole no gate can close for good). The law
		// is the law; the only escapes are the refusals the kernel derives — a
		// refused law, a target not hosting the observer, the >2000-reference
		// freeze, the refused reference cap, and this one.
		const dropped = existing.length - kept.length;
		const withheld = dropped > 0 && defects.length > 0;
		if (withheld) {
			console.error(
				`observer '${observerTipo}' @ ${targetSection}/${targetId}: shrink REFUSED — DEGRADED SEED [${defects.join(', ')}] — ${dropped} stale entrie(s) kept (${existing.length} stored, law keeps ${kept.length}, +${additions.length} new); fix the peer ontology node, then re-run scripts/observer_reconcile.ts`,
			);
			incrementCounter('observers_shrink_refused_degraded_seed');
			// Legacy alias, kept so dashboards built on the old name do not read
			// as "suddenly zero" the day this ships. REMOVE after the 2026-08
			// release; the specific name above is the one to alert on.
			incrementCounter('observers_shrink_refused');
		}
		// What persists: the full law, unless this record's seed was degraded —
		// then the grow-only merge (every existing entry kept in place + the
		// additions appended).
		const finalData = withheld ? [...existing, ...additions] : replaced;
		if (JSON.stringify(finalData) === JSON.stringify(existing)) {
			// Pure withheld shrink: nothing to persist. `after` = the law's
			// target count (what an undegraded seed would write), like the dry run.
			return {
				changed: true,
				before: existing.length,
				after: replaced.length,
				dropped: existing.length - kept.length,
				added: additions.length,
				skippedShrink: true,
				seedDefects: [...defects],
				...(await keepStoredValue()),
			};
		}

		const { persistObserverMirrorKeys } = await import('../../section_record/index.ts');
		const { mainIdentity, readMainSlots, readMainState, recordMainBackfill, recordMainHistory } =
			await import('../../relations/dataframe_slots.ts');
		const { removeDataframeDataById } = await import('../../relations/save.ts');
		const target = { table, sectionTipo: targetSection, sectionId: targetId };
		const identity = await mainIdentity(observerTipo, 'lg-nolan');
		const stamp = dbTimestamp(now);
		await ensureTmHistoryReady();
		// The observer's state BEFORE this write (read now, under the lock): its
		// value and its slots — an observer may carry a dataframe slot like any
		// component, and its history is two-lane like every main's
		// (relations/dataframe_slots.ts recordMainHistory).
		const before = {
			// an empty mirror is recorded as nothing (null), the PHP baseline shape
			value: existing.length > 0 ? existing : undefined,
			slots: await readMainSlots(target, observerTipo),
		};
		// P0-14: the probe asks whether THIS record already has a backfill row.
		// Without the epoch narrowing, a DEAD generation's rows at the same
		// address answer yes and the reborn record's own history is never
		// written — the defect inverted: not inherited history, but suppressed.
		// VISIBLE rows only (withTmHistory): a bulk run's hidden undo-log row
		// (a BEFORE image, a birth marker) is not the visible baseline and must
		// not suppress the pair dd15 needs.
		// `anyTag`: an unsliced main's one lane is every row whatever its tag (LaneHistoryProbe).
		const hasHistory = async (lane: string, anyTag: boolean): Promise<boolean> =>
			(
				(await sql.unsafe(
					`SELECT 1 FROM matrix_time_machine
					 WHERE ${withTmHistory(`section_tipo = $1 AND section_id = $2 AND tipo = $3${anyTag ? '' : ' AND lang = $4'}`)}
					 LIMIT 1`,
					anyTag
						? [targetSection, targetId, observerTipo]
						: [targetSection, targetId, observerTipo, lane],
				)) as unknown[]
			).length > 0;
		await recordMainBackfill(
			target,
			identity,
			before,
			{ userId, timestamp: dbTimestamp(new Date(now.getTime() - 60_000)) },
			hasHistory,
			{ emptyDoorLane: true },
		);
		// Chokepoint write — its CASCADE-OWNED entry: observer value + the
		// owner's modified stamps (dd197/dd201) + the derived `relation_search`
		// of an `_hi` mirror, in ONE update, like every PHP component save. The
		// index is derived from `finalData` — what is actually STORED, a withheld
		// shrink included (CORE-2: this write used to leave an `_hi` mirror with
		// no ancestor index, so a broader-term search missed it). No ledger
		// entry: the caller's recomputeMirrorAndHop hops the written observer.
		await persistObserverMirrorKeys(
			target,
			[{ column: 'relation', key: observerTipo, value: finalData.length > 0 ? finalData : [] }],
			options.stamp === false ? false : { userId, now },
			{ actor: userId, now },
		);
		// A dropped locator takes its paired frames with it (the component save's
		// remove cascade, PHP remove_dataframe_data_by_id) — else they stay in the
		// slot as orphans every later frame-lane row would record as live.
		for (const id of droppedItemIds(existing, finalData)) {
			await removeDataframeDataById(table, targetSection, targetId, observerTipo, id, userId);
		}
		// The save rows: the value written + the slots AFTER the cascade.
		await recordMainHistory(
			target,
			identity,
			{ before, after: await readMainState(target, identity, before.slots.slots) },
			{ userId, timestamp: stamp, bulkId: null },
		);
		// `after` = the full-law target (see the return contract). When drops
		// were withheld the record actually holds existing+additions entries.
		const { removedLocators } = await import('../../section_record/index.ts');
		return {
			changed: true,
			before: existing.length,
			after: replaced.length,
			dropped: existing.length - kept.length,
			added: additions.length,
			wrote: true,
			droppedLocators: removedLocators(existing, finalData),
			...(withheld ? { skippedShrink: true, seedDefects: [...defects] } : {}),
		};
	});
}

/** The reconcile's legacy-index question (record_write.ts hiIndexDisagrees). */
async function legacyIndexDisagrees(
	observerTipo: string,
	existing: readonly unknown[],
	storedIndex: unknown,
): Promise<boolean> {
	const { hiIndexDisagrees } = await import('../../section_record/index.ts');
	return hiIndexDisagrees(observerTipo, existing, storedIndex);
}
