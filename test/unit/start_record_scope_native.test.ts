/**
 * THE PAGE DOOR HOLDS THE RECORD SCOPE — WC-2026-10-27-start-deep-link-record-scope.
 *
 * The feature crawl: a project-scoped editor opening an out-of-project record
 * by URL (`?tipo=S&id=N`) got `start` 200 — the door checked the section grant
 * only — then an empty edit form whose inspector queried a null record. `start`
 * now asks principalCanAccessRecord for a SECTION deep link to an id >= 1, and
 * refuses with the page refusal (403 perm.denied + environment):
 *
 *   1. out-of-project record → 403 perm.denied, environment, nothing about the record;
 *   2. a missing id → the SAME status, code, message and body shape (no existence oracle);
 *   3. an in-scope record → 200, context section_id stamped;
 *   4. a record the persona just created → 200 (born in their project);
 *   5. the superuser on the out-of-project record → 200 (non-vacuity: it exists);
 *   6. a COMPONENT deep link to the record is gated the same way
 *      (WC-2026-10-28-start-component-deep-link-record-scope); id 0 stays untouched.
 *
 * Situation `zzsrs` (scratch TLD, torn down): section zzsrs1, project-gated by
 * component_filter zzsrs3, one record in the persona's project and one outside.
 * The persona (user + profile at explicit ids) is minted and swept.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
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

const SECTION = 'zzsrs1';
const TEXT = 'zzsrs2';
const FILTER = 'zzsrs3';
const IN_SCOPE_ID = 1;
const OUT_OF_SCOPE_ID = 2;
/** Never created: the no-oracle leg. */
const MISSING_ID = 987654;
const IN_PROJECT_ID = 958821;
const OUT_PROJECT_ID = 958822;
const USER_ID = 958801;
const PROFILE_ID = 958811;
/** TEST-NET-3: the activity rows this file's doors write are swept by it. */
const CLIENT_IP = '203.0.113.89';

const scopedRecord = (sectionId: number, projectId: number) => ({
	section_tipo: SECTION,
	section_id: sectionId,
	columns: {
		string: { [TEXT]: [{ id: 1, lang: 'lg-nolan', value: `ZZSRS_VALUE_${sectionId}` }] },
		relation: {
			[FILTER]: [
				{
					id: 1,
					type: 'dd151',
					section_tipo: 'dd153',
					section_id: projectId,
					from_component_tipo: FILTER,
				},
			],
		},
	},
});

const SITUATION = situation({
	name: 'start deep-link record scope',
	tld: 'zzsrs',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'zzsrs scoped' } },
		{ tipo: TEXT, parent: SECTION, model: 'component_input_text', order_number: 1 },
		{
			tipo: FILTER,
			parent: SECTION,
			model: 'component_filter',
			order_number: 2,
			term: { 'lg-eng': 'Projects' },
			relations: [{ tipo: 'dd153' }],
		},
	],
	records: [
		scopedRecord(IN_SCOPE_ID, IN_PROJECT_ID),
		scopedRecord(OUT_OF_SCOPE_ID, OUT_PROJECT_ID),
	],
});

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

async function insertRow(table: string, sectionTipo: string, sectionId: number, columns: object) {
	const entries = Object.entries(columns);
	const names = entries.map(([name]) => `"${name}"`).join(', ');
	const values = entries.map((_, index) => `$${index + 3}::text::jsonb`).join(', ');
	await sql.unsafe(
		`INSERT INTO "${table}" (section_tipo, section_id, ${names}) VALUES ($1, $2, ${values})`,
		[sectionTipo, sectionId, ...entries.map(([, value]) => encodeForJsonb(value))],
	);
}

function clearSecurityCaches() {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function sweep() {
	await assertTestDatabase('start_record_scope_native sweep');
	await deleteMatrixRecord('matrix_users', 'dd128', USER_ID);
	await deleteMatrixRecord('matrix_profiles', 'dd234', PROFILE_ID);
	await sql.unsafe("DELETE FROM matrix_activity WHERE string->'dd544'->0->>'value' = $1", [
		CLIENT_IP,
	]);
	clearSecurityCaches();
}

async function contextFor(userId: number, isGlobalAdmin: boolean) {
	const session = getSession(createSession(userId, `zzsrs_${userId}`, isGlobalAdmin));
	return {
		requestId: 'start_record_scope',
		clientIp: CLIENT_IP,
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(userId),
	};
}

const startRqo = (searchObj: Record<string, string>) => ({
	action: 'start',
	dd_api: 'dd_core_api',
	options: { search_obj: searchObj, menu: false },
});

async function start(userId: number, searchObj: Record<string, string>) {
	return dispatchRqo(
		startRqo(searchObj) as never,
		(await contextFor(userId, userId === -1)) as never,
	);
}

const codeOf = (body: Record<string, unknown>) =>
	(body.error as { code?: string } | undefined)?.code;

function sectionContextOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
	return ((body.data as { context?: Record<string, unknown>[] } | undefined)?.context ?? []).find(
		(entry) => entry.tipo === SECTION,
	);
}

describe.if(DB_READY)('start: a section deep link is record-scope gated', () => {
	beforeAll(async () => {
		await assertTestDatabase('start_record_scope_native');
		await sweep();
		await ensureSituation(SITUATION);
		await insertRow('matrix_profiles', 'dd234', PROFILE_ID, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzsrs profile' }] },
			misc: {
				dd774: [
					{ id: 1, tipo: SECTION, section_tipo: SECTION, value: 2 },
					{ id: 2, tipo: TEXT, section_tipo: SECTION, value: 2 },
				],
			},
		});
		await insertRow('matrix_users', 'dd128', USER_ID, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `zzsrs_${USER_ID}` }] },
			relation: {
				dd131: [locator('dd131', 'dd64', 1)],
				dd244: [locator('dd244', 'dd64', 2)],
				dd515: [locator('dd515', 'dd64', 2)],
				dd1725: [locator('dd1725', 'dd234', PROFILE_ID)],
				dd170: [locator('dd170', 'dd153', IN_PROJECT_ID)],
			},
		});
		clearSecurityCaches();
	});

	afterAll(async () => {
		await sweep();
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('the persona is a non-admin holding the section', async () => {
		const principal = await resolvePrincipal(USER_ID);
		expect(principal.isGlobalAdmin).toBe(false);
	});

	test('an out-of-project record → 403 perm.denied + environment, nothing about the record', async () => {
		const refused = await start(USER_ID, { tipo: SECTION, id: String(OUT_OF_SCOPE_ID) });
		expect({ status: refused.status, code: codeOf(refused.body) }).toEqual({
			status: 403,
			code: 'perm.denied',
		});
		const environment = (refused.body as { environment?: { result?: { get_label?: object } } })
			.environment;
		expect(environment?.result?.get_label).toBeDefined();
		expect('data' in refused.body).toBe(false);
		const text = JSON.stringify(refused.body);
		expect(text).not.toContain(SECTION);
		expect(refused.body.error as object).not.toHaveProperty('coordinates');
	});

	test('a missing id answers the same status, code, message and shape (no existence oracle)', async () => {
		const shape = async (id: number) => {
			const answer = await start(USER_ID, { tipo: SECTION, id: String(id) });
			const error = answer.body.error as Record<string, unknown>;
			return {
				status: answer.status,
				keys: Object.keys(answer.body)
					.filter((key) => key !== 'request_id')
					.sort(),
				error: { ...error, request_id: undefined },
			};
		};
		const outOfScope = await shape(OUT_OF_SCOPE_ID);
		expect(outOfScope.status).toBe(403);
		expect(await shape(MISSING_ID)).toEqual(outOfScope);
	});

	test('an in-scope record → 200 with the section_id stamped', async () => {
		const allowed = await start(USER_ID, { tipo: SECTION, id: String(IN_SCOPE_ID) });
		expect(allowed.status).toBe(200);
		expect(sectionContextOf(allowed.body)?.section_id).toBe(IN_SCOPE_ID);
	});

	test('a record the persona just created → 200', async () => {
		const context = await contextFor(USER_ID, false);
		const created = await dispatchRqo(
			{
				action: 'create',
				dd_api: 'dd_core_api',
				source: { section_tipo: SECTION, tipo: SECTION, model: 'section' },
			} as never,
			context as never,
		);
		expect({ status: created.status, code: codeOf(created.body) ?? null }).toEqual({
			status: 200,
			code: null,
		});
		const newId = Number(created.body.data);
		expect(newId).toBeGreaterThan(OUT_OF_SCOPE_ID);
		const allowed = await start(USER_ID, { tipo: SECTION, id: String(newId) });
		expect(allowed.status).toBe(200);
	});

	test('the superuser opens the out-of-project record (it exists: the refusal is scope)', async () => {
		const allowed = await start(-1, { tipo: SECTION, id: String(OUT_OF_SCOPE_ID) });
		expect(allowed.status).toBe(200);
		expect(sectionContextOf(allowed.body)?.section_id).toBe(OUT_OF_SCOPE_ID);
	});

	test('the component data read behind such a link never carries the out-of-project value', async () => {
		const read = async (userId: number, sectionId: number) =>
			dispatchRqo(
				{
					action: 'read',
					dd_api: 'dd_core_api',
					source: {
						action: 'get_data',
						model: 'component_input_text',
						tipo: TEXT,
						section_tipo: SECTION,
						section_id: sectionId,
						mode: 'edit',
						lang: 'lg-nolan',
					},
				} as never,
				(await contextFor(userId, userId === -1)) as never,
			);
		const value = (sectionId: number) => `ZZSRS_VALUE_${sectionId}`;
		const editor = JSON.stringify((await read(USER_ID, OUT_OF_SCOPE_ID)).body);
		const own = JSON.stringify((await read(USER_ID, IN_SCOPE_ID)).body);
		const superuser = JSON.stringify((await read(-1, OUT_OF_SCOPE_ID)).body);
		expect(editor).not.toContain(value(OUT_OF_SCOPE_ID));
		expect(own).toContain(value(IN_SCOPE_ID)); // non-vacuity: the read shape returns values
		expect(superuser).toContain(value(OUT_OF_SCOPE_ID));
	});

	test('NO source.tipo is no bypass: read is refused as invalid, count is scoped and refused on an ungranted section', async () => {
		const ask = async (action: 'read' | 'count', userId: number, sectionTipo: string) =>
			dispatchRqo(
				{
					action,
					dd_api: 'dd_core_api',
					source: { section_tipo: sectionTipo, mode: 'list', model: 'section' },
					sqo: { section_tipo: [sectionTipo], limit: 10, offset: 0 },
				} as never,
				(await contextFor(userId, userId === -1)) as never,
			);
		const read = await ask('read', USER_ID, SECTION);
		expect([read.status, codeOf(read.body)]).toEqual([400, 'request.invalid_source']);
		expect(JSON.stringify(read.body)).not.toContain('ZZSRS_VALUE_');
		const count = await ask('count', USER_ID, SECTION);
		expect(count.status).toBe(200);
		expect((count.body.data as { total: number }).total).toBe(
			((await ask('count', -1, SECTION)).body.data as { total: number }).total - 1,
		);
		// a section the persona holds no grant on: refused without naming a component
		const ungranted = await ask('count', USER_ID, 'dd88');
		expect([ungranted.status, codeOf(ungranted.body)]).toEqual([403, 'perm.denied']);
	});

	test('untouched by the check: id 0', async () => {
		const zero = await start(USER_ID, { tipo: SECTION, id: '0' });
		expect(zero.status).toBe(200);
	});

	test('a COMPONENT deep link is gated alike: out-of-project and missing → the same 403, in-scope → 200', async () => {
		const component = async (id: number) => {
			const answer = await start(USER_ID, { tipo: TEXT, section_tipo: SECTION, id: String(id) });
			const error = answer.body.error as Record<string, unknown> | undefined;
			return {
				status: answer.status,
				error: error ? ({ ...error, request_id: undefined } as Record<string, unknown>) : null,
			};
		};
		const outOfScope = await component(OUT_OF_SCOPE_ID);
		expect([outOfScope.status, outOfScope.error?.code]).toEqual([403, 'perm.denied']);
		expect(await component(MISSING_ID)).toEqual(outOfScope);
		expect((await component(IN_SCOPE_ID)).status).toBe(200);
		// non-vacuity: the record exists and the superuser opens the same link
		const superuser = await start(-1, {
			tipo: TEXT,
			section_tipo: SECTION,
			id: String(OUT_OF_SCOPE_ID),
		});
		expect(superuser.status).toBe(200);
	});
});
