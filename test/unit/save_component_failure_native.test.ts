/**
 * WRITE-PATH PROPAGATION GATE (P3, ERRORS_SPEC §8) — the component save door.
 *
 * `saveComponentData` runs the whole change application inside ONE
 * transaction (S1-02): row lock, record materialisation, item-id allocation,
 * data write, Time Machine row. CONVENTIONS §1 says every integrity failure
 * between "client asked to persist X" and COMMIT must PROPAGATE to the caller
 * and roll the transaction back — never be absorbed into a soft
 * `{ok:false}`. Now that the guards are TYPED (`internal.invariant`,
 * `request.invalid_data`, `record.external_write_refused`), this gate proves
 * the typing did not change that:
 *
 *   A. an existing scratch twin: an `insert` without id ALLOCATES an item id
 *      (a meta-counter UPDATE lands inside the tx), then the json_codec guard
 *      fires on the value → the DedaloError reaches the caller, the counter
 *      and the data column are byte-unchanged, no TM row was appended;
 *   B. an ABSENT row: a save never creates a record (WC-2026-11-10-save-never-creates
 *      — nor did PHP v6/v7), so it is refused `resource.not_found` inside the tx
 *      BEFORE the value guards run → the row still does not exist, no TM row;
 *   C. the caller-fault refusals (`request.invalid_data`) throw the typed
 *      code and write nothing.
 *
 * Scratch pattern: the situation this file BUILDS — one section on matrix_test
 * and one translatable component_input_text (→ `string` column), whose ontology
 * drives the save. Cleaned before and after.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The twin
// used to be a CLONE of the ambient install record `numisdata6/1` read straight out
// of `matrix`, driven through the install component `numisdata16`; both are now
// authored here (`zzfail`), and the seeded row carries an explicit non-null `meta`
// counter so case A's "the allocation was rolled back" assertion compares a real
// stored value instead of null against null.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { type DedaloError, isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

/**
 * Where the section's records live. STATED here and PROVEN in beforeAll
 * against `getMatrixTableFromTipo` — the test24 relation is what puts them in
 * `matrix_test`, and a gate that only assumed it would write to `matrix`.
 */
const TABLE = 'matrix_test';
const SECTION_TIPO = 'zzfail1';
const EXISTING_ID = 900011;
const UNBORN_ID = 900012;
/** component_input_text, translatable → 'string' column. */
const COMPONENT = 'zzfail2';
/**
 * An anchor record: dropSituation scopes its sweep to the sections the
 * situation declares records for, so the section needs one to be torn down whole.
 */
const ANCHOR_ID = 900010;

const SITUATION = situation({
	tld: 'zzfail',
	name: 'save_component_failure',
	nodes: [
		{
			tipo: SECTION_TIPO,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Fallo al guardar', 'lg-eng': 'Save failure' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: COMPONENT,
			parent: SECTION_TIPO,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'Texto', 'lg-eng': 'Text' },
		},
	],
	records: [{ section_tipo: SECTION_TIPO, section_id: ANCHOR_ID }],
});

/**
 * The seeded twin: items in two languages AND a non-null `meta` counter, so
 * the meta UPDATE case A rolls back has a real value to be compared against
 * (a null-vs-null comparison would pass without the rollback happening).
 */
const SEED_COLUMNS = {
	string: { [COMPONENT]: [{ id: 3, lang: 'lg-spa', value: 'sembrado' }] },
	meta: { [COMPONENT]: [{ count: 3 }] },
};

async function refusalOf(run: Promise<unknown>): Promise<DedaloError> {
	try {
		await run;
	} catch (error) {
		if (isDedaloError(error)) return error;
		throw error;
	}
	throw new Error('expected a DedaloError, but the save succeeded');
}

async function tmRowCount(sectionId: number): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_time_machine
		WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${sectionId}
	`) as { n: number }[];
	return rows[0]?.n ?? 0;
}

describe('save_component failure propagation (write paths never absorb integrity errors)', () => {
	beforeAll(async () => {
		await ensureSituation(SITUATION);
		expect(await getMatrixTableFromTipo(SECTION_TIPO)).toBe(TABLE);
		await cleanScratchRecord(SECTION_TIPO, EXISTING_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, UNBORN_ID, TABLE);
		await createScratchRecord(SECTION_TIPO, EXISTING_ID, SEED_COLUMNS, { table: TABLE });
	});
	afterAll(async () => {
		await cleanScratchRecord(SECTION_TIPO, EXISTING_ID, TABLE);
		await cleanScratchRecord(SECTION_TIPO, UNBORN_ID, TABLE);
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('A. allocation landed, then the json_codec guard fired: DedaloError out, counter + column + TM unchanged', async () => {
		const before = await readMatrixRecord(TABLE, SECTION_TIPO, EXISTING_ID);
		expect(before).not.toBeNull();
		const tmBefore = await tmRowCount(EXISTING_ID);

		const error = await refusalOf(
			saveComponentData({
				componentTipo: COMPONENT,
				sectionTipo: SECTION_TIPO,
				sectionId: EXISTING_ID,
				lang: 'lg-spa',
				// No id → allocateComponentItemId writes meta.<tipo>[0].count inside
				// the tx BEFORE the value is encoded; NaN is not JSON → the guard.
				// The NaN rides an UNTYPED field: a NaN `value` is refused earlier, by the
				// value-shape law (value_shape.ts), and would never reach the guard.
				changedData: [
					{ action: 'insert', value: { lang: 'lg-spa', value: 'x', note: Number.NaN } },
				],
				userId: -1,
			}),
		);
		expect(error.code).toBe('internal.invariant');
		expect(error.message).toContain('json_codec: non-finite number');

		const after = await readMatrixRecord(TABLE, SECTION_TIPO, EXISTING_ID);
		// The meta counter UPDATE that ran inside the tx is rolled back…
		expect(after?.rawText.meta ?? null).toBe(before?.rawText.meta ?? null);
		// …the data column is byte-identical, and no audit row was appended.
		expect(after?.rawText.string).toBe(before?.rawText.string);
		expect(await tmRowCount(EXISTING_ID)).toBe(tmBefore);
	});

	test('A-control (anti-vacuity): the SAME insert with a JSON-safe value does move the counter, the column and TM', async () => {
		const before = await readMatrixRecord(TABLE, SECTION_TIPO, EXISTING_ID);
		const tmBefore = await tmRowCount(EXISTING_ID);
		const outcome = await saveComponentData({
			componentTipo: COMPONENT,
			sectionTipo: SECTION_TIPO,
			sectionId: EXISTING_ID,
			lang: 'lg-spa',
			changedData: [{ action: 'insert', value: { lang: 'lg-spa', value: 'control' } }],
			userId: -1,
		});
		expect(outcome.ok).toBe(true);
		const after = await readMatrixRecord(TABLE, SECTION_TIPO, EXISTING_ID);
		expect(after?.rawText.meta ?? null).not.toBe(before?.rawText.meta ?? null);
		expect(after?.rawText.string).toContain('control');
		// +2, re-pinned 2026-11-12 (T1-21): the record is seeded RAW ('sembrado', no
		// history), so the save first records that lg-spa value (the save-before) —
		// then its own row.
		expect(await tmRowCount(EXISTING_ID)).toBe(tmBefore + 2);
	});

	test('B. a save to an absent row is refused resource.not_found and creates nothing', async () => {
		expect(await readMatrixRecord(TABLE, SECTION_TIPO, UNBORN_ID)).toBeNull();
		const error = await refusalOf(
			saveComponentData({
				componentTipo: COMPONENT,
				sectionTipo: SECTION_TIPO,
				sectionId: UNBORN_ID,
				lang: 'lg-spa',
				// The NaN rides an UNTYPED field: a NaN `value` is refused earlier, by the
				// value-shape law (value_shape.ts), and would never reach the guard.
				changedData: [
					{ action: 'insert', value: { lang: 'lg-spa', value: 'x', note: Number.NaN } },
				],
				userId: -1,
			}),
		);
		// The existence refusal precedes the json_codec guard the NaN would trip.
		expect(error.code).toBe('resource.not_found');
		expect(await readMatrixRecord(TABLE, SECTION_TIPO, UNBORN_ID)).toBeNull();
		expect(await tmRowCount(UNBORN_ID)).toBe(0);
	});

	test('C. caller faults are typed request.invalid_data and write nothing', async () => {
		const before = await readMatrixRecord(TABLE, SECTION_TIPO, EXISTING_ID);
		const notAnObject = await refusalOf(
			saveComponentData({
				componentTipo: COMPONENT,
				sectionTipo: SECTION_TIPO,
				sectionId: EXISTING_ID,
				lang: 'lg-spa',
				changedData: [{ action: 'insert', value: 'not an item' }],
				userId: -1,
			}),
		);
		expect(notAnObject.code).toBe('request.invalid_data');
		// The value-shape law (value_shape.ts) answers before the transaction opens.
		expect(notAnObject.message).toContain('an item must be an object');

		const unknownAction = await refusalOf(
			saveComponentData({
				componentTipo: COMPONENT,
				sectionTipo: SECTION_TIPO,
				sectionId: EXISTING_ID,
				lang: 'lg-spa',
				changedData: [{ action: 'not_a_real_action', value: null }],
				userId: -1,
			}),
		);
		expect(unknownAction.code).toBe('request.invalid_data');
		expect(unknownAction.coordinates?.action).toBe('not_a_real_action');

		const after = await readMatrixRecord(TABLE, SECTION_TIPO, EXISTING_ID);
		expect(after?.rawText.string).toBe(before?.rawText.string);
		expect(after?.rawText.meta ?? null).toBe(before?.rawText.meta ?? null);
	});
});
