# WC-2026-11-13-text-area-broken-tag-repair — the edit read of a transcription surfaces its broken index/draw tags in blue

- **Date:** 2026-11-13.
- **Decision:** RC-closure T1-41 / audit O06 (`fix_broken_index_tags` not
  ported). DEC-12 gate: `test/unit/text_area_broken_tag_repair_native.test.ts`
  (pure repair P*, real `readSection` edit/list reads + the save-echo
  decoration S* on the `zztags` scratch situation, which gained the
  `tags_draw` → `zztags11` pointer).
- Code: `src/core/components/component_text_area/tag_integrity.ts` (the
  repair), `tag_locators.ts` (the host-record tag-locator reader, moved out of
  `tags_info.ts`), `emit.ts` (`decorateItem` → `repairTagIntegrity`).

## Shape before (TS)

The EDIT item of a text_area declaring `properties.tags_index` and/or
`properties.tags_draw` (shipped: rsc36 → rsc860, rsc30 → rsc1369) carried the
stored text verbatim. An index mark whose partner was lost, or an indexation /
draw locator whose mark was lost, never showed in the editor.

## Shape after (TS) = PHP component_text_area::fix_broken_index_tags

On the EDIT item — the section read AND the scalar save echo (which replaces
the client's data; PHP's echo ran the same JSON controller) — each non-empty
stored text of the item's `entries` is served repaired:

- an unpaired `[/index-…]` gets `[index-d-<id>-<label>-data:<data>:data]`
  right before it; an unpaired `[index-…]` gets
  `[/index-d-<id>-<label>-data:<data>:data]` right after it (label/data copied,
  `"` → `'` as `TR::build_tag`);
- each index locator `tag_id` with no index mark in the text gets
  `[index-d-<id>--data::data][/index-d-<id>--data::data]` prepended, each draw
  locator `tag_id` with no `[draw-…]` mark gets `[draw-d-<id>-<id>:-data::data]`
  prepended; one prepend per id, so the final text starts with the draws, then
  the index pairs, each group last-locator-first;
- a repaired item's `fallback_value` is `null` (PHP computed the fallback after
  the repair; a repaired text is never empty).

Nothing is written: the repair persists only if the user saves the text. List,
tm, diffusion and raw reads are unchanged. The client already renders state
`d` (blue) index/draw tags.

## Divergences from PHP (deliberate)

1. A synthetic partner is inserted at each MATCHED position, exactly once.
   PHP `str_replace`d the whole text inside its per-match loop: a broken tag
   occurring twice got two partners at each occurrence, and the same bytes
   inside other tags' data payloads were rewritten too.
2. A locator `tag_id` is used only when it has the grammar's id shape
   (`^[0-9]{1,6}$`, `tr_marks.ts` TAG_ID_SHAPE); anything else is skipped. PHP
   concatenated the raw stored value into text the editor renders as HTML.
3. Ids compare by numeric value (PHP's loose `==` on digit strings: `07` pairs
   with `7`); locator ids also dedupe by it (PHP's `array_unique` compared
   strings, prepending two pairs for `7` and `07`).
4. The repair message is not produced: PHP built it and the JSON controller
   discarded it; its labels were retired (WC-034).
5. `edit` mode only. PHP's default branch also covered other non-list modes,
   where the TS engine serves no stored text.
6. A linear scanner replaces the PCRE patterns (whose lazy data tail is
   quadratic over a whole text); matching semantics are the same — each family
   (`indexIn`, `indexOut`, `draw`) scanned on its own without overlap, `.` not
   crossing `\n`, the bare `]` fallback after a failed index tail. A label is
   counted in UTF-16 code units (PHP, without `/u`, counted bytes).

## Reason

Orphaned indexations and half-deleted marks were invisible: the user could
neither re-place nor remove them, and they reached publication unnoticed.

## Gate reconciliation

No frozen fixture holds an edit value of a tag-declaring text_area with a
repair (grep of `test/parity/fixtures/oracle_harvest/` for synthetic
`index-d-<id>--data::data` / `draw-d-`: none). No fixture changes.
