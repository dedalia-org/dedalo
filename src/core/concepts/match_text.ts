/**
 * THE MATCH TRIM — the ONE whitespace rule for "the same text, as a whole
 * value" (T0-12, D4b): the iri label import trims a label with it, and the
 * Postgres match fold (db/matrix.ts `foldMatchText` /
 * `readSectionIdsByFoldedValue`) strips the SAME set from both sides.
 *
 * Why a set of our own: Postgres `btrim(x)` strips the ASCII SPACE only, while
 * the JS side trimmed with `String.prototype.trim` (all Unicode white space and
 * line terminators). A stored label "Nomisma " or "Nomisma\t" then folded
 * differently from an imported "Nomisma" and a DUPLICATE label was created
 * next to it. This set IS `String.prototype.trim`'s — ECMAScript WhiteSpace
 * (TAB, VT, FF, SP, NBSP, ZWNBSP and every Zs) plus LineTerminator (LF, CR, LS,
 * PS) — pinned code point by code point in `test/unit/match_text.test.ts`.
 *
 * The class is built from CODE POINTS (below) into literal characters, so the
 * same pattern source is valid in a JS RegExp and as a bound Postgres ARE:
 * inside a bracket expression none of them is special.
 */

/** The match-trim code points: ECMAScript WhiteSpace + LineTerminator. */
const MATCH_SPACE_CODE_POINTS = [
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
	0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

const MATCH_SPACE_CLASS = `[${String.fromCodePoint(...MATCH_SPACE_CODE_POINTS)}]`;

/** The pattern (leading OR trailing run), applied with the global flag on both sides. */
export const MATCH_TRIM_PATTERN = `^${MATCH_SPACE_CLASS}+|${MATCH_SPACE_CLASS}+$`;

const MATCH_TRIM = new RegExp(MATCH_TRIM_PATTERN, 'g');

/** A text with the match trim applied (the JS half of the one rule). */
export function trimMatchText(text: string): string {
	return text.replace(MATCH_TRIM, '');
}
