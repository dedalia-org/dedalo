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
			return { ok: result.body.ok, stored: getSession(token) };
		} finally {
			destroySession(token);
		}
	};

	describe('change_lang under DATA_LANG_SYNC (MED-3)', () => {
		test('floor: sync is ON in this child, and the probe is a valid, undeclared code', () => {
			expect(config.menu.dataLangSync).toBe(true);
			expect(isValidLang(UI_ONLY_LANG)).toBe(true);
			expect(installedDataLangs()).not.toContain(UI_ONLY_LANG);
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
