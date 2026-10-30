/**
 * THE UPDATE RUN'S STATE MACHINE (update audit 2026-10-29, design §3.2; owner
 * decisions D-1, D-2, D-9).
 *
 * One journaled run per install update. The phases a run executes are the
 * release's declared `steps` (catalog.json, D-1), so the states are not one
 * fixed line: a run moves through the states of ITS phases, in order, and
 * every state is a fact the journal can prove after a crash.
 *
 *   PLANNED → PREFLIGHT_OK → BACKED_UP → <one state per phase, in step order>
 *           → VERIFIED → CONFIRMED
 *
 * Side/terminal states: REFUSED (nothing mutated), FAILED_PRE_SWAP (nothing
 * the install runs changed), ROLLED_BACK_CODE (the code was put back, allowed
 * only when rollback.ts canAutoRollback), NEEDS_DB_RESTORE (D-2: a data model
 * was crossed — a human restores), MANUAL (a human took over), ABANDONED.
 *
 * Pure: no I/O. journal.ts persists; the phase runners decide outcomes.
 */

import type { ReleaseStepKind } from '../catalog_file.ts';

/** The state a phase's success lands the run in. */
export const PHASE_STATE: Readonly<Record<ReleaseStepKind, RunState>> = Object.freeze({
	code: 'CODE_SWAPPED',
	ontology: 'ONTOLOGY_APPLIED',
	schema: 'SCHEMA_APPLIED',
	data: 'DATA_APPLIED',
	ancillary: 'ANCILLARY_APPLIED',
});

export type RunState =
	| 'PLANNED'
	| 'PREFLIGHT_OK'
	| 'BACKED_UP'
	| 'CODE_SWAPPED'
	| 'ONTOLOGY_APPLIED'
	| 'SCHEMA_APPLIED'
	| 'DATA_APPLIED'
	| 'ANCILLARY_APPLIED'
	| 'VERIFIED'
	| 'CONFIRMED'
	| 'REFUSED'
	| 'FAILED_PRE_SWAP'
	| 'ROLLED_BACK_CODE'
	| 'NEEDS_DB_RESTORE'
	| 'MANUAL'
	| 'ABANDONED';

/** States no run leaves: a new run may start only when the newest run is in one. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
	'CONFIRMED',
	'REFUSED',
	'FAILED_PRE_SWAP',
	'ROLLED_BACK_CODE',
	'NEEDS_DB_RESTORE',
	'MANUAL',
	'ABANDONED',
]);

export function isTerminal(state: RunState): boolean {
	return TERMINAL_STATES.has(state);
}

/**
 * The happy path of a run whose phases are `phases` (the release steps, in
 * order): PLANNED, PREFLIGHT_OK, BACKED_UP, one state per phase, VERIFIED,
 * CONFIRMED. Two steps of one kind (two ontology preconditions) land the same
 * state twice — the journal's phase list tells them apart.
 */
export function happyPath(phases: readonly ReleaseStepKind[]): RunState[] {
	return [
		'PLANNED',
		'PREFLIGHT_OK',
		'BACKED_UP',
		...phases.map((phase) => PHASE_STATE[phase]),
		'VERIFIED',
		'CONFIRMED',
	];
}

/** The side exits of a state — where a failure, or a human, may take it. */
function sideExits(state: RunState, swapped: boolean): RunState[] {
	if (state === 'PLANNED') return ['REFUSED'];
	if (!swapped) return ['FAILED_PRE_SWAP', 'MANUAL', 'ABANDONED'];
	return ['ROLLED_BACK_CODE', 'NEEDS_DB_RESTORE', 'MANUAL'];
}

/**
 * May a run whose phases are `phases`, now at position `index` of its happy
 * path (`completed` phases done), move to `to`? The next happy-path state, or
 * a side exit. A terminal state goes nowhere.
 */
export function canTransition(
	phases: readonly ReleaseStepKind[],
	completed: number,
	from: RunState,
	to: RunState,
): boolean {
	if (isTerminal(from)) return false;
	const path = happyPath(phases);
	const position = positionOf(path, completed, from);
	if (position === null) return false;
	if (path[position + 1] === to) return true;
	const swapped = phases.slice(0, completed).includes('code');
	return sideExits(from, swapped).includes(to);
}

/**
 * Where on the happy path `state` stands, given how many phases are done —
 * the phase count disambiguates a state that two steps of one kind share.
 */
function positionOf(path: readonly RunState[], completed: number, state: RunState): number | null {
	const fixed = ['PLANNED', 'PREFLIGHT_OK', 'BACKED_UP'].indexOf(state);
	if (fixed !== -1) return completed === 0 ? fixed : null;
	// VERIFIED only once EVERY phase is done (the path is the 5 fixed states + the phases).
	if (state === 'VERIFIED') return completed === path.length - 5 ? path.length - 2 : null;
	return phasePosition(path, completed, state);
}

/** A phase state stands right after BACKED_UP + the phases done (at least one). */
function phasePosition(
	path: readonly RunState[],
	completed: number,
	state: RunState,
): number | null {
	const position = 2 + completed;
	return completed > 0 && path[position] === state ? position : null;
}
