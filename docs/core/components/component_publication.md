# component_publication

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
            "mode" : "list"
        }
    ],
    "data"        : "array of locators",
    "sample_data" : [
        {
            "id"                  : 3,
            "type"                : "dd151",
            "section_id"          : 1,
            "section_tipo"        : "dd64",
            "from_component_tipo" : "test92"
        }
    ],
    "value"        : "array of locators",
    "sample_value" : [
        {
            "id"                  : 3,
            "type"                : "dd151",
            "section_id"          : 1,
            "section_tipo"        : "dd64",
            "from_component_tipo" : "test92"
        }
    ]
}
```

!!! note "Typology"
    `component_publication` is a **related** component. Like every relation-column model, it is declared as a descriptor over the shared relations engine rather than a class in an inheritance tree. It stores no literal value of its own: its data is an array of [locator](../locator.md) objects pointing at the shared yes/no section. It is **never translatable** — its descriptor declares no `classSupportsTranslation`, so it is always instantiated with `lang = lg-nolan`, and the context is always emitted with `translatable: false`.

!!! info "About `default_tools`"
    The list above is what the model sample (`samples/context.json`) carries in `context.tools`: `tool_propagate_component_data` and `tool_time_machine`. Because the component is non-translatable, it never receives `tool_lang` / `tool_lang_multi`. The toolbar is assembled from the model + ontology; it is not hardcoded in the descriptor.

!!! info "Server implementation"
    The descriptor `src/core/components/component_publication/descriptor.ts` registers `resolveData: 'select_family'` (`src/core/relations/models/select_family.ts`), the same resolver shared by `component_select` / `component_select_lang` / `component_radio_button` / `component_check_box` / `component_relation_model`. `list`/`edit`/`search` modes resolve the yes/no datalist and label through `src/core/relations/datalist.ts`; other modes take the shared portal engine. The diffusion-side publication gate this component drives is implemented natively in `src/diffusion/resolve/resolver.ts` (its publication-gate logic: a section's `component_publication` locator must resolve to `dd64`/*yes*; a section with no `component_publication` is always publishable; the resolution priority is ontology `is_publishable` override, then inherited `publishable_overrides`, then this live locator check; any gate error fails closed to *unpublish*). See the *dedalo-relations-ts* skill.

## Definition

`component_publication` is the **publication switch** of a record: a simple binary yes/no toggle that marks whether a record should be published to external systems. Instead of storing a literal boolean, it stores a [locator](../locator.md) pointing at the shared **yes/no section** (`DEDALO_SECTION_SI_NO_TIPO = 'dd64'`), where `section_id = 1` is *yes* (`NUMERICAL_MATRIX_VALUE_YES`) and `section_id = 2` is *no* (`NUMERICAL_MATRIX_VALUE_NO`). An empty value (no locator) is the undecided / default state.

**Why it exists.** A cultural-heritage catalogue almost always distinguishes the *internal* working dataset from what is exposed to the public — a museum portal, an open-data endpoint, an RDF / SQL diffusion target. `component_publication` is the per-record gate for that distinction. The diffusion engine's publication gate reads it directly: it locates the section's `component_publication`, resolves its locator, and only treats the record as publishable when the locator points at *yes* in section `dd64`. A section with **no** `component_publication` is considered publishable (the switch is opt-out, not opt-in).

**When to use it.**

- A per-record "Publish / Do not publish" flag that drives diffusion: *Publish this object on the public web*, *Include in the open-data export*, *Visible in the public catalogue*.
- Any place where you want a single, sortable, language-neutral binary state that the publication / diffusion subsystem can query record by record.

**When not to use it.**

- A generic yes/no field that is **not** about publication and should not influence diffusion — model it with [component_radio_button](component_radio_button.md) or [component_check_box](component_check_box.md) against the yes/no section instead.
- A free relation to arbitrary records (people, places, terms) -> use [component_portal](component_portal.md) or [component_select](component_select.md).
- Multilingual or free-text descriptive data -> use a literal component such as [component_input_text](component_input_text.md).

## Data model

**Data:** `array of locators`. The array is normally zero or one locator long (the switch is binary), but the storage shape is the standard related-component array.

**Value:** `array of locators`, or `null`. Unlike literal components, the displayed value is not a local string; the *yes/no* label is resolved from the target section's option list (the datalist) and matched against the stored `section_id`.

**Storage shape.** A component never touches the database; it reads and writes through its section, which persists related-component locators in its matrix **`relation`** column as a JSONB map keyed by component tipo. The section also aggregates every locator across the record into a global `relations` container; the component slices out its own subset by matching `from_component_tipo` against its own `tipo`.

A single stored locator (record marked **for** publication, *yes* = `section_id "1"` in section `dd64`):

```json
[
    {
        "id"                  : 3,
        "type"                : "dd151",
        "section_id"          : 1,
        "section_tipo"        : "dd64",
        "from_component_tipo" : "test92"
    }
]
```

The same component explicitly **excluded** from publication (*no* = `section_id "2"`):

```json
[
    {
        "id"                  : 1,
        "type"                : "dd151",
        "section_id"          : 2,
        "section_tipo"        : "dd64",
        "from_component_tipo" : "test92"
    }
]
```

Undecided / default — no locator stored at all:

```json
[]
```

Locator fields:

- `type` — the relation-type tipo. Defaults to the descriptor's `defaultRelationType` (`dd151`, the generic link type), injected by the relations engine when a locator is normalised on save.
- `section_tipo` — always the yes/no section `dd64` (`DEDALO_SECTION_SI_NO_TIPO`).
- `section_id` — `"1"` for *yes*, `"2"` for *no*.
- `from_component_tipo` — forced to the owning component's own `tipo` when the relations engine normalises the locator on save (it clones the locator first, so observers still see the value they were handed). This is the property the section and the relation-list resolution use to slice this component's locators out of the global `relations` bag.
- `id` — the per-item counter id (paired with the changed-data entry on save).

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum (the JSON-API contract). In the API payload (`samples/api_data.json`) the locator items are surfaced under `data.entries`, alongside `from_component_tipo` and a `datalist` of the selectable yes/no options. `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view`) and never the values. See the *dedalo-context-data-layers* skill for the full layering rules.

Duplicate detection on save compares locators on `['section_tipo','section_id','type','from_component_tipo']` (`compareLocators()`, `src/core/concepts/locator.ts`): two locators agreeing on all four are de-duped.

## Ontology instantiation

A `component_publication` is created as an ontology node whose `model` is `component_publication`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` ontology terms; because the component is non-translatable, no `is_translatable` flag is needed (it is forced off at construction).

Node definition (shape, mirroring `samples/context.json`):

```json
{
    "tipo"           : "test92",
    "model"          : "component_publication",
    "parent"         : "test3",
    "parent_grouper" : "test45",
    "section_tipo"   : "test3",
    "lg-eng"         : "publication",
    "lg-spa"         : "publicación",
    "properties"     : { }
}
```

Realistic `properties` block. The component is typically used with empty `properties` (the model sample ships `{}`); the target yes/no section and its datalist are resolved by the shared related-component machinery via `request_config` / `source`. A common, minimal layout-only block:

```json
{
    "css" : {
        ".wrapper_component": { "grid-column": "span 2" }
    }
}
```

`section_tipo` / `parent` tell the section which `relation` column owns this component's locators. On save the component hands its locator array to the owning section record, which is the single writer to the database; the locators are persisted into the section's `relation` column and aggregated into the global `relations` container.

!!! info "Target section is fixed"
    Unlike a free [component_portal](component_portal.md), a publication switch always targets the yes/no section `dd64`. The selectable options (`yes` / `no`) are resolved from that section as the component's datalist; the client renders them as a single on/off switch (edit) or as radio options (search).

## Properties & options

`component_publication` defines **no component-specific properties of its own**. Its descriptor fixes its behaviour instead:

- `defaultRelationType: 'dd151'` — the relation type written into every locator. Not an ontology option.
- A fixed duplicate-detection key (`section_tipo`, `section_id`, `type`, `from_component_tipo`). Not an ontology option.
- The component can be used to sort records in list mode by publication status.
- No `classSupportsTranslation` is declared, so any translatability declared in the ontology is ignored and the language is always `lg-nolan`.

It still honours the generic context blocks carried into every component's `context` (these are **not** publication-specific):

### css

- **Values:** object mapping CSS selectors (e.g. `.wrapper_component`) to style rules.
- **Effect:** style stamped on the component wrapper. Used for grid layout.

### request_config / source

- **Values:** the standard related-component request-config object (`source.mode`, `request_config[].sqo`, `show`, `choose`, `ddo_map`).
- **Effect:** drives the datalist resolution (`getDatalist()`, `src/core/relations/datalist.ts`) — the selectable yes/no options fetched from the target section. In normal use this resolves to the two options of section `dd64`. Verify the exact shape in the ontology for any non-default deployment.

!!! note "No bespoke flags"
    There are no `mandatory`, `unique`, `with_lang_versions`, `dato_default` or similar publication-specific options. If a production ontology node carries any other key under `properties`, verify it in the ontology — it is generic context, not a `component_publication` feature.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files (`render_edit_*`, `render_list_*`, `render_search_*`). Verified from the source:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | yes | Edit: renders the on/off **switch** (`switcher_publication`) per entry, an `<input type="checkbox">` whose checked state is *yes* (`section_id==1`). List: `build_wrapper_list` with the joined value, clicking enters `edit` / `line`. Search: radio options + a `q_operator` input. |
| `line` | yes | — | — | Compact inline switch (`view_line`), zoomed-down switcher, no label. |
| `print` | yes | — | — | Falls through to the `default` edit view but forces `permissions = 1` (read-only) and tags the wrapper `view_print`; renders the resolved yes/no label instead of an interactive switch. |
| `mini` | — | yes | — | Minimal `build_wrapper_mini`, value entries joined by `context.fields_separator`. |
| `text` | — | yes | — | Plain `<span>` with the entries joined by `context.fields_separator`, no chrome. |

Modes:

- **edit** — interactive switch. Toggling the checkbox calls the unified `change_handler()`, which picks the *yes* (`section_id 1`) or *no* (`section_id 2`) locator from the `datalist`, builds a `changed_data` entry and **saves on every change** (`change_value({refresh:false})`); it then publishes `change_publication_value_<id_base>` on the event manager so dependent UI (for example a notes tag's state) can react. In read mode (`permissions===1`) the switch is replaced by the resolved label.
- **list / tm** — read-only listing; the JS wires `tm` to the same renderer as `list`. The label shown in the cell comes from the shared relation-list value resolution (`getRelationListValue()`, `src/core/relations/datalist.ts`).
- **search** — builds an SQO filter. Each yes/no option is a `radio` input; selecting one sets the filter locator (`from_component_tipo` injected = the component's own tipo), and **Alt-clicking** a selected option de-selects it (a "no value" filter, `action: 'remove'`). A `q_operator` text input is provided. Saves are blocked in search mode (the change handler publishes `change_search_element` instead of saving).

DOM (edit / default): `wrapper_component component_publication <tipo> <mode>` -> `content_data.nowrap` -> one or more `content_value` -> `label.switcher_publication` -> `input[type=checkbox]` + `<i>` (the switch graphic).

## Import / export model

`component_publication` follows the shared related-component import/export contract.

**Import.** The import conform step (`conformImportData()`, `src/core/tools/import_data.ts`) accepts the JSON locator format, the same as any related component. For a publication switch the meaningful locators point at `dd64` with `section_id` `1` (*yes*) or `2` (*no*):

```json
[{"type":"dd151","section_id":1,"section_tipo":"dd64","from_component_tipo":"test92"}]
```

Because the target section is fixed to the yes/no section, the short numeric `section_id` sequence form (used by single-target [component_portal](component_portal.md)) can also apply — `1` selects *yes*, `2` selects *no*. See [importing data](../../using/importing_data.md#related-data).

**Export.** The shared relation export path (the export atoms path, `src/diffusion/export/atoms.ts`) iterates the locators and resolves each against the target section per the `ddo_map`, emitting the resolved yes/no label. See [exporting data](../../using/exporting_data.md).

## Notes

- **Diffusion integration.** This is the component's primary consumer. The diffusion resolver's publication gate finds the section's `component_publication`, resolves its stored locator, and treats the record as publishable only when the locator's `section_tipo` is the yes/no section (`dd64`) and its `section_id` is *yes* (`1`). A section **without** a `component_publication` is treated as publishable.
- **Observers / observables.** No subscriptions ship in the component JS. On every edit-mode change it publishes `change_publication_value_<id_base>` for any client listener; observer/observable wiring, when needed, is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section).
- **Sortable.** Records can be ordered by publication status in list views.
- **Language-neutral.** The component is never translatable and never receives language tools.
- **Default tools.** `tool_propagate_component_data` (propagate the same publication state to other records) and `tool_time_machine` (every switch toggle is a real save, recorded in Time Machine). Tools are read-only context.
- **Permissions.** Resolved by the permissions engine (`getPermissions()`, `src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Read users (level 1) get the read-only label render; the interactive switch and saves require level >= 2.
- **Related components:** [component_radio_button](component_radio_button.md), [component_check_box](component_check_box.md), [component_select](component_select.md), [component_portal](component_portal.md), [component_relation_related](component_relation_related.md), [component_dataframe](component_dataframe.md).
