# Tools subsystem (TS/Bun engine)

Dédalo **tools** are self-contained mini-applications that extend the core (export,
time machine, transcription, indexation, import, …). This document is the standing
spec for the TS tools subsystem after the tools-architecture rewrite.

## The one rule

**A tool is a self-contained package.** Everything a tool needs lives in one
directory under the repo-root `tools/` tree — its client code, its server code,
and its registration manifest:

```
tools/tool_export/
  register.json        # registration manifest (v7 authoring or column-keyed dump)
  js/  css/  img/      # client assets — served at /dedalo/tools/tool_export/…
  server/
    index.ts           # exports `tool: ToolServerModule` — NEVER served
    …                  # private server helpers
```

The **common machinery** (registry, loader, dispatch, security, config,
registration, and the `tool_common` client base) is NOT a tool — it lives in
`src/core/tools/`. The `tools/` tree contains only tools. Third-party tools drop
a folder into an additional root (see *Roots*) and register it; core is never
edited.

`tools/` is **TS-owned**: it was seeded once from the PHP client tool tree and now
diverges deliberately. Since the 2026-07-11 cutover `scripts/sync_client.sh` is
RETIRED and refuses to run at all — every client tree, `tools/` included, is
primary TS-owned source and is edited in place.

## Server module contract (`src/core/tools/module.ts`)

`server/index.ts` exports `const tool: ToolServerModule`:

```ts
interface ToolServerModule {
  name: string;                               // must equal the dir name, ^tool_[a-z0-9_]+$
  apiActions: Record<string, ToolActionSpec>;  // the remote surface (PHP API_ACTIONS)
  backgroundRunnable?: readonly string[];      // second allowlist for async (PHP BACKGROUND_RUNNABLE)
  backgroundLanes?: Record<string, JobLane>;   // REQUIRED per backgroundRunnable action (PERF-11)
  isAvailable?: (ctx) => boolean | Promise<boolean>;  // toolbar availability (PHP is_available)
  onRegister?: () => Promise<void>;            // lifecycle hooks — NEVER inside apiActions
  onRemove?: () => Promise<void>;
}
interface ToolActionSpec {
  // declarative gate — see "Choosing a permission kind" below for record/tipo/record_tipo
  permission: 'section'|'section_list'|'targets'|'tipo'|'record'|'record_tipo'|'developer'|null;
  minLevel?: number;                            // dd774 level (1 read / 2 write / 3 admin), default 2
  sectionTipos?: (options) => unknown[];        // REQUIRED for 'section_list': the batch's targets
  targets?: (options) => WriteTarget[];         // REQUIRED for 'targets': the action's WRITE targets
  handler: (context: ToolActionContext) => Promise<ToolResponse>;
}
interface WriteTarget { section_tipo: unknown; tipo?: unknown; section_id?: unknown }
```

**`section_list`** is for a BATCH action whose section targets ride *inside* the
payload rather than at the top level — `tool_import_dedalo_csv::import_files` posts
`files[]`, one `section_tipo` per file. `sectionTipos(options)` pulls them out and
`minLevel` is asserted on every one; an empty list or any invalid entry is a denial.
It exists so the check stays DECLARATIVE and therefore still runs **before the
background fork** (gate 7), where a denial is still observable to the caller — an
in-handler loop would be invisible to a `background_running` request. PHP's twin is
the `assert_section_permission` loop at the top of `import_files` (SEC-024 §9.2).

**`targets`** is for an action whose EFFECT TARGET is not a top-level option —
the scope rides in `options.sqo` (`tool_update_cache::update_cache` re-saves the
selected components on every row the SQO matches), in a nested client map
(`tool_import_files::import_files` writes into every `tool_config.ddo_map`
destination; the marc21/zotero field-maps bind components the same way), or is a
section the handler PINS by constant (`tool_hierarchy` writes `hierarchy1/<id>`
whatever `section_tipo` the client sends). `targets(options)` derives the
(section_tipo, tipo?, section_id?) triples the handler will mutate **off the same
keys the handler reads**; `minLevel` is asserted on each — the (section,
component) PAIR when a `tipo` is named, the record's scope (`isRecordInScope`)
when a `section_id` is — and an empty list, a malformed entry or a throwing
extractor is a denial. Declaring `section`/`tipo` on such an action asserts a
right about a SIBLING field and leaves the thing actually written ungated: that
is audit CARRY-08 (TOOLS-04), three doors proven open by execution. `section_list`
is the tipo-less, id-less special case and stays for the pure per-section batch.
A target the handler can only resolve at run time — an ontology-derived portal
section, and above all a RECORD the handler binds while it runs (a filename's
numeric prefix in enumerate mode, a matcher hit, the destination of a role
write) — is authorized in-handler, at the point it is bound and before the
first write into it, through the save door's own rule
(`record_scope.ts assertRecordWriteTarget`); a record born in the same run is
admitted as a create is. The declarative extractor proves the PAIRS and the
records the request SPELLS; it cannot see an id the handler derives, and a
gate that stops at the extractor leaves the record axis open (audit CARRY-08's
third door, refuted by reproduction: the same record refused as
`files_data[].section_id` and written as a filename prefix).
Gates: `test/unit/action_scope_binding_tripwire.test.ts` — TOTAL over every
action of every loaded tool server module, binding each handler that reads a
request SQO, a nested client map key, or a pinned section constant to an
extractor that references the same key; `action_scope_binding_native` — the
pair, the level and the record halves refused through the real gate and, for
the run-time-bound records, through the real handler.

A handler's returned `ToolResponse` **replaces the API envelope wholesale** — the
tool owns its `result` / `msg` / `errors` (and any extra fields, e.g. a streaming
body). There is **no reflection**: a method exists on the API only if it is a
property of `apiActions`, and the handler is a typed function, so PHP's
"public + static + `(object $options)`" gates are structural here.

`tools/tool_dev_template/server/index.ts` is the exemplar: EVERY permission kind
the contract declares (`section`, `section_list` + its `sectionTipos` extractor,
`targets` + its `targets` extractor — as `scoped_batch_demo` —
`tipo`, `record`, `record_tipo` — as `component_write_demo` — and `developer`)
plus a null-spec action, `backgroundRunnable`, the background-only
`publishProgress` / `signal` seams, `isAvailable` and the lifecycle hooks. For
which kind an action should declare, see *Choosing a permission kind* below —
that section is the one home of the record/tipo/record_tipo decision.
`test/unit/tool_dev_template.test.ts` pins the list mechanically against the
permission union PARSED out of `module.ts`, so an exemplar that drifts from the
contract fails rather than propagating the drift into every scaffolded tool, and
`test/unit/tools_spec_sync.test.ts` holds the union quoted above to that same
source (this paragraph and the code block are checked, not trusted).

## Dispatch gate chain (`src/core/tools/dispatch.ts`)

`dd_tools_api.tool_request` → `dispatchToolRequest`, PHP's ten gates in order
(the reflection gates are structural, so they collapse into a Map lookup):

1. `options` must be an object;
2. the tool name must match `^tool_[a-z0-9_]+$` (rejected before any lookup);
3+4. the tool must be ACTIVE in dd1324 **and** authorized for the caller
   (`getUserTools`: admins get every active tool; others the profile-granted
   dd1067 set + always_active dd1601 tools);
5. the tool must have a **loaded server module** (PHP class-file resolve);
6. the method must be in `apiActions` (PHP API_ACTIONS allowlist);
7. the declarative permission gate must pass — **before** any background fork;
8. execute directly, or (when `options.background_running === true` — the
   BOOLEAN, a truthy string does not fork) via the background executor, which
   additionally enforces `backgroundRunnable`;
9. the action must DECLARE ITS JOB LANE in the module's `backgroundLanes`
   (PERF-11). Background actions no longer share one process-wide concurrency
   cap: each spends a per-class budget (`media | transcription | rag |
   maintenance`, `src/core/media/jobs.ts`), so an ingest queue cannot starve an
   operator's code update. The lane is DECLARED, never inferred from the tool or
   action name — a prefix rule silently files a new action into whatever lane its
   name resembles — and an undeclared one is refused with its own closed-registry
   code, `tool.background_lane_undeclared`, because reusing
   `tool.background_not_allowed` would name the wrong cause. Census gate:
   `test/unit/job_lane_census_tripwire.test.ts`.

**Every gate is tripwired.** `test/unit/tools_dispatch.test.ts` carries one case
per gate, each written so that DELETING that gate makes it fail — the messages are
asserted, not just `result:false`, because a later gate would refuse the same
input for a different reason and a shape-only assertion would stay green. Gate 7
additionally has an ORDER case: a background request whose permission fails must
come back as the DENIAL with no job handle, since a denial raised after the fork
is invisible to the caller.

`dd_tools_api.user_tools` returns the caller's authorized toolbar contexts.

### Where a toolbar is STAMPED onto a context

**The stamp is gated on MODE and on PHP's `$simple`. NEVER on permissions.**
`common::get_tools()` (`class.common.php:4023`) contains no permission check at
all — authorization is the per-user `get_user_tools()` list it iterates. The
caller's condition (`build_structure_context:1865`) is:

```php
$simple===false && ((($model==='section' || str_starts_with($model,'area')) && $mode==='list') || $mode!=='list')
```

A `permissions >= 3` gate would mean **superuser-only**: only userId `-1` ever
reaches 3 (`getPermissions` short-circuits it; the profile matrix tops out at 2,
global admins included), so every real user would get an empty toolbar
everywhere. The frozen oracle refutes such a gate — PHP shipped tools at
permissions **2** (`sqo_differential` dd560 dataframe/edit) and **1**
(`tm_component_history` dd452/tm). The perm-1 empties in the store are all
`start` responses, i.e. the SIMPLE build, not a level effect.

`$simple` is `addRequestConfig === false` in this port (the `start` action and
the search-filter panel). Four stamping sites — miss one and that element
silently ships `tools: []`:

| Element | Gets a toolbar when | Notes |
|---|---|---|
| component (`component_*`) | not simple **and** `mode !== 'list'` | `all_components` catch-all + `requirement_translatable`. The list exclusion STAYS — see "Reaching a component tool from a section LIST" below. |
| area (`area`/`area_*`) | not simple (any mode) | matches via `affected_models('area')` or an `affected_tipos` entry. |
| section | not simple (any mode) — `section/context.ts` | via `getSectionTools`; the section clause of the PHP condition covers list too. |
| **menu** (`dd85`) | **always** | PHP overrides the builder (`menu::get_structure_context`) and `start` calls that override too (`dd_core_api.php:379`), so neither the list-mode nor the simple exclusion reaches it. Its one bound tool is `tool_user_admin` (`affected_tipos:['dd85']`, `always_active`) — the client opens it from `context.tools` when the user clicks their name (`menu.js open_tool_user_admin_handler`), and suppresses the click for `root` client-side. |

Whatever the site, `getElementTools` first drops every tool the ACTOR's
`user_tools` does not contain — PHP's `get_tools()` iterates
`get_user_tools($user_id)`, so a tool the profile denies can never reach a
toolbar. The actor comes from the request scope (`security/request_context.ts`
= PHP's `logged_user_id()`); no scope (internal resolutions, background warmups,
harnesses) and global admins mean no filter, the same posture `ddoIsAuthorized`
takes. Clicking a tool re-authorizes independently (`src/core/tools/dispatch.ts` gate 4,
`dd_core_api` start), so this filter is a wire-correctness rule, not the access
control — but omitting it ships buttons that 403.

### Reaching a component tool from a section LIST

The list exclusion above says a component in `mode:'list'` ships `tools: []`. That
is oracle-pinned and stays. It does NOT mean component tools are unreachable from
a list — the route is the **per-cell edit modal**, and it needs no server change:

1. the user clicks a list cell → `activate_edit_in_list`
   (`client/dedalo/core/component_common/js/component_common.js`);
2. `ui.render_edit_modal` builds a **fresh instance at `mode:'edit'`** and calls
   `build(true)`, i.e. a real `read`;
3. that read is an ordinary edit-mode build, so the component gets its **full
   toolbar** from the table above.

Do not "fix" list mode by stamping tools in list. It is refuted three ways: PHP
never shipped them for a component in list mode; it would put a toolbar in every
grid cell; and it would not even work — `tool_common.init` takes
`main_element.mode` from the CALLER, so a tool like
`tool_propagate_component_data` would build its editable clone as a **read-only
list cell** with nothing to type into. Pinned by
`test/unit/component_tools_stamp.test.ts` ("the list-mode exclusion STAYS").

**What a tool must NOT assume: the caller-chain DEPTH.** A component reaches its
owning section through a `section_group` in edit mode but through a
`section_record` from a list cell, and a portal-embedded component reaches an
OUTER section that owns a different record set. Resolve by MODEL —
`get_caller_by_model(instance, 'section')`, which is also cycle-safe
(`tool_common`'s window path sets `caller.caller = self`, so a hand-rolled walk
hangs the tab). A fixed-depth walk is exactly why
`tool_propagate_component_data` was unusable from a section list in this engine
and in the PHP oracle before it. Gated by
`test/unit/client_caller_chain_tripwire.test.ts`.

The modal instance is made a **sibling** of the cell it edits (its `caller` is the
cell's own caller), so the distance to the section matches edit mode and tools
that still walk a fixed depth keep working. `caller` is not part of the instance
key, and `get_instance`'s cache-hit path skips `init`, so it must be re-asserted
after every `get_instance` — otherwise a reopened modal points at a caller a
re-search already destroyed, and the tool works once and then silently stops
finding its section.

The per-user grant lookup is cached (`profileToolGrantsCache`, a
`createDataCache` keyed by userId, exactly like `permissions.ts`
`permissionsTableCache`), because the stamp needs it once per ELEMENT. It is
dropped on any dd128 (profile assignment) or dd234 (grants) write via the
save-event channel AND by `invalidateAllToolCaches()`.

Gated by `test/unit/component_tools_stamp.test.ts` + `test/unit/menu_tools.test.ts`.

## Background execution (`src/core/tools/background.ts`)

A `background_running` request runs the handler inside the **process-job registry**
(`media/jobs.ts` — the same one the AV transcodes and the backup widget use), and
answers immediately with `{job_id, background_job_id, pid, pfile}`.

**Two status wires exist. New consumers use the first.**

- **PUSH (native) — `dd_utils_api::get_job_events`** (`core/api/job_stream.ts`).
  The job runs in the process serving the stream, so a consumer SUBSCRIBES to the
  job record (`mediaJobs.subscribe`) and every state change is pushed the instant it
  happens: no `{pid, pfile}` handle, no re-reading a file on a timer, no 0–1000 ms
  lag. The handle is `job_id` alone. The stream ends on the first `is_running:false`
  frame, and THAT frame's `data` is the handler's return value.

  **A SUBSCRIPTION IS A CONNECTION, and the consumer owns its release.** The stream
  stays open for the job's whole life (the server re-sends the current frame every
  15 s so no proxy times it out), and a browser grants six per origin over
  HTTP/1.1. `client/dedalo/core/common/js/job_follow.js` is therefore the only
  client entry point: its `cancel()` cancels the reader and drops it from
  `page_globals.stream_readers`, and `create_job_follower_group()` gives a surface
  one `cancel_all()` for every stream it opened — called from its `destroy()` AND at
  the head of each render pass, since a re-render orphans the previous pass's
  followers. Measured cost of getting this wrong (2026-08-13, tool_media_versions):
  six panel opens over one transcode starved the origin, `/health` included, so the
  client reported timeouts and retries against a server answering in milliseconds.
  Gated by `test_job_tray` in the client suite.
- **POLL (legacy) — `dd_utils_api::get_process_status`**. A faithful port of a PHP
  workaround: PHP forked a detached CLI child that could not talk to the web request,
  so it wrote a JSON "process file" and the web layer TAILED it. `pid` + `pfile` are
  that wire (`pfile` is a BASENAME — the endpoint refuses any separator). Still spoken
  by the AV transcodes and the area_maintenance widgets; kept for them, not extended.

Progress: a handler receives `ctx.publishProgress` under the background executor
(absent in a foreground call). Each payload it publishes replaces the job frame's
`data` and wakes every subscriber — handlers THROTTLE their own rate, because each
publish also rewrites the pfile mirror. `tool_import_dedalo_csv` publishes a typed
`ImportProgressFrame` (`core/tools/import_wire.ts`) carrying `rows_total`, which is
what lets its panel show a real progress BAR rather than a scrolling text line.

- **The handler's `ToolResponse` becomes the job's final payload**, i.e. the terminal
  frame's `data` — which is where the client reads its report from.
- **Ownership.** Job ids are derived (`kind_pid_counter`), so they are guessable: the
  job record carries its `user_id` and the status stream answers only the owner (or a
  global admin). A poll from anyone else gets the same terminal frame a non-existent
  job gets — no existence oracle, no payload. Unowned jobs (AV, backup: operational
  shape only) keep their historical behavior.
- Jobs are IN-PROCESS: they die on server restart (a PHP CLI child survived an Apache
  reload), and they share the registry's concurrency cap with media work.

### THE RULE: the SERVER owns job state, the client keeps none

The job runs inside the process that is serving the request, and the registry
already records its **tool, action, owner and status**. So a client must never keep
its own copy of that — no `job_id` in `localStorage`, none in IndexedDB, none in a
page global that a reload throws away.

This is the one place the PHP shape actively misleads. PHP forked a **detached CLI
child** the web layer had no memory of: the only handle was the `{pid, pfile}` pair
handed back at launch, so the client HAD to persist it or lose the job. Porting that
habit gives you client state duplicating a fact the server owns, and it is wrong in
three ways at once — it is **per-browser** (a second tab sees no running import), it
goes **stale** the moment the server restarts and the in-process job dies with it,
and persisting it is a silent runtime throw away (`db.transaction()` on an object
store that does not exist rejects from inside a promise). `tool_import_dedalo_csv`
shipped all three before this rule existed.

Two RESERVED framework actions serve every `backgroundRunnable` tool — the dispatcher
answers them itself, after the active+authorized gates and before the module lookup,
so no module registers anything:

| Action | Answers |
|---|---|
| `get_background_job_status` | "how is job X doing?" — needs an id you still hold |
| `get_background_jobs` | "**do I have one running?**" — the LIST, newest first, optionally narrowed by `options.action`. This is what a reloading client uses to find the run whose id it no longer has |

Both are scoped identically: own jobs only, unless the caller is a global admin. The
LIST deliberately carries **no `response` payload** — it is a directory, not a bulk
export of every recent run's report; the caller subscribes to the one job it cares
about (`get_job_events`) and gets the report on the terminal frame.

So reload-recovery is: *ask which of my jobs is running → subscribe to it.* Enforced
by `test/unit/local_db_stores_tripwire.test.ts`.

### Choosing a permission kind: `record` vs `tipo` vs `record_tipo`

PHP composed its asserts freely per method, so a TS kind may stand for a
COMBINATION. The one that matters:

| the action targets | kind | asserts |
|---|---|---|
| a section | `section` | the consultation-capped SECTION level on `options.section_tipo` |
| a component (no record) | `tipo` | level on the (section, component) PAIR; a NAMED record (a positive `section_id`) is scoped too |
| a record | `record` | the consultation-capped SECTION level + the record's project scope; the id REQUIRED |
| **a COMPONENT OF A RECORD** | **`record_tipo`** | **section floor 1 + the dd128-aware PAIR + the record's project scope** |
| whatever `options.sqo` / a nested client map / a pinned constant names | `targets` | EVERY derived (section, tipo?, id?) — pair and scope halves per entry, the section cap on a section-level entry |

**Every kind is THE WRITE DOOR** (closure Step 3, 2026-09-30;
`src/core/security/write_door.ts`, `engineering/wire_contract/WC-2026-09-30-write-door.md`):
`security.ts` maps each kind onto `authorizeRecordAccess` / `authorizeSectionTarget` /
`authorizeSectionRecord`, whose order is fixed — id grammar → section floor → the
(section, component) pair through `getRecordComponentPermission` (the dd128 own-record
rule: a `(dd128, dd1725)` user-manager cannot edit their OWN profile through any tool;
the self-service name/email/password/image exception holds at a tool door too) → the
record scope, the non-positive id refused AHEAD of the admin bypass (no tool action
reaches root's dd128/-1). Rules every kind shares:

- **The id is a positive integer or it is refused.** `1.5`, `'abc'`, `0` and negative
  ids are `invalid record target`; `tipo` / `section` read an ABSENT id as "no record
  named", never a malformed one. No shipped client sends `section_id: 0` on a `section`
  / `tipo` action.
- **The consultation cap applies to every section-level target** — `section`, `record`,
  a `targets` entry, and `tipo` when it names the section itself: a consultation-only
  section (Activity, Time Machine) caps at read, the superuser included.
- **`assertToolGranted(principal, tool)`** is the one tool-ACL check for doors outside
  the declarative gate (the agent door's `tool_assistant`, identify's `tool_identify`
  vision spend).
- **tool_transcription gates in-handler** (its permission kind is `null`): the write door on BOTH
  ddos, read (1) on the AV source on every path and write (2) on the transcript; its
  background save re-runs the door for a LIVE principal, and its status poll takes a
  server-issued poll handle (WC-2026-09-30-transcription-record-tipo).

`record` resolves `getPermissions(principal, sectionTipo, sectionTipo)` — a
*section*-level right. It never consults the component tipo. So an action that
names both a component and a record id and declares `record` silently drops the
component half, and one declaring `tipo` silently drops the record half. Until
2026-07-28 the whole media family declared `record`, which meant **a user with
section write who was explicitly denied level 2 on one media component could
still delete its files, rotate it, remux it or bulk-rewrite its transcription**
— **eleven** actions across five tools (`tool_media_versions` ×7, `tool_image_rotation`,
`tool_tc`, `tool_pdf_extractor`, `tool_posterframe.create_identifying_image`). A twelfth
joined on 2026-09-30: `tool_upload.process_uploaded_file` writes ONE component's master
file and files_info, so it declares `record_tipo` too
(WC-2026-09-30-media-pair-scope).
PHP asserted both at every one of those doors
(`assert_tipo_permission` + `assert_record_in_user_scope`).

**One action deliberately stays `record`.** (`tool_upload.process_uploaded_file`
stayed too until 2026-09-30 because its PHP twin asserts no tipo — but the write it
performs is a component's, and the hole was the AV/3D one.)
`tool_posterframe.get_ar_identifying_image` — its
handler and client send only `section_tipo`/`section_id`, and PHP gates it
`assert_section_permission(1)` + `assert_record_in_user_scope`
(`class.tool_posterframe.php:382-384`). It was briefly flipped to `record_tipo` on
2026-07-28 and that made it **unsatisfiable for every caller, global admins
included** — the gate demanded a component the payload never carries. **A gate the
real payload cannot satisfy is a broken action, not a strict one**, and asserting
the permission STRING in a test does not catch it; the reachability test below does.

The component key is `options.tipo`, with `options.component_tipo` accepted as
its alias — exactly what `resolveMediaToolContext` and the tc/pdf handlers read.
**Supplying BOTH keys with DIFFERENT values is a denial** (`conflicting component
target`): handlers did not all read the aliases in the same order, so an ambiguous
payload could be authorized against one component and acted on in another. Refusing
it makes the gate order-independent.

Gated by `test/unit/tools_record_tipo_permission.test.ts`, which pins both halves
independently (section-write-but-component-denied is refused; granted-component-
on-an-out-of-scope-record is refused), pins the both-keys-conflict denial, asserts
those twelve actions still declare it, and REACHABILITY-checks that the payload each
caller actually sends clears its own gate. The exemplar demonstrates it as
`component_write_demo`.

### THE RULE: a batch action takes its scope from the REQUEST, or refuses

An action that writes over a SET of records must be told which set. An absent scope
parameter must never widen into "every record of the section" — that default has now
produced two runaways: `tool_update_cache` swept a 438k-record section that the
client displayed as "Records: 1" (2026-07-19, WC-043), and
`tool_ontology::set_records_in_dd_ontology` rewrote whole sections (12,172 records
across the audited install) where PHP had failed CLOSED (2026-07-28, WC-058).

The pattern both now follow: the client sends a deep clone of the caller list's LIVE
`sqo`; the handler refuses when it is absent/malformed, sanitizes it
(`sanitizeClientSqo`), strips pagination so the whole MATCHED set is processed rather
than the visible page, and resolves it to explicit ids. An unfiltered list still
matches the whole section — but EXPLICITLY, and the number the user was shown is the
number the run touches.

Where a genuine full-section rebuild is required by an INTERNAL caller, it declares
itself (`setRecordsInDdOntology({wholeSection:true})`) — opt-in and greppable, so no
request that merely omits a parameter can reach it.

### THE COROLLARY: a tool's throwaway clone addresses NO record

The same law one layer lower (2026-07-28, WC-059). A tool that needs an editable
component the user can type into — the propagate tool's value widget,
`service_tmp_section`'s staging form, the `component_text_area` pickers — builds a
CLONE and marks it `is_temporal`. The clone has no record, so the client stamps a
sentinel `section_id` (1) on it.

**A client-supplied record id on an instance that declares itself record-less is a
wire field, never an address.** PHP honored the flag with a scratch store; the TS
port dropped the store but kept accepting the id, so the sentinel resolved to the
real record 1 of whatever section the tool was opened on — overwritten, Time-Machined
and activity-logged on every single tool open, for a whole engine generation.

A record-less instance therefore RESOLVES and ECHOES (`resolveTemporalSave`) and the
record-lifecycle doors refuse it outright. **Do not make a write engine polymorphic
over "real vs scratch"** — that part stands. By default the value lives in the client
until the tool commits it deliberately, which is exactly what
`tool_propagate_component_data` does (it propagates
`component_to_propagate.data.entries`, straight from client memory).

**Exception (WC-079, 2026-07-30): a SEPARATE, opt-in scratch store now exists** for
the one case where client-only cannot work — `service_tmp_section`, whose children
autoload and so re-read an empty value on every render, silently wiping the staging
form on any reload. It is a distinct table with its own owning module
(`section/record/temporal_store.ts`); `saveComponentData` was NOT made polymorphic,
and the temporal door still reaches no matrix write engine. A tool opts in by sending
`source.temporal_scope`; anything that does not send it keeps the client-only
behaviour described above. Adding a second producer of that field is a deliberate
change gated by `temporal_instance_tripwire`.

## Loading (`src/core/tools/loader.ts`)

At first use, the loader scans the roots in priority order, and for every dir
matching `^tool_[a-z0-9_]+$` with a `server/index.ts`, dynamically imports it and
validates the exported `tool` against the contract. First root wins name
collisions (reported). The import specifier is never request-influenced — it is
built from an allowlisted root path + a name that already matched the pattern,
and the canonical path is confined under the root before import (TOCTOU-safe).
Gated by `test/unit/tools_path_confinement.test.ts`: a traversal-shaped name is a
registry MISS (never a dynamic import), and every loaded tool's `dir` is under a
declared root.

**Editing `server/` code requires a server restart** (Bun module cache). Running
the registration widget refreshes the DB registry and rescans for NEW tool dirs,
but does not hot-reload changed modules.

> `bun build --compile` does not see runtime dynamic imports. The project runs
> from source (`bun run src/server.ts`), so this is fine; a compiled deployment
> would need a generated manifest embedding the tool modules (the contract is
> unchanged either way). — ledgered.

## Roots & static serving

Roots come from `paths.ts::getRoots()`: index 0 is the in-repo `tools/`; extra
roots come from `config.tools.additionalRoots` (env `DEDALO_ADDITIONAL_TOOLS`,
JSON `[{path,url}]`). A root that is missing, not a directory, or a system temp
dir is refused. Additional-root URLs must be same-origin (root-relative) — the
browser `import()`s tool JS from them.

The tool_common client base is NOT here: it is ordinary client source at
`client/dedalo/core/tools_common/` and the generic client handler serves it at
`/dedalo/core/tools_common/…` like every other file under `/dedalo/core/`
(moved there 2026-08-16 — WC-006 — from `src/core/tools/client/`, which had
needed its own route, its own css search dir and its own scan root in every
gate that walks the client; the URL is unchanged, so all 62 importers and
`client/dedalo/core/page/css/main.less` are untouched).

`server.ts` serves tool assets via `serving.ts` (before the generic client
handler):

- `/dedalo/tools/<tool>/*` → the tool's assets over the roots, **realpath**-confined,
  **refusing the `server/` subtree and any non-asset extension**. `register.json`
  IS servable (public registry data). Everything fails closed (404) — one identical
  body for a private path, an absent file and an unknown tool, so the route is
  never an existence oracle.

Confinement is TWO checks, and both are load-bearing: `resolve()` normalizes `..`
lexically, and the result is then realpath'd and re-checked against the realpath'd
package dir. Only the second catches a SYMLINK inside a package pointing out of it
(`<tool>/js/x.json -> ../../../package.json` normalizes to a path legitimately
under the tool dir). That matters because a package in an ADDITIONAL root is
third-party code, so the difference is an arbitrary-file reader. The base is
realpath'd too, so a legitimately symlinked tool directory keeps working. Gated by
`test/unit/tools_path_confinement.test.ts` (found + closed 2026-07-28; the
"realpath-confined" claim had been true of `loader.ts` and only lexically true here).

The client env exposes `DEDALO_TOOLS_URL` (`/dedalo/tools`) and, for
additional-root tools only, `DEDALO_TOOLS_URLS` (name → base URL);
primary-root tools fall back to the relative path in the client.

## Config (`src/core/tools/config.ts`)

Per-key resolution: install config (dd996 / dd999) → register default
(dd1324 / dd1633) → caller default. Only options flagged `"client": true` reach
the browser (`getToolClientConfig` resolves values; `getToolClientConfigRaw`
keeps the full prop definitions, used by the tool element context). Secrets never
carry a `client` flag. Tool config is per-tool (via the tool context), **not** in
the environment payload.

## Registration (`src/core/tools/register.ts`)

`importTools({dryRun})` scans the roots, parses each `register.json`, detects the
format (`components` key → v6, not supported this wave; `name` key → authoring →
converted; column-keyed → pass-through), validates it (zod for authoring +
`validateRegister` mirroring PHP), and reconciles the dd1324 registry.

**Two callers, two postures — know which one you are reading.**

`importTools({dryRun})` still defaults to **dry-run** whenever the caller passes
no `dryRun`, because `config.tools.enableRegistryImport` defaults to `false`
(`TOOLS_ENABLE_REGISTRY_IMPORT` unset). A dry run validates every tool and
reports, per tool, whether the registry already reflects its declared identity
(empty diff = no-op) — writing nothing. That is the posture the parity gate and
every incidental caller get.

The area_maintenance **"Register tools" widget does NOT take that path any more.**
Its action is `gated()`, and `engineOwnsInstall()` has been unconditionally `true`
since the 2026-07-11 cutover, so the OPEN branch always runs and it calls
`importTools({dryRun:false, activeOverrides})` explicitly — a REAL write,
independent of `enableRegistryImport`. That is deliberate: WC-057's Active column
is a write control and would be meaningless against a dry run. The frozen
dry-run/diff branch survives as `whenClosed` and is reachable only by forcing the
gate shut (`test/unit/register_tools_widget.test.ts` exercises both). The
`enableRegistryImport` flag now governs only the callers that do NOT pass
`dryRun` — it is no longer the switch that decides whether the admin's button
writes.

**Per-tool activation (WC-057).** `importTools({activeOverrides})` takes a
`name → boolean` map that forces each tool's dd1354 ACTIVE radio
(`applyActiveOverride`), applied before validation and the diff so it reaches
both. It is the "Register tools" widget's Active column: the panel seeds its
checkboxes from the registry and posts them back as `options.tools_active`, so
**the admin's on-screen state outranks the register.json declaration** for any
tool the install already registered — without this, the 36 `register.json` files
declaring `active:1` re-enabled deactivated tools on every import. A tool absent from the
map keeps its file declaration; that is the path the installer
(`registerInstallTools`) and every non-widget caller take. Because dd1354 gates
`getUserTools`, unchecking a tool removes it from every user's menu on the next
import (caches are invalidated by the same run).

The panel itself (`get_value`) JOINS the registry with the scanned directories,
so it can never offer a checkbox over a tool the import cannot reach: a row
whose directory is gone is flagged `on_disk:false` (the client disables its
checkbox) and a directory with no registry row is flagged
`'Not registered tool'`.

**The two version columns are the two SIDES of that join**
(WC-2026-08-02-register-tools-registry-state): `installed_version` is the dd1324
value, `version` is what the directory's `register.json` declares
(`readDeclaredVersion`, both formats; `null` for an unparsable file and for a
registry row with no directory). Until 2026-08-02 both were served from the
registry row, which made a stale registry indistinguishable from a synced one and
left the client's mismatch alert unreachable.

**One drift verdict, computed server-side.** Each row carries
`state: 'ok' | 'outdated' | 'unregistered' | 'missing'`, and the response carries
`registry_state = {total, outdated[], unregistered[], missing[]}` (names). Both
consumers — the panel table and the maintenance map's Tools node — READ that
verdict; neither re-derives it. They did before, and the map's copy omitted the
version comparison, so it reported a healthy node above a panel rendering the
drift. Any new consumer reads `registry_state` too.

Gated by `test/unit/register_tools_panel.test.ts` — it
asserts the JOIN itself (every scanned directory is offered a row, rows are unique
and sorted, both checkbox fields are booleans, `on_disk` agrees with the scanner
and a `false` one carries the 'Not found on disk' warning), that `version` equals
the declared version read from each directory, and that `registry_state` is
exactly the per-row `state` values summarised — rather than any
install's particular rows. NOTE the `on_disk:false` branch is DATA-DEPENDENT: it
asserts nothing unless the DB under test has a registry row with no directory —
the live install does (an extra row against 36 directories), the suite DB may not.

**Registry-drift gate.** The parity test
`test/parity/tools_register_differential.test.ts` asserts that a TS dry-run import
is a **no-op** against the registry: every seeded tool valid, present (except the
named `TS_ONLY_TOOLS`), and diff-free. It calls `importTools({dryRun:true})`
directly — no oracle credentials, no `describe.if`, so it cannot go vacuously
green — which also means it is only meaningful against a DB whose dd1324 is
populated. Its `dry-run writes nothing` case asserts the report's `dryRun` FLAG,
not a before/after snapshot of dd1324; treat it as a labelling check, not proof of
a no-op. The write path (`writeRegistryRecord`) writes the identity columns; the
dd1353 simple-tool-object cache blob and ontology tipo renumeration remain
ledgered. Scratch-DB round-trip parity for that writer lives in
`test/unit/tools_register_write.test.ts`.

**TS-only tools (`TS_ONLY_TOOLS`).** A tool that exists ONLY in this engine's
`tools/` tree (no PHP class — e.g. `tool_error_report`, WC-019) can never satisfy
the "in the registry" half of the no-op assertion until its TS-side registration
runs (the Register tools widget with the flag on, once). Such tools are carved
out of that ONE requirement via the named `TS_ONLY_TOOLS` set in the parity test
(each entry cites its WC ledger line, with a staleness self-test); they must
still VALIDATE and, once registered, stay diff-free. PHP-served admins will see
the dd1324 row but the tool fails cleanly there (COEXISTENCE row; PHP must never
re-import tools).

## Section tools ("processes", e.g. oh81 Transcription / oh83 Indexation)

`section_tool` is a virtual ontology model, not a class: a node whose `properties`
bind a tool + custom config/visualization to a target section. The menu builder
(`src/core/api/handlers/menu.ts`) rewrites section_tool nodes for display (tipo/model
swap, enriched tool_config, `self` resolution) — this is the load-bearing path and
is menu-differential-gated. Opening a process renders the target section normally
with the tool config; the client (`section.js`) handles
`config.source_model === 'section_tool'`. A dedicated server read-path
interception (PHP `dd_core_api` model overwrite) is not reachable via the request
shapes tested (PHP returns false/errors for naive get_element_context/read on a
section_tool node) — ledgered.

A section_tool page carries **no section toolbar**: it reroutes to its target
section, so its section instance holds the TARGET's tipo and `getSectionTools`
would stamp the target's ordinary tools, which act on the wrong surface. The
client's two list views drop the whole other-buttons drawer for it via ONE shared
predicate `is_non_tools_section(self)` (`render_common_section.js`), keyed on
`self.config.source_model === 'section_tool'` (the only surviving marker) — the
same treatment the consultation-only logs get. CLIENT-SIDE ONLY (no wire change);
TODO-041, gate `consultation_only_sections_tripwire`.

## Tool element context (open_tool string branch)

When the client's `open_tool` receives a tool NAME string (not a full context
object), it calls `get_element_context` with `source:{model:'tool_x'}` and no
tipo. `dispatch.ts` handles this before the tipo check: it requires the tool to be
authorized, then returns `buildToolElementContext(name)` — the full tool context
(tipo/lang/labels/description/developer + the client-visible `config`). Byte-parity
gated (`test/parity/tool_element_context_differential.test.ts`).

## Tool labels (`get_tool_label`)

A tool's OWN UI strings live in its `register.json` — `misc.dd1372` (column-keyed
dump) or the top-level `labels[]` array (authoring format) — as
`{lang, name, value}` entries. This is the tool-local counterpart of the global
`src/core/labels/` catalog (WC-034: a string used by exactly ONE tool and
tool-specific in meaning belongs here; generic vocabulary stays global).

**`register.json` is a SEED, not the runtime source.** Labels are served from
`matrix_tools`; editing the file changes nothing until the "Register tools"
maintenance widget re-imports it.

**SINGLE-LANG SERVING CONTRACT.** `buildToolElementContext`
(`src/core/tools/registry.ts`) emits ONLY the entries whose `lang` equals the
request's application lang, and an EMPTY array when the tool has no label in that
lang. A key missing in the requested lang is omitted, never substituted from
another lang. PHP behaved identically — frozen in
`test/parity/fixtures/oracle_harvest/tool_element_context_differential.json`,
where every emitted label carries the single requested lang.

Consequently the client resolver `get_tool_label`
(`client/dedalo/core/tools_common/js/tool_common.js`) is a plain name lookup: a name match
IS the right language. A miss returns `null`, which every call site handles with
its own `|| 'literal'` English fallback — so an untranslated lang shows the
literal rather than another language's string. (This replaced a three-tier
current-lang / install-default / any-lang priority chain whose second and third
tiers a single-lang payload made unreachable; it only implied a fallback the wire
could never deliver.)

Widening the filter to several langs is a WIRE CHANGE: it needs a
`engineering/wire_contract/` entry, a re-cut of the frozen fixture, and the client resolver
taught to choose. Gated by `test/unit/tool_context_labels_lang.test.ts` (seeds its
own scratch tool row, so it does not depend on what the install has registered).

## Registry strings: label (dd799) + description (dd612)

A tool's own REGISTRY strings are not `dd1372` labels and do NOT follow the
single-lang rule above: they are one string each, and the context must carry one
value, so a missing translation has to fall back to something. Since
**2026-08-02** it falls back down a DECLARED chain
(`src/core/resolve/lang_fallback.ts`), first hit wins:

    requested lang → its linguistic alias → install default app lang
      → MASTER_SOURCE_LANG → any non-empty entry

PHP took `items[0]` — whatever lang the column's stored order happened to put
first. Stored order is alphabetical by lang code, so an lg-spa install was served
the GERMAN `tool_indexation` description: lg-deu merely sorted first among the
langs that DID exist, and the same missing translation resolved to a different
language depending on which OTHER translations were present. Divergence entry:
`engineering/wire_contract/WC-2026-08-02-tool-string-lang-fallback.md`; gated by
`test/unit/tool_string_lang_fallback.test.ts`.

The chain mirrors the global UI-label catalog's
(`src/core/labels/catalog.ts`) so the two label stores degrade the same way. It
makes a missing translation less VISIBLE, so it does not remove the obligation to
translate: a tool's `dd612` should carry every application lang the install
serves, in the `register.json` seed.

## Scaffolding

`bun run scripts/create_tool.ts --name=tool_x --label="X" [--models=a,b]` copies
`tool_dev_template`, renames identifiers, and writes an authoring-format
`register.json`. The new tool is created but not registered — run the "Register
tools" widget to reconcile it.

## Cache invalidation

`src/core/tools/cache.ts::invalidateAllToolCaches()` is THE single entry point
(clears the registry reader, config caches, paths memo, and the loaded-tools
registry). Call it after any dd1324 / dd996 / dd234 write.

Two routes reach it, and between them they cover every write the engine makes:

- the section write chokepoint — `record_write.ts` and `delete_record.ts` call
  `fireSaveEvent(sectionTipo)`, whose switch maps those three tipos here;
- `importTools` invalidates for itself, because `writeRegistryRecord` calls
  `matrix_write` directly and never passes the chokepoint.

**TRIPWIRED** by `test/unit/tools_cache_invalidation.test.ts` — it is in the
tripwire index (`engineering/TRIPWIRES.md` = `scripts/verify.ts` TRIPWIRES), so it
runs on every `bun run scripts/verify.ts`, not only when a tools file changes. The
routing is asserted behaviourally (the memoized roots array and loaded-module Map
must be REBUILT after a dd1324/dd996/dd234 save event, and must NOT be after any
other section), and the entry point's totality at source level (every reset the
four cache-owning modules export is called from it) — the two caches with no
externally observable identity would otherwise be gated by nothing. It was
promoted to a tripwire on 2026-07-28: with the TTL gone (below), a missed hop is
permanent staleness, which is tripwire-grade.

Since the cutover the engine is the single writer, so this is invalidation-only:
there is no TTL and no restart-after-external-write rule.
`TOOLS_REGISTRY_CACHE_TTL_MS` / `config.tools.registryCacheTtlMs` survives in the
config catalog but is **read by nothing** — the coexistence-era S2-09 TTL it fed
was deleted with the PHP engine.

## Server-module coverage (2026-07-28)

**Not every tool package ships a `server/index.ts`** — the two lists below name
which do (no counts: the lists are the census, derived and gated). The ones
without have client code only (except `tool_rag`, grant-only, which ships no code — below): registration warns (`no server module: tool_request will refuse
this tool`) and dispatch refuses at gate 5 (`tool has no server module`,
`unauthorized_method`).

**None of those without one is a gap, and that registration warning is INFORMATIONAL, not a
TODO** (2026-07-28 audit — the opposite reading is what produced a whole wrong
starting premise). A tool needs a server module only if it has a remote surface,
and these do not: **no client-only tool posts `tool_request` at all**, while every
server-backed tool does — a clean bimodal split, gated by
`test/unit/tools_spec_sync.test.ts`. The PHP oracle agrees: every PHP-era twin declared
`public const API_ACTIONS = [];` verbatim. They reach the server through the core
APIs (`dd_core_api`, `dd_ts_api`, `dd_diffusion_api`, `dd_mcp_api`) plus the
framework action `dd_tools_api::user_tools`; `tool_qr` never leaves the browser.
So do NOT "finish" one by scaffolding a server module — adding an unreachable
`apiActions` map is new attack surface, not coverage.

WITH a server module: `tool_bibliography_acquisition`, `tool_dev_template`,
`tool_error_report`, `tool_export`, `tool_hierarchy`, `tool_identify`, `tool_image_rotation`,
`tool_import_dedalo_csv`, `tool_import_files`, `tool_import_marc21`,
`tool_import_rdf`, `tool_import_zotero`, `tool_lang`, `tool_lang_multi`,
`tool_media_versions`, `tool_numisdata_acquisition`, `tool_ontology`, `tool_ontology_parser`,
`tool_pdf_extractor`, `tool_posterframe`, `tool_propagate_component_data`,
`tool_sitebuilder`, `tool_tc`, `tool_time_machine`, `tool_transcription`,
`tool_update_cache`, `tool_upload`.

WITHOUT one: `tool_assistant`, `tool_cataloging`, `tool_dd_label`,
`tool_diffusion`, `tool_indexation`, `tool_numisdata_epigraphy`,
`tool_numisdata_order_coins`, `tool_print`, `tool_qr`, `tool_rag`, `tool_subtitles`,
`tool_tr_print`, `tool_user_admin`.

`tool_rag` is the first GRANT-ONLY tool (2026-10-01, TOOLS-4): a registry row with
no client, no stylesheet and no server module (`properties.grant_only: true`),
which exists to be granted in the profile editor and asked by an engine door —
`dd_rag_api` `ask` calls `assertToolGranted(principal, 'tool_rag')`. The UI
gates (the phone ratchet, one entry sheet per tool) exempt it by that
declaration; the grant-only law that keeps the declaration true is in
`tools_register_validate.test.ts`.

Two of the 13 additionally carry core wiring a reader would otherwise look for in
the (absent) module: `tool_diffusion`'s availability has a core fallback in
`registry.ts` (the diffusion section-map walk), and `tool_user_admin` is the
install's only `always_active` tool. `tool_user_admin`'s server-side rules are
not a tool surface either — the dd128 own-record permission table lives in
`src/core/security/permissions.ts` (`resolveOwnUserRecordPermission`), enforced
at the read stamp and at the `dd_core_api::save` write gate.

The registry can hold MORE rows than there are directories — a dd1324 row whose
package is gone is legal and is what the panel's `on_disk:false` flag exists for
(the live install carries one). It is inert at dispatch: gate 5 refuses it.

### tool_hierarchy — a tool that OWNS no logic (2026-07-14)

`tool_hierarchy` is the reference for a tool whose handler sequences **nothing**. Its two
actions are a read and a write over an invariant that lives in the core:

| action | gate | core |
| --- | --- | --- |
| `inspect_hierarchy` | `targets` over `hierarchy1/<section_id>`, minLevel 1 | `inspectHierarchy` — the checklist the client renders as its status panel |
| `generate_virtual_section` | `targets` over `hierarchy1/<section_id>`, minLevel 2 | `ensureHierarchy` (idempotent converge); `force_to_create` → `rebuildHierarchy` |

Both gates are bound to the record the core is PINNED to — `hierarchy_state.ts` takes only
the id and writes `hierarchy1` by constant — never to the `section_tipo` the client sends,
which the writer ignores (audit CARRY-08; `action_scope_binding_native`).

Both live in `src/core/ontology/hierarchy_state.ts`, which is the **single writer** for
hierarchy consistency (`test/unit/hierarchy_single_writer_tripwire.test.ts`). The tool used
to sequence provisioning + root seeding itself, and that is precisely how it broke: three
call sites (this tool, the installer's activation, `ontology_write`) each established a
different subset of the same invariant and none checked the end state. **A tool is a gated
door onto a core operation — when a handler starts ordering steps, the invariant it is
building has no owner.**

### tool_ontology_parser — the same pattern for `dd_ontology` (2026-07-15)

The runtime ontology (`dd_ontology`) is a projection of `matrix_ontology`; keeping them
consistent lives in `src/core/ontology/ontology_state.ts`, the single reconcile authority
(`test/unit/ontology_single_writer_tripwire.test.ts`). The tool gates and surfaces it:

| action | gate | core |
| --- | --- | --- |
| `inspect_ontologies` | `developer` | `inspectOntology` — per-TLD drift (missing/stale/orphaned); the status panel |
| `reconcile_ontologies` | `developer` | `ensureOntology` — incremental, non-destructive (the default) |
| `regenerate_ontologies` | `developer` | `rebuildOntology` — transactional wipe-and-rebuild |
| `export_ontologies` | `developer` | the `data_io.ts` export pipeline; the per-TLD `exportToFile` dumps run bounded-parallel (≤ `EXPORT_CONCURRENCY`), the info/private-lists/LLM-map steps stay sequential |

The retired `regenerateRecordsInDdOntology` wiped a TLD with a leftover `dd_ontology_bk` table
as its only, untested, rollback — the same shape as the hierarchy defect: a destructive write
that no invariant owned. Note the two design axes together: `tool_hierarchy`'s invariant is a
FIXED checklist (ten conditions), while `tool_ontology_parser`'s is a RECONCILIATION (a diff
against a source) — so its `ensure` applies only the delta and is FAST on the common case,
where the hierarchy `ensure` converges a fixed shape.

## Files

- Machinery: `src/core/tools/{module,types,ontology_map,registry,paths,loader,security,dispatch,config,cache,background,job_status,register,register_schema,section_tool_context,import_wire}.ts` + `client/`.
- Serving: `src/core/tools/serving.ts`, wired in `src/server.ts`.
- Dispatch entry: `src/core/api/dispatch.ts` (`dd_tools_api` + the get_element_context tool branch).
- Widget: `src/core/area_maintenance/widgets/register_tools.ts`, dispatched by
  `src/core/area_maintenance/widgets/registry.ts` behind
  `dd_area_maintenance_api::widget_request`
  (`src/core/api/handlers/dd_area_maintenance_api.ts`). There is no
  `src/core/resolve/widget_request.ts` — earlier revisions of this doc named one.
- Scaffolder: `scripts/create_tool.ts`.
- Machinery tests (`test/unit/`): `tools_dispatch` (the 8 gates), `tools_security`,
  `tools_record_tipo_permission`, `tools_path_confinement`, `tools_static_serving`,
  `tools_loader`, `tools_spec_sync` (this document's facts),
  `tools_cache_invalidation` (a TRIPWIRE), `tools_config`, `tools_background`,
  `tools_register_validate`, `tools_register_write`, `tool_request`,
  `tool_job_status`, `tool_dev_template` (the exemplar's contract),
  `tool_context_labels_lang`, `section_tool_context`, `user_tools_nonadmin`,
  `register_tools_widget`, `register_tools_panel`, `dd_tools_api_stream_headers`,
  `local_db_stores_tripwire`.
- Machinery parity (`test/parity/`): `{user_tools,section_tools,component_tools,tool_element_context,tools_register,section_tool_start,tool_component_read}_differential.test.ts`.
  Per-tool differentials (e.g. `tool_export_*_differential`) live with their tool, not here.
