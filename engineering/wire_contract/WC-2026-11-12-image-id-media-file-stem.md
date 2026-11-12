# WC-2026-11-12-image-id-media-file-stem — a component_image's `properties.image_id` names its files again

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-10 / audit O06 (PHP parity port, `component_image::get_id`,
  frozen `class.component_image.php:158-219`; v6 `class.component_image.php:95-117`
  identical). DEC-12 gate: `test/unit/media_image_id_native.test.ts` (L1-L9, scratch TLD
  `zzmiid`); census widened: `test/unit/media_ingest_properties_native.test.ts` (the
  section-scoped `resolveMediaPathOptions` callers are scanned in `src/` AND `tools/`).
- Code: `src/core/media/path.ts` (`MediaPathOptions.fileIdOverride`, `mediaFileId`,
  `assertMediaFileStem`), `src/core/media/ontology_path.ts` (`resolveFileIdOverride`,
  record-scoped `resolveMediaPathOptions(…, sectionId, { record })`,
  `completeMediaPathOptions`, `recordFromColumns`, `flatItemsValue`),
  `src/core/media/svg_overlay.ts`, `src/core/media/file_ops.ts` (snapshot read through the
  resolver; never copy onto itself), `src/core/media/tool_support.ts`,
  `src/core/media/component_emit.ts`, `src/core/section/indexation_grid.ts`,
  `src/ai/rag/image_source.ts`, `src/core/identify/preview.ts`,
  `tools/tool_posterframe/server/index.ts`, and the six ingest callers'
  `original_normalized_name` (tool_upload, tool_import_files, tool_import_zotero,
  tool_numisdata_acquisition, tool_bibliography_acquisition, MCP media tool).

## Shape before (TS)

- Every file path was `{component}_{section}_{id}[_lang].{ext}`; only the indexation grid's
  cell URL read `image_id`. For rsc29 (Images, `image_id: rsc34` 'Filename') a PHP-era
  record whose files are `photo_2.*`: `base_svg_url` null (the edit view showed the
  placeholder), upload/regenerate wrote `rsc29_rsc170_N.*` beside the PHP files, a rescan
  found nothing (held SHRINK, or a dropped index with `--allow-shrink`), record delete left
  the stem files live, RAG/identify thumbs missing.
- `original_normalized_name` was always the identifier name.

## Shape after (TS) = PHP get_id case 2, with the divergences below

- A `component_image` declaring `image_id` whose sibling (lg-nolan first, else every item,
  joined ` | `, trimmed) is non-empty names EVERY file by that value — quality files,
  thumb, SVG envelope (`files_info[].file_path`, upload/regenerate results,
  `base_svg_url`, grid cell URL, `original_normalized_name`). NO lang suffix (PHP).
  Empty → the identifier, as before. Any other model's `image_id` is inert (PHP:
  image-only).
- `buildMediaIdentifier` keeps meaning the clone signature (PHP `get_identifier`):
  counter reconcile, the files_info FOREIGN check, log labels, av fragment/subtitles.

## Divergences from PHP (deliberate narrowings)

1. **Refused stems** (`media.invalid_identifier`, before any write): `.`/`..`, `/`, `\`,
   NUL / C0 controls / DEL, `"` `<` `>` (T0-10 attribute law); and a value the
   media-protection grammar (`MEDIA_FILENAME_GRAMMAR`) maps to ANOTHER record — it would
   be published with that record and is, by name, that record's file. A stem mapping to
   this record (its own identifier included) is accepted. PHP wrote any value. In the
   edit view a refused stem yields `base_svg_url: null`; the grid and the tools refuse.
2. **Duplicate of a stem-named record** (interim, owner decision T1-10 OD-1 open): source
   and clone resolve to the same files; the copy throws `media.operation_failed` instead
   of copying a file onto itself → per-component `error`, verdict stage `copy`, the clone
   indexes the shared files. PHP copied onto itself.
3. **Not ported:** PHP case 1 (an `external_source` IRI's file name wins over image_id) —
   owner decision T1-10 OD-2. Renaming files when the sibling changes after upload is not
   done (PHP parity; owner decision T1-10 OD-3).

## Data already written

- PHP-era stem files are found again; no repair step.
- TS-era identifier-named files of an image_id record (uploaded before this entry) are NOT
  migrated (v7 TS beta: no TS-era data compat); a rescan of such a record sees them as
  not-built names (held SHRINK).

## Gate reconciliation

- No frozen fixture changes: the grid fixture path already honoured `image_id`
  (now through the writer's own `resolveFileIdOverride`); no re-harvest.
- `engineering/MEDIA_SPEC.md` (files_info sweep paragraph) amended: an `image_id` stem is
  built, only an unresolvable one is a held SHRINK.
