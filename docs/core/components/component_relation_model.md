# component_relation_model

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
            "view" : "text | mini",
            "mode" : "list"
        }
    ],
    "data"        : "array of locators",
    "sample_data" : [{
        "id"                  : 1,
        "type"                : "dd98",
        "section_tipo"        : "dd922",
        "section_id"          : 1,
        "from_component_tipo" : "test169"
    }],
    "value"        : "array of strings",
    "sample_value" : ["Categoría Laboral / Cargo"]
}
```

!!! note "Typology"
    `component_relation_model` is a **related** component. Like every related component, it stores [locators](../locator.md) pointing at other records rather than literal data, and resolves its displayed `value` from the *target* section. Its descriptor (`src/core/components/component_relation_model/descriptor.ts`) declares `column: 'relation'`.

!!! info "Client is an alias of component_select"
    The client class is a thin alias: `client/dedalo/core/component_relation_model/js/component_relation_model.js` exports `component_relation_model = component_select`. All client behaviour (render files, views, edit/list/search UI) is therefore [component_select](component_select.md)'s. Server-side resolution, however, has its own model-specific target-resolution rules (see below).

!!! info "TS server implementation"
    The descriptor `src/core/components/component_relation_model/descriptor.ts` registers `resolveData: selectFamilyResolver` (`src/core/relations/models/select_family.ts`) — the same read-side resolver as [component_select](component_select.md), resolving options and labels through `src/core/relations/datalist.ts`. What *is* model-specific is the **target**: the descriptor declares `targetSource: 'section_model'`, and the shared request-config builder applies that rule as the node's default target whenever the node's own config resolves none. See [Target resolution](#target-resolution).

## Definition

`component_relation_model` creates a **model-type relation** between the current record and another record, where the link is constrained to a *target section derived from the caller's own section* rather than named in the node. Its default relation type is `dd98`, distinct from the generic link type `dd151` used by [component_portal](component_portal.md).

The defining trait is **target resolution**: the component does not hardcode which section it points at. The target section tipo(s) are resolved at runtime from the element's request config (`src/core/relations/request_config/build.ts`), and — uniquely in the relation family — the model supplies a **default target that depends on the caller**, so one ontology node serves many sections and points somewhere different in each of them. The rule is spelled out in [Target resolution](#target-resolution) below.

**Why it exists.** In Dédalo, a thesaurus is split into a *terms* section (the vocabulary a cataloguer browses) and a *model* section (the typologies those terms are classified by). A model relation lets a term point at its own thesaurus's model section without the ontology author repeating that target tipo in every node — which would be impossible anyway, because the very same node is inherited by every thesaurus in the install.

**When to use it.**

- A field whose valid options are the records of the model section paired with the caller's own section, so the target follows the thesaurus configuration rather than being fixed in the field itself.
- A fixed target with model-relation semantics: declare `sqo.section_tipo` explicitly on the node when you want the plain, explicit list-of-targets behaviour but still want the model relation type (`dd98`) and the select UI. A declared target always wins over the model's default.

**When not to use it.**

- A generic link to one or more arbitrary sections with autocomplete / tree / mosaic UI -> use [component_portal](component_portal.md) (relation type `dd151`).
- A flat single/multiple choice from a target component's option list with select / radio / checkbox UI -> use [component_select](component_select.md), [component_radio_button](component_radio_button.md) or [component_check_box](component_check_box.md).
- A thesaurus parent / child / equivalence relation -> use [component_relation_parent](component_relation_parent.md), [component_relation_children](component_relation_children.md) or [component_relation_related](component_relation_related.md).

## Target resolution

One node, many sections. `hierarchy27` ("Tipology") is defined once, on the thesaurus template section `hierarchy20`, and is inherited by the 54 virtual sections built from it. The section whose records it must offer is different for **every caller**: a term in `es1` is typed by the records of `es2`, a term in `fr1` by `fr2`. That answer cannot be written into the node, so the engine derives it from the caller.

The derivation lives in exactly one place, `getModelSectionForSection()` (`src/core/ontology/model_section.ts`), and reaches this component through the descriptor facet `targetSource: 'section_model'`. Candidates are tried **in order, and the first one that validates wins** — a candidate that fails validation does not stop the walk.

The tipos and counts below are the live ones on the development install (`dedalo_v7_mht`); yours will differ in the hierarchies, not in the rule.

### 1. The hierarchy registry (data, not a naming rule)

Each hierarchy is declared by a record in the hierarchy registry, and that record names both faces of the pair: `hierarchy53` is the **target section** (the terms section) and `hierarchy58` is the **target model section**. The resolver looks for the registry record whose `hierarchy53` equals the caller's `section_tipo` and takes its `hierarchy58`.

Two registry sections are consulted, because both carry the same registry components:

| Registry section | Holds | Matrix table |
| --- | --- | --- |
| `hierarchy1` | thesaurus hierarchies | `matrix_hierarchy_main` |
| `ontology35` | main ontologies (a virtual section of `hierarchy1`) | `matrix_ontology_main` |

The family is **derived**, not hardcoded: every section whose real section tipo is `hierarchy1` is a registry, so a third one added later is read with no code change. The match is exact string equality on `hierarchy53` — never a prefix or search match, because tipos nest as substrings of one another (`ich1` inside `ich145`, `hierarchy1` inside `hierarchy13`, all four of them real sections). If two rows ever declared the same `hierarchy53`, the lowest `section_id` wins. A registry row whose `hierarchy58` is absent or empty falls through to the next candidate.

!!! note "Why the registry cannot be replaced by the naming rule"
    On this install the registry row for the `WW` hierarchy pairs `mht72` with `ww2`, while the naming rule below would answer `mht2` — a `diffusion_element`, not a section. The pairing is operator data and the operator is allowed to break the naming convention.

### 2. The naming rule

If no registry row answers, the candidate is the caller's TLD followed by `2`: `actv1` → `actv2`, `es1` → `es2`. This is what covers the sections that have no registry row at all, and it is not optional — most callers resolve here.

### 3. Validation

Every candidate — registry answer **and** naming-rule answer alike — is kept only if its ontology model is `section`. Two live examples are refused by this step: `hierarchy20` (the raw template) would yield `hierarchy2`, a `component_number`, and `ich145` would yield `ich2`, a `section_group`. A candidate that equals the registry row's own `hierarchy53` is refused as well: that would point the option list at the *terms* section, whose record counts run into the tens of thousands.

Validation cannot be deferred to the consumer. The resolved targets are emitted to the client as `context.target_sections` and are the tipos the CSV importer accepts, so an unvalidated tipo would travel straight into a read of a table that does not exist.

### 4. Nothing resolves

When no candidate validates, the component resolves **no target**: the select renders empty, the list column renders blank, and the server logs one warning naming the component, the caller section and every rejected candidate with the model it resolved to. Nothing is thrown and no request fails — the degradation is loud and bounded, never silent.

### The declared configuration always wins

The rule above is a **default**: a node that DECLARES `sqo.section_tipo` in its own request config, and whose declaration resolves a section, keeps it untouched. This is what lets one node of this model be pinned to a fixed section (`actv6` in `actv1`, whose target is a fixed catalogue rather than a thesaurus twin) while `hierarchy27` stays caller-derived.

A target reached through the **implicit relations walk** is *not* a declaration and does not survive: a node with no request config at all would otherwise take the first section in its ontology `relations`, which for `hierarchy27` is `hierarchy20` — the thesaurus template every hierarchy is cloned from, not a list of typologies. And when the rule resolves *nothing*, the answer is no target rather than a fallback to that walk: an empty option list with a logged reason is honest, a plausible wrong list is not.

The same rule is also available **explicitly**, to any component, as an `sqo.section_tipo` source named `section_model`:

```json
{ "sqo": { "section_tipo": [ { "source": "section_model" } ] } }
```

With no `value`, it resolves the caller's own section; with `value`, it resolves the model section of each listed section (`{"source": "section_model", "value": ["es1", "fr1"]}` → `es2`, `fr2`). See the [source vocabulary](../request_config.md#sqosection_tipo-source-vocabulary).

!!! note "A model section targets itself, and that is correct"
    The model sections are themselves virtual sections of `hierarchy20`, so `hierarchy27` renders inside `es2` as well — where it resolves to `es2`, its own section. 27 of the 54 inheriting sections are this case. A typology may be typed by another typology; the option list is small (tens of records), and the relations engine rejects a locator that points a record at itself. Do not read it as a resolution bug.

!!! warning "Retired: `target_mode` and `target_values`"
    The ontology keys `properties.target_mode: "free"` and `properties.target_values` are **not read**. They were a vocabulary invented for this one model that said exactly what `sqo.section_tipo` says for every other component, and they forced any reader of a node to check two places to learn where it points.

    Replace `{"target_mode": "free", "target_values": ["dd922"]}` with an ordinary source descriptor on the node's request config:

    ```json
    { "sqo": { "section_tipo": [ { "source": "section", "value": ["dd922"] } ] } }
    ```

    A node still carrying the old keys is **not** silently ignored: every build of that element logs one error naming the node and the exact replacement descriptor, and then resolves by the ordinary rule. On this install the playground node `test169` is the only one carrying them.

## Data model

**Data:** `array of locators`.

**Value:** `array` of `strings`, or `null`. The displayed value is resolved from the *target* record, never stored locally.

**Storage shape.** A component never touches the database; it reads and writes through its section. A related component's own locators live in the section matrix `relation` column as a JSONB map `{from_component_tipo: [locators]}`, and the section also maintains a global `relations` container that aggregates every locator across the record. `component_relation_model` slices its own subset out of that bag by matching `from_component_tipo` (its own `tipo`) and `section_tipo`.

The canonical locator shape for this component is `{id, type, section_tipo, section_id, from_component_tipo}`:

```json
[
    {
        "id"                  : 1,
        "type"                : "dd98",
        "section_tipo"        : "dd922",
        "section_id"          : 1,
        "from_component_tipo" : "test169"
    }
]
```

- `type` — the relation-type tipo. Defaults to the descriptor's `defaultRelationType`, which for this component is `dd98`. The relations engine injects it on every incoming locator.
- `section_tipo` / `section_id` — point at the target record (one of the resolved target sections).
- `from_component_tipo` — the owning component's own `tipo`; the relations engine forces this to the component's own `tipo` on save (cloning the locator first to protect observers) so a single section-wide relations bag can serve many distinct relation components.
- `id` — the per-item counter id used to pair the locator across operations.

!!! note "No directionality flag"
    Unlike [component_relation_related](component_relation_related.md), this component declares no default directionality, so model locators carry no `type_rel` uni/bi/multidirectional marker by default. The link is stored on the originating side.

!!! note "Duplicate detection"
    Adding a locator de-dupes against the existing data by comparing `['section_tipo','section_id','type','from_component_tipo']` (`compareLocators()`, `src/core/concepts/locator.ts`). Auto-references and malformed locators are rejected by the relations engine.

## Ontology instantiation

A `component_relation_model` is created as an ontology node whose `model` is `component_relation_model`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` term; related components are non-translatable, so `translatable` is `false`.

Node definition (shape):

```json
{
    "tipo"         : "test169",
    "model"        : "component_relation_model",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "Job category",
    "lg-spa"       : "Categoría laboral",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block — a **pinned** target: the node names the target section itself, and the `show.ddo_map` names the component of that section whose value labels each option:

```json
{
    "source": {
        "mode": "autocomplete",
        "request_config": [
            {
                "sqo": {
                    "section_tipo": [ { "source": "section", "value": ["dd922"] } ]
                },
                "show": {
                    "ddo_map": [
                        {
                            "tipo": "dd924",
                            "parent": "self",
                            "section_tipo": "self",
                            "value_with_parents": false
                        }
                    ],
                    "fields_separator": ", "
                }
            }
        ]
    }
}
```

A **caller-derived** target instead leaves `sqo.section_tipo` empty (or omits it) and lets the model default fill it — this is `hierarchy27`'s own definition, whose label ddo `hierarchy25` is resolved against whichever model section the caller resolves to:

```json
{
    "source": {
        "request_config": [
            {
                "sqo": { "section_tipo": [] },
                "show": {
                    "ddo_map": [
                        {
                            "tipo": "hierarchy25",
                            "parent": "self",
                            "section_tipo": "self",
                            "value_with_parents": false
                        }
                    ],
                    "fields_separator": ", "
                }
            }
        ]
    }
}
```

Declaring `{ "source": "section_model" }` explicitly asks for the same rule and is the clearer form for a new node; leaving the array empty relies on the model default.

`section_tipo` / `parent` tell the section which column owns this component's locators; on save the section is the single writer to the database. The structure-context builder (`src/core/resolve/structure_context.ts`) resolves the target sections from the parsed `request_config` and attaches each as `context.target_sections` (`{tipo, label}`), so the client knows which sections it may link to. In `edit` mode the shared select-family resolver also attaches the `datalist` (`src/core/relations/datalist.ts`, `getDatalist`) of selectable options.

## Properties & options

Properties live in the ontology node `properties` JSON. Verified names consumed by this component (`target_mode` and `target_values` are **not** among them — see [Retired](#target-resolution)):

### source

- **Values:** object `{mode, request_config}` (the standard related-component source descriptor).
- **Effect:** drives the option list / lookup. `mode` is typically `"autocomplete"`; `request_config` carries the `sqo` / `show.ddo_map` that decide which target component value labels the options. Same structure used by [component_portal](component_portal.md) and [component_select](component_select.md). Consumed when building the datalist.

### has_dataframe

- **Values:** `true` | `false` (default `false`).
- **Effect:** marks the component as paired with a [component_dataframe](component_dataframe.md). The dataframe rows are cascaded by the shared relations engine whenever a locator is added or removed. See the *dedalo-dataframe* skill.

!!! note "Standard context properties"
    Like every component, `component_relation_model` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view to use). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

!!! warning "sort_by_column"
    This component is sortable by default (its descriptor declares no `sortable: false` override), so its locator list is sortable and column-sort is available in principle. The `sort_by_column` property and the column-sort UI are documented under [component_portal](component_portal.md#properties); if you rely on it here, verify the behaviour in the ontology for your instance.

## Render views & modes

Because the client class is an alias of [component_select](component_select.md), the views and modes are component_select's, dispatched from the select render files. Verified from `client/dedalo/core/component_select/js/` and the CSS in `client/dedalo/core/component_relation_model/css/component_relation_model.less` (which styles `view_default` and `view_line`):

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | — | (via search render) | Full wrapper: label, buttons, `content_data` with a `<select>` per locator (max-width 80%) and a per-row `remove` button. |
| `line` | yes | — | — | Block layout, compact inline (no label chrome). |
| `text` | — | yes | — | Plain text of the resolved value(s) for list / tm. |
| `mini` | — | yes | — | Minimal list rendering. |

Modes:

- **edit** — read/write a real record; the read path resolves the stored locators plus the `datalist` of selectable options, and adds the resolved `target_sections` to the context. The user picks target records from the select.
- **list / tm** — read-only listing; both resolve their labels through the shared datalist engine (`getRelationListValue`, `src/core/relations/datalist.ts`). `tm` (Time Machine) reuses the list render.
- **search** — builds an SQO filter input through the shared relation search path. Saves are blocked in search mode.

## Import / export model

**Import.** The default import format is the JSON locator array of the component data; when the relation targets a single section the import can also be a sequence of `section_id` values. The shared import engine (`conformImportData()`, `src/core/tools/import_data.ts`) injects `type` (`dd98`) and `from_component_tipo`, and resolves the target section (the column name may carry the explicit target as `<component_tipo>_<section_tipo>`, e.g. `test169_dd922`). An empty cell clears the existing data.

Default import (JSON locators):

```json
[{"type":"dd98","section_tipo":"dd922","section_id":1,"from_component_tipo":"test169"}]
```

A number sequence of `section_id` when there is a single resolved target section:

```json
1,5,8
```

With multiple resolved targets, define the target section in the column header as `<component_tipo>_<section_tipo>` (e.g. `test169_dd922`). See the full related-data definition in [importing data](../../using/importing_data.md#related-data).

**Export.** Related components resolve each locator against its target section/component. The shared export path iterates the locators and, per the `ddo_map`, resolves each child component against the locator's `section_id` / `section_tipo` to produce the displayed sub-columns; the indexation grid resolves the same way. See [exporting data](../../using/exporting_data.md).

## Notes

- **Server / client split.** Only the client layer aliases [component_select](component_select.md). Server-side resolution is its own: the descriptor declares its own model relation type (`dd98`) and its own default target source (`section_model`, see [Target resolution](#target-resolution)) — do not assume it behaves identically to `component_select` server-side.
- **Default tools.** A non-translatable related instance exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools` (verified from `samples/context.json`). Tools are read-only context, assembled from the model + ontology, not hardcoded in the component.
- **Observers / observables.** Wiring, when needed, is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section), not in the component code. Observer-driven data updates are applied by the shared propagation engine (`src/core/section/record/observers.ts`) — see [Server-side observers](../system/observers.md).
- **Shared relation behaviour.** From the relations engine (`src/core/relations/`): locator normalization and validation, adding/removing a locator (with the dataframe cascade), grid / export / diffusion resolution, the relations-index persistence, JSON diffusion output in SQL targets, parent-reference cleanup on delete, and search.
- **Related components:** [component_portal](component_portal.md), [component_select](component_select.md), [component_relation_related](component_relation_related.md), [component_relation_parent](component_relation_parent.md), [component_relation_children](component_relation_children.md), [component_radio_button](component_radio_button.md), [component_check_box](component_check_box.md), [component_dataframe](component_dataframe.md).
