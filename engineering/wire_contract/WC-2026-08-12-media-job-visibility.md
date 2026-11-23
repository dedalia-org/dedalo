# WC-2026-08-12-media-job-visibility — background media work is DISCOVERABLE by record and by user, and a tier being built refuses a second build

- **Date:** 2026-08-12.
- **Surface:**
  - `src/core/media/jobs.ts` — `JobTarget` + `JobRecord.target`,
    `JobRecord.startedAtWall`, the live-by-target index, `jobsForRecord`,
    `jobsForUser`, `hasLiveJobForTarget`.
  - `src/core/api/activity.ts` — the NEW read-side projection (`ActivityRow`).
  - `src/core/api/handlers/dd_utils_api.ts` — two NEW actions,
    `get_record_jobs` and `get_activity`.
  - `src/diffusion/jobs/queue.ts` — `listActiveJobsForOwner` (a narrow reader).
  - `src/core/media/av_versions.ts` — target stamping, per-tier progress, and
    the duplicate-build refusal.
  - Client: `tools/tool_media_versions/js/**`,
    `client/dedalo/core/page/js/job_tray.js`,
    `client/dedalo/core/common/js/{job_follow,floating_dock}.js`,
    `tools/tool_upload/js/render_tool_upload.js`.
- **Gates:** `test/unit/media_job_target_tripwire.test.ts` (in the tripwire
  index), `test/unit/media_job_index_native.test.ts`,
  `test/unit/activity_aggregate_native.test.ts`,
  `test/unit/ffmpeg_progress_native.test.ts`.

## Why this is a wire entry at all

The frozen oracle has no opinion here: PHP had no way to ask "what background
work is running for this record?" — it tracked conversions in a `processes`
table the TS engine deliberately never reads (`jobs.ts` header). These are
TS-native additions, not divergences from a PHP answer. They are ledgered
because they add PUBLIC API surface and change a client-visible behaviour
(`build_version` can now be REFUSED), and the WC ledger is where the wire's
law lives.

## Addition 1 — `dd_utils_api::get_record_jobs`

Request: `{section_tipo, section_id}`. Response: `{result, jobs: ActivityRow[]}`.

**Authorized by RECORD read permission, not by job ownership.** This is the
deliberate part. `mayStreamJob` (`api/job_stream.ts`) still gates the job's
`data` payload to its owner or a global admin, and is UNCHANGED. The new
listing is a strictly narrower projection — `{source, job_id, label, record,
status, progress, started_at, owner_name, stream}` — and never carries `data`.

The reason it is record-scoped rather than owner-scoped is a correctness one,
not a convenience: a second operator who cannot see that the `404` tier is
already being built will click the gear and start a SECOND ffmpeg writing the
same output path. `jobs.ts` already draws exactly this line, describing an
unowned job as one whose frames "expose only operational shape".

`owner_name` is populated only for a job the reader does NOT own — a disabled
build button with no explanation reads as a broken panel.

## Addition 2 — `dd_utils_api::get_activity`

Request: `{}`. Response: `{result, jobs: ActivityRow[]}` — the caller's own
work across BOTH job systems:

- `mediaJobs.jobsForUser` (in-process: transcodes, imports, indexation, backup)
- `listActiveJobsForOwner` (the durable diffusion/publication queue)

**The diffusion half arrives by INVERSION, not by import.** `src/core/**` may
not import `src/diffusion` (three named seams, and an aggregator is not one), so
`core/api/activity.ts` owns a provider registry and startServer's diffusion boot
chain registers into it — the same pattern `registerOpsGauge` uses for the
diffusion gauge. An install without diffusion has no provider and the tray shows
media work only, which is that install's truth.

**Neither existing SSE wire changed.** Diffusion's `ProgressData` is pinned
byte-for-byte with golden fixtures and 16384-char padding; `JobStatusFrame` is
the media poll shape. `ActivityRow.stream` names which stream a row belongs to,
so the client subscribes to the ORIGINATING system for live frames. The
aggregation is a read-side projection that writes nothing and owns no state.

**LIVE PLUS RECENTLY FINISHED (`RECENT_TERMINAL_MS`, 5 min).** Not live-only.
A live-only answer forces the client to INTERPRET a row's disappearance, and the
first implementation guessed "done" — so a FAILED or CANCELLED publication was
painted green and faded, and one dropped request marked every running
publication successful. The window makes every outcome STATED; absence then
means only "older than the window" and is safe to drop silently. Terminal rows
carry `errors[]` so a red row can say why. Both halves obey the same window, so
the two sources never disagree about what "activity" means.

A row's `status` is the union vocabulary `queued|running|done|error|
interrupted|cancelled`. Diffusion's `completed→done` and `failed→error` mapping
is asserted TOTAL against the DB CHECK constraint by
`activity_aggregate_native.test.ts`: a new state added to `schema.ts` fails that
gate rather than rendering a failed publication as still running.

## Divergence 3 — `build_version` REFUSES a tier that is already being built

> **Superseded in part (2026-11-22):** the busy refusal is now
> `media.build_running` (409), and its scope is the whole av COMPONENT (one
> build per component, any tier; an upload included) — see
> `WC-2026-11-22-av-upload-build-running`. `AvBuildRefused` /
> `media.av_build_refused` keeps only the refusals that do not depend on another
> job. The text below is the 2026-08-12 shape.

`submitAvVersionBuild` now raises `AvBuildRefused` when a live job holds the
same target, so `tool_media_versions::build_version` answers
`{result:false, msg:"… is already being built for this record …"}` where it
previously accepted and started a duplicate encode.

**Client-visible behaviour change.** A workflow that relied on clicking the
gear again to force a rebuild now gets a refusal until the running job ends.
The panel additionally does not RENDER the gear for a live tier, so the
refusal is visible before the click.

**A job blocks every tier it writes, not just the one it is named after.** The
INGEST transcode builds the default quality AND the audio tier in a single job,
so `JobTarget.also_qualities` widens what it blocks while identity stays single
(`jobTargetKey` reads `quality` alone, so the index and the panel still agree on
one row per job). Without it the guard covered `404` and left `audio` open — a
click on the audio gear mid-ingest started a second ffmpeg writing the very file
the running job was about to produce, which is the original race surviving in
the one path that motivated this change.

Nothing was corrupt before this: outputs are written temp+rename, so the loser
of the race was discarded. The cost was two full transcodes of an hour-long
master to produce one file, with the winner decided by a race.

**The guard is in-memory, and that is a bounded promise.** Diffusion enforces
its equivalent with a partial unique index because its runners are separate
processes; media jobs run in-process under one manager, where the registry is
the arbiter. Under a SECOND server instance sharing `../private/processes` — a
deployment `isStaleLiveRecord` explicitly contemplates — each instance has its
own registry and the guard is NOT authoritative. Stated, not discovered: the
fix if it ever must be exact is to promote media jobs onto the durable queue,
which is recorded as the next piece of work in
`rewrite/specs/2026-08-12-media-job-visibility-design.md`.

## Behaviour change 4 — the AV job's progress is measured, not marked

`submitAvTranscode` reported `onProgress(70)` before the audio tier and `100`
at the end, so a 46-minute master sat at "70%" for most of an hour — a bar that
does not move reads as a wedged job. The encode now parses ffmpeg's
`-progress` stream (already injected for the idle-timeout watchdog, previously
discarded) and reports a real fraction: video 0-85%, audio 85-95%, persist to
100. The two-pass encode maps each pass to half of the video span, because
running the bar to full and snapping back to zero reads as a failed restart.

`progress` stays NULL when the source declares no duration. An indeterminate
bar is the honest rendering; a fabricated percentage is the frozen-70% lie in a
new costume.

## Non-goal, recorded

Media jobs remain NOT durable. A server restart mid-transcode still loses the
work. This change makes that loss VISIBLE (`interrupted` + a retry, instead of
a silently blank tier) but does not fix it.
