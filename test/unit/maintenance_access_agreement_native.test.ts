/**
 * THE MAINTENANCE RULE — every door that opens the maintenance area (dd88)
 * answers the SAME for every persona (T2-O15-2, owner ruling Q5 2026-11-19,
 * WC-2026-11-22-maintenance-access-predicate).
 *
 * The rule (security/permissions.ts canAccessMaintenanceArea): the superuser
 * always; a global admin OR a developer whose profile grants dd88 at level 2.
 * Before: the menu offered dd88 to an admin OR developer holding ANY dd88 entry
 * (and to every admin+developer unconditionally), while the area read and the
 * widget dispatchers asked "global admin" alone and never the grant — so a
 * developer saw an entry that refused, and an admin without the grant opened a
 * panel the menu would not have offered.
 *
 * DOORS (each driven through its real entry, outcome = opened / refused):
 *   menu        getMenuTreeDatalist offers dd88
 *   start       dispatchRqo start ?tipo=dd88 → 200 (not perm.denied)
 *   landing     start with no tipo, dd1603 = dd88 → lands on dd88
 *   area read   dispatchRqo read area_maintenance dd88 → 200
 *   get_widget_value / widget_request / lock_components_actions /
 *   parse_simple_schema_changes_files — answer anything but perm.denied
 * PERSONAS: the superuser + test/helpers/maintenance_persona_fixture.ts (one
 * per cell: admin / developer / neither × dd88 2 / 1 / none).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { getMenuTreeDatalist } from '../../src/core/api/handlers/menu.ts';
import { canAccessMaintenanceArea, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	createSession,
	destroySession,
	getSession,
} from '../../src/core/security/session_store.ts';
import {
	installMaintenancePersonas,
	MAINTENANCE_PERSONAS,
	ONTOLOGY_AREA_OPEN_USER_IDS,
	removeMaintenancePersonas,
} from '../helpers/maintenance_persona_fixture.ts';
import { requireSuiteMariadb, SUITE_MARIADB_DATABASES } from '../helpers/suite_mariadb.ts';

const DD88 = 'dd88';
const DD5 = 'dd5';

/** Every session a door call mints — destroyed in afterAll (no residue in the suite store). */
const mintedTokens: string[] = [];

const PERSONAS = [{ userId: -1, label: 'superuser', open: true }, ...MAINTENANCE_PERSONAS] as const;

async function call(userId: number, rqo: Record<string, unknown>) {
	const principal = await resolvePrincipal(userId);
	const token = createSession(userId, `zzmaint_${userId}`, principal.isGlobalAdmin);
	mintedTokens.push(token);
	const session = getSession(token);
	const result = await dispatchRqo(
		structuredClone(rqo) as never,
		{
			requestId: 'maintenance_access_agreement',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	return result;
}

/** A door opened when it answered anything but the authorization refusal. */
function opened(result: { status: number; body: Record<string, unknown> }): boolean {
	const code = (result.body.error as { code?: string } | undefined)?.code;
	return code !== 'perm.denied';
}

function landingTipos(result: { body: Record<string, unknown> }): unknown[] {
	const data = result.body.data as { context?: { tipo?: unknown }[] } | undefined;
	return (data?.context ?? []).map((entry) => entry.tipo);
}

async function doorsFor(userId: number): Promise<Record<string, boolean>> {
	const principal = await resolvePrincipal(userId);
	const menu = await getMenuTreeDatalist(principal);
	const start = await call(userId, {
		action: 'start',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: { search_obj: { tipo: DD88 }, menu: false },
	});
	// the no-tipo landing: every persona's dd1603 names dd88 (the superuser lands
	// there before any dd1603 read, T2-P03-a)
	const landing = await call(userId, {
		action: 'start',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: { search_obj: {}, menu: false },
	});
	// a refused default never blocks a login: it falls back, it does not answer perm.denied
	expect(landing.status, `landing of ${userId}`).toBe(200);
	const read = await call(userId, {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: { tipo: DD88, section_tipo: DD88, model: 'area_maintenance', mode: 'list' },
	});
	const value = await call(userId, {
		action: 'get_widget_value',
		dd_api: 'dd_area_maintenance_api',
		prevent_lock: true,
		source: { model: 'zz_no_such_widget' },
	});
	const widget = await call(userId, {
		action: 'widget_request',
		dd_api: 'dd_area_maintenance_api',
		prevent_lock: true,
		options: {},
		source: { model: 'zz_no_such_widget', action: 'get_value' },
	});
	const locks = await call(userId, {
		action: 'lock_components_actions',
		dd_api: 'dd_area_maintenance_api',
		prevent_lock: true,
		options: { fn_action: 'zz_no_such_action' },
	});
	const schema = await call(userId, {
		action: 'parse_simple_schema_changes_files',
		dd_api: 'dd_area_maintenance_api',
		prevent_lock: true,
		options: { filename: 'zz_no_such_file.json' },
	});
	return {
		predicate: await canAccessMaintenanceArea(principal),
		menu: menu.tree_datalist.some((item) => item.tipo === DD88),
		start: start.status === 200,
		landing: landingTipos(landing).includes(DD88),
		area_read: read.status === 200,
		get_widget_value: opened(value),
		widget_request: opened(widget),
		lock_components_actions: opened(locks),
		parse_simple_schema_changes_files: opened(schema),
	};
}

// The dd_diffusion_api door (lang_sweep) and the maintenance area's
// diffusion_server_control widget open a pool per diffusion target: acquire the
// lane's suite MariaDB first (PUB-05) so those pools are proved to land there.
beforeAll(async () => {
	await requireSuiteMariadb(import.meta.path, SUITE_MARIADB_DATABASES());
}, 120_000); // a cold suite MariaDB lane installs and starts a server
beforeAll(installMaintenancePersonas);
afterAll(async () => {
	for (const token of mintedTokens.splice(0)) destroySession(token);
	await removeMaintenancePersonas();
});

describe('the maintenance rule — every door agrees, per persona (T2-O15-2)', () => {
	for (const persona of PERSONAS) {
		test(`${persona.label} (${persona.userId}): every door ${persona.open ? 'OPENS' : 'REFUSES'}`, async () => {
			const doors = await doorsFor(persona.userId);
			const expected = Object.fromEntries(Object.keys(doors).map((door) => [door, persona.open]));
			expect(doors).toEqual(expected);
		});
	}

	test('non-vacuity: both outcomes occur, and each role reaches both', () => {
		const open = PERSONAS.filter((p) => p.open).map((p) => p.label);
		const closed = PERSONAS.filter((p) => !p.open).map((p) => p.label);
		expect(open.length).toBeGreaterThanOrEqual(3);
		expect(closed.length).toBeGreaterThanOrEqual(3);
	});
});

/**
 * THE AREA PAGE DOOR (WC-2026-11-22-start-area-page-door): `start` asks the
 * SAME door the area read asks (security/permissions.ts canOpenAreaPage), so it
 * never describes a page the next read refuses. Driven on the ontology area
 * (dd5: superuser, or a global admin whose profile grants dd5): before, `start`
 * asked only the grant and handed a dd5 page to a developer / a role-less user
 * holding it, whose next read answered perm.denied.
 */
describe('start agrees with the area read on a door-ruled area page (dd5)', () => {
	for (const persona of PERSONAS) {
		const open = persona.userId === -1 || ONTOLOGY_AREA_OPEN_USER_IDS.has(persona.userId);
		test(`${persona.label} (${persona.userId}): start and read both ${open ? 'OPEN' : 'REFUSE'} dd5`, async () => {
			const start = await call(persona.userId, {
				action: 'start',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				options: { search_obj: { tipo: DD5 }, menu: false },
			});
			const read = await call(persona.userId, {
				action: 'read',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: { tipo: DD5, section_tipo: DD5, model: 'area_ontology', mode: 'list' },
			});
			expect({ start: start.status === 200, read: read.status === 200 }).toEqual({
				start: open,
				read: open,
			});
		});
	}

	test('non-vacuity: the grant-without-role cell exists, and both outcomes occur', () => {
		expect(ONTOLOGY_AREA_OPEN_USER_IDS.size).toBeGreaterThanOrEqual(1);
		// 954004 (developer) and 954006 (no role) hold dd5 without the admin role
		expect([954004, 954006].some((id) => ONTOLOGY_AREA_OPEN_USER_IDS.has(id))).toBe(false);
		expect(
			PERSONAS.some((p) => p.userId !== -1 && !ONTOLOGY_AREA_OPEN_USER_IDS.has(p.userId)),
		).toBe(true);
	});
});
