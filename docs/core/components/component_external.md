# component_external

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
            "view"    : "default | line | mini | print",
            "mode"    : "edit"
        },
        {
            "view"    : "default | line | text | mini",
            "mode"    : "list"
        }
    ],
    "data": "object",
    "sample_data": {
        "entries": ["Santa María de Ripoll : informe sobre las obras realizadas en la basílica"]
    },
    "value": "array of strings",
    "sample_value": ["Santa María de Ripoll : informe sobre las obras realizadas en la basílica"]
}
```

!!! note "Live, read-only value"
    `component_external` is a literal-direct component, but it is special: its
    value is not authored by the user. The displayed value is fetched
    on-demand from a configured external API every time the component's data is
    read. There is no edit
    input — the `edit` view renders the resolved remote text read-only.

!!! note "Status (2026-08-05)"
    The remote-read subsystem is implemented: the outbound door, the per-service
    adapters, the row cache and the circuit breaker live in `src/external/`
    (a peer of `src/core`, reached only through `src/external/api/`), and the
    component's own derivation lives in
    `src/core/components/component_external/value.ts`, wired as
    `emitHook: 'external'`. Two things are deliberately still open:

    - **outbound is fail-closed by default.** With no
      `DEDALO_EXTERNAL_ALLOWED_HOSTS` line in the install's environment, every
      request is refused and each component reports `misconfigured`. Turning it
      on is an operator action.
    - **server-side external SEARCH is not implemented.** The component's
      `search` face throws deliberately: there is no SQL surface to search, so
      it must go through the service adapter's search request, which is not
      built yet.

## Definition

`component_external` retrieves and displays data from a **remote external API**
and integrates it into a Dédalo section as if it were a normal literal field.
It exists for the common cultural-heritage scenario where the authoritative
record lives in a third-party catalogue and Dédalo must surface selected fields
of that record without copying (and then having to re-synchronise) the data
locally.

The reference implementation targets **DAINST ZENON** (the German
Archaeological Institute's bibliographic catalogue,
`https://zenon.dainst.org/api/v1/record`), where a Dédalo bibliography section
holds only the ZENON record identifier and each `component_external` field
(Title, Authors, Publication dates, Physical description, …) is resolved live
from the ZENON API.

**Use it when:**

- The canonical data lives in an external system (library catalogue, museum
  database, authority file) and should be displayed but not stored/edited in
  Dédalo.
- You want each external field to behave like a separate column in list and
  search views (so it can be shown in grids, used as a list label, etc.).
- The remote system exposes a per-record HTTP/JSON endpoint that can be keyed
  by the Dédalo `section_id`.

**Do not use it when:**

- The user must edit or own the value locally — use
  [component_input_text](component_input_text.md) or
  [component_text_area](component_text_area.md).
- You only need to *link* to another Dédalo section — use a relation component
  such as [component_portal](component_portal.md).
- The value must persist offline: external values are recomputed on every load.
  An unreachable source is survivable — the last good values keep being shown,
  marked as such — but nothing is stored locally, so a source that goes away
  for good takes the values with it.

For connecting a service end to end (the section binding, the host allowlist,
the operator knobs), see
[External record services](../system/external_services.md).

## Data model

**Data:** `object`. The client/data layer carries the resolved value under an
`entries` array (the JSON-API data item). Each entry is a plain string already
formatted by the server.

**Value:** `array` of `strings`, or `null`.

**Storage: none.** The component stores nothing, in any column. Its descriptor
declares `column: 'relation'` purely for column-map parity with the retired
engine; nothing writes it and nothing reads it. The record it displays IS the
remote record — the section's `section_id` is the remote identifier (a
zero-padded string such as `"001338683"`, never a Dédalo numeric id) — and the
value is derived on every read. As a literal-shaped component it transmits its
data through the standard `{context, data}` datum.

Because the value is derived, **an import can never write it**: every cell
shape (flat, JSON, empty) is refused per cell, leaving the record untouched.

!!! danger "The component is never written, and the remote service never is"
    The traffic is one-directional by design. A save addressed to a
    `component_external` tipo is refused outright (an `ExternalWriteRefused`
    error naming the tipo), `delete_data` skips the model instead of emptying
    it, and a Time Machine restore therefore cannot put a remote value back —
    the retired engine did exactly that, and it fossilised a stale copy of
    somebody else's record into a column nothing reads. Outbound, the transport
    accepts only `GET` and `POST`; no adapter can express a remote mutation.
    The **one** thing curation writes is the caller's own locator, in the
    calling component: `{"section_tipo": "zenon1", "section_id": "001338683"}`.
    That `section_id` is a **remote** id and stays a string verbatim — a matrix
    record address is an integer, but a zero-padded or otherwise
    non-numeric-convertible value addresses no matrix record and is never
    converted by any writer.

Data item emitted to the client (`mode: list`):

```json
{
    "section_id"          : "001338683",
    "section_tipo"        : "zenon1",
    "tipo"                : "zenon4",
    "mode"                : "list",
    "lang"                : "lg-nolan",
    "from_component_tipo" : "rsc368",
    "entries"             : [
        "Santa María de Ripoll : informe sobre las obras realizadas en la basílica"
    ]
}
```

The component is **non-translatable** (`translatable: false`); the lang is
forced to `lg-nolan`. The requested remote language is derived from the
current data language and mapped to a two-letter code by the service adapter
(for ZENON, `lgn=en`).

When the values are anything but a plain fresh success, the item carries an
extra `source_status` object naming what happened:

```json
"source_status": {
    "service"    : "zenon",
    "state"      : "stale",
    "label_key"  : "external_source_stale",
    "retryable"  : true,
    "stale_since": 1754380000000
}
```

`state` is one of `stale`, `unavailable`, `timeout`, `not_found`,
`circuit_open`, `disabled`, `misconfigured` (a clean success emits no field at
all), and `label_key` is a key into the UI label catalog — the client
localizes it. There is deliberately **no silent blank**: an empty external
field always says why it is empty.

**Saving:** there is nothing to save. The component has no edit input and no
storage slot.

### How the value resolves

1. Read the **section** ontology node properties (`api_config`) for `entity`,
   `api_url` and `response_map`.
2. Collect the `remote` field names declared by sibling components
   (`properties.fields_map` entries whose `local` is `dato`), plus the field
   that carries the record's own identifier (`id` for Zenon).
3. The service adapter for the configured `entity` (e.g. `zenon`) builds the
   per-record request, asking for exactly those fields — ONE request per
   record, shared by every component of the section (and cached as one row).
4. The host is checked against the operator's allowlist **before** anything is
   resolved; the address is then vetted, pinned, and fetched with a short
   timeout and a hard response-size ceiling.
5. The row whose identifier matches the requested one is selected.
6. Each component extracts its own field from that row using its own
   `fields_map` `dato` entry and applies the optional `format` transform.

Sample remote row (ZENON `records[0]`) the component reads from:

```json
{
    "id": "000848571",
    "title": "Las acuñaciones provinciales romanas de Hispania",
    "authors": {
        "primary": { "Ripollès Alegre, P. P. (Pere Pau)": [] },
        "secondary": [],
        "corporate": []
    },
    "publicationDates": ["2010"],
    "recordPage": "/Record/000848571",
    "physicalDescriptions": ["328 p. : ill. ; 29 cm."]
}
```

## Ontology instantiation

`component_external` is wired in two layers: the **section** node carries the
connection (`api_config`), and each external **component** node maps one remote
field.

Component node (one per external field, e.g. *Title* `zenon4`):

```json
{
    "tipo"      : "zenon4",
    "model"     : "component_external",
    "parent"    : "zenon2",
    "lg-eng"    : "Title"
}
```

Its `properties` declare which remote field this component reads and how to
format it:

```json
{
    "fields_map": [
        {
            "local"  : "dato",
            "remote" : "title"
        }
    ]
}
```

An *Authors* field using a format transform:

```json
{
    "fields_map": [
        {
            "local"  : "dato",
            "remote" : "authors",
            "format" : "zenon_authors"
        }
    ]
}
```

The owning **section** node (`section_tipo`, e.g. `zenon1`) carries the API
connection in its own `properties.api_config`:

```json
{
    "api_config": {
        "entity"       : "zenon",
        "api_url"      : "https://zenon.dainst.org/api/v1/record",
        "response_map" : [
            { "local": "ar_records", "remote": "records" },
            { "local": "msg",        "remote": "status" }
        ]
    }
}
```

!!! warning "section_tipo is mandatory"
    Like every v7 component, `component_external` requires an explicit
    `section_tipo` at instantiation; auto-resolution was removed. The component
    reaches **up** to its section node to read `api_config`, so the external
    field only resolves when it is a child of a section configured for the
    matching entity. The external section_id is the remote record identifier
    (e.g. `"001338683"`), not a Dédalo numeric id.

## Properties & options

### `fields_map` (component node)

The only property this component reads on its own node. An array of mapping
objects:

- `local` — fixed marker. Use `"dato"` to designate the entry that supplies
  this component's value (it is the default `local` name; only `dato` entries
  are read when the value is resolved, and only they contribute to the
  section's requested remote field list).
- `remote` — a **path** into the remote row. A top-level key is the common
  case (`"title"`, `"authors"`, `"physicalDescriptions"`); a nested value is
  written with dots and indexes (`"labels.en.value"`,
  `"items[0].body.value"`), which is what lets a service with a nested payload
  be mapped without any code. A step that does not resolve is a **missing
  value**, not an error.
- `format` *(optional)* — server-side transform applied to the remote value:
    - `array_values` — joins an array remote value with ` | ` (scalars are
      stringified). Empty elements are dropped, and an element that is an
      OBJECT is refused and counted exactly as an unformatted one is — a
      `format` never turns rubbish into a value.
    - `zenon_authors` — flattens the ZENON `authors` object into
      `role: name - name | role: …`. A value that is not an object, or a role
      holding a single text instead of a list of names, is refused and counted.
      In a **search** result (the autocomplete list) the same field renders as
      `zenon_author_names`: the names only, joined ` - `, without the role
      labels — the record keeps them.
    - `zenon_author_names` — the names of every author role joined ` - `
      (`name - name - name`), no role labels; the same refusals as
      `zenon_authors`. Chosen by the engine for search results; it can also be
      declared directly.
    - *(a name the service adapter does not implement)* — REFUSED as a
      configuration error, not silently passed through: the mapping is wrong
      and the cataloguer must see it.
    - *(absent)* — strings, numbers and booleans are used as-is; an array fans
      out into several entries; an OBJECT is refused and counted, because it
      has no canonical text form and guessing one writes `[object Object]`
      into a heritage record.

    A value with no visible text after formatting (an empty or blank string,
    an empty list, an authors object with every role empty) produces **no
    entry** — it is a missing value, like an absent field, not a degraded one.

    Whatever the format, an entry always reaches the wire as a **string**, and
    two ceilings apply: an over-long value is refused (never silently
    shortened — a cut title is a wrong title that looks real) and entries past
    the count ceiling are dropped. Both are counted in `source_status`.

### `api_config` (section node, not the component node)

Read from the **section** ontology node properties; drives the remote call for
all external components in that section:

- `entity` — the key selecting which service adapter handles this section
  (request shape, identifier form, named formats). It must match a registered
  adapter exactly; an unknown key is a loud error, never an empty component.
  Documented entity: `zenon`.
- `api_url` — per-record endpoint, called by the **server**. Its host must be
  in the install's outbound allowlist or the whole binding is refused.
- `api_url_search` *(optional)* — the service's search endpoint, when it has
  one. Server-side external search is not implemented yet (see the status note
  above), so nothing in the engine calls it today.
- `ui_base_url` *(optional)* — the human-facing record page, opened by the
  **browser**; it must be an `http`/`https` address.
- `response_map` — maps remote response keys to local roles. The entry with
  `local === "ar_records"` identifies the array of records in the response.
  The record used is the one whose identifier **matches the one asked for** —
  never simply the first: an answer carrying a different record is treated as
  *not found*, because a confidently wrong value is worse than a reported gap.

!!! danger "A credential never belongs in `api_config`"
    The ontology is editable data. Any credential-shaped key found here is
    stripped and reported rather than used, and stripped again before anything
    reaches a browser. Service credentials live in the install's private
    environment file — see
    [External record services](../system/external_services.md).

!!! note "No standard literal properties"
    `component_external` does **not** use `with_lang_versions`, `unique`,
    `mandatory` or other authoring properties of editable literals — its value
    is read-only and remote-derived. Any other property name not listed here
    should be treated as unsupported (verify in ontology before relying on it).

## Render views & modes

| Mode | Views | Notes |
| --- | --- | --- |
| `edit` | `default`, `line`, `mini`, `print` | Read-only; renders each entry as a `content_value` div (no input). `print` forces `permissions = 1` to use the read-only element. |
| `list` | `default`, `line`, `text`, `mini` | `default` joins entries with ` | ` and, on click, switches the instance to `edit`/`line`. `line`/`text` render an inline `span`. `mini` is used by autocomplete/datalist services. |
| `tm` | (as `list`) | Time Machine read; the JS `tm` renderer is aliased to `list`. |
| `search` | `default` | Renders a `q_operator` text input plus a free-text `value` input that writes back to `data.entries` and publishes `change_search_element`. |

DOM follows the shared structure: `wrapper_component component_external <tipo>
<mode>` → `label`, `buttons` (edit, when `permissions > 1`), `content_data` →
`content_value` nodes. The edit toolbar can show component tools and a
`full_screen` button.

### Entries render as text

An entry is a string a third-party service put in this record, so every view
renders it with `textContent` — it is never parsed as HTML. The one exception
is an entry the server declares as markup in the optional `entries_kind` array
(parallel to `entries`), which it emits only for values it put through its
allowlist sanitizer: bare `b`, `i`, `em`, `strong`, `sub`, `sup`, `br`, `p`,
`ul`, `ol`, `li`, with no attributes at all. No shipped adapter produces markup
today, so the field is absent from every emission and everything renders as
text.

To render formatted values, declare a `fields_map` `format` whose adapter
returns the markup kind; there is no way to opt in from the ontology alone, and
none from the client.

### The degradation marker

When the source is degraded the component renders, after its values, a

```html
<span class="external_source_status state_<state>">…</span>
```

carrying the localized `source_status.label_key`, and a tooltip with the
service, the fetch time when the row is stale, and how many values were
withheld. Every state has its own look, and `stale` (data shown, possibly out
of date) differs from `unavailable` (no data at all) in border style as well as
colour.

!!! warning "An empty external component is never just empty"
    If a `component_external` shows nothing AND no marker, the record really
    has no value there. If it shows a marker, the value could not be derived
    and the marker says why — do not catalogue around it as if the remote
    record were blank.

## Import / export model

**Import: refused, always.** The value is owned by the remote system and has no
local slot, so every cell shape — flat, JSON round-trip, or empty — is refused
per cell with a loud row error, and the record is left untouched. (The empty
cell is refused too: "clearing" a value that does not exist locally would be a
lie in the import report.) The meaningful local datum is the **identifier**,
which is the section's own `section_id`; the external fields render from it on
each load.

**Export:** the flat cell is the component's derived entries, joined like a
literal — a `section_list` column of an external section exports normally. When
the source is unreachable the cell exports empty AND the model is reported in
the export's unresolved list, rather than shipping a silent blank column.

For the generic literal import/export contract and CSV formats, see
[../importing_data.md](../../using/importing_data.md) and
[../exporting_data.md](../../using/exporting_data.md).

## Notes

- **No default tools.** The shipped ontology context exposes `tools: []` for
  this component (no `tool_time_machine`/`tool_lang`/add/replace data tools),
  consistent with its read-only, remote nature.
- **Circuit breaker.** Three consecutive SERVICE failures (no answer, a
  timeout, a 5xx, 429 or 408) open a circuit per (service, remote origin) so a
  dead host is not re-dialled on every page view. An answer about one record —
  a 400 for an id the service rejects, a 404 — never counts: it degrades that
  record to `not_found` and leaves every other lookup alone. It is keyed by
  origin and cleared only by TIME — never per session and never per user (the
  retired engine kept the flag in the session, so one bad response blanked the
  source for a whole login, for one user, across every entity at once).
- **Row cache + coalescing.** Rows are cached with a soft TTL and keyed by
  service, endpoint, section, remote id, data language and the requested field
  set, so several external fields of the same record trigger ONE call. Past
  the soft TTL the last good row is served immediately and a refresh runs
  behind the request — with **no marker**, because the age of a cache entry is
  not a degradation and the service is healthy. Only when a refresh actually
  FAILS is the row it falls back on marked `stale`, and the next successful
  refresh clears that again.
- **Egress control.** The `api_url` host must be in the operator's allowlist
  or the binding is refused; the fully constructed URL is re-checked against
  an SSRF guard and pinned to the vetted address before the fetch. A
  credential never comes from the ontology — any credential-shaped key found
  in `api_config` is stripped and reported.
- **Adding a new service.** Register an adapter under
  `src/external/services/` (request builders, response mapping, formats, id
  shape and an egress classification) and name its key in
  `api_config.entity`. An unknown key THROWS — it never degrades to an empty
  component, because an empty component is indistinguishable from a record
  with no data.
- **No observers/observables** are configured for this component.
- Related component docs: [component_input_text](component_input_text.md)
  (editable literal alternative), [component_text_area](component_text_area.md),
  [component_portal](component_portal.md) (linking to other sections),
  [component_iri](component_iri.md) (external resource locators stored locally).
