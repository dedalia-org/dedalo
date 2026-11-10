# WC-2026-09-24-tool-export-server-built-artifacts — tool_export builds the export on the server; the browser gets one page and a download link

- **Date:** 2026-09-24, adopted with the tool_export-at-scale change (the
  export moves from the browser into a background job with a spool on disk).
- **Decision:** none. The change is additive to the wire: five new
  `tool_export` actions (`build_export_artifact`, `build_export_file`,
  `get_export_preview`, `list_export_jobs`, `delete_export_job`), one new GET
  route, nine new `export.*` error codes (the table below), and one optional key
  on the job status frame. (Amended 2026-09-24, review: this line said four
  actions and seven codes while the sections below listed all five and nine.)
  `get_export_grid` keeps its request, protocol and gates; TWO byte-level
  changes: a `component_external` cell now fetches its remote row in the
  export's data lang (`options.lang`), not the session's (see below); and
  `data.unresolved` is now a list of DISTINCT notes instead of one entry per
  record × field (see "Terminal frame" under `build_export_artifact`).
  (Amended 2026-09-24, review: this line said ONE change and named only the
  first.)
- **Scope:** `tools/tool_export/server/{index,export_job,preview,download,access,artifact_store,spool_reader}.ts`,
  `tools/tool_export/server/writers/`, the route (registered through `ToolServerModule.httpRoutes`, dispatched by `src/server.ts` via `loader.ts toolHttpRouteFor`), the
  `export.*` block of `src/core/errors/registry.ts`, and `JobStatusFrame.error`
  in `src/core/media/jobs.ts`; since the "related media" addendum also
  `src/diffusion/export/{row_media,atoms,grid}.ts`, the media-read hook of
  `src/core/resolve/relation_list.ts` and `tools/tool_export/js/render_tool_export.js`
  `get_media_models_in_data`.

## Shape before (PHP, and TS until this change)

The ONLY export action the client used was `get_export_grid` with
`ndjson_stream: true`. The browser read the whole NDJSON stream (`meta`,
`col*`, `row*`, `end`), kept every row in memory and in the DOM
(`flat_table.js` accumulator), and built every download itself: CSV/TSV by
string concatenation, ODS/XLSX with SheetJS, HTML by cloning the preview DOM
into a `data:` URL, and the media ZIP by fetching each media URL in the browser.
Print printed the preview. A download could therefore only hold what the
browser had managed to render, and a large export exhausted the tab.

There was no server-side export artifact, no route to download one, and no
`export.*` error code.

## Shape after (TS)

### `get_export_grid` — same request, protocol and gates; one cell family's lang changed

Same request, same NDJSON protocol, same buffered shape, same gates (module
section gate + `assertExportSqoSections` on every `sqo.section_tipo`). The
per-section SQO check was only extracted into an exported function so the
background job runs the same one. The bundled client no longer calls it.

**The one byte change — the walk's AMBIENT data lang.** The walk now runs
inside the export's own identity scope (`grid.ts createExportScope`), whose
data lang is the export's: `options.lang`, default `lg-spa`. Before, it ran in
dispatch's scope, whose data lang is the SESSION's
(`session.dataLang ?? config.menu.dataLang`). Literal cells never read that
ambient lang (the export lang is passed down to them explicitly), so they are
unchanged. A cell that reads `currentDataLang()` does change: today that is
the `component_external` cell (`relation_list.ts resolveCellValue` →
`deriveExternalValue` → `external/cache.ts fetchExternalRows`), whose remote
row is fetched per lang (Zenon `lgn=`).

- Before: a session in `lg-eng` exporting with `options.lang: 'lg-spa'` (or
  with no `options.lang`) got its literal cells in `lg-spa` and its external
  cells in `lg-eng` — one export, two languages.
- After: every cell is in `options.lang`. A detached job has no session lang
  at all, so this is the only definition all three forms (stream, buffered,
  background) can share.

Gate: `test/unit/export_external_data_lang_native.test.ts` (per-lang primed
external rows; `options.lang` wins over the session lang both ways, the
`lg-spa` default wins over an `lg-eng` session, detached === in-request).

Gates that still pin the protocol and the gates:
`tool_export_stream`, `diffusion_export_unified`, `tool_export_sqo_gate`,
`export_gate_b_native`, and the two `tool_export_*_differential` parity replays.

### New actions (all through `dd_tools_api::tool_request`, `source.action` = the action)

Every action is declared `permission: 'section', minLevel: 1` on
`options.section_tipo`.

**`build_export_artifact`** — background only, lane `export`.

Request `options`: the `get_export_grid` options without `ndjson_stream`
(`section_tipo`, `model`, `data_format`, `breakdown`, `fill_the_gaps`,
`ar_ddo_to_export`, `sqo`) plus `background_running: true`.

- Submit answer: the framework's background envelope,
  `{ok: true, data: true, job_id, background_job_id, pid, pfile}` (the four
  handles are extension keys; `job_id` is the LANE job id).
- Progress frames (`dd_utils_api::get_job_events` / `get_process_status`),
  `data` = `{msg, job_id, written, total, is_running}`. Here `job_id` is the
  ARTIFACT id (`exp_<base36 ms>_<12 hex>`), which is different from the lane job id.
- Terminal frame `data` = the handler envelope,
  `{ok: true, data: {job_id, status: 'ended', total, records, rows, spool_bytes, columns, unresolved, narrowed}}`.
  `unresolved` (here, in the manifest, and in the inline `get_export_grid`
  `data.unresolved`) is a list of DISTINCT notes — each once, however many
  records raise it (amended 2026-09-24, review: it was one entry per record ×
  field, so a 300k-record walk persisted millions of copies into the manifest
  every later read parses). Gate: `tool_export_relation_dataframe_fanout_native`.
  `narrowed` (boolean) says the ACL frontier NARROWED the walk (an SQO hop
  through a component the owner cannot read answers `1=0`, an order hop is
  dropped): the files hold fewer or differently ordered records than asked
  for. A FLAG, never the refusals: the same one-notice / no-coordinates rule as
  the envelope's `perm.out_of_scope` notice (a refusal can name a record the
  owner may not see). The coordinates stay server-side (manifest
  `frontier_refusals`, never served) and in the operator log. (Amended
  2026-09-24, review: the frame carried the raw `frontier_refusals` list —
  section/component/record coordinates — and no client read it, so a narrowed
  download was never told to the user.)
- The walk's refusals are the JOB's: the producer never forwards them into an
  ambient request context (`grid.ts ExportGridRunOptions.enclosingRequest` is
  passed explicitly by `exportGridUnified` only). The detached worker inherits
  the submitting request's context through the job manager; before the review
  it wrote the walk's refusals into that long-ended request for the whole walk.
- A foreground call (no `background_running`) is refused with
  `request.invalid_options`.
- The build RUNS ON and RECORDS only its own options: the ALLOWLIST
  `EXPORT_MANIFEST_OPTION_KEYS` (`section_tipo`, `sqo`, `ar_ddo_to_export`,
  `data_format`, `breakdown`, `lang`, `fill_the_gaps` — every key the producer,
  the owned-job re-check and the summary read). Any other key (transport flags,
  `model`, anything unknown) is dropped, never persisted. The recorded object
  is capped at `MANIFEST_OPTIONS_MAX_BYTES` (1 MiB serialized); above it the
  submit's job fails with `request.invalid_options` (coordinates `{bytes,
  limit}`) BEFORE any other gate, the selection or a job directory. createJob
  also charges the manifest's own bytes to the user's quota before writing it
  (`export.artifact_quota`, nothing on disk), and refuses an oversized options
  object itself (defence in depth). (Amended 2026-09-24, review: the manifest
  stored the caller's whole options object, uncapped and charged 0 bytes, and
  every checkpoint, preview page, file build, download and listing re-parsed
  it — one ~250 MB body became persisted, repeated JSON work; list_export_jobs
  held every such manifest in memory at once.) Gates:
  `tool_export_job_native` E2 + I, `tool_export_artifact_store_native` D.
- Admission: the action's `admit` hook runs before the job is registered. At
  most `DEDALO_EXPORT_JOBS_PER_USER` (default 2) of the caller's
  `build_export_artifact` + `build_export_file` jobs may be queued or running.
  Over the limit, the submit request itself fails with `export.too_many_jobs`
  (429, `details: {limit}`) and nothing is queued.
- Before the walk, every finished export of the caller that the build's own
  gates no longer let them read (revoked grant, changed record scope, past
  end + TTL) is RECLAIMED (deleted): nobody can be served it, and it would
  otherwise hold quota bytes the owner cannot list (amended 2026-09-24, review).

**`build_export_file`** — background only, lane `export_file` (its own: a
file build never queues behind another user's walk on `export`), owner-only.

Request `options`: `{section_tipo, job_id (artifact id), format, origin, show_tipo_in_label, media_quality?, media_qualities?, background_running: true}`.

- `format` ∈ `csv | tsv | html | xlsx | ods | ndjson | media_zip`.
- `origin` is the browser origin, used to write absolute media links; anything
  that is not an `http(s)://host[:port]` origin becomes `''`.
- `media_qualities` is `{<media model>: <quality>}`, and `media_quality` is one
  quality for every model. Both are checked against the model's quality ladder
  (`media.invalid_quality`, or `request.invalid_options` for a key that is not a
  media model). Neither given = each model's default quality.
- Terminal frame `data` = `{ok: true, data: {job_id, format, basename, url, bytes, rows}}`,
  where `url` is the download route below. For `media_zip`, `rows` = files archived.
- THE FILE NAME IS A FUNCTION OF EVERY OPTION THAT CHANGES THE BYTES
  (`writers/index.ts artifactFileVariant`, derived inside the one build door, never
  by the caller): csv/tsv/html/xlsx/ods are ALWAYS `export_<12 hex>.<ext>` (a hash
  of `{show_tipo_in_label, origin}`); `media_zip` is `media.zip` without a quality
  choice, `media_<slug+hash>.zip` with one; `ndjson` (option-independent) is
  `export.ndjson`. Two option sets therefore never share a file or a URL, and the
  same options name the same file. (Amended 2026-09-24, review: the labelled
  formats were `export.<ext>` for every option set, so a rebuild with other options
  replaced the file behind a URL the client had cached for the first set.)
- The file is built from an ENDED spool. A job that has not ended is refused
  with `export.artifact_not_ready`.
- `media_zip` archives a file only when it is the AUTHORIZED record's own file
  (amended 2026-09-24, review, S1). The record's stored `files_info` path is
  used as a name only. It must sit in the quality folder that the media path
  grammar derives for that (component, section, id) at the chosen quality, and
  its real path must be in that folder's real path. Its name must not carry a
  web-server-denied suffix (`protection.ts MEDIA_WORKING_FILE_EXTENSIONS`, the
  active-document list), and must not be another media record's canonical file
  name. Before this, a user with write access to a media component could store
  a path to any file under the media root: another user's import CSV, or the
  `.publication` marker store. The web server denies both to everyone, and they
  reached the archive. A refused path is listed in `info.txt` with reason
  `invalid_path`, whose meaning widens from "leaves the media root" to "is not
  the record's own file at that quality". Legacy files renamed through
  `properties.image_id` in the record's folder are still archived. Gate:
  `tool_export_media_zip_native` O.
- Admission (amended 2026-09-24, review): one user may hold at most
  min(`DEDALO_EXPORT_JOBS_PER_USER`, every slot of the shared `export_file`
  lane but one) running file builds (`export_job.ts exportFileLaneShare`:
  `max(1, budget − 1)`, so 1 with the default budget 2). Over it the submit
  fails with `export.too_many_jobs` (`details: {limit}` = that share) and
  nothing is queued — so one user's deadline-free media ZIPs can never fill
  the lane every other user's CSV waits on. The user's running WALKS
  (`build_export_artifact`) are NOT counted here (amended again 2026-09-24,
  review: two exports still running refused every download of an export that
  had already ended); a walk's own admission still counts both kinds. The
  tool queues a second download click behind the file being prepared (one
  build at a time per view) instead of submitting it to be refused. It reclaims unreadable exports too (as `build_export_artifact`),
  after its own job passed the owned-job door.
- A file is renamed into place and recorded in the manifest as ONE step: if the
  manifest write fails after the rename, the final file is removed again, so
  no unrecorded (never served, still quota-counted) file stays on disk.
- BUILT ONCE (amended 2026-09-24, review: every request rebuilt the file — a
  reopened tool re-walked a multi-GB media ZIP): a file already committed
  under the same name (and still on disk) is answered as recorded — same
  `basename`, `url`, `bytes`, `rows` — without walking the spool again. The
  ended spool never changes and the name covers every option that changes the
  bytes, so it IS the same file. Building a file never extends the export's
  lifetime (end + TTL).

**`get_export_preview`** — foreground, owner-only.

Request `options`: `{section_tipo, job_id, page, page_size?, col_page?}`. `page` is
0-based and counted in RECORDS (a record's breakdown sub-rows never split).
`page_size` is clamped on the server to 1..200 (default
`DEDALO_EXPORT_PREVIEW_PAGE_SIZE`, 100). `col_page` is the 0-based COLUMN
window (default 0; clamped to the last window).

Answer `data`:
`{job_id, status, cols, col_page, col_page_size, first_col, total_cols, col_models, media_models, final_order, rows, elided, page, page_size, first_record, records, has_more, total_records, written_records}`
(`media_models`: addendum "related media" below).

- `cols` are the spool's `col` lines of ONE column window of the display order:
  at most `col_page_size` (= `PREVIEW_COLUMN_BUDGET`, 100) columns, starting at
  display index `first_col`, of `total_cols`. Every served row carries only
  that window's cells, so a page is bounded in cells (rows budget × column
  budget) however wide the export (`breakdown: 'columns'` can reach thousands
  of columns). `col_models` = the distinct leaf models of EVERY column. (The
  client offered the media download from it until the "related media"
  addendum below; it now reads `media_models`.) The downloads carry every column.
  (Amended 2026-09-24, review: a page served every column, so a 4,000-column
  export drew millions of cells per page and re-sent every descriptor on each
  refresh.)
- `rows` are the spool's `row` lines, `{t:'row', rec, sub, c}` (`c` cut to the window).
- A page is `page_size` RECORDS and at most `PREVIEW_ROW_BUDGET` (1000) ROWS
  (amended 2026-09-24, review: a breakdown record with thousands of sub-rows
  made one page thousands of `<tr>`). Every record keeps its first row; the
  remaining budget goes to sub-rows in record order; the sub-rows that do not
  fit are not served and are counted in `elided: [{rec, rows, after}]` (always
  a record's LAST rows; empty when the page is whole). `after` is the index in
  `rows` of the record's last SERVED row; the client draws one marker row per
  elided record right after `rows[after]`. The marker is placed by POSITION,
  never by `rec` (amended 2026-09-24, review: `rec` is the bare section_id, so
  an export of several sections repeats it on one page and a rec-keyed marker
  landed after every record sharing the id); `rec` stays informational. The
  downloads carry every row.
- `final_order` is false while the job runs (the live-insert order known so
  far) and true once the `end` order is known.
- A cancelled, failed or interrupted export answers an empty page.
- While the job runs, a page reads the grid only up to the bytes COMMITTED at
  the last checkpoint (amended 2026-09-24, review: a read racing a 256 KiB
  flush could end inside a record and serve it cut short, with no elision
  marker). So a running page shows exactly `written_records` records, never a
  record still being written; `elided` is counted from the rows the page
  itself walked.

**`list_export_jobs`** — foreground, owner-only.

Request `options`: `{section_tipo}`. Answer `data`: `{jobs: [ExportJobSummary], pending: [PendingExportJob]}`,
each newest first. Only the caller's jobs for that section that it can still read are listed.

    PendingExportJob = { background_job_id, submitted_at }   // ms epoch

`pending` (amended 2026-09-24, review) = the caller's OWN submitted
`build_export_artifact` lane jobs of that section that no manifest names yet —
a walk queued behind the lane (budget 1, no deadline) has no manifest until its
handler starts. The reopened client follows the newest one as the current
export (its lane job, Stop armed from `<background_job_id>.json`) instead of
painting an older manifest; a job stream that drops while the job is still
pending is re-followed, never painted "failed". Before: a queued export was
invisible to reconnect (an older export shown as current, Stop never armed,
the job still holding a per-user slot). Gates: `tool_export_job_native`
(pending), `test_tool_export.js` (reopen while queued; stream drop while queued).

    ExportJobSummary = {
      job_id, status, section_tipo, created_at, updated_at, ended_at,
      total, records, rows, data_format, breakdown,
      files: [{format, basename, bytes, rows, created_at, url}],
      background_job_id,          // the lane job that wrote it, THIS boot only; else null
      narrowed,                   // boolean: the ACL frontier narrowed the walk (see build_export_artifact)
      error: null | {code, label_key?, message?, retryable?, details?}
    }

`background_job_id` is boot-scoped (amended 2026-09-24, review): served only
when the manifest's `owner_boot` is the serving process, else `null`; the same
rule decides which manifests hide a lane job from `pending`
(`artifact_store.ts thisBootLaneJobId`). Lane ids are `<kind>_<pid>_<counter>`
and repeat across restarts (bun is PID 1 in the container), so before this a
new queued walk sharing an id with a kept older export was hidden from
`pending`, and a Stop/refusal before its first checkpoint made the client show
the OLD export as this run's result. Gates: `tool_export_job_native` G
(foreign-boot summary serves null), K2 (foreign-boot manifest does not hide a
pending job).

The client renders `narrowed` on the ended export's status line as the
`error_perm_out_of_scope` label — one notice, no coordinates (amended
2026-09-24, review).

`status` ∈ `running | ended | failed | cancelled | interrupted`. An aborted
walk is recorded by WHY the lane job's signal fired (`media/jobs.ts
jobAbortInfo`, the abort reason the manager sets): the user's stop →
`cancelled`; the lane deadline → `failed` with `export.deadline_exceeded`; a
graceful shutdown (`interruptLive`) → `interrupted`, no error (amended
2026-09-24, review: all three were `cancelled`). A `running`
manifest is reported `interrupted` exactly when the ONE liveness rule the sweep
and `delete_export_job` act on (`artifact_store.ts runningJobLive`, served through
`effectiveJobStatus` with the store's TTL) says its writer is gone: this boot's
lane job no longer running; another boot's owner pid dead or reused (ours); or
another boot's heartbeat older than max(TTL, 1 h). Another boot whose process is
alive and heartbeating stays `running` (and `delete_export_job` answers
`export.artifact_busy`). (Amended 2026-09-24, review: every other boot's job was
reported `interrupted`, so the client offered Delete on an export the server
refused as busy.)
`error` is read from the registry when the list is served: the manifest stores
only `{code, details?}`, and the details are filtered AGAIN against the current
`details_keys`. A code the registry no longer knows answers `{code}` only.

**`delete_export_job`** — foreground, owner-only.

Request `options`: `{section_tipo, job_id}`. Answer `data`:
`{job_id, deleted: true, freed_bytes}` — the export directory is removed with
everything in it (spool, manifest, every built file), and `freed_bytes` (what it
held) is returned to the user's quota at once. From then on the export is absent
from `list_export_jobs` and its download URLs answer the route's 404.

- It opens the job through the OWNER'S DISCARD door
  (`export_job.ts resolveOwnedJobToDiscard`): the caller's own directory, a
  manifest naming the caller, the gated section — and nothing more. Any refusal
  there is `export.artifact_not_found`, and nothing is removed. Deliberately
  NOT the read door (amended 2026-09-24, review): an export its owner may no
  longer READ (revoked grant, changed record scope, expired) is still theirs to
  discard — deleting discloses nothing and frees their quota; refusing it left
  the owner quota-locked by exports they could neither see nor remove.
- RUNNING-JOB POLICY: it REFUSES, it never stops. A running export whose
  process is alive, or an export a live file build holds a lease on, answers
  `export.artifact_busy` (409, retryable) and nothing is removed. The client
  stops a running export first (`stop_process`). The decision is taken under the
  job's manifest lock with the TTL sweep's own liveness rules, so an export
  left `running` by a dead process (reported `interrupted`) is deletable.

### Ownership and the "not found" policy of the actions

A job lives under `<export root>/<userId>/<jobId>/`. Every read of an existing
export (preview, file build, listing) looks only in the CALLER's own directory
and requires these (delete asks only the first two and the section — see
`delete_export_job`):

- the manifest names the same user;
- the job belongs to the `section_tipo` the request was gated on;
- the build's own read gates still pass, asked again now over the recorded
  options (`access.ts exportStillReadable`: section grant,
  `assertExportSqoSections`, and `assertExportDeclarationReadable` = Gate A +
  Gate B + the `dedalo_raw` frames);
- the owner's RECORD SCOPE is still the one the walk ran under (amended
  2026-09-24, review: the grants alone kept a user removed from a project
  reading that project's records from the spool). The manifest records
  `record_scope` at build — `access.ts exportRecordScope`, an opaque
  fingerprint of exactly what the walk's selection applies: the global-admin
  flag; for everyone else the dd170 projects AND the dd478 per-user record
  allow-list (amended 2026-09-24, review: narrowing a user's dd478 allow-list
  left their finished exports of the wider selection open; a global admin's
  walk selects with no principal, so dd478 is not part of an admin's scope —
  the re-check is never stricter than the build) — and any different answer
  now closes the export at every door;
- every RUNTIME frontier grant the walk read under is still held (amended
  2026-09-24, review: a stored locator may land in a section the declared ddo
  path never names — a multi-target portal, thesaurus terms across several
  TLD sections — and the build's frontier authorized that (section,
  component) pair on the runtime identity; revoking it left the declared
  gates green and the file served). The manifest records every pair the
  frontier ALLOWED (`frontier_grants`, server-side, written at each
  checkpoint and at the end) and each is re-asked through the build's own
  predicate (`frontier_scope.ts frontierComponentAllowed`); a manifest with no
  list is bound to none (fail closed). Global admins are exempt, as their walk
  carries no frontier;
- the export has not passed its lifetime ceiling: end + TTL
  (`artifact_store.ts exportExpired`). A HARD ceiling (amended 2026-09-24,
  review): a file built later no longer extends it, so re-running a build can
  no longer keep a snapshot alive indefinitely; the sweep deletes by the same
  verdict.

A single record whose own project filing changed after the walk is NOT
re-checked: the export is a snapshot of what its owner could read when it ran,
kept at most until end + TTL.

Absent, expired, another user's (a global admin's included) and revoked access
all get the same answer: `export.artifact_not_found` (404). No answer reveals
whether a job exists.

### The download route — `GET /dedalo/export/artifact/<jobId>/<basename>`

Handled by `tools/tool_export/server/download.ts` (`serveExportArtifact`),
registered as the tool's `httpRoutes` entry and dispatched by the router
(`src/server.ts` → `loader.ts toolHttpRouteFor`, after every engine route and
before the client static tree).

- The path is taken RAW, never percent-decoded. There must be exactly two
  segments; `jobId` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, and
  `basename` is on the closed allowlist
  `export[_<a-z0-9 ≤32>].(csv|tsv|html|xlsx|ods|ndjson)` or `media[_<a-z0-9 ≤32>].zip`.
  The spool files, the manifest and temp files can never be served.
- The route requires: a session cookie resolved on this request, and NOT refused
  by maintenance (the dispatcher's Gate 2b: while `maintenance_mode` is on, every
  non-root session is unauthenticated — `session_gate.ts refusedUnderMaintenance`,
  the one rule both use; amended 2026-09-24, review — the route skipped it, so a
  non-root owner kept downloading while every tool_export action door refused
  `auth.maintenance`); the TOOL gate
  the dispatcher gives every action door (tool_export ACTIVE in dd1324 and
  AUTHORIZED for the user, `access.ts exportToolAuthorized` = registry
  `getUserTools`; amended 2026-09-24, review — the route skipped it, so a user
  whose tool was removed kept downloading until TTL); a manifest
  under the caller's own directory that names the caller and the job; status
  `ended`; a basename recorded in `manifest.files`; `exportStillReadable`
  passing now; and `resolveArtifactFile` succeeding (confinement check, regular
  file, no symlink).
- **404 policy:** every refusal (no session, not yours, unknown, expired, not
  ended, not built, disallowed name, traversal, access or the tool revoked since the build,
  maintenance on for a non-root session)
  answers the same 404 `resource.not_found` envelope. The route never answers
  403, so a probe cannot tell "not yours" from "does not exist".
- 200 headers: the shared security headers,
  `Content-Security-Policy: default-src 'none'; sandbox`, the format's
  `Content-Type`,
  `Content-Disposition: attachment; filename="dedalo_export_<section>_<date>…"`
  (plus an RFC 5987 `filename*` when the name is not plain ASCII),
  `Content-Length`, and `Cache-Control: no-store`. The body is streamed from
  disk.

### New error codes (`src/core/errors/registry.ts`, all `disclosure: operator`)

| code | status | retryable | details_keys | when |
|---|---|---|---|---|
| `export.cancelled` | 409 | no | — | the user stopped the lane job (stop_process); the partial spool is deleted |
| `export.deadline_exceeded` | 429 | no | `limit_s` | the walk ran past `DEDALO_JOB_DEADLINE_EXPORT_S` and was aborted; the partial spool is deleted (amended 2026-09-24, review: a deadline was recorded as the user's Stop) |
| `export.format_limit` | 400 | no | `format`, `limit` | XLSX/ODS over 16,384 columns; an XLSX cell over 32,767 characters |
| `export.artifact_not_ready` | 409 | yes | — | a file was requested from an export that has not ended |
| `export.artifact_quota` | 429 | no | `quota_bytes` | the user's files would exceed `DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES`. A media ZIP's refused-candidate log (an unlinked scratch file in the job directory) counts too, and so does the `export.storage_low` floor: a build whose refusals alone outgrow the budget stops while the log grows (amended 2026-09-24, review: the log was unmetered, so it could fill the volume before either code fired; gate `tool_export_media_zip_native` N) |
| `export.artifact_count` | 429 | no | `max_exports` | the user already keeps `DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS` exports (default 100, `0` = off; checked at job creation, nothing created). Amended 2026-09-24, review: the byte quota alone let one user keep ~10^5 tiny exports, and every list/reclaim reads each |
| `export.storage_low` | 503 | yes | — | the export volume would fall below `DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES` free (default 1 GiB, `0` = off) — installation-wide, whatever the users' quotas; refused at every writing door and enforced by the writers' meter (a running export or file build stops, its partial spool/temp deleted). Amended 2026-09-24, review: N users could hold N quotas on the private volume the session store shares |
| `export.too_many_jobs` | 429 | yes | `limit` | per-user admission over both export lanes (submit refused, nothing queued) |
| `export.artifact_not_found` | 404 | no | — | absent / expired / not yours / revoked (one answer) |
| `export.artifact_busy` | 409 | yes | — | `delete_export_job` on an export that is running or has a live file build |
| `export.store_unavailable` | 503 | no | — | the export root is unusable: it overlaps a tree served without an owner check (the media root, the client tree, or a tool root — the engine serves `/dedalo/tools/` unauthenticated, `.json`/`.html` included; amended 2026-09-24, review — inside, equal or above, symlinks followed; refused on every writing door and at the boot sweep), or it is NOT OWNED — non-empty and without the `.dedalo_export_artifacts` ownership marker the store plants in an empty root (amended 2026-09-24, review: a foreign `<digits>/<name>` tree was aged and deleted by the sweep; now nothing is written or deleted), or, under the test seam, it carries no test marker |

Each code has its `error_export_*` label in `src/core/labels/master.json`.

### The job status frame gains an optional `error` (every lane job, not just exports)

`JobStatusFrame` now carries `error?: ApiErrorBody` on a FAILED terminal
frame, on the two push wires that serve the frame itself: `get_job_events` and
`get_process_status`. It is the envelope v2 error body, built without the
`debug` block because the record is persisted to the pfile. This is the
`{is_running: false, error}` stream-frame contract of `engineering/ERRORS_SPEC.md`.

- An untyped throw gets the `internal.*` body.
- A STOPPED job gets no `error`, even when the abort surfaced typed (a stopped
  export throws `export.cancelled`): `error` is the client's failure signal
  (`normalize_stream_error`), and a user's own stop is not a failure.
- The legacy media poll `get_job_status` does NOT carry it: its envelope lifts a
  closed key list (`pid`, `pfile`, `is_running`, `errors`, `total_time`) beside
  an `ok:true` body, where an `error` key would contradict the envelope. No
  client polls it any more (`job_follow.js` follows `get_job_events`).

The `errors[]` lines also change: a typed throw now contributes its wire
sentence instead of its log-only `.message`. The background executor's record
follows the same rule: `get_background_job_status` and `get_background_jobs`
serve `error` as a plain STRING (not an `ApiErrorBody`), and for a typed throw
that string is now its wire sentence, never the log-only `.message` (which may
name a path); the executor's log line keeps the full message. An UNTYPED throw
from a background tool handler follows the same rule (amended 2026-09-24,
review): it is converted first, so `error`, the frame's `errors[]` line and the
persisted pfile carry the `internal.unexpected` wire sentence, never the raw
text. Before, a raw fs error ("ENOENT: …, open '/srv/…/media/…'") reached all
three with the server's absolute path. A tool whose client showed a
background job's raw `error` text (tool_transcription's `job.error` cause) now
shows the registry sentence for an untyped failure; a failure worth naming
must be thrown typed. The raw-text arm of the lane record (`recordFailure`,
error_taxonomy A6) stays only for the AV lane workers, which do not run
through the background executor. Gate: `tools_background` (the untyped
throw's path is absent from `job.error`, the listed row, the frame and the
pfile, and present in both log lines). The `get_background_jobs` rows AND
`get_background_job_status` gain a status value, `stopped`, for a job stopped
before its handler ran (while it was still queued); its `error` string is
`stopped before it started (was queued)`. Before, such a record stayed
`running` until the process died.

A lane job stopped WHILE QUEUED now ends at once (it used to wait in the queue
until the jobs ahead of it finished). Its terminal frame on `get_job_events` /
`get_process_status` is `{is_running: false, errors: [], data: null}` with no
`error` — the same frame the pre-lane wire served. The "stopped before it
started" sentence goes to the operator log only (amended 2026-09-24, review: a
draft put it in `errors[]`, which `update_code_phases.js resolve_final_frame`
reads as a FAILED update). Gate: `tools_background` (the queued-stop leg pins
the frame and that `resolve_final_frame` decides nothing from it).

### Registered labels

`tools/tool_export/register.json` gains 22 label names for the new UI:
`delete_export`, `delete_export_confirm`, `download_media`, `download_ndjson`,
`export_deleted`, `export_ended`, `export_failed`, `export_interrupted`,
`export_running`, `export_starting`, `file_failed`, `first_page`, `last_page`,
`media`, `no_columns_selected`, `preparing_file`, `print_current_page_note`,
`quality_for`, `records`, `records_per_page`, `stop`, `waiting_file`. They reach the served tool
context only after the tools are registered again. The additive filter of
`tool_element_context_differential` already covers them (its `ADDED` set grew
by these names; see the 2026-09-24 addendum of
`WC-2026-08-23-tool-export-register-labels`).

### Amended 2026-09-24 (review hardening batch) — wire-visible outcomes

Each is a TS-native surface (no parity fixture covers it); the gate is named.

- **`get_export_preview` cells are bounded in characters.** A served cell is cut
  to `PREVIEW_CELL_MAX_CHARS` (1,000) with a trailing `…`; an oversized
  non-string cell is served as its `String()` (what the client renders), cut; a
  media cell (`cell_type` img/av) is cut at a `' | '` URL boundary. Sub-rows past
  `PREVIEW_PAGE_CHAR_BUDGET` are ELIDED through the existing `elided` entries
  (every record keeps its first row). Downloads are unchanged — full values.
  Once `status` is `ended`, `final_order` comes from the manifest's recorded
  `columns`. Gates: `tool_export_job_native` (wire helpers),
  `tool_export_artifact_store_native` C.
- **`build_export_file` / `build_export_artifact` run on the principal as of the
  handler's START** (re-resolved; the section READ grant re-asked):
  a user who lost the section grant while the job queued gets `perm.denied`
  (previously `export.artifact_not_found` from the owned-job door for a file
  build), and a demoted global admin gets the scoped walk. Gate:
  `tool_export_job_native` A3.
- **`media_zip` is rebuilt on every `build_export_file`** (never "built once"): its
  bytes depend on live media state. The same basename is replaced. Gate:
  `tool_export_media_zip_native`.
- **At most `MAX_FILES_PER_FORMAT` (4) built files per format per export.** A
  fifth commit evicts that format's oldest: it leaves `list_export_jobs`
  `files[]` and its URL answers the route's 404. Gate:
  `tool_export_artifact_store_native` F.
- **The media ZIP lists a file name no ZIP entry can carry as is** (a drive-like
  prefix, a backslash) as `invalid_path` in `info.txt`, instead of failing the
  whole build with `internal.unexpected`. Gate: `tool_export_media_zip_native` P.
- **The HTML download:** a protocol-relative URL (`//host`, `\\host`) is emitted as
  text, never as `src`/`href`; the file's CSP is `img-src <captured origin> data:`
  (was `img-src * data:`). Gate: `tool_export_delimited_html_writers_native` C.
- **`get_background_jobs` / `get_background_job_status`: a user's Stop of a
  RUNNING tool job reports `status: 'stopped'`** (was `'error'`), matching the
  lane frame; it no longer counts in `/api/v1/counters` `background_jobs.error`.
  `'stopped'` already existed on this wire (a job stopped while queued). Gate:
  `tools_background`.
- **Byte-neutral:** `export.ndjson` is the ended spool hard-linked into place
  (same bytes; counted once by the quota); `request.json` holds the recorded
  options beside `manifest.json` (server-side files, never served); an export
  root claimed by another installation answers `export.store_unavailable` at
  every door. Gates: `tool_export_artifact_store_native` C2, E, F.

## Reason

A heritage export is the whole filtered selection, which can be hundreds of
thousands of records × tens of columns. Building it in the browser meant two
things: the tab's memory limited the size of an export, and every download
depended on what had been rendered. Now the server writes the export once into
a spool and builds each format from the spool in a single streaming pass, so
no row or cell is held beyond one batch: what grows with the selection is only
its id list (about a hundred bytes per record, the walk's snapshot) and, for a media
ZIP, the archived files' directory (`engineering/PRODUCTION.md`). The browser holds one page
and a link. A link to a file on disk is also the only way to hand over a
multi-GB XLSX or media ZIP without a Blob.

## Gate reconciliation

No parity fixture covers the new actions, the route or the frame key (they are
TS-native surfaces), so nothing needs a re-harvest. `get_export_grid` is
unchanged apart from the two byte changes the Decision line names (external
cell lang, distinct `unresolved`), and its parity replays are untouched. Native gates:
`tool_export_job_native`, `export_artifact_download_native`,
`tool_export_artifact_store_native`, `export_open_grid_native`,
`export_run_bounds_identity_native`, `tool_export_spreadsheet_native`,
`tool_export_delimited_html_writers_native`, `tool_export_media_zip_native`,
`tool_export_cells_native`, `tools_background`,
`export_artifacts_backup_exclusion_native`, `run_created_records_native` (the
client runner's post-run sweep of the records a run created), and the client
suite `test_tool_export.js`. The ZIP bytes come from the engine's one encoder
(`src/core/files/zip.ts`, gated by `zip_stream_native` and
`zip_encoder_census_tripwire`); tool_export reaches the export engine only
through `src/diffusion/api/export.ts` (`boundary_seam_tripwire` scans tools/).

The files' TEXT is gated against the LIVE client functions the preview still
runs (`flat_table.js` `get_column_label`, `cell_to_text`, `_build_cell`,
`resolve_media_url`), including the IRI rule: only an `http(s)` first IRI
becomes a link, in the preview and in the HTML download alike. The CSV/TSV
GRAMMAR the browser used to write (the deleted `to_delimited` + BOM) is frozen
verbatim inside `tool_export_delimited_html_writers_native` as its byte oracle,
because its client source no longer exists.

## Addendum 2026-09-24 — external sources: an export is never silently incomplete; batched remote rows; `rerun_of`

A `component_external` cell (Zenon) has no stored value: the export reads the
remote record. When the source could not answer (down, circuit open, timeout,
disabled, misconfigured, values cut), the cell came out EMPTY and the only trace
was the model name in `unresolved` — the files looked complete. Now:

- **`'end'` line gains `external_degraded`, ONLY when some external cell
  degraded** (`src/diffusion/export/external_prefetch.ts`
  `ExportExternalDegradation`):
  `{incomplete, retryable, cells, records, missing_cells, missing_records, counts: [{service, state, cells}], sample: [{section_tipo, section_id, component_tipo, remote_section_tipo, remote_id, service, state}], sample_limit}`.
  `missing_cells` / `missing_records` (addendum (c) below) count only the cells
  whose value is NOT in the files (every incomplete state but `truncated`).
  `state` ∈ `unavailable | timeout | circuit_open | disabled | misconfigured |
  truncated` (incomplete) or `stale` (recorded; the value is there, from the
  last good copy). `not_found` is an answer and is not recorded; a foreign
  target (the column does not apply) neither. `cells` counts distinct
  (exported record, component, remote id); `counts` is exact and bounded by
  services × states; `sample` holds at most `sample_limit` (20) entries.
  - Where it shows: the `get_export_grid` NDJSON stream's `end` line and the
    buffered `data.end`; the spool, so the `export.ndjson` download carries it.
  - **Byte-identity:** a clean export (and one whose remote records answered
    `not_found`) emits no key — its stream, spool and NDJSON file are
    byte-identical to before. No envelope notice was added.
- **Manifest / wire of the tool:** the manifest records `external_degraded` at
  every checkpoint (LIVE while running) and at the end; it is served as
  `external_degraded` (null when nothing degraded) on the `build_export_artifact`
  terminal frame `data`, every `list_export_jobs` `ExportJobSummary`, and the
  `get_export_preview` answer. A manifest written before this change has no
  key and is served `null`. Owner-only like everything on these actions: the
  sample names the owner's own exported records and the remote ids they
  reference.
- **In-band marker in the tabular files — deliberately NONE.** CSV/TSV/XLSX/ODS
  get no note row or extra sheet: every row of those files is read as a record
  by the consumers they exist for (spreadsheets, scripts, a re-import), so a
  marker row would be imported as data — a worse corruption than the one being
  reported. HTML stays a table of the records for the same reason (it has no
  server-side localized prose to carry). The warning lives where the user
  decides: the tool's status line, a note under the download buttons
  (`export_file_incomplete`), and the NDJSON `end` line for machine consumers.
- **`build_export_artifact` accepts `options.rerun_of`** (an artifact id): the
  build runs the RECORDED options of that export (opened through the owner's
  read door — the caller's own, of the gated section, still readable; else
  `export.artifact_not_found`), then every gate of a fresh build. The client's
  "Run the export again" button (shown for an ended, incomplete, retryable
  export) sends only `{section_tipo, rerun_of}`.
- **Batched remote rows (byte-neutral):** before each hydrate batch the walk
  fetches the batch's external targets in one bounded fan-out and serves the
  cells from it; the request count drops to one per distinct remote record
  (the union of the predicted fields), the values do not change.
- **Labels:** `register.json` gains `export_rerun`, `export_file_incomplete`,
  `export_external_incomplete`, `export_external_rerun_advice`,
  `export_external_admin_advice`, `export_external_stale`, and (addendum (c))
  `export_external_truncated` (7 langs each; `{cells}` `{records}` `{services}`
  are filled by the client).
- **Addendum (c), same day — the status line says each kind for what it is.**
  `external_degraded` gains `missing_cells` / `missing_records`. The status line
  counts as "could not be read" ONLY the missing cells (with their records), with
  the re-run / administrator advice; `truncated` cells (values cut by the
  export's size limits — partly IN the files) get their own
  `export_external_truncated` sentence and no advice (neither a re-run nor an
  administrator changes a size limit); `stale` cells keep the softer note. Before
  it, 1 unavailable + 300 stale cells read "301 values could not be read", and a
  truncated-only export told the user to contact the administrator. A manifest
  written before (c) has no `missing_*` keys: the client sums the missing states
  from `counts` and falls back to `records`.
- **Addendum (c) — the prefetch obeys the export frontier and the Stop.** The
  batch prefetch applies the walk's own crossing answer before following a hop
  or asking for a relation-leaf target (no remote id behind a refused crossing
  reaches the service), starts its remote records a few at a time under the
  breaker's current verdict, and passes the export's Stop signal
  (engineering/EXTERNAL_SPEC.md §3 addendum (b) rules 4–5). Byte-neutral for
  every export the frontier allows.

Gates: `test/unit/export_external_prefetch_degradation_native.test.ts` (P, D, F, J),
client suite `test_tool_export.js` ("an export an EXTERNAL source left
INCOMPLETE says so…"). No parity fixture covers these keys; no re-harvest.

## Addendum 2026-09-24 — related media: the media ZIP archives what the export READ, at any depth

Measured on real spools: a portal column whose targets hold images was never in
the media ZIP. The writer and the client identified media columns by the
column's OWN model, and a portal column's model is `component_portal` — in
value format its cell is text mixing the image URLs with the other children
(`url | name, url`), in dedalo_raw it is the portal's locators, in grid_value
with a bare portal it is compact text. The thumbnails rendered (the client reads
`cell_type`) while the ZIP button stayed disabled (it read `col_models`). A
grid_value portal → image column worked only through the file-name grammar, so
a `properties.image_id` rename was refused `unidentified`.

- **The walk records what it reads** (`src/diffusion/export/row_media.ts`,
  `relation_list.ts CellValueResolveOptions.onMediaRead`, `atoms.ts`,
  `grid.ts ExportGridRunOptions.captureMedia`): every media component read on a
  record whose stored items name a file — a literal leaf, a portal's own-config
  child, a frame's, a nested relation's; for dedalo_raw, the SAME derivation
  from the stored locators (`collectRawMediaAddresses`). Invariant: the same ddo
  gives the same archive in value, grid_value and dedalo_raw.
- **Out of band — the wire does not change.** The addresses ride the record's
  first row line under a SYMBOL key: no serialization carries it, so the
  `get_export_grid` stream, the buffered envelope, the spool's `grid.ndjson` and
  the `export.ndjson` download are byte-identical. Only the background build
  (`runExportArtifact`) captures.
- **Spool-internal file `media.ndjson`** (`SPOOL_FILES.media`): one line per
  record that read media, `{rec, a: [[column, section_tipo, section_id,
  component_tipo], …]}`; created lazily, metered by the quota with the spool,
  deleted with it, never served. **Manifest `media_models`**: the distinct media
  models it names, sorted, at every checkpoint and at the end. Its PRESENCE marks
  a captured spool; absent on a manifest written before this addendum.
- **`get_export_preview` gains `media_models`** (sorted): every column's own
  media model plus the manifest's `media_models`. `col_models` keeps its
  meaning. The client's media download (`render_tool_export.js
  get_media_models_in_data`) — whether it is offered, and one quality selector
  per model — reads `media_models`.
- **`media_zip` coverage** (`writers/media_zip.ts`):
  - a DIRECT media column (top level, own model a media model) is read from its
    cells exactly as before — its archive and `info.txt` are unchanged, with or
    without the sidecar (gate R7);
  - every other address comes from `media.ndjson`. No URL text is parsed for
    it: a URL typed into a text field is never a candidate (gate R1 plants two
    forged URLs — another record's master, a path out of the root — and asserts
    neither reaches the archive). Each address is re-authorized as the OWNER —
    the model is a media model with a chosen quality, then
    `getRecordComponentPermission >= 1` on (section, component, record), then
    `principalCanAccessRecord` — the same checks as a cell candidate, and the
    only gate on those bytes (the walk crosses into relation targets asserting
    the record key only, never the image component's grant). Then EVERY item the
    record holds now for that component goes through the unchanged step 4 (target
    quality, own quality folder, denied names, realpath, regular file, dedupe).
  - `info.txt` names a sidecar refusal `section_tipo/section_id/component_tipo`
    (reasons `not_media`, `not_authorized`, `not_in_record` — the record holds no
    item for it now — plus the per-item ones).
  - New closed reason **`rerun_required`**: on a spool WITHOUT capture the old
    reading is kept (every media-model column from its cells), and every other
    column that may hold related media (an img/av cell, a path through a media
    component, a relation whose own config has a media child) is listed once —
    loud, never guessed from URL text.

Gates: `tool_export_media_zip_native` R1–R8 (a built `zzmz` host section with a
portal into test3 whose own config shows image + text + pdf; value, grid_value
default / rows / columns and dedalo_raw, bare and declared portal → image; a
target moved out of the owner's projects after the walk and the ungranted pdf
child refused `not_authorized`; the forged URLs; the uncaptured fallback; a
record emptied after the walk; the direct-export identity), mutation-verified;
client suite `test_tool_export.js` ("a PORTAL column whose targets hold images
offers the media ZIP from media_models…"). No parity fixture covers these
surfaces; no re-harvest.

### Amended 2026-09-24 (review) — one derivation, every format; the rerun notice reachable

Four defects found by review, each now gated:

- **grid_value kept only the media of NON-EMPTY atoms.** A target whose value
  is empty (only the `original` file exists yet, or the export base is unset)
  dropped its atom, and its media with it, while value still archived it. The
  walk now keeps the media of every dropped value (`atoms.ts
  ExportRun.droppedMedia`). Such media — and a value / dedalo_raw cell that
  shows nothing — is recorded with a **null column**: `media.ndjson` entries
  are `[column | null, section_tipo, section_id, component_tipo]`. The writer
  skips a sidecar address only when its column is a DIRECT media column (read
  from its cells); a null one has no cell to read, so a direct image column
  whose record holds only the master is archived in every format too.
- **dedalo_raw walked the relation's own config and ignored the declared
  path.** It now follows the DECLARED path (`resolveRecordAtoms`, the value
  format's own walk) and, at each leaf, mirrors `resolveCellValue`'s reads —
  the children come from the SAME helpers the value resolvers use
  (`relation_list.ts relationTargetChildren`, `dataframeFrameChildTipos`). A
  portal → text ddo reads no media; a portal → image ddo reads the image even
  when the portal's config does not show it. The raw frame columns
  (WC-2026-08-09) carry no capture: value has no frame column, and the frames
  the relation's config shows are read through the top column.
- **The raw media walk could fail an export.** Capture runs on every build
  (the spool is written once, before anyone asks for a media ZIP), and the walk
  threw `internal.invariant` past 12 hops — a self-referencing portal chain made
  a CSV build fail. The walk is now an explicit worklist that expands each
  (section, id, component) once: it ends on any finite record graph, with no
  depth ceiling. A field whose ontology can reach no media component reads no
  record for it.
- **`rerun_required` was unreachable from the tool.** An export built before
  capture whose related media sits behind a portal got `media_models: []`, so
  the button stayed disabled. **`get_export_preview` gains
  `media_rerun_required`** (boolean): true only for an ended export whose
  manifest has no `media_models` and that has a non-media column which may hold
  related media (the writer's own predicate, `legacyColumnMayHoldMedia`). The
  client enables the media ZIP when `media_models` is non-empty OR this is
  true; the modal then lists no quality, and the ZIP's `info.txt` lists those
  columns as `rerun_required`.

Gates: `tool_export_media_zip_native` R9 (master-only target: bare, declared and
direct, every format), R10 (declared path in raw: portal → text reads nothing,
a portal → image its config does not show is read), R11 (a 16-record
self-referencing chain builds in dedalo_raw / value / grid_value, CSV included),
R5/R6 (`media_rerun_required`), each mutation-verified; client suite
`test_tool_export.js` (the same "PORTAL column" case, third leg). No parity
fixture covers these surfaces; no re-harvest.

## Addendum 2026-11-09 — `frontier_grants` also holds the implicit children

The run now also asks the component key on each IMPLICIT child the fan-out reads; every pair it
ALLOWS joins `frontier_grants`, so a later revocation closes the finished export exactly as for a
leaf grant. See `WC-2026-11-09-export-frontier-fanout`.
