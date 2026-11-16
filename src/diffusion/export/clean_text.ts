/**
 * THE EXPORT TEXT-CELL CLEANUP — a byte port of PHP
 * export_tabulator::clean_text_value (tools/tool_export/class.export_tabulator
 * .php :1007-1034; WC-2026-11-12-export-text-cell-clean), preceded by ONE
 * deliberate divergence: the text_area TAG MARKS are stripped to plain text
 * (owner C43 2026-11-13, WC-2026-11-13-export-tag-marks-plain-text).
 *
 * The rich-text editor stores paragraphs and escaped entities
 * (`<p>a &amp; b</p><p>c</p>`); an exported cell is read as plain text
 * (CSV/TSV/XLSX/ODS/HTML files, the NDJSON download, the preview). The cleanup:
 *   - strips every text_area tag MARK (`[index-n-58-label]`, `[/index-n-58]`,
 *     `[TC_00:01:02_TC]`, `[person-a-7-JD]`, `[geo-…]`, `[page-…]`, `[note-…]`,
 *     `[lang-…]`, `[draw-…]`, `[svg-…-data:{…}:data]`) — PHP's atom rendered
 *     each one as an `<img>` badge (TR::add_tag_img_on_the_fly), markup a
 *     spreadsheet cell cannot show; the mark is a pointer into the record's
 *     indexation, not text, so plain text is the text WITHOUT it. Only the
 *     grammar's own shapes are stripped (tag_grammar.ts); a bracketed word that
 *     is not a mark (`[1]`, `[sic]`) is text and stays;
 *   - short-circuits when the value holds no `<` and no `&`;
 *   - turns every `</p><p>` into a line break, then strips ONE leading `<p>` and
 *     ONE trailing `</p>` — PCRE `$` without the D flag, so `</p>` just before a
 *     single trailing newline is the "end" too;
 *   - decodes the 11-entity legacy map in ONE pass (PHP strtr: `&amp;lt;` →
 *     `&lt;`, never `<`). Anything outside the map is kept — it is not
 *     html_entity_decode, and not a sanitizer: other markup stays.
 *
 * Its ONE caller is the tabulator (grid.ts), on every non-raw value / grid_value
 * cell: the cleanup runs on the JOINED cell, never per atom (PHP), so a
 * multi-item text keeps its inner `</p>, <p>`. dedalo_raw is never cleaned, and
 * neither is any interactive reader (PHP: the tabulator only).
 * Gate: test/unit/export_clean_text.test.ts (+ tool_export_coverage_native).
 * The entity decode lives in the html_text home (html_text_tripwire).
 */

import { decodeLegacyClientEntities } from '../../core/resolve/html_text.ts';

/** The leading paragraph opener (PCRE `/^<p>/`, no m flag). */
const LEADING_P = /^<p>/;
/** The trailing paragraph closer (PCRE `/<\/p>$/`: `$` also before ONE final \n). */
const TRAILING_P = /<\/p>(?=\n?$)/;

/**
 * EVERY in-text tag mark of the text_area grammar (tag_grammar.ts RE_TC,
 * RE_INDEX … RE_DRAW and the `svg` locator mark of dataMarkerPattern), as ONE
 * global alternation over the FULL in-text form — state letter, numeric id, the
 * optional `-label` (up to 22 chars, no `-`) and the optional `-data:…:data`
 * payload (lazy to the FIRST `:data]`, newlines included: a draw's paper data
 * spans lines). `person` allows an empty id and REQUIRES its label (RE_PERSON);
 * `index` alone has the closing `/` form. Nothing else is a mark: the
 * alternation names the eight types, so `[1]` / `[sic]` / a JSON array never
 * match.
 */
const TAG_MARK =
	/\[(?:TC_[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:\.[0-9]{1,3})?_TC|\/?index-[a-z]-[0-9]{1,6}(?:-[^-\]]{0,22})?(?:-data:[\s\S]*?:data)?|(?:geo|page|note|lang|draw|svg)-[a-z]-[0-9]{1,6}(?:-[^-\]]{0,22})?(?:-data:[\s\S]*?:data)?|person-[a-z]-[0-9]{0,6}-[^-\]]{0,22}(?:-data:[\s\S]*?:data)?)\]/g;

/**
 * The text WITHOUT its tag marks (owner C43 2026-11-13). The mark is removed
 * and nothing else: the surrounding characters are kept as stored (two spaces
 * around a removed mark stay two spaces — the cleanup is not a re-flow).
 * Short-circuits on a text with no `[`.
 */
export function stripTagMarks(value: string): string {
	if (!value.includes('[')) return value;
	return value.replace(TAG_MARK, '');
}

/**
 * PHP export_tabulator::clean_text_value — plain text out of an exported cell,
 * the tag marks stripped first (TS; PHP's atoms carried them as `<img>`).
 */
export function cleanTextValue(value: string): string {
	const text = stripTagMarks(value);
	if (text === '' || (!text.includes('<') && !text.includes('&'))) return text;
	const unwrapped = text.split('</p><p>').join('\n').replace(LEADING_P, '').replace(TRAILING_P, '');
	return decodeLegacyClientEntities(unwrapped);
}
