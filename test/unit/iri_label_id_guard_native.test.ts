/**
 * THE IRI LABEL LAW at the save door (T0-12 §3.6, owner decision D1) — the
 * tripwire for "a component_iri item never carries `label_id` into the matrix".
 *
 * The label of an IRI item lives in its dd560 dataframe frame (dd490 → dd1706),
 * never on the item. saveComponentData refuses (`request.invalid`, before the
 * transaction: nothing written, no Time Machine row) any value-carrying change
 * whose iri item carries a `label_id` key. The deprecated `title` key is NOT
 * judged (decision D5 — kept, stored, PHP parity).
 *
 * Situation BUILT here, on the generic `test` TLD: a fresh test3 record created
 * at runtime through the engine; test140 is test3's component_iri (asserted, not
 * assumed). The record, its TM rows and its activity rows are swept after.
 *
 * Non-vacuity: case (a) was run against the unguarded door first and went RED —
 * the save answered ok and the matrix stored `{iri, label_id:5}` verbatim.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	type ChangedDataItem,
	saveComponentData,
} from '../../src/core/section/record/save_component.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';

const SECTION = 'test3';
const IRI = 'test140';
const LANG = 'lg-nolan';

let table = '';
let record = 0;

/** One set_data save of `items` on the scratch record's test140, as root. */
function saveIri(items: unknown[]) {
	const change: ChangedDataItem = { action: 'set_data', value: items };
	return saveComponentData({
		componentTipo: IRI,
		sectionTipo: SECTION,
		sectionId: record,
		lang: LANG,
		changedData: [change],
		userId: -1,
	});
}

/** The stored test140 items of the scratch record (the whole iri key, every lang). */
async function storedItems(): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT iri->$1 AS items FROM ${table} WHERE section_tipo = $2 AND section_id = $3`,
		[IRI, SECTION, record],
	)) as { items: Record<string, unknown>[] | null }[];
	return rows[0]?.items ?? [];
}

/** The scratch record's Time Machine rows for test140. */
async function tmRowCount(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
		[SECTION, record, IRI],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

beforeAll(async () => {
	await assertTestDatabase('iri_label_id_guard scratch record');
	table = (await getMatrixTableFromTipo(SECTION)) ?? '';
	if (table === '') throw new Error(`no matrix table for ${SECTION}`);
	record = await createSectionRecord(SECTION, -1, new Date());
}, 60000);

afterAll(async () => {
	if (record === 0) return;
	await assertTestDatabase('iri_label_id_guard sweep');
	await deleteMatrixRecord(table, SECTION, record);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		record,
	]);
	await sweepActivityRows(SECTION, [record]);
});

describe('the situation is non-degenerate', () => {
	test('test140 is a test3 component_iri; the scratch record exists', async () => {
		expect(await getModelByTipo(IRI)).toBe('component_iri');
		expect(record).toBeGreaterThan(0);
	});
});

describe('the iri label law', () => {
	test('(c) a plain {iri} item is accepted and stored', async () => {
		const saved = await saveIri([{ iri: 'https://a.test/plain' }]);
		expect(saved.ok).toBe(true);
		const items = await storedItems();
		expect(items.length).toBe(1);
		expect(items[0]).toMatchObject({ iri: 'https://a.test/plain' });
		expect(Object.hasOwn(items[0] as object, 'label_id')).toBe(false);
	});

	test('(a) an item carrying label_id is REFUSED: request.invalid, nothing stored, no TM row', async () => {
		const before = await storedItems();
		const tmBefore = await tmRowCount();
		let thrown: unknown = null;
		try {
			const answer = await saveIri([{ iri: 'https://a.test/labelled', label_id: 5 }]);
			// An ok:false answer would also be a refusal, but the law throws loudly.
			thrown = answer;
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DedaloError);
		const error = thrown as DedaloError;
		expect(error.code).toBe('request.invalid');
		expect(error.message).toContain(IRI);
		expect(error.message).toContain('label_id');
		expect(error.message).toContain('dd560');
		expect(await storedItems()).toEqual(before);
		expect(await tmRowCount()).toBe(tmBefore);
	});

	test('(a′) a null label_id is refused too — the key itself is the stray', async () => {
		const before = await storedItems();
		await expect(saveIri([{ iri: 'https://a.test/labelled', label_id: null }])).rejects.toThrow(
			'label_id',
		);
		expect(await storedItems()).toEqual(before);
	});

	test('(a″) an insert carrying label_id is refused as well', async () => {
		const before = await storedItems();
		await expect(
			saveComponentData({
				componentTipo: IRI,
				sectionTipo: SECTION,
				sectionId: record,
				lang: LANG,
				changedData: [{ action: 'insert', value: { iri: 'https://a.test/ins', label_id: 7 } }],
				userId: -1,
			}),
		).rejects.toThrow('label_id');
		expect(await storedItems()).toEqual(before);
	});

	test('(b) the deprecated title key is accepted and STORED (decision D5)', async () => {
		const saved = await saveIri([{ iri: 'https://a.test/titled', title: 'T' }]);
		expect(saved.ok).toBe(true);
		const items = await storedItems();
		expect(items.length).toBe(1);
		expect(items[0]).toMatchObject({ iri: 'https://a.test/titled', title: 'T' });
	});
});
