# IRI values

> Part of the [data model](index.md) family — the typed JSONB storage shapes
> Dédalo writes into the `matrix` table. See
> [Sections → typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns)
> for where this column lives, and [`component_iri`](../components/component_iri.md)
> for the component that produces it.

## What it is

The **IRI value** is the stored form of an *Internationalized Resource
Identifier* — a web address (`http://` / `https://`), a persistent identifier,
or any external authority/resource link, optionally paired with a
human-readable label.

It exists so that cultural-heritage records can reference **external**
authorities and resources (Wikidata, VIAF, GeoNames, nomisma, Getty AAT/ULAN,
a museum's public catalogue page, an external IIIF/image URL) as a *typed* link
rather than as plain text. Typing the link lets Dédalo validate the protocol,
render it as a clickable anchor, pair it with a structured label, and publish it
through diffusion as a real resource identifier.

This is distinct from a relation value such as a portal/select
[locator](../locator.md): an IRI points **out of** the system at an external
URL, whereas a relation points **at another Dédalo record**.

!!! warning "Not `{title, uri}`"
    Some older comments and documentation describe this column as holding
    `{title, uri}` objects. **That shape is not what is stored.** There is no
    `uri` property anywhere in the producing code; the canonical property is
    `iri`, and values are an **array of objects** (not a single object). The
    schema below is authoritative.

## Canonical JSON shape

Each value is one IRI item object. The stored value is an **array** of them.

```json
[
    {
        "id"    : 1,
        "iri"   : "https://dedalo.dev",
        "title" : "Dédalo website",
        "lang"  : "lg-nolan"
    }
]
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `iri` | `string` | **yes** | The URL, **with** protocol. Validated client-side with a strict `https?://` + hostname check (`check_iri_value()`); the write path does not currently re-validate scheme/host server-side. |
| `id` | `int` | yes (persisted rows) | Per-item counter, minted server-side. It is the **pairing key** for the title label dataframe and for the per-language variants of the same value. |
| `title` | `string` | optional | A literal label. **Deprecated as stored data** (since 6.8.0): new labels live in the paired label dataframe; the literal `title` is kept readable as a fallback for legacy rows. |
| `lang` | `string` | optional | The language marker of the item. Present because `component_iri` keeps per-language versions; the default/main value is `lg-nolan`. |

A fifth field, `label_id`, is documented as an **import-only** carrier that is
never persisted — see the import gap note in
[Import / interop](#import--interop).

### Language versions (`with_lang_versions`)

`component_iri` (`classSupportsTranslation: true`,
`src/core/components/component_iri/descriptor.ts`) has its default value under
`lg-nolan`, but behaves like a transliterated component: the user may add
per-language variants alongside the main `lg-nolan` value (surfaced
client-side as `transliterate_value`). The variants of one value **share the
same `id`**:

```json
[
    { "id": 1, "iri": "https://es.wikipedia.org/wiki/Arse",     "lang": "lg-spa" },
    { "id": 1, "iri": "https://ca.wikipedia.org/wiki/Saguntum", "lang": "lg-cat" },
    { "id": 1, "iri": "https://dedalo.dev",                     "lang": "lg-nolan" }
]
```

When instantiated for a given language the component returns the items for that
language and surfaces the others as `transliterate_value` so the UI can show the
alternates.

## Database column

The value is stored in the `matrix` typed JSONB column named **`iri`**,
resolved through `getColumnNameByModel('component_iri')`
(`src/core/ontology/resolver.ts`), which reads `column: 'iri'` off
`component_iri/descriptor.ts`.

Inside the column the array is **keyed by the producing component tipo** (an
extra level of nesting), so a row's `iri` column looks like:

```json
{
    "rsc217": [
        { "id": 1, "iri": "https://dedalo.dev", "title": "Dédalo website", "lang": "lg-nolan" }
    ]
}
```

The search engine therefore queries with JSONB path expressions rooted at the
component tipo:

```text
$.{component_tipo}[*] ? (@.lang == "lg-eng" && @.iri != "" && @.iri != null)
```

and a containment test like `iri @> '[{"iri":"https://dedalo.dev"}]'` matches a
record holding that URL. Built by `buildIriFragment()`
(`src/core/search/builders/builder_iri.ts`). See
[`component_iri`](../components/component_iri.md#search-operators) for the
full operator set.

## Components that produce / use it

| Component | Role |
| --- | --- |
| [`component_iri`](../components/component_iri.md) | The **only** producer. A literal-direct component: it stores its own final value (the URL + optional label) and does not resolve through a relation. |

The component **auto-injects** a fixed `component_dataframe` for the structured
title (slot tipo `dd560`, target section `dd1706` / component `dd1715`) —
declared as `fixedDataframeTipos: ['dd560']` on
`component_iri/descriptor.ts`. That dataframe stores the real titles; it is
*paired* to each IRI value by the shared item `id`, not stored in the `iri`
column itself. See [`component_dataframe`](../components/component_dataframe.md).
`src/core/section/read.ts` explicitly emits the `dd560` structure-context slot
whenever the resolved model is `component_iri`, so every read carries the
label dataframe alongside the value.

## Server-side handling

There is no dedicated item class; each value stays a plain object, validated
only by the client's own `check_iri_value()`. The write path does not
currently re-validate the `iri` scheme/host, and does not reject unknown
properties on the item — a stray extra key on a submitted item is stored
verbatim rather than dropped.

**Title resolution IS implemented.** `resolveCellValue()`'s `iri` family
(`src/core/resolve/relation_list.ts`) pairs a value with its label dataframe
**by the item `id`**: it looks up the `dd560` relation-column frame whose
`id_key` matches the item's `id` and `main_component_tipo` matches the
component, then resolves the frame target's `dd1715` label component. The
flat display joins the `iri` value and the resolved label with `, `. The read
pipeline (`src/core/section/read.ts`) explicitly emits the `dd560` structure
context slot whenever the resolved model is `component_iri`, so every read
carries the label dataframe alongside the value. Export atoms
(`src/diffusion/export/atoms.ts`) tag a `component_iri` cell as `cell_type: 'iri'`.

## Client-side model

On the client the value reaches the browser inside the datum **`data`** layer of
the `component_iri` instance
(`client/dedalo/core/component_iri/js/component_iri.js`): `this.data` is the
same array of objects described above (`{id, iri, title, lang}`), surfaced by
the request-config context/subcontext flow alongside the rest of the record.

The IRI input validates on `change` with `check_iri_value()`: it builds a
`new URL(value)`, requires `http:` / `https:`, and sanity-checks the hostname;
invalid input gets an `error` class. (Note: the `uri` *variable* in that check is
a transient `URL` parse object — it is **not** a stored field.) A per-value
"Link" button opens the URL in a new window with `rel="noopener noreferrer"` and
`opener = null` to prevent reverse tabnabbing. In list / read views the value is
rendered as an anchor whose text is the resolved title:

```html
<a href="https://dedalo.dev" rel="noopener noreferrer">Dédalo website</a>
```

## Examples

A single, default (non-translatable) link with a structured title:

```json
{
    "rsc217": [
        { "id": 1, "iri": "https://dedalo.dev", "title": "Dédalo website", "lang": "lg-nolan" }
    ]
}
```

A value with per-language variants (same `id`):

```json
{
    "rsc217": [
        { "id": 1, "iri": "https://es.wikipedia.org/wiki/Arse",     "lang": "lg-spa" },
        { "id": 1, "iri": "https://ca.wikipedia.org/wiki/Saguntum", "lang": "lg-cat" },
        { "id": 1, "iri": "https://dedalo.dev",                     "lang": "lg-nolan" }
    ]
}
```

The matching `meta` counter that minted those item `id`s (see
[Meta (id counters)](misc.md#the-meta-column)):

```json
{ "rsc217": [{ "count": 1 }] }
```

## Import / interop

`conformImportData()` (`src/core/tools/import_data.ts`) is a generic,
model-agnostic import path, and it covers `component_iri`'s two JSON shapes:

- the **array of objects** (one per value, `iri` mandatory):
  `[{ "iri": "https://dedalo.dev", "title": "Dédalo website" }]`;
- a **lang-keyed** map for the language-version capability:
  `{ "lg-spa": [{ "iri": "https://es.wikipedia.org/wiki/Arse" }] }` (a bare
  string value is wrapped into an array too).

`id` may be set explicitly on import; it is preserved as part of the JSON
object.

!!! warning "Plain-text CSV import: TS gap"
    Splitting a plain-text cell into a label + URL pair, joining several
    values on a records separator, and building the paired title-dataframe
    locator from an imported `label_id` token are **not implemented** in the
    TS import path today. Only the JSON shapes above import correctly for
    `component_iri`; a plain-text URL/label cell does not.

For export, export atoms (`src/diffusion/export/atoms.ts`) tag a
`component_iri` cell as `cell_type: 'iri'`; the flat value joins `iri` and
the resolved label with `, ` (see [Exporting data](../../using/exporting_data.md)).

## v7 consolidation / evolution

- **Flat array, not a `{lg-xxx:[…]}` map.** v7 stores all variants of all values
  as one flat array, carrying the `lang` on each item, paired across languages by
  the shared `id`. This replaces the older per-language nested map.
- **Title moved to a paired dataframe.** The literal `title` on the value is
  deprecated; the canonical title is now structured data in the injected label
  dataframe (`dd560`), resolved at read time by the item `id` (see
  [Server-side handling](#server-side-handling)). The literal `title` remains
  a read fallback until the title-materialization migration runs across
  legacy data.

## See also

- [Data model overview](index.md) — all typed-column value shapes.
- [`component_iri`](../components/component_iri.md) — the producing component
  (properties, views, search operators, import/export).
- [`component_dataframe`](../components/component_dataframe.md) — where the
  structured title is stored and how the `id_key` pairing works.
- [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns)
  — how the `iri` column sits inside the `matrix` row.
- [Importing data → URI](../../using/importing_data.md#uri) ·
  [Exporting data](../../using/exporting_data.md).
