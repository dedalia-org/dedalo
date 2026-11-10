/**
 * A REFUSED SAVE LEAVES NO TRACE (2026-09-29) — save_component.ts
 * runSaveAtomically.
 *
 * A change the loop refuses with `{ok:false}` — `remove` of an id the
 * component does not hold — may come AFTER the save already wrote inside its
 * transaction (an id-less `update` allocating an item id: a meta-counter
 * raise). When saveComponentData owns the transaction the refusal rolls that
 * back; under a caller's transaction the caller owns that choice.
 *
 * (Until 2026-11-10 the write this gate caught was the create-on-first-save
 * branch materializing a MISSING record. A save never creates any more —
 * WC-2026-11-10-save-never-creates, gate save_missing_record_refused_native —
 * so the property is pinned on an EXISTING record here.)
 *
 * Covered:
 *  1. owned transaction: allocate-then-refuse on an existing record → ok:false,
 *     the record's columns byte-unchanged (meta counter included), no TM row;
 *  2. inside a CALLER's transaction the refused save joins it and the caller's
 *     next save still commits;
 *  3. an absent-record refusal (resource.not_found, a JS throw after a SELECT)
 *     does not poison the caller's transaction: caught, the next save commits.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';
const SECTION_TIPO = 'zzsref1';
/** component_input_text, translatable → 'string' column. */
const COMPONENT = 'zzsref2';
const ANCHOR_ID = 1;
/** Existing records the situation builds. */
const REFUSED_ID = 2;
const AMBIENT_REFUSED_ID = 3;
const AMBIENT_OK_ID = 4;
/** Never created: the absent-record case. Far above the counter. */
const ABSENT_ID = 918304;

const SITUATION = situation({
	tld: 'zzsref',
	name: 'save_refusal_no_trace',
	nodes: [
		{
			tipo: SECTION_TIPO,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Rechazo sin rastro', 'lg-eng': 'Refusal leaves no trace' },
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
	records: [ANCHOR_ID, REFUSED_ID, AMBIENT_REFUSED_ID, AMBIENT_OK_ID].map((section_id) => ({
		section_tipo: SECTION_TIPO,
		section_id,
	})),
});

async function rowCount(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT 1 FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION_TIPO, sectionId],
	)) as unknown[];
	return rows.length;
}

/** The record's whole stored image, as text (byte comparison). */
async function recordImage(sectionId: number): Promise<string | null> {
	const rows = (await sql.unsafe(
		`SELECT row_to_json(t)::text AS image FROM (
			SELECT data, relation, string, date, iri, geo, number, media, misc, meta
			  FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2) t`,
		[SECTION_TIPO, sectionId],
	)) as { image: string }[];
	return rows[0]?.image ?? null;
}

async function storedValues(sectionId: number): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT string->$3 AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION_TIPO, sectionId, COMPONENT],
	)) as { items: { value: string }[] | null }[];
	return (rows[0]?.items ?? []).map((item) => item.value);
}

async function counterValue(): Promise<number | null> {
	const rows = (await sql`SELECT value FROM matrix_counter WHERE tipo = ${SECTION_TIPO}`) as {
		value: number;
	}[];
	return rows[0] === undefined ? null : Number(rows[0].value);
}

async function tmRowCount(sectionId: number): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_time_machine
		WHERE section_tipo = ${SECTION_TIPO} AND section_id = ${sectionId}
	`) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** NEW activity rows naming a created record of this section at `sectionId`. */
async function activityRowCount(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		   AND misc->'dd551'->0->'value'->>'section_id' = $2`,
		[SECTION_TIPO, String(sectionId)],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function cleanAll(): Promise<void> {
	await cleanScratchRecord(SECTION_TIPO, ABSENT_ID, TABLE);
	await sql.unsafe(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
		 AND misc->'dd551'->0->'value'->>'section_tipo' = $1`,
		[SECTION_TIPO],
	);
}

/**
 * The refused change, AFTER a write: an id-less update (allocates an item id —
 * a meta-counter raise inside the tx), then a remove of an id the record
 * cannot hold.
 */
function refusedRemove(sectionId: number) {
	return saveComponentData({
		componentTipo: COMPONENT,
		sectionTipo: SECTION_TIPO,
		sectionId,
		lang: 'lg-spa',
		changedData: [
			{ action: 'update', id: null, value: { lang: 'lg-spa', value: 'never-kept' } },
			{ action: 'remove', id: 999, value: null },
		],
		userId: -1,
	});
}

function legitimateUpdate(sectionId: number, value: string) {
	return saveComponentData({
		componentTipo: COMPONENT,
		sectionTipo: SECTION_TIPO,
		sectionId,
		lang: 'lg-spa',
		changedData: [{ action: 'update', id: null, value: { lang: 'lg-spa', value } }],
		userId: -1,
	});
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION_TIPO)).toBe(TABLE);
	await cleanAll();
});

afterAll(async () => {
	await cleanAll();
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('a refused save leaves no trace', () => {
	test('owned transaction: ok:false, the existing record byte-unchanged, no TM row', async () => {
		const before = await recordImage(REFUSED_ID);
		expect(before).not.toBeNull();
		const counterBefore = await counterValue();
		const tmBefore = await tmRowCount(REFUSED_ID);

		const outcome = await refusedRemove(REFUSED_ID);
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toBe('remove: no item with id 999');

		expect(await recordImage(REFUSED_ID)).toBe(before);
		expect(await counterValue()).toBe(counterBefore);
		expect(await tmRowCount(REFUSED_ID)).toBe(tmBefore);
		expect(await activityRowCount(REFUSED_ID)).toBe(0);
	}, 30000);

	test("caller's transaction: the refused save joins it and the caller's next save commits", async () => {
		const outcomes = await withTransaction(async () => {
			const refused = await refusedRemove(AMBIENT_REFUSED_ID);
			const kept = await legitimateUpdate(AMBIENT_OK_ID, 'kept-after-refusal');
			return { refused, kept };
		});
		expect(outcomes.refused.ok).toBe(false);
		expect(outcomes.kept.ok).toBe(true);
		expect(await storedValues(AMBIENT_OK_ID)).toContain('kept-after-refusal');
	}, 30000);

	test("an absent-record refusal does not poison the caller's transaction", async () => {
		expect(await rowCount(ABSENT_ID)).toBe(0);
		const counterBefore = await counterValue();
		const code = await withTransaction(async () => {
			let refusedCode: string | null = null;
			try {
				await legitimateUpdate(ABSENT_ID, 'never-born');
			} catch (error) {
				refusedCode = (error as { code?: string }).code ?? null;
			}
			const kept = await legitimateUpdate(AMBIENT_OK_ID, 'kept-after-not-found');
			expect(kept.ok).toBe(true);
			return refusedCode;
		});
		expect(code).toBe('resource.not_found');
		expect(await rowCount(ABSENT_ID)).toBe(0);
		expect(await counterValue()).toBe(counterBefore);
		expect(await tmRowCount(ABSENT_ID)).toBe(0);
		expect(await activityRowCount(ABSENT_ID)).toBe(0);
		expect(await storedValues(AMBIENT_OK_ID)).toContain('kept-after-not-found');
	}, 30000);
});
