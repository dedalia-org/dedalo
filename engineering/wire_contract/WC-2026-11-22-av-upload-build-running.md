# WC-2026-11-22-av-upload-build-running — an av upload during a live build of the component is refused (`media.build_running`)

- **Date:** 2026-11-22 (audit item A1-01).
- **Decision:** v6 parity restored — v6 master `81be039d6c` (2026-11-03):
  `tools/tool_upload/class.tool_upload.php:80` (`component_av::is_build_locked` →
  refuse, unlink the staged file), `core/component_av/class.component_av.php:1120-1146`
  (one background build per component, file lock). Code:
  `src/core/media/ingest/process_uploaded_file.ts` (`claimAvBuildTarget`),
  `src/core/media/jobs.ts` (`claimTarget`, `exclusive` / `claim` submit),
  `src/core/media/av_versions.ts` (`avIngestTarget`, both av submits exclusive).
- **Shape before (TS):** `tool_upload` `process_uploaded_file` (and the MCP
  `upload_media` door) on a `component_av` whose ingest transcode or per-quality
  build of the default or audio tier was running answered `ok:true` with a `job_id`:
  the master was replaced under the running ffmpeg and a SECOND ingest transcode
  started; whichever finished last won the default tier (possibly the encode of
  the OLD master) and the two files_info write-backs raced.
- **Shape after (TS):** the same request answers `ok:false`, HTTP 409,
  `error.code = 'media.build_running'` (category `conflict`, public, not
  retryable; label `error_media_build_running`, v6's sentence "A version build is
  already running for this file. Wait until it finishes and try again"). Refused
  BEFORE the move: the staged upload is deleted (file, preview, name record), the
  stored original and the record are untouched, no job is created. "Live" = a
  running/queued job on the default or audio tier, or another av upload of the
  same component between its check and its transcode submit (a claim). A direct
  `submitAvTranscode` / `submitAvVersionBuild` over a live tier throws the same
  code (`tool_media_versions`' build answers it where a race slipped past its
  pre-flight `media.av_build_refused`).
- **Reason:** one build per component is the only state in which the default tier
  and the stored files_info describe the master on disk. The client needs no
  change: `render_tool_upload.js` renders any failure through `error_text`, which
  resolves the label.
- **Gate reconciliation:** no frozen fixture carries an av upload during a build
  (the harvest has no tool_upload interaction for it); no re-harvest. Gate:
  `test/unit/av_upload_build_guard_native.test.ts`.
