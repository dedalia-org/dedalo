/**
 * ONTOLOGY RECOVER — the offline repair of a damaged dd_ontology
 * (scripts/ontology_recover.ts is its shell). It replaces PHP's "recovery mode",
 * which served a backup table while the engine ran
 * (WC-2026-11-12-recovery-mode-retired).
 *
 * dd_ontology is a DERIVED projection of the `<tld>0` source records
 * (ontology_state.ts), so the repair is a re-derive — with one catch: the
 * parser resolves component models and matrix tables THROUGH dd_ontology, so a
 * projection whose core tlds are broken cannot re-derive itself. Two phases:
 *
 *   1. SNAPSHOT (`snapshot`): restore the recovery file (the core-tld slice
 *      `build_recovery_version_file` dumps — recovery_file.ts) and swap its rows
 *      into dd_ontology per tld, one transaction, all under ONE hold of the
 *      recovery-slice lock (recovery_file.ts restoreAndSwapRecoverySlice). Gives the
 *      parser a working core.
 *   2. REBUILD (`rebuild`): the `ontology` reconcile — every projected tld
 *      re-derived from its source records (rebuildOntology). Damaged SOURCE
 *      records are re-derived as they are: that case is an ontology update.
 *
 * Dry run by default (reports the snapshot file and the drift, writes nothing).
 * An APPLY refuses while any client holds the database (the restore door's
 * quiesce rule): a running engine would keep serving its cached ontology.
 */

import { existsSync, statSync } from 'node:fs';
import {
	describeBackend,
	type ForeignBackend,
	foreignBackends,
} from '../area_maintenance/restore_door.ts';
import type { RecoverySliceSwap } from '../db/dd_ontology.ts';
import { toDedaloError } from '../errors/convert.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { logError } from '../errors/log.ts';
import { connFromConfig, type DbConnDescriptor } from '../install/pg_exec.ts';
import { resolveRecoveryFilePath } from '../install/runtime_paths.ts';
import type { ReconcileReport } from '../reconcile/registry.ts';
import { ONTOLOGY_RECONCILE } from './ontology_state.ts';
import { restoreAndSwapRecoverySlice } from './recovery_file.ts';

export interface OntologyRecoverOptions {
	/** Phase 1: swap the recovery file's core slice into dd_ontology. */
	snapshot: boolean;
	/** Phase 2: re-derive every projected tld from its source records. */
	rebuild: boolean;
	/** false = dry run: report, write nothing. */
	apply: boolean;
	/** The recovery file; default = the effective slot (runtime_paths.ts). */
	snapshotFile?: string;
	/** The database the quiesce check connects through (default `postgres`). */
	maintenanceDatabase?: string;
	connection?: DbConnDescriptor;
}

export interface OntologyRecoverReport {
	apply: boolean;
	snapshot: {
		file: string;
		/** false: no recovery file — a dry run reports it, an apply refuses before writing. */
		exists: boolean;
		bytes: number | null;
		modified: string | null;
		/** null on a dry run. */
		swapped: RecoverySliceSwap | null;
	} | null;
	/** The `ontology` reconcile's report (drift = units before; applied = repaired). */
	rebuild: ReconcileReport | null;
	/**
	 * A DRY run with the snapshot phase asked: the error CODE of why the current projection
	 * could not be inspected (a core too broken to parse — what the snapshot exists for);
	 * its text is logged. null otherwise.
	 */
	rebuild_error: string | null;
}

/** The quiesce rule: an apply refuses while any client holds the database. */
async function assertQuiet(
	conn: DbConnDescriptor,
	maintenanceDatabase = 'postgres',
): Promise<void> {
	const backends: ForeignBackend[] = await foreignBackends(
		conn,
		maintenanceDatabase,
		conn.database,
	);
	if (backends.length > 0) {
		throw new DedaloError('recovery.writers_active', {
			message: `ontology recover: '${conn.database}' still has ${backends.length} connection(s): ${backends.map(describeBackend).join(', ')}; nothing was written`,
			coordinates: { phase: 'quiesce', target: conn.database, backends: backends.length },
		});
	}
}

type SnapshotReport = NonNullable<OntologyRecoverReport['snapshot']>;

/** What the recovery file is, read without touching the database. */
function snapshotFileState(file: string = resolveRecoveryFilePath()): SnapshotReport {
	if (!existsSync(file)) return { file, exists: false, bytes: null, modified: null, swapped: null };
	const stat = statSync(file);
	return {
		file,
		exists: true,
		bytes: stat.size,
		modified: stat.mtime.toISOString(),
		swapped: null,
	};
}

/** An apply of the snapshot phase needs the file — refused before anything else runs. */
function assertSnapshotPresent(snapshot: SnapshotReport | null): void {
	if (snapshot === null || snapshot.exists) return;
	throw new DedaloError('recovery.artifact_unusable', {
		message: `ontology recover: no recovery file at '${snapshot.file}' (build one with Maintenance → Build database version → recovery file, or run only --rebuild); nothing was written`,
		coordinates: { phase: 'snapshot', path: snapshot.file },
	});
}

/** Phase 1: the recovery file's core slice into dd_ontology (a dry run only reports the file). */
async function snapshotPhase(
	conn: DbConnDescriptor,
	snapshot: SnapshotReport,
	apply: boolean,
): Promise<SnapshotReport> {
	if (!apply) return snapshot;
	const restored = await restoreAndSwapRecoverySlice(conn, snapshot.file);
	if (!restored.ok || restored.swap === undefined) {
		throw new DedaloError('recovery.artifact_unusable', {
			message: `ontology recover: the recovery file did not restore (${[restored.msg, ...restored.errors].join('; ')}); dd_ontology was not touched`,
			coordinates: { phase: 'snapshot', path: snapshot.file },
		});
	}
	return { ...snapshot, swapped: restored.swap };
}

/**
 * Phase 2: the `ontology` reconcile. A dry run that ALSO asked for the snapshot reports an
 * uninspectable projection instead of throwing it: before the snapshot that is the expected
 * state, and the snapshot half of the report must still reach the operator.
 */
async function rebuildPhase(
	options: OntologyRecoverOptions,
): Promise<Pick<OntologyRecoverReport, 'rebuild' | 'rebuild_error'>> {
	if (!options.rebuild) return { rebuild: null, rebuild_error: null };
	try {
		return { rebuild: await ONTOLOGY_RECONCILE.run({ apply: options.apply }), rebuild_error: null };
	} catch (error) {
		if (options.apply || !options.snapshot) throw error;
		// the text goes to the log, the report carries the code (SEC-18)
		const typed = toDedaloError(error);
		logError(typed, { subsystem: 'ontology_recover' });
		return { rebuild: null, rebuild_error: typed.code };
	}
}

/** The phases asked for — at least one, or the call is refused. */
function assertSomePhase(options: OntologyRecoverOptions): void {
	if (options.snapshot || options.rebuild) return;
	throw new DedaloError('internal.invariant', {
		message:
			'ontology recover: nothing to do — ask for the snapshot phase, the rebuild phase, or both',
	});
}

export async function runOntologyRecover(
	options: OntologyRecoverOptions,
): Promise<OntologyRecoverReport> {
	assertSomePhase(options);
	const file = options.snapshot ? snapshotFileState(options.snapshotFile) : null;
	const conn = options.connection ?? connFromConfig();
	if (options.apply) {
		assertSnapshotPresent(file);
		// Checked BEFORE this process opens its own pool, so every backend it lists is foreign.
		await assertQuiet(conn, options.maintenanceDatabase);
	}
	const snapshot = file === null ? null : await snapshotPhase(conn, file, options.apply);
	return { apply: options.apply, snapshot, ...(await rebuildPhase(options)) };
}
