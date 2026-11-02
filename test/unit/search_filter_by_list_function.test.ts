/**
 * Relation filter leaves (conform.ts) — the autocomplete picker's pre-filter
 * checkboxes (e.g. test6100's test6230 "Catálogo" filter). Both wire
 * shapes resolve to the same exact tuple-IN over matrix_relation_index:
 *
 * CANONICAL format:'relation' (2026-07-21): q is a partial locator object
 *   ({from_component_tipo, section_tipo, section_id, type?}) or an array of
 *   them (array = OR within the leaf). Strictly validated.
 *
 * DEPRECATED format:'function' (WC-012 reader, kept for beta-era saved
 *   searches): { q:'"<fct>_<st>_<si>"', use_function:'relations_flat_*' } —
 *   the v6-era vocabulary; the stored functions were REMOVED 2026-07-20.
 *
 * DELIBERATE functionality-over-parity: the live PHP oracle interpolated the
 * v6 name verbatim → SQL error → 0 results (probed 2026-07-09; TS used to
 * IGNORE the clause → unfiltered results, the reported bug). These cases
 * therefore assert TS ground truth, NOT PHP equality.
 *
 * Fixtures: test6099 gated by catalogue select test6323 → testcatalogs1
 * records (catalogue 1 = 5425 rows, catalogue 2 = 2726, probed 2026-07-09 —
 * re-derived in-test, never hardcoded).
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const SECTION = 'test6099';
const SECTION_TABLE = 'matrix_test';
const FILTER_COMPONENT = 'test6323';
const CATALOGUE_SECTION = 'testcatalogs1';
/** The two catalogue records the corpus holds — the filter's two checkboxes. */
const CATALOGUE_A = '1';
const CATALOGUE_B = '12';
/**
 * The gate BUILDS its own gated records instead of hoping the corpus links
 * both catalogues: three scratch rows in a band no corpus record reaches,
 * TWO on catalogue A and ONE on catalogue B, so every count below is non-zero
 * AND the union is strictly larger than either side. Ground truth is always
 * re-derived from the same table, so ambient corpus rows never skew a case.
 */
const SCRATCH_IDS: readonly [number, number, number] = [934200, 934201, 934202];
const SCRATCH_CATALOGUE: Record<number, string> = {
	934200: CATALOGUE_A,
	934201: CATALOGUE_A,
	934202: CATALOGUE_B,
};

function functionClause(useFunction: string, key: string): Record<string, unknown> {
	return {
		q: JSON.stringify(key),
		path: [{ section_tipo: SECTION, component_tipo: FILTER_COMPONENT }],
		format: 'function',
		use_function: useFunction,
	};
}

async function runCount(filter: Record<string, unknown>): Promise<number> {
	const sqo = sanitizeClientSqo(
		structuredClone({ section_tipo: [SECTION], limit: 10, offset: 0, full_count: true, filter }),
	);
	const { sql: builtSql, params } = await buildSearchSql(sqo, {});
	const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		full_count: number | string;
	}[];
	return rows.reduce((sum, row) => sum + Number(row.full_count), 0);
}

async function purgeScratch(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM ${SECTION_TABLE} WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
		[SECTION, `{${SCRATCH_IDS.join(',')}}`],
	);
}

let dbReady = false;
beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false; // no shared DB on this machine — cases skip honestly
		return;
	}
	// The catalogue records the locators point at, then OUR gated rows. The
	// INSERT fires all_matrix_relation_index_sync, which is what the tuple-IN
	// under test reads.
	await ensureTestCorpus([CATALOGUE_SECTION]);
	await purgeScratch(); // belt and braces: a crashed earlier run
	for (const id of SCRATCH_IDS) {
		await sql.unsafe(
			`INSERT INTO ${SECTION_TABLE} (section_id, section_tipo, relation)
			 VALUES ($1, $2, $3::text::jsonb)`,
			[
				id,
				SECTION,
				JSON.stringify({
					[FILTER_COMPONENT]: [
						{
							id: 1,
							type: 'dd151',
							section_id: SCRATCH_CATALOGUE[id],
							section_tipo: CATALOGUE_SECTION,
							from_component_tipo: FILTER_COMPONENT,
						},
					],
				}),
			],
		);
	}
});

afterAll(async () => {
	if (!dbReady) return;
	await purgeScratch();
	expect(await dropTestCorpus([CATALOGUE_SECTION])).toBe(0);
});

function relationClause(q: unknown): Record<string, unknown> {
	return {
		q,
		path: [{ section_tipo: SECTION, component_tipo: FILTER_COMPONENT }],
		format: 'relation',
	};
}

async function catalogueTruth(catalogueIds: string[]): Promise<number> {
	const truth = (await sql.unsafe(
		`SELECT count(*)::int AS c FROM ${SECTION_TABLE}
		 WHERE section_tipo = $1 AND EXISTS (
			SELECT 1 FROM jsonb_array_elements(relation->$2) e
			WHERE e->>'section_tipo' = $3
			  AND e->>'section_id' IN (SELECT jsonb_array_elements_text($4::text::jsonb))
			  AND e->>'from_component_tipo' = $2)`,
		[SECTION, FILTER_COMPONENT, CATALOGUE_SECTION, JSON.stringify(catalogueIds)],
	)) as { c: number }[];
	return truth[0]?.c ?? 0;
}

describe("filter leaves format:'relation' (canonical, 2026-07-21)", () => {
	test('single locator object narrows to the ground-truth record set', async () => {
		if (!dbReady) return;
		for (const catalogueId of [CATALOGUE_A, CATALOGUE_B]) {
			const expected = await catalogueTruth([catalogueId]);
			expect(expected).toBeGreaterThan(0); // fixture guard
			const total = await runCount({
				$and: [
					{
						$or: [
							relationClause({
								from_component_tipo: FILTER_COMPONENT,
								section_tipo: CATALOGUE_SECTION,
								section_id: catalogueId,
							}),
						],
					},
				],
			});
			expect(total).toBe(expected);
		}
	});

	test('array q = OR within the leaf (one index subquery, union of both sets)', async () => {
		if (!dbReady) return;
		const expected = await catalogueTruth([CATALOGUE_A, CATALOGUE_B]);
		const total = await runCount({
			$and: [
				relationClause([
					{
						from_component_tipo: FILTER_COMPONENT,
						section_tipo: CATALOGUE_SECTION,
						section_id: Number(CATALOGUE_A),
					},
					{
						from_component_tipo: FILTER_COMPONENT,
						section_tipo: CATALOGUE_SECTION,
						section_id: CATALOGUE_B,
					},
				]),
			],
		});
		expect(total).toBe(expected);
	});

	test('array leaf equals the $or-of-single-leaves form (both wire shapes)', async () => {
		if (!dbReady) return;
		const viaOperators = await runCount({
			$and: [
				{
					$or: [
						relationClause({
							from_component_tipo: FILTER_COMPONENT,
							section_tipo: CATALOGUE_SECTION,
							section_id: Number(CATALOGUE_A),
						}),
						relationClause({
							from_component_tipo: FILTER_COMPONENT,
							section_tipo: CATALOGUE_SECTION,
							section_id: Number(CATALOGUE_B),
						}),
					],
				},
			],
		});
		expect(viaOperators).toBe(await catalogueTruth([CATALOGUE_A, CATALOGUE_B]));
	});

	test('strict validation: unknown field, bad tipo, non-integer id, empty array all throw', async () => {
		if (!dbReady) return;
		await expect(
			runCount({ $and: [relationClause({ section_tipo: CATALOGUE_SECTION, bogus: 'x' })] }),
		).rejects.toThrow(/unknown locator field 'bogus'/);
		await expect(
			runCount({ $and: [relationClause({ section_tipo: "x'; DROP--" })] }),
		).rejects.toThrow(/invalid tipo/);
		await expect(
			runCount({
				$and: [relationClause({ section_tipo: CATALOGUE_SECTION, section_id: '1 OR 1=1' })],
			}),
		).rejects.toThrow(/is not an integer/);
		await expect(runCount({ $and: [relationClause([])] })).rejects.toThrow(/q array is empty/);
		await expect(runCount({ $and: [relationClause({ section_id: 1 })] })).rejects.toThrow(
			/needs a section_tipo/,
		);
	});
});

describe("filter_by_list format:'function' (DEPRECATED reader, WC-012)", () => {
	test('single catalogue clause narrows to the ground-truth record set', async () => {
		if (!dbReady) return;
		for (const catalogueId of [CATALOGUE_A, CATALOGUE_B]) {
			const truth = (await sql.unsafe(
				`SELECT count(*)::int AS c FROM ${SECTION_TABLE}
				 WHERE section_tipo = $1 AND EXISTS (
					SELECT 1 FROM jsonb_array_elements(relation->$2) e
					WHERE e->>'section_tipo' = $3 AND e->>'section_id' = $4
					  AND e->>'from_component_tipo' = $2)`,
				[SECTION, FILTER_COMPONENT, CATALOGUE_SECTION, catalogueId],
			)) as { c: number }[];
			expect(truth[0]?.c).toBeGreaterThan(0); // fixture guard
			const total = await runCount({
				$and: [
					{
						$or: [
							functionClause(
								'relations_flat_fct_st_si',
								`${FILTER_COMPONENT}_${CATALOGUE_SECTION}_${catalogueId}`,
							),
						],
					},
				],
			});
			expect(total).toBe(truth[0]?.c as number);
		}
	});

	test('two catalogue clauses under $or = union of both sets', async () => {
		if (!dbReady) return;
		const truth = (await sql.unsafe(
			`SELECT count(*)::int AS c FROM ${SECTION_TABLE}
			 WHERE section_tipo = $1 AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(relation->$2) e
				WHERE e->>'section_tipo' = $3 AND e->>'section_id' IN ('1','2')
				  AND e->>'from_component_tipo' = $2)`,
			[SECTION, FILTER_COMPONENT, CATALOGUE_SECTION],
		)) as { c: number }[];
		const total = await runCount({
			$and: [
				{
					$or: [
						functionClause(
							'relations_flat_fct_st_si',
							`${FILTER_COMPONENT}_${CATALOGUE_SECTION}_1`,
						),
						functionClause(
							'relations_flat_fct_st_si',
							`${FILTER_COMPONENT}_${CATALOGUE_SECTION}_2`,
						),
					],
				},
			],
		});
		expect(total).toBe(truth[0]?.c as number);
	});

	test('unknown use_function throws loudly (allowlist-only, never interpolated)', async () => {
		if (!dbReady) return;
		await expect(
			runCount({
				$and: [{ $or: [functionClause('pg_sleep; DROP TABLE matrix', 'x_y_1')] }],
			}),
		).rejects.toThrow(/unknown use_function/);
	});

	test('malformed flat key contributes nothing (no crash, unfiltered)', async () => {
		if (!dbReady) return;
		const unfiltered = await runCount({ $and: [] });
		const total = await runCount({
			$and: [{ $or: [functionClause('relations_flat_fct_st_si', "bad'); DROP--")] }],
		});
		expect(total).toBe(unfiltered);
	});
});
