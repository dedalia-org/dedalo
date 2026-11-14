# component_relation_parent

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
    "render_views" :[
        {
            "view" : "default | line",
            "mode" : "edit | list"
        },
        {
            "view" : "content | indexation | mini | mosaic | tree",
            "mode" : "edit"
        },
        {
            "view" : "text",
            "mode" : "list"
        }
    ],
    "data"        : "array of locators",
    "sample_data" : [{
        "id"                  : 1,
        "type"                : "dd47",
        "section_tipo"        : "test3",
        "section_id"          : 2,
        "from_component_tipo" : "test71"
    }],
    "value"        : "array of strings",
    "sample_value" : ["Europe"]
}
```

!!! note "Typology"
    `component_relation_parent` is a **related** component. Like every related component it stores [locators](../locator.md) that point at other records rather than literal data, and resolves its displayed `value` from the *target* (parent) record.

!!! info "Client is an alias of component_portal"
    The client class is a thin alias: `client/dedalo/core/component_relation_parent/js/component_relation_parent.js` exports `component_relation_parent = component_portal`. All client behaviour (render files, views, the edit/list/search UI) is therefore [component_portal](component_portal.md)'s, which is why the `render_views` above mirror the portal. The server side, however, has its own parent-specific tree semantics (cycle guard, child ordering, recursive ancestor walk).

!!! info "About `default_tools`"
    The tools above are what a typical instance receives in `context.tools` (verified from the component model sample): `tool_propagate_component_data` and `tool_time_machine`. The component is non-translatable, so the `tool_lang` family is not added. The toolbar is assembled from the model + ontology; nothing hardcodes it. The server additionally forces `properties.show_interface.button_add` to `false` so the client never offers a generic "add" button — parents are linked through the thesaurus / tree UI, not created inline.

!!! info "TS server implementation"
    Row emission reuses the shared portal engine: the descriptor `src/core/components/component_relation_parent/descriptor.ts` registers `resolveData: 'portal'` (`src/core/relations/models/portal.ts`) — a parent link renders like any other relation cell. This is a **read-projection equivalence only**; the distinctive hierarchy behaviour lives in dedicated modules: the ancestor walk (`getParents` / `getParentsRecursive` / `isAncestor`) and the mutation half (`addParent` / `moveParent`, cycle + auto-reference guards) are in `src/core/relations/parent.ts`; sibling ORDER (the `component_number` id_key dataframe) is in the same file (`setChildOrder` / `removeChildOrder` / `recalculateSiblingOrders` / `sortChildren`) built on the inline id_key API in `src/core/relations/dataframe.ts`. Search is ported: the descriptor declares `search: { status: 'ported' }`, and a parent link searches as a normal relation through the shared containment builder. See the *dedalo-relations-ts* and *dedalo-tree-ts* skills.

## Definition

`component_relation_parent` records the **parent reference(s)** of the current record, building the upward edge of a tree/hierarchy between records of the same (or another) section. Each parent is stored as a locator pointing at the parent record; the inverse downward view is provided by [component_relation_children](component_relation_children.md) on the parent's side. Together they form the parent ↔ children pair that underpins every Dédalo thesaurus and hierarchical ontology.

**Why it exists.** Cultural-heritage data is frequently hierarchical: a place inside a region inside a country; a fonds → series → file → item archival arrangement; a broader-term/narrower-term thesaurus of subjects, materials or techniques. Rather than duplicating the tree in a bespoke table, Dédalo stores the *child's* link to its parent in this component and the *parent's* link to its children in `component_relation_children`. Because the edge is a plain locator inside the section-wide `relations` bag, the same record can sit in a hierarchy and still be reached, searched and diffused like any other record.

**When to use it.**

- Thesaurus / authority hierarchies: a *Term* whose broader term is another *Term* (e.g. *Romanesque* under *Medieval*).
- Geographic or administrative trees: *Town* → *Province* → *Country*.
- Archival classification: an *Item* whose parent is a *File*, whose parent is a *Series*.
- Any "belongs to / is part of" relationship where you also want the reciprocal "contains" view on the parent.

**When not to use it.**

- A symmetric or non-hierarchical association between records → use [component_relation_related](component_relation_related.md) (related/see-also) or [component_portal](component_portal.md).
- A simple link to one or more records with no parent/child semantics and no tree ordering → use [component_portal](component_portal.md), [component_select](component_select.md) or [component_autocomplete](component_portal.md).
- The *downward* (contains) view of the same hierarchy → that is [component_relation_children](component_relation_children.md), not this component.

## Data model

**Data:** `array of locators`.

**Value:** `array` of `strings`, or `null`. The strings are resolved from the *parent* record (its term/label), not stored locally.

**Storage shape.** A component never touches the database; it reads and writes through its section. A `component_relation_parent` stores its locators in the section-wide `relations` container, and the component slices out its own subset by matching `from_component_tipo` against its own `tipo` (and the relation `type`, `dd47`). The canonical locator shape for this component:

```json
[
    {
        "id"                  : 1,
        "type"                : "dd47",
        "section_tipo"        : "test3",
        "section_id"          : 2,
        "from_component_tipo" : "test71"
    }
]
```

- `type` — the relation-type tipo. For parent relations this is `dd47` (the descriptor's `defaultRelationType`); children use `dd48`, related `dd89`. The relations engine injects and normalises it on save.
- `section_tipo` / `section_id` — point at the **parent** record.
- `from_component_tipo` — the tipo of *this* component (the owner of the locator); this is what lets the single section-wide `relations` array serve many distinct relation components. The relations engine forces it to the owning component's own `tipo` on save.
- `id` — the per-item counter id.

This component is **not translatable** (`lang` is `lg-nolan`), so locators carry no `lang`. Auto-references (a record pointing at itself) and descendant cycles are rejected before storage (see *Notes*).

!!! note "Section-wide `relations` bag"
    Like all related components, the persisted locators live in the section's global `relations` container; a record can therefore declare its parent and its children edges side by side, each disambiguated by `from_component_tipo`. The component's own matrix `relation` column holds the JSONB map `{component_tipo: [locators]}`; `relation_list` and other components slice the right subset out of the global bag.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum. In the API payload the locators are surfaced under `data.entries` (each augmented with a `paginated_key`), accompanied by `parent_tipo`, `parent_section_id` and `pagination`. When the recursive ancestor walk detects a loop, the resulting errors are attached to the data item so the client can warn the user. See the *dedalo-context-data-layers* skill for the full layering rules.

## Ontology instantiation

A `component_relation_parent` is created as an ontology node whose `model` is `component_relation_parent`. Its `parent` is the section (or grouper) it belongs to, and `section_tipo` wires it into that section. The relation type is read from the node's `properties.config_relation.relation_type`; when absent it falls back to the descriptor's `defaultRelationType` (`dd47`).

Node definition (shape):

```json
{
    "tipo"         : "test71",
    "model"        : "component_relation_parent",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "Parent",
    "lg-spa"       : "Padre",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block for a thesaurus *parent term* pointing at the same section (`self`), listing parents with their own term column resolved with its ancestors:

```json
{
    "config_relation": {
        "relation_type": "dd47"
    },
    "source": {
        "records_mode": "list",
        "request_config": [
            {
                "sqo": {
                    "section_tipo": [ { "source": "self" } ]
                },
                "show": {
                    "ddo_map": [
                        {
                            "tipo"               : "test52",
                            "parent"             : "self",
                            "section_tipo"       : "self",
                            "value_with_parents" : true
                        }
                    ]
                }
            }
        ]
    },
    "show_interface": {
        "button_add"    : false,
        "button_link"   : true,
        "button_delete" : true,
        "button_tree"   : true
    }
}
```

`section_tipo` / `parent` tell the section which column owns this component's relation data; on save the section is the single writer to the database. The `source.request_config` (RQO) defines the target section(s) and the columns to resolve for display — `"source": "self"` keeps a record's parents inside the same section (the normal thesaurus case), but a different `section_tipo` lets a record's parent live in another section.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. The names below are the real keys consumed by this component (they come from the shared relations engine, so they are identical to those of [component_portal](component_portal.md)). If a key is not in this list, **verify in the ontology** before relying on it.

### config_relation

- **Values:** an object, currently `{relation_type, relation_type_rel}`.
- **Effect:** `config_relation.relation_type` overrides the locator `type` written by this component (default `dd47`); `config_relation.relation_type_rel` sets the directionality (`type_rel`) on the locator. For parent relations the default type `dd47` is normally left implicit.

### source

- **Values:** an object `{records_mode, request_config, mode, …}`.
- **Effect:** the relation source descriptor shared with all related components. `request_config` carries the RQO that defines the **target** section(s) (`sqo.section_tipo`, often `{"source":"self"}` for a same-section thesaurus) and the `show.ddo_map` columns resolved for each parent's display value (e.g. the parent's term component with `value_with_parents: true`). `records_mode` (`"list"` in the sample) controls how the option/record list is presented.

### show_interface

- **Values:** an object of boolean / sub-object flags (e.g. `button_add`, `button_link`, `button_delete`, `button_delete_link`, `button_delete_link_and_record`, `button_edit`, `button_list`, `button_tree`, `button_fullscreen`, `show_autocomplete`, `show_section_id`, `list_from_component_data`, `label`, `read_only`, `tools`, `value_buttons`, `button_edit_options`).
- **Effect:** toggles the client buttons and chrome of the relation widget. **Note:** the server always overrides `show_interface.button_add` to `false` for `component_relation_parent`, so even if the ontology sets it true, the generic add button is suppressed (parents are linked via the tree/thesaurus, not created inline).

### css

- **Values:** an object keyed by CSS selector (e.g. `{".wrapper_component": {"grid-column": "span 6"}}`).
- **Effect:** the generic ontology style block, stamped on the component wrapper. Not specific to this component.

!!! note "Standard context properties"
    Like every component, `component_relation_parent` also honours the generic ontology context blocks carried into the datum `context`: `request_config` (RQO), `css` and `view` (the render view). These are not parent-specific options.

!!! note "Ordering uses the section_map order component"
    `component_relation_parent` does not declare an `order` property of its own. When it adds or removes a parent it reads the order component tipo from the section map (`getSectionMap()`, `src/core/ontology/section_map.ts`) under `thesaurus.order` and writes the child's position there. The order is a **dataframe paired by `id_key`** to the child's parent-link locator (a `component_number` value `{value, id_key}`), so a child carries an independent order per parent. If the section_map defines no `order`, ordering is silently skipped. See *Notes*.

## Render views & modes

The client is an alias of [component_portal](component_portal.md), so the views and modes are the portal's. Verified from `client/dedalo/core/component_portal/js/` and the parent sample `context.view` (`line`):

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | (via search render) | Full relation widget: label, buttons, the list of linked parents with per-row buttons (link / delete / tree). |
| `line` | yes | yes | — | Compact single-line presentation (the sample instance uses `line`). |
| `content` | yes | — | — | Inline content view. |
| `indexation` | yes | (list variant) | — | Thesaurus indexation presentation of the relation. |
| `mini` | yes | yes | — | Minimal presentation for tight space. |
| `mosaic` | yes | — | — | Grid/mosaic layout. |
| `tree` | yes | — | — | Tree-style picker (natural for hierarchical parents). |
| `text` | — | yes | — | Plain joined value, no chrome. |

Modes:

- **edit** — read/write the parent locators; add/remove parents, with auto-reference and descendant-cycle rejection, and automatic child-order maintenance.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render and is fed as subdata rows.
- **search** — builds an SQO relation filter against the target section(s); saves are blocked in search mode.

The server CSS for the parent itself is minimal (`client/dedalo/core/component_relation_parent/css/component_relation_parent.less` only defines a `view_default` wrapper); the visual styling is inherited from the portal stylesheet.

## Import / export model

**Import.** Import uses the shared `conformImportData()` (`src/core/tools/import_data.ts`). It accepts:

- The full JSON locator array (default, round-trips an export):

```json
[{"type":"dd47","section_tipo":"test3","section_id":2,"from_component_tipo":"test71"}]
```

- A bare `section_id` sequence when the component has a single resolvable target section (the parent section), e.g. `2,5,8`. The CSV column header carries the target when needed, in the form `from_component_tipo` + delimiter + `target_section_tipo` (e.g. `test71_test3`); when only the component tipo is given the target is resolved from the RQO. An empty cell clears the existing data (result `null`).

The import engine always rewrites `from_component_tipo` to this component's own `tipo` and stamps the locator `type` from the resolved relation type. Multiple candidate target sections with no explicit target are rejected and logged as `IGNORED`. See [importing data](../../using/importing_data.md#related-data).

**Export.** The shared relation export path iterates the locators and, per the `ddo_map`, resolves each requested column component against the parent's `section_id` / `section_tipo` to produce the sub-columns; the indexation grid resolves the same way. In SQL diffusion targets the locators are emitted as JSON. See [exporting data](../../using/exporting_data.md).

## Notes

- **Hierarchy integrity (server-enforced).** A parent link that would close a cycle is refused with `tree.cycle` (409): an **auto-reference** (a record pointing at itself) or a **descendant cycle** (the prospective parent is already a descendant). The check is `assertParentLinksAcyclic()` (`src/core/relations/parent.ts`): inside the write's transaction it locks the child row and walks the new parent's ancestors under share locks, so two moves that together would close a loop cannot both commit. Only links a write adds are checked, so an existing loop can still be cut. The tree doors (`addParent()` / `moveParent()`) run it themselves; see [the thesaurus lock law](../thesaurus/index.md#the-lock-law-no-lost-update-no-stored-cycle). The read-side walk `getParentsRecursive()` is loop-guarded per path (a path-local `visited` set), records a loop as an error instead of recursing, and de-dupes ancestors by `section_tipo_section_id`.
- **Child ordering.** `addParent()` calls `setChildOrder()`, and `moveParent()` calls `removeChildOrder()` for the old link and `setChildOrder()` for the new one (`src/core/relations/parent.ts`); both read the order component tipo from the section map and write the child's position as an **`id_key` dataframe** of the parent-link locator (`{value, id_key}` on a `component_number`, via the inline id_key helpers in `src/core/relations/dataframe.ts`) so siblings keep a stable order. `addParent()` **pre-allocates** the parent locator's `id` before ordering so the order can pair before the save mints ids. `recalculateSiblingOrders()` renumbers a parent's children 1..n, resolving each child's `id_key` via `resolveParentLinkIdKey()` (`src/core/relations/children.ts`). The id_key contract is documented in [component_dataframe → Relation ordering](component_dataframe.md#relation-ordering-the-order-is-a-dataframe).
- **Convenience API.** Adding or moving a parent edge from the child's side is exposed directly as `addParent()` / `moveParent()`, and reading it as `getParents()` / `getParentsRecursive()` (`src/core/relations/parent.ts`); the mutations need an open transaction. A link is removed through the record-write path (the edit form's save of this component) or by a move. Root-of-hierarchy detection (used for diffusion) has no confirmed implementation in this checkout.
- **Default tools.** A typical instance exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools`. Tools are read-only context.
- **Persistence.** The locators are also kept in the section relations index; the section is the single database writer.
- **Sortable.** This component is sortable by default (its descriptor declares no `sortable: false` override), so it may be used as a sort column in list contexts.
- **Observers / observables.** Not wired by default; observer/observable behaviour, when needed, is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section).
- **Related components:** [component_relation_children](component_relation_children.md) (the inverse downward view), [component_relation_related](component_relation_related.md), [component_relation_index](component_relation_index.md), [component_portal](component_portal.md) (client alias), [component_select](component_select.md), [component_autocomplete](component_portal.md), [component_dataframe](component_dataframe.md).
