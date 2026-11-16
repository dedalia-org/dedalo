/**
 * component_number TYPE / PRECISION ON THE SERVER (T1-40 / O06, OX2) —
 * `engineering/wire_contract/WC-2026-11-12-number-type-precision-on-save.md`,
 * law: `src/core/components/component_number/number_format.ts`.
 *
 * Measured on HEAD 5756cb7aa3 before the change: every door other than the
 * client edit view stored a number exactly as sent — `1.23456` on a
 * `{type:'float',precision:2}` node, `3.7` on an `{type:'int'}` node — through
 * the save door (MCP set_field, agent change-plan, propagate, API) and through
 * the import conform (a JSON cell was never cast; a string cell never rounded).
 * PHP applied `set_format_form_type` in `set_data` on every write.
 *
 * WHAT THIS GATE PROVES, on a situation it BUILDS:
 *
 *   A  the law, pure: half-away-from-zero DECIMAL rounding (1.005 → 1.01, never
 *      toFixed's 1.00), int truncation toward zero, no `-0`, precision 0 and
 *      negative precision, high precision exact, untyped identity, a
 *      non-integer precision refused loudly (`ontology.invalid_node`).
 *   B  through saveComponentData (update / insert / set_data): the stored
 *      number column carries the formatted value; ids / id_key / null slots
 *      kept; the save echo carries what was stored; an untyped node and `0`
 *      unchanged (controls); a bad-precision node refuses and writes NOTHING.
 *   C  the import conform: the preview shows what will be stored — string and
 *      JSON cells formatted; a bad-precision node fails the CELL, naming it.
 *   D  the repair door: tool_update_cache regenerate over a value stored
 *      unrounded (a TS-era import) re-saves it formatted.
 *   E  the bad-precision refusal is LAZY (T1-40 review), as PHP's was: the
 *      format is resolved only when a finite number is about to be formatted.
 *      A clear (null value / empty set_data) on a bad-precision node saves; the
 *      tree's order read (`fetchNodeInfo`, behind every ts_object / tree-search
 *      / list_thesaurus read) answers a section whose order node is malformed
 *      while no row carries an order value, and refuses (`ontology.invalid_node`)
 *      only when it must format one — never eagerly per section group.
 *
 * Generic `test` TLD, situation-built (AGENTS.md hard rules): section `zznfm1`
 * on matrix_test (via test24). Cleaned before and after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	formatNumber,
	formatNumberItems,
	NUMBER_FORMAT_NONE,
	numberFormatOf,
} from '../../src/core/components/component_number/number_format.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { type DedaloError, isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { getSectionMap } from '../../src/core/ontology/section_map.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { conformImportData } from '../../src/core/tools/import_data.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { fetchNodeInfo } from '../../src/core/ts_object/node_repository.ts';
import { mustGet } from '../helpers/assert.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';
const SECTION_TIPO = 'zznfm1';
const FLOAT2 = 'zznfm2'; // {type:'float', precision:2}
const INT = 'zznfm3'; // {type:'int'}
const FLOAT0 = 'zznfm4'; // {type:'float', precision:0}
const UNTYPED = 'zznfm5'; // no properties
const FLOAT_DEFAULT = 'zznfm6'; // {type:'float'} → precision 2
const BAD_PRECISION = 'zznfm7'; // {type:'float', precision:'2'} → refused
const LEGACY_OBJECT = 'zznfm8'; // {type:{float:3}} → float, precision default 2 (PHP)
const FLOAT16 = 'zznfm9'; // {type:'float', precision:16}
const SECTION_MAP = 'zznfm12'; // section_map: thesaurus.order → BAD_PRECISION (gate E)
const RECORD_ID = 900840;
const ANCHOR_ID = 900841;
const REPAIR_ID = 900842;
const TREE_EMPTY_ID = 900843; // no order value
const TREE_VALUED_ID = 900844; // an order value on the bad-precision node
const bulkIds: number[] = [];

const numberNode = (tipo: string, properties: Record<string, unknown> | null) => ({
	tipo,
	parent: SECTION_TIPO,
	model: 'component_number',
	term: { 'lg-eng': `Number ${tipo}` },
	...(properties === null ? {} : { properties }),
});

const SITUATION = situation({
	tld: 'zznfm',
	name: 'number_format',
	nodes: [
		{
			tipo: SECTION_TIPO,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Formato número', 'lg-eng': 'Number format' },
			relations: [{ tipo: 'test24' }],
		},
		numberNode(FLOAT2, { type: 'float', precision: 2 }),
		numberNode(INT, { type: 'int' }),
		numberNode(FLOAT0, { type: 'float', precision: 0 }),
		numberNode(UNTYPED, null),
		numberNode(FLOAT_DEFAULT, { type: 'float' }),
		numberNode(BAD_PRECISION, { type: 'float', precision: '2' }),
		numberNode(LEGACY_OBJECT, { type: { float: 3 } }),
		numberNode(FLOAT16, { type: 'float', precision: 16 }),
		{
			tipo: SECTION_MAP,
			parent: SECTION_TIPO,
			model: 'section_map',
			term: { 'lg-eng': 'Section map' },
			properties: { thesaurus: { order: BAD_PRECISION } },
		},
	],
	records: [{ section_tipo: SECTION_TIPO, section_id: ANCHOR_ID }],
});

const ALL_NUMBERS = [
	FLOAT2,
	INT,
	FLOAT0,
	UNTYPED,
	FLOAT_DEFAULT,
	BAD_PRECISION,
	LEGACY_OBJECT,
	FLOAT16,
];
const SEED = {
	number: Object.fromEntries(ALL_NUMBERS.map((tipo) => [tipo, [{ id: 1, value: 1 }]])),
	meta: Object.fromEntries(ALL_NUMBERS.map((tipo) => [tipo, [{ count: 1 }]])),
};

async function reseed(): Promise<void> {
	await cleanScratchRecord(SECTION_TIPO, RECORD_ID, TABLE);
	await createScratchRecord(SECTION_TIPO, RECORD_ID, SEED, { table: TABLE });
}

type Change = { action: string; id?: unknown; value?: unknown };

function save(tipo: string, changes: Change[], sectionId = RECORD_ID) {
	return saveComponentData({
		componentTipo: tipo,
		sectionTipo: SECTION_TIPO,
		sectionId,
		lang: 'lg-nolan',
		changedData: changes as never,
		userId: -1,
	});
}

async function stored(tipo: string, sectionId = RECORD_ID): Promise<unknown[] | undefined> {
	const record = await readMatrixRecord(TABLE, SECTION_TIPO, sectionId);
	return (record?.columns.number as Record<string, unknown[]> | null)?.[tipo];
}

async function storedValues(tipo: string): Promise<unknown[]> {
	return ((await stored(tipo)) ?? []).map((item) => (item as { value: unknown }).value);
}

async function refusalOf(run: Promise<unknown>): Promise<DedaloError> {
	try {
		await run;
	} catch (error) {
		if (isDedaloError(error)) return error;
		throw error;
	}
	throw new Error('expected a DedaloError, but the call succeeded');
}

async function tmRowCount(): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_time_machine
		WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${RECORD_ID}
	`) as { n: number }[];
	return rows[0]?.n ?? 0;
}

describe('A. the number format law, pure', () => {
	const float = (precision: number) => numberFormatOf({ type: 'float', precision }, 'zznfm10');
	const INT_FORMAT = numberFormatOf({ type: 'int' }, 'zznfm10');

	test('float rounds half away from zero, on the decimal representation', () => {
		const cases: [number, number, number][] = [
			[1.23456, 2, 1.23],
			[1.005, 2, 1.01],
			[-1.005, 2, -1.01],
			[2.675, 2, 2.68],
			[0.1 + 0.2, 2, 0.3],
			[85.3568, 2, 85.36],
			[2.5, 0, 3],
			[-2.5, 0, -3],
			[0.005, 2, 0.01],
			[0.004, 2, 0],
			[9.995, 2, 10],
			[1234, -2, 1200],
			[1250, -2, 1300],
			[49, -2, 0],
			[1e-7, 2, 0],
			[1.5e-7, 7, 2e-7],
		];
		for (const [value, precision, expected] of cases) {
			expect([value, precision, formatNumber(value, float(precision))]).toEqual([
				value,
				precision,
				expected,
			]);
		}
		// Within precision: returned bit for bit (high precision is never truncated).
		expect(formatNumber(0.1234567890123456, float(16))).toBe(0.1234567890123456);
		expect(formatNumber(1e21, float(2))).toBe(1e21);
		expect(formatNumber(2, float(2))).toBe(2);
		// No negative zero.
		expect(Object.is(formatNumber(-0.001, float(2)), 0)).toBe(true);
	});

	test('int truncates toward zero; untyped is identity; 0 stays 0', () => {
		expect(formatNumber(3.7, INT_FORMAT)).toBe(3);
		expect(formatNumber(-3.7, INT_FORMAT)).toBe(-3);
		expect(Object.is(formatNumber(-0.5, INT_FORMAT), 0)).toBe(true);
		expect(formatNumber(1.23456, NUMBER_FORMAT_NONE)).toBe(1.23456);
		expect(formatNumber(0, float(2))).toBe(0);
		expect(formatNumber(0, INT_FORMAT)).toBe(0);
	});

	test('numberFormatOf: PHP empty(type) → none; int; anything else → float(precision ?? 2)', () => {
		for (const props of [null, undefined, {}, { type: '' }, { type: null }, { type: '0' }, 'x']) {
			expect(numberFormatOf(props, 'zznfm10')).toEqual(NUMBER_FORMAT_NONE);
		}
		expect(numberFormatOf({ type: 'int', precision: 4 }, 'zznfm10').kind).toBe('int');
		expect(numberFormatOf({ type: 'float' }, 'zznfm10')).toEqual({ kind: 'float', precision: 2 });
		expect(numberFormatOf({ type: { float: 3 } }, 'zznfm10')).toEqual({
			kind: 'float',
			precision: 2,
		});
		expect(numberFormatOf({ type: 'decimal', precision: 3 }, 'zznfm10')).toEqual({
			kind: 'float',
			precision: 3,
		});
	});

	test('a non-integer precision is refused loudly, naming the node', () => {
		for (const precision of ['2', 2.5, true, { n: 2 }]) {
			let caught: unknown = null;
			try {
				numberFormatOf({ type: 'float', precision }, 'zznfm11');
			} catch (error) {
				caught = error;
			}
			expect(isDedaloError(caught)).toBe(true);
			expect((caught as DedaloError).code).toBe('ontology.invalid_node');
			expect((caught as DedaloError).message).toContain('zznfm11');
		}
	});

	test('formatNumberItems: only finite `value`s change; every other field kept', () => {
		const items = [
			{ id: 1, id_key: 7, value: 1.23456 },
			{ id: 2, value: null },
			{ id: 3 },
			{ id: 4, value: 2 },
		];
		expect(formatNumberItems(items, float(2))).toEqual([
			{ id: 1, id_key: 7, value: 1.23 },
			{ id: 2, value: null },
			{ id: 3 },
			{ id: 4, value: 2 },
		]);
		const unchanged = [{ id: 1, value: 2 }];
		expect(formatNumberItems(unchanged, float(2))).toBe(unchanged);
	});
});

describe('B–D. the server stores what the node declares', () => {
	beforeAll(async () => {
		await ensureSituation(SITUATION);
		expect(await getMatrixTableFromTipo(SECTION_TIPO)).toBe(TABLE);
		await cleanScratchRecord(SECTION_TIPO, REPAIR_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, TREE_EMPTY_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, TREE_VALUED_ID, TABLE);
		await reseed();
	});
	afterAll(async () => {
		await cleanScratchRecord(SECTION_TIPO, RECORD_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, REPAIR_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, TREE_EMPTY_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, TREE_VALUED_ID, TABLE);
		for (const bulkId of bulkIds) {
			await sql`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = ${bulkId}`;
		}
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('B1. update on float/2 stores the rounded value; the echo carries it', async () => {
		await reseed();
		const result = await save(FLOAT2, [
			{ action: 'update', id: 1, value: { id: 1, value: 1.23456 } },
		]);
		expect(result.ok, JSON.stringify(result)).toBe(true);
		expect(await stored(FLOAT2)).toEqual([{ id: 1, value: 1.23 }]);
		expect(JSON.stringify((result as { data?: unknown }).data)).toContain('1.23');
		expect(JSON.stringify((result as { data?: unknown }).data)).not.toContain('1.23456');
	});

	test('B2–B5. int truncates, precision 0 rounds, float default and legacy object → 2', async () => {
		await reseed();
		const cases: [string, number, number][] = [
			[INT, 3.7, 3],
			[INT, -3.7, -3],
			[FLOAT0, 2.5, 3],
			[FLOAT_DEFAULT, 1.23456, 1.23],
			[LEGACY_OBJECT, 1.23456, 1.23],
		];
		for (const [tipo, value, expected] of cases) {
			const result = await save(tipo, [{ action: 'update', id: 1, value: { id: 1, value } }]);
			expect(result.ok, `${tipo} ${JSON.stringify(result)}`).toBe(true);
			expect([tipo, value, await storedValues(tipo)]).toEqual([tipo, value, [expected]]);
		}
	});

	test('B6. set_data and insert format every item; ids, id_key and null slots kept', async () => {
		await reseed();
		const set = await save(FLOAT2, [
			{
				action: 'set_data',
				value: [
					{ id: 1, value: 1.23456 },
					{ id: 2, value: null },
					{ id: 3, id_key: 9, value: 2.675 },
				],
			},
		]);
		expect(set.ok, JSON.stringify(set)).toBe(true);
		expect(await stored(FLOAT2)).toEqual([
			{ id: 1, value: 1.23 },
			{ id: 2, value: null },
			{ id: 3, id_key: 9, value: 2.68 },
		]);
		const inserted = await save(INT, [{ action: 'insert', value: { value: 9.99 } }]);
		expect(inserted.ok, JSON.stringify(inserted)).toBe(true);
		expect(await storedValues(INT)).toEqual([1, 9]);
	});

	test('B7–B8, B11. CONTROLS: untyped unchanged, 0 kept, high precision exact', async () => {
		await reseed();
		const cases: [string, number][] = [
			[UNTYPED, 1.23456],
			[FLOAT2, 0],
			[INT, 0],
			[FLOAT16, 0.1234567890123456],
		];
		for (const [tipo, value] of cases) {
			const result = await save(tipo, [{ action: 'update', id: 1, value: { id: 1, value } }]);
			expect(result.ok, `${tipo} ${JSON.stringify(result)}`).toBe(true);
			expect([tipo, await storedValues(tipo)]).toEqual([tipo, [value]]);
		}
	});

	test('B9. a non-integer precision refuses the save and writes nothing', async () => {
		await reseed();
		const before = await readMatrixRecord(TABLE, SECTION_TIPO, RECORD_ID);
		const tmBefore = await tmRowCount();
		const refusal = await refusalOf(
			save(BAD_PRECISION, [{ action: 'update', id: 1, value: { id: 1, value: 1.23456 } }]),
		);
		expect(refusal.code).toBe('ontology.invalid_node');
		expect(refusal.message).toContain(BAD_PRECISION);
		const after = await readMatrixRecord(TABLE, SECTION_TIPO, RECORD_ID);
		expect(after?.columns.number).toEqual(before?.columns.number);
		expect(await tmRowCount()).toBe(tmBefore);
	});

	test('C. import conform: the preview is what will be stored', async () => {
		const conform = (componentTipo: string, importValue: string, decimal?: string) =>
			conformImportData({
				model: 'component_number',
				importValue,
				columnName: componentTipo,
				sectionTipo: SECTION_TIPO,
				sectionId: 7,
				componentTipo,
				lang: 'lg-nolan',
				wrapped: false,
				...(decimal === undefined ? {} : { decimal }),
			});
		expect((await conform(FLOAT2, '1,23456', ',')).result).toEqual([{ value: 1.23 }]);
		expect((await conform(FLOAT2, '1.23456')).result).toEqual([{ value: 1.23 }]);
		expect((await conform(FLOAT2, '[1.23456]')).result).toEqual([{ value: 1.23 }]);
		expect((await conform(FLOAT2, '[{"id":4,"value":"2.675"}]')).result).toEqual([
			{ id: 4, value: 2.68 },
		]);
		expect((await conform(INT, '[3.7]')).result).toEqual([{ value: 3 }]);
		expect((await conform(INT, '3.7')).result).toEqual([{ value: 3 }]); // control (PHP intval)
		expect((await conform(UNTYPED, '1.23456')).result).toEqual([{ value: 1.23456 }]); // control
		const bad = await conform(BAD_PRECISION, '1.23456');
		expect(bad.result).toBeNull();
		expect(JSON.stringify(bad.errors)).toContain(BAD_PRECISION);
		expect(JSON.stringify(bad.errors)).toContain('precision');
		// T1-40 review: the refusal is lazy — a cell with no number to shape conforms.
		expect((await conform(BAD_PRECISION, '[{"id":1,"value":null}]')).result).toEqual([
			{ id: 1, value: null },
		]);
		expect(JSON.stringify((await conform(BAD_PRECISION, '[2]')).errors)).toContain(BAD_PRECISION);
	});

	test('D. repair door: update_cache regenerate re-saves an unrounded stored value formatted', async () => {
		await createScratchRecord(
			SECTION_TIPO,
			REPAIR_ID,
			{ number: { [FLOAT2]: [{ id: 1, value: 1.23456 }] }, meta: { [FLOAT2]: [{ count: 1 }] } },
			{ table: TABLE },
		);
		// FLOOR: the record really holds the unrounded value.
		expect(await stored(FLOAT2, REPAIR_ID)).toEqual([{ id: 1, value: 1.23456 }]);
		const cache = await getLoadedTool('tool_update_cache');
		const regenerate = await mustGet(cache?.module.apiActions.update_cache, 'update_cache').handler(
			{
				principal: await resolvePrincipal(-1),
				userId: -1,
				background: true,
				publishProgress: () => {},
				options: {
					section_tipo: SECTION_TIPO,
					components_selection: [{ tipo: FLOAT2 }],
					sqo: {
						section_tipo: [SECTION_TIPO],
						filter_by_locators: [{ section_tipo: SECTION_TIPO, section_id: String(REPAIR_ID) }],
					},
				},
			},
		);
		expect(regenerate.ok, JSON.stringify(regenerate)).toBe(true);
		const run = regenerate.data as { regenerated: number; bulk_process_id?: unknown };
		if (typeof run.bulk_process_id === 'number') bulkIds.push(run.bulk_process_id);
		expect(run.regenerated).toBe(1);
		expect(await stored(FLOAT2, REPAIR_ID)).toEqual([{ id: 1, value: 1.23 }]);
	}, 60000);

	test('E1. a clear on a bad-precision node saves (no number to format → no refusal)', async () => {
		await reseed();
		// The client's empty slot is `{value: null}` (value_shape.ts).
		const cleared = await save(BAD_PRECISION, [
			{ action: 'update', id: 1, value: { id: 1, value: null } },
		]);
		expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
		expect(await storedValues(BAD_PRECISION)).not.toContain(1);
		await reseed();
		const emptied = await save(BAD_PRECISION, [{ action: 'set_data', value: null }]);
		expect(emptied.ok, JSON.stringify(emptied)).toBe(true);
		expect(await storedValues(BAD_PRECISION)).toEqual([]);
		// CONTROL: a number on the same node is still refused.
		const refusal = await refusalOf(
			save(BAD_PRECISION, [{ action: 'insert', value: { value: 1.23456 } }]),
		);
		expect(refusal.code).toBe('ontology.invalid_node');
	});

	test('E2. tree order read: a malformed order node refuses only a value it must format', async () => {
		await createScratchRecord(SECTION_TIPO, TREE_EMPTY_ID, { meta: {} }, { table: TABLE });
		await createScratchRecord(
			SECTION_TIPO,
			TREE_VALUED_ID,
			{
				number: { [BAD_PRECISION]: [{ id: 1, value: 1.23456 }] },
				meta: { [BAD_PRECISION]: [{ count: 1 }] },
			},
			{ table: TABLE },
		);
		// FLOOR: the section really names the malformed node as its order.
		expect(
			((await getSectionMap(SECTION_TIPO))?.thesaurus as { order?: unknown } | undefined)?.order,
		).toBe(BAD_PRECISION);
		const info = await fetchNodeInfo([{ section_tipo: SECTION_TIPO, section_id: TREE_EMPTY_ID }]);
		expect(info.get(`${SECTION_TIPO}_${TREE_EMPTY_ID}`)).toEqual({
			order: null,
			is_indexable: false,
		});
		const refusal = await refusalOf(
			fetchNodeInfo([{ section_tipo: SECTION_TIPO, section_id: TREE_VALUED_ID }]),
		);
		expect(refusal.code).toBe('ontology.invalid_node');
		expect(refusal.message).toContain(BAD_PRECISION);
	});
});
