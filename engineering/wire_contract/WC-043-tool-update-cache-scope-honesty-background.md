# WC-043 — tool_update_cache scope honesty + the background-job stop wire

Three coupled changes born of the 2026-07-19 runaway (a run the client displayed
as "Records: 1" swept the whole 438k-record section):

- **`update_cache` REQUIRES `options.sqo`.** The silent whole-section fallback
  (`?? {section_tipo:[…]}`) is REMOVED: absent/malformed sqo fails closed with
  `invalid_request`. The v7 client now sends a deep clone of the caller list's
  LIVE sqo (`tools/tool_update_cache/js/tool_update_cache.js` — it previously
  sent none at all, which is what armed the fallback), so the run's scope is by
  construction the scope the list displays; an unfiltered list matches the whole
  section EXPLICITLY. Scripted callers pass `{section_tipo:['…']}` themselves.
  The confirm dialog now carries the record + component counts. Response gains
  `processed` and `stopped`.
- **Per-record progress.** The handler publishes throttled frames via
  `ctx.publishProgress` — `{msg, is_running, counter, total,
  current:{section_id}, n_components}`, the exact fields the copied client's
  stream renderer has always formatted (`render_tool_update_cache.js`
  compound_msg). Before this the pfile froze on the initial frame for the whole
  run.
- **`dd_utils_api::stop_process` EXISTS now.** The copied client's generic Stop
  button has always posted this action; no handler was registered, so every
  Stop click surfaced "Not retry-able HTTP error 400". Registered in
  `utilsApiActions` → `stopUtilsProcess` (core/api/process_status.ts):
  `options {pid, pfile}`, job id = validated pfile basename, owner-gated with
  the status stream's rule (no existence oracle for foreign ids), aborts the
  job's controller. The abort reaches handlers as the NEW
  `ToolActionContext.signal` (background executor forwards the job manager's
  per-job AbortSignal — `core/tools/background.ts`); `update_cache` checks it
  per record and returns a partial summary. The client stop branch
  (`client/dedalo/core/common/js/render_common.js`) now sends `pfile` alongside
  the legacy `pid` — fixing Stop for every tool on the legacy branch.

### Gate

`test/unit/tool_update_cache.test.ts` (sqo fail-closed; scoped run `records===1`
+ progress frames; aborted-signal cancellation) +
`test/unit/stop_process.test.ts` (registry, pfile grammar, no-oracle answers,
live-job stop → status `stopped`).

### WC-043 addendum — v6 `regenerate_component` parity (2026-07-19, same day)

Review against the v6 oracle (`tools/tool_update_cache/class.tool_update_cache.php`
+ `component_media_common::regenerate_component :2614`) found five divergences in
the first TS port; all are now aligned:

- **Media regenerate builds only what is MISSING.** v6 rebuilds the default
  quality only when its file is absent, re-creates the thumb ALWAYS, and
  creates/path-fixes the SVG envelope; the TS port re-encoded everything
  unconditionally (the runaway's file-churn). Kernel:
  `core/media/repair.ts regenerateMissingDerivatives`.
- **`regenerate_options` honored + correct wire shape.** get_component_list now
  returns the v6 descriptor ARRAY (`[{name,type,default}]`) the copied client
  iterates (the previous `{regenerable:true}` object rendered a silently empty
  options panel), and update_cache applies `delete_normalized_files` (move to
  `deleted/<bulk id>/`; guarded — our deliberate divergence — on a locally
  present original).
- **Time Machine suppressed** for the run's generic re-saves (`saveTm:false`;
  v6 hard-disabled TM + activity for the whole run — activity already does not
  fire on direct component saves in TS).
- **dd800 bulk-process record** minted per run (label
  `Update cache | <section> | <components>`), id in the response
  (`bulk_process_id`) and in the deleted-files path.
- **`original_file_name` restoration** from the media component's
  `properties.target_filename` sibling (v6 :2670) when the stored item lost it.
  *(2026-11-12: now ONE kernel shared with tool_media_versions `sync_files` —
  data-lang item, PHP get_id stem, lowercase extension, applied before the
  rescan; see WC-2026-11-12-media-provenance-repair-one-kernel.)*

Ledgered gap: v6 also conditionally builds ALTERNATE-extension versions; the TS
processing layer has no alternate-extension builder yet.

Gate: `test/unit/tool_update_cache.test.ts` (TM-count unchanged across a run,
dd800 minted, exact scope, progress frames).

### WC-043 correction — thumb builds from the DEFAULT-QUALITY file (2026-07-19)

v6 `component_image::create_thumb` (:393) reads `get_media_filepath(default_quality)`
and never touches the original. The first parity pass still gated BOTH the tool
regenerate and `build_version('thumb')` on `resolveOriginalSource`, so on a
partial-media box (default files present, originals not) the thumb build silently
no-oped / threw 'original not found'. Now: the kernel's thumb + envelope steps key
on the DEFAULT file's presence (original needed only for the default-quality build
and delete_normalized); `buildVersionCore('thumb')` sources the default file,
falls back to the original, and errors clearly only when neither exists.
Gate: `test/unit/media_regenerate_thumb.test.ts` (scratch media root with the
default file only).
