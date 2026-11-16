/**
 * THE RETENTION CATALOG — one entry per append-only store the engine INSERTs
 * into, with the executable prune (or the reasoned "kept forever") behind it.
 *
 * Read registry.ts first: it holds the shape and the argument. This module is
 * the CONTENT — and it is deliberately one file, so "which of our stores grows
 * without a rule?" is a question with one place to look rather than a grep
 * across twenty-six writer modules.
 *
 * EVERY WINDOW READS ITS CONFIG PER RUN, never at import: an operator who sets
 * a window does not have to restart the server for it to mean anything.
 */

import { config } from '../../config/config.ts';
import { readNumber } from '../../config/readers.ts';
import { ERROR_REPORTS_TABLE } from '../error_report/store.ts';
import { type RetentionRunOptions, registerRetention } from './registry.ts';

/** ms per day — window arithmetic, one place. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The cut instant for a window of `days`, measured from `options.now`. */
function cutoffIso(days: number, options: RetentionRunOptions): string {
	const now = options.now ?? new Date();
	return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * Register every store. Called once at import; idempotent per process because
 * the registry keys by name.
 */
export function registerRetentionCatalog(): void {
	// ---------------------------------------------------------------------
	// THE HERITAGE RECORD — forever, and that is the whole point of the system.
	// ---------------------------------------------------------------------
	registerRetention({
		name: 'matrix_records',
		store:
			'matrix, matrix_dd, matrix_users, matrix_projects, matrix_list, matrix_* (the record tables)',
		description:
			'The records themselves, their counters, locks, generations and derived search columns.',
		writers: [
			'src/core/db/matrix_write.ts',
			'src/core/db/record_generation.ts',
			'src/core/db/db_assets.ts',
			'src/core/section/locks.ts',
			'src/core/section/record/temporal_store.ts',
			'src/core/media/counter_reconcile.ts',
			'src/core/area_maintenance/widgets/counters_status.ts',
			'src/core/area_maintenance/widgets/check_config.ts',
			'src/core/install/hierarchy_import.ts',
			'src/core/update/transform/locators.ts',
			'src/core/update/transform/tables.ts',
			'src/core/update/transform/tipos.ts',
			'src/core/test_data/seed.ts',
			'src/core/test_data/projects_fixture.ts',
			'src/core/test_data/test_corpus/ensure.ts',
			'src/diffusion/targets/mariadb/sql_generator.ts',
		],
		policy: {
			kind: 'forever',
			reason:
				'This IS the heritage archive. A record is removed by a curator through the delete door (which files it in the Time Machine), never by a clock.',
		},
	});

	registerRetention({
		name: 'matrix_time_machine',
		store: 'matrix_time_machine',
		description: 'Every prior version of every component value, and the undelete source.',
		writers: ['src/core/db/time_machine.ts'],
		policy: {
			kind: 'forever',
			reason:
				'It is the record of what the record used to be, and the ONLY store a deleted record can be restored from. A window here would silently set an expiry on undo.',
		},
	});

	registerRetention({
		name: 'ontology_projection',
		store: 'dd_ontology, dd_ontology_recovery',
		description: 'The compiled ontology and its recovery snapshot.',
		writers: ['src/core/db/dd_ontology.ts', 'src/core/ontology/data_io_import.ts'],
		policy: {
			kind: 'forever',
			reason:
				'A projection of the ontology source records, rewritten wholesale by the ontology writers. It does not accumulate with time, so a window would have nothing to act on.',
		},
	});

	// ---------------------------------------------------------------------
	// OPERATIONAL STORES — they accumulate with USE, so each names its window.
	// ---------------------------------------------------------------------

	// matrix_activity: SEC-21. One row per state-changing action AND one per
	// denied login, which any unauthenticated caller can cause.
	registerRetention({
		name: 'matrix_activity',
		store: 'matrix_activity',
		description:
			'The audit trail: who did what, when — including every denied login attempt. Pruning removes rows older than the window.',
		// activity_log.ts is the ONE emitter; the INSERT itself lives in the matrix
		// DML writer home, which is also where the age prune lives.
		writers: ['src/core/api/handlers/activity_log.ts', 'src/core/db/matrix_write.ts'],
		policy: {
			kind: 'window',
			configKey: 'DEDALO_ACTIVITY_RETENTION_DAYS',
			windowDays: () => Math.max(0, readNumber('DEDALO_ACTIVITY_RETENTION_DAYS')),
			prune: async (options) => {
				const days = Math.max(0, readNumber('DEDALO_ACTIVITY_RETENTION_DAYS'));
				const detail = { table: 'matrix_activity', window_days: days };
				if (days <= 0) return { candidates: 0, deleted: 0, detail };
				// The statement lives in the matrix DML writer home; this module
				// decides only WHETHER and FROM WHEN (sql_confinement T2).
				const { pruneMatrixEventRowsByAge } = await import('../db/matrix_write.ts');
				const outcome = await pruneMatrixEventRowsByAge(
					'matrix_activity',
					cutoffIso(days, options),
					{
						apply: options.apply,
						batchRows: options.batchRows,
						signal: options.signal,
					},
				);
				return {
					candidates: outcome.candidates,
					deleted: outcome.deleted,
					detail: {
						...detail,
						batches: outcome.batches,
						batch_rows: outcome.batchRows,
						stopped: outcome.stopped,
					},
				};
			},
		},
	});

	// dd1758 publication ledger: PUB-14. One row per record per publish run.
	registerRetention({
		name: 'diffusion_publication_ledger',
		store: 'matrix_activity_diffusion (dd1758)',
		description:
			'One row per record per publish/unpublish run. Pruning removes SETTLED rows older than the window; rows still owing an unpublish are never pruned.',
		writers: ['src/core/diffusion_bridge/diffusion_delete.ts'],
		policy: {
			kind: 'window',
			configKey: 'DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS',
			windowDays: () => Math.max(0, readNumber('DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS')),
			prune: async (options) => {
				const days = Math.max(0, readNumber('DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS'));
				const { pruneSettledLedgerRows } = await import('../diffusion_bridge/diffusion_delete.ts');
				return pruneSettledLedgerRows({
					windowDays: days,
					apply: options.apply,
					now: options.now,
					batchRows: options.batchRows,
					signal: options.signal,
				});
			},
		},
	});

	registerRetention({
		name: 'diffusion_jobs',
		store: 'the diffusion jobs table',
		description:
			"Queued/running/terminal publication jobs, and each job's run ledger (DIFF-1: frontier + artifact rows, cleared when the run completes, ON DELETE CASCADE with the job row). The diffusion scheduler already purges terminal rows on its own cadence.",
		writers: ['src/diffusion/jobs/queue.ts', 'src/diffusion/jobs/run_ledger.ts'],
		policy: {
			kind: 'window',
			configKey: '(constant: diffusion/jobs/scheduler.ts TERMINAL_PURGE_AFTER_HOURS)',
			windowDays: () => 7,
			prune: async (options) => {
				if (!options.apply)
					return { candidates: 0, deleted: 0, detail: { owner: 'diffusion scheduler' } };
				// Through the diffusion FACADE only — core never reaches into the
				// subsystem's internals (boundary_seam_tripwire, DIFFUSION_SPEC §2.5).
				const { purgeTerminalJobs } = await import('../../diffusion/api/actions.ts');
				const { purged } = await purgeTerminalJobs(7 * 24);
				return { candidates: purged, deleted: purged, detail: { owner: 'diffusion scheduler' } };
			},
		},
	});

	// SEC-20: the age window alone cannot bound a burst, so this one also has a
	// ROW CEILING and the prune enforces both.
	registerRetention({
		name: 'error_reports',
		store: ERROR_REPORTS_TABLE,
		description:
			'Error reports received from other installations (master only). Pruned by age AND by a row ceiling — the oldest rows are evicted first.',
		writers: ['src/core/error_report/store.ts'],
		policy: {
			kind: 'window',
			configKey: 'DEDALO_ERROR_REPORT_RETENTION_DAYS',
			windowDays: () => config.errorReport.retentionDays,
			prune: async (options) => {
				const { pruneErrorReports } = await import('../error_report/store.ts');
				return pruneErrorReports(options);
			},
		},
	});

	registerRetention({
		name: 'session_store',
		store: '../private/sessions.sqlite (sessions, login_attempts, password_resets)',
		description:
			'Sessions, failed-login buckets and pending password resets. Each writer GCs its own expired rows opportunistically on insert.',
		writers: ['src/core/security/session_store.ts'],
		policy: {
			kind: 'window',
			configKey: '(constant: SESSION_TTL / LOGIN_ATTEMPT_WINDOW + LOGIN_LOCKOUT)',
			windowDays: () => 1,
			prune: async (options) => {
				// NO dry-run short circuit: a prune that is never executed on the dry
				// path is a prune the gate cannot prove RUNS (this one shipped a DELETE
				// against a column the `sessions` table does not have). The purge counts
				// with the same predicates when apply is false.
				const { purgeExpiredSessionState } = await import('../security/session_store.ts');
				const result = purgeExpiredSessionState({ apply: options.apply });
				return { ...result, detail: { owner: 'session_store' } };
			},
		},
	});

	registerRetention({
		name: 'rag_index',
		store: 'the RAG vector database (embeddings + their index queue)',
		description:
			'Derived embeddings and their work queue. Rewritten per record by the indexer; the queue drains.',
		writers: ['src/ai/rag/vector_store.ts', 'src/ai/rag/queue.ts', 'src/ai/rag/test_rag_db.ts'],
		policy: {
			kind: 'forever',
			reason:
				'DERIVED and self-replacing: an embedding is keyed by its record and overwritten on re-index, so the store tracks the corpus rather than accumulating with time. It is also rebuildable — the one store here that can be dropped whole.',
		},
	});
}

registerRetentionCatalog();
