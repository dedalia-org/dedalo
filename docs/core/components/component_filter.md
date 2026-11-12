# component_filter

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : false,
    "is_related"            : true,
    "is_media"              : false,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools" : [
        "tool_propagate_component_data",
        "tool_time_machine"
    ],
    "render_views" :[
        {
            "view" : "default | line",
            "mode" : "edit"
        },
        {
            "view" : "default | line | print",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text | collapse",
            "mode" : "list | tm"
        },
        {
            "view" : "default | line",
            "mode" : "search"
        }
    ],
    "data": "array of locators",
    "sample_data": [
        {"type":"dd675","section_tipo":"dd153","section_id":1,"from_component_tipo":"test101"},
        {"type":"dd675","section_tipo":"dd153","section_id":7,"from_component_tipo":"test101"}
    ],
    "value": "array of locators",
    "sample_value": [
        {"type":"dd675","section_tipo":"dd153","section_id":1,"from_component_tipo":"test101"}
    ]
}
```

!!! note "Typology"
    `component_filter` is a **related** component. Like all related components it stores [locators](../locator.md), not literal values, and resolves its display value from a *target* section — here, the **Projects** section (`dd153`).

!!! info "TS server implementation"
    The descriptor `src/core/components/component_filter/descriptor.ts` registers `resolveData: 'filter'` (`src/core/relations/models/portal.ts`) — the portal engine WITHOUT own-config child expansion (filter cells never run subdatum over the project targets, `allowOwnConfigChildren: false`). In `list`/`edit`/`search` modes it resolves the authorized-projects datalist and label strings via `src/core/relations/filter_projects.ts` (`getFilterDatalist` / `getFilterListValue`, over `getUserAuthorizedProjects()`). The datalist is **caller-scoped**: a global admin gets every `dd153` project, a non-admin exactly the projects of its own `dd170` membership (the same set the per-record projects ACL filters by), and an unauthenticated call none. The cache behind it is keyed by that membership *set* plus the data language, so a membership change shows on the next read, with no eviction needed. See the *dedalo-relations-ts* skill.

!!! info "Specialised purpose"
    Unlike a generic relation component, `component_filter` is not a free-form linker. It is Dédalo's **project-based access-control** field. The locators it stores are *project* assignments, the relation type is fixed to `DEDALO_RELATION_TYPE_FILTER` (`dd675`), and saving is gated so that a non-admin user can only assign projects they belong to (see [Security model](#security-model)). Its sibling model [component_filter_master](#relationship-with-component_filter_master) reuses the same machinery to record *which projects a user is allowed to work in*.

## Definition

`component_filter` assigns a section record to one or more **projects** and, through that assignment, controls which users can see and edit the record. Projects live in the Projects section (`DEDALO_SECTION_PROJECTS_TIPO = dd153`); each is a node the cataloguer can attach to a record by ticking a checkbox. A user only sees a record if at least one of the record's project locators is also among the projects that user is authorised for.

**Why it exists.** A cultural-heritage installation is rarely a single flat catalogue. The same Dédalo instance often hosts several independent collections, fieldwork campaigns, or institutional partners that must not see each other's working data. `component_filter` is the mechanism that partitions records into those projects. Every new section record is automatically tagged with at least one project (derived from the creating user's permissions or from the configured default), so no record is ever orphaned and invisible.

**When to use it.**

- A section whose records must be split across access boundaries: *Objects*, *People*, *Archive units* that belong to distinct collections, excavations, or client institutions.
- Any section where editors of one project must be prevented from reading or modifying another project's records.
- As the standard "Projects" / "Access" field a section grows by default; in most installations it is already present on the core resource sections.

**When not to use it.**

- A plain relation to another record that has no access-control meaning -> use [component_portal](component_portal.md) or [component_check_box](component_check_box.md).
- A closed list of descriptive categories the user ticks (typology, technique) -> use [component_check_box](component_check_box.md), which is visually identical but carries no security semantics and points at an ordinary list section.
- Recording which projects a *user* may enter -> that is the User-section variant `component_filter_master` ([see below](#relationship-with-component_filter_master)), not `component_filter`. You do not instantiate `component_filter_master` on ordinary content sections.

## Data model

**Data:** `array of locators`. In server context the locators are persisted in the section's global `relations` container; in client context the datum carries them as `data.entries` alongside a `data.datalist` of selectable projects.

**Value:** `array` of `locators`, or `null`.

**Storage shape.** A component never writes to the database directly; its section does. `component_filter` stores its locators the same way every relation component does — in the matrix `relation` column, an object keyed by component tipo (singular `relation`, never a flat `relations` array). Each locator is a project assignment whose `type` is the filter relation type `dd675`, whose `section_tipo`/`section_id` point at the target project record (in `dd153`), and whose `from_component_tipo` is this component's own `tipo`, so the section can slice this component's subset out of the shared bag.

```json
{
    "relation" : {
        "test101" : [
            {
                "type"                : "dd675",
                "section_tipo"        : "dd153",
                "section_id"          : 1,
                "from_component_tipo" : "test101"
            },
            {
                "type"                : "dd675",
                "section_tipo"        : "dd153",
                "section_id"          : 7,
                "from_component_tipo" : "test101"
            }
        ]
    }
}
```

`component_filter` is **never translatable** (`could_be_translatable: false`). Its language slot is always `DEDALO_DATA_NOLAN`, so the locators carry no `lang`.

!!! note "Client datum: entries + datalist"
    In the API payload the value items are surfaced under `data.entries` (the stored locators, each carrying a per-item counter `id`), and the choosable list under `data.datalist`. Each datalist item is a resolved project: `{type:"project", label, section_tipo, section_id, value:{section_tipo, section_id}, parent, order}`. `parent` lets the client render the projects as a collapsible **tree** (a project can be nested under a parent project); `order` controls sibling ordering before the alphabetical fallback. A record's `entries` are matched against the `datalist` by `section_tipo` + `section_id` to decide which checkboxes start checked. Note the displayed `datalist` is already **filtered to the projects the logged user is authorised for** (`src/core/relations/filter_projects.ts`).

```json
{
    "section_id"          : 1,
    "section_tipo"        : "test3",
    "tipo"                : "test101",
    "mode"                : "edit",
    "lang"                : "lg-nolan",
    "from_component_tipo" : "test101",
    "entries": [
        {"id":1,"section_id":1,"section_tipo":"dd153","from_component_tipo":"test101"},
        {"id":2,"section_tipo":"dd153","section_id":7,"from_component_tipo":"test101"}
    ],
    "datalist": [
        {"type":"project","label":"Global project","section_tipo":"dd153","section_id":1,"value":{"section_tipo":"dd153","section_id":1},"parent":null,"order":0},
        {"type":"project","label":"Project Three","section_tipo":"dd153","section_id":3,"value":{"section_tipo":"dd153","section_id":3},"parent":null,"order":0},
        {"type":"project","label":"Project Four","section_tipo":"dd153","section_id":4,"value":{"section_tipo":"dd153","section_id":4},"parent":{"section_tipo":"dd153","section_id":3},"order":1}
    ],
    "changed_data": []
}
```

## Ontology instantiation

A `component_filter` is created as an ontology node whose `model` is `component_filter`. Its `parent` is the section (or a grouper inside it) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` terms; translatability is irrelevant here because the component is never translatable.

Node definition (shape):

```json
{
    "tipo"         : "test101",
    "model"        : "component_filter",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "Projects",
    "lg-spa"       : "Proyectos",
    "properties"   : { }
}
```

A `component_filter` rarely needs custom `properties` at all: its target section is fixed to the projects section (`dd153`) and its relation type is fixed to `dd675` by the descriptor's `defaultRelationType`. The only meaningful node configuration is the standard CSS layout block:

```json
{
    "css" : {
        ".wrapper_component": { "grid-column": "span 4" }
    }
}
```

`section_tipo` / `parent` tell the section which column owns this component's relation locators; on save the section resolves it and is the single writer to the `relations` container of the matrix row. When a record is created with no project of its own, a default project is seeded — see [Default-project seeding](#default-project-seeding) below.

## Properties & options

`component_filter` consumes very few ontology `properties`; most of its behaviour is fixed by design (target section, relation type) rather than configured. Verified names:

### config_relation.relation_type

- **Values:** a relation-type tipo (object `{"config_relation": {"relation_type": "..."}}`), the generic ontology key every relation component understands.
- **Effect:** for `component_filter` the effective relation type is fixed to `DEDALO_RELATION_TYPE_FILTER` (`dd675`) by the descriptor's `defaultRelationType`. Overriding it is **not** part of this component's contract — leave it unset. Documented here only because the key is generic; verify in the ontology before changing.

### css

- **Values:** an object of selector -> declarations (e.g. `{".wrapper_component": {"grid-column": "span 4"}}`).
- **Effect:** standard layout styling stamped on the component wrapper. Not specific to `component_filter`.

!!! note "No source / request_config"
    Unlike [component_portal](component_portal.md), `component_filter` does **not** read a `source` / `request_config` property to build its option list. The selectable projects are computed server-side from the logged user's authorised projects, so any custom `request_config` on the node is ignored for the datalist. The node's `request_config` is reported as `null` in the context. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched per mode by `render_edit_component_filter.js`, `render_list_component_filter.js` and `render_search_component_filter.js`. The presentation is always a checkbox tree of projects (a nested `<ul>` of `item_li` rows, each with an `item_input` checkbox and an `item_label`); grouper projects with children get a collapsible arrow. Verified from the source:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | yes | Full checkbox tree inside `content_data`; grouper rows are collapsible. In `edit`/`search` the boxes are interactive; in `list` they are read-only ticks. |
| `line` | yes | — | (falls through to default) | Same tree without the full label chrome (compact). Edit-mode `line` view. |
| `print` | yes | — | — | Reuses the `default` edit view but forces `permissions = 1` so the tree renders read-only and the wrapper is tagged `view_print`. |
| `mini` | — | yes | — | Minimal list rendering for tight spaces. |
| `text` | — | yes | — | Plain textual rendering of the selected project labels. |
| `collapse` | — | yes | — | List view that collapses to a fixed height (`view_collapse` CSS) and toggles open on click. |

Modes:

- **edit** — read/write. Ticking a box fires `change_handler()`, which builds a frozen `changed_data` item (`action: insert | remove`) and calls `change_value()` immediately (every change is saved, to recalculate value keys). A guard prevents un-ticking the **last** project: at least one project must stay selected (`"You must select at least one project"`). A **reset** button clears all assignments (with confirmation); an **edit** button opens the target Projects section in a new window.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render. The listed value is the labels of the assigned projects, **restricted to the projects the logged user is authorised for** (others are silently dropped).
- **search** — builds an SQO filter. The same checkbox tree is rendered, plus a `q_operator` text input; ticking a box publishes `change_search_element` rather than saving. Saves are blocked in search mode.

DOM (edit / default): `wrapper_component component_filter <tipo> <mode>` -> `buttons` (no label by default), `content_data` -> `ul.branch` -> one or more `li.item_li` -> `input.item_input` + `label.item_label` (+ nested `ul.branch` for groupers).

## Import / export model

`component_filter` follows the shared **related-data** contract: the import unit is an array of [locators](../locator.md), and the export unit is the resolved project label(s).

**Import.** The default format is the JSON array of filter locators (the target project records). Each locator points at a `dd153` project:

```json
[{"type":"dd675","section_tipo":"dd153","section_id":1,"from_component_tipo":"test101"}]
```

On import the relations engine normalises every incoming locator: it injects `type` (the filter type), forces `from_component_tipo` to this component's own `tipo`, and de-dupes against the locators already stored. Two filter locators are the same when their `section_tipo`, `section_id`, `type` and `from_component_tipo` all match — the one locator-equality rule, `compareLocators()` (`src/core/concepts/locator.ts`). See [importing data — Related data](../../using/importing_data.md#related-data).

!!! warning "Access-control still applies on import"
    Importing does not bypass the write path: a save is gated by the per-record projects scope (`isRecordInScope`, `src/core/security/record_scope.ts`), so an importing user cannot mutate a record outside their own projects. Plan imports with the importing user's project permissions in mind.

**Export.** Like other relation components, the export value is resolved from the target project record — the project label(s), joined for flat output. See [exporting data](../../using/exporting_data.md).

## Notes

### Default-project seeding

Two mechanisms keep a record from being stranded outside every project.

**On creation through a portal's "add new" action.** `applyAddNewElement()`
(`src/core/relations/save.ts`) reads the **host** record's own project filter and
inherits it into the new record's `component_filter`, re-stamping each locator. If
the host carries no project, it falls back to the default-project locator
(`section_tipo: 'dd153'`, `section_id: 1`, `type: 'dd675'`).

**On removing a record's last project.** The delete path
(`src/core/section/record/delete_record.ts`) does not empty a `component_filter`
to `null`: it rewrites it to the configured default project instead, so the record
stays reachable.

The default is configurable: `DEDALO_DEFAULT_PROJECT` (the project `section_id`,
default `1`) and `DEDALO_FILTER_SECTION_TIPO_DEFAULT` (the projects `section_tipo`,
default `dd153`), both read through the typed config catalog in `src/config/config.ts`.

!!! warning "A record created directly is not seeded"
    Only the portal "add new" path inherits a project. A record created directly
    against a section starts with an empty `component_filter`, which means only
    its creator and a global admin can reach it until a project is assigned.

### Security model

The projects filter is a **write boundary as well as a read boundary**. A user who can edit a section may only touch records inside their authorized projects, and every write handler (save, delete, duplicate) asserts this explicitly on the target `section_id` through `isRecordInScope()` (`src/core/security/record_scope.ts`) before it mutates anything. Global admins are unscoped and short-circuit the check. Without that assertion a level-2 user could mutate a record they can never see, so the check is the single implementation reused everywhere and stays identical to list/search enforcement.

**Adding a project is a membership question.** A *new* project locator — on `component_filter` or on [component_filter_master](component_filter_master.md) — must name a project the saving user belongs to, the same set the checkbox list offers. Anything else is refused with `relation.insert_refused` (`details.constraint: "project_not_member"`, HTTP 400) and the whole save is rolled back: nothing stored, no Time Machine row. Global admins are exempt (they are offered every project), and a save with no identifiable user is refused. The check is made in the relation insert door, `src/core/relations/save.ts` (`refuseProjectOutsideMembership`), over `resolveProjectsScope` in `src/core/relations/filter_projects.ts`.

A project the record **already** holds is never re-checked: a colleague's project on a shared record survives every save, including a `set_data` that writes the whole list back.

!!! warning "Removal is not narrowed on save"
    The membership check governs **adding** a project. The submitted locator set is not intersected with the user's own authorized projects on removal, so a non-admin editing a record inside their scope can still remove a project locator they cannot themselves see (for example with the **reset** button, or a `set_data` that omits it). Review this before exposing project-filter saves to non-admin users.

### Relationship with component_filter_master

[`component_filter_master`](#relationship-with-component_filter_master) (tipo `DEDALO_FILTER_MASTER_TIPO = dd170`) reuses the same machinery as `component_filter`. It is used exclusively in the User section (`DEDALO_SECTION_USERS_TIPO`) to record *which projects a user may access* — the very data that `component_filter` then enforces on content records. Key differences: its target section is the Users section, saving it clears the per-user authorised-project caches immediately (so permission changes take effect right away), and it disables filter propagation. The authorised-projects resolution (`getUserAuthorizedProjects()`, `src/core/relations/filter_projects.ts`, cached) is the source of truth that ordinary `component_filter` instances consult to build their datalist and to enforce access.

### Other notes

- **Sortable.** The component is sortable: its descriptor declares no `sortable: false` opt-out, and sortability defaults to true (`resolveSortable()`, `src/core/resolve/structure_context.ts`). Its order path (`buildOrderPath()`, `src/core/search/order_path.ts`) is a two-step path, so a list can be ordered by the project **name** field (`DEDALO_PROJECTS_NAME_TIPO = dd156`, a `component_input_text` in `dd153`).
- **Default tools.** A typical instance exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools` (verified from the context sample). Tools are read-only context, assembled from the model + ontology; the model does not hardcode them.
- **Observers / observables.** None are wired for this component; observer/observable behaviour, when needed, is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section).
- **Related components:** [component_check_box](component_check_box.md) (same checkbox UI, no security), [component_portal](component_portal.md), [component_dataframe](component_dataframe.md). See also the typology index in [components](index.md).
