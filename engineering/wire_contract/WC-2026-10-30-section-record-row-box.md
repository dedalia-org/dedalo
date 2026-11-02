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
- **Legacy, removed at stage 5:** none remain. Stage 5 (2026-10-31) deleted
  the per-node dragstart/dragstart-mosaic/dragover/dragleave/dragend listeners,
  the kind-less mosaic payload builder, and the kind-less payload upgrade and
  page-key target reading of the drop adapter; every portal view binds through
  the delegated binders — pinned shrink-only by the
  gate below (now at zero). THIS LIST IS THE BANK: the gate's legacy set must equal it, and
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

## Addendum 2026-10-31 — stage 5 (atomic integration): the gates

- **`test/unit/client_row_dom_tripwire.test.ts`** (new, hermetic, isolated
  gate; registered in `engineering/TRIPWIRES.md`, `scripts/verify.ts` and
  `scripts/ci/hermetic.sh` `HERMETIC_TRIPWIRES`). Its scope is DERIVED: every
  browser source that imports the row engine (`window_section_rows` of
  `section.js` bound through the served tree, or `record_window.js`) plus the
  two named drag modules (`drag_and_drop.js`, the coins tool render). Legs:
  - every banned spelling of the old row DOM is gone from the scope
    (`content_data.childNodes`, `content_data[0] =`, `node_of(`, `materialize:`,
    `drag_nodes`, `get_section_records(`, `add_section_record_drag_and_drop`,
    `closest('.section_record')`, a per-row listener without the window
    `signal`, a row node's `paginated_key` / `row_key` / `locator` read in drag
    code, `paginator.offset` outside the navigation owners, a render / refresh
    of a `record_at(` row) — each with a planted positive control;
  - `record_window.js` imports only the `row_window.js` constants;
  - the ROW DOM INVARIANT, run: every door-importing `view_*.js` (a coverage
    leg fails on a view with neither a case nor a named exemption; the
    exemption list — `view_text_list_portal`, `view_mini_portal`,
    `view_indexation_list_portal`, `render_search_component_portal`, inline /
    search shapes — is shrink-only) rendered over a counting fake DOM with the
    REAL `record_window.js`, `common.js`, `row_hover.js` and `drag_and_drop.js`
    at N ∈ {0, 3, 201}, full and content render: `children === N`, every child
    a `.section_record` of its index, `N − 200` childless placeholders, no row
    listener, roles by layout after the connected frames, `.list_after` the
    single sibling after `list_body` / `content_data` and never inside
    `role=table`, references and no_records inside it; `place_list_after` a
    strict no-op without pointers and the `common.render` content branch
    calling it;
  - LESS: no `--box_width`, no `.row_window_spacer` outside ts_object, no
    `display: contents` on the base section's content_data, no subgrid without
    the `.layout_table` chain, no `overflow` clip and no list-body `z-index`
    on the row chain. Six live rules are banked by EXACT spelling in
    `LESS_PENDING` (reason: the stage-6 removals of this entry — four
    `.row_window_spacer` rules of `list.less`, two `--box_width` rules of
    `section_record.less`); a banked rule that is gone is red, so the bank
    only shrinks.
- **`client_render_budget_native`** rewritten for the record window (import
  binding of `window_section_rows`, the destroy order through
  `destroy_row_windows`); **`client_tm_list_destroy_race`** asserts
  `mark_empty_columns` on the row render and its destroyed-row path;
  **`client_control_naming_tripwire`** builds the row-box chain
  (`list_body[table] > content_data[rowgroup] > section_record[row] >
  .column[cell] > wrapper[group]`) through the real `apply_table_semantics`
  and asserts the table label never names a column control.
- **Browser suites** (`bun run test:client`, registered in `test_registry.js`):
  `test_render_budget` (section / portal edit / tool-mosaic blocks rewritten
  to `record_windows.rows`: `children === entries`, built ≤ 200, leaf
  placeholders, `ar_instances` = built, `reveal(n)` in place, a far scroll
  releasing rows, `record_windows === null` after destroy, tool-mosaic drag
  source + touch pick + the cataloging card reaching a `ts_object` term drop;
  the pure `row_window` and tree blocks byte-identical), `test_row_invariant`
  (new), `test_portal_row_drag` (new; the 360px handle hit-test is stage 6),
  and `a11y_surfaces.js`: the two CLI-10 row surfaces take the row-box chain,
  and five row surfaces filled by the REAL window — `row_table`, `row_list`,
  `row_table_placeholders`, `row_table_empty`, `row_table_empty_no_header` —
  join `engineering/client_a11y_budget.json` `required_surfaces`.
- **Floors to bank before this addendum's commit** (measured, never
  hand-written; both are outside a hermetic run):
  - unit per-file floors, in the locked image: `bun run ci:local --docker
    --record-unit-baseline --new
    test/unit/client_row_dom_tripwire.test.ts,test/unit/client_modal_before_close_native.test.ts,test/unit/client_row_lock_hover_native.test.ts,test/unit/tool_numisdata_order_coins_drop_native.test.ts,test/unit/client_record_window_native.test.ts`,
    plus a re-record of the reshaped `client_relation_move_native`,
    `client_render_budget_native`, `client_tm_list_destroy_race`.
    Until then `tier_wiring_tripwire` (leg B) and the db tier's
    `unit_baseline.ts --check` are RED by design, naming exactly these files;
    `engineering/unit_baseline.json` lands in the same commit as the gates;
  - client inventory: a green `bun run test:client` (reseed on), then
    `--update`, so `engineering/client_gate_inventory.json` `suite_floor` /
    `mocha_test_floor` include `test_row_invariant` and `test_portal_row_drag`.

## Addendum 2026-10-31 — stage 5: the WebKit hover/drag probe (owner ruling 9)

- **Measured** (the one-off manual WebKit probe, owner ruling 9 of
  2026-10-31): Playwright WebKit 2370 against the REAL compiled `main.css`, a
  `.layout_table` list. When the ring `::after` was generated only by the
  state rules (`:hover` / `.dragover` / `.dragging` set `content`,
  `position`, `inset`), WebKit re-sized the hovered subgrid row's tracks
  alone: **165 cells left the table's columns during 5 hovers**. Chromium:
  **0**. Fix (`list.less`, the ring block): the `::after` is generated by a
  STATELESS rule in every state (`border: 2px dashed transparent`), and the
  states change paint only (`box-shadow`, `border-color`). After the fix
  WebKit: **0** cells off their column over the same hovers, and **0** across
  the `.dragover` / `.dragging` toggles. This is the probe's evidence for
  hover and drag; the **post-pagination header-subgrid probe** (stage-4
  addendum above) stays manual and PENDING.
- **Gate:** `test/unit/client_row_dom_tripwire.test.ts` — CSS STATE leg,
  reading the COMPILED `client/dedalo/core/page/css/main.css` (at-rule
  context kept): a selector carrying `.layout_table` positively whose subject
  is a row or a row's direct child, with `:hover` / `:focus-within` /
  `.dragover` / `.dragging` / `.selected` on either, sets no `content`,
  `display`, `position`, `inset` (nor its longhands); every pseudo-element it
  styles is generated (`content` not `none`/`normal`) by a stateless rule of
  the same at-rule context matching a superset of its elements. Planted
  controls: the pre-fix ring shape is red (9 box + 4 ungenerated findings),
  the fixed shape green; the pre-fix `list.less` compiled through the real
  `css:build` reds the live leg (restored after). Honest limit: unmarked
  generic row rules are outside the leg (measured: none sets a box property
  on a state today).
- **Browser half:** `test_section_list_header` (ring test) holds the same law
  in the resolved cascade: at rest the ring `::after` is generated
  (`content: ""`, absolute) and paints nothing; a hover arm on a pseudo counts
  as a ring when it paints it (`box-shadow` / `outline` / `border-color`), not
  only when it sets `content`.

## Addendum 2026-11-01 — stage 6: CSS removals, phone portal cards

- **Removals landed** (§5 "Removed"): the `list.less` spacer selector,
  `.alt_list_body`, `.hilite_row`, the hilite-compensating cell overrides
  (`box-shadow: none` / radius 0 / `height: auto`) and the invalid `::empty`.
  KEPT, still matched by live DOM (mosaic tiles, list portals with mosaic/text
  rows, nested tables on phone): the per-cell edge `::after`, the header
  border, the `.column` box-shadow and the Id cell's `margin-top: 1px`;
  `section_record.less` `--box_display`/`--box_width` `::after`;
  `component_portal.less` `.drop` / `.draggable.dragover` (wrapper class now
  `.drop_target`); the mosaic `>.hover_body` / dead / `.mosaic_over` rules;
  `view_indexation_portal.less` `::empty`; the unconditional
  `view_content_portal.less` header-row rule; the dead `top:0` in
  `layout.less` / `tool_time_machine.less`; `view_default_list_section_record.js`
  `hilite_row` + its `when_in_dom` registration. `client_row_dom_tripwire`
  `LESS_PENDING` is EMPTY, ceiling 0: every LESS leg reds on any violation.
  The overflow / subgrid / z-index legs judge each complex selector of a list
  separately (no member hides behind the last), and compounds split on
  top-level combinators only (`:is(a, b)` stays whole; a name inside
  `:is()`/`:where()` claims no exemption).
- **Phone portal cards (owner-approved, §11):** the `list.less` 'PHONE CARDS'
  rules key on `.list_body.layout_table` (top level only), so a portal table
  and every portal-aliased model (`component_relation_related` …) render the
  same labelled cards as a section list. Card labels are attached for every
  caller (`attach_card_label`), no longer only `caller.model === 'section'`.
  The label is CSS string text: escaped (`\`, `'`, `"`, control characters)
  before `ui.make_column_responsive`, since css.js `process_rule` interpolates
  `content` raw between single quotes (an apostrophe dropped the label; a
  crafted label added declarations).
- **Phone handle:** under `.list_body.layout_table` below the breakpoint the
  default-view `.drag.icon` is in flow inside the Id cell, `opacity: 1` at
  rest; `.column_section_id` carries no overflow clip there. The card's trash
  cell keeps its button beside its label (no page wider than the screen).
- **Gates:** `test_portal_row_drag` 360px legs — handle opacity 1 at rest,
  static, Id cell `overflow: visible`, `elementFromPoint` at the handle centre
  is the handle, every card cell child inside the card, every value cell
  labelled (default portal and `component_relation_related`), and the label
  escaping leg (apostrophe / backslash+quote / crafted label through the real
  `render_column_node_callback`).
- **WebKit header-subgrid probe after pagination (manual, owner ruling §11.9) —
  DONE 2026-11-01, Safari 26.6.2 (AppleWebKit/605.1.15, macOS).** A
  `.list_body.layout_table` (header row + `content_data` subgrid, the compiled
  `main.css`), paginated five times by `content_data.replaceWith(new)` with
  different cell widths (incl. a 2-row and an all-empty page): every
  `.head_column` x/width equals its column's cells within 1px (0 misaligned
  cells) and the header height is stable (26px on every page). Same result in
  Chrome. Playwright's bundled WebKit could not open a page on the host, so
  the probe ran in Safari itself (self-running page, verdict read by the owner).
