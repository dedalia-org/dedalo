# component_portal

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : false,
    "is_related"            : true,
    "is_media"              : false,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools" : [
        "tool_propagate_component_data",
        "tool_time_machine"
    ],
    "render_views" : [
        {
            "view" : "default | line | text",
            "mode" : "edit | list"
        },
        {
            "view" : "content | indexation | mosaic | tree",
            "mode" : "edit"
        },
        {
            "view" : "mini",
            "mode" : "list"
        }
    ],
    "data"        : "array of locators",
    "sample_data" : [{
        "id"                  : 1,
        "type"                : "dd151",
        "section_tipo"        : "rsc197",
        "section_id"          : 1,
        "from_component_tipo" : "oh24"
    }],
    "value"        : "array of strings",
    "sample_value" : ["Marie Curie"]
}
```

!!! note "Typology"
    `component_portal` is a **related** component. It does not own a literal value: it stores an array of [locator](../locator.md) objects that point at records in other (or the same) section, and the displayed `value` is resolved on demand from the *target* records. Like every relation-column model (`component_select`, `component_check_box`, `component_radio_button`, `component_relation_*`, `component_filter`, `component_publication`, `component_inverse`, `component_dataframe`), it is declared as a descriptor over the shared relations engine (`src/core/relations/`) rather than a class in an inheritance tree.

!!! info "About `default_tools`"
    The toolbar is assembled from the model + ontology; the descriptor does not hardcode it. The verified model sample (`samples/context.json`) ships `tool_propagate_component_data` and `tool_time_machine`. Because `component_portal` is **not** translatable, the language tooling (`tool_lang` / `tool_lang_multi`) is never added. Tools are read-only context.

!!! note "Legacy aliases"
    `component_portal` absorbed the former `component_autocomplete` / `component_autocomplete_hi` (pre-v6) functionality; you may still see `legacy_model: "component_autocomplete_hi"` in older ontology nodes. New nodes use `component_portal`. In the TS server both are registered as thin alias stubs whose descriptors set `alias: 'component_portal'`, so they are resolved to this model at runtime before any resolver/search lookup; `component_autocomplete_hi` additionally retains `column: 'relation'` and `importConform: 'relation'` for any pre-replacement column/import lookup.

!!! info "Server implementation"
    `component_portal` is implemented as a shared engine plus a per-model registry entry, not a class hierarchy. The descriptor `src/core/components/component_portal/descriptor.ts` registers `resolveData: 'portal'` (`src/core/relations/models/portal.ts`), which resolves the child ddo map (client-supplied map, or the list-cell effective config, or the component's own v6 config via `buildRequestConfigForElement`, `src/core/relations/request_config/build.ts`) and delegates paging/expansion/re-stamping to the shared `expandPortal` engine (`src/core/relations/relation_core.ts`). The same resolver backs the legacy `component_autocomplete` / `component_autocomplete_hi` aliases and (until they get their own particularity) `component_relation_parent`, `component_dataframe` and `component_external`. Write-side particularities (`sort_data`, `sort_by_column`, `add_new_element`, `delete_locator`) live in `src/core/relations/save.ts`. See the *dedalo-relations-ts* skill for the full relations-engine map.

## Definition

`component_portal` is the relational workhorse of Dédalo: it links the host record to one or more records in a target section and presents those linked records as a list (autocomplete to find/add, open to navigate, drag-to-reorder, remove). It is the v7 successor of the old autocomplete components and is by far the most common way to express a *reference to another record* in a catalogue.

**Why it exists.** A cultural-heritage record is rarely self-contained: an object has an *author*, a *material*, a *find spot*; a person has *projects*, *publications*, *related people*. Each of those is a record in its own section, not a literal string. `component_portal` stores the connection as a [locator](../locator.md) instead of copying the target's text, so the link stays live — rename the authority record once and every portal that points at it shows the new term. It supports many-to-many cardinality, so the same authority can be reused across thousands of records.

**When to use it.**

- Link a record to one or more records in another section: *Author*, *Owner*, *Find spot*, *Related objects*, *Bibliography*, *Birth town*.
- Build a curated, ordered list of references the cataloguer adds by autocomplete and re-orders by hand (or by a target column — see [column order](#column-order-sort_by_column-and-order-per-ddo)).
- Surface calculated / inverse relations read-only via `source.mode: external` (e.g. *all coins of this type*, computed from the inverse side).
- Expose a thesaurus / hierarchy branch for picking terms (the `tree` and `indexation` views).

**When not to use it.**

- A literal short string the cataloguer types directly (*Title*, *Inventory number*) -> use [component_input_text](component_input_text.md).
- A bounded, mutually-exclusive choice rendered as a dropdown or radios -> use `component_select` / `component_radio_button` (also relation components, but with a fixed option list and single/low cardinality UX).
- A multi-select rendered as a tick list -> use [component_check_box](component_check_box.md).
- Frame data (uncertainty, qualifiers) attached to another component's items -> use [component_dataframe](component_dataframe.md).

## Data model

**Data:** `array of locators`.

**Value:** `array` of `strings`, or `null`. The value is **not** stored on the portal; it is resolved from the target record(s) at read time (see [Value resolution](#value-resolution)).

**Storage shape.** A component never touches the database; it reads and writes through its section. Relation components do not store their items in the matrix `data` column — they store them in the matrix **`relation`** column as a JSONB map keyed by component tipo, and the section additionally aggregates every locator of the record into a single section-wide `relations` container. A portal slices its own subset out of that bag by matching `from_component_tipo` (and `section_tipo`). That single shared relations bag is exactly what lets many distinct relation components live on one record without colliding.

A portal's stored data is therefore an **array of locator objects**:

```json
[
    {
        "id"                  : 1,
        "type"                : "dd151",
        "section_tipo"        : "rsc197",
        "section_id"          : 1,
        "from_component_tipo" : "oh24"
    },
    {
        "id"                  : 2,
        "type"                : "dd151",
        "section_tipo"        : "rsc167",
        "section_id"          : 8,
        "from_component_tipo" : "oh24"
    }
]
```

Locator fields:

- `type` — the relation-type tipo. Defaults to the portal's `defaultRelationType`, which for `component_portal` is `DEDALO_RELATION_TYPE_LINK` = **`dd151`** (the generic link type). Set on instantiation from `properties.config_relation.relation_type`.
- `section_tipo` / `section_id` — point at the target record.
- `from_component_tipo` — names the component that owns the locator. When the relations engine normalises a locator on save it **forces** this to the owning portal's own `tipo` (cloning the incoming locator first, so observers still see the value they were handed), which is how the section-wide relations bag is partitioned per component.
- `id` — per-item counter id used for ordering and dataframe pairing.
- `type_rel` *(optional)* — directionality (uni / bi / multidirectional); see [Directionality](#directionality).
- `tag_id` *(optional)* — present for indexation locators.

`component_portal` is **non-translatable** (`could_be_translatable: false`), so its locators have no `lang`; an instance is built in `lg-nolan`. The *resolved value* is still shown in the application/data language because the target component is instantiated in that language at resolution time.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum (the JSON-API contract). In the API payload the locator array is surfaced under `data.entries` (each entry carrying a `paginated_key`), accompanied by `parent_tipo`, `parent_section_id` and `pagination`. The displayed strings of the linked records arrive as **subdata**: each target record's datum is resolved and merged into the response alongside the portal's own. `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `request_config`, `view`) and never the values. See the *dedalo-context-data-layers* and *dedalo-datalist-resolution* skills for the full layering rules.

### Value resolution

The displayed strings come from the *target* section/component, never from the portal:

- Resolving one locator looks up the term of the target record; when the request asks for specific target columns it instead instantiates each named target component in the target record and collects its value, and when it asks for the ancestor chain it prepends the term and walks the parents recursively.
- For grid and export, the resolution driven by the `request_config` `show.ddo_map` iterates the locators and instantiates each child component against the locator's `section_id` / `section_tipo` to resolve sub-columns.
- The selectable option list (datalist / autocomplete suggestions) comes from the target component's option-list resolution, served through the relation-list resolver (`src/core/resolve/relation_list.ts`).

## Ontology instantiation

A `component_portal` is created as an ontology node whose `model` is `component_portal`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` term; `translatable` is `false` for a portal.

Node definition (shape):

```json
{
    "tipo"         : "rsc91",
    "model"        : "component_portal",
    "parent"       : "rsc197",
    "section_tipo" : "rsc197",
    "lg-eng"       : "Birth town",
    "lg-spa"       : "Localidad de nacimiento",
    "translatable" : false,
    "properties"   : { }
}
```

The behaviour of a portal is driven almost entirely by its `properties.source` block, which carries the **request_config** that defines the target section(s) and the columns to `show` / `choose` / `search`. A realistic `properties` block for a "Birth town" portal pointing at one geographic section and showing the term with its ancestor chain:

```json
{
    "source": {
        "mode": "autocomplete",
        "request_config": [{
            "sqo": {
                "section_tipo": [{ "value": ["rsc197"], "source": "section" }]
            },
            "show": {
                "ddo_map": [{
                    "tipo": "rsc91",
                    "parent": "self",
                    "section_tipo": "self",
                    "value_with_parents": true
                }],
                "fields_separator": ", "
            },
            "choose": {
                "ddo_map": [{
                    "tipo": "rsc91",
                    "parent": "self",
                    "section_tipo": "self",
                    "value_with_parents": true
                }],
                "sqo_config": { "limit": 30 },
                "fields_separator": " | "
            }
        }]
    }
}
```

`section_tipo` / `parent` tell the section which relation slot owns this portal's locators; on save the section is the single writer to the database (the locators land in the `relation` column and the record-wide `relations` bag). The portal's `request_config` is parsed (TS: `buildRequestConfigForElement` in `src/core/relations/request_config/build.ts`, dispatching to the v6 or v5 builder) into a ready-to-use `request_config` array on the context (`api_engine: "dedalo"`, `type: "main"`), which the client uses to build the data/list/search RQO.

!!! info "Relation table persistence"
    On save, relation components also propagate their locators to the relations index for fast querying. Bulk paths (e.g. geonames imports) may skip that index write.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component (server-side resolution + client JS):

### source

- **Values:** an object `{mode, request_config}`.
- **`source.mode`:** `"autocomplete"` (default behaviour — the user finds and links target records via the autocomplete service) or `"external"`. With **`external`** the portal data is *calculated*, not user-owned: the stored locators are an **external mirror** that the server keeps up to date whenever the data it derives from is saved, by one of three value laws (every record pointing at this one, a copy of a component on the record this one points at, or the locators in a text's tags) — see [Server-side observers](../system/observers.md#the-value-laws-of-set_dato_external). A read serves the stored mirror; it does not recompute it. The UI hides add/link/tree buttons and tools, showing only the update-external + list buttons.
- **Update external (the sync button).** Pressing it sends one component `read` whose `source.build_options` carries `get_data_external: true`; the server recomputes that one mirror on that one record from committed data, saves it only if it changed, and serves the fresh value. The flag is sent once and cleared afterwards. It needs only **read** permission (1) on the record and the portal, because the value is derived and identical whoever asks: editors see the button in the full toolbar, and at permission 1 an external portal's toolbar holds only this button. The read is always served; a refused or held-back recompute comes back as a notice (`observers.refresh_refused`, or `observers.refresh_withheld` with a `reason`). It never runs from a Time Machine view. The older flag `get_dato_external` is ignored. Details: [Refreshing a mirror by hand](../system/observers.md#refreshing-a-mirror-by-hand).
- **`source.request_config`:** the per-portal RQO template: `sqo` (which target section(s), via `section_tipo` sources such as `section`, `hierarchy_types`, …), `show` (the `ddo_map` columns rendered for each linked record + `fields_separator`), `choose` (the columns offered in the autocomplete picker), and `search`. This is the heart of a portal's configuration — it defines both *what it links to* and *how each linked record is displayed*.
- **Picker labels.** In the autocomplete picker each match is shown as the target's flat-text row: the `choose` columns that resolve a value, joined by `fields_separator` (default ` | `). A column that resolves nothing — an empty `value_with_parents` breadcrumb, for instance — is skipped, so the columns that do render stay separated (`Latina | Agrupador`, never `LatinaAgrupador`).

### config_relation

- **Values:** an object `{relation_type, relation_type_rel}`.
- **Effect:** read on instantiation. `relation_type` overrides the locator `type` (default `dd151`); `relation_type_rel` sets directionality (locator `type_rel`). See [Directionality](#directionality). Also carries `tag_id` config for indexation portals.

### Column order: `sort_by_column` and `order` (per-ddo)

Portal order directives live **on the column ddo** — an entry of `source.request_config[].show.ddo_map` — not on a separate top-level property. The stored locator array is the portal's only real order: export, publication and every read see it as stored. Two independent per-ddo keys:

| Per-ddo key | Meaning |
|---|---|
| `"sort_by_column": true` | The column header offers a **temporary** sort of the list by this column (nothing is written); **Save** in the order indicator makes the shown order the stored order. |
| `"order": "asc" \| "desc"` | This column is part of the portal's **permanent declared order**: the stored array is kept sorted by it on every write. |

```jsonc
"source": { "request_config": [ { "show": { "ddo_map": [
  { "tipo": "rsc279", "view": "line" },
  { "tipo": "rsc85", "sort_by_column": true, "order": "asc" },   // Name: header sort + declared order key
  { "tipo": "rsc86", "sort_by_column": true, "order": "asc" },   // Surname: tie-break
  { "tipo": "rsc89" }                                            // Date of birth: neither
] } } ] }
```

The tipos are real `rsc` nodes of the *People* section (`rsc197`): `rsc85` *Name* and `rsc86` *Surname* (`component_input_text`), `rsc89` *Date of birth* (`component_date`), `rsc279` *Public* (`component_publication`). No node of the ontology this page was verified against declares either key, so the block shows the shape only.

**`sort_by_column: true`** — the header of that column shows sort arrows (`ui.allow_column_order`, asked through the portal's `can_view_sort`; edit mode, read permission, not on a `source.mode: external` portal, and the column must be `sortable`). A click is a **temporary view**: the next read carries [`sqo.view_order`](../sqo.md#view_order) `{tipo, direction}` and the server orders the portal's full locator list by that column before paginating; nothing is written. See [The order model](#the-order-model) for the indicator and the save.

- Client: `ui.allow_column_order` → `component_portal.set_view_order`. Server: `orderLocatorsByViewOrder` (`src/core/relations/order_locators.ts`), applied inside `expandPortal` (`src/core/relations/relation_core.ts`). The persisted save is the `sort_by_column` save action, `applySortByColumn` (`src/core/relations/save.ts`), which gates on the resolved column ddo's `sort_by_column === true` and writes the re-ordered array (a Time Machine data change).

**`order: "asc"|"desc"`** (`true` = asc) — the stored array of a portal declaring `order` is **sorted at write time**: the record-write chokepoint applies the key save rules (`applyKeySaveRules`, `src/core/section_record/record_write.ts`) to every write of the key, through the one ordering function `sortByDeclaredOrder` (`order_locators.ts`). **Priority follows the ddo_map declaration order** (first ordered column = primary sort, next = tie-break). Unresolvable (deleted) targets fall to the end, keeping their relative order. The read serves the stored array as stored.

- The declared order is read from the component's resolved edit config (its first `request_config` item); for a `component_alias` it is its target's. The context carries it to the client as `context.declared_order` (`[{tipo, direction}]`, absent when none).

Both keys share ONE ranking engine (`rankLocatorsByColumns`): a search over the target section restricted to the linked `section_id`s, ordered by the column value. The keys ride the parsed request_config passthrough to both the server and the client — no `ddoSchema` change.

### data_limit

- **Values:** integer. Default: unset (no limit). A literal `0` is a real answer — "nothing may be linked" — and is honoured as one; it is not the same as unset.
- **Effect:** maximum number of linked records the component may hold. The client blocks the add/link action once the count is reached (label `exceeded_limit`), and **the save re-resolves the same limit and refuses the insert that would exceed it** — so the cap holds for every door, not only for the supported browser. Useful for "exactly one author" style fields without dropping to a single-value select.
- In the [term picker](#tree-view-the-term-picker) it is the only count that binds: the picker is handed the **remaining** capacity (this limit minus what the component already holds), and a batch of picks is evaluated against it as a batch, so several individually-legal picks cannot collectively break it.

### draggable_to

- **Values:** array of component tipos the entries may be dragged into.
- **Effect:** makes the portal a source of cross-portal **MOVE**. `drag_and_drop.js` reads `properties.draggable_to`; a target portal accepts a drop only when its own `tipo` is found in the dragged source's `draggable_to` list and the target is writable. The target links the record first and the source unlinks it only once the target accepted it. Used to move a linked record from one portal to another (e.g. promote a "candidate" link to a "confirmed" link). The ontology alone decides: the same drop code serves every view. See [Rows, drag and drop, and order](#rows-drag-and-drop-and-order).

### with_value

- **Values:** an object `{mode, view}`.
- **Effect:** in `list` line view, double-clicking an entry switches the portal to the `mode` / `view` declared here (defaults `edit` / `line`) — the inline "open for editing" transition. Only fires for users with write permission and when the portal is not read-only.

### service_autocomplete

- **Values:** an object (service-autocomplete configuration) or `null`.
- **Effect:** passed straight to the `service_autocomplete` instance the edit render spins up when the user activates the picker (`render_edit_component_portal.js`). Configures the external autocomplete service used to find target records.

The result list is painted **complete**: a row is appended only after its
`section_record` has rendered, and the search call resolves only when every row is
ready. The open list is therefore either empty or complete — it never shows a band
of empty rows over the form.

!!! note "Standard context properties"
    Like every component, `component_portal` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (the parsed RQO) and `view` (the render view to use). Observer/observable wiring (`observe` / `observers`) is configured here too — see [Notes](#notes). Any other custom key seen in production should be **verified in the ontology**.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files. The `render_views` map registered in `component_portal.js` is authoritative:

| View | edit | list / tm | Notes |
| --- | :---: | :---: | --- |
| `default` | yes | yes | Full list: label, buttons (add / link / open / autocomplete), a row-box table with one row per linked record and a drag handle per row (edit); temporary header sort on columns declaring `sort_by_column`. |
| `line` | yes | yes | Compact single-line list; in list mode supports the [`with_value`](#with_value) double-click-to-edit transition. |
| `text` | yes | yes | Plain joined text of the resolved values, no chrome. (Registered for both edit and list.) |
| `mini` | — | yes | Minimal inline view, used by the service autocomplete / tight layouts. |
| `mosaic` | yes | — | Grid layout of linked records (visual / media-heavy targets). |
| `tree` | yes | — | Opens the target thesaurus as a **term picker** — see [below](#tree-view-the-term-picker). The tree renders a link affordance per term instead of navigating; the client stamps **no** relation `type` (the server fills it from the component's own model). |
| `indexation` | yes | — | Specialised thesaurus indexation view (uses `config_relation` `tag_id`, `top_locator` from `tool_indexation`). One row per target record, not per locator — see [below](#indexation-view-rows-are-terms-not-tags). |
| `content` | yes | — | Renders the linked records' content inline. |

### `tree` view: the term picker

Declaring `properties.view: "tree"` on a relation component turns its target thesaurus
into a picker. It is generic: the same declaration works on `component_portal` and on
every model that shares its client — `component_dataframe`,
[component_relation_children](component_relation_children.md),
[component_relation_index](component_relation_index.md),
[component_relation_related](component_relation_related.md),
[component_relation_parent](component_relation_parent.md) — and on
`component_relation_model`, whose target is an ontology tree rather than a thesaurus.

**The handshake is a caller, not a mode.** When the picker opens, the request names the
component that will receive the terms — `{section_tipo, section_id, tipo}` — and the
server derives everything else from it: whether this is a picker at all (the caller's
resolved view is `tree`, its model stores relations, and you hold edit permission on
it), which hierarchies open (the caller's own target sections), and how many terms may
still be linked (`data_limit` minus what the component already holds). Nothing about the
picker is asserted by the browser. The full contract — the emitted fields, the two
refusals — is documented once under
[area_thesaurus](../areas/area_thesaurus.md#the-term-picker-relation-mode).

**What the request config does and does not control.** The `sqo` names the target
section(s), and that is its whole role here:

| Question | Answered by |
| --- | --- |
| Which thesaurus opens? | the caller's `sqo.section_tipo` |
| Which terms are in the tree? | the thesaurus itself — **not** the request config |
| How many terms does the tree show? | unbounded: a thesaurus is browsed, not paged. `sqo_config.limit` is the [autocomplete](#service_autocomplete) dropdown's size, a different surface |
| How is a tree node rendered? | the thesaurus's own term rendering — **not** the caller's `ddo_map`, which governs how a *linked* value is displayed back in this component |
| Is a given term linkable? | the **term**, through its thesaurus's own selectable flag |
| How many terms may be linked? | [`data_limit`](#data_limit) — the only count that binds the picker |

!!! note "A picker view adds an input path and removes none"
    The tree view declares its own toolbar (the tree button on, add/link/list/fullscreen
    off) as part of the view registration, so it is composed once with the component's
    other constraints instead of being written during render. It deliberately cannot
    switch off `show_autocomplete`, `read_only` or `permissions`: a component whose
    `source.mode` is `autocomplete` keeps its autocomplete input while gaining the
    picker, and no view may widen or narrow what the server granted.

!!! warning "Not every `view: "tree"` target is a thesaurus"
    The picker opens a hierarchy. A component declaring `view: "tree"` whose target
    section is an ordinary section has no tree to show, and the read now says so
    (`409`, "no active hierarchy is configured for this component target") instead of
    rendering an empty panel. If you see that refusal, the declaration is the defect —
    check the target before adding the view.

### `indexation` view: rows are terms, not tags

The indexation view is the only one where a row is **not** one locator. The stored data holds one locator per tag anchor, so a term tagged five times inside the companion `component_text_area` is five locators sharing the same `section_tipo` + `section_id` and differing only in `tag_id`. The view de-duplicates them into **one row per target record**, and the row's tag column paints one chip per locator — clicking a chip scrolls to that tag in the text.

Two consequences follow, and they are the whole contract of the view:

- **What the row shows is what the row deletes.** The row's unlink removes *every* locator the row is displaying — all of the term's links, in a single save — instead of an arbitrary one of them. The confirmation dialog names the term and lists the chips it is about to remove.
- **A selected tag narrows both.** While a tag filter is active the portal's entries are filtered to that `tag_id`, so the row shows one chip and the unlink removes one link. There is no separate code path for this case: the displayed set and the deleted set are the same expression.

!!! warning "Unlinking here never edits the text"
    This removes locators only. The `[index-…]` marks stay in the transcription exactly as they were, orphaned or not. Deleting a tag for real — the marks in every language *plus* its locator — is the text component's job, driven from the editor, not from this list. Say so in any UI you build on top of it.

!!! note "search mode"
    `search` mode reuses the edit/list render pipeline via `render_search_component_portal.js`: the portal becomes an SQO filter input (autocomplete over the target section, `action: 'resolve_data'`), and the picked locators are carried as the filter source value. Saves are blocked in search mode.

Modes:

- **edit** — read/write: autocomplete-add, link existing, open target, reorder (drag, tap-tap, move-to-position), cross-portal move, remove (`remove_element` with `delete_link` or `delete_all`), `data_limit` cap, temporary header sort and its **Save**, and the update-external recompute of an `external` portal.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render (list mode `limit` is always 1 per row).
- **search** — builds the SQO filter input; saves blocked.

## Rows, drag and drop, and order

### The row DOM

Portal rows are placed by the same record window as section lists (see
[The row box](../sections/section_list.md#the-row-box): the row invariant,
placeholders above 200 rows, edit safety, the owner row lock, the print notice,
phone cards). DOM of the default edit view:

```text
.wrapper_component.component_portal
  ├─ .label, .buttons_container
  ├─ .list_body.layout_table                       role=table
  │    ├─ .header_wrapper_list                       the header row (sort arrows)
  │    └─ .content_data                              role=rowgroup
  │         └─ .section_record[data-index=i]         role=row: one row per linked record
  │              ├─ .column_section_id               id cell: drag handle, open
  │              ├─ .column …                        the target's show.ddo_map columns
  │              └─ .column_remove                   the unlink / delete button
  └─ .list_after                                    order indicator, references, print notice
```

The table views (`default`, `content`, the mosaic's alternative table) carry
`layout_table`; the line, mosaic, tree and indexation views are lists
(`role=list` / `listitem`). Nothing but rows sits in `content_data`: the
order indicator, `component_relation_related` back-references, the
indexation "remove filter" footer and the print notice all live in
`.list_after`. A mosaic tile's hover overlay (`.sr_mosaic_hover`) is built on
demand by `delegate_row_hover` and flushed before it leaves.

### Drag and drop

All gestures are **delegated** (`client/dedalo/core/component_portal/js/drag_and_drop.js`):
one listener set per `content_data`, bound to the row window's `AbortSignal`,
none on a row.

- **Sources.** The `default` view drags by the row's **handle** (`.drag`, in the
  id cell; rows stay non-draggable so their inputs keep text selection). On a
  desktop the handle hangs in the left gutter, invisible until the row is
  hovered or focused (it is never `display:none`, so it stays in the Tab order).
  That gutter is reserved **inside the list's own scrollport** (a wide table
  scrolls sideways there), so the handle is never clipped by the list edge: a
  clipped handle starts no native drag from its centre, however normal it looks
  to a hit test. On a phone card it sits inside the id cell and is always
  visible. The `mosaic` and `line` edit views drag the **whole row**.
- **Drop on a row.** Every row is a target, placeholders included. A row under
  an accepted drag gets `.dragover`; the dragged row gets `.dragging`; both
  paint the row's ring. A drop on the wrapper outside any row is a MOVE only
  (`bind_portal_drop`; an empty portal has no rows).
- **One decision.** `decide_drop` answers, for every path (mouse, touch,
  keyboard):
  - **REORDER** — the payload came from **this** instance (by instance id, not
    `tipo`: two instances of one tipo are two lists) and `can_reorder` holds:
    edit mode, a paginator, write permission, no declared order, no temporary
    view order, and a model whose order is a position in the list
    (`component_relation_children` is not). It saves with `sort_data`.
  - **MOVE** — the payload came from **another** portal whose
    [`draggable_to`](#draggable_to) names this portal's tipo, and this portal is
    writable. A move source must also hold `can_drag_out` (a `draggable_to`
    list, no declared order, no view order). The target links first; the
    source unlinks only when the link landed.
  - **stale** — the payload was started in a row window that has since been
    replaced; it is consumed and nothing is sent (a "list changed" warning).
- **The absolute-key rule.** A reorder sends `source_key` = the dragged entry's
  `paginated_key` and `target_key` = the target entry's, both read from the
  window's frozen entries. `paginated_key` is the locator's **index in the
  stored array** — absolute, valid on every page and under a temporary view
  order — so the paginator's offset is never added. The server checks the
  locator against the source position and refuses an out-of-range key.
- **Foreign drags pass through.** A portal payload travels as
  `application/x-dedalo-portal-row` (plus a `text/plain` copy). A drag without
  that type — a file, a thesaurus term, a tool card — is never stopped and
  reaches its own target.
- **A reorder whose outcome is unknown** (the save succeeded but the refresh
  failed) says so and asks for a reload instead of claiming the order was not
  saved.

**Touch.** A finger cannot drag. Tap a row's source (the handle in the default
view, the row in mosaic / line) to pick it — a bar names what you carry — then
tap the target row to place it (`touch_pick.js`); the placement is the same
decision as a drop. **Cancel** in the bar puts it back.

**Keyboard and double-click: move to position.** Double-click on the handle, or
**Enter** on a handle reached with **Tab**, opens a small dialog with the row's
current 1-based position over the whole list; OK sends `sort_data` with
absolute keys (the typed position clamped to the list). The row is held while
the dialog is open. Both are offered only while `can_reorder` holds. The
handle's accessible name is "Change order for *section_id*" (label
`change_order_for`).

### The order model

The **stored locator array is the only order.** A new link is appended to it,
unless the portal declares an `order`.

- **A declared `order` is permanent and automatic.** Every write of the
  portal's key — a save, a link from the autocomplete, an add, a removal, a
  Time Machine restore, an observer mirror, a new or duplicated record — stores
  the array sorted by the declared columns (the record-write chokepoint). When
  a linked record's ordering value changes, every portal that holds it is
  re-sorted: the observer registry derives the edges from the declaration
  (see [edges derived from a declared order](../system/observers.md#edges-derived-from-a-declared-order)).
  Such a portal offers no drag, no move-to-position and no save of a header
  sort: the server refuses `sort_data` and `sort_by_column` on it
  (`request.invalid_data`, log reason `declared_order`). An array stored before
  its order was declared keeps its stored order until it is written again or
  the `portal_declared_order` reconcile sorts it; the reconcile runs from
  Maintenance (`reconcile_status`, dry unless applied — see
  [area_maintenance](../areas/area_maintenance.md#the-widgets)) or
  `scripts/reconcile.ts`, and is queued automatically after an ontology update
  or a local ontology edit adds or changes an `order`.
- **A header click is a temporary view.** On a column declaring
  `sort_by_column: true`, the click sets the instance's `view_order`
  `{tipo, direction}` (`set_view_order`), starts again from the first page and
  stamps `sqo.view_order` on every later read of the portal (pagination, a
  refresh, the re-read after a link, unlink or add). Nothing is written. While
  it is active rows cannot be dragged. Read permission is enough. A declared-order
  portal offers it too.
- **The order indicator** (`.list_after > .order_indicator`, edit mode) shows
  "Order: *column* ↑/↓". Under a temporary view order it carries **Reset**
  (`clear_view_order`, back to the stored order) and, when `can_save_view_order`
  holds (write permission, no declared order), **Save** (`save_view_order` →
  the `sort_by_column` save action with the same column and direction; the
  view order clears on success and stands on a refusal). Without a view order,
  a declared-order portal with rows shows its permanent order, without buttons.
- **One change at a time.** An order change, reset or save is refused while
  another one or another read of the portal is in flight; a refused or failed
  change restores the previous order and page. A view order the server
  refuses (a column the user may not read on every hop of its path) re-reads
  under the previous order.

Gates: `test/unit/portal_order_native.test.ts` (server),
`test/unit/client_relation_move_native.test.ts` (the drag decision), and the
browser suites `test_portal_order`, `test_portal_row_drag` and
`test_row_invariant` (`bun run test:client`). Wire contract:
`WC-2026-10-31-portal-order-model` and `WC-2026-10-30-section-record-row-box`
(`engineering/wire_contract/`).

## Import / export model

**Import.** Handled by the shared related-component import path. The default format is the JSON locator array; convenience short forms are accepted because the column head already names the component and the component knows its own `type`:

Default (full or trimmed locators — `type` / `from_component_tipo` may be omitted, they are injected):

```json
[{"type":"dd151","section_tipo":"rsc197","section_id":1,"from_component_tipo":"oh24"}]
```

```json
[{"section_id":2,"section_tipo":"rsc197"}]
```

A comma-separated list of target `section_id`s, valid when the portal has a single target section (the `section_tipo` is then resolved from that one configured target):

```text
1,5,8
```

With multiple possible target sections, disambiguate by naming the target in the column head as `oh24_rsc197` (`oh24` = the portal tipo, `rsc197` = the target section); then the integer-sequence form is accepted. Importing an integer sequence without a clear single target is rejected and logged (`IGNORED: Trying to import multiple section_tipo without clear target`); invalid `section_id` / `section_tipo` and malformed locators are likewise rejected per row. An empty cell clears the component data. See [Related data](../importing_data.md#related-data).

**Export.** The shared relation export path emits one export atom per locator, resolving each via the `show.ddo_map` — resolving the named target component(s) against the locator's `section_id` / `section_tipo` and collecting their value. The `ddo_map` drives the sub-columns, so a portal can export the target's term, its model, its parents (`value_with_parents`), etc., joined by the configured `fields_separator`. Relations export as JSON in SQL diffusion contexts. See [exporting data](../exporting_data.md).

## Notes

- **Directionality.** `config_relation.relation_type_rel` (locator `type_rel`) records uni / bi / multidirectional relations. Unidirectional stores the locator only on the originating side; bidirectional / multidirectional also write the inverse locator into the target record so the relation is queryable from both records. A plain link portal leaves `type_rel` unset.
- **Add semantics (the New button).** `add_new_element` creates a record in the target section (inheriting the host's projects filter, or the default project), appends the link locator, and opens the new record in a modal. Two things in the save response make "the new record" unambiguous: the echoed datum is paged to the **last page** — where the appended locator lives, which is also the page the paginator lands on — and `result->created_section_id` carries the created `section_id` outright. The client opens that address and only falls back to the last echoed entry when no address arrives. Both are ledgered as WC-081; a page-one echo made a paginated portal (e.g. one configured `sqo.limit: 1`) open the *first* linked record instead.
- **Remove semantics.** The remove action takes a `remove_mode`: `delete_link` (default — unlink only) or `delete_all`. `delete_all` hard-deletes the **target** section record and therefore requires write/delete permission on the *target* section itself (REL-06) — permission on the host record is not sufficient. Bulk partial-locator removal is `deletePortalLocator` (`src/core/relations/save.ts`, the `dd_component_portal_api.delete_locator` action); `delete_all`'s target-record hard-delete is not yet ported.
- **Observers / observables.** Portals are a common observer target: e.g. a numismatic *coins* portal observes a *type* field and recomputes its own data from its external source on change. Wiring lives in the ontology `properties` (`observe` / `observers`), not in the component — see the *Observers and observables* section of the [components index](index.md).
- **Default tools.** The verified model sample exposes `tool_propagate_component_data` and `tool_time_machine`; the toolbar is assembled from the model + ontology, not hardcoded, and narrows further for `external` portals (tools off).
- **Permissions.** Resolved by the permissions engine (`getPermissions()`, `src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Read users (level 1) get the read-only list and may still sort it temporarily by a header; add / link / remove / reorder / move and saving a header order require level >= 2.
- **Behaviour that comes from the shared relations engine.** A portal owns almost none of its own machinery. Locator normalisation and validation on save, de-duplication (locators are compared on a fixed key set by `compareLocators()`, `src/core/concepts/locator.ts`), adding and removing a locator with the dataframe cascade (`src/core/relations/save.ts`), grid/export/diffusion resolution, parent-reference cleanup when a record is deleted, and the relation search builders all live in the shared engine under `src/core/relations/` and are used identically by every relation-column model.
- **Related components:** [component_check_box](component_check_box.md), [component_dataframe](component_dataframe.md), [component_inverse](component_inverse.md), `component_select`, `component_radio_button`, `component_relation_parent`, `component_relation_children`, `component_relation_related`, `component_publication`, [component_input_text](component_input_text.md) (the literal counterpart for non-relational fields).
