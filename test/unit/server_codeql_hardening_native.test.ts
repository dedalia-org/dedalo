/**
 * SERVER CodeQL hardening (2026-10-25) — one OUTCOME gate per closed alert:
 *
 *   #7958  js/polynomial-redos      tag endpoint: id length cap + linear stripTags
 *   #7934/#7935/#7936 js/double-escaping  one single-pass entity decoder
 *   #9673  js/incomplete-url-scheme-check  html_sanitize data: → raster allowlist
 *   #9503/#9413/#9566 js/file-system-race  check-then-write → one append open
 *   #8089  js/file-system-race      staged name record: one open, fstat, bounded read
 *   (+)    no NUL byte in server source (it made grep treat the file as binary)
 *
 * The race gates SIMULATE the race deterministically: they make the existence /
 * size probe lie (spyOn on the node:fs namespace — Bun rebinds named imports),
 * which is exactly what a concurrent writer does between two syscalls. Code that
 * still probes-then-acts fails; code that acts in one syscall never asks.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { htmlToPlainText } from '../../src/ai/rag/component_text.ts';
import { handleTagRequest } from '../../src/core/components/component_text_area/tag_endpoint.ts';
import { safeDecodeTagId } from '../../src/core/components/component_text_area/tag_grammar.ts';
import { readStagedDisplayName } from '../../src/core/media/ingest/staged_name_record.ts';
import {
	layAuthMarker,
	overrideMediaProtectionPathsForTests,
	syncAuthMarkers,
} from '../../src/core/media/protection.ts';
import {
	decodeHtmlSpecialChars,
	replaceHtmlTags,
	stripTags,
} from '../../src/core/resolve/html_text.ts';
import { charsInfo } from '../../src/core/resolve/tr_marks.ts';
import { sanitizeRichText } from '../../src/core/security/html_sanitize.ts';
import { ensureLogFile } from '../../src/core/update/engine.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';

const REPO = join(import.meta.dir, '../..');

/** Inputs where a wrong tag stripper would differ from the regex it replaces. */
const STRIP_CORPUS: readonly string[] = [
	'',
	'plain',
	'<b>bold</b> text',
	'a<b<c>d',
	'<<<>>>',
	'<>',
	'x<>y',
	'<a href="x>y">z</a>',
	'tail <unclosed',
	'<<a>',
	'>',
	'<p>one</p><p>two<br/></p>',
	'a<b>c<d',
	'<<b>x<',
];

describe('#7958 linear tag strip (identical output, linear time)', () => {
	test('stripTags ≡ replace(/<[^>]*>/g, "") and the +-form ≡ /<[^>]+>/g', () => {
		const random: string[] = [];
		let seed = 7958;
		const alphabet = '<>a /';
		for (let i = 0; i < 400; i++) {
			let s = '';
			for (let j = 0; j < 12; j++) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				s += alphabet[seed % alphabet.length];
			}
			random.push(s);
		}
		for (const input of [...STRIP_CORPUS, ...random]) {
			expect(stripTags(input)).toBe(input.replace(/<[^>]*>/g, ''));
			expect(replaceHtmlTags(input, ' ', true)).toBe(input.replace(/<[^>]+>/g, ' '));
		}
	});

	test('64 KB of unclosed "<" is stripped in linear time (the regex took ~0.7 s)', () => {
		const hostile = '<'.repeat(64 * 1024);
		const started = performance.now();
		expect(stripTags(hostile)).toBe(hostile);
		expect(safeDecodeTagId(hostile)).toBe(hostile);
		expect(performance.now() - started).toBeLessThan(50);
	});

	test('the unauthenticated tag endpoint refuses an over-long id as request.invalid (400)', async () => {
		const hostile = '<'.repeat(64 * 1024);
		const url = new URL(`http://x/core/component_text_area/tag/?id=${encodeURIComponent(hostile)}`);
		const started = performance.now();
		const response = await handleTagRequest(new Request(url), url);
		expect(performance.now() - started).toBeLessThan(50);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { ok: boolean; error: { code: string } };
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe('request.invalid');
		// …and a legitimate tag still renders (the cap is not a blanket refusal).
		const tagUrl = new URL('http://x/core/component_text_area/tag/?id=[index-n-1-label]');
		expect((await handleTagRequest(new Request(tagUrl), tagUrl)).status).toBe(200);
	});
});

describe('#7934/#7935/#7936 single-pass entity decode', () => {
	test('&amp;lt; decodes to the literal &lt; — never to <', () => {
		expect(decodeHtmlSpecialChars('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
		expect(decodeHtmlSpecialChars('&lt;&quot;&#39;&#039;&amp;&gt;')).toBe(`<"''&>`);
		expect(decodeHtmlSpecialChars('&nbsp;&#233;')).toBe('&nbsp;&#233;'); // htmlspecialchars only
		expect(decodeHtmlSpecialChars('a&nbsp;b', { nbsp: ' ' })).toBe('a b');
		expect(decodeHtmlSpecialChars('&AMP;', { ignoreCase: true })).toBe('&');
		expect(decodeHtmlSpecialChars('&#xE9;&#233;', { numeric: true })).toBe('éé');
	});

	test('tr_marks charsInfo counts &amp;lt; as the 4 chars of "&lt;" (#7935)', () => {
		expect(charsInfo('&amp;lt;').total_chars).toBe(4);
	});

	test('RAG plain text keeps &amp;lt; literal and survives an out-of-range reference (#7934)', () => {
		expect(htmlToPlainText('<p>&amp;lt;x&amp;gt;</p>')).toBe('&lt;x&gt;');
		expect(() => htmlToPlainText('&#99999999;')).not.toThrow();
	});
});

describe('#9673 data: URLs — raster images only', () => {
	test('scriptable / non-raster data: URLs become #', () => {
		for (const url of [
			'data:image/svg+xml,<svg onload=alert(1)>',
			'data:image/svg+xml;base64,PHN2Zz4=',
			'data:text/xml,<x/>',
			'data: text/html,<script>alert(1)</script>',
			'data:,hello',
		]) {
			const out = sanitizeRichText(`<p><img src="${url}"></p>`);
			expect(out, url).toContain('src="#"');
		}
	});

	test('raster data: images and prose attributes survive', () => {
		for (const type of ['png', 'jpeg', 'gif', 'webp', 'avif']) {
			const html = `<p><img src="data:image/${type};base64,AAAA"></p>`;
			expect(sanitizeRichText(html)).toContain(`data:image/${type};base64,AAAA`);
		}
		expect(sanitizeRichText('<p><img alt="Data: Madrid, 1923" src="x.png"></p>')).toContain(
			'alt="Data: Madrid, 1923"',
		);
	});
});

describe('check-then-write races (#9503 #9413 #9566 #8089)', () => {
	let scratch = '';
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), 'dedalo_codeql_race_'));
	});
	afterEach(() => {
		overrideMediaProtectionPathsForTests(null);
		rmSync(scratch, { recursive: true, force: true });
	});

	test('the update log is never truncated by a stale existence check (#9566)', () => {
		const log = join(scratch, 'update.log');
		writeFileSync(log, 'written by another process\n');
		const lie = spyOn(fs, 'existsSync').mockReturnValue(false);
		try {
			expect(ensureLogFile(log)).toBeNull();
		} finally {
			lie.mockRestore();
		}
		expect(readFileSync(log, 'utf8')).toBe('written by another process\n');
		const fresh = join(scratch, 'new.log');
		expect(ensureLogFile(fresh)).toBeNull();
		expect(statSync(fresh).size).toBe(0);
	});

	test('auth markers are laid without truncating one that appeared meanwhile (#9413, #9503)', () => {
		const media = markMediaRoot(join(scratch, 'media'));
		overrideMediaProtectionPathsForTests({
			mediaRoot: media,
			authStorePath: join(scratch, 'private', 'media_auth.json'),
		});
		const value = 'a'.repeat(128);
		layAuthMarker(value); // creates the dir + marker
		const marker = join(media, '.publication', 'auth', value);
		expect(statSync(marker).isFile()).toBe(true);
		writeFileSync(marker, 'concurrent');
		// Lie ONLY about the marker (the media-root guard's own probe must still see
		// the truth): "absent" — what a check that ran before the writer would say.
		const realExists = fs.existsSync;
		const lie = spyOn(fs, 'existsSync').mockImplementation((path) =>
			String(path) === marker ? false : realExists(path),
		);
		try {
			layAuthMarker(value); // #9413
			expect(readFileSync(marker, 'utf8')).toBe('concurrent');
			syncAuthMarkers([value]); // #9503 (layValidMarkers)
			expect(readFileSync(marker, 'utf8')).toBe('concurrent');
		} finally {
			lie.mockRestore();
		}
	});

	test('the staged-name size bound and the read hit the SAME file (#8089)', () => {
		const staging = markMediaRoot(join(scratch, 'staging'));
		fs.mkdirSync(join(staging, '.names'));
		writeFileSync(join(staging, '.names', 'f1.jpg'), 'x'.repeat(5000));
		// The stat a path-based probe would see: a small, valid record (the file
		// that was there BEFORE a concurrent rename swapped in the big one).
		const lie = spyOn(fs, 'statSync').mockReturnValue({
			isFile: () => true,
			size: 10,
		} as unknown as fs.Stats);
		let value: string | null;
		try {
			value = readStagedDisplayName(staging, 'f1.jpg');
		} finally {
			lie.mockRestore();
		}
		expect(value).toBeNull(); // 5000 bytes > MAX_RECORD_BYTES: refused, not read
		writeFileSync(join(staging, '.names', 'f2.jpg'), 'Fotografía 1.jpg\n');
		expect(readStagedDisplayName(staging, 'f2.jpg')).toBe('Fotografía 1.jpg');
		expect(readStagedDisplayName(staging, 'absent.jpg')).toBeNull();
	});
});

describe('server source is text', () => {
	test('no NUL byte in src/, publication/ or tools/*/server source (grep-blind otherwise)', () => {
		const offenders: string[] = [];
		const scanned: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === 'node_modules' || entry.name === 'dist') continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (/\.(ts|js|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
					scanned.push(relative(REPO, full));
					if (readFileSync(full).includes(0)) offenders.push(relative(REPO, full));
				}
			}
		};
		walk(join(REPO, 'src'));
		walk(join(REPO, 'publication'));
		for (const tool of readdirSync(join(REPO, 'tools'), { withFileTypes: true })) {
			const server = join(REPO, 'tools', tool.name, 'server');
			if (tool.isDirectory() && fs.existsSync(server)) walk(server);
		}
		// Anti-vacuity: the walk saw the tree, including the file that carried the bytes.
		expect(scanned.length).toBeGreaterThan(1000);
		expect(scanned).toContain('src/core/media/ingest/upload.ts');
		expect(offenders).toEqual([]);
	});
});
