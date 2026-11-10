/**
 * SECURITY_ACCESS SAVE ECHO — the dd774 scalar save echo carries the value and
 * the parent locator, NOT the edit-read datalist nor changes_files
 * (WC-2026-11-09-security-access-save-echo-no-datalist).
 *
 * WHY. The save handler runs the model emit hook on the echo; with the full ACL
 * tree (~6.5 MB) attached the answer outgrew the idempotency replay cap, so a
 * client retry of a committed save got `idempotency.replay_unavailable` — a
 * false save error. The hook now sees `door: 'save_echo'` and skips the
 * datalist; the edit read (contrast half below) still attaches it, so this gate
 * cannot pass by the datalist vanishing everywhere.
 *
 * Situation: the acl_identity_fixture scratch dd234 profile (930011, own
 * misc.dd774), installed + swept here; saved through the real dispatch door.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo, IDEMPOTENCY_MAX_BODY_BYTES } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	ACL_ADMIN_PROFILE_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const SECTION = 'dd234';
const TIPO = 'dd774';
const MODEL = 'component_security_access';
const LANG = 'lg-nolan';
const SAVED = [{ id: 1, tipo: 'test3', section_tipo: 'test3', value: 2 }];

type Item = Record<string, unknown> & { tipo?: string };
let tsContext: Record<string, unknown>;

function echoItem(body: unknown): Item {
	const items = (body as { data?: { data?: Item[] } }).data?.data ?? [];
	const found = items.find((item) => item.tipo === TIPO);
	if (found === undefined) throw new Error(`no ${TIPO} item in the response`);
	return found;
}

function source(extra: Record<string, unknown> = {}) {
	return {
		model: MODEL,
		tipo: TIPO,
		section_tipo: SECTION,
		section_id: ACL_ADMIN_PROFILE_ID,
		mode: 'edit',
		lang: LANG,
		...extra,
	};
}

beforeAll(async () => {
	await installAclIdentityFixture();
	const token = createSession(-1, 'root', true);
	const session = getSession(token) as Record<string, unknown> | null;
	tsContext = {
		requestId: 'security_access_save_echo_native',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
});

afterAll(async () => {
	// The fixture sweep removes the record + its TM rows; the save's dd542 activity row is ours.
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		   AND misc->'dd551'->0->'value'->>'section_id' = $2`,
		[SECTION, String(ACL_ADMIN_PROFILE_ID)],
	);
	await removeAclIdentityFixture();
});

describe('dd774 save echo', () => {
	test('the edit read carries the datalist (contrast: the echo omission is not vacuous)', async () => {
		const response = await dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: source({ action: 'get_data' }),
			} as unknown as Rqo,
			tsContext as never,
		);
		expect(response.status).toBe(200);
		const item = echoItem(response.body);
		expect(Array.isArray(item.datalist)).toBe(true);
		expect((item.datalist as unknown[]).length).toBeGreaterThan(0);
		expect(item.changes_files).toEqual([]);
	}, 60_000);

	test('the save echo has value + parent locator, no datalist / changes_files, fits the replay cap', async () => {
		const response = await dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: source(),
				data: { entries: [], changed_data: [{ action: 'set_data', value: SAVED }] },
			} as unknown as Rqo,
			tsContext as never,
		);
		expect(response.status).toBe(200);
		const echo = echoItem(response.body);
		expect(echo.datalist).toBeUndefined();
		expect(echo.changes_files).toBeUndefined();
		expect(echo.parent_tipo).toBe(TIPO);
		expect(String(echo.parent_section_id)).toBe(String(ACL_ADMIN_PROFILE_ID));
		expect(echo.entries).toEqual(SAVED);
		expect(JSON.stringify(response.body).length).toBeLessThan(IDEMPOTENCY_MAX_BODY_BYTES);
	}, 60_000);
});
