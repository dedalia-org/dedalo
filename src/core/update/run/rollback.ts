/**
 * THE ONE ROLLBACK PREDICATE (update audit 2026-10-29, U-02; design §3.1;
 * owner decision D-2): may the code be put back AUTOMATICALLY?
 *
 * Only while the install has not left the data model the previous code runs
 * on. A phase that touches the database — `schema`, `data`, `ontology` — of a
 * release whose catalog compat is `incompatible` crosses the model: from then
 * on the previous code would run against a database it does not understand,
 * so the only sound way back is a database restore TOGETHER with the code, and
 * that is a human decision (NEEDS_DB_RESTORE), never a supervisor's. A phase
 * counts as soon as it STARTED: a failed migration file rolled back, but the
 * files before it in the same phase committed. A phase that ran BEFORE the code
 * swap never counts: it ran under the previous code, which survived it (that is
 * what an ontology precondition step is for).
 *
 * Pure. HOW IT REACHES THE SUPERVISOR: not by the shell scripts asking it. The
 * executor (executor.ts stepOnce) flips the code sentinel to `needs_restore`
 * BEFORE a phase that crosses the model starts, and deploy/dedalo-code-rollback.sh
 * acts only on a `pending` sentinel — so the script never rolls back across a
 * model without consulting anything (gate: update_run_resume_native). The leaf
 * CLI (scripts/update_run_rollback_check.ts, `bun run update check`) is the
 * OPERATOR's view of the same predicate. Removing the sentinel flip would leave
 * nothing between a model-crossing failure and an automatic rollback.
 */

import { RELEASE_PLANS } from '../catalog.ts';
import type { ReleasePlan, ReleaseStepKind } from '../catalog_file.ts';
import type { RunJournal } from './journal.ts';

const DATABASE_PHASES: ReadonlySet<ReleaseStepKind> = new Set(['schema', 'data', 'ontology']);

export interface RollbackVerdict {
	allowed: boolean;
	/** The phase that crossed the model (`<release> <kind>`), when one did. */
	crossedBy: string | null;
	reason: string;
}

/** Can `journal`'s code be rolled back automatically (same data model throughout)? */
export function canAutoRollback(
	journal: RunJournal,
	plans: Readonly<Record<string, ReleasePlan>> = RELEASE_PLANS,
): RollbackVerdict {
	const swap = journal.phases.findIndex((phase) => phase.step.kind === 'code');
	const crossing = journal.phases.find(
		(phase, index) =>
			swap !== -1 &&
			index > swap &&
			phase.outcome !== 'skipped' &&
			DATABASE_PHASES.has(phase.step.kind) &&
			plans[phase.release]?.compat !== 'compatible',
	);
	if (crossing === undefined) {
		return {
			allowed: true,
			crossedBy: null,
			reason:
				'no database phase of an incompatible release ran: the previous code still fits the database',
		};
	}
	const crossedBy = `${crossing.release} ${crossing.step.kind}`;
	return {
		allowed: false,
		crossedBy,
		reason: `the ${crossedBy} phase moved the database to a data model the previous code does not run on — restore the database backup together with the previous code (a human decision)`,
	};
}

/** The side exit a FAILED phase takes the run to (design §3.2). */
export type FailureExit = 'FAILED_PRE_SWAP' | 'ROLLED_BACK_CODE' | 'NEEDS_DB_RESTORE';

/**
 * Where a failure takes the run: before the code swap nothing the install runs
 * changed (FAILED_PRE_SWAP); after it, the code goes back automatically only
 * when `canAutoRollback` allows (ROLLED_BACK_CODE), else a human restores the
 * database with the code (NEEDS_DB_RESTORE).
 */
export function failureExit(
	journal: RunJournal,
	plans: Readonly<Record<string, ReleasePlan>> = RELEASE_PLANS,
): FailureExit {
	const swapped = journal.phases.some(
		(phase) => phase.step.kind === 'code' && phase.outcome === 'ok',
	);
	if (!swapped) return 'FAILED_PRE_SWAP';
	return canAutoRollback(journal, plans).allowed ? 'ROLLED_BACK_CODE' : 'NEEDS_DB_RESTORE';
}

/** What NEEDS_DB_RESTORE tells the human (D-2): the backup, the loss window, the steps. */
export interface DbRestoreReport {
	run_id: string;
	crossedBy: string | null;
	/** The dump to restore: the run's own, taken on the previous model. Null = waived (no run backup). */
	backup: string | null;
	/** Writes after this instant are lost by the restore (null when there is no backup). */
	lossWindowFrom: string | null;
	/** The release whose code must run on the restored database. */
	previousRelease: string;
	/** The ordered human actions. */
	actions: string[];
}

/**
 * The NEEDS_DB_RESTORE report: which backup restores the previous data model,
 * what a restore loses (every write since the dump), and what to do, in order.
 * Without a run backup (a journaled waiver) the report says so instead of
 * naming one — choosing an older dump is the human's call, with a larger loss.
 */
export function dbRestoreReport(
	journal: RunJournal,
	plans: Readonly<Record<string, ReleasePlan>> = RELEASE_PLANS,
): DbRestoreReport {
	const backup = journal.backup?.path ?? null;
	const previous = journal.from.release;
	return {
		run_id: journal.run_id,
		crossedBy: canAutoRollback(journal, plans).crossedBy,
		backup,
		lossWindowFrom: backup === null ? null : (journal.backup?.taken ?? null),
		previousRelease: previous,
		actions: [
			'Keep the installation in maintenance mode: no user may write.',
			backup === null
				? 'This run took no backup (waived): pick the newest verified dump taken BEFORE the run; everything written after it is lost.'
				: `Restore the database from ${backup}; every write after the dump is lost.`,
			`Restore the code restore point of ${previous} (Maintenance → Update code → Restore, or the rollback script).`,
			`Close the run ${journal.run_id}: bun run update abort <what was restored> (until then no new update run starts), then leave maintenance mode.`,
		],
	};
}
