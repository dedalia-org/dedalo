# WC-2026-11-19-media-url-version-key — the media URL version key is `dv`, not `v`

- **Date:** 2026-11-19 (task: av record on a remote install showed duration 0:02 in the edit
  view and tool_media_versions; the file is 1:25:58).
- **Amends:** WC-2026-10-29-posterframe-url-version (same token, renamed key).
- **Cause (measured):** the install's Apache runs `mod_h264_streaming` 2.2.8, which reads the
  `v` query key of an `.mp4` request as a trim parameter. `?v=1536576223-662979797` (the
  client's `<file_time.time>-<size>`) served 498 136 bytes / 2.53 s instead of 662 979 797;
  the same value under `t`, `x` or `dv` served the whole file. 13-digit (ms) values happened
  to be ignored, so server-emitted URLs were less exposed, but the key is the defect.
- **Shape before (TS):** every versioned media URL ended `?v=<token>` — client `get_media_url`,
  server `posterframe_url`, `base_svg_url`, indexation-grid media cells, login `user_image`.
- **Shape after (TS):** `?dv=<token>`, token unchanged. Old `?v=` URLs still resolve (the media
  server ignores unknown keys where no streaming module is loaded); they only miss the cache once.
- **Client effect:** av plays its full duration behind Apache with mod_h264_streaming.
- **Gate reconciliation:** parity strips now match `\?dv=\d+-\d+`; no fixture change.
- **Gates:** `media_url_version_tripwire` rule 5 (builders emit `?dv=`, no `?v=` in any media
  component), `media_url_version_native`, `client_media_url`.
