/**
 * update_data_version widget — the data-version panel + the migration
 * EXECUTE (PHP widgets/update_data_version; UPDATE_PROCESS Phase 3).
 * Panel: the catalog-matched target version + wire descriptor (PHP shape —
 * the client derives its checkbox keys from it); with the EMPTY 7.x catalog
 * both stay null, byte-identical to the pre-Phase-3 panel.
 * EXECUTE: ownership-gated. Closed (coexisting) keeps the frozen behavior —
 * preconditions then the bespoke denial. Open runs the TS engine
 * (core/update/engine.ts — ONE atomic, single-flight transaction, OPS-6):
 * background_running=true submits an in-process mediaJobs job whose signal
 * aborts the run (the client polls dd_utils_api:get_process_status with the
 * returned {pid,pfile} — PHP envelope bytes 'OK. Running publication <pid>'),
 * else the run is inline (inside the widget door's unbounded scope).
 */

import type { Principal } from '../../security/permissions.ts';
import { DEDALO_DATA_VERSION } from '../../update/version.ts';
import {
	engineDenied,
	failAction,
	gated,
	type WidgetModule,
	type WidgetResponse,
} from './support.ts';

/**
 * update_data_version panel (PHP widgets/update_data_version::get_value):
 * {update_version, current_version_in_db, dedalo_version, updates}.
 * current_version_in_db is the shared matrix_updates value (byte-parity).
 * update_version/updates come from the TS catalog (core/update/catalog.ts)
 * — null while no 7.x migration exists, exactly the pre-catalog panel bytes.
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.1; reason registered in
 * engineering/crap_coverage_exempt.json): it folds an EMPTY-BY-CONSTRUCTION
 * catalog (no 7.x migration descriptor exists), so both descriptor fields are
 * null and any assertion over them is vacuous — the precedent is
 * test/unit/code_update.test.ts.
 */
async function updateDataVersionGetValue(): Promise<WidgetResponse> {
	const { getCurrentDataVersion } = await import('../backup.ts');
	const { getMatchedDescriptor, getUpdateVersion, toWireDescriptor } = await import(
		'../../update/catalog.ts'
	);
	const current = await getCurrentDataVersion();
	const descriptor = getMatchedDescriptor(current);
	return {
		data: {
			update_version: getUpdateVersion(current),
			current_version_in_db: current,
			dedalo_version: DEDALO_DATA_VERSION,
			updates: descriptor === null ? null : toWireDescriptor(descriptor),
		},
	};
}

/**
 * The CLOSED (coexisting) branch — byte-frozen: PHP preconditions with the
 * PHP refusal messages, then the bespoke denial (migrations must run exactly
 * once, on the engine that owns the catalog — the PHP install's updates.php).
 */
async function updateDataVersionRun(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	// PHP preconditions (superuser + maintenance mode) — they THROW their own
	// typed refusal. No backup scan: this branch carries no warnings channel.
	const { checkUpdatePreconditions } = await import('../../update/preconditions.ts');
	// A failed precondition THROWS (perm.superuser_required / maintenance.mode_required).
	checkUpdatePreconditions(principal);
	// Then the bespoke denial: migrations must run exactly once, on the engine
	// that owns the catalog.
	return engineDenied(
		'update_data_version.update_data_version',
		'the migration catalog (updates.php) belongs to the PHP install',
	)(options, principal);
}

/**
 * The OPEN (owned) branch: the TS migration engine. Same preconditions,
 * then background (mediaJobs) or inline execution.
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a thin unwrap forwarding to the update
 * engine, gated in its own suites: update_engine_atomic_native (the atomic run,
 * abort and single-flight) and update_engine, whose widget legs drive THIS
 * worker through the real door — the job is submitted with no deadline, and the
 * job's abort signal is the one the engine receives (a stop aborts the run).
 * Executing it MIGRATES STORED DATA. The precondition refusal it shares with the
 * closed branch is gated by test/unit/update_preconditions.test.ts. A descriptor
 * refusal cannot reach the panel: catalog.ts refuses a bad live descriptor at
 * module load (the process never serves one — update_descriptor_tripwire's
 * module-load leg) and the engine's preflight refuses before any statement.
 */
async function updateDataVersionRunOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { backupWarningsWithin, checkUpdatePreconditions, PANEL_WAIT_MS } = await import(
		'../../update/preconditions.ts'
	);
	// A failed precondition THROWS (perm.superuser_required / maintenance.mode_required).
	checkUpdatePreconditions(principal);
	const updatesChecked = (options.updates_checked ?? {}) as Record<string, unknown>;
	const { updateVersion } = await import('../../update/engine.ts');

	if (options.background_running === true) {
		const { mediaJobs } = await import('../../media/jobs.ts');
		const record = mediaJobs.submit(
			'update_data',
			async ({ signal }) => {
				// The final job payload IS the engine response (the client's last
				// SSE frame shows it; PHP: the final pfile line). The job's signal
				// (stop / deadline / shutdown) cancels the running statement and
				// rolls the whole run back (OPS-6). The job is DETACHED, so it
				// inherits no unbounded scope from this request: the engine
				// declares its own (withMaintenanceTransaction).
				return await updateVersion(updatesChecked, {}, { signal });
			},
			// Operator work, not media: it must not queue behind an ingest (PERF-11).
			// NO DEADLINE (deadlineMs 0, overriding the lane's): the run is one
			// atomic unit, so a clock that fires mid-run rolls ALL of it back, and
			// the rerun meets the same clock — a migration longer than the lane
			// deadline could never complete. The operator's stop and a shutdown
			// still abort it (the media and export lanes default to 0 for the
			// same reason).
			{ lane: 'maintenance', deadlineMs: 0 },
		);
		return {
			data: true,
			msg: `OK. Running publication ${process.pid}`,
			// In-process job: the server process runs it (PHP returns the
			// detached CLI's pid; divergence ledgered in the engine header).
			extend: { pid: process.pid, pfile: `${record.id}.json` },
		};
	}

	// The backup verdict is a full archive read and THIS is an HTTP request: wait
	// a bounded time on the shared scan, and say "still being verified" rather
	// than block past the server's idle timeout (OPS-1). Warnings only — a data
	// migration never refuses on a backup. (The background branch above carries
	// no warnings channel, so it never asks.)
	const backupWarnings = await backupWarningsWithin(PANEL_WAIT_MS);
	const outcome = await updateVersion(updatesChecked);
	const errors = [...backupWarnings, ...outcome.errors];
	if (!outcome.ok) {
		failAction(
			errors.length === 0
				? outcome.msg.join('\n')
				: `${outcome.msg.join('\n')} (${errors.join('; ')})`,
		);
	}
	return {
		data: true,
		msg: outcome.msg.join('\n'),
		...(errors.length === 0 ? {} : { errors }),
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'update_data_version',
		category: 'data',
		class: 'success width_100',
		background: true,
		label: { kind: 'label_concat', keys: ['update', 'data'] },
	},
	apiActions: {
		// Ownership-gated (UPDATE_PROCESS Phase 3): closed = the frozen
		// preconditions + bespoke denial; open = the TS migration engine over
		// the (currently empty) core/update/catalog.ts.
		update_data_version: gated(
			'update_data_version.update_data_version',
			updateDataVersionRun,
			updateDataVersionRunOwned,
		),
	},
	getValue: updateDataVersionGetValue,
};
