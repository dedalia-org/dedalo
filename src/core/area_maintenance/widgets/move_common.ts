/**
 * Shared machinery of the move_* migration widgets (move_lang / move_locator /
 * move_tld / move_to_portal / move_to_table): the static explanation body
 * (byte-equal to PHP) + the TS-owned definition-file listing + the
 * ownership-gated transform EXECUTE (UPDATE_PROCESS Phase 5, WC-025).
 *
 * DRY RUN IS REQUIRED before an execute: the client passes
 * `{files_selected, dry_run}`; `dry_run` must be exactly false to mutate, and
 * the job's report gives the deltas either way (both run as jobs). Definition files live under the
 * TS-owned config.ops.transformDefinitionsDir (never the PHP tree).
 */

import { typedMaintenanceLockWait, withUnboundedStatements } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/index.ts';
import type { Principal } from '../../security/permissions.ts';
import {
	engineDenied,
	gated,
	type WidgetHandler,
	type WidgetModule,
	type WidgetResponse,
	type WidgetSpec,
} from './support.ts';

export const MOVE_WIDGET_BODIES: Record<string, string> = {
	move_lang:
		'Convert map items (e.g., hierarchy89) between translatable and non-translatable components (or vice-versa).<br>\n\t\t\t\t\t   Uses JSON file definitions located in /dedalo/core/base/transform_definition_files/move_lang.<br>\n\t\t\t\t\t   Note: This process can be very time-consuming, as it iterates through all relevant records in the database.',
	move_locator:
		'Move locator defined map items from source (ex. rsc194) to target (ex. rsc197) adding new section_id based in the last section_id of destiny.<br>\n\t\t\t\t\t   Uses JSON file definitions located in /dedalo/core/base/transform_definition_files/move_locator.<br>\n\t\t\t\t\t   Note: this can be a very long process because it has to go through all the records in all the tables.',
	move_tld:
		'Move TLD defined map items from source (ex. numisdata279) to target (ex. tchi1).<br>\n\t\t\t\t\t   Uses JSON file definitions located in /dedalo/core/base/transform_definition_files/move_tld.<br>\n\t\t\t\t\t   Note: this can be a very long process because it has to go through all the records in all the tables.',
	move_to_portal:
		'Move data from a section to another linked section and link together with a portal (e.g. "Use and function" components behind qdp443 to section rsc1340).<br>\n\t\t\t\t\t   Uses JSON file definitions located in /dedalo/core/base/transform_definition_files/move_to_portal.<br>\n\t\t\t\t\t   Note: this can be a very long process because it has to go through all the records in all the tables.',
	move_to_table:
		'Move data from a table to another (e.g. move utoponymy1 to matrix_hierarchy).<br>\n\t\t\t\t\t   Uses JSON file definitions located in /dedalo/core/base/transform_definition_files/move_to_table.<br>',
};

/** Resolve one widget's executor (lazy — avoids loading the whole engine per boot). */
export async function executorFor(
	id: string,
): Promise<
	(
		items: unknown,
		recorder: import('../../update/transform/report.ts').TransformRecorder,
	) => Promise<void>
> {
	switch (id) {
		case 'move_tld': {
			const { executeChangesInTipos } = await import('../../update/transform/tipos.ts');
			return executeChangesInTipos;
		}
		case 'move_locator': {
			const { executeChangesInLocators } = await import('../../update/transform/locators.ts');
			return executeChangesInLocators;
		}
		case 'move_to_portal': {
			const { executePortalize } = await import('../../update/transform/portalize.ts');
			return executePortalize;
		}
		case 'move_to_table': {
			const { executeMoveToTable } = await import('../../update/transform/tables.ts');
			return executeMoveToTable;
		}
		case 'move_lang': {
			const { executeMoveLang } = await import('../../update/transform/lang.ts');
			return executeMoveLang;
		}
		default:
			throw new Error(`no transform executor for ${id}`);
	}
}

/**
 * COVERAGE-EXEMPT for execution (coverage plan §5.1; the reason is registered in
 * engineering/crap_coverage_exempt.json, which test/unit/crap_complexity_ratchet.test.ts
 * gates against this marker): the body is the static catalog lookup plus
 * `listDefinitionFiles`.
 *
 * LEDGER — coverage plan §4.4 D20: the `?? ''` fallback below is DEAD. All five
 * `buildMoveWidget` call sites pass ids that ARE keys of `MOVE_WIDGET_BODIES`
 * (`move_lang` included — checked, since a missing key would have made the
 * fallback live), so no input reaches it. It is UNREACHABLE BY CONSTRUCTION,
 * not merely untested. What KEEPS it dead — and the one non-vacuous claim this
 * function carries — IS GATED: test/unit/move_widget_registry_native.test.ts
 * asserts, in both directions, that every registered move_* id is both an
 * `executorFor` switch arm and a `MOVE_WIDGET_BODIES` key.
 */
function moveWidgetGetValue(widget: string): WidgetHandler {
	return async () => {
		const { listDefinitionFiles } = await import('../../update/transform/definitions.ts');
		const files = listDefinitionFiles(
			widget as import('../../update/transform/definitions.ts').MoveWidgetId,
		);
		return { data: { body: MOVE_WIDGET_BODIES[widget] ?? '', files } };
	};
}

/**
 * The OPEN (owned) transform run — dry-run mandatory before an execute.
 *
 * BOTH ARE JOBS (submitTransformJob): a DRY RUN reads every row of every matrix
 * table a definition names — minutes to hours on a production install — so it
 * is no more an HTTP-request-sized unit than the execute (OPS-6/PERF-11 r3), and
 * the vendored client renders a job stream for either (`{pid, pfile}`). Gate:
 * test/unit/transform_run_native.test.ts drives both through the real widget
 * door with a fake executor.
 */
function moveWidgetRun(id: string): WidgetHandler {
	return async (options, principal): Promise<WidgetResponse> => {
		const widget = id as MoveWidgetId;
		const executor = await executorFor(id);
		return submitTransformJob(widget, options, executor, principal);
	};
}

type MoveWidgetId = import('../../update/transform/definitions.ts').MoveWidgetId;
type TransformExecutor = import('../../update/transform/engine.ts').TransformExecutor;
type TransformReport = import('../../update/transform/report.ts').TransformReport;

/**
 * A transform report as the job's DATA — `ok` (never the envelope's forbidden
 * `result` key: ERRORS_SPEC §5.3, a frame is never `result:false/msg/errors`),
 * the msg, the per-file lines and the diagnostic fields.
 */
function reportData(report: TransformReport): Record<string, unknown> {
	return {
		ok: report.ok,
		msg: report.msg,
		errors: report.errors,
		dry_run: report.dryRun,
		counts: report.counts,
		sample: report.sample,
	};
}

/** The failed run's public sentence: its msg, plus its per-file lines when there are any. */
function failureSentence(report: TransformReport): string {
	return report.errors.length === 0 ? report.msg : `${report.msg} (${report.errors.join('; ')})`;
}

/**
 * The run, as a maintenance-lane job — a DRY RUN or an EXECUTE (`dry_run`
 * exactly false; anything else is a dry run, WC-025).
 *
 * An EXECUTE's files are each one lock-holding unit with the statement ceiling
 * lifted, so the run must be endable: the job's signal (the operator's stop, a
 * shutdown) cancels the running file and rolls it back (engine.ts). A DRY RUN
 * writes nothing and holds no lock that blocks anyone (its reads take ACCESS
 * SHARE); its stop is honoured between files. NO deadline (deadlineMs 0) for
 * either: a clock firing mid-file rolls back a file whose rerun meets the same
 * clock — update_data_version's reason. The job is detached from the door's
 * unbounded scope, so it declares its own (withUnboundedStatements).
 *
 * The response is `{pid, pfile, dry_run}` at once (the widget polls
 * dd_utils_api:get_process_status); the job's `data` is the report
 * (reportData). THE FAILURE CHANNEL (ERRORS_SPEC §5.3): a run whose report is
 * not ok — a rolled-back file, a run-lock refusal, an UNKNOWN / PARTIAL outcome,
 * a dry run whose executor failed — keeps the report as the job data and ends
 * `error` with the typed `maintenance.action_failed` (its sentence the report's
 * msg + lines), never a `done` frame the client renders as "Process completed".
 * A STOPPED run is not a failure: it ends `stopped`, its report the data.
 *
 * SINGLE-FLIGHT (execute only): a second execute while one is claimed is refused
 * (`resource.conflict`) before any job exists; across processes the engine's
 * per-file run lock refuses it. A dry run takes no claim.
 */
async function submitTransformJob(
	widget: MoveWidgetId,
	options: Record<string, unknown>,
	executor: TransformExecutor,
	principal: Principal,
): Promise<WidgetResponse> {
	const { claimTransformRun, runTransform } = await import('../../update/transform/engine.ts');
	const dryRun = options.dry_run !== false;
	const release = dryRun ? () => {} : claimTransformRun();
	if (release === null) {
		throw new DedaloError('resource.conflict', {
			message: `${widget} refused: another move_* transform is running in this process`,
			publicMessage: 'Another move_* transform is running',
		});
	}
	const { mediaJobs } = await import('../../media/jobs.ts');
	try {
		const record = mediaJobs.submit(
			widget,
			async ({ signal, onData }) => {
				// An EXECUTE holds the UPDATE_RUN lock for the job's life
				// (core/update/door_class.ts): no update run starts mid-transform. A dry
				// run writes nothing and takes no lock.
				const transform = () =>
					withUnboundedStatements(() => runTransform(widget, options, executor, { signal }));
				const { holdUpdateRunLock } = await import('../../update/door_class.ts');
				const report = await (dryRun ? transform() : holdUpdateRunLock(widget, transform)).catch(
					(error: unknown) => {
						throw typedMaintenanceLockWait(error);
					},
				);
				const data = reportData(report);
				if (report.ok || signal.aborted) return data;
				onData(data);
				throw new DedaloError('maintenance.action_failed', {
					publicMessage: failureSentence(report),
					coordinates: { widget, dry_run: String(dryRun) },
				});
			},
			{
				// Operator work on stored data: the maintenance lane (PERF-11).
				lane: 'maintenance',
				deadlineMs: 0,
				// The report samples name records: the status stream is owner-scoped.
				userId: principal.userId,
				// The claim is freed on the job's FIRST terminal transition: for a
				// started job that is when its worker SETTLES (a stop included — its
				// file already rolled back), for one stopped while still queued it is
				// at once (its worker never runs). Idempotent.
				onTerminal: release,
			},
		);
		return {
			data: true,
			msg: `OK. Running ${widget}${dryRun ? ' (dry run)' : ''} ${process.pid}`,
			extend: { pid: process.pid, pfile: `${record.id}.json`, dry_run: dryRun },
		};
	} catch (error) {
		release();
		throw error;
	}
}

/**
 * Build one move_* widget module (spec + ownership-gated transform EXECUTE +
 * definition panel). Closed (coexisting) keeps the frozen engine_denied; open
 * runs the transform engine (dry-run first — WC-025).
 */
export function buildMoveWidget(id: string, spec: WidgetSpec): WidgetModule {
	return {
		spec,
		apiActions: {
			[id]: gated(
				`${id}.${id}`,
				engineDenied(`${id}.${id}`, 'the bulk transform is driven by PHP-tree definition files'),
				moveWidgetRun(id),
			),
		},
		// A bulk transform of stored records: maintenance (PERF-11). The door
		// only submits; the DRY RUN and the EXECUTE are detached jobs that declare
		// their own unbounded scope, an executed file its own unit (engine.ts
		// runDefinitionFile — atomic, lock-retried, abortable), so the lane's
		// lock-wait bound rolls a file back whole — it never splits one.
		unboundedActions: [id],
		getValue: moveWidgetGetValue(id),
	};
}
