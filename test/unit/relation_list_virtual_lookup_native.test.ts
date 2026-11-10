/**
 * relation_list NODE LOOKUP — virtual→real inheritance + order (T0-7, O01/O12/OX8).
 *
 * ONE lookup finds a section's `relation_list` node: `findSectionChildByModel`
 * (section/list_definitions/node_find.ts) — own node first, else the REAL
 * section's (getSectionRealTipo), first by `order_number` (PHP
 * get_ar_children_of_this order). Its three relation_list consumers keep only
 * their post-step:
 *  - `getRelationListColumns` (resolve/relation_list.ts) — section_map scope
 *    first, else the node's relations → the References grid + related_search;
 *  - `sectionRelationListTipo` (section/buttons.ts) — the node tipo →
 *    section context `config.relation_list_tipo`;
 *  - `getRelatedListChildTipos` (resolve/relation_index.ts) — the node's
 *    relations → component_relation_index columns.
 * Before T0-7 the grid one had NO virtual fallback (every thesaurus instance,
 * rsc170, tch1… showed only the id column) and none of them ordered.
 *
 * OWNER DECISION D1 (2026-11-10): `exclude_elements` NEVER applies to
 * relation_list — it is the definition of what a CALLER section shows of
 * itself in the inspector (and the path diffusion follows inversely), not an
 * edit-form child. A virtual whose exclude_elements names the real
 * relation_list node still inherits it (zzrv33 pins this; PHP's generic
 * subtraction reaching it is incidental, a deliberate non-port).
 *
 * SITUATION (`zzrv`, matrix_test, ids 900851+, dropped with a residue-0 check):
 *   zzrv1  section HOST (relation_list zzrv2, empty)    — §900851
 *   zzrv3  REAL referencing section: zzrv4, zzrv5 input_text, zzrv7 portal →
 *          host, relation_list zzrv8 → [zzrv4, zzrv5]
 *   zzrv30 VIRTUAL of zzrv3, no children                — §900852 → host
 *   zzrv31 VIRTUAL of zzrv3 with OWN relation_list zzrv32 → [zzrv4]
 *   zzrv33 VIRTUAL of zzrv3, exclude_elements zzrv35 naming zzrv8
 *   zzrv34 REAL section with TWO relation_list nodes and TWO time_machine_list
 *          nodes; the order-2 one of each is INSERTED FIRST so an unordered
 *          read picks it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { buildRelatedSections } from '../../src/core/resolve/related_sections.ts';
import { getRelatedListChildTipos } from '../../src/core/resolve/relation_index.ts';
import { getRelationListColumns } from '../../src/core/resolve/relation_list.ts';
import { sectionRelationListTipo } from '../../src/core/section/buttons.ts';
import { findSectionChildByModel } from '../../src/core/section/list_definitions/node_find.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	residueOf,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const HOST_ID = 900851;
const VIRTUAL_REF_ID = 900852;
const hostLocator = { section_tipo: 'zzrv1', section_id: HOST_ID, type: 'dd571' };

const s = situation({
	tld: 'zzrv',
	name: 'relation_list virtual lookup',
	nodes: [
		// HOST
		{
			tipo: 'zzrv1',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Anfitrión' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: 'zzrv2',
			parent: 'zzrv1',
			model: 'relation_list',
			term: { 'lg-spa': 'relation_list' },
		},

		// REAL referencing section
		{
			tipo: 'zzrv3',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Real' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: 'zzrv4',
			parent: 'zzrv3',
			model: 'component_input_text',
			order_number: 1,
			term: { 'lg-spa': 'Cuatro' },
		},
		{
			tipo: 'zzrv5',
			parent: 'zzrv3',
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-spa': 'Cinco' },
		},
		{
			tipo: 'zzrv7',
			parent: 'zzrv3',
			model: 'component_portal',
			order_number: 3,
			term: { 'lg-spa': 'Portal al anfitrión' },
			relations: [{ tipo: 'zzrv1' }],
		},
		{
			tipo: 'zzrv8',
			parent: 'zzrv3',
			model: 'relation_list',
			order_number: 4,
			term: { 'lg-spa': 'relation_list' },
			relations: [{ tipo: 'zzrv4' }, { tipo: 'zzrv5' }],
		},

		// VIRTUAL, no own children → inherits zzrv8.
		{
			tipo: 'zzrv30',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Virtual' },
			relations: [{ tipo: 'zzrv3' }],
		},

		// VIRTUAL with its OWN relation_list → own wins.
		{
			tipo: 'zzrv31',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Virtual propio' },
			relations: [{ tipo: 'zzrv3' }],
		},
		{
			tipo: 'zzrv32',
			parent: 'zzrv31',
			model: 'relation_list',
			term: { 'lg-spa': 'relation_list' },
			relations: [{ tipo: 'zzrv4' }],
		},

		// VIRTUAL whose exclude_elements names the real relation_list (D1 pin).
		{
			tipo: 'zzrv33',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Virtual excluye' },
			relations: [{ tipo: 'zzrv3' }],
		},
		{
			tipo: 'zzrv35',
			parent: 'zzrv33',
			model: 'exclude_elements',
			term: { 'lg-spa': 'exclude_elements' },
			relations: [{ tipo: 'zzrv8' }],
		},

		// REAL section with two nodes per model; order-2 inserted FIRST.
		{
			tipo: 'zzrv34',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Dos listas' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: 'zzrv36',
			parent: 'zzrv34',
			model: 'relation_list',
			order_number: 2,
			term: { 'lg-spa': 'relation_list segunda' },
			relations: [{ tipo: 'zzrv4' }],
		},
		{
			tipo: 'zzrv37',
			parent: 'zzrv34',
			model: 'relation_list',
			order_number: 1,
			term: { 'lg-spa': 'relation_list primera' },
			relations: [{ tipo: 'zzrv5' }],
		},
		{
			tipo: 'zzrv38',
			parent: 'zzrv34',
			model: 'time_machine_list',
			order_number: 4,
			term: { 'lg-spa': 'time_machine_list segunda' },
		},
		{
			tipo: 'zzrv39',
			parent: 'zzrv34',
			model: 'time_machine_list',
			order_number: 3,
			term: { 'lg-spa': 'time_machine_list primera' },
		},
	],
	records: [
		{ section_tipo: 'zzrv1', section_id: HOST_ID, columns: { data: {} } },
		{
			section_tipo: 'zzrv30',
			section_id: VIRTUAL_REF_ID,
			columns: {
				string: {
					zzrv4: [{ lang: 'lg-nolan', value: 'Valor cuatro' }],
					zzrv5: [{ lang: 'lg-nolan', value: 'Valor cinco' }],
				},
				relation: { zzrv7: [hostLocator] },
			},
		},
	],
});

beforeAll(async () => {
	if (!DB_READY) return;
	// Fresh rows every run: the order case relies on the order-2 node being
	// the physically FIRST row, which an upsert over a stale row would not give.
	await dropSituation(s);
	await ensureSituation(s);
});

afterAll(async () => {
	if (!DB_READY) return;
	expect(await dropSituation(s)).toBe(0);
	expect(await residueOf(s)).toBe(0);
});

async function relationListGrid(): Promise<{
	context: Record<string, unknown>[];
	data: Record<string, unknown>[];
}> {
	const token = createSession(-1, 'relation_list_virtual_lookup_test', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	const result = await dispatchRqo(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'relation_list',
				tipo: 'zzrv2',
				section_tipo: 'zzrv1',
				section_id: HOST_ID,
				action: 'get_relation_list',
				mode: 'edit',
				lang: 'lg-spa',
			},
			sqo: {
				section_tipo: ['all'],
				mode: 'related',
				filter_by_locators: [{ section_tipo: 'zzrv1', section_id: HOST_ID }],
				limit: 10,
				offset: 0,
			},
		} as never,
		{
			requestId: 'relation_list_virtual_lookup_native',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	if (result.status !== 200) {
		throw new Error(`get_relation_list refused: ${JSON.stringify(result.body)}`);
	}
	return (
		result.body as { data: { context: Record<string, unknown>[]; data: Record<string, unknown>[] } }
	).data;
}

describe.if(DB_READY)('relation_list node lookup: virtual→real + order (T0-7)', () => {
	test('a virtual WITHOUT its own relation_list inherits the real one (columns, in order)', async () => {
		expect(await getRelationListColumns('zzrv30')).toEqual(['zzrv4', 'zzrv5']);
		expect(await sectionRelationListTipo('zzrv30')).toBe('zzrv8');
		expect(await getRelatedListChildTipos('zzrv30')).toEqual(['zzrv4', 'zzrv5']);
	});

	test('a virtual WITH its own relation_list keeps its own', async () => {
		expect(await getRelationListColumns('zzrv31')).toEqual(['zzrv4']);
		expect(await sectionRelationListTipo('zzrv31')).toBe('zzrv32');
		expect(await getRelatedListChildTipos('zzrv31')).toEqual(['zzrv4']);
	});

	test('D1: exclude_elements never removes the inherited relation_list', async () => {
		expect(await getRelationListColumns('zzrv33')).toEqual(['zzrv4', 'zzrv5']);
		expect(await sectionRelationListTipo('zzrv33')).toBe('zzrv8');
		expect(await getRelatedListChildTipos('zzrv33')).toEqual(['zzrv4', 'zzrv5']);
	});

	test('several relation_list nodes: the first by order_number wins', async () => {
		expect(await getRelationListColumns('zzrv34')).toEqual(['zzrv5']);
		expect(await sectionRelationListTipo('zzrv34')).toBe('zzrv37');
		expect(await getRelatedListChildTipos('zzrv34')).toEqual(['zzrv5']);
	});

	test('the order law reaches the other list-definition models too', async () => {
		expect((await findSectionChildByModel('zzrv34', 'time_machine_list'))?.tipo).toBe('zzrv39');
	});

	test('References grid (get_relation_list) shows the inherited columns for a virtual referrer', async () => {
		const grid = await relationListGrid();
		const columns = grid.context
			.filter((entry) => entry.section_tipo === 'zzrv30')
			.map((entry) => entry.component_tipo);
		expect(columns).toEqual(['id', 'zzrv4', 'zzrv5']);
		const values = grid.data
			.filter((cell) => cell.section_tipo === 'zzrv30' && cell.component_tipo !== 'id')
			.map((cell) => [cell.component_tipo, cell.value]);
		expect(values).toEqual([
			['zzrv4', 'Valor cuatro'],
			['zzrv5', 'Valor cinco'],
		]);
	});

	test('related_search shows the inherited columns for a virtual referrer', async () => {
		const related = await buildRelatedSections([{ section_tipo: 'zzrv1', section_id: HOST_ID }], {
			callerTipo: 'zzrv1',
			lang: 'lg-spa',
		});
		const columns = related.context
			.filter((entry) => entry.section_tipo === 'zzrv30' && entry.model !== 'section')
			.map((entry) => entry.tipo);
		expect(columns).toEqual(['zzrv4', 'zzrv5']);
		const values = related.data
			.filter((cell) => cell.section_tipo === 'zzrv30')
			.map((cell) => [cell.tipo, cell.value]);
		expect(values).toEqual([
			['zzrv4', ['Valor cuatro']],
			['zzrv5', ['Valor cinco']],
		]);
	});
});
