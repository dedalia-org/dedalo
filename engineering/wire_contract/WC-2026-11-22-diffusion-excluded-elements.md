# WC-2026-11-22-diffusion-excluded-elements — `tool_diffusion`'s `EXCLUDE_DIFFUSION_ELEMENTS` hides an element's panels AND refuses `diffuse` to it

- **Date:** 2026-11-22 (owner ruling R3: port the v6 `EXCLUDE_DIFFUSION_ELEMENTS`, option (a) — a
  `tool_diffusion` config key, filter AND server-door refusal; the v6→v7 config migration moves the
  define into it).
- **Decision:** owner ruling R3 (gated: `test/unit/diffusion_excluded_elements_native.test.ts` —
  zzdif scratch domain, scratch dd996 record, both doors, the alias match, malformed refusal, the
  migration move and its four outcomes). Code: `src/diffusion/api/excluded_elements.ts` (THE list +
  both checks), `src/diffusion/api/info.ts` (`selectPublishablePanelNodes`),
  `src/diffusion/api/actions.ts` (`diffuseAction` → `assertPublishableElement`),
  `src/core/tools/tool_config_move.ts` + `src/config/migration_map.ts` class `TOOL_CONFIG` +
  `scripts/migrate_v6_config.ts` (the move).
- **Shape before (PHP v6):** `tool_diffusion::get_diffusion_info` read `EXCLUDE_DIFFUSION_ELEMENTS`
  from the tool's Tools-configuration record (dd996 → dd999 config object), falling back to the
  define of the same name when the tool config had no non-empty array, and dropped every diffusion
  map item whose (real, alias-resolved) element tipo was listed. A UI filter only: `diffuse` never
  checked the list, so a hand-posted tipo published. A non-array value was silently ignored.
- **Shape before (TS):** the key was read by nothing; `migration_map.ts` dropped the define as
  `NO_CONSUMER`. Every element of the section's domain reached `get_diffusion_info`, and `diffuse`
  published to any of them.
- **Shape after (TS):**
  - **Where the list lives.** ONE place: the `tool_diffusion` tool configuration under v6's own key
    spelling `EXCLUDE_DIFFUSION_ELEMENTS` (install dd996/dd999 over the register default, via
    `getToolConfigValue`; the `{value: [...]}` option form reads as its `.value`). A v6 install
    that set it there keeps it with no data change. There is no env key and no define.
  - **`get_diffusion_info`.** The `section_diffusion_nodes` items (panels) of an excluded element
    are absent from `data` — same shape, fewer entries.
  - **`diffuse`.** An excluded `diffusion_element_tipo` is refused before anything is queued, after
    the SEC-13 permission check: `diffusion.element_excluded` (NEW code, category `permission`,
    HTTP 403, disclosure `public`, not retryable, label `error_diffusion_element_excluded`;
    `coordinates.diffusion_element_tipo` log-only). No job row is written.
  - **Matching.** An element is excluded when its own tipo OR, for a `diffusion_element_alias`, the
    real element it resolves to is listed (v6's match, on real tipos, is kept; listing an alias
    tipo is new — v6 could never match one).
  - **Malformed list.** Anything other than absent/null or an array of non-empty strings refuses
    BOTH actions with `tool.config_invalid` (public message names dd996; see the LOW-7 addendum). v6 ignored it — a
    list written to stop a publication must not become "publish everywhere" through a typo.
  - **Every NEW run is guarded (MED-1 addendum):** besides `diffuse`, the admin `requeue_job`
    (`requeueTerminalJob`) refuses `diffusion.element_excluded` before writing, and the stale-job
    sweeper FAILS a lost run of an excluded element with that code instead of re-queueing it.
  - **Not filtered:** delete propagation / `retry_pending_deletions` (unpublishing records already
    in a target is never blocked), and a job ALREADY QUEUED before the list changed is not
    re-checked by the runner — it runs as queued (owner question pending; unchanged).
- **Migration.** `dedalo:migrate-config` classifies the define `TOOL_CONFIG` (report section of
  that name, no `.env` line); `--execute` moves a non-empty value into the dd996 record naming
  `tool_diffusion` through the engine's write doors (one transaction, TM-audited): created when no
  record names the tool, written when the record has the key absent/empty, kept when it already
  holds a non-empty value (v6 read the tool config first), refused (`resource.conflict`) when two
  records name the tool. Shape checks and record naming: see the MED-2 addendum.
- **Reason:** the define was a live v6 publication guard that v7 had silently dropped; a hidden
  panel is no refusal to a caller who posts the tipo by hand, so the server door enforces it.
- **Gate reconciliation:** no parity fixture covers an install with the key set (the frozen store
  never exercised it); no fixture change, no re-harvest.

## Addendum 2026-11-22 — review LOW-7: a malformed list is a CONFIG fault

The malformed-list refusal was first shipped as `request.invalid_options` (category `caller`,
HTTP 400) — a fault of the request, which the caller cannot fix. It is now the NEW code
`tool.config_invalid` (category `unavailable`, HTTP 503, disclosure `public`, not retryable,
label `error_tool_config_invalid`): the installation's tool configuration is malformed, the
operator fixes it. The public message is unchanged (it names the key and dd996). Same code for
the v6→v7 move's refusal of a non-object stored config (MED-2 addendum). Gate:
`diffusion_excluded_elements_native` D (read, `get_diffusion_info` and `diffuse` all assert the
code).

## Addendum 2026-11-22 — review MED-1: requeue and the stale-run sweeper are guarded too

An excluded element could still be published by a NEW run started after the exclusion: the
diffusion server control's `requeue_job` (`queue.requeueTerminalJob`) and the stale-job sweeper's
re-queue (`queue.sweepStaleJobs`) both start a run without passing `diffuse`. Now:

- `requeue_job` reads the eligible row's element and refuses — `diffusion.element_excluded`
  (alias match included), or `tool.config_invalid` for a malformed list — before the job row is
  written. A job that is not requeueable still answers `diffusion.not_requeueable`.
- `sweepStaleJobs` takes the stale rows exactly as before (one statement, `FOR UPDATE SKIP
  LOCKED`), but a lost run whose element is excluded (listed tipo, or an alias of a listed real
  element of the configured domain) is set `failed` with the persisted failure record of
  `diffusion.element_excluded` and a `msg` saying why, never `queued`; while the list is MALFORMED
  every lost run is failed that way with `tool.config_invalid` (no element can be told
  publishable, the same posture as the `diffuse` door). The sweeper logs them under that code.
  Any other failure computing the list aborts the sweep (logged, retried next tick) — it never
  re-queues on a guess.
- Unchanged and still UNRULED: a job already queued before the exclusion is run by the runner.

Gate: `diffusion_excluded_elements_native` F (requeue refused + row unchanged, with a
non-excluded control that requeues; sweeper fails the excluded lost run with the code while the
non-excluded one is re-queued; malformed list → `tool.config_invalid`).

## Addendum 2026-11-22 — review MED-2: the migration uses the reader's shape rule and naming rule

v6 used the define and the tool-config value only when `is_array`, silently ignoring anything
else; the first migration had no shape check at all. Now ONE parse,
`src/config/element_tipo_list.ts` `parseElementTipoList` (absent/null → empty list; an array of
non-empty strings → that list; anything else → malformed), is the reader's
(`parseExcludedElements`) AND the migration's (`V6_MIGRATION` rule `toolConfig.parse`, carried by
every planned move):

- **A define that is not a list** is NOT moved: `planToolConfigMoves` returns it in `invalid`
  with its value, and the report prints it under *TOOL_CONFIG NOT MOVED* (set by hand). The move
  door refuses such a value too (`tool.config_invalid`), should one reach it.
- **A malformed STORED value** (dd996 `EXCLUDE_DIFFUSION_ELEMENTS` not a list) is treated as
  EMPTY — the v6-faithful option: v6 ignored it and applied the define — so a valid define is
  written over it, outcome `replaced`, the old value returned (`replaced`) and printed. (The
  alternative, refusing naming both values, was not taken.)
- **A stored dd999 config that is not an OBJECT** (an array, a string…) is REFUSED with
  `tool.config_invalid` naming the dd996 record — never merged into as `{}` (which overwrote it
  silently). Nothing is written.
- **Which record is the tool's** is decided by `configRecordToolName` (`core/tools/config.ts`):
  the FIRST dd1326 name item, a non-empty string — the one rule `readConfigMap` now reads by too.
  The old `@>` match could pick a record naming the tool in a later item, which the reader never
  reads as the tool's config: the move landed where no read reached it.
- The door answers `{outcome, sectionId, replaced?}` (was the bare outcome).

Gate: `diffusion_excluded_elements_native` E (string/number/mixed/empty-string defines not moved
and reported with the value; malformed stored value replaced and reported; non-object config
refused, value unchanged; a decoy naming the tool second is not written into — a record of its
own is created and the reader sees it; the door refuses a malformed value to move).

## Addendum 2026-11-22 — re-review LOW-3: a job spec with no element

- **Admin requeue** (`requeueTerminalJob`) of a job whose spec names no `diffusion_element_tipo`
  is REFUSED `diffusion.not_requeueable` (malformed: the guard cannot clear what it cannot name),
  nothing written. Before: the missing element skipped the guard and the job re-queued.
- **The stale-run sweeper** decides on a definite boolean: `COALESCE(element = ANY(list), false)`.
  Before, a NULL element made `blocked` NULL against a non-empty list, and the CASEs split the
  row (state `failed`, previous result kept, reported as an ordinary failure). Now such a lost run
  is treated as not excluded — re-queued while budget remains, as before the guard existed.

Gate: `diffusion_excluded_elements_native` F (hand-made rows with the element stripped).

## Addendum 2026-11-22 — re-review LOW-4: every entry must be a tipo; the sweeper binds a real array

- `parseElementTipoList` (`src/config/element_tipo_list.ts`, the reader's and the migration's one
  parse) accepts an entry only when it is a TIPO (`isValidTipo`). Before: any non-empty string, so
  a typo (`'oh 63'`, `'OH63'`) silently excluded nothing. Now such a list is MALFORMED —
  `tool.config_invalid` at read/info/door, every lost run failed by the sweeper, and the migration
  does not move such a define (reported under *TOOL_CONFIG NOT MOVED*).
- The tipo grammar moved to the leaf `src/config/tipo_code.ts` (config may not import core);
  `core/concepts/ontology.ts` RE-EXPORTS `TIPO_PATTERN`/`isValidTipo` — one copy, as
  `lang_code.ts` did for the lang grammar (no second copy, so no agreement test to keep).
- The sweeper binds the excluded set as a real `text[]` (`= ANY($4::text[])`), not a
  comma-joined string split again in SQL. A comma-joined entry (`'zzdif80,zzdif42'`) used to
  exclude both halves in the sweeper while the door matched it as one string; it is now malformed
  at both (the grammar has no comma). With the grammar in force the bind is not separately
  observable — it is the structural guarantee, not a gated behaviour.

Gate: `diffusion_excluded_elements_native` D (`['oh 63']`, `['OH63']`, comma entry → config fault
at read, info, door), F (comma entry: door and sweeper both `tool.config_invalid`), E (such defines
not moved).
