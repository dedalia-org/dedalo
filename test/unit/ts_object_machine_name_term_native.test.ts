/**
 * A tree node's `term` element shows — and EDITS — the component that names the
 * node (src/core/ts_object/ts_object.ts termTiposShown;
 * WC-2026-11-04-ontology-machine-names).
 *
 * WHY IT EXISTS. An ontology node is named either by its translatable label or
 * by a language-free machine name, and the node's own si/no flag says which.
 * The section_map declares both roles (`machine_name`, `use_machine_name`) next
 * to `term`; the tree must follow the flag through those roles — never a
 * hardcoded tipo — and the element must carry the tipos it SHOWS, because the
 * client opens `tipo[0]` when the text is clicked (render_ts_line.js). An
 * element that showed the machine name but carried the label tipo opened the
 * label editor.
 *
 * WHAT IS PINNED (outcomes):
 *   1. flag Yes → the label member of `term` is replaced by `machine_name` at
 *      its position; the rest of the composite stays; the value is the machine
 *      name; the element's model is the machine name's;
 *   2. flag No → the declared tipos and the label, the machine name never shown;
 *   3. flag Yes with an EMPTY machine name → still the machine-name tipo, and
 *      the label is NOT borrowed (the client marks the empty term as missing);
 *   4. flag unset → the declared tipos (No is the default).
 *
 * SITUATION. `zztmn*` scratch TLD, built and dropped by this file.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { buildNodeData } from '../../src/core/ts_object/ts_object.ts';

const SECTION = 'zztmn1';
const LIST = 'zztmn2';
const LABEL = 'zztmn3'; // translatable label
const TLD = 'zztmn4'; // non-translatable composite member
const MAP = 'zztmn5';
const MACHINE_NAME = 'zztmn6';
const FLAG = 'zztmn7';

const YES = 1;
const NO = 2;

const ADMIN = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as const;

const labelItems = (value: string) =>
	['lg-spa', 'lg-eng', 'lg-cat'].map((lang, index) => ({ id: index + 1, lang, value }));
const nolan = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];
const flag = (sectionId: number) => [
	{ id: 1, type: 'dd151', section_tipo: 'dd64', section_id: sectionId, from_component_tipo: FLAG },
];

const S = situation({
	name: 'ts_object machine-name term',
	tld: 'zztmn',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: LIST,
			parent: SECTION,
			model: 'section_list_thesaurus',
			properties: { show: { ddo_map: [{ tipo: [LABEL, TLD], type: 'term' }] } },
		},
		{
			tipo: MAP,
			parent: SECTION,
			model: 'section_map',
			properties: {
				thesaurus: { term: [LABEL, TLD], machine_name: MACHINE_NAME, use_machine_name: FLAG },
			},
		},
		{ tipo: LABEL, parent: SECTION, model: 'component_input_text', is_translatable: true },
		{ tipo: TLD, parent: SECTION, model: 'component_input_text' },
		{ tipo: MACHINE_NAME, parent: SECTION, model: 'component_input_text' },
		{ tipo: FLAG, parent: SECTION, model: 'component_radio_button' },
	],
	records: [
		{
			// 1. named by its machine name
			section_tipo: SECTION,
			section_id: 1,
			columns: {
				string: { [MACHINE_NAME]: nolan('table_x'), [TLD]: nolan('zz') },
				relation: { [FLAG]: flag(YES) },
			},
		},
		{
			// 2. named by its label; a stray machine name is never shown
			section_tipo: SECTION,
			section_id: 2,
			columns: {
				string: {
					[LABEL]: labelItems('Coins'),
					[MACHINE_NAME]: nolan('stray_name'),
					[TLD]: nolan('zz'),
				},
				relation: { [FLAG]: flag(NO) },
			},
		},
		{
			// 3. Yes but no machine name: the label is NOT borrowed
			section_tipo: SECTION,
			section_id: 3,
			columns: {
				string: { [LABEL]: labelItems('Borrowed'), [TLD]: nolan('zz') },
				relation: { [FLAG]: flag(YES) },
			},
		},
		{
			// 4. flag unset: the declared term
			section_tipo: SECTION,
			section_id: 4,
			columns: { string: { [LABEL]: labelItems('Unset'), [TLD]: nolan('zz') } },
		},
	],
});

beforeAll(async () => {
	await ensureSituation(S);
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
}, 60000);

async function termOf(sectionId: number) {
	const node = await buildNodeData(SECTION, sectionId, {}, null, ADMIN);
	const term = node.ar_elements.find((element) => element.type === 'term');
	if (term === undefined) throw new Error(`node ${sectionId} has no term element`);
	return term;
}

test('flag Yes: the machine name replaces the label at its position, and is what a click opens', async () => {
	const term = await termOf(1);

	expect(term.tipo).toEqual([MACHINE_NAME, TLD]);
	expect(String(term.value)).toBe('table_x zz');
	expect(term.model).toBe('component_input_text');
});

test('flag No: the declared label, never the stored machine name', async () => {
	const term = await termOf(2);

	expect(term.tipo).toEqual([LABEL, TLD]);
	expect(String(term.value)).toContain('Coins');
	expect(String(term.value)).not.toContain('stray_name');
});

test('flag Yes with no machine name: the label is not borrowed', async () => {
	const term = await termOf(3);

	expect(term.tipo).toEqual([MACHINE_NAME, TLD]);
	expect(String(term.value)).not.toContain('Borrowed');
	expect(String(term.value).trim()).toBe('zz');
});

test('flag unset: the declared term (No is the default)', async () => {
	const term = await termOf(4);

	expect(term.tipo).toEqual([LABEL, TLD]);
	expect(String(term.value)).toContain('Unset');
});
