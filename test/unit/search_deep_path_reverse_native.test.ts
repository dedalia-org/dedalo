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
 *
 * Two hops (TODO-012, owner decision 20 — 2026-11-17): the reversed shape reads
 * an intermediate record's address from matrix_relation_index, which carries no
 * table. Scratch TLD zzhopsrc holds two virtual siblings of test3 — zzhopsrc1
 * stored in matrix_list, zzhopsrc2 in matrix_test — so one gate builds a locator
 * that names a record OUTSIDE the declared step table and one that names another
 * section INSIDE it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
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

// two hops: main → middle → end
const END = 932121; // 'zzhopend'
const MID_EMPTY = 932122; // test3, no locator — and the id the off-table twin shares
const MID_LINKED = 932123; // test3 → END
const MID_SIBLING = 932124; // zzhopsrc2 (matrix_test) → END
const C1 = 932131; // → zzhopsrc1/MID_EMPTY: a record of matrix_list, itself → END
const C2 = 932132; // → test3/MID_EMPTY: the same id in the step table, no locator
const C3 = 932133; // → test3/MID_LINKED
const C4 = 932134; // → zzhopsrc2/MID_SIBLING: another section of the step table
const CHAIN_MAINS = [C1, C2, C3, C4];
const OWNED = [T1, T2, T3, ...MAINS, END, MID_EMPTY, MID_LINKED, ...CHAIN_MAINS];

/** Virtual siblings of test3: same components, one stored outside matrix_test. */
const OFF_TABLE = 'zzhopsrc1';
const SAME_TABLE = 'zzhopsrc2';
const MATRIX_LIST_TIPO = 'dd22';
const MATRIX_TEST_TIPO = 'test24';

function locator(sectionId: number, sectionTipo: string = SECTION) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: HOP,
	};
}

const SIBLINGS = situation({
	tld: 'zzhopsrc',
	name: 'search_deep_path_reverse_native: virtual siblings of test3',
	nodes: [
		{
			tipo: OFF_TABLE,
			model: 'section',
			relations: [{ tipo: SECTION }, { tipo: MATRIX_LIST_TIPO }],
		},
		{
			tipo: SAME_TABLE,
			model: 'section',
			relations: [{ tipo: SECTION }, { tipo: MATRIX_TEST_TIPO }],
		},
	],
	records: [
		{
			section_tipo: OFF_TABLE,
			section_id: MID_EMPTY,
			columns: { relation: { [HOP]: [locator(END)] } },
		},
		{
			section_tipo: SAME_TABLE,
			section_id: MID_SIBLING,
			columns: { relation: { [HOP]: [locator(END)] } },
		},
	],
});

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
const links = (...ids: number[]) => ({ [HOP]: ids.map((id) => locator(id)) });

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

/** The matched ids among `universe` (this file's main records), and whether the SQL reversed. */
async function run(
	filter: unknown,
	universe: readonly number[] = MAINS,
): Promise<{ ids: number[]; reversed: boolean; count: string }> {
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
			.filter((id) => universe.includes(id))
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

/** hop test54 twice: main → middle → the end record's text. */
const twoHopLeaf = (q: string) => ({
	q,
	path: [
		{ section_tipo: SECTION, component_tipo: HOP },
		{ section_tipo: SECTION, component_tipo: HOP },
		{ section_tipo: SECTION, component_tipo: LEAF },
	],
});

describe.if(DB_READY)('two hops: both shapes read the middle record in the step table', () => {
	beforeAll(async () => {
		await assertTestDatabase('search_deep_path_reverse_native');
		await dropSituation(SIBLINGS);
		await ensureSituation(SIBLINGS);
		await insert(END, { string: text('zzhopend') });
		await insert(MID_EMPTY, {});
		await insert(MID_LINKED, { relation: links(END) });
		await insert(C1, { relation: { [HOP]: [locator(MID_EMPTY, OFF_TABLE)] } });
		await insert(C2, { relation: links(MID_EMPTY) });
		await insert(C3, { relation: links(MID_LINKED) });
		await insert(C4, { relation: { [HOP]: [locator(MID_SIBLING, SAME_TABLE)] } });
	});
	afterAll(async () => {
		await purge();
		expect(await dropSituation(SIBLINGS)).toBe(0);
	});

	// The correlated twin of a positive leaf: under a negation the semi-join is
	// never reversed, and NOT (NOT EXISTS …) is the positive answer.
	const correlated = (leafNode: unknown) => ({ $and: [{ $not: [{ $not: [leafNode] }] }] });

	test('the situation holds: an off-table record indexed as a source of the end record', async () => {
		const sources = (await sql`
			SELECT section_tipo, section_id FROM matrix_relation_index
			WHERE from_component_tipo = ${HOP} AND target_section_tipo = ${SECTION}
			  AND target_section_id = ${END}
			ORDER BY section_tipo, section_id
		`) as { section_tipo: string; section_id: number }[];
		expect(sources.map((row) => `${row.section_tipo}/${row.section_id}`)).toEqual([
			`${SECTION}/${MID_LINKED}`,
			`${OFF_TABLE}/${MID_EMPTY}`,
			`${SAME_TABLE}/${MID_SIBLING}`,
		]);
		const offTable = (await sql`
			SELECT count(*)::int AS n FROM matrix_test
			WHERE section_tipo = ${OFF_TABLE} AND section_id = ${MID_EMPTY}
		`) as { n: number }[];
		expect(offTable[0]?.n).toBe(0);
	});

	test('correlated: a locator naming a record outside the step table reaches nothing', async () => {
		const result = await run(correlated(twoHopLeaf('zzhopend')), CHAIN_MAINS);
		expect(result.reversed).toBe(false);
		expect(result.ids).toEqual([C3, C4]);
	});

	test('reversed: the same answer — no match through the off-table record (TODO-012)', async () => {
		const result = await run({ $and: [twoHopLeaf('zzhopend')] }, CHAIN_MAINS);
		expect(result.reversed).toBe(true);
		// C1's middle lives in matrix_list; C2's is the same id in test3, unlinked.
		expect(result.ids).toEqual([C3, C4]);
	});
});
