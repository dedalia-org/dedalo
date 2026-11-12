# component_number

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_time_machine",
        "tool_replace_component_data",
        "tool_add_component_data"
    ],
    "render_views" :[
        {
            "view"    : "default | mini",
            "mode"    : "edit | list"
        },
        {
            "view"    : "line | print",
            "mode"    : "edit"
        },
        {
            "view"    : "text",
            "mode"    : "list"
        }
    ],
    "data": "object",
    "sample_data": {
        "lg-nolan":[5.27]
    },
    "value": "array of numbers",
    "sample_value": [4,-25,7.89]
}
```

!!! note "About the flags"
    `could_be_translatable`, `is_literal`, `is_related` and `is_media` are client-model classifiers consumed by the render layer (literal value vs relation locator vs media). For `component_number` they are fixed: it is a **literal-direct** component, it stores its own numeric value, and it is **never** translatable — its descriptor declares no `classSupportsTranslation`, so it is always instantiated with `lang = lg-nolan`.

## Definition

`component_number` manages numeric data (integers and floating-point numbers) with controlled type and precision. It is a literal-direct component: it owns and formats its own value, independent of any other ontology node, and persists that value through its section.

**Why it exists.** Plenty of cultural-heritage data is genuinely numeric and must behave as a number, not as text: it has to round to a fixed precision, sort numerically (not lexicographically — `100` after `99`, not after `1`), and be filterable with comparison and range operators in search. `component_input_text` cannot do any of that, so numeric fields use `component_number`.

**When to use it.** Measurements and counts: an object's height/width/weight in cm or g, a coin's diameter or die-axis, the number of pages in a manuscript, a quantity of fragments, an inventory count, a monetary amount, a temperature, a stratigraphic depth.

**When not to use it.**

- Years / dates / time spans → use [component_date](component_date.md) (it understands calendars, BCE, periods and partial dates; a year is not just a number).
- Catalogue or inventory **codes** that happen to contain digits but are identifiers, not quantities (e.g. `INV-0042`, leading zeros, codes you never sum or compare numerically) → use [component_input_text](component_input_text.md).
- A choice among a fixed numeric set → use [component_select](component_select.md) or [component_radio_button](component_radio_button.md).

!!! note "Not translatable"
    A number is the same in every language, so the component is non-translatable. Its language is always `lg-nolan`. It does **not** expose `tool_lang`.

## Data model

**Data type:** `array` of data items (the values payload of the datum `data` layer).

**Value type:** `array` of `numbers` (`int` or `float`), or `null`.

**Types supported:** `int` | `float`
**Default type:** `float`
**Default precision:** `2`
**Decimal separator (storage):** always `.` (a different *input* separator is an import-time concern only; see below)

### Storage shape inside the matrix `data` column

`component_number` writes to the matrix column **`number`** (its descriptor at `src/core/components/component_number/descriptor.ts` declares `column: 'number'`; no `classSupportsTranslation` flag, matching the non-translatable behaviour). Inside that column the value is keyed by the component `tipo`, and each item is a v7 value object `{id, value}` (no `lang` key is added because the component is non-translatable). It resolves through the same generic `src/core/resolve/component_data.ts` every literal component uses; see `src/core/components/component_number/samples/` for the verified wire shapes:

```json
{
    "number": {
        "test211": [
            { "id": 5, "value": 31416.2 },
            { "id": 2, "value": 55 }
        ]
    }
}
```

`value` always holds the unformatted numeric literal. The decimal point is `.` and there is **no** thousand separator in storage. Internationalized display (e.g. the Spanish/French `1.234,56` for the stored `1234.56`) is applied only in the render/view layer, never persisted.

When the component is instantiated it reads its data through its section and works only on the `lg-nolan` partition (the only one a number has).

!!! info "Legacy lang-keyed export shape"
    Raw exports and ontology prior to the v7 dataframe normalization may present the value as a flat lang-keyed object:

    ```json
    { "lg-nolan": [104, -75.35] }
    ```

    Import still accepts this form: for the non-translatable number it extracts the first `lg-*` partition and normalizes each entry into v7 `{value}` items.

### Client data payload

On the wire the datum `data` carries the values as `entries` (the array the JS views iterate), e.g.:

```json
{
    "tipo": "test211",
    "section_tipo": "test3",
    "section_id": 1,
    "lang": "lg-nolan",
    "entries": [
        { "id": 5, "value": 31416.2 },
        { "id": 2, "value": 55 }
    ]
}
```

### Type / precision formatting

The client JS model applies the configured type on input:

- `type: "int"` → value cast to integer (`85.35` → `85`).
- `type: "float"` (default) → value rounded to `precision` decimals (default `2`; `85.3568` with `precision: 2` → `85.36`).

Unexpected/non-numeric values are rejected client-side: the edit view flags the input and refuses to silently overwrite the entry with `null`.

## Ontology instantiation

A `component_number` is defined as an ontology node (a `ddo`) whose `model` is `component_number` and whose `parent` is the section (or a parent grouper) it belongs to. As a non-translatable component its `lang` is fixed to `lg-nolan`.

Node definition (illustrative):

```json
{
    "tipo"          : "numisdata133",
    "model"         : "component_number",
    "parent"        : "numisdata1",
    "section_tipo"  : "numisdata1",
    "translatable"  : false,
    "lg-eng"        : "Diameter (mm)",
    "lg-spa"        : "Diámetro (mm)"
}
```

Realistic `properties` block for this component:

```json
{
    "type"      : "float",
    "precision" : 1,
    "css": {
        ".wrapper_component": { "grid-column": "span 3" }
    }
}
```

The `section_tipo` / `parent` wiring places the component as a column inside its section: on save, the generic engine (`src/core/section/record/save_component.ts`) writes the full updated item array back into the section's matrix row and appends the Time Machine audit row — the component never touches the database directly.

## Properties & options

| Property | Accepted values | Default | Effect |
| --- | --- | --- | --- |
| `type` | `"int"` \| `"float"` | `"float"` | Numeric type. `int` casts to integer; `float` enables decimal `precision`. |
| `precision` | integer (number of decimals) | `2` | Decimals kept when `type` is `float`. Applied on read, save, and the input `step`. Ignored for `int`. |
| `has_dataframe` | `true` \| `false` | `false` | Pairs each value item with a dataframe (uncertainty / qualifier / context) record. Required for literal mains (relation mains activate from the slot ddo alone); the control also renders read-only (Time Machine previews). Full ontology setup incl. a coloured rating: [component_dataframe](component_dataframe.md) → "Worked example — uncertainty rating on a literal". |
| `dato_default` | array of value items | (none) | Default value applied in `edit` mode for new records. **Not ported** — no module under `src/` reads `dato_default` yet (see [component_input_text](component_input_text.md#properties--options)). |
| `css` | object | (none) | Per-instance CSS injected into the datum `context`. Generic, shared by every component. |

!!! warning "Gap: `type`/`precision` casting is client-side only"
    Casting/rounding to `type`/`precision` happens only in the client (JS
    model), never on the server: the generic save path
    (`src/core/section/record/save_component.ts`) is model-agnostic and does
    not read `type`/`precision` — it persists whatever numeric value the
    client sends. Normal editing behaves correctly in practice because the
    client rounds/casts before sending; a value written through any other path
    (import, an API client bypassing the standard UI) will not be cast or
    rounded server-side.

!!! warning "Legacy `type` object form — deprecated"
    Ontology created **before 04/07/2024** used an object form like `"type": {"float": 2}`. This is incorrect/deprecated. Use the flat form `"type": "float"` + `"precision": 2`.

!!! note "Verify in ontology"
    `type` and `precision` are the only numeric-specific properties this model reads. Any other property on a real node is a shared/`request_config` property, not a `component_number` feature — verify it in the ontology before relying on it.

## Render views & modes

Views are selected from `context.view`; the render dispatcher per mode lives in `js/render_<mode>_component_number.js`.

| View | edit | list | tm | search | Source |
| --- | :---: | :---: | :---: | :---: | --- |
| `default` | yes | yes | yes (via list) | yes | `view_default_edit_number.js` / `view_default_list_number.js` |
| `mini` | yes | yes | yes (via list) | — | `view_mini_number.js` |
| `line` | yes | — | — | — | `view_line_edit_number.js` |
| `print` | yes | — | — | — | rendered as `default` forced read-only (`permissions = 1`) |
| `text` | — | yes | yes (via list) | — | `view_text_list_number.js` |

Notes from the source:

- `tm` (Time Machine) is rendered with the **same** renderer as `list` (`render_list`), read-only.
- The CSS (`css/component_number.less`) only defines styling for `view_default` and `view_line`; `mini`/`text`/`print` reuse shared/default rules.
- Edit views render one `<input type="text">` per value inside `content_value`; input is sanitized live by `clean_value()` (commas → dots, strips non-numeric chars) and finalized by `fix_number_format()` on `change`. The `+` button adds a value; the per-row remove button deletes one.
- **Search** allows a single input (only one value), preserves the between operator `...`, and does **not** apply `fix_number_format` so range expressions survive.

### Search operators

Server-side the filter is turned into SQL by `src/core/search/builders/builder_number.ts` (dispatched from `src/core/search/conform.ts`); it builds JSONB existence/comparison predicates over `<column>->'<tipo>'`. Supported operators:

| Operator | Meaning |
| --- | --- |
| `*` | not empty |
| `!*` | is empty |
| `value1...value2` | between (inclusive range), e.g. `10...20` |
| `>=` / `<=` / `>` / `<` | comparison |
| `!=42` | different: the record has a value and none of its values is `42` (the rest after `!=` reads with the same grammar, so `!=1...5` is "not between"). A record without a value does not match. Before 2026-09-29 this searched `= 0`. |
| `42` (no operator) | equality |

## Import / export model

By default the import model uses the canonical **v7 array of value objects** (numbers carry no language):

```json
[{"value":104},{"value":-75.35}]
```

In a CSV cell (escaped):

```text
section_id;numisdata133
1;"[{""value"":104},{""value"":-75.35}]"
```

Alternative accepted formats:

1. **Plain number** (simplest) — the whole cell is one number, e.g. `33.85`. The plain value is meant to **replace** any previous data, parsed to a real `int`/`float` with a configurable decimal separator.
2. **Array of bare numbers** (v6 form) — `[104,-75.35]`.
3. **Lang-keyed object** (legacy raw export) — `{"lg-nolan":[104]}`; the first `lg-*` partition is extracted and normalized.

The import engine (`conformImportData()`, `src/core/tools/import_data.ts`) handles (2) and (3) generically (the JSON array/lang-keyed branches wrap bare numbers into `{value}` items), but **not (1) faithfully**:

!!! warning "Gap: plain-number cells are not parsed to a number"
    A bare non-JSON cell like `33.85` does not start with `[`/`{`, so it falls
    through to the generic value-property wrap (`component_number` is a
    `VALUE_PROPERTY_MODELS` member) and is stored as `{"value": "33.85"}` — the
    **raw string**, not a parsed number. There is no decimal-separator option
    and no `int`/`float` cast in the TS import path. Import numeric columns as
    proper JSON (`[{"value":33.85}]`) to be safe until this is ported.

See the full import definition in [importing_data.md → Numbers](../../using/importing_data.md#numbers) and the export model in [exporting_data.md](../../using/exporting_data.md).

## Notes

- **Persistence path.** The generic TS save engine (`src/core/section/record/save_component.ts`) writes the component's item array to the section's matrix row; saves are refused in `search`/`tm` modes. Time Machine rows are written after a successful save.
- **Sortable.** Lists can be ordered by a `component_number` column. `resolveSortable()` (`src/core/resolve/structure_context.ts`) defaults every model to sortable and only a specific set of descriptors opt out (`component_number`'s descriptor is not one of them), so a list can order by the numeric value in the matrix `number` column.
- **Default tools.** Toolbar tools are supplied as read-only `context` entries. Real instances commonly carry `tool_propagate_component_data` and `tool_time_machine` (see `samples/context.json`); no `tool_lang` (non-translatable).
- **Observers / observables.** No number-specific observer logic; configured in ontology `properties` like any other component, and driven entirely by the copied client (no TS-server observer dispatch exists).
- **Related components:** [component_input_text](component_input_text.md) (numeric-looking codes/identifiers), [component_date](component_date.md) (years and time), [component_select](component_select.md) / [component_radio_button](component_radio_button.md) (fixed numeric choices), [component_dataframe](component_dataframe.md) (uncertainty/qualifier framing of each value).