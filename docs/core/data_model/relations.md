# Relation values

> The data **type** produced by every related component: an array of
> [locators](../locator.md), each one a value item whose *value* is a pointer to
> another record. This page documents the **storage and value model** of that
> data — not any single component. For the locator object itself (its fields,
> flat form, helpers) see [Locator](../locator.md).

> See also: [Data model index](index.md) · [Sections — typed-column storage](../sections/index.md) · [Components](../components/index.md) · [relation_list (inverse view)](../ontology/relation_list.md) · [Locator](../locator.md)

---

## 1. What relation data is, and why it exists

Dédalo stores records as JSONB in a handful of `matrix_*` tables, each row keyed
by the pair `(section_tipo, section_id)` (see
[Sections — the matrix table model](../sections/index.md#the-matrix-table-model)).
That is a NoSQL store. **Relation data is how Dédalo grafts SQL-style
referential relations onto it.**

A *related component* (portal, select, check_box, radio_button, the
`relation_*` family, dataframe, filter) does not store literal values. Its data
is an **array of locators** — each locator is a value item that *points at*
another record (and optionally a component, tag or dataframe item inside it).
The canonical data lives once, in the target record; many records can point at
it; changing the target updates every caller. Resolving relation data means
reading the target row and rendering the requested component.

Because the pointer (`{section_tipo, section_id}`) is the same minimal address
the matrix tables use, the locator is the universal join key of the data model.
The relation *value model* is therefore: **a value item whose value is a
locator**, grouped into per-component arrays.

!!! note "Type vs. component"
    "Relation data" is the **format**. Many components produce it. The producing
    components are documented separately — start at
    [Components → related components](../components/index.md#related-components).
    This page is about the bytes in the database and how they are keyed, read,
    inverted and searched.

---

## 2. Canonical JSON shape

A single relation value item is a locator. The minimal, mandatory pair is the
target address; the other fields are sparse (only meaningful ones serialize):

```json
{
    "section_tipo"        : "rsc197",
    "section_id"          : 88,
    "from_component_tipo" : "oh24",
    "type"                : "dd151"
}
```

- `section_tipo` / `section_id` — **mandatory**; the target record being pointed at.
- `from_component_tipo` — the component that *owns* this locator. This is what
  partitions the section-wide relations bag (see §4): each component forces this
  to its own tipo when it validates incoming locators.
- `type` — the relation **type** tipo (link / parent / child / related / model /
  filter / dataframe …), see §6.

Richer items add destination and pairing fields (all optional, sparse):

```json
{
    "section_tipo"        : "rsc170",
    "section_id"          : 3,
    "component_tipo"      : "rsc29",
    "from_component_tipo" : "oh24",
    "from_section_tipo"   : "oh1",
    "from_section_id"     : "1",
    "type"                : "dd151",
    "type_rel"            : "bidirectional",
    "tag_id"              : "1",
    "tag_component_tipo"  : "rsc36",
    "id_key"              : 1
}
```

- `component_tipo` — narrows the pointer from a whole record to one field.
- `tag_id` / `tag_component_tipo` / `tag_type` — narrow to one inline tag inside
  a text-area component.
- `from_*` — the source side (the record/component that stored the locator),
  needed to navigate a relation back to its origin.
- `type_rel` — directionality descriptor (`'unidirectional'`,
  `'bidirectional'`, `'multidirectional'`); used by
  [`component_relation_related`](../components/component_relation_related.md).
- `id_key` — dataframe pairing key (positive int); ties a dataframe locator to
  the exact main-component item it qualifies
  (`section_id_key` / `section_tipo_key` are **@deprecated** and no longer read by
  live code — only by the old-CSV import and v6→v7 update).

For the complete, field-by-field reference — every property, its setter,
validation rules and the flat string form — see **[Locator](../locator.md)**.

---

## 3. Database column: `relation`, keyed by component tipo

Relation data lives in its own typed JSONB column, **`relation`**, one of the
columns the conceptual `data` payload is split into
(see [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns)).

Inside the column the locators are stored as a **map keyed by the originating
component tipo**, each value being that component's array of locators:

```json
{
    "oh24": [
        { "section_tipo": "rsc197", "section_id": 88, "from_component_tipo": "oh24", "type": "dd151" },
        { "section_tipo": "rsc167", "section_id": 12, "from_component_tipo": "oh24", "type": "dd151" }
    ],
    "oh25": [
        { "section_tipo": "rsc197", "section_id": 5, "from_component_tipo": "oh25", "type": "dd151" }
    ]
}
```

This is why one record can carry many distinct relation components without
collision: each component owns the array under its own tipo key. A component
reads its slice via `readComponentItems(record, 'oh24', 'component_select')`
(`src/core/resolve/component_data.ts`) — the array stored under key `oh24`
inside the `relation` JSONB column — where the model's descriptor declares
`column: 'relation'` (e.g. `component_select/descriptor.ts`). The
relation-specific engines that consume it — expansion, inverse resolution,
dataframe `id_key` pairing — live in `src/core/relations/`.

A record-create / column-save payload addresses it the same way (column →
component-tipo → value array):

```json
{
    "relation": { "oh25": [ /* locators */ ] },
    "string":   { "oh26": ["Hello"] },
    "data":     { "...": "section metadata object" }
}
```

!!! note "Components never write the database"
    A component reads and writes *through* its section. On `save()` the section
    is the single writer; the locators land in the `relation` column keyed by
    component tipo, and the record-wide `relations` bag (§4) is kept in step.

---

## 4. Relation writes go through the partitioned column directly

There is a single representation of a record's relation data: the
partitioned **`relation` column**, keyed by component tipo (§3). There is no
separate aggregated bag holding every locator of a record in one flat array —
each write reads and writes its own component's slice directly.

The write chokepoint is `src/core/section/record/save_component.ts` /
`src/core/relations/save.ts`, which every related component's insert/update/
remove goes through. Insert-time validation and dedup — requiring a
`type`, and rejecting a locator that already matches an existing one — are
standalone functions over the locator value object
(`src/core/concepts/locator.ts`, e.g. its comparison/dedup helpers) and
`validateRelationInsert()` (`src/core/relations/save.ts`), called at the
point of use rather than through a shared aggregation object.

---

## 5. Inverse references (`dd_relations`)

Locators are stored only on the **pointing (forward)** side: the record that
*points at* another holds the locator. The inverse question — *"who points at
me?"* — is **computed**, not stored: `findInverseReferences()` /
`findInverseReferenceLocators()` (`src/core/search/search_related.ts`) scan
the matrix tables and return descriptors carrying `from_component_tipo`,
`from_section_tipo`, `from_section_id` and the pairing key (`id_key`). This
drives:

- **Referential integrity on delete** — `removeAllInverseReferences()`
  (`src/core/section/record/delete_record.ts`) removes every forward locator
  that points at a record being deleted, so no stale references remain.
- **The inverse view** — [`relation_list`](../ontology/relation_list.md) renders
  the backlinks as a grouped, paginated grid ("who points at this record").

On the **diffusion** side this materialises as a published column,
**`dd_relations`** (refactored from the v6 `jer_dd_relations` column during
the v6→v7 migration). The publication API's
`resolve_inverse_relations` option resolves it; an unresolved entry looks like:

```json
{
    "type"                : "dd48",
    "section_id"          : 33,
    "section_tipo"        : "aa1",
    "from_component_tipo" : "hierarchy49",
    "from_section_tipo"   : "aa1",
    "from_section_id"     : "4"
}
```

Each inverse locator carries a `section_tipo`, which the publication layer maps
to a target table to fetch the resolved row; locators whose `section_tipo` is
not in the mapping are skipped silently. See the publication API querying docs
for `resolve_inverse_relations`.

---

## 6. Relation `type` values

The `type` field is a real ontology tipo (not a label):

| tipo | meaning |
| --- | --- |
| `dd151` | generic portal / select link |
| `dd47` | hierarchy parent |
| `dd48` | hierarchy child |
| `dd89` | related record |
| `dd620` | related, unidirectional |
| `dd467` | related, bidirectional |
| `dd621` | related, multidirectional |
| `dd98` | model |
| `dd96` | index / indexation |
| `dd675` | project / access filter |
| `dd77` | ontology |
| `dd490` | positive marker of dataframe-pairing locators |

Conceptually the locator type space is *link / external link / parent / child /
related / model* (the "external link" is the external-source variant of a link).
A component's effective `type` comes from its own descriptor's
`defaultRelationType` field (`src/core/components/types.ts`), overridden per
tipo by `properties.config_relation.relation_type` when set
(`getRelationTypeByTipo()`, `src/core/relations/save.ts`).

---

## 7. `relation_search` (denormalized hierarchical search data)

Plain relation data only records the exact target a record points at. For
**hierarchical / cross-parent search** that is not enough: searching for *Spain*
should also match a record linked to *Madrid*. To make that work, the
hierarchical-search component (legacy model `component_autocomplete_hi`,
normalized to `component_portal` on read) denormalizes its ancestor chain
into the auxiliary **`relation_search`** JSONB column whenever the record is
written: `deriveRelationSearch()` (`src/core/relations/save.ts`) walks each
stored locator's ancestor chain and emits one entry per ancestor, tagged with
this component's tipo and relation type, and the record-write chokepoint
stores it in the same update as the value.

The emitted ancestor locators carry `section_tipo`, `section_id`,
`from_component_tipo` (the searching component) and `type`, so a search that hits
an ancestor node also matches every descendant that links below it. This is a
**denormalized copy** maintained from the forward locators — never a separate
source of truth.

---

## 8. Components that produce / use relation data

Every related component reads and writes relation data; their differences are in
*type*, *cardinality* and *UI*, not in the stored format:

| component | produces | notes |
| --- | --- | --- |
| [`component_portal`](../components/component_portal.md) | link locators (`dd151`) | many-to-many record links; resolves target sub-columns via `ddo_map` |
| [`component_select`](../components/component_select.md) | link locator | single linked record |
| [`component_check_box`](../components/component_check_box.md) | link locators | multi-value selection |
| [`component_radio_button`](../components/component_radio_button.md) | link locator | single selection |
| [`component_relation_parent`](../components/component_relation_parent.md) | parent locators (`dd47`) | hierarchy up |
| [`component_relation_children`](../components/component_relation_children.md) | child locators (`dd48`) | hierarchy down |
| [`component_relation_related`](../components/component_relation_related.md) | related locators (`dd89`/`dd620`/`dd467`/`dd621`) | uses `type_rel` directionality |
| [`component_relation_model`](../components/component_relation_model.md) | model locators (`dd98`) | model wiring |
| [`component_relation_index`](../components/component_relation_index.md) | index locators (`dd96`) | indexation with `tag_id` |
| [`component_dataframe`](../components/component_dataframe.md) | dataframe-paired locators (`dd490`) | paired to a main item via `id_key` |
| [`component_filter`](../components/component_filter.md) | filter locators (`dd675`) | project / access filtering |

The selectable option list (datalist / autocomplete) for these components is a
separate concern, resolved through
[`relation_list`](../ontology/relation_list.md) and `getDatalist()`
(`src/core/relations/datalist.ts`) — see
[Components → related components](../components/index.md#related-components).

---

## 9. Where relation behaviour lives

Relation behaviour is a set of horizontal engine modules, not classes:

| Module | Role |
| --- | --- |
| `src/core/concepts/locator.ts` | the locator value shape (zod schema) + dedup/comparison helpers |
| `src/core/resolve/component_data.ts` | reads a component's slice of the `relation` column |
| `src/core/relations/relation_core.ts` + the per-model resolvers in `src/core/relations/models/` (dispatched via `src/core/relations/registry.ts`, `descriptor.resolveData`) | shared relation-row-emission engine + per-model particularities |
| `src/core/search/search_related.ts` | `findInverseReferences()` / `findInverseReferenceLocators()` — the inverse-reference engine |
| `src/core/resolve/relation_list.ts` | the inverse (backlink) view |
| `src/core/section/record/delete_record.ts` | `removeAllInverseReferences()` — referential integrity on delete |

See the `dedalo-relations-ts` skill for the full engine map.

---

## 10. Client-side model

In the JSON-API the transmitted unit is a `{context, data}` **datum**. For a
relation component the locator array surfaces in the **data** layer (the
`context` layer carries only the description — `tipo`, `model`, `mode`, `lang`,
`label`, `properties`, `permissions`, `tools`, `request_config`, `view` — never
the values).

- In the API payload the locator array is exposed under **`data.entries`**, each
  entry carrying a transient `paginated_key`, accompanied by `parent_tipo`,
  `parent_section_id` and `pagination`.
- In JavaScript the component instance holds it as **`self.data.entries`** — the
  array of locator objects, mutated in place before save; on save the locator's
  `from_component_tipo` is forced to the owning component's own tipo.
- The **displayed strings** of the linked records are *not* in the locator. They
  arrive as **subdata**: the read pipeline (`readSection()`,
  `src/core/section/read.ts`) resolves each target and appends the target
  components' datums, deduplicating context entries by `context_key`
  (tipo + section + mode, first occurrence wins).

```javascript
// client/dedalo/core/component_common/js/component_common.js (shape)
self.data.entries = [
    { section_tipo: "rsc197", section_id: 88, from_component_tipo: "oh24", type: "dd151" }
    // ...
]
```

For the full layering rules (context vs. data, subdatum resolution, datalist) see
the **dedalo-context-data-layers** and **dedalo-datalist-resolution** skills.

---

## 11. Resolution to a value

To turn a locator into a displayed value:

1. Read the target `matrix_*` row by `{section_tipo, section_id}`.
2. If `component_tipo` is set, render that component; `tag_id` /
   `tag_component_tipo` narrow further to a single inline annotation.
3. For dataframe locators, `id_key` pairs the supplementary frame record to the
   exact main-component item (`section_id_key` / `section_tipo_key` are retired —
   read only by the old-CSV import and v6→v7 update).

Helper functions in `src/core/concepts/locator.ts` support resolution and
dedup: `getTermIdFromLocator()` (`{section_tipo}_{section_id}`, e.g.
`es1_185`), `compareLocators()`, `isLocatorInArray()` and
`buildLocatorLookupKey()` (hash-key dedup). See [Locator → helpers](../locator.md)
for the full list.

---

## 12. v7 consolidation / evolution

- **One partitioned column, no separate bag.** Every related component's
  locators live in its own slice of the `relation` column, keyed by component
  tipo — there is no separate aggregated array of every relation on a record;
  a caller that needs "all relations of this record" reads across the
  column's keys.
- **Unified dataframe pairing.** `id_key` is the single pairing contract for
  dataframe locators (and `dd490` is the positive marker of a
  dataframe-pairing locator) — including the relation sibling-order, which is
  itself an `id_key` dataframe. The legacy `section_id_key` / `section_tipo_key`
  are retired, read only by old-CSV import and the v6→v7 update path.
- **Source-side `from_*` over the v6 anchors.** `from_section_tipo` /
  `from_section_id` replace the deprecated `section_top_tipo` /
  `section_top_id` hierarchical anchors.
- **`dd_relations` on the diffusion side** replaces the v6 `jer_dd_relations`
  column (migrated during the v6→v7 upgrade) and is resolved on demand by
  the publication API's `resolve_inverse_relations`.
- **Inverse is computed, not stored.** `findInverseReferences()`
  (`src/core/search/search_related.ts`) computes backlinks on demand, so
  there is no inverse table to keep in sync; `relation_search` is the only
  denormalized copy, and it is rebuilt from the forward locators on save.

---

## See also

- [Locator](../locator.md) — the value object: every field, the flat string form, helpers.
- [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns) — how `relation` / `relation_search` sit among the typed columns.
- [Sections — relations are section-owned](../sections/index.md#relations-are-section-owned) — the `section` relation API.
- [Components → related components](../components/index.md#related-components) — the producers.
- [relation_list](../ontology/relation_list.md) — the inverse (backlink) view and the `dd_relations` diffusion adapter.
- [Data model index](index.md) — sibling data-type pages.
