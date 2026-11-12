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
import { cleanTextValue } from '../../src/diffusion/export/clean_text.ts';

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
