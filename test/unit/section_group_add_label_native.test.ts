/**
 * `add_label` on section_group contexts — the flag that tells a layout-only
 * `section_group_div` wrapper from a labelled, collapsible `section_group`
 * (T1-28 / O04).
 *
 * THE CONTRACT (PHP section_group_json.php:92-107, v6 :29-34 identical):
 *  - EVERY `section_group` structure-context entry carries
 *    `add_label = legacy_model !== 'section_group_div'`. A `section_group_div`
 *    is aliased to `section_group` at runtime (GROUPER_MODEL_ALIASES), so its
 *    entry is `model section_group` + `legacy_model section_group_div` +
 *    `add_label false` — the client (render_section_group.js, `=== false`)
 *    then renders an unlabelled `no_margin` div with no collapse header.
 *  - NO other model carries the key (section_tab / tab / components / section).
 *  - The search-panel element list (get_section_elements_context) builds its
 *    groupers through get_structure_context_simple, never the json controller
 *    → NO `add_label` key there, and the div is recursed through, never emitted.
 *  - The flag is a pure function of the STORED model, so it lives in the cached
 *    core; an ontology model edit must be reflected on the next read.
 *
 * Before T1-28 no TS emitter existed: every div panel rendered as a labelled
 * collapsible box. The parity gate missed it because its grouper key left
 * `add_label` out (now tightened — grouper_context_differential.test.ts).
 *
 * SITUATION (tld `zzsgd`, dropped in afterAll with residue asserted):
 *  zzsgd1 REAL section (relations → test24), one record (id 1)
 *    zzsgd2 section_group      → zzsgd3 component_input_text
 *    zzsgd4 section_group_div  → zzsgd5 component_input_text
 *    zzsgd6 section_tab        → zzsgd7 tab → zzsgd8 component_input_text
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { buildSectionElementsContext } from '../../src/core/resolve/section_elements_context.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';

const SECTION = 'zzsgd1';
const GROUP = 'zzsgd2';
const DIV = 'zzsgd4';
const DIV_CHILD = 'zzsgd5';
const TAB_SECTION = 'zzsgd6';
const TAB = 'zzsgd7';

const DIV_NODE = { tipo: DIV, parent: SECTION, model: 'section_group_div', order_number: 2 };

const S = situation({
	name: 'section_group add_label',
	tld: 'zzsgd',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 95,
			term: { 'lg-eng': 'add_label section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: GROUP, parent: SECTION, model: 'section_group', order_number: 1 },
		{ tipo: 'zzsgd3', parent: GROUP, model: 'component_input_text', order_number: 1 },
		DIV_NODE,
		{ tipo: DIV_CHILD, parent: DIV, model: 'component_input_text', order_number: 1 },
		{ tipo: TAB_SECTION, parent: SECTION, model: 'section_tab', order_number: 3 },
		{ tipo: TAB, parent: TAB_SECTION, model: 'tab', order_number: 1 },
		{ tipo: 'zzsgd8', parent: TAB, model: 'component_input_text', order_number: 1 },
	],
	records: [
		{
			section_tipo: SECTION,
			section_id: 1,
			columns: { string: { zzsgd3: [{ id: 1, lang: 'lg-nolan', value: 'x' }] } },
		},
	],
});

interface ContextEntry {
	tipo?: string;
	model?: string;
	legacy_model?: unknown;
	type?: unknown;
	parent_grouper?: unknown;
	add_label?: unknown;
}

let tsContext: Record<string, unknown>;

beforeAll(async () => {
	await ensureSituation(S);
	await assertTestDatabase('section_group_add_label_native');
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'section-group-add-label',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
	// A section read logs a dd542 LOAD row naming the section; sweep + assert.
	for (const node of S.nodes) await sweepActivityRows(node.tipo);
	let residue = 0;
	for (const node of S.nodes) residue += await countActivityRows(node.tipo);
	expect(residue).toBe(0);
});

/** The edit read of record 1 through the real pipeline → its context entries. */
async function editContext(): Promise<Map<string, ContextEntry>> {
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: SECTION,
			section_tipo: SECTION,
			action: 'search',
			mode: 'edit',
			lang: 'lg-nolan',
		},
		sqo: {
			section_tipo: [SECTION],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: SECTION, section_id: '1' }],
		},
	};
	const body = (await dispatchRqo(rqo as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { context?: ContextEntry[] };
	};
	expect(body.ok).not.toBe(false);
	const context = (body.data?.context ?? []).filter((e) => e.tipo?.startsWith('zzsgd'));
	return new Map(context.map((entry) => [entry.tipo as string, entry]));
}

describe('section edit read — add_label on section_group contexts', () => {
	test('a plain section_group carries add_label true', async () => {
		const group = (await editContext()).get(GROUP);
		expect(group?.model).toBe('section_group');
		expect(group?.type).toBe('grouper');
		expect(group?.add_label).toBe(true);
	});

	test('a section_group_div is a section_group with add_label false', async () => {
		const ctx = await editContext();
		const div = ctx.get(DIV);
		expect(div?.model).toBe('section_group');
		expect(div?.legacy_model).toBe('section_group_div');
		expect(div?.type).toBe('grouper');
		expect(div?.add_label).toBe(false);
		// The div still nests its children (it is a grouper, only unlabelled).
		expect(ctx.get(DIV_CHILD)?.parent_grouper).toBe(DIV);
	});

	test('no other model carries the key (tab family, components, section)', async () => {
		const ctx = await editContext();
		// Non-vacuity: the entries this asserts over are actually present.
		for (const tipo of [SECTION, TAB_SECTION, TAB, 'zzsgd3', DIV_CHILD, 'zzsgd8']) {
			expect(ctx.has(tipo)).toBe(true);
		}
		for (const entry of ctx.values()) {
			if (entry.model === 'section_group') continue;
			expect('add_label' in entry).toBe(false);
		}
	});

	test('cached core: stable across reads, rebuilt after an ontology model edit', async () => {
		expect((await editContext()).get(DIV)?.add_label).toBe(false);
		expect((await editContext()).get(DIV)?.add_label).toBe(false);
		await upsertDdOntologyNode({ ...DIV_NODE, tld: 'zzsgd', model: 'section_group' });
		try {
			const flipped = (await editContext()).get(DIV);
			expect(flipped?.legacy_model).toBe('section_group');
			expect(flipped?.add_label).toBe(true);
		} finally {
			await upsertDdOntologyNode({ ...DIV_NODE, tld: 'zzsgd' });
		}
		expect((await editContext()).get(DIV)?.add_label).toBe(false);
	});
});

describe('search-panel element list — PHP simple contexts, no add_label', () => {
	test('groupers there carry no add_label; the div is never emitted', async () => {
		const principal = await resolvePrincipal(-1);
		const entries = (await buildSectionElementsContext(principal, {
			ar_section_tipo: [SECTION],
		})) as ContextEntry[];
		const group = entries.find((e) => e.tipo === GROUP);
		expect(group?.type).toBe('grouper');
		expect('add_label' in (group as object)).toBe(false);
		expect(entries.some((e) => e.tipo === DIV)).toBe(false);
		for (const entry of entries) expect('add_label' in entry).toBe(false);
	});
});
