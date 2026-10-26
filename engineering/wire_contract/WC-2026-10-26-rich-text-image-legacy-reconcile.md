# WC-2026-10-26-rich-text-image-legacy-reconcile — two reconciles bring historic rich-text images under rule B

- **Date:** 2026-10-26 (TODO-069, follow-up of WC-2026-10-26-rich-text-image-record-keyed).
- **Decision:** DEC-12 (gated: `test/unit/rich_text_image_reconcile.test.ts`, mutation-checked;
  `reconcile_registry_native` planters; `reconcile_registry_tripwire` facets).
- **Shape before (TS):** images inserted before TODO-066 keep their original name (`pic.jpg`) behind
  any historic `src` prefix (`../../../media/image/web/x?<cachebust>`, `/dedalo/media/…`, a v6 custom
  root) and stay login-only. And since `image/web` became public, a legacy name that happens to end
  `_<tipo>_<id>` of a PUBLISHED record is served anonymously whoever embeds it.
- **Shape after (TS):** two registered reconciles (`REGISTERED_NAMES`, the `reconcile` gauge, the
  `reconcile_status` widget, `scripts/reconcile.ts`):
  - `rich_text_images` (operator): drift = an `<img src>` in a text_area that is not the stored form
    (`/dedalo/<mediaDir>/image/<web>/<name>`) of a file keyed to ITS record. Apply copies the file to
    `<sanitized stem>[-n]_<section_tipo>_<section_id>.<ext>` (claimKeyedWebImage, the upload's own
    rule; one copy per embedding record, the original kept) and rewrites the `src` via
    `saveComponentData` per lang (TM row, actor root `-1`, no modified stamp; the html write gate
    sanitizes the whole text, as every save). A referenced file missing from the web folder is
    reported (`detail.missing`), its text untouched. A slice stored under a lang the save would not
    write (`effectiveSaveLang`: a non-translatable text holding `lg-eng`) or a component with
    lang-less items is HELD (`detail.held`) — a `set_data` save would add a copy / drop items.
    Apply is root only (it makes login-only files public).
  - `web_image_exposure` (boot, dry): drift = a web-folder file whose name parses to a key with a
    `pub/` marker while that record's own text does not embed it; files younger than 24 h are held
    (`detail.recent`). Apply (root only) links (or, without hardlinks, exclusively copies) it to
    `<stem>.legacy[N].<ext>` — out of the grammar, a `_lg-xxx` suffix included — repoints every
    embedding text found by the `_<tipo>_<id>` needle (raw, %- or entity-encoded; TM row), and
    unlinks the old name only once a re-scan of every string of those records resolves nothing to
    it; a held slice, a failed save or a reference outside a rewritable text keeps both names.
  - Both run DRY in `POST_RESTORE_PLAN`.
- **Reason:** delivered with the code update to every installation and visible remotely (gauge), with
  "re-run reports 0" as the proof — never an operator-only script.
- **Limits:** a Time Machine snapshot taken before a `web_image_exposure` rename shows its image broken
  to logged-in users; `src` values single-quoted are not matched (none measured).
- **Gate reconciliation:** no parity fixture holds a rich-text image (no re-harvest needed).
