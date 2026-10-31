# WC-2026-10-30-section-record-row-box — the section/portal row box: one row node per entry, a bounded edit-safe window, absolute sort keys

- **Date:** 2026-10-30 (spec approved; owner rulings 2026-10-31). Landed in
  stages: the pure window module and its hermetic gate first (stage 2, this
  entry's first commit); the views adopt it in one atomic series (stage 5);
  the CSS removals that assume it follow (stage 6). Each stage that changes the
  contract below appends an addendum here.
- **Decision:** DEC-07 (the page is bounded; `max_page_limit()` stays the
  ceiling) and DEC-12 (every invariant lands with its gate:
  `test/unit/client_record_window_native.test.ts` — hermetic, fake DOM — for
  the module; the row-DOM tripwire, the render-budget rewrite and the browser
  suites `test_row_invariant` / `test_portal_row_drag` join with stage 5).
  Builds on `WC-2026-09-04-client-limit-bound` (row_window) and
  `WC-2026-10-30-sort-data-key-range` (the server refuses out-of-range keys).

## Shape before (PHP)

The client half of the get_dedalo_files manifest (the service-worker
pre-cache list) has no `section_record/js/record_window.js`. The row DOM it
describes did not exist either:

1. **No row box.** A list row was a `display:contents` `section_record`
   inside a `display:contents` `content_data`; the grid tracks belonged to
   `list_body`. `content_data` also held two `row_window` spacers
   (`.row_window_spacer`, `grid-column: 1/-1` inline), the `no_records` node,
   the portal `references` list and footers, so `content_data.children[i]`
   was NOT row i and every consumer walked `childNodes` or kept its own
   index → node map (`row_window.node_of`, the mosaic `companions` Map, the
   cataloging `drag_nodes` Map).
2. **Custom materialize.** The mosaic, line and TM views built their own
   row DOM (tile + hover overlay + alt-table row per entry) behind
   `window_section_rows({materialize, release})`.
3. **Edit safety by accident.** A release, a `refresh({destroy:true})` and
   most row-set operations destroyed rows through `destroy()`, which
   deregisters the instance from the unsaved registry: a pending edit was
   dropped silently. A `destroy:false` refresh adopted the cached instances
   and leaked the previous window.
4. **Sort keys double-counted the offset.** `drag_and_drop.js` sent
   `target_key = paginated_key + paginator.offset`, but `paginated_key` is
   already absolute (`relation_core.ts`), so every reorder on page 2+ addressed
   the wrong item.

## Shape after (TS)

- **Manifest:** `/dedalo/core/section_record/js/record_window.js` is served
  (ADDITIVE; the PHP side has no such file).
- **Row invariant (every N, N=0 included):** `content_data.children` holds
  exactly N `.section_record` elements in index order, `children[i]` is row i
  with `data-index="i"`; nothing else sits in `content_data`. Non-row
  children (references, footers, `no_records`, the render-error node, the
  print notice) live in ONE `.list_after` sibling after `list_body` (never
  inside a `role=table`).
- **Bounded window:** `record_window.js` (`create_record_window`) builds
  `min(N, ROW_WINDOW_MAX_ROWS)` rows; above the bound the rest are
  PLACEHOLDERS — `<div class="section_record placeholder" data-index role
  aria-hidden="true">`, childless, listener-free leaves sized by
  `--row_size` / `--placeholder_size`. At N ≤ the bound no placeholder and no
  observer exist (a failed build is the one exception: a placeholder with
  `data-failed`, retried by `reveal`). One IntersectionObserver, created only
  above the bound, builds rows in reach and releases the farthest unpinned
  rows down to EXACTLY bound − margin (hysteresis: a scroll past the bound
  releases a margin's worth at once, never one row per step); built ≤ bound +
  pinned. The window owns its `content_data`: a
  container handed in non-empty THROWS (every lookup is `children[i]`, so a
  leftover child would shift every index and a release would replace a
  foreign node). Every per-index step runs on one serialized queue; a step
  that throws is logged once, and a flush that throws inside a release or a
  `rebuild` leaves the row BUILT and pinned (never half-released). That throw
  pin is sticky — the window never retries a throwing binding on its own; a
  clean `flush(i)` / `rebuild(i)` by the door lifts it. `destroy()` tears the
  window down (observer, listeners, generation++, instance map) even when its
  flush throws, then rejects. `retire()` with a throwing flush has no verdict
  either: it clears the instance map (the window was already stopped and its
  generation bumped), destroys NO row — any of them may hold a dirty instance;
  they stay in the owner's `ar_instances` for its cascade, the same contract as
  a throwing `destroy()` — logs once with the kept count, then rejects.
- **Purity (no page coupling):** the module imports only the three
  `row_window.js` constants and reads no ambient page or DOM global: its free
  identifiers are language builtins, `console`, and ONE `globalThis` (the
  `defaultView` fallback); the DOM is reached only through
  `container.ownerDocument` (`doc`: `activeElement`, `createElement`,
  `createDocumentFragment`, `defaultView`) and its `defaultView` (`view`:
  `Event`, `IntersectionObserver`, `requestAnimationFrame`,
  `cancelAnimationFrame`). Gated by a scope-resolved free-identifier census,
  so a `page_globals` / `document` / `window` read on a branch no test
  executes is still red.
- **Edit safety (no silent loss):** a row is never released while it holds
  focus, a hold, the active component, an unsaved instance, an uncommitted
  editor node, the live autocomplete, a saving/changing instance, `:hover` or
  `.dragging`. Before any row is removed its typed-not-committed editor nodes
  are committed by a synthetic `change` + `blur`, and a node whose instance's
  `commit_seq` did not advance is PENDING (judged by outcome, never by
  registry membership) and stays registered. A failed or pending flush is a
  VERDICT, not a standing pin: the row stays built while the live checks still
  see its pending node / unsaved instance, and every release attempt re-flushes
  it — re-settling each instance whose settle failed in that row, even one that
  has since left the unsaved registry — and releases it only when that flush is
  clean. A transiently dirty row therefore becomes releasable again once its
  value is committed and saved (a sticky pin would accumulate pinned rows above
  the bound for the window's lifetime). The pin verdict is taken before the
  release flush AND again after it: the flush awaits (a re-settle can be a
  network save), and a row the user came back to meanwhile — focus, a hold, a
  new active / unsaved / uncommitted edit, the row back in reach — stays built
  with nothing in it destroyed. `rebuild(i)` likewise re-checks the edit pins
  (active, unsaved, uncommitted, autocomplete, saving / changing) after its
  flush and refuses on one; holds, focus, hover and reach do not refuse an
  explicit rebuild. The active component is deactivated BEFORE it is settled:
  `ui.component.deactivate` is what turns its last change into a save, so a
  settle first would answer clean before that save exists. A failed save is orphaned (alive,
  registered, out of the instance cache), never destroyed. Supersession of a
  window computes its destroy set AFTER its flush, so an instance the new
  window took from the instance cache is never destroyed — nor is one a late
  build of the old window resolves after the new window adopted it (the
  instance cache hands the SAME section_record to both).
- **Row semantics:** `role=table` / `rowgroup` / `row` / `cell` (table
  layouts, optional header row `row` + `columnheader`), `list` / `listitem`
  (list layouts); `aria-rowcount` / `aria-rowindex` (or `aria-setsize` /
  `aria-posinset`) only while placeholders exist; at N=0 the rowgroup role is
  removed and a header-less table drops `role=table`.
- **Client sort-key rule:** write keys are `rows[i].paginated_key` of the
  window's frozen entries — absolute; `paginator.offset` is NEVER added, and
  instance fields (`section_record.paginated_key` / `row_key` / `locator`) are
  never read for writes (they go stale on cache reuse). A drag payload carries
  the owner-monotonic `window_generation`; a payload from a superseded window
  is refused client-side as stale. (Lands with the drag core, stages 3/5.)

## Reason

The client is the consumer of the row DOM it builds, and every downstream
contract depends on `children[i]` being row i: delegated drag/drop and hover
(one listener set per `content_data`, resolved by `row_of`), the row a11y
semantics axe requires, the subgrid row box the CSS needs, and the absolute
key a reorder must send. The unbounded page (DEC-07 allows 1000 rows) must
stay bounded in the DOM without ever dropping an edit the user typed.

## Gate reconciliation

- `test/parity/dedalo_files_differential.test.ts`: `record_window.js` is one
  more `POST_HARVEST_CLIENT_ADDITIONS` entry (filtered from the set compare on
  the TS side, asserted present on TS and absent on PHP — the WC-013 pattern).
  No re-harvest (impossible by definition, and not needed: the gate filters
  before diffing). Stage 5 adds `row_hover.js` the same way.
- `test/unit/client_record_window_native.test.ts` (new, hermetic): the
  invariant and bound for N ∈ {0, 1, 200, 201, 1000, 5000} incl. seeded
  randomized sequences, every pin kind, outcome-judged commit of uncommitted
  nodes (red-on-membership), the hover-overlay skip, freeze/thaw, orphan on a
  failed settle, retire adoption (red-on-old: fill-time destroy set), the
  owner-supplied generation, N=3→0, the import set (the `row_window.js`
  constants only) and a bound that FOLLOWS the imported constant (the module
  re-run against a scratch `row_window.js` fills to that bound — an outcome,
  not a literal census), failed/stale builds (incl. a late build the
  successor holds, which survives), the detached fill, destroy (incl. a
  throwing flush that still tears the window down), a throwing flush in
  release / `rebuild` (row stays built and pinned, sticky), the exact release
  target bound − margin (real and scratch constants), the pending verdict
  isolated from pin 5, and a failed / pending row becoming releasable once its
  value is saved / committed (red-on-sticky), the non-empty
  container refusal, the semantics sync, every edit-safety binding refused
  by name when absent (a census over the harness's bindings, floored), and
  the teardown races: `destroy()` during an in-flight release (the
  `'releasing'` row is in destroy's flush, so its failed settle is orphaned
  exactly once, never destroyed — a release that finds the window dead does
  not orphan, the teardown verdict does), and `rebuild(i)` resuming after a
  `retire` (the successor holds the row: never destroyed) or a `destroy`
  (the row's failed child is orphaned, the row never destroyed) — rebuild
  re-checks `dead` after its flush. Also: deactivate-before-settle on ONE
  shared call sequence (settle sees the deactivate-time commit); no row built
  twice while live and every superseded build destroyed exactly once (in the
  seeded randomized legs and a reveal / ensure_built leg); focusin builds both
  sides of ± margin, each a placeholder before; a pin appearing while the
  release flush awaits (hold, focus, active, unsaved, uncommitted, back in
  reach) keeps the row and an edit appearing while a rebuild flush awaits
  refuses it; a throwing retire flush destroys no row, clears the map, logs
  once and rejects; the purity census with planted positive controls
  (`page_globals`, `document`, `window`, a second `globalThis`, `view.*` /
  `doc.*` outside the allowlist, a same-named local elsewhere) on a branch
  the fake-DOM legs never run. Each guarded line was reverted once and the
  gate went red.
- `test/unit/client_render_budget_native.test.ts` stays unchanged at stage 2
  (no view door creates a window yet); it is rewritten in stage 5.

## Addendum 2026-10-31 — stage 4 (CSS additions): the WebKit header probe

- **WebKit subgrid-header probe: PENDING.** Under `.list_body.layout_table`
  the header is a column subgrid (`list.less` 'layout_table'); its
  `.head_column` cells keep the legacy overflow law (`overflow-x: clip;
  overflow-y: visible`, measured on the `display: contents` shape only). No
  view carries the marker before stage 5, so the probe — WebKit/Safari, a
  marked list, header height across pagination swaps — runs with stage 6 and
  its measured result is appended here. Until then the law is not lifted.
- 2026-10-31 (stage-4 review): this entry is the ONLY home of the probe status
  and of which views carry the marker — `test_section_list_header.js` links
  here instead of restating either.

## Addendum — stage 3: the delegated drag core (`drag_and_drop.js`)

- **One listener set per `content_data`**, registered on the row window's
  `AbortSignal` (`record_windows.rows.signal`), none per row:
  `bind_row_drag` (portal rows, source `'handle' | 'row'`, plus the
  dblclick/Enter move-to-position hook, which HOLDS the row as `'position'`
  until the modal's `release`), `bind_tool_row_drag` (the tool mosaics) and
  `bind_portal_drop` (the wrapper MOVE zone, one bind per wrapper). No view
  calls the binders yet: stage 5 wires them, and the browser suite
  `test_portal_row_drag` joins then.
- **One decision, one executor.** `decide_drop(self, payload, target_index)`
  is pure and answers `{kind:'reorder', value, source_key, target_key}` |
  `{kind:'move', locator}` | `{kind:'stale'}` | `null`. REORDER iff
  `payload.source_id === self.id` (never `tipo`: two instances of one tipo are
  two lists) and `can_reorder` (no `context.declared_order`, no `view_order`);
  MOVE iff another instance's `draggable_to` names this tipo and the target is
  writable (no target row needed). `perform_drop` executes; `on_drop` is the
  adapter of the touch path and the legacy per-node listeners.
- **Absolute keys** (the client sort-key rule above): `source_key` is the
  payload's `paginated_key`, `target_key` the target entry's; the offset is
  never added. Legacy kind-less payloads are upgraded with the LOCATOR's key,
  never the payload's top-level `paginated_key`, which the line/mosaic views
  set to the page index.
- **Stale refusal:** a payload whose `window_generation` is not the live
  window's is `{kind:'stale'}` — consumed (it must not bubble to an ancestor
  receiver) but never sent; the drop raises ONE `resource.conflict` warning.
- **Foreign guard:** the payload travels under `application/x-dedalo-portal-row`
  (plus a `text/plain` twin) with `kind:'dedalo_portal_row'`. A drag without
  that type, or one `decide_drop` answers `null` for, is never STOPPED (no
  `stopPropagation`), so it reaches its owner (ts_object term, file zone, outer
  portal). A FOREIGN drop (neither the portal type nor a payload that parses as
  a portal / legacy portal payload) is left wholly alone, no `preventDefault`
  either. An OWN payload that `decide_drop` refuses on DROP (same row, declared
  order, `view_order`, unwritable target, no row under the pointer) IS
  `preventDefault`'ed: otherwise the browser's default text drop inserts the
  payload JSON into the editable control under the pointer (a component
  `<input>` in the row), which the component then saves. preventDefault without
  stopPropagation blocks only that insertion; ancestors still decide. Touch
  decides on `touch_pick.peek()` before consuming, so a foreign pick survives a
  tap on a portal row.
- **Tool sources** are a shrink-only, reasoned list (`TOOL_ROW_SOURCES`:
  `tool_cataloging_mosaic`, `coins_mosaic`); their payload is `text/plain`
  only, never the portal type, so portal targets treat it as foreign.
- **A reorder that throws is UNCONFIRMED, not "not saved"**: `sort_data` saves
  and then refreshes, and the refresh can throw after a committed save; the
  client says the outcome is unconfirmed and asks for a reload.
- **Drag notices carry their own label.** `render_api_error.error_text`
  renders `get_label[label_key]` BEFORE the English `message`, and a `client.*`
  code derives a transport label (`client.bad_response` → "unreadable
  response"), so every notice passes `label_key` explicitly and never borrows a
  `client.*` code: stale → `resource.conflict` + `drag_list_changed`; a reorder
  the save path answered without an envelope error → `record.save_failed` +
  `drag_order_not_saved`; a reorder that threw → `idempotency.outcome_unknown`
  (the registry's "may already have been applied") + `drag_order_unconfirmed`.
  The three keys are translated in every catalog (`src/core/labels/`).
- **Legacy `on_dragover` asks the drop's decision.** Until stage 5 the views
  wire the per-node `on_dragover`; it accepts (preventDefault, stopPropagation,
  highlight) exactly when `decide_drop` — through the same adapter path as
  `on_drop` — answers non-null, and touches nothing otherwise. A target the
  drop refuses (declared order, `view_order`, own row, another instance of the
  same tipo, no target row) is never shown as droppable.
- **A window retired mid-drag releases the drag.** Retire aborts the window's
  signal, which also removes the binders' `dragend`; both binders register an
  abort listener that releases `tmp` and the `'drag'` hold when — and only
  when — that window holds the drag in progress.
- **Legacy, removed at stage 5:** `on_dragstart`, `on_dragstart_mosaic`,
  `on_dragover`, `on_dragleave`, `on_dragend`, `get_mosaic_transfer_data`,
  `legacy_portal_payload`, `legacy_target_index` — pinned shrink-only by the
  gate below. THIS LIST IS THE BANK: the gate's legacy set must equal it, and
  every top-level binding of `drag_and_drop.js` is classified (core export,
  core internal, legacy), so adding a legacy path means editing this entry.
- **Gate:** `test/unit/client_relation_move_native.test.ts` §I (hermetic,
  fake DOM, the real module).

## Addendum 2026-10-31 — edit-safety primitives

The component half of "edit safety (no silent loss)" above, in
`component_common.js` and `events.js`. Gate:
`test/unit/component_settle_native.test.ts` (hermetic; every leg was proven red
on its reverted line). Edit safety on REAL components (a typed-not-blurred
editor committed by the window flush, the per-editor synthetic-`change`
`commit_seq` census) is NOT gated there; it joins with the stage-5 browser
suites named above.

- **Finish-writing door.** `saving_promise` is present iff a save is pending
  (assigned after the concurrency guard; the pre-guard exits never replace it;
  a recovered re-login retry chains the outer promise). `change_value_promise`
  is present iff a `change_value` runs. `commit_seq` advances synchronously at
  the entry of `change_value` and `set_changed_data` and on nothing else.
  `settle()` awaits all of them, flushes what is left once, and answers whether
  the instance is still registered as unsaved.
- **A failed save registers.** It keeps what it did not persist in
  `failed_changed_data` (merged, never replaced; mirrored to
  `data.changed_data`; it survives a refresh) and registers the instance as
  unsaved. Every later save of the instance sends those items FIRST in the same
  request, so a later successful edit never retires an earlier failed one
  unsent. The no-change short-circuit cancels only an all-`update` batch. A
  `component_password` is registered without keeping its value.
- **Orphans.** A dirty instance whose `settle()` failed is orphaned, never
  destroyed: out of its caller's `ar_instances` and the instance cache (only
  when the cache entry is itself), renamed id, OFF the event bus (a sibling's
  `sync_data_` would otherwise refresh it and empty its edit), counted by the
  unsaved guard on its own, swept by `save_unsaved_components`. The set and its
  two writers are module-private in `events.js`; other modules get a frozen
  read-only view. The writers leave `events.js` only as a capability handed out
  ONCE (`claim_orphaned_unsaved_writers`), which `component_common.js` claims at
  load: any second claimant throws, whatever spelling it reaches the export by.
  A source scan of every served client root (the client tree and each tool
  root) backs it: no module but the two owners names a writer.
- **Supersession (last handed-over edit wins, PER ITEM).** Within one field
  (`id_base` + `lang`), every save (live or orphan) compares its items with the
  pending items of the other instances of the field, right before the request:
  - an outgoing item that a NEWER pending item overlaps is not sent and leaves
    the sender's pending sets;
  - an OLDER pending item that an outgoing item overlaps is retired with a
    console warning — every pending item of an orphan, only the
    `failed_changed_data` of a live sibling (its unsent edit of its own is on
    screen, the user's). An instance left with nothing pending is
    deregistered; an orphan is retired and destroyed. An orphan registered
    without items (a `component_password`) is retired by any save of its field.
  - **Overlap** is per target, because the server applies `update`/`remove` by
    item id (or entries key), `insert` by locator, and `add_new_element` /
    a literal `insert` as an independent append: those items overlap only
    when they name the same target. `set_data`, `clear`, `sort_data`,
    `sort_by_column` and any unknown action act on the whole field and
    overlap everything. A failed edit of value id=1 therefore survives a newer
    save of value id=2 (and an insert of locator X one of locator Y): a retry
    of it writes nothing the newer edit wrote.
  - **Newer** is the hand-over order: each item is stamped (page-wide
    sequence) when the edit-safety code first sees it — `set_changed_data`,
    the save that first sends it, an orphaning, or a supersession scan (the
    other instances' unseen items are stamped before the outgoing ones). A
    retry keeps its original stamp, so a resent older failed edit never
    supersedes a newer failed one, whatever order a sweep reaches them in.
  Reason: the rebuilt row shows the server value and the user edits THAT;
  resending an older edit of the same target later would overwrite the newer
  one with no warning — and retiring an edit of another target would lose a
  user edit that was never persisted.
- **A revert is not an edit.** When `set_changed_data` finds an item back at
  its stored value, that item and every older pending item of the SAME target
  (a failed edit of it included) leave `changed_data`; the instance is
  deregistered only when nothing else is pending. `failed_changed_data` and
  `data.changed_data` are separate arrays (the mirror is a copy), so an edit or
  revert of another item can never rewrite the failed set.
- An orphan leaves only through its own successful save, a supersession, the
  sweep finding nothing left to send (never a password orphan), or
  `reset_unsaved_data` (the user's discard); it is destroyed then.
