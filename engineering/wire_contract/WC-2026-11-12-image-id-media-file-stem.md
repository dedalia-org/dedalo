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
   be published with that record and is, by name, that record's file. Only a TIPO-shaped
   section token (letters then digits) names a record: `IMG_20230512_142233` or
   `inv_1987_23` (an all-digit token) is a plain stem (T1-10 review). A stem mapping to
   this record (its own identifier included) is accepted. PHP wrote any value. In the
   edit view a refused stem yields `base_svg_url: null`; in the indexation grid that ONE
   cell's value is `''` (logged typed, the grid still answers — T1-10 review); the tools
   refuse.
2. **Shared stems** (interim, owner decision T1-10 OD-1 open). Two records whose sibling
   values are equal (same component folder and bucket) address the SAME files, as in PHP —
   and that includes every duplicate of a stem-named record. The duplicate's copy throws
   `media.operation_failed` instead of copying a file onto itself → per-component `error`,
   verdict stage `copy`, the clone indexes the shared files (PHP copied onto itself).
   Delete and upload keep PHP behaviour until OD-1 rules: an upload to one record
   overwrites the shared master; deleting one record (the clone included) moves the
   shared files to `deleted/`, so the other record loses its media (recoverable from
   `deleted/`). No refusal is made for a stem another record already uses, nor across
   project scope.
3. **Deleted-version scan** (T1-10 review): restore and the time-machine deleted reads
   match `<stem>_deleted_<stamp>.<ext>` exactly (stamp `Y-m-d_Hi` or PHP's `Y-m-d_Gis`),
   not PHP's `glob("<id>_*")` prefix — a free-text stem `coin` must not take
   `coin_reverse`'s soft-deleted bytes.
4. **Not ported:** PHP case 1 (an `external_source` IRI's file name wins over image_id) —
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

## Addendum 2026-11-13 — shared stems refused, stem locked while files exist, duplicate clears (T1-10 OD-1 ruled c+b, OD-3 ruled c)

Owner rulings 2026-11-13 (T1 owner decisions C20, C22) close divergence 2 and
the OD-3 half of divergence 4. Code: `src/core/media/stem_rules.ts` (the rules),
`src/core/section_record/record_write.ts` §3i (every key write of an image_id SIBLING takes the
transaction path and is judged under the owner's row lock before its UPDATE; the atomic append
refuses such a key and `save_component.ts stemRuledInserts` routes it to the full-array
persist), `src/core/media/ingest/process_uploaded_file.ts` (the upload door),
`src/core/db/matrix.ts readOtherSectionIdsHoldingValue` (the ONE probe),
`src/core/section/record/duplicate_record.ts` step 1c + `file_ops.ts duplicateSectionMediaFiles`
(the clone's own options). Registry: `media.stem_in_use`, `media.stem_locked` (both `conflict`
409, public). Gate: `media_image_id_native` L8 (flipped), L12, L13.

**C20 (c) — a stem is UNIQUE in its section.** Saving an image_id sibling to a value whose
trimmed stem another record of the same section stores on that sibling is refused inside the
save's transaction, nothing written:

```
{ok:false, error:{code:'media.stem_in_use', status:409,
  message:"The file name 'photo_2' is already used by record rsc29/7 of this section: choose another one",
  details:{section_id:7}}}
```

The upload door asserts the same before the staged file is moved (a PHP-era pair that already
shares a stem — stored before this rule — is refused there; the staged file stays staged).
The probe is ONE containment `"<column>" @> '{"<sibling>":[{"value":"<stem>"}]}'` (the
per-column `jsonb_path_ops` GIN shape), BYTE-EXACT on the stored item value: a stored value that
differs only by surrounding whitespace resolves to the same stem (the resolver trims) but is NOT
matched — a PHP-era residue the D01-class repair step owns, not this rule. Re-saving a record's
own stem (padding included) is no "other record". Project scope is not consulted: uniqueness is
a section fact.

**C22 (c) — a non-empty stem is LOCKED while managed files exist under it.** Changing (or
clearing) an image_id sibling whose stored stem has any `managedFileSlots` file on disk — every
quality × managed extension of every component_image naming that sibling, under the record's
bucket — is refused inside the save's transaction:

```
{ok:false, error:{code:'media.stem_locked', status:409,
  message:"The file name 'photo_2' cannot be changed while media files exist under it (/image/original/0/photo_2.jpg, /image/1.5MB/0/photo_2.jpg): delete the media first, then rename",
  details:{files:'/image/original/0/photo_2.jpg, /image/1.5MB/0/photo_2.jpg'}}}
```

The stored stem is NOT re-asserted against the stem law here (a bad stored value has no files
and must stay replaceable). The remedy is the sentence: delete the media (the record's media
tools), then rename. PHP orphaned the files. Every chokepoint key entry is judged — a Time
Machine restore of the sibling to an older value while files exist under the current one is
refused too (the restore is a change of the stem like any other).

**C20 (b) — the DUPLICATE clears the clone's sibling.** The clone is inserted WITHOUT its
image_id sibling value(s) (its column key absent), so its files are copied under
`{component}_{section}_{clone}.{ext}` — the identifier — never onto the source's stem file;
the per-component `error`/verdict stage `copy` of divergence 2 is gone, and the clone's verdict
carries `clearedStemSibling: '<sibling tipo>'`. The interim copy-onto-itself refusal in
`file_ops.ts duplicateMediaFiles` is now an `internal.invariant` assertion (unreachable through
the engine's doors). A curator who wants the clone stem-named sets a NEW stem on it (unique by
C20 c) and uploads.

**Still PHP / unchanged:** delete keeps moving the record's OWN stem files to `deleted/` (no
other record can share them any more); divergence 4's OD-2 (`external_source` precedence) stays
deferred (C21).

No frozen fixture is affected; no re-harvest.
