/**
 * THE RE-LOGIN IDENTITY KEY, MEASURED ON THE WIRE (LEAD-2 + CLIENT-5).
 *
 * The client's one identity primitive, `error_dispatch.relogin_identity`,
 * decides who just logged in from the LOGIN ENVELOPE. Every Mocha case of
 * test_relogin_identity.js feeds it a SYNTHETIC envelope
 * (`{ok:true, data:true, user_id:N}`), and the relogin tripwire used to pin
 * the server half by SPELLING (`extend: { user_id:` in dd_utils_api.ts). Both
 * stay green if the key moves on the wire — the handler keeps its spelling but
 * the envelope builder stops lifting `extend` to the top level, or the key is
 * renamed in one half — and then EVERY same-user re-login resolves 'unknown':
 * the page reloads and the user's queued save is dropped. Fail-closed, but work
 * is lost silently.
 *
 * So the two halves meet here, as an OUTCOME: a REAL login over HTTP
 * (`handleRequest`, password verified, session minted on the suite database),
 * the body parsed as the browser parses it, and the REAL client primitive
 * (client/dedalo/core/common/js/error_dispatch.js, imported unmodified) asked
 * about it — 'same' for the session's own user, 'differs' for another.
 * Positive control: the same body with the key nested (the PHP-era
 * `result_options` shape that once made the guard inert) is 'unknown'.
 *
 * THE TOKEN DOOR, the same way (WC-2026-10-11-session-user-beside-csrf-token):
 * every body that carries `csrf_token` carries `session_user_id` beside it, and
 * the client adopts the token only when `session_identity` says 'same' (or the
 * page has no user yet). Measured on REAL bodies of the three kinds the client
 * meets: the login answer, a CSRF refusal (the transparent-resend door), and the
 * success of a CSRF-EXEMPT action (the door that hands a valid token over).
 *
 * HARNESS. error_dispatch.js is copied VERBATIM, with its two import-free
 * leaves (api_error.js, error_policy.js), into a scratch tree; the one leaf that
 * needs a DOM (render_api_error.js) is written there as a stub — the identity
 * primitive never renders. No module is substituted in-process, so the bytes
 * under test are the shipped bytes and nothing leaks to a later file.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const REAL_CLIENT = join(REPO_ROOT, 'client', 'dedalo', 'core', 'common', 'js');

type Verdict = 'same' | 'differs' | 'unknown' | 'not_logged';
type SessionVerdict = 'same' | 'differs' | 'unknown' | 'anonymous_page';
let relogin_identity: (api_response: unknown, page_user_id: unknown) => Verdict;
let session_identity: (envelope: unknown, page_user_id: unknown) => SessionVerdict;
let scratchRoot = '';

beforeAll(async () => {
	scratchRoot = mkdtempSync(join(tmpdir(), 'dd-relogin-wire-'));
	const jsDir = join(scratchRoot, 'client', 'dedalo', 'core', 'common', 'js');
	mkdirSync(jsDir, { recursive: true });
	for (const name of ['error_dispatch.js', 'api_error.js', 'error_policy.js']) {
		cpSync(join(REAL_CLIENT, name), join(jsDir, name));
	}
	writeFileSync(
		join(jsDir, 'render_api_error.js'),
		[
			'error_text',
			'render_error_toast',
			'render_error_inline',
			'render_error_panel',
			'render_error_modal',
			'severity_type',
		]
			.map((name) => `export const ${name} = () => {}\n`)
			.join(''),
	);
	({ relogin_identity, session_identity } = (await import(
		join(jsDir, 'error_dispatch.js')
	)) as never);
});

afterAll(() => {
	if (scratchRoot !== '') rmSync(scratchRoot, { recursive: true, force: true });
});

/** A REAL login over HTTP: the parsed wire body and the minted session's user. */
async function realLogin(): Promise<{ body: Record<string, unknown>; userId: number }> {
	const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
		'../../src/core/test_data/suite_login.ts'
	);
	const { handleRequest } = await import('../../src/server.ts');
	const { SESSION_COOKIE, getSession, destroySession } = await import(
		'../../src/core/security/session_store.ts'
	);
	// BUILD the situation: the suite seed ships `root` with no password.
	await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
	const response = await handleRequest(
		new Request('http://localhost/api/v1/json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				dd_api: 'dd_utils_api',
				action: 'login',
				options: { username: 'root', auth: SUITE_LOGIN_PASSWORD },
			}),
		}),
		{ requestId: 'relogin_identity_wire', startedAt: 0 },
	);
	expect(response.status).toBe(200);
	const cookie = response.headers
		.getAll('set-cookie')
		.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
	const token = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '';
	expect(token.length, 'the login minted a session cookie').toBeGreaterThan(0);
	try {
		const session = getSession(token);
		expect(session, 'the minted session resolves').not.toBeNull();
		return {
			body: (await response.json()) as Record<string, unknown>,
			userId: (session as { userId: number }).userId,
		};
	} finally {
		destroySession(token);
	}
}

describe('the login envelope carries the identity the client door reads', () => {
	test('a real login body: the session user is "same", another user "differs"', async () => {
		const { body, userId } = await realLogin();
		expect(body.ok).toBe(true);
		// the page holds a number; the wire may carry either — both are 'same'
		expect(relogin_identity(body, userId)).toBe('same');
		expect(relogin_identity(body, String(userId))).toBe('same');
		expect(relogin_identity(body, userId + 1000)).toBe('differs');
	});

	test('positive control: the key moved off the top level is "unknown" (the inert-guard shape)', async () => {
		const { body, userId } = await realLogin();
		const { user_id, ...rest } = body;
		expect(user_id, 'precondition: the real body has a top-level user_id').toBeDefined();
		expect(relogin_identity({ ...rest, result_options: { user_id } }, userId)).toBe('unknown');
		expect(relogin_identity({ ...rest, data: { user_id } }, userId)).toBe('not_logged');
	});
});

/** A REAL API call on an authenticated session, the parsed wire body. */
async function realCall(
	rqo: Record<string, unknown>,
	csrfHeader: string | null,
): Promise<{ status: number; body: Record<string, unknown>; userId: number }> {
	const { handleRequest } = await import('../../src/server.ts');
	const { createSession, destroySession } = await import(
		'../../src/core/security/session_store.ts'
	);
	const userId = -1;
	const token = createSession(userId, 'root', true);
	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Cookie: `dedalo_ts_session=${token}`,
		};
		if (csrfHeader !== null) headers['X-Dedalo-Csrf-Token'] = csrfHeader;
		const response = await handleRequest(
			new Request('http://localhost/dedalo/core/api/v1/json/', {
				method: 'POST',
				headers,
				body: JSON.stringify(rqo),
			}),
			{ requestId: 'session_identity_wire', startedAt: 0 },
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
			userId,
		};
	} finally {
		destroySession(token);
	}
}

describe('every token on the wire names its owner, and the client token door reads it', () => {
	test("the login answer: its token is the session user's", async () => {
		const { body, userId } = await realLogin();
		expect(typeof body.csrf_token).toBe('string');
		expect(session_identity(body, userId)).toBe('same');
		expect(session_identity(body, userId + 1000)).toBe('differs');
	});

	test('a CSRF refusal (the resend door): the fresh token is named, so another page user never resends with it', async () => {
		const { status, body, userId } = await realCall(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: { model: 'section', tipo: 'test3', section_tipo: 'test3' },
				sqo: { section_tipo: ['test3'], limit: 1 },
			},
			'stale-token',
		);
		expect(status).toBe(403);
		expect((body.error as { code: string }).code).toBe('auth.csrf_failed');
		expect(typeof body.csrf_token).toBe('string');
		expect(session_identity(body, userId)).toBe('same');
		expect(session_identity(body, userId + 1000)).toBe('differs');
	});

	test('a CSRF-EXEMPT success (get_environment): the valid token it hands over is named too', async () => {
		const { status, body, userId } = await realCall(
			{ action: 'get_environment', dd_api: 'dd_core_api' },
			null,
		);
		expect(status).toBe(200);
		expect(typeof body.csrf_token).toBe('string');
		expect(session_identity(body, userId)).toBe('same');
		expect(session_identity(body, userId + 1000)).toBe('differs');
	});

	test('positive control: a token without its owner is "unknown" for a page with a user (fail closed)', async () => {
		const { body, userId } = await realCall(
			{ action: 'get_environment', dd_api: 'dd_core_api' },
			null,
		);
		const { session_user_id: _owner, ...nameless } = body;
		expect(_owner, 'precondition: the real body names the owner').toBeDefined();
		expect(session_identity(nameless, userId)).toBe('unknown');
		expect(session_identity(nameless, null)).toBe('anonymous_page');
	});

	test("a login on a request that still carries an OLD session answers with the NEW session's token and owner", async () => {
		// the chokepoint appends csrf_token + session_user_id from the request's
		// session; the login mints a new one mid-handler and owns both keys — they
		// must never be overwritten with the previous session's (whose token the
		// new cookie does not match, and whose owner may be another user)
		const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
			'../../src/core/test_data/suite_login.ts'
		);
		const { handleRequest } = await import('../../src/server.ts');
		const { SESSION_COOKIE, createSession, getSession, destroySession } = await import(
			'../../src/core/security/session_store.ts'
		);
		await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
		const oldToken = createSession(4242, 'zz_previous_session_user', false);
		let newToken = '';
		try {
			const response = await handleRequest(
				new Request('http://localhost/api/v1/json', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${oldToken}` },
					body: JSON.stringify({
						dd_api: 'dd_utils_api',
						action: 'login',
						options: { username: 'root', auth: SUITE_LOGIN_PASSWORD },
					}),
				}),
				{ requestId: 'relogin_identity_wire_old_session', startedAt: 0 },
			);
			expect(response.status).toBe(200);
			const cookie = response.headers
				.getAll('set-cookie')
				.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
			newToken = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '';
			const fresh = getSession(newToken) as { userId: number; csrfToken: string } | null;
			expect(fresh, 'the login minted a new session').not.toBeNull();
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.csrf_token).toBe(fresh?.csrfToken);
			expect(body.session_user_id).toBe(fresh?.userId);
			expect(session_identity(body, 4242)).toBe('differs');
		} finally {
			destroySession(oldToken);
			if (newToken !== '') destroySession(newToken);
		}
	});
});
