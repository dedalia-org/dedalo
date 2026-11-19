/**
 * A MALFORMED `DEDALO_MEDIA_WEB_BASE` REFUSES THE BOOT, NAMING THE KEY AND THE VALUE (T2 D03-a).
 *
 * The key is the base EVERY media URL served to the client is built on. Until
 * 2026-11-19 its only treatment was a trailing-slash strip, so a typo
 * (`localhost:8080/dedalo/media`, a missing scheme) produced URLs the browser
 * resolved against the page — every image a 404, with nothing in any log — and
 * a value with a query or userinfo was concatenated into every `src`.
 *
 * Owner ruling 2026-11-19 (FYI-2): no fallback. A fallback to the same-origin
 * default would mask a split-origin misconfiguration as "no images"; the server
 * refuses to start instead, the same posture as a retired key.
 *
 * The grammar (src/config/catalog/media.ts parseMediaWebBase): a ROOT-RELATIVE
 * path, or an ABSOLUTE http(s) URL with no userinfo, no query, no fragment.
 * Pinned on the parser AND on the real config module in a child process (the
 * config builds at import, so "refuses the boot" is only observable there).
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseMediaWebBase } from '../../src/config/catalog/media.ts';

const REPO = join(import.meta.dir, '..', '..');
const KEY = 'DEDALO_MEDIA_WEB_BASE';

const GOOD: Record<string, string> = {
	'/dedalo/media': '/dedalo/media',
	'http://localhost:8080/dedalo/media': 'http://localhost:8080/dedalo/media',
	// a trailing slash is stripped (every builder appends a '/…'-rooted path)
	'https://media.example.org/dedalo/media/': 'https://media.example.org/dedalo/media',
	'/dedalo/media///': '/dedalo/media',
	'https://media.example.org': 'https://media.example.org',
};

const MALFORMED: Record<string, string> = {
	'no scheme (read as a relative path by the browser)': 'localhost:8080/dedalo/media',
	'a relative path': 'dedalo/media',
	'protocol-relative': '//media.example.org/dedalo/media',
	'another scheme': 'ftp://media.example.org/dedalo/media',
	'a script scheme': 'javascript:alert(1)',
	userinfo: 'https://user:secret@media.example.org/dedalo/media',
	'a query string': 'https://media.example.org/dedalo/media?token=abc',
	'a fragment': 'https://media.example.org/dedalo/media#x',
	'a query on the relative form': '/dedalo/media?x=1',
	'a fragment on the relative form': '/dedalo/media#x',
	'a parent segment': '/dedalo/../private',
	'a backslash': '/dedalo\\media',
	whitespace: '/dedalo/my media',
	'no host': 'https:///dedalo/media',
};

describe('the grammar', () => {
	for (const [raw, expected] of Object.entries(GOOD)) {
		test(`accepted: ${raw} → ${expected}`, () => {
			expect(parseMediaWebBase(raw)).toBe(expected);
		});
	}

	for (const [name, raw] of Object.entries(MALFORMED)) {
		test(`refused — ${name}: the error names the key and the value`, () => {
			let message = '';
			try {
				parseMediaWebBase(raw);
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain(KEY);
			expect(message).toContain(raw);
		});
	}
});

describe('the real config module, in a child process', () => {
	async function boot(
		value: string,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(
			[
				process.execPath,
				'-e',
				"const { config } = await import('./src/config/config.ts'); console.log('WEB_BASE=' + config.media.webBase);",
			],
			{
				cwd: REPO,
				// The child reads the same private/.env; ONE key differs.
				env: { ...process.env, [KEY]: value },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode: await child.exited, stdout, stderr };
	}

	test('CONTROL: a good absolute base builds, trailing slash stripped', async () => {
		const run = await boot('http://localhost:8080/dedalo/media/');
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain('WEB_BASE=http://localhost:8080/dedalo/media\n');
	}, 60_000);

	test('a malformed base: the config does NOT build — non-zero exit, key and value on stderr, no fallback', async () => {
		const bad = 'localhost:8080/dedalo/media';
		const run = await boot(bad);
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain(KEY);
		expect(run.stderr).toContain(bad);
		expect(run.stdout).not.toContain('WEB_BASE=');
	}, 60_000);

	test('unset (empty) keeps the same-origin default', async () => {
		const run = await boot('');
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toMatch(/WEB_BASE=\/dedalo\/[\w-]+\n/);
	}, 60_000);
});
