# section_list

> The **client-side list view** of a section: the `list` rendering mode of the
> `section` JavaScript instance that turns many records of one `section_tipo`
> into a paginated, sortable column grid of rows.

> See also: [section (reference)](section.md) · [sections (server collection concept)](sections.md) · [section_record](section_record.md) · [Components](../components/index.md) · [paginator](../ui/paginator.md)

This page is the **subsystem reference** for *section list*. "section_list" is
**not a class or module** — there is no `src/core/section/section_list.ts`
section class. It is the `list` **mode** of the client `section` instance
(`client/dedalo/core/section/js/section.js`) and the family of `render_list` /
`view_*_list` files that draw it. On the server the records it shows are
produced by the read engine (`readSection` / `readSectionRows`,
`src/core/section/read.ts`); the client `section` instance fetches that payload
and renders it.

!!! note "Three things called 'section'"
    Keep the distinction straight. The [`section`](section.md) concept is the
    *type*; [`section_record`](section_record.md) is one *row*;
    [`sections`](sections.md) (plural) is the *collection* concept that runs
    the search. On the client there is a single `section` constructor
    (`section.js`) whose **mode** (`list` / `edit` / `tm` / `solved`) decides
    whether it draws a list of many records or one editable record.
    *section_list* is that client `section` running in `list` mode.

## Role

The list view sits at the boundary between the server's multi-record read
engine and the DOM:

| layer | element | role |
| --- | --- | --- |
| server read engine | `readSection` / `readSectionRows` — `src/core/section/read.ts` | run the navigation [SQO](../sqo.md) (via `pickReadSource` → the search engine or the Time Machine source), return the matching `(section_tipo, section_id)` rows |
| server envelope | built inline in `readSectionRows()` | turn the rows into one `entries` array of locators + a de-duplicated `context[]` (see [`sections`](sections.md#the-sqo-normalization-contract)) |
| client model | `section` instance in `list` mode (`section.js`) | holds the `datum`, `rqo`/`sqo`, `columns_map`, `paginator` and `filter`; owns navigation/pagination/sort |
| client render | `render_list_section.list` → `view_*_list_section` | builds the row-box table: a header row + one [`section_record`](section_record.md) row per entry, placed by the record window (see [The row box](#the-row-box)) |

A list view never reads the database and never resolves a single field itself.
It asks the API for a page of locators, hands them to a record window that
instantiates one client `section_record` per locator it builds, and lets each
record render its own columns. Where the
[`section` edit mode](section.md) shows **one** record with all its components,
the list mode shows **many** records, each collapsed to a configured set of
**columns**.

```text
readSection() / readSectionRows()   ── SQO ──► search engine ──► rows
        │                             (src/core/section/read.ts)
        │  builds envelope inline: {typo:'sections', tipo, section_tipo:[], entries:[…]}
        │  JSON API { result: { context, data:[{ typo:'sections', entries:[…] }] } }
        ▼
section instance (list mode)  ── self.data.entries  +  self.columns_map  +  self.paginator
        │
render_list_section.list ──► view_default_list_section.render
        │                         ├─ header row  (ui.render_list_header)
        │                         └─ window_section_rows → record_window
        │                              one section_record row per entry (≤ 200 built, placeholders beyond)
        ▼
DOM:  wrapper_section > [ list_body.layout_table > [ header_wrapper_list | content_data > section_record × N ]
                         | list_after ]
```

## Responsibilities

- **Fetch a page of records.** Build the `rqo`/`sqo` (limit / offset / filter /
  order), call the API `search` action through `build_autoload`, and store the
  resulting `entries` (locators) in `self.data`. Server-side, `readSectionRows()`
  applies the limit-defaulting rule: `edit` → 1 record, `list` → 10 rows when the
  client sends no explicit limit (see
  [`sections`](sections.md#the-sqo-normalization-contract)).
- **Build the columns model.** Derive `self.columns_map` from the section's
  `request_config` `show.ddo_map` (`common.get_columns_map`, client-side) and
  prepend the fixed `section_id` control column (`rebuild_columns_map`).
- **Render the grid.** Lay out a CSS-grid `list_body.layout_table` whose
  `grid-template-columns` is computed from the columns' widths
  (`ui.flat_column_items`), draw the header (`ui.render_list_header`), and hand
  the page's entries to the row door (`window_section_rows`), which places one
  `section_record` row per entry — see [The row box](#the-row-box).
- **Render the `section_id` control column.** Per row, draw the id cell with the
  edit / delete / link / tool affordances appropriate to permissions and caller
  (`render_column_id`).
- **Paginate.** Own a [`paginator`](../ui/paginator.md) caller contract
  (`get_total()`, `rqo.sqo.limit`/`.offset`, `update_pagination()`,
  `navigate()`) and persist the page state to the local DB.
- **Sort.** Expose sortable column headers (`ui.allow_column_order` /
  `add_column_order_set`) that mutate the SQO `order` and re-navigate.
- **Search.** Host the section's [`search`](../sqo.md) filter
  instance (`self.filter`) and the *Search* / *Show all* buttons — plus, when
  the searched section declares RAG [embed groups](../ai/rag_cookbook.md#r1--opt-a-section-in-the-section_map-ragembed-groups-2026-07-22),
  the **"Search by meaning" quick input** (semantic search: ranked results pin
  the list via `filter_by_locators` + the `locator_position` order) and the
  **pinned chip** — an SQO-derived status ("N results pinned" / "no matches" /
  "semantic unavailable") with a ✕ that clears the pin. The chip derives from
  the SQO, not client memory, because pins persist in the server session
  across reloads.
- **Render the toolbar — unless the section is non-editable.** The other-buttons
  drawer and its `show_other_buttons_button` toggle are mounted from
  `self.context.buttons` plus the section's tools. Three section tipos skip them
  and keep only the search controls: Activity (`dd542`) and Time Machine (`dd15`)
  — strictly read-only logs, so they carry no action buttons and no section tools
  — and the registered-tools section (`dd1324`). Both list views
  (`view_default_list_section`, `view_graph_list_section`) read the ONE list
  `NON_EDITABLE_SECTION_TIPOS` (`render_common_section.js`), so a tipo cannot be
  suppressed in one view and shown in the other.
- **Record actions.** Wire *new* / *duplicate* / *delete* through the
  `new_section_` / `duplicate_section_` / `delete_section_` events and the
  `create` / `duplicate` / `delete` API actions — see
  [`section`](section.md) and
  [`sections`](sections.md#bulk-delete--the-delete-api-action).
- **Navigate into a record.** Turn a click on a row's id into a
  `user_navigation` event that opens that record in `edit` mode (or a new
  window).

## Key concepts / data model

The list mode is driven by a handful of properties on the client `section`
instance (declared in `section.js`):

| property | shape | meaning |
| --- | --- | --- |
| `self.mode` | `'list'` | set by `validate_mode()`; the default mode when none is given |
| `self.datum` | `{ context:[], data:[] }` | the full API payload for this section_tipo |
| `self.data` | `{ typo:'sections', tipo, section_tipo:[], entries:[…] }` | the *sections* envelope item: `entries` is the page of row locators |
| `self.context` | object | the section's resolved context (label, view, request_config, buttons, css, permissions) — server-built by `buildStructureContext` / `stampSectionContext` (see [`section`](section.md)) |
| `self.rqo` / `self.request_config_object` | objects | the request query object and its `sqo` (limit / offset / filter / order); the **source of truth** for pagination |
| `self.columns_map` | array of column objects | the columns to render per row (see below) |
| `self.total` | int \| null | cached record count from the `count` action (fed to the paginator) |
| `self.ar_instances` | array | the **built** `section_record` rows only: a row the window releases leaves it through its own destroy |
| `self.record_windows` | `{ rows: handle }` | the record window of each row slot (`rows`; a portal mosaic adds `alt` for its alternative table), stored by the row door `window_section_rows` |
| `self.paginator` | [`paginator`](../ui/paginator.md) | the navigation widget; this section is its `caller` |
| `self.filter` | [`search`](../sqo.md) instance | the section's search panel (created unless `mode==='tm'`) |
| `self.view` | `'default'` \| `'base'` \| `'graph'` \| `'thesaurus_list'` \| `'search_user_presets'` \| `'export_user_presets'` | which list view renders |
| `self.node_body` | HTMLElement | the `.list_body.layout_table` grid element (kept for in-place pagination refresh) |

### The `entries` array (the page of rows)

The read engine's envelope (`SECTIONS_ENVELOPE_TYPO = 'sections'`,
`src/core/concepts/sections.ts`) is a single `data` item with `typo:
'sections'` whose `entries` is the page of records. Each entry is a locator
plus a `paginated_key` (its absolute position = `offset + row_index`, used to
navigate straight to that record in edit mode), built by `readSectionRows()`:

```json
{
    "typo"         : "sections",
    "tipo"         : "oh1",
    "section_tipo" : [],
    "entries"      : [
        { "section_tipo": "oh1", "section_id": 12, "paginated_key": 0 },
        { "section_tipo": "oh1", "section_id": 9,  "paginated_key": 1 }
    ]
}
```

In Time-Machine (`tm`) mode each entry also carries `matrix_id`, `timestamp`,
`caller_section_tipo` / `caller_section_id`, `bulk_process_id` and `user_id` —
`dd15` is served as a normal section read through the same `readSectionRows()`
path, with the TM-specific extras added by the Time Machine read source
(`pickReadSource`, `src/core/section/read_source.ts`).

### The columns model

A list row is a horizontal slice of one record across a **fixed set of
columns**. The columns_map is built in two steps, both client-side:

1. **Component columns** — `common.get_columns_map({context, datum_context})`
   reads the section's `request_config` and walks the `show.ddo_map` (or
   `['search','show']` in search mode). Each first-level ddo whose `parent` is
   the section tipo becomes a column `{ id, label, tipo, model, section_tipo,
   sortable, width, path, … }`. A ddo's `column_id` + the section's
   `properties.columns_map` let several components share one column or define
   sub-columns; a `value_with_parents` ddo also appends an `ddinfo` ("Info")
   column.
2. **Control column** — `view_default_list_section.rebuild_columns_map(self)`
   **prepends** a synthetic `section_id` column
   (`{ id:'section_id', label:'Id', sortable:true, width:'minmax(auto,
   var(--column_id_width))', callback: render_column_id }`) before the component
   columns, and marks `self.fixed_columns_map = true` so it is built once.

The grid track widths come from `ui.flat_column_items(columns_map)`.

!!! note "The list gets the LIST child's CSS, not the section's own"
    A section's `request_config`/CSS properties differ between its `edit` form
    and its `list`/`tm` view. The structure-context build handles the swap
    (`resolveSourceProperties()`, `src/core/resolve/structure_context.ts`): for a
    **section** in `list` / `tm` / `list_thesaurus` mode, the properties used to
    build its context are swapped for its `section_list` (or
    `section_list_thesaurus`) ontology child's properties — found via
    `findSectionChildByModel()`
    (`src/core/section/list_definitions/node_find.ts`) — **unless** the section
    itself declares its own `source.request_config`, in which case it keeps its
    own. This is what gives the list view the correct column CSS (e.g. a
    `.column_<tipo>` width declared on the `section_list` child) instead of the
    section's edit-form `.list_body` grid.

!!! note "The columns are a *view*, not the record"
    The list deliberately does **not** instance every component of every record.
    Each client `section_record` (`get_ar_columns_instances_list`) instances only
    the components named by the columns_map, in `list` mode, view-collapsed
    (e.g. `view: 'text'`/`'line'`). This is what makes a 100-row list cheap
    relative to 100 full edit forms. See [section_record](section_record.md).

### The row box

Every list row is **one box**: the `.section_record` element *is* the row. The
section list views (`default`, `base`, `thesaurus_list` and the Time Machine
list), every [portal](../components/component_portal.md#rows-drag-and-drop-and-order)
row view and the two tool mosaics (cataloguing, coin ordering) place their rows
through one engine, the **record window**
(`client/dedalo/core/section_record/js/record_window.js`), reached through one
door, `window_section_rows` (`section.js`). The graph view, the saved-preset
lists and the autocomplete results still build their rows directly with
`get_section_records`.

**The row invariant.** At every moment and for every page size N, N = 0
included, `content_data.children` holds exactly N `.section_record` elements in
index order: `children[i]` is row *i* and carries `data-index="i"`. Nothing else
sits inside `content_data` — no spacer, no "no records" node, no footer. A row is
therefore always found as `content_data.children[i]`, or from an event target
with `row_of(content_data, target)`; nothing keeps its own index-to-node map.

**The table DOM.** A table view marks its `list_body` with `layout_table`:

```text
.list_body.layout_table              role=table; grid-template-columns = the column widths
  ├─ .header_wrapper_list            role=row: the header, a column subgrid (optional)
  └─ .content_data                   role=rowgroup: a column subgrid
       └─ .section_record[data-index=i]   role=row: one row box, a column subgrid
            └─ .column …                  role=cell: the cells, on the shared column tracks
.list_after                          the one non-row sibling (never inside the table)
```

Header, `content_data` and every row span the whole grid (`grid-column: 1 / -1`)
with `grid-template-columns: subgrid`, so each row is a single box — it carries
the hover ring, the drop mark and, when unbuilt, the placeholder — while its
cells still line up on the list's shared columns. The ring is a `::after`
generated on every row in every state; hover, `.dragover` and `.dragging`
change only its paint. Rows and `content_data` never clip their overflow and
never open a stacking context, so an autocomplete panel or a hover button is
never trapped under the next row. A section list keeps its header row at N = 0.
A list layout (line, mosaic, tree, indexation and the tool mosaics) has no
`layout_table` mark; its `content_data` is `role=list` and its rows
`role=listitem`. `aria-rowcount` / `aria-rowindex` (or `aria-setsize` /
`aria-posinset` for lists) are set only while placeholders exist; at N = 0 the
row group role is dropped, and a header-less table drops `role=table`.

**The `.list_after` slot.** Everything that is not a row — the "no records
found" node, a portal's back-references, a list footer, a render error, the
print notice and a portal's order indicator — goes into ONE `.list_after`
element, placed right after `list_body` (table views) or `content_data` (list
views). A view's `get_content_data` hands it over as `content_data.list_after`;
the full render places it with `place_list_after` (`common.js`), and a content
refresh (`render_level: 'content'`) swaps it together with `content_data`.

**A bounded window.** A page may hold up to 1000 rows. The window builds
`min(N, 200)` rows (`ROW_WINDOW_MAX_ROWS`, `common/js/row_window.js`); above
200, every other row is a **placeholder**: a childless, listener-free
`<div class="section_record placeholder" data-index="i" aria-hidden="true">`
sized by the measured height of the row it replaced (`--row_size`) or by the
running mean of the built rows (`--placeholder_size`), so scrolling never
shifts the page. Only above 200 rows does the window create its one
`IntersectionObserver`: it builds the placeholders that scroll into reach, and
releases the farthest unpinned rows back down to 160 (`ROW_WINDOW_MARGIN` = 40
below the bound). Focus moving into a row builds its neighbours on both sides.
`reveal(i)` resolves once row *i* is built. A row whose build failed stays a
placeholder with `data-failed` (a red stripe), keeps its index, and is retried
by `reveal(i)`.

**No edit is ever lost by a release.** A row is never released while it holds
focus, a hold (a drag in progress, an open move-to-position dialog), the active
component, an unsaved instance, a typed-but-uncommitted editor value, the live
autocomplete, a saving or changing instance, the pointer (`:hover`) or the
`.dragging` mark. Before a row leaves, its uncommitted editor values are
committed (a synthetic `change` + `blur`), and a value whose component did not
record the commit stays pending: the row stays built. An instance whose save
failed is kept alive and registered as unsaved (orphaned), never destroyed, so
the unsaved-data guard still sees it.

**The owner row lock.** Every operation that replaces a list's rows — `refresh`,
`navigate` (a page change or a sort), and for a portal also link, unlink, add,
the tag filter and every reorder — first acquires the owner row lock
(`lock_rows`, `common.js`). It commits the uncommitted values of every row
(and of an open mosaic hover overlay), then makes the old rows `inert` until the
new ones replace them. When a value cannot be committed, the lock asks the user:
**Cancel** leaves the list exactly as it was (same page, same rows, focus back
on the value); **OK** discards exactly those values and goes on. `navigate`
takes the lock before its unsaved-data check, so that check sees only what the
lock could not commit.

**Delegated listeners.** No row carries a listener of its own. The views that
need gestures register one listener set on `content_data`, bound to the
window's `AbortSignal`, so it dies with the window. A mosaic's hover overlay
(`.sr_mosaic_hover`, the `hover` columns) is built on demand, one at a time, by
`delegate_row_hover` (`section_record/js/row_hover.js`), and flushed before it
leaves, so an edit typed in the overlay is never dropped. Portal drag and drop
is delegated the same way — see
[component_portal](../components/component_portal.md#rows-drag-and-drop-and-order).

**Print and find-in-page.** Placeholders are neither printed nor findable with
the browser's search. When a printed list holds placeholders, `.list_after`
carries a notice, visible in print only:
"*count* of *total* rows are not printed: only the rows rendered on screen are.
Use the print or export tool to get the complete list." (label
`rows_not_rendered_print`). Nothing is built on `beforeprint`; use the print or
export tool for the complete list.

**Phone cards.** At 1024px wide and below (`@width_break_point_0`), a row of a
`layout_table` list — a section list or a portal table alike — becomes a
**card**: the header row is hidden, each cell shows its column name before its
value (set by `ui.make_column_responsive`), and the card stays within the screen
width. A placeholder is never a card. A list nested inside a card cell keeps
flowing inside that cell.

### Relation-component list cells: which config a cell actually expands

A relation-family component (e.g. a portal) rendered as one **list cell**
inside a row does not always expand its own `request_config`. The substitution
that decides its *effective* list/TM config lives in
`src/core/section/list_definitions/section_list.ts`:

| function | purpose |
| --- | --- |
| `resolveListCellMap(tipo)` | The component's effective LIST/TM-cell config: if it has a `section_list` ontology child, that child's properties (v6 `source.request_config`, or a v5 legacy fallback built from the child's own `relations`) replace the component's own for a list/TM build; otherwise the component's own properties are used. Cached. |
| `resolveOwnConfigMap(tipo)` | The component's **own** config map, with **no** `section_list` substitution — used by callers (e.g. export atom recursion) that must see the component's full own map, not its list-cell projection. |
| `getDataframeChildTipos(tipo)` | The component's ontology `component_dataframe` slots (children whose model is `component_dataframe`) — the frame tipos a literal main with `has_dataframe: true` pairs with. |
| `resolveFrameConfig(frameTipo)` | A dataframe frame's own page limit + child ddos. |

The cell page limit follows the same resolved config:
`show.sqo_config.limit ?? sqo.limit ?? null` (the caller falls back to the
1-locator list cell / 10-record edit page); a ddo-level `limit` on the child
entry can override it from the parent side.

## Files & structure

There is no single "section_list" file; the list view is assembled from the
section client module:

```text
client/dedalo/core/section/js/
├── section.js                       # the section instance: init/build/render, navigate,
│                                     #   update_pagination, get_total, create/duplicate/delete_section;
│                                     #   window_section_rows (THE row door), build_section_record_for,
│                                     #   row_edit_safety, get_section_records (unwindowed views)
├── render_list_section.js           # list() view dispatcher + render_column_id (the id cell)
├── view_default_list_section.js     # the default grid view: columns, list_body, header, paginator, buttons
├── view_base_list_section.js        # a leaner grid view ('base'): caller-supplied columns_map
├── view_thesaurus_list_section.js   # 'thesaurus_list' view
├── view_tm_list_section.js          # the Time Machine list
├── view_graph_list_section.js       # 'graph' view
├── view_search_user_presets.js      # 'search_user_presets' view
├── view_export_user_presets.js      # 'export_user_presets' view
├── render_common_section.js         # shared bits: no_records_node(), render_list_after, render_print_notice,
│                                     #   delete dialog
└── render_solved_section.js         # 'solved' mode (read-only resolved view)

client/dedalo/core/section_record/js/
├── record_window.js                 # the record window: row invariant, placeholders, pins,
│                                     #   row_of, apply_table_semantics
└── row_hover.js                     # delegate_row_hover: the on-demand mosaic hover overlay

client/dedalo/core/common/js/
├── common.js                        # lock_rows (the owner row lock), place_list_after
└── row_window.js                    # ROW_WINDOW_MAX_ROWS / ROW_WINDOW_MARGIN / ROW_WINDOW_ROOT_MARGIN
```

Server side, the records are produced by the read engine:

```text
src/core/section/
├── read.ts                          # readSection / readSectionRows / deriveSectionDdoMap /
│                                     #   emitDdoData (the read engine + inline envelope build)
├── read_source.ts                   # pickReadSource: the matrix source vs the Time Machine source
└── list_definitions/
    ├── section_list.ts              # resolveListCellMap / resolveOwnConfigMap / resolveFrameConfig /
    │                                 #   getDataframeChildTipos (relation-cell config substitution)
    └── node_find.ts                 # findSectionChildByModel (the section_list/section_list_thesaurus
                                      #   child lookup used by structure_context's CSS swap)
```

### How the view is chosen

`section.prototype.list` (assigned from `render_list_section.list`) switches on
`self.context.view`:

| `context.view` | renders | used for |
| --- | --- | --- |
| `default` (or unmatched) | `view_default_list_section.render` | the standard list grid |
| `base` | `view_base_list_section.render` | a leaner grid; the caller may inject `rebuild_columns_map` / `columns_map` |
| `thesaurus_list` | `view_thesaurus_list_section.render` | thesaurus term lists |
| `graph` | `view_graph_list_section.render` | graph visualisation |
| `search_user_presets` | `view_search_user_presets.render` | saved-search presets list |
| `export_user_presets` | `view_export_user_presets.render` | export-preset list |

A `default`-view request first consults `self.render_views` (a dynamic registry
of `{view, mode, render, path}` that tools can extend) and dynamically imports a
matching module before falling back to `view_default_list_section`.

!!! note "list, tm and activity share the list renderer"
    `section.prototype.list`, `.list_portal`, `.tm` and `.activity` are all
    assigned from `render_list_section.list`. The differences are data-driven:
    `tm` mode suppresses the buttons/search/paginator-edit affordances and reads
    Time-Machine entries; `dd542` (Activity) and `dd15` (Time Machine) get a
    non-button id cell in `render_column_id`.

## Public API / key methods

The list view has no dedicated class; its behaviour lives as methods on the
client `section` instance and as functions in the server read engine.

### `section` instance — list lifecycle & navigation (`section.js`)

| member | purpose |
| --- | --- |
| `init(options)` | Fix instance vars; `validate_mode()` defaults an unknown/empty mode to `'list'`. Subscribes the `new_section_` / `duplicate_section_` / `delete_section_` / `toggle_search_panel_` / `render_` events and seeds `render_views`. |
| `build(autoload=false)` | Build the `rqo` from `request_config` (`build_rqo_show`), create the `search` filter (unless `tm`), load the page via `build_autoload`, set `self.datum` / `self.context` / `self.data`, restore/apply pagination from local DB, create the `paginator`, and compute `self.columns_map` via `get_columns_map`. |
| `render(options)` | Delegate to `common.prototype.render`, which dispatches to the mode method (`list`). |
| `list(options)` | (= `render_list_section.list`) The list-mode renderer/dispatcher. `options.render_level` is `'full'` (whole wrapper) or `'content'` (only `content_data`, for pagination refresh). |
| `navigate(options)` | Refresh the list in place with a new SQO (used by pagination & sort); optionally push browser history; clears stale per-user record locks. Takes the owner row lock first, then the unsaved-data check; a refused lock leaves the list untouched. |
| `update_pagination(offset)` | Paginator-goto handler: write `rqo.sqo.offset`, persist it to local DB, then `navigate()`. |
| `get_total(sqo?)` | Async record count for the paginator: clone the SQO, strip `limit`/`offset`/`select`/`order`/`generated_time`, call the `count` action; de-duplicated behind `_total_promise`; caches `self.total`. |
| `create_section()` | `create` API action; returns the new `section_id` (server: `createSectionRecord()`, see [`section`](section.md)). |
| `duplicate_section(section_id)` | `duplicate` API action; returns the new `section_id` (server: `duplicateSectionRecord()`, see [`section_record`](section_record.md)). |
| `delete_section(options)` | `delete` API action over a `{ sqo, delete_mode }` (see [`sections`](sections.md#bulk-delete--the-delete-api-action)). |
| `navigate_to_new_section(section_id)` | After create/duplicate, publish `user_navigation` to open the new record in `edit`. |
| `goto_list()` | From `edit` back to `list`; publishes `user_navigation` with the restored list pagination. |
| `change_mode(options)` | Swap this instance for a fresh one in another mode/view (e.g. list → edit) and replace the DOM node. |
| `get_all_target_sections()` | Collect the unique target `section_tipo`s of the section's portal columns (from each portal's `rqo.sqo.section_tipo`). |
| `focus_first_input()` | Activate the first component of the first row. |
| `delete_cache()` | Drop the `section_cache_*` local-DB entries (on `quit` / `change_lang`). |

### Row door and row builders (exported from `section.js`)

| member | purpose |
| --- | --- |
| `window_section_rows({caller, container, rows, slot?, records_options?, render_options?, layout?, draggable_rows?, decorate?})` | THE row door of every windowed view. Creates a record window over `rows` in the empty `container` (`content_data`), stores it as `caller.record_windows[slot]` (default slot `rows`), and retires the previous window of that slot. Called on **every** content render, N = 0 included. Each window gets the next owner-monotonic `generation` of its slot, so a drag started in a superseded window is recognised as stale. Returns the filled window. |
| `build_section_record_for(caller, entry, records_options)` | Build one `section_record` for one entry (the window's builder and the hover overlay's). |
| `get_section_records(options)` | Build a `section_record` for every entry of `caller.data.entries` at once and return the built ones (failed builds filtered out). Used only by the views that do not window their rows (graph, saved presets, autocomplete results, the search-mode and text / mini portal views). |

The window handle (`create_record_window`, `record_window.js`) exposes data and
instances only, never a node: `size`, `generation`, `signal`, `entry_of(i)`,
`record_at(i)`, `is_built(i)`, `reveal(i)`, `ensure_built(from, to)`,
`rebuild(i)`, `hold(i, reason)` / `unhold(i, reason)`, `commit_uncommitted()`,
`freeze()` / `thaw()`, `flush()`, `retire(next)`, `destroy()` and `idle()`.

### Default list view (`view_default_list_section.js`)

| member | purpose |
| --- | --- |
| `view_default_list_section.render(self, options)` | Build the full list: `rebuild_columns_map`, set the grid `grid-template-columns` (`ui.flat_column_items`), render the header + `content_data` inside `list_body.layout_table`, apply the table roles (`apply_table_semantics`), place `.list_after`, mount buttons / search / paginator. Honours `render_level==='content'`. |
| `get_content_data(self, rows, options)` | Create an empty `.content_data`, hand `rows` (`self.data.entries`) to `window_section_rows`, and attach the `.list_after` node (no-records node, print notice) as `content_data.list_after`. Returns the filled `.content_data`. |
| `rebuild_columns_map(self)` | Prepend the synthetic `section_id` control column; idempotent via `self.fixed_columns_map`. |
| `adapt_section_id_column(list_body_node, self)` | Set `--section_id_font_size` / `--column_id_width` CSS vars to fit the longest id on the page. |

### Id-cell renderer (`render_list_section.js`)

| member | purpose |
| --- | --- |
| `render_column_id(options)` | Render the `section_id` cell per row. Branches by caller/permissions: a portal-initiator **link** button (iframe linking), a `section_tool` **edit** button, a plain id badge for `dd542`/`dd15`, a disabled badge for read-only (`permissions < 2`), or the standard **edit** (open record) + **delete** buttons. The edit button supports `navigate` (in-page `user_navigation`) and `open_window` actions chosen by `show_interface.button_edit_options`. |

### Shared / dispatcher

| member | purpose |
| --- | --- |
| `render_list_section.list(options)` | View dispatcher (see [How the view is chosen](#how-the-view-is-chosen)). |
| `no_records_node()` | The "no records found" node when `entries` is empty; it is placed in `.list_after`, never in `content_data`. |
| `render_list_after(self, {content_data, record_window})` / `render_print_notice(content_data, record_window)` (`render_common_section.js`) | Build the section list's `.list_after` node (no-records node, print notice) and the print notice shared with the portal views. |

### Server-side companions

| member | where | purpose |
| --- | --- | --- |
| `readSection` / `readSectionRows` / `deriveSectionDdoMap` | `src/core/section/read.ts` | run the navigation SQO and return the matching rows + envelope; see [`sections`](sections.md). |
| `resolveSourceProperties` (section-level CSS swap) | `src/core/resolve/structure_context.ts` | swap a section's properties for its `section_list`/`section_list_thesaurus` child's, in list/tm/list_thesaurus mode. |
| `resolveListCellMap` / `resolveOwnConfigMap` (component-level cell config) | `src/core/section/list_definitions/section_list.ts` | resolve which config a relation component's LIST cell actually expands. |

!!! warning "Never invent a `section_list` symbol"
    There is no `section_list` constructor, class or method. In code you will
    only see the client `section` instance with `mode:'list'`, the
    `render_list_section` / `view_*_list_section` modules, and the server-side
    `readSection` / `readSectionRows` functions. Wire-ups use those names, not
    "section_list" — the module named `section_list.ts` is the relation-cell
    config resolver described above, not a section/list class.

## How it fits with the rest of Dédalo

- **[sections (server collection concept)](sections.md)** — the upstream
  producer. `readSection()` runs the navigation [SQO](../sqo.md), and
  `readSectionRows()` builds the `entries` + `context` the list consumes. The
  list's `get_total()` `count` action queries the same record set.
- **[section (reference)](section.md)** — the section concept behind each
  `section_tipo` in the list; its context (buttons, permissions, CSS) is
  stamped by `stampSectionContext()` and swapped per
  [the list-CSS note above](#the-columns-model) when in list/tm mode.
- **[section_record](section_record.md)** — one **row**. The record window
  builds one client `section_record` per entry it builds
  (`build_section_record_for`); each renders only the columns in the
  columns_map (`get_ar_columns_instances_list`). Click handling on the id cell
  turns a row into an `edit`-mode navigation.
- **[Components](../components/index.md)** — the **cells**. Each column resolves
  to a component instance rendered in `list` mode and a collapsed view (`text` /
  `line` / `mini` / `mosaic`).
- **[paginator](../ui/paginator.md)** — the list is the canonical paginator
  caller: it provides `id`, `mode`, `rqo.sqo.limit`/`.offset`, `get_total()`,
  `permissions`, `node` and the `render_<id>` event, and routes
  `paginator_goto_<id>` through `update_pagination()` → `navigate()`.
- **[SQO](../sqo.md)** — `self.filter` is the section's search instance; the
  list's *Search* / *Show all* buttons toggle it and mutate the SQO `filter`.
  Sorting mutates the SQO `order`. Pagination mutates `limit`/`offset`.
- **[request_config](../request_config.md) / [RQO](../rqo.md)** — the
  `request_config` `show.ddo_map` defines the columns; `build_rqo_show()` wraps
  the SQO into the request sent to the API.
- **[page](../ui/page.md) / [menu](../ui/menu.md) / [inspector](../ui/inspector.md)** —
  a list is usually created by the `page` (its `caller`); the `render_` handler
  updates the menu's section label and the document title. The inspector is an
  `edit`-mode dependency (not built in list mode).
- **[events](../events.md)** — every action is decoupled via `event_manager`:
  `new_section_<id>`, `duplicate_section_<id>`, `delete_section_<id>`,
  `toggle_search_panel_<id>`, `user_navigation`, `paginator_goto_<id>`,
  `render_<id>`.

## Examples

### The list payload the client receives

```json
{
  "result": {
    "context": [ { "tipo": "oh1", "model": "section", "view": "default", "request_config": [ ] } ],
    "data": [
      {
        "typo"    : "sections",
        "tipo"    : "oh1",
        "entries" : [
          { "section_tipo": "oh1", "section_id": 12, "paginated_key": 0 },
          { "section_tipo": "oh1", "section_id": 9,  "paginated_key": 1 }
        ]
      }
    ]
  }
}
```

`section.build()` stores the `entries` item as `self.data` (matched by
`tipo===self.tipo && typo==='sections'`) and the `oh1` context as
`self.context`.

### Building and rendering a list (the page pattern)

```javascript
import {get_instance} from '../../common/js/instances.js'

// page builds a section in list mode
const section = await get_instance({
    model        : 'section',
    tipo         : 'oh1',
    section_tipo : 'oh1',
    mode         : 'list',           // → section_list
    lang         : page_globals.dedalo_data_lang,
    caller       : page              // exposes set_document_title / ar_instances (menu)
})

await section.build(true)            // autoload: fetch the first page from the API
const wrapper = await section.render() // list_body.layout_table: header + one row box per entry
document.body.appendChild(wrapper)
```

### Paginating the list

```javascript
// the paginator publishes paginator_goto_<id>; section subscribes in init():
//   event_manager.subscribe('paginator_goto_' + self.paginator.id, offset => self.update_pagination(offset))

// update_pagination writes the offset and re-navigates in place:
//   self.rqo.sqo.offset = offset
//   data_manager.set_local_db_data({ id:`${self.tipo}_${self.mode}`, value:{ limit, offset } }, 'pagination')
//   self.navigate({ sqo: clone(self.rqo.sqo), navigation_history: true })
// navigate() calls self.refresh() which re-renders only content_data (render_level:'content')
```

### Reading a list page directly on the server (not via the client)

```ts
import { readSection } from '../section/read.ts';

const result = await readSection(
  {
    action: 'search',
    source: { tipo: 'oh1', section_tipo: 'oh1', mode: 'list', lang: 'lg-spa' },
    sqo: { section_tipo: ['oh1'] }, // limit defaults to 10 when the client sends none
  },
  principal,
);
// result.data[0] → the 'sections' envelope with entries[]
```

## Related

- [section (reference)](section.md) — the server section concept/orchestrator.
- [sections (server collection concept)](sections.md) — the multi-record read
  engine that feeds the list.
- [section_record](section_record.md) — one list **row**; how a record renders
  only its columns.
- [Sections concept](index.md) — the matrix-table model behind every section.
- [Components](../components/index.md) — the **cells** rendered in `list` mode.
- [paginator](../ui/paginator.md) — the navigation widget the list drives.
- [SQO](../sqo.md) — the filter / order / limit / offset the list mutates.
- [request_config](../request_config.md) · [RQO](../rqo.md) — where the columns
  (`show.ddo_map`) and the request come from.
- [page](../ui/page.md) · [menu](../ui/menu.md) · [inspector](../ui/inspector.md) —
  the surrounding UI that hosts the list.
- [events](../events.md) — the publish/subscribe layer behind every list action.
