/**
 * ============================================================================
 * OBSERVER MIRROR RECONCILE SWEEP — CLI shell over
 * core/section/record/observer_reconcile.ts (the shared kernel; the v6→v7
 * data-update pipeline runs the same kernel automatically in its success
 * tail — update/engine.ts).
 * ============================================================================
 *
 * Observer mirrors (the hierarchy93 ← rsc387 family: a term record's
 * "who references me" slot, kept SEARCHABLE by persisting it) are maintained
 * by the save-chokepoint observer cascade. Writes that bypass every cascade
 * door leave them stale: v6→v7 migrated/updated data (the reported case —
 * dc1 §2 had 3 rsc387 referencers and a NULL hierarchy93 mirror, zero TM
 * rows) and portalize — plus any door that states at its own site that it
 * does not propagate (observers.ts module header).
 *
 * The kernel replays the ONE recompute law (recomputeExternalRelation —
 * row-locked, order-preserved keep, next-id append, TM audit pair) per
 * candidate. Which law runs, and which records are candidates, is the law
 * registry's (core/section/record/external_laws/): law (c) visits referenced
 * targets from matrix_relation_index (trigger truth) ∪ stored-mirror holders,
 * at sections from spec ∪ index truth; the copy laws (source_overwrite,
 * set_observed_data) visit records carrying their pointer / ddo ∪ holders, at
 * every section that DECLARES the observer. A section that does not declare
 * the observer (an index face) is never swept — the kernel's host
 * precondition is strict; its stored slots are counted and reported
 * `[not a host]: N stored slot(s) left untouched`.
 *
 * USAGE (dry-run is the default and prints every drifted record):
 *
 *     bun scripts/observer_reconcile.ts
 *     bun scripts/observer_reconcile.ts --observer hierarchy93 --section dc1
 *     bun scripts/observer_reconcile.ts --id 2 --section dc1
 *     bun scripts/observer_reconcile.ts --apply
 *     bun scripts/observer_reconcile.ts --json > census.json
 *     bun scripts/observer_reconcile.ts --budget            # non-zero exit if busted
 *
 * SINCE 2026-08-06 THE SWEEP APPLIES THE FULL LAW, drops included. The
 * grow-only fail-safe (and its `--allow-shrink` opt-in) is GONE: its premise
 * — that the computed set was known too small — expired when the D3 closure
 * landed, and a mirror that can only grow is not a mirror. The one remaining
 * shrink escape is derived by the kernel: a record whose SEED was degraded
 * (missing peer ontology node, malformed peer locator) keeps its drops and
 * says so. Fix the ontology it names, then re-run.
 *
 * THE CENSUS. `--json` emits one line per drifted record
 * {observerTipo, hostSection, sectionId, before, after, dropped, added,
 * seedDefects?, refusal?} so drop volume can be audited BY CAUSE. `--budget`
 * adjudicates the run against engineering/observer_shrink_budget.json and
 * exits non-zero when the corpus wants to delete more than the declared
 * ceiling — a re-runnable pre-deploy check, so a future value-law change that
 * would mass-delete fails here rather than at the next save.
 *
 * REFUSED LAWS: an observer whose node the classifier refuses (both
 * sub-laws declared, a sub-law next to a top-level data_from_field, a
 * malformed set_observed_data / source_overwrite) is REFUSED wholesale and
 * reported as such — never swept under a fallback law, never reported clean.
 * Both PHP sub-laws (a: set_observed_data, b: source_overwrite) are ported
 * since 2026-10-30; a well-formed one is swept like law (c).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	exceedsShrinkBudget,
	reconcileObserverMirrors,
	type ShrinkBudget,
} from '../src/core/section/record/observer_reconcile.ts';

function argValue(flag: string): string | null {
	const index = process.argv.indexOf(flag);
	return index !== -1 ? (process.argv[index + 1] ?? null) : null;
}

const apply = process.argv.includes('--apply');
const json = process.argv.includes('--json');
const checkBudget = process.argv.includes('--budget');
const onlyId = argValue('--id');

// --json is a MACHINE channel: the human report lines would corrupt it, so
// they are suppressed and every drifted record is emitted as one JSON object.
const summary = await reconcileObserverMirrors({
	apply,
	onlyObserver: argValue('--observer'),
	onlySection: argValue('--section'),
	onlyId: onlyId === null ? null : Number(onlyId),
	log: json ? undefined : (line) => console.log(line),
	onRecord: json ? (record) => console.log(JSON.stringify(record)) : undefined,
});

const report = `\nTOTAL: ${summary.tuples} tuple(s), ${summary.candidates} candidate(s), ${summary.drifted} drifted${
	apply
		? ` — ${summary.repaired} repaired, ${summary.shrinksSkipped} shrink(s) held`
		: ' — dry-run, pass --apply to repair'
}${
	summary.droppedRecords > 0
		? `; DROPS: ${summary.droppedLocators} locator(s) across ${summary.droppedRecords} record(s)`
		: ''
}${
	summary.degradedSeedRecords > 0
		? `; ${summary.degradedSeedRecords} record(s) with a DEGRADED SEED (drops withheld)`
		: ''
}${
	summary.sublawRefused > 0
		? `; ${summary.sublawRefused} tuple(s) REFUSED (external value law refused — not swept)`
		: ''
}${
	summary.bigResultRefused > 0
		? `; ${summary.bigResultRefused} record(s) at the >2000-reference FREEZE (computed, not written)`
		: ''
}`;
// --json owns stdout; the human summary goes to stderr so a piped census stays
// parseable while an operator still sees the totals.
if (json) console.error(report);
else console.log(report);

if (checkBudget) {
	const budgetPath = join(import.meta.dir, '..', 'engineering', 'observer_shrink_budget.json');
	const budget = JSON.parse(readFileSync(budgetPath, 'utf8')) as ShrinkBudget;
	const reasons = exceedsShrinkBudget(summary, budget);
	if (reasons.length > 0) {
		console.error(
			`\nSHRINK BUDGET BUSTED (${budgetPath}):\n  - ${reasons.join('\n  - ')}\n` +
				'Do NOT --apply. Classify the drops by cause first (--json), and raise the budget\n' +
				'only once every drop is verified genuine.',
		);
		process.exit(1);
	}
	console.error(
		`\nShrink budget OK: ${summary.droppedLocators}/${budget.maxDroppedLocators} locator(s), ${summary.droppedRecords}/${budget.maxDroppedRecords} record(s).`,
	);
}
process.exit(0);
