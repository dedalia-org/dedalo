# component_check_box

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : false,
    "is_related"            : true,
    "is_media"              : false,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools" : [
        "tool_time_machine",
        "tool_replace_component_data",
        "tool_add_component_data"
    ],
    "render_views" :[
        {
            "view" : "default",
            "mode" : "edit | list"
        },
        {
            "view" : "line | print | tools",
            "mode" : "edit"
        },
        {
            "view" : "mini | text",
            "mode" : "list"
        }
    ],
    "data"        : "array of locators",
    "sample_data" : [
        {"type":"dd151","section_id":1,"section_tipo":"rsc723","from_component_tipo":"tch191"},
        {"type":"dd151","section_id":2,"section_tipo":"rsc723","from_component_tipo":"tch191"}
    ],
    "value"        : "array of locators",
    "sample_value" : [
        {"type":"dd151","section_id":1,"section_tipo":"rsc723","from_component_tipo":"tch191"},
        {"type":"dd151","section_id":2,"section_tipo":"rsc723","from_component_tipo":"tch191"}
    ]
}
```

!!! note "Typology"
    `component_check_box` is a **related** component. It does not own literal data; it stores an array of [locator](../locator.md) objects pointing at records of a target *list-of-values* section. It is **not translatable** (`lg-nolan`): the relation is language-independent and the displayed labels are resolved from the target term in the application language.

!!! note "Legacy alias"
    The legacy v5/v6 model name `component_security_tools` is registered in the TS server only as a thin alias stub whose descriptor sets `alias: 'component_check_box'`. It owns no storage or resolver of its own and is resolved to `component_check_box` at runtime, so everything on this page applies to it too. (Distinct from the `dd1067` security-tools *profiles* field described in [Notes](#notes), which is an ordinary `component_check_box` instance.)

!!! info "About `default_tools`"
    The toolbar is assembled from the model + ontology, never hardcoded. The set above is what a typical related instance receives in `context.tools`. `component_check_box` is rendered with a fixed, closed option list, so it does not carry an autocomplete/search picker the way `component_portal` does; the inline reset/list buttons (see *Render views & modes*) are built by the render layer, not by tools.

!!! info "TS server implementation"
    The descriptor `src/core/components/component_check_box/descriptor.ts` registers `resolveData: 'select_family'` (`src/core/relations/models/select_family.ts`), shared with `component_select` / `component_select_lang` / `component_radio_button` / `component_publication` / `component_relation_model`. `list`/`edit`/`search` modes build the datalist / label strings through `src/core/relations/datalist.ts`; other modes fall through to the shared portal engine (`src/core/relations/models/portal.ts`). See the *dedalo-relations-ts* skill.

## Definition

`component_check_box` manages a **closed list of values** as a multi-select of checkboxes. It is a related component: each checked option is stored as a locator pointing at a record in a target section (typically a small *list of values* / thesaurus section), and the rendered label is resolved from that target term. The component is non-translatable and can hold multiple selected values at once.

**Why it exists.** Many catalogue fields are constrained to a fixed, short vocabulary where the cataloguer should *see all the options at once* and tick the ones that apply, rather than typing or searching. `component_check_box` renders the whole option list inline as checkboxes, which makes it ideal for small controlled vocabularies and for many-to-many flags. It reuses the shared relation machinery (locators, the section-wide `relations` bag, `from_component_tipo` filtering, Time Machine, diffusion), so the stored data is a normal relation that can be queried from search and exported like any other related component.

**When to use it.**

- A small closed vocabulary where every option should be visible and tickable: *Acquisition type* (purchase / donation / bequest / exchange), *Conservation state*, *Material* flags, *Yes/No* style booleans backed by a list section.
- Many-to-many assignments against a short list: assigning *tools* to a user profile (the security-tools profiles field, see *Notes*), enabling a set of features, tagging a record with several non-hierarchical categories.

**When not to use it.**

- A vocabulary too large to show all at once, or one the user should type/search -> use [component_portal](component_portal.md) (autocomplete behaviour), or `component_select` for a dropdown.
- A single mutually-exclusive choice -> use `component_radio_button`.
- A free relation to arbitrary records of another section (people, places, bibliography) rather than a closed value list -> use [component_portal](component_portal.md).
- A hierarchical parent/child relation in the thesaurus tree -> use `component_relation_parent` / `component_relation_children`.

## Data model

**Data:** `array of locators`. On the client the API data object also carries a `datalist` array (the resolved option list) so the renderer knows every checkbox to draw, and `entries` (the currently selected locators) so it knows which are checked.

**Value:** `array` of `locators`, or `null`.

**Storage shape.** A component never touches the database; it reads and writes through its section. Like every related component, `component_check_box` does **not** keep an isolated value column — its locators live in the record's `relation` column — singular, and an **object keyed by component tipo**, not a flat array — so the component reads its own entry under its `tipo` (and still matches `from_component_tipo`/`section_tipo` when slicing a shared bag). The canonical locator shape is `{type, section_tipo, section_id, from_component_tipo}`; `type` is the relation type (`dd151` by default), `section_tipo`/`section_id` point at the selected list-of-values record, and `from_component_tipo` names this component.

```json
{
    "relation" : {
        "tch191" : [
            {"type":"dd151","section_id":1,"section_tipo":"rsc723","from_component_tipo":"tch191"},
            {"type":"dd151","section_id":2,"section_tipo":"rsc723","from_component_tipo":"tch191"}
        ]
    }
}
```

When the component is instantiated it gets its data from its section in `lg-nolan` (the relation has no language). On save, each incoming locator is normalized by the shared relation write engine (`src/core/relations/save.ts`): `type` is resolved from the component's relation type (`properties.config_relation.relation_type`, falling back to the descriptor's `defaultRelationType`), `from_component_tipo` is forced to the component's own `tipo`, auto-references and malformed locators are rejected, and duplicates are de-duped by equality on `section_tipo`, `section_id`, `type` and `from_component_tipo`.

!!! note "Datum vs. API data"
    The transmitted unit is a `{context, data}` datum. For this component `data` carries the selected locators as `entries`, the resolved option list as `datalist` (built by `getDatalist()`, `src/core/relations/datalist.ts`), plus `parent_tipo`, `parent_section_id`, `row_section_id` and, in search mode, `q_operator`. `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view`, `fields_separator`, `target_sections`) and never the values. The `datalist` resolution is shared with `component_select` / `component_radio_button`; see the *dedalo-datalist-resolution* skill.

## Ontology instantiation

A `component_check_box` is created as an ontology node whose `model` is `component_check_box`. Its `parent` is the section (or grouper) it belongs to, `section_tipo` wires it into that section, and the standard `lg-*` term + `is_translatable` flags declare its label (translatability is normally `false` for this related component). The target list-of-values section and the option resolution are declared through the `source` / `request_config` (RQO) in `properties`.

Node definition (shape):

```json
{
    "tipo"         : "tch191",
    "model"        : "component_check_box",
    "parent"       : "tch2",
    "section_tipo" : "tch2",
    "lg-eng"       : "Acquisition type",
    "lg-spa"       : "Tipo de adquisición",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block — a checkbox group that lists every term of a small list-of-values section `rsc723`, joins multiple selected labels with `" | "`, and is mandatory:

```json
{
    "mandatory"         : true,
    "records_separator" : " | ",
    "fields_separator"  : ", ",
    "source" : {
        "mode" : "list_of_values",
        "request_config" : [{
            "sqo" : {
                "section_tipo" : ["rsc723"]
            },
            "show" : {
                "ddo_map" : [{
                    "tipo"         : "rsc724",
                    "parent"       : "self",
                    "section_tipo" : "self"
                }],
                "fields_separator" : ", "
            }
        }]
    }
}
```

`section_tipo` / `parent` tell the section which slice of the global `relations` bag belongs to this component; on save the locators are written through the section's record save path against the section's relations column (the section is the single writer to the database). The RQO under `source.request_config` is the query the datalist engine runs to build the option list, so the available checkboxes are entirely ontology-driven.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component:

### config_relation

- **Values:** object with `relation_type` and (optionally) `relation_type_rel`.
- **Effect:** sets the relation type written into every locator's `type`. Resolved by the shared relation write engine (`src/core/relations/save.ts`) as `properties.config_relation.relation_type`, falling back to the component's descriptor default (`defaultRelationType`). For `component_check_box` the descriptor default is `DEDALO_RELATION_TYPE_LINK` = **`dd151`** (generic link). Override it to record a different semantic of the selection.

  | typology | tipo |
  |---|---|
  | Link (default) | `dd151` |
  | Indexation | `dd96` |
  | Children | `dd48` |
  | Parent | `dd47` |
  | Filter | `dd675` |
  | Ontology | `dd77` |

  ```json
  {
      "config_relation": { "relation_type": "dd96" }
  }
  ```

  `relation_type_rel` (locator `type_rel`) controls directionality (uni/bi/multidirectional) the same way as other related components; for a closed value list it is normally left at the default.

### source / request_config

- **Values:** an object (`source`) carrying a `request_config` (RQO), or a top-level `request_config`. `verify in ontology` for the exact shape per instance.
- **Effect:** declares the **target list-of-values section** and how to resolve each option's label. The shared select-family resolver (`src/core/relations/models/select_family.ts`) runs this RQO through `getDatalist()` (`src/core/relations/datalist.ts`) to produce the option list as `{value:{section_id,section_tipo}, label, section_id}` items. This is the single source of the checkboxes the user sees, so the option set is changed by editing the RQO, not by editing engine code.
- **Who sees which options:** the option list is a real search run for the person asking. A user who is not a global administrator is offered only the target records of their own projects, and a per-user record allow-list (`component_filter_records`) narrows it further for everyone. The labels of a stored value outside that scope are not shown either.
- **Options per record:** a `sqo.fixed_filter` of source `component_data` narrows the options by a value read from the record being edited (for example, only the milestones of the person the record names), so two records can offer different lists. With no record (the search panel) the list is not narrowed.

### filtered_by_search

- **Values:** an SQO filter object (`{"$and": [{"q": …, "path": […]}]}`), the same shape a search sends.
- **Effect:** narrows the option list to the target records the filter matches. It is applied only when the `request_config` carries no `fixed_filter` group; a `fixed_filter` wins.

### fields_separator

- **Values:** string (default `", "` in the text/mini list views).
- **Effect:** the character used **between the fields of the target record** when a locator is flattened to a label string (grid, list `text`/`mini` views, export, and when shown inside another component). Resolved with precedence: the ddo's own `fields_separator` -> RQO `show.fields_separator` -> `properties.fields_separator`.

  ```json
  { "fields_separator": ", " }
  ```

  Joins the target fields (e.g. surname `rsc86`, name `rsc85`) as `Ramón y Cajal, Santiago`.

### records_separator

- **Values:** string.
- **Effect:** the character used **between locators (records)** when several selected values are flattened to one string for grid display / export. Resolved with the same precedence: the ddo's own `records_separator` -> RQO `show.records_separator` -> `properties.records_separator`.

  ```json
  { "records_separator": " | " }
  ```

  Joins multiple selected records as `Santiago Ramón y Cajal | Gerty Cori`.

### mandatory

- **Values:** `true` | `false` (default `false`).
- **Effect:** informs the user the field requires a value (UI signal). It is not a server-enforced save block.

!!! note "Standard context properties"
    Like every component, `component_check_box` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view to use). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

The view is read from `context.view` (default `default`) and dispatched per mode by the render files. Verified from the source:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | — | edit: one `content_value` per `datalist` option, each a `<label>` wrapping an `<input type=checkbox>`; checked when a matching locator is in `entries`. Read users (permission 1) see only the selected labels as read-only `content_value` nodes. list: joined value string. |
| `line` | yes | — | — | Same content as default but the wrapper has no label (`label:null`), `display:contents` for compact inline layout. |
| `print` | yes | — | — | Reuses the `default` edit view but forces `permissions = 1` (read-only) and tags the wrapper `view_print`. |
| `tools` | yes | — | — | Two-column grid with a **Select all** master checkbox; each row shows a tool icon + label. Used to render the security-tools profiles field (see *Notes*); `always_active` options render disabled. |
| `mini` | — | yes | — | Minimal `wrapper_mini` with the joined value string; used by service autocomplete / datalists. |
| `text` | — | yes | — | Plain `<span>` with the value joined by `fields_separator` (HTML preserved, e.g. search `<mark>`). |

Search mode renders a single `content_data` with a `q_operator` text input plus one checkbox per `datalist` option; toggling a box updates the instance data and publishes `change_search_element` to rebuild the SQO filter (it does not save).

Modes:

- **edit** — read/write. Every change is saved immediately (`change_handler` builds an `insert`/`remove` `changed_data_item` and calls `change_value`) so value keys stay recalculated; the reset button issues a bulk `remove`. Tabbing into a checkbox auto-activates the component.
- **list / tm** — read-only listing (the `tm` Time Machine render reuses the list render). The displayed value is resolved from the option list: each stored locator becomes the label of the option it matches (`getRelationListValue()`, `src/core/relations/datalist.ts`).
- **search** — builds an SQO relation filter; saves are blocked.

DOM (edit / default): `wrapper_component component_check_box <tipo> <mode> view_default` -> `label`, `buttons_container`, `content_data` -> one or more `content_value` -> `label > input[type=checkbox]`.

## Import / export model

**Import.** The default import format is a JSON array of [locators](../locator.md), conformed by the generic import engine (`conformImportData()`, `src/core/tools/import_data.ts`):

```json
[{"type":"dd151","section_id":2,"section_tipo":"rsc723","from_component_tipo":"tch191"}]
```

An empty cell clears the existing relation.

!!! warning "Gap: bare section_id shorthand not ported"
    A plain `section_id` number / number sequence (with the target section disambiguated via a `<component_tipo>_<target_section_tipo>` CSV column-name suffix when several targets are possible) is not handled by the generic import engine today — only the JSON locator array round-trips. Neither `conformImportData()` nor the CSV import driver (`src/core/tools/import_csv.ts`) contains this shorthand or column-name disambiguation logic.

See [importing data](../../using/importing_data.md#related-data).

**Export.** Label resolution over the stored locators — iterating the `ddo_map`, resolving each target record's label columns and joining fields with `fields_separator` and records with `records_separator` — goes through the generic cell resolver `resolveCellValue()` (`src/core/resolve/relation_list.ts`), consumed by `tools/tool_export/server/tool_export.ts`. See [exporting data](../../using/exporting_data.md).

## Notes

- **Sortable.** Most relation-family descriptors declare `sortable: false` to opt their list column out of sort ordering (media, geolocation, info, security_access, `component_relation_index`/`component_relation_children`…). `component_check_box` does not set the flag, so it keeps the engine default (`resolveSortable()`, `src/core/resolve/structure_context.ts`, defaults to `true`) — its list column is sortable and can appear as a sort target (verified in the sample context, `sortable: true`).
- **Security-tools profiles (`dd1067`).** The security-tools profiles field is built as a `component_check_box` and rendered with the `tools` view; a user's granted tools are resolved from this field's stored locators against the profile registry (`src/core/tools/registry.ts`, `PROFILE_TOOLS_COMPONENT = 'dd1067'`, `src/core/tools/ontology_map.ts`) plus tools flagged `always_active`. Whether the datalist option list itself is enriched with per-tool icon/`always_active` metadata for the `tools` view render has not been independently verified in this checkout.
- **Relation write path.** Locator normalization/validation and dedup, the sibling-preserving dataframe removal cascade on item delete (`removeDataframeDataById()`, `src/core/relations/save.ts`), and locator deletion (`deletePortalLocator()`, same module) are all handled by the shared relation write engine, not by per-model code. Grid/export/diffusion label resolution goes through the shared datalist engine (`src/core/relations/datalist.ts`).
- **Observers / observables.** Wiring, when needed, is configured in the ontology `properties` (see the index page *Observers and observables* section), not in component code.
- **Default tools.** Tools are read-only context, assembled from the model + ontology; nothing is hardcoded per model.
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Read users (level 1) get read-only labels; selecting/saving requires level >= 2.
- **Related components:** `component_radio_button`, `component_select` (single-choice variants of the same closed list), [component_portal](component_portal.md), [component_dataframe](component_dataframe.md).
