/**
 * IS THIS PRIVATE DIRECTORY ALREADY INSTALLED? — the developer route's
 * existing-install refusals, ONE function per rule, three callers (T1-P08,
 * TODO-050):
 *
 *  - the System check (probes.ts systemCheck — screen 2, before any other
 *    question: an installed tree is said there, not after the Review and `yes`);
 *  - the Review preflight (host/review.ts reviewPreflightRefusals);
 *  - the run (executor.ts assertNoRecord / assertMachineReady) — the authority.
 *
 * Same words everywhere: the run's sentence IS the one shown on the screens.
 *
 * An UNFINISHED record (`in_progress`) is not a refusal here: the Welcome
 * offers resume/abort for it (install_session.ts unfinishedFlow). `aborted`
 * never persists (executor.ts abortRun removes the run files).
 *
 * READ-ONLY: nothing is created — the state file is read through
 * server_state.ts statePathOf (no mkdir of a private dir that is only looked
 * at). Config-free (run_files + server_state's path resolution only).
 * Gate: test/unit/install_existing_install_native.test.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statePathOf } from '../resolve/server_state.ts';
import {
	type InstallState,
	installRunDir,
	readPlanFile,
	readStateFile,
	STATE_FILE,
} from './run_files.ts';

/** A sealed private dir: the run's refusal (executor.ts assertMachineReady). */
export const SEALED_PRIVATE_DIR =
	'this private directory belongs to a SEALED installation — a fresh install never overwrites a live one';

/** The install_status of the engine's state file, or undefined (absent / unreadable) — never creates it. */
export function peekInstallStatus(): string | undefined {
	const path = statePathOf();
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as { install_status?: unknown };
		return typeof parsed.install_status === 'string' ? parsed.install_status : undefined;
	} catch {
		return undefined;
	}
}

/**
 * THE wording of "an install record exists" (executor.ts assertNoRecord). A
 * COMPLETE record is an installed tree: never undone, never overwritten by a
 * fresh run (`--resume` over it re-verifies every step and changes nothing —
 * install_e2e); anything else keeps the resume/abort tail.
 */
export function engineRecordSentence(dir: string, state: InstallState, db: string): string {
	const prefix = `an install record exists at ${join(dir, STATE_FILE)} (outcome: ${state.outcome})`;
	return state.outcome === 'complete'
		? `${prefix} — this tree is already installed (--resume only re-verifies it); a fresh install never overwrites a live one`
		: `${prefix} — resume it with --resume, undo it with --abort --confirm-database ${db}, or remove the install directory if this private directory is being reused deliberately`;
}

/** The database a record's plan names ('<db>' when there is none). */
export function recordDatabase(dir: string = installRunDir()): string {
	return String(readPlanFile(dir)?.answers.db_database ?? '<db>');
}

/**
 * The developer route's existing-install refusals, read-only: a finished
 * record, a sealed state file. An unreadable record is its own refusal (the
 * run would refuse it too). An `in_progress` record is the Welcome's.
 */
export function engineInstalledHere(): string[] {
	const sealed = peekInstallStatus() === 'sealed' ? [SEALED_PRIVATE_DIR] : [];
	let state: InstallState | null;
	try {
		state = readStateFile();
	} catch (error) {
		return [(error as Error).message, ...sealed];
	}
	if (state === null || state.outcome === 'in_progress') return sealed;
	const dir = installRunDir();
	return [engineRecordSentence(dir, state, safeDatabase(dir)), ...sealed];
}

/** The record's database, '<db>' when its plan cannot be read. */
function safeDatabase(dir: string): string {
	try {
		return recordDatabase(dir);
	} catch {
		return '<db>';
	}
}
