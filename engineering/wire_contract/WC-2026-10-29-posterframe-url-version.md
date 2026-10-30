# WC-2026-10-29-posterframe-url-version — media URLs carry `?v=<mtime ms>-<size>` (av/3d `posterframe_url`, image `base_svg_url`, grid cells)

- **Date:** 2026-10-29 (component_av render performance pass; same day extended to every media model).
- **Decision:** DEC-12 (gated: `test/unit/media_url_version_native.test.ts`, `test/unit/client_media_url.test.ts`,
  `test/unit/media_url_version_tripwire.test.ts`). ONE helper per side: server
  `src/core/media/url_version.ts` (`fileVersionToken`, `versionedMediaUrl`), client
  `client/dedalo/core/component_media_common/js/media_url.js` (`get_media_url`).
- **Shape before (PHP and TS):** `posterframe_url` = `<media web base><relative path>` (bare), or
  `null` when no file. Every client view appended `?t=<Date.now()>`, so the still was never served
  from the HTTP cache — each render (pagination, refresh, revisit) fetched it again.
- **Shape after (TS):** `<media web base><relative path>?v=<file mtime, integer ms>-<file size>`;
  still `null` when no file (the existence check is now the `statSync` that reads both). The URL
  changes only when the file does, so a regenerated posterframe gets a new URL on the next read. Size
  is in the token because some media mounts (FAT, some SMB/NFS NAS shares) keep mtime to the second:
  two stills written in one second still differ. Every producer publishes by atomic rename
  (`src/core/media/atomic.ts`, `tools/posterframe.ts` upload), so no URL ever names a partial file.
  Client views (component_av + component_3d) no longer append `?t=`.
- **Video (client-only, no wire change):** the av default edit view versions video/quality URLs as
  `?v=<files_info.file_time.time>-<file_size>` — values the server already re-scans from disk on
  every av read (`component_emit.ts`); no `file_time` → render time (never cached).
- **Image `base_svg_url` (`media/svg_overlay.ts` `baseSvgUrl`):** `<media web base><svg relative
  path>?v=<mtime ms>-<size>`; still `null` when no envelope. Stat-versioned (not files_info) because a
  vector-layer save rewrites the envelope without touching files_info.
- **Client, every media model (av, 3d, image, pdf, svg):** files_info-backed URLs (qualities, thumbs,
  pdf, svg files, the raster an image envelope embeds) are built by `get_media_url` as
  `?v=<file_time.time>-<file_size>`. av re-scans files_info per read; image/pdf/svg/3d serve the
  STORED files_info, which every byte-changing writer refreshes through
  `media/tools/files_info_persist.ts` — a file edited out of band stays cached until the
  `files_info` reconcile sweep, the same tradeoff av video already accepts. No `?t=<Date.now()>`
  in any media component view (tripwired).
- **Indexation grid media cells (`section/indexation_grid.ts` → `url_version.ts` `versionedMediaUrl`):** the av/3d
  posterframe and image/pdf/svg thumb cells keep the PHP-grammar PATH byte for byte and gain the
  same `?v=<mtime ms>-<size>` when that path names a readable file inside the media root; otherwise
  (no file, stat error, a path escaping the root, a non-media URL) the URL is returned bare, as before.
- **Stat errors:** any stat error is "no file" (`null` posterframe / bare grid URL), exactly as the
  `existsSync` it replaced answered — an unreadable mount never fails a read.
- **Client:** av/3d views use the URL as given. `tool_posterframe` still appends its own `?<time>`
  to its preview after create/delete (deliberate: it must show the new still before any re-read).
- **Gate reconciliation:** `component_datalist_lifecycle_differential` "av: posterframe …" compares
  the TS value with `?v=\d+-\d+$` stripped against the frozen PHP fixture (WC-001 transform pattern) —
  no fixture change, no re-harvest. `indexation_grid_differential` strips `?v=\d+-\d+` from the TS
  grid before the deep-equal, same pattern. `component_image_context_differential` strips it from
  `base_svg_url`, same pattern.
