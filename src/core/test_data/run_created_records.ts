/**
 * THE RECORDS A CLIENT RUN CREATED — and the rows the engine wrote ABOUT them.
 *
 * WHY. A browser suite builds its situation through the engine's own doors:
 * it creates test3 records (`create`) and deletes them again (`delete`,
 * delete_mode 'delete_record'). The record rows go, but the engine also wrote
 * rows ABOUT those records that a delete keeps by design — the delete's
 * time-machine snapshot (matrix_time_machine: the undo of a delete) and the
 * create/delete activity (matrix_activity dd542, locator in misc.dd551). The
 * post-run reseed (seed.ts restoreCanonicalTest3) deliberately leaves TM
 * history alone, so every run added its created records' history to the SUITE
 * database for good (the export suite alone: ~80 snapshots per run).
 *
 * WHAT IT SWEEPS — exactly the records CREATED during the run, nothing older:
 * the runner reads the section's counter AFTER its pre-run reseed
 * (`runCounterMark`), and after the run deletes, for section_ids ABOVE that
 * mark, the leftover record rows, their time-machine rows and their dd542
 * activity rows. An id is allocated by raising that counter (GREATEST), so an
 * id above the mark is one this run's creates allocated; the canonical
 * playground and every earlier row lie at or below it. (Not an id BAND: the
 * mark is measured per run, on the marked suite database — never a range
 * assumed "clear of genuine records".)
 *
 * WHAT "THIS RUN" RESTS ON — the sweep's actual rule is "every row of the
 * section ABOVE the mark", whoever wrote it (pinned by
 * run_created_records_native leg D: a raw row planted above the counter, as the
 * explicit-id export gates plant theirs, is swept too). That equals "created by
 * this run" only because the suite database has ONE test run at a time: a
 * concurrent `bun test` and `bun run test:client` on one suite database is
 * UNSUPPORTED, and not because of this sweep — both reseed test3 WHOLESALE
 * (seed.ts restoreCanonicalTest3 deletes every test3 row: test/helpers/
 * test_data.ts on each test process, client_test_runner.ts before the run),
 * so either run already wipes the other's records.
 *
 * SUITE DATABASE ONLY: both doors refuse a database the suite has not marked
 * (assertTestDatabase, the marker owner's API) before reading or writing.
 */

import { sectionIdAddressSqlValue } from '../concepts/section_id.ts';
import { sql } from '../db/postgres.ts';
import { CANONICAL_SECTION_TIPO, CANONICAL_TABLE } from './manifest.ts';
import { assertTestDatabase } from './test_database_marker.ts';

/** The run's mark: the section's counter now (0 when it has none yet). */
export async function runCounterMark(
	sectionTipo: string = CANONICAL_SECTION_TIPO,
): Promise<number> {
	await assertTestDatabase('runCounterMark');
	const rows = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
		sectionTipo,
	])) as { value: number | string }[];
	return Number(rows[0]?.value ?? 0);
}

/** What one sweep removed, per table. */
export interface RunCreatedSweep {
	records: number;
	timeMachine: number;
	activity: number;
}

/**
 * Delete every row about a record of `sectionTipo` created after `mark`: the
 * record itself (a suite that did not delete its own), its time-machine rows
 * and its dd542 activity rows. Answers the counts.
 */
export async function sweepRecordsCreatedSince(
	mark: number,
	sectionTipo: string = CANONICAL_SECTION_TIPO,
	table: string = CANONICAL_TABLE,
): Promise<RunCreatedSweep> {
	await assertTestDatabase('sweepRecordsCreatedSince');
	const records = await sql.unsafe(
		`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id > $2`,
		[sectionTipo, mark],
	);
	const timeMachine = await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id > $2',
		[sectionTipo, mark],
	);
	const activity = await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		   AND ${sectionIdAddressSqlValue("misc->'dd551'->0->'value'->>'section_id'")} > $2`,
		[sectionTipo, mark],
	);
	return {
		records: records.count ?? 0,
		timeMachine: timeMachine.count ?? 0,
		activity: activity.count ?? 0,
	};
}

/**
 * A run's sweep, ARMED: the mark measured when it was armed, and the sweep for
 * exactly that mark. `sweep()` runs once — the runner calls it from its
 * `finally` AND from its signal handler, whichever comes first; a second call
 * answers null and deletes nothing (a later mark would be a different run).
 */
export interface RunCreatedSweeper {
	readonly mark: number;
	sweep(): Promise<RunCreatedSweep | null>;
}

/**
 * Measure the mark NOW (arm AFTER anything that may raise the counter — the
 * runner's pre-run reseed) and hand back its once-only sweep. The runner's use
 * of it (armed after the reseed, swept in `finally` and on a signal) is pinned
 * by client_situations_native.
 */
export async function armRunCreatedSweep(
	sectionTipo: string = CANONICAL_SECTION_TIPO,
	table: string = CANONICAL_TABLE,
): Promise<RunCreatedSweeper> {
	const mark = await runCounterMark(sectionTipo);
	let swept = false;
	return {
		mark,
		async sweep() {
			if (swept) return null;
			swept = true;
			return sweepRecordsCreatedSince(mark, sectionTipo, table);
		},
	};
}
