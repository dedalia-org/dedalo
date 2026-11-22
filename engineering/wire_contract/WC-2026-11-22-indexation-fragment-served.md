# WC-2026-11-22-indexation-fragment-served — the indexation grid's text fragment is served rich text

- **Date:** 2026-11-22 (T2 batch B5: D03-b-b; the B3 half is D03-b-a).
- **Decision:** T2 triage row D03-b; WC-042 (stored media src is same-origin relative).
  Code: `src/core/section/indexation_grid.ts` (`servedFragmentText`),
  `src/core/components/component_text_area/emit.ts` (`servedTextPreview`).
- **Shape before (PHP, and TS before this entry):** the tagged fragment was the stored slice
  (marks deleted, entities decoded); the untagged fallback was `truncate_html(220, text)`
  THEN `deleteMarks`. Neither rebased a media `src` (PHP had no split origin), so on a
  split-origin install the fragment's images pointed at the app origin, which serves no media.
- **Shape after (TS):** the tagged slice is rebased onto `config.media.webBase`
  (`appServedMediaSrc`); the untagged fallback is `servedTextPreview(deleteMarks(text), 220)`
  — rebase → tags → HTML truncate. Marks are deleted BEFORE the cut, so the 220 chars count
  readable text and a cut never leaves half a mark (PHP counted mark characters and could
  leave a broken `[TC_…` stub). The source is first capped at the served-preview bound
  (`LIST_SOURCE_CAP`, 16 KB — DOS-01: deleteMarks is quadratic on unterminated `-data:`
  openers), so a mark straddling that cut in a text with under 220 readable chars before it
  can survive; the preview is memoized per source text for one grid build. Same-origin
  installs: the src is unchanged.
- **Reason:** every served rich text goes through one served-text helper (D03-b).
- **Gate reconciliation:** `test/parity/indexation_grid_differential.test.ts` reds are
  corpus-bound and identical before/after (7, banked); no fixture edit, no re-harvest. Gate:
  `test/unit/text_area_media_src_split_origin.test.ts` (grid leg: split and same origin,
  tagged + untagged, no mark left); `test/unit/dos_bounds.test.ts` (1 MB adversarial source
  bounded; 300 rows on one text = one computation).
