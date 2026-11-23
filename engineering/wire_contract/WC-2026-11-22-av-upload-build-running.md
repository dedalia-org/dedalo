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
- **Addendum 2026-11-22 (review M1/M2/L1–L5/L7, the lock's own soundness):**
  no wire shape changes; the guarantees behind the 409 tighten.
  (1) The lock is two files — the immutable `<key>.lock` (published with
  `link()`) and the holder's own `<key>.lock.<token>.hb` heartbeat (beat
  counter + holder, re-labelled to the job on adoption) — and every release /
  reclaim / stale-mutex clear is compare-and-swap (rename aside, verify token or
  inode/mtime, unlink or put back with `link()`), ENOENT-tolerant; a raw
  filesystem failure is typed `media.operation_failed`, never
  `internal.unexpected`. (2) Staleness: same machine (hostname + boot id + pid
  namespace) → dead pid (EPERM = alive) or this process's pid with a token no
  manager here holds; otherwise only a heartbeat SEEN unchanged for the bound on
  the reader's own clock — no cross-host time comparison. (3) A holder that
  finds its lock reclaimed aborts its job with the new abort cause `lock_lost`
  (status `error`, not `stopped`), and the atomic rename (`writeAtomically`) and
  the av files_info write-back re-check the hold immediately before acting
  (`job_scope.ts` `assertJobHold`) and refuse with `media.build_running`. (4) A
  component held past a deadline stays held until the worker settles; a
  shutdown releases held claims' locks too. Gate:
  `test/unit/media_component_lock_native.test.ts` (28).
- **Addendum 2026-11-22 (review M3, the record doors):** the three doors that
  move EVERY file of a record's av components outside the job manager now join
  the per-component hold. `deleteSectionRecord`, `deleteSectionData` (behind
  their row lock, before any write) and the Time Machine undelete
  `restoreSection` (before its transaction) take the RECORD AV HOLD
  (`av_component_claim.ts` `holdRecordAvComponents`): every av component the
  section declares or the media column names, for the untranslatable slot,
  every item lang, and every lang a lock file of any instance holds. A busy
  slot refuses the whole operation with 409 `media.build_running` — the row, its
  Time Machine rows and the disk untouched (the in-transaction throw rolls back).
  The hold is kept through the file sweep and released after it. The two file
  movers (`removeSectionMediaFiles`, `restoreDeletedSectionMediaFiles`) move an
  av identity only under a hold — the caller's, or their own for the pass — so
  the bulk revert's post-commit restore halves (no pre-write refusal possible: the
  row is already back) report a busy av component as that component's error and
  leave its files in `deleted/`, recoverable. The wipe holds every av component
  of the record, not only its wipe scope (a build on an av component a virtual
  section excludes refuses the wipe too — the safe side). Wire change: record
  delete, delete-data and section undelete can now answer 409
  `media.build_running`. Gate: `test/unit/av_record_media_hold_native.test.ts`
  (9).
- **Addendum 2026-11-22 (review L6, the panel):** the media activity row's
  `record` gains `lang` (`string | null` — the job target's lang, null for an
  untranslatable component; additive, media rows only: `activityRowFromMediaJob`).
  `tool_media_versions` matches it against the panel's own lang (the data lang
  when the component is translatable, else null — the server's media-context
  rule), so a per-lang av build greys only that lang's gears, as the server keys
  the hold. The panel greys the other tiers the moment THIS browser's av build
  is accepted (not on the next `get_record_jobs`) and releases them when that
  build fails. The gears are `role="button"` + `tabindex="0"` with Enter/Space
  activation; a greyed gear stays focusable and names its reason through
  `aria-describedby` (visually-hidden text) besides its title. Gates:
  `test/unit/activity_aggregate_native.test.ts` (lang projection), client suite
  `test_tool_media_versions` (+3).
- **Addendum 2026-11-22 (second review F1/F2/F6, the lock's own failure modes):**
  (F1) only ENOENT (absent) and an empty/malformed parse count as "no owner":
  any other read or stat error of a lock or heartbeat is BUSY — the acquire
  refuses (`media.build_running` at the doors, as for any held component) and
  logs `cannot be read (<errno>) — treated as BUSY, never reclaimed`; an
  unreadable live lock is never reclaimed. The holder's own-lock check retries a
  read error (3 reads) and then throws `media.operation_failed` (the job or the
  publication step refuses) — it never reports the hold LOST because a read
  failed; the heartbeat logs and beats again next tick. (F2) the CAS that
  releases, reclaims or clears a mutex never vacates the path to check it: it
  hard-links the path to a private peek name and reads the peek; an unexpected
  lock is left in place; an expected one is renamed aside and dropped only when
  the aside is the peek's inode (else put back) — a third instance can no longer
  take a lock the check emptied. (F6) a successful acquire sweeps the lock's
  ORPHANED siblings (`<lock>.*` — dead tokens' heartbeats, staged `.new`, temp,
  peek/aside names, a mutex without its lock) once that reader has seen each
  unchanged for the bound. HOST_ID on macOS gains `kern.bootsessionuuid`
  (`sysctl -n`, read once at load). No wire shape changes. Gate:
  `test/unit/media_component_lock_native.test.ts` (28 → 36): unreadable live
  lock with a beating heartbeat never reclaimed; unreadable lock logged busy;
  unstat-able malformed lock never 'gone'; transient own-read retried;
  persistent own-read typed + heartbeat beats; three parties (stale release vs
  a third acquirer); replacement between check and rename put back; orphan
  sweep (+ changing sibling kept, neighbour untouched, observations forgotten);
  HOST_ID boot part.
- **Addendum 2026-11-22 (second review F4/F3, whole components + claims that
  re-check):** (F4) the record hold (delete, wipe, Time Machine undelete) is no
  longer a set of per-lang slots listed at hold time: it takes WHOLE-COMPONENT
  claims (`JobTarget.scope: 'component_all'`, a claim only —
  `MediaJobManager.claimWholeComponents`; `claimTarget` and `submit` refuse it
  with `internal.invariant`). In memory a per-lang holder occupies an any-lang
  marker and probes the all-langs key, a whole claim occupies the all-langs key
  and probes the marker; on disk the whole claim takes the lock
  `section|id|component|*`, then lists the record's lock files ONCE and refuses
  if any lang lock of its components is live; a per-lang holder, after taking
  its lock, refuses if the all-langs lock is live (each side publishes before it
  looks: of two racing holders at least one sees the other). So a build or an
  upload in ANY lang — one the record never named included — is refused while a
  delete/restore holds the record, and vice versa. `liveComponentLangs` is
  gone. (F3) claims re-check their hold: `withAvComponentClaim` and the av
  ingest run their work under `mediaJobs.runUnderClaim` (the job-hold scope, so
  `writeAtomically` and the files_info write-back re-check the claim's lock on
  disk), a submit refuses to ADOPT a claim whose lock was reclaimed, and
  `AvRecordHold.require` re-checks an already-held component per identity the
  movers touch (a reclaimed hold stops the sweep: that component reported, its
  files left in place). All refusals are 409 `media.build_running`; no new wire
  shape (`scope` on an activity row stays `'component' | null`). Gates:
  `media_component_lock_native` (36 → 45), `av_record_media_hold_native`
  (9 → 11), `av_upload_build_guard_native` (+1: a claim reclaimed mid-ingest
  publishes no picture and its transcode is not started).
- **Addendum 2026-11-22 (second review F5, the bulk revert's undelete):** the
  bulk revert's cascade undelete (a unit's prelude, a standalone group) now
  HOLDS the av components of every record it would bring back BEFORE its
  transaction opens (`bulk_revert_records.ts` `holdCascadeAvComponents`, the
  record av hold), and the file half moves each record's files under that
  hold. A live build or upload refuses before any row comes back: a unit →
  its `failed` entry with `code: 'media.build_running'` (located at the unit,
  whose verdict passed) and the target it re-links counted
  `cascade_delete_not_reverted`; a standalone group → `{reason: 'failed'}`
  alone (refused before any record's verdict — SEC-16 rule unchanged). Wire
  vocabulary change: `inexact[].basis` gains `media_not_restored` — a record
  that came back but whose media files the mover could not all put back
  (`restoreSectionMedia` now returns the mover's errors; they were only
  logged). Gate: `test/unit/bulk_revert_undo_native.test.ts` (+5: standalone
  refused then back; re-linked refused then back; av files back under the same
  hold, hard and soft; a file that could not move reported).
- **Addendum 2026-11-22 (second review F7/F8, the panel; L4 gate):** a build
  gear asks the server once per press — a keydown auto-repeat (`e.repeat`) and
  any click or key press while that gear's request is still out are ignored
  (an in-flight flag cleared when the answer arrives). The gear's accessible
  NAME is its action (`aria-label` = the idle title) at all times; a greyed
  gear's reason is its DESCRIPTION only (`aria-describedby`), so it is not
  announced twice. Client-only, no wire change. Gates: client suite
  `test_tool_media_versions` (+3). The L4 deadline gate now fires the deadline
  through `MediaJobManager.deadlineNow(jobId)` (the deterministic tick, like
  `heartbeatNow`) instead of racing a 20 ms real timer.
- **Addendum 2026-11-23 (third review N2/N3/N4):** the macOS host identity reads
  `/usr/sbin/sysctl` by ABSOLUTE path (a launchd service's PATH,
  `/usr/bin:/bin`, has no `/usr/sbin`: the boot part silently fell back to the
  hostname alone); an empty answer on darwin is logged once at load. The hold
  check is now asked by EVERY publication door PRODUCTION §8.1 names:
  `conformHeader` asks it after the remux + faststart, right before its two
  renames; `moveToDeleted` asks it before it touches anything (every quality,
  version, orphan-twin and overlay move of `deleteAndResyncCore` goes through
  it). The peek-CAS residual (a path replaced between peek and rename is out of
  place for one rename → link; a fourth creator in that instant wins it, the
  replaced holder's own-lock check then reads LOST) is accepted and stated in
  the `component_lock.ts` header. No wire change. Gates:
  `media_component_lock_native` (+2: launchd-PATH identity; a stolen hold moves
  nothing to deleted/), `media_encode_integrity_native` (+1: a conform whose
  hold is lost after the relocation renames nothing).
- **Addendum 2026-11-23 (third review N1, the any-lang ↔ all-langs look):** both
  looks are now the SERVER's answer to a mutation, never a lookup or a listing
  (an NFS client with `lookupcache=all` could trust a cached negative dentry /
  listing on both sides and let a delete and a build proceed together). A
  per-lang holder, after publishing its lock, REGISTERS (hard link of its lock
  in `component_locks/<s|id|c>.langs/`, named lock + token) and PROBES the
  whole-component name with `link(own lock, s|id|c|*)` — EEXIST refuses (a dead
  whole lock is reclaimed first; another lang's in-flight probe is waited out
  2 ms × 3); linked, the probe is withdrawn by CAS. The whole holder, after
  publishing, `rmdir`s the share dir — removed/absent = vacant; ENOTEMPTY →
  registrations judged (pid / heartbeat rules, sighted under their own name),
  dead ones dropped, asked again; a live one refuses. `componentLockKeysWithPrefix`
  and the record listing are gone. Staleness still reads through the client
  cache, so the MOUNT is verified (`src/core/media/processes_mount.ts`): on Linux
  an `nfs`/`nfs4` processes dir without `lookupcache=none`, without `noac` or all
  four `ac*=0`, or with `nocto` refuses the boot (FATAL) and every lock call
  (`media.not_configured`). Wire: a new refusal code on the lock door
  (`media.not_configured`, operator disclosure) — only on such a mount. Gates:
  `media_component_lock_native` (+10: crossed lang-first / whole-first via the
  `lockShareHooks.afterPublish` seam; a STALE client view — every lookup absent,
  every listing empty — refused both ways; langs share; dead vs live
  registration; dead whole lock reclaimed by a lang; probe collision waited out;
  a registration's own sightings; a release whose share cannot be left still
  gives the lock back; and the lost-hold gate now asserts its registration
  withdrawn), `media_processes_mount_native` (new, 12 — the mount table is read
  through `readBoundedSync` with a 4 MiB ceiling; past it or unopenable, the
  mount is refused typed, never trusted).
- **Addendum 2026-11-23 (fourth review R1, the share without a probe):** the
  per-lang PROBE at the whole name (link + 2 ms × 3 wait + CAS withdraw) is gone
  — on NFS its withdraw (~7 synchronous RPCs) outlasted the wait, so two langs of
  one component refused each other spuriously. Now the whole holder, after its
  vacant `rmdir` of the share dir, links its lock AT the share dir's NAME as a
  file — the TOMBSTONE. A per-lang registration (`link` into the dir) then gets
  ENOTDIR (or ENOENT → `mkdir` EEXIST → refused after the attempts): refused,
  server-answered. A registration that succeeded keeps the dir non-empty, so the
  whole holder's `rmdir` answers ENOTEMPTY and its tombstone EEXIST (asked again
  → refused). The release unlinks the tombstone by CAS (only a link of its own
  lock); a crashed holder's tombstone is judged by its lock's rules (pid /
  heartbeat at the lock's own path, sighted under the tombstone's name) and
  reclaimed by the next lang or whole claim. Two langs never refuse each other
  and nothing waits. No wire change. Gates: `media_component_lock_native`
  (+3 → 60: crossed lang-first / whole-first, a lang crossing between the rmdir
  and the tombstone (`lockShareHooks.beforeTombstone`); lang-vs-lang interleaved
  and mid-leave (a dir removed between mkdir and link is made again), no wait;
  dead tombstone reclaimed by a lang and by a whole claim; a live far
  tombstone refuses while its heartbeat beats; a release takes back only its own
  tombstone — replacing the probe-collision gate).
- **Addendum 2026-11-23 (fourth review R2 + R3, the mount verdict):** R2 — the
  pre-swap SMOKE boot no longer skips the mount check: the updater names the
  LIVE processes dir to its child (`DEDALO_SMOKE_PROCESSES_DIR`, environment
  scope, set by the updater only; `configuredProcessesDir()` — resolved, never
  created) and the child reads the same verdict READ ONLY
  (`verifySmokeProcessesDirMount`: nearest existing ancestor, realpath, no
  mkdir) — refused → FATAL exit 1 → `update.refused`, nothing swapped. An
  updater older than the key names no dir: said loudly, not judged (the real
  boot still judges). R3 — the mount is matched BY DEVICE: the dir's `st_dev`
  (glibc `maj:min` decoding) against mountinfo field 3, the deepest prefix mount
  carrying that device; only when none carries it (btrfs subvolume) the deepest
  prefix alone — an over-mount resolves to what the kernel resolved. A path that
  cannot be located (EACCES/EIO, not ENOENT) is refused typed. The lock door
  re-reads the table past `MOUNT_REVERIFY_MS` (60 s, the manager's clock), a
  refusal is never remembered. Wire: no change (same `media.not_configured`).
  Gates: `media_processes_mount_native` 12→18 (over-mounts both ways by device +
  the no-device fallback, in `mountOf` and at the door (a share stacked over a
  local disk refused, the disk itself not judged); st_dev decoding incl. majors/minors past the low bits,
  and on a /proc host the kernel's own '/' device; nearest-ancestor verdict
  creates nothing; re-verify only past the bound, a remount refused, a refusal
  not remembered; the smoke verdict refuses a live default-NFS dir creating
  nothing, passes a coherent one, says an unnamed one; `configuredProcessesDir`),
  `code_update_smoke_boot` +2 (a child running the real verdict on the named
  live dir refuses the update, nothing swapped; server.ts's mount block is never
  behind a `!smokeBoot` guard) and the neutralised-env case now requires the
  named live dir.
- **Addendum 2026-11-23 (final review F1 + F3 + info):** F1 — a whole-component
  claim that THROWS part-way (an acquire error, the mount re-verified and
  refused at the share-closing `lockContext`, an rmdir/link/readdir failure
  closing a share) gives back every claim already taken — memory keys, whole
  locks, tombstones — then propagates; a throw after a tombstone is placed but
  before its handle is returned takes that tombstone back (CAS). F3 — a
  per-lang LEAVE unlinks only its registration, never the share dir (it raced
  another lang's registration); an empty share dir is harmless, removed by the
  next whole holder's `rmdir`. Info — a whole claim that holds no file lock is
  refused (`closeShareOf` false), never taken as closed. No wire change. Gates:
  `media_component_lock_native` 60→64 (a throw injected at each point — a later
  component's acquire, the mount refused at the closing `lockContext`, a later
  share's rmdir EIO with the earlier tombstone standing, the post-placement
  hook — each leaves no whole lock, no tombstone, and a later whole claim on the
  same manager passes); the lang tests now assert the dir stays, empty, after the
  last leave, and that a lang leaving never touches another's registration.
