/**
 * `dd_core_api.get_element_context` — one element's structure context
 * (plan item 4.2.7, comp 18, CRAP 329).
 *
 * WHY THIS FILE EXISTS. The handler is a DISCLOSURE door with two independent
 * authorization arms, and both were ungated:
 *
 *   1. the TOOL branch answers BEFORE any permission call, gated only by
 *      `getUserTools`. Delete that check and the endpoint hands the full tool
 *      context (labels, properties, developer, url) to any logged-in user.
 *   2. the ELEMENT branch checks `getPermissions(principal, sectionTipo, tipo)`
 *      where `sectionTipo = source.section_tipo ?? tipo`. That default is
 *      load-bearing: check the WRONG PAIR and a grant on one section
 *      authorises reading an element of another. The bug is INVISIBLE when both
 *      tipos are the same, so the fixture must grant on one and not the other —
 *      which is exactly what `test/helpers/acl_identity_fixture.ts` mints
 *      (non-admin: `test3` yes, `dd88` no; admin: both).
 *
 * ANTI-VACUITY. Every refusal here is paired with the identity that IS allowed
 * to do the same thing. A 403-everything handler, or one that error-envelopes
 * every call, fails this file. The first test re-asserts that the fixture's
 * contrast is non-degenerate, so a degraded fixture cannot turn the pairs into
 * zero-versus-zero.
 *
 * NO SCRATCH RECORDS. Every input is an installed ontology node (`test3`,
 * `dd88`, `dd151`) or a registered tool row; the handler is read-only and this
 * file writes nothing but the shared ACL fixture (swept by its own helper).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { coreApiActions } from '../../src/core/api/handlers/dd_core_api.ts';
import { getPermissions, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	createSession,
	getSession,
	setSessionLangs,
} from '../../src/core/security/session_store.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

/** The section the non-admin holds a read grant on. */
const GRANTED_SECTION = 'test3';
/**
 * dd88 (maintenance) — model `area_maintenance`, granted at 2 to the fixture
 * ADMIN and refused to the non-admin. It is also TRANSLATABLE, so its context
 * entry echoes the request lang: the handler's `source.lang` default (the
 * request data lang) is observable on the wire here. A TRANSLITERABLE
 * component (with_lang_versions / component_iri) defaults to its lg-nolan base
 * instead and keeps only an EXPLICIT lang — gated in
 * with_lang_versions_native.test.ts.
 */
const ADMIN_ONLY_AREA = 'dd88';
/** dd151 — a `relation_type` node: a real tipo the generic builder cannot build. */
const UNCOVERED_MODEL_TIPO = 'dd151';
/** Its model, which the 400 must NAME. */
const UNCOVERED_MODEL = 'relation_type';
/** A registered tool the fixture non-admin's profile does NOT grant. */
const RESTRICTED_TOOL = 'tool_export';
/** A registered `always_active` tool — authorized for BOTH identities. */
const ALWAYS_ACTIVE_TOOL = 'tool_user_admin';
/**
 * A data lang the session picks that is NOT the install default, so the
 * session lane and the install-default lane answer differently.
 */
const SESSION_DATA_LANG = config.menu.dataLang === 'lg-eng' ? 'lg-cat' : 'lg-eng';

function contextFor(userId: number, isGlobalAdmin: boolean, principal: unknown) {
	const token = createSession(userId, `zzcnt_${userId}`, isGlobalAdmin);
	const session = getSession(token);
	return {
		requestId: 'zzcnt',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

function elementRqo(source: Record<string, unknown>) {
	return { action: 'get_element_context', dd_api: 'dd_core_api', source };
}

/**
 * ENVELOPE v2 READERS (ported 2026-08-19). This file used to read the PHP-era
 * `body.result` / `body.msg`, which are GONE (ERRORS_SPEC §envelope v2:
 * `{ok, request_id, data}` on success, `{ok:false, error:{code,…}}` on
 * failure). Every one of those reads yielded `undefined`, and nobody noticed
 * because the whole describe was blocked by a throwing `installAclIdentityFixture`
 * — the file never ran a single assertion. Refusals are now pinned by CODE, not
 * by the human message: the message is the disclosure-ladder's public string,
 * the code is the contract.
 */
function entriesOf(body: Record<string, unknown>): Record<string, unknown>[] {
	return body.data as Record<string, unknown>[];
}
function errorCodeOf(body: Record<string, unknown>): string | undefined {
	return (body.error as { code?: string } | undefined)?.code;
}

describe.if(DB_READY)('dd_core_api.get_element_context', () => {
	let adminContext: unknown;
	let nonAdminContext: unknown;

	beforeAll(async () => {
		await installAclIdentityFixture();
		adminContext = contextFor(ACL_ADMIN_USER_ID, true, await resolvePrincipal(ACL_ADMIN_USER_ID));
		nonAdminContext = contextFor(
			ACL_NON_ADMIN_USER_ID,
			false,
			await resolvePrincipal(ACL_NON_ADMIN_USER_ID),
		);
	});

	afterAll(removeAclIdentityFixture);

	test('the contrast is live (guards every pair below)', async () => {
		const admin = await resolvePrincipal(ACL_ADMIN_USER_ID);
		const nonAdmin = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		expect(admin.isGlobalAdmin).toBe(true);
		expect(nonAdmin.isGlobalAdmin).toBe(false);
		// The non-admin reads test3 and NOT dd88; the admin reads both. Without
		// this split the wrong-pair case below is unobservable.
		expect(await getPermissions(nonAdmin, GRANTED_SECTION, GRANTED_SECTION)).toBeGreaterThanOrEqual(
			1,
		);
		expect(await getPermissions(nonAdmin, ADMIN_ONLY_AREA, ADMIN_ONLY_AREA)).toBe(0);
		expect(await getPermissions(admin, ADMIN_ONLY_AREA, ADMIN_ONLY_AREA)).toBeGreaterThanOrEqual(1);
	});

	describe('the tool branch', () => {
		test('an AUTHORIZED tool returns its context; the same tool is 403 for a user without it', async () => {
			// POSITIVE CONTROL FIRST — a handler that refuses everything must fail.
			const allowed = await dispatchRqo(
				elementRqo({ model: RESTRICTED_TOOL }) as never,
				adminContext as never,
			);
			expect(allowed.status).toBe(200);
			const [toolContext] = entriesOf(allowed.body);
			expect(toolContext).toBeDefined();
			expect(toolContext?.model).toBe(RESTRICTED_TOOL);
			expect(toolContext?.type).toBe('tool');

			const refused = await dispatchRqo(
				elementRqo({ model: RESTRICTED_TOOL }) as never,
				nonAdminContext as never,
			);
			expect(refused.status).toBe(403);
			expect(refused.body.ok).toBe(false);
			expect(errorCodeOf(refused.body)).toBe('tool.not_authorized');
		});

		test('the grant is asked of the PRINCIPAL: a session-less call is the 403, not a 500 (req 8, D8/L6)', async () => {
			// requirePrincipal guarantees a principal, never a session object. The
			// branch used to read `(context.session as Session).userId` and THROW a
			// TypeError (a 500) here; the one grant decision takes the principal.
			const handler = coreApiActions.get_element_context;
			if (handler === undefined) throw new Error('get_element_context is not registered');
			const nonAdmin = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			let code = 'served';
			try {
				await handler(
					elementRqo({ model: RESTRICTED_TOOL }) as never,
					{
						requestId: 'zzcnt',
						clientIp: '127.0.0.1',
						session: null,
						principal: nonAdmin,
					} as never,
				);
			} catch (error) {
				code = (error as { code?: string }).code ?? `untyped: ${String(error)}`;
			}
			expect(code).toBe('tool.not_authorized');
		});

		test('an always_active tool IS authorized for the non-admin (the check is per-tool, not per-role)', async () => {
			const result = await dispatchRqo(
				elementRqo({ model: ALWAYS_ACTIVE_TOOL }) as never,
				nonAdminContext as never,
			);
			expect(result.status).toBe(200);
			expect(entriesOf(result.body)[0]?.model).toBe(ALWAYS_ACTIVE_TOOL);
		});
	});

	describe('input contract', () => {
		test('a missing source.tipo is a named 400', async () => {
			const result = await dispatchRqo(elementRqo({}) as never, adminContext as never);
			expect(result.status).toBe(400);
			expect(result.body.ok).toBe(false);
			expect(errorCodeOf(result.body)).toBe('request.invalid_source');
		});

		test('an uncovered model is a 400 that NAMES the model (never a 500)', async () => {
			// ENVELOPE v2: the CODE is the contract; the model name survives on the
			// disclosure-gated `error.debug.exception`. The gate OPENS the ladder
			// itself (convert.ts reads the key live) — it used to borrow
			// DEDALO_DEBUG_API_ERRORS from the developer's .env and went red on a
			// machine without it. Asserted, so the naming half cannot go vacuous.
			const previousDebug = process.env.DEDALO_DEBUG_API_ERRORS;
			process.env.DEDALO_DEBUG_API_ERRORS = 'true';
			try {
				const result = await dispatchRqo(
					elementRqo({ tipo: UNCOVERED_MODEL_TIPO }) as never,
					adminContext as never,
				);
				expect(result.status).toBe(400);
				expect(errorCodeOf(result.body)).toBe('request.invalid_model');
				const debug = (result.body.error as { debug?: { exception?: string } }).debug;
				expect(debug?.exception).toBeDefined();
				expect(debug?.exception).toContain(
					`model '${UNCOVERED_MODEL}' not implemented (section/component/area only)`,
				);
			} finally {
				if (previousDebug === undefined)
					Reflect.deleteProperty(process.env, 'DEDALO_DEBUG_API_ERRORS');
				else process.env.DEDALO_DEBUG_API_ERRORS = previousDebug;
			}
		});
	});

	describe('the permission is checked on the (section_tipo, tipo) PAIR', () => {
		test('an omitted source.section_tipo defaults to the tipo — the grant on test3 authorises test3', async () => {
			const result = await dispatchRqo(
				elementRqo({ tipo: GRANTED_SECTION }) as never,
				nonAdminContext as never,
			);
			// Drop the `?? tipo` default and the pair becomes (undefined, test3):
			// a grant nobody holds, and this 200 turns into a 403.
			expect(result.status).toBe(200);
			const [entry] = entriesOf(result.body);
			expect(entry?.tipo).toBe(GRANTED_SECTION);
			expect(entry?.section_tipo).toBe(GRANTED_SECTION);
			// The resolved level rides on the entry — the grant is the fixture's 1.
			expect(entry?.permissions).toBe(1);
		});

		test('a SUPPLIED section_tipo is honoured: the test3 grant does NOT authorise (dd88, test3)', async () => {
			const result = await dispatchRqo(
				elementRqo({ tipo: GRANTED_SECTION, section_tipo: ADMIN_ONLY_AREA }) as never,
				nonAdminContext as never,
			);
			// Ignoring source.section_tipo (checking (tipo, tipo) instead) makes
			// this 200: a grant on one section reading an element of another.
			expect(result.status).toBe(403);
			expect(errorCodeOf(result.body)).toBe('perm.denied');
		});

		test('permission level 0 is 403 — and the identity holding the grant gets 200', async () => {
			const refused = await dispatchRqo(
				elementRqo({ tipo: ADMIN_ONLY_AREA }) as never,
				nonAdminContext as never,
			);
			expect(refused.status).toBe(403);
			expect(refused.body.ok).toBe(false);
			expect(errorCodeOf(refused.body)).toBe('perm.denied');

			const allowed = await dispatchRqo(
				elementRqo({ tipo: ADMIN_ONLY_AREA }) as never,
				adminContext as never,
			);
			expect(allowed.status).toBe(200);
			expect(entriesOf(allowed.body)[0]?.tipo).toBe(ADMIN_ONLY_AREA);
		});
	});

	test('source.lang defaults to the request data lang and an explicit lang overrides it', async () => {
		// dd88 is an AREA and translatable, so buildStructureContext stamps the
		// request lang verbatim instead of forcing lg-nolan. WC-2026-10-20-
		// element-context-default-lang: an omitted lang is the REQUEST's data lang
		// (session override → install default), never a literal — get_instance
		// builds a model-less component from this lang.
		const noOverride = await dispatchRqo(
			elementRqo({ tipo: ADMIN_ONLY_AREA }) as never,
			adminContext as never,
		);
		expect(noOverride.status).toBe(200);
		expect(entriesOf(noOverride.body)[0]?.lang).toBe(config.menu.dataLang);

		// The session's own data lang wins over the install default.
		const token = createSession(ACL_ADMIN_USER_ID, `zzcnt_lang_${ACL_ADMIN_USER_ID}`, true);
		setSessionLangs(token, { dataLang: SESSION_DATA_LANG });
		const session = getSession(token);
		expect(session?.dataLang).toBe(SESSION_DATA_LANG);
		const sessionContext = {
			...(adminContext as Record<string, unknown>),
			session,
			csrfCandidate: session?.csrfToken ?? null,
		};
		const fromSession = await dispatchRqo(
			elementRqo({ tipo: ADMIN_ONLY_AREA }) as never,
			sessionContext as never,
		);
		expect(entriesOf(fromSession.body)[0]?.lang).toBe(SESSION_DATA_LANG);

		const explicit = await dispatchRqo(
			elementRqo({ tipo: ADMIN_ONLY_AREA, lang: 'lg-fra' }) as never,
			sessionContext as never,
		);
		expect(entriesOf(explicit.body)[0]?.lang).toBe('lg-fra');
	});

	test('source.mode rides through to the built entry (default list)', async () => {
		const listMode = await dispatchRqo(
			elementRqo({ tipo: GRANTED_SECTION }) as never,
			nonAdminContext as never,
		);
		expect(entriesOf(listMode.body)[0]?.mode).toBe('list');
		const editMode = await dispatchRqo(
			elementRqo({ tipo: GRANTED_SECTION, mode: 'edit' }) as never,
			nonAdminContext as never,
		);
		expect(entriesOf(editMode.body)[0]?.mode).toBe('edit');
	});
});

/**
 * THE PRINCIPAL REACHES THE BUILDER (P1-3 / SEC-13). `get_element_context`
 * built its section context WITHOUT the principal, so `buildSectionButtons`
 * took the caller-cap path: any caller with level >= 2 on the section received
 * EVERY button, including the ones whose own grant is 0 — a delete button in
 * the list of a reader who may not delete. With the principal, each button is
 * gated by its own `getPermissions(section, button) >= 2`.
 *
 * PAIRED on the read-door fixture: two non-admins at level 2 on `test3`, the
 * READER at 0 on `test96` (button_delete) and 2 on `test126` (button_new), the
 * CONTROL at 2 on both. EXACT button sets, so a builder that emits none (or
 * all) reddens on one of the two.
 */
describe.if(DB_READY)('get_element_context — section buttons pass the per-button grant', () => {
	let fixture: typeof import('../helpers/read_door_identity_fixture.ts');

	beforeAll(async () => {
		fixture = await import('../helpers/read_door_identity_fixture.ts');
		await fixture.installReadDoorIdentityFixture();
	});
	afterAll(async () => {
		await fixture.removeReadDoorIdentityFixture();
	});

	async function buttonsFor(userId: number): Promise<string[]> {
		const principal = await resolvePrincipal(userId);
		expect(principal.isGlobalAdmin).toBe(false);
		const response = await dispatchRqo(
			elementRqo({ tipo: fixture.DOOR_SECTION, model: 'section', mode: 'list' }) as never,
			contextFor(userId, false, principal) as never,
		);
		expect(response.status).toBe(200);
		const [entry] = entriesOf(response.body as Record<string, unknown>);
		expect(entry).toBeDefined();
		return ((entry as { buttons?: { tipo: string }[] }).buttons ?? []).map((b) => b.tipo);
	}

	test('the contrast is live: both hold the section at 2; only the control holds button_delete', async () => {
		const reader = await resolvePrincipal(fixture.DOOR_READER_USER_ID);
		const control = await resolvePrincipal(fixture.DOOR_CONTROL_USER_ID);
		expect(await getPermissions(reader, fixture.DOOR_SECTION, fixture.DOOR_SECTION)).toBe(2);
		expect(await getPermissions(control, fixture.DOOR_SECTION, fixture.DOOR_SECTION)).toBe(2);
		expect(await getPermissions(reader, fixture.DOOR_SECTION, fixture.DOOR_BUTTON_DELETE)).toBe(0);
		expect(await getPermissions(control, fixture.DOOR_SECTION, fixture.DOOR_BUTTON_DELETE)).toBe(2);
	});

	test('the reader gets EXACTLY the buttons its profile grants; the control gets both', async () => {
		expect((await buttonsFor(fixture.DOOR_READER_USER_ID)).sort()).toEqual([
			fixture.DOOR_BUTTON_NEW,
		]);
		expect((await buttonsFor(fixture.DOOR_CONTROL_USER_ID)).sort()).toEqual(
			[fixture.DOOR_BUTTON_DELETE, fixture.DOOR_BUTTON_NEW].sort(),
		);
	});
});
