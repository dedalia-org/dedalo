/**
 * matrix_relation_index — the per-locator relation index (phases 1-2,
 * 2026-07-20): sync-trigger round-trip, index-driven search_related paths vs
 * flat-function ground truth (result equality on live data), and the WC-012
 * format:'function' leaf translation shape.
 *
 * The index is DERIVED and never authoritative; these gates pin that the
 * covered paths return exactly what the classic flat-GIN containment returns.
 *
 * THE TWO LEDGERED DEFECTS ARE REPAIRED (2026-08-20), and the repair is the
 * generic-`test`-TLD migration itself:
 *  1. MUTABLE-PRODUCTION FIXTURE → gone. The `> 100` counts were asserted
 *     against INSTALLED `rsc` records nobody minted for this gate and anyone
 *     may edit. Every fixture is now BUILT here (`zzri`, matrix_test, ids in
 *     the 9009xx band) and every count is EXACT, not a floor.
 *  2. INVISIBLE GREEN → gone. `if (!(await storeReady())) return;` made the
 *     whole file report PASS having asserted nothing wherever the relation
 *     index store is absent. The store readiness is now asserted ONCE in
 *     beforeAll: a database without the trigger reddens this file loudly
 *     instead of passing silently.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules): the
// rsc197/6848 production target and its rsc205/rsc139 owners were replaced by a
// BUILT situation, and every raw ground-truth query moved off the hard-coded
// `matrix` onto the table the ontology resolves for a `test24` section
// (matrix_test) — reading `matrix` after the rename would have compared the
// index against rows the gate never wrote.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	countInverseReferences,
	findInverseReferenceLocators,
	findInverseReferences,
} from '../../src/core/search/search_related.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const SCRATCH_ID = 999903; // matrix_test scratch surface

/** The referenced record every owner below points at. */
const TARGET_SECTION = 'zzri3';
const TARGET_ID = 900901;
const TARGET = { section_tipo: TARGET_SECTION, section_id: TARGET_ID };
/** Owner section A and its portal — 25 records, so a 10+10 paging is exact. */
const OWNER_A = 'zzri1';
const OWNER_A_COMPONENT = 'zzri2';
const OWNER_A_IDS = Array.from({ length: 25 }, (_, index) => 900911 + index);
/** Owner section B — a SECOND owning section, so the group-by is not vacuous. */
const OWNER_B = 'zzri4';
const OWNER_B_COMPONENT = 'zzri5';
const OWNER_B_IDS = [900941, 900942, 900943, 900944];

/** The stored locator an owner record carries (what the trigger indexes). */
function ownerLocator(fromComponentTipo: string) {
	return {
		id: 1,
		type: 'dd151',
		section_tipo: TARGET_SECTION,
		section_id: TARGET_ID,
		from_component_tipo: fromComponentTipo,
	};
}

const S = situation({
	name: 'zzri relation index store',
	tld: 'zzri',
	nodes: [
		{
			tipo: OWNER_A,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Propietarios A', 'lg-eng': 'Owners A' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: OWNER_A_COMPONENT,
			parent: OWNER_A,
			model: 'component_portal',
			term: { 'lg-spa': 'Portal A' },
			relations: [{ tipo: TARGET_SECTION }],
		},
		{
			tipo: TARGET_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Destino', 'lg-eng': 'Target' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: OWNER_B,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Propietarios B', 'lg-eng': 'Owners B' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: OWNER_B_COMPONENT,
			parent: OWNER_B,
			model: 'component_portal',
			term: { 'lg-spa': 'Portal B' },
			relations: [{ tipo: TARGET_SECTION }],
		},
	],
	records: [
		{ section_tipo: TARGET_SECTION, section_id: TARGET_ID, columns: { data: {} } },
		...OWNER_A_IDS.map((sectionId) => ({
			section_tipo: OWNER_A,
			section_id: sectionId,
			columns: { relation: { [OWNER_A_COMPONENT]: [ownerLocator(OWNER_A_COMPONENT)] } },
		})),
		...OWNER_B_IDS.map((sectionId) => ({
			section_tipo: OWNER_B,
			section_id: sectionId,
			columns: { relation: { [OWNER_B_COMPONENT]: [ownerLocator(OWNER_B_COMPONENT)] } },
		})),
	],
});

/** The table the ONTOLOGY resolves for the owner sections — never hard-coded. */
let TABLE = '';

async function storeReady(): Promise<boolean> {
	const rows = (await sql`
		SELECT 1 AS ok FROM pg_trigger WHERE tgname = 'matrix_test_relation_index_sync' LIMIT 1
	`) as { ok: number }[];
	return rows.length > 0;
}

beforeAll(async () => {
	// THE END OF THE INVISIBLE GREEN: without the sync trigger the index-driven
	// paths below cannot be asserted at all, so the file must go RED, not quietly
	// pass. This replaces the per-case `if (!(await storeReady())) return;`.
	expect(await storeReady()).toBe(true);
	await ensureSituation(S);
	const resolved = await getMatrixTableFromTipo(OWNER_A);
	expect(resolved).toBe('matrix_test'); // the test24 relation, proven not assumed
	TABLE = resolved as string;
}, 60000);

afterAll(async () => {
	await sql`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = ${SCRATCH_ID}`;
	expect(await dropSituation(S)).toBe(0);
});

describe('sync trigger', () => {
	test('insert/update/delete keep matrix_relation_index in sync; non-numeric ids are skipped', async () => {
		const storeRows = () =>
			sql`SELECT from_component_tipo, type, target_section_tipo, target_section_id
			    FROM matrix_relation_index
			    WHERE section_tipo = 'test3' AND section_id = ${SCRATCH_ID}
			    ORDER BY from_component_tipo, target_section_id` as Promise<
				{
					from_component_tipo: string;
					type: string | null;
					target_section_tipo: string;
					target_section_id: number;
				}[]
			>;
		await sql`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = ${SCRATCH_ID}`;
		await sql`INSERT INTO matrix_test (section_tipo, section_id, relation)
		          VALUES ('test3', ${SCRATCH_ID}, '{"test52":[
		            {"type":"dd151","section_tipo":"test3","section_id":"7"},
		            {"type":"dd151","section_tipo":"test3","section_id":7},
		            {"type":"dd151","section_tipo":"test3","section_id":"not_numeric"}
		          ]}'::jsonb)`;
		let rows = await storeRows();
		// both string "7" and number 7 normalize to int 7; the junk locator is skipped
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.target_section_id === 7 && r.type === 'dd151')).toBe(true);
		await sql`UPDATE matrix_test SET relation = '{"test52":[{"type":"dd151","section_tipo":"test3","section_id":"9"}]}'::jsonb
		          WHERE section_tipo = 'test3' AND section_id = ${SCRATCH_ID}`;
		rows = await storeRows();
		expect(rows.map((r) => r.target_section_id)).toEqual([9]);
		await sql`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = ${SCRATCH_ID}`;
		rows = await storeRows();
		expect(rows).toEqual([]);
	});
});

describe('index-driven search_related equals flat-function ground truth', () => {
	test('findInverseReferences — same owner set as raw jsonb ground truth (owner-A scope)', async () => {
		// Ground truth from the RAW jsonb (no flat functions — their indexes are
		// retired), section-scoped so the expansion is bitmap-bounded.
		const truth = (await sql.unsafe(
			`SELECT DISTINCT m.section_tipo, m.section_id FROM "${TABLE}" m
			 WHERE m.section_tipo = $1 AND EXISTS (
				SELECT 1 FROM jsonb_each(m.relation) kv, jsonb_array_elements(kv.value) e
				WHERE jsonb_typeof(kv.value) = 'array'
				  AND e->>'section_tipo' = $2 AND e->>'section_id' = $3)`,
			[OWNER_A, TARGET_SECTION, String(TARGET_ID)],
		)) as { section_tipo: string; section_id: number }[];
		const truthKeys = new Set(truth.map((r) => `${r.section_tipo}/${r.section_id}`));
		// EXACT, not a floor: this file minted every one of them.
		expect(truthKeys.size).toBe(OWNER_A_IDS.length);

		const hits = await findInverseReferences([TARGET], {
			limit: false,
			order: 'section_id',
			sectionTipos: [OWNER_A],
		});
		const hitKeys = new Set(hits.map((h) => `${h.section_tipo}/${h.section_id}`));
		expect([...hitKeys].sort()).toEqual([...truthKeys].sort());
		expect(hits.length).toBe(hitKeys.size); // no duplicate owners
	}, 30000);

	test('countInverseReferences — total and section_tipo grouping match the find set', async () => {
		const hits = await findInverseReferences([TARGET], { limit: false });
		const counted = await countInverseReferences([TARGET], { groupBy: ['section_tipo'] });
		expect(counted.total).toBe(hits.length);
		// TWO owning sections, so the group-by really groups.
		expect(counted.total).toBe(OWNER_A_IDS.length + OWNER_B_IDS.length);
		const byTipo = new Map<string, number>();
		for (const hit of hits) byTipo.set(hit.section_tipo, (byTipo.get(hit.section_tipo) ?? 0) + 1);
		expect([...byTipo.entries()].sort()).toEqual([
			[OWNER_A, OWNER_A_IDS.length],
			[OWNER_B, OWNER_B_IDS.length],
		]);
		for (const group of counted.totals_group ?? []) {
			expect(group.value).toBe(byTipo.get(group.key[0] as string) as number);
		}
	}, 30000);

	test('findInverseReferenceLocators — exact locator payloads survive the index row-narrowing', async () => {
		const hits = await findInverseReferenceLocators(
			[{ ...TARGET, from_component_tipo: OWNER_A_COMPONENT }],
			{ limit: false, order: 'section_id' },
		);
		// EXACT: only owner A's records carry this from_component_tipo.
		expect(hits.length).toBe(OWNER_A_IDS.length);
		for (const hit of hits) {
			expect(hit.locator_data.section_tipo).toBe(TARGET_SECTION);
			expect(String(hit.locator_data.section_id)).toBe(String(TARGET_ID));
			expect(hit.locator_data.from_component_tipo).toBe(OWNER_A_COMPONENT);
		}
	}, 30000);

	test('order table + limit pagination stays exact (relation_list shape)', async () => {
		const pageA = await findInverseReferences([TARGET], { limit: 10, offset: 0 });
		const pageB = await findInverseReferences([TARGET], { limit: 10, offset: 10 });
		expect(pageA.length).toBe(10);
		expect(pageB.length).toBe(10);
		const overlap = new Set(pageA.map((h) => `${h.section_tipo}/${h.section_id}`));
		expect(pageB.some((h) => overlap.has(`${h.section_tipo}/${h.section_id}`))).toBe(false);
	}, 30000);
});

describe('WC-012 format:function leaf translation', () => {
	test('covered table emits the matrix_relation_index tuple-IN, key parsed into columns', async () => {
		const sqo = sanitizeClientSqo(
			structuredClone({
				section_tipo: [OWNER_A],
				limit: 10,
				offset: 0,
				filter: {
					$and: [
						{
							format: 'function',
							use_function: 'relations_flat_fct_st_si',
							q: `${OWNER_A_COMPONENT}_${TARGET_SECTION}_${TARGET_ID}`,
							path: [{ section_tipo: OWNER_A, component_tipo: OWNER_A_COMPONENT }],
						},
					],
				},
			}) as never,
		);
		const { sql: builtSql, params } = await buildSearchSql(sqo, {});
		expect(builtSql).toContain('FROM matrix_relation_index r');
		expect(builtSql).toContain('r.from_component_tipo = $');
		expect(builtSql).toContain('r.target_section_id = $');
		expect(builtSql).not.toContain('data_relations_flat');
		expect(params).toContain(OWNER_A_COMPONENT);
		expect(params).toContain(TARGET_SECTION);
		expect(params).toContain(String(TARGET_ID));
		// result equality vs the raw jsonb enumeration (the source of truth —
		// the retired flat containment's semantics, expressed directly)
		const viaIndex = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${TABLE}" mix WHERE mix.section_tipo = $1
			 AND (mix.section_tipo, mix.section_id) IN
			   (SELECT r.section_tipo, r.section_id FROM matrix_relation_index r
			    WHERE r.from_component_tipo = $2 AND r.target_section_tipo = $3 AND r.target_section_id = $4)`,
			[OWNER_A, OWNER_A_COMPONENT, TARGET_SECTION, TARGET_ID],
		)) as { n: number }[];
		const viaJsonb = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${TABLE}" mix WHERE mix.section_tipo = $1
			 AND EXISTS (
				SELECT 1 FROM jsonb_each(mix.relation) AS kv, jsonb_array_elements(kv.value) AS e
				WHERE jsonb_typeof(kv.value) = 'array' AND kv.key = $2
				  AND e->>'section_tipo' = $3 AND e->>'section_id' = $4)`,
			[OWNER_A, OWNER_A_COMPONENT, TARGET_SECTION, String(TARGET_ID)],
		)) as { n: number }[];
		expect(viaIndex[0]?.n).toBe(viaJsonb[0]?.n as number);
		expect(viaIndex[0]?.n).toBe(OWNER_A_IDS.length);
	}, 30000);
});
