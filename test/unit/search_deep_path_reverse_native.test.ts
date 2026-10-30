/**
 * DEEP-PATH SHAPES — which physical form a deep filter leaf takes, and that
 * each form answers the record-level semantics (src/core/search/deep_path.ts,
 * WC-2026-09-29-search-deep-leaf-mixed-rule; the semantics themselves are
 * gated by search_deep_semantics_native).
 *
 *  - a POSITIVE semi-join in a positive context, over index-covered tables,
 *    is driven from the LEAF through matrix_relation_index (reversed);
 *  - a NEGATED clause ('!*', the twin of '!=', anything under $not) is a
 *    correlated NOT EXISTS / NOT (EXISTS …) — never reversed;
 *  - no deep leaf adds a join to the main FROM: the count is count(*).
 *
 * Situation: test3 records (matrix_test) at explicit ids, hop test54
 * (component_relation_related) → leaf test52 (component_input_text). Records
 * are created here and swept after; answers are intersected with the ids this
 * file owns, so the ambient corpus cannot change them.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const HOP = 'test54';
const LEAF = 'test52';

const T1 = 932101; // 'zzdeep alpha one'
const T2 = 932102; // 'zzdeep beta two'
const T3 = 932103; // 'zzdeep alpha beta'
const M1 = 932111; // → T1
const M2 = 932112; // → T2
const M3 = 932113; // → T1, T2 (alpha and beta on DIFFERENT records)
const M4 = 932114; // → T3 (alpha and beta on the SAME record)
const M5 = 932115; // no locator
const M6 = 932116; // → a record that does not exist
const MISSING = 932199;
const MAINS = [M1, M2, M3, M4, M5, M6];
const OWNED = [T1, T2, T3, ...MAINS];

function locator(sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: SECTION,
		from_component_tipo: HOP,
	};
}

async function insert(sectionId: number, columns: Record<string, unknown>): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const values = ['$1', '$2'];
	const params: (string | number)[] = [SECTION, sectionId];
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		params.push(encodeForJsonb(value));
		values.push(`$${params.length}::text::jsonb`);
	}
	await sql.unsafe(
		`INSERT INTO ${TABLE} (${names.join(', ')}) VALUES (${values.join(', ')})`,
		params,
	);
}

const text = (value: string) => ({ [LEAF]: [{ id: 1, lang: 'lg-nolan', value }] });
const links = (...ids: number[]) => ({ [HOP]: ids.map(locator) });

async function purge(): Promise<void> {
	for (const id of OWNED) await deleteMatrixRecord(TABLE, SECTION, id);
}

const leaf = (q: string) => ({
	q,
	path: [
		{ section_tipo: SECTION, component_tipo: HOP },
		{ section_tipo: SECTION, component_tipo: LEAF },
	],
});

/** The matched ids among this file's main records, and whether the SQL reversed. */
async function run(filter: unknown): Promise<{ ids: number[]; reversed: boolean; count: string }> {
	const rows = await buildSearchSql(
		sanitizeClientSqo(structuredClone({ section_tipo: [SECTION], limit: 'all', filter }) as never),
		{},
	);
	const count = await buildSearchSql(
		sanitizeClientSqo(
			structuredClone({ section_tipo: [SECTION], full_count: true, filter }) as never,
		),
		{},
	);
	const found = (await sql.unsafe(rows.sql, rows.params as never[])) as { section_id: number }[];
	return {
		ids: found
			.map((row) => Number(row.section_id))
			.filter((id) => MAINS.includes(id))
			.sort(),
		reversed: rows.sql.includes('FROM matrix_relation_index AS ri_'),
		count: count.sql,
	};
}

describe.if(DB_READY)('deep-path reversal is exact', () => {
	beforeAll(async () => {
		await assertTestDatabase('search_deep_path_reverse_native');
		await purge();
		await insert(T1, { string: text('zzdeep alpha one') });
		await insert(T2, { string: text('zzdeep beta two') });
		await insert(T3, { string: text('zzdeep alpha beta') });
		await insert(M1, { relation: links(T1) });
		await insert(M2, { relation: links(T2) });
		await insert(M3, { relation: links(T1, T2) });
		await insert(M4, { relation: links(T3) });
		await insert(M5, {});
		await insert(M6, { relation: links(MISSING) });
	});
	afterAll(purge);

	test('positive leaf: reversed, every record linking a match', async () => {
		const result = await run({ $and: [leaf('zzdeep alpha')] });
		expect(result.reversed).toBe(true);
		expect(result.count).toContain('count(*) as full_count');
		expect(result.ids).toEqual([M1, M3, M4]);
	});

	test('same field twice under $and: two independent reversed semi-joins', async () => {
		const result = await run({ $and: [leaf('alpha'), leaf('beta')] });
		expect(result.reversed).toBe(true);
		// M3: alpha on T1, beta on T2 — the same field is matched independently.
		expect(result.ids).toEqual([M3, M4]);
	});

	test('same path under $or: any related record satisfying either', async () => {
		const result = await run({ $or: [leaf('zzdeep alpha one'), leaf('zzdeep beta')] });
		expect(result.reversed).toBe(true);
		// T3 'zzdeep alpha beta' contains neither term: M4 stays out.
		expect(result.ids).toEqual([M1, M2, M3]);
	});

	test("'!*' is a NOT EXISTS: records with no (or a dangling) related record match", async () => {
		const result = await run({ $and: [leaf('!*')] });
		expect(result.reversed).toBe(false);
		expect(result.count).toContain('NOT EXISTS (SELECT 1 FROM');
		expect(result.count).toContain('count(*) as full_count');
		expect(result.ids).toEqual([M5, M6]);
	});

	test("'!=': the has-half reversed, the twin a NOT EXISTS", async () => {
		const result = await run({ $and: [leaf('!=zzdeep alpha one')] });
		expect(result.reversed).toBe(true);
		expect(result.count).toContain('NOT EXISTS (SELECT 1 FROM');
		// M3 links T1 ('zzdeep alpha one'): some related record equals → out.
		expect(result.ids).toEqual([M2, M4]);
	});

	test('under $not the semi-join stays correlated (never reversed)', async () => {
		const result = await run({ $and: [{ $not: [leaf('zzdeep alpha')] }] });
		expect(result.reversed).toBe(false);
		expect(result.ids).toEqual([M2, M5, M6]);
	});
});
