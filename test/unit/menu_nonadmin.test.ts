/**
 * Phase 6 gate: the NON-ADMIN menu filter (PHP menu::get_tree_datalist
 * non-superuser path + security::get_ar_authorized_areas_for_user).
 *
 * A non-admin viewer's tree keeps only nodes whose tipo is SELF-KEY
 * authorized in their dd774 permissions table; the maintenance area (dd88)
 * additionally requires admin-or-developer and the development area (dd770)
 * developer — the role is a precondition, never a grant (PHP falls through to
 * the same authorized lookup). Expectations are DERIVED from the superuser tree and
 * the viewer's own permissions table — never hardcoded.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getMenuTreeDatalist } from '../../src/core/api/handlers/menu.ts';
import { getAuthorizedAreaTipos } from '../../src/core/security/permissions.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';

// BUILT, not borrowed: this was "user 16, profile 8 — the standing non-admin
// fixture", an installation account a rebuilt suite database does not hold. A
// grantless principal makes the filtered tree EMPTY, so the "at least some
// remain" floor measured the fixture's absence.
const NON_ADMIN_USER = ACL_NON_ADMIN_USER_ID;

beforeAll(installAclIdentityFixture);
afterAll(removeAclIdentityFixture);

describe('non-admin menu filter (Phase 6 gate)', () => {
	test('a non-admin sees exactly the authorized subset of the superuser tree', async () => {
		const superuser = await getMenuTreeDatalist();
		const filtered = await getMenuTreeDatalist({
			userId: NON_ADMIN_USER,
			isGlobalAdmin: false,
			isDeveloper: false,
		});
		const authorized = await getAuthorizedAreaTipos(NON_ADMIN_USER);

		// A real filter: strictly fewer nodes, and at least some remain.
		expect(filtered.tree_datalist.length).toBeLessThan(superuser.tree_datalist.length);
		expect(filtered.tree_datalist.length).toBeGreaterThan(0);

		// Every emitted node is authorized and never a role-gated area. The
		// section_tool/thesaurus rewrites change the emitted tipo, so check
		// against BOTH sets via the superuser tree's tipos.
		const superuserTipos = new Set(superuser.tree_datalist.map((node) => node.tipo));
		for (const node of filtered.tree_datalist) {
			expect(node.tipo === 'dd88').toBe(false);
			expect(node.tipo === 'dd770').toBe(false);
			expect(superuserTipos.has(node.tipo)).toBe(true);
			if (node.config === undefined) {
				expect(authorized.has(node.tipo)).toBe(true);
			}
		}

		// And nothing authorized that the superuser tree contains was dropped.
		const filteredTipos = new Set(filtered.tree_datalist.map((node) => node.tipo));
		for (const node of superuser.tree_datalist) {
			if (node.config !== undefined) continue; // rewrites carry swapped tipos
			if (node.tipo === 'dd88' || node.tipo === 'dd770') continue;
			if (authorized.has(node.tipo)) {
				expect(filteredTipos.has(node.tipo)).toBe(true);
			}
		}
	});

	test('an admin who is not a developer still loses the development area', async () => {
		const tree = await getMenuTreeDatalist({
			userId: NON_ADMIN_USER, // table irrelevant for the role-gated areas
			isGlobalAdmin: true,
			isDeveloper: false,
		});
		const tipos = new Set(tree.tree_datalist.map((node) => node.tipo));
		expect(tipos.has('dd770')).toBe(false);
	});

	test('the role areas need the GRANT too, not the role alone', async () => {
		// A user id with no profile → an empty permissions table.
		const UNGRANTED = 987654321;
		expect((await getAuthorizedAreaTipos(UNGRANTED)).size).toBe(0);
		expect((await getAuthorizedAreaTipos(ACL_ADMIN_USER_ID)).has('dd88')).toBe(true);
		const superuserTipos = new Set((await getMenuTreeDatalist()).tree_datalist.map((n) => n.tipo));
		expect(superuserTipos.has('dd88')).toBe(true);
		expect(superuserTipos.has('dd770')).toBe(true);
		const tipos = async (userId: number, isGlobalAdmin: boolean, isDeveloper: boolean) =>
			new Set(
				(await getMenuTreeDatalist({ userId, isGlobalAdmin, isDeveloper })).tree_datalist.map(
					(n) => n.tipo,
				),
			);
		// admin, not developer: dd88 only with the grant
		expect((await tipos(ACL_ADMIN_USER_ID, true, false)).has('dd88')).toBe(true);
		expect((await tipos(UNGRANTED, true, false)).has('dd88')).toBe(false);
		// developer, not admin: dd88 only with the grant; dd770 never without it
		expect((await tipos(ACL_ADMIN_USER_ID, false, true)).has('dd88')).toBe(true);
		expect((await tipos(UNGRANTED, false, true)).has('dd88')).toBe(false);
		expect((await tipos(UNGRANTED, false, true)).has('dd770')).toBe(false);
	});

	test('the admin+developer path is unchanged (unfiltered)', async () => {
		const explicit = await getMenuTreeDatalist({
			userId: -1,
			isGlobalAdmin: true,
			isDeveloper: true,
		});
		const implicit = await getMenuTreeDatalist();
		expect(explicit.tree_datalist).toEqual(implicit.tree_datalist);
	});
});
