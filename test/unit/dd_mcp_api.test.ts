/**
 * Gate: dd_mcp_api — the in-process HTTP bridge (Phase 5 of the work-system
 * MCP foundation). Drives the REAL dispatch (dispatchRqo) with session
 * fixtures, so every gate the browser hits runs here too.
 *
 * Load-bearing assertions:
 *   - fail-closed master switch: absent DEDALO_AGENT_HTTP_ENABLED ⇒ every
 *     action answers like an unregistered one;
 *   - session + CSRF required (the normal authenticated-action gates);
 *   - the JSON-RPC round-trip initialize → tools/list → tools/call works and
 *     mints/validates the stateless mcp_session_id;
 *   - the stale-session message is the LITERAL string the byte-identical
 *     client's recovery matches on;
 *   - per-request principal: two sessions with different users see different
 *     gated results through the same bridge;
 *   - agent_apply rejects a hash mismatch.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The
// per-principal split is BUILT, not borrowed: the gated section is the
// playground `test3`, which is project-gated for real through its own
// component_filter `test101`, and the two identities are the synthetic ACL ones
// (test/helpers/acl_identity_fixture.ts). Three scratch records in the reserved
// ≥900000 band carry the split — two the non-admin's project, one a project they
// do NOT hold — so "the gated user sees strictly fewer, and both see some" is a
// fact of this repo. It used to read an install's `numisdata267` records and
// user 16, which exist on one machine: BOTH assertions were red on the suite DB.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	createSession,
	destroySession,
	getSession,
	type Session,
} from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { resetRegistryCache } from '../../src/core/tools/registry.ts';
import {
	ACL_NON_ADMIN_PROFILE_ID,
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import {
	cleanScratchRecord,
	createScratchRecord,
	ensureCanonicalTest3,
} from '../helpers/test_data.ts';
import { toolGrantLocator } from '../helpers/tool_grant_fixture.ts';

/** The project-gated section, and the component_filter buildProjectsFilter keys on. */
const GATED_SECTION = 'test3';
const FILTER_COMPONENT = 'test101';
/** test3's own component_input_text — what makes the scratch rows searchable. */
const TEXT_COMPONENT = 'test52';
/** Projects live in dd153; the locator type the real records carry. */
const PROJECTS_SECTION = 'dd153';
const PROJECT_LOCATOR_TYPE = 'dd675';
/** Scratch records this gate owns (reserved ≥900000 band). */
const VISIBLE_IDS = [941201, 941202];
const HIDDEN_ID = 941203;
/** A project the gated user does NOT hold — what makes HIDDEN_ID hidden. */
const OTHER_PROJECT_ID = 1;

function projectLocator(projectId: number) {
	return [
		{
			id: 1,
			type: PROJECT_LOCATOR_TYPE,
			section_id: String(projectId),
			section_tipo: PROJECTS_SECTION,
			from_component_tipo: FILTER_COMPONENT,
		},
	];
}

async function createGatedRecord(sectionId: number, projectId: number): Promise<void> {
	await createScratchRecord(GATED_SECTION, sectionId, {
		relation: { [FILTER_COMPONENT]: projectLocator(projectId) },
		string: { [TEXT_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: `mcp scratch ${sectionId}` }] },
	});
}

let adminToken: string;
let admin: Session;
let userToken: string;
let user: Session;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
	for (const key of [
		'DEDALO_AGENT_HTTP_ENABLED',
		'DEDALO_AGENT_ALLOW_WRITE',
		'DEDALO_AGENT_MODELS',
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.DEDALO_AGENT_HTTP_ENABLED = 'true';
	// The assistant is only offered (src/ai/capabilities.ts → the tool_assistant
	// grant) when the catalog resolves to a model: BUILD one instead of borrowing
	// the host's ANTHROPIC_API_KEY (red in the CI image, green on a developer
	// machine). These doors never call it; a local endpoint that answers nothing.
	process.env.DEDALO_AGENT_MODELS = JSON.stringify([
		{
			id: 'zzmcp',
			label: 'zzmcp stub',
			provider: 'openai_compatible',
			model: 'zzmcp-native',
			endpoint: 'http://127.0.0.1:9/v1/chat/completions',
			egress: 'local',
		},
	]);
	await ensureCanonicalTest3();
	await installAclIdentityFixture();
	// THE AGENT DOOR asks the caller's tool grant (closure Step 3, SEC-3): the
	// gated user's profile authorizes tool_assistant, BUILT here through the one
	// grant derivation (tool_grant_fixture) — the superuser holds every tool.
	await assertTestDatabase('dd_mcp_api.test: tool_assistant grant');
	await sql.unsafe(
		`UPDATE matrix_profiles SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object('dd1067', $1::text::jsonb) WHERE section_tipo = 'dd234' AND section_id = $2`,
		[encodeForJsonb([await toolGrantLocator('tool_assistant')]), ACL_NON_ADMIN_PROFILE_ID],
	);
	resetRegistryCache();
	for (const id of VISIBLE_IDS) await createGatedRecord(id, ACL_PROJECT_ID);
	await createGatedRecord(HIDDEN_ID, OTHER_PROJECT_ID);
	adminToken = createSession(-1, 'debug_superuser', true);
	admin = getSession(adminToken) as Session;
	userToken = createSession(ACL_NON_ADMIN_USER_ID, 'gated_user', false);
	user = getSession(userToken) as Session;
});

afterAll(async () => {
	for (const id of [...VISIBLE_IDS, HIDDEN_ID]) await cleanScratchRecord(GATED_SECTION, id);
	await removeAclIdentityFixture();
	destroySession(adminToken);
	destroySession(userToken);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

function contextFor(session: Session | null, csrf?: string | null) {
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: csrf === undefined ? (session?.csrfToken ?? null) : csrf,
	};
}

function proxyRqo(envelope: Record<string, unknown>, mcpSessionId?: string): Rqo {
	return {
		action: 'mcp_proxy',
		dd_api: 'dd_mcp_api',
		options: envelope,
		...(mcpSessionId !== undefined ? { mcp_session_id: mcpSessionId } : {}),
	} as unknown as Rqo;
}

async function initialize(session: Session): Promise<string> {
	const result = await dispatchRqo(
		proxyRqo({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
		contextFor(session) as never,
	);
	const body = result.body as { ok: boolean; mcp_session_id?: string };
	expect(body.ok).toBe(true); // envelope v2: {result:true, data} → ok/data
	expect(body.mcp_session_id).toBeTruthy();
	return body.mcp_session_id as string;
}

describe('dd_mcp_api gates', () => {
	test('fail-closed: with the master switch OFF the action refuses', async () => {
		process.env.DEDALO_AGENT_HTTP_ENABLED = '';
		try {
			const result = await dispatchRqo(
				proxyRqo({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
				contextFor(admin) as never,
			);
			expect(result.status).toBe(400);
		} finally {
			process.env.DEDALO_AGENT_HTTP_ENABLED = 'true';
		}
	});

	test('a session is required; CSRF is required', async () => {
		const noSession = await dispatchRqo(
			proxyRqo({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
			contextFor(null) as never,
		);
		expect(noSession.status).toBe(401);

		const badCsrf = await dispatchRqo(
			proxyRqo({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
			contextFor(admin, 'wrong-token') as never,
		);
		expect(badCsrf.status).toBe(403);
		expect((badCsrf.body as { error?: { code?: string } }).error?.code).toBe('auth.csrf_failed');
	});
});

describe('mcp_proxy JSON-RPC round-trip', () => {
	test('initialize → tools/list → tools/call under the minted session id', async () => {
		const mcpSessionId = await initialize(admin);

		const list = await dispatchRqo(
			proxyRqo({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, mcpSessionId),
			contextFor(admin) as never,
		);
		const listBody = list.body as {
			ok: boolean;
			data: { result: { tools: { name: string; inputSchema: unknown }[] } };
		};
		expect(listBody.ok).toBe(true); // envelope v2: {result:true, data} → ok/data
		const toolNames = listBody.data.result.tools.map((tool) => tool.name);
		expect(toolNames).toContain('dedalo_list_sections');
		expect(toolNames).toContain('dedalo_search_records');
		// No write flag set ⇒ no write tools on the wire.
		expect(toolNames).not.toContain('dedalo_create_record');

		const call = await dispatchRqo(
			proxyRqo(
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'dedalo_describe_node',
						arguments: { tipo: GATED_SECTION },
					},
				},
				mcpSessionId,
			),
			contextFor(admin) as never,
		);
		const callBody = call.body as {
			ok: boolean;
			data: {
				result: { content: { type: string; text: string }[]; structuredContent: unknown };
			};
		};
		expect(callBody.ok).toBe(true); // envelope v2: {result:true, data} → ok/data
		const structured = callBody.data.result.structuredContent as {
			ok: boolean;
			data: { model: string };
		};
		expect(structured.ok).toBe(true);
		expect(structured.data.model).toBe('section');
	});

	test('stale/missing session id returns the LITERAL recovery message', async () => {
		const missing = await dispatchRqo(
			proxyRqo({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
			contextFor(admin) as never,
		);
		expect((missing.body as { ok: boolean }).ok).toBe(false);
		expect((missing.body as { error: { code: string } }).error.code).toBe('mcp.session_invalid');
		expect((missing.body as { error: { message: string } }).error.message).toBe(
			'No valid MCP session ID provided',
		);

		const stale = await dispatchRqo(
			proxyRqo({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'deadbeef'),
			contextFor(admin) as never,
		);
		expect((stale.body as { error: { message: string } }).error.message).toBe(
			'No valid MCP session ID provided',
		);
	});

	test('non-allowlisted JSON-RPC methods get a JSON-RPC error', async () => {
		const mcpSessionId = await initialize(admin);
		const result = await dispatchRqo(
			proxyRqo({ jsonrpc: '2.0', id: 9, method: 'resources/list', params: {} }, mcpSessionId),
			contextFor(admin) as never,
		);
		const body = result.body as {
			ok: boolean;
			data: { error?: { code: number; data?: { code: string; label_key: string } } };
		};
		expect(body.ok).toBe(true); // the JSON-RPC layer is the payload; the HTTP envelope is fine
		expect(body.data.error?.code).toBe(-32601);
		// the envelope-v2 error body rides in JSON-RPC `error.data`
		expect(body.data.error?.data?.code).toBe('request.invalid');
		expect(body.data.error?.data?.label_key).toBe('error_request_invalid');
	});

	test('per-request principal: the gated user sees fewer records than admin', async () => {
		const adminSession = await initialize(admin);
		const userSession = await initialize(user);
		expect(userSession).not.toBe(adminSession);

		async function total(session: Session, mcpSessionId: string): Promise<number> {
			const result = await dispatchRqo(
				proxyRqo(
					{
						jsonrpc: '2.0',
						id: 4,
						method: 'tools/call',
						params: {
							name: 'dedalo_count_records',
							arguments: { section_tipo: GATED_SECTION },
						},
					},
					mcpSessionId,
				),
				contextFor(session) as never,
			);
			const structured = (
				result.body as {
					data: { result: { structuredContent: { data: { total: number } } } };
				}
			).data.result.structuredContent;
			return structured.data.total;
		}

		const adminTotal = await total(admin, adminSession);
		const userTotal = await total(user, userSession);
		expect(adminTotal).toBeGreaterThan(0);
		expect(userTotal).toBeGreaterThan(0);
		expect(userTotal).toBeLessThan(adminTotal);
	});

	test('write tools are refused for a global admin even with write enabled', async () => {
		process.env.DEDALO_AGENT_ALLOW_WRITE = 'true';
		try {
			const mcpSessionId = await initialize(admin);
			const list = await dispatchRqo(
				proxyRqo({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, mcpSessionId),
				contextFor(admin) as never,
			);
			const tools = (
				list.body as { data: { result: { tools: { name: string }[] } } }
			).data.result.tools.map((tool) => tool.name);
			// Admin: STILL read-only (the stdio confused-deputy wall, per request).
			expect(tools).not.toContain('dedalo_create_record');

			// The scoped user DOES see write tools under the opt-in.
			const userSession = await initialize(user);
			const userList = await dispatchRqo(
				proxyRqo({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, userSession),
				contextFor(user) as never,
			);
			const userTools = (
				userList.body as { data: { result: { tools: { name: string }[] } } }
			).data.result.tools.map((tool) => tool.name);
			expect(userTools).toContain('dedalo_set_field');
		} finally {
			process.env.DEDALO_AGENT_ALLOW_WRITE = '';
		}
	});
});

describe('agent_apply', () => {
	// The plan_hash_mismatch path itself is unit-covered in
	// agent_change_plan.test.ts; here the assertion is the DISPATCH wiring:
	// a plan a user cannot execute comes back as the coded envelope, result
	// false, through the same session+CSRF gates as everything else.
	test('a plan the user cannot execute returns the coded envelope', async () => {
		process.env.DEDALO_AGENT_ALLOW_WRITE = 'true';
		try {
			const plan = {
				plan_version: 1,
				summary: 'noop fixture',
				ops: [
					{
						op_id: 'op1',
						tool: 'dedalo_find_or_create',
						args: {
							section_tipo: 'test183',
							match: [{ field: 'test187', value: `never-${process.pid}`, lang: 'lg-spa' }],
						},
						summary: 'noop',
					},
				],
			};
			const result = await dispatchRqo(
				{
					action: 'agent_apply',
					dd_api: 'dd_mcp_api',
					options: { plan, plan_hash: 'not-even-checked-before-validation' },
				} as unknown as Rqo,
				contextFor(user) as never,
			);
			// user 16 has no write grants: the validation wall answers first — a
			// plan refused as a WHOLE is a THROWN failure (envelope v2, registry
			// status); the perm code is the wire identity, `op_id` an extension key.
			const body = result.body as {
				ok: boolean;
				error?: { code: string };
			};
			expect(result.status).toBe(403);
			expect(body.ok).toBe(false);
			expect('result' in body).toBe(false);
			expect(body.error?.code).toBe('perm.denied');
		} finally {
			process.env.DEDALO_AGENT_ALLOW_WRITE = '';
		}
	});

	test('missing plan/plan_hash is a 400', async () => {
		const result = await dispatchRqo(
			{
				action: 'agent_apply',
				dd_api: 'dd_mcp_api',
				options: { plan: { plan_version: 1 } },
			} as unknown as Rqo,
			contextFor(user) as never,
		);
		expect(result.status).toBe(400);
	});
});

// Sanity: the split really exists — the three scratch rows are present and the
// section really is gated by a component_filter (paranoia guard so the
// per-principal assertion above cannot silently rot into 0-versus-0).
test('fixture sanity: the gated section is filter-gated and holds the built split', async () => {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_test WHERE section_tipo = $1 AND section_id = ANY($2::int[])',
		[GATED_SECTION, `{${[...VISIBLE_IDS, HIDDEN_ID].join(',')}}`],
	)) as { n: number }[];
	expect(Number(rows[0]?.n)).toBe(3);

	const { getComponentFilterTipo } = await import('../../src/core/ontology/resolver.ts');
	expect(await getComponentFilterTipo(GATED_SECTION)).toBe(FILTER_COMPONENT);
});
