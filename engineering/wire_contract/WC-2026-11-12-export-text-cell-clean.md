# WC-2026-11-12-export-text-cell-clean — exported value / grid_value cells are cleaned to plain text (PHP `clean_text_value`)

- **Date:** 2026-11-12 (RC-closure item T1-39, audit OX1).
- **Decision:** DEC-12 (gates in the same change). PHP parity; no owner decision.

## Shape before (PHP)

`export_tabulator::clean_text_value` (`tools/tool_export/class.export_tabulator.php:1007-1034`)
ran on every exported text cell, server-side, so every download agreed:

- value format (`:321-326`): `clean(export_value::join(atoms))` when the join is not `''`;
- grid_value (`join_cell`, `:940-956`): `clean(join(cell atoms))`, except a single int
  `section_id` atom; an empty result is dropped (`:361-364`);
- `dedalo_raw`: pass-through, never cleaned;
- the cleanup: short-circuit without `<` / `&`; `</p><p>` → `\n`; strip `^<p>` and `</p>$`
  (PCRE `$`, no D flag: also before ONE trailing newline); then ONE `strtr` over 11 entities —
  `&nbsp;` (→ U+0020) `&amp;` `&#38;` `&lt;` `&#60;` `&gt;` `&#62;` `&apos;` `&#39;` `&quot;`
  `&#34;`.

## Shape before (TS)

No port: a text_area cell reached every file (CSV/TSV/XLSX/ODS/HTML), the NDJSON download and the
preview as stored markup — `<p>a &amp; b</p><p>c</p>`.

## Shape after (TS)

- `src/diffusion/export/clean_text.ts cleanTextValue` — the byte port; the entity decode is
  `html_text.ts decodeLegacyClientEntities` (the html_text home; exact spellings only, ONE pass:
  `&amp;lt;` → `&lt;`, `&#038;` / `&#x26;` / `&AMP;` kept).
- Applied in the tabulator (`grid.ts`), the ONE chokepoint upstream of every download and the
  preview: the value term cell (a cell that cleans to `''` is kept, as PHP), the WC-049 `#parents`
  and T0-9 `#references` sibling cells (TS split-outs of atoms PHP joined into the term cell —
  same cleanup), and every grid_value cell after the join (single `section_id` bypass kept; `''`
  dropped).
- NOT applied: `dedalo_raw`, and no interactive reader (relation_list panel, Referencias, terms) —
  PHP cleaned in the tabulator only.
- Cleaned on the JOINED cell, never per atom (PHP): a multi-item text_area keeps its inner
  `</p>, <p>` — only the ends are anchored.
- Not a sanitizer: other markup (text_area tags such as `[index-…]`, `<b>`) is untouched — what a
  text_area atom renders its tags as is open owner decision T1-39 D1.

## Reason

The cell is read as plain text in a spreadsheet; the legacy client did this cleanup in the browser
and PHP moved it server-side so every download agreed. `cells.ts cellToText` (file writers only)
was rejected: the preview and the NDJSON download would disagree with the files.

## Gate reconciliation

`test/unit/export_clean_text.test.ts` (PHP `export_tabulator_Test::test_clean_text_value` table +
the PCRE `$`, single-pass, exact-spelling edges); `test/unit/tool_export_coverage_native.test.ts`
C4 (value, grid_value, preview row, CSV file; `dedalo_raw` control) and C5 (plain value passes
through). Frozen parity gates: banked reds unchanged (measured before/after).

## Addendum 2026-11-13 — the tag marks are no longer "untouched"

Owner C43 (T1-39 D1) ruled "plain text": `cleanTextValue` now strips every
text_area tag mark BEFORE the cleanup above, so the "Not a sanitizer" clause's
example of an untouched `[index-…]` no longer holds — the marks go, other
markup (`<b>`) still stays. The contract, the grammar matched and the gate:
`WC-2026-11-13-export-tag-marks-plain-text`.
