/**
 * RECORD GENERATION — a re-minted id does not inherit the dead record's history
 * (P0-14, second half).
 *
 * The counter half (commit d374ceeace) stopped ids being re-minted GOING
 * FORWARD. It does nothing for an address where a re-mint ALREADY happened, and
 * it cannot fence a route outside the allocator. There, the reborn record's
 * Time Machine panel lists the dead record's snapshots as its own, and a restore
 * writes the dead record's values into it with `ok:true`.
 *
 * THE DISCRIMINATOR IS A TM ID, NOT A CLOCK (see record_generation.ts): both
 * engines deliberately stamp repair rows 60 seconds in the past, the clock is
 * wall-clock local time with an ambiguous DST fold, and thousands of UTC-skewed
 * rows still exist. `matrix_time_machine.id` is a monotonic serial and is
 * already the engine's ordering for history.
 *
 * These gates force the damaged state directly (delete the record, drop the
 * counter below the tail, mint again) because the counter half now prevents it
 * through the front door — which is the point: this half exists for the
 * installs where it already happened.
 *
 * DB writes ONLY on the matrix_test scratch surface; cleaned before and after.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import {
	insertMatrixRecordWithCounter,
	updateMatrixRecord,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordEpoch } from '../../src/core/db/record_generation.ts';
import {
	hasVisibleLaneHistory,
	readTimeMachineHistory,
	recordTimeMachine,
} from '../../src/core/db/time_machine.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { countTimeMachineData, readTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { TransformRecorder } from '../../src/core/update/transform/report.ts';
import { executeChangesInTipos } from '../../src/core/update/transform/tipos.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { cleanScratchTipo } from '../helpers/test_data.ts';

const TLD = 'zzgen';
const TIPO = `${TLD}1`;
const COMPONENT = `${TLD}2`;
const TABLE = 'matrix_test';
/** dd_ontology node of model 'matrix_table' whose term is `matrix_test`. */
const MATRIX_TEST_RELATION = 'test24';

async function mint(): Promise<number> {
	return insertMatrixRecordWithCounter(TABLE, TIPO, {
		string: { [COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: 'x' }] },
	});
}

async function writeHistory(sectionId: number, value: string): Promise<void> {
	await recordTimeMachine(
		{
			sectionTipo: TIPO,
			sectionId,
			componentTipo: COMPONENT,
			lang: 'lg-nolan',
			userId: 1,
			data: { value },
		},
		'2026-08-31 10:00:00',
	);
}

async function deleteRecord(sectionId: number): Promise<void> {
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
		TIPO,
		sectionId,
	]);
}

/**
 * The history the dd15 panel would list for this record — through the real
 * serving door (readTimeMachineData), not a hand-written query, so the gate
 * exercises the same WHERE the panel does.
 */
async function visibleHistory(sectionId: number): Promise<number> {
	const sqo = {
		filter_by_locators: [{ section_tipo: TIPO, section_id: sectionId }],
		limit: 50,
		offset: 0,
	};
	const { data } = await readTimeMachineData({ sqo, source: { lang: 'lg-nolan' } } as never);
	const envelope = data[0] as { entries?: unknown[] };
	const listed = (envelope.entries ?? []).length;
	// The panel's count twin must agree with its rows, or pagination lies.
	expect(await countTimeMachineData({ sqo } as never)).toBe(listed);
	return listed;
}

/** Force the pre-P0-14 damaged state: the id is free again and the counter lags. */
async function forceRemintOf(sectionId: number): Promise<number> {
	await deleteRecord(sectionId);
	await sql`UPDATE matrix_counter SET value = ${sectionId - 1} WHERE tipo = ${TIPO}`;
	return mint();
}

describe('record generation (P0-14, second half)', () => {
	beforeAll(async () => {
		await deleteTldNodes(TLD);
		await upsertDdOntologyNode({
			tipo: TIPO,
			model: 'section',
			tld: TLD,
			term: { 'lg-eng': 'Generation scratch section' },
			properties: {},
			relations: [{ tipo: MATRIX_TEST_RELATION }],
		});
		// The restore door resolves the component's MODEL before it reaches the
		// identity gate — without a real node it refuses with request.invalid_tipo
		// and the gate below would pass for the wrong reason (measured).
		await upsertDdOntologyNode({
			tipo: COMPONENT,
			model: 'component_input_text',
			parent: TIPO,
			tld: TLD,
			is_translatable: false,
			term: { 'lg-eng': 'Generation scratch component' },
		});
	});

	beforeEach(async () => {
		await cleanScratchTipo(TIPO, TABLE);
		await sql`DELETE FROM dedalo_ts_record_generation WHERE section_tipo = ${TIPO}`;
	});

	afterAll(async () => {
		await cleanScratchTipo(TIPO, TABLE);
		await sql`DELETE FROM dedalo_ts_record_generation WHERE section_tipo = ${TIPO}`;
		await deleteTldNodes(TLD);
	});

	test('a record born at a FRESH address opens no epoch and owns all its history', async () => {
		const id = await mint();
		await writeHistory(id, 'mine-1');
		await writeHistory(id, 'mine-2');

		// The store is SPARSE: nothing is written for an address never reborn.
		expect(await recordEpoch(TIPO, id)).toBe(0);
		expect(await visibleHistory(id)).toBe(2);
	});

	test('a REBORN record does not inherit the dead record’s history', async () => {
		const dead = await mint();
		await writeHistory(dead, 'dead-1');
		await writeHistory(dead, 'dead-2');
		expect(await visibleHistory(dead)).toBe(2);

		const reborn = await forceRemintOf(dead);
		expect(reborn).toBe(dead); // the same address — that is the defect

		// The epoch was opened at birth, so the panel starts EMPTY...
		expect(await recordEpoch(TIPO, reborn)).toBeGreaterThan(0);
		expect(await visibleHistory(reborn)).toBe(0);

		// ...and fills only with what this record does.
		await writeHistory(reborn, 'mine-1');
		expect(await visibleHistory(reborn)).toBe(1);

		// The dead record's rows are still THERE — never destroyed, only fenced.
		const all = (await sql`
			SELECT count(*)::int AS n FROM matrix_time_machine
			WHERE section_tipo = ${TIPO} AND section_id = ${reborn}
		`) as { n: number }[];
		expect(Number(all[0]?.n)).toBe(3);
	});

	test('readTimeMachineHistory serves only the living generation', async () => {
		// time_machine.ts is EXEMPT from tm_epoch_tripwire's census (it hosts the
		// PK reader that must see every generation), so the census cannot see
		// this reader lose its epoch narrowing: this OUTCOME is its gate.
		const dead = await mint();
		await writeHistory(dead, 'dead-1');
		await writeHistory(dead, 'dead-2');
		const reborn = await forceRemintOf(dead);
		expect(reborn).toBe(dead);
		await writeHistory(reborn, 'mine-1');
		// CONTROL: all three rows sit at the one address.
		const all = (await sql`
			SELECT count(*)::int AS n FROM matrix_time_machine
			WHERE section_tipo = ${TIPO} AND section_id = ${reborn}
		`) as { n: number }[];
		expect(Number(all[0]?.n)).toBe(3);
		const served = await readTimeMachineHistory(TIPO, reborn, COMPONENT);
		expect(served.map((row) => (row.data as { value?: unknown } | null)?.value)).toEqual([
			'mine-1',
		]);
	});

	test('the backfill write-gate probe sees only the living generation', async () => {
		// hasVisibleLaneHistory is THE probe every backfill door asks (the history
		// writer's save-before, the delete and observer backfills; T1-21). A dead
		// generation's rows answering it would SUPPRESS the reborn record's own
		// backfill. time_machine.ts is exempt from tm_epoch_tripwire's per-statement
		// census, so this OUTCOME is the probe's epoch gate.
		const coords = { sectionTipo: TIPO, sectionId: 0, componentTipo: COMPONENT };
		const dead = await mint();
		await writeHistory(dead, 'dead-1');
		// CONTROL: the probe does see a living record's own history.
		expect(await hasVisibleLaneHistory({ ...coords, sectionId: dead }, 'lg-nolan', false)).toBe(
			true,
		);
		expect(await hasVisibleLaneHistory({ ...coords, sectionId: dead }, 'lg-nolan', true)).toBe(
			true,
		);
		const reborn = await forceRemintOf(dead);
		expect(reborn).toBe(dead);
		// Both lane shapes (one lang / any tag) answer NO for the reborn record.
		expect(await hasVisibleLaneHistory({ ...coords, sectionId: reborn }, 'lg-nolan', false)).toBe(
			false,
		);
		expect(await hasVisibleLaneHistory({ ...coords, sectionId: reborn }, 'lg-nolan', true)).toBe(
			false,
		);
		await writeHistory(reborn, 'mine-1');
		expect(await hasVisibleLaneHistory({ ...coords, sectionId: reborn }, 'lg-nolan', false)).toBe(
			true,
		);
	});

	test('a RESTORE from a dead generation is refused, not performed', async () => {
		// The consequence that matters most. Before this half, the restore's only
		// identity check was (section_tipo, section_id, tipo) — which a re-minted
		// address satisfies exactly — so the dead record's values were written into
		// the living record and answered with ok:true.
		const dead = await mint();
		await writeHistory(dead, 'dead-value');
		const deadRows = (await sql`
			SELECT id FROM matrix_time_machine
			WHERE section_tipo = ${TIPO} AND section_id = ${dead} ORDER BY id DESC LIMIT 1
		`) as { id: number }[];
		const deadTmId = Number(deadRows[0]?.id);
		expect(deadTmId).toBeGreaterThan(0);

		const reborn = await forceRemintOf(dead);
		expect(reborn).toBe(dead);

		let refusal: unknown;
		try {
			await toolTimeMachineApplyValue({
				principal: await resolvePrincipal(-1),
				userId: -1,
				options: {
					section_tipo: TIPO,
					section_id: reborn,
					tipo: COMPONENT,
					lang: 'lg-nolan',
					matrix_id: deadTmId,
				},
				background: false,
			} as never);
		} catch (error) {
			refusal = error;
		}
		// The SPECIFIC refusal — not merely "something threw". An earlier draft of
		// this gate passed on `request.invalid_tipo`, thrown long before the
		// identity check, and so proved nothing.
		expect(isDedaloError(refusal)).toBe(true);
		if (isDedaloError(refusal)) {
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toContain('does not belong');
		}

		// ...and the living record was NOT written.
		const live = (await sql.unsafe(
			`SELECT string::text AS s FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[TIPO, reborn],
		)) as { s: string }[];
		expect(live[0]?.s ?? '').not.toContain('dead-value');
	});

	test('a section RENAME carries the fence with the history it re-keys', async () => {
		// The transform rewrites every matrix_time_machine row's section_tipo. If
		// the epoch store is not re-keyed with it, the fence points at a tipo that
		// no longer exists: recordEpoch answers 0, "no epoch means all history",
		// and the reborn record's panel lists the dead record's snapshots again.
		const RENAMED = `${TLD}8`;
		try {
			const dead = await mint();
			await writeHistory(dead, 'dead');
			const reborn = await forceRemintOf(dead);
			await writeHistory(reborn, 'mine');
			expect(await visibleHistory(reborn)).toBe(1);

			const recorder = new TransformRecorder(false);
			await executeChangesInTipos(
				[{ old: TIPO, new: RENAMED, type: 'section', perform: ['replace_tipo'] }],
				recorder,
			);
			expect(recorder.errors).toEqual([]);

			// The fence moved with the rows: still exactly one visible snapshot.
			expect(await recordEpoch(RENAMED, reborn)).toBeGreaterThan(0);
			const moved = (await sql`
				SELECT count(*)::int AS n FROM matrix_time_machine
				WHERE section_tipo = ${RENAMED} AND section_id = ${reborn}
			`) as { n: number }[];
			expect(Number(moved[0]?.n)).toBe(2); // both generations' rows moved
		} finally {
			await cleanScratchTipo(RENAMED, TABLE);
			await sql`DELETE FROM dedalo_ts_record_generation WHERE section_tipo = ${RENAMED}`;
			await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${RENAMED}`;
		}
	});

	test('the TM PREVIEW pane refuses a dead generation, and serves the record’s own', async () => {
		// The user-visible twin of the restore gate: the preview grafts a chosen
		// snapshot's value over the live record's field. Un-narrowed, it shows the
		// DEAD record's value under the living record's name.
		const { readComponentData } = await import('../../src/core/section/read.ts');
		const dead = await mint();
		await writeHistory(dead, 'dead-value');
		const deadTm = (await sql`
			SELECT id FROM matrix_time_machine
			WHERE section_tipo = ${TIPO} AND section_id = ${dead} ORDER BY id DESC LIMIT 1
		`) as { id: number }[];
		const deadTmId = Number(deadTm[0]?.id);

		const reborn = await forceRemintOf(dead);
		await writeHistory(reborn, 'my-value');
		const mineTm = (await sql`
			SELECT id FROM matrix_time_machine
			WHERE section_tipo = ${TIPO} AND section_id = ${reborn} ORDER BY id DESC LIMIT 1
		`) as { id: number }[];
		const myTmId = Number(mineTm[0]?.id);

		const preview = async (matrixId: number): Promise<unknown[]> =>
			(await readComponentData({
				source: {
					tipo: COMPONENT,
					section_tipo: TIPO,
					section_id: reborn,
					lang: 'lg-nolan',
					data_source: 'tm',
					matrix_id: matrixId,
				},
			} as never)) as unknown[];

		// The dead generation's snapshot is not this record's to preview...
		expect(await preview(deadTmId)).toEqual([]);
		// ...while its OWN snapshot still previews (the positive control, so the
		// gate cannot pass by refusing everything).
		expect((await preview(myTmId)).length).toBeGreaterThan(0);
	});

	test('EXISTING history is grandfathered: no epoch row means all of it', async () => {
		// The state of every record on every install the day this ships.
		const id = await mint();
		await writeHistory(id, 'old-1');
		await writeHistory(id, 'old-2');
		await sql`DELETE FROM dedalo_ts_record_generation WHERE section_tipo = ${TIPO}`;

		expect(await recordEpoch(TIPO, id)).toBe(0);
		expect(await visibleHistory(id)).toBe(2);
	});

	test('an UNDELETE keeps its own history: resurrection opens no epoch', async () => {
		// The subtle half of the rule. A Time Machine SECTION restore re-creates a
		// deleted row at its old address through updateMatrixRecord's insert
		// branch. That is the SAME record continuing — opening an epoch there would
		// cut a curator off from the very history they asked to restore.
		const id = await mint();
		await writeHistory(id, 'before-delete');
		await deleteRecord(id);

		await updateMatrixRecord(TABLE, TIPO, id, {
			string: { [COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: 'restored' }] },
		});

		expect(await recordEpoch(TIPO, id)).toBe(0);
		expect(await visibleHistory(id)).toBe(1);
	});

	test('the counter floor still sees DEAD generations (it must never be epoch-filtered)', async () => {
		// The two halves of P0-14 pull in opposite directions and both are right:
		// history must be fenced, while the ALLOCATOR must keep witnessing the dead
		// ids so it cannot re-mint them. Filtering the floor would re-open half one.
		const dead = await mint();
		await writeHistory(dead, 'dead');
		const reborn = await forceRemintOf(dead);
		expect(await recordEpoch(TIPO, reborn)).toBeGreaterThan(0);

		await writeHistory(reborn, 'mine');
		await deleteRecord(reborn);
		await sql`DELETE FROM matrix_counter WHERE tipo = ${TIPO}`;

		// The bootstrap floor consults TM across ALL generations, so the next id is
		// above every id ever minted here.
		expect(await mint()).toBeGreaterThan(reborn);
	});
});
