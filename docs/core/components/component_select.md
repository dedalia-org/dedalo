# component_select

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
            "mode" : "edit"
        },
        {
            "view" : "print",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text",
            "mode" : "list | tm"
        }
    ],
    "data"        : "array of locators",
    "sample_data" : [{
        "id"                  : 1,
        "type"                : "dd151",
        "section_tipo"        : "dd64",
        "section_id"          : 1,
        "from_component_tipo" : "test91"
    }],
    "value"        : "array of string",
    "sample_value" : ["Yes"]
}
```

!!! note "Typology"
    `component_select` is a **related** component. It does not own a literal value: it stores an array of [locators](../locator.md) pointing at a target section and resolves the displayed value from that target. Its descriptor (`src/core/components/component_select/descriptor.ts`) is intentionally thin — almost all behaviour comes from the shared relation engines it links out to.

!!! info "About `default_tools`"
    The toolbar is assembled from the model + ontology; the component class does not hardcode it. The model sample (`src/core/components/component_select/samples/context.json`) ships `tool_propagate_component_data` and `tool_time_machine`. As a non-translatable component, `component_select` does **not** receive `tool_lang` / `tool_lang_multi`. Tools are read-only context. For language selection that needs translatable behaviour, use the sibling [component_select_lang](component_select_lang.md).

!!! info "TS server implementation"
    The descriptor `src/core/components/component_select/descriptor.ts` registers `resolveData: 'select_family'` (`src/core/relations/models/select_family.ts`), shared with `component_select_lang`, `component_radio_button`, `component_check_box`, `component_publication` and `component_relation_model`. In `list`/`edit`/`search` modes the resolver builds the option datalist and the label strings via `src/core/relations/datalist.ts` (`getDatalist` / `getRelationListValue`, including a faithful `strnatcmp` re-implementation); every other mode falls through to the shared portal engine (`src/core/relations/models/portal.ts`). See the *dedalo-relations-ts* skill.

## Definition

`component_select` is the single-choice dropdown of Dédalo. It renders an HTML `<select>` whose options are the records of a **target section**, and stores the user's choice as a single [locator](../locator.md) relation. Picking an option creates a one-to-one / many-to-one link from the current record to one record in the target section; choosing the empty option removes the relation.

**Why it exists.** Many catalogue fields are a controlled single choice drawn from a closed or small list: a status, a yes/no flag, a category, a type, a single responsible entity. A relation (rather than a literal string) keeps the chosen value normalised — it points at a real record in a controlled-vocabulary section, so the label resolves consistently, can be renamed in one place, and is queryable from both sides. `component_select` is the compact UI for that when only **one** value is allowed and the option set is short enough to fit a dropdown.

**When to use it.**

- A single controlled value from a small target list: *Conservation status*, *Object category*, *Publication state*, *Yes/No* flag, *Currency*, *Material* (when single-valued).
- Choosing one parent / owner / responsible record in a simple relationship.
- Any place a [component_radio_button](component_radio_button.md) would work but a dropdown is preferred for space (radio buttons show all options inline; select collapses them into one control).

**When not to use it.**

- Multiple values from the same target section -> use [component_check_box](component_check_box.md) (multi-select list) or [component_portal](component_portal.md) (rich, paginated, ordered relation list).
- A large target list where the user must type to find a record -> use [component_portal](component_portal.md) with `source.mode: autocomplete` (autocomplete service), not a dropdown of thousands of options.
- A literal string the cataloguer types directly (a title, a note) -> use [component_input_text](component_input_text.md).
- Tagging the language of sibling content -> use [component_select_lang](component_select_lang.md), the language-aware specialisation.

## Data model

**Data:** `array of locators`. A `component_select` is single-valued, so the array holds at most **one** locator.

**Value:** `array` of `strings`, or `null`. The string is the resolved label of the target record, not a stored value.

**Storage shape.** A component never writes to the database directly; it reads and saves through its section. A `component_select` does not keep a private value column — its chosen locator lives in the section-wide `relations` container, and the component slices out its own locator by matching `from_component_tipo` (its own `tipo`). The canonical locator shape is `{type, section_tipo, section_id, from_component_tipo}` plus the per-item `id`:

```json
[
    {
        "id"                  : 1,
        "type"                : "dd151",
        "section_tipo"        : "dd64",
        "section_id"          : 1,
        "from_component_tipo" : "test91"
    }
]
```

- `type` is the relation-type tipo. It defaults to `DEDALO_RELATION_TYPE_LINK = "dd151"` (the generic link type), and can be overridden from `properties.config_relation.relation_type`.
- `section_tipo` / `section_id` point at the chosen record in the target section.
- `from_component_tipo` is forced to this component's own `tipo` by the relations engine on save (it clones the incoming locator first to protect observers, rejects auto-references and malformed locators, and de-dupes by comparing `['section_tipo','section_id','type','from_component_tipo']` — `compareLocators()`, `src/core/concepts/locator.ts`).
- `id` is the per-item counter id used to pair the value with a [component_dataframe](component_dataframe.md) row when one is attached.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum (the JSON-API contract). In the API payload the stored locators are surfaced under `data.entries`, and the selectable options under `data.datalist` (see `src/core/components/component_select/samples/api_data.json`). `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view`, `request_config`, `target_sections`) and never the values. See the *dedalo-context-data-layers* and *dedalo-datalist-resolution* skills for the full layering rules.

The displayed `value` (`["Yes"]` in the sample) is resolved from the *target* section/component, not stored locally. `getRelationListValue()` (`src/core/relations/datalist.ts`) walks the resolved option datalist and returns the labels of the options whose locator matches the stored data (compared by `section_id` + `section_tipo`).

## Ontology instantiation

A `component_select` is created as an ontology node whose `model` is `component_select`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` term; because it is a related component it is **non-translatable** (`lang` resolves to `lg-nolan`).

Node definition (shape):

```json
{
    "tipo"         : "test91",
    "model"        : "component_select",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "Status",
    "lg-spa"       : "Estado",
    "properties"   : { }
}
```

The decisive part for a related component is the **request config** (RQO) inside `properties`. It declares the target section(s) in `sqo.section_tipo` and how each option label is resolved in `show.ddo_map`. Realistic `properties` block for a single-choice *Status* select pointing at a controlled-vocabulary section `dd64`, whose label is the `dd62` text column:

```json
{
    "config_relation" : {
        "relation_type" : "dd151"
    },
    "source" : {
        "request_config" : [
            {
                "api_engine" : "dedalo",
                "type"       : "main",
                "sqo" : {
                    "section_tipo" : ["dd64"]
                },
                "show" : {
                    "ddo_map" : [
                        {
                            "tipo"         : "dd62",
                            "model"        : "component_input_text",
                            "section_tipo" : "dd64",
                            "parent"       : "test91",
                            "mode"         : "list",
                            "label"        : "Value"
                        }
                    ],
                    "sqo_config" : { "limit" : 30 }
                }
            }
        ]
    },
    "css" : {
        ".wrapper_component": { "grid-column": "span 4" }
    }
}
```

When instantiated, the structure context resolves the target sections from the parsed `request_config` (TS: `buildRequestConfigForElement` + `extractSqoSectionTipos`, `src/core/relations/request_config/build.ts` and `request_config/v6.ts`) and attaches each as `context.target_sections`, and — in `edit` mode — populates `data.datalist` (TS: `getDatalist`, `src/core/relations/datalist.ts`). On save, the section is the single writer: the chosen locator is persisted into the section `relations` container, not a private data column.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. `component_select` adds **no component-specific scalar flags of its own**; it consumes the shared related-component properties. Verified names:

### source / request_config

- **Values:** an object with `request_config` (an array of RQO blocks). The RQO declares `sqo.section_tipo` (the target section list) and `show.ddo_map` (which target component resolves each option label and how — `value_with_parents`, `fields_separator`, etc.).
- **Effect:** this is what makes the dropdown work. `getDatalist()` (`src/core/relations/datalist.ts`) runs the RQO against the target section(s) to build `data.datalist` (the `<option>` set); `target_sections` is derived from `sqo.section_tipo`. A select with no resolvable `request_config` logs an error and produces an empty option list. See the *dedalo-datalist-resolution* and *dedalo-request-config* skills.
- **Who sees which options:** the option list is a real search run for the person asking. A user who is not a global administrator is offered only the target records of their own projects, and a per-user record allow-list (`component_filter_records`) narrows it further for everyone. A stored value outside that scope (or outside the record's `fixed_filter`) is not hidden: the edit form keeps it as an opaque option labelled *(restricted)* and the list shows *(restricted)* in its place, so the selection survives the next save. A stored value whose target record no longer exists shows nothing.
- **Options per record:** a `sqo.fixed_filter` of source `component_data` narrows the options by a value read from the record being edited (for example, only the milestones of the person the record names), so two records can offer different lists. With no record (the search panel) the list is not narrowed.

### config_relation

- **Values:** an object `{relation_type, relation_type_rel}`.
- **Effect:** overrides the relation tipo written into each locator. `relation_type` defaults to the descriptor's `defaultRelationType` (`dd151`) for `component_select`; set it to use a different relation type. `relation_type_rel` records directionality (uni/bi/multidirectional); `component_select` declares no default directionality, so the link is unidirectional, stored only on the originating side.

### css

- **Values:** an object keyed by CSS selector (e.g. `.wrapper_component`), each a map of declarations.
- **Effect:** style stamped on the rendered wrapper. Commonly used to set the grid span of the field.

### Dataframe (a slot in `show.ddo_map`)

- **Values:** a `component_dataframe` ddo in the `show.ddo_map` of `source.request_config`, naming the host section as its `section_tipo` — for example `numisdata291` (discovery method, in the coins section `numisdata4`) declares `{"tipo":"numisdata872","view":"default","section_tipo":"numisdata4"}`, the uncertainty rating of the chosen method.
- **Effect:** pairs each selected value with a [component_dataframe](component_dataframe.md) frame. In edit (any mode but `list` and `search`) and when the select holds a value, the server sends, after the select's own item, one frame item per selected value (paired by the value item `id`, never the target `section_id`), the frame's own fields and their context; the `default` edit view then attaches the dataframe control to the selected value. An empty select sends no frame; the first pick's save response carries an empty one, so the control appears at once. Changing the select value fires an explicit `delete_dataframe` unlink before the new value is saved. `has_dataframe` is **not** needed here: that flag is a switch for literal mains only.

!!! note "Standard context properties"
    Like every component, `component_select` also honours the generic ontology context blocks carried into the datum `context`: `properties`, `request_config` (RQO) and `view` (the render view to use). Observer/observable wiring, when needed, is configured in `properties` like any other component (see the index page *Observers and observables* section). Any other custom key seen in production should be verified in the ontology.

!!! warning "Single value enforced in the client"
    The dropdown structurally allows only one choice. The client also enforces it on the *new record* path: it first removes any existing locator (a `remove` save) before creating and linking the new target record, so the select never accumulates more than one relation.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files (`render_edit_component_select.js`, `render_list_component_select.js`, `render_search_component_select.js`). Verified from the source:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | (via search render) | edit: `<select>` with options from `data.datalist`, plus optional *new* / *go to target* / tool buttons; selecting attaches the dataframe when configured. list: read-only joined value in the wrapper, click activates edit-in-list (modal). |
| `line` | yes | — | — | Compact inline `<select>` without label; reuses the same content-data builder, adds a *button exit edit*. |
| `print` | yes | — | — | Reuses the `default` edit view but forces `permissions = 1` (read-only `content_value`) and is tagged for print context. |
| `mini` | — | yes | — | Minimal wrapper used by service autocomplete / datalists. |
| `text` | — | yes / tm | — | Plain `<span>` with the joined value (entries joined by `context.fields_separator`), no chrome. |

The **search** render builds a filter input per entry: a `q_operator` text input plus the same `<select>` (with an empty option prepended), publishing `change_search_element` as the user edits. It produces an SQO filter over the related target; saves are blocked in search mode.

Modes:

- **edit** — read/write a real record; populates `datalist`, supports choosing/removing the single value, creating a new target record (*add*), opening the target record/list, and attaching a dataframe. The `+1` selection from the empty option clears the relation (`action: remove`); any other choice is an `action: update`.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render. The stored locator is resolved to its target label.
- **search** — builds the SQO filter input; saves are refused.

DOM (edit / default): `wrapper_component component_select <tipo> <mode> view_default` -> `label`, `buttons_container`, `content_data` -> `content_value` -> `select.select` (one `<option>` per datalist item, value = `JSON.stringify(locator)`).

## Import / export model

**Import.** `component_select` goes through the shared related-component import engine (`conformImportData()`, `src/core/tools/import_data.ts`). Two formats are accepted (see [importing data](../../using/importing_data.md#related-data)):

- **JSON locator array** (default round-trip format) — a one-element array since the component is single-valued:

```json
[{"type":"dd151","section_tipo":"dd64","section_id":1,"from_component_tipo":"test91"}]
```

- **Plain `section_id`** when the target section is unambiguous (a single target in the RQO, or disambiguated by the CSV column header `tipo_targettipo`, e.g. `test91_dd64`). The importer builds the full locator from that id:

```json
1
```

`from_component_tipo` is forced to this component's own `tipo`, `type` is injected from the resolved relation type, the `section_id` is validated, and invalid / multi-target-without-clear-target rows are logged and ignored. An empty cell is valid and clears the existing relation.

**Export.** The shared relation export path iterates the stored locator and, per the `ddo_map`, resolves the target component against the locator's `section_id` / `section_tipo` to produce the displayed label / sub-columns; the indexation grid resolves the same way. See [exporting data](../../using/exporting_data.md) and the *dedalo-export* skill.

## Notes

- **Observers / observables.** No component-specific subscriptions are hardcoded. Observer/observable wiring is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section).
- **Default tools.** A standard instance exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools` (model sample). Being non-translatable, it does not receive `tool_lang` / `tool_lang_multi`.
- **Sortable.** `resolveSortable()` (`src/core/resolve/structure_context.ts`) defaults every model to sortable and `component_select`'s descriptor does not opt out, so a `component_select` column can be used to sort a list. (Note: when used as a *column inside* a [component_portal](component_portal.md), portal column sort excludes select-type columns — that is the portal's policy for its own sub-columns, separate from this component's own sortability.)
- **Shared relation behaviour.** The chosen value lives only in the section `relations` bag; the component filters by `from_component_tipo`. Locator normalisation and validation, adding/removing a locator (with the dataframe cascade), grid/export/diffusion resolution and search all come from the shared relations engine (`src/core/relations/`), not from anything this model declares itself.
- **Related components:** [component_select_lang](component_select_lang.md), [component_radio_button](component_radio_button.md), [component_check_box](component_check_box.md), [component_portal](component_portal.md), [component_relation_model](component_relation_model.md), [component_dataframe](component_dataframe.md), [component_input_text](component_input_text.md).
