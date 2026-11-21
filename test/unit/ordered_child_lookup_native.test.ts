/**
 * ORDERED CHILD LOOKUP — "the first child of model X" is the lowest
 * `order_number` (NULL last, `tipo` breaking a tie), and "the first descendant
 * of model X" is the first in a depth-first walk in that same order (T2-SC-4a /
 * T2-SC-5a, 2026-11-21).
 *
 * WHY: a parent may hold several children of one model (two `section_map`,
 * two `section_list`). An unordered `LIMIT 1` answers whichever row the heap
 * returns first, so the section map / list columns a reader got depended on the
 * order the ontology rows were written. The gate writes the WRONG child first
 * (higher order_number, earlier insert) and asserts every reader answers the
 * other one.
 *
 * Readers under test (each asserted on its OUTCOME, not on its SQL):
 *   - findFirstChildByModel            (ontology/resolver.ts — the primitive)
 *   - getSectionMap / getSectionMapFirstTipo (ontology/section_map.ts)
 *   - resolveListCellMap               (section/list_definitions/section_list.ts)
 *   - findSectionChildByModel          (section/list_definitions/node_find.ts)
 *   - findSectionListChild             (relations/request_config/build.ts)
 *   - readDdOntologyFirstListNodeTipos (db/dd_ontology.ts — must agree with it)
 *   - findFirstDescendantTipoByModel   (ontology/resolver.ts — depth-first)
 *   - getRecursiveChildrenTipos        (ontology/resolver.ts — the same walk)
 *   - resolveVirtualEditScope          (ontology/virtual_scope.ts — tied exclude_elements)
 *
 * SITUATION (`zzoc`, scratch TLD, no records), dropped in afterAll with
 * residue asserted 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readDdOntologyFirstListNodeTipos } from '../../src/core/db/dd_ontology.ts';
import {
	findFirstChildByModel,
	findFirstDescendantTipoByModel,
	getRecursiveChildrenTipos,
} from '../../src/core/ontology/resolver.ts';
import { getSectionMap, getSectionMapFirstTipo } from '../../src/core/ontology/section_map.ts';
import { resolveVirtualEditScope } from '../../src/core/ontology/virtual_scope.ts';
import { findSectionListChild } from '../../src/core/relations/request_config/build.ts';
import { findSectionChildByModel } from '../../src/core/section/list_definitions/node_find.ts';
import { resolveListCellMap } from '../../src/core/section/list_definitions/section_list.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const SECTION = 'zzoc1';
/** section_map written FIRST with the HIGHER order_number — the wrong answer. */
const MAP_LATE = 'zzoc2';
const MAP_FIRST = 'zzoc3';
const TERM_A = 'zzoc20';
const TERM_B = 'zzoc21';
const PORTAL = 'zzoc10';
const LIST_LATE = 'zzoc11';
const LIST_FIRST = 'zzoc12';
/** A parent whose two section_list children TIE on order_number. */
const TIE_PORTAL = 'zzoc30';
const TIE_HIGH_TIPO = 'zzoc32';
const TIE_LOW_TIPO = 'zzoc31';
/** A parent whose first-written section_list has NO order_number. */
const NULL_PORTAL = 'zzoc35';
const NULL_ORDER_LIST = 'zzoc36';
const NUMBERED_LIST = 'zzoc37';
/** Depth-first: the first group (by order) holds the HIGHER tipo. */
const DEEP_SECTION = 'zzoc100';
const GROUP_FIRST = 'zzoc150';
const GROUP_SECOND = 'zzoc140';
const DATE_IN_FIRST_GROUP = 'zzoc159';
const DATE_IN_SECOND_GROUP = 'zzoc141';
const DATE_SIBLING_LATE = 'zzoc151';
/**
 * A node with NO model, holding a component: the ONE subtree walk descends
 * through it (only a nested section / area stops the walk).
 */
const MODELLESS_SECTION = 'zzoc200';
const MODELLESS_NODE = 'zzoc201';
const DATE_UNDER_MODELLESS = 'zzoc202';
/**
 * A VIRTUAL section whose two exclude_elements children TIE on order_number;
 * the higher tipo is written first (so it holds the lower row id).
 */
const REAL_SECTION = 'zzoc300';
const REAL_FIELD_A = 'zzoc301';
const REAL_FIELD_B = 'zzoc302';
const VIRTUAL_SECTION = 'zzoc310';
const EXCLUDE_HIGH_TIPO = 'zzoc312';
const EXCLUDE_LOW_TIPO = 'zzoc311';

const S = situation({
	name: 'ordered child lookup',
	tld: 'zzoc',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section' },
		{
			tipo: MAP_LATE,
			parent: SECTION,
			model: 'section_map',
			order_number: 2,
			properties: { thesaurus: { term: 'zzoc99' } },
		},
		{
			tipo: MAP_FIRST,
			parent: SECTION,
			model: 'section_map',
			order_number: 1,
			properties: { thesaurus: { term: [TERM_A, TERM_B], parent: TERM_B, model: [] } },
		},
		{ tipo: TERM_A, parent: SECTION, model: 'component_input_text', order_number: 3 },
		{ tipo: TERM_B, parent: SECTION, model: 'component_input_text', order_number: 4 },
		{ tipo: PORTAL, parent: SECTION, model: 'component_portal', order_number: 5 },
		{
			tipo: LIST_LATE,
			parent: PORTAL,
			model: 'section_list',
			order_number: 2,
			relations: [{ tipo: TERM_A }],
		},
		{
			tipo: LIST_FIRST,
			parent: PORTAL,
			model: 'section_list',
			order_number: 1,
			relations: [{ tipo: TERM_B }],
		},
		{ tipo: TIE_PORTAL, parent: SECTION, model: 'component_portal', order_number: 6 },
		{ tipo: TIE_HIGH_TIPO, parent: TIE_PORTAL, model: 'section_list', order_number: 1 },
		{ tipo: TIE_LOW_TIPO, parent: TIE_PORTAL, model: 'section_list', order_number: 1 },
		{ tipo: NULL_PORTAL, parent: SECTION, model: 'component_portal', order_number: 7 },
		{
			tipo: NULL_ORDER_LIST,
			parent: NULL_PORTAL,
			model: 'section_list',
			order_number: null as unknown as number,
			relations: [{ tipo: TERM_A }],
		},
		{
			tipo: NUMBERED_LIST,
			parent: NULL_PORTAL,
			model: 'section_list',
			order_number: 9,
			relations: [{ tipo: TERM_B }],
		},
		{ tipo: DEEP_SECTION, parent: 'test1', model: 'section' },
		{ tipo: GROUP_SECOND, parent: DEEP_SECTION, model: 'section_group', order_number: 2 },
		{ tipo: DATE_IN_SECOND_GROUP, parent: GROUP_SECOND, model: 'component_date', order_number: 1 },
		{ tipo: GROUP_FIRST, parent: DEEP_SECTION, model: 'section_group', order_number: 1 },
		{ tipo: DATE_SIBLING_LATE, parent: GROUP_FIRST, model: 'component_date', order_number: 2 },
		{ tipo: DATE_IN_FIRST_GROUP, parent: GROUP_FIRST, model: 'component_date', order_number: 1 },
		{ tipo: MODELLESS_SECTION, parent: 'test1', model: 'section' },
		{
			tipo: MODELLESS_NODE,
			parent: MODELLESS_SECTION,
			// a model-less row: `model` NULL; model_tipo names a tipo that is no
			// model node (ensureSituation resolves only an absent model_tipo)
			model: null as unknown as string,
			model_tipo: 'zzoc999',
		},
		{ tipo: DATE_UNDER_MODELLESS, parent: MODELLESS_NODE, model: 'component_date' },
		{ tipo: REAL_SECTION, parent: 'test1', model: 'section' },
		{ tipo: REAL_FIELD_A, parent: REAL_SECTION, model: 'component_input_text', order_number: 1 },
		{ tipo: REAL_FIELD_B, parent: REAL_SECTION, model: 'component_input_text', order_number: 2 },
		{
			tipo: VIRTUAL_SECTION,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: REAL_SECTION }],
		},
		{
			tipo: EXCLUDE_HIGH_TIPO,
			parent: VIRTUAL_SECTION,
			model: 'exclude_elements',
			order_number: 1,
			relations: [{ tipo: REAL_FIELD_A }],
		},
		{
			tipo: EXCLUDE_LOW_TIPO,
			parent: VIRTUAL_SECTION,
			model: 'exclude_elements',
			order_number: 1,
			relations: [{ tipo: REAL_FIELD_B }],
		},
	],
});

beforeAll(async () => {
	await dropSituation(S);
	await ensureSituation(S);
});

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

describe('first child of a model = lowest order_number (T2-SC-4a)', () => {
	test('the primitive answers the lower order_number, whatever was written first', async () => {
		expect((await findFirstChildByModel(SECTION, 'section_map'))?.tipo).toBe(MAP_FIRST);
		expect((await findFirstChildByModel(PORTAL, 'section_list'))?.tipo).toBe(LIST_FIRST);
		expect(await findFirstChildByModel(SECTION, 'section_list')).toBeNull();
	});

	test('a NULL order_number sorts last; a tie is broken by tipo', async () => {
		expect((await findFirstChildByModel(NULL_PORTAL, 'section_list'))?.tipo).toBe(NUMBERED_LIST);
		expect((await findFirstChildByModel(TIE_PORTAL, 'section_list'))?.tipo).toBe(TIE_LOW_TIPO);
	});

	test('the section map is the first section_map child', async () => {
		const map = (await getSectionMap(SECTION)) as { thesaurus?: { term?: unknown } } | null;
		expect(map?.thesaurus?.term).toEqual([TERM_A, TERM_B]);
	});

	test('the list cell map is the first section_list child', async () => {
		expect((await resolveListCellMap(PORTAL)).implicitRelations).toEqual([TERM_B]);
		expect((await resolveListCellMap(NULL_PORTAL)).implicitRelations).toEqual([TERM_B]);
	});

	test('the virtual-aware definition lookup and the request_config hop agree with it', async () => {
		expect((await findSectionChildByModel(SECTION, 'section_map'))?.tipo).toBe(MAP_FIRST);
		expect(await findSectionListChild(PORTAL)).toBe(LIST_FIRST);
		expect(await findSectionListChild(NULL_PORTAL)).toBe(NUMBERED_LIST);
	});
});

describe('section_map first-tipo accessor is array-aware', () => {
	test('an array role answers its first tipo, a string role itself, nothing else', async () => {
		expect(await getSectionMapFirstTipo(SECTION, 'thesaurus', 'term')).toBe(TERM_A);
		expect(await getSectionMapFirstTipo(SECTION, 'thesaurus', 'parent')).toBe(TERM_B);
		// an empty array, an absent key and an absent section_map name no tipo
		expect(await getSectionMapFirstTipo(SECTION, 'thesaurus', 'model')).toBeNull();
		expect(await getSectionMapFirstTipo(SECTION, 'thesaurus', 'is_indexable')).toBeNull();
		expect(await getSectionMapFirstTipo(DEEP_SECTION, 'thesaurus', 'term')).toBeNull();
	});
});

describe('same tie-break everywhere (T2-SC-5a)', () => {
	test('the request_config hop and the first-list-node census pick the same tied child', async () => {
		const picked = await findSectionListChild(TIE_PORTAL);
		expect(picked).toBe(TIE_LOW_TIPO);
		const census = await readDdOntologyFirstListNodeTipos();
		expect(census.has(TIE_LOW_TIPO)).toBe(true);
		expect(census.has(TIE_HIGH_TIPO)).toBe(false);
		// and the untied parents, for the census floor
		expect(census.has(LIST_FIRST)).toBe(true);
		expect(census.has(LIST_LATE)).toBe(false);
		expect(census.has(NUMBERED_LIST)).toBe(true);
	});

	test('first descendant by model is depth-first in sibling order, not by tipo', async () => {
		// by tipo the answer would be zzoc141 (second group); by depth-first
		// order it is the first component of the first group
		expect(await findFirstDescendantTipoByModel(DEEP_SECTION, 'component_date')).toBe(
			DATE_IN_FIRST_GROUP,
		);
	});

	test('the virtual edit scope reads the same tied exclude_elements child', async () => {
		const scope = await resolveVirtualEditScope(VIRTUAL_SECTION);
		expect(scope.realTipo).toBe(REAL_SECTION);
		// the lower tipo wins the tie, not the row written first
		expect((await findFirstChildByModel(VIRTUAL_SECTION, 'exclude_elements'))?.tipo).toBe(
			EXCLUDE_LOW_TIPO,
		);
		expect([...scope.excludeSet]).toEqual([REAL_FIELD_B]);
	});

	test('the subtree walk descends through a node with no model', async () => {
		expect(await getRecursiveChildrenTipos(MODELLESS_SECTION)).toEqual([
			MODELLESS_NODE,
			DATE_UNDER_MODELLESS,
		]);
		expect(await findFirstDescendantTipoByModel(MODELLESS_SECTION, 'component_date')).toBe(
			DATE_UNDER_MODELLESS,
		);
	});
});
