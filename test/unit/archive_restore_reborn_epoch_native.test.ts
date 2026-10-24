/**
 * THE ARCHIVE RESTORE OPENS A RECORD-GENERATION EPOCH WHERE A DEAD RECORD LIVED —
 * TS-native write-path contract (W4 cross-authz_read:r2, review-diff S3).
 *
 * The restore re-creates each archived record AT ITS ARCHIVED ID
 * (`insertMatrixRecordWithExplicitId`). An installation's section_id counter is
 * local, so that address may already carry the time-machine history of a record
 * that lived — and was deleted — there: a different record (restore.ts LOCATORS
 * note: "`zz10/7` in the destination may be a different record"). Every other
 * explicit-id birth door opens a generation epoch at such an address
 * (create_record.ts recordBirthMarker → record_generation.ts openEpochIfReborn),
 * so the dead generation's rows stay below the boundary every history reader
 * applies (withTmHistory). The restore did not: the restored record's history
 * served the dead record's snapshots as its own — a curator could read, and
 * restore from, values the restored record never held.
 *
 * Pinned (outcomes):
 *   E1 a restore INTO an address with a dead generation's history: the restored
 *      record's visible history is exactly the restore's own whole-record row;
 *      the dead row still exists (history is never deleted), below the epoch;
 *   E2 control: a restore into a FRESH address (no prior history) opens no epoch
 *      and its history is the restore's row — the common case unchanged.
 *
 * Scratch: tld `zzare` (section `zzare1` + component `zzare2`, records in
 * matrix_test). Swept before and after, zero residue asserted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractArchive } from '../../src/core/archive/extract.ts';
import { restoreArchive } from '../../src/core/archive/restore.ts';
import { dbTimestamp } from '../../src/core/db/db_timestamp.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ensureRecordGenerationTable } from '../../src/core/db/record_generation.ts';
import { readTimeMachineHistory, recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureSituation, situation } from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const TLD = 'zzare';
const SECTION = `${TLD}1`;
const COMPONENT = `${TLD}2`;
const RECORD_ID = 1;
const SCRATCH = scratchDir('archive_reborn');
const ARCHIVE = join(SCRATCH, 'archive');
let mediaRoot = '';

const s = situation({
	tld: TLD,
	name: 'archive restore reborn epoch',
	nodes: [
		{ tipo: SECTION, model: 'section' },
		{ tipo: COMPONENT, parent: SECTION, model: 'component_input_text' },
	],
	records: [
		{
			section_tipo: SECTION,
			section_id: RECORD_ID,
			columns: { string: { [COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: 'archived' }] } },
		},
	],
});

/** Everything the scratch tld can leave: nodes, records, TM, counters, epochs. */
async function sweep(): Promise<void> {
	await assertTestDatabase('archive_restore_reborn_epoch_native');
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [TLD]);
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [SECTION]);
	await ensureRecordGenerationTable();
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await clearOntologyDerivedCaches();
}

async function residue(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM dd_ontology WHERE tld = $1)
		      + (SELECT count(*) FROM matrix_test WHERE section_tipo = $2)
		      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = $2)
		      + (SELECT count(*) FROM matrix_counter WHERE tipo = $2)
		      + (SELECT count(*) FROM dedalo_ts_record_generation WHERE section_tipo = $2) AS n`,
		[TLD, SECTION],
	)) as { n: number | string }[];
	return Number(rows[0]?.n ?? -1);
}

/** Every TM row at the address, visible or not (the floor E1 reads the epoch against). */
async function rawTmRows(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
		[SECTION, RECORD_ID],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

/** The whole-record snapshot a delete stamps — the dead generation's last word. */
async function plantDeadGeneration(): Promise<void> {
	await recordTimeMachine(
		{
			sectionTipo: SECTION,
			sectionId: RECORD_ID,
			componentTipo: SECTION,
			lang: 'lg-nolan',
			userId: -1,
			data: { string: { [COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: 'a DEAD record' }] } },
		},
		dbTimestamp(),
	);
}

function valuesOf(history: readonly { data: unknown }[]): unknown[] {
	return history.map(
		(row) =>
			(row.data as { string?: Record<string, { value?: unknown }[]> } | null)?.string?.[
				COMPONENT
			]?.[0]?.value,
	);
}

beforeAll(async () => {
	rmSync(SCRATCH, { recursive: true, force: true });
	mediaRoot = resetMediaRoot(join(SCRATCH, 'media_root'));
	await sweep();
	await ensureSituation(s);
	await extractArchive({ sectionTipos: [SECTION], outDir: ARCHIVE, mediaRoot });
});

beforeEach(sweep);

afterAll(async () => {
	await sweep();
	expect(await residue()).toBe(0);
	rmSync(SCRATCH, { recursive: true, force: true });
});

describe('the archive restore and a dead generation at the restored address', () => {
	test('E1 the restored record does not inherit the dead record’s history', async () => {
		await plantDeadGeneration();
		const outcome = await restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot });
		expect(outcome.records.inserted).toBe(1);
		// Floor: both rows exist — the dead one is hidden, never deleted.
		expect(await rawTmRows()).toBe(2);
		const history = await readTimeMachineHistory(SECTION, RECORD_ID, SECTION);
		expect(valuesOf(history)).toEqual(['archived']);
	});

	test('E2 control: a fresh address — the history is the restore’s row', async () => {
		const outcome = await restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot });
		expect(outcome.records.inserted).toBe(1);
		expect(await rawTmRows()).toBe(1);
		const history = await readTimeMachineHistory(SECTION, RECORD_ID, SECTION);
		expect(valuesOf(history)).toEqual(['archived']);
	});
});
