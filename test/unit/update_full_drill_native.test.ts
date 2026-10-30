/**
 * THE WHOLE UPDATE RUN, IN-PROCESS (update audit 2026-10-29, U-50; design §6
 * Phase 3.1) — the fast subset of `bun run test:update:full`
 * (scripts/update_full_drill.ts), run by the normal suite.
 *
 * The same legs, the same real effects on scratch surfaces of the suite
 * database (marker-asserted; `dedalo_ts_test_updfull_*` tables swept at both
 * ends, their absence asserted; the maintenance flag in a scratch state file):
 * the catalog through the real loader and the master's wire plans → the
 * ontology `min` precondition refusing before the swap (FAILED_PRE_SWAP) → the
 * walk 7.0.1 → 7.0.2 → 7.1.0 with its code restart, the next boot resuming
 * from the journal through ontology, schema and the data rung to CONFIRMED →
 * a planted failing migration after the model moved (NEEDS_DB_RESTORE).
 *
 * What only the drill proves: the next boot as a REAL child process, and the
 * SIGKILL inside the data rung's transaction (PostgreSQL rolls the rung back
 * and frees the UPDATE_RUN lock; the next process re-runs the phase). Here
 * every "next boot" resumes in this process.
 *
 * The drill's pinned KNOWN ENGINE BUGS must still reproduce here too — a pin
 * that no longer does is red in both (remove it with the fix).
 */

import { expect, test } from 'bun:test';
import { runUpdateFullDrill } from '../../scripts/update_full_drill.ts';

test('the update run end to end with real effects: catalog → ontology-min refusal → walk + code restart + resume → CONFIRMED → planted failure → NEEDS_DB_RESTORE (kill leg: bun run test:update:full)', async () => {
	const result = await runUpdateFullDrill({ children: false });
	expect(result.legs).toEqual([
		'catalog',
		'ontology_min_refusal',
		'walk_code_resume_confirmed',
		'planted_failure_needs_db_restore',
	]);
}, 120_000);
