/**
 * change_lang under DEDALO_DATA_LANG_SYNC (review MED-3) — the data language
 * follows the interface language ONLY when that language is a declared data
 * language of the installation; otherwise the data language is left unchanged.
 *
 * Before, sync copied ANY grammar-valid application language into the session's
 * data language: an install offering an interface language it does not
 * catalogue in got a session data language no read resolves (and that
 * tool_identify's cluster then refused, review MED-3).
 *
 * ISOLATED GATE: DATA_LANG_SYNC is boot config (config.menu.dataLangSync), so the
 * file runs in a child with it pinned true (ISOLATED_GATE_ENV); the tier process
 * only mirrors that run. Driven through the real dispatch chokepoint.
 */

import { describe, expect, test } from 'bun:test';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const { config } = await import('../../src/config/config.ts');
	const { dispatchRqo } = await import('../../src/core/api/dispatch.ts');
	const { isValidLang } = await import('../../src/core/concepts/ontology.ts');
	const { installedDataLangs } = await import('../../src/core/section/record/save_component.ts');
	const { createSession, destroySession, getSession } = await import(
		'../../src/core/security/session_store.ts'
	);
	type Rqo = import('../../src/core/concepts/rqo.ts').Rqo;
	type ApiRequestContext = import('../../src/core/api/dispatch.ts').ApiRequestContext;

	/** An interface language that is NOT a data language (grammar-valid, undeclared). */
	const UI_ONLY_LANG = 'lg-zzzq';
	/** A declared DATA language that is not an interface language of this child. */
	const DATA_ONLY_LANG = 'lg-nep';
	/** Grammar-valid, and neither an interface nor a data language. */
	const NOT_AN_INTERFACE_LANG = 'lg-zzzr';

	/** One change_lang on a fresh superuser session; answers the session after it. */
	const changeLang = async (options: Record<string, string>) => {
		const token = createSession(-1, 'root', true);
		try {
			const session = getSession(token);
			if (session === null) throw new Error('session vanished');
			const context: ApiRequestContext = {
				requestId: 'test',
				clientIp: '127.0.0.1',
				session,
				sessionToken: token,
				csrfCandidate: session.csrfToken,
			};
			const result = await dispatchRqo(
				{ dd_api: 'dd_utils_api', action: 'change_lang', options } as Rqo,
				context,
			);
			return {
				ok: result.body.ok,
				code: (result.body.error as { code?: string } | undefined)?.code,
				cookie: result.setPreauthLangCookie,
				stored: getSession(token),
			};
		} finally {
			destroySession(token);
		}
	};

	/**
	 * One LOGIN carrying the pre-auth language cookie `preauthLang`; answers the
	 * minted session (destroyed after). The suite's root credential is BUILT here.
	 */
	const loginWithCookie = async (preauthLang: string) => {
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
				preauthLang,
				csrfCandidate: null,
			},
		);
		const fresh = result.setSessionToken as string;
		try {
			return { ok: result.body.ok, stored: getSession(fresh) };
		} finally {
			destroySession(fresh);
		}
	};

	describe('change_lang under DATA_LANG_SYNC (MED-3)', () => {
		test('floor: sync is ON in this child, and the probe is a valid, undeclared code', () => {
			expect(config.menu.dataLangSync).toBe(true);
			expect(isValidLang(UI_ONLY_LANG)).toBe(true);
			expect(installedDataLangs()).not.toContain(UI_ONLY_LANG);
			// …and an INTERFACE language of this child (pinned DEDALO_APPLICATION_LANGS):
			// the case the sync rule exists for — offered on the menu, not catalogued in.
			expect(Object.hasOwn(config.lang.applicationLangs, UI_ONLY_LANG)).toBe(true);
		});

		test('re-review MED-1(a): LOGIN adopting an interface-only cookie leaves the data lang alone', async () => {
			const { ok, stored } = await loginWithCookie(UI_ONLY_LANG);
			expect(ok).toBe(true);
			expect(stored?.applicationLang).toBe(UI_ONLY_LANG);
			expect(stored?.dataLang).toBeNull();
		});

		test('LOGIN adopting a cookie that IS a data language drives the data lang (control)', async () => {
			const { ok, stored } = await loginWithCookie('lg-cat');
			expect(ok).toBe(true);
			expect(stored?.applicationLang).toBe('lg-cat');
			expect(stored?.dataLang).toBe('lg-cat');
		});

		test('an interface language that is a DATA language drives the data language', async () => {
			const { ok, stored } = await changeLang({ dedalo_application_lang: 'lg-cat' });
			expect(ok).toBe(true);
			expect(stored?.applicationLang).toBe('lg-cat');
			expect(stored?.dataLang).toBe('lg-cat');
		});

		test('an interface language that is NOT a data language leaves the data language unchanged', async () => {
			const { ok, stored } = await changeLang({ dedalo_application_lang: UI_ONLY_LANG });
			expect(ok).toBe(true);
			expect(stored?.applicationLang).toBe(UI_ONLY_LANG);
			expect(stored?.dataLang).toBeNull();
		});

		test('re-review LOW-5: a data language drives the interface one ONLY when it is an interface language', async () => {
			// FLOOR: lg-nep is a declared data language, and NOT an interface language
			// of this child (pinned DEDALO_APPLICATION_LANGS).
			expect(installedDataLangs()).toContain(DATA_ONLY_LANG);
			expect(Object.hasOwn(config.lang.applicationLangs, DATA_ONLY_LANG)).toBe(false);
			const { ok, stored } = await changeLang({ dedalo_data_lang: DATA_ONLY_LANG });
			expect(ok).toBe(true);
			expect(stored?.dataLang).toBe(DATA_ONLY_LANG);
			expect(stored?.applicationLang).toBeNull();
		});

		test('re-review LOW-5: an interface language outside DEDALO_APPLICATION_LANGS is refused, nothing stored', async () => {
			expect(isValidLang(NOT_AN_INTERFACE_LANG)).toBe(true);
			expect(Object.hasOwn(config.lang.applicationLangs, NOT_AN_INTERFACE_LANG)).toBe(false);
			for (const options of <Record<string, string>[]>[
				{ dedalo_application_lang: NOT_AN_INTERFACE_LANG },
				{ dedalo_application_lang: NOT_AN_INTERFACE_LANG, dedalo_data_lang: 'lg-eng' },
			]) {
				const { ok, code, stored, cookie } = await changeLang(options);
				const label = JSON.stringify(options);
				expect(ok, label).toBe(false);
				expect(code, label).toBe('request.invalid_options');
				expect(stored?.applicationLang, label).toBeNull();
				expect(stored?.dataLang, label).toBeNull();
				expect(cookie, label).toBeUndefined();
			}
		});

		test('a data language drives the interface one (declared), an undeclared one is refused', async () => {
			const driven = await changeLang({ dedalo_data_lang: 'lg-eng' });
			expect(driven.ok).toBe(true);
			expect(driven.stored?.dataLang).toBe('lg-eng');
			expect(driven.stored?.applicationLang).toBe('lg-eng');
			const refused = await changeLang({ dedalo_data_lang: UI_ONLY_LANG });
			expect(refused.ok).toBe(false);
			expect(refused.stored?.dataLang).toBeNull();
			expect(refused.stored?.applicationLang).toBeNull();
		});
	});
}
