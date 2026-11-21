# component_radio_button

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
            "view" : "default | line | rating | print",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text",
            "mode" : "list | tm"
        }
    ],
    "data": "object",
    "sample_data": [
        {
            "id"                  : 8,
            "type"                : "dd151",
            "section_id"          : 1,
            "section_tipo"        : "dd64",
            "from_component_tipo" : "test87"
        }
    ],
    "value": "array of locators (single entry)",
    "sample_value": [
        {
            "id"                  : 8,
            "type"                : "dd151",
            "section_id"          : 1,
            "section_tipo"        : "dd64",
            "from_component_tipo" : "test87"
        }
    ]
}
```

!!! note "Typology"
    `component_radio_button` is a **related** component, declared as a descriptor over the shared relations engine like every relation-column model (see [component_portal](component_portal.md)). It does not own literal data: instead of a string it stores a [locator](../locator.md) pointing at a record of a *list-of-values* section, and the displayed value is resolved from that target record. Its descriptor is thin — it sets `defaultRelationType: 'dd151'`, a fixed duplicate-detection key (`section_tipo`, `section_id`, `type`, `from_component_tipo`), and is sortable by default; everything else (validation, storage, grid/export/diffusion resolution, import) comes from the shared relations engine.

!!! info "About `default_tools`"
    The toolbar is assembled from the model + ontology, not hardcoded in the descriptor. The verified sample (`samples/context.json`) carries `tool_propagate_component_data` and `tool_time_machine`. Because the component is **non-translatable**, `tool_lang` / `tool_lang_multi` are not added. Tools are read-only context.

!!! info "TS server implementation"
    The descriptor `src/core/components/component_radio_button/descriptor.ts` registers `resolveData: 'select_family'` (`src/core/relations/models/select_family.ts`), the same resolver shared by `component_select` / `component_select_lang` / `component_check_box` / `component_publication` / `component_relation_model`. `list`/`edit`/`search` modes resolve the option datalist and label strings via `src/core/relations/datalist.ts`; other modes fall through to the shared portal engine. See the *dedalo-relations-ts* skill.

## Definition

`component_radio_button` is the **single-select** related field of Dédalo. It renders a group of radio inputs, one per option in a closed list of values, and lets the cataloguer pick exactly one. Selecting an option stores a single locator pointing at the chosen list-of-values record; selecting a different option **replaces** the previous selection rather than adding to it.

**Why it exists.** Many catalogue fields are mutually exclusive choices drawn from a short controlled vocabulary: a yes/no flag, a publication state, an acquisition type, a single condition grade. A radio group makes the exclusivity visible and enforces it at the UI level (the underlying data is a one-entry locator array). It is the related sibling of the literal text field: the cataloguer never types the value, they pick a record from a managed list, so the vocabulary stays consistent and is itself editable as a section.

**When to use it.**

- A single mandatory or optional choice from a small, stable vocabulary: *Yes/No*, *Published / Draft*, *Acquisition type* (purchase / donation / loan), *Sex* (in an anthropology record), a single *Condition* grade.
- A star-style *rating* (1–5) where the options are ordered records and exactly one is selected — use the `rating` view.
- Any place you want the exclusivity of a radio group and the value to live in a separately curated list-of-values section.

**When not to use it.**

- Multiple simultaneous selections from the same list → use [component_check_box](component_check_box.md), which stores many locators.
- A long option list, or one that needs type-ahead search → use [component_select](component_select.md) (drop-down) or [component_portal](component_portal.md) / [component_autocomplete](component_portal.md) (free relation with autocomplete).
- A literal string the user types directly → use [component_input_text](component_input_text.md).

## Data model

**Data:** `object`. On the server the value is an array of [locator](../locator.md) objects (single entry for a radio button). On the client the data datum also carries a `datalist` array — the resolved option list — and the selected value under `entries`.

**Value:** `array` of `locators` (one element), or `null`.

**Storage shape.** Like every related component, `component_radio_button` does not write its own column. Its locator lives in the matrix `relation` column — singular, and an **object keyed by component tipo**, not a flat array — so the component reads its own entry under its `tipo` (and still matches `from_component_tipo`/`section_tipo` when slicing a shared bag). The canonical locator shape is `{type, section_tipo, section_id, from_component_tipo}` plus the per-entry `id`:

```json
{
    "relation": {
        "test87": [
            {
                "id"                  : 8,
                "type"                : "dd151",
                "section_id"          : 1,
                "section_tipo"        : "dd64",
                "from_component_tipo" : "test87"
            }
        ]
    }
}
```

- `type` is the relation-type tipo, defaulting to `dd151` (the generic link) from the descriptor's `defaultRelationType`.
- `section_tipo` / `section_id` point at the chosen record in the *target* list-of-values section (here `dd64`, the built-in *Yes/No* section).
- `from_component_tipo` is forced to the owning component's own `tipo` when the relations engine normalises the locator on save; it is what lets one section-wide relations bag serve many distinct relation components.

Because it is non-translatable, the component is always instantiated with `lang = lg-nolan` and the locator carries no `lang`.

!!! note "Datum vs. client `entries` / `datalist`"
    The transmitted unit is a `{context, data}` datum. In `edit` and `tm` modes the server returns the stored value under `data.entries` **and** attaches a `datalist` — the resolved option list. In plain `list` mode it returns the resolved labels and no datalist (the render only needs the checked label). Client sample:

    ```json
    {
        "section_id"          : 1,
        "section_tipo"        : "test3",
        "tipo"                : "test87",
        "lang"                : "lg-nolan",
        "from_component_tipo" : "test87",
        "entries": [
            {"id":8,"type":"dd151","section_id":1,"section_tipo":"dd64","from_component_tipo":"test87"}
        ],
        "datalist": [
            {"value":{"section_tipo":"dd64","section_id":2},"label":"No","section_id":2,"hide":[]},
            {"value":{"section_tipo":"dd64","section_id":1},"label":"Si","section_id":1,"hide":[]}
        ]
    }
    ```

## Ontology instantiation

A `component_radio_button` is created as an ontology node whose `model` is `component_radio_button`. Its `parent` is the section (or grouper) it belongs to, and `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` terms and — being non-translatable — is marked `translatable: false`. The list of options it offers is **not** part of the node body: it is resolved at runtime from the component's `request_config` (RQO), which targets the list-of-values section.

Node definition (shape):

```json
{
    "tipo"         : "test87",
    "model"        : "component_radio_button",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "Published?",
    "lg-spa"       : "¿Publicado?",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block for a mandatory yes/no radio that points at a list-of-values section and joins multiple target columns with a comma:

```json
{
    "mandatory"        : true,
    "fields_separator" : ", ",
    "config_relation"  : {
        "relation_type" : "dd151"
    },
    "css" : {
        ".wrapper_component": { "grid-column": "span 3" }
    }
}
```

The option list is wired through the node's request config: the `show.ddo_map` names the target section (`dd64` in the verified sample) and the label component to resolve (`component_input_text` `dd62`). `getDatalist()` (`src/core/relations/datalist.ts`) runs that RQO and returns the `datalist` consumed by the edit/search render. On save the section is the single writer; the component hands its relations slice (keyed by `from_component_tipo`) to the section record, and the locator is also persisted to the relations index for cross-record querying.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component (most of them handled by the shared relations engine, not by the model itself):

### config_relation

- **Values:** object `{relation_type, relation_type_rel}`.
- **Effect:** sets the relation type written into the locator. `relation_type` is taken from `properties.config_relation.relation_type`, falling back to the model default `dd151` (`DEDALO_RELATION_TYPE_LINK`). Accepted relation-type tipos:

    | typology | tipo |
    |---|---|
    | Link | `dd151` |
    | Indexation | `dd96` |
    | Child | `dd48` |
    | Parent | `dd47` |
    | Filter | `dd675` |
    | Ontology | `dd77` |

    ```json
    {
        "config_relation": { "relation_type": "dd96" }
    }
    ```

### source

- **Values:** object (RQO / list-of-values configuration). Verify the exact shape in the ontology.
- **Effect:** drives where the option list comes from and, optionally, observed-data behaviour. Older nodes may carry the legacy option-list keys `source.section_to_search`, `source.component_to_search`, `source.data_from_field`, `source.source_overwrite` and `source.set_observed_data`. In most installations the option list is supplied by the node's parsed `request_config` (`show.ddo_map`) rather than a bespoke `source` block.

### fields_separator

- **Values:** string (e.g. `", "`).
- **Effect:** the character used between **fields of the target record** when the selected value is flattened to text (grid display, export, and when shown inside another component). For example, joining surname + name as `Ramón y Cajal, Santiago`.

### records_separator

- **Values:** string (e.g. `" | "`).
- **Effect:** the character used between **records (locators)** when more than one is flattened to text. A radio button normally holds a single entry, so this rarely applies; it is part of the shared relation contract, kept for parity with multi-value relation components.

### mandatory

- **Values:** `true` | `false` (default `false`).
- **Effect:** informs the user the field requires a value. It is a UI signal, not a server-enforced constraint.

### dato_default

- **Values:** an array of value items (for this component, locators: `[{"section_id": 1, "section_tipo": "dd501"}]` is the default of `oh93`, *Review status*). The `{"method": "<method_name>"}` form is not supported: a node declaring it makes its section's records impossible to create, loudly.
- **Effect:** the value is written when a record is **created**, through every creation door (the list "+", a portal "+", an import…). Opening an existing record never writes it. Handled by the shared default mechanism common to every component — see [Ontology authoring](../ontology/authoring.md#dato_default--a-default-is-written-when-the-record-is-created).

!!! note "Standard context properties"
    Like every component, `component_radio_button` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (the RQO that resolves the option list) and `view` (the render view to use). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files. Verified from the source:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | (via search render) | One `content_value` per datalist option, each a `<label>` wrapping an `<input type="radio">`; the selected option gets the `checked` class. Read-only users (permission 1) see only the matched label. |
| `line` | yes | — | — | Same radio group laid out inline (`content_data { display: contents }`). |
| `rating` | yes | — | — | Renders the ordered options (sorted by `section_id`) as star icons; every star up to the selected `section_id` gets the `rated` class. Picking a star saves the matching locator. |
| `print` | yes | — | — | Reuses the `default` edit view but forces `permissions = 1` (read-only) and tags the wrapper `view_print`. |
| `mini` | — | yes | — | Minimal list rendering of the checked label. |
| `text` | — | yes | — | Plain text rendering of the checked label. |

Modes (from `component_radio_button.js`):

- **edit** — read/write; renders the radio group from `datalist`. Every change calls `handle_radio_change()`, which clones the chosen datalist value, re-attaches the entry `id`, and force-saves via `change_value()` (one selection at a time). A *reset* button removes the current selection (`action: 'remove'`); a *list* button per target section opens that section in a new window.
- **list / tm** — read-only listing; both reuse the list render (`tm` is aliased to `list`). The displayed value is the resolved option label(s), produced by the shared relation-list value resolution. In a dataframe `tm` context the server additionally ships the `datalist` so the dataframe can rebuild its scenario.
- **search** — builds the SQO filter input: one radio per option plus a `q_operator` text input. Alt-click clears the selection. Each change publishes `change_search_element`; selecting an option writes a locator into the search query.

DOM (edit / default): `wrapper_component component_radio_button <tipo> <mode> view_default` → `label`, `buttons_container`, `content_data` → one `content_value` per option → `label.label` → `input[type=radio]`.

## Import / export model

**Import.** The default import format is the shared related-component format — a JSON array of [locator](../locator.md) objects — handled by the shared related-component import path:

```json
[{"type":"dd151","section_id":1,"section_tipo":"dd64","from_component_tipo":"test87"}]
```

When the radio button points at a single target section, a bare `section_id` (or a comma sequence) is also accepted; the importer infers the target `section_tipo` from that one configured target section and builds the full locator. If multiple target sections are configured the target must be made explicit in the column header (`<component_tipo>_<section_tipo>`), otherwise the cell is rejected and logged (`IGNORED: Trying to import multiple section_tipo without clear target`). An empty cell clears the existing selection. Invalid `section_id` / `section_tipo` values are rejected and logged rather than stored. See the full related-data definition in [importing data](../../using/importing_data.md#related-data).

**Export.** Resolution comes from the shared relation export path (the export atoms path, `src/diffusion/export/atoms.ts`): it iterates the stored locator(s) and, per the `ddo_map`, resolves the named child component against the locator's `section_id` / `section_tipo` to produce the displayed label, joining target fields with `fields_separator`. See [exporting data](../../using/exporting_data.md).

## Notes

- **Single selection.** The defining behaviour: although the value is technically an array of locators, the component enforces one entry. Selecting another option replaces the existing locator (the change handler reuses the current entry `id`); the reset button removes it.
- **Option list (datalist).** Options are resolved by `getDatalist()` (`src/core/relations/datalist.ts`) from the component's `request_config` (RQO), which targets a managed list-of-values section. Editing the vocabulary means editing that section's records — see the *dedalo-datalist-resolution* skill.
- **Sortable.** A radio-button column **can** be used to order a list / portal by its selected value. `resolveSortable()` (`src/core/resolve/structure_context.ts`) defaults every model to sortable and `component_radio_button`'s descriptor does not opt out.
- **Observers / observables.** Wiring, when needed, is configured in the ontology `properties` (`observe` / `observers`) like any other component. See the index page *Observers and observables* section.
- **Default tools.** A standard instance exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools`. Tools are read-only context.
- **Permissions.** Resolved by the permissions engine (`getPermissions()`, `src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Read users (level 1) get the read-only label; selecting and saving require level >= 2. Saves are refused in `search` mode.
- **Related components:** [component_check_box](component_check_box.md) (multi-select sibling), [component_select](component_select.md) (drop-down single select), [component_portal](component_portal.md) (free relation / autocomplete), [component_relation_related](component_relation_related.md), [component_dataframe](component_dataframe.md), [component_input_text](component_input_text.md).