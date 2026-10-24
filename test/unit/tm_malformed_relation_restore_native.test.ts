/**
 * MALFORMED RELATION SNAPSHOTS IN THE TIME MACHINE TOOL — the preview pane
 * (section/read.ts readComponentData, data_source 'tm') and the restore doors
 * (tools/tool_time_machine apply_value: the component restore and the
 * whole-record restore) run a relation snapshot through the shape gate
 * (src/core/tm_record/relation_snapshot_shape.ts). Sibling of
 * tm_malformed_relation_value_native (the dd15 history list).
 *
 * WC-2026-10-24-tm-malformed-relation-cell. No conversion (owner decision): a
 * pre-v6 bare id is NOT turned into a locator by v7.
 *
 *   - preview of a malformed row → the component item flagged
 *     `malformed_relation_value` with a reason, entries EMPTY — never the
 *     non-locator handed to the client (before: the bare id was grafted into
 *     the relation key and the select reader threw on it);
 *   - restore of a malformed row (component or whole record) → REFUSED with
 *     `tool.snapshot_unrestorable`, the live relation column UNCHANGED (before:
 *     the bare id was written into the live column);
 *   - a well-formed row previews and restores as before.
 *
 * BUILT on the suite DB, `test` TLD: a scratch `test65` record and TM rows
 * minted through `recordTimeMachine`; activity + TM rows of the record swept
 * after, loudly.
 *
 *   test91  component_select → dd64 (1 = Sí, 2 = No)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { createScratchRecord } from '../helpers/test_data.ts';

const SECTION_TIPO = 'test65';
const SECTION_ID = 936102; // this gate's own scratch record, swept by exact address
const SELECT_TIPO = 'test91';
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

type Item = Record<string, unknown>;

const locatorTo = (sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: 'dd64',
	from_component_tipo: SELECT_TIPO,
});
const LIVE_VALUE = [locatorTo(2)];

let bareIdRowId = 0;
let wellFormedRowId = 0;
let malformedWholeRowId = 0;

async function mint(componentTipo: string, data: unknown, timestamp: string): Promise<number> {
	await recordTimeMachine(
		{
			sectionTipo: SECTION_TIPO,
			sectionId: SECTION_ID,
			componentTipo,
			lang: 'lg-nolan',
			userId: -1,
			data,
		},
		timestamp,
	);
	const rows = (await sql.unsafe(
		`SELECT id FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND timestamp = $4
		 ORDER BY id DESC LIMIT 1`,
		[SECTION_TIPO, SECTION_ID, componentTipo, timestamp],
	)) as { id: number }[];
	const id = rows[0]?.id;
	if (id === undefined) throw new Error(`mint failed: ${componentTipo} @ ${timestamp}`);
	return Number(id);
}

async function liveSelectValue(): Promise<unknown> {
	const record = await readMatrixRecord('matrix_test', SECTION_TIPO, SECTION_ID);
	return (record?.columns.relation as Record<string, unknown> | null)?.[SELECT_TIPO];
}

async function previewItem(matrixId: number): Promise<Item> {
	const items = (await readComponentData({
		source: {
			tipo: SELECT_TIPO,
			section_tipo: SECTION_TIPO,
			section_id: SECTION_ID,
			lang: 'lg-nolan',
			mode: 'edit',
			data_source: 'tm',
			matrix_id: matrixId,
		},
	} as never)) as Item[];
	const own = items.filter((item) => item.tipo === SELECT_TIPO);
	expect(own.length, 'the preview answers exactly one item for the component').toBe(1);
	return own[0] as Item;
}

function restore(tipo: string, matrixId: number) {
	return toolTimeMachineApplyValue({
		principal: ADMIN,
		userId: ADMIN.userId,
		options: {
			section_tipo: SECTION_TIPO,
			section_id: SECTION_ID,
			tipo,
			lang: 'lg-nolan',
			matrix_id: matrixId,
		},
		background: false,
	} as never);
}

beforeAll(async () => {
	await createScratchRecord(SECTION_TIPO, SECTION_ID, { relation: { [SELECT_TIPO]: LIVE_VALUE } });
	bareIdRowId = await mint(SELECT_TIPO, 1, '2017-01-18 10:00:00');
	wellFormedRowId = await mint(SELECT_TIPO, [locatorTo(1)], '2017-01-18 10:00:01');
	malformedWholeRowId = await mint(
		SECTION_TIPO,
		{ relation: { [SELECT_TIPO]: 1 } },
		'2017-01-18 10:00:02',
	);
});

afterAll(async () => {
	await sweepActivityRows(SECTION_TIPO, [SECTION_ID]);
	const tm = (await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 RETURNING id',
		[SECTION_TIPO, SECTION_ID],
	)) as unknown[];
	const record = (await sql.unsafe(
		'DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2 RETURNING section_id',
		[SECTION_TIPO, SECTION_ID],
	)) as unknown[];
	if (tm.length === 0 || record.length === 0) throw new Error('scratch sweep deleted 0 rows');
});

describe('TM preview pane over a malformed relation snapshot', () => {
	test('a bare-id row previews FLAGGED, entries empty, the datalist intact', async () => {
		// Reverted, the read throws (the bare id reaches the select reader).
		const item = await previewItem(bareIdRowId);
		expect(item.error).toBe('malformed_relation_value');
		expect(String(item.reason)).toContain('not a locator array');
		expect(Array.isArray(item.entries) && (item.entries as unknown[]).length).toBe(0);
		expect((item.datalist as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0);
	});

	test('a well-formed row previews its locator, unflagged', async () => {
		const item = await previewItem(wellFormedRowId);
		expect(item.error).toBeUndefined();
		expect(item.entries).toEqual([locatorTo(1)]);
	});
});

describe('TM restore (apply_value) over a malformed relation snapshot', () => {
	test('a bare-id component row is REFUSED and the live column is unchanged', async () => {
		const refusal = await refusalOf(restore(SELECT_TIPO, bareIdRowId));
		expect(refusal.code).toBe('tool.snapshot_unrestorable');
		expect(await liveSelectValue()).toEqual(LIVE_VALUE);
	});

	test('a whole-record row carrying a non-locator relation value is REFUSED whole', async () => {
		const refusal = await refusalOf(restore(SECTION_TIPO, malformedWholeRowId));
		expect(refusal.code).toBe('tool.snapshot_unrestorable');
		expect(await liveSelectValue()).toEqual(LIVE_VALUE);
	});

	test('a well-formed row restores as before', async () => {
		const answer = (await restore(SELECT_TIPO, wellFormedRowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);
		const live = (await liveSelectValue()) as Item[];
		expect(live.map((locator) => [locator.section_tipo, locator.section_id])).toEqual([
			['dd64', 1],
		]);
	});
});
