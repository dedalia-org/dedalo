/**
 * Observer mirror reconciliation — the shared kernel under BOTH consumers:
 * scripts/observer_reconcile.ts (CLI sweep, dry-run default) and the v6→v7
 * data-update pipeline (update/engine.ts success tail — the update writes
 * records WITHOUT the save chokepoint, so mirrors arrive stale by
 * construction; this is how dc1 §2 drifted in the first place).
 *
 * Discovery/candidates/loop semantics documented in the CLI header; the one
 * recompute law lives in ./observers.ts recomputeExternalRelation (row-locked,
 * in-lock shrink adjudication). WHICH law a tuple runs, and which records it
 * visits, is the law registry's (./external_laws/: the classifier names the
 * law, the law's own `candidateIds` names the records) — this module only
 * discovers (observer, section) tuples and adjudicates kernel outcomes.
 */

import { incrementCounter } from '../../api/counters.ts';
import { sql } from '../../db/postgres.ts';
import { getMatrixTableFromTipo, getNode, listSectionNodes } from '../../ontology/resolver.ts';
import type { ReconcileDefinition } from '../../reconcile/registry.ts';
import { isStoredExternalLaw, resolveExternalLaw } from './external_laws/classify.ts';
import {
	classifyObserverServerShape,
	externalValueLawOf,
	isObserverHostSection,
} from './external_laws/resolvers.ts';
import type { ExternalLaw, ExternalLawRefusalReason } from './external_laws/types.ts';
import {
	entryServerBlock,
	getSubscriptionRegistry,
	type ObserverSubscription,
	type SubscriptionIndex,
} from './observer_subscriptions.ts';
import { type ExternalRecomputeOutcome, recomputeExternalRelation } from './observers.ts';

export type { ExternalRecomputeOutcome } from './observers.ts';

const SYSTEM_USER_ID = -1;

/**
 * Classifier refusals that are NOT a refused tuple: the node defines no law
 * at all (no node, no source object, law (c) without its component_to_search).
 * The kernel answers them with its historical plain counted skip, and the
 * reconciler never surfaced them as tuples either — they stay unswept and
 * unreported here exactly as before the law registry.
 */
const LAWLESS_REASONS: ReadonlySet<ExternalLawRefusalReason> = new Set<ExternalLawRefusalReason>([
	'node_missing',
	'source_not_object',
	'component_to_search_missing',
]);

/** One discovered (observed → observer @ section) tuple, before host adjudication. */
export interface ReconcileTupleSeed {
	observedTipo: string;
	observerTipo: string;
	hostSection: string;
	/**
	 * The observer's law, from THE classifier (external_laws/classify.ts —
	 * the one the kernel, the dispatch and the refresh door read). A refused
	 * law (ambiguous / malformed node) surfaces the tuple as REFUSED, never
	 * swept: sweeping would print one kernel refusal per candidate and then
	 * report the tuple CLEAN — the false-clean that hides a broken node.
	 */
	law: ExternalLaw;
}

export interface ReconcileTuple extends ReconcileTupleSeed {
	/**
	 * Does `hostSection` DECLARE the observer (isObserverHostSection — the one
	 * census the kernel's host precondition reads)? A non-host tuple (an index
	 * fan-out face that does not declare the observer) is NEVER swept: the
	 * kernel's host precondition is strict (owner ruling 2026-10-30), so every
	 * record there — stored slot or not — is a counted no-op. The sweep only
	 * COUNTS the slots already stored there (`notHostSlots`) and says so.
	 */
	host: boolean;
}

export interface ReconcileOptions {
	/** false (default) = dry run: diff + report only. */
	apply?: boolean;
	onlyObserver?: string | null;
	onlySection?: string | null;
	onlyId?: number | null;
	/** Per-record / per-tuple report lines (CLI prints, the updater logs). */
	log?: (line: string) => void;
	/** Structured per-drifted-record callback — the CENSUS channel (`--json`).
	 * Fires for every drifted record, refusals included, so a drop budget can
	 * be adjudicated by cause instead of by a single total. */
	onRecord?: (record: ReconcileRecord) => void;
}

/** One drifted record, as the census reports it. */
export interface ReconcileRecord {
	observerTipo: string;
	hostSection: string;
	sectionId: number;
	/** Stored entry count before. */
	before: number;
	/** Entry count the FULL law wants (see recomputeExternalRelation's contract). */
	after: number;
	/** Entries the law drops (0 when the record only grows). */
	dropped: number;
	/** Entries the law appends. */
	added: number;
	/** Set when the drop half was withheld — the seed was degraded. */
	seedDefects?: string[];
	/** Which kernel refusal fired, if any. */
	refusal?: 'degraded_seed' | 'big_result';
}

export interface ReconcileSummary {
	tuples: number;
	candidates: number;
	drifted: number;
	repaired: number;
	shrinksSkipped: number;
	/**
	 * Tuples refused wholesale: the classifier refuses the observer's law
	 * (see ReconcileTupleSeed.law). The name predates the law registry (it
	 * counted the then-unported PHP sub-laws); kept because the update
	 * engine's report and run journal read it under this key.
	 */
	sublawRefused: number;
	/** Records whose persist hit the PHP >2000-reference freeze (computed, not written). */
	bigResultRefused: number;
	/** Records the law wants to shrink (drop volume's denominator). */
	droppedRecords: number;
	/** Total locators the law wants to drop across every drifted record. */
	droppedLocators: number;
	/** Records whose drop half was withheld because their seed was degraded. */
	degradedSeedRecords: number;
	/**
	 * Records whose `_hi` ancestor index disagreed with the value AS STORED (a
	 * mirror written before CORE-2: value, no index), where the sweep leaves that
	 * value in place: a value that agrees with the law (NOT in `drifted` — the
	 * value is right), or one the kernel refused or withheld (the >2000 freeze,
	 * a pure degraded-seed shrink — ALSO in `drifted`: two findings, the value
	 * and the index). Dry run = would be re-indexed, apply = re-indexed
	 * (recomputeExternalRelation indexDrift).
	 */
	reindexed: number;
	/**
	 * Observer slots STORED on records of a non-host face (a section that does
	 * not declare the observer), left untouched — the kernel's strict host
	 * precondition never computes there. Reported, never swept: not in
	 * `candidates` nor `drifted`.
	 */
	notHostSlots: number;
}

/**
 * The corpus drop budget: a dry run over the whole install must not want to
 * delete more than this. It exists so "we ran a dry run once and eyeballed it"
 * becomes a re-runnable pre-deploy check — any future change to the value law
 * that would mass-delete fails LOUDLY here instead of at the next save.
 *
 * Measured baseline 2026-08-06 (before the grow-only fail-safe was retired):
 * 22 records / 1,673 locators, every drop verified genuine (the referencing
 * records still exist but no longer point at the target).
 */
export interface ShrinkBudget {
	maxDroppedLocators: number;
	maxDroppedRecords: number;
}

/**
 * PURE budget predicate — returns the reasons the census busts its budget
 * (empty = within budget). Separated from the sweep so it is gate-testable
 * without a DB.
 */
export function exceedsShrinkBudget(summary: ReconcileSummary, budget: ShrinkBudget): string[] {
	const reasons: string[] = [];
	if (summary.droppedLocators > budget.maxDroppedLocators) {
		reasons.push(
			`droppedLocators ${summary.droppedLocators} > budget ${budget.maxDroppedLocators}`,
		);
	}
	if (summary.droppedRecords > budget.maxDroppedRecords) {
		reasons.push(`droppedRecords ${summary.droppedRecords} > budget ${budget.maxDroppedRecords}`);
	}
	// A degraded seed is never "within budget": it means the ontology is broken
	// in a way that makes the value law unanswerable for that record.
	if (summary.degradedSeedRecords > 0) {
		reasons.push(
			`${summary.degradedSeedRecords} record(s) have a DEGRADED SEED — fix the peer ontology node(s) first`,
		);
	}
	return reasons;
}

/**
 * Every side effect the sweep needs, as ONE injectable seam. The default is
 * `defaultReconcileIO` (the real implementations), so today's callers are
 * unchanged; the gates pass stubs so the classifier and the discovery halves
 * are exercisable without a DB or an ontology.
 */
export interface ReconcileIO {
	getRegistry(): Promise<SubscriptionIndex>;
	getNodeProperties(tipo: string): Promise<Record<string, unknown> | null>;
	indexSectionsFor(componentToSearch: string): Promise<string[]>;
	/** Every section that declares the observer (the copy laws' tuple sections). */
	hostSectionsFor(observerTipo: string): Promise<string[]>;
	/** The kernel's host predicate (isObserverHostSection). */
	isHostSection(observerTipo: string, sectionTipo: string): Promise<boolean>;
	matrixTableFor(sectionTipo: string): Promise<string | null>;
	candidateIds(tuple: ReconcileTuple, hostTable: string, onlyId: number | null): Promise<number[]>;
	recompute(
		observerTipo: string,
		hostSection: string,
		id: number,
		userId: number,
		at: Date,
		opts: { write: boolean; repairIndex: true },
	): Promise<ExternalRecomputeOutcome>;
}

/**
 * The EDGE half of the covered predicate (external_laws/resolvers.ts
 * isCoveredExternalObserverNode): a set_dato_external server block whose
 * shape the resolver table can run (classifyObserverServerShape — the same
 * table the live dispatch reads, so the reconciler heals exactly what the
 * cascade fires). The NODE half — the observer classifies as a stored law —
 * is the selector's (selectReconcileTuples). Law-derived registry edges
 * (origin 'law', `use_inverse_relations`) qualify by construction. Anything
 * else is the cascade's ledgered-skip territory, not silently swept here.
 * Shared by the tuple selector and the source pre-resolution below so the
 * two can never diverge.
 */
export function isCoveredReconcileEdge(sub: ObserverSubscription): boolean {
	const server = entryServerBlock(sub.entry);
	if (server === undefined) return false;
	return !('refused' in classifyObserverServerShape(server));
}

/**
 * PURE tuple selection: every (observed → observer @ host-section) edge with
 * the covered server shape, deduped on `observerTipo|hostSection` (first edge
 * wins). `observerSource` yields the observer node's `properties.source`; the
 * law is classified from it by THE classifier (resolveExternalLaw — pure).
 * A law-less node (LAWLESS_REASONS) yields no tuple; any other refusal yields
 * a tuple carrying the refused law, reported and never swept.
 *
 * Unresolved hosts are RETURNED, never dropped silently (never-narrow law,
 * review 2026-08-02): a covered edge with an unresolved host still DISPATCHES
 * live (its targets come from the observable data), so a silent skip here
 * would let its mirrors drift unhealed with no signal. The caller logs them
 * loudly and counts them.
 */
export function selectReconcileTuples(
	edges: readonly ObserverSubscription[],
	observerSource: (observerTipo: string) => unknown,
	onlyObserver: string | null,
): { tuples: ReconcileTupleSeed[]; hostUnresolved: string[] } {
	const tuples: ReconcileTupleSeed[] = [];
	const hostUnresolved: string[] = [];
	const seen = new Set<string>();
	for (const sub of edges) {
		if (!isCoveredReconcileEdge(sub)) continue;
		const observerTipo = sub.observerTipo;
		// Host section from the registry's 4-step resolution (observe-entry
		// scope → forward spec → the observer's own section) — same requirement
		// as ever: no host, no tuple.
		const hostSection = sub.hostSection;
		if (typeof hostSection !== 'string') {
			hostUnresolved.push(`${sub.observedTipo}->${observerTipo}`);
			continue;
		}
		if (onlyObserver !== null && observerTipo !== onlyObserver) continue;
		const key = `${observerTipo}|${hostSection}`;
		if (seen.has(key)) continue;
		const law = resolveExternalLaw({
			tipo: observerTipo,
			properties: { source: observerSource(observerTipo) },
		});
		if (law.kind === 'refused' && LAWLESS_REASONS.has(law.reason)) continue;
		seen.add(key);
		tuples.push({ observedTipo: sub.observedTipo, observerTipo, hostSection, law });
	}
	return { tuples, hostUnresolved };
}

/**
 * The live cascade recomputes at WHATEVER section a saved locator targets
 * (spec.section_tipo is informational) — so host sections must come from the
 * INDEX TRUTH too, not the spec list alone (review 2026-07-24: rsc387 targets
 * ~20 sections on this DB, the specs name 3; spec-only discovery left the rest
 * permanently stale). Union in every target section the index knows for each
 * tuple's component_to_search.
 *
 * This union is ALSO the intended backstop for virtual↔real section faces
 * (review 2026-08-02): a host resolved via the observer's OWN section is the
 * REAL face, while stored records may carry the VIRTUAL face
 * (numisdata148->numisdata322: host numisdata276, yet its targets are stored
 * under numisdata5, so the seeded tuple's queries find nothing). The index
 * rows carry the faces the records actually use, so the fan-out seeds tuples
 * at the STORED faces. No face normalization is done here on purpose — it
 * would duplicate what the index truth already supplies.
 *
 * The index ALSO names faces that do not declare the observer at all (R3
 * census 2026-10-30: hierarchy93 ← rsc387 reaches numisdata6/numisdata3/tchi1,
 * numisdata321 ← numisdata282 reaches tchi1). Those tuples are kept — a
 * PHP-era slot stored there is still converged by the kernel — but they are
 * adjudicated non-host (ReconcileTuple.host) and visit stored holders only.
 *
 * Law (c) only: its tuple sections ARE "where the referenced records live".
 * The copy laws' are the sections that declare the observer
 * (expandTuplesByHostSections). Refused tuples are reported once per spec
 * host — no fan-out (their candidates are never swept anyway).
 *
 * Returns the input tuples FOLLOWED BY the fan-out (only the input list is
 * expanded — an index-seeded tuple is never re-expanded).
 */
export async function expandTuplesByIndexSections<T extends ReconcileTupleSeed>(
	tuples: readonly T[],
	indexSectionsFor: (componentToSearch: string) => Promise<string[]>,
): Promise<T[]> {
	const out = [...tuples];
	const seen = new Set<string>(out.map((t) => `${t.observerTipo}|${t.hostSection}`));
	for (const tuple of [...tuples]) {
		if (tuple.law.kind !== 'inverse_search') continue;
		const indexSections = await indexSectionsFor(tuple.law.componentToSearch);
		for (const section of indexSections) {
			const key = `${tuple.observerTipo}|${section}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ ...tuple, hostSection: section });
		}
	}
	return out;
}

/**
 * The copy laws' (source_overwrite, observed_data) tuple sections: every
 * section that DECLARES the observer (`hostSectionsFor` — the one census the
 * kernel's host precondition reads). Their records are the term/coin records
 * themselves, stored under whatever face declares the observer — typically
 * VIRTUAL faces of the observer's own section (terms under three virtual
 * catalog sections of one real one), which neither the registry's host
 * (the observer's own, real section) nor the index (keyed by what a record
 * POINTS AT, not where it lives) names. Same append/dedup shape as the index
 * fan-out.
 */
export async function expandTuplesByHostSections<T extends ReconcileTupleSeed>(
	tuples: readonly T[],
	hostSectionsFor: (observerTipo: string) => Promise<string[]>,
): Promise<T[]> {
	const out = [...tuples];
	const seen = new Set<string>(out.map((t) => `${t.observerTipo}|${t.hostSection}`));
	for (const tuple of [...tuples]) {
		if (tuple.law.kind !== 'source_overwrite' && tuple.law.kind !== 'observed_data') continue;
		for (const section of await hostSectionsFor(tuple.observerTipo)) {
			const key = `${tuple.observerTipo}|${section}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ ...tuple, hostSection: section });
		}
	}
	return out;
}

/** Per-record counter deltas the classifier hands back to the sweep. */
export interface ReconcileCounts {
	droppedRecords: number;
	droppedLocators: number;
	degradedSeedRecords: number;
	bigResultRefused: number;
	shrinksSkipped: number;
	repaired: number;
	/** 1 when the outcome is an index-only drift (see ReconcileSummary.reindexed). */
	reindexed: number;
}

/**
 * PURE per-candidate adjudication: given ONE kernel outcome, what the census
 * records, which counters move and which report line is printed.
 *
 * Census: drop volume comes from the kernel's MEMBERSHIP counts, never from
 * `before - after`. A value-law regression that drops N genuine locators and
 * appends N wrong ones has an equal length — a length delta reports 0 and
 * sails through the budget, which is precisely the shape the budget exists to
 * catch. The kernel adjudicates membership (that is why a 1-drop+1-add swap
 * commits both halves), so the census must read the same numbers it did.
 */
export function classifyReconcileOutcome(
	outcome: ExternalRecomputeOutcome,
	tuple: ReconcileTupleLabel,
	sectionId: number,
	apply: boolean,
): {
	drifted: boolean;
	record: ReconcileRecord | null;
	counted: ReconcileCounts;
	log: string | null;
} {
	const counted = emptyReconcileCounts();
	if (!outcome.changed) return classifyAgreeingValue(outcome, tuple, sectionId, apply, counted);
	const { dropped, added } = countDrift(outcome, counted);
	return {
		drifted: true,
		record: reconcileRecordOf(outcome, tuple, sectionId, dropped, added),
		counted,
		log: driftLog(outcome, tuple, sectionId, apply, counted),
	};
}

type ReconcileClassification = ReturnType<typeof classifyReconcileOutcome>;

/** What the adjudication reads of a tuple: its label only. */
type ReconcileTupleLabel = Pick<ReconcileTuple, 'observerTipo' | 'hostSection'>;

function emptyReconcileCounts(): ReconcileCounts {
	return {
		droppedRecords: 0,
		droppedLocators: 0,
		degradedSeedRecords: 0,
		bigResultRefused: 0,
		shrinksSkipped: 0,
		repaired: 0,
		reindexed: 0,
	};
}

/** An unchanged value: clean, or an index-only drift (its `_hi` ancestor index missing or stale). */
function classifyAgreeingValue(
	outcome: ExternalRecomputeOutcome,
	tuple: ReconcileTupleLabel,
	sectionId: number,
	apply: boolean,
	counted: ReconcileCounts,
): ReconcileClassification {
	const refusedLine = kernelPrecomputeRefusalLine(outcome, tuple, sectionId);
	if (refusedLine !== null) return { drifted: false, record: null, counted, log: refusedLine };
	if (outcome.indexDrift !== true) return { drifted: false, record: null, counted, log: null };
	counted.reindexed = 1;
	return {
		drifted: false,
		record: null,
		counted,
		log: `  ${tuple.hostSection} §${sectionId} ${tuple.observerTipo}: value agrees, _hi ancestor index ${apply ? 'rewritten' : 'disagrees — an apply would rewrite it'}`,
	};
}

/**
 * A pre-compute kernel refusal on ONE candidate (the tuple was adjudicated
 * sweepable, so the ontology moved under the run, or a host verdict raced):
 * nothing was computed, so it is neither clean nor drifted — say so, never
 * fold it into a silent "agrees". The kernel already counted it.
 */
function kernelPrecomputeRefusalLine(
	outcome: ExternalRecomputeOutcome,
	tuple: ReconcileTupleLabel,
	sectionId: number,
): string | null {
	const at = `  ${tuple.hostSection} §${sectionId} ${tuple.observerTipo}`;
	if (outcome.refusedLaw !== undefined) {
		return `${at}: REFUSED — external value law refused (${outcome.refusedLaw.reason}); not computed`;
	}
	if (outcome.targetNotHost === true) {
		return `${at}: SKIP — the section does not declare the observer (kernel no-op; a host verdict raced the sweep)`;
	}
	return null;
}

/**
 * The census of a drifted value (see the classifier's header: MEMBERSHIP
 * counts, a length delta only when the kernel gave none). A value the kernel
 * refused or withheld (the freeze, a pure degraded-seed shrink) stays as
 * stored — and its `_hi` index is swept all the same.
 */
function countDrift(
	outcome: ExternalRecomputeOutcome,
	counted: ReconcileCounts,
): { dropped: number; added: number } {
	if (outcome.indexDrift === true) counted.reindexed = 1;
	const dropped = outcome.dropped ?? Math.max(0, outcome.before - outcome.after);
	const added = outcome.added ?? Math.max(0, outcome.after - outcome.before);
	if (dropped > 0) {
		counted.droppedRecords++;
		counted.droppedLocators += dropped;
	}
	if (outcome.seedDefects !== undefined) counted.degradedSeedRecords++;
	return { dropped, added };
}

function reconcileRecordOf(
	outcome: ExternalRecomputeOutcome,
	tuple: ReconcileTupleLabel,
	sectionId: number,
	dropped: number,
	added: number,
): ReconcileRecord {
	return {
		observerTipo: tuple.observerTipo,
		hostSection: tuple.hostSection,
		sectionId,
		before: outcome.before,
		after: outcome.after,
		dropped,
		added,
		...(outcome.seedDefects !== undefined ? { seedDefects: outcome.seedDefects } : {}),
		...kernelRefusal(outcome),
	};
}

/** Which kernel refusal fired: the >2000-reference freeze wins over a degraded seed. */
function kernelRefusal(outcome: ExternalRecomputeOutcome): Pick<ReconcileRecord, 'refusal'> {
	if (outcome.refusedBigResult === true) return { refusal: 'big_result' };
	if (outcome.skippedShrink === true) return { refusal: 'degraded_seed' };
	return {};
}

/** The report line of a drifted value; moves the refusal / repaired counters. */
function driftLog(
	outcome: ExternalRecomputeOutcome,
	tuple: ReconcileTupleLabel,
	sectionId: number,
	apply: boolean,
	counted: ReconcileCounts,
): string {
	const head = `  ${tuple.hostSection} §${sectionId} ${tuple.observerTipo}: ${outcome.before} → ${outcome.after} entrie(s)`;
	if (outcome.refusedBigResult === true) {
		// PHP >2000-reference freeze: the kernel computed the diff but
		// persisted nothing — never count it as repaired (a refused record
		// reported clean is the sub-law lesson all over again).
		counted.bigResultRefused++;
		return `${head} [>2000-reference FREEZE — ${apply ? 'not written' : 'an apply would refuse'}${reindexNote(outcome, apply)}]`;
	}
	if (outcome.skippedShrink === true) {
		// DEGRADED SEED — the only remaining shrink escape. Additions HAVE
		// been applied (in apply mode); the drop half is withheld because
		// this record's seed could not be built completely. Not fixable by
		// a flag: fix the ontology the defects name, then re-run.
		counted.shrinksSkipped++;
		return `${head} [SHRINK held — DEGRADED SEED: ${(outcome.seedDefects ?? []).join(', ')}; grows applied${reindexNote(outcome, apply)}]`;
	}
	return cleanDriftLog(head, outcome, apply, counted);
}

/** A drift the kernel wrote (apply) or would write (dry run). */
function cleanDriftLog(
	head: string,
	outcome: ExternalRecomputeOutcome,
	apply: boolean,
	counted: ReconcileCounts,
): string {
	if (apply) counted.repaired++;
	return `${head}${outcome.after < outcome.before ? ' [shrink]' : ''}${apply ? ' [repaired]' : ''}`;
}

/** The `_hi` note a refused/withheld value carries (its index is swept all the same). */
function reindexNote(outcome: ExternalRecomputeOutcome, apply: boolean): string {
	if (outcome.indexDrift !== true) return '';
	return `; _hi ancestor index ${apply ? 'rewritten' : 'disagrees — an apply would rewrite it'}`;
}

/**
 * Every (observed → observer @ host-section) tuple with the covered server
 * shape. Since Act 2 the edges come from the SUBSCRIPTION REGISTRY (the same
 * discovery the live cascade dispatches from — this used to be a third
 * hand-rolled copy of forward-only discovery): the reconciler heals exactly
 * what the cascade fires — every declared server edge, the ontology's
 * decision (reverse-only declarations included).
 *
 * Orchestration only: selection, the index fan-out and the --section filter
 * are the three pure functions above; the loud+counted unresolved-host signal
 * and the IO live here.
 */
async function discoverTuples(
	onlyObserver: string | null,
	onlySection: string | null,
	io: ReconcileIO,
): Promise<ReconcileTuple[]> {
	const registry = await io.getRegistry();
	const sourceByTipo = await coveredObserverSources(registry.edges, io);
	const { tuples, hostUnresolved } = selectReconcileTuples(
		registry.edges,
		(observerTipo) => sourceByTipo.get(observerTipo),
		onlyObserver,
	);
	// Loud + counted (the dispatch-side SQO refusal's counter); nothing hits
	// this on either current ontology — every covered edge resolves.
	for (const edgeKey of hostUnresolved) {
		console.error(
			`observer reconcile: covered edge '${edgeKey}' has an UNRESOLVED host section — tuple skipped, mirrors NOT swept; add a section scope (section_tipo) to the observe entry`,
		);
		incrementCounter('observers_host_section_unresolved');
	}
	const byIndex = await expandTuplesByIndexSections(tuples, (componentToSearch) =>
		io.indexSectionsFor(componentToSearch),
	);
	const expanded = await expandTuplesByHostSections(byIndex, (observerTipo) =>
		io.hostSectionsFor(observerTipo),
	);
	// --section filters LAST: a spec-listed section must still seed the union
	// (filtering inside the loops starved it — a --section tchi1 run found 0
	// tuples although tchi1 drift exists through the index truth). The match
	// is the tuple's host face VERBATIM (no virtual↔real normalization): pass
	// the face the stored records carry (e.g. numisdata5, not numisdata276).
	const scoped =
		onlySection === null ? expanded : expanded.filter((t) => t.hostSection === onlySection);
	const adjudicated: ReconcileTuple[] = [];
	for (const tuple of scoped) {
		adjudicated.push({
			...tuple,
			host: await io.isHostSection(tuple.observerTipo, tuple.hostSection),
		});
	}
	return adjudicated;
}

/**
 * Each covered observer's `properties.source`, resolved up front: the pure
 * selector reads them synchronously. getNode is a cached, side-effect free
 * ontology read (the registry build already materialised these nodes).
 */
async function coveredObserverSources(
	edges: readonly ObserverSubscription[],
	io: ReconcileIO,
): Promise<Map<string, unknown>> {
	const sourceByTipo = new Map<string, unknown>();
	for (const sub of edges) {
		if (!isCoveredReconcileEdge(sub)) continue;
		if (sourceByTipo.has(sub.observerTipo)) continue;
		const properties = await io.getNodeProperties(sub.observerTipo);
		sourceByTipo.set(sub.observerTipo, (properties as { source?: unknown } | null)?.source);
	}
	return sourceByTipo;
}

/**
 * One tuple's candidate records. A host tuple asks its LAW
 * (ExternalValueLaw.candidateIds — law (c): referenced targets ∪ holders; the
 * copy laws: records carrying their pointer/ddo ∪ holders). A non-host tuple
 * answers the stored holders — COUNTED by the sweep, never recomputed (see
 * ReconcileTuple.host). Never called for
 * a refused tuple.
 */
async function candidateIds(
	tuple: ReconcileTuple,
	hostTable: string,
	onlyId: number | null,
): Promise<number[]> {
	const law = tuple.law;
	if (!isStoredExternalLaw(law)) return [];
	if (tuple.host) {
		return externalValueLawOf(law).candidateIds(
			law,
			{ observerTipo: tuple.observerTipo, hostSection: tuple.hostSection },
			hostTable,
			onlyId,
		);
	}
	const holders = (await sql.unsafe(
		`SELECT section_id AS id FROM "${hostTable}" WHERE section_tipo = $1 AND relation ? $2`,
		[tuple.hostSection, tuple.observerTipo],
	)) as { id: number }[];
	const ids = new Set(holders.map((row) => Number(row.id)));
	if (onlyId !== null) return ids.has(onlyId) ? [onlyId] : [];
	return [...ids].sort((a, b) => a - b);
}

/** Every census section that declares `observerTipo` (see expandTuplesByHostSections). */
async function hostSectionsFor(observerTipo: string): Promise<string[]> {
	const sections: string[] = [];
	for (const section of await listSectionNodes()) {
		if (await isObserverHostSection(observerTipo, section.tipo)) sections.push(section.tipo);
	}
	return sections;
}

/** The real side-effect set — what every production caller gets. */
export const defaultReconcileIO: ReconcileIO = {
	getRegistry: getSubscriptionRegistry,
	async getNodeProperties(tipo: string): Promise<Record<string, unknown> | null> {
		const node = await getNode(tipo);
		return (node?.properties as Record<string, unknown> | undefined) ?? null;
	},
	async indexSectionsFor(componentToSearch: string): Promise<string[]> {
		const rows = (await sql.unsafe(
			'SELECT DISTINCT target_section_tipo AS s FROM matrix_relation_index WHERE from_component_tipo = $1',
			[componentToSearch],
		)) as { s: string }[];
		return rows.map((row) => row.s);
	},
	hostSectionsFor,
	isHostSection: isObserverHostSection,
	matrixTableFor: (sectionTipo: string) => getMatrixTableFromTipo(sectionTipo),
	candidateIds,
	recompute: recomputeExternalRelation,
};

export async function reconcileObserverMirrors(
	options: ReconcileOptions = {},
	io: ReconcileIO = defaultReconcileIO,
): Promise<ReconcileSummary> {
	const apply = options.apply === true;
	const log = options.log ?? ((): void => {});
	const onRecord = options.onRecord ?? ((): void => {});
	const summary: ReconcileSummary = {
		tuples: 0,
		candidates: 0,
		drifted: 0,
		repaired: 0,
		shrinksSkipped: 0,
		sublawRefused: 0,
		bigResultRefused: 0,
		droppedRecords: 0,
		droppedLocators: 0,
		degradedSeedRecords: 0,
		reindexed: 0,
		notHostSlots: 0,
	};
	const tuples = await discoverTuples(
		options.onlyObserver ?? null,
		options.onlySection ?? null,
		io,
	);
	summary.tuples = tuples.length;
	for (const tuple of tuples) {
		if (tuple.law.kind === 'refused') {
			// Honest reporting of a node the classifier refuses (ambiguous or
			// malformed law): one REFUSED line + a summary count — never "0
			// drifted" for a tuple whose law is not even runnable.
			summary.sublawRefused++;
			log(
				`- ${tuple.observerTipo} @ ${tuple.hostSection} (← ${tuple.observedTipo}): REFUSED — external value law refused (${tuple.law.reason}): ${tuple.law.detail}; candidates not swept, stored mirrors left as-is`,
			);
			continue;
		}
		const hostTable = await io.matrixTableFor(tuple.hostSection);
		if (hostTable === null) {
			log(
				`- ${tuple.observerTipo} @ ${tuple.hostSection}: SKIP (no matrix table — section not provisioned)`,
			);
			continue;
		}
		const ids = await io.candidateIds(tuple, hostTable, options.onlyId ?? null);
		if (!tuple.host) {
			// STRICT host precondition: the kernel never computes on a face that
			// does not declare the observer, stored slot or not. Count the stored
			// slots (candidateIds' non-host branch answers the holders) and say
			// they stay as they are — never a recompute per holder only to print
			// one kernel no-op each.
			summary.notHostSlots += ids.length;
			log(
				`- ${tuple.observerTipo} @ ${tuple.hostSection} (← ${tuple.observedTipo}) [not a host]: ${ids.length} stored slot(s) left untouched (the section does not declare the observer; never computed)`,
			);
			continue;
		}
		summary.candidates += ids.length;
		let drifted = 0;
		let shrinksSkipped = 0;
		for (const id of ids) {
			// ONE call per candidate: in apply mode the adjudication happens
			// INSIDE the row lock — no diff-then-apply TOCTOU window. The kernel
			// applies the FULL law (2026-08-06); the only drop it withholds is one
			// whose seed it knows was degraded.
			const outcome = await io.recompute(
				tuple.observerTipo,
				tuple.hostSection,
				id,
				SYSTEM_USER_ID,
				new Date(),
				// The legacy `_hi` index sweep is the reconcile's (see the kernel's
				// repairIndex): the interactive cascade never pays the chain walk.
				{ write: apply, repairIndex: true },
			);
			const verdict = classifyReconcileOutcome(outcome, tuple, id, apply);
			summary.reindexed += verdict.counted.reindexed;
			if (!verdict.drifted) {
				if (verdict.log !== null) log(verdict.log);
				continue;
			}
			drifted++;
			summary.droppedRecords += verdict.counted.droppedRecords;
			summary.droppedLocators += verdict.counted.droppedLocators;
			summary.degradedSeedRecords += verdict.counted.degradedSeedRecords;
			summary.bigResultRefused += verdict.counted.bigResultRefused;
			summary.repaired += verdict.counted.repaired;
			shrinksSkipped += verdict.counted.shrinksSkipped;
			if (verdict.record !== null) onRecord(verdict.record);
			if (verdict.log !== null) log(verdict.log);
		}
		summary.drifted += drifted;
		summary.shrinksSkipped += shrinksSkipped;
		log(tupleLine(tuple, ids.length, drifted, shrinksSkipped, apply));
	}
	return summary;
}

/** The one per-tuple summary line of a sweep. */
function tupleLine(
	tuple: ReconcileTuple,
	candidates: number,
	drifted: number,
	shrinksSkipped: number,
	apply: boolean,
): string {
	return `- ${tuple.observerTipo} @ ${tuple.hostSection} (← ${tuple.observedTipo}): ${candidates} candidate(s), ${drifted} drifted${shrinksSkipped > 0 ? ` (${shrinksSkipped} shrink(s) skipped)` : ''}${apply ? ', repaired' : ''}`;
}

/**
 * The registry shape of this sweep (core/reconcile/registry.ts, S-10): drift =
 * records whose stored mirror disagrees with the full law, apply = the same
 * row-locked recompute with `write:true`. `scope` = host section tipos (the
 * `--section` narrowing of the CLI shell, scripts/observer_reconcile.ts).
 */
export const OBSERVER_MIRRORS_RECONCILE: ReconcileDefinition = {
	name: 'observer_mirrors',
	stores: [
		'matrix_relation_index (referencing records)',
		'observer mirror slots (set_dato_external)',
	],
	description:
		'Recompute every observer mirror from the records that reference it — heals mirrors left stale by writes that bypassed the save cascade (v6→v7 update, portalize, propagate).',
	scopeLabel: 'host section tipo',
	// A whole-corpus recompute; refused tuples (a law the classifier refuses) are reported, never swept.
	schedule: 'operator',
	// Shells: the CLI, and the data update's post-COMMIT heal (update/engine.ts
	// reconcileAfterCommit — it calls reconcileObserverMirrors with apply:true).
	sources: [
		'src/core/section/record/observer_reconcile.ts',
		'scripts/observer_reconcile.ts',
		'src/core/update/engine.ts',
	],
	async run({ apply, scope }) {
		const summary: ReconcileSummary = {
			tuples: 0,
			candidates: 0,
			drifted: 0,
			repaired: 0,
			shrinksSkipped: 0,
			sublawRefused: 0,
			bigResultRefused: 0,
			droppedRecords: 0,
			droppedLocators: 0,
			degradedSeedRecords: 0,
			reindexed: 0,
			notHostSlots: 0,
		};
		const records: ReconcileRecord[] = [];
		// One sweep per scoped section (the kernel narrows by ONE section), or one
		// unscoped sweep — summed field by field.
		for (const onlySection of scope === undefined ? [null] : scope) {
			const part = await reconcileObserverMirrors({
				apply,
				onlySection,
				onRecord: (record) => {
					records.push(record);
				},
			});
			for (const key of Object.keys(summary) as (keyof ReconcileSummary)[]) {
				summary[key] += part[key];
			}
		}
		// An index-only drift is drift the registry reports (and an apply repairs).
		return {
			drift: summary.drifted + summary.reindexed,
			applied: summary.repaired + (apply ? summary.reindexed : 0),
			detail: { ...summary, records },
		};
	},
};
