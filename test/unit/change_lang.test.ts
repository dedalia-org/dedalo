/**
 * change_lang — the menu's interface/data language selectors (PHP dd_utils_api::
 * change_lang). Regression coverage for the bug where BOTH selectors were inert:
 * the action was never registered, so dispatch returned 400 and nothing was
 * persisted, so the post-reload page rebuilt with the install-default language.
 *
 * These tests drive the real dispatch chokepoint end-to-end: persist the choice
 * on the session, then confirm the very next request's environment reflects it
 * (via the request-scoped language context) — with zero cross-request bleed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	createSession,
	destroySession,
	getSession,
} from '../../src/core/security/session_store.ts';

let token: string;

/** Grammar-valid, and not a data language of the suite installation (floored in the test). */
const UNDECLARED_DATA_LANG = 'lg-zzzq';

beforeEach(() => {
	// A real superuser session (userId -1). createSession returns the raw cookie
	// token; the request context needs both the resolved session and that token.
	token = createSession(-1, 'root', true);
});

afterEach(() => {
	destroySession(token);
});

/** An authenticated, CSRF-valid context for the freshly-created session. */
function contextFor(rawToken: string): ApiRequestContext {
	const session = getSession(rawToken);
	if (session === null) throw new Error('session vanished');
	return {
		requestId: 'test',
		clientIp: '127.0.0.1',
		session,
		sessionToken: rawToken,
		csrfCandidate: session.csrfToken, // pass the CSRF gate
	};
}

describe('change_lang action', () => {
	test('persists the data language onto the session', async () => {
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_data_lang: 'lg-eng' },
			} as Rqo,
			contextFor(token),
		);
		expect(result.status).toBe(200);
		expect(result.body.data).toBe(true);
		// Re-read the session: the choice survived.
		expect(getSession(token)?.dataLang).toBe('lg-eng');
		expect(getSession(token)?.applicationLang).toBeNull(); // untouched
	});

	test('persists the interface (application) language onto the session', async () => {
		await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: 'lg-cat' },
			} as Rqo,
			contextFor(token),
		);
		expect(getSession(token)?.applicationLang).toBe('lg-cat');
	});

	test('the next request environment reflects the stored languages', async () => {
		// Store both, then ask for the environment on the SAME session.
		await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: 'lg-cat', dedalo_data_lang: 'lg-eng' },
			} as Rqo,
			contextFor(token),
		);
		const env = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			contextFor(token),
		);
		const pageGlobals = (env.body.data as { page_globals?: Record<string, unknown> })?.page_globals;
		expect(pageGlobals?.dedalo_application_lang).toBe('lg-cat');
		expect(pageGlobals?.dedalo_data_lang).toBe('lg-eng');
	});

	test('rejects an invalid language tag without persisting it (SEC §7.6)', async () => {
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_data_lang: "lg-eng'; DROP TABLE" },
			} as Rqo,
			contextFor(token),
		);
		expect(result.body.ok).toBe(false);
		expect((result.body.error as { code: string }).code).toBe('request.invalid_options');
		expect(getSession(token)?.dataLang).toBeNull();
	});

	test('re-review LOW-5: refuses an interface language outside DEDALO_APPLICATION_LANGS — session unchanged', async () => {
		const { config } = await import('../../src/config/config.ts');
		const { isValidLang } = await import('../../src/core/concepts/ontology.ts');
		// FLOOR: grammar-valid (only MEMBERSHIP can refuse it), and not an interface language.
		expect(isValidLang(UNDECLARED_DATA_LANG)).toBe(true);
		expect(Object.hasOwn(config.lang.applicationLangs, UNDECLARED_DATA_LANG)).toBe(false);
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: UNDECLARED_DATA_LANG },
			} as Rqo,
			contextFor(token),
		);
		expect(result.body.ok).toBe(false);
		expect((result.body.error as { code: string }).code).toBe('request.invalid_options');
		expect(getSession(token)?.applicationLang).toBeNull();
		expect(result.setPreauthLangCookie).toBeUndefined();
	});

	test('MED-3: refuses a data language this installation does not declare — session unchanged', async () => {
		const { isValidLang } = await import('../../src/core/concepts/ontology.ts');
		const { installedDataLangs } = await import('../../src/core/section/record/save_component.ts');
		// FLOOR: the probe is grammar-valid (only MEMBERSHIP can refuse it) and undeclared.
		expect(isValidLang(UNDECLARED_DATA_LANG)).toBe(true);
		expect(installedDataLangs()).not.toContain(UNDECLARED_DATA_LANG);
		for (const options of [
			{ dedalo_data_lang: UNDECLARED_DATA_LANG },
			{ dedalo_application_lang: 'lg-cat', dedalo_data_lang: UNDECLARED_DATA_LANG },
		]) {
			const result = await dispatchRqo(
				{ dd_api: 'dd_utils_api', action: 'change_lang', options } as Rqo,
				contextFor(token),
			);
			const label = JSON.stringify(options);
			expect(result.body.ok, label).toBe(false);
			expect((result.body.error as { code: string }).code, label).toBe('request.invalid_options');
			// Nothing stored — neither half of a mixed request, nor the cookie.
			expect(getSession(token)?.dataLang, label).toBeNull();
			expect(getSession(token)?.applicationLang, label).toBeNull();
			expect(result.setPreauthLangCookie, label).toBeUndefined();
		}
		// FLOOR: the same door DOES store a declared data language.
		await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_data_lang: 'lg-eng' },
			} as Rqo,
			contextFor(token),
		);
		expect(getSession(token)?.dataLang).toBe('lg-eng');
	});

	test('re-review MED-1(b): a STORED undeclared session data lang is served as the menu data lang', async () => {
		const { setSessionLangs } = await import('../../src/core/security/session_store.ts');
		const { installedDataLangs } = await import('../../src/core/section/record/save_component.ts');
		const { config } = await import('../../src/config/config.ts');
		// FLOOR: the probe is undeclared, and the menu data lang is a declared one.
		expect(installedDataLangs()).not.toContain(UNDECLARED_DATA_LANG);
		expect(installedDataLangs()).toContain(config.menu.dataLang);
		// BUILD the situation a legacy session (or any door that bypassed the
		// change_lang rule) leaves behind: the session row ALREADY holds it.
		setSessionLangs(token, { dataLang: UNDECLARED_DATA_LANG });
		expect(getSession(token)?.dataLang).toBe(UNDECLARED_DATA_LANG);
		const env = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			contextFor(token),
		);
		const pageGlobals = (env.body.data as { page_globals?: Record<string, unknown> })?.page_globals;
		expect(pageGlobals?.dedalo_data_lang).toBe(config.menu.dataLang);
		// CONTROL: a declared stored data lang is served as stored.
		setSessionLangs(token, { dataLang: 'lg-eng' });
		const served = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			contextFor(token),
		);
		expect(
			(served.body.data as { page_globals?: Record<string, unknown> })?.page_globals
				?.dedalo_data_lang,
		).toBe('lg-eng');
	});

	test('a session with no override falls back to the install default', async () => {
		// No change_lang call — the environment must carry the configured default,
		// proving the override is opt-in and never bleeds from another request.
		const env = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			contextFor(token),
		);
		const pageGlobals = (env.body.data as { page_globals?: Record<string, unknown> })?.page_globals;
		const { config } = await import('../../src/config/config.ts');
		expect(pageGlobals?.dedalo_data_lang).toBe(config.menu.dataLang);
		expect(pageGlobals?.dedalo_application_lang).toBe(config.menu.applicationLang);
	});
});

/**
 * PRE-AUTH change_lang (the LOGIN PANEL's selector). There is no session row to
 * store the choice in, so it rides an anonymous cookie; without this the login
 * form snapped back to the install default on the reload after every switch.
 */
describe('change_lang before login', () => {
	/** An anonymous context, optionally carrying the pre-auth language cookie. */
	function anonymousContext(preauthLang?: string): ApiRequestContext {
		return {
			requestId: 'test',
			clientIp: '127.0.0.1',
			session: null,
			sessionToken: null,
			preauthLang: preauthLang ?? null,
			csrfCandidate: null,
		};
	}

	test('is reachable without a session and answers with the language cookie', async () => {
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: 'lg-cat' },
			} as Rqo,
			anonymousContext(),
		);
		expect(result.status).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(result.setPreauthLangCookie).toBe('lg-cat');
	});

	test('the cookie drives the next anonymous request environment', async () => {
		const env = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			anonymousContext('lg-cat'),
		);
		const pageGlobals = (env.body.data as { page_globals?: Record<string, unknown> })?.page_globals;
		expect(pageGlobals?.dedalo_application_lang).toBe('lg-cat');
	});

	test('a cookie naming a lang this install does not serve is ignored', async () => {
		const { config } = await import('../../src/config/config.ts');
		const env = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			anonymousContext("lg-eng'; DROP TABLE"),
		);
		const pageGlobals = (env.body.data as { page_globals?: Record<string, unknown> })?.page_globals;
		expect(pageGlobals?.dedalo_application_lang).toBe(config.menu.applicationLang);
	});

	test('refuses a data-language-only change when there is no session', async () => {
		// There is nowhere to put it: the cookie carries the APPLICATION language
		// alone. Answering ok(true) while storing nothing would be the silent no-op
		// the "never narrow scope" law forbids.
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_data_lang: 'lg-eng' },
			} as Rqo,
			anonymousContext(),
		);
		expect(result.body.ok).toBe(false);
		expect((result.body.error as { code: string }).code).toBe('auth.not_logged');
		expect(result.setPreauthLangCookie).toBeUndefined();
	});

	test('an AUTHENTICATED change refreshes the cookie too', async () => {
		// The cookie outlives the session and login adopts it, so a stale one would
		// reinstate itself over every later in-app choice. Both stores move together.
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: 'lg-cat' },
			} as Rqo,
			contextFor(token),
		);
		expect(getSession(token)?.applicationLang).toBe('lg-cat');
		expect(result.setPreauthLangCookie).toBe('lg-cat');
	});

	test('the session ALWAYS wins over the cookie', async () => {
		await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: 'lg-spa' },
			} as Rqo,
			contextFor(token),
		);
		const authenticated = contextFor(token);
		authenticated.preauthLang = 'lg-cat';
		const env = await dispatchRqo(
			{ dd_api: 'dd_core_api', action: 'get_environment' } as Rqo,
			authenticated,
		);
		const pageGlobals = (env.body.data as { page_globals?: Record<string, unknown> })?.page_globals;
		expect(pageGlobals?.dedalo_application_lang).toBe('lg-spa');
	});
});

/**
 * THE TRANSPORT SEAM. The tests above inject `preauthLang` onto the context and
 * read `setPreauthLangCookie` off the result — they would stay green with the
 * cookie never read from, nor written to, an actual HTTP header. These drive
 * `handleRequest` so the browser-facing halves are gated too.
 */
describe('the dedalo_lang cookie over HTTP', () => {
	const httpContext = { requestId: 'test', startedAt: 0 };

	function apiRequest(body: unknown, cookie?: string): Request {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (cookie !== undefined) headers.cookie = cookie;
		return new Request('http://localhost/api/v1/json', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
	}

	test('an anonymous change_lang answers with a Set-Cookie the browser will keep', async () => {
		const { handleRequest } = await import('../../src/server.ts');
		const response = await handleRequest(
			apiRequest({
				dd_api: 'dd_utils_api',
				action: 'change_lang',
				options: { dedalo_application_lang: 'lg-cat' },
			}),
			httpContext,
		);
		expect(response.status).toBe(200);
		const setCookie = response.headers
			.getAll('set-cookie')
			.find((c) => c.startsWith('dedalo_lang='));
		expect(setCookie).toBeDefined();
		expect(setCookie).toContain('dedalo_lang=lg-cat');
		// A preference, not a credential: unreadable by JS, and it must survive the
		// browser session or the login form forgets the choice again.
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Max-Age=31536000');
		expect(setCookie).toContain('Path=/');
	});

	test('the cookie coming BACK drives the anonymous login page language', async () => {
		const { handleRequest } = await import('../../src/server.ts');
		const response = await handleRequest(
			apiRequest({ dd_api: 'dd_core_api', action: 'get_environment' }, 'dedalo_lang=lg-cat'),
			httpContext,
		);
		const body = (await response.json()) as {
			data?: { page_globals?: Record<string, unknown> };
		};
		expect(body.data?.page_globals?.dedalo_application_lang).toBe('lg-cat');
	});
});

/**
 * ADOPTION AT LOGIN — the app must open in the language the login form was just
 * switched to. A REAL login (password verified, session minted), because the
 * adoption hangs off the fresh session token: mocking it would gate nothing.
 */
describe('the login panel language survives the login', () => {
	test('the cookie language lands on the freshly minted session', async () => {
		const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
			'../../src/core/test_data/suite_login.ts'
		);
		// BUILD the situation: the suite database's seed ships `root` with no
		// password at all, so there is nothing to log in with until we set one.
		await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'login',
				options: { username: 'root', auth: SUITE_LOGIN_PASSWORD },
			} as Rqo,
			{
				requestId: 'test',
				clientIp: '127.0.0.1',
				session: null,
				sessionToken: null,
				preauthLang: 'lg-cat',
				csrfCandidate: null,
			},
		);
		expect(result.body.ok).toBe(true);
		const fresh = result.setSessionToken as string;
		try {
			expect(getSession(fresh)?.applicationLang).toBe('lg-cat');
		} finally {
			destroySession(fresh);
		}
	});

	test('a cookie naming a lang this install does not serve is NOT adopted', async () => {
		const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
			'../../src/core/test_data/suite_login.ts'
		);
		await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
		const result = await dispatchRqo(
			{
				dd_api: 'dd_utils_api',
				action: 'login',
				options: { username: 'root', auth: SUITE_LOGIN_PASSWORD },
			} as Rqo,
			{
				requestId: 'test',
				clientIp: '127.0.0.1',
				session: null,
				sessionToken: null,
				preauthLang: "lg-eng'; DROP TABLE",
				csrfCandidate: null,
			},
		);
		const fresh = result.setSessionToken as string;
		try {
			expect(getSession(fresh)?.applicationLang).toBeNull();
		} finally {
			destroySession(fresh);
		}
	});
});
