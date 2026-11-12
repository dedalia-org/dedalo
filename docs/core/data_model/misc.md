# Misc, meta and relation_search values

> See also: [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns) · [Components](../components/index.md) · [Locator](../locator.md) · [Glossary](../../understanding/glossary.md)

This page documents three of the typed JSONB columns that make up a `matrix`
record. They are siblings of the value-bearing columns documented elsewhere
(`media`, `geo`, `iri`, `number`, `string`, `date`, `relation`):

- **`misc`** — a catch-all column for components whose value is a *direct
  object/array* rather than a keyed locator list. Five very different components
  share it: [`component_json`](#component_json-arbitrary-json), [`component_info`](#component_info-computed-summary), [`component_security_access`](#component_security_access-permissions-matrix), [`component_inverse`](#component_inverse-resolved-backlinks) and [`component_filter_records`](#component_filter_records-per-record-access).
- **`meta`** — per-component **id counters**: the bookkeeping that mints the
  monotonic per-item `id`s used by `iri`, `json`, `date` and the other
  multi-value components.
- **`relation_search`** — an auxiliary, denormalised ancestor index written only
  for hierarchical (thesaurus) values so a search can match a record by any of
  its parents.

None of these columns hold a "type" in the sense that `media` or `geo` do; they
are storage *roles*. Where a column carries an actual value shape (`misc`), the
shape is **decided by the producing component**, not by the column. This is the
distinguishing fact about `misc` and the reason it needs its own page.

!!! info "Where these columns sit"
    A `matrix` record is one row whose conceptual `data` payload is physically
    split across typed JSONB columns. Routing from a component model to its
    column is resolved through `getColumnNameByModel()`
    (`src/core/ontology/resolver.ts`), reading each model's own
    `descriptor.column`, and the canonical column set is declared as
    `MATRIX_JSONB_COLUMNS` (`src/core/db/matrix.ts`). See
    [Sections — the data column is split into typed JSONB columns](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns).

---

## The `misc` column

### What it is

`misc` is the column for **direct-object** components. A normal value column
(`string`, `number`, `date`, `media`, `geo`, `iri`) stores a value of a single
known shape, and a `relation` column stores arrays of [locators](../locator.md)
keyed by component tipo. `misc` is the place for components whose value does not
fit either of those: an arbitrary blob of JSON, a computed summary, a
permissions matrix, a set of resolved backlinks, a per-user record allowlist.

Because the shapes differ wildly, the column store does not interpret the
value — **the component itself knows how to read and write its own shape**.
Each of the five models declares `column: 'misc'` on its own descriptor
(`src/core/components/component_json/descriptor.ts`, `component_info/`,
`component_inverse/`, `component_filter_records/`, `component_security_access/`).

### How it is keyed

Like the other value columns, `misc` is a JSONB object **keyed by the producing
component tipo**; each key holds that component's stored array:

```json
{
  "dd478":  [ { "id": 1, "tipo": "oh1", "value": [1, 3, 4] } ],
  "rsc245": [ { "id": 1, "value": { "any": "json" } } ]
}
```

A given section row only carries keys for the `misc` components that actually
live in that section. The GIN sample query for the column reaches into every
item's `value`:

```text
jsonb_path_query_array(misc, '$.*[*].value')
```

### Components that produce it

| component | stored? | shape summary | doc |
| --- | --- | --- | --- |
| `component_json` | yes | `[{"id", "value": <any JSON>}]` | [component_json](../components/component_json.md) |
| `component_info` | rarely | per-widget output items (computed each load) | [component_info](../components/component_info.md) |
| `component_security_access` | yes | `[{"id", "tipo", "section_tipo", "value"}]` | [component_security_access](../components/component_security_access.md) |
| `component_inverse` | no (`save()` is a no-op) | computed `[{from_section_tipo, from_section_id, from_component_tipo}]` | [component_inverse](../components/component_inverse.md) |
| `component_filter_records` | yes | `[{"id", "tipo", "value": [section_id…]}]` | [component_filter_records](../components/component_filter_records.md) |

The five models share no common ancestor beyond the generic item lifecycle —
`misc` is a storage role, not a class family.

### Client-side model

On the client the stored array surfaces in the datum `data` layer under the
**`entries`** property, built by `buildDataItem()`
(`src/core/resolve/component_data.ts`), which assigns the stored array to the
item's `entries` field. The component JS reads it back the same way:

```javascript
// client/dedalo/core/component_json/js/component_json.js
const entries  = data.entries || []
const db_value = typeof entries[0]!=="undefined" ? entries[0] : null
```

So a `misc` component appears client-side as `self.data.entries` (an array of the
same item objects stored in the column), regardless of which of the five shapes
it carries.

---

### `component_json` — arbitrary JSON

An arbitrary, free-form JSON value stored as a single **monovalue**. The item's
`value` may be any JSON: object, array, string, number, boolean or `null`,
nested to any depth. It is language-neutral (`lg-nolan`, non-translatable).

```json
[
  {
    "id": 2,
    "value": { "any": ["arbitrary", "json"], "nested": true }
  }
]
```

- `value` carries the literal payload; `id` is the counter-assigned item id (see
  [`meta`](#the-meta-column)). There is no `lang` key.
- Although stored as an array, the component is effectively monovalue: edit, list
  and search views only build/read `entries[0]`.
- **Import disambiguation:** a stored item `[{"value":1}]` is indistinguishable
  from a literal JSON value that happens to have a `value` property. The raw
  export wraps the data as `{"dedalo_data":[{"value":<any JSON>,"id":1}]}`;
  on import, `unwrapDedaloData()` (`src/core/tools/import_data.ts`) detects
  the wrapper — it is recognized only when `dedalo_data` is the item's *sole*
  property, so a legitimate `{"dedalo_data":1,"other":2}` value is not
  mistaken for the wrapper.

See [component_json](../components/component_json.md) and the
[import data model](../../using/importing_data.md).

---

### `component_info` — computed summary

An **info / aggregation** component: a literal component whose value is computed
dynamically from one or more *widgets* declared in its ontology `properties`,
rather than typed by a cataloguer.

Normally it stores **no own `misc` data**: the emit hook
(`src/core/components/component_info/emit.ts`) prefers a stored `misc` value
when present (the client save cycle can persist widget output as
`{id, key, value, widget}` items), and falls back to computing the widgets
live otherwise. Each widget contributes its own value list, reading from
other components of the record. When a value *is* stored, it lands in `misc`
like any direct-object component.

```json
[
  {
    "id": 1,
    "value": "…widget-computed output…",
    "tool_context": [ /* read-only per-widget tools */ ]
  }
]
```

!!! note "Per-widget tools, not component tools"
    `component_info` itself carries no toolbar. Any tools you see in its
    output are emitted **per widget output item** inside `data` as
    `tool_context` (e.g. the `media_icons` widget,
    `src/core/components/component_info/widgets/oh/media_icons.ts`); they are
    read-only context, not the component's own toolbar.

See [component_info](../components/component_info.md).

---

### `component_security_access` — permissions matrix

Per-profile permission levels over every reachable ontology element (areas,
sections, components, buttons, groupers). Stored as a flat array of permission
rows; non-translatable (`lg-nolan`, a single map across all languages).

```json
[
  {"id": 1, "tipo": "rsc197", "section_tipo": "rsc197", "value": 2},
  {"id": 2, "tipo": "rsc85",  "section_tipo": "rsc197", "value": 2},
  {"id": 3, "tipo": "rsc261", "section_tipo": "rsc197", "value": 1},
  {"id": 4, "tipo": "rsc170", "section_tipo": "rsc170", "value": 2}
]
```

- Each row reads as *"this profile has permission `value` over element `tipo`,
  located in section `section_tipo`."* When `tipo === section_tipo` the row is the
  section (or area) itself; otherwise it is a leaf element of that section.
- `value` is the permission level: `0` none, `1` read, `2` read+edit, `3` admin.
- `id` is the counter-assigned row id; `tipo`/`section_tipo` target the element.

!!! note "Zero values are not persisted"
    Rows whose `value` is `0` are **not** saved. The client builds a full
    `filled_value` array (every datalist node, absent ones defaulting to `0`) for
    the UI, but on save it strips every `value <= 0` entry. Absence of a row
    means *no access*.

!!! info "The tree (datalist) is derived, not stored"
    In `edit` mode the payload also ships a `datalist`: the full ontology
    hierarchy (areas → sections → elements) used to render the tree, built by
    `getSecurityAccessDatalist()` (`src/core/resolve/security_access_datalist.ts`).
    It is identical for every profile — the client overlays per-profile
    permission integers on top — and is served through the same per-request
    ontology cache layer as other structural reads
    (`createOntologyCache()`, `src/core/ontology/cache_factory.ts`). It never
    lives in the `misc` column.

See [component_security_access](../components/component_security_access.md).

---

### `component_inverse` — resolved backlinks

Displays the backlinks of a record (which records point at me). It **stores
nothing** — its `save()` is a deliberate no-op — and `get_data()` computes the
inverse-reference locators at request time:

```json
[
  { "from_section_tipo": "oh1", "from_section_id": "5", "from_component_tipo": "oh23" },
  { "from_section_tipo": "rsc197", "from_section_id": "12", "from_component_tipo": "rsc200" }
]
```

- `from_section_tipo` — ontology tipo of the referencing section.
- `from_section_id` — record id of the referencing section.
- `from_component_tipo` — the component (portal/relation) inside that section that
  holds the locator back to this record.

Because it is computed, an `inverse` value never appears as a `misc` key in
storage — the column-map entry exists only so the framework routes the (empty)
save correctly.

See [component_inverse](../components/component_inverse.md).

---

### `component_filter_records` — per-record access

Per-user record-level access restrictions (used in the Users section `dd128`,
canonical tipo `dd478`): the explicit set of `section_id`s a given user may
access in each target section, finer-grained than project-based filtering.
Non-translatable (`lg-nolan`). There is no feature flag: an empty array — or an
entry with an empty id list — means *no restriction*, and a populated entry
restricts that section on the user's next search.

```json
[
  { "id": 1, "tipo": "mdcat3112", "value": [1, 8, 9] },
  { "id": 2, "tipo": "rsc202",    "value": [8, 150, 201] },
  { "id": 3, "tipo": "oh1",       "value": [1, 3, 4] }
]
```

- `id` — counter-assigned entry id (targets `update`/`remove`).
- `tipo` — the target **section** tipo the restriction applies to.
- `value` — array of integer `section_id`s the user may access in that section
  (validated client-side to positive, de-duplicated integers).

!!! warning "This ACL is enforced — editing the row changes what a user can see"
    The search assembler (`src/core/search/sql_assembler.ts`) reads the logged
    user's entries through `getUserFilterRecords()`
    (`src/core/security/filter_records.ts`) and ANDs a `section_id IN (...)`
    restriction for every named section. It is a **second, independent**
    restriction alongside the project filter (`component_filter` /
    `component_filter_master`, enforced in
    `src/core/relations/filter_projects.ts`): both apply, each narrowing the
    other. Writing this row by hand — or through an import — silently changes
    what that user can list, count and open.

See [component_filter_records](../components/component_filter_records.md).

---

## The `meta` column

### What it is

`meta` holds the **per-component id counters**. Multi-value components
(`component_iri`, `component_json`, `component_date`, …) assign each stored item a
unique, monotonically increasing `id` so the item can later be targeted by
`update`/`remove` and paired across dataframes. The counter for each
component lives in `meta`, updated alongside the component's data column on
every save.

### Canonical shape

`meta` is a map of **component tipo → single-item array** carrying the running
counter. The `count` is the **last id assigned** to a value in that component:

```json
{
  "dd750": [ { "count": 3 } ],
  "dd201": [ { "count": 1 } ]
}
```

The single-item-array form is deliberate (it mirrors how the other typed columns
key a component's value as an array), and it is exactly what the atomic allocator
reads at the SQL level:

```sql
SELECT (meta->$1->0->>'count')::int AS count
FROM matrix WHERE section_tipo=$2 AND section_id=$3
```

### How ids are minted

Allocation is **atomic** and follows a never-lower, never-recycled counter
law: `allocateComponentItemId()` (`src/core/db/matrix_write.ts`) does the
increment as one atomic `UPDATE … SET meta = jsonb_set(…, count + 1)
RETURNING`, relying on Postgres's own row-level lock to serialize concurrent
callers against the same record — two allocations against the same row can
never observe the same pre-increment count. Absorbing explicit ids from
imports/migrations is `absorbComponentItemIds()`, which raises the counter to
`GREATEST(persisted, incoming max)` and never lowers it.

This is why every `iri`/`json`/`date` item gets a stable, non-reused `id`
even under concurrent edits.

### Components that use it

Any component that mints per-item `id`s: `component_iri`, `component_json`,
`component_date`, the string components, and the `misc` components above
(`component_security_access`, `component_filter_records` rows all carry the
counter-assigned `id`). `meta` itself is never read by the client — it is pure
server-side bookkeeping.

---

## The `relation_search` column

### What it is

A denormalised, GIN-indexed **ancestor index**. It is written **only for
`component_autocomplete_hi`** (hierarchical/thesaurus values) on save. It stores
the flattened parent-chain locators of the stored value so a search can match a
record by any of its ancestors **without walking the hierarchy at query time**:
linking a value to the thesaurus node *Madrid* lets a search for *Spain* or
*Europe* still match the record.

### Shape

An array of [locator](../locator.md) objects (the parent chain), keyed in the
column by the producing component tipo, each locator tagged with the component
tipo and relation type:

```json
[
  { "section_tipo": "es1", "section_id": 4, "type": "dd543", "from_component_tipo": "oh23" },
  { "section_tipo": "es1", "section_id": 2, "type": "dd543", "from_component_tipo": "oh23" }
]
```

It is derived by `deriveRelationSearch()` (`src/core/relations/save.ts`),
which walks each stored locator's ancestor chain, sets `from_component_tipo`
to the component's own tipo and `type` to its relation type, and
de-duplicates — and written by the record-write chokepoint
(`src/core/section_record/record_write.ts`) in the same update as the value,
so every way of writing a record (a save, a Time Machine restore, an
undelete, a bulk revert, an observer recompute) keeps it current. On a save it
runs only when the component's model is `component_autocomplete_hi`
(normalized to `component_portal` on read) — every other model writes nothing
to `relation_search`. The three removal doors (a portal locator delete, the
inverse-reference strip of a record delete, the data wipe) re-derive it for
every relation key they rewrite.

### How search uses it

The search builder wraps the primary `relation` clause with a cloned clause
targeting `relation_search`, OR-ing the two so a hit on the value **or** any of
its ancestors matches:

```text
{ $or: [ clause_relations, clause_relation_search ] }
```

See the [search subsystem](../../api/sqo.md) for the SQO → WHERE machinery.

---

## v7 consolidation / evolution

- **`misc` is a role, not a type.** The five components that share it have no
  common base; each owns its shape entirely. When adding a direct-object
  component, declare `column: 'misc'` on the new model's own `descriptor.ts`
  and implement the read/write of its own shape — do **not** add bespoke
  columns or tables (see *The Dédalo way: standard schema*).
- **Computed vs stored.** `component_inverse` (always) and `component_info`
  (normally) compute their value at request time and persist nothing; their
  descriptor's `column: 'misc'` is a routing declaration only. Treat it as
  "may use this column", not "stores here".
- **`meta` minting hardened.** The id counter moved from a non-atomic in-memory
  increment to the advisory-locked `allocate_component_ids()` so per-item ids stay
  unique under concurrent edits in persistent workers; the column shape
  (`{tipo:[{count}]}`) is fixed by the SQL the allocator runs.
- **`relation_search` stays narrow.** It exists purely as a search optimisation
  for `component_autocomplete_hi`; it is not a general-purpose denormalisation
  hook. Keep new search-time ancestor logic in the SQO/WHERE layer unless it must
  be precomputed at save time for the same hierarchical reason.

---

## See also

- [Sections — typed-column storage model](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns) — how `misc`/`meta`/`relation_search` fit the `matrix` row.
- Sibling data-model pages: `media`, `geo`, `iri` (other typed columns).
- Producing components: [component_json](../components/component_json.md) · [component_info](../components/component_info.md) · [component_security_access](../components/component_security_access.md) · [component_inverse](../components/component_inverse.md) · [component_filter_records](../components/component_filter_records.md).
- [Search (SQO)](../../api/sqo.md) — how `relation_search` is queried.
- [Importing data](../../using/importing_data.md) — the `dedalo_data` wrapper used by `component_json`.
- [Locator](../locator.md) · [Glossary](../../understanding/glossary.md).
