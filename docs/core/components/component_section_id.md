# component_section_id

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [],
    "render_views" :[
        {
            "view"    : "default | line | print",
            "mode"    : "edit"
        },
        {
            "view"    : "default | text | mini",
            "mode"    : "list | tm"
        },
        {
            "view"    : "default",
            "mode"    : "search"
        }
    ],
    "data": "array of int (or [null])",
    "sample_data": [1],
    "value": "int, or null",
    "sample_value": 1
}
```

## Definition

`component_section_id` is a **read-only, virtual** literal component that exposes the
record's primary identifier — the section `section_id` — as if it were an ordinary
component value. It does **not** store, set or modify any data of its own: the
identifier it shows is the integer primary key already owned by the section row.

It exists because the `section_id` lives in a dedicated `section_id` integer column of
the matrix table (managed by the section itself), not inside the
JSONB `data` column where ordinary component values live. To let the rest of Dédalo
treat the record id uniformly — display it next to other fields, filter records by id,
sort by id, and export it as a spreadsheet column — the id is surfaced through this
component facade.

Use it when you need to:

- **Display the record id** for user reference in edit and list views (e.g. an
  accession number next to a museum object record, or a row id in a results listing).
- **Query records by id** in search mode, including ranges and id lists
  (e.g. "give me objects `100...200`" or "objects `1,5,8`").
- **Export the id as a column** in CSV / spreadsheet exports, alongside the
  descriptive data of each record.

Do **not** use it to hold editable data. Any value the user could type only matters in
search mode (to build the filter); in edit/list/tm it is a read-only mirror of the row
id. Writing through this component is an intentional no-op — an attempt to persist is
ignored and logged.

!!! note "Virtual component"
    Because the id is owned by the section row, `component_section_id` is never the
    "responsible" for saving in the section save path; it has no JSONB data column of
    its own.

## Data model

**Data:** `array` containing a single `int` (the section id), or `[null]` when the
instance has no `section_id` yet.

**Value:** `int`, or `null`.

**Storage:** The identifier is **not** stored in the JSONB `data` column. It lives in
the dedicated integer `section_id` column of the matrix table, written and managed by
the section itself. Because that structural column sits outside the JSONB column set
every other literal component resolves through, the TS section read
(`src/core/section/read.ts`) special-cases this model and short-circuits **before**
the generic literal path — which would otherwise look for a JSONB column this model
has none of:

```ts
// src/core/section/read.ts (emitDdoData, abridged)
if (model === 'component_section_id') {
    const entries = [row.section_id > 0 ? row.section_id : null];
    const item = buildDataItem(ddo.tipo, row.section_tipo, row.section_id, ddoMode, 'lg-nolan', entries);
    // ...
}
```

So the in-memory `data` produced by this component is the plain wrapper array:

```json
[1]
```

The component is **language-neutral**: it is instantiated as non-translatable and uses
`lg-nolan` (`DEDALO_DATA_NOLAN`). There is no per-language storage, no transliteration
and no `with_lang_versions` handling — the id is the same in every language.

The client datum carries the id inside `data.entries` (see the API data sample):

```json
{
    "section_id": 1,
    "section_tipo": "dd153",
    "tipo": "dd784",
    "mode": "edit",
    "lang": "lg-nolan",
    "from_component_tipo": "dd784",
    "entries": [
        1
    ],
    "row_section_id": 1,
    "parent_tipo": "dd153",
    "changed_data": []
}
```

## Ontology instantiation

Define the node like any other component, pointing `model` to `component_section_id`
and wiring `parent` / `section_tipo` to the owning section. It is non-translatable, so
`translatable` is `false` and the working lang is `lg-nolan`.

Node JSON (canonical "Id" component `dd784` of section `dd153`):

```json
{
    "tipo": "dd784",
    "model": "component_section_id",
    "label": "Id",
    "parent": "dd153",
    "parent_grouper": "dd154",
    "section_tipo": "dd153",
    "lang": "lg-nolan",
    "translatable": false,
    "properties": {},
    "css": {
        ".wrapper_component": {
            "grid-column": "span 1"
        }
    }
}
```

- **`parent` / `section_tipo`** bind the component to the section whose row id it
  exposes. There is usually exactly one `component_section_id` per section.
- **`properties`** is normally an empty object `{}` — this component reads no behavioral
  ontology properties (see below). `css` is the typical place to tune its compact
  one-column footprint.
- The `lg-*` translation rows of the node (`lg-eng`, `lg-spa`, …) only translate the
  **label**; they do not affect the value, which is language-neutral.

## Properties & options

`component_section_id` consumes **no behavioral ontology properties of its own**. In
practice the `properties` block is empty (`{}`). Its column target and ordering behavior
are driven by the instance `tipo` and the shared component machinery, not by named
properties:

| Property | Accepted values | Default | Effect |
| --- | --- | --- | --- |
| *(none specific to this component)* | — | `{}` | No behavioral properties are read for this model. |

Generic component facilities still apply via the shared context layer:

- **`css`** — styling of the wrapper (the model commonly spans a single grid column).
- **`request_config`** — generic; typically `null` for this component.

!!! note "Column resolution is not a property"
    Whether the instance maps to the `section_id` column or the Time Machine `id`
    column is decided by the instance `tipo` (`dd1573` → `id`), handled inside the
    order-path builder (`buildOrderPath()`, `src/core/search/order_path.ts`) — it is not a
    configurable ontology property. If you need to confirm a specific deployment's node
    configuration, verify in the ontology.

## Render views & modes

The component declares the modes `edit`, `list`, `tm` and `search`. In the client the
`tm` mode reuses the `list` render path.

| Mode | Views | Notes |
| --- | --- | --- |
| `edit` | `default`, `line`, `print` | Read-only display of the id inside a `content_value section_id` node. `line` drops the label node; `print` forces `permissions = 1` (read-only element render) and reuses the default view. The badge **is selectable**: clicking it activates the component so the inspector shows its info, data and history, but it never takes an editable field's active look — selection is an orange ring around the badge's own surface (`layout.less` and every `core/page/css/active_styles/` sheet exclude it), and it never takes a component lock. |
| `list` / `tm` | `default`, `text`, `mini` | `default` renders the standard wrapper; `text` renders a compact `<span>` value (used by autocomplete / datalist contexts); `mini` renders the minimalist wrapper. `tm` reads the historical id via the Time Machine path. |
| `search` | `default` | The **only** mode where the component is interactive: it renders a numeric text input that builds the search filter (see below). Pasting a multi-line list of ids is normalized to a comma-separated sequence; input is constrained to `0-9 . , > < =`. |

CSS for these states lives in `css/component_section_id.less` (`.edit`, `.search`,
`.view_line`). Other views fall back to `default`.

## Import / export model

**Import:** `component_section_id` is **not importable** — it is read-only and has no
import handling of its own. The id is assigned by the section on record creation,
never set from import data. (Note: in [import](../importing_data.md) flows, a column of
section ids can still be *used* to target existing records; the component itself does
not ingest a value.)

**Export:** the id is exported as a plain integer cell rather than a JSON array —
**one integer atom per data item** (normally a single item), carrying
`cell_type: 'section_id'`, so the exported cell is `1`, not `[1]`. The export path
runs through the generic cell resolver `resolveCellValue()`
(`src/core/resolve/relation_list.ts`, which already has an explicit
`model === 'component_section_id'` branch reading the record's own id — see
[Data model](#data-model)) via `tools/tool_export/server/tool_export.ts`; whether the
exact `cell_type: 'section_id'` plain-int contract is reproduced end-to-end has not
been independently verified for this pass.

See the full export and import definitions in
[exporting data](../exporting_data.md) and [importing data](../importing_data.md).

### Search operators

Server-side the filter is turned into SQL by `src/core/search/builders/builder_section_id.ts` (dispatched from `src/core/search/conform.ts`); it resolves the query against the integer `section_id` column (cast to `integer`), supporting these operators:

| Input | Operator | Meaning | SQL shape |
| --- | --- | --- | --- |
| `123` | equal (default) | id is 123 | `col::integer = _Q1_::integer` |
| `100...200` | `...` between | id in range | `col::integer >= a::integer AND col::integer <= b::integer` |
| `1,2,3` | `,` sequence | id in list | `col::integer = ANY(_Q1_::integer[])` |
| `!=123` | `!=` different | id is not 123 | `col::integer != _Q1_::integer` |
| `>=50` | `>=` | id ≥ 50 | `col::integer >= _Q1_::integer` |
| `<=50` | `<=` | id ≤ 50 | `col::integer <= _Q1_::integer` |
| `>50` | `>` | id > 50 | `col::integer > _Q1_::integer` |
| `<50` | `<` | id < 50 | `col::integer < _Q1_::integer` |

Non-numeric characters are stripped before binding. A locator passed as `q` is reduced
to its `value` (or `section_id`) before resolution.

!!! warning "Both sides of the comparison carry the cast"
    The bound value is cast as well as the column, and that is load-bearing
    rather than cosmetic. Search placeholders are **deduplicated by value**, so
    searching a text field for `5555` and the record id for `5555` collapses
    both onto one placeholder. Bound as text for the text field and left
    uncast here, the same placeholder would be asked to be an integer too, and
    the whole query would fail with `operator does not exist: integer = text` —
    an error, not an empty result. Searching either field alone worked, so the
    fault only appeared when both carried the same number (fixed 2026-08-06;
    gated by `test/unit/search_section_id_bind_native.test.ts`, which executes
    the SQL, because building it is not enough to catch a type error only the
    database raises).

## Notes

- **Read-only by design.** A write through this component succeeds without storing
  anything, and a save logs an ignored-save notice. There is no Time Machine
  write for this component; in `tm` mode it only *reads* the historical id.
- **No tools.** The model exposes no tools, so `default_tools` is empty
  and no tool sections are loaded for this component (it has no editable data to act on).
- **Ordering.** A list column on this component sorts on the real integer `section_id`
  matrix column rather than on a JSONB path: `buildOrderPath()`
  (`src/core/search/order_path.ts`) special-cases `component_section_id`, forcing the
  resolved order step's `column` to `section_id`. `resolveSortable()`
  (`src/core/resolve/structure_context.ts`) returns `true` for this component by
  default — its descriptor declares no `sortable: false` override — so "order by id"
  is sortable like any other component, subject only to the one per-tipo exception
  (the notes-text tipo `rsc329`, always non-sortable).
- **No observers/observables.** This component does not participate in the
  observer/observable mechanism — it produces no data changes to broadcast.
- **Client validation.** The client model strips everything but digits from typed input,
  and hilites the search wrapper when the field carries a value.

### Related components

- [component_input_text](component_input_text.md) — the canonical editable literal-direct
  text component.
- [component_number](component_number.md) — editable numeric literal component (compare
  its numeric search operators).
- [component_portal](component_portal.md) — related component that links records via
  locators (contrast with this component's direct integer id).
