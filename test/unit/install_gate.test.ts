/**
 * P1 gate — install window dispatch gate + synthetic installer context (DEC-19,
 * hardened by OPS-01 2026-07-28).
 *
 * The install surface (dd_utils_api:get_install_context + dd_utils_api:install)
 * is pre-auth ONLY on a genuinely fresh box (INSTALL_MODE) or a mid-wizard one
 * (installInProgress — status 'configured' after persist_config), IP-gated, and
 * GONE (404) once sealed OR on a configured/migrated instance. These tests flip
 * the scratch state file's install_status (bun test isolates DEDALO_TS_STATE_PATH)
 * and drive dispatchRqo directly.
 *
 * This test PROCESS is a configured box (a real .env is present ⇒ INSTALL_MODE
 * false), so it exercises the mid-wizard reachable path via status 'configured';
 * the genuinely-fresh INSTALL_MODE path is exercised end-to-end against a fresh
 * temp DB in the e2e phase and in install_mode_boot. The OPS-01 case — a
 * configured box with NO/incomplete wizard status must be 404 — is asserted
 * directly below.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { setServerState } from '../../src/core/resolve/server_state.ts';

function anon(clientIp = 'local'): ApiRequestContext {
	return { requestId: 't', clientIp, session: null, csrfCandidate: null };
}

afterEach(() => {
	setServerState({ install_status: undefined });
	delete process.env.DEDALO_INSTALL_ALLOWED_IPS;
});

describe('install window gate (P1)', () => {
	test('get_install_context: pre-auth while install in progress → synthetic installer context', async () => {
		setServerState({ install_status: 'configured' });
		const res = await dispatchRqo(
			{ action: 'get_install_context', dd_api: 'dd_utils_api' } as Rqo,
			anon(),
		);
		// This test owns the GATE contract: a reachable install window serves the
		// synthetic installer element pre-auth. The installer PAYLOAD details
		// (init_test, hierarchies — the vendored hierarchy.json manifest read
		// through hierarchy_meta.ts, environment-dependent) are the handler's
		// concern, exercised against a fresh temp DB in install_e2e.
		expect(res.status).toBe(200);
		const result = res.body.data as { model: string; properties: Record<string, unknown> }[];
		expect(Array.isArray(result)).toBe(true);
		expect(result[0]?.model).toBe('installer');
		expect((result[0]?.properties as Record<string, unknown>).needs_config).toBe(true);
	});

	test('get_install_context: SEALED → 404 (surface gone)', async () => {
		setServerState({ install_status: 'sealed' });
		const res = await dispatchRqo(
			{ action: 'get_install_context', dd_api: 'dd_utils_api' } as Rqo,
			anon(),
		);
		expect(res.status).toBe(404);
	});

	// OPS-01 (2026-07-28 audit): a CONFIGURED / PHP-migrated instance carries NO
	// install_status (the migration drops it) yet is fully operational. It must
	// answer 404 — never expose the unauthenticated installer. This process is a
	// configured box (INSTALL_MODE false), so undefined status is exactly that
	// shape. Keying the gate on `!isSealed()` alone regressed this to a 200.
	test('get_install_context: configured/migrated instance (no status) → 404 (OPS-01)', async () => {
		setServerState({ install_status: undefined });
		const res = await dispatchRqo(
			{ action: 'get_install_context', dd_api: 'dd_utils_api' } as Rqo,
			anon(),
		);
		expect(res.status).toBe(404);
	});

	test('install step router: pre-auth to_update routes (not 401) while install in progress', async () => {
		setServerState({ install_status: 'configured' });
		const res = await dispatchRqo(
			{ action: 'install', dd_api: 'dd_utils_api', options: { action: 'to_update' } } as Rqo,
			anon(),
		);
		// to_update is unsupported by design: a refusal (envelope v2 —
		// `engine.uncovered_scope`, 503, since the P1 install sweep), NOT the 401
		// the auth gate would answer.
		expect(res.status).toBe(503);
		expect(res.body.ok).toBe(false);
		expect('result' in res.body).toBe(false);
		expect((res.body.error as { code: string }).code).toBe('engine.uncovered_scope');
	});

	test('install: SEALED → 404 for every step', async () => {
		setServerState({ install_status: 'sealed' });
		const res = await dispatchRqo(
			{
				action: 'install',
				dd_api: 'dd_utils_api',
				options: { action: 'check_directories' },
			} as Rqo,
			anon(),
		);
		expect(res.status).toBe(404);
	});

	test('IP allowlist: a disallowed address is refused (403) while install in progress', async () => {
		setServerState({ install_status: 'configured' });
		process.env.DEDALO_INSTALL_ALLOWED_IPS = '10.0.0.5';
		const res = await dispatchRqo(
			{ action: 'get_install_context', dd_api: 'dd_utils_api' } as Rqo,
			anon('192.168.1.9'),
		);
		expect(res.status).toBe(403);
		// The refusal names the address it saw — the one the operator must add
		// (WC-2026-10-08-install-ip-denied-names-address).
		const error = res.body.error as { code: string; details?: Record<string, unknown> };
		expect(error.code).toBe('install.ip_denied');
		expect(error.details).toEqual({ client_address: '192.168.1.9' });
	});

	test('IP allowlist: loopback token admits the local address', async () => {
		setServerState({ install_status: 'configured' });
		process.env.DEDALO_INSTALL_ALLOWED_IPS = 'loopback';
		const res = await dispatchRqo(
			{ action: 'get_install_context', dd_api: 'dd_utils_api' } as Rqo,
			anon('local'),
		);
		expect(res.status).toBe(200);
	});

	test('record-writing steps require a session even while install in progress', async () => {
		setServerState({ install_status: 'configured' });
		const res = await dispatchRqo(
			{
				action: 'install',
				dd_api: 'dd_utils_api',
				options: { action: 'register_tools' },
			} as Rqo,
			anon(),
		);
		expect(res.status).toBe(401);
	});

	// Regression (found driving the real browser wizard): the router spread the
	// ASYNC verifyActiveConfig without awaiting, so the body was `{}` and the
	// wizard stuck at Verify. A mismatched entity keeps this DB-free.
	test('verify_active_config is AWAITED — body carries the poll answer, not {}', async () => {
		setServerState({ install_status: 'configured' });
		const res = await dispatchRqo(
			{
				action: 'install',
				dd_api: 'dd_utils_api',
				options: {
					action: 'verify_active_config',
					entity: 'definitely-not-the-active-entity',
					db_database: 'x',
				},
			} as Rqo,
			anon(),
		);
		// A mismatched entity is the ANSWER to the poll, not an engine failure: the
		// envelope succeeds (200) and carries `active` as an extension key — NOT
		// absent (the {} bug) — with the verdict on `data`.
		expect(res.status).toBe(200);
		expect(typeof res.body.active).toBe('boolean');
		expect(res.body.data).toBe(false);
		expect(res.body.ok).toBe(true);
	});

	// Regression (found driving the real browser wizard): after persist_config
	// the server restarts OUT of install mode (config.installMode=false) but the
	// install is not sealed — `start` must still resume the wizard, or a reload
	// strands on the login form with no schema/root yet.
	test('start resumes the wizard while an install is in progress (configured, not sealed)', async () => {
		setServerState({ install_status: 'configured' });
		const res = await dispatchRqo({ action: 'start', dd_api: 'dd_core_api' } as Rqo, anon());
		const ctx = (res.body.data as { context?: { model?: string }[] })?.context ?? [];
		expect(ctx[0]?.model).toBe('installer');
	});

	test('start serves LOGIN once sealed (and for an existing unconfigured deployment)', async () => {
		const { installInProgress, isSealed } = await import('../../src/core/install/gate.ts');
		setServerState({ install_status: 'sealed' });
		expect(isSealed()).toBe(true);
		expect(installInProgress()).toBe(false);
		const sealed = await dispatchRqo({ action: 'start', dd_api: 'dd_core_api' } as Rqo, anon());
		expect((sealed.body.data as { context?: { model?: string }[] })?.context?.[0]?.model).toBe(
			'login',
		);
		// An existing (PHP-provisioned) deployment never ran the TS installer →
		// status undefined → NOT in progress → login, never the wizard.
		setServerState({ install_status: undefined });
		expect(installInProgress()).toBe(false);
	});
});
