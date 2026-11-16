# WC-2026-11-13-export-tag-marks-plain-text — text_area tag marks are STRIPPED from exported value / grid_value cells (PHP rendered `<img>` badges)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C43 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-39 D1): "plain text". Closes the open decision named in
  `WC-2026-11-12-export-text-cell-clean` ("what a text_area atom renders its
  tags as is open owner decision T1-39 D1" — addendum there). DEC-12 gate:
  `test/unit/export_clean_text.test.ts` (C43 block: one case per grammar shape,
  the non-mark controls, the joined-cell case).
- Code: `src/diffusion/export/clean_text.ts` — `stripTagMarks` + `TAG_MARK`,
  run by `cleanTextValue` BEFORE the PHP cleanup.

## Shape before (PHP)

`component_text_area::get_export_value` (`class.component_text_area.php:248`,
v6 `get_grid_value:168`) ran `TR::add_tag_img_on_the_fly` on each atom: every
in-text tag mark (`[index-n-58-label]`, `[/index-n-58]`, `[TC_00:01:02_TC]`,
`[person-a-7-JD]`, `[geo-…]`, `[page-…]`, `[note-…]`, `[lang-…]`, `[draw-…]`,
`[svg-…-data:{…}:data]`) became an
`<img src="…/component_text_area/tag/?id=…">` badge INSIDE the cell. A CSV
carried that markup; the HTML download drew badges whose `src` pointed at the
exporting server.

## Shape before (TS, until today)

The `string` family emitted the stored text verbatim: the raw marks reached
every file, the NDJSON download and the preview (`relation_list.ts`
`resolveCellItems`; `WC-2026-11-12-export-text-cell-clean` cleaned paragraphs
and entities and left the marks).

## Shape after (TS)

`cleanTextValue` (the tabulator's one cleanup — every value / grid_value cell,
after the join, never dedalo_raw, never an interactive reader) first removes
every tag mark, then applies the PHP cleanup:

- the marks removed are EXACTLY the text_area grammar's in-text shapes
  (`tag_grammar.ts` RE_TC, RE_INDEX … RE_DRAW, the `svg` locator mark): type
  word, state letter, numeric id, the optional `-label` (≤ 22 chars, no `-`),
  the optional `-data:…:data` payload (lazy to the first `:data]`, newlines
  included); `person` with an empty id; `[/index-…]`;
- the mark is removed and nothing else — its neighbours stay as stored (two
  spaces around a removed mark stay two spaces; no re-flow);
- bracketed text that is not a mark (`[1]`, `[sic]`, `[index]`, a JSON array in
  a json cell) is text and stays;
- a cell that is one mark cleans to `''` (kept / dropped by the format's own
  empty-cell rule, as before).

DIVERGENCE from PHP, stated: a mark is a pointer into the record's indexation
(the tag's locators are exported through their own components), not text; a
spreadsheet cell cannot show a badge, and markup in a CSV is not plain text.
The owner chose plain text over `<img>` (PHP) and over the raw marks.

Edge, stated: a `json`-family cell whose STRING holds a literal tag mark is
rewritten too (the cleanup runs on the joined cell and cannot tell a json
string from text); no vendored component stores text_area marks inside a
component_json value, and array brackets never match (the alternation names the
eight type words).

## Reason

The cell is read as plain text (the whole reason the cleanup exists); PHP's
badge was the browser's rendering leaking into a file.

## Gate reconciliation

`export_clean_text` C43 cases would be RED on the previous `cleanTextValue`
(marks kept); `tool_export_coverage_native` C4 unchanged (its text holds no
mark). No frozen fixture replays an exported text_area with marks.
