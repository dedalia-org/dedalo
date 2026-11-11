/**
 * The match trim (src/core/concepts/match_text.ts) — the ONE whitespace rule
 * the iri label import and the Postgres match fold share (T0-12, D4b).
 *
 * Pure half: `trimMatchText` equals `String.prototype.trim` on EVERY BMP code
 * point, padded on either side (the set is spelled out by hand, so a missing or
 * extra character must be red here, not a duplicate label in production).
 * The Postgres half (the same pattern bound into `regexp_replace`) is pinned
 * against the suite DB in import_iri_label_native (R5).
 */

import { describe, expect, test } from 'bun:test';
import { trimMatchText } from '../../src/core/concepts/match_text.ts';

describe('trimMatchText', () => {
	test('equals String.prototype.trim on every BMP code point, both sides', () => {
		const mismatches: string[] = [];
		let checked = 0;
		for (let code = 0; code <= 0xffff; code++) {
			if (code >= 0xd800 && code <= 0xdfff) continue;
			checked++;
			const char = String.fromCharCode(code);
			const padded = `${char}a${char}b${char}`;
			if (trimMatchText(padded) !== padded.trim()) mismatches.push(code.toString(16));
		}
		expect(checked).toBeGreaterThan(63000); // the census really walked the BMP
		expect(mismatches).toEqual([]);
	});

	test('the interior is never touched', () => {
		expect(trimMatchText(' \t a   b\n　')).toBe('a   b');
		expect(trimMatchText('\t\n ')).toBe('');
	});
});
