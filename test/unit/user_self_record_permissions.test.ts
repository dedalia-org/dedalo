/**
 * dd128 OWN-USER-RECORD permission rules (PHP component_common::
 * resolve_component_read_permission, class.component_common.php:3547-3577).
 *
 * PHP evaluates these in NON-SEARCH mode on the actor's OWN user record and both
 * UPGRADES and DOWNGRADES the matrix level:
 *
 *   dd244 security-administrator          -> 1  (always, even for a global admin)
 *   dd1725/dd515/dd132/dd330              -> 1  (non-global-admins: anti self-elevation)
 *                                            >= 1 (global admin: matrix, floored at READ —
 *                                                  TODO-071, tool_user_admin's read-only rows)
 *   dd452/dd134/dd133/dd522/dd1206        -> 2  (editable self-data, used by tool_user_admin)
 *
 * The TS port shipped only the SEARCH-mode branch, so both halves were missing:
 * an ordinary user could not edit their own password/email/name (the tool's whole
 * purpose), and a user holding a dd128 write grant could set their OWN profile
 * assignment or developer flag through the generic save API.
 *
 * The rules are a WRITE gate, not only a display stamp — dd_core_api::save must
 * consult them too, which is what the end-to-end save block below pins. And the
 * READ doors must consult them as well (read Gate A + the get_data facade gate):
 * up to 7.0.0-beta.7 they did not, so tool_user_admin answered perm.denied for
 * every user without a dd128 grant — pinned by the end-to-end read block.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). The tipos are
// identifiers threaded through the unit under test — a generic `test` section carries
// the same meaning here as the install one did.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { clearDatalistCache, getDatalist } from '../../src/core/relations/datalist.ts';
import {
	getPermissions,
	getRecordComponentPermission,
	type Principal,
	resolveComponentContextPermission,
	resolveOwnUserRecordPermission,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	installOntologyAreaAccessFixture,
	OA_GRANT_PROFILE_ID,
	OA_GRANTED_ADMIN_ID,
	OA_GRANTED_NON_ADMIN_ID,
	removeOntologyAreaAccessFixture,
} from '../helpers/ontology_area_access_fixture.ts';

const USERS = 'dd128';
const SECURITY_ADMIN = 'dd244';
const GUARDED = ['dd1725', 'dd515', 'dd132', 'dd330'] as const; // profile/developer/username/section_id
const SELF_EDITABLE = ['dd452', 'dd134', 'dd133', 'dd522', 'dd1206'] as const; // name/email/password/image/UI preferences

function principal(userId: number, isGlobalAdmin: boolean): Principal {
	return { userId, isGlobalAdmin, isDeveloper: false };
}

describe('resolveOwnUserRecordPermission — the PHP dd128 table', () => {
	test('dd244 is forced to READ on your own record, global admin included', () => {
		expect(resolveOwnUserRecordPermission(principal(7, false), USERS, SECURITY_ADMIN, 7)).toBe(1);
		expect(resolveOwnUserRecordPermission(principal(7, true), USERS, SECURITY_ADMIN, 7)).toBe(1);
	});

	test('profile/developer/username/section_id are forced to READ for a non-global-admin', () => {
		for (const tipo of GUARDED) {
			expect(resolveOwnUserRecordPermission(principal(7, false), USERS, tipo, 7)).toBe(1);
		}
	});

	test('a GLOBAL ADMIN keeps the matrix level on those four (PHP exempts them)', () => {
		for (const tipo of GUARDED) {
			expect(resolveOwnUserRecordPermission(principal(7, true), USERS, tipo, 7)).toBeNull();
		}
	});

	test('name/email/password/image are forced to WRITE on your own record', () => {
		for (const tipo of SELF_EDITABLE) {
			expect(resolveOwnUserRecordPermission(principal(7, false), USERS, tipo, 7)).toBe(2);
			expect(resolveOwnUserRecordPermission(principal(7, true), USERS, tipo, 7)).toBe(2);
		}
	});

	test('ANOTHER user record is untouched — no upgrade, no downgrade', () => {
		for (const tipo of [SECURITY_ADMIN, ...GUARDED, ...SELF_EDITABLE]) {
			expect(resolveOwnUserRecordPermission(principal(7, false), USERS, tipo, 8)).toBeNull();
		}
	});

	test('a non-dd128 section is untouched', () => {
		expect(resolveOwnUserRecordPermission(principal(7, false), 'test3', 'dd133', 7)).toBeNull();
	});

	test('an absent section_id is untouched (PHP $section_id !== null)', () => {
		expect(resolveOwnUserRecordPermission(principal(7, false), USERS, 'dd133', null)).toBeNull();
		expect(
			resolveOwnUserRecordPermission(principal(7, false), USERS, 'dd133', undefined),
		).toBeNull();
	});

	test('user id 0 is skipped — PHP guards the branch with !empty($user_id)', () => {
		expect(resolveOwnUserRecordPermission(principal(0, false), USERS, 'dd133', 0)).toBeNull();
		expect(
			resolveOwnUserRecordPermission(principal(0, false), USERS, SECURITY_ADMIN, 0),
		).toBeNull();
	});

	test('a string section_id from the wire still matches its own record', () => {
		expect(resolveOwnUserRecordPermission(principal(7, false), USERS, 'dd133', '7')).toBe(2);
	});
});

describe('resolveComponentContextPermission applies the table (non-search only)', () => {
	test('own password stamps WRITE even with a zero matrix grant', async () => {
		const level = await resolveComponentContextPermission(
			principal(7, false),
			USERS,
			'dd133',
			7,
			'edit',
		);
		expect(level).toBe(2);
	});

	test('own profile stamps READ for a non-global-admin', async () => {
		const level = await resolveComponentContextPermission(
			principal(7, false),
			USERS,
			'dd1725',
			7,
			'edit',
		);
		expect(level).toBe(1);
	});

	test("a global admin's own guarded fields are READABLE even with a zero matrix (TODO-071)", async () => {
		const admin = principal(424245, true);
		for (const tipo of GUARDED) {
			expect(await getPermissions(admin, USERS, tipo)).toBe(0);
			expect(await getRecordComponentPermission(admin, USERS, tipo, 424245)).toBe(1);
			expect(await resolveComponentContextPermission(admin, USERS, tipo, 424245, 'edit')).toBe(1);
			// another user's record: no floor
			expect(await getRecordComponentPermission(admin, USERS, tipo, 424246)).toBe(0);
		}
	});

	test('SEARCH mode does NOT apply the table — PHP returns before it', async () => {
		// dd244 is a metadata-free ordinary component: in search mode PHP falls
		// through to the matrix, so the own-record downgrade must not fire here.
		const level = await resolveComponentContextPermission(
			principal(-1, true),
			USERS,
			SECURITY_ADMIN,
			-1,
			'search',
		);
		expect(level).toBeGreaterThan(1);
	});
});

describe('dd_core_api::save honours the table (the WRITE gate, end to end)', () => {
	function contextFor(userId: number, username: string, isGlobalAdmin: boolean, p: Principal) {
		const token = createSession(userId, username, isGlobalAdmin);
		const session = getSession(token);
		return {
			requestId: 'self-perm',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal: p,
		};
	}

	/**
	 * Root holds level 3 on dd244 and is a global admin, so ONLY the forced
	 * downgrade can refuse this save. Nothing is written on the denial path.
	 */
	test('editing your OWN security-administrator flag is refused, even as root', async () => {
		const p = await resolvePrincipal(-1);
		expect(p.isGlobalAdmin).toBe(true);
		const result = await dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				source: {
					model: 'component_security_administrator',
					tipo: SECURITY_ADMIN,
					section_tipo: USERS,
					section_id: -1,
				},
				data: { changed_data: [] },
			} as never,
			contextFor(-1, 'root', true, p) as never,
		);
		expect(result.status).toBe(403);
		expect((result.body as { ok: boolean; error: { code: string } }).ok).toBe(false);
		expect((result.body as { ok: boolean; error: { code: string } }).error.code).toBe(
			'perm.denied',
		);
	});

	test('the same flag on ANOTHER user record is NOT blocked by this rule', async () => {
		const p = await resolvePrincipal(-1);
		const result = await dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				source: {
					model: 'component_security_administrator',
					tipo: SECURITY_ADMIN,
					section_tipo: USERS,
					section_id: 1,
				},
				data: { changed_data: [] },
			} as never,
			contextFor(-1, 'root', true, p) as never,
		);
		expect(result.status).not.toBe(403);
	});
});

describe('dd_core_api::read serves your OWN record to tool_user_admin (end to end)', () => {
	// The remote report (7.0.0-beta.7): a non-admin whose profile grants nothing
	// on dd128 got perm.denied (Gate A), then — half fixed — an EMPTY shell (the
	// get_data facade's own per-component gate). A real user record is needed:
	// the assertions read the served context and data, not just the status.
	const OWN = OA_GRANTED_NON_ADMIN_ID;
	let user: Principal;

	beforeAll(async () => {
		await installOntologyAreaAccessFixture();
		user = await resolvePrincipal(OWN);
		expect(user.isGlobalAdmin).toBe(false);
	});
	afterAll(async () => {
		await removeOntologyAreaAccessFixture();
	});

	async function readOwn(
		tipo: string,
		model: string,
		sectionId: number | string,
		actor: Principal = user,
	) {
		const token = createSession(actor.userId, 'zzoa_reader', actor.isGlobalAdmin);
		const session = getSession(token);
		const result = await dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: {
					action: 'get_data',
					model,
					tipo,
					section_tipo: USERS,
					section_id: sectionId,
					mode: 'edit',
				},
			} as never,
			{
				requestId: 'self-read',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal: actor,
			} as never,
		);
		const body = result.body as {
			data?: { context: { tipo: string; permissions: number }[]; data: { value?: unknown }[] };
		};
		return { status: result.status, body };
	}

	test('the profile grants nothing on dd128 — the matrix alone would refuse', async () => {
		expect(await getPermissions(user, USERS, 'dd452')).toBe(0);
	});

	test('the four self-editable components serve their context at WRITE (2)', async () => {
		for (const [tipo, model] of [
			['dd452', 'component_input_text'],
			['dd134', 'component_email'],
			['dd133', 'component_password'],
			['dd522', 'component_image'],
		] as const) {
			const { status, body } = await readOwn(tipo, model, OWN);
			expect(status).toBe(200);
			expect(body.data?.context.find((c) => c.tipo === tipo)?.permissions).toBe(2);
		}
	});

	test('own username serves its DATA, read-only (anti self-elevation)', async () => {
		const { body } = await readOwn('dd132', 'component_input_text', OWN);
		expect(body.data?.context.find((c) => c.tipo === 'dd132')?.permissions).toBe(1);
		expect(JSON.stringify(body.data?.data)).toContain('zzoa_granted_reader');
	});

	test('a string section_id from the wire is the same own record', async () => {
		const { body } = await readOwn('dd132', 'component_input_text', String(OWN));
		expect(JSON.stringify(body.data?.data)).toContain('zzoa_granted_reader');
	});

	test("ANOTHER user's record keeps the matrix level — refused", async () => {
		expect((await readOwn('dd452', 'component_input_text', OA_GRANTED_ADMIN_ID)).status).toBe(403);
	});

	test('a non-root GLOBAL ADMIN reads their own id / username / profile read-only (TODO-071)', async () => {
		const admin = await resolvePrincipal(OA_GRANTED_ADMIN_ID);
		expect(admin.isGlobalAdmin).toBe(true);
		for (const [tipo, model] of [
			['dd330', 'component_section_id'],
			['dd132', 'component_input_text'],
			['dd1725', 'component_select'],
		] as const) {
			expect(await getPermissions(admin, USERS, tipo)).toBe(0);
			const { status, body } = await readOwn(tipo, model, OA_GRANTED_ADMIN_ID, admin);
			expect(`${tipo} ${status}`).toBe(`${tipo} 200`);
			expect(body.data?.context.find((c) => c.tipo === tipo)?.permissions).toBe(1);
		}
		const { body } = await readOwn('dd132', 'component_input_text', OA_GRANTED_ADMIN_ID, admin);
		expect(JSON.stringify(body.data?.data)).toContain('zzoa_granted_admin');
	});

	test('own profile (read-only) names ONLY your own profile, labelled (TODO-071)', async () => {
		const admin = await resolvePrincipal(OA_GRANTED_ADMIN_ID);
		for (const [id, actor] of [
			[OWN, user],
			[OA_GRANTED_ADMIN_ID, admin],
		] as const) {
			// non-vacuity: this profile grants nothing on the Profiles label component
			expect(await getPermissions(actor, 'dd234', 'dd237')).toBe(0);
			clearDatalistCache();
			const { body } = await readOwn('dd1725', 'component_select', id, actor);
			const item = (body.data?.data as { tipo: string; datalist?: unknown }[]).find(
				(d) => d.tipo === 'dd1725',
			);
			expect(item?.datalist).toEqual([
				expect.objectContaining({
					section_id: OA_GRANT_PROFILE_ID,
					label: 'zzoa ontology grant profile',
				}),
			]);
		}
	});
});

describe('the option list is keyed by the label fields the reader may see (TODO-071)', () => {
	// request_config drops a label ddo the actor holds 0 on, so a user without a
	// grant on dd237 builds BLANK labels. Keyed by (component, owner, lang) alone,
	// whoever built first decided what everyone saw.
	let reader: Principal;
	beforeAll(async () => {
		await installOntologyAreaAccessFixture();
		reader = await resolvePrincipal(OA_GRANTED_NON_ADMIN_ID);
	});
	afterAll(async () => {
		await removeOntologyAreaAccessFixture();
	});

	const labels = async (actor: Principal | undefined) => {
		const build = () =>
			getDatalist('dd1725', null, USERS, 'lg-eng').then((items) =>
				items.filter((i) => i.section_id === OA_GRANT_PROFILE_ID).map((i) => i.label),
			);
		return actor === undefined
			? build()
			: runWithRequestContext(
					{ principal: actor, session: null, requestId: 'k', clientIp: '' },
					build,
				);
	};

	test('an ungranted reader first does not blank the list for everyone', async () => {
		clearDatalistCache();
		expect(await labels(reader)).toEqual(['']);
		expect(await labels(undefined)).toEqual(['zzoa ontology grant profile']);
	});

	test('a full list first is not served to an ungranted reader', async () => {
		clearDatalistCache();
		expect(await labels(undefined)).toEqual(['zzoa ontology grant profile']);
		expect(await labels(reader)).toEqual(['']);
	});
});
