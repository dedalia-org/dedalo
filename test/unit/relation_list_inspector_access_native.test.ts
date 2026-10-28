/**
 * INSPECTOR RELATIONS for a NON-ADMIN — WC-2026-10-27-relation-list-grant-stamp.
 *
 * The owner report: a profile granting a section but not its relation_list node
 * saw the inspector Relations block; opening it was refused (read's Gate A asks
 * the (section, node) pair) while its paginator count was served. The node grant
 * stays (human decision #2): the section context now stamps
 * config.relation_list_tipo per principal, and count mode 'related' runs Gate A.
 *
 *   1. no node grant → stamp null, read get_relation_list 403, count 403;
 *   2. node granted → stamp = node, read 200, count 200, total == rows read (scoped);
 *   3. a VIRTUAL section borrowing the node: the grant keyed on the virtual tipo stamps;
 *   4. the superuser stamps; no principal → null (fail-closed);
 *   5. the node grant gates the PANEL (its stamp + its own requests), not the data: the
 *      delete dialog's shape (source.tipo = the section) is served on host read, rows scoped.
 *
 * Situation `zzrla` (scratch TLD, matrix_test via test24, torn down): host zzrla1
 * with relation_list zzrla3; zzrla10, a virtual section of zzrla1; zzrla20, a
 * project-gated section whose records point at the host (two in the reader's
 * project, one outside). Users/profiles minted at explicit ids and swept.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const HOST_SECTION = 'zzrla1';
const HOST_TEXT = 'zzrla2';
const HOST_RELATION_LIST = 'zzrla3';
const VIRTUAL_SECTION = 'zzrla10';
const REF_SECTION = 'zzrla20';
const REF_PORTAL = 'zzrla21';
const REF_TEXT = 'zzrla22';
const REF_FILTER = 'zzrla23';
const REF_RELATION_LIST = 'zzrla24';
const HOST_ID = 1;
const IN_PROJECT_ID = 958823;
const OUT_PROJECT_ID = 958824;
/** zzrla20 referrers of the host: visible = in the reader's project. */
const REFS = [
	{ id: 1, visible: true },
	{ id: 2, visible: false },
	{ id: 3, visible: true },
];
const GRANTED_USER_ID = 958803;
const UNGRANTED_USER_ID = 958804;
const GRANTED_PROFILE_ID = 958813;
const UNGRANTED_PROFILE_ID = 958814;
/** TEST-NET-3: the LOAD activity rows this file's reads write are swept by it. */
const CLIENT_IP = '203.0.113.90';

const marker = (id: number) => `ZZRLA_${id}`;
const MARKER_RE = /ZZRLA_\d+/g;

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

const SITUATION = situation({
	name: 'inspector relation_list access',
	tld: 'zzrla',
	nodes: [
		{
			tipo: HOST_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'zzrla host' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: HOST_TEXT, parent: HOST_SECTION, model: 'component_input_text', order_number: 1 },
		{
			tipo: HOST_RELATION_LIST,
			parent: HOST_SECTION,
			model: 'relation_list',
			order_number: 2,
			term: { 'lg-eng': 'References' },
		},
		{
			tipo: VIRTUAL_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'zzrla virtual' },
			relations: [{ tipo: HOST_SECTION }],
		},
		{
			tipo: REF_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'zzrla refs' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: REF_TEXT, parent: REF_SECTION, model: 'component_input_text', order_number: 1 },
		{
			tipo: REF_PORTAL,
			parent: REF_SECTION,
			model: 'component_portal',
			order_number: 2,
			relations: [{ tipo: HOST_SECTION }],
		},
		{
			tipo: REF_FILTER,
			parent: REF_SECTION,
			model: 'component_filter',
			order_number: 3,
			term: { 'lg-eng': 'Projects' },
			relations: [{ tipo: 'dd153' }],
		},
		{
			tipo: REF_RELATION_LIST,
			parent: REF_SECTION,
			model: 'relation_list',
			order_number: 4,
			relations: [{ tipo: REF_TEXT }],
		},
	],
	records: [
		{ section_tipo: HOST_SECTION, section_id: HOST_ID, columns: { data: {} } },
		...REFS.map(({ id, visible }) => ({
			section_tipo: REF_SECTION,
			section_id: id,
			columns: {
				string: { [REF_TEXT]: [{ id: 1, lang: 'lg-nolan', value: marker(id) }] },
				relation: {
					[REF_PORTAL]: [locator(REF_PORTAL, HOST_SECTION, HOST_ID)],
					[REF_FILTER]: [locator(REF_FILTER, 'dd153', visible ? IN_PROJECT_ID : OUT_PROJECT_ID)],
				},
			},
		})),
	],
});

const grant = (id: number, sectionTipo: string, tipo: string) => ({
	id,
	tipo,
	section_tipo: sectionTipo,
	value: 1,
});

/** Everything the reader needs EXCEPT the relation_list node. */
const BASE_GRANTS = [
	grant(1, HOST_SECTION, HOST_SECTION),
	grant(2, HOST_SECTION, HOST_TEXT),
	grant(3, VIRTUAL_SECTION, VIRTUAL_SECTION),
	grant(4, REF_SECTION, REF_SECTION),
	grant(5, REF_SECTION, REF_TEXT),
];
const NODE_GRANTS = [
	grant(6, HOST_SECTION, HOST_RELATION_LIST),
	// keyed on the VIRTUAL section: (zzrla10, the borrowed zzrla3)
	grant(7, VIRTUAL_SECTION, HOST_RELATION_LIST),
];

async function insertRow(table: string, sectionTipo: string, sectionId: number, columns: object) {
	const entries = Object.entries(columns);
	const names = entries.map(([name]) => `"${name}"`).join(', ');
	const values = entries.map((_, index) => `$${index + 3}::text::jsonb`).join(', ');
	await sql.unsafe(
		`INSERT INTO "${table}" (section_tipo, section_id, ${names}) VALUES ($1, $2, ${values})`,
		[sectionTipo, sectionId, ...entries.map(([, value]) => encodeForJsonb(value))],
	);
}

async function mintUser(userId: number, profileId: number, grants: object[]) {
	await insertRow('matrix_profiles', 'dd234', profileId, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zzrla profile ${profileId}` }] },
		misc: { dd774: grants },
	});
	await insertRow('matrix_users', 'dd128', userId, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `zzrla_${userId}` }] },
		relation: {
			dd131: [locator('dd131', 'dd64', 1)],
			dd244: [locator('dd244', 'dd64', 2)],
			dd515: [locator('dd515', 'dd64', 2)],
			dd1725: [locator('dd1725', 'dd234', profileId)],
			dd170: [locator('dd170', 'dd153', IN_PROJECT_ID)],
		},
	});
}

function clearSecurityCaches() {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	clearUserFilterRecordsCache();
}

async function sweep() {
	await assertTestDatabase('relation_list_inspector_access_native sweep');
	for (const [userId, profileId] of [
		[GRANTED_USER_ID, GRANTED_PROFILE_ID],
		[UNGRANTED_USER_ID, UNGRANTED_PROFILE_ID],
	] as const) {
		await deleteMatrixRecord('matrix_users', 'dd128', userId);
		await deleteMatrixRecord('matrix_profiles', 'dd234', profileId);
	}
	await sql.unsafe("DELETE FROM matrix_activity WHERE string->'dd544'->0->>'value' = $1", [
		CLIENT_IP,
	]);
	clearSecurityCaches();
}

async function contextFor(userId: number) {
	const session = getSession(createSession(userId, `zzrla_${userId}`, userId === -1));
	return {
		requestId: 'relation_list_inspector_access',
		clientIp: CLIENT_IP,
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(userId),
	};
}

/** The panel's source, exactly as relation_list.js sends it (read + count). */
const source = {
	section_tipo: HOST_SECTION,
	section_id: HOST_ID,
	tipo: HOST_RELATION_LIST,
	mode: 'edit',
	model: 'relation_list',
	action: 'get_relation_list',
};
const filterByLocators = [{ section_tipo: HOST_SECTION, section_id: HOST_ID }];

async function readPanel(userId: number, src: Record<string, unknown> = source) {
	return dispatchRqo(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			source: src,
			sqo: {
				section_tipo: ['all'],
				mode: 'related',
				limit: 10,
				offset: 0,
				filter_by_locators: filterByLocators,
			},
		} as never,
		(await contextFor(userId)) as never,
	);
}

async function countPanel(userId: number, src: Record<string, unknown> = source) {
	return dispatchRqo(
		{
			action: 'count',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: src,
			sqo: { section_tipo: ['all'], mode: 'related', filter_by_locators: filterByLocators },
		} as never,
		(await contextFor(userId)) as never,
	);
}

const codeOf = (body: Record<string, unknown>) =>
	(body.error as { code?: string } | undefined)?.code ?? null;

async function stamped(principal: Principal | undefined, sectionTipo: string): Promise<unknown> {
	const entry = await buildStructureContext({
		tipo: sectionTipo,
		sectionTipo,
		mode: 'edit',
		lang: 'lg-eng',
		permissions: 1,
		principal,
	} as never);
	return (entry as { config?: { relation_list_tipo?: unknown } }).config?.relation_list_tipo;
}

describe.if(DB_READY)('inspector Relations: the trigger is stamped per principal', () => {
	let admin: Principal;
	let granted: Principal;
	let ungranted: Principal;

	beforeAll(async () => {
		await assertTestDatabase('relation_list_inspector_access_native');
		await sweep();
		await ensureSituation(SITUATION);
		await mintUser(GRANTED_USER_ID, GRANTED_PROFILE_ID, [...BASE_GRANTS, ...NODE_GRANTS]);
		await mintUser(UNGRANTED_USER_ID, UNGRANTED_PROFILE_ID, BASE_GRANTS);
		clearSecurityCaches();
		admin = await resolvePrincipal(-1);
		granted = await resolvePrincipal(GRANTED_USER_ID);
		ungranted = await resolvePrincipal(UNGRANTED_USER_ID);
	});

	afterAll(async () => {
		await sweep();
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('no node grant: stamp null, read 403, count 403 (read and count decide alike)', async () => {
		expect(ungranted.isGlobalAdmin).toBe(false);
		expect(await stamped(ungranted, HOST_SECTION)).toBeNull();
		const read = await readPanel(UNGRANTED_USER_ID);
		const count = await countPanel(UNGRANTED_USER_ID);
		expect({
			read: [read.status, codeOf(read.body)],
			count: [count.status, codeOf(count.body)],
		}).toEqual({ read: [403, 'perm.denied'], count: [403, 'perm.denied'] });
	});

	test('no node grant: the delete dialog shape (tipo = section) is served, rows scoped', async () => {
		// the node grant is the panel's offer, not a data boundary: rowScopeFor already scopes rows
		const dialog = { ...source, tipo: HOST_SECTION };
		const read = await readPanel(UNGRANTED_USER_ID, dialog);
		const count = await countPanel(UNGRANTED_USER_ID, dialog);
		expect([read.status, count.status]).toEqual([200, 200]);
		expect((count.body.data as { total?: number }).total).toBe(
			((await countPanel(GRANTED_USER_ID)).body.data as { total?: number }).total,
		);
	});

	test('node granted: stamp the node, read 200, count 200 == the scoped rows read', async () => {
		expect(granted.isGlobalAdmin).toBe(false);
		expect(await stamped(granted, HOST_SECTION)).toBe(HOST_RELATION_LIST);
		const read = await readPanel(GRANTED_USER_ID);
		const count = await countPanel(GRANTED_USER_ID);
		expect([read.status, codeOf(read.body), count.status, codeOf(count.body)]).toEqual([
			200,
			null,
			200,
			null,
		]);
		const rows = [...new Set(JSON.stringify(read.body.data ?? null).match(MARKER_RE) ?? [])].sort();
		const visible = REFS.filter((ref) => ref.visible).map((ref) => marker(ref.id));
		expect(rows).toEqual(visible.sort());
		expect((count.body.data as { total: number }).total).toBe(rows.length);
	});

	test('the superuser sees every referrer (the scope contrast is live)', async () => {
		const count = await countPanel(-1);
		expect(count.status).toBe(200);
		expect((count.body.data as { total: number }).total).toBe(REFS.length);
	});

	test('a virtual section: the grant keyed on the virtual tipo stamps the borrowed node', async () => {
		expect({
			granted: await stamped(granted, VIRTUAL_SECTION),
			ungranted: await stamped(ungranted, VIRTUAL_SECTION),
		}).toEqual({ granted: HOST_RELATION_LIST, ungranted: null });
	});

	test('the superuser stamps; no principal stamps null (fail-closed)', async () => {
		expect({
			admin: await stamped(admin, HOST_SECTION),
			none: await stamped(undefined, HOST_SECTION),
		}).toEqual({ admin: HOST_RELATION_LIST, none: null });
	});
});
