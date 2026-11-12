# Rebuild the Dédalo media subsystem in native TypeScript

Standing spec for the media family, companion to `engineering/REWRITE_SPEC.md` (whose constraints — §2 absolute constraints, §2b code style, §4 concurrency/persistent-runtime, §7 security — apply here unchanged), `engineering/SECTION_SPEC.md` (media components live inside sections; the delete/duplicate/save record lifecycle is shared), and `engineering/RELATIONS_SPEC.md`. PHP reference tree: `./v7_php_frozen/master_dedalo` (read-only). All `file:line` anchors below point into that tree and have been verified against it (2026-07-03). Live-ontology corpus from `dedalo_mib_v7`.

Scope: the five media component models (**component_image, component_av, component_pdf, component_svg, component_3d** + `component_media_common`, the PHP base they all extend, as the shared TS core), the media processing engine (ImageMagick / ffmpeg / pdf tools), the upload ingest pipeline, and the media tools (**tool_upload, tool_media_versions, tool_posterframe, tool_image_rotation, tool_pdf_extractor, tool_tc, tool_transcription (local half), tool_import_files**).

**Absolute engine constraint (user direction):** all media processing shells out to external binaries — **ImageMagick, ffmpeg/ffprobe, qt-faststart, pdftotext/pdftohtml, pdfinfo, ocrmypdf** — via `Bun.spawn`. **No third-party TS/npm media libraries** (no sharp, jimp, fluent-ffmpeg, pdf-lib). The tree is already clean of them; keep it that way.

**Absolute config constraint (user direction, 2026-07-03):** formats, qualities, extensions, thumbnail dimensions, folder names, and binary paths are **configuration, not code** — defined through the config system (`<private>/.env` + the typed config catalog), exactly as PHP defines them in `core/base/config/catalog/domains/media_image.php` / `media_av.php` / `media_docs.php`. Keep the PHP `DEDALO_*` key names and PHP defaults; an installation must be able to tune the media catalog without touching a module (§3).

Out of scope, explicitly ledgered — never silently narrowed:

- **Media protection (marker store / fixed-name auth cookie / `media_index` / `.htaccess`+nginx rules)** — its own subsystem with three lockstep enforcement surfaces. **LANDED NATIVE 2026-07-12** (was PHP/web-server-owned, with TS only *reporting* it): `src/core/media/protection.ts` mints `dedalo_media_auth` at login, owns `.publication/auth/`, and GENERATES both rule files; `media_index.ts` owns `pub/` + `dbs/`; enforcement stays in the web server (one `stat()` per request — nothing may sit in the byte path of a 32 GB file). Out of scope **of this spec**, but no longer a gap: the definition is `engineering/MEDIA_PROTECTION.md`. Closes MEDIA-01 / SECURITY_DECISIONS DECISION 1(B).
- **Babel / Whisper remote transcription API** (`tools/tool_transcription/transcribers/babel/`) — external network service + credentials; only the local/ffmpeg seams (`audio`/`audio_tr` builds, VTT subtitle write, `tool_tc`) ship here.
- **3D format converters** (`DEDALO_3D_GLTFPACK_PATH` / `_FBX2GLTF_PATH` / `_COLLADA2GLTF_PATH`, `media_docs.php:190-206`) — defined as constants but **never invoked** in the reference tree; `component_3d` has no `build_version` override, so `web` is a naive copy. Port the copy; ledger the converters as PHP-dead.
- **PHP `processes` table interop** — TS jobs are TS-visible only (sessions are not shared between the two servers); documented, not a gap.
- **tool_subtitles server side** — `API_ACTIONS = []` (`class.tool_subtitles.php:69`); a purely client-side editor. VTT files are written server-side by `tool_transcription::build_subtitles_file` (§8), not here.

Keep a coverage ledger of what the rebuild does not yet cover.

---

## 1. Mission & honest status

> **ADDENDUM 2026-08-24 (module homes — read this before the rest of the spec.)**
> Three of the TS modules this spec's older text names **no longer exist under
> those paths**; the paths are corrected in place below, and the salvage/design
> prose that referenced them now means the current homes:
> - the `media_control` dashboard widget is **not** in a `resolve/widget_request.ts`
>   monolith: it is one widget module,
>   `src/core/area_maintenance/widgets/media_control.ts` (`get_value:
>   mediaControlGetValue`), listed in `src/core/area_maintenance/widgets/registry.ts`
>   and reached through the `dd_area_maintenance_api` `widget_request` /
>   `get_widget_value` actions
>   (`src/core/api/handlers/dd_area_maintenance_api.ts`);
> - **`src/core/resolve/tool_request.ts` and its `TOOL_API_ACTIONS` export are
>   gone.** Tool dispatch is `src/core/tools/dispatch.ts` +
>   `src/core/tools/registry.ts`, and a tool's actions are declared per tool in its
>   `register.json` with a `permission` / `minLevel` spec
>   (`ToolActionSpec`, `src/core/tools/module.ts`). Where §5/§9/§10 say "register
>   in `TOOL_API_ACTIONS`", read "declare the action in the tool's `register.json`
>   with its permission spec"; the argument the spec makes — an EXPLICIT registry
>   with declarative permission specs and no reflection, strictly stronger than
>   PHP's 8-gate chain — is unchanged and now stronger still (`record_tipo` gates
>   component tipo AND record scope in one spec, the gate for the whole media
>   family);
> - `src/core/resolve/backup.ts` → `src/core/area_maintenance/backup.ts` (the
>   spawn pattern §5 points at as proven).
>
> Date is the date of record, not of the move: repo history is squashed at the
> 2026-07-11 initial commit, so the moves are not datable from `git log`.
> Nothing about the media DESIGN changes — only where the modules live.

**Media components store no pixels in the database — they store a materialized *index* (`files_info`) of files living in a shared on-disk layout, regenerated from the filesystem on every `save()`.** The DB row is a cache of the disk; the disk is addressed by a deterministic grammar (identifier + quality directories + numeric buckets). Everything else — upload, derivative generation, rotation, posterframes, OCR, soft-delete — is choreography around that invariant. Because the PHP and TS servers share the SAME database AND the SAME media directory (`REWRITE_SPEC §2.2`), byte/structure compatibility of *both* surfaces — the stored `files_info` JSON and the on-disk file layout — is non-negotiable.

The current TS implementation is judged **not done correctly** and is hereby superseded as a foundation. What exists is real and differential-gated, but it is **read-only projection glue only** — the entire ingestion/derivative half of the subsystem is absent:

- **No ingestion at all.** There is no upload endpoint, no derivative/quality generation, no `Bun.spawn` of any media binary, no posterframe/thumbnail/transcode/metadata extraction. `dispatch.ts` has save/read/delete/duplicate actions but no upload/process action. The engine assumes `files_info` was already populated by the legacy PHP media engine and merely reads/serves/moves those records. "Not done correctly" is really "barely started."
- **Quality knowledge is hardcoded and incomplete.** `src/core/resolve/media_list_value.ts` hardcodes `LIST_QUALITIES` for `component_image` (`['1.5MB','thumb']`), `component_svg` (`['web']`), `component_pdf` (`['web','thumb']`) — **`component_av` and `component_3d` are absent**, so `isMediaModel('component_av')` is `false` and AV/3D are unsupported on the read path. Default qualities are scattered as literals across `media_list_value.ts`, `relation_list.ts:264-300`, and `environment.ts:103-171` instead of centralized in config. **This is the named defect the §3 config mandate fixes.**
- **Files are trusted-as-stored, never computed.** No path builder derives `{model}/{quality}/{bucket}/{id}.{ext}` from a record; the engine cannot regenerate or verify a missing derivative. `file_path` is passed through verbatim from the stored `files_info`.
- **Duplicate does not copy physical files.** `duplicate_record.ts:20` explicitly ledgers "media-file duplication (physical file copies + regenerate)" as a TODO; the jsonb `files_info` is copied but the files are not.
- **Media protection is native and enforced** since 2026-07-12 — out of scope of THIS spec, but no longer a reporting shell (`engineering/MEDIA_PROTECTION.md`).

**Salvage (proven — keep, do not rewrite blind):** the delete-time soft-move `removeSectionMediaFiles` (now `src/core/media/file_ops.ts`, paired with its restore and unit-gated by `test/unit/media_lifecycle_native.test.ts`; the `delete_record.ts` copy this line originally pointed at was inert on a default install and is deleted); the dev-only session-gated serving route (`src/server.ts:126-155`, traversal-guarded, fail-closed 404); the media export cells (`tool_export` media URL resolution, `STATUS.md:594`); the `media_control.get_value` dashboard widget (now `src/core/area_maintenance/widgets/media_control.ts`, registered in `widgets/registry.ts`, served through the `dd_area_maintenance_api` `widget_request`/`get_widget_value` actions); the explicit, reflection-free tool dispatch registry (now `src/core/tools/dispatch.ts` + `src/core/tools/registry.ts`, per-tool `register.json` permission specs); the media list/read differentials (image/svg/pdf list-mode byte-parity, `model_coverage_sweep.test.ts`). The differential suite is the validation harness: it must stay green throughout with **zero fixture/normalization changes** (the relations/section/area rebuild rule).

---

## 2. The unifying model — five types, four laws

PHP class tree (verified): `component_common` → `component_media_common` (`core/component_media_common/class.component_media_common.php:137`, `use search_component_media_common`) → { `component_image`, `component_av`, `component_pdf`, `component_svg`, `component_3d` }. Canonical registry: `component_media_common::get_media_components()` = `['component_3d','component_av','component_image','component_pdf','component_svg']` (`:309`). Each subclass mostly just reads the config constants of its type (§3) and overrides the per-type processing hook.

Four laws every module below serves:

1. **Identity law.** Identifier = `{component_tipo}_{section_tipo}_{section_id}` plus `_{DEDALO_DATA_LANG}` when the ontology node is translatable (`get_id` `:649-681`, lang suffix `:672-674`; `get_name` is an alias `:692`). The file for a quality = `get_media_path_dir(quality) . '/' . id . '.' . ext` (`get_media_filepath :3356`). The directory = `DEDALO_MEDIA_PATH + /<type_folder> + <initial_media_path> + /<quality> + <additional_path>` (`get_media_path_dir :2859`). `initial_media_path` is an optional per-section top-level segment (`get_initial_media_path :715`). `additional_path` is the numeric bucket subfolder: either a value pulled from another component, or `'/' + max * floor(section_id / max)` from `properties.max_items_folder` (`get_additional_path :753-819`) — this yields the `/0`, `/1000` buckets seen in `…/image/1.5MB/0/`. Example file: `rsc29_rsc170_770.jpg` in `…/image/1.5MB/0/`.

2. **Index law.** `files_info` is NOT hand-authored — it is regenerated on every `save()` by scanning the filesystem (`update_component_data_files_info :3710` → `get_files_info :1343` → `get_quality_file_info :2496`, the single authoritative writer). Each entry `{quality, file_exist, file_name, file_path, file_size, file_time(dd_date), extension, external?}` (`:106-126`, `:2496`); `file_path` is stored **relative** to `DEDALO_MEDIA_PATH` (`str_replace(DEDALO_MEDIA_PATH,'',…) :2595`), leading slash; `file_time` from `filemtime()` → `dd_date` (`:2583`); external sources set `external:true` and `file_path` = the external URL (`:2504`). Entry shape, key order, and value formats are DB/wire contract. Sibling keys stored in `data[0]` alongside `files_info`: `original_file_name`, `original_normalized_name` (e.g. `"rsc29_rsc170_770.tif"`), `original_upload_date` (dd_date), `modified_file_name/modified_normalized_name/modified_upload_date` (image retouched tier), `lib_data` (component_image only).

3. **Original law.** The `original` tier holds BOTH the raw upload (e.g. `.tif`) and a normalized default-ext copy (`.jpg`) side by side. `get_original_extension :2689` finds the raw one (excludes files matching `get_target_filename`); `get_original_file_path :2764` prefers the normalized copy as conversion source. The original is **never** rotated, cropped, or transcoded in place — it is the regeneration source of truth; every derivative rebuilds from it (idempotent `regenerate_component :3153`).
   **TS addendum (2026-10-23).** The copy is built by `buildMasterNormalizedCopy()` (`src/core/media/processing.ts`): from the ingest when a master tier receives an upload (`processUploadedFile`, rebuilt — the upload just replaced that tier's raw) and in missing-only mode from `regenerateMissingDerivatives()` (repair). It is encoded at `-quality 100` (PHP `check_normalized_files` parity; the ladder's tiers use 90, PHP's image recipe value), because it IS the full-resolution viewable of the archival master. It is a DISPLAY/INDEX companion, not a conversion source: the engine builds derivatives from the raw upload (`resolveMaster` tries the caller's `rawExtension` first), which preserves the alpha a flattened jpg would lose. It carries no `deleted/` backup (machine-authored, rebuilt from the raw), and a per-file delete of it is honest: the tier keeps the raw and repair rebuilds the copy. The one deliberate divergence from PHP: `add_file` backs up only the target file, not every extension of `<id>.*`, so a previous raw of another extension can survive beside a new one; repair never re-encodes it.
   **PDF coexistence (owner decision 2026-11-11).** For component_pdf that survival is the v6 LAW, not an accident (frozen `component_pdf::rename_old_files :663`): the original tier holds the AUTHORED document (`.doc`/`.odt`/…) beside its PDF RENDITION. Only the rendition is a derivative source — `DERIVATIVE_SOURCE_BY_MODEL` (`src/core/concepts/media.ts`) restricts `resolveMaster` to the default extension for pdf (every other type: any allowlisted raw). A non-PDF original upload rebuilds nothing and returns an ingest notice naming the rendition that still drives web/thumb/covers, or saying there is none (`nonSourceOriginalNotice`). Gate: `test/unit/media_pdf_rendition_source_native.test.ts`.

4. **No-hard-delete law.** Live media never hard-deletes. `delete_file(quality[,ext]) :1711` → `remove_component_media_files :1802` → per quality × extension `move_deleted_file :1929`: target dir `<quality>/deleted[/<bulk_process_id>]`, new name `<id>_deleted_<Y-m-d_Hi>.<ext>` (or plain `<id>.<ext>` in bulk mode) via `rename()`. `rename_old_files :1193` backs up any existing target before every overwrite (same `deleted/` datestamp scheme). Time-machine reads scan `deleted/` for the most-recent match (`get_url` TM mode `:2924-2931`; `get_deleted_image` globs + natsort, `component_image:662`). **Posterframe deletion is the one true `unlink`** (`component_av:509`). `duplicate_component_media_files :1999` copies all quality/ext files to a new section_id.
   **SVG envelope lifecycle (policy 2026-10-23).** The envelope is not a quality file, so it has its own rule: it is retired — **MOVED** to the `svg/…/deleted/` folder like every media delete (restorable) — only when the record holds no file of **any** quality (the whole `managedFileSlots` census: masters, derivatives, thumb, twins). Deleting one tier — even the default one — keeps it. `deleteAndResyncCore` applies the rule after the delete + rebuild, and `regenerateMissingDerivatives` applies it to records emptied before the rule existed. **The drawing goes with it.** The same delete that empties the census clears the stored layers (`lib_data` → null, `svg_file_data` dropped) in the locked media write-back (`reconcileStoredFilesInfo` with `resetDrawing`), so a later upload opens a fresh vector editor instead of loading the deleted picture's vectors over the new image; the cleared value is appended to the Time Machine in the same transaction, so the drawing stays recoverable as the previous version. PHP instead unlinked it as soon as the default quality was removed (`component_image::remove_component_media_files :1643-1658`); that is deliberately NOT the rule here — removing every file left the wrapper loading with a dead `<image>` href and the browser painted a broken-image icon (MEASURED on rsc29_rsc170_463937).

---

## 3. Quality / type catalog — env-defined config (user mandate)

"Quality" = a named sub-directory under the media-type folder, ordered high→low. **Every value in this section is CONFIGURATION, not code** — defined through the TS config catalog + `<private>/.env` under the PHP `DEDALO_*` key names, with the PHP defaults when a key is unset (the same mechanism the tree already uses for `DEDALO_MEDIA_DIR` / `MEDIA_PATH`). `concepts/media.ts` (§5.1) is the typed accessor/validator over that config, NOT a hardcoded source of truth. The current `LIST_QUALITIES` in `media_list_value.ts` and the literals in `environment.ts:103-171` are the defect this replaces.

PHP source: the config catalog domains define each constant as a `config_key{path, const, type, default, doc}` object, `.env`-overridable by dotted `path` — e.g. `media.image.ar_quality` / `DEDALO_IMAGE_AR_QUALITY` (`media_image.php:151`). The TS catalog mirrors these keys.

| Type | Quality ladder (`*_AR_QUALITY`) | Default | Original | Folder | Def. ext | Allowed extensions (`*_EXTENSIONS_SUPPORTED`) | Alt ext |
|---|---|---|---|---|---|---|---|
| image | `original,modified,100MB,25MB,6MB,1.5MB,thumb` | `1.5MB` | `original` | `image` | `jpg` | jpg,jpeg,png,tif,tiff,bmp,psd,raw,webp,heic,avif | `[]` |
| av | `original,1080,720,576,404,240,audio` | `404` | `original` | `av` | `mp4` | mp4,wave,wav,aiff,aif,mp3,mov,avi,mpg,mpeg,vob,zip,flv | — |
| pdf | `original,web` | `web` | `original` | `pdf` | `pdf` | pdf,doc,pages,odt,ods,rtf,ppt | `['jpg']` |
| svg | `original,web` | `web` | `original` | `svg` | `svg` | svg | — |
| 3d | `original,web` | `web` | `original` | `3d` | `glb` | glb,gltf,obj,fbx,dae,zip | — |

**Config-key catalog to mirror** (verbatim PHP const names; group under TS config `media.image.*` / `media.av.*` / `media.pdf.*` / `media.svg.*` / `media.3d.*` paths):

- **image** (`media_image.php`): `DEDALO_IMAGE_AR_QUALITY` (:153), `DEDALO_IMAGE_QUALITY_DEFAULT` (:137), `DEDALO_IMAGE_QUALITY_ORIGINAL` (:121), `DEDALO_IMAGE_QUALITY_RETOUCHED`='modified' (:129), `DEDALO_IMAGE_FOLDER` (:63), `DEDALO_IMAGE_EXTENSION` (:71), `DEDALO_IMAGE_EXTENSIONS_SUPPORTED` (:99), `DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS` (:108), `DEDALO_IMAGE_MIME_TYPE` (:79), `DEDALO_IMAGE_PRINT_DPI`=150 (:166), plus the shared thumb keys `DEDALO_QUALITY_THUMB`='thumb' (:31), `DEDALO_THUMB_EXTENSION`='jpg' (:23), `DEDALO_IMAGE_THUMB_WIDTH`=222 (:43), `DEDALO_IMAGE_THUMB_HEIGHT`=148 (:51).
- **av** (`media_av.php`): `DEDALO_AV_AR_QUALITY` (:98), `DEDALO_AV_QUALITY_DEFAULT`='404' (:83), `DEDALO_AV_QUALITY_ORIGINAL` (:75), `DEDALO_AV_FOLDER` (:24), `DEDALO_AV_EXTENSION` (:32), `DEDALO_AV_EXTENSIONS_SUPPORTED` (:46), `DEDALO_AV_POSTERFRAME_EXTENSION`='jpg' (:111), `DEDALO_SUBTITLES_FOLDER`='/subtitles' (:166), `DEDALO_AV_SUBTITLES_EXTENSION`='vtt' (:174), `DEDALO_AV_RECOMPRESS_ALL` (:187), and the binary paths `DEDALO_AV_FFMPEG_PATH` (:123), `DEDALO_AV_FFPROBE_PATH` (:141), `DEDALO_AV_FASTSTART_PATH` (:132), `DEDALO_AV_STREAMER` (:154).
- **pdf/svg/3d** (`media_docs.php`): `DEDALO_PDF_AR_QUALITY` (:89) / `DEDALO_PDF_QUALITY_DEFAULT` (:81) / `DEDALO_PDF_EXTENSIONS_SUPPORTED` (:39) / `DEDALO_PDF_ALTERNATIVE_EXTENSIONS`=['jpg'] (:48) / `PDF_AUTOMATIC_TRANSCRIPTION_ENGINE` (:100) / `PDF_OCR_ENGINE` (:109); `DEDALO_SVG_*` (:218-267); `DEDALO_3D_*` (:122-206, converters ledgered PHP-dead).
- **binary base**: `MAGICK_PATH` and the ffmpeg/ffprobe/faststart/pdf-engine paths derive from `paths.binary_base` (`/opt/homebrew/bin` on Darwin, `/usr/bin` otherwise — `paths.php:230-236`); expose as config keys so an install can point at its own binaries.

Derived laws (config-driven, not hardcoded):
- **image quality → pixel budget**: `convert_quality_to_megabytes` parses `'1.5MB'`→1.5, `'>100MB'`→101, `'<1MB'`→0.9 (`component_image:576`); pixel area = MB × `350000` (empirical constant, `get_target_pixels_to_quality_conversion :1850-1899`); `short_axis = area/ratio`, `height = sqrt(short_axis)`, `width = height*ratio`; **never upscale** (caps to source `:1358`).
- **quality sanitization (SEC-065)**: `sanitize_quality :2830` allows only `[A-Za-z0-9_\-.]+`, rejects `.`/`..`, else falls back to the original quality; called by both `get_media_path_dir` and `get_media_url_dir`. The TS accessor STRENGTHENS this: charset gate AND catalog membership for the type (§5.1 `assertValidQuality`).

A module reading a hardcoded quality/extension/dimension string instead of the config accessor is a spec violation — the executor must forbid it (the §1 defect).

---

## 4. The processing engine — external-binary command corpus

Two static façade classes in PHP (`core/media_engine/class.ImageMagick.php`, `class.Ffmpeg.php`); all binary dirs derive from `paths.binary_base`. Every command runs `nice -n 19`; every path is `escapeshellarg`-quoted. **The TS rewrite reproduces the argument RECIPES exactly but eliminates the shell entirely (§5.3) — argv arrays, no `escapeshellarg`, no `.sh` files.** The recipes below are the parity contract.

### 4.1 ImageMagick (`class.ImageMagick.php`)
Binary resolution: `MAGICK_PATH.'magick'` if it exists, else `.'convert'` (`:83`); identify = `magick identify` (v7) or `identify` (v6) (`:111`); `pdfinfo` at `MAGICK_PATH.'pdfinfo'` (`:138`).

- **`dd_thumb` (`:184`)** — `nice -n 19 <magick> -define jpeg:size=400x400 <src> -thumbnail '<W>x<H>>' -auto-orient -gravity center -unsharp 0x.5 -quality 90 <dst>` (`:206-209`). `>` = shrink-only. W/H from `DEDALO_IMAGE_THUMB_WIDTH/HEIGHT`.
- **`convert` (`:275`)** — the central engine, command `nice -n 19 <magick> <begin_flags> <src[layers]> <middle_flags> <dst>` (`:466-469`):
  - **Colorspace**: probe `identify -quiet -format '%[colorspace]' <src>[0]` (`:330`); if CMYK → inject `-profile <COLOR_PROFILES_PATH>Generic_CMYK_Profile.icc -profile …sRGB_Profile.icc` then `-strip` (`:408-448`). ICC files vendored from `core/media_engine/lib/color_profiles_icc/`.
  - **Transparency/meta-channel**: `is_opaque` via `identify -format '%[opaque]'` (`:913`); `has_meta_channel` via `identify -format '%[channels]'` on tif/psd only (`:595`). Meta channel → `-channel-fx "meta0=>alpha"`; transparent → `\( -clone 0 -alpha on -channel rgba -evaluate set 0 \)` (`:378-384`).
  - Background `#ffffff` for opaque/jpg else `none`; `-layers merge` (`:388`); optional `-thumbnail`, `-coalesce`, `-composite`, `-flatten`, `-quality`, `-auto-orient`, `-quiet`, `-resize`. PDF source adds `-density <dpi> -antialias -define pdf:use-cropbox=true` (`:342-351`).
  - Non-zero exit is not fatal unless output contains `ERROR:` (`:493`).
- **`rotate` (`:697`)** — `<magick> <src> <color> [+|-]distort SRT <deg> +repage <dst>` (`:717-719`); `+distort` = expanded canvas, `-distort` = fixed. Background: color → `-virtual-pixel background -background <c> -interpolate Mesh`; alpha → `-alpha set -virtual-pixel transparent -background none -interpolate Mesh` (`:707-713`).
- **`crop` (`:781`)** — `<magick> <src> -crop {W}x{H}+{x}+{y} +repage <dst>` (`:795`); fails on `geometry does not contain image` even at exit 0 (`:819-827`).
- **`get_media_attributes` (`:861`)** — `<magick> <file> json:` → decoded array (one object per layer).
- **`get_dimensions` (`:1027`)** — three `identify` calls (`%[orientation]`, `%w`, `%h` on `[0]`); swaps W/H for `LeftBottom`/`RightTop` EXIF orientations (`:1054-1065`).
- **`get_date_time_original` (`:964`)** — `identify -format "%[EXIF:DateTimeOriginal]"`, fallback `%[date:modify]` → dd_date.

### 4.2 Ffmpeg (`class.Ffmpeg.php`)
Binaries `DEDALO_AV_FFMPEG_PATH` / `_FFPROBE_PATH` / `_FASTSTART_PATH` (§3). Settings dir `core/media_engine/lib/ffmpeg_settings` (39 profiles).

- **`build_av_alternate_command` (`:491`)** — the main transcoder. Resolves a settings file `<setting_name>.php` via `get_setting_name` = `<quality>_<pal|ntsc>_<16x9|4x3|…>` (`:274`; PAL/NTSC from `avg_frame_rate`, fps≥29→ntsc, `get_media_standard :321`; aspect from `display_aspect_ratio`, `get_aspect_ratio :909`), `require`s it to import `$vb,$s,$g,$vcodec,$progresivo,$gammma,$force,$ar,$ab,$ac,$acodec,$target_path`. Emits a **two-pass libx264** chain (DVD dirs → `concat:<vob>|<vob>`, `:583-631`):
  - Pass 1: `nice -n 19 <ffmpeg> -i <src> -an -pass 1 -vcodec $vcodec -vb $vb -s $s -g $g $progresivo $gammma -f $force -loglevel error -passlogfile <log> -y /dev/null` (`:766`)
  - Pass 2: `… -pass 2 … -y -acodec $acodec -ar $ar -ab $ab -ac $ac -y <tmp>` (`:773-775`)
  - `nice -n 19 <qt-faststart> <tmp> <target>` then `rm -f <tmp>`, `rm -f <log>*`, `rm -f <sh>` (`:782-793`).
  - Audio-only setting: `nice -n 19 <ffmpeg> -i <src> -vn -acodec $acodec -ar 44100 -ab 128k -ac 2 <target>` (`:710`); `audio_tr` → `-vn -ar 16000 -ac 1` (16 kHz mono for speech-to-text, `:695`).
  - tmp dir = `DEDALO_MEDIA_PATH + '/av' + '/tmp'` (`:635`).
- **`create_posterframe` (`:1075`)** — `<ffmpeg> -ss <tc> -i <src> -y -vframes 1 -f rawvideo -an -vcodec mjpeg -s <WxH> <dst>` (`:1153`). Size by quality: original 936×720 (4×3)/1280×720 (16×9), thumbnail from `DEDALO_IMAGE_THUMB_HEIGHT`, else 540×404/720×404 (`:1118-1130`). `timecode = number_format(x,3)`. Returns false if no video stream (audio-only).
- **`build_fragment` (`:1200`)** — no watermark → `<ffmpeg> -ss <in> -i <src> -t <dur> -vcodec copy -acodec copy -y <dst>` (`:1281`); watermark → stream-copy temp then `-vf "movie=<wm> [watermark]; [in][watermark] overlay=main_w-overlay_w-10:10 [out]"` (`:1273-1274`). TC via `OptimizeTC::seg2tc`.
- **`conform_header` (`:1346`)** — `<ffmpeg> -i <src> -c:v copy -c:a copy <tmp> && mv <src> <src>_untouched && <qt-faststart> <tmp> <src> && rm -f <tmp>` (`:1374-1385`).
- **`convert_to_dedalo_av` (`:1497`)** — one-pass: `nice <ffmpeg> -y -i <src> -vf "yadif=0:-1:0, scale=-2:<DEDALO_AV_QUALITY_DEFAULT>" -vb 960k -g 75 -f mp4 -vcodec libx264 -acodec $acodec -ar 44100 -ab 128k -ac 2 -movflags faststart <tmp> && mv <tmp> <target>` (`:1522-1523`); `$async` (default true) appends `> /dev/null &` (`:1531`).
- **Probes**: `get_media_attributes` = `ffprobe -v quiet -print_format json -show_format` (`:1585`); `get_media_streams` = `ffprobe -v quiet -show_streams -print_format json`, cached per path (`:1651`); `get_audio_codec` picks `libfdk_aac > libvo_aacenc > aac` from `ffmpeg -loglevel error -buildconf` (`:1722`) — TS asks `ffmpeg -hide_banner -encoders` instead (the registry `-acodec` resolves against, not the configure flags) and caches per binary path (`engine/ffmpeg.ts:audioCodecByBinary`).
- **Settings profiles**: `lib/ffmpeg_settings/*.php` — port ALL 39 to ONE typed TS data table (§5.2) keyed `setting_name`. Sample `404_pal_16x9.php`: `$vb='1024k'; $s='720x404'; $g=25; $vcodec='libx264'; $progresivo='-vf yadif'; $force='mp4'; $ar=44100; $ab='64k'; $ac='1'; $acodec` (overridden by the buildconf pick); `audio.php`: `$force='mp4'`, `$target_path='audio'` (audio branch hard-codes `-ar 44100 -ab 128k -ac 2`). **TS divergence (2026-10-02):** PHP passed `$progresivo` and `$gammma` as two `-vf` options; ffmpeg keeps only the last, so `yadif` never ran. TS profiles carry `videoFilters` (bare specs, deinterlace first, `yadif=deint=interlaced` so progressive frames pass untouched) and both passes emit ONE `-vf a,b` (`engine/ffmpeg.ts:videoFilterArgv`; gates `media_engine.test.ts` + `media_deinterlace_native.test.ts`).

### 4.3 PDF (`core/component_pdf/class.component_pdf.php`)
- **Text/HTML extraction** (`get_text_from_pdf :743`): `source = get_media_filepath(get_default_quality())` (`:757`); resolve engine binary `shell_exec('type -P '.$engine)` (`:773`) → TS boot-probe equivalent; flags `-f <page_in> -l <page_out>`, html mode adds `-i -p -noframes -layout` and `.html` ext (text → `.txt`) (`:806-821`); command `<engine> -enc UTF-8<config> <src> <text_filename>` (`:831`), `exec` synchronous (`:838`); output containing `error` → fail. Read → `valid_utf8` → `utf8_clean` (iconv IGNORE + control-char strip) → JSON round-trip validation (`:863-892`).
- **OCR** (`PDF_OCR_ENGINE = ocrmypdf`): `ocrmypdf --pdfa-image-compression lossless -l <lang> --force-ocr <src> <src>` (in-place, `:1003-1006`).
- **pdfinfo** (Poppler) for page count; PDF→jpg cover via `ImageMagick::convert` with density (`create_alternative_version :1422`). **PDF thumb** (`create_thumb :279`) also goes through `convert`, not `dd_thumb`: it selects the **first page only** (`ar_layers=[0]` → `<pdf>[0]`) at density 72 / quality 75 with `pdf:use-cropbox=true`, resized to the thumb box. **AS BUILT (2026-09-05) NO IMAGEMAGICK RECIPE ASKS FOR A PDF**: `buildThumbVersion()` still branches on `component_pdf`, but the branch renders page 1 with `engine/ghostscript.ts` into a PNG intermediate and hands THAT to the shared thumb recipe (same box, background, blank guard and atomic write as every other thumb) — the `-density/-antialias/pdf:use-cropbox` prefix is gone from `buildConvertArgv` and the policy denies the `gs` delegate. FIDELITY CHANGE, stated rather than hidden: `buildGhostscriptArgv` passes no `-dUseCropBox`, so a PDF whose CropBox is smaller than its MediaBox now renders WITH its trim margins where the retired ImageMagick recipe cropped them away. The PHP note below is the oracle's shape, not this engine's; the `[0]` selector is mandatory — the scene-less `dd_thumb` recipe splits a multi-page PDF into `<stem>-0.jpg`/`-1.jpg`/… and never the bare temp the rename targets (→ `ENOENT`). Regression-gated in `test/unit/media_processing.test.ts` (multi-page fixture).

### 4.4 SVG / 3D
- SVG thumb: rasterized via `ImageMagick::convert` (`component_svg:395`).
  **AS BUILT (2026-08-08) the renderer is librsvg, not ImageMagick** — `src/core/media/engine/svg.ts`
  (`rsvg-convert`, `DEDALO_RSVG_CONVERT_PATH`, dpi `DEDALO_SVG_THUMB_DPI`), whose PNG the shared
  thumb recipe then reduces. The hardened `imagemagick-policy/policy.xml` disables the `MVG` coder
  that ImageMagick's own SVG renderer emits, so the PHP recipe is REFUSED on this engine (measured:
  `magick 'x.svg[0]' … → "not authorized by the security policy 'MVG'"`, and the same command
  succeeds with the policy removed). That was left KNOWN-OPEN in the policy file as "a security
  decision"; rendering the vector in a dedicated program is that decision, and it keeps MVG closed.
  Until it landed, `component_svg` had `hasThumb: false` and the media-versions thumb gear answered
  "Unknown media quality 'thumb' for component_svg (not in ladder [original, web])" on every SVG
  record. Gate: `test/unit/media_svg_thumb.test.ts` (which is also the tripwire against rerouting
  the render back through ImageMagick — it fails with that policy error).
- 3D: `web` = naive copy via base `build_version :3543` (no override); 3D thumb via `ImageMagick::dd_thumb` from an auto-posterframe (`component_3d:440`). Converters ledgered PHP-dead (§Out-of-scope).

### 4.5 Rewrite gotchas (carry over)
- `nice -n 19` on every media command (shared-host courtesy — keep as an argv prefix).
- Two-pass x264 needs a `passlogfile` and cleanup — becomes structural in TS (per-job scratch dir, `finally` cleanup).
- `is_opaque`/`has_meta_channel` are TIFF/PSD-specific and OS-sensitive (`MAGICK_CONFIG = {remove_layer_0, is_opaque}`, `media_image.php:201`) — carry the platform flags into config.
- Load-bearing PHP typos (`$gammma` triple-m in every settings file; `get_ffprove_installed_path`) — use clean internal TS names; they have zero wire/disk surface.

---

## 5. TS module design

Follows the AREA/SECTION/RELATIONS pattern: ONE contract module in `concepts/`, one subsystem home, tool handlers plugged into the existing explicit tool registry (`src/core/tools/registry.ts`, dispatched by `src/core/tools/dispatch.ts`; each action declared in the tool's `register.json`). Spawn pattern proven in `src/core/area_maintenance/backup.ts`.

```
src/core/concepts/media.ts          — THE contract: type/quality catalog accessor (env-config), allowlists, id-grammar types
src/core/media/
  path.ts                           — path builder (id grammar + media-dir grammar + buckets + assertInsideMediaRoot)
  files_info.ts                     — filesystem → files_info scanner/regenerator (byte-compat)
  file_ops.ts                       — soft-delete move, rename_old_files, duplicate copies, deleted/ scan (TM)
  jobs.ts                           — supervised async job manager + process-file store + SSE status frames
  engine/
    spawn.ts                        — shared Bun.spawn discipline (argv arrays, nice, timeout, atomic rename)
    imagemagick.ts                  — identify / convert / dd_thumb / rotate / crop / attributes / dims
    ffmpeg.ts                       — ffprobe / two-pass transcode / posterframe / fragment / conform / audio(_tr)
    ffmpeg_profiles.ts              — the 39 settings profiles as ONE typed data table
    pdf.ts                          — pdfinfo / pdftotext / pdftohtml / ocrmypdf / PDF→jpg cover
    mime.ts                         — magic-byte sniffer + mime↔extension allowlist (data)
    icc/                            — vendored ICC profiles (from PHP media_engine/lib/color_profiles_icc/)
  ingest/
    upload.ts                       — multipart/chunked receiver + staging + join (client wire contract)
    add_file.ts                     — staging → quality dir (SEC-063 confinement, rename_old_files)
    regenerate.ts                   — regenerate_component orchestration
    process_image.ts / process_av.ts / process_pdf.ts / process_svg.ts / process_3d.ts
  tools/                            — tool_upload, tool_media_versions, tool_posterframe, tool_image_rotation,
                                      tool_pdf_extractor, tool_tc, tool_transcription_local (registered in tool_request)
```

Rebase points: `media_list_value.ts` re-based on the contract (its `LIST_QUALITIES` dies); `environment.ts:167-169` quality constants read from the config so the wire echoes the effective install values; `delete_record.ts` / `duplicate_record.ts` delegate to `file_ops.ts`.

### 5.1 Contract (`concepts/media.ts`)
```ts
export type MediaModel = 'component_image'|'component_av'|'component_pdf'|'component_svg'|'component_3d';
export interface MediaTypeSpec {
  readonly model: MediaModel;
  readonly typeFolder: 'image'|'av'|'pdf'|'svg'|'3d';
  readonly qualities: readonly string[];        // *_AR_QUALITY (from config)
  readonly defaultQuality: string;              // *_QUALITY_DEFAULT
  readonly originalQuality: string;             // *_QUALITY_ORIGINAL
  readonly defaultExtension: string;            // *_EXTENSION
  readonly allowedExtensions: readonly string[];// *_EXTENSIONS_SUPPORTED
  readonly alternateExtensions: readonly string[]; // *_ALTERNATIVE_EXTENSIONS
  readonly listQualities: readonly string[];    // replaces media_list_value LIST_QUALITIES (incl. av/3d)
}
export function mediaTypeOf(model: string): MediaTypeSpec | null; // built from config at boot
export function isMediaModel(model: string): boolean;
/** SEC-065 STRENGTHENED: charset [A-Za-z0-9_\-.]+ AND catalog membership. Throws on violation. */
export function assertValidQuality(spec: MediaTypeSpec, quality: string): string;
/** image quality → pixel-area budget: MB × 350000; null = unbounded (original/modified). */
export function pixelAreaBudget(quality: string): number | null;
```
Everything is loaded from the config catalog (§3) — no literals in the module body.

### 5.2 Path builder (`media/path.ts`)
```ts
export interface MediaIdentity { componentTipo: string; sectionTipo: string; sectionId: number; lang: string | null; }
export function buildMediaIdentifier(id: MediaIdentity): string;             // {ct}_{st}_{sid}[_{lang}]
export function additionalPath(sectionId: number, maxItemsFolder: number | null): string;
export interface MediaLocation { relativeDir: string; relativePath: string; absolutePath: string; }
export function buildMediaLocation(spec: MediaTypeSpec, id: MediaIdentity, quality: string, extension: string,
  opts: { initialMediaPath: string; maxItemsFolder: number | null }): MediaLocation;
/** THE traversal chokepoint: realpath-confine an absolute path inside the media root. Throws. */
export function assertInsideMediaRoot(absolutePath: string): string;
```
All identifier segments run through the existing `identifier_gate.ts` tipo validator; `sectionId` a positive integer; extension through the type allowlist. Every filesystem touch in the subsystem passes through `assertInsideMediaRoot` — one chokepoint, not per-call-site checks (stronger than PHP's scattered `realpath` calls).

### 5.3 Spawn discipline (`media/engine/spawn.ts`)
- **Argv arrays only, never a shell.** No `sh -c`, no string interpolation, no `.sh` files. Categorically stronger than PHP's `escapeshellarg` — arguments never traverse a shell parser, so there is nothing to escape. PHP's self-deleting `.sh` launcher (`exec_::exec_sh_file`) is NOT ported.
- **Binaries resolved at boot** from the config allowlist (§3), probed once (`-version`), capabilities cached (aac-encoder pick, ImageMagick v6/v7). Missing binary → the feature refuses loudly at call time; the server still boots.
- `nice -n 19` kept as an argv prefix (coexistence).
- Timeouts + kill on abort; stderr captured into the job record; **outputs written to a temp name inside the destination dir, then atomically renamed** so a coexisting PHP reader never sees a partial derivative. Per-job scratch (x264 passlog, audio_tr WAV) cleaned in `finally`.

### 5.4 files_info scanner (`media/files_info.ts`)
```ts
export interface FileInfoEntry {  // key ORDER = DB-byte contract; emit exactly as get_quality_file_info (:2496)
  quality: string; file_exist: boolean;
  file_name?: string; file_path?: string;  // file_path RELATIVE to media root, leading slash
  file_size?: string; file_time?: DdDateValue; extension?: string; external?: boolean;
}
/** Scan every quality × (default ext + alternates + raw-original twin) for the identity. Pure read. */
export function scanFilesInfo(spec: MediaTypeSpec, id: MediaIdentity, opts): Promise<FileInfoEntry[]>;
/** Save-time hook: re-scan and splice files_info into the stored media item, preserving
 *  original_* / modified_* / lib_data siblings. */
export function refreshStoredFilesInfo(storedItem: Record<string, unknown>, …): Promise<Record<string, unknown>>;
```
Value fidelity (size format, `file_time` dd_date shape) is pinned by a read-only differential gate over the SHARED media dir (§7 Phase B).

### 5.5 Job model (`media/jobs.ts`)
PHP: detached `nohup`/`sh` + PID + on-disk process files + a `processes` DB table, client consuming an SSE status stream. **TS design (user decision): in-process supervised jobs with an on-disk process-file mirror, same client wire.**
- **Job record** = JSON process file under `<private>/processes/<job_id>.json` (`{id, kind, pid, status, progress, data, errors, started_at, updated_at}`) + an in-memory registry. The pfile is the restart-survival + client-resume token (the client stores `{pid, pfile}` locally — `render_common.js:648`). TS pfiles live in the TS private tree, never PHP's.
- **Supervised, not detached**: `Bun.spawn` children stay attached to the manager, which streams ffmpeg progress (`-progress pipe:1` — a modernization; PHP had none), writes the pfile on every tick, enforces a **concurrency cap** (semaphore; default 2 transcode + 1 CPU-heavy image/OCR lane, config-tunable), and implements `stop_process` as a real child kill + status flip.
- **Restart = idempotence, not orphan adoption**: on boot, scan pfiles with `status:'running'`, probe PID liveness, mark dead ones `interrupted`, and re-queue derivative builds — safe because every derivative rebuilds from the untouched original and temp-name+rename means no partial file ever went live.
- **Client contract honored**: the status action serves the SSE stream the vendored `data_manager.request_stream`/`read_stream` expect (`data:\n<json>\n\n` frames of `{pid, pfile, is_running, data, errors, total_time}` — `render_common.js:640-780`, `data_manager.js:993`); `stop_process` and `get_server_ready_status` (= cap headroom) join the action table. Frame shape parity-gated by driving the real client in Chrome.
- **Coexistence**: TS never reads/writes PHP's `processes` table or pfiles; the only shared surface is the media dir, protected by atomic renames and by never touching `original`. Trade-off recorded: we lose survive-the-restart *execution* (PHP's detached process would keep running) but gain progress, caps, cancellation, and guaranteed cleanup.

### 5.5b Job VISIBILITY — what is running, and where an operator sees it (2026-08-12)

Wire contract: `engineering/wire_contract/WC-2026-08-12-media-job-visibility.md`.

§5.5 gives a job supervision, progress and cancellation. It did NOT give it an
ADDRESS: a job was reachable only by an id handed to whoever submitted it, so no
surface could ask "what is running for this record?". That gap is why an
upload's background transcode was invisible — `tool_upload` received `job_id`
and dropped it, and `tool_media_versions`, opened afterwards, had nothing to ask.
An empty tier cell is indistinguishable from a tier that was never built.

**Every job now carries a `JobTarget`** (`{section_tipo, section_id (INT),
component_tipo, lang, quality, also_qualities?, label?}`). `jobTargetKey` is its
identity; `also_qualities` widens what a job BLOCKS without changing what it is
called — the ingest transcode writes the default tier AND the audio tier, and
stamping only one left the other open to a duplicate encode.

Three readers, one index (`MediaJobManager`):
- `jobsForRecord(sectionTipo, sectionId)` — includes TERMINAL jobs, because a
  failed tier must stay readable; reverting it to blank is the "never built" lie.
- `jobsForUser(userId)` — the media half of the activity read model.
- `hasLiveJobForTarget(target)` — the duplicate-build guard.

**THE TWO JOB SYSTEMS.** This engine runs long work in two places, and they are
different by design, not by accident:

| | `mediaJobs` (§5.5) | diffusion queue (`src/diffusion/jobs/`) |
|---|---|---|
| durability | in-process + pfile mirror; **lost on restart** | Postgres; survives restart |
| execution | in-process worker, concurrency lanes | one SPAWNED runner per job, heartbeat |
| recovery | boot sweep → `interrupted` | sweeper RE-QUEUES under an attempt budget |
| duplicate guard | in-memory (`hasLiveJobForTarget`) | partial unique index |
| progress wire | `JobStatusFrame` + `get_job_events` SSE | `ProgressData`, byte-pinned to the old engine |

`mediaJobs` is the GENERAL registry: AV transcodes, every tool background action
(imports, indexation) via `core/tools/background.ts`, backup, the test runner.

**The monitoring surface is a READ-SIDE PROJECTION over both**, not a merge:
`core/api/activity.ts` defines `ActivityRow`, and each row names the stream its
own system already serves (`stream: 'job_events' | 'diffusion'`), so the client
subscribes THERE. Neither wire changed — diffusion's is pinned with golden
fixtures. Core may not import `src/diffusion`, so the diffusion half arrives by
the `registerActivityProvider` INVERSION (the `registerOpsGauge` pattern).

Two doors, deliberately different scopes:
- `dd_utils_api::get_record_jobs` — authorized by RECORD read permission (not job
  ownership), operational shape only, never the job's `data`. A second operator
  must see that a tier is busy or they start a duplicate encode.
- `dd_utils_api::get_activity` — the caller's OWN work across both systems,
  feeding the page-chrome activity tray. LIVE **plus finished within
  `RECENT_TERMINAL_MS` (5 min)**, with `errors[]` on terminal rows: a live-only
  answer would make the client infer outcomes from a row's disappearance, and
  that inference painted failed publications green. Absence is never an outcome.

**KNOWN LIMITS, stated rather than discovered.** Media jobs are still NOT
durable: a restart mid-transcode loses the work, and this change makes that loss
VISIBLE (`interrupted`) rather than fixing it. The duplicate guard is in-memory,
so under a SECOND server instance sharing `../private/processes` it is not
authoritative — and because the panel now HIDES the build control for a live
tier, that non-authoritative answer is being presented as a guarantee. Both
point at the same end state.

**THE END STATE (adversarial review, 2026-08-12).** This section describes a
read-side projection over two job systems, not one system. The structurally
correct move — and the one this spec should be read as pointing at — is to make
`mediaJobs` a FACADE over the durable diffusion queue: restart-surviving
transcodes, an authoritative duplicate guard (a partial unique index instead of
a Map), and one owner listing, all of which that queue already implements one
directory away. Until then, treat `ActivityRow` as scaffolding: it is a third
vocabulary over two wires plus the legacy `get_process_status` poll, and every
surface built on it is one more thing the promotion must preserve.

### 5.5c Job LANES and DEADLINES (PERF-11)

§5.5's concurrency cap was ONE semaphore for everything. `av_transcode`,
`update_code`/`restore_code`, `update_data`, the dev long-process probe and every
backgroundable tool action drew from the same slots, so an ingest queue starved
the code update an operator was waiting on.

**The class is declared, never inferred.** `submit`'s `meta.lane` is REQUIRED and
typed (`JobLane` = `media | transcription | rag | maintenance`); a tool declares
one per `backgroundRunnable` action in `backgroundLanes`, and `scheduleBackground`
refuses an undeclared one (`tool.background_lane_undeclared`). A `kind`-prefix rule
was rejected on purpose: it files a new job into whatever lane its name happens to
resemble, and the starvation returns with nobody having edited a budget. There is
no `publication` lane — publication work runs on the durable diffusion queue, and a
lane no call site can reach would publish a permanently-zero counters row.

**Budgets** are per lane, one operator key each (`DEDALO_MEDIA_JOB_CONCURRENCY` is
unchanged and IS the media budget; `DEDALO_JOB_LANE_*_CONCURRENCY` for the rest).
`acquire`/`release` are per lane, so a full lane can only queue its own class.

**Deadlines** are per lane (`DEDALO_JOB_DEADLINE_*_S`, seconds; `0` = none, which is
`media`'s default because a master transcode is legitimately hours long), with a
per-submit override. The clock starts at RUN START, after the slot is acquired: a
job starved behind a full lane must not be killed for having waited. On expiry the
job's existing `AbortController` is fired and the record goes terminal `stopped` —
but the LANE SLOT IS NOT RELEASED until the worker actually settles, because
releasing it while ffmpeg still holds the CPU over-subscribes the box. A worker
still unsettled after the grace bumps `job_deadline_lane_held`, so a wedged lane is
observable rather than silent.

**The abort now REACHES an awaited outbound call.** The job's signal is the ambient
`media/job_scope.ts` AsyncLocalStorage value for the whole dynamic extent of the
worker, and `security/ssrf_guard.ts::fetchBoundedText` composes it with its own
timeout (`AbortSignal.any`). Before this, an abort stopped at the worker's first
await and the socket stayed open. **Out of scope, named rather than absent:**
`Bun.spawn` children (ffmpeg, pg_dump, the transcriber) do not subscribe to the
signal; their cancellation is their own subprocess handle, a separate change with
its own gate — and the held-lane counter is precisely what measures the gap.

**Published depth.** `/api/v1/counters` carries `media_jobs.lanes[class] =
{active, queued, max}` beside the legacy `has_headroom` boolean — the in-process
twin of the diffusion queue depth. A boolean cannot say WHICH class is backed up,
which is the only question worth asking of a saturated box.

Gates: `test/unit/job_lane_budget_native.test.ts` (budgets hold under load, a job
past its deadline is cancelled, the signal reaches an awaited outbound call),
`test/unit/job_lane_census_tripwire.test.ts` (every submit site and every
backgroundRunnable action declares a lane).

### 5.6 File ops (`media/file_ops.ts`)
```ts
export function moveToDeleted(absolutePath: string, opts?: { bulkProcessId?: string; now?: Date; mediaRoot?: string }): string | null;
export function renameOldFiles(absolutePath: string, now?: Date, mediaRoot?: string): string | null;
export async function duplicateMediaFiles(spec, source: MediaIdentity, target: MediaIdentity, opts): Promise<string[]>; // (:1999) — the byte copy is async: whole media files on the request path
export function listDeletedVersions(spec, id: MediaIdentity, quality: string, extension: string, opts): string[]; // TM natsort scan
// THE RECORD-LEVEL PAIR — one file, written against each other (§8):
export function removeSectionMediaFiles(sectionTipo, sectionId, mediaColumn, opts?): Promise<SectionMediaFilesOutcome>;
export function restoreDeletedSectionMediaFiles(sectionTipo, sectionId, mediaColumn, opts?): Promise<SectionMediaFilesOutcome>;
```
The four file-level ops are SYNCHRONOUS (no `Promise`); the two record-level ones
are async because they resolve the ontology per component.

**Two datestamp formats exist in PHP and BOTH are preserved per call-site**: `move_deleted_file :1929` uses `Y-m-d_Hi` — and that is the one EVERY soft-delete goes through, the section delete included (PHP `remove_section_media_files` → `remove_component_media_files` → `move_deleted_file`). `rename_old_files :1226`, the pre-overwrite backup on UPLOAD, uses `Y-m-d_Gis` (hour without leading zero). Do NOT unify — TM scanners and humans read both. (Correction, 2026-08-09: this paragraph previously attributed `Y-m-d_Gis` to the section-delete path, citing a private copy of `removeSectionMediaFiles` that lived in `delete_record.ts`, walked `files_info`, resolved the media root from a bare `MEDIA_PATH` env read — normally UNSET — and therefore moved nothing on an ordinary install. That copy is deleted; the delete door calls `file_ops.ts`.) `duplicateMediaFiles` closes the `duplicate_record.ts:20` ledger (copy the files, then `refreshStoredFilesInfo` + save on the duplicate so files_info carries the target's paths, not the source's). The AV POSTERFRAME is part of both record-level directions (PHP `component_av` overrides both methods for it); a tier-level posterframe delete stays a true `unlink`.

---

## 6. Upload flow end-to-end

Two API calls (PHP). Verified vendored-client wire contract: `client/dedalo/core/services/service_upload/js/service_upload.js` POSTs `multipart/form-data` with headers `Content-Range: bytes s-e/total`, `X-File-Name` (URI-encoded), `X-Dedalo-Csrf-Token`, and fields `key_dir, file_name, chunked, start, end, chunk_index, total_chunks, file_to_upload, csrf_token`.

### 6.1 Raw receiver — `dd_utils_api::upload` (`core/api/v1/common/class.dd_utils_api.php:925`)
Action allowlist includes `upload`, `join_chunked_files_uploaded`, `list_uploaded_files`, `delete_uploaded_file`, `get_process_status[_poll]`, `stop_process`, `get_server_ready_status`, `get_system_info` (`:40-64`). Steps:
1. `$_FILES` corruption / `UPLOAD_ERR_*` validation (`:968-1056`).
2. Extension from filename; **MIME sniff via `finfo(FILEINFO_MIME_TYPE)`** on the temp file (`:1079`) — client MIME NOT trusted.
3. `sanitize_key_dir` the filename (`:1096`); MIME must be in `get_known_mime_types` (`:1099`, authority `:3035`); extension whitelisted AND cross-validated to belong to the matched MIME entry (`:1124-1154`).
4. Staging dir `DEDALO_UPLOAD_TMP_DIR/<user_id>/<key_dir>` (`:1189`; `DEDALO_UPLOAD_TMP_DIR = media_path/upload/service_upload/tmp`, `paths.php:360`), created 0750.
5. Path-traversal guard `safe_upload_target($tmp_dir, $name, false)` (basename + realpath confinement, `shared/core_functions.php:2886`) before `move_uploaded_file`/`moveTo` (`:1203-1222`).
6. Non-chunked images/av get an immediate staging thumbnail (`create_thumbnail :3299`).
7. **Chunked**: each chunk stored as `<chunk_index>-<tmp_name>.blob`, MIME forced `application/octet-stream` (`:1084-1091`); `join_chunked_files_uploaded :1379` confines each chunk path, appends `file_put_contents(FILE_APPEND|LOCK_EX)`, unlinks the chunk, and **re-sniffs the assembled file (SEC-066)**, deleting on invalid MIME/extension (`:1481-1498`).
Returns `file_data` incl. `tmp_dir:'DEDALO_UPLOAD_TMP_DIR'` (a constant NAME, resolved server-side), `key_dir`, `tmp_name`, `extension`, `chunked`, and (chunked) `total_chunks`/`chunk_index`.

### 6.2 Dispatcher — `tool_upload::process_uploaded_file` (`tools/tool_upload/class.tool_upload.php:109`)
Sole API action (`:50`). `session_write_close()` first (`:117`). Validate required params; `security::assert_record_in_user_scope($section_tipo,(int)$section_id)` when saved (`:166`); instantiate component (`edit`, `DEDALO_DATA_NOLAN`); `assert_component_permission($component, 2)` WRITE gate (`:233`); `set_quality($quality)` (`:240`); then:
- `add_file($file_data)` (`component_media_common:901`, **SEC-063**): ignores caller `source_file`, restricts `tmp_dir` to the allowlist `['DEDALO_UPLOAD_TMP_DIR']`, sanitizes `key_dir`/`tmp_name`, rebuilds source `= <tmp_dir>/<user_id>/<key_dir>/<tmp_name>`, realpath-confines staging (`:927-1016`), validates extension (`valid_file_extension :1034`), `rename_old_files` backup (`:1066`), `rename` into `<quality dir>/<id>.<ext>` (Original law: raw + normalized pair). Returns `ready = {original_file_name, full_file_name, full_file_path}`.
- `process_uploaded_file($ready)` (`:258`) — the per-type hook: image `component_image:742` (writes `original_*`/`modified_*`, optional `target_filename`, `regenerate_component`); av `component_av:1113` (build audio quality, `target_filename`+`target_duration`, `regenerate`); pdf `component_pdf:322` (non-PDF doc/odt stored but not text-processed `:404`; PDFs `regenerate_component({transcription, ocr, ocr_lang, first_page})`); svg `component_svg:507`; 3d `component_3d:620`.
- **`regenerate_component` (`:3153`)** — the derivative orchestrator: `delete_normalized_files` (keep raw) → build `default_quality` if missing (`build_version :3168`) → build alternate-ext versions → `create_thumb` → `update_component_data_files_info` → save. Image override also (re)creates the SVG overlay (`component_image:1971`).

### 6.3 TS design
- Route: the existing API path (`server.ts:163`) adds a **content-type branch** — `multipart/form-data` → `ingest/upload.ts`. Session required; CSRF enforced from header-or-field, constant-time (upload is NOT CSRF-exempt — client SEC-008). `Bun`'s native `request.formData()` parses it (no library); chunks are client-capped (~MB), so buffering a chunk in memory is fine (streaming multipart ledgered as an optimization).
- **MIME sniffing without libraries**: primary = a native TS **magic-byte table** in `engine/mime.ts` over the closed allowlist universe (jpg/png/tif/bmp/psd/webp/heic/avif · mp4/mov/avi/mpg/vob/wav/aiff/mp3/flv/zip · pdf/rtf · svg-as-XML-text · glb), each with a well-known signature; fallback = spawn `file --brief --mime-type` for genuinely ambiguous containers (MPEG-PS/VOB), behind the same spawn discipline. Fail-closed: unknown signature → reject even if the extension is allowlisted. Meets finfo parity and beats it (our DB is exactly the allowlist). The mime↔extension map is DATA (port of `get_known_mime_types`), config-adjacent.
- **The signature-less content classes** (`txt`/`csv`/`glsl`/`css`/`json`/`xml`/`geojson`/`kml`, plus ASCII 3D `obj`/`dae`/`fbx`) have no magic bytes in PHP either: finfo classifies them by CONTENT (`text/plain`, `text/csv`, `application/json`, `application/xml`) and the upload cross-checks the declared extension against that entry. The sniffer therefore has a **text branch** — charset-agnostic (a latin-1 CSV out of Excel is text), empty file ≠ text (finfo `application/x-empty` → rejected), and **HTML is refused under every extension** (MEDIA-01 stored-XSS). This branch is what the import tools ride: `tool_import_dedalo_csv` uploads its CSV through the same endpoint as media, and its chunk join re-sniffs the assembled file (SEC-066).
- Flow mirrors §6.1–6.2 with the SAME shared staging layout (coexistence), chunk-level AND assembled re-sniff (SEC-066), `add_file` SEC-063 confinement, per-type processor → `regenerate.ts`. Image/pdf/svg run synchronously inline; av transcode goes through `jobs.ts` (§5.5).
- Missing derivative → the Dédalo placeholder image (PHP `get_url(default_add=true) :2942`) — preserve the fallback so the client never 404s a thumbnail.

### 6.4 Addendum — the ingest as BUILT (2026-07-31, `engineering/wire_contract/` WC-080)

The §6.3 design landed; this records where it ended up, because three parts are
not obvious from the plan.

**The target tier is honoured, and the impossible ones are refused.**
`processUploadedFile` takes `quality` (the client's `custom_target_quality` /
`quality`) and parks the file there, as PHP's `set_quality()` before `add_file`
did — `addFile` builds the location for that tier instead of hardcoding
`originalQuality`. Three targets throw instead, all guarded in
`src/core/concepts/media.ts` beside `assertValidQuality` so their carve-out lists
cannot drift from its:
- the THUMB tier and `audio_tr` (`assertIngestableQuality`) — DERIVED tiers the
  scanner cannot index, so the file would be invisible to the record forever;
- a non-normalized extension in a derivative tier
  (`assertNormalizedExtensionForTier`) — the tier's canonical
  `<id>.<defaultExtension>` shadows it in `files_info` and the thumb rebuilds
  from that stale file. The ORIGINAL tier is exempt (the Original law).

Which regenerate runs follows the tier: the ORIGINAL tier gets the ingest
builders (unconditional re-encode — a fresh original SHOULD rebuild everything);
any other tier gets `regenerateMissingDerivatives` (`media/repair.ts`, the v6
`regenerate_component` port), so the just-placed file is never overwritten.
`component_av` has no branch there, so a non-original av upload submits a
transcode only when an ORIGINAL is on this box AND the default tier is absent.

**`files_info` has ONE writer: `media/tools/files_info_persist.ts`
`transformStoredMediaItems`** (CLOSURE_PLAN Step 2, TOOLS-5 + CORE-5,
`WC-2026-09-30-media-key-locked-transform`). Every write-back — the tool
mutations, the AV job completion, the `sync_files` repair, the upload persist,
`tool_update_cache`'s media branch, the `files_info` reconcile sweep and the
duplicate's refresh of its clone — goes through it: it reads the whole
`media -> <tipo>` key under a `FOR UPDATE` row lock (`readMatrixKeyForUpdate`,
`db/matrix_write.ts`) and writes what a SYNCHRONOUS transform returns FROM THOSE
ITEMS, in one short transaction it owns (refused inside a caller's — its lock
would be held to the caller's COMMIT). File work (derivative rebuilds) happens
OUTSIDE the lock, before. Callers must NOT hand in a snapshot: theirs is stale by
the time the write lands, and the write replaces the key whole, so a stale
snapshot silently reverts whatever another session committed on it. Outcomes per
record — `written`, `noop`, `held` (a shrink the transform refuses), `missing`
(the record is gone), `locked` (SQLSTATE 55P03) — never an escape that aborts a
run. Every caller declares its lock wait: `lockWait: 'per-record'` (update_cache,
the sweep — many records on the request pool) sets `SET LOCAL lock_timeout` to
the maintenance bound, or half the statement ceiling when that is shorter
(`perRecordLockWaitMs`), so the wait ends as the handled 55P03, never as a
statement timeout; `'request'` (uploads, write-backs, the duplicate) waits under
the caller's own bounds. The sweep judges PER ITEM — GROW / DIFF / SHRINK on the
item's own existing-file count, a SHRINK item kept as stored unless
`allowShrink`, re-judged under the lock — plus the **`FOREIGN`** kind: an item
whose entries carry the CLONE SIGNATURE (`<component>_<section>_<N>` with N ≠
this record's id, what a failed duplicate could leave) is always rewritten; any
other name the scan does not build is a held SHRINK. An image's `properties.image_id`
stem IS built (`fileIdOverride`, resolved per record — T1-10,
`WC-2026-11-12-image-id-media-file-stem`), so a PHP-era stem-named record GROWS;
only a stem the record no longer resolves (the value changed or emptied after
upload) is a held SHRINK. The
duplicate inserts its clone with `files_info: []`, copies through the
record-scoped walk and re-scans at the clone's identity; an incomplete copy is a
verdict (`duplicate_media_incomplete`, `media.operation_failed`,
`duplicateSectionRecordWithVerdict`), never a swallowed catch.
Two entry points for the rescan transform, deliberately named apart:
- `reconcileStoredFilesInfo` — refreshes existing items, NEVER mints. The
  passive-scan rule: a background or incidental scan must not resurrect media
  someone removed.
- `repairStoredFilesInfo` — mints `{files_info}` (no provenance keys) when the
  component has no item and the scan found files. PHP
  `update_component_data_files_info :3748` did this unconditionally on save; here
  it is reachable ONLY from the operator's explicit `sync_files`.

The result carries `action` (`refreshed` / `created` / `noop` / `missing`) and
the affected row count. `missing` — no matrix table, or the record was deleted
mid-flight — is distinct from `noop` on purpose: a guard on the row count alone
can never see it, and "nothing needed doing" must not report the same as "the
record is gone" (`assertRecordPresent` throws; `persistUploadedMedia` throws
outright, because the file is already on disk).

**One AV encoder, two callers** (`src/core/media/av_versions.ts`). `encodeAvQuality`
is the single place an av tier is produced: the two-pass x264 profile for
`<quality>_<standard>[_<aspect>]`, or an audio extraction, written atomically
(temp + rename) with the two-pass stats scratch removed. `submitAvTranscode` is
the INGEST caller (default quality + audio, §6.2); `submitAvVersionBuild` is the
TOOL caller and builds the ONE tier the operator asked for — PHP
`component_av::build_version` parity, source = the original, falling back to the
default-quality file, and never a tier from itself. Refusals knowable up front
(no source, no encode profile for the tier, no audio stream for an audio tier,
the original as target) are raised BEFORE a job id exists, because the panel
shows *Processing* the moment it receives one. The av THUMB is not a transcode:
it is the posterframe resized (PHP `create_thumb`), so it routes to
`buildThumbFromPosterframe`, not to ffmpeg.

### 6.6 The thumb/posterframe handler — one rule for five models (2026-08-08, `engineering/wire_contract/WC-2026-08-08-media-thumb-handler.md`)

**THE RULE: the thumb depicts its SOURCE; when that source changes or disappears,
the thumb is rebuilt or retired in the same seam.** The source is declared per
model in `concepts/media.ts` and nowhere else:

| model | `THUMB_SOURCE_BY_MODEL` | `POSTERFRAME_WRITER_BY_MODEL` | recipe |
|---|---|---|---|
| image | `default_tier` | — | resize |
| pdf | `default_tier` | — | page-1 rasterize (density/quality literals from PHP) |
| svg | `default_tier` | — | librsvg render → resize (`engine/svg.ts`) |
| av | `posterframe` | `server_frame_extract` | resize of the frame |
| 3d | `posterframe` | `client_capture` | resize of the canvas snapshot |

`media/thumb.ts` is THE entry point (`rebuildThumb` / `resolveThumbSource` /
`retireThumb` / `thumbIsMissing`); the media-versions gear, the repair sweep, the
ingest seam and the posterframe writers all go through it. Before it, five
triggers resolved a thumb source five different ways, and the gaps between those
rules were where the defects lived — a fresh av record with no picture at all
until an operator opened tool_posterframe, an av/3d thumb the repair sweep could
not rebuild, a thumb outliving the posterframe and the master it depicted.

**Only two things stay model-specific, and both are irreducible:** the RECIPE
(one dispatch in `processing.ts buildThumbVersion`) and WHO MAY WRITE A
POSTERFRAME. ffmpeg can pull an av frame here and now, so `rebuildThumb` MINTS one
when it is missing — PHP did the same inside `create_thumb`
(class.component_av.php:581, fixed t=10; the TS mint clamps to `min(10s,
duration/2)` so a short clip is not sampled past its end). A mesh must be
RENDERED and this engine has no renderer, so the 3d refusal names the browser gear
instead (`CLIENT_POSTERFRAME_REMEDY`).

**Invalidation, stated once and enforced at each seam:** a new master retires the
stale posterframe+thumb (av then re-mints; 3d shows its placeholder until the
browser recaptures); deleting a posterframe retires its thumb in the same call
(av re-mints); the repair sweep rebuilds any model's MISSING thumb; a posterframe
write is persisted to `files_info` by the API layer, because 3d — unlike av — is
not re-scanned per read. The posterframe now leaves its tier by MOVING to
`deleted/` like every other media file (it was the one hard unlink in the
subsystem) and is written atomically.

**One grammar:** `path.ts buildMediaSegmentLocation` / `posterframeLocation` is
the only producer of the posterframe path and URL. It replaced three copies — one
of which ignored `additionalPathOverride` — and the av/3d thumb, which used to be
written through an ungated helper and read back through the gated one.
`section/indexation_grid.ts` keeps its own, deliberately different export grammar
(no `initial_media_path`, custom id) as a NAMED exemption in the gate.

Gates: `media_thumb_census_tripwire.test.ts` (declarations, grammar, one-writer/one-handler)
and `media_thumb_consistency.test.ts` (the behaviour, with real binaries).

**THE POSTERFRAME MODELS' THUMB (2026-08-08) — av AND 3d, one route.**
`POSTERFRAME_MODELS` (`concepts/media.ts`) is the census of models whose thumb is
a PICTURE OF THEIR POSTERFRAME rather than a derivative of their own file, which
is what `DEDALO_QUALITY_THUMB` documents in prose ("AV | Will render the
posterframe", "3d | Will render the posterframe"). `buildVersionCore` routes the
thumb tier of both through `buildThumbFromPosterframe`; neither model's own file
may ever reach a thumb recipe (av through ffmpeg would write a VIDEO into the
thumb tier, and `identify` on a mesh answers `no decode delegate for this image
format` — measured, that was the media-versions panel's thumb gear on every 3d
record). With no posterframe the build REFUSES, naming the gear that writes one.

The two models differ only in WHO writes the posterframe. ffmpeg extracts the av
one (`createAvPosterframe`). A 3d posterframe is a snapshot of a RENDERED scene
and **this engine has no mesh renderer**, so the browser's WebGL canvas is the
only thing in the stack that can produce it: `component_3d.create_posterframe`
captures `viewer.get_image()`, uploads it through service_upload, and
`dd_component_3d_api::move_file_to_dir` binds it and derives the thumb
(`moveUploadedToMediaDir`). That is why the media-versions panel's 3d thumb cell
CAPTURES instead of asking the server to build (`create_3d_posterframe` in
`render_tool_media_versions.js`), falling back to a server build — from a
posterframe already on disk — when no viewer is available. Gates:
`tool_posterframe.test.ts` (build + the refusal) and
`media_versions_client_contract.test.ts` (the panel routes 3d to the capture).

**The AV transcode records its own result, and the CALLER starts it.**
`submitAvTranscode`'s worker re-scans and reconciles after the encode, so the
derivatives reach the stored index instead of waiting for the next save (only
`component_av` re-scans per read — everything reading the STORED index saw a
record owning nothing but its source). `processUploadedFile` therefore returns
`startTranscode` UNSTARTED: the job and the ingest caller write the same jsonb
key, and whichever lands second wins it whole, so the caller starts the job after
its own persist commits. Jobs also run detached from the submitter's transaction
ALS (`runDetachedFromTransaction`, `engineering/REQUEST_ISOLATION.md`) — a job
outlives the request whose handle expires at COMMIT.

### 6.5 Alternate-extension versions — the twins (2026-08-07, `engineering/wire_contract/WC-2026-08-07-media-alternate-version-builder.md`)

`DEDALO_*_ALTERNATIVE_EXTENSIONS` (§3) was read by seven modules and written by
none: PHP `component_image::create_alternative_version` (`:1422` for pdf covers)
was not ported at the cutover, so the engine scanned for, indexed and advertised
files it could not produce. This section defines what the key means now.

**A twin is a per-tier COMPANION of that tier's normalized file** — same picture,
same tier, other container. It is NOT "every quality with every format". The
invariant, stated in the direction the engine can hold at ALL times, for every
DERIVED quality Q:

```
exists(Q/<id>.<E>)  ⇒  exists(Q/<id>.<defaultExtension>)
```

- **No twin without its companion, ever.** Tier file present → the twin is
  (re)built by the reconciler; absent → any twin there is RETIRED to `deleted/`
  (No-hard-delete law), both inside `buildAlternateVersions` AND in the paths that
  REMOVE a companion (`retireOrphanTwins`, called from `deleteAndResyncCore`). The
  second call site is the one that matters in practice: a delete changes no
  master, so the reconciler never runs, and MEASURED, one
  `delete_version('1.5MB','jpg')` left the twin on disk where `files_info` then
  reported it as the tier's FIRST entry — `relation_list.ts` and
  `media_list_value.ts` pick a tier by quality alone, so the record served an AVIF
  url for the web version that had just been deleted.
- The converse is a RECONCILIATION, not a disk state. A twin may legitimately be
  absent — empty key, unencodable format on this host, an operator's per-file
  delete (which is honoured, not undone), or a tier carrying a transform the
  master does not — and every one of those is reported rather than silently fixed.
- **Masters are never a build target.** `resolveMaster` walks
  `allowedExtensions`, so a machine-authored file parked in a master tier becomes
  resolvable AS the master. (v6 built twins in `original`/`modified` and chained
  `original/<id>.avif → 1.5MB/<id>.avif`; not ported, deliberately.)
- **The thumb never.** `files_info.ts` scans the thumb tier with the thumb
  extension alone, so a twin there would be permanently unindexable.
- **Absent higher tiers are not minted** — twins inherit `regenerateImage`'s
  standing rule that a tier is created on demand, never speculatively. v6
  invalidated twins only for `[original, modified, default]`, so a `6MB` twin
  went stale in v6 too: the reported symptom is v6's own bug and porting the
  oracle would not have fixed it.

**THE SOURCE IS THE MASTER, NEVER THE TIER'S SIBLING JPG.** Transcoding the jpg
is cheaper and wrong: that file has already been composited onto white by
`backgroundForTarget`, so the alpha the twin exists to carry is gone before the
transcode starts. Measured on the layered medal master through the exact 1.5MB
recipe — from the master `srgba`, `opaque=False`, PSNR 44.56; from the tier's jpg
`opaque=True`, PSNR 3.31, the cut-out destroyed, and every existence check still
green. **This is what makes `tool_image_rotation`'s automatic background removal
visible in Dédalo for the first time** (its alpha PNG lands in the retouched
master; before this, every derived tier was jpg and flattened it) — together with
the client half, since `build(true)` is a no-op on a built instance and the
removal flow discarded the upload response that carries the fresh `files_info`.

**A twin is only built beside a file the ENGINE produced from that master.** The
two rules above collide on a tier an operator has rotated or cropped: its file is
no longer a plain resize of the master, so a twin built from the master is a
companion of a different picture. MEASURED on the shipped builder — rotate 1.5MB
90° (both extensions rotate together, correctly), lose the twin, recover it with
`build_version(target_extension)` or let the repair sweep rebuild it, and the tier
holds an 852×620 jpg beside a 618×850 avif, reported present and current, no
error. `companionDisagreesWithMaster` refuses the build and names both geometries;
transcoding the tier's own file instead was REJECTED because it silently produces
a flattened twin wherever the heuristic is wrong, which is the damage the twin
exists to avoid. Residual, stated: dimensions cannot see a 180° rotation nor a 90°
one of an almost-square image. The durable fix is storing the rotation/crop as
record state and re-applying it after a rebuild (already ledgered in
`tools/rotation.ts`), at which point no heuristic is needed.

**One managed-extension list, not three.** `spec.managedExtensions` (default
extension first, then the upload allowlist, the twins, the covers and the
configured-but-REFUSED formats) is what every enumeration of a record's files
reads — `files_info`'s scan and `duplicateMediaFiles`. `alternateExtensions` says
what the engine BUILDS; `managedExtensions` says what it must SEE, COPY and
SOFT-DELETE, and conflating them loses files: measured, `duplicateMediaFiles`
dropped a pdf's jpg cover whenever the key did not list jpg, and the D5 capability
filter additionally made a legacy `404/<id>.ogg` invisible to the scanner, the
duplicator and `delete_quality` at once.

**Per-model capability, declared once.** `ALTERNATE_BUILDER_BY_MODEL` /
`NO_ALTERNATE_BUILDER_REASON` (`concepts/media.ts`) are exact complements over
the five models. `component_image` (`buildAlternateVersions`) and `component_pdf`
(`buildPdfCovers`) have writers; `component_av` has none (every profile in
`engine/ffmpeg_profiles.ts` forces `mp4`/`libx264` and `getFfmpegProfile`'s names
carry only resolution/standard/aspect — no container axis), nor `component_svg`
(derivatives are byte copies) nor `component_3d` (converters ledgered PHP-dead,
§Out-of-scope). `mediaTypeOf` FILTERS `alternateExtensions` at construction and
keeps the rest in `refusedAlternateExtensions` with its config key, so every
existing consumer — the scanner, the versions panel, `features.alternative_extensions`
— becomes correct with zero edits, and the refusal is named once in the boot log
rather than silently dropped. Refusing at config-read, at boot, or at ingest were
all rejected: they brick scripts and tests, turn "no ImageMagick" into "no
engine", or refuse inconsistently.

**PDF covers are the same mechanism with one exception.** `spec.coverExtensions`
= `['jpg', ...alternates]`, and the jpg cover is built AND scanned whether or not
the key lists it, so emptying `DEDALO_PDF_ALTERNATIVE_EXTENSIONS` cannot
un-index covers already on disk. Every cover composites onto `'#ffffff'`, never
`backgroundForTarget`: a page has no paper. Measured through the exact recipe on
both pdf masters in this install, as avif covers: onto `none` a glyph-sparse page
comes out `alpha_mean 0.0496` (`media/pdf/original/0/test85_test3_1.pdf`) — a
95%-transparent sheet of floating glyphs — while a page that paints its own
background comes out 0.9998 (`.../rsc37_rsc176_4.pdf`) and hides the hazard
entirely. Onto `'#ffffff'` both measure 0.9998. The number is page-dependent, the
rule is not, and the self-opaque page is exactly why it must never be decided per
file. Today's jpg cover is safe only because jpg is in `OPAQUE_TARGET_EXTENSIONS`;
the naive generalisation would have shipped blank covers. The CANONICAL jpg cover
is additionally never gated on the writability probe: it is the type's own output
rather than a configured alternate, and the probe is memoized per process.

**Synchronous, with the cost stated.** Per-encode wall time (median of 3, exact
recipe): avif +0.16 s (0.57 Mpx master, 1.5MB tier) to +0.37 s (3.8 Mpx master,
6MB tier), and at higher tiers the avif is SMALLER than the jpg it accompanies
(180 KB vs 256 KB at 6MB). A job queue was rejected: it manufactures the very lie
being fixed (a master path captured at submit time rebuilds higher tiers from a
superseded master), and `processUploadedFile` scans and returns `files_info`
immediately after the derivative pass. On-demand is impossible — no serving path
names a twin (`resolve/media_list_value.ts:48-50` actively DE-prefers avif/webp).
**PNG is the honest limit, documented not hidden:** 1.25–4.33 s and 7.6–10 MB per
tier on a 3.8 Mpx master. No runtime cap — a cap is a silent narrowing. The cost
that reaches the operator is the WHOLE pass, measured end to end through
`regenerateImage` on this install's largest master (19.9 MB, 3.8 Mpx, median of
3): **273 ms** with the key empty, **594 ms** with `["avif"]` (+118%), **1868 ms**
with `["avif","png"]` (+584%). A bulk `tool_import_files` run multiplies that by
the file count, inside the request.

**Encoder discipline that came with it** (`engine/imagemagick.ts`): every output
token carries an explicit coder prefix on an ABSOLUTE path (`AVIF:/abs/x.avif`),
because `magick src.png out.jxl` exits 0 with empty stderr and writes 316 bytes
of PNG into a file named `.jxl` — it passes `nonEmptyFile`, passes the scene-count
post-condition, enters `files_info` and is served with the wrong MIME; the same
unrecognised coder with an absolute path exits 1 and writes nothing. Capability
is probed with a REAL 1×1 encode, never `magick -list format` (it reports
`PS PS rw+` while the hardened policy refuses `PS:`, and marks `PNG* PNG rw-`, so
an `rw+` test would refuse the engine's own default extension). `-quality` is 90 for every target — PHP's image recipe value for derivatives and
thumbs (`class.ImageMagick.php:281`/`:208`), with master normalized copies at 100.
90 is ALSO the better setting for PNG, whose `-quality` is not quality but
`zlib_level*10 + filter_type`: 82 cost +34.9% bytes on the medal at the 1.5MB tier
and +24.0% on this install's largest master at full size. The engine wrote 82
until 2026-10-23, which cost ~40-75% of the delivered detail on the jpg tiers
(measured on rsc29/rsc170/1: 55 988 B at 82 vs 97 453 B at 90 for the same
picture).

**Error channel and repair.** `regenerateImage` returns
`{created, replaced, retired, errors}` and `regenerateMissingDerivatives` returns
its non-fatal failures; both reach `IngestResult.derivativeErrors`, so a host
that cannot write a configured format can no longer report every upload a clean
success. Repair (`media/repair.ts` step 6, and `tool_update_cache` through it)
builds MISSING twins only, per-extension wrapped, AFTER the thumb + envelope
block — a missing delegate must never abort what the sweep exists to fix.
Retirement survives as the FAILURE branch: a box with no AVIF delegate is left
honestly twin-less rather than quietly stale.

**Known-open, stated rather than narrowed:** a v6-era STALE twin is corrected by
the next master change, not by a sweep (repair is missing-only by contract, and
the engine cannot tell a stale twin from an operator-authored one without
per-tier provenance); twins v6 left in MASTER tiers are neither rebuilt nor
removed, for the same reason; and the companion-geometry refusal reads DIMENSIONS
(see above), so a 180° rotation and an EXIF orientation outside `getDimensions`'
two swaps are its two residuals — the first a silent miss, the second a loud,
non-destructive false refusal.

---

## 7. Phased strangler-fig plan

Write-phases run against a **scratch media root** (the `MEDIA_PATH` override the delete-move already supports) until Phase F cutover; read-gates run against the real shared dir safely. Standing rule (relations/section/area precedent): the existing differential suite stays green throughout with **zero fixture/normalization changes**.

- **A. Contracts + config + adapters + probes (read-only).** `concepts/media.ts`, `path.ts`, `engine/*`, mime sniffer; the media config-key catalog in `.env`/config (PHP `DEDALO_*` names + defaults, §3); re-base `media_list_value.ts` + `environment.ts` on the contract. *Gates:* the TS effective media catalog **equals the PHP install's constants** (config-parity gate); golden path/identifier tests vs PHP-computed paths for the live corpus (all 5 types, bucketed + translatable); probe parity (identify/ffprobe/pdfinfo TS output vs the PHP getters on real shared-dir files); ffmpeg-profile argv **token-parity** vs a PHP CLI oracle dump; existing media differentials green, zero fixture changes.
- **B. files_info scanner + file ops.** *Gates:* `scanFilesInfo` **byte-equal to the live stored `files_info`** for a pinned record corpus (read-only over the shared dir); twin soft-delete/rename/duplicate gates on scratch roots (PHP CLI vs TS over identical trees → identical resulting trees); `duplicate_record` media-copy ledger closed.
- **C. Processing engines (scratch).** Image convert/thumb/rotate/crop, pdf web/cover/text, svg/3d web copy, av transcode+posterframe+conform. *Gates — realistic, NOT byte-equality* (encoder builds differ across versions): dimensions/format/colorspace/orientation/ICC-presence via identify-parity; ffprobe stream-shape parity (codec_name, w×h, fps, audio params, duration ±0.1 s, moov-before-mdat faststart); pdftotext text equality; the §A argv token gates as the recipe pin. Record the byte-inequality rationale in the spec.
- **D. Upload endpoint + ingest + jobs (scratch).** Full upload→staging→add_file→process→regenerate. *Gates:* the SAME source file through PHP and TS → **files_info byte-equal after explicitly-ledgered masks** (`file_time`; `file_size` only where encoder output legitimately differs — mask named in the gate); chunked join + SEC-066 re-sniff security tests (polyglot chunk assembly must fail closed); SSE job frames driven by the real client in Chrome (upload progress, stop, completion).
- **E. Tools.** Registry entries + handlers for tool_upload, tool_media_versions, tool_image_rotation, tool_posterframe, tool_pdf_extractor (ocrmypdf behind a binary-availability probe), tool_tc, tool_transcription local half. Per-tool differentials (scratch roots for mutations); non-admin refusal gates for every action.
- **F. Cutover + integration + tool_import_files.** Switch writes to the SHARED media dir; end-to-end Chrome upload/rotate/version flows; av/3d list qualities live in section reads; tool_import_files (with the named-processor registry replacing SEC-053); STATUS.md rows + ledger closure.

---

## 8. The media tools

All register as actions in the tool's `register.json`, dispatched by `src/core/tools/dispatch.ts` through `src/core/tools/registry.ts`, with declarative permission specs (`ToolActionSpec`, `src/core/tools/module.ts` — `permission: 'record_tipo'` + `minLevel: 2` on the target for every media mutation, since a media action names BOTH a component tipo and a record id; PHP `assert_record_in_user_scope` → the standard `getPermissions` gate + record-scope check). PHP's 8-gate `tool_request` chain (sanitize model → registry whitelist → per-user grant → realpath confinement → API_ACTIONS allowlist → public+static reflection → 0-or-1-object-param signature → declarative permission spec) is already re-expressed as the explicit TS registry (no reflection) — strictly stronger. Each tool's `register.json` is an ontology record in section `dd1340`.

- **tool_upload.process_uploaded_file** — the ingest entry (§6.2). `API_ACTIONS = ['process_uploaded_file']`.
- **tool_media_versions** (`API_ACTIONS = ['get_files_info','delete_quality','build_version','conform_headers','rotate','sync_files','delete_version','get_job_status']`) — thin verbs over §4–§6: `build_version` (`options.async` default **true** → job manager), `conform_headers` (AV remux), `sync_files` (`edit` mode, `regenerate_component`, re-scan disk), `delete_version` (thumb → `delete_thumb`, else `delete_file(quality,ext)`). Two TS-only additions the panel depends on (`WC-2026-08-04-media-versions-panel-wire`):
  - `build_version` on **component_av** builds the QUALITY THAT WAS ASKED FOR (`submitAvVersionBuild`, §6), and `get_job_status` (the shared `MEDIA_JOB_STATUS_ACTION`, also mounted on tool_upload) is how the panel follows that job. Watching the filesystem alone cannot distinguish "still encoding" from "the job died", which is why a failed transcode used to blink *Processing* forever.
  - `get_files_info` returns **`files_info_db`** — what the record STORES for the operated lang — beside the disk scan in `result`. The panel's "files info data is unsync" warning is a comparison of those two, and both sides must come from one answer: taking the stored side from the client's cached component data (a snapshot no refresh re-reads) made every delete raise a false alarm that a page reload cleared. It costs no extra query — the tool context already loaded the stored items.
- **tool_image_rotation.apply_rotation** (`API_ACTIONS = ['apply_rotation']`) — rotate all non-`original` tiers (`±distort SRT`) + proportional crop computed from the default-quality reference dimensions — the client sends `crop_area` in **pixels of the default-quality file it previews** (`render_tool_image_crop` already scales display px → natural px), the core divides by that file's dimensions and re-scales the resulting fraction per tier; feeding the pixel box straight to `-crop` yields a silent no-op (offset inside the frame → ImageMagick clamps) or a lost tier (offset outside → `geometry does not contain image`), so an out-of-reference box is REFUSED with an error instead (gate: `media_tools.test.ts` "crops every non-original tier from default-quality pixels"); **original never mutated** — asserted in code, not convention (rotate/crop targeting `quality === 'original'` refuses).
- **tool_posterframe** (`API_ACTIONS = ['create_identifying_image','get_ar_identifying_image']`) — `create_identifying_image`: instantiate the portal, `add_new_element` → `Save` → new image record in the target section, `Ffmpeg::create_posterframe` at `current_time` into the image original path, then image `process_uploaded_file` for derivatives; `get_ar_identifying_image`: walk inverse references for portals whose ontology node has an `identifying_image` property.
- **tool_pdf_extractor.get_pdf_data** (`API_ACTIONS = ['get_pdf_data']`) — method `text|html`, engine from the `dd1633` tool config (`pdftotext`/`pdftohtml`; `pdftohtml` takes no `-layout`), `type -P` resolution → TS boot-probe, page range, logical page `offset`. NO output encoding (CLIENT-2, 2026-10-11, `WC-2026-10-11-pdf-extractor-render-class`): the answer is `{value, render_class}` — text verbatim (`render_class: 'text'`, escaped by the client's `render_value`), html shaped on the server (fragment, numeric `a[name]` anchors → page tags keyed `page - 1 + offset`) and passed through `sanitizeRichText` last (`render_class: 'html'`). The `htmlentities`-equivalent encoding it replaces mangled `<…>` runs in editions and was decoded again by a client DOMParser round trip.
- **tool_transcription (local half only)** — `create_transcribable_audio_file` / `delete_transcribable_audio_file` (ephemeral `audio_tr` 16 kHz WAV), `build_subtitles_file` (VTT via the `subtitles` class into `get_subtitles_path(lang)` under the av `/subtitles` folder), ensure-audio-quality. The Babel/Whisper remote path (`automatic_transcription`, `check_server_transcriber_status`) is ledgered (§Out-of-scope). **`get_text_from_pdf` stays OFF the API surface** — PHP deliberately excludes it from `API_ACTIONS` (unauthenticated path arg); callers use tool_pdf_extractor.
- **tool_tc.change_all_timecodes** (`API_ACTIONS = ['change_all_timecodes']`) — pure text transform, no media I/O: offset every `[TC_..._TC]` mark (`TR::get_mark_pattern('tc')`), `OptimizeTC::TC2seg`/`seg2tc`, clamp ≥0, reverse the replacement map for positive offsets (collision avoidance); `edit` mode, per-lang, save. Cheap early port.
- **tool_import_files** — its own late phase (Phase F): the 1744-line bulk importer. Filename grammar regex `/^(\d*)?-?(?(?=.\.)|(.*?))(?(?=-)-([a-zA-Z]{1,2})|)\.([a-zA-Z]{3,4})$/` (id / base_name / field-letter / ext; e.g. `73-my image-A.tiff` → id 73 / "my image" / A / tiff); `import_mode` `default|section|section_resource` × `import_file_name_mode` `null|enumerate|named|match|match_freename`; `match` via stored-record relation walk, `match_freename` via an SQO with `skip_projects_filter` + trailing-`.` boundary; `set_components_data` roles `target_filename`/`target_date` (EXIF/ffprobe/pdfinfo dates)/`input_component` (translatable temp-data path); `BACKGROUND_RUNNABLE = ['import_files']`; per-file CLI/job progress. **SEC-053 custom `file_processor` functions are NOT ported as arbitrary sandboxed PHP** — replaced by a registry of named TS processor functions (the explicit-registry rule; strictly stronger).
- **tool_time_machine** touchpoint — the section-restore branch of `apply_value` calls `restore_deleted_section_media_files` (re-link media soft-deleted between snapshot and now). Lives in `tool_time_machine` (already partially ported); the media re-link is `file_ops.restoreDeletedSectionMediaFiles`.
- **tool_subtitles** — ledgered client-only (`API_ACTIONS = []`).

---

## 9. Preserve vs modernize (explicit rulings)

| Preserve byte/behavior-exact | Why |
|---|---|
| `files_info` entry shape, key order, value formats; sibling keys (`original_*`, `modified_*`, `lib_data`) | shared-DB contract |
| identifier & path grammar, buckets, `initial_media_path`, `deleted/` naming (BOTH stamp formats `Y-m-d_Hi` and `Y-m-d_Gis`), `rename_old_files` | shared-disk contract |
| raw+normalized original pair; original never mutated; posterframe hard-unlink | Original law |
| MB×350000 pixel law, never-upscale, `dd_thumb` recipe, ICC CMYK→sRGB + `-strip`, EXIF orientation swap, PDF density/cropbox | derivative parity |
| two-pass x264 + qt-faststart, PAL/NTSC-by-fps, audio 44100/128k/2, audio_tr 16k mono, aac-encoder pick order | output-shape parity; 39 profiles → typed data with argv token gate |
| placeholder fallback for missing derivatives; TM `deleted/` scan semantics | client contract |
| `nice -n 19` | shared-host coexistence |
| PHP `DEDALO_*` config-key names & defaults (§3) | env-config mandate; wire/URL parity |

| Modernize | How |
|---|---|
| shell strings / `.sh` launchers / `escapeshellarg` | argv arrays, no shell — stronger |
| load-bearing typos (`$gammma`, `get_ffprove_installed_path`) | clean internal names; zero wire/disk surface |
| settings-as-PHP-code | one typed profile table + boot-probed capabilities |
| detached nohup + PID-only status | supervised jobs, progress, caps, idempotent restart re-queue (§5.5) |
| finfo | closed-world magic-byte sniffer (§6.3) |
| **Ledgered post-parity options** (do NOT change outputs while gates depend on recipe parity) | CRF single-pass x264, streaming multipart, SVG upload sanitization, raising concurrency caps |

---

## 10. Security — chokepoint map (≥ PHP)

| Chokepoint | PHP | TS mandate |
|---|---|---|
| Upload MIME/ext | finfo sniff + `get_known_mime_types` cross-check (`:1079,:3035`) | closed-world magic-byte sniff + allowlist data; client MIME never read; fail-closed on unknown |
| Chunk assembly | SEC-066 re-sniff of joined file (`:1481-1498`) | same, + per-chunk sniff + a polyglot-assembly fail-closed test in the gate |
| Staging confinement | `sanitize_key_dir`, `safe_upload_target` basename+realpath, per-user 0750 dirs | same grammar gates + ONE `assertInsideMediaRoot` chokepoint on every fs touch |
| add_file source | SEC-063 tmp-dir allowlist + rebuilt path + realpath + `valid_file_extension` (`:901`) | ported verbatim; source path never client-supplied |
| Quality strings | SEC-065 `[A-Za-z0-9_\-.]+` (`:2830`) | charset AND catalog membership (`assertValidQuality`, stronger) |
| Identifier segments | implicit | `identifier_gate` tipo validation + integer section_id (stronger) |
| Shell | `escapeshellarg` everywhere | **no shell exists**; argv arrays; binaries from a boot-time absolute-path allowlist |
| Tool dispatch | 8-gate reflection chain (`dd_tools_api.php:178-394`) | explicit `src/core/tools/registry.ts` + `dispatch.ts` (no reflection) + declarative `register.json` permission/min-level spec run before the handler |
| Record scope | `assert_record_in_user_scope` on every mutation | `getPermissions ≥ 2` + record project-scope check in every mutating handler |
| CSRF | upload not exempt; header+field fallback (SEC-008) | same, constant-time compare |
| Custom processors | SEC-053 realpath+regex+Reflection sandbox (`tool_import_files.php:595-643`) | replaced by an explicit named-processor registry (strictly stronger) |
| Serving | reverse proxy + media_protection | production: the reverse proxy enforces the **TS-GENERATED** rules (rule A auth-cookie marker / rule B pub marker, fail-closed 404); the engine never serves a media byte. Dev route stays session-gated fail-closed 404 (no existence leak) and OFF by default |
| Media auth cookie | fixed-name daily sha512 marker (PHP) | same, now TS-owned: 128-hex validated before ANY filesystem use (the value BECOMES a filename); HttpOnly + SameSite=Lax + Secure; the auth store lives OUTSIDE the media root (a served store is a universal anonymous bypass) |
| Original integrity | convention | asserted invariant: rotate/crop/transcode refuse `quality === 'original'` targets |
| Converter resources | none (PHP passed no `-limit` and shipped no policy) | **two halves, both required** (audit MEDIA-01): the shipped `engine/imagemagick-policy/policy.xml` `domain="resource"` block is the HARD CEILING (memory/map/area/disk/width/height/time — a process may lower a resource below a policy value, never raise it above), and `magickResourceLimitArgs()` splices the install's OPERATING limit (`DEDALO_MAGICK_LIMIT_*`) as `-limit` argv into BOTH ImageMagick spawn sites. The Dockerfile installs the same file at the system config path so a delegate child and any non-engine `convert` are bound too. memory/map/area/disk degrade to a disk-backed cache; width/height/time REFUSE, and the dimension ceilings refuse at header-parse time, before a pixel is allocated. NO DELEGATE RESIDUE: the one process neither half could reach was Ghostscript, reached as an ImageMagick DELEGATE on the PDF cover path — measured, a 441-byte PDF declaring a 200000x200000-point page kept a gs child growing an intermediate towards 120 TB, and after the request cap SIGKILLed the `magick` we spawned that child reparented to PID 1 and ran on unreaped. The policy now DENIES the `gs` delegate and the engine spawns Ghostscript itself (`engine/ghostscript.ts`, `DEDALO_GS_PATH`): poppler reads the page box first (`engine/pdf.ts readPdfPageSize`), a page above `DEDALO_MAGICK_LIMIT_WIDTH`/`_HEIGHT` at the render density is REFUSED before anything is drawn, the render runs under the spawn cap, and the process that cap kills is the one doing the work. ImageMagick only ever encodes the resulting PNG. Gates: `magick_policy_tripwire` + `magick_resource_limits_native` + `pdf_rasterizer_native` |
| Converter admission | none (every conversion ran inline, unbounded in NUMBER) | **a permit, taken at the spawn door** (audit MEDIA-01, the plural half). A per-process resource bound multiplied by K concurrent uploads is not a bound: measured 2026-09-05 on the shipped defaults, one 2.4 MB 20000x20000 TIFF no longer takes the RAM — it spends the whole `-limit disk` budget instead (16 GiB apparent / 8.2 GiB real) over 22 s, and two concurrent uploads held 16 GiB of real disk at once, because `createStagedThumbnail` is awaited INLINE on the authenticated upload request. `engine/admission.ts` bounds how many pixel converters run at once (`DEDALO_MEDIA_CONVERT_CONCURRENCY`, default 2) and refuses a waiter that has queued past `DEDALO_MEDIA_CONVERT_QUEUE_SECONDS` with `rate.limited` (429, retryable) rather than holding a request lane forever. The permit is taken by the SPAWN DOORS — `runMagickTo`, `rasterizePdfPage`, `rasterizeSvg`, `runIdentify` — never by one caller, so every inline derivative build is bounded, including the ones written after it; EVERY ImageMagick spawn takes one, `runIdentify` included: the `-ping` exemption this table used to record was REFUTED by measurement 2026-09-05 — `-ping` skips the pixels but still enumerates every SCENE, so a hand-written 4.6 MB GIF89a of 200000 1x1 frames (0.2 % of the upload cap, a thumbnailable extension) cost the upload preview's own argv 26.3 s and 8.73 GB RSS with every pixel-cache limit armed, and four concurrent probes were four concurrent identify processes. The latency worry that motivated the exemption is answered by COST instead: `-limit list-length` (`DEDALO_MAGICK_LIMIT_LIST_LENGTH`, default 4096) refuses such a source at 180 MB before the enumeration completes, so a header read is genuinely cheap for EVERY input and its permit is held for milliseconds — measured through the real `probeImageSource`, 163 ms to refuse, and a legitimate 63-frame animation unaffected. A second permit around a `runIdentify` is forbidden (a permit held while waiting for a permit deadlocks at concurrency 1). The non-ImageMagick header reads (`pdfinfo`, `ffprobe`) stay ungated. THE AV PRODUCERS ARE ADMITTED TOO, by a SECOND pool: `media/jobs.ts` was recorded here as the AV path's admission, and that was FALSE for the two audiovisual API actions — `create_posterframe` and `download_fragment` are awaited INLINE in `api/handlers/dd_component_av_api.ts`, submit no job and appear in no lane, and `download_fragment` runs a full second re-encode when a watermark is asked for, with a client that waits an hour by contract; K authenticated readers were K unbounded ffmpeg processes. `engine/ffmpeg.ts:runProducer` and `tools/fragment.ts:runFfmpeg` now take `withAvSlot` (`DEDALO_MEDIA_AV_CONCURRENCY`, default `DEDALO_MEDIA_JOB_CONCURRENCY + 1`; `DEDALO_MEDIA_AV_QUEUE_SECONDS`, default 120). It is a separate pool from the image one on purpose: an image permit is held for seconds and an AV one for minutes, so a shared ceiling would queue every upload thumbnail behind a transcode, and a job lane must never wait on the pool an image conversion is waiting on. A media job takes BOTH (its lane says the work may run, the permit says an ffmpeg may start now) — a lane is not a permit, and nothing holding an AV permit ever waits for a lane. THE SPILL ALSO HAS A CHOSEN FILESYSTEM: `-limit disk` budgets the pixel cache, it does not prevent it, and ImageMagick picks the volume from `MAGICK_TMPDIR` — unset, the OS temp dir, which on both shipped compose stacks is the volume the DATABASE lives on. `magickPolicyEnv(scratchDir)` now requires the directory and every caller names one inside the media root, the twin of the `TMPDIR` the PDF rasterizer hands Ghostscript. Gates: `magick_policy_tripwire` (census of every spawn door, both pools, plus the leg that no API handler spawns a converter of its own) + `media_admission_native` (both pools bound the real binaries) |

Also carry over: never reveal media existence to the unauthorized (fail-closed 404s), activity logging on upload/delete (the `'UPLOAD COMPLETE'` / `'DELETE FILE'` entries), and the record-scope gate on TM/filename-match paths that deliberately skip the projects filter.

---

## 11. Verified real-world corpus (fixtures)

> **ADDENDUM 2026-08-31 (P3-2 / GATE-47) — READ THIS BEFORE THE TABLE BELOW.**
> **This section is HISTORY, not instruction.** It records the corpus these
> behaviours were originally *observed* against; it is no longer how a gate is
> written, and following it literally produces a gate the ratchet rejects.
>
> Two laws have overtaken it, both mechanical:
>
> - **Tests use the generic `test` TLD and BUILD the situation they test**
>   (AGENTS.md). A gate naming `rsc*`, `numisdata*`, `oh*` or any other
>   install-specific TLD passes on one machine and nowhere else.
>   `generic_tld_tripwire` REFUSES such a gate — shrink-only, so the ratchet
>   will reject a new one outright.
> - **The suite writes only to a database that says it is one** (the
>   `dedalo_test_marker` row) and to a media root that says it is one
>   (`.dedalo_test_media`). `dedalo_mib_v7` is the live APPLICATION database:
>   never a fixture source, never a gate target.
>
> So: read the table for WHAT the media family does (bucketed paths, the lang
> suffix, the pdf web+cover+text triple). Build the fixture through the engine's
> own write path on a `test` TLD — `src/core/test_data/` situations — and assert
> against that. The AV row's advice still stands in spirit and is now the rule
> everywhere: seed a scratch chain, never lean on whatever the ambient install
> happens to hold.

Pinned against the live corpus at the time of writing (this install,
`dedalo_mib_v7`) — see the addendum above before using any of it:

| Node | Model | Notes |
|---|---|---|
| rsc29 in rsc170 | component_image | primary image fixture (`rsc29_rsc170_770.jpg`, `…/image/1.5MB/0/`); bucketed path |
| rsc37 in rsc176 | component_pdf | pdf web + jpg-cover + text |
| svg fixture | component_svg | web raster thumb |
| translatable image node | component_image | id lang-suffix case (`_lg-spa`) |
| rsc35 in rsc167 | component_av | **this install has ZERO real AV records** — AV write/transcode gates need seeded scratch fixtures (the `STATUS.md` tool_indexation precedent: fabricate a scratch AV chain; never fabricate to pin *client* behavior, only engine behavior) |
| posterframe/identifying_image exemplar | tool_posterframe | portal `identifying_image` property node |
| a `deleted/`-carrying record | file_ops | TM `deleted/` scan fixture |

Existing gates to keep green (zero fixture changes): `model_coverage_sweep.test.ts` (image/svg/pdf list-mode), `media_lifecycle_native.test.ts` (the delete/restore pair — it replaces the retired `delete_media_files.test.ts`, which gated the inert `delete_record.ts` copy), `media_serving.test.ts`, `tool_export_differential.test.ts` (media cells). New gates land per §7.

---

## 12. Gates (definition of done for the media family)

1. **Standing suite green, zero fixture/normalization changes** throughout the strangler migration.
2. **Config parity.** The TS effective media catalog (qualities/defaults/extensions/thumb dims/binary paths) equals the PHP install's `DEDALO_*` constants; every value is `.env`-overridable; no module hardcodes a quality/extension/dimension (§3).
3. **Path & index parity.** Golden path/identifier tests vs PHP-computed paths (all 5 types, bucketed + translatable); `scanFilesInfo` byte-equal to live stored `files_info` over the shared dir (§B).
4. **Processing parity.** Realistic per-type gates (§C): identify-parity (dims/format/colorspace/orientation/ICC), ffprobe stream-shape parity (codec/w×h/fps/audio/duration ±0.1 s/faststart), pdftotext text equality, ffmpeg-profile argv token-parity; byte-inequality rationale recorded.
5. **Ingest parity.** Same source file → files_info byte-equal after ledgered masks; SEC-066 polyglot fail-closed; SSE job frames driven by the real client in Chrome (upload/stop/complete). `duplicate_record` media-copy ledger closed.
6. **Tools.** Every media tool registered + differential-gated (scratch roots for mutations) + non-admin refusal gate; `original` never mutated (asserted); tool_import_files with the named-processor registry.
7. **Security.** Every §10 chokepoint has a passing fail-closed test (invalid quality/tipo, traversal, over-scope record, unknown MIME, polyglot chunk, unauthorized tool/action).
8. **Ledger closure.** STATUS.md gains the Media rebuild table; the out-of-scope items (media protection, Babel API, 3D converters, PHP `processes` interop) and any remaining narrows are written down. Never silently narrow.

---

## 13. Suggested phasing recap (executor may evolve; mirrors the relations/area A–F pattern)

- **A. Contracts + config + adapters + probes** — `concepts/media.ts`, the `.env` config catalog, `path.ts`, `engine/*`, mime sniffer; re-base the read surface; config/path/probe/profile parity gates; suite green untouched.
- **B. files_info scanner + file ops** — byte-equal scan over the shared dir; twin soft-delete/rename/duplicate on scratch; duplicate ledger closed.
- **C. Processing engines (scratch)** — image/pdf/svg/3d/av; realistic parity gates.
- **D. Upload + ingest + jobs (scratch)** — the endpoint, chunked/SEC-066, the job manager + SSE Chrome drive.
- **E. Tools** — the registry handlers + per-tool + non-admin gates.
- **F. Cutover + tool_import_files + ledger closure** — writes to the shared dir; av/3d live in reads; STATUS.md rows updated.
