/**
 * THE TWO STATIC THESAURUS PICKS NEVER FOLLOW THE REQUEST (T2 B10 review M3/M6;
 * owner ruling: install DATA_LANG_DEFAULT, static, cached).
 *
 *   - term_resolver `getMainLang('hierarchy1')` — the main lang a hierarchy1
 *     term falls back to (v6 get_main_lang → DEDALO_DATA_LANG_DEFAULT). It is
 *     CACHED PER SECTION TIPO, so a request lang read here would be served to
 *     every later request: the first lane fills the cache, the second must
 *     still get the install pick.
 *   - indexation_grid `langData` — when a cell has no value in the request data
 *     lang, the first fallback candidate is DATA_LANG_DEFAULT (v6 $main_lang),
 *     then lg-nolan, then the project langs.
 *
 * Both used to read the MENU's DATA_LANG (`config.menu.dataLang`, a per-session
 * starting point) until 69a3d01dfc. To tell the two install values apart this
 * file runs as an ISOLATED GATE with DATA_LANG pinned to lg-eng
 * (`ISOLATED_GATE_ENV`, test/helpers/isolated_gate.ts — config is read once at
 * module load), while the suite's DATA_LANG_DEFAULT stays lg-spa; the floor
 * below proves the two differ, or the menu-lang mutation would be invisible.
 * The two REQUEST data langs differ from both, so a pick following the request
 * is red too. The grid items carry a value in each of those three langs plus
 * lg-nolan, so each wrong pick names a different value.
 *
 * Reads only: the test TLD's repo-owned `test52` (translatable — floored) and
 * the hierarchy1 TLD walk. Nothing is written.
 */

import { describe, expect, test } from 'bun:test';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file needs DATA_LANG
// pinned at boot (ISOLATED_GATE_ENV) — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const { config } = await import('../../src/config/config.ts');
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	const { getTranslatableByTipo } = await import('../../src/core/ontology/resolver.ts');
	const { runWithRequestLangs } = await import('../../src/core/resolve/request_lang.ts');
	const { langData } = await import('../../src/core/section/indexation_grid.ts');
	const { getMainLang } = await import('../../src/core/ts_object/term_resolver.ts');

	const MAIN = config.lang.dataLangDefault;
	const MENU = config.menu.dataLang;
	/** Two request data langs, both apart from MAIN and MENU. */
	const REQUEST_LANGS = config.menu.projectsDefaultLangs
		.filter((code) => code !== MAIN && code !== MENU)
		.slice(0, 2);
	const TRANSLATABLE = 'test52';

	const inRequest = <T>(dataLang: string, fn: () => Promise<T>): Promise<T> =>
		runWithRequestLangs({ applicationLang: dataLang, dataLang }, fn);

	describe('floor: the situation can tell the picks apart', () => {
		test('DATA_LANG (pinned) ≠ DATA_LANG_DEFAULT, and two request langs differ from both', () => {
			expect(MENU).toBe('lg-eng');
			expect(MAIN).not.toBe(MENU);
			expect(REQUEST_LANGS.length).toBe(2);
		});

		test('test52 is translatable (the grid reads its request-lang slice first)', async () => {
			expect(await getTranslatableByTipo(TRANSLATABLE)).toBe(true);
		});
	});

	describe('term_resolver — hierarchy1 main lang', () => {
		test('= DATA_LANG_DEFAULT under two request langs, in both fill orders of the cache', async () => {
			for (const order of [REQUEST_LANGS, [...REQUEST_LANGS].reverse()]) {
				// Empty cache: the FIRST lane computes and stores the pick; the second
				// lane is served from the cache and must get the same install value.
				await clearOntologyDerivedCaches();
				for (const lang of order) {
					expect(await inRequest(lang, () => getMainLang('hierarchy1')), lang).toBe(MAIN);
				}
			}
		});
	});

	describe('indexation_grid — the fallback main lang', () => {
		test('no value in the request lang: the DATA_LANG_DEFAULT slice, under both request langs', async () => {
			const items = [
				{ id: 1, lang: MAIN, value: 'main' },
				{ id: 2, lang: MENU, value: 'menu' },
				{ id: 3, lang: 'lg-nolan', value: 'nolan' },
			];
			for (const lang of REQUEST_LANGS) {
				const result = await inRequest(lang, () =>
					langData({ dataLang: lang } as Parameters<typeof langData>[0], items, TRANSLATABLE),
				);
				expect(result.data, lang).toEqual([]);
				expect(result.fallback, lang).toEqual([{ id: 1, lang: MAIN, value: 'main' }]);
			}
		});
	});
}
