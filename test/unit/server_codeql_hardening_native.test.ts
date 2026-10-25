/**
 * SERVER CodeQL hardening (2026-10-25) — one OUTCOME gate per closed alert:
 *
 *   #7958  js/polynomial-redos      tag endpoint: id length cap + linear stripTags,
 *                                   and the linear twins at their CALLERS (subtitles,
 *                                   external markup sanitiser, svg envelope, rdf merge)
 *   #7934/#7935/#7936 js/double-escaping  one single-pass entity decoder, at its
 *                                   callers (indexation_grid, tr_marks, RAG, import lookup),
 *                                   matching PHP htmlspecialchars_decode incl. numeric refs
 * (The SHAPE half — no regex tag scan / chained &amp; decode anywhere else —
 * is html_text_tripwire.)
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
import { repointEnvelopeRaster } from '../../src/core/media/svg_overlay.ts';
import { cleanTextForSubtitles } from '../../src/core/media/tools/subtitles.ts';
import {
	decodeHtmlSpecialChars,
	firstHtmlTag,
	replaceFirstHtmlTag,
	replaceHtmlTags,
	stripTags,
	stripTagsExcept,
} from '../../src/core/resolve/html_text.ts';
import { charsInfo } from '../../src/core/resolve/tr_marks.ts';
import { fragmentFromTag } from '../../src/core/section/indexation_grid.ts';
import { sanitizeRichText } from '../../src/core/security/html_sanitize.ts';
import { paragraphAsText } from '../../src/core/tools/import_code_lookup.ts';
import { ensureLogFile } from '../../src/core/update/engine.ts';
import { rdfInnerBlock } from '../../src/diffusion/writers/rdf.ts';
import { sanitizeMarkup } from '../../src/external/fields_map.ts';
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
				s += alphabet[(seed >>> 16) % alphabet.length];
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

	test('the allowlist / first-tag twins ≡ their regexes (subtitles, svg envelope, rdf merge)', () => {
		const tokens = [
			'<',
			'>',
			'/',
			'a',
			'br',
			'BR',
			'strong',
			'em',
			'emx',
			' ',
			'<br>',
			'</em>',
			'<svg',
			'<image',
			'<rdf:RDF',
			' x="y>"',
		];
		let seed = 7958;
		for (let i = 0; i < 3000; i++) {
			let input = '';
			for (let j = 0; j < 10; j++) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				input += tokens[(seed >>> 16) % tokens.length];
			}
			expect(stripTagsExcept(input, ['br', 'strong', 'em'])).toBe(
				input.replace(/<(?!\/?(?:br|strong|em)\b)[^>]*>/gi, ''),
			);
			expect(firstHtmlTag(input, /<rdf:RDF/y)?.tag ?? null).toBe(
				input.match(/<rdf:RDF[^>]*>/)?.[0] ?? null,
			);
			expect(replaceFirstHtmlTag(input, /<svg\b/iy, (t) => `[${t}]`)).toBe(
				input.replace(/<svg\b[^>]*>/i, (t) => `[${t}]`),
			);
		}
		expect(() => firstHtmlTag('<a>', /<a/)).toThrow(); // a non-sticky opener is refused
	});

	test('the CALLERS are linear on 64 KB of unclosed "<" (each regex form took ~0.7 s)', () => {
		const started = performance.now();
		const hostile = '<'.repeat(64 * 1024);
		expect(cleanTextForSubtitles(hostile)).toBe(hostile);
		expect(sanitizeMarkup('<a'.repeat(32 * 1024))).toBe('&lt;a'.repeat(32 * 1024));
		expect(sanitizeMarkup('<script'.repeat(8 * 1024))).toBe('&lt;script'.repeat(8 * 1024));
		expect(sanitizeMarkup('<!--'.repeat(16 * 1024))).toBe('&lt;!--'.repeat(16 * 1024));
		// A run of unclosed OPENERS is the hostile shape for the first-tag twins (a
		// single `<svg` at offset 0 is scanned once even by the old regex).
		// 32K (not 16K): the reverted `/<svg\b[^>]*>/i` takes ~0.7 s here, so the 150 ms
		// budget catches it on any host; 16K cleared the budget by only ~15% (round-3 review).
		const svgs = '<svg'.repeat(32 * 1024);
		const images = `<svg>${'<image'.repeat(16 * 1024)}`;
		expect(repointEnvelopeRaster(svgs, 10, 10, 'x.jpg')).toBe(svgs);
		expect(repointEnvelopeRaster(images, 10, 10, 'x.jpg')).toBe(images);
		expect(rdfInnerBlock('<rdf:RDF'.repeat(16 * 1024))).toBe(''); // no `>` anywhere: the worst case
		expect(performance.now() - started).toBeLessThan(150);
		// …and still do their job.
		expect(
			cleanTextForSubtitles('<p>a<br />b <strong>c</strong> <em>d</em><span>e</span></p>'),
		).toBe('a b <b>c</b> <i>d</i>e');
		expect(sanitizeMarkup('<p onclick="x">a<script>bad()</script><!-- c --><b>b</b></p>')).toBe(
			'<p>a<b>b</b></p>',
		);
		expect(rdfInnerBlock('<?xml?>\n<rdf:RDF xmlns:a="b">\n <a:x/>\n</rdf:RDF>')).toBe('<a:x/>');
		expect(
			repointEnvelopeRaster('<svg width="1" height="1"><image href="old"/></svg>', 4, 3, 'new'),
		).toBe('<svg width="4" height="3"><image href="new"/></svg>');
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

	test('numeric references: exactly PHP htmlspecialchars_decode(ENT_QUOTES) (php 8 table)', () => {
		// [input, PHP output] — recorded from `php -r 'echo htmlspecialchars_decode($s, ENT_QUOTES);'`
		// (PHP 8, html.c traverse_for_entities: !all ⇒ numeric refs of & < > " ' ONLY).
		const PHP: ReadonlyArray<readonly [string, string]> = [
			['&#60;b&#62;', '<b>'],
			['&#x27;&#X27;&#x0027;&#0039;&#39;&#039;', "''''''"],
			['&#38;amp;', '&amp;'],
			['&#34;&#x22;&#X3C;&#x3e;&#x26;', '""<>&'],
			['&#0000000060;', '<'],
			['&#233;&#xE9;&#169;&#32;', '&#233;&#xE9;&#169;&#32;'],
			['&apos;&nbsp;&AMP;', '&apos;&nbsp;&AMP;'],
			['&amp;#60;', '&#60;'],
			['&#99999999;&#x110000;&#;&#x;', '&#99999999;&#x110000;&#;&#x;'],
		];
		for (const [input, php] of PHP) expect(decodeHtmlSpecialChars(input), input).toBe(php);
		expect(decodeHtmlSpecialChars('&apos;', { apos: true })).toBe("'");
	});

	test('indexation_grid fragment text is decoded ONCE (#7936)', () => {
		const fragment = fragmentFromTag('1', 'x[index-n-1]&amp;lt;b&amp;gt; &#60;i&#62;[/index-n-1]y');
		expect(fragment?.text).toBe('&lt;b&gt; <i>');
	});

	test('import code lookup: textAsParagraph inverse in one pass, plus the PHP numeric refs', () => {
		expect(paragraphAsText('<p>&amp;lt;x&amp;gt; &lt;y&gt; &quot;&#39;&apos;&amp;</p>')).toBe(
			`&lt;x&gt; <y> "''&`,
		);
		// what the old replaceAll chain left verbatim: numeric spellings of < > '
		expect(paragraphAsText('<p>&#60;x&#62; &#x27;&#039;&#0039;</p>')).toBe(`<x> '''`);
	});

	test('tr_marks charsInfo counts &amp;lt; as the 4 chars of "&lt;" (#7935)', () => {
		expect(charsInfo('&amp;lt;').total_chars).toBe(4);
	});

	test('RAG plain text keeps &amp;lt; literal and survives an out-of-range reference (#7934)', () => {
		expect(htmlToPlainText('<p>&amp;lt;x&amp;gt;</p>')).toBe('&lt;x&gt;');
		expect(() => htmlToPlainText('&#99999999;')).not.toThrow();
	});
});

describe('external markup sanitiser ≡ the regex pipeline it replaced', () => {
	// The pre-2026-10-25 sanitizeMarkup, verbatim: raw-element regex, comment
	// regex, then a matchAll tag walk (the O(n²) forms the linear twins replace).
	const ALLOWED = new Set(['b', 'i', 'em', 'strong', 'sub', 'sup', 'br', 'p', 'ul', 'ol', 'li']);
	const escapeText = (text: string): string =>
		text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const reference = (raw: string): string => {
		const kept = raw
			.replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
			.replace(/<!--[\s\S]*?-->/g, '');
		let output = '';
		let cursor = 0;
		for (const match of kept.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
			const index = match.index ?? 0;
			output += escapeText(kept.slice(cursor, index));
			cursor = index + match[0].length;
			const tag = (match[1] ?? '').toLowerCase();
			if (!ALLOWED.has(tag)) continue;
			output += match[0].startsWith('</') ? `</${tag}>` : `<${tag}>`;
		}
		return output + escapeText(kept.slice(cursor));
	};

	test('seeded token soup: interleaved, unclosed and mixed-case raw elements, comments, tags', () => {
		const tokens = [
			'<script',
			'</script>',
			'</SCRIPT >',
			'<Script>',
			'<style',
			'</style>',
			'<svg',
			'</svg>',
			'<math>',
			'</math >',
			'<!--',
			'-->',
			'<a',
			'<b>',
			'</b>',
			'<p x="1">',
			'>',
			'x',
			' ',
			'"',
		];
		let seed = 9673;
		let cases = 0;
		for (let i = 0; i < 20000; i++) {
			let input = '';
			const length = 1 + (i % 14);
			for (let j = 0; j < length; j++) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				input += tokens[(seed >>> 16) % tokens.length];
			}
			expect(sanitizeMarkup(input), input).toBe(reference(input));
			cases++;
		}
		expect(cases).toBe(20000);
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
