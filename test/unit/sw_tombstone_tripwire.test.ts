/**
 * SW TOMBSTONE tripwire (2026-10-02) — `client/dedalo/core/sw.js` is the permanent
 * tombstone of a retired service-worker URL; the live worker is `core/service_worker.js`.
 *
 * v6 registered `core/sw.js` as a CLASSIC worker answering every `.js` cache-first
 * from the fixed `dedalo_files` cache. v7 put a MODULE worker (static `import`) at
 * the same URL, so the browser's update of the classic registration failed to parse
 * it and kept the v6 worker forever, serving v6 modules into the v7 page (and v7's
 * own login.js, so it could never re-register). The fix is a URL split:
 *   - `sw.js` answers with a script valid under BOTH registration types that takes
 *     over, deletes the v6 cache, unregisters and reloads the v6-polluted windows;
 *   - the real worker moved to `service_worker.js`, and nothing registers `sw.js`.
 * Every rule below is one way the eviction silently stops working.
 *
 * Hermetic: tracked-source reads only (a clean CI checkout without a tracked
 * `sw.js` or `service_worker.js` reds here on the first read).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildDedaloFilesResponse } from '../../src/core/api/dedalo_files.ts';
import { browserSources } from '../helpers/browser_corpus.ts';

const TOMBSTONE = 'client/dedalo/core/sw.js';
const WORKER = 'client/dedalo/core/service_worker.js';
const LOGIN = 'client/dedalo/core/login/js/login.js';
/** The v6 fixed cache key. */
const V6_CACHE = 'dedalo_files';

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** True when the source compiles as a CLASSIC script (no import/export). Never runs it. */
function parsesAsClassic(source: string): boolean {
	try {
		new Function(source);
		return true;
	} catch {
		return false;
	}
}

const tombstone = readFileSync(TOMBSTONE, 'utf-8');
const tombstoneCode = stripComments(tombstone);

describe('sw.js parses under ANY registration type', () => {
	test('it compiles as a classic worker (the v6 registration type)', () => {
		expect(parsesAsClassic(tombstone)).toBe(true);
	});

	test('the classic-parse probe discriminates (anti-vacuity: the module worker fails it)', () => {
		expect(parsesAsClassic(readFileSync(WORKER, 'utf-8'))).toBe(false);
	});

	test('it compiles as a module worker (the v7 registration type): no import of any shape', () => {
		// (export statements are already refused by the classic parse above)
		expect(new Bun.Transpiler({ loader: 'js' }).scanImports(tombstone)).toEqual([]);
		// importScripts throws in a module worker; import() is refused in every worker
		expect(tombstoneCode).not.toMatch(/\bimportScripts\s*\(/);
		expect(tombstoneCode).not.toMatch(/\bimport\s*\(/);
	});
});

describe('sw.js evicts, and only evicts', () => {
	test('NO fetch listener: once active, nothing is served from any cache', () => {
		expect(tombstoneCode).toContain("self.addEventListener('activate'");
		expect(tombstoneCode).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
		expect(tombstoneCode).not.toMatch(/\bonfetch\b/);
	});

	test('install takes over at once (a waiting tombstone leaves v6 serving while a tab is open)', () => {
		expect(tombstoneCode).toMatch(/addEventListener\('install'[\s\S]*?self\.skipWaiting\(\)/);
	});

	test('activate claims, deletes the v6 cache and unregisters', () => {
		expect(tombstoneCode).toContain(`const legacy_cache_name = '${V6_CACHE}'`);
		expect(tombstoneCode).toContain('await self.clients.claim()');
		expect(tombstoneCode).toContain('await caches.delete(legacy_cache_name)');
		expect(tombstoneCode).toContain('await self.registration.unregister()');
	});

	test("it deletes ONLY the v6 key: a versioned key may be the live worker's cache", () => {
		expect(tombstoneCode).not.toMatch(/caches\.keys\s*\(/);
		expect(tombstoneCode.match(/caches\.delete\(/g)?.length).toBe(1);
	});

	test('the reload is gated on v6 evidence (no reload of a user mid-edit on a v7 page)', () => {
		expect(tombstoneCode).toMatch(/if\s*\(\s*had_legacy_cache\s*\)\s*\{[\s\S]*?client\.navigate\(/);
	});
});

describe('nothing registers sw.js; the live worker is service_worker.js', () => {
	test('login registers service_worker.js as a module', () => {
		expect(stripComments(readFileSync(LOGIN, 'utf-8'))).toMatch(
			/serviceWorker\.register\(\s*DEDALO_ROOT_WEB \+ '\/core\/service_worker\.js',\s*\{\s*type:\s*'module'\s*\}/,
		);
	});

	test('no tracked client/tool source names sw.js outside comments', () => {
		const files = browserSources();
		expect(files.length).toBeGreaterThan(300); // anti-vacuity floor
		expect(files).toContain(TOMBSTONE); // the corpus reaches core/
		const offenders = files.filter((f) => {
			if (f === TOMBSTONE) return false;
			const code = stripComments(readFileSync(f, 'utf-8'));
			// the live worker's fetch handler excludes the URL by name — that is not a reference to load it
			const scrubbed =
				f === WORKER ? code.replace("!path.endsWith('/sw.js')", '') : code;
			return /['"`][^'"`]*\bsw\.js/.test(scrubbed);
		});
		expect(offenders).toEqual([]);
	});

	test('neither worker script is in the precache manifest', () => {
		const urls = buildDedaloFilesResponse().result.map((el: { url: string }) => el.url);
		expect(urls.length).toBeGreaterThan(0);
		expect(urls.filter((u: string) => /\/(sw|service_worker)\.js$/.test(u))).toEqual([]);
	});
});
