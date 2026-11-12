# component_filter_records

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
        "tool_time_machine"
    ],
    "render_views" :[
        {
            "view"    : "default | line | print",
            "mode"    : "edit"
        },
        {
            "view"    : "default | mini | text",
            "mode"    : "list | tm"
        },
        {
            "view"    : "default",
            "mode"    : "search"
        }
    ],
    "data": "array of entries",
    "sample_data": [
        { "id": 1, "tipo": "mdcat3112", "value": [1, 8, 9] },
        { "id": 2, "tipo": "rsc202", "value": [8, 150, 201] },
        { "id": 3, "tipo": "oh1", "value": [1, 3, 4] }
    ],
    "value": "array of entries",
    "sample_value": [
        { "id": 1, "tipo": "mdcat3112", "value": [1, 8, 9] }
    ]
}
```

!!! note "Classifier flags"
    `could_be_translatable`, `is_literal`, `is_related` and `is_media` are client-model
    classifiers derived from the component typology, not stored datum fields. As a
    *literal-direct* component, `component_filter_records`
    is literal (`is_literal: true`), it is not a relation locator (`is_related: false`),
    not media (`is_media: false`), and not translatable
    (`could_be_translatable: false`): its single static instance is loaded under
    `DEDALO_DATA_NOLAN`.

## Definition

`component_filter_records` manages **record-level access control**: it stores, per target
section, the explicit list of record ids (`section_id`s) a given user is allowed to access.
It is a configuration component used **exclusively inside the Users section** (`dd128`),
where each user record carries one instance of it (the standard tipo is `dd478`,
`DEDALO_USER_COMPONENT_FILTER_RECORDS_TIPO`).

Dédalo already restricts access through **areas/projects** (see `component_filter` and
`component_filter_master`). Those grant or deny a user a *whole section/area*.
`component_filter_records` exists to provide a **finer grain**:
within a section the user is otherwise authorized for, restrict visibility down to a specific
set of record ids — regardless of project assignment.

**The restriction is live: there is no feature flag to turn it on.** Whenever the logged
user's stored datum names the section being searched, the search adds a
`section_id IN (...)` restriction for that section. A user with no entry for a section —
the overwhelmingly common case — searches it exactly as before, with a byte-identical
query.

!!! warning "Saving an allow-list takes effect immediately"
    There is no staging step and no global switch: the moment an entry is saved on a user
    record, that user's next search of the named section is restricted. Clear the row (empty
    the input) to remove the restriction — an entry saved with an **empty** id list is read
    as *no restriction*, never as *sees nothing*. The restriction applies to global admins
    too, so an allow-list written onto an administrator's own account restricts that
    administrator.

**When to use it**

- A cataloguer should only see a handful of records of a section (e.g. only the 12
  archaeological objects on loan to their institution), even though they have read/write
  permission on that whole section.
- A reviewer is granted access to a curated subset of `oh1` (Oral History) records for
  a temporary campaign, without touching their project membership.

## How it works — a plain-language guide

This part is for administrators who manage user accounts. No technical knowledge is
needed.

### What the component does

Open a user's record (menu *Users*) and you find the **Records filter** field. It is a table
with one row per section (a section is a kind of record: *Oral History*, *Image*,
*Numismatic object*…). In each row you may type record numbers separated by commas.

- **Row left empty** → no restriction. The user sees every record of that section their
  profile and projects already allow.
- **Row with numbers** → the user sees **only** those records of that section, and nothing
  else in it.

*Example.* Ana is a volunteer transcribing three interviews. In Ana's user record, in the
row **Oral History** (`oh1`), you type `12,15,40`. From her next search on, Ana finds only
the interviews with Id 12, 15 and 40. The other sections are not affected.

### Which sections appear in the list

The list does **not** show every section of the installation, and it does **not** depend
on the user you are editing. It is built from the profile of **the person who is logged
in** — you, the administrator filling the form. The idea: you can only narrow access to
sections you are allowed to work on yourself.

A section appears when **all** of these are true:

1. Your user has a **profile** (field *User profile* in your own user record).
2. In that profile (menu *Profiles*, field *Permissions*), **the section itself** is
   ticked — not only some of its fields.
3. Its level is **read and write** (2) or higher. Read-only is not enough.
4. It is a real section. Menu groups and areas never appear.

The rows are shown in order of their code (`tipo`), for example `numisdata3`,
`numisdata4`, `oh1`, `rsc170`.

*Example (codes from a numismatic installation).* María administers the accounts. Her
profile gives her:

| Section | What María's profile ticks | In María's list? |
| --- | --- | --- |
| Numismatic object (`numisdata4`) | the section, read and write | **Yes** |
| Image (`rsc170`) | the section, read only | No — read only |
| Type (`numisdata3`) | some fields, but not the section box | No — section not ticked |

María now edits Ana's account. Ana's profile (*Editor*) has full access to **Type**
(`numisdata3`). Even so, **Type is not in the list**: what counts is María's profile, not
Ana's.

!!! tip "Why is section X missing from my list?"
    Check **your own** profile, not the edited user's:

    - Does your user record have a profile? A user without a profile — **root included** —
      sees an empty list.
    - In that profile's permissions, is the **section** itself ticked (not just its
      fields)?
    - Is it at least **read and write**?

    Fix the profile, then reload the user record: the section appears.

!!! note "root follows the same rule"
    Being root does not show every section. root's list comes from root's own profile like
    anyone else's.

### Working with a long list

- **Filter box** (top): type part of a code or a section name — `numis`, `oral` — and
  only the matching rows stay. The counter on the right shows how many match
  (`4 / 41`).
- **Column headers**: click **Tipo**, **Section** or **Value** to sort by that column; click
  again to reverse the order. Sorting by **Value** brings the rows that already have record
  numbers to the top (empty rows always stay at the bottom) — the quickest way to review
  which restrictions a user has.
- **Help icon** (ⓘ, top right of the field): opens this page.

**When *not* to use it**

- To grant or deny access to an entire section/area — use the project filter components
  (`component_filter` / `component_filter_master`) instead.
- As a normal data field in cataloguing sections. This is a permissions/configuration
  component; it only makes sense inside the Users section.
- As the *only* barrier around sensitive records. It narrows what a user can reach through
  the search path; it is one restriction ANDed on top of the section grant and the project
  filter, not a replacement for either.

## Data model

**Data:** `array` of entry objects.

**Value:** `array` of entry objects (same shape as `data`), or `null`.

**Storage:** the component stores its data in the matrix **`misc`** column (a *direct
object*, not a relation locator). It is **not** translatable, so there is a single instance
under `DEDALO_DATA_NOLAN` and no per-language rows.

Each entry pairs a target **section `tipo`** with the array of allowed **`section_id`s** for
that section, plus the standard counter-assigned `id`:

```json
[
    { "id": 1, "tipo": "mdcat3112", "value": [1, 8, 9] },
    { "id": 2, "tipo": "rsc202",    "value": [8, 150, 201] },
    { "id": 3, "tipo": "oh1",       "value": [1, 3, 4] }
]
```

- `id` — counter-assigned entry id, used to target `update`/`remove` operations on the item
  array.
- `tipo` — the target section ontology tipo the restriction applies to.
- `value` — array of integer `section_id`s the user may access in that section. Client-side
  the input is validated to **positive, de-duplicated integers**; search mode keeps the raw
  comma split until saved.

In the JSON-API datum the array is delivered under the `data` item's **`entries`** property,
and in `edit` and `search` modes the resolved list of authorized sections is attached as
`datalist` (see below). `list` and `tm` carry **no `datalist` key at all** — those views read
only the stored entries.

**Consumption shape.** The search layer reads the stored `entries` array into a map keyed by
section tipo (`section_tipo` → id array) before it can restrict anything; that reader is
`getUserFilterRecords()` (`src/core/security/filter_records.ts`). It is deliberately strict,
because every id it returns reaches SQL as an integer literal:

- an entry with no `tipo` names no section and contributes nothing (legacy data does carry
  these, with a nested `{tipo, value}` payload under `value`);
- ids are coerced to integers and kept only when positive; anything else is dropped;
- an entry whose id list ends up **empty** is skipped — it is *no restriction*, not a lockout;
- two entries for the same section (only reachable from hand-edited data) are **unioned**.

The result is cached per user and dropped whenever any Users-section record is written, so an
edited allow-list applies to the next search.

## Ontology instantiation

Define the node like any other component, declaring its `model`, `tipo`, `parent` (the
section it lives in) and the language descriptors. Because it is non-translatable, it is
instantiated under `lg-nolan`.

Node definition (the canonical placement is the Users section `dd128`, tipo `dd478`):

```json
{
    "tipo"          : "dd478",
    "model"         : "component_filter_records",
    "parent"        : "dd128",
    "section_tipo"  : "dd128",
    "lg-eng"        : "Filter records by id",
    "translatable"  : false
}
```

Minimal/empty `properties` block (this component takes no required ontology properties):

```json
{
    "properties": {}
}
```

`section_tipo`/`parent` wire the component into its owning section. The TS server has no
per-component factory to call: the descriptor at
`src/core/components/component_filter_records/descriptor.ts` (`column: 'misc'`, no
`classSupportsTranslation` flag) resolves through the same generic
`src/core/resolve/component_data.ts` as any other literal component, and the
authorized-sections datalist is built by `getFilterRecordsDatalist(userId, lang)`
(`src/core/api/handlers/filter_records_datalist.ts`), attached by the model's emit hook
(`src/core/components/component_filter_records/emit.ts`).

## Properties & options

This component defines **no bespoke ontology properties**. Its `properties` block is normally
empty (`{}`), as shown in the shipped sample context. Behaviour is driven by:

- the **`datalist`** — *not* an ontology property, computed server-side by
  `getFilterRecordsDatalist()` (`src/core/api/handlers/filter_records_datalist.ts`, built from
  `getAuthorizedAreasForUser()`, `src/core/security/permissions.ts`). It lists every section
  the logged user is authorized for, keeping only areas whose `model === 'section'` and whose
  permission `value >= 2` (write or higher), resolving each section label from the ontology and
  sorting alphabetically by label (the `edit` view re-orders the rows by `tipo`). Only
  **self-keyed** grants count — a `dd774` entry whose `section_tipo` and `tipo` are both the
  section; grants on the section's components alone do not list it. Each datalist item is
  `{ tipo, permissions, label }`.
- the **stored datum itself** — there is no config key. The presence of an entry for a section
  IS the switch; see [Definition](#definition).

!!! note "The datalist is the EDITOR's list, not the edited user's"
    It is resolved from the *logged* user's own authorized areas, so it describes what the
    person filling the form may restrict. Editing another user's record does not widen it: a
    section the editor cannot administer cannot be given a restriction here.

The standard generic component properties (e.g. `mandatory`, `css`, `request_config`) may be
attached through the ontology node like any component; none are specific to or required by
`component_filter_records`. If you need behaviour beyond the above, *verify in ontology*.

## Render views & modes

The client model wires modes to renders in `js/component_filter_records.js`
(`edit`, `list`, `tm` → `list` render, `search`). The views actually present in the source:

| Mode | View | Source | Behaviour |
| --- | --- | --- | --- |
| `edit` | `default` | `view_default_edit_filter_records.js` | Grid (`tipo` / section label / value input). One editable comma-separated id input per authorized section from the `datalist`. A sticky head carries a filter box (matches `tipo` or label, with a match counter) and the `tipo` / `Section` / `Value` header; `tipo`, `Section` and `Value` sort on click (`Value` reads the live input, numeric-aware, empty rows always last) (initial order: `tipo` ascending, numeric-aware). An ⓘ link pinned top-right of the wrapper opens this page. |
| `edit` | `line` | `view_default_edit_filter_records.js` | Same render as `default`, label removed (compact inline). |
| `edit` | `print` | `render_edit_component_filter_records.js` | Same render as `default` but forced read-only (`permissions = 1`): rows render through `get_content_value_read`, only entries present in the value are shown. |
| `list` / `tm` | `default` | `view_default_list_filter_records.js` | Read-only string: each entry serialized as JSON, joined by `context.fields_separator`. |
| `list` / `tm` | `mini` | `view_mini_list_filter_records.js` | Minimal wrapper, same JSON-joined string. |
| `list` / `tm` | `text` | `view_text_list_filter_records.js` | Plain `span`, entries serialized as JSON, newline-separated. |
| `search` | `default` | `render_search_component_filter_records.js` | One text input per authorized section; on change publishes `change_search_element` (raw comma split, no integer validation). |

`tm` (Time Machine) reuses the `list` render. The shared change logic lives in
`change_handler()` / `build_changed_data_item()` in the client model: in `edit` it saves on
every change (`change_value`), in `search` it updates the instance and publishes the search
event.

!!! note "Permission-aware edit render"
    In `edit`, when `permissions === 1` the view renders only the stored entries read-only;
    with write permission (`> 1`) it renders one editable input per authorized section and
    exposes the toolbar buttons (tools + fullscreen).

## Import / export model

`component_filter_records` defines no import, export or diffusion handling of its own — it
goes through the shared engines like any other literal component. Its data is a plain JSON
array of entries, so import/export use that array directly:

```json
[
    { "id": 1, "tipo": "mdcat3112", "value": [1, 8, 9] },
    { "id": 2, "tipo": "rsc202",    "value": [8, 150, 201] }
]
```

Because this is a configuration component living in the Users section, it is rarely part of
ordinary catalogue import/export flows. See the general
[importing data](../../using/importing_data.md) and [exporting data](../../using/exporting_data.md) docs for the
shared component contract (the `dedalo_data` wrapper, atoms, NDJSON flat-table protocol).

## Notes

- **Typology:** literal-direct component (data column `misc`). The TS server has no class
  hierarchy — `src/core/components/component_filter_records/descriptor.ts` declares
  `column: 'misc'`. It is *not* a relation component despite pointing at section records — the
  targets are stored as bare integer ids inside `value`, not as locators.
- **Default tools** (from the shipped `context.json`): `tool_propagate_component_data` and
  `tool_time_machine`. Saves are recorded in Time Machine like any component
  (`tm` mode is read-only).
- **Server entry point — enforcement.** `getUserFilterRecords()`
  (`src/core/security/filter_records.ts`) reads the logged user's datum, and the search
  assembler (`src/core/search/sql_assembler.ts`) turns it into one `section_id IN (...)`
  predicate ANDed into the query it builds. Because the per-record scope check runs that same
  assembler, the restriction covers the list, the row count, every branch of a multi-section
  search and the "may this principal open this record" probe — one predicate, every door. A
  multi-section search gates only the branches the datum names; sibling sections pass through
  untouched.
- **Datalist source:** `getFilterRecordsDatalist()`
  (`src/core/api/handlers/filter_records_datalist.ts`) depends on the *logged user's*
  authorized areas, so the set of selectable sections in `edit`/`search` reflects current
  permissions, filtered to sections with write-or-higher access (`value >= 2`).
- **Observers/observables:** none configured for this component.
- **Read path — one attachment point.** The datalist is attached by the model's emit hook
  (`src/core/components/component_filter_records/emit.ts`), which runs inside the shared
  emission (`src/core/section/read.ts`, `emitDdoData`). The full-section read and the
  component-level `get_data` therefore serve the *same* key: `edit`/`search` carry the
  authorized-sections list, `list`/`tm` carry no `datalist` key. Identity comes from the
  request-scoped principal; a call with no principal (no request scope — timer/scheduler
  work, a unit harness) gets an empty array rather than somebody else's sections. A
  background job is not that case: it runs under its submitter's principal, snapshotted at
  submit, so it serves the submitter's list.
- **Search-panel instances.** A filter row in the search panel addresses no record (its
  `section_id` is a client-minted `search_<n>` sentinel). The component still answers with its
  own item — empty `entries`, full `datalist`, the sentinel id echoed verbatim — because the
  search render iterates `datalist` unconditionally and an absent item would leave the row
  unrendered.
- **Related components:**
  `component_filter` and `component_filter_master` (project/area-level access),
  `component_security_access` (also stored in `misc`), and
  [component_portal](component_portal.md) (relation-based linking, by contrast).