/**
 * Section context `color` (WC-2026-11-25-section-context-color).
 *
 * THE RULE: a section's context carries `color` = its OWN node's explicit
 * properties.color, in every mode — no grey fallback (that fallback belongs to
 * component_section_id's edit band). The list Id-column stripe reads it
 * (view_default_list_section.js → list.less `.has_section_color`).
 *
 * Why a stamp and not properties: in list mode the emitted section properties
 * are SWAPPED for the section_list child's (structure_context
 * resolveEmittedPropertiesAndCss), so properties.color never reached the list.
 * The list case below pins that swap (properties carry no color) so the stamp
 * is proved to be what carries it.
 *
 * SITUATION (tld `zzscc`, dropped in afterAll with residue asserted):
 *  - zzscc1  section {color:'#7a4b8c'}: zzscc2 input_text, section_list zzscc3
 *            (non-null properties without color — the swap really replaces)
 *  - zzscc10 section (no color): zzscc11 input_text, section_list zzscc12
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readSection } from '../../src/core/section/read.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const COLORED = 'zzscc1';
const PLAIN = 'zzscc10';
const COLOR = '#7a4b8c';

const S = situation({
	name: 'section context color',
	tld: 'zzscc',
	nodes: [
		{
			tipo: COLORED,
			parent: 'test1',
			model: 'section',
			order_number: 95,
			properties: { color: COLOR },
		},
		{ tipo: 'zzscc2', parent: COLORED, model: 'component_input_text', order_number: 1 },
		{
			tipo: 'zzscc3',
			parent: COLORED,
			model: 'section_list',
			order_number: 2,
			relations: [{ tipo: 'zzscc2' }],
			properties: { css: { '.wrapper_component': { width: '100%' } } },
		},
		{ tipo: PLAIN, parent: 'test1', model: 'section', order_number: 96 },
		{ tipo: 'zzscc11', parent: PLAIN, model: 'component_input_text', order_number: 1 },
		{
			tipo: 'zzscc12',
			parent: PLAIN,
			model: 'section_list',
			order_number: 2,
			relations: [{ tipo: 'zzscc11' }],
		},
	],
});

beforeAll(async () => {
	await ensureSituation(S);
	await assertTestDatabase('section_context_color_native');
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

/** The section's own context entry, read through the real read door. */
async function sectionEntry(tipo: string, mode: 'list' | 'edit'): Promise<Record<string, unknown>> {
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: { model: 'section', tipo, section_tipo: tipo, mode, lang: 'lg-spa', action: 'search' },
		sqo: { section_tipo: [tipo], limit: 1, offset: 0 },
	} as unknown as Rqo;
	const result = await runWithRequestContext(
		{
			principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
			session: null,
			requestId: 'section_context_color_native',
			clientIp: '127.0.0.1',
		},
		() => readSection(rqo),
	);
	const context = result.context as unknown as Record<string, unknown>[];
	const entry = context.find((item) => item.tipo === tipo && item.model === 'section');
	if (entry === undefined) throw new Error(`no section context entry for ${tipo} (${mode})`);
	return entry;
}

describe('section context color', () => {
	test('list: color stamped although the section_list swap dropped properties.color', async () => {
		const entry = await sectionEntry(COLORED, 'list');
		// non-vacuity: the swap happened — the emitted properties are the
		// section_list's, which carry no color
		expect((entry.properties as { color?: unknown } | null)?.color).toBeUndefined();
		expect(entry.color).toBe(COLOR);
	});

	test('edit: same color', async () => {
		expect((await sectionEntry(COLORED, 'edit')).color).toBe(COLOR);
	});

	test('no explicit color: key absent in both modes (no grey fallback)', async () => {
		for (const mode of ['list', 'edit'] as const) {
			expect('color' in (await sectionEntry(PLAIN, mode))).toBe(false);
		}
	});
});
