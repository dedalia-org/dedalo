# component_info — widget cookbook

> **The hands-on companion to [component_info](component_info.md) (the component
> reference) and [widgets](../ui/widgets.md) (the framework reference).** Those
> explain *what* the IPO widget framework is and *why*. **This document is the
> recipe book**: declare a widget, add a new one end-to-end, add a calculation
> formula, make a widget async, give it an edit datalist, wire observers, test
> it without an ontology instance, and debug a blank panel.
>
> See also: [Add a widget](../../development/extending/add_a_widget.md) (the
> step-by-step how-to) · [component_info](component_info.md#the-wire-contract) (WC-026, the dual `id`/`widget_id` wire contract)

---

## Contents

1. [The 60-second mental model](#the-60-second-mental-model)
2. [R1 — Declare a widget on a component_info node](#r1--declare-a-widget-on-a-component_info-node)
3. [R2 — Add a new server+client widget end-to-end](#r2--add-a-new-serverclient-widget-end-to-end)
4. [R3 — Add a `calculation` process function](#r3--add-a-calculation-process-function)
5. [R4 — Make a widget async](#r4--make-a-widget-async)
6. [R5 — Give a widget an edit datalist](#r5--give-a-widget-an-edit-datalist)
7. [R6 — Wire observers so the widget recomputes on saves](#r6--wire-observers-so-the-widget-recomputes-on-saves)
8. [R7 — Test a widget without an ontology instance](#r7--test-a-widget-without-an-ontology-instance)
9. [R8 — Debug a blank widget](#r8--debug-a-blank-widget)

---

## The 60-second mental model

A `component_info` node declares a list of widgets in `properties.widgets`. On a
section read the emit hook (`src/core/components/component_info/emit.ts`)
always serves the **live compute** (a stored misc value is ignored and counted —
the value is derived, see
[The derived-value rule](component_info.md#the-derived-value-rule)):

```text
component_info node ──▶ emit hook
                                          │
                                          ▼
                   computeInfoWidgets(componentTipo, context)   [widgets/registry.ts]
                                          │  per widget: INFO_WIDGETS.get(widget_name)
                                          ▼
                   descriptor.computeData(ipo, context)          [widgets/<tld>/<name>.ts]
                                          │  reads via readWidgetComponentData()
                                          ▼
                   [{widget, key, widget_id, id, value}]  ──▶ normalizeWidgetEntryKeys ──▶ data.entries
                                                                                              │
                                                     client component_info.js ──▶ render_<name>.js
```

Three rules that never bend:

- **Dispatch is by `widget_name` through the registry**, never by loading the
  ontology `path`. An unknown name throws `WidgetNotRegisteredError` — widgets
  never silently render empty.
- **Widgets never touch storage.** They read inputs through
  `readWidgetComponentData()` / `resolveComponentValue()`.
- **Every emitted item carries BOTH `id` and `widget_id`** (WC-026), so the
  client renders (matches `widget_id`) and the grid/export (matches `id`) both
  resolve.

> Recipes use the running examples **oh87** (a `component_info` on `oh1` hosting
> `media_icons` + `descriptors`), **numisdata595** (`get_archive_weights`), and
> **rsc19** (`component_state`). Substitute your own tipos.

---

## R1 — Declare a widget on a component_info node

The simplest change: host an **existing** widget on a `component_info` node — no
code. Add a `properties.widgets[]` entry naming the `widget_name`, its client
`path`, and an `ipo` config. Verified shape from **oh87** (`model:
component_info`, `parent: oh1`), hosting two widgets:

```json
{
  "widgets": [
    {
      "widget_name": "media_icons",
      "path"       : "/oh/media_icons",
      "widget_info": "Create a simple list of media element icons when default quality file exists. Add direct links to process",
      "ipo": [
        {
          "input": {
            "type"  : "component_data",
            "source": [ { "section_id": "current", "section_tipo": "current", "component_tipo": "oh25" } ],
            "paths" : [ [ { "var_name": "av", "section_tipo": "rsc167", "component_tipo": "rsc35" } ] ]
          },
          "output": [
            { "id": "id",            "label": "id",                 "value": "link" },
            { "id": "tc",            "label": "tc",                 "value": "text" },
            { "id": "transcription", "label": "tool_transcription", "value": "link", "process_section_tipo": "oh81" },
            { "id": "indexation",    "label": "tool_indexation",    "value": "link", "process_section_tipo": "oh83" },
            { "id": "translation",   "label": "tool_lang",          "value": "link", "process_section_tipo": "oh85" }
          ],
          "process": null
        }
      ]
    },
    {
      "widget_name": "descriptors",
      "path"       : "/oh/descriptors",
      "widget_info": "state of the av process and create a simple list of all descriptors associated to current record",
      "ipo": [
        {
          "input": {
            "type"  : "component_data",
            "source": [ { "section_id": "current", "section_tipo": "current", "component_tipo": "oh25" } ],
            "paths" : [ [ { "var_name": "indexation", "section_tipo": "rsc167", "component_tipo": "rsc860" } ] ]
          },
          "output": [
            { "id": "indexation", "label": "digitization", "value": "int" },
            { "id": "terms",      "label": "descriptors",  "value": "text" }
          ],
          "process": null
        }
      ]
    }
  ]
}
```

Edit the node's `properties` via the Ontology tool (or a `dd_ontology` write),
regenerate, and reload a record of that section. `computeInfoWidgets` runs both
widgets on every load — the value is computed, not stored.

!!! tip "Pick the input shape the widget expects"
    Widgets read either an **object** input (`{type, source, paths}` — as above)
    or an **array** input of typed entries (`[{type:'source'}, {type:'used'},
    …]` — as `get_archive_weights` / `sum_dates` / `get_coins_by_period` /
    `get_archive_states`). Copy the `ipo` from an existing instance of the same
    widget rather than inventing field names — see
    [component_info → IPO](component_info.md#ipo--the-widget-config) and
    [widgets → IPO](../ui/widgets.md#ipo--input--process--output).

---

## R2 — Add a new server+client widget end-to-end

A summary no existing widget computes needs a new **descriptor module** (server)
+ a copied **client module**. Condensed worked example — for the full
step-by-step read [Add a widget](../../development/extending/add_a_widget.md) and
the authoritative checklist in
`src/core/components/component_info/widgets/README.md`.

**1. Copy the reference client widget** and rename every `test_info` occurrence:

```bash
cp -r client/dedalo/core/widgets/test/test_info client/dedalo/core/widgets/oh/word_count
# rename js/test_info.js → js/word_count.js, js/render_test_info.js → js/render_word_count.js,
# css/test_info.less → css/word_count.less, and every `test_info` identifier → `word_count`
```

**2. Add the server descriptor** at
`src/core/components/component_info/widgets/oh/word_count.ts`:

```ts
import {
  type InfoWidgetDescriptor, type TypedInput, type WidgetContext, type WidgetItem,
  readWidgetComponentData, resolveCurrent,
} from '../widget_common.ts';

async function computeWordCount(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
  const data: WidgetItem[] = [];
  for (const [key, entry] of ipo.entries()) {
    const block = entry as { input?: { source?: TypedInput[] }; output?: { id?: string }[] };
    let value: unknown = null;
    for (const source of block.input?.source ?? []) {
      if (source.component_tipo == null) continue;
      const sourceData = (await readWidgetComponentData(
        String(resolveCurrent(source.section_tipo, context.sectionTipo)),
        resolveCurrent(source.section_id, context.sectionId),
        source.component_tipo,
      )) as { value?: unknown }[];
      if (sourceData.length > 0) value = String(sourceData[0]?.value ?? '').length;
    }
    for (const dataMap of block.output ?? []) {
      const id = dataMap.id ?? '';
      data.push({ widget: 'word_count', key, widget_id: id, id, value }); // BOTH keys — WC-026
    }
  }
  return data;
}

export const word_count: InfoWidgetDescriptor = {
  name: 'word_count',        // = ontology widget_name = client JS export
  path: '/oh/word_count',    // = ontology path; tripwire-bound to the client module
  computeData: computeWordCount,
};
```

**3. Register it** — add `word_count` to the `INFO_WIDGETS` array in
`widgets/registry.ts`.

**4. Add a gate** naming the widget in a `test()` title
(`test/parity/info_widget_differential.test.ts` for a real instance, or
`test/unit/info_widget_ports.test.ts` for a synthetic one — see [R7](#r7--test-a-widget-without-an-ontology-instance)).
The registry tripwire **requires** it.

**5. Host it** on a `component_info` node ([R1](#r1--declare-a-widget-on-a-component_info-node)).

```bash
# the tripwire tells you what is still missing at every step:
bun test test/unit/info_widget_registry_tripwire.test.ts
```

!!! warning "Emit BOTH `id` and `widget_id`"
    The client render matches on `widget_id`; the grid/export match on `id`.
    `test_info.ts` emits both — copy that. (The emit hook also dualises them, but
    emit both yourself so unit tests and the API channel see them too.)

---

## R3 — Add a `calculation` process function

The generic `calculation` widget runs an ontology-named formula. TS resolves it
from a **static registry** (`widgets/calculation/functions.ts`) — never a
dynamic include (the SEC-052 threat class does not exist here). To add a formula,
add an entry to `CALCULATION_FUNCTIONS`:

```ts
// src/core/components/component_info/widgets/calculation/functions.ts
export const CALCULATION_FUNCTIONS: Readonly<Record<string, CalculationFn>> = {
  summarize({ dataMap, options }) { /* … */ },
  to_euros({ dataMap }) { /* … */ },
  calculate_period({ dataMap, options }) { /* … */ },
  // … the other shipped formulas …
  // add yours:
  multiply({ dataMap }) {
    const numbers = Object.values(dataMap)
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .filter((value): value is number => typeof value === 'number');
    if (numbers.length === 0) return [{ id: 'total', value: 0 }];
    return [{ id: 'total', value: numbers.reduce((a, b) => a * b, 1) }];
  },
};
```

A `CalculationFn` receives `{dataMap, options, callerSectionTipo}` and returns
`{id, value}[]`. `dataMap` maps each input `var_name` to what that input's
model feeds a calculation (the descriptor facet `calculationData`,
`src/core/components/calculation_data.ts`):

| Input model | What the formula receives |
|---|---|
| `component_number` | the stored values as a list of numbers (`[]` when empty) |
| `component_date` | the input `options.select` part (default `start`): with `options.format: "dd_date"` the first item's date object tagged `format` `date` / `period`, otherwise the sum of the parts as Unix seconds; `false` when an item lacks the part |
| `component_info` (and its `component_calculation` alias) | the live compute's `options.select` values (default `value`) |
| relation models (`component_portal`, …) | each locator walks the input's `options.ddo_map` from its `self` ddo: a ddo with `fn: "get_calculation_data"` feeds its own calculation data, a plain leaf its item values; `null` when there are no locators |

`computeCalculation` (`calculation/calculation.ts`) then emits one item per
`output.id` the formula produced. The ontology block wires it:

```json
{
  "widget_name": "calculation",
  "path": "/calculation",
  "ipo": [
    {
      "input": {
        "section_id": "current",
        "components": [ { "tipo": "numisdata133", "var_name": "numero" }, { "tipo": "numisdata135", "var_name": "numero2" } ]
      },
      "process": { "fn": "multiply", "options": { "type": "float", "precision": 2 } },
      "output": [ { "id": "total", "value": "float" } ]
    }
  ]
}
```

!!! note "`process.file` / `engine` are legacy — ignored"
    TS dispatches only on `process.fn` through the static registry. Older
    ontology records may still carry `file` / `engine` keys from before the
    cutover; they are read but never used to load code. An unknown `fn` is
    refused with `ontology.invalid_node` — the read reports the broken
    definition instead of showing an empty field.

!!! warning "What a calculation refuses"
    `ontology.invalid_node`: a block without `process.fn`, an input without
    `tipo` / `var_name`, a relation input without a `self`-anchored
    `ddo_map`, a calculation that depends on itself (directly or through other
    calculations), a chain deeper than 16. `engine.uncovered_scope`: the
    `section_id` scopes `all` / `search_session`, `filter: true`, and an input
    whose model has no `calculationData` facet.

---

## R4 — Make a widget async

An async widget is skipped by the read-time aggregate and delivered on demand
through the `dd_component_info` `get_widget_data` action. Declare `isAsync: true`
on the descriptor:

```ts
export const user_activity: InfoWidgetDescriptor = {
  name: 'user_activity',
  path: '/dd/user_activity',
  isAsync: true,               // computeInfoWidgets skips it; get_widget_data delivers it
  computeData: computeUserActivity,
};
```

`computeInfoWidgets` skips it. The client fetches it
from the shared `widget_common.js` autoload path. The RQO and its response
envelope:

```bash
curl -s "$DEDALO/api/v1/json" \
  -H 'Content-Type: application/json' \
  -H "Cookie: dedalo_ts_session=$SESSION" \
  --data '{
    "dd_api" : "dd_component_info",
    "action" : "get_widget_data",
    "source" : { "tipo": "dd1633", "section_tipo": "dd64", "section_id": 42, "mode": "edit" },
    "options": { "widget_name": "user_activity" }
  }'
```

```jsonc
// success — result is the widget's raw item array
{ "result": [ { "widget": "user_activity", "key": 0, "widget_id": "totals", "value": { "who": [], "what": [], "where": [], "when": [], "publish": [] } } ],
  "msg": "OK. Request done successfully", "errors": [] }

// unknown widget_name (exact error bytes preserved as the wire contract)
{ "result": false, "msg": [" Empty widget_obj for widget user_activity"], "errors": [] }

// forbidden record (AUTHZ-01 gate)
{ "result": false, "msg": [" Forbidden record"], "errors": ["forbidden"] }
```

!!! note "The handler AUTHZ-01-gates the record"
    `get_widget_data` calls `principalCanAccessRecord(section_tipo, section_id,
    principal)` before any compute — an access check enforced on this path. See
    `src/core/api/handlers/dd_component_info.ts`.

---

## R5 — Give a widget an edit datalist

Some widgets render a controlled-vocabulary picker in **edit** mode and need the
option list as `data.datalist`. Implement `computeDataList` on the descriptor —
`state` is the precedent (`widgets/state/state.ts`):

```ts
async function computeStateDataList(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
  const { getDatalist } = await import('../../../../relations/datalist.ts');
  const data: WidgetItem[] = [];
  for (const [key, entry] of ipo.entries()) {
    const block = entry as { input?: { paths?: { section_tipo?: string; component_tipo?: string }[][] } };
    for (const path of block.input?.paths ?? []) {
      const lastPath = path[path.length - 1];
      const componentTipo = lastPath?.component_tipo;
      if (componentTipo === undefined) continue;
      const ownerSection =
        lastPath?.section_tipo === undefined || lastPath.section_tipo === 'self'
          ? context.sectionTipo : lastPath.section_tipo;
      const node = await getNode(componentTipo);
      const items = await getDatalist(componentTipo, node?.properties ?? null, ownerSection, 'lg-nolan');
      for (const item of items) data.push({ ...item, widget: 'state', key });
    }
  }
  return data;
}

export const state: InfoWidgetDescriptor = {
  name: 'state', path: '/state',
  computeData: computeState,
  computeDataList: computeStateDataList,   // ← the edit datalist facet
};
```

The emit hook (`emit.ts` `decorateItem`) calls `computeInfoDataList` **only in
edit mode** and attaches the result to the data item as `datalist` when
non-empty.

- The option list resolves through the canonical `getDatalist` — so it is
  exactly the set the leaf select/check_box would offer, **narrowed by that
  component's own `request_config`/sqo** (a leaf that fixes its target sections
  or filters shows only those options).
- The `'self'` sentinel on a path's `section_tipo` resolves to the owner
  section; the option list otherwise comes from the leaf component's own targets.

!!! warning "Missing datalist = blank widget"
    `render_edit_state.js` resolves labels from `self.datalist`
    (`datalist.find(...).label`). Without it the edit render **TypeErrors** and
    the widget goes blank — this is a client contract, so the server must attach
    it.

---

## R6 — Wire observers so the widget recomputes on saves

When another component changes, an info widget can recompute so its TM history
stays fresh. **One key does it: `observe` on the info component** — *what I
watch* — `{component_tipo, server:{filter|…}, client:{event,perform}}`. The
watched component declares nothing; the subscriber registers itself.

!!! warning "`observers` on the observed component is legacy — and never was 'required'"
    Earlier releases needed a mirror declaration, `[{section_tipo,
    component_tipo}]` on the **observed** node, and a half-declared edge was
    silently dead. That is no longer true: an `observe` entry with a `server`
    block dispatches on its own. The forward array survives for two jobs only —
    scoping an `observe` entry whose `component_tipo` is the `"all"` wildcard,
    and telling the recompute which section's records to target when one
    component is reused across several sections. Neither applies to an ordinary
    info widget. Full rules: [Server-side observers](../system/observers.md).

The recompute runs on save, from `src/core/section/record/observers.ts`, and
reads two server `filter` shapes.

### Cross-section — `filter:{SQO}`

The observed component lives on **another** section. Verified from
**numisdata595** (`get_archive_weights`), which watches the coin's `numisdata57`
`used` flag:

```json
// numisdata595 (the info component) properties.observe
[ { "component_tipo": "numisdata57",
    "server": { "filter": { "$and": [ { "q": null,
      "path": [ { "name": "Coins", "model": "component_portal", "section_tipo": "numisdata3", "component_tipo": "numisdata77" } ],
      "q_operator": null } ] } } } ]
```

That entry is the whole wiring. `numisdata57` (`component_radio_button`) does
also carry the legacy mirror below, but it is inert for dispatch — the edge
would fire identically without it:

```json
// numisdata57 (the observed radio_button) properties.observers — LEGACY, not required
[ { "info": "Coins. Property used for server side only", "section_tipo": "numisdata3", "component_tipo": "numisdata595" } ]
```

On a `numisdata57` save the recompute fills every clause's `q` with the saved
record's locator (+ `from_component_tipo` from the clause's last path step),
searches the observer's own section (`numisdata3`) for the type records that
reference the saved coin through the `numisdata77` portal, and recomputes
`get_archive_weights` **at each of them** — writing **one**
`matrix_time_machine` row per target (lg-nolan, raw computed shape) and leaving
the live misc column untouched. No item rides the save response (the target ≠
the saved record).

!!! tip "Which section gets searched"
    Three independent sources name `numisdata3` here and they all agree: the
    legacy spec's `section_tipo`, the observer's own ontology section, and the
    filter path's first step. So this edge resolves the same with or without the
    legacy spec. The order that decides when they *disagree* — and what happens
    when the section is virtual — is in
    [Server-side observers](../system/observers.md#host-section-resolution).

### Same-record — `filter:false`

The observer lives on the **same** record that changed. Verified from **rsc19**
(`component_state`), whose eight `observe` entries each use `filter:false`:

```json
// rsc19 properties.observe (one of eight)
[ { "component_tipo": "rsc156",
    "client": { "event": "update_value", "perform": { "function": "refresh" } },
    "server": { "filter": false } } ]
```

On an `rsc156` save the recompute targets the saved record itself, writes the TM
row, **and** merges the recomputed `rsc19` item into the **save response**
(`observers_data`) so the actively-edited panel refreshes client-side. The
response item carries WC-026 dual keys.

!!! danger "Declare the watch on the widget, never only on the watched component"
    `rsc19` is also the cautionary tale. Four components on this install —
    `rsc1139`, `rsc1140`, `rsc1401`, `rsc1403` — carry a legacy `observers`
    spec naming `rsc19` and **no** matching `observe` entry on `rsc19`. Nothing
    ever fired for them, and nothing ever will until the `observe` half is
    added: a forward spec alone is dead configuration. The engine now names
    every such edge in the boot log.

!!! note "What lands where"
    Per target: exactly **one** TM row (never the live misc column — the served
    value is derived at read time, so the row is history only). Same-record
    targets additionally ride the save response. Gated in
    `test/parity/info_observer_differential.test.ts`. An insert save used to
    double-fire before the cutover, so the frozen fixture data can contain two
    identical rows per insert — the gate compares TM counts **deduped** to stay
    robust to that.

---

## R7 — Test a widget without an ontology instance

The framework makes a widget testable by driving its descriptor's `computeData`
**directly** with a synthetic `ipo` over scratch matrix records — no ontology
instance needed. This is the pattern in `test/unit/info_widget_ports.test.ts`
(the gate for `get_archive_states` and `sum_dates`, which no instance declares):

```ts
import { get_archive_states } from '../../src/core/components/component_info/widgets/dmm/get_archive_states.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { sql } from '../../src/core/db/postgres.ts';

// 1. build scratch records (tracked for cleanup — 0-row deletes must fail loudly)
const host = await createSectionRecord('numisdata3', -1);
// … seed the portal + coins via UPDATE matrix SET relation = … (see the test) …

// 2. a synthetic IPO straight to the descriptor
const STATES_IPO = [{
  input: [
    { type: 'source', section_tipo: 'self',    component_tipo: 'numisdata77' },
    { type: 'answer', section_tipo: 'current', component_tipo: 'numisdata57' },
    { type: 'closed', section_tipo: 'current', component_tipo: 'numisdata157' },
  ],
  output: ['answer_afirmative', 'answer_count', 'answer_total' /* … */].map((id) => ({ id })),
}];

// 3. drive computeData directly and assert the shape
if (!('computeData' in get_archive_states)) throw new Error('descriptor is a stub');
const items = await get_archive_states.computeData(STATES_IPO, {
  sectionTipo: 'numisdata3', sectionId: host, mode: 'list', lang: 'lg-spa',
});
expect(items.find((i) => i.widget_id === 'answer_total')?.value).toBe(3);
```

Key hygiene (from the test): **track every created row and delete it in
`afterAll`** — a 0-row delete throws (the scratch-write law); also clear
`matrix_time_machine`. Run with `bun test test/unit/info_widget_ports.test.ts`.

!!! tip "Prefer a differential when an instance exists"
    If the widget IS declared by a real ontology node, add a
    `*_differential.test.ts` case that byte-compares `computeInfoWidgets` (or the
    `get_widget_data` envelope) against the frozen fixture store
    (`test/parity/info_widget_differential.test.ts`). Read the **Oracle Trap**
    note in `AGENTS.md` first — a green differential with no fixture coverage
    proves nothing.

---

## R8 — Debug a blank widget

A widget that renders blank almost always fails one of these checks. Work top to
bottom — the first three are the usual culprits.

| # | Check | How |
|---|---|---|
| 1 | **Which key does the render match?** | The client matches entries on **`widget_id`**; the grid/export on **`id`**. If your compute emits only one, the other consumer sees nothing. Emit both (WC-026); the emit hook dualises top-level string keys, but confirm your item is a top-level `{widget, …}` object, not a nested cell. |
| 2 | **Is `context.properties.widgets` present and an array?** | A missing/non-array `widgets` is a **client TypeError** — the whole field fails. Confirm the ontology node carries it and the structure-context ships it. |
| 3 | **Is `data.entries` an Array?** | The client reads `self.data.entries`. If the widget threw server-side, the entries never arrive. Check the server log for `WidgetNotRegisteredError` / `WidgetUnportedError`. |
| 4 | **Edit datalist missing?** | For `state`-style widgets the edit render needs `data.datalist`; without it the render TypeErrors. Confirm `computeDataList` is implemented and you are in **edit** mode ([R5](#r5--give-a-widget-an-edit-datalist)). |
| 5 | **`widget_name` mismatch across the three places?** | The descriptor `name`, the client `export const`/directory, and the ontology `widget_name` must all match; the `path` must point at the client folder. Run `bun test test/unit/info_widget_registry_tripwire.test.ts`. |
| 6 | **Async widget on a stored-only path?** | An `isAsync` widget is skipped by the read aggregate and delivered only via `get_widget_data`. If the client never issues that call (or the record is AUTHZ-01-forbidden), it stays blank. Check the `dd_component_info` request in the network tab ([R4](#r4--make-a-widget-async)). |

!!! note "Fix the server payload first"
    `client/` is the TS-owned primary client source — you may edit it directly.
    But if a widget renders blank, the fix is almost always the **server
    payload** — the missing key, the missing datalist, the un-normalized entry —
    not the render. Check the payload before touching client code.

---

## Related

- [component_info](component_info.md) — the component reference (wire contract,
  census, observers, known limitations).
- [widgets](../ui/widgets.md) — the framework reference (registry, descriptor
  contract, IPO fields, SEC-052).
- [Add a widget](../../development/extending/add_a_widget.md) — the step-by-step
  how-to and the `word_count` worked example.
- Source of truth: `src/core/components/component_info/widgets/` (README.md
  checklist, registry.ts, one descriptor module per widget).
