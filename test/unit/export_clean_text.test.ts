/**
 * The export TEXT-CELL CLEANUP (T1-39 / OX1) — the port of PHP
 * export_tabulator::clean_text_value (tools/tool_export/class.export_tabulator
 * .php :1007-1034), pinned as a pure function. Its placement (every non-raw
 * value / grid_value cell, never dedalo_raw) is gated on the built database by
 * tool_export_coverage_native.test.ts. Wire: WC-2026-11-12-export-text-cell-clean.
 *
 * The first block is PHP's own unit table (export_tabulator_Test.php :558-572,
 * transcribed); the rest pins the edges a reimplementation gets wrong: the PCRE
 * `$` (no D flag) also matching before ONE trailing newline, the single-pass
 * strtr (an escaped entity decodes ONCE), an entity outside the map kept, and
 * the short-circuit.
 */

import { describe, expect, test } from 'bun:test';
import { cleanupInertJson } from '../../src/core/resolve/relation_list.ts';
import { cleanTextValue, stripTagMarks } from '../../src/diffusion/export/clean_text.ts';

describe('cleanTextValue — PHP export_tabulator_Test::test_clean_text_value', () => {
	test('paragraphs become line breaks, the outer <p> pair is stripped', () => {
		expect(cleanTextValue('<p>first</p><p>second</p>')).toBe('first\nsecond');
	});
	test('the legacy entity map decodes', () => {
		expect(cleanTextValue('a &amp; b &quot;c&quot; &lt;d&gt;')).toBe('a & b "c" <d>');
	});
	test('plain text is returned as is', () => {
		expect(cleanTextValue('plain')).toBe('plain');
	});
});

describe('cleanTextValue — the edges of the port', () => {
	test('the whole 11-entity map, numeric forms included; nbsp is a plain space', () => {
		expect(
			cleanTextValue('&nbsp;|&amp;|&#38;|&lt;|&#60;|&gt;|&#62;|&apos;|&#39;|&quot;|&#34;'),
		).toBe(` |&|&|<|<|>|>|'|'|"|"`);
	});
	test('ONE pass (strtr): an escaped entity decodes once, never twice', () => {
		expect(cleanTextValue('&amp;lt;')).toBe('&lt;');
		expect(cleanTextValue('&amp;amp;')).toBe('&amp;');
	});
	test('an entity outside the map is kept (no html_entity_decode)', () => {
		expect(cleanTextValue('a &hellip; b &copy;')).toBe('a &hellip; b &copy;');
		// exact spellings only (strtr keys): no numeric normalisation, no case folding
		expect(cleanTextValue('&#038; &#x26; &AMP; &#039;')).toBe('&#038; &#x26; &AMP; &#039;');
	});
	test('PCRE $ without D: </p> before ONE trailing newline is stripped, the newline kept', () => {
		expect(cleanTextValue('<p>x</p>\n')).toBe('x\n');
		// two trailing newlines: $ matches only at the end / before the last one
		expect(cleanTextValue('<p>x</p>\n\n')).toBe('x</p>\n\n');
	});
	test('only the ENDS are anchored: an inner </p>, <p> join survives (PHP cleans the joined cell)', () => {
		expect(cleanTextValue('<p>a</p>, <p>b</p>')).toBe('a</p>, <p>b');
	});
	test('an empty paragraph cleans to the empty string', () => {
		expect(cleanTextValue('<p></p>')).toBe('');
	});
	test('other markup is left untouched (the cleanup is not a sanitizer)', () => {
		expect(cleanTextValue('<p><b>x</b></p>')).toBe('<b>x</b>');
	});
	test('short-circuit: nothing to clean ⇒ the same string', () => {
		expect(cleanTextValue('')).toBe('');
		expect(cleanTextValue('a > b')).toBe('a > b');
	});
});

/**
 * C43 (owner 2026-11-13, WC-2026-11-13-export-tag-marks-plain-text): the
 * text_area tag MARKS are stripped to plain text — PHP's atom rendered each as
 * an `<img>` badge, the engine before this kept the raw mark. One case per
 * grammar shape (tag_grammar.ts), the full in-text form with label and
 * `-data:…:data` payload included; bracketed text that is NOT a mark stays.
 */
describe('cleanTextValue — text_area tag marks are stripped to plain text (C43)', () => {
	const MARKS: [string, string][] = [
		['index open, state + id + label', 'a [index-n-58-Label] b'],
		['index close', 'a [/index-n-58] b'],
		[
			'index with a data payload',
			"a [index-d-7--data:{'section_tipo':'test3','section_id':'1'}:data] b",
		],
		['timecode', 'a [TC_00:01:02.500_TC] b'],
		['timecode without millis', 'a [TC_0:1:2_TC] b'],
		['person with label', 'a [person-a-12-JD] b'],
		['person with empty id (the grammar allows it)', 'a [person-b--JD] b'],
		['geo', 'a [geo-n-3] b'],
		['page with label and data', 'a [page-n-4-p4-data:{"x":1}:data] b'],
		['note', 'a [note-n-9-nota] b'],
		['lang with label (no `-` in a label: the grammar)', 'a [lang-n-2-English] b'],
		['draw', 'a [draw-n-5-Draw] b'],
		['svg locator mark', "a [svg-n-1--data:{'section_tipo':'test65','section_id':'3'}:data] b"],
		[
			'a payload spanning lines (lazy to the FIRST :data])',
			'a [draw-n-5-D-data:{\n"paper":[1,\n2]}:data] b',
		],
	];
	for (const [name, text] of MARKS) {
		test(`stripped: ${name}`, () => {
			// the mark goes, its neighbours stay exactly (no re-flow: two spaces)
			expect(stripTagMarks(text)).toBe('a  b');
			expect(cleanTextValue(text)).toBe('a  b');
		});
	}

	test('several marks in one cell, with the paragraph cleanup around them', () => {
		expect(
			cleanTextValue('<p>[index-n-1-A]one[/index-n-1] &amp; [TC_00:00:01_TC]two</p><p>three</p>'),
		).toBe('one & two\nthree');
	});

	test('a mark alone cleans to the empty string (no `<` / `&` needed)', () => {
		expect(cleanTextValue('[index-n-1]')).toBe('');
	});

	test('bracketed text that is NOT a mark is text and stays', () => {
		for (const text of [
			'[1]',
			'[sic]',
			'a [index] b',
			'[index-n] x',
			'[TC_1_TC]',
			'["index-n-1"]',
			'[note-N-1]',
		]) {
			expect(stripTagMarks(text)).toBe(text);
			expect(cleanTextValue(text)).toBe(text);
		}
	});

	test('short-circuit: a text without `[` is the same string instance', () => {
		const text = 'plain text';
		expect(stripTagMarks(text)).toBe(text);
	});
});

describe('cleanupInertJson — a json export cell the cleanup cannot rewrite (T1-39 review)', () => {
	// every rule of the cleanup, inside JSON strings (and a backslash before a
	// `/`, which must stay one escaped backslash + one escaped slash)
	const ITEMS: unknown[] = [
		{ html: '<p>a</p><p>b</p>' },
		{ q: 'say &quot;hi&quot; &amp; &lt;x&gt; &amp;lt;' },
		{ tail: 'x</p>', lead: '<p>y' },
		'<p>only</p>',
		{ path: 'C:\\dir\\/x', url: 'https://example.org/a/b' },
		[{ type: 'Feature', properties: { popup: '<p>x</p><p>y &quot;z&quot;</p>' } }],
	];
	test('the plain encoding IS rewritten by the cleanup (the defect, non-vacuity)', () => {
		const plain = JSON.stringify(ITEMS[0]);
		expect(cleanTextValue(plain)).not.toBe(plain);
		expect(() => JSON.parse(cleanTextValue(JSON.stringify(ITEMS[1])))).toThrow();
	});
	for (const item of ITEMS) {
		test(`inert + lossless: ${JSON.stringify(item).slice(0, 40)}`, () => {
			const cell = cleanupInertJson(item);
			expect(cell).not.toContain('</');
			expect(cell).not.toContain('&');
			expect(cleanTextValue(cell)).toBe(cell);
			expect(JSON.parse(cell)).toEqual(item);
		});
	}
	test('joined beside cleaned text atoms (the tabulator cleans the JOIN)', () => {
		const cell = `<p>t &amp; u</p>, ${cleanupInertJson(ITEMS[0])}`;
		expect(cleanTextValue(cell)).toBe(`t & u</p>, ${cleanupInertJson(ITEMS[0])}`);
	});
});
