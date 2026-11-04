/**
 * Menu context TOOLS gate (PHP menu::get_structure_context, class.menu.php:461
 * — the override that populates 'tools' from get_tools()).
 *
 * The menu ships its own toolbar in the context half of the read(menu)
 * response: the client's open_tool_user_admin_handler
 * (client/dedalo/core/menu/js/menu.js) looks tool_user_admin up in
 * `self.context.tools` and refuses to open the panel when it is missing — the
 * username link in the header then does nothing.
 *
 * The binding is ONTOLOGY-defined, not hardcoded: the dd1324 registry record
 * for tool_user_admin declares affected_tipos (dd1350) = ['dd85'] (the menu
 * tipo) and always_active (dd1601) = yes, so EVERY logged user gets it, root
 * included (root's header link opens it too since 2026-11-02). Expectations are therefore DERIVED from the registry
 * filter (getElementTools), never hardcoded to a tool list.
 *
 * Frozen-oracle shape (test/parity/fixtures/oracle_harvest/menu_differential.json,
 * the read(menu) interaction): context[0].tools[0] is the tool simple-context
 * DDO {typo:'ddo', type:'tool', section_tipo:'dd1324', model/name, css, icon}.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	createSession,
	destroySession,
	getSession,
} from '../../src/core/security/session_store.ts';
import { getElementTools } from '../../src/core/tools/registry.ts';

/** The menu element (PHP DEDALO_MENU_TIPO). */
const MENU_TIPO = 'dd85';
/** Profile-8 non-admin fixture user (same standing fixture as menu_nonadmin). */
const NON_ADMIN_USER = 16;

const tokens: string[] = [];

function sessionFor(userId: number, username: string, isGlobalAdmin: boolean): ApiRequestContext {
	const rawToken = createSession(userId, username, isGlobalAdmin);
	tokens.push(rawToken);
	const session = getSession(rawToken);
	if (session === null) throw new Error('session vanished');
	return {
		requestId: 'test',
		clientIp: '127.0.0.1',
		session,
		sessionToken: rawToken,
		csrfCandidate: session.csrfToken,
	};
}

/** The read(menu) rqo the client boots with (PHP menu_json.php). */
const MENU_RQO = {
	dd_api: 'dd_core_api',
	action: 'read',
	prevent_lock: true,
	source: {
		typo: 'source',
		model: 'menu',
		tipo: MENU_TIPO,
		section_tipo: MENU_TIPO,
		action: 'get_data',
		mode: 'list',
		lang: 'lg-eng',
	},
} as unknown as Rqo;

async function readMenuTools(context: ApiRequestContext): Promise<Record<string, unknown>[]> {
	const result = await dispatchRqo(MENU_RQO, context);
	expect(result.status).toBe(200);
	const menuContext = ((result.body.data as { context?: Record<string, unknown>[] }).context ??
		[])[0];
	expect(menuContext).toBeDefined();
	return (menuContext?.tools ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
	tokens.length = 0;
});

afterEach(() => {
	for (const token of tokens) destroySession(token);
	tokens.length = 0;
});

describe('menu context tools', () => {
	test('the read(menu) context ships the ontology-bound menu tools', async () => {
		// The registry filter is the oracle for WHICH tools belong on dd85.
		const expected = await getElementTools({
			model: 'menu',
			tipo: MENU_TIPO,
			isComponent: false,
			translatable: false,
			toolConfigKeys: [],
		});
		expect(expected.ledgered).toEqual([]);
		expect(expected.tools.length).toBeGreaterThan(0); // dd1350 binds at least one

		const tools = await readMenuTools(sessionFor(-1, 'root', true));
		expect(tools.map((tool) => tool.model)).toEqual(expected.tools.map((tool) => tool.name));
	});

	test('tool_user_admin is on the menu, in the frozen simple-context shape', async () => {
		const tools = await readMenuTools(sessionFor(-1, 'root', true));
		const userAdmin = tools.find((tool) => tool.model === 'tool_user_admin');
		// The client finds it by model (menu.js open_tool_user_admin_handler).
		expect(userAdmin).toBeDefined();
		expect(userAdmin?.typo).toBe('ddo');
		expect(userAdmin?.type).toBe('tool');
		expect(userAdmin?.section_tipo).toBe('dd1324');
		expect(userAdmin?.name).toBe('tool_user_admin');
		expect(userAdmin?.mode).toBe('edit');
		expect(userAdmin?.css).toEqual({
			url: '/dedalo/tools/tool_user_admin/css/tool_user_admin.css',
		});
		expect(userAdmin?.icon).toBe('/dedalo/tools/tool_user_admin/img/icon.svg');
	});

	test('a NON-ADMIN user gets it too — the tool is always_active', async () => {
		const tools = await readMenuTools(sessionFor(NON_ADMIN_USER, 'non_admin', false));
		expect(tools.map((tool) => tool.model)).toContain('tool_user_admin');
	});
});
