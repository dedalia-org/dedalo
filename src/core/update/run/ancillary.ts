/**
 * THE UPDATE RUN'S ANCILLARY PHASE (update audit 2026-10-29, U-30, design
 * §3 / §6 item 2.5): after code → ontology → schema → data, every DERIVED
 * surface the update may have invalidated is reconciled, in a DECLARED order —
 * ANCILLARY_RECONCILERS. The table is the census
 * (release_manifest_completeness_tripwire asserts its ids): a derived surface
 * the update can stale and no reconciler heals is a red gate, not a
 * remembered step.
 *
 *   tools             the dd1324 registry from each tools/<tool>/register.json
 *                     (tools/register.ts importTools), the admin's per-tool
 *                     ACTIVE choice PRESERVED (see reconcileTools)
 *   observer_mirrors  the set_dato_external mirrors (observer_reconcile.ts),
 *                     only when an ontology or data phase of this run finished
 *                     ok — the two phases that move observer definitions or
 *                     write records past the save chokepoint
 *   search_stores     the derived search stores: ensureSearchStores (missing
 *                     DDL, empty coverage pairs) THEN the derivation stamp
 *                     (db_assets.ts reconcileSearchStoreDerivation: a populated
 *                     store derived by an older declared filter is re-derived)
 *   media_rules       the generated web-server rule files (media/protection.ts
 *                     writeRuleFiles — rewritten when their config hash moved,
 *                     TEMPLATE_VERSION folded in)
 *
 * A reconciler that throws FAILS the phase: the run's note gets
 * `evidence.summary`, a sentence — the raw exception text goes to the server
 * log (journal.ts failureSentence), never into the journal the panel shows
 * (error_taxonomy A6, SEC-18). The first failure stops the table: the run is
 * leaving for its failure exit, and a later reconciler must not act on a
 * surface an earlier one left half-reconciled.
 */

import {
	type EnsureSearchStoresResult,
	ensureSearchStores,
	reconcileSearchStoreDerivation,
	type SearchStoreDerivationResult,
	type SearchStoreTable,
} from '../../db/db_assets.ts';
import { withUnboundedStatements } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getRulesStatus, writeRuleFiles } from '../../media/protection.ts';
import { clearSearchStoreCache } from '../../search/search_store.ts';
import {
	type ReconcileOptions,
	type ReconcileSummary,
	reconcileObserverMirrors,
} from '../../section/record/observer_reconcile.ts';
import { type ImportReportItem, importTools } from '../../tools/register.ts';
import type { PhaseResult } from './executor.ts';
import { failureSentence, type RunJournal } from './journal.ts';

/** Every side effect the reconcilers have — one injectable seam (the gates stub it). */
export interface AncillaryDeps {
	importTools: (options: {
		dryRun?: boolean;
		keepStoredActive?: boolean;
	}) => Promise<ImportReportItem[]>;
	reconcileObserverMirrors: (options: ReconcileOptions) => Promise<ReconcileSummary>;
	ensureSearchStores: () => Promise<EnsureSearchStoresResult>;
	reconcileSearchStoreDerivation: (
		fresh: readonly SearchStoreTable[],
	) => Promise<SearchStoreDerivationResult>;
	clearSearchStoreCache: () => void;
	writeRuleFiles: () => boolean;
	getRulesStatus: () => Record<string, { up_to_date: boolean | null }>;
}

const DEFAULT_DEPS: AncillaryDeps = {
	importTools,
	reconcileObserverMirrors: (options) => reconcileObserverMirrors(options),
	ensureSearchStores,
	reconcileSearchStoreDerivation,
	clearSearchStoreCache,
	writeRuleFiles: () => writeRuleFiles(),
	getRulesStatus,
};

/** What a reconciler sees: the run so far and the effects. */
export interface AncillaryContext {
	journal: RunJournal;
	deps: AncillaryDeps;
}

/** One named reconciler: its evidence, or a throw (= the phase fails). */
export interface AncillaryReconciler {
	id: string;
	run: (context: AncillaryContext) => Promise<Record<string, unknown>>;
}

/** A reconciler's own refusal: a vetted sentence (failureSentence passes it through). */
function refuse(sentence: string): never {
	throw new DedaloError('update.failed', { message: sentence, publicMessage: sentence });
}

/**
 * The tools registry from the release's register.json files, each registered
 * tool KEEPING the ACTIVE value an admin stored (register.ts keepStoredActive:
 * read under the row lock in the write's own transaction — a bare import would
 * re-enable every tool an admin turned off, and a two-pass read-then-write
 * would revert a toggle committed between the passes, review #25).
 */
async function reconcileTools({ deps }: AncillaryContext): Promise<Record<string, unknown>> {
	const report = await deps.importTools({ dryRun: false, keepStoredActive: true });
	// A declaration the engine refuses is reported (the tool stays unregistered,
	// as the panel shows it); a write that did not land is a registry the run
	// could not reconcile — the phase fails, as for a search store (#11).
	const unwritten = report.filter((item) => item.writeFailed === true).map((item) => item.name);
	if (unwritten.length > 0) {
		refuse(`the tools registry could not be written for ${unwritten.join(', ')} (see the log)`);
	}
	const invalid = report.filter((item) => !item.valid).map((item) => item.name);
	return {
		written: report.some((item) => item.valid && !item.dryRun),
		tools: report.length,
		invalid,
	};
}

/** The kinds whose ok completion can stale an observer mirror. */
const MIRROR_MOVING_KINDS: ReadonlySet<string> = new Set(['ontology', 'data']);

/** True when this run finished an ontology or data phase ok. */
export function runMovedMirrors(journal: RunJournal): boolean {
	return journal.phases.some(
		(phase) => phase.outcome === 'ok' && MIRROR_MOVING_KINDS.has(phase.step.kind),
	);
}

/**
 * The mirrors heal the way the update engine's post-COMMIT tail heals them
 * (engine.ts reconcileAfterCommit): the full law applied, under the unbounded
 * statement scope (a corpus sweep is not a request). Unlike that tail, a throw
 * here FAILS: the run claims reconciled surfaces, and a mirror it could not
 * reconcile is a claim it cannot make.
 */
async function reconcileMirrors({
	journal,
	deps,
}: AncillaryContext): Promise<Record<string, unknown>> {
	if (!runMovedMirrors(journal)) {
		return { skipped: 'no ontology or data phase of this run finished ok' };
	}
	const summary = await withUnboundedStatements(() =>
		deps.reconcileObserverMirrors({ apply: true }),
	);
	return {
		tuples: summary.tuples,
		drifted: summary.drifted,
		repaired: summary.repaired,
		shrinks_held: summary.shrinksSkipped,
		sublaw_refused: summary.sublawRefused,
		big_result_refused: summary.bigResultRefused,
	};
}

/**
 * ensureSearchStores first (DDL drift, empty coverage pairs), then the
 * derivation stamp over what ensure did NOT just refill. Errors are counted,
 * logged by their producers, and fail the phase: a store the run could not
 * reconcile is not a reconciled store.
 */
async function reconcileSearchStores(context: AncillaryContext): Promise<Record<string, unknown>> {
	// A first stamp re-derives every populated store (DELETE + INSERT…SELECT per
	// table): bulk maintenance work, so it runs on the maintenance pool without the
	// request ceiling — under the 60 s production statement timeout a large install
	// would fail the phase on every attempt (and roll back an update that is fine).
	return withUnboundedStatements(() => reconcileSearchStoresUnbounded(context));
}

async function reconcileSearchStoresUnbounded({
	deps,
}: AncillaryContext): Promise<Record<string, unknown>> {
	const ensured = await deps.ensureSearchStores();
	if (ensured.errors.length > 0) {
		console.error('[update run] search stores: ensure errors', ensured.errors);
		refuse(`search stores could not be ensured (${ensured.errors.length} error(s), see the log)`);
	}
	const derivation = await deps.reconcileSearchStoreDerivation(ensured.backfilledTables);
	if (!ensured.healthy || derivation.rederived.length > 0) deps.clearSearchStoreCache();
	if (derivation.errors > 0) {
		refuse(`search stores could not be re-derived (${derivation.errors} error(s), see the log)`);
	}
	return {
		ddl_applied: ensured.ddlApplied,
		backfilled_tables: ensured.backfilledTables.length,
		rederived: derivation.rederived,
		stamped: derivation.stamped,
	};
}

/**
 * writeRuleFiles rewrites only the artifacts whose embedded config hash moved,
 * so the files stale BEFORE the call are the ones it rewrote. `written: false`
 * = the media tree is unreachable (writeRuleFiles logs why) — not the update's
 * failure: nothing is served out of an absent tree. A write failure throws.
 * The test-media guard rides mediaRoot() inside both calls.
 */
async function reconcileMediaRules({ deps }: AncillaryContext): Promise<Record<string, unknown>> {
	const before = deps.getRulesStatus();
	const stale = Object.keys(before).filter((name) => before[name]?.up_to_date === false);
	const written = deps.writeRuleFiles();
	return { written, rewritten: written ? stale : [] };
}

/** THE CENSUS, in order (the tripwire pins the ids — see the header). */
export const ANCILLARY_RECONCILERS: readonly AncillaryReconciler[] = [
	{ id: 'tools', run: reconcileTools },
	{ id: 'observer_mirrors', run: reconcileMirrors },
	{ id: 'search_stores', run: reconcileSearchStores },
	{ id: 'media_rules', run: reconcileMediaRules },
];

/** Run one reconciler: its evidence, or the failure sentence (raw text → the log). */
async function runReconciler(
	reconciler: AncillaryReconciler,
	context: AncillaryContext,
): Promise<{ evidence: Record<string, unknown> } | { failure: string }> {
	try {
		return { evidence: await reconciler.run(context) };
	} catch (error) {
		return { failure: failureSentence(`ancillary reconciler ${reconciler.id}`, error) };
	}
}

/**
 * The ancillary phase: every reconciler of the table, in order. `reconcilers`
 * is the table by default — the parameter exists so the completeness tripwire
 * can plant a throwing one (anti-vacuity), never for production to narrow it.
 */
export async function runAncillaryPhase(
	journal: RunJournal,
	deps: Partial<AncillaryDeps> = {},
	reconcilers: readonly AncillaryReconciler[] = ANCILLARY_RECONCILERS,
): Promise<PhaseResult> {
	const context: AncillaryContext = { journal, deps: { ...DEFAULT_DEPS, ...deps } };
	const done: Record<string, unknown> = {};
	for (const reconciler of reconcilers) {
		const outcome = await runReconciler(reconciler, context);
		if ('failure' in outcome) {
			const summary = `ancillary reconciler ${reconciler.id} failed: ${outcome.failure}`;
			return { outcome: 'failed', evidence: { reconcilers: done, failed: reconciler.id, summary } };
		}
		done[reconciler.id] = outcome.evidence;
	}
	return { outcome: 'ok', evidence: { reconcilers: done, order: reconcilers.map((r) => r.id) } };
}
