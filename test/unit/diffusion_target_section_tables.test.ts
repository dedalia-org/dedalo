/**
 * getTargetSectionTableNames — the compiled argument of the
 * `map_target_section_tipo` ddo fn (T1-5 / O09). PURE: a synthetic virtual
 * tree, no database.
 *
 * The laws (PHP diffusion_fn::map_target_section_tipo :75-150, departures in
 * WC-2026-11-12-diffusion-map-target-section-tipo):
 * - only nodes the element OWNS (nearest element in the parents path);
 * - keyed by the node's FIRST related section only;
 * - an `*_alias` model beats a non-alias whatever the order; otherwise the
 *   first in walk order wins;
 * - the name is the node LABEL; a label-less node is never named.
 */
import { describe, expect, test } from 'bun:test';
import type {
	VirtualDiffusionTree,
	VirtualPathItem,
	VirtualTreeNode,
} from '../../src/diffusion/plan/virtual_tree.ts';
import { getTargetSectionTableNames } from '../../src/diffusion/plan/virtual_tree.ts';

const element = (tipo: string): VirtualPathItem => ({
	tipo,
	model: 'diffusion_element',
	label: tipo,
	realTipo: null,
	type: 'sql',
});
const database: VirtualPathItem = { tipo: 'db', model: 'database', label: 'db', realTipo: null };

function tableNode(
	tipo: string,
	model: string,
	label: string | null,
	relatedSections: string[],
	parents: VirtualPathItem[],
): VirtualTreeNode {
	return {
		tipo,
		model,
		label,
		properties: null,
		realTipo: null,
		isAlias: model.includes('_alias'),
		parents,
		childrenTipos: [],
		directChildrenTipos: [],
		relatedSections,
	};
}

const treeOf = (nodes: VirtualTreeNode[]): VirtualDiffusionTree => ({
	domainName: 'test',
	domainTipo: 'dom',
	nodes,
	index: {
		nodeOf: async () => null,
		childTipos: async () => [],
		relatedByModel: async () => [],
		relationTipos: async () => [],
		resolveAlias: async () => null,
	},
});

const underA = [database, element('elA')];
const underB = [database, element('elB')];

describe('getTargetSectionTableNames (map_target_section_tipo map)', () => {
	test('an alias beats a real table of the same section, in either walk order', () => {
		const realFirst = treeOf([
			tableNode('t1', 'table', 'test_real', ['test3'], underA),
			tableNode('t2', 'table_alias', 'test_alias', ['test3'], underA),
		]);
		const aliasFirst = treeOf([
			tableNode('t2', 'table_alias', 'test_alias', ['test3'], underA),
			tableNode('t1', 'table', 'test_real', ['test3'], underA),
		]);
		expect(getTargetSectionTableNames(realFirst, 'elA')).toEqual({ test3: 'test_alias' });
		expect(getTargetSectionTableNames(aliasFirst, 'elA')).toEqual({ test3: 'test_alias' });
	});

	test('two non-aliases: the first in walk order wins', () => {
		const tree = treeOf([
			tableNode('t1', 'table', 'test_first', ['test3'], underA),
			tableNode('t2', 'table', 'test_second', ['test3'], underA),
		]);
		expect(getTargetSectionTableNames(tree, 'elA')).toEqual({ test3: 'test_first' });
	});

	test('nodes owned by ANOTHER element are ignored (nearest element decides)', () => {
		const tree = treeOf([
			tableNode('t1', 'table', 'test_b', ['test3'], underB),
			// nested element: elB is nearer than elA, so elA does not own it
			tableNode('t2', 'table_alias', 'test_nested', ['test5'], [element('elB'), element('elA')]),
			tableNode('t3', 'table', 'test_a', ['test5'], underA),
		]);
		expect(getTargetSectionTableNames(tree, 'elA')).toEqual({ test5: 'test_a' });
		expect(getTargetSectionTableNames(tree, 'elB')).toEqual({
			test3: 'test_b',
			test5: 'test_nested',
		});
	});

	test('a label-less node is skipped; only the FIRST related section keys', () => {
		const tree = treeOf([
			tableNode('t1', 'table_alias', null, ['test3'], underA),
			tableNode('t2', 'table', 'test_named', ['test3', 'test5'], underA),
			tableNode('t3', 'table', 'test_no_section', [], underA),
		]);
		expect(getTargetSectionTableNames(tree, 'elA')).toEqual({ test3: 'test_named' });
	});

	test('a section tipo never reaches the prototype', () => {
		const tree = treeOf([tableNode('t1', 'table', 'test_proto', ['__proto__'], underA)]);
		const names = getTargetSectionTableNames(tree, 'elA');
		expect(Object.hasOwn(names, '__proto__')).toBe(true);
		expect(Object.getPrototypeOf(names)).toBe(Object.prototype);
	});
});
