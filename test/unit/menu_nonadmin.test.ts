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
import { getMenuTreeDatalist, reattachOrphans } from '../../src/core/api/handlers/menu.ts';
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
/** The areas a ROLE gates; what sits under one the viewer lacks is hidden with it. */
const ROLE_GATED: ReadonlySet<string> = new Set(['dd5', 'dd770', 'dd88']);

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

		// And nothing authorized that the superuser tree contains was dropped — except what
		// sits under a role-gated area the viewer lacks (WC-2026-10-28-menu-orphans).
		const filteredTipos = new Set(filtered.tree_datalist.map((node) => node.tipo));
		const superuserParent = new Map(
			superuser.tree_datalist.map((node) => [node.tipo, node.parent]),
		);
		const underHiddenRoleArea = (tipo: string): boolean => {
			for (
				let p = superuserParent.get(tipo) ?? null;
				p !== null;
				p = superuserParent.get(p) ?? null
			) {
				if (ROLE_GATED.has(p) && !filteredTipos.has(p)) return true;
			}
			return false;
		};
		for (const node of superuser.tree_datalist) {
			if (node.config !== undefined) continue; // rewrites carry swapped tipos
			if (ROLE_GATED.has(node.tipo)) continue;
			if (authorized.has(node.tipo)) {
				expect(filteredTipos.has(node.tipo)).toBe(!underHiddenRoleArea(node.tipo));
			}
		}
	});

	test('no entry is left under a parent the viewer cannot see (unreachable in the client tree)', async () => {
		const superuserTipos = new Set((await getMenuTreeDatalist()).tree_datalist.map((n) => n.tipo));
		for (const viewer of [
			{ userId: NON_ADMIN_USER, isGlobalAdmin: false, isDeveloper: false },
			{ userId: ACL_ADMIN_USER_ID, isGlobalAdmin: true, isDeveloper: false },
		]) {
			const tree = (await getMenuTreeDatalist(viewer)).tree_datalist;
			const visible = new Set(tree.map((node) => node.tipo));
			// a parent is visible, the top level, or a menu root that is no entry for anyone
			const orphans = tree.filter(
				(node) =>
					node.parent !== null && !visible.has(node.parent) && superuserTipos.has(node.parent),
			);
			expect(orphans.map((node) => `${node.tipo} → ${node.parent}`)).toEqual([]);
			expect(tree.length).toBeGreaterThan(0); // non-vacuity: a real tree was checked
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

describe('orphan pass (WC-2026-10-28-menu-orphans) — pure', () => {
	// dd1 (no area) ← dd242 ← test1 ← test3 ; dd1 ← dd5 ← ontology40 ← ontologytype5
	const area = (tipo: string, parent: string) => ({
		tipo,
		model: 'area',
		parent,
		label: tipo,
		properties: null,
	});
	const all = new Map(
		[
			area('dd242', 'dd1'),
			area('test1', 'dd242'),
			area('test3', 'test1'),
			area('dd5', 'dd1'),
			area('ontology40', 'dd5'),
			area('ontologytype5', 'ontology40'),
		].map((node) => [node.tipo, node]),
	);
	const item = (tipo: string, parent: string) => ({ tipo, model: 'area', parent, label: tipo });

	test('a granted child of a hidden plain area is re-parented to the nearest visible ancestor', () => {
		const skipped: { tipo: string; reason: string }[] = [];
		const out = reattachOrphans(
			[item('dd242', 'dd1'), item('test3', 'test1')],
			all as never,
			skipped,
		);
		expect(out.map((n) => `${n.tipo}<${n.parent}`)).toEqual(['dd242<dd1', 'test3<dd242']);
		expect(skipped).toEqual([]);
	});

	test('under a hidden role-gated area the WHOLE subtree drops, even below a granted ancestor', () => {
		const skipped: { tipo: string; reason: string }[] = [];
		const out = reattachOrphans(
			[item('ontology40', 'dd5'), item('ontologytype5', 'ontology40'), item('test3', 'test1')],
			all as never,
			skipped,
		);
		expect(out.map((n) => `${n.tipo}<${n.parent}`)).toEqual(['test3<dd1']);
		expect(skipped.map((s) => s.tipo)).toEqual(['ontology40', 'ontologytype5']);
	});

	test('a visible role-gated area keeps its subtree as it is', () => {
		const out = reattachOrphans(
			[item('dd5', 'dd1'), item('ontology40', 'dd5'), item('ontologytype5', 'ontology40')],
			all as never,
			[],
		);
		expect(out.map((n) => n.parent)).toEqual(['dd1', 'dd5', 'ontology40']);
	});
});
