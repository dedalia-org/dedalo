/**
 * Shared-section targets close the edit/list buttons for non-root (T2-SC-3, O04/O05).
 *
 * THE CONTRACT (PHP build_structure_context :2033-2054, v6 identical): a
 * component whose request_config targets a section stored in `matrix_dd` — the
 * lists SHARED between installations (dd64 yes/no, …) — carries
 * `properties.show_interface.button_edit = false` and `button_list = false`
 * for every user except root, so nobody else is offered to open or edit those
 * records. Only the FULL context (add_request_config) — the simple build carries
 * no request_config. TS stamps it in the post-emission block, per call and per
 * principal (none = not root, fail closed), AFTER the RQO override / governed
 * re-emission, merged into show_interface.
 *
 * SITUATION (tld `zzsmd`, dropped in afterAll with residue asserted):
 *  zzsmd1 REAL section (relations → test24)
 *    zzsmd2 component_radio_button → dd64 (matrix_dd), show_interface {button_add: true}
 *    zzsmd3 component_portal       → test3 (matrix_test — not shared)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const SECTION = 'zzsmd1';
const SHARED = 'zzsmd2';
const LOCAL = 'zzsmd3';

const ROOT: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** A global admin + developer who is NOT root: PHP keys on the superuser id alone. */
const ADMIN: Principal = { userId: 999_713, isGlobalAdmin: true, isDeveloper: true };

const S = situation({
	name: 'matrix_dd target buttons',
	tld: 'zzsmd',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 98,
			term: { 'lg-eng': 'matrix_dd buttons section' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: SHARED,
			parent: SECTION,
			model: 'component_radio_button',
			order_number: 1,
			relations: [{ tipo: 'dd64' }],
			properties: { show_interface: { button_add: true } },
		},
		{
			tipo: LOCAL,
			parent: SECTION,
			model: 'component_portal',
			order_number: 2,
			relations: [{ tipo: 'test3' }],
		},
	],
});

beforeAll(async () => {
	await assertTestDatabase('structure_context_matrix_dd_buttons_native');
	await ensureSituation(S);
}, 60_000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

type ShowInterface = Record<string, unknown> | undefined;

async function showInterface(
	tipo: string,
	options: {
		principal?: Principal;
		propertiesOverride?: Record<string, unknown>;
		simple?: boolean;
	} = {},
): Promise<ShowInterface> {
	const entry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo,
		sectionTipo: SECTION,
		mode: 'edit',
		lang: 'lg-nolan',
		permissions: 2,
		...(options.principal !== undefined ? { principal: options.principal } : {}),
		...(options.propertiesOverride !== undefined
			? { propertiesOverride: options.propertiesOverride }
			: {}),
		...(options.simple === true ? { addRequestConfig: false } : {}),
	});
	return (entry?.properties as { show_interface?: Record<string, unknown> } | undefined)
		?.show_interface;
}

const CLOSED = { button_edit: false, button_list: false };

describe('matrix_dd targets: button_edit / button_list closed for non-root (T2-SC-3)', () => {
	test('precondition: the targets are what the situation says (dd64 shared, test3 not)', async () => {
		expect(await getMatrixTableFromTipo('dd64')).toBe('matrix_dd');
		expect(await getMatrixTableFromTipo('test3')).not.toBe('matrix_dd');
	});

	test('a non-root principal — a global admin included — gets both closed, siblings kept', async () => {
		expect(await showInterface(SHARED, { principal: ADMIN })).toEqual({
			button_add: true,
			...CLOSED,
		});
	});

	test('root keeps the ontology show_interface untouched', async () => {
		expect(await showInterface(SHARED, { principal: ROOT })).toEqual({ button_add: true });
	});

	test('the principal is read from the request scope too — and NO principal is not root', async () => {
		const scoped = (principal: Principal) =>
			runWithRequestContext(
				{ principal, session: null, requestId: 'smd', clientIp: '127.0.0.1' },
				() => showInterface(SHARED),
			);
		expect(await scoped(ROOT)).toEqual({ button_add: true });
		expect(await scoped(ADMIN)).toEqual({ button_add: true, ...CLOSED });
		expect(await showInterface(SHARED)).toEqual({ button_add: true, ...CLOSED });
	});

	test('an RQO properties override cannot re-open them', async () => {
		const reopened = await showInterface(SHARED, {
			principal: ADMIN,
			propertiesOverride: { show_interface: { button_edit: true, button_list: true, x: 1 } },
		});
		expect(reopened).toEqual({ x: 1, ...CLOSED });
	});

	test('a target that is not shared is left alone; the simple build (no request_config) too', async () => {
		const local = await showInterface(LOCAL, { principal: ADMIN });
		expect(local?.button_edit).toBeUndefined();
		expect(local?.button_list).toBeUndefined();
		expect(await showInterface(SHARED, { principal: ADMIN, simple: true })).toEqual({
			button_add: true,
		});
	});
});
