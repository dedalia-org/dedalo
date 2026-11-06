# component_json

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_propagate_component_data",
        "tool_time_machine",
        "tool_upload"
    ],
    "render_views" :[
        {
            "view"    : "default | line | print",
            "mode"    : "edit"
        },
        {
            "view"    : "default | mini | text | collapse",
            "mode"    : "list"
        },
        {
            "view"    : "default",
            "mode"    : "search"
        }
    ],
    "data": "array of items",
    "sample_data": [{
        "id": 2,
        "value": {
            "color"  : "#82b92c",
            "number" : 123,
            "object" : {"a":"b","c":"d"},
            "boolean": true
        }
    }],
    "value": "any JSON (object, array, string, number, boolean or null)",
    "sample_value": {
        "color"  : "#82b92c",
        "number" : 123,
        "object" : {"a":"b","c":"d"},
        "boolean": true
    }
}
```

## Definition

`component_json` is a literal-direct component that stores an **arbitrary, free-form JSON value** as a single monovalue. Unlike `component_input_text` (plain strings) or `component_number` (formatted numbers), it does not constrain the shape of its value: the payload can be a JSON object, array, string, number, boolean or `null`, nested to any depth.

Its reason to exist is to act as a flexible container for structured data that does not map cleanly onto the regular field-by-field ontology — configuration blobs, third-party API responses, machine-generated metadata, import staging payloads, or any record-attached document whose schema is not known in advance or is owned by an external system.

When to use it:

- Storing a configuration object or a settings document attached to a record (e.g. the JSON config of a viewer, a map layer definition, an export preset payload).
- Capturing the raw JSON returned by an external service (a geocoder response, an authority-record lookup, a IIIF manifest fragment) so the original document is preserved alongside the curated fields.
- Holding machine-produced metadata that has no fixed ontology model yet (analysis output, structured logs, an activity record — the `dd542` activity section uses this component and renders its key/value pairs in the `collapse` view).

When **not** to use it:

- For values that have a real semantic meaning in the model. A title, a date, a place or a person must be a typed component (`component_input_text`, `component_date`, `component_portal`, …) so they are searchable, translatable, diffusable and reusable as columns. `component_json` is opaque: its inner structure is not part of the ontology.
- For anything that needs per-language values. `component_json` is **language-neutral** (always `lg-nolan`); it cannot be translated.

!!! note "Single value only"
    Although the data is stored as an array of items, `component_json` is effectively **monovalue**: the edit, list and search views only build/read the first item (`entries[0]`). The edit view explicitly warns and ignores any extra items.

## Data model

**Data:** `array` of items. Each item is an object `{ "id": <int>, "value": <any JSON> }`. `value` carries the literal payload; there is no `lang` key because the component is non-translatable.

**Value:** any valid JSON — object, array, string, number, boolean or `null`.

**Storage:** the value is **language-neutral** and is persisted in the matrix `misc` column (the shared column used by direct-object literal components such as `component_security_access`, `component_info`, `component_filter_records`, `component_json`). It is **not** stored under a `lg-*` key like `component_input_text`; it is a flat array of items.

```json
[
    {
        "id": 2,
        "value": {
            "null"    : null,
            "time"    : 1575599819000,
            "color"   : "#82b92c",
            "number"  : 123,
            "object"  : { "a": "b", "c": "d" },
            "string"  : "Hello World",
            "boolean" : true,
            "object with numbers": [1, 2, 3]
        }
    }
]
```

The inner `value` can equally be a top-level array, a scalar or `null`:

```json
[{ "id": 1, "value": [1, 2, 3] }]
```

```json
[{ "id": 1, "value": "a plain string" }]
```

!!! info "Datum on the wire (API)"
    When served through the controller the data item is exposed as `entries`, mirroring the stored array. A typical `edit` payload:

    ```json
    {
        "section_id"          : 1,
        "section_tipo"        : "test3",
        "tipo"                : "test18",
        "mode"                : "edit",
        "lang"                : "lg-nolan",
        "from_component_tipo" : "test18",
        "entries": [
            { "id": 2, "value": { "color": "#82b92c", "number": 123 } }
        ]
    }
    ```

    The `context` of this component additionally carries a `features` block with `allowed_extensions` (`["json"]`) and `default_target_quality` (`null`), used by the upload tool.

## Ontology instantiation

`component_json` is defined as an ontology node, like any other component. The node declares the model, the parent section it belongs to and its lang descriptors:

```json
{
    "tipo"        : "test18",
    "model"       : "component_json",
    "parent"      : "test3",
    "lg-eng"      : "JSON data",
    "lg-spa"      : "Datos JSON"
}
```

A realistic `properties` block for this component (both keys are optional):

```json
{
    "list_show_key" : "msg",
    "sample_data"   : {
        "title"   : "",
        "config"  : { "enabled": true, "layers": [] }
    }
}
```

The node is wired into a section through its `parent`/`section_tipo`: the component's `tipo` is `test18`, its `section_tipo` is `test3` (the section that owns it), and the value is written into the section record's `misc` column. As a non-translatable component its `lang` is forced to `lg-nolan` on instantiation regardless of the requested lang (see [Notes](#notes)).

The TS server has no per-component factory to call: the descriptor at
`src/core/components/component_json/descriptor.ts` (`column: 'misc'`, no
`classSupportsTranslation` flag) is looked up by tipo through the shared
registry (`src/core/components/registry.ts`), and its data resolves through
`src/core/resolve/component_data.ts` like every other literal component. See
`src/core/components/component_json/samples/` for the verified wire shapes.

## Properties & options

`component_json` reads only two ontology properties; both are optional and both are client-side rendering hints (no server data effect).

### list_show_key

options: any string (a key name) — default `msg`

In `list` mode (and the `collapse`/`mini`/`text` list views), when the stored value is a JSON object and it contains the named key, the list cell shows that key's value instead of a truncated JSON dump. With the default `msg`, an object like `{"msg":"Imported OK","code":200}` renders as `Imported OK` in the list. When the key is absent (or the value is not an object) the list falls back to a 100-character `JSON.stringify` preview followed by ` ...`.

```json
{ "list_show_key": "title" }
```

### sample_data

options: any JSON value — default *(none)*

When present, the edit view (`default`/`line`/`print`) shows an extra **"Add sample data"** button in the toolbar. Clicking it loads this JSON into the editor (asking for confirmation if the current value is not empty), giving the editor a ready-to-fill template. Purely an authoring convenience; it is never auto-saved.

```json
{
    "sample_data": {
        "type"   : "FeatureCollection",
        "features": []
    }
}
```

!!! note "No literal-text style properties"
    `component_json` does **not** support `with_lang_versions`, `unique`, `mandatory` or `dato_default`-driven defaults in the way `component_input_text` does — it is language-neutral and free-form. If you need any other property, verify it in the ontology before relying on it.

## Render views & modes

The component implements the modes `edit`, `list`, `tm` (Time Machine, rendered with the list renderer) and `search`. Views per mode, as present in the source (`render_edit_*`, `render_list_*`, `render_search_*` and `css/component_json.less`):

| Mode | Views | Notes |
| --- | --- | --- |
| `edit` | `default`, `line`, `print` | `default` mounts a full **JSONEditor** (jsoneditor lib, lazy-loaded when scrolled into view) with a **Save** button in its own menu (dimmed while there is nothing to save, highlighted once the value changes; edits are also saved automatically when you leave the field, like any component — only content that parses as JSON is kept), plus toolbar buttons: tools, **Download** (export the value as a `.json` file), **Add sample data** (when `sample_data` is set) and **Full screen**. `line` reuses `default` without a label. `print` reuses `default` but forces read-only rendering (a `<pre>` block). With read-only permissions (`1`) the value is shown as a non-editable `<pre>`. |
| `list` | `default`, `mini`, `text`, `collapse` | `default` shows the `list_show_key` value or a truncated JSON preview and opens the editor in a modal on click. `mini` and `text` render the same short string (text as an inline `<span>`). `collapse` renders a collapsible cell; on the `dd542` activity section it expands the object into `key: value` lines. |
| `search` | `default` | A plain text input plus a `q_operator` input that feed the JSON-path search (see below). |

`tm` (Time Machine) read uses the list renderer; in TM the search/read targets the `data` column of `matrix_time_machine` rather than `misc`.

## Import / export model

`component_json` participates in the standard CSV import/export. Because **any JSON is a valid value**, a v7 envelope is ambiguous with a literal value of the same shape, so the import conform step disambiguates via the `dedalo_data` wrapper:

- **Default (un-wrapped) cell** — the entire decoded cell becomes the single monovalue. A JSON object/array is stored as-is inside `value`; a scalar string like `42`/`true` is decoded to its JSON type, and any non-JSON text is kept as a raw string.

    | section_id | test18 |
    | --- | --- |
    | 1 | `{"config":{"a":1}}` |
    | 2 | `[1,2,3]` |
    | 3 | `hello world` |

    Row 1 is saved as `[{"value":{"config":{"a":1}}}]`, row 3 as `[{"value":"hello world"}]`.

- **Wrapped cell** — to re-import data already in Dédalo v7 format (e.g. a raw export), wrap it so the import unwraps it once and treats it as the v7 envelope:

    ```json
    {"dedalo_data":[{"value":{"config":{"a":1}},"id":1}]}
    ```

    Wrapped items must be objects with a `value` property, otherwise the row is ignored with an error. A legacy single-`lg-` keyed object whose value is an array of `{value:…}` items is also recognised and unwrapped.

- **Empty cell** clears the existing component data (`result` is `null`).

The raw export (`dedalo_raw`) produces the `dedalo_data` wrapper automatically, so **export → import round-trips work without manual edits**. The edit-view **Download** button exports the current value as a plain `.json` file (not wrapped). This wrap/unwrap contract is ported model-agnostically in `src/core/tools/import_data.ts` (`unwrapDedaloData` + `conformImportData`; `component_json` is a `VALUE_PROPERTY_MODELS` member), so the shapes above are expected to import correctly through the TS server too.

See [Importing data → JSON](../importing_data.md#json) and [Exporting data](../exporting_data.md) for the full model.

## Notes

- **Language-neutral.** Its descriptor declares no `classSupportsTranslation`, so it is always instantiated with `lang = lg-nolan`; `translatable` is `false`. There is no per-language storage and no `tool_lang`.
- **Default tools.** Per the ontology, the component exposes `tool_propagate_component_data`, `tool_time_machine` and `tool_upload`. The upload tool accepts only files with the `.json` extension — the `allowed_extensions` feature of the component context (`["json"]`), validated on upload; the file content is then JSON-decoded, set as the value and saved, and the temp file is removed.
- **File upload naming.** Uploaded files are normalised to `section_tipo_tipo_section_id.json`.
- **Search.** `component_json` is searchable: its descriptor declares `searchBuilder: 'json'`, and `src/core/search/conform.ts` dispatches that family to `buildJsonFragment` (`src/core/search/builders/builder_json.ts`). Because the stored `value` is arbitrary JSON, matching operates on its TEXT projection (`elem->>'value'`) with the query held as a bound parameter, case- and accent-insensitive; the operator set covers empty / not-empty / exact / contains / not-contains and the wildcard shapes. Search saves are blocked like in any component (search/tm modes do not persist).
- **Persistence.** Like all components it never touches the DB directly; the write goes through the owning section record, which is the single writer to the `misc` column. Time Machine rows are written after save.
- **Regeneration.** Regeneration re-saves the value, decoding any stringified JSON back to native JSON; if a stored value fails to decode it aborts rather than silently dropping the invalid data, so an admin can inspect it.
- **Editor performance.** The JSONEditor module is preloaded on idle and instantiated only when the component enters the viewport; its CSS is injected once across all instances.

Related components:

- [component_input_text](component_input_text.md) — plain, translatable strings (use instead of JSON for human text).
- [component_number](component_number.md) — typed numeric values.
- [component_portal](component_portal.md) — relational links between sections (use instead of embedding ids in a JSON blob).
