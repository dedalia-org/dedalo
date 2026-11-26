/**
 * RELATIONS_SPEC.md Phase E units — the relation-family search fragments:
 *
 * 1. The _tm TWIN (PHP trait.search_component_relation_common_tm): on the
 *    matrix_time_machine table every operator emits scalar user_id SQL —
 *    SQL-string pinned (the search_Test pattern).
 * 2. The registry SEARCH face: relation-column models dispatch to the shared
 *    containment builder; children/index/external THROW their ledger reason.
 * 3. The autocomplete_hi ancestor wrap (buildRelationSearchAncestorFragment),
 *    executed directly against the shared DB: an ancestor locator present ONLY
 *    in relation_search matches the record. It is LIVE since 2026-08-09
 *    (WC-2026-08-09-autocomplete-hi-ancestor-search) — this header used to say
 *    "deliberately NOT live, PHP defect pin", which was the pre-decommission
 *    state: the wrap was withheld from dispatch pending a PHP fix that can
 *    never come. conform.ts now applies it, keyed on the leaf node's STORED
 *    ontology model; the LIVE dispatch is gated in
 *    search_date_and_ancestors_native.test.ts, this file gates the BUILDER.
 * 4. search_related filter_by_locators_op 'AND': intersection semantics on a
 *    record that holds BOTH targets, next to one that holds only the first.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The
// four DB-backed cases used to hunt install records — a `tema1` section with
// dd96 indexations, a maintained `numisdata4.relation_search` row, and the
// `numisdata3` §15657 fixture holding both object1/99 and object1/96 — and were
// the file's four reds on the suite database. They now run against a BUILT
// situation (`zzsb`, matrix_test through the test24 matrix_table node, ids in
// the 9009xx band, torn down with an asserted residue of 0), so each fixture is
// a row this file wrote and every count is EXACT. The pure SQL-string builders
// (the _tm twin, the registry face, relation_children) were already generic and
// are untouched.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { getRelationSearchFragmentBuilder } from '../../src/core/relations/registry.ts';
import {
	buildRelationFragment,
	buildRelationSearchAncestorFragment,
} from '../../src/core/search/builders/builder_relation.ts';
import { buildRelationChildrenFragment } from '../../src/core/search/builders/builder_relation_children.ts';
import { buildRelationIndexFragment } from '../../src/core/search/builders/builder_relation_index.ts';
import type { BuilderContext } from '../../src/core/search/builders/types.ts';
import { asSqlTipo } from '../../src/core/search/identifier_gate.ts';
import { ParamsCollector } from '../../src/core/search/params.ts';
import { findInverseReferences } from '../../src/core/search/search_related.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

/* -------------------------------------------------------------------------
 * THE SITUATION the three DB-backed describes run on.
 *   zzsb1  owner section        — §900961 holds BOTH targets, §900962 only the
 *                                 first (the AND/OR intersection), §900963
 *                                 carries an ancestor locator ONLY in
 *                                 relation_search (the autocomplete_hi wrap)
 *   zzsb2  component_portal     — the owning column; deliberately UNPAIRED
 *                                 (no component_relation_parent), which is the
 *                                 relation_children "drop the clause" case
 *   zzsb3  component_portal     — the ancestor-wrap column
 *   zzsb5  target section       — §900951 / §900952
 *   zzsb6  indexed section      — §900971 / §900972, pointed at by the dd96
 *                                 locators the relation_index builder scans
 *   zzsb7  component_relation_index — the column carrying those dd96 locators
 * ---------------------------------------------------------------------- */

const OWNER_SECTION = 'zzsb1';
const OWNER_PORTAL = 'zzsb2';
const ANCESTOR_PORTAL = 'zzsb3';
const TARGET_SECTION = 'zzsb5';
const INDEXED_SECTION = 'zzsb6';
const INDEX_COLUMN = 'zzsb7';

const TARGET_A = 900951;
const TARGET_B = 900952;
const OWNER_BOTH = 900961;
const OWNER_ONE = 900962;
const OWNER_ANCESTOR = 900963;
const INDEXED_IDS = [900971, 900972];

/** A plain portal locator on the owner column. */
const targetLocator = (sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_tipo: TARGET_SECTION,
	section_id: sectionId,
	from_component_tipo: OWNER_PORTAL,
});
/** DEDALO_RELATION_TYPE_INDEX_TIPO — what the relation_index builder scans for. */
const indexLocator = (sectionId: number) => ({
	id: 1,
	type: 'dd96',
	section_tipo: INDEXED_SECTION,
	section_id: sectionId,
	from_component_tipo: INDEX_COLUMN,
});
/**
 * The ancestor locator that exists ONLY in `relation_search` — the whole point
 * of the autocomplete_hi wrap: the relation column never holds it.
 */
const ANCESTOR_LOCATOR = {
	type: 'dd151',
	section_tipo: TARGET_SECTION,
	section_id: TARGET_B,
	from_component_tipo: ANCESTOR_PORTAL,
};

const S = situation({
	name: 'zzsb relation search builders',
	tld: 'zzsb',
	nodes: [
		{
			tipo: OWNER_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Propietarios', 'lg-eng': 'Owners' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: OWNER_PORTAL,
			parent: OWNER_SECTION,
			model: 'component_portal',
			term: { 'lg-spa': 'Portal' },
			relations: [{ tipo: TARGET_SECTION }],
		},
		{
			tipo: ANCESTOR_PORTAL,
			parent: OWNER_SECTION,
			model: 'component_portal',
			order_number: 2,
			term: { 'lg-spa': 'Portal jerárquico' },
			relations: [{ tipo: TARGET_SECTION }],
		},
		{
			tipo: INDEX_COLUMN,
			parent: OWNER_SECTION,
			model: 'component_relation_index',
			order_number: 3,
			term: { 'lg-spa': 'Indexación' },
		},
		{
			tipo: TARGET_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Destinos', 'lg-eng': 'Targets' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: INDEXED_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Sección indexada', 'lg-eng': 'Indexed section' },
			relations: [{ tipo: 'test24' }],
		},
	],
	records: [
		{ section_tipo: TARGET_SECTION, section_id: TARGET_A, columns: { data: {} } },
		{ section_tipo: TARGET_SECTION, section_id: TARGET_B, columns: { data: {} } },
		...INDEXED_IDS.map((sectionId) => ({
			section_tipo: INDEXED_SECTION,
			section_id: sectionId,
			columns: { data: {} },
		})),
		{
			section_tipo: OWNER_SECTION,
			section_id: OWNER_BOTH,
			columns: {
				relation: {
					[OWNER_PORTAL]: [targetLocator(TARGET_A), targetLocator(TARGET_B)],
					[INDEX_COLUMN]: [indexLocator(INDEXED_IDS[0] as number)],
				},
			},
		},
		{
			section_tipo: OWNER_SECTION,
			section_id: OWNER_ONE,
			columns: {
				relation: {
					[OWNER_PORTAL]: [targetLocator(TARGET_A)],
					[INDEX_COLUMN]: [indexLocator(INDEXED_IDS[1] as number)],
				},
			},
		},
		{
			section_tipo: OWNER_SECTION,
			section_id: OWNER_ANCESTOR,
			// The ancestor lives ONLY in relation_search — `relation` has no
			// ANCESTOR_PORTAL key at all, which is what makes the unwrapped
			// fragment miss and the wrap the only thing that can find it.
			columns: { relation_search: { [ANCESTOR_PORTAL]: [ANCESTOR_LOCATOR] } },
		},
	],
});

/** The table the ONTOLOGY resolves for the situation's sections. */
let TABLE = '';

beforeAll(async () => {
	await ensureSituation(S);
	const resolved = await getMatrixTableFromTipo(OWNER_SECTION);
	expect(resolved).toBe('matrix_test'); // the test24 relation, proven not assumed
	TABLE = resolved as string;
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

const tmContext: BuilderContext = {
	alias: 'tm',
	column: 'relation',
	tipo: asSqlTipo('dd578', 'test context'), // the TM envelope's user portal
	sectionTipo: 'dd15',
	table: 'matrix_time_machine',
	lang: 'lg-nolan',
	translatable: false,
	model: 'component_portal',
};

/** test3's component_relation_children (paired parent test71, table matrix_test). */
const childrenContext: BuilderContext = {
	alias: 'te3',
	column: 'relation',
	tipo: asSqlTipo('test201', 'test context'),
	sectionTipo: 'test3',
	table: 'matrix_test',
	lang: 'lg-nolan',
	translatable: false,
	model: 'component_relation_children',
};

/** Render a fragment to {sql, params} for SQL-string pinning. */
function render(result: ReturnType<typeof buildRelationFragment>): {
	sql: string;
	params: unknown[];
} {
	const collector = new ParamsCollector();
	if (result === false) return { sql: '', params: [] };
	if (result.kind === 'fragment') {
		return {
			sql: collector.substitute(result.sentence, result.tokenValues),
			params: collector.toArray(),
		};
	}
	const parts = result.items.map((item) => {
		if (item === false || item.kind !== 'fragment') return '';
		return collector.substitute(item.sentence, item.tokenValues);
	});
	const joiner = result.op === '$and' ? ' AND ' : ' OR ';
	return { sql: `( ${parts.join(joiner)} )`, params: collector.toArray() };
}

describe('_tm twin (matrix_time_machine scalar user_id column)', () => {
	test("default '==' resolves the locator's section_id to user_id =", () => {
		const { sql: rendered, params } = render(
			buildRelationFragment([{ section_tipo: 'dd128', section_id: '1' }], null, tmContext),
		);
		expect(rendered).toBe('tm.user_id = $1');
		expect(params).toEqual(['1']);
	});

	test("'!=' and '!==' are identical on the scalar column", () => {
		for (const operator of ['!=', '!==']) {
			const { sql: rendered, params } = render(
				buildRelationFragment([{ section_tipo: 'dd128', section_id: 7 }], operator, tmContext),
			);
			expect(rendered).toBe('tm.user_id != $1');
			expect(params).toEqual(['7']);
		}
	});

	test("'!*' / '*' are NULL checks", () => {
		expect(render(buildRelationFragment(null, '!*', tmContext)).sql).toBe('tm.user_id IS NULL');
		expect(render(buildRelationFragment(null, '*', tmContext)).sql).toBe('tm.user_id IS NOT NULL');
	});

	test('a q JSON STRING decodes (the PHP wire shape)', () => {
		const { sql: rendered, params } = render(
			buildRelationFragment('{"section_id": 3}', null, tmContext),
		);
		expect(rendered).toBe('tm.user_id = $1');
		expect(params).toEqual(['3']);
	});
});

/** A plain relation-column context (the containment builder, not the _tm twin). */
const relationContext: BuilderContext = {
	alias: 'te3',
	column: 'relation',
	tipo: asSqlTipo('test80', 'test context'),
	sectionTipo: 'test3',
	table: 'matrix_test',
	lang: 'lg-nolan',
	translatable: false,
	model: 'component_portal',
};

describe('relation q contract — operators in q_operator, a bad q is REFUSED', () => {
	// A non-locator q used to be dropped quietly: the clause vanished and the
	// search widened to the whole section (`q:'!*'` counted every record for
	// both '!*' and '*').
	test('a non-locator q throws request.invalid (glued operators included)', () => {
		for (const q of ['!*', '*', 'garbage', '{not json', 42, true, [1], [{ section_id: 1 }, 'x']]) {
			for (const operator of [null, '!=', '!==']) {
				expect(() => buildRelationFragment(q, operator, relationContext)).toThrow(
					expect.objectContaining({ code: 'request.invalid' }),
				);
			}
		}
	});

	test("no q ('', null, 'only_operator') is operator-only, not an error", () => {
		for (const q of [null, undefined, '', 'only_operator']) {
			expect(render(buildRelationFragment(q, '!*', relationContext)).sql).toBe(
				'NOT (te3.relation ? $1)',
			);
			expect(render(buildRelationFragment(q, '*', relationContext)).sql).toBe(
				'(te3.relation ? $1)',
			);
		}
	});

	test('a JSON-string locator (the PHP wire shape) decodes like the object', () => {
		const locator = { section_tipo: 'test3', section_id: 1 };
		expect(render(buildRelationFragment(JSON.stringify(locator), null, relationContext))).toEqual(
			render(buildRelationFragment(locator, null, relationContext)),
		);
	});
});

describe('registry search face', () => {
	test('the relation family shares the containment builder', async () => {
		for (const model of ['component_portal', 'component_select', 'component_relation_related']) {
			const builder = await getRelationSearchFragmentBuilder(model);
			expect(builder).toBe(buildRelationFragment);
		}
	});

	test('children/index dispatch to their DEDICATED pipelines (ported 2026-07-10)', async () => {
		expect(await getRelationSearchFragmentBuilder('component_relation_children')).toBe(
			buildRelationChildrenFragment,
		);
		expect(await getRelationSearchFragmentBuilder('component_relation_index')).toBe(
			buildRelationIndexFragment,
		);
	});

	test('external still THROWS — there is no SQL surface to search', async () => {
		expect(getRelationSearchFragmentBuilder('component_external')).rejects.toThrow(
			/not searchable/,
		);
	});
});

describe('relation_children builder (PHP trait.search_component_relation_children)', () => {
	const scanShape = /EXISTS \(SELECT 1 FROM "matrix_test" AS sub CROSS JOIN LATERAL/;

	test("default '==' emits the specific-child EXISTS; repeated _Q1_ collapses to ONE param", async () => {
		const result = await buildRelationChildrenFragment(
			{ section_tipo: 'test3', section_id: '5', id: 'dom-77' },
			null,
			childrenContext,
		);
		const { sql: rendered, params } = render(result as Exclude<typeof result, Promise<unknown>>);
		expect(rendered).toMatch(scanShape);
		expect(rendered).toContain("elem->>'section_id' = te3.section_id::text");
		expect(rendered).toContain("sub.section_id::text = ($2::text::jsonb->>'section_id')");
		// _Q1_ appears 3× in the sentence but binds ONCE: substitute() mints one
		// placeholder per TOKEN (replaceAll) — one sentence, one typing context.
		// Equal values in DIFFERENT fragments never share (params.ts header).
		expect(params).toEqual(['test71', '{"section_tipo":"test3","section_id":"5"}']);
	});

	test("'!*' / '*' are the parent-has-children scans (no _Q2_)", async () => {
		const empty = render(
			(await buildRelationChildrenFragment(null, '!*', childrenContext)) as never,
		);
		expect(empty.sql).toMatch(/^NOT EXISTS \(/);
		expect(empty.params).toEqual(['test71']);
		const notEmpty = render(
			(await buildRelationChildrenFragment(null, '*', childrenContext)) as never,
		);
		expect(notEmpty.sql).toMatch(/^EXISTS \(/);
		expect(notEmpty.params).toEqual(['test71']);
	});

	test("'!=' = has-children AND not-this-child; '!==' = single NOT EXISTS", async () => {
		const q = { section_tipo: 'test3', section_id: '9' };
		const different = render(
			(await buildRelationChildrenFragment(q, '!=', childrenContext)) as never,
		);
		expect(different.sql).toMatch(/^EXISTS \(.+\) AND NOT EXISTS \(/);
		const strict = render(
			(await buildRelationChildrenFragment(q, '!==', childrenContext)) as never,
		);
		expect(strict.sql).toMatch(/^NOT EXISTS \(/);
		expect(strict.sql).not.toContain(') AND NOT EXISTS (');
	});

	test('invalid q THROWS request.invalid — never a silent substitute', async () => {
		for (const q of ['garbage', '!*', 'only_operator']) {
			await expect(buildRelationChildrenFragment(q, null, childrenContext)).rejects.toMatchObject({
				code: 'request.invalid',
			});
		}
		// operator-only searches never read q
		expect(await buildRelationChildrenFragment('only_operator', '!*', childrenContext)).not.toBe(
			false,
		);
	});

	test('multi-locator arrays throw cleanly (PHP emits invalid jsonb)', async () => {
		expect(
			buildRelationChildrenFragment(
				[
					{ section_tipo: 'test3', section_id: '1' },
					{ section_tipo: 'test3', section_id: '2' },
				],
				null,
				childrenContext,
			),
		).rejects.toThrow(/multi-locator/);
	});

	test('unpaired components drop the clause (false); matrix_time_machine throws', async () => {
		// zzsb2 is a portal this file authored with NO paired
		// component_relation_parent anywhere in its section.
		expect(
			await buildRelationChildrenFragment(null, '*', {
				...childrenContext,
				tipo: asSqlTipo(OWNER_PORTAL, 'test context'),
				sectionTipo: OWNER_SECTION,
				table: TABLE,
			}),
		).toBe(false);
		expect(
			buildRelationChildrenFragment(null, '*', {
				...childrenContext,
				table: 'matrix_time_machine',
			}),
		).rejects.toThrow(/time-machine/);
	});
});

describe('relation_index builder (PHP trait.search_component_relation_index)', () => {
	// The SEARCHED section is zzsb6: this file wrote the two dd96 locators that
	// point at it, so the emitted id list is EXACTLY its two records.
	const indexContext: BuilderContext = {
		alias: 'h1',
		column: 'relation',
		tipo: asSqlTipo(INDEX_COLUMN, 'test context'),
		sectionTipo: INDEXED_SECTION,
		table: 'matrix_test',
		lang: 'lg-nolan',
		translatable: false,
		model: 'component_relation_index',
	};

	test("'*' emits an UNCORRELATED SEMI-JOIN over matrix_relation_index", async () => {
		// PERF-05: the ids are no longer materialised in the process and inlined
		// as literals — the database resolves the set. The rows are identical
		// (proved by executing both shapes in relation_index_semijoin_native).
		const result = await buildRelationIndexFragment(null, '*', indexContext);
		const { sql: rendered, params } = render(result as never);
		expect(rendered).toStartWith('h1.section_id IN (SELECT');
		expect(rendered).toContain('matrix_relation_index');
		expect(rendered).not.toMatch(/IN \(\s*\d/); // no inlined id list
		expect(params).toEqual([INDEXED_SECTION, 'dd96']); // bound, not interpolated
	});

	test("'!*' emits NOT IN over the same subselect", async () => {
		const result = await buildRelationIndexFragment(null, '!*', indexContext);
		const { sql: rendered } = render(result as never);
		expect(rendered).toStartWith('h1.section_id NOT IN (SELECT');
		expect(rendered).toContain('matrix_relation_index');
		// NULL-safe by construction: the subselect excludes NULL target ids.
		expect(rendered).toContain('target_section_id IS NOT NULL');
	});

	test('a reference-less section needs no 1=0 / 1=1 (the empty semi-join answers)', async () => {
		// The set is EMPTY, not special-cased: `IN (empty)` is false for every row
		// and `NOT IN (empty)` is true for every row. The behavioural proof (real
		// rows, both operators) is relation_index_semijoin_native.test.ts.
		const bare = {
			...indexContext,
			tipo: asSqlTipo('test149', 'test context'),
			sectionTipo: 'test65',
			table: 'matrix_test',
		};
		expect(render((await buildRelationIndexFragment(null, '*', bare)) as never).sql).not.toBe(
			'1=0',
		);
		expect(render((await buildRelationIndexFragment(null, '!*', bare)) as never).sql).not.toBe(
			'1=1',
		);
		expect(render((await buildRelationIndexFragment(null, '*', bare)) as never).sql).toContain(
			'matrix_relation_index',
		);
	});

	test('any other operator drops the clause (PHP returns the SQO sentence-less)', async () => {
		for (const operator of [null, '==', '!=', '!==']) {
			expect(await buildRelationIndexFragment(null, operator, indexContext)).toBe(false);
		}
	});

	test('matrix_time_machine throws (no _tm twin exists)', async () => {
		expect(
			buildRelationIndexFragment(null, '*', { ...indexContext, table: 'matrix_time_machine' }),
		).rejects.toThrow(/time-machine/);
	});
});

describe('autocomplete_hi ancestor wrap (LIVE since 2026-08-09 — the builder, unit-gated)', () => {
	test('an ancestor locator present ONLY in relation_search matches through the wrap', async () => {
		// §900963 carries the ancestor in `relation_search` and NOWHERE in
		// `relation` — the exact shape a maintained autocomplete_hi index row has.
		const context: BuilderContext = {
			alias: 'm',
			column: 'relation',
			tipo: asSqlTipo(ANCESTOR_PORTAL, 'test context'),
			sectionTipo: OWNER_SECTION,
			table: TABLE,
			lang: 'lg-nolan',
			translatable: false,
			model: 'component_portal',
		};
		const wrapped = buildRelationSearchAncestorFragment([ANCESTOR_LOCATOR], null, context);
		const { sql: whereSql, params } = render(wrapped);
		expect(whereSql).toContain('relation_search');

		const counted = (await sql.unsafe(
			`SELECT count(*)::int AS total FROM "${TABLE}" m
			 WHERE m.section_tipo = '${OWNER_SECTION}' AND m.section_id = ${OWNER_ANCESTOR} AND ${whereSql}`,
			params as string[],
		)) as { total: number }[];
		expect(counted[0]?.total).toBe(1);

		// The UNWRAPPED clause — the relation-column-only fragment every OTHER
		// relation model still gets — does NOT match, proving the wrap is what
		// recovers ancestor hits (and that this test is not vacuous).
		const direct = buildRelationFragment([ANCESTOR_LOCATOR], null, context);
		const { sql: directSql, params: directParams } = render(direct);
		const directCount = (await sql.unsafe(
			`SELECT count(*)::int AS total FROM "${TABLE}" m
			 WHERE m.section_tipo = '${OWNER_SECTION}' AND m.section_id = ${OWNER_ANCESTOR} AND ${directSql}`,
			directParams as string[],
		)) as { total: number }[];
		expect(directCount[0]?.total).toBe(0);
	}, 30000);
});

describe("search_related filter_by_locators_op 'AND'", () => {
	const both = [
		{ section_tipo: TARGET_SECTION, section_id: TARGET_A, from_component_tipo: OWNER_PORTAL },
		{ section_tipo: TARGET_SECTION, section_id: TARGET_B, from_component_tipo: OWNER_PORTAL },
	];

	test('AND returns the intersection (a strict subset of OR here)', async () => {
		const orHits = await findInverseReferences(both, { limit: false, order: 'section_id' });
		const andHits = await findInverseReferences(both, {
			limit: false,
			order: 'section_id',
			op: 'AND',
		});
		// OR = every owner touching EITHER target (§900961 + §900962);
		// AND = only the owner holding BOTH (§900961). Exact, both minted here.
		expect(orHits.map((hit) => hit.section_id).sort()).toEqual([OWNER_ONE, OWNER_BOTH].sort());
		expect(andHits.length).toBeGreaterThan(0);
		expect(andHits.length).toBeLessThan(orHits.length);
		const orKeys = new Set(orHits.map((hit) => `${hit.section_tipo}_${hit.section_id}`));
		for (const hit of andHits) {
			expect(orKeys.has(`${hit.section_tipo}_${hit.section_id}`)).toBe(true);
		}
		expect(
			andHits.some((hit) => hit.section_tipo === OWNER_SECTION && hit.section_id === OWNER_BOTH),
		).toBe(true);
	}, 30000);
});
