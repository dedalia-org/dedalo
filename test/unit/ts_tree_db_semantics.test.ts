/**
 * Tree subsystem — DB-backed subtle-semantics tests.
 *
 * These assertions pin the semantics a differential would otherwise be the only
 * guard for: string section_id wire keys, homogeneous-children ordering,
 * count null≠0, first-locator conventions, root button perms, and the
 * diamond/cycle-safe ancestor walk.
 *
 * FIXTURE REBUILT 2026-08-10. This file used to read the `tchi1` thesaurus —
 * "a real installed tree", node 602 ("Tarragona"), parent 620, grandparent 1001
 * — from the APPLICATION database. Two things were wrong with that, and they
 * are the same thing: `tchi1` has no rows in ANY table of the suite database
 * (`dedalo_mib_v7_test`), so the six tree-shaped tests could never pass there
 * (they were 6 of the suite's ~84 standing failures, and the largest single red
 * file in it); and asserting against installed records breaks the project law
 * that no test may assert against a mutable production record. A tree gate
 * whose fixture only exists on one machine gates nothing anywhere else.
 *
 * The tree cases now build their OWN three-level test3 hierarchy on the scratch
 * surface below and assert against that. The remaining cases are unchanged:
 * they read dd0/dd64/hierarchy1/hierarchy20/ontology35, which are install
 * ontology present in every database.
 *
 * FIXTURE MAP (test3 section_map `thesaurus`, read from the live ontology —
 * term test52, parent test71, order test22, is_descriptor test88, children
 * component test201):
 *
 *   928000  ROOT      no parent
 *   928001  MID       parent ROOT, descriptor, carries a term string
 *   928002  LEAF_A    parent MID, descriptor
 *   928003  LEAF_B    parent MID, descriptor
 *   928004  LEAF_C    parent MID, NON-descriptor (so the descriptor filter has
 *                     something to exclude — a filter that returns everything
 *                     is indistinguishable from no filter at all)
 *
 * FIXTURE TRAP (copied from children_of_type_order_native, where it cost an
 * hour): a child's parent link MUST carry `type: 'dd47'` and
 * `from_component_tipo: 'test71'`. The canonical test3 playground rows use
 * dd151 links; copy-pasting those makes the inverse probe return zero and every
 * assertion degenerates into comparing two empty arrays.
 *
 * SCRATCH SURFACE (this file's namespace ONLY — other suites write the same
 * database concurrently, so no table-global count is taken anywhere here):
 *   matrix_test          section_tipo 'test3', section_id 928000-928999
 *   matrix_time_machine  same tipo, same id range
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import {
	countChildren,
	countChildrenOrNull,
	getChildren,
	getChildrenTipo,
} from '../../src/core/relations/children.ts';
import { getChildrenOfType, getParentsRecursive } from '../../src/core/relations/parent.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getNodeData } from '../../src/core/ts_object/ts_api.ts';
import {
	buildNodeData,
	getPermissionsElement,
	isIndexable,
	replaceTranslatableTermTipos,
} from '../../src/core/ts_object/ts_object.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

// --- scratch tree fixture ---------------------------------------------------

const TREE_TIPO = 'test3';
const PARENT_TIPO = 'test71';
const TERM_TIPO = 'test52';
const DESCRIPTOR_TIPO = 'test88';
const CHILDREN_TIPO = 'test201';

const ID_MIN = 928000;
const ID_MAX = 928999;

const ROOT = 928000;
const MID = 928001;
const LEAF_A = 928002;
const LEAF_B = 928003;
const LEAF_C = 928004; // non-descriptor

/** A parent link in the exact stored shape the inverse probe matches on. */
function parentLink(parentId: number): Record<string, unknown> {
	return {
		id: 1,
		type: 'dd47',
		section_id: String(parentId),
		section_tipo: TREE_TIPO,
		from_component_tipo: PARENT_TIPO,
	};
}

/** The dd64 is_descriptor locator (1 = descriptor / yes, 2 = non-descriptor / no). */
function descriptorLink(sectionId: 1 | 2): Record<string, unknown> {
	return {
		id: 1,
		type: 'dd151',
		section_id: String(sectionId),
		section_tipo: 'dd64',
		from_component_tipo: DESCRIPTOR_TIPO,
	};
}

async function seedNode(input: {
	section_id: number;
	parent_id?: number;
	descriptor?: 1 | 2;
	term?: string;
}): Promise<void> {
	const relation: Record<string, unknown[]> = {};
	if (input.parent_id !== undefined) relation[PARENT_TIPO] = [parentLink(input.parent_id)];
	if (input.descriptor !== undefined)
		relation[DESCRIPTOR_TIPO] = [descriptorLink(input.descriptor)];
	const string =
		input.term === undefined
			? null
			: JSON.stringify({ [TERM_TIPO]: [{ id: 1, lang: 'lg-eng', value: input.term }] });
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, relation, "string")
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[input.section_id, TREE_TIPO, JSON.stringify(relation), string] as (string | number | null)[],
	);
}

async function sweepScratch(): Promise<void> {
	for (const table of ['matrix_test', 'matrix_time_machine']) {
		await sql.unsafe(
			`DELETE FROM ${table} WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3`,
			[TREE_TIPO, ID_MIN, ID_MAX] as (string | number)[],
		);
	}
}

beforeAll(async () => {
	await sweepScratch(); // a previous crashed run must not change what these read
	await seedNode({ section_id: ROOT, term: 'zz scratch root' });
	await seedNode({ section_id: MID, parent_id: ROOT, descriptor: 1, term: 'zz scratch mid' });
	await seedNode({ section_id: LEAF_A, parent_id: MID, descriptor: 1, term: 'zz leaf a' });
	await seedNode({ section_id: LEAF_B, parent_id: MID, descriptor: 1, term: 'zz leaf b' });
	await seedNode({ section_id: LEAF_C, parent_id: MID, descriptor: 2, term: 'zz leaf c' });
});

afterAll(sweepScratch);

describe('getChildren — int section_id wire keys + homogeneous children', () => {
	it('returns child locators with INT section_id and the dd48 children shape', async () => {
		const children = await getChildren(MID, TREE_TIPO);
		expect(children.length).toBe(3); // LEAF_A, LEAF_B, LEAF_C
		const first = children[0];
		// int-canonical wire shape (WC-2026-08-10-section-id-int-canonical;
		// the PHP-era locator::set_section_id string cast is repealed).
		expect(typeof first?.section_id).toBe('number');
		expect(first?.type).toBe('dd48');
		// The CHILDREN component tipo, never the dd47 parent tipo stored on the link.
		expect(first?.from_component_tipo).toBe(CHILDREN_TIPO);
		expect(first?.section_tipo).toBe(TREE_TIPO);
	});
});

describe('count null≠0 (PHP count_children null contract)', () => {
	it('countChildrenOrNull → null when the section has no children component; countChildren → 0', async () => {
		// dd64 (si/no) is a plain list section with no component_relation_children.
		expect(await getChildrenTipo('dd64')).toBeNull();
		expect(await countChildrenOrNull(1, 'dd64')).toBeNull();
		expect(await countChildren(1, 'dd64')).toBe(0);
	});
	it('a real hierarchy node returns an authoritative integer count', async () => {
		// EXACT, not >0: an authoritative count that silently drifted to "some
		// positive number" would still pass a >0 assertion.
		expect(await countChildrenOrNull(MID, TREE_TIPO)).toBe(3);
		expect(await countChildren(MID, TREE_TIPO)).toBe(3);
		// A leaf is the other half of the null≠0 contract: it HAS a children
		// component, so the answer is an authoritative 0, never null.
		expect(await countChildrenOrNull(LEAF_A, TREE_TIPO)).toBe(0);
	});
});

describe('diamond/cycle-safe ancestor walk (getParentsRecursive)', () => {
	it('walks the full parent chain top-down without looping', async () => {
		const { ancestors, errors } = await getParentsRecursive(LEAF_A, TREE_TIPO);
		const keys = ancestors.map((a) => `${a.section_tipo}_${a.section_id}`);
		// ORDER IS NEAREST-FIRST, measured 2026-08-10 — the walk emits the direct
		// parent before its own parent. The describe name says "top-down"; that
		// describes the WALK, not the returned array, and the old assertion was a
		// bare toContain that pinned no order at all. Pinned exactly here so a
		// reversal (which would flip every breadcrumb the client renders) is a
		// visible failure rather than a silent change.
		expect(keys).toEqual([`${TREE_TIPO}_${MID}`, `${TREE_TIPO}_${ROOT}`]);
		expect(errors).toHaveLength(0);
	});
});

describe('is_indexable — roots always false', () => {
	it('hierarchy/ontology root sections are never indexable', async () => {
		expect(await isIndexable('hierarchy1', 1)).toBe(false);
		expect(await isIndexable('ontology35', 1)).toBe(false);
	});
});

describe('root button perms (PHP get_permissions_element)', () => {
	it('hierarchy1 delete is hardcoded 0; hierarchy1/hierarchy20 new resolve via their fixed tipos', async () => {
		// button_delete on the hierarchy root is ALWAYS 0.
		expect(await getPermissionsElement('hierarchy1', 'button_delete', SUPERUSER)).toBe(0);
		// button_new on hierarchy1 → hierarchy11; superuser resolves to level 3.
		expect(await getPermissionsElement('hierarchy1', 'button_new', SUPERUSER)).toBe(3);
		// thesaurus template section uses hierarchy38/hierarchy39 → superuser level 3.
		expect(await getPermissionsElement('hierarchy20', 'button_new', SUPERUSER)).toBe(3);
		expect(await getPermissionsElement('hierarchy20', 'button_delete', SUPERUSER)).toBe(3);
	});
});

describe('buildNodeData — descriptor node with term + link_children', () => {
	it('produces the term string, is_descriptor, children_tipo and a link_children element', async () => {
		// FIXTURE: dd0/1, the Dédalo ontology root — NOT the scratch test3 tree.
		// `children_tipo` / `link_children` come from the section's ts_object
		// ddo_map, and test3 has none: its section_map carries only `thesaurus`
		// (term/parent/order/is_descriptor), which is enough to BE a tree for
		// getChildren/getParentsRecursive but not to be RENDERED as one. dd0 is
		// install ontology, present in every database, and is already this file's
		// fixture for the term-grammar, icon and model_value cases below.
		const node = await buildNodeData('dd0', 1, {}, 'root', SUPERUSER);
		expect(node.ts_id).toBe('dd0_1');
		expect(node.ts_parent).toBe('root');
		expect(node.is_descriptor).toBe(true);
		expect(node.children_tipo).toBe('ontology14');
		const term = node.ar_elements.find((element) => element.type === 'term');
		expect(typeof term?.value).toBe('string');
		expect((term?.value as string).length).toBeGreaterThan(0);
		const link = node.ar_elements.find((element) => element.type === 'link_children');
		expect(link).toBeDefined();
		expect(node.has_descriptor_children).toBe(true);
	});
});

describe('buildNodeData — the ontology term is the client-parsable "label tld id"', () => {
	// The ontology ddo_map term is a 3-tipo array [term, tld, section_id] whose
	// concatenated value the CLIENT parses back with this exact regex
	// (client/dedalo/core/ts_object/js/render_ts_line.js render_ontology_term):
	// group 1 = the label it renders, groups 2+3 = the [dd242] badge. A missing
	// trailing id (component_section_id is virtual — it owns no jsonb column, so
	// it can only come from the record's own id) fails the match and the client
	// silently falls back to rendering the RAW value, i.e. "Catalogue dd".
	const ONTOLOGY_TERM_GRAMMAR = /^(.*) ([a-z]{2,}) ([0-9]+)$/;

	it('ends the term value with the tld and the section_id', async () => {
		const node = await buildNodeData('dd0', 242, {}, 'root', SUPERUSER);
		const term = node.ar_elements.find((element) => element.type === 'term');
		const parts = ONTOLOGY_TERM_GRAMMAR.exec(term?.value as string);
		expect(parts).not.toBeNull();
		expect(parts?.[1]).not.toBe('');
		expect(parts?.[2]).toBe('dd'); // tld
		expect(parts?.[3]).toBe('242'); // section_id
	});
});

describe('buildNodeData — an icon whose component is empty is not rendered', () => {
	// dd0_1772 has a CLEARED properties component (misc.ontology18 = [{id:4, value:null}]:
	// the wrapper item survives a clear), dd0_1 (the Dédalo root) has real properties.
	// PHP is_empty calls any object with any property non-empty, so PHP renders the 'P'
	// for both and the empty one opens an empty JSON editor — WC-029 diverges.
	const iconTipos = (node: Awaited<ReturnType<typeof buildNodeData>>) =>
		node.ar_elements.filter((element) => element.type === 'icon').map((element) => element.tipo);

	it('suppresses the P icon of a cleared properties component', async () => {
		expect(iconTipos(await buildNodeData('dd0', 1772, {}, 'root', SUPERUSER))).not.toContain(
			'ontology18',
		);
	});

	it('still renders the P icon when the properties component has content', async () => {
		expect(iconTipos(await buildNodeData('dd0', 1, {}, 'root', SUPERUSER))).toContain('ontology18');
	});
});

describe("buildNodeData — the 'M' icon carries the model name (model_value)", () => {
	// PHP class.ts_object.php:518 sets model_value = $component->get_value() on the
	// element whose resolved value is 'M'; area_ontology renders it as the orange
	// badge toggled with Ctrl+M (render_ts_line.js). Fixture: install ontology
	// records — dd35 IS the area_tool section, dd5 the area_ontology one.
	const modelValueOf = async (sectionId: number, lang: string): Promise<string | undefined> =>
		runWithRequestLangs({ applicationLang: lang, dataLang: lang }, async () => {
			const node = await buildNodeData('dd0', sectionId, {}, 'root', SUPERUSER);
			return node.ar_elements.find((element) => element.value === 'M')?.model_value;
		});

	it('resolves the model name of an ontology node', async () => {
		expect(await modelValueOf(35, 'lg-eng')).toBe('area_tool');
		expect(await modelValueOf(5, 'lg-eng')).toBe('area_ontology');
		expect(await modelValueOf(100, 'lg-eng')).toBe('area_thesaurus');
	});

	it('resolves the SAME name in any data lang (grid fallback_value)', async () => {
		// Load-bearing: the dd0 model-name records store their term in ONE lang
		// (lg-spa on a standard install). Without PHP's translatable fallback chain
		// the badge renders empty in every other UI language.
		expect(await modelValueOf(35, 'lg-spa')).toBe('area_tool');
		expect(await modelValueOf(35, 'lg-fra')).toBe('area_tool');
	});

	it('never stamps model_value on a non-M element', async () => {
		const node = await runWithRequestLangs(
			{ applicationLang: 'lg-eng', dataLang: 'lg-eng' },
			async () => buildNodeData('dd0', 35, {}, 'root', SUPERUSER),
		);
		const stamped = node.ar_elements.filter((element) => element.model_value !== undefined);
		expect(stamped).toHaveLength(1);
		expect(stamped[0]?.value).toBe('M');
	});

	it('a map that already declares the machine name only drops the label (no doubled name)', async () => {
		// ontology6 shows [ontology43, ontology5, ontology9]: on a dd0 record flagged
		// use_machine_name, swapping ontology5 for ontology43 rendered "area_root, area_root".
		const term = new Set(['ontology5']);
		expect(
			await replaceTranslatableTermTipos(
				['ontology43', 'ontology5', 'ontology9'],
				term,
				'ontology43',
			),
		).toEqual(['ontology43', 'ontology9']);
		expect(
			await replaceTranslatableTermTipos(['ontology5', 'ontology9'], term, 'ontology43'),
		).toEqual(['ontology43', 'ontology9']);
	});
});

describe('getChildrenOfType — descriptor filter', () => {
	it('returns the descriptor children of a parent, and EXCLUDES the non-descriptor', async () => {
		// The exclusion is the assertion. LEAF_C is seeded non-descriptor precisely
		// so a filter that silently stopped filtering (the is_descriptor locator
		// dropped) would return 3 here and fail, instead of passing a bare >0.
		// Branch-by-branch coverage of this function lives in
		// children_of_type_order_native.test.ts; this is the tree-shaped case.
		const descriptors = await getChildrenOfType(MID, TREE_TIPO, 'descriptor');
		const ids = descriptors.map((locator) => String(locator.section_id)).sort();
		expect(ids).toEqual([String(LEAF_A), String(LEAF_B)]);

		const nonDescriptors = await getChildrenOfType(MID, TREE_TIPO, 'non_descriptor');
		expect(nonDescriptors.map((locator) => String(locator.section_id))).toEqual([String(LEAF_C)]);
	});
});

describe('dd_ts_api.get_node_data envelope', () => {
	it('returns the single node as result with the VERBATIM success msg', async () => {
		const response = await getNodeData(
			{
				dd_api: 'dd_ts_api',
				action: 'get_node_data',
				source: { section_tipo: TREE_TIPO, section_id: MID },
			},
			SUPERUSER,
		);
		expect(response.warnings).toBeUndefined();
		expect((response.data as { ts_id?: string } | null)?.ts_id).toBe(`${TREE_TIPO}_${MID}`);
	});
});
