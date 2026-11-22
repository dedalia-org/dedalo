/**
 * A tree node's `term` element is server-built markup whose record text is
 * ESCAPED: each piece goes through the one server escaper BEFORE the `<mark>`
 * untranslated wrap and before the composite `' '` join, and the element names
 * its render class `html` (src/core/ts_object/ts_object.ts resolveElementValue;
 * WC-2026-11-12-tree-term-escaped; owner ruling 2026-11-11: a term may NOT
 * carry markup).
 *
 * WHY IT EXISTS. The term is a component_input_text (render 'text'): its save
 * does not sanitize, so `<img src=x onerror=…>` typed into a thesaurus term
 * was stored verbatim and the tree client parsed it (`inner_html`) for every
 * viewer of the tree — stored XSS from any term editor to every admin.
 *
 * WHAT IS PINNED (outcomes):
 *   1. current-lang value with markup → entities, no `<img` survives;
 *   2. lang fallback → `<mark>` wraps the ESCAPED fallback (ENT_QUOTES);
 *   3. composite → each piece escaped, the join space intact;
 *   4. every term element carries render_class 'html'; icon elements none;
 *   control: a benign term is byte-identical.
 *
 * SITUATION. `zztte*` scratch TLD, built and dropped by this file.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { buildNodeData } from '../../src/core/ts_object/ts_object.ts';

const SECTION = 'zztte1';
const LIST = 'zztte2';
const LABEL = 'zztte3'; // translatable label
const CODE = 'zztte4'; // non-translatable composite member
const NOTE = 'zztte5'; // icon element

const ADMIN = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as const;

const HOSTILE = '<img src=x onerror=alert(1)>';
const FALLBACK = `<b>x</b> & 'y'`;
/**
 * A configured project lang that is neither a request data lang this file reads
 * in (the default) nor the zztte main lang (lg-eng: no hierarchy row) — so only
 * the project-lang rung can supply it. A lang no project declares renders
 * nothing (THES-01: the chain stops at the project langs).
 */
const FALLBACK_LANG = (() => {
	const langs = config.menu.projectsDefaultLangs.filter(
		(code) => code !== 'lg-eng' && code !== config.lang.dataLangDefault,
	);
	const last = langs.at(-1);
	if (last === undefined) throw new Error('no project lang besides the default and lg-eng');
	return last;
})();

const labelItems = (value: string) =>
	['lg-spa', 'lg-eng', 'lg-cat'].map((lang, index) => ({ id: index + 1, lang, value }));
const nolan = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];

const S = situation({
	name: 'ts_object term escape',
	tld: 'zztte',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: LIST,
			parent: SECTION,
			model: 'section_list_thesaurus',
			properties: {
				show: {
					ddo_map: [
						{ tipo: [LABEL, CODE], type: 'term' },
						{ tipo: NOTE, type: 'icon', icon: 'N' },
					],
				},
			},
		},
		{ tipo: LABEL, parent: SECTION, model: 'component_input_text', is_translatable: true },
		{ tipo: CODE, parent: SECTION, model: 'component_input_text' },
		{ tipo: NOTE, parent: SECTION, model: 'component_input_text' },
	],
	records: [
		{
			// 1. markup in the current-lang label
			section_tipo: SECTION,
			section_id: 1,
			columns: { string: { [LABEL]: labelItems(HOSTILE), [CODE]: nolan('aa') } },
		},
		{
			// 2. label only in a project lang the request does not use → the
			//    untranslated fallback (the project-lang rung, THES-01)
			section_tipo: SECTION,
			section_id: 2,
			columns: {
				string: {
					[LABEL]: [{ id: 1, lang: FALLBACK_LANG, value: FALLBACK }],
					[CODE]: nolan('aa'),
				},
			},
		},
		{
			// 3. markup in the composite's second piece; an icon with data
			section_tipo: SECTION,
			section_id: 3,
			columns: {
				string: {
					[LABEL]: labelItems('Coins'),
					[CODE]: nolan('a<b'),
					[NOTE]: nolan('a note'),
				},
			},
		},
		{
			// control: nothing to escape
			section_tipo: SECTION,
			section_id: 4,
			columns: { string: { [LABEL]: labelItems('Coins'), [CODE]: nolan('aa') } },
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
	return buildNodeData(SECTION, sectionId, {}, null, ADMIN);
}

async function termOf(sectionId: number) {
	const node = await nodeOf(sectionId);
	const term = node.ar_elements.find((element) => element.type === 'term');
	if (term === undefined) throw new Error(`node ${sectionId} has no term element`);
	return term;
}

test('markup in the current-lang term reaches the wire as entities, never as a tag', async () => {
	const value = String((await termOf(1)).value);

	expect(value).toBe('&lt;img src=x onerror=alert(1)&gt; aa');
	expect(value).not.toContain('<img');
});

test('the untranslated fallback: <mark> wraps the ESCAPED text (ENT_QUOTES)', async () => {
	const value = String((await termOf(2)).value);

	expect(value).toBe('<mark>&lt;b&gt;x&lt;/b&gt; &amp; &#039;y&#039;</mark> aa');
});

test('composite: each piece escaped, the join space intact', async () => {
	expect(String((await termOf(3)).value)).toBe('Coins a&lt;b');
});

test('the term element names its render class html; non-term elements carry none', async () => {
	const node = await nodeOf(3);
	const terms = node.ar_elements.filter((element) => element.type === 'term');
	const icons = node.ar_elements.filter((element) => element.type === 'icon');

	expect(terms.length).toBe(1);
	expect(terms.map((element) => element.render_class)).toEqual(['html']);
	expect(icons.length).toBe(1);
	expect(icons[0]?.render_class).toBeUndefined();
});

test('control: a benign term is byte-identical', async () => {
	expect(String((await termOf(4)).value)).toBe('Coins aa');
});
