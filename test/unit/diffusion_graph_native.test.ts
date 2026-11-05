/**
 * NATIVE gate for the diffusion ontology-graph interpretation (Tier-3 3.9).
 *
 * The walk rules used to be inlined in src/core/diffusion_bridge/diffusion_map.ts
 * and were 0%-covered for a structural reason, not neglect: the test DB's
 * dd_ontology predates `properties.diffusion.type`, so every element resolved
 * 'unknown' and no meaningful target was ever built. The fix is the seam —
 * src/core/diffusion_bridge/diffusion_graph.ts takes a `DiffusionGraph`
 * (node/children/properties), so the rules are exercised against a STUB graph
 * with no DB at all.
 *
 * Scratch namespace: pure + stubbed DiffusionGraph. No DB writes, no DB reads.
 */
// Migrated to the generic `test` TLD 2026-08-19: the graph is a STUB (no DB at
// all), so the section tipos are only labels — now generic test-TLD ones.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type ElementOutcome,
	foldElementOutcomes,
	targetKey,
} from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import {
	collectConsumedReals,
	type DiffusionGraph,
	type DiffusionSqlTarget,
	resolveAliasTarget,
	resolveDomainTipo,
	selectMediaIndexTargets,
	walkDiffusionSections,
	walkDiffusionTargets,
} from '../../src/core/diffusion_bridge/diffusion_graph.ts';
import { nameOrLabelOf } from '../../src/core/ontology/labels.ts';

// ---------------------------------------------------------------- stub graph

interface StubSpec {
	tipo: string;
	parent?: string;
	model?: string;
	term?: Record<string, string> | null;
	machine_name?: string | null;
	use_machine_name?: boolean | null;
	relations?: string[];
	properties?: Record<string, unknown> | null;
}

/** Label helper: the 'lg-spa' translation the walk prefers. */
const t = (label: string): Record<string, string> => ({ 'lg-spa': label });

/**
 * In-memory DiffusionGraph. Children come out in SPEC ORDER — walk order is
 * the contract for every first-hit selection below, so the tests state it
 * explicitly by ordering the specs.
 */
function makeGraph(specs: StubSpec[]): DiffusionGraph {
	const byTipo = new Map<string, StubSpec>();
	const childrenOf = new Map<string, string[]>();
	for (const spec of specs) {
		byTipo.set(spec.tipo, spec);
		if (spec.parent !== undefined) {
			const list = childrenOf.get(spec.parent) ?? [];
			list.push(spec.tipo);
			childrenOf.set(spec.parent, list);
		}
	}
	return {
		async node(tipo) {
			const spec = byTipo.get(tipo);
			if (spec === undefined) return null;
			return {
				tipo: spec.tipo,
				parent: spec.parent ?? null,
				model: spec.model ?? '',
				term: spec.term === undefined ? null : spec.term,
				...(spec.use_machine_name === undefined
					? {}
					: { machine_name: spec.machine_name ?? null, use_machine_name: spec.use_machine_name }),
				relations: (spec.relations ?? []).map((tipoRef) => ({ tipo: tipoRef })),
			};
		},
		async children(tipo) {
			return childrenOf.get(tipo) ?? [];
		},
		async properties(tipo) {
			const spec = byTipo.get(tipo);
			return spec?.properties ?? null;
		},
	};
}

const SQL_ELEMENT = { diffusion: { type: 'sql' } };

// --------------------------------------------------- nameOrLabelOf / domain
//
// RE-PINNED 2026-11-04 (WC-2026-11-04-ontology-machine-names): the graph's own
// first-non-empty `termOf` was DELETED in favour of the one name reader
// (labels.ts nameOrLabelOf) over dd_ontology.machine_name — a name node is
// named by its machine name ONLY, so a stray translation that sorts first in
// jsonb can no longer become a database/table name.

describe('nameOrLabelOf (the diffusion name reader)', () => {
	test('a NAME node reads its machine name, never a decoy translation', async () => {
		const graph = makeGraph([
			{
				tipo: 'a',
				model: 'table',
				term: { 'lg-ara': 'decoy', 'lg-eus': 'Berria', 'lg-spa': 'not_the_name' },
				machine_name: 'body_references',
				use_machine_name: true,
			},
			// collision / missing at the parser → NULL: refuses, never guesses
			{ tipo: 'b', model: 'table', term: { 'lg-spa': 'x', 'lg-eng': 'y' }, use_machine_name: true },
		]);
		expect(nameOrLabelOf(await graph.node('a'))).toBe('body_references');
		expect(nameOrLabelOf(await graph.node('b'))).toBe(null);
	});

	test('a LABEL node reads the label chain in the label-fallback lang', async () => {
		const graph = makeGraph([
			{
				tipo: 'a',
				model: 'diffusion_element',
				term: { 'lg-eng': 'english', 'lg-spa': 'spanish' },
				use_machine_name: false,
			},
			{ tipo: 'b', term: { 'lg-eng': '', 'lg-fra': 'francais' }, use_machine_name: false },
		]);
		expect(nameOrLabelOf(await graph.node('a'))).toBe('spanish');
		expect(nameOrLabelOf(await graph.node('b'))).toBe('francais');
	});

	test('a row not derived yet reads as before: lg-spa, then the first NON-EMPTY value', async () => {
		const graph = makeGraph([
			{ tipo: 'a', term: { 'lg-spa': 'spanish', 'lg-eng': 'english' } },
			{ tipo: 'b', term: { 'lg-eng': '', 'lg-fra': 'francais' } },
			{ tipo: 'c', term: {} },
			{ tipo: 'd', term: null },
		]);
		expect(nameOrLabelOf(await graph.node('a'))).toBe('spanish');
		expect(nameOrLabelOf(await graph.node('b'))).toBe('francais');
		expect(nameOrLabelOf(await graph.node('c'))).toBe(null);
		expect(nameOrLabelOf(await graph.node('d'))).toBe(null);
	});
});

describe('resolveDomainTipo', () => {
	const graph = makeGraph([
		{ tipo: 'dd1190' },
		{ tipo: 'noise1', parent: 'dd1190', model: 'diffusion_element', term: t('domain_b') },
		{ tipo: 'domA', parent: 'dd1190', model: 'diffusion_domain', term: t('domain_a') },
		{ tipo: 'domB', parent: 'dd1190', model: 'diffusion_domain', term: t('domain_b') },
	]);

	test("'domain_b' resolves the SECOND domain node (term match, not first child)", async () => {
		expect(await resolveDomainTipo(graph, 'dd1190', 'domain_b')).toBe('domB');
	});

	test("'domain_a' resolves the first", async () => {
		expect(await resolveDomainTipo(graph, 'dd1190', 'domain_a')).toBe('domA');
	});

	test('an unknown domain name resolves null (PHP fresh-install early return)', async () => {
		expect(await resolveDomainTipo(graph, 'dd1190', 'no_such_domain')).toBe(null);
	});

	test('the model gate holds: a same-term non-domain child never matches', async () => {
		const onlyNoise = makeGraph([
			{ tipo: 'dd1190' },
			{ tipo: 'noise1', parent: 'dd1190', model: 'diffusion_element', term: t('domain_b') },
		]);
		expect(await resolveDomainTipo(onlyNoise, 'dd1190', 'domain_b')).toBe(null);
	});
});

// ------------------------------------------------------------ alias chains

describe('resolveAliasTarget', () => {
	test('one hop: the first RELATED node of the de-aliased model', async () => {
		const graph = makeGraph([
			{ tipo: 'EA', model: 'diffusion_element_alias', relations: ['sec1', 'E'] },
			{ tipo: 'sec1', model: 'section' },
			{ tipo: 'E', model: 'diffusion_element' },
		]);
		expect(await resolveAliasTarget(graph, 'EA')).toBe('E');
	});

	test('a NON-alias node resolves null', async () => {
		const graph = makeGraph([{ tipo: 'E', model: 'diffusion_element', relations: ['x'] }]);
		expect(await resolveAliasTarget(graph, 'E')).toBe(null);
	});

	test('an alias relating nothing of the de-aliased model resolves null', async () => {
		const graph = makeGraph([
			{ tipo: 'TA', model: 'table_alias', relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect(await resolveAliasTarget(graph, 'TA')).toBe(null);
	});

	test('a SAME-MODEL alias chain does NOT chain: the model match is EXACT, so hop 1 finds nothing', async () => {
		// FOUND, NOT FIXED: the recursion is gated on the target's model being
		// EXACTLY model.replace('_alias',''), yet it only recurses when that same
		// target model still contains '_alias'. For the real ontology models
		// ('diffusion_element_alias' → 'diffusion_element') the two conditions are
		// mutually exclusive, so a chain of same-model aliases resolves null at the
		// FIRST hop. Moved faithfully; pinned here rather than "fixed".
		const graph = makeGraph([
			{ tipo: 'a1', model: 'diffusion_element_alias', relations: ['a2'] },
			{ tipo: 'a2', model: 'diffusion_element_alias', relations: ['real'] },
			{ tipo: 'real', model: 'diffusion_element' },
		]);
		expect(await resolveAliasTarget(graph, 'a1')).toBe(null);
	});

	/**
	 * The ONLY shape that reaches the recursion: nested '_alias' suffixes, since
	 * replace() peels exactly one occurrence per hop
	 * ('table_alias_alias' → 'table_alias').
	 */
	const nestedChain = (hops: number): DiffusionGraph => {
		const specs: StubSpec[] = [{ tipo: 'real', model: 'table' }];
		for (let j = 1; j <= hops; j++) {
			specs.push({
				tipo: `m${j}`,
				model: `table${'_alias'.repeat(j)}`,
				relations: [j === 1 ? 'real' : `m${j - 1}`],
			});
		}
		return makeGraph(specs);
	};

	test('a 10-hop nested-alias chain still resolves; 12 hops exhaust the budget → null', async () => {
		expect(await resolveAliasTarget(nestedChain(10), 'm10')).toBe('real');
		expect(await resolveAliasTarget(nestedChain(12), 'm12')).toBe(null);
	});

	test('an explicit depth argument overrides the 10-hop default', async () => {
		expect(await resolveAliasTarget(nestedChain(5), 'm5', 5)).toBe('real');
		expect(await resolveAliasTarget(nestedChain(5), 'm5', 4)).toBe(null);
		expect(await resolveAliasTarget(nestedChain(1), 'm1', 0)).toBe(null);
	});

	test('a MUTUAL alias pair A↔B resolves null WITHIN the timeout (no hang)', async () => {
		const graph = makeGraph([
			{ tipo: 'A', model: 'table_alias_alias', relations: ['B'] },
			{ tipo: 'B', model: 'table_alias', relations: ['A'] },
		]);
		// A→B is a real hop (B's model matches 'table_alias'); B→A misses the exact
		// model match, so the walk stops there instead of cycling.
		expect(await resolveAliasTarget(graph, 'A')).toBe(null);
	}, 2000);
});

// ------------------------------------------------------------ consumed set

describe('collectConsumedReals', () => {
	test('every alias under the domain consumes its real node', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element' },
			{ tipo: 'EA', parent: 'D', model: 'diffusion_element_alias', relations: ['E'] },
			{ tipo: 'TB', parent: 'EA', model: 'table' },
			{ tipo: 'TA', parent: 'EA', model: 'table_alias', relations: ['TB'] },
		]);
		expect([...(await collectConsumedReals(graph, 'D'))].sort()).toEqual(['E', 'TB']);
	});

	test('the DOMAIN node itself is never in its own consumed set', async () => {
		const graph = makeGraph([{ tipo: 'D', model: 'diffusion_domain' }]);
		expect((await collectConsumedReals(graph, 'D')).size).toBe(0);
	});

	test('an alias whose target does not resolve consumes nothing', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'EA', parent: 'D', model: 'diffusion_element_alias', relations: [] },
		]);
		expect((await collectConsumedReals(graph, 'D')).size).toBe(0);
	});
});

// ------------------------------------------------------- walkDiffusionSections

describe('walkDiffusionSections', () => {
	test("only nodes UNDER an element contribute — the element's OWN relation is not emitted", async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element', relations: ['sec_own'] },
			{ tipo: 'T', parent: 'E', model: 'table', relations: ['sec_under'] },
			{ tipo: 'sec_own', model: 'section' },
			{ tipo: 'sec_under', model: 'section' },
		]);
		const sections = await walkDiffusionSections(graph, 'D');
		expect([...sections]).toEqual(['sec_under']);
		expect(sections.has('sec_own')).toBe(false);
	});

	test('only related nodes of model SECTION count', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element' },
			{ tipo: 'T', parent: 'E', model: 'table', relations: ['sec1', 'notasection'] },
			{ tipo: 'sec1', model: 'section' },
			{ tipo: 'notasection', model: 'component_input_text' },
		]);
		expect([...(await walkDiffusionSections(graph, 'D'))]).toEqual(['sec1']);
	});

	test("an alias with NO relations falls back to the real node's; its OWN relations WIN when present", async () => {
		const fallback = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element' },
			{ tipo: 'TA', parent: 'E', model: 'table_alias', relations: ['T'] },
			{ tipo: 'T', model: 'table', relations: ['sec_real'] },
			{ tipo: 'sec_real', model: 'section' },
		]);
		expect([...(await walkDiffusionSections(fallback, 'D'))]).toEqual(['sec_real']);

		const own = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element' },
			{ tipo: 'TA', parent: 'E', model: 'table_alias', relations: ['T', 'sec_alias'] },
			{ tipo: 'T', model: 'table', relations: ['sec_real'] },
			{ tipo: 'sec_real', model: 'section' },
			{ tipo: 'sec_alias', model: 'section' },
		]);
		// own relations are non-empty → NO fallback, the real's section is absent
		expect([...(await walkDiffusionSections(own, 'D'))]).toEqual(['sec_alias']);
	});

	test('a real node CONSUMED by an alias is skipped in its raw tree position', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element' },
			// T sits raw under E *and* is aliased by TA → the raw visit is skipped
			{ tipo: 'T', parent: 'E', model: 'table', relations: ['sec_real'] },
			{ tipo: 'TA', parent: 'E', model: 'table_alias', relations: ['T', 'sec_alias'] },
			{ tipo: 'sec_real', model: 'section' },
			{ tipo: 'sec_alias', model: 'section' },
		]);
		expect([...(await walkDiffusionSections(graph, 'D'))]).toEqual(['sec_alias']);
	});

	test('the consumption is ELEMENT-SCOPED: an alias in ANOTHER element does not skip the raw node', async () => {
		// The mht96 → mht72 case. T lives under element E1 and publishes sec_real
		// THERE; element E2 aliases it and relates a section of its OWN, so the
		// alias fallback cannot re-emit sec_real. Domain-wide consumption drops
		// sec_real from the map entirely — haveSectionDiffusion() then returns
		// false and the Difusión tool disappears for those records.
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E1', parent: 'D', model: 'diffusion_element' },
			{ tipo: 'T', parent: 'E1', model: 'table', relations: ['sec_real'] },
			{ tipo: 'E2', parent: 'D', model: 'diffusion_element' },
			{ tipo: 'TA', parent: 'E2', model: 'table_alias', relations: ['T', 'sec_alias'] },
			{ tipo: 'sec_real', model: 'section' },
			{ tipo: 'sec_alias', model: 'section' },
		]);
		expect([...(await walkDiffusionSections(graph, 'D'))]).toEqual(['sec_real', 'sec_alias']);
	});

	test("an alias also descends into its REAL node's children", async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'EA', parent: 'D', model: 'diffusion_element_alias', relations: ['E'] },
			{ tipo: 'E', model: 'diffusion_element' },
			{ tipo: 'T', parent: 'E', model: 'table', relations: ['sec_real'] },
			{ tipo: 'sec_real', model: 'section' },
		]);
		expect([...(await walkDiffusionSections(graph, 'D'))]).toEqual(['sec_real']);
	});

	test('depth-20 guard: a section at depth 19 is present, at depth 22 absent', async () => {
		const specs: StubSpec[] = [
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element' }, // depth 1
			{ tipo: 'sec19', model: 'section' },
			{ tipo: 'sec22', model: 'section' },
		];
		let parent = 'E';
		for (let depth = 2; depth <= 22; depth++) {
			specs.push({
				tipo: `n${depth}`,
				parent,
				model: 'table',
				relations: depth === 19 ? ['sec19'] : depth === 22 ? ['sec22'] : [],
			});
			parent = `n${depth}`;
		}
		const sections = await walkDiffusionSections(makeGraph(specs), 'D');
		expect(sections.has('sec19')).toBe(true);
		expect(sections.has('sec22')).toBe(false);
	});

	test('a domain with no element children yields an EMPTY set', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'T', parent: 'D', model: 'table', relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect((await walkDiffusionSections(graph, 'D')).size).toBe(0);
	});
});

// -------------------------------------------------------- walkDiffusionTargets

/** domain → element(sql) → database(label) → table(label, relates sec) */
function sqlDomain(databaseLabel: string, tableLabel: string | null): DiffusionGraph {
	return makeGraph([
		{ tipo: 'D', model: 'diffusion_domain' },
		{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties: SQL_ELEMENT },
		{ tipo: 'DB', parent: 'E', model: 'database', term: t(databaseLabel) },
		{
			tipo: 'T',
			parent: 'DB',
			model: 'table',
			term: tableLabel === null ? null : t(tableLabel),
			relations: ['sec1'],
		},
		{ tipo: 'sec1', model: 'section' },
	]);
}

describe('walkDiffusionTargets — address materialization', () => {
	test('the happy path: db/table labels become the published address', async () => {
		const map = await walkDiffusionTargets(sqlDomain('web_a', 'people'), 'D');
		expect(map.get('sec1')).toEqual([
			{
				element_tipo: 'E',
				type: 'sql',
				database_name: 'web_a',
				table_name: 'people',
				table_is_alias: false,
			},
		]);
	});

	test('requireSqlIdentifier is a NORMALIZER: "my table!" → "my_table", "Web X" → "web_x"', async () => {
		const map = await walkDiffusionTargets(sqlDomain('Web X', 'my table!'), 'D');
		expect(map.get('sec1')?.[0]?.database_name).toBe('web_x');
		expect(map.get('sec1')?.[0]?.table_name).toBe('my_table');
	});

	test('labels that fail AFTER sanitization drop their target (publish/delete lockstep)', async () => {
		// each rejected label is mixed with an ACCEPTED sibling in the same domain
		const cases: [string, string][] = [
			['leading digit', '2024'],
			['punctuation only', '...'],
			['bang only', '!!!'],
			['over 64 chars', 'a'.repeat(70)],
		];
		for (const [name, badLabel] of cases) {
			const graph = makeGraph([
				{ tipo: 'D', model: 'diffusion_domain' },
				{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties: SQL_ELEMENT },
				{ tipo: 'DB', parent: 'E', model: 'database', term: t('web_a') },
				{ tipo: 'Tbad', parent: 'DB', model: 'table', term: t(badLabel), relations: ['sec1'] },
				{ tipo: 'Tok', parent: 'DB', model: 'table', term: t('people'), relations: ['sec1'] },
				{ tipo: 'sec1', model: 'section' },
			]);
			const list = (await walkDiffusionTargets(graph, 'D')).get('sec1') ?? [];
			expect(`${name}: ${list.map((target) => target.table_name).join(',')}`).toBe(
				`${name}: people`,
			);
		}
	});

	test('a rejected DATABASE label drops the target too', async () => {
		const map = await walkDiffusionTargets(sqlDomain('2024', 'people'), 'D');
		expect(map.has('sec1')).toBe(false);
	});

	test('a FALSY (missing) table label short-circuits to "" with NO throw — the target survives with table_name ""', async () => {
		// The `hit.table ? requireSqlIdentifier(...) : ''` ternary never reaches the
		// chokepoint for a null/empty label. Pinning the SHAPE, not endorsing it:
		// this is how file elements (rdf/xml) legitimately carry empty addresses,
		// and a sql node with no label produces the same empty address here.
		const map = await walkDiffusionTargets(sqlDomain('web_a', null), 'D');
		expect(map.get('sec1')).toEqual([
			{
				element_tipo: 'E',
				type: 'sql',
				database_name: 'web_a',
				table_name: '',
				table_is_alias: false,
			},
		]);
	});

	test('no database node → database_name "" (file elements ledger with empty addresses)', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{
				tipo: 'E',
				parent: 'D',
				model: 'diffusion_element',
				properties: { diffusion: { type: 'rdf' } },
			},
			{ tipo: 'C', parent: 'E', model: 'owl:Class', term: t('nmo'), relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect((await walkDiffusionTargets(graph, 'D')).get('sec1')).toEqual([
			{
				element_tipo: 'E',
				type: 'rdf',
				database_name: '',
				table_name: 'nmo',
				table_is_alias: false,
			},
		]);
	});

	test('duplicate (element, db, table) hits are deduped; a different table is a second target', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties: SQL_ELEMENT },
			{ tipo: 'DB', parent: 'E', model: 'database', term: t('web_a') },
			{ tipo: 'T1', parent: 'DB', model: 'table', term: t('people'), relations: ['sec1'] },
			{ tipo: 'T2', parent: 'DB', model: 'table', term: t('people'), relations: ['sec1'] },
			{ tipo: 'T3', parent: 'DB', model: 'table', term: t('places'), relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect((await walkDiffusionTargets(graph, 'D')).get('sec1')?.map((x) => x.table_name)).toEqual([
			'people',
			'places',
		]);
	});
});

describe('walkDiffusionTargets — element type', () => {
	test('properties.diffusion.type drives the type; a missing/empty one is "unknown"', async () => {
		const build = (properties: Record<string, unknown> | null): DiffusionGraph =>
			makeGraph([
				{ tipo: 'D', model: 'diffusion_domain' },
				{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties },
				{ tipo: 'T', parent: 'E', model: 'table', term: t('people'), relations: ['sec1'] },
				{ tipo: 'sec1', model: 'section' },
			]);
		const typeOf = async (
			properties: Record<string, unknown> | null,
		): Promise<string | undefined> =>
			(await walkDiffusionTargets(build(properties), 'D')).get('sec1')?.[0]?.type;

		expect(await typeOf({ diffusion: { type: 'socrata' } })).toBe('socrata');
		expect(await typeOf(null)).toBe('unknown');
		expect(await typeOf({})).toBe('unknown');
		expect(await typeOf({ diffusion: {} })).toBe('unknown');
		// the `|| 'unknown'` half: an EMPTY string type is coerced, not kept
		expect(await typeOf({ diffusion: { type: '' } })).toBe('unknown');
	});

	test("an alias element with EMPTY properties inherits the real node's diffusion type", async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{
				tipo: 'EA',
				parent: 'D',
				model: 'diffusion_element_alias',
				relations: ['E'],
				properties: {},
			},
			{ tipo: 'E', model: 'diffusion_element', properties: SQL_ELEMENT },
			{ tipo: 'DB', parent: 'E', model: 'database', term: t('web_a') },
			{ tipo: 'T', parent: 'DB', model: 'table', term: t('people'), relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);
		const target = (await walkDiffusionTargets(graph, 'D')).get('sec1')?.[0];
		expect(target?.type).toBe('sql');
		// element_tipo is the REAL node, never the alias
		expect(target?.element_tipo).toBe('E');
	});

	test('an alias declaring its OWN properties does NOT inherit', async () => {
		const graph = makeGraph([
			{
				tipo: 'D',
				model: 'diffusion_domain',
			},
			{
				tipo: 'EA',
				parent: 'D',
				model: 'diffusion_element_alias',
				relations: ['E'],
				properties: { diffusion: { type: 'socrata' } },
			},
			{ tipo: 'E', model: 'diffusion_element', properties: SQL_ELEMENT },
			{ tipo: 'DB', parent: 'E', model: 'database', term: t('web_a') },
			{ tipo: 'T', parent: 'DB', model: 'table', term: t('people'), relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect((await walkDiffusionTargets(graph, 'D')).get('sec1')?.[0]?.type).toBe('socrata');
	});
});

describe('walkDiffusionTargets — the database is FIRST-WINS (walk order IS the contract)', () => {
	const build = (first: string, second: string): DiffusionGraph =>
		makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties: SQL_ELEMENT },
			{ tipo: 'DB1', parent: 'E', model: 'database', term: t(first) },
			{ tipo: 'DB2', parent: 'E', model: 'database', term: t(second) },
			{ tipo: 'T', parent: 'DB2', model: 'table', term: t('people'), relations: ['sec1'] },
			{ tipo: 'sec1', model: 'section' },
		]);

	test('DB1("web_a") walked before DB2("web_b") → "web_a", even though the table lives under DB2', async () => {
		expect(
			(await walkDiffusionTargets(build('web_a', 'web_b'), 'D')).get('sec1')?.[0],
		).toMatchObject({ database_name: 'web_a' });
	});

	test('reordering the siblings FLIPS the answer', async () => {
		expect(
			(await walkDiffusionTargets(build('web_b', 'web_a'), 'D')).get('sec1')?.[0],
		).toMatchObject({ database_name: 'web_b' });
	});
});

describe('walkDiffusionTargets — alias inheritance', () => {
	test('EA aliasing E emits exactly ONE target, on the ALIAS database "web_x_pre"', async () => {
		// EA declares its own database node; E's raw position is consumed the
		// moment EA aliases it, so E is never walked directly. The merged child
		// set is (EA's children ∪ E's children) in that order, and
		// ElementContext.database is first-wins → the alias database wins.
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties: SQL_ELEMENT },
			{ tipo: 'DB_E', parent: 'E', model: 'database', term: t('web_x') },
			{ tipo: 'T', parent: 'DB_E', model: 'table', term: t('people'), relations: ['sec1'] },
			{ tipo: 'EA', parent: 'D', model: 'diffusion_element_alias', relations: ['E'] },
			{ tipo: 'DB_A', parent: 'EA', model: 'database_alias', term: t('web_x_pre') },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect((await walkDiffusionTargets(graph, 'D')).get('sec1')).toEqual([
			{
				element_tipo: 'E',
				type: 'sql',
				database_name: 'web_x_pre',
				table_name: 'people',
				table_is_alias: false,
			},
		]);
	});

	test('table_is_alias marks a table_alias emitter', async () => {
		const graph = makeGraph([
			{ tipo: 'D', model: 'diffusion_domain' },
			{ tipo: 'E', parent: 'D', model: 'diffusion_element', properties: SQL_ELEMENT },
			{ tipo: 'DB', parent: 'E', model: 'database', term: t('web_a') },
			{
				tipo: 'TA',
				parent: 'DB',
				model: 'table_alias',
				term: t('other_people'),
				relations: ['T', 'sec1'],
			},
			{ tipo: 'T', model: 'table', term: t('people') },
			{ tipo: 'sec1', model: 'section' },
		]);
		expect((await walkDiffusionTargets(graph, 'D')).get('sec1')?.[0]).toMatchObject({
			table_name: 'other_people',
			table_is_alias: true,
		});
	});
});

// ---------------------------------------------------- selectMediaIndexTargets

const sqlTarget = (over: Partial<DiffusionSqlTarget>): DiffusionSqlTarget => ({
	element_tipo: 'E',
	type: 'sql',
	database_name: 'web_a',
	table_name: 'people',
	...over,
});

describe('selectMediaIndexTargets', () => {
	test('an empty map yields nothing', () => {
		expect(selectMediaIndexTargets(new Map())).toEqual([]);
	});

	test('real + alias in ONE database → the REAL table, order-independent', () => {
		const real = sqlTarget({ table_name: 'people', table_is_alias: false });
		const alias = sqlTarget({ table_name: 'other_people', table_is_alias: true });
		for (const list of [
			[real, alias],
			[alias, real],
		]) {
			expect(selectMediaIndexTargets(new Map([['test6099', list]]))).toEqual([
				{ database_name: 'web_a', table_name: 'people', section_tipo: 'test6099' },
			]);
		}
	});

	test('alias-only → the FIRST alias', () => {
		const map = new Map([
			[
				'test6099',
				[
					sqlTarget({ table_name: 'alias_one', table_is_alias: true }),
					sqlTarget({ table_name: 'alias_two', table_is_alias: true }),
				],
			],
		]);
		expect(selectMediaIndexTargets(map)).toEqual([
			{ database_name: 'web_a', table_name: 'alias_one', section_tipo: 'test6099' },
		]);
	});

	test('socrata counts as a publication target', () => {
		const map = new Map([['test6099', [sqlTarget({ type: 'socrata' })]]]);
		expect(selectMediaIndexTargets(map)).toEqual([
			{ database_name: 'web_a', table_name: 'people', section_tipo: 'test6099' },
		]);
	});

	test('NEGATIVES, each mixed with an accepted target in the SAME map', () => {
		const accepted = sqlTarget({ database_name: 'web_ok', table_name: 'ok_table' });
		const negatives: [string, DiffusionSqlTarget][] = [
			['rdf element', sqlTarget({ type: 'rdf', database_name: 'web_r', table_name: 'x' })],
			['xml element', sqlTarget({ type: 'xml', database_name: 'web_x', table_name: 'x' })],
			['unknown type', sqlTarget({ type: 'unknown', database_name: 'web_u', table_name: 'x' })],
			['empty database', sqlTarget({ database_name: '', table_name: 'x' })],
			['empty table', sqlTarget({ database_name: 'web_e', table_name: '' })],
		];
		for (const [name, negative] of negatives) {
			const out = selectMediaIndexTargets(new Map([['test6099', [negative, accepted]]]));
			expect(`${name}: ${JSON.stringify(out)}`).toBe(
				`${name}: ${JSON.stringify([
					{ database_name: 'web_ok', table_name: 'ok_table', section_tipo: 'test6099' },
				])}`,
			);
		}
	});

	test('different databases each contribute one entry; sections fold independently', () => {
		const map = new Map([
			[
				'test6099',
				[
					sqlTarget({ database_name: 'web_a', table_name: 'people' }),
					sqlTarget({ database_name: 'web_b', table_name: 'people' }),
				],
			],
			['test6100', [sqlTarget({ database_name: 'web_a', table_name: 'images' })]],
		]);
		expect(selectMediaIndexTargets(map)).toEqual([
			{ database_name: 'web_a', table_name: 'people', section_tipo: 'test6099' },
			{ database_name: 'web_b', table_name: 'people', section_tipo: 'test6099' },
			{ database_name: 'web_a', table_name: 'images', section_tipo: 'test6100' },
		]);
	});

	test('D12 (fixed 2026-08-09): TWO REAL tables in ONE database both get entries', () => {
		// The key was database_name ALONE, so the second real table never reached
		// the marker store and its published rows got NO media markers. The key is
		// now (database, table), which is also what PHP's resolve_media_index_targets
		// emits (db|table|section triples). Ledger:
		// engineering/wire_contract/WC-2026-08-09-media-index-target-selection.md.
		const map = new Map([
			[
				'test6099',
				[
					sqlTarget({ table_name: 'people', table_is_alias: false }),
					sqlTarget({ table_name: 'places', table_is_alias: false }),
				],
			],
		]);
		expect(selectMediaIndexTargets(map)).toEqual([
			{ database_name: 'web_a', table_name: 'people', section_tipo: 'test6099' },
			{ database_name: 'web_a', table_name: 'places', section_tipo: 'test6099' },
		]);
	});

	test('a real table SUPPRESSES the aliases of its database, and every real table is kept', () => {
		const map = new Map([
			[
				'test6099',
				[
					sqlTarget({ table_name: 'alias_one', table_is_alias: true }),
					sqlTarget({ table_name: 'people', table_is_alias: false }),
					sqlTarget({ table_name: 'second_real', table_is_alias: false }),
				],
			],
		]);
		// D12 (fixed 2026-08-09): the alias drops out because the database has a
		// real table; BOTH real tables are now kept (the second used to be lost).
		expect(selectMediaIndexTargets(map)).toEqual([
			{ database_name: 'web_a', table_name: 'people', section_tipo: 'test6099' },
			{ database_name: 'web_a', table_name: 'second_real', section_tipo: 'test6099' },
		]);
	});
});

// ------------------------------------------- targetKey / foldElementOutcomes

describe('targetKey', () => {
	test('sql and socrata key as `db|table`', () => {
		expect(targetKey(sqlTarget({ type: 'sql' }))).toBe('web_a|people');
		expect(targetKey(sqlTarget({ type: 'socrata' }))).toBe('web_a|people');
	});

	test('file elements key as `type:element_tipo` — rdf on E2 → "rdf:E2"', () => {
		expect(
			targetKey(sqlTarget({ type: 'rdf', element_tipo: 'E2', database_name: '', table_name: '' })),
		).toBe('rdf:E2');
		expect(targetKey(sqlTarget({ type: 'xml', element_tipo: 'E3' }))).toBe('xml:E3');
		expect(targetKey(sqlTarget({ type: 'markdown', element_tipo: 'E4' }))).toBe('markdown:E4');
		// 'unknown' is NOT sql/socrata → it takes the file grammar too
		expect(targetKey(sqlTarget({ type: 'unknown', element_tipo: 'E5' }))).toBe('unknown:E5');
	});
});

describe('foldElementOutcomes', () => {
	/** The delete-side outcome shape the fold reads (2026-09-03: + terminal). */
	const confirmed = (keys: string[], terminal: { key: string; reason: string }[] = []) => ({
		deleted: keys,
		terminal,
	});
	const UNPUBLISHED: ElementOutcome = { kind: 'unpublished' };
	const PENDING: ElementOutcome = { kind: 'pending' };

	test('empty targets → empty Map', () => {
		expect(foldElementOutcomes([], confirmed([]))).toEqual(new Map());
	});

	test('a SINGLE confirmed target makes its element successful', () => {
		const target = sqlTarget({ element_tipo: 'E1' });
		const folded = foldElementOutcomes([target], confirmed([targetKey(target)]));
		expect(folded).toEqual(new Map([['E1', UNPUBLISHED]]));
	});

	test('AND, not OR: ONE unconfirmed target poisons its whole element', () => {
		const ok = sqlTarget({ element_tipo: 'E1', table_name: 'people' });
		const bad = sqlTarget({ element_tipo: 'E1', table_name: 'places' });
		expect(foldElementOutcomes([ok, bad], confirmed([targetKey(ok)]))).toEqual(
			new Map([['E1', PENDING]]),
		);
		// order-independent — the poison survives a later confirmation
		expect(foldElementOutcomes([bad, ok], confirmed([targetKey(ok)]))).toEqual(
			new Map([['E1', PENDING]]),
		);
		// both confirmed → unpublished
		expect(foldElementOutcomes([ok, bad], confirmed([targetKey(ok), targetKey(bad)]))).toEqual(
			new Map([['E1', UNPUBLISHED]]),
		);
	});

	test('elements fold INDEPENDENTLY', () => {
		const good = sqlTarget({ element_tipo: 'E1', table_name: 'people' });
		const bad = sqlTarget({ element_tipo: 'E2', table_name: 'places' });
		expect(foldElementOutcomes([good, bad], confirmed([targetKey(good)]))).toEqual(
			new Map<string, ElementOutcome>([
				['E1', UNPUBLISHED],
				['E2', PENDING],
			]),
		);
	});

	test('TERMINAL (PUB-02): an element is terminal only when NOTHING confirmed and EVERY target is terminal', () => {
		const csv = sqlTarget({ element_tipo: 'E1', type: 'csv', database_name: '', table_name: '' });
		const noDb = sqlTarget({ element_tipo: 'E2', database_name: '', table_name: 'people' });
		const live = sqlTarget({ element_tipo: 'E2', database_name: 'web_a', table_name: 'places' });
		const reasons = [
			{ key: targetKey(csv), reason: 'full export' },
			{ key: targetKey(noDb), reason: 'no database' },
		];
		// E1: its only target is terminal → terminal, with the reason
		expect(foldElementOutcomes([csv], confirmed([], reasons))).toEqual(
			new Map([['E1', { kind: 'terminal', reason: 'full export' }]]),
		);
		// E2: one terminal + one TRANSIENT (neither confirmed nor terminal) → pending
		expect(foldElementOutcomes([noDb, live], confirmed([], reasons))).toEqual(
			new Map([['E2', PENDING]]),
		);
		// E2: the live target confirmed, the terminal one did not → pending (AND law)
		expect(foldElementOutcomes([noDb, live], confirmed([targetKey(live)], reasons))).toEqual(
			new Map([['E2', PENDING]]),
		);
	});

	test('PRODUCER↔CONSUMER: the fold reads the SAME grammar the delete path writes (DIFF-A class)', () => {
		// a mixed element: one sql target + one rdf target, both confirmed under
		// the keys targetKey() produces. If either side drifted (raw label vs
		// sanitized, or `db|table` vs `type:tipo`) this element would fold false.
		const sqlSide = sqlTarget({ element_tipo: 'E1', database_name: 'web_a', table_name: 'people' });
		const fileSide = sqlTarget({
			element_tipo: 'E1',
			type: 'rdf',
			database_name: '',
			table_name: '',
		});
		const producedKeys = [sqlSide, fileSide].map(targetKey);
		expect(producedKeys).toEqual(['web_a|people', 'rdf:E1']);
		expect(foldElementOutcomes([sqlSide, fileSide], confirmed(producedKeys))).toEqual(
			new Map([['E1', UNPUBLISHED]]),
		);
		// drop ONE produced key → the element goes pending
		expect(foldElementOutcomes([sqlSide, fileSide], confirmed(['web_a|people']))).toEqual(
			new Map([['E1', PENDING]]),
		);
	});
});

// ------------------------------------------------------- REWIRE source gates

describe('REWIRE — the inline logic is GONE from the call sites', () => {
	const ROOT = join(import.meta.dir, '..', '..');
	const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

	test('diffusion_map.ts delegates the walk instead of inlining it', () => {
		const map = read('src/core/diffusion_bridge/diffusion_map.ts');
		// the extraction is USED
		expect(map.includes("from './diffusion_graph.ts'")).toBe(true);
		expect(map.includes('walkDiffusionSections(graph, domainTipo)')).toBe(true);
		expect(map.includes('walkDiffusionTargets(graph, domainTipo)')).toBe(true);
		expect(map.includes('selectMediaIndexTargets(targetsCache)')).toBe(true);
		expect(map.includes('resolveDomainTipo(graph, DIFFUSION_ROOT, domainName)')).toBe(true);
		// the inline markers are DELETED (a revert cannot silently un-wire this)
		expect(map.includes('const resolveAlias =')).toBe(false);
		expect(map.includes('const consumed = new Set<string>()')).toBe(false);
		expect(map.includes('pending.push(')).toBe(false);
		expect(map.includes('requireSqlIdentifier')).toBe(false);
		expect(map.includes('const chosen = new Map<string, DiffusionSqlTarget>()')).toBe(false);
		expect(map.includes('ELEMENT_MODELS')).toBe(false);
		expect(map.includes('const walk = async')).toBe(false);
	});

	test('diffusion_delete.ts builds outcome keys ONLY through targetKey()', () => {
		const del = read('src/core/diffusion_bridge/diffusion_delete.ts');
		expect(del.includes('export function targetKey')).toBe(true);
		expect(del.includes('export function foldElementOutcomes')).toBe(true);
		expect(del.includes('foldElementOutcomes(targets, outcome)')).toBe(true);
		// exactly ONE producer of each key grammar in the file — the one inside
		// targetKey(); every call site now delegates
		const inlineSqlKey = /`\$\{target\.database_name\}\|\$\{target\.table_name\}`/g;
		const inlineFileKey = /`\$\{target\.type\}:\$\{target\.element_tipo\}`/g;
		expect(del.match(inlineSqlKey)?.length).toBe(1);
		expect(del.match(inlineFileKey)?.length).toBe(1);
		expect(del.includes('outcome.deleted.push(targetKey(target))')).toBe(true);
		expect(del.includes('outcome.pending.push(targetKey(target))')).toBe(true);
		expect(del.includes('const key = targetKey(target);')).toBe(true);
		// and the old inline fold in logUnpublishOutcome is gone
		expect(del.includes('const confirmedKeys = new Set(outcome.deleted)')).toBe(false);
		expect(del.includes('confirmedKeys.has(key)')).toBe(false);
	});

	test('the graph module imports NEITHER postgres.ts NOR env.ts', () => {
		const graph = read('src/core/diffusion_bridge/diffusion_graph.ts');
		expect(graph.includes('db/postgres.ts')).toBe(false);
		expect(graph.includes('config/env.ts')).toBe(false);
		expect(/\bsql\.unsafe\b/.test(graph)).toBe(false);
	});
});
