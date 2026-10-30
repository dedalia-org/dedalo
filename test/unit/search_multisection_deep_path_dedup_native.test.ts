/**
 * Multi-section search + a multi-hop (deep) filter path: ONE row per record
 * identity (section_tipo, section_id), and a full_count that counts identities
 * (WC-2026-09-24-multi-section-search-identity-dedup).
 *
 * A filter join chain unnests a relation's locators (`LEFT JOIN LATERAL
 * jsonb_array_elements`) so the leaf can match ANY of them — a record with N
 * matching locators becomes N joined rows. The single-section shape folds that
 * back with DISTINCT ON; the multi-section shape used to drop DISTINCT entirely
 * (PHP forced remove_distinct, fearing a cross-section collapse on section_id
 * alone), so the record came back N times, and its count(DISTINCT section_id)
 * merged two sections' records that merely share an id.
 *
 * The situation (`zzsd`, torn down with an asserted residue of 0):
 *   - zzsd1 target section (matrix_test), zzsd2 its term;
 *   - zzsd3 real source section (matrix_test), zzsd4 its portal → zzsd1;
 *   - zzsd5 VIRTUAL of zzsd3 on the SAME table (borrows zzsd4);
 *   - zzsd6 VIRTUAL of zzsd3 on `matrix` (dd643) — a second table, so the
 *     search is a UNION ALL.
 * Record 900950 exists in all three sources; in zzsd3 and zzsd6 it holds TWO
 * locators that both match the leaf (the fan-out), in zzsd5 one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const TARGET = 'zzsd1';
const TERM = 'zzsd2';
const SOURCE = 'zzsd3';
const PORTAL = 'zzsd4';
const TWIN_SAME_TABLE = 'zzsd5';
const TWIN_OTHER_TABLE = 'zzsd6';
/** The id every source section holds — the cross-section identity case. */
const SHARED_ID = 900950;

const target = (sectionId: number) => ({
	section_tipo: TARGET,
	section_id: sectionId,
	type: 'dd151',
});

const S = situation({
	name: 'zzsd multi-section deep-path dedup',
	tld: 'zzsd',
	nodes: [
		{
			tipo: TARGET,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Destino', 'lg-eng': 'Target' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: TERM,
			parent: TARGET,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'Término', 'lg-eng': 'Term' },
		},
		{
			tipo: SOURCE,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Origen', 'lg-eng': 'Source' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: PORTAL,
			parent: SOURCE,
			model: 'component_portal',
			term: { 'lg-spa': 'Portal al destino', 'lg-eng': 'Target portal' },
			relations: [{ tipo: TARGET }],
		},
		{
			tipo: TWIN_SAME_TABLE,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Origen gemelo', 'lg-eng': 'Source twin' },
			relations: [{ tipo: SOURCE }],
		},
		{
			tipo: TWIN_OTHER_TABLE,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Origen en matrix', 'lg-eng': 'Source on matrix' },
			relations: [{ tipo: SOURCE }, { tipo: 'dd643' }],
		},
	],
	records: [
		{
			section_tipo: TARGET,
			section_id: 900901,
			columns: { string: { [TERM]: [{ lang: 'lg-spa', value: 'Needle one' }] } },
		},
		{
			section_tipo: TARGET,
			section_id: 900902,
			columns: { string: { [TERM]: [{ lang: 'lg-spa', value: 'Needle two' }] } },
		},
		{
			section_tipo: TARGET,
			section_id: 900903,
			columns: { string: { [TERM]: [{ lang: 'lg-spa', value: 'Haystack' }] } },
		},
		{
			section_tipo: SOURCE,
			section_id: SHARED_ID,
			columns: { relation: { [PORTAL]: [target(900901), target(900902)] } },
		},
		{
			section_tipo: SOURCE,
			section_id: 900951,
			columns: { relation: { [PORTAL]: [target(900903)] } },
		},
		{
			section_tipo: TWIN_SAME_TABLE,
			section_id: SHARED_ID,
			columns: { relation: { [PORTAL]: [target(900901)] } },
		},
		{
			section_tipo: TWIN_OTHER_TABLE,
			section_id: SHARED_ID,
			columns: { relation: { [PORTAL]: [target(900901), target(900902)] } },
		},
	],
});

beforeAll(async () => {
	await ensureSituation(S);
});
afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

/** A multi-section SQO filtering through the portal onto the target's term. */
function deepPathSqo(sectionTipos: string[], extra: Record<string, unknown> = {}) {
	return sanitizeClientSqo(
		structuredClone({
			section_tipo: sectionTipos,
			limit: 50,
			offset: 0,
			filter: {
				$and: [
					{
						q: 'Needle',
						path: [
							{ section_tipo: SOURCE, component_tipo: PORTAL },
							{ section_tipo: TARGET, component_tipo: TERM },
						],
						q_split: true,
					},
				],
			},
			...extra,
		}),
	);
}

async function run(sqo: ReturnType<typeof sanitizeClientSqo>): Promise<Record<string, unknown>[]> {
	const { sql: builtSql, params } = await buildSearchSql(sqo, { idsOnly: true });
	return (await sql.unsafe(builtSql, params as (string | number | null)[])) as Record<
		string,
		unknown
	>[];
}

async function fullCount(sqo: ReturnType<typeof sanitizeClientSqo>): Promise<number> {
	sqo.full_count = true;
	const rows = (await run(sqo)) as { full_count: number | string }[];
	// Multi-table UNION yields one count row per branch (callers sum, count.ts).
	return rows.reduce((total, row) => total + Number(row.full_count), 0);
}

const identities = (rows: Record<string, unknown>[]) =>
	rows.map((row) => `${row.section_tipo}:${Number(row.section_id)}`);

describe('multi-section search over a deep path: one row per record identity', () => {
	test('control: single-section search already folds the fan-out', async () => {
		expect(identities(await run(deepPathSqo([SOURCE])))).toEqual([`${SOURCE}:${SHARED_ID}`]);
	});

	test('same table: each identity exactly once, shared section_id kept per section', async () => {
		const rows = identities(await run(deepPathSqo([SOURCE, TWIN_SAME_TABLE])));
		expect(rows.sort()).toEqual([`${SOURCE}:${SHARED_ID}`, `${TWIN_SAME_TABLE}:${SHARED_ID}`]);
	});

	test('two tables (UNION ALL): each identity exactly once', async () => {
		// Anti-vacuity: the twin really lives on another table, so this IS a UNION.
		const { sql: builtSql } = await buildSearchSql(deepPathSqo([SOURCE, TWIN_OTHER_TABLE]), {
			idsOnly: true,
		});
		expect([...builtSql.matchAll(/FROM (\w+) AS mix/g)].map((match) => match[1])).toEqual([
			'matrix_test',
			'matrix',
		]);
		const rows = identities(await run(deepPathSqo([SOURCE, TWIN_OTHER_TABLE])));
		expect(rows.sort()).toEqual([`${SOURCE}:${SHARED_ID}`, `${TWIN_OTHER_TABLE}:${SHARED_ID}`]);
	});

	test('explicit order (windowed shape): each identity exactly once', async () => {
		const order = [{ direction: 'DESC', path: [{ component_tipo: 'section_id' }] }];
		for (const twin of [TWIN_SAME_TABLE, TWIN_OTHER_TABLE]) {
			const { sql: builtSql } = await buildSearchSql(deepPathSqo([SOURCE, twin], { order }), {
				idsOnly: true,
			});
			expect(builtSql).toContain(') main_select');
			const rows = identities(await run(deepPathSqo([SOURCE, twin], { order })));
			expect(rows.sort()).toEqual([`${SOURCE}:${SHARED_ID}`, `${twin}:${SHARED_ID}`]);
		}
	});

	test('full_count counts identities — equals the rows served', async () => {
		expect(await fullCount(deepPathSqo([SOURCE, TWIN_SAME_TABLE]))).toBe(2);
		expect(await fullCount(deepPathSqo([SOURCE, TWIN_OTHER_TABLE]))).toBe(2);
	});

	test('multi-section with no filter: records sharing a section_id are all counted', async () => {
		const sqo = sanitizeClientSqo({ section_tipo: [SOURCE, TWIN_SAME_TABLE] });
		// SOURCE holds 900950 + 900951, the twin 900950: three identities.
		expect(await fullCount(sqo)).toBe(3);
	});
});
