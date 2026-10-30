/**
 * BOOT STATE — what this process learned about its own schema and data at boot
 * (update audit 2026-10-29, U-01 / U-04).
 *
 * Three facts, all request-INDEPENDENT process-lifecycle state (same class as
 * process_health.ts's poison latch — module_state_tripwire allowlist):
 *
 *  - the BOOT SCHEMA verdict: did this boot's migration run succeed? A failed
 *    run used to be one journal line while /health stayed green and the update
 *    sentinel was confirmed, disarming every rollback. The verdict now feeds
 *    /health (red on failure) and the confirmation (refused on failure).
 *
 *  - the DATA VERSION state: the installed data version (matrix_updates) against
 *    the data version this code declares (DEDALO_DATA_VERSION). Nothing read it at
 *    boot, so code could serve a database it was not written for, unflagged.
 *    `pending` = the database is BEHIND the code (an "Update data" is due);
 *    `ahead` = the database is NEWER than the code (old code restored over a
 *    migrated database — VERSIONING_SPEC S7: needs a human, never served green).
 *
 *  - the UPDATE RUN facts (design §3.5): the run in flight and whether it owns
 *    this boot — /health carries them, and a run applying pending schema/data
 *    is not "red" for being in the middle of its job.
 *
 * Leaf-ish: no DB access here; the readers are injected by the boot (server.ts)
 * and by the data engine after a committed rung, so this module stays pure.
 */

import type { BootSchemaVerdict } from '../../../install/db/migrate.ts';
import { compareVersionArrays, DEDALO_DATA_VERSION, formatVersion } from './version.ts';

/** Installed data version vs the code's declared one. */
export type DataVersionStateName = 'ok' | 'pending' | 'ahead' | 'unknown';

export interface DataVersionState {
	state: DataVersionStateName;
	/** The installed data version (matrix_updates), or null when it could not be read / is absent. */
	installed: string | null;
	/** The data version this code declares. */
	code: string;
}

/** The boot schema verdict as /health reports it (`skipped`: a smoke boot, or not run yet). */
export type BootSchemaStateName = 'ok' | 'failed' | 'skipped';

/**
 * The update run as /health reports it (design §3.5): the run in flight, or the
 * last one this process ended. `owns_boot`: a run in flight claimed this boot —
 * its schema phase, not the boot runner, applies the migrations.
 */
export interface UpdateRunFacts {
	run_id: string;
	state: string;
	/** The release identity the run installs. */
	target: string;
	owns_boot: boolean;
	/** This process runs the tree the run installs (executor.ts runsTargetTree). */
	on_target: boolean;
}

interface BootStateFacts {
	schema: BootSchemaVerdict | null;
	data: DataVersionState | null;
	run: UpdateRunFacts | null;
}

const bootState: BootStateFacts = {
	schema: null,
	data: null,
	run: null,
};

/** Record the update run's facts (the boot's journal read, then every executor step). */
export function recordUpdateRunFacts(facts: UpdateRunFacts | null): void {
	bootState.run = facts;
}

/** The update run's facts, or null when no run concerns this process. */
export function updateRunFacts(): UpdateRunFacts | null {
	return bootState.run;
}

/** Record this boot's schema verdict (server.ts, once, after runBootSchema). */
export function recordBootSchemaVerdict(verdict: BootSchemaVerdict): void {
	bootState.schema = verdict;
}

/** This boot's schema verdict, or null when no migration run happened (smoke boot / tests). */
export function bootSchemaVerdict(): BootSchemaVerdict | null {
	return bootState.schema;
}

/** The /health spelling of the schema verdict. */
export function bootSchemaStateName(): BootSchemaStateName {
	return bootState.schema === null ? 'skipped' : bootState.schema.state;
}

/**
 * On a FAILED run only: whether it moved the schema (null = unknown, read as
 * moved by the confirmation). Undefined otherwise — /health omits the key.
 */
export function bootSchemaMoved(): boolean | null | undefined {
	return bootState.schema?.state === 'failed' ? bootState.schema.schemaMoved : undefined;
}

/**
 * Classify an installed data version against the code's. `installed` null = it
 * could not be read (unknown); `[]` = no version row (a database that never
 * recorded one — reported as unknown, never as ok).
 */
export function classifyDataVersion(
	installed: readonly number[] | null,
	code: readonly number[],
): DataVersionState {
	const codeText = formatVersion(code);
	if (installed === null || installed.length === 0) {
		return { state: 'unknown', installed: null, code: codeText };
	}
	const order = compareVersionArrays(installed, code);
	return {
		state: order === 0 ? 'ok' : order < 0 ? 'pending' : 'ahead',
		installed: formatVersion(installed),
		code: codeText,
	};
}

/**
 * Re-read and record the data version state. `read` is the strict reader
 * (backup.ts readInstalledDataVersionStrict); a read failure records `unknown`.
 * Called at boot and after a committed data rung, so /health follows "Update
 * data" without a restart.
 */
export async function refreshDataVersionState(
	read: () => Promise<number[]>,
	code: readonly number[] = DEDALO_DATA_VERSION,
): Promise<DataVersionState> {
	let installed: number[] | null;
	try {
		installed = await read();
	} catch (error) {
		console.error('[boot] installed data version unreadable (reported as unknown):', error);
		installed = null;
	}
	const state = classifyDataVersion(installed, code);
	bootState.data = state;
	if (state.state === 'pending') {
		console.warn(
			`[boot] DATA UPDATE PENDING: the database is on data version ${state.installed}, this code declares ${state.code} — run "Update data" in the maintenance area before using the new version`,
		);
	} else if (state.state === 'ahead') {
		console.error(
			`[boot] DATA VERSION AHEAD OF CODE: the database is on data version ${state.installed}, this code declares ${state.code} — older code over a newer database; restore a compatible backup or install the matching code (/health is red until then)`,
		);
	}
	return state;
}

/** The last recorded data version state, or null before the first refresh. */
export function dataVersionState(): DataVersionState | null {
	return bootState.data;
}

/** TEST-ONLY: forget every fact (the state is process-global by design). */
export function resetBootStateForTest(): void {
	bootState.schema = null;
	bootState.data = null;
	bootState.run = null;
}
