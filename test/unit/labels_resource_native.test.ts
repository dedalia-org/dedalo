/**
 * The UI-label dictionary as its own versioned resource
 * (WC-2026-11-07-labels-separate-resource, core/api/labels_resource.ts):
 *   - `v` current → immutable; `v` absent/stale → no-cache + ETag, 304 on match;
 *   - a malformed/missing lang → 404 (converter-made); a well-formed lang outside
 *     the configured list is served labelsServingLang's dictionary (the default);
 *   - body = the plain getLabels(lang) dictionary (no envelope), gzip-negotiated;
 *   - both path twins, GET + HEAD, no session;
 *   - labels_version = 16 hex of sha256 over the MERGED dictionary, stable
 *     across a cache clear, different when the dictionary differs;
 *   - the environment carries labels_version and no longer carries get_label, and
 *     for EVERY lang it can emit (incl. one outside the list) the route answers 200.
 * Hermetic for the route (labels are repo files); the environment leg builds
 * page_globals, which reads the suite database.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { config } from '../../src/config/config.ts';
import {
	clearLabelsCache,
	getLabels,
	getLabelsVersion,
	labelsServingLang,
} from '../../src/core/labels/catalog.ts';
import { buildEnvironment } from '../../src/core/resolve/environment.ts';
import {
	currentApplicationLang,
	runWithRequestLangs,
} from '../../src/core/resolve/request_lang.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { handleRequest } from '../../src/server.ts';

const context = { requestId: 'labels-resource-test', startedAt: 0 };
const PATHS = ['/api/v1/labels', '/dedalo/core/api/v1/labels'] as const;
const LANG = Object.keys(config.lang.applicationLangs)[0] as string;

function get(path: string, query: string, headers: Record<string, string> = {}, method = 'GET') {
	return handleRequest(
		new Request(`http://localhost${path}?${query}`, { method, headers }),
		context,
	);
}

describe('labels resource route', () => {
	for (const path of PATHS) {
		test(`${path}: current v → immutable, plain dictionary body`, async () => {
			const version = await getLabelsVersion(LANG);
			const response = await get(path, `lang=${LANG}&v=${version}`);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
			expect(response.headers.get('etag')).toBe(`"${version}"`);
			expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
			expect(await response.json()).toEqual(await getLabels(LANG));
		});

		test(`${path}: stale or absent v → no-cache + ETag`, async () => {
			for (const query of [`lang=${LANG}&v=0000000000000000`, `lang=${LANG}`]) {
				const response = await get(path, query);
				expect(response.status).toBe(200);
				expect(response.headers.get('cache-control')).toBe('no-cache');
				expect(response.headers.get('etag')).toBe(`"${await getLabelsVersion(LANG)}"`);
			}
		});
	}

	test('If-None-Match with the current version → 304, no body', async () => {
		const version = await getLabelsVersion(LANG);
		const response = await get(PATHS[0], `lang=${LANG}`, { 'If-None-Match': `"${version}"` });
		expect(response.status).toBe(304);
		expect(await response.text()).toBe('');
	});

	test('well-formed lang outside the list → the default dictionary, same version', async () => {
		const served = config.lang.applicationLangsDefault;
		expect(labelsServingLang('lg-zzzz')).toBe(served);
		const version = await getLabelsVersion(served);
		const response = await get(PATHS[0], `lang=lg-zzzz&v=${version}`);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('immutable');
		expect(await response.json()).toEqual(await getLabels(served));
	});

	test('hostile, sentinel or missing lang → 404 envelope', async () => {
		for (const query of ['lang=../master', 'lang=all', '']) {
			const response = await get(PATHS[0], query);
			expect(response.status).toBe(404);
			expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
		}
	});

	test('gzip negotiated; decompressed body equals the dictionary', async () => {
		const response = await get(PATHS[0], `lang=${LANG}`, { 'Accept-Encoding': 'gzip' });
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(response.headers.get('vary')).toBe('Accept-Encoding');
		const bytes = Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()));
		expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(await getLabels(LANG));
	});

	test('HEAD → headers, no body', async () => {
		const response = await get(PATHS[0], `lang=${LANG}`, {}, 'HEAD');
		expect(response.status).toBe(200);
		expect(response.headers.get('etag')).toBe(`"${await getLabelsVersion(LANG)}"`);
		expect(await response.text()).toBe('');
	});
});

describe('labels version', () => {
	const hashOf = (dict: Record<string, string>) =>
		createHash('sha256').update(JSON.stringify(dict)).digest('hex').slice(0, 16);

	test('= 16 hex of sha256 over the merged dictionary; stable across a cache clear', async () => {
		const before = await getLabelsVersion(LANG);
		const dictBefore = await getLabels(LANG);
		expect(before).toMatch(/^[0-9a-f]{16}$/);
		expect(before).toBe(hashOf(dictBefore));
		clearLabelsCache();
		const dictAfter = await getLabels(LANG);
		expect(dictAfter).not.toBe(dictBefore); // really re-read, not the cached object
		expect(await getLabelsVersion(LANG)).toBe(before);
	});

	test('a different dictionary → a different version', async () => {
		const langs = Object.keys(config.lang.applicationLangs);
		const byHash = new Map<string, string>();
		for (const lang of langs) byHash.set(hashOf(await getLabels(lang)), lang);
		// non-vacuity: the suite config serves at least two distinct dictionaries
		expect(byHash.size).toBeGreaterThan(1);
		for (const [hash, lang] of byHash) expect(await getLabelsVersion(lang)).toBe(hash);
	});
});

describe('environment', () => {
	test('carries page_globals.labels_version, not get_label', async () => {
		const token = createSession(-1, 'root', true);
		const environment = (await buildEnvironment(getSession(token), await resolvePrincipal(-1)))
			.result as Record<string, Record<string, unknown>>;
		expect(environment).not.toHaveProperty('get_label');
		expect(environment.page_globals?.labels_version).toBe(
			await getLabelsVersion(labelsServingLang(currentApplicationLang())),
		);
		const anonymous = (await buildEnvironment(null, null)).result as Record<
			string,
			Record<string, unknown>
		>;
		expect(anonymous.page_globals?.labels_version).toMatch(/^[0-9a-f]{16}$/);
	});

	test('every lang page_globals can emit (configured or not) → the route answers 200 immutable', async () => {
		// lg-zzzz: a session lang set via change_lang / DATA_LANG_SYNC outside the list.
		for (const lang of [...Object.keys(config.lang.applicationLangs), 'lg-zzzz']) {
			const globals = (
				(
					await runWithRequestLangs({ applicationLang: lang, dataLang: lang }, () =>
						buildEnvironment(null, null),
					)
				).result as Record<string, Record<string, string>>
			).page_globals as Record<string, string>;
			expect(globals.dedalo_application_lang).toBe(lang);
			const response = await get(
				PATHS[0],
				`lang=${globals.dedalo_application_lang}&v=${globals.labels_version}`,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toContain('immutable');
		}
	});
});
