/**
 * `state_of_component` messages on the structure context (T2-SC-1, O04/O05).
 *
 * THE CONTRACT (PHP build_structure_context :1994-2005, v6 :1788-1799): a
 * component's `properties.state_of_component.<key>.msg` is a UI-label KEY; the
 * wire carries its TEXT in the request's APPLICATION lang, `%s` filled with the
 * term of `target_component`. The client shows `msg` as the state icon's
 * tooltip (ui.js), so an unresolved key reached users verbatim
 * (`component_alternative`). TS (the post-emission stamps block):
 *  - resolved on whichever properties source WINS — the ontology, an RQO
 *    properties override, a governing ddo — so none can ship a raw key;
 *  - a msg that is not a label key, or whose text keeps an unfilled `%s` (no
 *    target to name), is REFUSED: dropped and logged, never shipped;
 *  - sibling keys (icon, target_component) and msg-less entries pass through.
 * The lg-cat leg also pins the `% s` catalog defect (lg-cat.json
 * component_alternative): a placeholder sprintf never fills.
 *
 * SITUATION (tld `zzsoc`, dropped in afterAll with residue asserted):
 *  zzsoc1 REAL section (relations → test24)
 *    zzsoc2 component_input_text  state_of_component {alternative → zzsoc3,
 *           deprecated (unknown key), orphan (%s, no target), plain (no msg)}
 *    zzsoc3 component_input_text  term "Preferred title" / "Título preferido"
 *    zzsoc4 component_input_text  term with `$&`/`$'`/`$1` (literal insertion)
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import { getLabels } from '../../src/core/labels/catalog.ts';
import { termByTipo } from '../../src/core/ontology/labels.ts';
import { resolveElement, rootNodeFor } from '../../src/core/relations/element_node.ts';
import { ElementNodeRegistry } from '../../src/core/relations/element_registry.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const SECTION = 'zzsoc1';
const CARRIER = 'zzsoc2';
const TARGET = 'zzsoc3';
/** A target whose term carries String.replace patterns — they must stay literal. */
const DOLLAR_TARGET = 'zzsoc4';
const DOLLAR_TERM = "Cost $& and $' and $1 tail";
const LABEL_KEY = 'component_alternative';

const STATE = {
	alternative: { msg: LABEL_KEY, target_component: TARGET, icon: 'alternative' },
	deprecated: { msg: 'zz_not_a_label_key', target_component: TARGET },
	orphan: { msg: LABEL_KEY },
	plain: { icon: 'plain' },
	dollar: { msg: LABEL_KEY, target_component: DOLLAR_TARGET },
};

const S = situation({
	name: 'state_of_component msg',
	tld: 'zzsoc',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 96,
			term: { 'lg-eng': 'state_of_component section' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: CARRIER,
			parent: SECTION,
			model: 'component_input_text',
			order_number: 1,
			properties: { state_of_component: STATE },
		},
		{
			tipo: TARGET,
			parent: SECTION,
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-eng': 'Preferred title', 'lg-spa': 'Título preferido' },
		},
		{
			tipo: DOLLAR_TARGET,
			parent: SECTION,
			model: 'component_input_text',
			order_number: 3,
			term: { 'lg-eng': DOLLAR_TERM },
		},
	],
});

type StateMap = Record<string, Record<string, unknown>>;

let warn: ReturnType<typeof spyOn>;

beforeAll(async () => {
	await assertTestDatabase('structure_context_state_of_component_native');
	await ensureSituation(S);
	warn = spyOn(console, 'warn').mockImplementation(() => {});
}, 60_000);

afterAll(async () => {
	warn.mockRestore();
	expect(await dropSituation(S)).toBe(0);
});

async function stateIn(
	lang: string,
	tipo = CARRIER,
	propertiesOverride?: Record<string, unknown>,
): Promise<StateMap> {
	const entry = await runWithRequestLangs({ applicationLang: lang, dataLang: lang }, () =>
		buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-nolan',
			permissions: 2,
			...(propertiesOverride !== undefined ? { propertiesOverride } : {}),
		}),
	);
	return (entry?.properties as { state_of_component?: StateMap } | undefined)
		?.state_of_component as StateMap;
}

/** The catalog text of the key in `lang`, `%s` = the target's term in `lang`. */
async function expectedText(lang: string): Promise<string> {
	const template = (await getLabels(lang))[LABEL_KEY] as string;
	expect(template).toContain('%s');
	return template.replace('%s', await termByTipo(TARGET, lang));
}

describe('state_of_component.msg is resolved, never shipped as a key (T2-SC-1)', () => {
	test('lg-eng: the label text with the target term filled in', async () => {
		const state = await stateIn('lg-eng');
		expect(state.alternative?.msg).toBe(await expectedText('lg-eng'));
		expect(String(state.alternative?.msg)).toContain('Preferred title');
		// siblings survive untouched
		expect(state.alternative?.icon).toBe('alternative');
		expect(state.alternative?.target_component).toBe(TARGET);
		expect(state.plain).toEqual({ icon: 'plain' });
	});

	test('the request APPLICATION lang decides — lg-spa text, Spanish term', async () => {
		const state = await stateIn('lg-spa');
		expect(state.alternative?.msg).toBe(await expectedText('lg-spa'));
		expect(String(state.alternative?.msg)).toContain('Título preferido');
	});

	test('lg-cat: the catalog placeholder fills (the `% s` typo never did)', async () => {
		const state = await stateIn('lg-cat');
		const msg = String(state.alternative?.msg);
		expect(msg).toContain(await termByTipo(TARGET, 'lg-cat'));
		expect(msg).not.toMatch(/%\s?s/);
	});

	test("the target term is inserted LITERALLY — `$&`, `$'`, `$1` are not replacement patterns", async () => {
		const state = await stateIn('lg-eng');
		const template = (await getLabels('lg-eng'))[LABEL_KEY] as string;
		const at = template.indexOf('%s');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(state.dollar?.msg).toBe(
			`${template.slice(0, at)}${DOLLAR_TERM}${template.slice(at + 2)}`,
		);
	});

	test('an unknown key, or a %s with no target, is REFUSED — dropped and logged, the entry kept', async () => {
		warn.mockClear();
		const state = await stateIn('lg-eng');
		expect(state.deprecated).toEqual({ target_component: TARGET });
		expect(state.orphan).toEqual({});
		const lines: string[] = (warn.mock.calls as unknown[][]).map((call) => String(call[0]));
		expect(lines.some((line) => line.includes('zz_not_a_label_key'))).toBe(true);
		expect(lines.some((line) => line.includes(`${CARRIER} state_of_component.orphan`))).toBe(true);
	});

	test('an RQO properties OVERRIDE cannot ship an unresolved key', async () => {
		const state = await stateIn('lg-eng', TARGET, {
			state_of_component: { alternative: { msg: LABEL_KEY, target_component: TARGET } },
		});
		expect(state.alternative?.msg).toBe(await expectedText('lg-eng'));
	});

	test('a GOVERNING ddo’s properties cannot ship an unresolved key either', async () => {
		const callerMap: Ddo[] = [
			{
				tipo: TARGET,
				section_tipo: SECTION,
				parent: SECTION,
				mode: 'edit',
				properties: {
					state_of_component: { alternative: { msg: LABEL_KEY, target_component: TARGET } },
				},
			} as unknown as Ddo,
		];
		const entry = await runWithRequestLangs(
			{ applicationLang: 'lg-eng', dataLang: 'lg-eng' },
			async () => {
				const registry = new ElementNodeRegistry();
				const parentNode = rootNodeFor(registry, SECTION, SECTION, 'edit', callerMap);
				const node = await resolveElement({
					ddo: callerMap[0] as Ddo,
					parentNode,
					ownerSectionTipo: SECTION,
					mode: 'edit',
					lang: 'lg-nolan',
					registry,
				});
				expect(node.properties).not.toBeNull();
				return buildStructureContext({
					configFrom: { source: 'emission', node },
					tipo: TARGET,
					sectionTipo: SECTION,
					mode: 'edit',
					lang: 'lg-nolan',
					permissions: 2,
				});
			},
		);
		const state = (entry?.properties as { state_of_component?: StateMap } | undefined)
			?.state_of_component;
		expect(state?.alternative?.msg).toBe(await expectedText('lg-eng'));
	});
});
