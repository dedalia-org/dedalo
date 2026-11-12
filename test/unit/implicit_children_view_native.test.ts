/**
 * IMPLICIT ddos carry the CALLER's `children_view` (T1-30 / audit O01).
 *
 * THE RULE (PHP trait.request_config_v5.php build_request_config_v5 :119-121 +
 * build_legacy_ddo_map :618-650): every ddo of an implicit (config-less)
 * request_config gets
 *     view = caller's OWN properties.children_view
 *            ?? the child's own properties.view
 *            ?? resolve_view(model)            (null → key omitted)
 * "Caller's own" is the instance's properties: an rqo `source.properties`
 * override counts; the list-mode section_list swap (Site B) does NOT — a
 * section in list mode keeps its own children_view, and a component whose
 * section_list carries one ignores it (owner ruling pending, plan §7 — case 8
 * pins the frozen-v7 / oracle behaviour). The relation-family LEGACY
 * children_view default ('text' for autocomplete) is NOT applied here: PHP
 * reads properties only.
 *
 * Before the fix the component-list ddos carried NO view at all, the
 * component_filter dd156 ddo none, and section edit ignored children_view —
 * so the coin-type portals rendered their children full-size instead of 'mini',
 * and the symbol/design legend portals as a grid instead of 'text'.
 *
 * Generic twins of the audited install nodes (test TLD clones, implicit, own
 * children_view; map in src/core/test_data/test_tld_tipo_map.json): test6123
 * and test6151 ('mini'), test6133 ('text').
 *
 * SITUATION (tld `zzchv`, dropped in afterAll with residue asserted):
 *  - zzchv1  target section (matrix_test): zzchv2 input_text, zzchv3 portal
 *            {view:'mosaic'}, zzchv4 autocomplete (no properties)
 *  - zzchv10 host section with the owners:
 *      zzchv5 portal {children_view:'text'}  relations [1,2,3,4]
 *      zzchv6 portal (none)                  relations [1,2,3,4]
 *      zzchv7 autocomplete (none)            relations [1,2]
 *      zzchv8 portal {children_view:'mini'} + section_list zzchv11 {children_view:'text'}
 *      zzchv9 portal (none)                 + section_list zzchv12 {children_view:'text'}
 *      zzchv16 component_filter {children_view:'text'}
 *  - zzchv13 section {children_view:'text'}: zzchv14 input_text,
 *            section_list zzchv15 (config-less, relations [zzchv14])
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { buildRequestConfigForElement } from '../../src/core/relations/request_config/build.ts';
import type { ParsedRequestConfigItem } from '../../src/core/relations/request_config/explicit.ts';
import { resolveOwnRequestConfig } from '../../src/core/relations/request_config/own_config.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';

const TARGET = 'zzchv1';
const HOST = 'zzchv10';
const LINKS = [{ tipo: 'zzchv1' }, { tipo: 'zzchv2' }, { tipo: 'zzchv3' }, { tipo: 'zzchv4' }];

const S = situation({
	name: 'implicit children_view',
	tld: 'zzchv',
	nodes: [
		// --- the target section and its children ---------------------------------
		{ tipo: 'zzchv1', parent: 'test1', model: 'section', order_number: 95 },
		{ tipo: 'zzchv2', parent: 'zzchv1', model: 'component_input_text', order_number: 1 },
		{
			tipo: 'zzchv3',
			parent: 'zzchv1',
			model: 'component_portal',
			order_number: 2,
			properties: { view: 'mosaic' },
		},
		{ tipo: 'zzchv4', parent: 'zzchv1', model: 'component_autocomplete', order_number: 3 },
		// --- the host section and the owners -------------------------------------
		{ tipo: 'zzchv10', parent: 'test1', model: 'section', order_number: 96 },
		{
			tipo: 'zzchv5',
			parent: 'zzchv10',
			model: 'component_portal',
			order_number: 1,
			relations: LINKS,
			properties: { children_view: 'text' },
		},
		{
			tipo: 'zzchv6',
			parent: 'zzchv10',
			model: 'component_portal',
			order_number: 2,
			relations: LINKS,
		},
		{
			tipo: 'zzchv7',
			parent: 'zzchv10',
			model: 'component_autocomplete',
			order_number: 3,
			relations: [{ tipo: 'zzchv1' }, { tipo: 'zzchv2' }],
		},
		{
			tipo: 'zzchv8',
			parent: 'zzchv10',
			model: 'component_portal',
			order_number: 4,
			relations: [{ tipo: 'zzchv1' }, { tipo: 'zzchv2' }],
			properties: { children_view: 'mini' },
		},
		{
			tipo: 'zzchv11',
			parent: 'zzchv8',
			model: 'section_list',
			order_number: 1,
			relations: [{ tipo: 'zzchv1' }, { tipo: 'zzchv2' }],
			properties: { children_view: 'text' },
		},
		{
			tipo: 'zzchv9',
			parent: 'zzchv10',
			model: 'component_portal',
			order_number: 5,
			relations: [{ tipo: 'zzchv1' }, { tipo: 'zzchv2' }],
		},
		{
			tipo: 'zzchv12',
			parent: 'zzchv9',
			model: 'section_list',
			order_number: 1,
			relations: [{ tipo: 'zzchv1' }, { tipo: 'zzchv2' }],
			properties: { children_view: 'text' },
		},
		{
			tipo: 'zzchv16',
			parent: 'zzchv10',
			model: 'component_filter',
			order_number: 6,
			properties: { children_view: 'text' },
		},
		// --- a section with its own children_view ---------------------------------
		{
			tipo: 'zzchv13',
			parent: 'test1',
			model: 'section',
			order_number: 97,
			properties: { children_view: 'text' },
		},
		{ tipo: 'zzchv14', parent: 'zzchv13', model: 'component_input_text', order_number: 1 },
		{
			tipo: 'zzchv15',
			parent: 'zzchv13',
			model: 'section_list',
			order_number: 2,
			relations: [{ tipo: 'zzchv14' }],
		},
	],
	records: [
		{
			section_tipo: TARGET,
			section_id: 1,
			columns: { string: { zzchv2: [{ id: 1, lang: 'lg-nolan', value: 'A' }] } },
		},
		{
			section_tipo: HOST,
			section_id: 1,
			columns: {
				relation: {
					zzchv5: [
						{
							id: 1,
							type: 'dd151',
							section_id: 1,
							section_tipo: TARGET,
							from_component_tipo: 'zzchv5',
						},
					],
				},
			},
		},
	],
});

let tsContext: Record<string, unknown>;

beforeAll(async () => {
	await ensureSituation(S);
	await assertTestDatabase('implicit_children_view_native');
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'implicit-children-view',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
	const tipos = S.nodes.map((node) => node.tipo);
	for (const tipo of tipos) await sweepActivityRows(tipo);
	let activityResidue = 0;
	for (const tipo of tipos) activityResidue += await countActivityRows(tipo);
	expect(activityResidue).toBe(0);
});

/** Build a COMPONENT owner's config from its own node properties. */
async function componentConfig(
	tipo: string,
	sectionTipo: string,
	mode: string,
): Promise<ParsedRequestConfigItem[]> {
	const node = await getNode(tipo);
	return buildRequestConfigForElement(node?.properties ?? null, {
		ownerTipo: tipo,
		ownerSectionTipo: sectionTipo,
		mode,
		ownerIsSection: false,
	});
}

/** tipo → view (undefined = key absent) of the first item's show ddo_map. */
function viewsOf(config: ParsedRequestConfigItem[]): Map<string, unknown> {
	const ddos = (config[0]?.show?.ddo_map ?? []) as unknown as Record<string, unknown>[];
	const views = new Map<string, unknown>();
	for (const ddo of ddos) {
		views.set(String(ddo.tipo), 'view' in ddo ? ddo.view : undefined);
	}
	return views;
}

/** Every ddo carries `expected`; the map is non-empty (non-vacuity). */
function expectAllViews(config: ParsedRequestConfigItem[], expected: string): void {
	const views = viewsOf(config);
	expect(views.size).toBeGreaterThan(0);
	for (const [tipo, view] of views) expect({ tipo, view }).toEqual({ tipo, view: expected });
}

describe('generic test-TLD twins of the audited install nodes', () => {
	test('test6151 edit — every implicit child is mini', async () => {
		expectAllViews(await componentConfig('test6151', 'test6099', 'edit'), 'mini');
	});
	test('test6123 list — every implicit child is mini', async () => {
		expectAllViews(await componentConfig('test6123', 'test6099', 'list'), 'mini');
	});
	test('test6133 edit — every implicit child is text', async () => {
		expectAllViews(await componentConfig('test6133', 'test6099', 'edit'), 'text');
	});
});

describe('component list config (build_legacy_ddo_map)', () => {
	test("owner children_view overrides every child's own view", async () => {
		const views = viewsOf(await componentConfig('zzchv5', HOST, 'edit'));
		expect(Object.fromEntries(views)).toEqual({ zzchv2: 'text', zzchv3: 'text', zzchv4: 'text' });
	});

	test('no children_view → own properties.view, else the model default, else absent', async () => {
		const views = viewsOf(await componentConfig('zzchv6', HOST, 'edit'));
		expect(Object.fromEntries(views)).toEqual({
			zzchv2: undefined,
			zzchv3: 'mosaic',
			zzchv4: 'line',
		});
	});

	test("the relation family's LEGACY children_view default is not applied", async () => {
		const views = viewsOf(await componentConfig('zzchv7', HOST, 'edit'));
		expect(views.has('zzchv2')).toBe(true);
		expect(views.get('zzchv2')).toBeUndefined();
	});

	test("list mode: the owner's own children_view beats its section_list's", async () => {
		expectAllViews(await componentConfig('zzchv8', HOST, 'list'), 'mini');
	});

	test("list mode: a section_list's children_view is not the caller's (frozen v7, plan §7 A)", async () => {
		const views = viewsOf(await componentConfig('zzchv9', HOST, 'list'));
		expect(views.has('zzchv2')).toBe(true);
		expect(views.get('zzchv2')).toBeUndefined();
	});

	test('an rqo properties override supplies the caller children_view', async () => {
		const config = await resolveOwnRequestConfig({
			tipo: 'zzchv6',
			sectionTipo: HOST,
			mode: 'edit',
			propertiesOverride: { children_view: 'line' },
		});
		expectAllViews(config, 'line');
	});

	test('component_filter: the projects-name ddo carries the children_view', async () => {
		expectAllViews(await componentConfig('zzchv16', HOST, 'edit'), 'text');
	});
});

describe('section owners', () => {
	test('section edit: the section children_view overrides its children', async () => {
		const node = await getNode('zzchv13');
		const config = await buildRequestConfigForElement(node?.properties ?? null, {
			ownerTipo: 'zzchv13',
			ownerSectionTipo: 'zzchv13',
			mode: 'edit',
			ownerIsSection: true,
		});
		expect(viewsOf(config).get('zzchv14')).toBe('text');
	});

	test("section list: the section's OWN children_view, read before the section_list swap", async () => {
		const config = await resolveOwnRequestConfig({
			tipo: 'zzchv13',
			sectionTipo: 'zzchv13',
			mode: 'list',
		});
		expect(viewsOf(config).get('zzchv14')).toBe('text');
	});
});

describe('read end-to-end', () => {
	test("the child's context entry under the owner carries the children_view", async () => {
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: HOST,
				section_tipo: HOST,
				action: 'search',
				mode: 'edit',
				lang: 'lg-nolan',
			},
			sqo: {
				section_tipo: [HOST],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: HOST, section_id: '1' }],
			},
		};
		const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
			ok?: boolean;
			data?: { context?: { tipo?: unknown; parent?: unknown; view?: unknown }[] };
		};
		expect(body.ok).not.toBe(false);
		const child = (body.data?.context ?? []).find(
			(entry) => entry.tipo === 'zzchv2' && entry.parent === 'zzchv5',
		);
		expect(child).toBeDefined();
		expect(child?.view).toBe('text');
	});
});
