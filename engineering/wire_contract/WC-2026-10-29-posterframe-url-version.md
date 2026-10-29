# WC-2026-10-29-posterframe-url-version — av/3d `posterframe_url` carries `?v=<mtime ms>-<size>`

- **Date:** 2026-10-29 (component_av render performance pass).
- **Decision:** DEC-12 (gated: `test/unit/av_posterframe_url_version_native.test.ts`).
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
- **Indexation grid media cells (`section/indexation_grid.ts` `versionedMediaUrl`):** the av/3d
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
  grid before the deep-equal, same pattern.
