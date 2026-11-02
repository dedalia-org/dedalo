/**
 * DEEP-PATH FILTER SEMANTICS — the record-level meaning of a filter leaf whose
 * path crosses a relation hop (WC-2026-09-29-search-deep-leaf-mixed-rule).
 *
 * R(m) = the related records main record m reaches through the path. A deep
 * leaf answers over R(m), never over one joined row:
 *
 *  - positive ('alpha', '=1939', '*')  → SOME r in R(m) matches;
 *  - negative ('-alpha', '!*', $not)   → NO r in R(m) matches the positive
 *    twin (records with no relation, or a dangling one, match);
 *  - '!=' (neq)                        → some r in R(m) has a value AND no
 *    r in R(m) equals it.
 *
 * THE MIXED RULE (owner decision 2026-09-29) for sibling leaves under an AND:
 *  - positive leaves on DIFFERENT fields of the same path describe ONE related
 *    record ('beta' AND 1939 = one related record holding both);
 *  - positive leaves on the SAME field are matched independently ('alpha' AND
 *    'beta' = one record with alpha, possibly another with beta) — and a
 *    repeated field makes every positive leaf of that path independent;
 *  - a negative leaf never shares a record: it always means "no related
 *    record matches".
 *
 * Situation: test3 records (matrix_test) at explicit ids, hop test54
 * (component_relation_related) → fields test52 (component_input_text) and
 * test22 (component_number). Records are created here and swept after; answers
 * are intersected with the ids this file owns, so the ambient corpus cannot
 * change them.
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
const TEXT = 'test52';
const NUMBER = 'test22';

// Related records: [text, number]
const T1 = 932201; // 'zzdeep alpha one', 1939
const T2 = 932202; // 'zzdeep beta two', 1940
const T3 = 932203; // 'zzdeep alpha beta', 1940
const T4 = 932204; // no text, 1939
const T5 = 932205; // 'zzdeep beta five', 1939
// Main records
const M1 = 932211; // → T1
const M2 = 932212; // → T2
const M3 = 932213; // → T1, T2
const M4 = 932214; // → T3
const M5 = 932215; // no locator
const M6 = 932216; // → a record that does not exist
const M7 = 932217; // → T2, T4 (beta on one record, 1939 on another)
const M8 = 932218; // → T5 (beta AND 1939 on the same record)
const MISSING = 932299;
const MAINS = [M1, M2, M3, M4, M5, M6, M7, M8];
// Second universe — relation-family leaves and a two-hop chain (hop test54
// twice): mains → middles → ends.
const E1 = 932231; // 'zzdeep two-hop end'
const E2 = 932232; // 'zzdeep other end'
const D1 = 932241; // → E1
const D2 = 932242; // → E2
const D3 = 932243; // no locator
const N1 = 932251; // → D1
const N2 = 932252; // → D2
const N3 = 932253; // → D3
const N4 = 932254; // → D1, D2
const N5 = 932255; // no locator
const CHAIN_MAINS = [N1, N2, N3, N4, N5];
const OWNED = [T1, T2, T3, T4, T5, ...MAINS, E1, E2, D1, D2, D3, ...CHAIN_MAINS];

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

const related = (text: string | null, year: number) => ({
	...(text === null ? {} : { string: { [TEXT]: [{ id: 1, lang: 'lg-nolan', value: text }] } }),
	number: { [NUMBER]: [{ id: 1, lang: 'lg-nolan', value: year }] },
});
const links = (...ids: number[]) => ({ relation: { [HOP]: ids.map(locator) } });

async function purge(): Promise<void> {
	for (const id of OWNED) await deleteMatrixRecord(TABLE, SECTION, id);
}

const path = (field: string) => [
	{ section_tipo: SECTION, component_tipo: HOP },
	{ section_tipo: SECTION, component_tipo: field },
];
const text = (q: string, extra: Record<string, unknown> = {}) => ({
	q,
	path: path(TEXT),
	...extra,
});
const year = (q: string) => ({ q, path: path(NUMBER) });

/** The matched ids among `universe` (this file's main records), from the rows AND the count query. */
async function run(
	filter: unknown,
	universe: readonly number[] = MAINS,
): Promise<{ ids: number[]; countSql: string }> {
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
	const ids = found.map((row) => Number(row.section_id)).filter((id) => universe.includes(id));
	// One row per record: a deep leaf never fans the main query out.
	expect(new Set(ids).size).toBe(ids.length);
	return { ids: ids.sort(), countSql: count.sql };
}

describe.if(DB_READY)('deep-path filter semantics (mixed rule)', () => {
	beforeAll(async () => {
		await assertTestDatabase('search_deep_semantics_native');
		await purge();
		await insert(T1, related('zzdeep alpha one', 1939));
		await insert(T2, related('zzdeep beta two', 1940));
		await insert(T3, related('zzdeep alpha beta', 1940));
		await insert(T4, related(null, 1939));
		await insert(T5, related('zzdeep beta five', 1939));
		await insert(M1, links(T1));
		await insert(M2, links(T2));
		await insert(M3, links(T1, T2));
		await insert(M4, links(T3));
		await insert(M5, {});
		await insert(M6, links(MISSING));
		await insert(M7, links(T2, T4));
		await insert(M8, links(T5));
	});
	afterAll(purge);

	test('positive: some related record matches; no fan-out in the count', async () => {
		const result = await run({ $and: [text('zzdeep alpha')] });
		expect(result.ids).toEqual([M1, M3, M4]);
		expect(result.countSql).not.toContain('count(DISTINCT');
	});

	describe('negation: no related record matches', () => {
		test("'-alpha'", async () => {
			const result = await run({ $and: [text('-alpha')] });
			expect(result.ids).toEqual([M2, M5, M6, M7, M8]);
			expect(result.countSql).not.toContain('count(DISTINCT');
		});

		test('$not over a positive leaf', async () => {
			const result = await run({ $and: [{ $not: [text('zzdeep alpha')] }] });
			expect(result.ids).toEqual([M2, M5, M6, M7, M8]);
		});

		test("'!*' (empty): no related record holds a value", async () => {
			const result = await run({ $and: [text('!*')] });
			expect(result.ids).toEqual([M5, M6]);
		});

		test("text '!=': some related value AND none equals", async () => {
			const result = await run({ $and: [text('!=zzdeep alpha one')] });
			expect(result.ids).toEqual([M2, M4, M7, M8]);
		});

		test("number '!=': some related value AND none equals", async () => {
			const result = await run({ $and: [year('!=1939')] });
			expect(result.ids).toEqual([M2, M4]);
		});
	});

	describe('mixed rule under $and', () => {
		test('same field twice: matched independently', async () => {
			const result = await run({ $and: [text('alpha'), text('beta')] });
			// M3: alpha on T1, beta on T2 — two different related records.
			expect(result.ids).toEqual([M3, M4]);
		});

		test('different fields: one related record holds both', async () => {
			const result = await run({ $and: [text('beta'), year('1939')] });
			// M3 (beta on T2, 1939 on T1) and M7 (beta on T2, 1939 on T4) are out.
			expect(result.ids).toEqual([M8]);
		});

		test('different fields under $not: NOT (one related record holds both)', async () => {
			const result = await run({ $and: [{ $not: [text('beta'), year('1939')] }] });
			expect(result.ids).toEqual([M1, M2, M3, M4, M5, M6, M7]);
		});

		test('a repeated field makes the whole path independent', async () => {
			const result = await run({ $and: [text('beta'), text('alpha'), year('1939')] });
			// M3: beta (T2), alpha (T1), 1939 (T1) — independent; M4 has no 1939.
			expect(result.ids).toEqual([M3]);
		});

		test('a negative sibling never shares the record', async () => {
			const result = await run({ $and: [text('beta'), text('-alpha')] });
			expect(result.ids).toEqual([M2, M7, M8]);
		});

		test('q_split: positive tokens share a record, a negative token is "none"', async () => {
			const result = await run({ $and: [text('beta -alpha', { q_split: true })] });
			expect(result.ids).toEqual([M2, M7, M8]);
		});
	});

	test('$nand: NOT (one related record holds both)', async () => {
		const result = await run({ $and: [{ $nand: [text('beta'), year('1939')] }] });
		expect(result.ids).toEqual([M1, M2, M3, M4, M5, M6, M7]);
	});

	test('$nor: NOT (either, each on its own record)', async () => {
		const result = await run({ $and: [{ $nor: [text('zzdeep beta five'), year('1939')] }] });
		expect(result.ids).toEqual([M2, M4, M5, M6]);
	});

	test('$or across fields: any related record satisfying either', async () => {
		const result = await run({ $or: [text('zzdeep beta five'), year('1939')] });
		expect(result.ids).toEqual([M1, M3, M7, M8]);
	});
});

/** hop test54 twice: main → middle → end record's field. */
const twoHop = (field: string) => [
	{ section_tipo: SECTION, component_tipo: HOP },
	{ section_tipo: SECTION, component_tipo: HOP },
	{ section_tipo: SECTION, component_tipo: field },
];
/** A relation leaf on the middle record's own hop component. */
const middleLinks = (qOperator: string, q: unknown = null) => ({
	q,
	q_operator: qOperator,
	path: path(HOP),
});
const endLocator = (sectionId: number) => ({ section_tipo: SECTION, section_id: sectionId });

describe.if(DB_READY)('deep-path semantics: relation leaves and two hops', () => {
	beforeAll(async () => {
		await assertTestDatabase('search_deep_semantics_native');
		await insert(E1, related('zzdeep two-hop end', 1939));
		await insert(E2, related('zzdeep other end', 1940));
		await insert(D1, links(E1));
		await insert(D2, links(E2));
		await insert(D3, {});
		await insert(N1, links(D1));
		await insert(N2, links(D2));
		await insert(N3, links(D3));
		await insert(N4, links(D1, D2));
		await insert(N5, {});
	});
	afterAll(purge);

	test('relation positive: some middle record links the end record', async () => {
		const result = await run({ $and: [middleLinks('', endLocator(E1))] }, CHAIN_MAINS);
		expect(result.ids).toEqual([N1, N4]);
	});

	test("relation '!==': no middle record links the end record", async () => {
		const result = await run({ $and: [middleLinks('!==', endLocator(E1))] }, CHAIN_MAINS);
		expect(result.ids).toEqual([N2, N3, N5]);
		expect(result.countSql).toContain('NOT EXISTS (SELECT 1 FROM');
	});

	test("relation '!=': some middle record has links AND none links the end record", async () => {
		const result = await run({ $and: [middleLinks('!=', endLocator(E1))] }, CHAIN_MAINS);
		// N3's only middle (D3) has no links; N5 has no middle at all.
		expect(result.ids).toEqual([N2]);
	});

	test("relation '!*': no middle record holds a link", async () => {
		const result = await run({ $and: [middleLinks('!*')] }, CHAIN_MAINS);
		expect(result.ids).toEqual([N3, N5]);
	});

	test('two hops, positive: reached through the middle record', async () => {
		const result = await run({ $and: [{ q: 'two-hop', path: twoHop(TEXT) }] }, CHAIN_MAINS);
		expect(result.ids).toEqual([N1, N4]);
	});

	test('two hops, negation: no end record reached through any middle matches', async () => {
		const result = await run({ $and: [{ q: '-two-hop', path: twoHop(TEXT) }] }, CHAIN_MAINS);
		expect(result.ids).toEqual([N2, N3, N5]);
		expect(result.countSql).toContain('CROSS JOIN LATERAL jsonb_array_elements(');
	});

	test('two hops, different fields share one end record', async () => {
		const shared = await run(
			{
				$and: [
					{ q: 'zzdeep', path: twoHop(TEXT) },
					{ q: '1940', path: twoHop(NUMBER) },
				],
			},
			CHAIN_MAINS,
		);
		// E2 holds both; E1 is 1939.
		expect(shared.ids).toEqual([N2, N4]);
	});
});
