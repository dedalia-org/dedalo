/**
 * MALFORMED RELATION VALUES IN TIME MACHINE HISTORY — the dd15 builder's shape
 * gate (src/core/tm_record/relation_snapshot_shape.ts), the history reader's
 * flagged cell (read_tm.ts, `malformed_relation_value`) and compareLocators'
 * non-object refusal (src/core/concepts/locator.ts).
 *
 * THE BUG (owner report, 2026-10-24): Inspector → Component History on a user
 * record, component dd1725 (profile select). Pre-v6 rows store the datum as a
 * BARE section_id (`2`); the dd15 builder wrapped it as `[2]` into the relation
 * column, select-family list labels handed the number to compareLocators, and
 * `'section_tipo' in 2` 500'd the whole history read (internal.unexpected).
 *
 * The v7 reader does NOT convert such values (owner decision: the v6→v7
 * upgrade owns that). It must only never 500: each malformed cell is flagged
 * with a reason, the well-formed rows of the same read still render.
 *
 * The situation is BUILT here on the generic `test` TLD — never read from the
 * ambient DB: a scratch `test65` record (a real section) and TM rows minted
 * through the engine's single TM writer (`recordTimeMachine`), on the suite
 * database (createScratchRecord asserts the marker). Every assertion is
 * addressed by a TM row id captured at mint time; the sweep fails LOUDLY on a
 * 0-row delete.
 *
 *   test91  component_select → dd64 (yes/no)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { compareLocators, type Locator } from '../../src/core/concepts/locator.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { readTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { classifyRelationSnapshot } from '../../src/core/tm_record/relation_snapshot_shape.ts';
import { createScratchRecord } from '../helpers/test_data.ts';

const SECTION_TIPO = 'test65';
const SECTION_ID = 936101; // this gate's own scratch record, swept by exact address
const SELECT_TIPO = 'test91'; // component_select → dd64
const LANG = 'lg-spa';

type Item = Record<string, unknown>;

const yesLocator = {
	id: 1,
	type: 'dd151',
	section_id: 1,
	section_tipo: 'dd64',
	from_component_tipo: SELECT_TIPO,
};

let wellFormedRowId = 0;
let bareIdRowId = 0;
let labelStringsRowId = 0;
let foreignObjectRowId = 0;
let mixedArrayRowId = 0;

async function mint(data: unknown, timestamp: string): Promise<number> {
	await recordTimeMachine(
		{
			sectionTipo: SECTION_TIPO,
			sectionId: SECTION_ID,
			componentTipo: SELECT_TIPO,
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
		[SECTION_TIPO, SECTION_ID, SELECT_TIPO, timestamp],
	)) as { id: number }[];
	const id = rows[0]?.id;
	if (id === undefined) throw new Error(`mint failed @ ${timestamp}`);
	return Number(id);
}

/** The per-record history read (the inspector's Component History surface). */
async function readHistory(ddoTipo: string): Promise<Item[]> {
	const result = await runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
		readTimeMachineData({
			source: { lang: LANG },
			sqo: {
				section_tipo: ['dd15'],
				limit: 50,
				offset: 0,
				filter_by_locators: [{ section_tipo: SECTION_TIPO, section_id: SECTION_ID }],
			},
			show: { ddo_map: [{ tipo: ddoTipo }] },
		} as never),
	);
	const data = result.data as Item[];
	// Floor: the five minted rows each emit a cell — an empty read proves nothing.
	expect(data.slice(1).length).toBeGreaterThanOrEqual(5);
	return data;
}

function cellOf(data: Item[], tmRowId: number, tipo: string): Item {
	const found = data
		.slice(1)
		.filter((item) => item.row_section_id === tmRowId && item.tipo === tipo);
	expect(found.length, `expected exactly one ${tipo} cell on TM row ${tmRowId}`).toBe(1);
	return found[0] as Item;
}

function expectFlagged(cell: Item, reasonFragment: string): void {
	expect(cell.error).toBe('malformed_relation_value');
	expect(Array.isArray(cell.entries) && (cell.entries as unknown[]).length).toBe(0);
	expect(String(cell.reason)).toContain(reasonFragment);
}

beforeAll(async () => {
	await createScratchRecord(SECTION_TIPO, SECTION_ID, {});
	wellFormedRowId = await mint([yesLocator], '2017-01-18 10:00:00');
	bareIdRowId = await mint(2, '2017-01-18 10:00:01');
	labelStringsRowId = await mint(['Hispania'], '2017-01-18 10:00:02');
	foreignObjectRowId = await mint({ label: 'v4', components: {} }, '2017-01-18 10:00:03');
	mixedArrayRowId = await mint([yesLocator, 7], '2017-01-18 10:00:04');
});

afterAll(async () => {
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

describe('Component History over malformed relation values (read_tm + tm_record)', () => {
	test('the read answers and the WELL-FORMED row still renders its label', async () => {
		// Reverted, this read THROWS (TypeError in compareLocators → internal.unexpected).
		const data = await readHistory(SELECT_TIPO);
		const cell = cellOf(data, wellFormedRowId, SELECT_TIPO);
		expect(cell.error).toBeUndefined();
		expect(cell.entries).toEqual(['Sí']);
	});

	test('a BARE section_id (the dd1725 shape) is flagged, NOT converted', async () => {
		expectFlagged(cellOf(await readHistory(SELECT_TIPO), bareIdRowId, SELECT_TIPO), '2');
	});

	test('label strings are flagged with the offending entry in the reason', async () => {
		expectFlagged(
			cellOf(await readHistory(SELECT_TIPO), labelStringsRowId, SELECT_TIPO),
			'Hispania',
		);
	});

	test('a foreign object (not a locator) is flagged, not dropped', async () => {
		expectFlagged(
			cellOf(await readHistory(SELECT_TIPO), foreignObjectRowId, SELECT_TIPO),
			'not a locator array',
		);
	});

	test('a MIXED array is flagged whole — no partial rendering of half a value', async () => {
		expectFlagged(cellOf(await readHistory(SELECT_TIPO), mixedArrayRowId, SELECT_TIPO), '7');
	});

	test('the raw dd1574 copy still carries the stored bytes of a refused row', async () => {
		const raw = cellOf(await readHistory('dd1574'), labelStringsRowId, 'dd1574');
		expect(JSON.stringify(raw)).toContain('Hispania');
	});
});

describe('classifyRelationSnapshot — refuses, never converts', () => {
	test('null → no value; a locator array → verbatim; a single locator → [locator]', () => {
		expect(classifyRelationSnapshot(null)).toEqual({ kind: 'locators', items: null });
		expect(classifyRelationSnapshot([yesLocator])).toEqual({
			kind: 'locators',
			items: [yesLocator],
		});
		expect(classifyRelationSnapshot(yesLocator)).toEqual({ kind: 'locators', items: [yesLocator] });
	});

	test('every non-locator shape is refused (bare id, string, object, label array, unaddressed, null entry)', () => {
		const shapes: unknown[] = [
			2,
			'2',
			true,
			{ '1': 2 },
			['Hispania'],
			[{ type: 'dd151', from_component_tipo: SELECT_TIPO }],
			[null],
		];
		for (const shape of shapes) {
			expect(classifyRelationSnapshot(shape).kind, JSON.stringify(shape)).toBe('refused');
		}
	});
});

describe('compareLocators — a non-object side equals nothing (never throws)', () => {
	test.each([[2], ['dd64'], [null], [undefined], [['dd64']]])(
		'%p vs a locator → false',
		(value) => {
			const locator = { section_tipo: 'dd64', section_id: 2 } as Locator;
			expect(
				compareLocators(value as unknown as Locator, locator, ['section_tipo', 'section_id']),
			).toBe(false);
			expect(compareLocators(locator, value as unknown as Locator)).toBe(false);
		},
	);

	test('between two objects the law is unchanged (loose section_id)', () => {
		expect(
			compareLocators(
				{ section_tipo: 'dd64', section_id: 2 } as Locator,
				{ section_tipo: 'dd64', section_id: '2' } as Locator,
				['section_tipo', 'section_id'],
			),
		).toBe(true);
	});
});
