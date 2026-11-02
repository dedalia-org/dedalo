# component_iri

## Overview

```json
{
    "could_be_translatable" : true,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_lang",
        "tool_lang_multi",
        "tool_propagate_component_data",
        "tool_time_machine"
    ],
    "render_views" :[
        {
            "view"    : "mini | default",
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
    "data": "array of objects",
    "sample_data": [
        {
            "id"    : 1,
            "iri"   : "https://dedalo.dev",
            "title" : "Dédalo website",
            "lang"  : "lg-nolan"
        }
    ],
    "value": "array of dd_iri objects",
    "sample_value": [
        {
            "id"    : 1,
            "iri"   : "https://dedalo.dev",
            "title" : "Dédalo website",
            "lang"  : "lg-nolan"
        }
    ]
}
```

!!! note "Default tools"
    `default_tools` lists the tools normally attached to an `component_iri` node by the model. The effective toolbar is resolved from the ontology node (see the [Notes](#notes) section); a node may declare fewer or more tools. `tool_lang` / `tool_lang_multi` only make sense once the component is used with multiple language versions (see [Translatable / transliterated IRIs](#translatable--transliterated-iris)).

## Definition

`component_iri` manages **Internationalized Resource Identifiers** (IRI / URI): web addresses such as `https://dedalo.dev`, persistent identifiers, authority-file links and any other `http://` / `https://` locator. Following [RFC 3987](https://www.rfc-editor.org/rfc/rfc3987), an IRI can contain Unicode characters, unlike a plain ASCII URI.

It is a **literal-direct** component: it stores its own final data (the URL string plus an optional human-readable label) and does not resolve through a relation to another section the way `component_portal` or `component_select` do.

**Why it exists.** Cultural-heritage records routinely reference external authorities and resources: a Wikidata entity, a `nomisma.org` coin-type page, a `viaf.org` name authority, a `geonames.org` place, a museum's own public catalogue page, or an external IIIF / image URL. Storing these as a typed IRI (rather than as plain text) lets Dédalo render them as clickable links, validate the protocol, pair each link with a structured label, and publish them through the diffusion layer as real resource identifiers.

**When to use it.**

- Linked-open-data references: Wikidata, VIAF, GeoNames, nomisma, Getty AAT/ULAN, etc.
- Permalinks to external catalogues, archives or bibliographic records.
- An external media source URL, combined with the `use_active_check` flag, to mark a remote URL as the active media source for a companion media component (e.g. `component_image`).

**When not to use it.** To point at *another Dédalo record* use a relation component (`component_portal`, `component_select`, `component_relation_related`) — those store [locators](../locator.md), not URL strings. For free plain text that is not a web address use [component_input_text](component_input_text.md); for an e-mail address use [component_email](component_email.md).

## Data model

**Data:** `array of objects`, or `null`. Each object is one IRI value (a `dd_iri`).

**Value:** the same `array of objects`. There is no separate "value vs locator" distinction because the component is literal; `iri` plays the role that `value` plays in [component_input_text](component_input_text.md).

**Item schema (`dd_iri`).** Each object holds:

- `id` (`int`) — per-item counter id, minted server-side. It is the **pairing key** for the title label dataframe (see [Notes](#notes)). Persisted rows always carry it.
- `iri` (`string`, mandatory) — the URL, including the protocol (`http://` or `https://`). A well-formed IRI needs a scheme and a host; that check runs on the client (strict regex / `URL` check) — see the shape note under [Notes](#notes) for the server side.
- `title` (`string`, optional, *deprecated as stored data*) — a literal label. New labels are stored through the paired label dataframe; the literal `title` is kept readable for old data until the title-materialization migration runs.
- `lang` (`string`, optional) — the language marker of the item. Present because `component_iri` keeps language versions (see below).

**Storage shape (matrix `iri` column).** v7 stores the data as a **flat array of objects**, one object per value, with the language carried on each item — *not* as a `{lg-xxx:[…]}` map. The data lives in the matrix column named `iri`.

Non-translatable (default) — every item is marked `lg-nolan`:

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

With language versions — the same `id` pairs the language variants of one value:

```json
[
    {
        "id"   : 1,
        "iri"  : "https://es.wikipedia.org/wiki/Arse",
        "lang" : "lg-spa"
    },
    {
        "id"   : 1,
        "iri"  : "https://ca.wikipedia.org/wiki/Saguntum",
        "lang" : "lg-cat"
    },
    {
        "id"   : 1,
        "iri"  : "https://dedalo.dev",
        "lang" : "lg-nolan"
    }
]
```

When instantiated, the component reads its data from the section and, by default, returns only the items for the instantiated language. Every data item also carries `transliterate_value`: the items of the *other* language of the pair (the version in the current data language beside an `lg-nolan` instance, the `lg-nolan` base beside a version instance), `null` when the component holds no data and `[]` when that language is empty. The edit view shows it under the entry and reuses its `id` for an empty row, so the label dataframe pairs across languages. The search engine queries this column with JSONB path expressions over `$.<component_tipo>[*]`, filtering by `@.lang` and matching `@.iri`.

!!! note "Rendered link"
    In read / list views the value is rendered as an anchor, the title (resolved from the label dataframe) as the link text:

    ```html
    <a href="https://dedalo.dev" rel="noopener noreferrer">Dédalo website</a>
    ```

### Translatable / transliterated IRIs

`component_iri` is **non-translatable by default** (`translatable = false`) and stamps its data as `lg-nolan`. But it sets `with_lang_versions = true`, so it behaves like a transliterated component: the main value lives under `lg-nolan` and the user may add per-language variants with `tool_lang` / `tool_lang_multi`, paired across languages by the shared item `id`.

!!! info "About translatable URIs"
    Dédalo applies no rule to decide whether a given URI *should* be translated. By default the user enters the URI as non-translatable; the language-version capability may be used or not (e.g. a per-language Wikipedia article).

## Ontology instantiation

A `component_iri` is defined like any other component: an ontology node whose `model` is `component_iri`, parented to the section (or grouper) it belongs to. The node carries its language flags (`lg-*`), its `properties` JSON, and optional `css`.

Minimal node definition:

```json
{
    "tipo"          : "rsc217",
    "model"         : "component_iri",
    "parent"        : "rsc205",
    "section_tipo"  : "rsc205",
    "translatable"  : false
}
```

- `tipo` — the ontology id of this component node (mandatory; validated as a safe tipo).
- `model` — `component_iri`. The ontology node's model is authoritative.
- `parent` / `section_tipo` — wire the component into its section; `section_tipo` is mandatory (no auto-resolution).

Realistic `properties` block for this component:

```json
{
    "use_title"         : true,
    "use_active_check"  : false,
    "fields_separator"  : ", ",
    "records_separator" : " | ",
    "mandatory"         : false
}
```

When the section that owns `section_tipo` is instantiated, it builds this component for the current `section_id`, `mode` and `lang`. The component reads/saves its data through that section's record — it never touches the database directly.

!!! note "Injected title dataframe"
    A fixed title label dataframe (slot tipo `dd560`, `DEDALO_COMPONENT_IRI_LABEL_DATAFRAME`) is **always injected** into every `component_iri`'s resolved `source.request_config`. You do not declare it in the node `properties`; every `component_iri` gets the structured-title dataframe automatically. See [component_dataframe](component_dataframe.md).

## Properties & options

| Property | Values | Default | Effect |
| --- | --- | --- | --- |
| `use_title` | `true` \| `false` | `true` | Show or hide the `title` text input next to the URL input in edit views. When `false`, only the URL field is rendered. |
| `use_active_check` | `true` \| `false` | `false` | Add an "active" checkbox to each value. Used when the IRI provides an external media source (e.g. paired with `component_image`): the checkbox marks whether that remote URL is the active media source. |
| `fields_separator` | string | `", "` | Character(s) used **between the parts of one value** (label and URL) when the value is flattened to text — for export, for showing the IRI inside other components, and to split CSV import strings such as `dédalo, https://dedalo.dev`. |
| `records_separator` | string | `" \| "` | Character(s) used **between multiple values** of the component when flattened to text (export, CSV import of multiple URLs, e.g. `…/org \| https://dedalo.dev`). |
| `mandatory` | `true` \| `false` | `false` | Marks the component as required so the UI informs the user a value must be entered. |
| `source` | object | injected | Holds `request_config`. `component_iri` **auto-injects** the title label dataframe into `source.request_config`; author-supplied `source.request_config` entries are preserved and appended to. Normally you do not set this by hand. |

!!! warning "Deprecated: literal `title`"
    Storing the human-readable label as a literal `title` string on the value is **deprecated** (since 6.8.0). Labels are now structured data held in the paired label dataframe (`dd560`) and resolved at read time from that dataframe. The literal `title` is still read as a fallback for legacy rows. On import the old `title` property is accepted but ignored; use `label_id` instead (see below).

!!! note "Unverified properties"
    Any property not listed above is not consumed by the `component_iri` source: verify in the ontology node before relying on it.

## Render views & modes

`component_iri` exposes the standard component modes — `edit`, `list`, `tm` (Time Machine read, rendered with the list renderer), and `search`. The views actually present in the source:

| View | Modes | Source | Notes |
| --- | --- | --- | --- |
| `default` | `edit`, `list` | `view_default_edit_iri.js`, `view_default_list_iri.js` | Edit: per-value title input + URL input + dataframe + add/remove/link buttons. List: title and URL joined with ` \| `, multi-value joined with line breaks; clicking opens edit-in-list as a modal. |
| `line` | `edit` | `view_line_edit_iri.js` | Compact single-line edit (reuses `get_content_data`). |
| `mini` | `edit`, `list` | `view_mini_iri.js` | Minimalist view for tight layouts; CSS class suffix `_mini`. |
| `print` | `edit` | render via `view_default_edit_iri` | Forces read-only rendering (`permissions = 1`) and adds the `view_print` class; used for print/export contexts. |
| `text` | `list` | `view_text_list_iri.js` | Returns the value purely as a text node (dataframe label + title + URL joined with ` \| `, values joined with `, `); no clickable anchor. |
| `search` | `search` | `render_search_component_iri.js` | Renders the search input plus the `q_operator` selector. |

The client model (`js/component_iri.js`) maps `tm` to the list renderer and reuses the shared client-side lifecycle / save / change-data behaviour. The IRI input validates on `change` with `check_iri_value()` (strict `https?://` + hostname sanity), flags invalid input with an `error` class, and a per-value "Link" button opens the URL in a new window (`rel=noopener`, `opener=null` to prevent reverse tabnabbing).

### Search operators

Server-side the filter is turned into SQL by `src/core/search/builders/builder_iri.ts` (dispatched from `src/core/search/conform.ts`); it builds JSONB-path SQL over the `iri` column and supports:

| Operator | Meaning |
| --- | --- |
| `!*` | empty (no IRI) |
| `*` | not empty (has IRI) |
| `==` | exactly equal |
| `!=` | different from |
| `=` | similar to / contains |
| `-` | does not contain |
| `!!` | duplicated (same IRI in another record) |
| `text*` | begins with |
| `*text` | ends with |
| `'text'` | literal |

!!! warning "Gap: `!!` duplicated self-join not yet covered"
    Per `builder_iri.ts`'s own header, every operator above is implemented **except** `!!` (duplicated — same IRI in another record), which throws in the current TS build.

## Import / export model

By default the import format is the **v7 array of objects** (one object per value, `iri` property). Because the component is non-translatable by default the language is not required; it defaults to `lg-nolan`.

```json
[{
   "iri"   : "https://dedalo.dev",
   "title" : "Dédalo website"
}]
```

Multilingual URIs (the language version capability) can be imported with the per-language object form:

```json
{
    "lg-spa": [{ "iri": "https://es.wikipedia.org/wiki/Arse" }],
    "lg-cat": [{ "iri": "https://ca.wikipedia.org/wiki/Saguntum" }]
}
```

The import format is also intended to accept plain-text CSV strings:

- A single URL: `https://dedalo.dev`
- A label + URL using `fields_separator`: `dédalo, https://dedalo.dev`. The left side is treated as the **label**: a number is taken as the `label_id` (target section id of the title label dataframe); a string is matched in the dataframe value list and a new label record is created if missing.
- Several values joined with `records_separator`: `dédalo, https://dedalo.dev | nomisma, https://nomisma.org`.

!!! danger "Gap: plain-text/label shorthands not implemented; JSON array form works"
    `component_iri` is **not** a `VALUE_PROPERTY_MODELS` member in the TS import
    engine (`src/core/tools/import_data.ts`), so none of the plain-text
    shorthands above (bare URL, `label, url`, pipe-joined multi-value,
    `label_id`-driven dataframe creation) are handled — a non-JSON cell falls
    through to the generic engine's raw-string branch instead of becoming an
    `{iri: ...}` item. Only the canonical **JSON array of objects** form
    (`[{"iri": "..."}]`) and the lang-keyed object form import correctly today.

!!! warning "id and label_id on import"
    The `id` property may be set explicitly on import because it pairs the
    value with its label dataframe (not independently verified against the
    current TS import path). `label_id` is intended as a temporary import-only
    property that points the title-label dataframe at a target section id,
    never stored on the value itself — but this mechanism is part of the same
    not-yet-implemented plain-text import path noted above, so it has no effect
    on the TS server today.

!!! note "Deprecated `title` on import"
    The literal `title` property is still accepted but ignored on import.
    Preserving the label relationship through `label_id` is part of the
    plain-text import path that is not yet implemented (see the gap above); the
    working JSON array form carries no label linkage of its own beyond the
    shared item `id`.

On export, flat display values are produced by the generic cell resolver `resolveCellValue()` (`src/core/resolve/relation_list.ts`) via `tools/tool_export/server/tool_export.ts`. The per-atom `cell_type: "iri"` contract (joining `iri` + resolved title with `fields_separator`, `records_separator` between values) has not been independently verified for full parity in the TS export path.

See the full URI import definition [here](../importing_data.md#uri) and the export model [here](../exporting_data.md).

## Notes

- **Title label dataframe (always injected).** Every `component_iri` node gets a fixed `component_dataframe` (slot tipo `dd560`, target section `dd1706` / component `dd1715`) injected into `source.request_config`: `src/core/resolve/structure_context.ts` (the `model === 'component_iri'` branch) and `src/core/section/read.ts` (the `frameTipos = ['dd560']` / explicit `dd560` push in the list/text render) both do this. Titles are paired to each IRI value by the shared item `id`. See [component_dataframe](component_dataframe.md).
- **Default tools.** Per the ontology model the node typically carries `tool_lang`, `tool_lang_multi`, `tool_propagate_component_data` and `tool_time_machine`. `tool_lang` / `tool_lang_multi` manage the per-language variants; `tool_time_machine` exposes the value history (`tm` mode).
- **Diffusion.** Not evaluated for this pass — verify against the native diffusion subsystem (`src/diffusion/`) before relying on title-resolved IRI diffusion output.
- **`dd_iri` shape.** Each value was once validated by a dedicated typed object (scheme+host check on the URL, `id`/`label_id` cast to int, unknown properties rejected). The TS server has no equivalent validator — values resolve as plain objects through the generic component-data engine (`src/core/resolve/component_data.ts`); any `iri`-shape validation happens only client-side.
- **Emptiness check** — considers only the `iri` and `title` properties when deciding whether a value is empty. Not independently verified for the TS read/save path.
- **Related component docs:** [component_input_text](component_input_text.md), [component_email](component_email.md), [component_dataframe](component_dataframe.md), [component_portal](component_portal.md).
