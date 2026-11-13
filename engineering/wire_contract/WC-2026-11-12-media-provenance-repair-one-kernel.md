# WC-2026-11-12-media-provenance-repair-one-kernel — both regenerate doors restore a lost original file name through ONE kernel

- **Date:** 2026-11-12 (landed 2026-11-13).
- **Decision:** RC-closure T1-P04 (audit P04: the update_cache vs sync_files
  provenance repair drifts). DEC-12 gate:
  `test/unit/media_provenance_repair_native.test.ts` (P1-P10, both doors; P8-P10 measure the lg-nolan sibling slice and divergences 1 and 3, on
  the `zzpv` scratch situation and the suite media root).
- Code: `src/core/media/provenance_repair.ts` (`resolveProvenanceRepair`,
  `applyProvenanceRepair`, `mediaItemTargetIndex`); doors
  `tools/tool_update_cache/server/index.ts` (`updateCache`, media branch) and
  `tools/tool_media_versions/server/media_versions.ts` (`syncFiles`, through
  `repairStoredFilesInfo(input, provenance)` in
  `src/core/media/tools/files_info_persist.ts`). The sibling slice rule is
  `siblingStringValues` (`src/core/media/ontology_path.ts`), shared with the
  path readers.
- Amends: WC-043 (`original_file_name` restoration bullet).

## Shape before (TS)

The stored provenance of a media item depended on which door the operator used:

- `sync_files` (media_versions "Regenerate files"): no repair at all. A lost
  `original_file_name` stayed lost.
- `update_cache`: a private copy that wrote `items[0]` whatever its lang, built
  `original_normalized_name` as `<tipo>_<section>_<id>.<ext>` (no lang suffix,
  no `image_id` stem, the extension's case kept: `….TIF`), took the first
  non-empty sibling value in ANY lang, and applied the repair AFTER the rescan,
  so the rescan never read the recovered cue.

## Shape after (TS) = PHP regenerate_component step 1, one kernel

Both doors (PHP v6 `component_media_common::regenerate_component` :2668-2705):

- The name comes from the component's `properties.target_filename` sibling,
  read like PHP's lg-nolan read: the lg-nolan (or lang-less) items, else every
  item; the first non-empty value (`$filename_data[0]`).
- Target item: the item of the request data lang for a translatable component,
  the first item otherwise. No such item: nothing happens.
- Fill only what is absent: `original_file_name` when it is not a non-empty
  string; `original_normalized_name` = `<file id>.<lowercase ext>` when absent
  too. `<file id>` is `mediaFileId` — the record's `image_id` stem when the
  image declares one, else the identifier with the lang suffix for translatable
  media (PHP `get_id`).
- Applied under the row lock, BEFORE the rescan (PHP's `Save()` re-scan reads
  the repaired cue). `sync_files` also scans with the repaired cue (it scans
  before the lock) and applies the repair again under the lock, after its
  mint or merge.

## Divergences from PHP (deliberate)

1. `''` counts as absent (PHP `isset` treats it as present): an empty name is no
   provenance.
2. The repair runs the same way for every media model, including a
   `component_pdf` whose original file is missing (PHP's pdf override returned
   early there by accident of its structure).
3. `original_normalized_name` is set only when the recovered name has a plain
   alphanumeric extension: the value is curator free text and becomes part of a
   file name. PHP built `<id>.` or `<id>.<anything>`.
4. NOT ported (owner decisions T1-P04 OD-1/OD-2, open): PHP steps 2-3
   (normalized names guessed from the files on disk when no `target_filename`
   value exists) and `original_upload_date` / `modified_upload_date` from the
   file's ctime. Values update_cache wrote wrongly before this entry (no lang
   suffix, wrong item, uppercase extension) are not corrected by a
   fill-only-absent repair (OD-3, open).
5. `sync_files` scans before the lock; a raw-original cue changed by a
   concurrent upload between the scan and the lock is seen on the next run
   (the update_cache shape rescans under the lock).
