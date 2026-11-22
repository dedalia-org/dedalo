/**
 * THE PERMISSIONS TREE WALKS A SECTION UNDER THE SECTION CONTAINMENT LAW
 * (T2-SL-3b, owner ruling SL-3a (b): the law EVERYWHERE, as v6).
 *
 * The security-access datalist (what a profile can grant, rendered by the
 * permissions widget) and the grant expansion (what a section grant writes)
 * had their own walks with their own exclude lists: `'box_elements'` (the
 * runtime model is `box elements` — a box under a grouper was walked and its
 * components offered), `'area'` exact (an `area_*` child kept), and a nested
 * section ENTERED. Both now apply the law's one predicate
 * (ontology/resolver.ts isOutsideSectionContainment) and its rule 2 (a nested
 * section is listed, never entered) — the grant expansion's set is pinned
 * EQUAL to the resolver's own section walk, so the two can never drift.
 *
 * Asserted on OUTCOMES (the tipos each door lists), with a kept component on
 * every side so an empty walk cannot pass.
 *
 * SITUATION `zzsacl` (scratch TLD, no records) under the database's own
 * area_root, so the area walk reaches the section; dropped with residue 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getModelByTipo, getRecursiveChildrenTipos } from '../../src/core/ontology/resolver.ts';
import {
	getGrantChildrenTipos,
	getSecurityAccessDatalist,
} from '../../src/core/resolve/security_access_datalist.ts';
import {
	dropSituation,
	ensureSituation,
	type Situation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const AREA = 'zzsacl1';
const SECTION = 'zzsacl2';
const GROUP = 'zzsacl3';
const KEPT_TEXT = 'zzsacl4';
/** A box under a GROUPER (the old `box_elements` misspelling let it through). */
const BOX = 'zzsacl5';
const BOX_TEXT = 'zzsacl6';
/** The stored legacy model that READS as `box elements`. */
const LEGACY_DATAFRAME = 'zzsacl7';
const LEGACY_DATAFRAME_TEXT = 'zzsacl8';
const SEMANTIC = 'zzsacl9';
const SEMANTIC_TEXT = 'zzsacl10';
/** An `area_*` model (the old exact `'area'` exclude missed it). */
const AREA_MODEL_CHILD = 'zzsacl11';
const AREA_MODEL_TEXT = 'zzsacl12';
/** A nested section: listed, never entered. */
const NESTED = 'zzsacl13';
const NESTED_TEXT = 'zzsacl14';

/** Outside the section, whichever door walks it. */
const OUTSIDE = [
	BOX,
	BOX_TEXT,
	LEGACY_DATAFRAME,
	LEGACY_DATAFRAME_TEXT,
	SEMANTIC,
	SEMANTIC_TEXT,
	AREA_MODEL_CHILD,
	AREA_MODEL_TEXT,
	NESTED_TEXT,
];

let S: Situation | null = null;

function build(root: string): Situation {
	return situation({
		name: 'security access containment',
		tld: 'zzsacl',
		nodes: [
			{ tipo: AREA, parent: root, model: 'area', order_number: 9100 },
			{ tipo: SECTION, parent: AREA, model: 'section', order_number: 1 },
			{ tipo: GROUP, parent: SECTION, model: 'section_group', order_number: 1 },
			{ tipo: KEPT_TEXT, parent: GROUP, model: 'component_input_text', order_number: 1 },
			{ tipo: BOX, parent: GROUP, model: 'box elements', order_number: 2 },
			{ tipo: BOX_TEXT, parent: BOX, model: 'component_input_text', order_number: 1 },
			{ tipo: LEGACY_DATAFRAME, parent: GROUP, model: 'dataframe', order_number: 3 },
			{
				tipo: LEGACY_DATAFRAME_TEXT,
				parent: LEGACY_DATAFRAME,
				model: 'component_input_text',
				order_number: 1,
			},
			{ tipo: SEMANTIC, parent: GROUP, model: 'component_semantic_node', order_number: 4 },
			{ tipo: SEMANTIC_TEXT, parent: SEMANTIC, model: 'component_input_text', order_number: 1 },
			// order_number 9999: never the first `area_tool` in sibling order (the
			// area_tool ROOT pick stays the seed's)
			{ tipo: AREA_MODEL_CHILD, parent: GROUP, model: 'area_tool', order_number: 9999 },
			{
				tipo: AREA_MODEL_TEXT,
				parent: AREA_MODEL_CHILD,
				model: 'component_input_text',
				order_number: 1,
			},
			{ tipo: NESTED, parent: GROUP, model: 'section', order_number: 6 },
			{ tipo: NESTED_TEXT, parent: NESTED, model: 'component_input_text', order_number: 1 },
		],
	});
}

const SUPERUSER = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

beforeAll(async () => {
	const rows = (await sql`
		SELECT tipo FROM dd_ontology WHERE model = 'area_root'
		ORDER BY order_number ASC NULLS LAST, tipo COLLATE "C" ASC LIMIT 1
	`) as { tipo: string }[];
	const root = rows[0]?.tipo ?? '';
	expect(root, 'this ontology declares no area_root').not.toBe('');
	S = build(root);
	await dropSituation(S);
	await ensureSituation(S);
	await clearOntologyDerivedCaches();
});

afterAll(async () => {
	if (S !== null) expect(await dropSituation(S)).toBe(0);
	await clearOntologyDerivedCaches();
});

describe('the permissions tree under the section containment law (T2-SL-3b)', () => {
	test('the situation reads as built (runtime models)', async () => {
		expect(await getModelByTipo(LEGACY_DATAFRAME)).toBe('box elements');
		expect(await getModelByTipo(AREA_MODEL_CHILD)).toBe('area_tool');
	});

	test('DATALIST: the section is listed with its kept element; nothing outside the section is', async () => {
		const items = await getSecurityAccessDatalist(SUPERUSER);
		const ofSection = items.filter((item) => item.section_tipo === SECTION).map((i) => i.tipo);
		// non-vacuity: the area walk reached the section and the element walk ran
		expect(items.some((item) => item.tipo === SECTION)).toBe(true);
		expect(ofSection).toContain(GROUP);
		expect(ofSection).toContain(KEPT_TEXT);
		expect(ofSection.filter((tipo) => OUTSIDE.includes(tipo))).toEqual([]);
		// rule 2: the nested section is listed, its own element is not
		expect(ofSection).toContain(NESTED);
		expect(items.some((item) => item.tipo === NESTED_TEXT)).toBe(false);
	});

	test('GRANT EXPANSION: no element outside the section is granted', async () => {
		const granted = await getGrantChildrenTipos(SECTION);
		expect(granted).toContain(GROUP);
		expect(granted).toContain(KEPT_TEXT);
		expect(granted.filter((tipo) => OUTSIDE.includes(tipo))).toEqual([]);
	});

	test('GRANT EXPANSION = the resolver section walk (one law), model-filtered', async () => {
		const law = await getRecursiveChildrenTipos(SECTION);
		const granted = await getGrantChildrenTipos(SECTION);
		// every granted tipo is IN the law's walk, and every law tipo the grant's
		// model filter keeps is granted — no second walk can drift from the first
		expect(granted.filter((tipo) => !law.includes(tipo))).toEqual([]);
		const grantModels = [
			'component',
			'button',
			'section_group',
			'relation_list',
			'time_machine_list',
		];
		const expected: string[] = [];
		for (const tipo of law) {
			const model = (await getModelByTipo(tipo)) ?? '';
			if (grantModels.some((part) => model.includes(part))) expected.push(tipo);
		}
		expect(granted).toEqual(expected);
		expect(expected.length).toBeGreaterThanOrEqual(2);
	});
});
