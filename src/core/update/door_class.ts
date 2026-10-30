/**
 * PRECONDITION CLASSES — one table for every maintenance door (update audit
 * 2026-10-29, design §3.4, Phase 2.8; U-15, U-42).
 *
 * The least reversible operations had the weakest gates: a move_* transform or
 * a hierarchy reset ran for any global admin, any time, with no backup, beside a
 * code update. Every door now DECLARES its class here, and the widget
 * dispatcher (area_maintenance/widgets/registry.ts) enforces it before the
 * handler runs — an unclassified door is refused (fail closed), and
 * update_door_precondition_class_tripwire keeps the table equal to the live
 * registry and proves each `destructive_shared` door refuses before it acts.
 *
 *   destructive_shared  irreversible on shared or stored data (design §3.4: the
 *                       ontology replace, move_*, the hierarchy reset, the data
 *                       rung, a code restore) — the SUPERUSER, MAINTENANCE mode,
 *                       a fresh proven database backup (waivable with
 *                       `waive_backup: true`, logged with the user), no update
 *                       run in flight, and the UPDATE_RUN lock held while it
 *                       runs (run/lock.ts — a code update cannot start beside it)
 *   update_run          the door STARTS an update run (run/start.ts), whose own
 *                       preflight / backup / lock are these same rules — the
 *                       SUPERUSER is checked here, at the door, before the run
 *                       fetches a manifest, takes the lock or writes a journal
 *   release_build       publishes code to EVERY consumer of this code master (U-25:
 *                       an archive built from any ref is served integrity-verified)
 *                       — the SUPERUSER only; no maintenance (the live tree is
 *                       untouched). Signing is out by owner decision D-10.
 *   reversible_admin    writes that can be undone or rebuilt (re-registering the
 *                       release's tools, derived assets, settings, dry runs) —
 *                       the dispatcher's global-admin gate
 *   read                no write — the global-admin gate
 *
 * A door that submits a BACKGROUND JOB (`job: true`) cannot keep a lock the
 * request releases on return: the dispatcher checks the rules at submission,
 * and the job body holds the lock itself (`holdUpdateRunLock`) for its whole
 * life. `dryRun` names the option that turns a destructive door into its
 * read-only rehearsal (reversible_admin).
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { getServerState } from '../resolve/server_state.ts';
import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { requireFreshBackup } from './preconditions.ts';
import { blockingRun, updateRunsRoot } from './run/journal.ts';
import { tryAcquireUpdateRunLock, type UpdateRunLock } from './run/lock.ts';

export type DoorClass =
	| 'destructive_shared'
	| 'update_run'
	| 'release_build'
	| 'reversible_admin'
	| 'read';

export interface DoorDeclaration {
	class: DoorClass;
	/**
	 * destructive_shared: the handler submits a background job that holds the
	 * lock itself — always (`true`), or when the named option is `true`.
	 */
	job?: true | string;
	/**
	 * destructive_shared: the option that makes it a dry run (then
	 * reversible_admin), and what its absence means — the handler's own reading.
	 */
	dryRun?: { option: string; absentMeansDry: boolean };
	/** Why this class, where it is not obvious. */
	reason?: string;
}

const D: DoorDeclaration = { class: 'destructive_shared' };
const DJ: DoorDeclaration = { class: 'destructive_shared', job: true };
const A: DoorDeclaration = { class: 'reversible_admin' };
const R: DoorDeclaration = { class: 'read' };
const MOVE_DRY_RUN = { option: 'dry_run', absentMeansDry: true };

/** `<widget_id>.<action>` → its class. The tripwire keeps it equal to the live registry. */
export const DOOR_CLASSES: Readonly<Record<string, DoorDeclaration>> = Object.freeze({
	// --- destructive_shared (design §3.4) ---
	// move_common.ts: `dry_run !== false` is a dry run
	'move_locator.move_locator': { ...DJ, dryRun: MOVE_DRY_RUN },
	'move_tld.move_tld': { ...DJ, dryRun: MOVE_DRY_RUN },
	'move_to_table.move_to_table': { ...DJ, dryRun: MOVE_DRY_RUN },
	'move_to_portal.move_to_portal': { ...DJ, dryRun: MOVE_DRY_RUN },
	'move_lang.move_lang': { ...DJ, dryRun: MOVE_DRY_RUN },
	'update_data_version.update_data_version': { ...D, job: 'background_running' },
	'add_hierarchy.reset_hierarchies': D,
	'update_code.restore_code': {
		...DJ,
		reason: 'a code restore swaps the tree (D-2: across a data model a human decides)',
	},
	'build_database_version.restore_dd_ontology_recovery_from_file': {
		...D,
		reason: 'replaces dd_ontology wholesale from a recovery file',
	},
	// --- update_run: the door starts an update run ---
	'update_code.update_code': { class: 'update_run' },
	'update_ontology.update_ontology': { class: 'update_run' },
	'update_code.request_image_update': {
		class: 'update_run',
		reason: 'files the request the host image updater runs (its own backup and swap)',
	},
	'update_code.cancel_image_update_request': {
		class: 'update_run',
		reason: 'withdraws that request',
	},
	// --- release_build (U-25) ---
	'serve_code.build_version_from_git_master': {
		class: 'release_build',
		reason: 'the archive is served to every consumer as integrity-verified (code servers only)',
	},
	// --- reversible_admin ---
	'update_code.delete_restore_point': {
		...A,
		reason:
			'superuser-gated in code_restore.ts; never touches the live tree (no maintenance, by design)',
	},
	'register_tools.register_tools': {
		...A,
		reason: 're-registering the release’s own tools (design §3.4)',
	},
	'add_hierarchy.install_hierarchies': {
		...A,
		reason: 'additive: activates a hierarchy, replaces nothing',
	},
	'publication_hosts.apply_rules': A,
	'publication_hosts.rollback_api': A,
	'publication_hosts.set_host_fields': A,
	'publication_hosts.remove_host': A,
	'publication_hosts.push_apis': A,
	'publication_hosts.reconcile_media_copy': A,
	'publication_hosts.propose_draft': A,
	'publication_hosts.save_draft': A,
	'publication_hosts.remove_draft': A,
	'publication_hosts.build_kit': A,
	'publication_hosts.pair_package': A,
	'dataframe_control.run_fix': A,
	'menu_skip_tipos.save_menu_skip_tipos': A,
	'counters_status.modify_counter': A,
	'counters_status.repair_all_counters': A,
	'counters_status.reconcile_media_counters': A,
	'media_control.rebuild_media_index': { ...A, reason: 'a derived index, rebuildable' },
	'media_control.set_media_access_mode': A,
	'diffusion_server_control.cancel_process': A,
	'diffusion_server_control.requeue_job': A,
	'diffusion_server_control.purge_jobs': A,
	'diffusion_server_control.set_scheduler': A,
	'diffusion_server_control.retry_pending_deletions': A,
	'make_backup.make_psql_backup': A,
	'check_config.set_maintenance_mode': {
		...A,
		reason: 'the switch the destructive class requires',
	},
	'check_config.set_recovery_mode': A,
	'check_config.set_notification': A,
	'runtime_info.clear_cache_files': A,
	'runtime_info.clear_session_files': A,
	'unit_test.create_test_record': A,
	'unit_test.long_process_stream': A,
	'config_areas.save_config_areas': A,
	'database_info.analyze_db': A,
	'database_info.analyze_statistics': A,
	'database_info.consolidate_tables': A,
	'database_info.rebuild_user_stats': A,
	'database_info.optimize_tables': A,
	'database_info.rebuild_db_functions': {
		...A,
		reason: 'derived assets from the declared definitions',
	},
	'database_info.rebuild_db_constraints': {
		...A,
		reason: 'derived assets from the declared definitions',
	},
	'database_info.rebuild_db_indexes': {
		...A,
		reason: 'derived assets from the declared definitions',
	},
	'database_info.recreate_db_assets': {
		...A,
		reason: 'derived assets from the declared definitions',
	},
	'database_info.backfill_search_stores': { ...A, reason: 'derived stores, rebuildable' },
	'reconcile_status.run_reconcile': A,
	'build_database_version.build_install_version': A,
	'build_database_version.build_recovery_version_file': A,
	'export_hierarchy.sync_hierarchy_active_status': A,
	'export_hierarchy.export_hierarchy': A,
	'export_hierarchy.export_hierarchy_json': A,
	// --- read ---
	'publication_hosts.probe': R,
	'publication_hosts.probe_public': R,
	'publication_hosts.download_kit': R,
	'dataframe_control.get_value': R,
	'dataframe_control.run_check': R,
	'counters_status.get_value': R,
	'media_control.get_value': R,
	'diffusion_server_control.get_value': R,
	'error_reports.get_reports': R,
	'make_backup.get_dedalo_backup_files': R,
	'database_info.relation_integrity_report': R,
	// engine_denied doors refuse themselves (support.ts engineDenied): nothing runs
	'update_ontology.export_to_translate': { ...R, reason: 'engine_denied' },
	'update_ontology.rebuild_lang_files': { ...R, reason: 'engine_denied' },
	'build_database_version.build_matrix_hierarchy_main_sql': { ...R, reason: 'engine_denied' },
});

/** The class a request to `what` runs under: a dry run of a destructive door is a rehearsal. */
export function doorClassOf(what: string, options: Record<string, unknown>): DoorClass | null {
	const declared = DOOR_CLASSES[what];
	if (declared === undefined) return null;
	return isRehearsal(declared, options) ? 'reversible_admin' : declared.class;
}

function isRehearsal(declared: DoorDeclaration, options: Record<string, unknown>): boolean {
	if (declared.dryRun === undefined) return false;
	// the handler's own reading, exactly: `!== false` when absence means dry, else `=== true`
	const value = options[declared.dryRun.option];
	return declared.dryRun.absentMeansDry ? value !== false : value === true;
}

/** Whether this request's handler hands the work to a background job (which holds the lock). */
export function submitsJob(what: string, options: Record<string, unknown>): boolean {
	const job = DOOR_CLASSES[what]?.job;
	return job === true || (typeof job === 'string' && options[job] === true);
}

function refused(rule: string, message: string): DedaloError {
	return new DedaloError('update.refused', {
		message: `door refused (${rule}): ${message}`,
		publicMessage: message,
		coordinates: { rule },
	});
}

/** The seams a gate replaces (production: the real reads). */
export interface DoorDeps {
	runsRoot: string;
	requireBackup: () => Promise<void>;
	acquire: () => Promise<UpdateRunLock | null>;
}

function productionDeps(): DoorDeps {
	return {
		runsRoot: updateRunsRoot(),
		requireBackup: () => requireFreshBackup(),
		acquire: tryAcquireUpdateRunLock,
	};
}

/** No update run may be in flight beside a destructive door (an unreadable journal counts). */
async function refuseWhileRunInFlight(root: string): Promise<void> {
	if ((await blockingRun(root)) !== null) {
		throw refused(
			'run_in_flight',
			'An update run is in flight — let it end (or end it with bun run update abort) first',
		);
	}
}

/** The backup, or the operator's waiver — logged with the user, never silent. */
async function backupOrWaiver(
	what: string,
	principal: Principal,
	options: Record<string, unknown>,
	deps: DoorDeps,
): Promise<void> {
	if (options.waive_backup !== true) return deps.requireBackup();
	console.warn(`[door] ${what}: database backup WAIVED by user ${principal.userId}`);
}

/**
 * The destructive_shared rules (superuser, maintenance, no run in flight,
 * backup or waiver), then the lock — held until the returned release is
 * called. A job door gets the lock probed and released at once: its job holds
 * it (holdUpdateRunLock).
 */
export async function enterDestructiveDoor(
	what: string,
	principal: Principal,
	options: Record<string, unknown>,
	deps: DoorDeps = productionDeps(),
): Promise<() => Promise<void>> {
	requireSuperuser(principal, what);
	requireMaintenance(what);
	await refuseWhileRunInFlight(deps.runsRoot);
	await backupOrWaiver(what, principal, options, deps);
	const lock = await deps.acquire();
	if (lock === null) {
		throw refused('run_locked', 'An update or another destructive operation holds the update lock');
	}
	if (submitsJob(what, options)) {
		await lock.release();
		return async () => {};
	}
	return () => lock.release();
}

/**
 * The superuser only (destructive_shared, update_run, release_build — U-25, and
 * an update run refused at its door, before any outbound fetch, lock or journal).
 * The refusal names the DOOR: the gate proves it came from here, not from a
 * handler's own check.
 */
function requireSuperuser(principal: Principal, what: string): () => Promise<void> {
	if (principal.userId !== SUPERUSER_ID) {
		throw new DedaloError('perm.superuser_required', {
			coordinates: { user: principal.userId, door: what },
		});
	}
	return async () => {};
}

/** Maintenance mode is on (destructive_shared), the refusal naming the door. */
function requireMaintenance(what: string): void {
	if (getServerState().maintenance_mode !== true) {
		throw new DedaloError('maintenance.mode_required', { coordinates: { door: what } });
	}
}

/**
 * Enforce `what`'s class for one request. Returns the release to call when the
 * handler ends. An unclassified door is refused (the tripwire keeps that from
 * shipping).
 */
export async function enterDoor(
	what: string,
	principal: Principal,
	options: Record<string, unknown>,
	deps?: DoorDeps,
): Promise<() => Promise<void>> {
	const declared = doorClassOf(what, options);
	if (declared === null) {
		throw new DedaloError('internal.invariant', {
			message: `maintenance door ${what} declares no precondition class (src/core/update/door_class.ts)`,
		});
	}
	if (declared === 'release_build' || declared === 'update_run') {
		return requireSuperuser(principal, what);
	}
	if (declared !== 'destructive_shared') return async () => {};
	return enterDestructiveDoor(what, principal, options, deps);
}

/**
 * A destructive door's BACKGROUND JOB holds the UPDATE_RUN lock for its whole
 * life (the request that submitted it already returned). Refused when the lock
 * is held — the job then fails before it touches anything.
 */
export async function holdUpdateRunLock<T>(
	what: string,
	body: () => Promise<T>,
	acquire: () => Promise<UpdateRunLock | null> = tryAcquireUpdateRunLock,
	runsRoot: string = updateRunsRoot(),
): Promise<T> {
	const lock = await acquire();
	if (lock === null) {
		throw refused(
			'run_locked',
			`${what}: an update or another destructive operation holds the update lock`,
		);
	}
	try {
		// The lock is free in a run's RESTART window too (the code phase releases
		// it as the process exits into the new tree): the journal fences what the
		// lock cannot — a job queued at the door re-checks it once it holds the
		// lock (review 2026-10-30 #9).
		await refuseWhileRunInFlight(runsRoot);
		return await body();
	} finally {
		await lock.release();
	}
}
