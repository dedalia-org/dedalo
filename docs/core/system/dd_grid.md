# dd_grid

> See also: [Exporting data](../../using/exporting_data.md) · [Components](../components/index.md) · [Sections](../sections/index.md) · [Locator](../locator.md)

The subsystem that resolves a record's component data into **flat, tabular
shapes** — both the visual grid cell (`dd_grid_cell_object`) and the per-component
**flat export value** contract — plus the client renderers under
`client/dedalo/core/dd_grid/js/`.

!!! note "`dd_grid` is a concept, not a directory"
    There is no `src/core/dd_grid/`. The subsystem is realized functionally: the
    flat-value resolution lives in `resolveCellValue`
    (`src/core/resolve/relation_list.ts`), the export tabulator in
    `tools/tool_export/server/tool_export.ts`, the visual cell as a **wire shape**
    produced by `ddGridCell()`
    (`src/core/components/component_info/widgets/grid.ts`), and the thesaurus
    indexation grid in `src/core/section/indexation_grid.ts`.

## Role

`dd_grid` turns the abstract, nested `{context, data}` model of a section's
components (see [Architecture overview](../architecture_overview.md)) into
**rows-and-columns of resolved values** that downstream consumers can render or
stream.

It sits between the component layer (which owns each value) and three consumers:

| consumer | what it asks for | TS module |
| --- | --- | --- |
| **tool_export** | the flat NDJSON export table (meta + columns + one row of resolved values per record) | `tools/tool_export/server/tool_export.ts` (protocol) + `resolveCellValue` / `resolvePathValue` (values). See [Exporting data](../../using/exporting_data.md). |
| **thesaurus indexation grid** | a term's backlink grid | `src/core/section/indexation_grid.ts` (the drive) + `src/core/section/list_definitions/indexation_list.ts` (the config). |
| **client grid widgets** | `dd_grid_cell_object` cells (time-machine matrix, descriptors widget, indexation view) | the wire cells emitted by `ddGridCell()` (`src/core/components/component_info/widgets/grid.ts`), rendered by the `client/dedalo/core/dd_grid/js/` views. |

There is no per-component class: the resolvers are horizontal engines that resolve
any component from its ontology descriptor, with zero per-model knowledge in the
tabulator.

## Responsibilities

- **Resolve flat component values** — `resolveCellValue()` produces one
  component's flat display string on one record (the TS `get_value` facade);
  `resolvePathValue()` walks relation hops to a leaf for multi-hop export paths.
- **Own the flat-join reference semantics** — the multi-item join rule (records
  separator ` | ` at the first indexed level, fields separator `, ` deeper),
  carried by the `itemSeparator` parameter threaded through `resolveCellValue`.
- **Define the flat export table** — `toolExportGetExportGrid()` emits the
  tabulator protocol (`meta` / `col` / `row` lines; the `grid_value` per-locator
  atoms with resolved-target column keys) consumed by the export tool.
- **Emit the visual grid cell** — `ddGridCell()` builds the `dd_grid_cell_object`
  wire shape (every property serialized, nulls included, in a fixed order) for the
  `component_info` read-time widgets (descriptors, media_icons, …).
- **Render the grids on the client** — the copied `dd_grid` JS model + views turn
  `dd_grid_cell_object` arrays into DOM tables/lists.

The value resolvers do **not** issue their own SQL beyond reading the matrix
record; the tabulator (in `tool_export`) and the client views consume the
resolved shapes with zero per-model knowledge.

## Files & structure

```text
src/core/resolve/
└── relation_list.ts       # resolveCellValue() (the flat value) + buildRelationList() + the ' | ' / ', ' join rule
src/core/components/component_info/widgets/
└── grid.ts                # ddGridCell() — the dd_grid_cell_object wire serializer
src/core/section/
├── indexation_grid.ts     # buildIndexationGrid() — the live indexation grid drive
└── list_definitions/
    └── indexation_list.ts # getIndexationListConfig() — the indexation grid CONFIG (head/row ddo_maps)

tools/tool_export/
├── server/tool_export.ts  # toolExportGetExportGrid() — the flat NDJSON export table (tabulator protocol)
└── js/flat_table.js       # the export tool's OWN flat-table renderer (NOT the dd_grid JS model)

client/dedalo/core/dd_grid/   # the client model + views (vanilla JS + LESS)
├── css/  (dd_grid.less, view_indexation*.less)
└── js/
    ├── dd_grid.js                  # client model; init/build/render
    ├── render_list_dd_grid.js      # view dispatcher (table | mini | indexation | descriptors | default)
    ├── view_default_dd_grid.js
    ├── view_table_dd_grid.js       # time-machine / generic matrix table
    ├── view_mini_dd_grid.js
    ├── view_indexation_dd_grid.js  # thesaurus indexation grid view
    └── view_descriptors_dd_grid.js # oral-history descriptors widget view
```

## Key concepts: the flat-value contract

The resolvers return **flat strings** — for the `value` export format and for cell
display — and **protocol rows**, for the tabulator. Everything a consumer needs
(column identity, breakdown explosion, joining) is derived by the tabulator from
the walked path, not from a per-value object.

### resolveCellValue — the flat-string facade

`resolveCellValue(sectionTipo, sectionId, componentTipo, lang, unresolved,
itemSeparator?)` (`src/core/resolve/relation_list.ts`) reads the matrix record
and returns the component's flat display string on that record:

- string-family components join their multi-values with `itemSeparator`, skipping
  empty ones;
- `component_section_id` returns the record's own id as a string;
- relation cells recurse into the component's own list-config children, joined by
  the export-atoms separator rule: **` | `** (records separator) at the first
  indexed level, **`, `** (fields separator) at deeper levels.

`unresolved` is an out-parameter collecting cell models the resolver could not
handle (so the caller can flag gaps rather than silently drop).

### The export tabulator protocol

`toolExportGetExportGrid()` (`tools/tool_export/server/tool_export.ts`) is the
flat-table producer. It emits three line kinds, serialized directly to NDJSON:

- `meta` — `{t:'meta', v:1, data_format, breakdown, section_tipo, total, …}`
- `col`  — `{t:'col', i, key:'<st>_<ct>', group, label, cell_type, model, path}`
- `row`  — `{t:'row', rec:'<section_id>', sub, c:{<i>:'<flat value>'}}`

`data_format 'value'` lays one flat row per record. `data_format 'grid_value'`
explodes relation entries into per-locator **atoms** whose column key carries the
**resolved target identity** (e.g. `numisdata6_numisdata20.terr1_hierarchy25`) —
column identity is a key string, not an object. `data_format 'dedalo_raw'` ships
the raw stored value per cell as a `dedalo_data`-wrapped JSON string. Columns
register first-seen across records, so the ordinal is the registration order. All
three formats, the three breakdown modes and NDJSON streaming are gated.

## Data model: dd_grid_cell_object (the wire shape)

`dd_grid_cell_object` is the **visual cell the client renders** — a plain object
literal. `ddGridCell(overrides)`
(`src/core/components/component_info/widgets/grid.ts`) builds it, serializing
**every** property (nulls included) in a fixed order, because the client views
depend on that exact shape. Its load-bearing fields:

| property | meaning |
| --- | --- |
| `type` | `'row'` or `'column'` |
| `label` / `render_label` | column header text and whether to draw it |
| `cell_type` | `av` \| `img` \| `iri` \| `button` \| `json` \| `section_id` \| `text` |
| `value` | array of cell values (strings, or nested cells) |
| `fallback_value` | values from another language when the current lang is empty |
| `fields_separator` / `records_separator` | join glue |
| `ar_columns_obj` | nested column objects (the `{section_tipo}_{tipo}` id) |
| `row_count` / `column_count` / `column_labels` | portal sub-table geometry |
| `action` | button/link action config for interactive cells |
| `class_list` / `id` | CSS + identity |

The wire cell is produced only for the **`component_info` read-time widgets** —
the oral-history descriptors grid, `media_icons`, and the other info widgets, all
under `src/core/components/component_info/widgets/`. Production value resolution
runs on `resolveCellValue()` (flat string) and the tabulator (export), so the
visual-cell object is built only where a widget actually ships one to the client.

## How components feed the grids

There is no per-component method to override. Instead:

- **Flat display value** — `resolveCellValue()` resolves any component from the
  ontology (`getModelByTipo` → column → matrix read), so string, number, iri,
  date, section_id and relation families all flow through the one function.
- **Relation recursion** — a relation cell in `resolveCellValue()` reads the
  component's own list-config children, resolves each child at the traversed
  locator's target, and joins them with the ` | ` / `, ` separator rule. The
  traversed locator position becomes the index the tabulator uses to decide
  row-vs-column explosion.
- **Raw wire value** — the `dedalo_raw` export format ships the stored value
  wrapped as `{"dedalo_data": <value>}`; a frame-carrying main includes its
  dataframe.

```mermaid
flowchart TD
    REC["matrix record (JSONB)"] --> RC["resolveCellValue(...)"]
    RC -->|flat string| GV["get_value: '…'"]
    RC -->|relation recurse ' | ' / ', '| RC
    GV -.consumed by.-> TAB["toolExportGetExportGrid (NDJSON)"]
    REC --> IW["ddGridCell(...) (info_widgets)"]
    IW -->|dd_grid_cell_object wire| JS["copied dd_grid JS views"]
```

## The indexation grid

The thesaurus "show indexations" grid answers: *which records tag this term?* It
splits into a config resolver and a live drive.

- **Config** — `getIndexationListConfig(sectionTipo)`
  (`src/core/section/list_definitions/indexation_list.ts`) finds the section's
  `indexation_list` node and reads its `head` / `row` `show.ddo_map`s plus
  `class_list` / `render_label`. Note it reads the node's **properties**, not its
  `relations`.
- **Drive** — `buildIndexationGrid(...)` (`src/core/section/indexation_grid.ts`)
  resolves the term's backlink locators through the `relation_index` inverse
  engine, groups them by section, and renders one row per indexing record. It is
  served by the `get_indexation_grid` action on `dd_core_api`, which requires read
  permission on the term's section.

## Client side

`client/dedalo/core/dd_grid/js/` holds the client model and its views.
`dd_grid.js` adds `init` / `build` / `list` on top of the shared client prototype
(`render` / `refresh` / `destroy`) and is instantiated through the standard client
factory `get_instance({ model: 'dd_grid', … })`. `render_list_dd_grid.js`
dispatches on `self.view`:

| view | renderer | used by |
| --- | --- | --- |
| `table` | `view_table_dd_grid` | time-machine matrix / generic table |
| `mini` | `view_mini_dd_grid` | compact cell |
| `indexation` | `view_indexation_dd_grid` | thesaurus term indexation grid |
| `descriptors` | `view_descriptors_dd_grid` | oral-history descriptors widget |
| `default` | `view_default_dd_grid` | fallback |

Client callers that instantiate the model include `ts_object.js` (the thesaurus
tree indexation toggle), `service_time_machine.js`, the OH descriptors widget,
`inspector` and `section_record`. Because the client is unmodified, these views
consume exactly the `dd_grid_cell_object` wire shape `ddGridCell()` emits.

!!! note "tool_export does NOT use the dd_grid JS model"
    The export tool renders its own flat table in
    `tools/tool_export/js/flat_table.js` from the NDJSON stream — it does not go
    through `client/dedalo/core/dd_grid/js/`. The export pipeline reuses only the
    **server** flat-value resolvers + the tabulator protocol. See
    [Exporting data](../../using/exporting_data.md).

## How it fits with the rest of Dédalo

- [Components](../components/index.md) — each component's flat value is resolved
  from its ontology descriptor by `resolveCellValue()`; there is no per-component
  grid method to override.
- [Exporting data](../../using/exporting_data.md) — `tool_export` is the primary consumer
  of the flat-value contract; `toolExportGetExportGrid()` lays the values onto the
  NDJSON tabulator table.
- [Sections](../sections/index.md) — grids resolve the components of a section
  record; values are read through the matrix record, never a per-component class.
- [Locator](../locator.md) — relation components traverse locators; the traversed
  position drives the tabulator's row/column explosion.
- The **thesaurus tree** (`ts_object`, `area_thesaurus`) is the intended consumer
  of the indexation grid + the `indexation` client view (config ported, live drive
  ledgered).

## Examples

### Resolve a component's flat value

```ts
import { resolveCellValue } from '../resolve/relation_list.ts';

const unresolved: string[] = [];
const value = await resolveCellValue(
    'rsc197',          // section_tipo (People)
    1,                 // section_id
    'rsc85',           // component tipo
    'lg-spa',          // lang
    unresolved,        // out: models the resolver could not handle
);                     // e.g. "Alicia"
```

### Build the flat export grid (tool_export)

```ts
// tool_request action 'get_export_grid' → toolExportGetExportGrid(context)
// options: { section_tipo, data_format:'value'|'grid_value'|'dedalo_raw', breakdown }
// returns the tabulator protocol: meta line + col lines + row lines
// (or a raw NDJSON string body the server streams as application/x-ndjson).
```

### Resolve a section's indexation grid config

```ts
import { getIndexationListConfig } from '../section/list_definitions/indexation_list.ts';

const config = await getIndexationListConfig('oh1'); // IndexationListConfig | null
// config.headDdoMap / config.rowDdoMap / config.rowClassList / config.renderLabel
// NOTE: this resolves the grid CONFIG only; the live per-locator grid drive is a gap.
```

## Related

- [Exporting data](../../using/exporting_data.md) — the export pipeline and the
  `value` / `grid_value` / `dedalo_raw` formats.
- [Components](../components/index.md) — the field abstraction whose values are
  flattened; [base classes](../components/base_classes.md).
- [Sections](../sections/index.md) — where the resolved data lives.
- [Locator](../locator.md) — the relational pointers traversed during recursion.
- [Architecture overview](../architecture_overview.md) — the `{context, data}`
  model these grids flatten.
