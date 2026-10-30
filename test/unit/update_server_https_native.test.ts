/**
 * UPDATE MASTERS ARE HTTPS (update audit 2026-10-29, U-24): the transport rule
 * (src/config/readers.ts isSecureUpdateSource), the config read that drops an
 * http master, and BOTH byte doors re-checking it before any fetch
 * (src/core/update/code_download.ts, src/core/ontology/data_io_import.ts).
 * 192.0.2.0/24 (TEST-NET-1) is never routed — and the refusal must come before
 * the fetch, so no request is ever attempted.
 */

import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSecureUpdateSource, secureServerList } from '../../src/config/readers.ts';
import { downloadRemoteOntologyFile } from '../../src/core/ontology/data_io_import.ts';
import { downloadReleaseArchive } from '../../src/core/update/code_download.ts';

describe('isSecureUpdateSource', () => {
	test('https anywhere; plain http only on this machine', () => {
		expect(isSecureUpdateSource('https://master.example/dedalo/', false)).toBe(true);
		for (const local of ['http://localhost:3500/', 'http://127.0.0.1/', 'http://[::1]:8080/']) {
			expect(isSecureUpdateSource(local, false), local).toBe(true);
		}
		for (const insecure of [
			'http://192.0.2.10/dedalo/',
			'http://master.example/',
			'http://localhost.example/',
			'ftp://master.example/',
			'not a url',
		]) {
			expect(isSecureUpdateSource(insecure, false), insecure).toBe(false);
		}
	});

	test('the development seam admits plain http off loopback — and nothing but http(s)', () => {
		expect(isSecureUpdateSource('http://192.0.2.10/dedalo/', true)).toBe(true);
		expect(isSecureUpdateSource('ftp://192.0.2.10/', true)).toBe(false);
	});
});

describe('secureServerList (the config read)', () => {
	test('drops an http master loudly, keeps the rest in order', () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = mock((line: string) => errors.push(line));
		try {
			const kept = secureServerList(
				'CODE_SERVERS',
				[
					{ name: 'a', url: 'https://a.example/', code: 'x' },
					{ name: 'b', url: 'http://192.0.2.10/', code: 'x' },
					{ name: 'c', url: 'http://localhost:3500/', code: 'x' },
				],
				false,
			);
			expect(kept.map((entry) => entry.name)).toEqual(['a', 'c']);
			expect(errors.some((line) => line.includes('ADMITTED'))).toBe(false);
			expect(
				errors.some((line) => line.includes('http://192.0.2.10/') && line.includes('DROPPED')),
			).toBe(true);
		} finally {
			console.error = original;
		}
	});
});

describe('secureServerList under the development seam', () => {
	test('admits the http master — and says so on every read, by key and url', () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = mock((line: string) => errors.push(line));
		try {
			const kept = secureServerList(
				'CODE_SERVERS',
				[
					{ name: 'a', url: 'https://a.example/', code: 'x' },
					{ name: 'b', url: 'http://192.0.2.10/', code: 'x' },
				],
				true,
			);
			expect(kept.map((entry) => entry.name)).toEqual(['a', 'b']);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain('http://192.0.2.10/');
			expect(errors[0]).toContain('DEDALO_UPDATE_HTTP_SOURCES_DEV');
		} finally {
			console.error = original;
		}
	});
});

describe('the byte doors re-check before fetching (the seam pinned OFF — never the desk’s env)', () => {
	const origin = 'http://192.0.2.10';

	test('code: an http release URL off loopback is refused before any request', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'dedalo_https_'));
		const fetchSpy = mock(globalThis.fetch);
		const original = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			await expect(
				downloadReleaseArchive({
					url: `${origin}/dedalo/install/code/7.0.1.zip`,
					configuredOrigin: origin,
					targetPath: join(scratch, 'a.zip'),
					allowHttp: false,
				}),
			).rejects.toThrow(/over https/);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = original;
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('ontology: an http file URL off loopback is refused before any request', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'dedalo_https_'));
		const fetchSpy = mock(globalThis.fetch);
		const original = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const result = await downloadRemoteOntologyFile({
				url: `${origin}/dedalo/install/import/ontology/7.0/dd.copy.gz`,
				configuredOrigin: origin,
				expectedBasename: 'dd.copy.gz',
				targetDir: scratch,
				allowHttp: false,
			});
			expect(result.ok).toBe(false);
			expect(result.errors).toEqual([`insecure source: ${origin}`]);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = original;
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
