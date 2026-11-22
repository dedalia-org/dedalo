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
  stored original and the record are untouched, no job is created. ONE BUILD PER
  COMPONENT (section/id/component/lang), as v6's per-component lock file: "live" =
  a running/queued ingest transcode or per-quality build of ANY tier of the
  component, or another av upload of it between its check and its transcode
  submit (a claim). The same rule refuses a build: `tool_media_versions`
  `build_version` of any tier while the component holds an upload claim, the
  ingest transcode or another tier's build answers `media.build_running` (409)
  BEFORE the source is looked for (pre-flight) and again at the exclusive submit
  (race backstop); a direct `submitAvTranscode` throws it too. Different
  components of one record never exclude each other.
- **Reason:** one build per component is the only state in which the default tier
  and the stored files_info describe the master on disk. The client needs no
  change: `render_tool_upload.js` renders any failure through `error_text`, which
  resolves the label.
- **Gate reconciliation:** no frozen fixture carries an av upload during a build
  (the harvest has no tool_upload interaction for it); no re-harvest. Gate:
  `test/unit/av_upload_build_guard_native.test.ts`.
- **Addendum 2026-11-22 (review MED-2, component scope):** the first landing
  (`2689273e76`) guarded the default + audio TIERS only — a 1080 build did not
  refuse an upload (nor the reverse), and two builds of different tiers of one
  component ran together, which v6's single lock forbids. Now every holder of
  the av build family carries `JobTarget.scope = 'component'`
  (`src/core/media/jobs.ts`, one extra component key in the same arbiter). Wire
  change for `build_version`: a build refused because its OWN tier was busy
  answered `media.av_build_refused` (400) from the pre-flight; it now answers
  `media.build_running` (409) like every other busy-component refusal — one
  condition, one code. `media.av_build_refused` keeps the refusals that do not
  depend on another job (no source, no profile, no audio stream, the original as
  target). The panel renders either through `handle_api_error`. **Owner-confirmed
  2026-11-22**: the 400 → 409 change for the own-tier-busy refusal is the ruled
  shape, not a provisional one.
- **Addendum 2026-11-22 (owner ruling 5, cross-process):** the refusal holds
  across server instances. Every component-scoped holder (upload claim, ingest
  transcode, per-quality build) also takes a per-component lock FILE with
  O_EXCL in the shared processes dir (`<DEDALO_MEDIA_PROCESSES_DIR>/component_locks/`,
  `src/core/media/component_lock.ts`) — memory first, then the file, released
  together. A lock held by another LIVE instance answers the same
  `media.build_running` (409); a stale one (dead pid on the same host, heartbeat
  older than 120 s, unreadable and old, this instance's own leftover) is
  reclaimed under a second O_EXCL mutex and logged. Requirement: every instance
  serving one media tree shares one processes dir
  (`engineering/PRODUCTION.md` §8.1). No wire shape changes. Gate:
  `test/unit/media_component_lock_native.test.ts`.
- **Addendum 2026-11-22 (owner ruling 4, the other av writers):** every av
  operation that writes tier files OUTSIDE the job manager now holds the same
  component claim for its whole write and its files_info write-back
  (`withAvComponentClaim`, `src/core/media/av_component_claim.ts` — the arbiter's
  own `claimTarget`, so memory + the cross-process lock file; released in a
  `finally`), and refuses with `media.build_running` (409) while a build, an
  upload or another such operation holds the component. Covered:
  `tool_media_versions` `conform_headers`, `delete_quality`, `delete_version`,
  `sync_files` (Regenerate), `build_version` of the thumb tier (the only av tier
  built synchronously — every other tier is a job that already holds the
  component); `dd_component_av_api` `create_posterframe` / `delete_posterframe`;
  the update-cache Regenerate sweep (`regenerateMediaDerivatives`), where a busy
  component is a per-record VALUE in `errors` and the sweep goes on. NOT wrapped:
  the ingest and the transcode (already the holder — the hold is taken at the
  OPERATION's entry, never inside the shared thumb/posterframe cores, so the
  holder never refuses itself); `rotate` (image-only, `tool_image_rotation`);
  `tool_posterframe`'s identifying image (reads the av, writes an image record).
  Non-av models are unchanged. Wire change: those actions can now answer 409
  `media.build_running` where they used to run concurrently with a build. Gate:
  `test/unit/av_component_operations_native.test.ts`.
- **Addendum 2026-11-22 (owner ruling 3, the panel):** the record-scoped job
  listing tells the client the scope. `dd_utils_api::get_record_jobs` (and
  `get_activity`, the same projection `activityRowFromMediaJob`) rows gain
  `scope: 'component' | null` — additive; `null` on every unscoped row, never
  absent. `tool_media_versions` greys (class `component_busy`, `aria-disabled`,
  inert, title = tool label `component_busy` + the building tier) the build
  gear of EVERY tier of an av component with a live component-scoped job, not
  just the building tier; a failed holder releases them, a finished one
  re-renders. Non-job holders (the upload claim before its transcode, the
  ruling-4 synchronous operations, another instance's lock) are not listed:
  the 409 refusal covers them. No frozen fixture carries a get_record_jobs
  answer; no re-harvest. Gates: `test/unit/activity_aggregate_native.test.ts`
  (scope projection), client suite `test_tool_media_versions` (6 tests).
