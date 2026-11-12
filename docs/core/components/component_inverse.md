# component_inverse

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : true,
    "is_related"            : false,
    "is_media"              : false,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools"         : [],
    "render_views" : [
        {
            "view" : "default | line",
            "mode" : "edit"
        },
        {
            "view" : "mini | print",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text",
            "mode" : "list | tm"
        }
    ],
    "data"        : "array of inverse locators (computed, never stored)",
    "sample_data" : [
        {
            "id"                  : 1,
            "section_id"          : 1,
            "section_tipo"        : "rsc550",
            "from_component_tipo" : "tch171",
            "from_section_tipo"   : "tch1",
            "from_section_id"     : "1"
        }
    ],
    "value"        : "array of caller section_id strings",
    "sample_value" : ["1", "3"]
}
```

!!! note "Typology"
    `component_inverse` is an **info** component (the "literal-info" branch of the typology). Like every info component it behaves as a literal at read time — its resolved value is surfaced through its own section exactly like a direct component — but it owns no data of its own: the value is *calculated on the fly* from the relations that point **at** the current record. Its sibling info component is `component_info`. Contrast the related branch ([component_portal](component_portal.md), [component_select](component_select.md)) which stores and resolves outgoing [locators](../locator.md).

!!! info "About `default_tools`"
    The sample model ships with an empty `tools` array (verified in `samples/context.json`). `component_inverse` is non-translatable and read-only, so the language and propagation tooling that translatable/writable components receive does not apply. As always the toolbar is assembled from the model + ontology; it is not hardcoded.

## Definition

`component_inverse` displays the **backlinks** of a record: the list of other records, in other sections, that reference the current record through a relation field (a [component_portal](component_portal.md), a relation component, or a [component_dataframe](component_dataframe.md)). It answers the question *"who points at me?"* without storing that list anywhere.

**Why it exists.** Relations in Dédalo are stored on one side only — the section that owns the [component_portal](component_portal.md) (or other relation component) writes the locator into its `relations` array. The pointed-at record holds nothing. Without `component_inverse` the inverse direction would be invisible to the cataloguer, or it would have to be duplicated and kept in sync by hand. `component_inverse` computes the inverse direction dynamically — via a `mode='related'` search over all matrix tables — so the backlink list is always correct and never drifts from the authoritative outgoing relation.

**When to use it.**

- Show, on a *Restoration Intervention* record (`rsc550`), every *Catalogue* record (`rsc555`) whose portal references this intervention — a read-only "referenced by" panel.
- Show, on an *Informant* / *Person* record, all the *Oral source* and *Cultural item* records that cite this person, even though only those records carry the relation.
- Any "appears in", "cited by", "used in", "referenced by" panel where the relation is authored on the **other** section and you only want to read it back.

**When not to use it.**

- You want to *create or edit* the relation — author it on the owning side with a [component_portal](component_portal.md), [component_select](component_select.md) or a relation component. `component_inverse` is strictly read-only and persists nothing.
- You want a value the cataloguer types or that belongs to this record — use a literal-direct component such as [component_input_text](component_input_text.md).
- You need a stored, hand-orderable list — `component_inverse` has nothing to store and nothing to sort persistently; its content is recomputed on every load.

## Data model

**Data type:** `array of inverse locators`. Each entry is a locator object describing one incoming reference. It is computed, never persisted.

**Value type:** `array` of caller `section_id` strings (the `from_section_id` of each inverse locator), or an empty array.

**Storage shape.** This component has **no value to store**. Its defining behavior is to ignore any matrix value and instead resolve the inverse references live: build a minimal filter locator for the current `{section_tipo, section_id}` and run a `mode='related'` search over all matrix tables; each matching relation row is decoded and decorated with `from_section_tipo`, `from_section_id` (and it already carries `from_component_tipo`). If the section has no `section_id` yet (a brand-new, unsaved record), the result is an empty array.

!!! note "Where the live compute happens"
    The value is computed at emit time by the model's emit hook (`src/core/components/component_inverse/emit.ts`, `resolveInverseEntries`), which runs the related search of `src/core/search/search_related.ts` for the record and keeps only the callers the requesting user may read (section read grant + projects boundary). The `misc` slot named by the descriptor is never read. The export reads the same function, so the edit view and an export always list the same callers.

Each computed inverse locator looks like this:

```json
{
    "id"                  : 1,
    "section_id"          : 1,
    "section_tipo"        : "rsc550",
    "from_component_tipo" : "tch171",
    "from_section_tipo"   : "tch1",
    "from_section_id"     : "1"
}
```

- `section_tipo` / `section_id` — the **current** record (the one being read).
- `from_section_tipo` / `from_section_id` — the **caller** record that points at us (the backlink target).
- `from_component_tipo` — the relation component on the caller side that authored the reference (e.g. the portal tipo `tch171`).

!!! note "The ontology `misc` column"
    The descriptor notes that any configuration this component may carry lives in the matrix `misc` column, not the data column — because the data column is never read or written for `component_inverse`. There is no value array to persist.

!!! note "Datum vs. API `entries`"
    The transmitted unit is the `{context, data}` datum (the JSON-API contract). In the API payload the computed inverse locators are surfaced under `data.entries` alongside `parent_tipo`, `row_section_id` and `changed_data` (always empty). `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `css`, `permissions`, `view`) and never the values. See the *dedalo-context-data-layers* skill for the full layering rules. A representative payload (verified from `samples/api_data.json`):

    ```json
    {
        "section_id"   : 1,
        "section_tipo" : "rsc550",
        "tipo"         : "rsc555",
        "mode"         : "edit",
        "lang"         : "lg-nolan",
        "entries"      : [
            {
                "id"                  : 1,
                "section_id"          : 1,
                "section_tipo"        : "rsc550",
                "from_component_tipo" : "tch171",
                "from_section_tipo"   : "tch1",
                "from_section_id"     : "1"
            }
        ],
        "row_section_id" : 1,
        "parent_tipo"    : "rsc550",
        "changed_data"   : []
    }
    ```

## Ontology instantiation

A `component_inverse` is created as an ontology node whose `model` is `component_inverse`. Its `parent` (and `section_tipo`) wire it into the section whose *backlinks* you want to display. Because it is non-translatable, the component is forced to `lg-nolan` at construction. There is no `is_translatable` to set true here.

Node definition (shape):

```json
{
    "tipo"         : "rsc555",
    "model"        : "component_inverse",
    "parent"       : "rsc550",
    "section_tipo" : "rsc550",
    "lg-eng"       : "Catalogue",
    "lg-spa"       : "Catálogo",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block (this component reads only the two grid/flatten separators; the rest of `properties` is the generic context — `css`, `view`, `request_config`):

```json
{
    "css" : {
        ".wrapper_component" : {
            "max-height"       : "5.5rem",
            "text-align"       : "center",
            "grid-column"      : "span 1",
            "background-color" : "#ee9916"
        },
        ".wrapper_component>.label"        : { "color" : "#ffffff" },
        ".wrapper_component>.content_data" : { "color" : "#ffffff" }
    },
    "fields_separator"  : ", ",
    "records_separator" : " | "
}
```

`section_tipo` / `parent` tell the section which node this component belongs to, but nothing is ever written for it — the section is never asked to persist component data for an inverse field. The inverse list is recomputed from the live relations every time the section is loaded.

!!! warning "No defaults, no save"
    A save request against a `component_inverse` is a logged no-op by design: nothing is persisted. The `dato_default` property is meaningless for it (there is nothing to seed), and Time Machine never records inverse data — the authoritative data is the outgoing relation on the other section, which has its own Time Machine history.

## Properties & options

`component_inverse` reads only the two presentation separators from the ontology `properties` JSON; both are optional and used solely when the inverse list is flattened to a single string for grid display or flat-table export.

### fields_separator

- **Values:** string (default `", "`).
- **Effect:** the separator used **inside** a single caller-pair column when several callers of the same `(from_section_tipo, from_component_tipo)` pair are joined into one grid/export cell — the per-pair leaf separator for both the grid and the export atoms.

### records_separator

- **Values:** string (default `" | "`).
- **Effect:** the separator stamped on the grid row (the grid cell's records-separator setting) used to join the component's columns when the inverse component is flattened to a single grid string.

!!! note "Standard context properties"
    Like every component, `component_inverse` honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `view` (the render view) and `request_config` (RQO). These are not component-specific options. **No other property names are consumed by this component** — `mandatory`, `unique`, `validation`, `dato_default`, `has_dataframe`, etc. have no effect here. Any other key seen in production should be verified in the ontology.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files (`render_edit_component_inverse.js`, `render_list_component_inverse.js`). Verified from the source:

| View | edit / search | list / tm | Notes |
| --- | :---: | :---: | --- |
| `default` | yes | yes | Edit: full wrapper (`label`, `buttons` only when `permissions > 1`, `content_data`) with one `content_value` per inverse locator, each showing the caller `from_section_id` in a `span.inverse_show_section_id`. List: `build_wrapper_list` with the first entry's `from_section_id` as the value string. |
| `line` | yes | — | Edit only; same as default but the label node is suppressed (compact inline, `.view_line { display:inline-block }`). |
| `mini` | yes | yes | Minimal `build_wrapper_mini`; injects the first caller `from_section_id` as text. Used by service autocomplete / datalist. |
| `text` | — | yes | Plain `<span class="wrapper_component component_inverse <mode> view_text">` containing the first caller `from_section_id`. |
| `print` | yes | — | Reuses the `default` edit view but forces read-only rendering (`self.permissions = 1`). |

Modes (`render_edit` serves `edit` and `search`; `render_list` serves `list` and `tm`):

- **edit** — read-only display of the live inverse list. Buttons appear only for `permissions > 1`, but there is no writable input; the component renders one read-only `content_value` per backlink. Note `search` is wired to the **same** render as `edit` in the JS model (`component_inverse.prototype.search = render_edit_component_inverse.prototype.edit`), so there is no dedicated search-filter UI — `component_inverse` is not a meaningful search target.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render verbatim (`prototype.tm = render_list_component_inverse.prototype.list`). Both are served the same flattened list value.

DOM (edit / default): `wrapper_component component_inverse <tipo> <mode>` → `label`, `buttons`, `content_data` → one or more `content_value` → `span.inverse_show_section_id`.

## Import / export model

**Import.** `component_inverse` has nothing to import: the inverse list is derived from the *outgoing* relations on the other section, so an import value routed at an inverse column is meaningless (and see the write-path caveat under [Notes](#notes)). To populate backlinks, import the relation on the **owning** side (the [component_portal](component_portal.md) / relation component), not here. See [importing data](../importing_data.md).

**Export.** The export tool exports the computed backlinks (the `inverse` flatValue family): one atom per caller, its value the caller `from_section_id`. The `(from_section_tipo, from_component_tipo)` pair travels as a **sub-segment**, so in the breakdown each distinct calling pair becomes its own column. Taking the Relations field `dd1596` of a People (`rsc197`) record pointed at by two interviews (`oh1`) through their Informants portal (`oh24`) — corpus nodes of an oral-history install:

- **Standard** (`value`): one column *Relations*, cell `3, 7` (every caller id, each calling field's callers together in ascending order, joined with `, `; the groups joined with the column's configured separator, `, ` by default).
- **Breakdown** (`grid_value`): one column per calling field (*Relations | Informants*), and each caller is its own item — each column lists its callers one per row in the `default` and `rows` modes (as many rows as the busiest calling field), one `|n` column per caller in `columns`.
- **Dédalo (Raw)** (`dedalo_raw`): the computed inverse locators wrapped as `{"dedalo_data": [...]}`; the import skips the column.

Callers from records the requesting user may not read are omitted, as in the edit view. See [exporting data](../exporting_data.md#what-a-backlinks-column-contains).

## Notes

- **No storage, computed live.** The defining trait: it ignores the matrix data column and computes the backlinks live — a minimal filter locator for the current record, then a `mode='related'` search (with breakdown) over all matrix tables, done by the emit hook (see the note under [Data model](#data-model)). Edit view, list view and export read the same computed list.
- **Read-only by design — unenforced on the TS write path.** The intended contract is a read-only no-op save (log a warning and return without persisting). **The generic TS save engine (`src/core/section/record/save_component.ts`) has no `component_inverse` guard**: nothing under `src/` special-cases this model to refuse a write, so a save request routed at a `component_inverse` tipo would actually persist into the `misc` column instead of being a no-op. In practice the copied client never issues such a save (there is no writable input for this component), but an API caller bypassing the client could. An unsaved record (empty `section_id`) yields an empty list. Time Machine does not track inverse data.
- **Observers / observables.** None ship for this component. As a purely derived read-only view it does not publish or observe data changes; its content simply re-resolves whenever the host record is reloaded.
- **Default tools.** The sample model exposes no tools (`tools: []`). Tools, when added, are read-only context like any component.
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Data is emitted only for `permissions > 0`. Even at level 2–3 the component stays read-only (no input element); buttons render only above level 1.
- **Related components:** [component_portal](component_portal.md), [component_select](component_select.md), [component_check_box](component_check_box.md), [component_dataframe](component_dataframe.md), [component_input_text](component_input_text.md). The outgoing/authoritative side is always one of the relation components; `component_inverse` only reflects them back.
