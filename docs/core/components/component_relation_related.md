# component_relation_related

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
            "view" : "default | line | content | indexation | mosaic | tree | mini",
            "mode" : "edit"
        },
        {
            "view" : "default | line | text | mini",
            "mode" : "list"
        }
    ],
    "data" : "array of locators",
    "sample_data" : [{
        "id"                  : 1,
        "type"                : "dd89",
        "type_rel"            : "dd620",
        "section_id"          : 2,
        "section_tipo"        : "test3",
        "from_component_tipo" : "test54"
    }],
    "value" : "array of string",
    "sample_value" : ["Bronze (related term)"]
}
```

!!! note "Typology"
    `component_relation_related` is a **related** component. It does not own a literal value: it stores an array of [locators](../locator.md) pointing at other records and resolves the displayed strings from the *target* section/component. On the client it is a direct **alias of [component_portal](component_portal.md)** (`export const component_relation_related = component_portal`), so it reuses the portal UI, render and data-management code; the related-specific behaviour (reference resolution, directionality) lives server-side.

!!! info "TS server implementation"
    The descriptor `src/core/components/component_relation_related/descriptor.ts` registers `resolveData: relationRelatedResolver` (`src/core/relations/models/relation_related.ts`). Non-`list` modes take the shared portal engine but always emit the component's own item — even when the stored data is empty (`entries: []`, so the client can add references) — and attach the computed back-references (`item.references`) via `getCalculatedReferences()` (`src/core/relations/related.ts`), except in `search` mode. `list` mode additionally emits a `component_section_id` item per related target (grid-cell contract) before the paginated relation item itself. The graph walk (unidirectional/bidirectional/multidirectional, `dd620`/`dd467`/`dd621`) lives in `src/core/relations/related.ts` (`getReferences`, the visited-cache-guarded recursive traversal). See the *dedalo-relations-ts* skill.

!!! info "About `default_tools`"
    The list above is what an instance receives in `context.tools` (verified from the model sample `samples/context.json`): `tool_propagate_component_data` and `tool_time_machine`. The component is non-translatable, so the language tools are not added. The toolbar is assembled from the model + ontology; nothing hardcodes it. The server forces `properties.show_interface.button_add` to `false` so the client does not draw the generic *add* button — references are managed through the thesaurus/relation UI.

## Definition

`component_relation_related` manages **associative (non-hierarchical) relationships between thesaurus terms**. Where [component_relation_parent](component_relation_parent.md) and [component_relation_children](component_relation_children.md) model the vertical *broader/narrower* axis of a thesaurus, `component_relation_related` models the horizontal *see-also / related-term* axis (the ISO-25964 *RT* relationship): it links a term to other terms that are semantically associated but not in its branch.

**Why it exists.** A controlled vocabulary needs more than a tree. A term such as *Birds* should point sideways to *Ornithology*; a material *Bronze* relates to *Copper* and *Tin*; an iconographic subject *Baptism* relates to *John the Baptist*. These are cross-branch associations that the parent/children hierarchy cannot express. `component_relation_related` provides that link and, crucially, can compute the **back-references** (terms that point *to* the current term) so the relationship can be navigated from both ends without storing it twice — see *Directionality* below.

**When to use it.**

- Thesaurus *related term* (RT) links: *see also*, *associated with*, *compare with*.
- Cross-branch semantic associations inside a single thesaurus / hierarchy section (the typical target section is the same thesaurus the term lives in).
- Cases where you want the relationship reachable from both records but stored once (bidirectional / multidirectional types).

**When not to use it.**

- A broader/narrower hierarchical link between terms -> use `component_relation_parent` / `component_relation_children`.
- A generic relation from a catalogue record to another section (a person, a place, an object) -> use [component_portal](component_portal.md) (relation type `dd151`).
- A pick-from-list relation rendered as a dropdown / checkboxes -> use [component_select](component_select.md), [component_check_box](component_check_box.md) or [component_radio_button](component_radio_button.md).

## Data model

**Data:** `array of locators`.

**Value:** `array` of `strings`, or `null`. The value is **not stored**; it is resolved from the target term (its `component_input_text` thesaurus term, optionally with parents) when the component is read.

**Storage shape.** A component never touches the database; it reads and writes through its section. A related component's own locators live in the section matrix `relation` column as a JSONB map `{component_tipo: [locators]}`, and the section also keeps a global `relations` bag aggregating every locator in the record. The component slices its own subset out of that global array by matching `from_component_tipo` (and `section_tipo`).

The canonical locator for this component carries `type = dd89` (the related relation-type tipo) and `type_rel` (the directionality tipo, default `dd620`):

```json
[
    {
        "id"                  : 1,
        "type"                : "dd89",
        "type_rel"            : "dd620",
        "section_id"          : 2,
        "section_tipo"        : "test3",
        "from_component_tipo" : "test54"
    }
]
```

- `type` — relation-type tipo, defaults to the descriptor's `defaultRelationType` (`dd89`). Injected and normalised by the relations engine on save.
- `type_rel` — directionality tipo (`dd620` unidirectional / `dd467` bidirectional / `dd621` multidirectional).
- `section_tipo` / `section_id` — point at the *target* term record.
- `from_component_tipo` — the owning component's own `tipo`; this is what lets the section-wide relations bag serve many distinct relation components. The relations engine forces it to the component's own `tipo` (cloning the locator first), rejects auto-references and malformed locators, and de-dupes them.
- `id` — per-item counter id.

Because the component is non-translatable, it is instantiated with `lang = lg-nolan`; locators have no `lang` key.

!!! note "Stored data vs. calculated references"
    `readComponentItems()` (`src/core/resolve/component_data.ts`) returns only the **stored** locators (relations authored on this record). `getCalculatedReferences()` (`src/core/relations/related.ts`) resolves the **back-references** — locators on *other* records that point here — for bidirectional / multidirectional types; the read path merges both into the emitted datum. In the API payload the stored locators are surfaced under `data.entries`; the calculated references are attached to the item as `item.references` (skipped in `search` mode). See *Directionality*.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum (the JSON-API contract). `data` carries the locators (`data.entries`) plus `parent_tipo`, `parent_section_id`, `pagination` and, when present, `references`; `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view`, `request_config`, `fields_separator`) and never the resolved value strings, which are delivered as subdata of the target components. See the *dedalo-context-data-layers* skill for the layering rules.

## Ontology instantiation

A `component_relation_related` is created as an ontology node whose `model` is `component_relation_related`. Its `parent` is the section (or grouper) it belongs to, and `section_tipo` wires it into that section — typically a thesaurus / hierarchy section, since related terms point back into the same vocabulary.

Node definition (shape):

```json
{
    "tipo"         : "test54",
    "model"        : "component_relation_related",
    "parent"       : "test45",
    "section_tipo" : "test3",
    "lg-eng"       : "Related terms",
    "lg-spa"       : "Términos relacionados",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block (verified shape, from `samples/context.json`) — a related-term field over the same thesaurus section, unidirectional, showing the target term column:

```json
{
    "source": {
        "records_mode": "list",
        "request_config": [
            {
                "show": {
                    "ddo_map": [
                        {
                            "tipo": "test52",
                            "parent": "test54",
                            "section_tipo": "self"
                        }
                    ]
                }
            }
        ]
    },
    "config_relation": {
        "relation_type"     : "dd89",
        "relation_type_rel" : "dd620"
    },
    "show_interface": {
        "button_add"                    : false,
        "button_delete"                 : true,
        "button_delete_link"            : true,
        "button_delete_link_and_record" : true,
        "button_link"                   : true,
        "button_list"                   : true,
        "button_save"                   : true,
        "show_autocomplete"             : true,
        "show_section_id"               : true,
        "list_from_component_data"      : true,
        "tools"                         : true,
        "label"                         : true
    }
}
```

`section_tipo` / `parent` tell the section which subset of the global `relations` bag this component owns; on save the locator array is persisted through `saveComponentData()` (`src/core/section/record/save_component.ts`) into the matrix `relation` column, and the relations index is kept in sync. The section is the single writer to the database.

The effective relation type comes from the node's `properties.config_relation.relation_type`, falling back to the descriptor's `defaultRelationType` (`dd89`) when it is absent.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component and by the shared relations engine.

### config_relation

- **Values:** an object `{relation_type, relation_type_rel}`.
- **Effect:** overrides the relation-type tipos written into each locator.
  - `relation_type` — defaults to `dd89` (`DEDALO_RELATION_TYPE_RELATED_TIPO`). Stored as the locator `type`.
  - `relation_type_rel` — directionality, defaults to `dd620`. Accepted values:
    - `dd620` — **unidirectional** (`DEDALO_RELATION_TYPE_RELATED_UNIDIRECTIONAL_TIPO`). The locator is stored only on the originating record; no back-reference is computed.
    - `dd467` — **bidirectional** (`DEDALO_RELATION_TYPE_RELATED_BIDIRECTIONAL_TIPO`). Direct references to the current term are resolved and surfaced.
    - `dd621` — **multidirectional** (`DEDALO_RELATION_TYPE_RELATED_MULTIDIRECTIONAL_TIPO`). References are resolved **recursively** to build the full graph of associated terms (references-to-references and references-to-data), de-duplicated through a static resolved cache.

### source

- **Values:** an object `{records_mode, request_config}` (the standard relation `source` block).
- **Effect:** defines how the picker/list resolves the target section and which columns are shown. `request_config[].show.ddo_map` lists the target components instantiated to resolve labels; `section_tipo: "self"` points the relation back at the component's own section (the usual thesaurus case). `records_mode` (`"list"`) controls how options are presented.

### show_interface

- **Values:** an object of boolean / option flags controlling which buttons and behaviours the client renders (`button_link`, `button_delete`, `button_delete_link`, `button_delete_link_and_record`, `button_list`, `button_save`, `show_autocomplete`, `show_section_id`, `list_from_component_data`, `tools`, `label`, `button_edit_options`, ...).
- **Effect:** UI toggles only. Note the server **forces `show_interface.button_add` to `false`** at runtime, so even if the ontology sets it `true` the generic add button is suppressed for this component.

### sort_by_column

- **Values:** `true`, set on a column ddo of `source.request_config[].show.ddo_map` (a per-column key, shared with the portal), not a top-level property.
- **Effect:** the server honours it for the `sort_by_column` save action (re-order the stored locator array by that column, a real data change) and for a temporary [`sqo.view_order`](../sqo.md#view_order) read. The client's header sort arrows are offered only to `component_portal` instances (`ui.allow_column_order` checks the model), so a `component_relation_related` list shows none today. See [component_portal](component_portal.md#column-order-sort_by_column-and-order-per-ddo) for the full semantics.

!!! note "Standard context properties"
    Like every component, `component_relation_related` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (the RQO, built from `source.request_config`) and `view` (the render view). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

On the client the component is an alias of [component_portal](component_portal.md), so it inherits the portal's `render_views`. Verified from `client/dedalo/core/component_portal/js/component_portal.js`:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | (via search render) | Full portal wrapper: label, buttons, paginated list of related-term rows. |
| `line` | yes | yes | — | Compact inline list. |
| `text` | — | yes | — | Plain joined string of the resolved term labels. |
| `mini` | yes | yes | — | Minimal presentation for limited space. |
| `content` | yes | — | — | Content-focused layout. |
| `indexation` | yes | — | — | Thesaurus indexation layout (term + path). |
| `mosaic` | yes | — | — | Grid-based visual layout. |
| `tree` | yes | — | — | Tree presentation for hierarchical navigation. |

Modes:

- **edit** — read/write the related-term locators; add via the thesaurus/autocomplete picker, remove via the delete-link buttons. Calculated back-references are attached to the item (`item.references`) so bidirectional/multidirectional associations are visible.
- **list / tm** — read-only listing of resolved term labels; `tm` (Time Machine) reuses the list render, with `parent_tipo` / `parent_section_id` injected into each subdata item.
- **search** — builds an SQO filter input. Reference calculation is **skipped** in search mode.

DOM follows the portal structure: `wrapper_component component_relation_related <tipo> <mode>` (the CSS hook is `.component_relation_related.view_default > .content_data`, defined in `css/component_relation_related.less`).

## Import / export model

`component_relation_related` uses the shared related-data import/export model of the relations engine.

**Import.** The shared import engine (`conformImportData()`, `src/core/tools/import_data.ts`) accepts the same forms as [component_portal](component_portal.md):

- The default **locator JSON** (the component's own data shape):

```json
[{"type":"dd89","type_rel":"dd620","section_id":2,"section_tipo":"test3","from_component_tipo":"test54"}]
```

- A **number sequence of `section_id`** when the target section is unambiguous (a single resolvable `target_section_tipo`):

```json
2,5,8
```

- With multiple target sections, the target is declared in the CSV column name as `<component_tipo>_<target_section_tipo>` (e.g. `test54_test3`). The column name is split on the locator delimiter; the first segment is treated as the `from_component_tipo` and is **forced to the current component's `tipo`** if it does not match (so a human-friendly column header like `related_test3` still resolves). An empty cell is valid and clears the existing data. Ambiguous multi-target imports without a clear target are rejected and logged as `IGNORED`.

See [importing data — Related data](../importing_data.md#related-data).

**Export.** The shared relation export path iterates the locators and, per the `show.ddo_map`, resolves each named child component against the target `section_id` / `section_tipo` to produce the sub-columns (term labels, optionally with parents). For diffusion, related components emit the locator array as JSON in SQL targets. See [exporting data](../exporting_data.md).

## Notes

- **Directionality is the differentiator.** Unidirectional (`dd620`) stores the link only on the originating side and skips inverse resolution entirely. Bidirectional (`dd467`) computes one inverse hop; multidirectional (`dd621`) walks the full graph. TS: `getReferences()` (`src/core/relations/related.ts`) runs the inverse-containment query over the target section for locators pointing at the current `{section_tipo, section_id, from_component_tipo}`; the recursive multidirectional traversal guards against cycles with a visited cache keyed `section_tipo_section_id_lang`. This lets a *related* link be navigated from either term without writing two locators.
- **Reference labels.** `getCalculatedReferences()` (`src/core/relations/related.ts`) resolves each back-reference to a `{value, label}` pair using the component's `request_config` show ddo(s) and `fields_separator` (default `" | "`), via `resolveCellValue()` (`src/core/resolve/relation_list.ts`) per show-ddo, empty parts skipped, survivors joined.
- **Sorting.** The descriptor does not opt out of sorting, and `buildOrderPath()` (`src/core/search/order_path.ts`) builds the column-order path as `[self component, thesaurus term component (hierarchy25)]`, so list ordering keys on the resolved term.
- **Duplicate guard.** Locator equality for the add/de-dupe path compares `['section_tipo','section_id','type','from_component_tipo']` (`compareLocators()`, `src/core/concepts/locator.ts`).
- **Default tools.** A standard instance exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools` (read-only context).
- **Observers / observables.** No component-specific subscriptions ship with this model; observer/observable wiring, when needed, is configured in the ontology `properties` like any other component (see the [index](index.md) *Observers and observables* section).
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`): 0 none / 1 read / 2 read+write / 3 admin. Data is only resolved when `permissions > 0`; saves require level >= 2.
- **Related components:** [component_portal](component_portal.md) (its client alias and generic-relation sibling), [component_select](component_select.md), [component_check_box](component_check_box.md), [component_radio_button](component_radio_button.md), [component_dataframe](component_dataframe.md), [component_input_text](component_input_text.md) (the typical target term component).
