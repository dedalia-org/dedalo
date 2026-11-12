/**
 * THE EXPORT TEXT-CELL CLEANUP — a byte port of PHP
 * export_tabulator::clean_text_value (tools/tool_export/class.export_tabulator
 * .php :1007-1034; WC-2026-11-12-export-text-cell-clean).
 *
 * The rich-text editor stores paragraphs and escaped entities
 * (`<p>a &amp; b</p><p>c</p>`); an exported cell is read as plain text
 * (CSV/TSV/XLSX/ODS/HTML files, the NDJSON download, the preview). The cleanup:
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

/** PHP export_tabulator::clean_text_value — plain text out of an exported cell. */
export function cleanTextValue(value: string): string {
	if (value === '' || (!value.includes('<') && !value.includes('&'))) return value;
	const unwrapped = value
		.split('</p><p>')
		.join('\n')
		.replace(LEADING_P, '')
		.replace(TRAILING_P, '');
	return decodeLegacyClientEntities(unwrapped);
}
