# widgets

> The `core/widgets/` subsystem — small, reusable server+client pieces that
> **compute** (rather than store) their data from other components of a record,
> and are hosted inside a [`component_info`](../components/component_info.md)
> field.

> See also: [component_info](../components/component_info.md) (the host) ·
> [Add a widget](../../development/extending/add_a_widget.md) (the how-to) ·
> [component_info cookbook](../components/component_info_cookbook.md) (recipes) ·
> [Components](../components/index.md) · [Architecture overview](../architecture_overview.md)

This is the **subsystem reference** for the widgets under
`client/dedalo/core/widgets/` (client) and, on the server, the framework under
`src/core/components/component_info/widgets/`. Each widget is a **descriptor**:
one module exporting one `InfoWidgetDescriptor`, dispatched **by name**
through `registry.ts` — never by loading a path named in the ontology. For
the *info* component that hosts these widgets read
[component_info](../components/component_info.md) first.

!!! warning "Two unrelated things are called 'widget' in Dédalo"
    There are **two** separate widget systems and they do **not** share code:

    1. **`core/widgets/`** *(this document)* — record-level data widgets hosted
       by `component_info`, driven by an **IPO** (Import–Process–Output) config
       from the ontology, summarizing/collecting data from a record's components.
    2. **`core/area_maintenance/widgets/`** — the self-contained admin panels of
       the Maintenance area (`make_backup`, `update_ontology`, `media_control`,
       …). They are built by `area_maintenance` and dispatched through
       `dd_area_maintenance_api`; they are **not** IPO widgets and share no code
       with system 1. See [area_maintenance](../areas/area_maintenance.md) and
       the *dedalo-area-maintenance* skill.

    This page is about system **1**.

## Role

A **widget** — one `InfoWidgetDescriptor` module under
`src/core/components/component_info/widgets/<tld>/<name>.ts` — is a reusable
unit of *derived* data. Unlike a normal component it owns no database column: it
reads the values of one or more existing components, optionally runs them
through a process function, and returns a flat array of
`{widget, key, id, widget_id, value}` items for the client to render.

Widgets never appear on their own in a section. They are always **hosted** by a
[`component_info`](../components/component_info.md) field that lists them in its
ontology `properties.widgets` and aggregates every widget's output into its own
value. The live compute is a **fallback**: the section read serves the
component's **stored** misc value when the client save cycle already
persisted one, and only computes live when the row is empty. The one other
server entry point is the
[`dd_component_info` `get_widget_data`](#async-widgets-the-dd_component_info-api)
API action, the delivery path for **async** widgets.

```mermaid
flowchart TB
    ONT["ontology node (component_info)<br/>properties.widgets = [ {widget_name, path, ipo}, … ]"]
    ONT --> CI["section read → component_info emit hook"]
    CI -->|"always live (a stored misc value is ignored + counted)"| REG["computeInfoWidgets(componentTipo, context)<br/>widgets/registry.ts"]
    REG -->|"INFO_WIDGETS.get(widget_name)"| W["descriptor.computeData(ipo, context)<br/>widgets/&lt;tld&gt;/&lt;name&gt;.ts"]
    W -->|"reads via readWidgetComponentData"| COMP["other components of the record"]
    W -->|"[{widget, key, widget_id, id, value}]"| REG
    REG --> DDO["component_info datum {context, data.entries}"]
    DDO --> CL["client: component_info.js → per-widget render_&lt;name&gt;.js"]
```

## Framework architecture (TS server)

The framework home is `src/core/components/component_info/widgets/`:

| file | role |
|---|---|
| `widget_common.ts` | The `InfoWidgetDescriptor` contract, `WidgetContext`, the shared IPO helpers (`readWidgetComponentData`, `resolveCurrent`, `findTyped`, a half-up rounding helper), `normalizeWidgetEntryKeys` (WC-026), and the two loud errors. |
| `registry.ts` | The **one dispatch home**: the `INFO_WIDGETS` map, `getInfoWidget` (fail-loud lookup), `computeInfoWidgets` (read aggregate), `computeInfoDataList` (edit datalist). |
| `calculation/functions.ts` | The STATIC calculation process-fn registry (`CALCULATION_FUNCTIONS`) — a closed set, never resolved by name from ontology-supplied strings. |
| `grid.ts` | dd_grid_cell_object builders (`buildPortalGridValue`, `resolveGridColumns`). |
| `<tld>/<name>.ts` | One widget = one module exporting one `InfoWidgetDescriptor`. |

### The descriptor contract

Each widget module exports one `InfoWidgetDescriptor` (`widget_common.ts`):

```ts
export type InfoWidgetDescriptor =
  | {
      name: string;                 // = ontology widget_name = client JS export
      path: string;                 // = ontology path; tripwire-bound to the client module
      isAsync?: true;               // skipped by the read aggregate; delivered via the API instead
      computeData(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]>;
      computeDataParsed?(ipo, context): Promise<WidgetItem[]>;  // grid/export facet
      computeDataList?(ipo, context): Promise<WidgetItem[]>;    // edit-mode datalist facet
    }
  | { name: string; path: string; isAsync?: true; unported: { reason: string } };
```

- **`name`** is the registry key and must equal the ontology `widget_name` and
  the client JS class/file name.
- **`path`** mirrors the ontology `path` and locates the CLIENT module
  (`client/dedalo/core/widgets<path>/js/<name>.js`). The registry tripwire binds
  it; **dispatch never uses it**.
- **`computeData`** is the plain read path; the optional `computeDataParsed` /
  `computeDataList` facets and `isAsync` are declared only when a widget needs
  them.
- An **`unported`** stub throws `WidgetUnportedError` from its compute — never
  a silent `[]`.

### `WidgetContext` and the input helpers

`computeData(ipo, context)` receives the IPO array and a `WidgetContext`:

| field | meaning |
|---|---|
| `sectionTipo` / `sectionId` | the host record the widget reads from |
| `mode` | `edit` / `list` / `search` / `tm` |
| `lang` | the request-scoped data language (`currentDataLang()`, not a static constant) |
| `userId` / `isAdmin` | the request principal, for user-scoped tool availability (`media_icons`); absent → the superuser tool set |

Every widget reads its inputs through `readWidgetComponentData(sectionTipo,
sectionId, componentTipo)` — the full stored item array, **no** lang
filtering. It never touches the matrix directly. It answers `[]` — never an
error — when the record cannot exist: an unknown section, or a section whose
declared `matrix_table` is not a readable record store (`dd15` Time Machine
maps to `matrix_time_machine`, flat columns, off the matrix identifier
allowlist). That mirrors the no-record branch of the section read.
`resolveCurrent(declared, own)` maps the `'current'`/undefined
sentinels to this record's values; `findTyped(input, type)` scans an array-shape
input for the last entry of a `type`; the shared rounding helper applies
half-up rounding to a fixed number of decimals.

### The registry — the one dispatch home

`computeInfoWidgets(componentTipo, context)` (`registry.ts`) reads the node's
`properties.widgets` and, for each declared widget, looks its `widget_name` up
in `INFO_WIDGETS`, skips async ones (`isAsync`, delivered via the API), and
concatenates every widget's `computeData` output. Returns `null` when the
component declares no widgets. An unknown `widget_name` throws
`WidgetNotRegisteredError`.

The registry is the **single** dispatch home: the tripwire
(`test/unit/info_widget_registry_tripwire.test.ts`) fails if any other `src/`
file builds an `INFO_WIDGETS` map, resurrects a `widget_name` switch, or defines
an `ASYNC_WIDGETS` set.

## IPO — Input · Process · Output

The widget's behaviour is data, not code: the `ipo` array read from the
ontology. Each entry has up to three parts:

- **`input`** — *what data to read.* Two real shapes:
    - **object** with `type` + `source` (+ `paths`): `source` names origin
      components with `current`/`self` sentinels; `paths` are per-leaf walks
      (`{var_name, section_tipo, component_tipo}`). Used by `media_icons`,
      `descriptors`, `state`, and (as a flat `{section_id, components}` object)
      `calculation`.
    - **array** of typed entries scanned by `type`: e.g. `{type:'source'}`,
      `{type:'used'}`, `{type:'date_in'}`, `{type:'period'}`,
      `{type:'data_diamenter'}`. Used by `get_archive_weights`,
      `get_coins_by_period`, `sum_dates`, `get_archive_states`.
- **`process`** — *how to transform it (optional).* Only `calculation` uses it,
  and only through the STATIC fn registry (see [SEC-052](#security-sec-052)).
- **`output`** — *what to emit.* An array of `{id, …}` maps; each `id` becomes
  one item in the returned array, and the grid/export paths use the output `id`
  as the column id.

Common `input` field names seen across widgets: `source`, `paths`, `var_name`,
`section_tipo`, `section_id`, `component_tipo`, `type`, `used`, `duplicated`,
`data_weights`, `data_diamenter` *(sic — persistent ontology typo, a wire
contract)*, `date_in`, `date_out`, `period`, `target_sections`,
`target_model_section_id`, `use_parent`, `answer`, `closed`. Common `output`
fields: `id`, `label`, `value` (a type hint like `int` / `float` / `text` /
`link`), plus `process_section_tipo` (media_icons tool columns).

!!! note "`id` vs `widget_id`"
    The item key that names the output differs by widget: `calculation` emits
    `id`, most others emit `widget_id`, `test_info` emits both. The **client**
    render matches on `widget_id`; the **grid/export** builders match on `id`.
    The emit hook dualises every top-level string key
    (`normalizeWidgetEntryKeys`) so both resolve — see
    [component_info → the widget outputs](../components/component_info.md#dataentries--the-widget-outputs-wc-026).

## The widgets that exist

All **11** widgets are ported. See the
[full census table with facets](../components/component_info.md#the-widget-census)
on the host page. In brief:

| widget | TLD | facet |
|---|---|---|
| `calculation` | — | static process fns; emits `id` |
| `state` | — | `computeDataList` (edit datalist); `total` items carry `items`, [the divisor](../components/component_info.md#state--detail-total-and-the-items-divisor) |
| `user_activity` | `dd` | `isAsync` |
| `get_archive_states` | `dmm` | shape-gated |
| `sum_dates` | `mdcat` | `computeDataParsed` |
| `get_archive_weights` | `numisdata` | — |
| `get_coins_by_period` | `numisdata` | — |
| `descriptors` | `oh` | edit-only; dd_grid term grid |
| `media_icons` | `oh` | row objects; user-scoped tools |
| `tags` | `oh` | leads with raw text items |
| `test_info` | `test` | reference stub; emits both keys |

## Files & structure

The client directory is organised by **TLD / domain** sub-folders, mirroring
the ontology. Each widget keeps the familiar component file layout:
`js/<name>.js` + `js/render_<name>.js`, and `css/<name>.less`; some ship
per-mode render variants (`render_edit_state.js` / `render_list_state.js`).

```text
client/dedalo/core/widgets/
├── widget_common/js/widget_common.js       # JS base (init/build/render/destroy)
├── calculation/ · state/                    # no TLD folder
├── dd/user_activity/ · dmm/get_archive_states/
├── mdcat/sum_dates/ · numisdata/{get_archive_weights,get_coins_by_period}/
├── oh/{descriptors,media_icons,tags}/
└── test/test_info/                          # reference/sample widget

src/core/components/component_info/widgets/  # server (TS/Bun)
├── widget_common.ts · registry.ts · grid.ts · README.md
├── calculation/{calculation.ts,functions.ts} · state/state.ts
├── dd/user_activity.ts · dmm/get_archive_states.ts · mdcat/sum_dates.ts
├── numisdata/{get_archive_weights.ts,get_coins_by_period.ts}
├── oh/{descriptors.ts,media_icons.ts,tags.ts} · test/test_info.ts
```

The client import is relative to the widget's own module:
`../../../core/widgets<path>/js/<widget_name>.js`.

## Client (JS) instantiation

`widget_common.js` is an ES6 module exporting a `widget_common` constructor that
lends `init` / `build` / `render` / `destroy` prototypes. A concrete widget JS
(e.g. `calculation.js`) imports it and assigns those plus its own
`render_<name>.js` view methods:

```js
import {widget_common}      from '../../widget_common/js/widget_common.js'
import {render_calculation} from '../js/render_calculation.js'

calculation.prototype.init    = widget_common.prototype.init
calculation.prototype.build   = widget_common.prototype.build
calculation.prototype.render  = widget_common.prototype.render
calculation.prototype.destroy = widget_common.prototype.destroy
calculation.prototype.edit    = render_calculation.prototype.edit
calculation.prototype.list    = render_calculation.prototype.list
```

`component_info.js::get_widgets()` dynamically imports each widget's JS by its
`path` (`import('../../../core/widgets' + path + '/js/' + widget_name + '.js')`),
instances it, and feeds it the server-built value slice
(`value.filter(item => item.widget === widget_name)`).

## Async widgets: the dd_component_info API

A widget whose descriptor sets `isAsync: true` is **skipped** by the
read-time aggregate (`computeInfoWidgets`); its client JS fetches the data
itself through the `dd_component_info` API. The single allowed action is
`get_widget_data` (`src/core/api/handlers/dd_component_info.ts`,
`API_ACTIONS = ['get_widget_data']`):

```json
{
  "action" : "get_widget_data",
  "dd_api" : "dd_component_info",
  "source" : { "tipo": "dd1633", "section_tipo": "dd64", "section_id": 42, "mode": "edit" },
  "options": { "widget_name": "user_activity" }
}
```

The handler AUTHZ-01-gates the record, finds the matching `properties.widgets`
entry by `widget_name`, runs `widgetComputeData(descriptor)(ipo, context)` (this
channel computes async widgets — it is their only delivery), and returns the
item array in `result`. A failure still returns HTTP 200 with
`{result: false, msg: [...], errors: [...]}`; success returns
`{result: widgetData, msg: 'OK. Request done successfully', errors: []}`.
Full request/response shapes:
[component_info → get_widget_data](../components/component_info.md#the-get_widget_data-api-action).
`user_activity` is the only ontology-declared async widget; its data comes from
the pre-aggregated user-stats pipeline (`src/core/area_maintenance/user_stats.ts`).

!!! note "It reports the user's WHOLE history"
    The span is read from the data, not from a fixed window: `savedStatsDayBounds()`
    gives the first and last day the user has a saved `dd1521` stats row for, that
    range is folded, and the raw activity log is aggregated only for the tail after
    the last saved day (today included — today is never saved). A user with **no**
    saved rows is the one bounded case: their raw log is aggregated over the last
    365 days and a warning naming the user is logged, because an unbounded live
    aggregation over a multi-million-row actor is the statement timeout this
    pipeline exists to avoid. Run the user-stats catch-up to give such a user a
    real history.

!!! warning "A day aggregated twice is counted once"
    A `dd1521` row IS that day's totals, and the stats writer only ever appends
    (it resumes from its newest row), so re-aggregating a user whose old rows
    were never deleted leaves duplicate days behind. The range read keeps one row
    per day — the highest `id`, i.e. the most recent run — because summing two
    runs of the same day reports more activity than the log holds. Days the
    catch-up never covered are still missing from the totals: the live tail read
    starts after the last saved day, it does not fill holes in the middle.

## Security: no dynamic code loading

The `calculation` widget's `process` step is attacker-relevant because the
ontology (which names the process function) is admin/developer-writable. A
design that loaded a file or resolved a function by name from that
ontology-supplied string would be a code-injection vector.

!!! note "Every process function is a static, closed registry entry"
    `computeCalculation` (`widgets/calculation/calculation.ts`) never loads a
    file or resolves a function by name. Every process function is a STATIC
    entry in `CALCULATION_FUNCTIONS` (`widgets/calculation/functions.ts`);
    the nine formulas the shipped ontology declares are registered there, and
    an unknown `process.fn` is refused with `ontology.invalid_node` rather than
    executing anything (a tripwire proves every shipped `process.fn` is
    registered). The `process.file` / `engine` keys are ignored (verification
    data only). If a widget needs a
    configurable formula, add a STATIC entry there — never re-introduce a
    dynamic include of ontology-supplied code.

## Public API / key methods

### Server: `src/core/components/component_info/widgets/`

| symbol | purpose |
|---|---|
| `computeInfoWidgets(componentTipo, context)` | The read aggregate: dispatch each non-async declared widget to its `computeData`, concatenate. Returns `null` when no widgets are declared. |
| `computeInfoDataList(componentTipo, context)` | The edit-mode datalist aggregate: concatenate every widget's `computeDataList` (only `state` implements it). |
| `getInfoWidget(name)` | Fail-loud registry lookup (throws `WidgetNotRegisteredError`). |
| `widgetComputeData(descriptor)` | The descriptor's compute fn, or a throw for an `unported` stub. |
| `listInfoWidgets()` | All registered descriptors (tripwire + tooling surface). |
| `readWidgetComponentData(sectionTipo, sectionId, componentTipo)` | The shared component-value reader every widget uses (full stored array, no lang filter). |
| the shared rounding helper `(value, precision)` | Half-up rounding to a fixed number of decimals. |
| `normalizeWidgetEntryKeys(items)` | WC-026 — dualise top-level `id`/`widget_id`. |

### Emit / API integration

- `src/core/components/component_info/emit.ts` — the emit hook (stored-wins /
  live-fallback, WC-026 normalize, edit datalist attach, principal threading).
- `src/core/api/handlers/dd_component_info.ts` — the `get_widget_data` action.
- `src/core/section/record/observers.ts` `recomputeInfoObserver` — observer
  recompute on saves (see [Server-side observers](../system/observers.md)).

## How it fits with the rest of Dédalo

- **[component_info](../components/component_info.md)** — the only data-side
  host. A widget only ever runs because a `component_info` (or its
  `component_calculation` / `component_state` aliases) listed it.
- **[Components](../components/index.md)** — a widget's inputs are ordinary
  components, read via `readWidgetComponentData` (never storage).
- **[Sections](../sections/index.md)** — the read components resolve their
  values through the section's matrix record, as everywhere else.
- **[area_maintenance](../areas/area_maintenance.md)** — the *other*, unrelated
  widget family (admin panels). Different base, dispatcher and contract.

## Related

- [component_info](../components/component_info.md) — the host component.
- [Add a widget](../../development/extending/add_a_widget.md) — the how-to.
- [component_info cookbook](../components/component_info_cookbook.md) — recipes.
- [Components](../components/index.md) · [Architecture overview](../architecture_overview.md).
- Source of truth: `src/core/components/component_info/widgets/` (README.md
  checklist, registry.ts dispatch, one descriptor module per widget) and the
  client `client/dedalo/core/widgets/`.
