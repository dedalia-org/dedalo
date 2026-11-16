/**
 * A tree node's component_relation_related ICON shows on BOTH ends of a
 * non-unidirectional link (src/core/ts_object/ts_object.ts
 * relatedInverseReferences; T1-31 / U03 / O10).
 *
 * WHY IT EXISTS. The thesaurus tree marks an equivalence with an `EQ` icon
 * (hierarchy44's section_list_thesaurus maps it over hierarchy94, dd621). The
 * link is STORED only on the term where it was entered; the term it points at
 * has an empty bag. PHP format_component_data (:1451) appends the component's
 * one-hop same-section inverse references unless the relation is
 * UNIDIRECTIONAL (dd620), so the target term shows the icon too. Without that
 * merge the icon's empty-data suppression hides it on the target.
 *
 * WHAT IS PINNED (outcomes):
 *   1. target of a dd621 / dd467 link shows EQ / BI;
 *   2. its element value is the inverse references, ordered by section_id;
 *   3. dd620 and an unset type_rel (→ dd620) stay stored-only (no over-merge);
 *   4. the source shows every icon from its stored bag; a node with BOTH
 *      stored links and inverse referrers emits exactly [...stored, ...inverse]
 *      (PHP :1451 order — no sort, no dedupe, never itself);
 *   5. an isolated node shows none;
 *   6. a referrer in ANOTHER section never counts (same-section scope).
 *
 * SITUATION. `zztri*` scratch TLD, built and dropped by this file.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { buildNodeData } from '../../src/core/ts_object/ts_object.ts';

const SECTION = 'zztri1';
const LIST = 'zztri2';
const TERM = 'zztri3';
const EQ = 'zztri4'; // dd621 multidirectional
const BI = 'zztri5'; // dd467 bidirectional
const TR = 'zztri6'; // dd620 unidirectional
const NC = 'zztri7'; // no config_relation → dd620
const FOREIGN = 'zztri9';

const ADMIN = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as const;

const related = (tipo: string, typeRel: string | null) => ({
	tipo,
	parent: SECTION,
	model: 'component_relation_related',
	...(typeRel === null
		? {}
		: { properties: { config_relation: { relation_type: 'dd47', relation_type_rel: typeRel } } }),
});

const link = (tipo: string, sectionTipo: string, sectionId: number) => ({
	type: 'dd47',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: tipo,
});

const term = (value: string) =>
	['lg-nolan', 'lg-spa', 'lg-eng'].map((lang, index) => ({ id: index + 1, lang, value }));

const S = situation({
	name: 'ts_object related inverse icon',
	tld: 'zztri',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: FOREIGN, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: LIST,
			parent: SECTION,
			model: 'section_list_thesaurus',
			properties: {
				show: {
					ddo_map: [
						{ tipo: TERM, type: 'term' },
						{ icon: 'EQ', tipo: EQ, type: 'icon' },
						{ icon: 'BI', tipo: BI, type: 'icon' },
						{ icon: 'TR', tipo: TR, type: 'icon' },
						{ icon: 'NC', tipo: NC, type: 'icon' },
						{ tipo: EQ, type: 'related_value' },
					],
				},
			},
		},
		{ tipo: TERM, parent: SECTION, model: 'component_input_text' },
		related(EQ, 'dd621'),
		related(BI, 'dd467'),
		related(TR, 'dd620'),
		related(NC, null),
	],
	records: [
		{
			// A: the source of every link, all pointing at B
			section_tipo: SECTION,
			section_id: 1,
			columns: {
				string: { [TERM]: term('A') },
				relation: {
					[EQ]: [link(EQ, SECTION, 2)],
					[BI]: [link(BI, SECTION, 2)],
					[TR]: [link(TR, SECTION, 2)],
					[NC]: [link(NC, SECTION, 2)],
				},
			},
		},
		// B: the target — nothing stored
		{ section_tipo: SECTION, section_id: 2, columns: { string: { [TERM]: term('B') } } },
		// C: isolated
		{ section_tipo: SECTION, section_id: 3, columns: { string: { [TERM]: term('C') } } },
		{
			// D: a second referrer of B (ordering)
			section_tipo: SECTION,
			section_id: 4,
			columns: {
				string: { [TERM]: term('D') },
				relation: { [EQ]: [link(EQ, SECTION, 2)] },
			},
		},
		{
			// F: BOTH stored links (→ H, then → G) and an inverse referrer (H).
			// Ids chosen so a sort by section_id, an inverse-first merge or a
			// dedupe of the mutual F↔H pair each changes the array.
			section_tipo: SECTION,
			section_id: 7,
			columns: {
				string: { [TERM]: term('F') },
				relation: { [EQ]: [link(EQ, SECTION, 9), link(EQ, SECTION, 8)] },
			},
		},
		{
			// H: points back at F
			section_tipo: SECTION,
			section_id: 8,
			columns: {
				string: { [TERM]: term('H') },
				relation: { [EQ]: [link(EQ, SECTION, 7)] },
			},
		},
		// G: F's other stored target
		{ section_tipo: SECTION, section_id: 9, columns: { string: { [TERM]: term('G') } } },
		// E: referenced only from another section
		{ section_tipo: SECTION, section_id: 5, columns: { string: { [TERM]: term('E') } } },
		{
			section_tipo: FOREIGN,
			section_id: 1,
			columns: { relation: { [EQ]: [link(EQ, SECTION, 5)] } },
		},
	],
});

beforeAll(async () => {
	await ensureSituation(S);
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
}, 60000);

async function nodeOf(sectionId: number) {
	const node = await buildNodeData(SECTION, sectionId, {}, null, ADMIN);
	const icons = node.ar_elements
		.filter((element) => element.type === 'icon')
		.map((element) => element.value);
	const value = node.ar_elements.find((element) => element.type === 'related_value')?.value;
	const term = node.ar_elements.find((element) => element.type === 'term')?.value;
	return { icons, value, term, elementCount: node.ar_elements.length };
}

test('the target of a multidirectional / bidirectional link shows EQ / BI', async () => {
	const { icons } = await nodeOf(2);

	expect(icons).toContain('EQ');
	expect(icons).toContain('BI');
});

test("the target's related value is its inverse references, ordered by section_id", async () => {
	const { value } = await nodeOf(2);

	expect(value).toEqual([
		{ section_tipo: SECTION, section_id: 1, from_component_tipo: EQ },
		{ section_tipo: SECTION, section_id: 4, from_component_tipo: EQ },
	]);
});

test('unidirectional (and unset → unidirectional) stays stored-only on the target', async () => {
	const { icons } = await nodeOf(2);

	expect(icons).not.toContain('TR');
	expect(icons).not.toContain('NC');
});

test('the source shows every icon from its stored bag, stored entries first', async () => {
	const { icons, value } = await nodeOf(1);

	expect(icons).toEqual(['EQ', 'BI', 'TR', 'NC']);
	expect(value).toEqual([link(EQ, SECTION, 2)]);
});

test('stored links AND inverse referrers merge as [...stored, ...inverse], never self', async () => {
	const { icons, value } = await nodeOf(7);

	expect(icons).toContain('EQ');
	expect(value).toEqual([
		link(EQ, SECTION, 9),
		link(EQ, SECTION, 8),
		{ section_tipo: SECTION, section_id: 8, from_component_tipo: EQ },
	]);
	expect((value as Array<{ section_id: number }>).some((entry) => entry.section_id === 7)).toBe(
		false,
	);
});

test('an isolated node shows none of the related icons', async () => {
	const { icons, term, elementCount } = await nodeOf(3);

	// Floor: the node WAS built from the ddo_map (its term resolved), so the
	// empty icon list is a verdict, not an unread node.
	expect(elementCount).toBeGreaterThan(0);
	expect(String(term)).toContain('C');
	expect(icons).toEqual([]);
});

test('a referrer in another section never counts', async () => {
	const { icons } = await nodeOf(5);

	expect(icons).not.toContain('EQ');
});
