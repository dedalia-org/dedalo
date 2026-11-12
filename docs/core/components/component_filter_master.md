# component_filter_master

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
            "view" : "default | line | print",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text | collapse",
            "mode" : "list"
        }
    ],
    "data": "array of locators",
    "sample_data": [
        {
            "id"                  : 1,
            "type"                : "dd675",
            "section_id"          : 1,
            "section_tipo"        : "dd153",
            "from_component_tipo" : "dd170"
        },
        {
            "id"                  : 2,
            "section_id"          : 7,
            "section_tipo"        : "dd153",
            "from_component_tipo" : "dd170"
        }
    ],
    "value": "array of string",
    "sample_value": ["Global project", "Project seven"]
}
```

!!! note "Typology"
    `component_filter_master` is a **related** component. It does not store literal text: its data is an array of [locators](../locator.md) pointing at *project* records. In client context `component_filter_master.js` is a thin alias: `export const component_filter_master = component_filter`, so it reuses the entire `component_filter` UI (the same checkbox tree, the same render/view files).

!!! info "Server implementation"
    The descriptor `src/core/components/component_filter_master/descriptor.ts` registers `resolveData: 'filter'` (`src/core/relations/models/portal.ts`) — the same resolver as `component_filter`, sharing the authorized-projects datalist logic in `src/core/relations/filter_projects.ts` (`getUserAuthorizedProjects()`, `getFilterDatalist()`, `getFilterListValue()`). The datalist is **caller-scoped**: a global admin gets every project record, a non-admin exactly the projects this component declares for it (its `dd170` membership), and an unauthenticated call none. See the *dedalo-relations-ts* skill.

!!! info "About `default_tools`"
    The toolbar is assembled from the model + ontology, never hardcoded. The verified instance (User section `dd170`) exposes `tool_propagate_component_data` and `tool_time_machine` in `context.tools`. Because the component is **non-translatable** (`lang` is forced to `lg-nolan`), it never receives `tool_lang` / `tool_lang_multi`.

## Definition

`component_filter_master` is a sibling model of [component_filter](component_filter.md) — same shared resolver, different job — used **exclusively in the User section** (`dd128`, tipo `dd170`, label *Projects*) to declare which projects a user is assigned to. It is the master list of a user's project membership.

The relationship between the two filter components is the heart of Dédalo's project-based access control:

- **`component_filter`** lives on every catalogued record (a museum object, a person, a place) and assigns *that record* to one or more projects.
- **`component_filter_master`** lives on the *user* and declares which projects *that user* may work in.

When a record is loaded, the projects on its `component_filter` are matched against the projects on the logged user's `component_filter_master` to decide visibility and editability. Both the datalist and list-value resolution of `component_filter` call `getUserAuthorizedProjects()` (`src/core/relations/filter_projects.ts`) to restrict what a user sees and can assign — so `component_filter_master` is the authority that every `component_filter` instance consults.

The same membership rule governs saving both components: a non-admin may only **add** a project they belong to themselves, so a user editor who is not a global admin cannot grant a project they cannot see. See the [component_filter security model](component_filter.md#security-model).

**Why it exists.** A single Dédalo installation is multi-tenant: several research projects (e.g. *Stolen Motherhoods*, an archaeological excavation, a numismatics catalogue) share one ontology and one database, but their records must stay isolated per project and per user. `component_filter_master` is where an administrator records, per user, the set of projects that user belongs to. It is the input to the project permission model.

**When to use it.** Effectively never as a free-standing field you add to an arbitrary section. It is a system component wired into the User section by the core ontology (`dd170`). You interact with it when:

- Administering users: ticking the projects a user can access (the *Projects* field of a user record).
- Reading membership programmatically via `getUserAuthorizedProjects()` (`src/core/relations/filter_projects.ts`).

**When not to use it.**

- To assign an ordinary *record* to projects -> use [component_filter](component_filter.md), not the master.
- To relate a record to any other section in general -> use [component_portal](component_portal.md), [component_select](component_select.md) or a `component_relation_*`.
- It is not a generic many-to-many picker; the target section is fixed to the Projects section (`DEDALO_SECTION_PROJECTS_TIPO`, `dd153`).

## Data model

**Data:** `array of locators`. Each locator points at a project record in the Projects section (`dd153`).

**Value:** `array` of `strings` (resolved project names), or `null`.

**Storage shape.** Like every relation component, `component_filter_master` does not write to the database directly; its section (the User section) persists the locators. The locator carries the relation `type` (`dd675` = `DEDALO_RELATION_TYPE_FILTER`), the target record (`section_tipo` / `section_id`) and `from_component_tipo` (the owning component, `dd170`). `from_component_tipo` is what lets the section's global relations bag be sliced back into this specific component.

```json
[
    {
        "id"                  : 1,
        "type"                : "dd675",
        "section_id"          : 1,
        "section_tipo"        : "dd153",
        "from_component_tipo" : "dd170"
    },
    {
        "id"                  : 2,
        "section_id"          : 7,
        "section_tipo"        : "dd153",
        "from_component_tipo" : "dd170"
    }
]
```

The relation type defaults to `DEDALO_RELATION_TYPE_FILTER` (`dd675`), the descriptor's `defaultRelationType`. The shared relation write engine (`src/core/relations/save.ts`) normalizes each incoming locator, injecting `type` and forcing `from_component_tipo` to the component's own `tipo`, so an entry that arrives without an explicit `type` (see the second item above) is conformed to `dd675` on save. De-duplication is by equality on `section_tipo`, `section_id`, `type` and `from_component_tipo`.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum. For this component the locators are surfaced under `data.entries`, and the edit/search renders also receive a `data.datalist` — the list of *selectable* projects, already filtered to the projects the logged user is authorized for (see [Datalist](#datalist)). `context` carries `tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view` and the `target_sections` array (the Projects section, used to render the "open target section" button). See the *dedalo-context-data-layers* skill for the full layering rules.

### Datalist

In `edit` (and `search`) the option list is built by `getFilterDatalist()` (`src/core/relations/filter_projects.ts`), which calls `getUserAuthorizedProjects()` and sorts the result by label. Each datalist entry is a project descriptor:

```json
{
    "type"         : "project",
    "label"        : "Project Five",
    "section_tipo" : "dd153",
    "section_id"   : 5,
    "value"        : { "section_tipo": "dd153", "section_id": 5, "from_component_tipo": "dd170" },
    "parent"       : { "section_tipo": "dd153", "section_id": 3 },
    "order"        : 2,
    "has_children" : false
}
```

The `parent` / `order` / `has_children` fields let the client render the projects as a collapsible **hierarchical tree of checkboxes** (`render_edit_component_filter.js`), where a project can be nested under a parent project. `parent` is only populated when the parent project is itself an authorized project of the user (`getParentsRecursive()`, `src/core/relations/parent.ts`, consumed by `getUserAuthorizedProjects()` in `src/core/relations/filter_projects.ts`). **Note:** the `FilterDatalistItem` shape currently ships `{type, label, section_tipo, section_id, value, parent, order}` — no `has_children` field yet; verify against the live client contract before assuming byte-parity on that key.

## Ontology instantiation

`component_filter_master` is a core system node already present in the ontology as `dd170`, attached to the User section (`dd128`) under its grouper `dd129`. You normally do not create new instances of it; it is shown here for completeness.

Node definition (shape, matching `samples/context.json`):

```json
{
    "tipo"           : "dd170",
    "model"          : "component_filter_master",
    "parent"         : "dd128",
    "parent_grouper" : "dd129",
    "section_tipo"   : "dd128",
    "lg-eng"         : "Projects",
    "translatable"   : false,
    "properties"     : {}
}
```

Realistic `properties` block (the live instance ships an empty `properties` plus a `css` context block; this component is driven by system constants, not by per-instance options):

```json
{
    "css": {
        ".wrapper_component": { "grid-column": "span 4" },
        ".wrapper_component >.content_data": { "max-height": "none" }
    }
}
```

`section_tipo` / `parent` wire the component into the User section; on save the section is the single writer. Because the component's language is always forced to `lg-nolan`, it is never instantiated per language. The set of *target* projects is not read from `properties` but from configuration constants:

- `DEDALO_SECTION_PROJECTS_TIPO` = `dd153` — the Projects section (the locator target).
- `DEDALO_PROJECTS_NAME_TIPO` = `dd156` — the `component_input_text` that holds the project name (used to resolve `label`).
- `DEDALO_COMPONENT_PROJECT_LANGS_TIPO` = `dd267` — the expected `section_map` of the Projects section (validated before building the authorized list).
- `DEDALO_FILTER_MASTER_TIPO` = `dd170`, `DEDALO_SECTION_USERS_TIPO` = `dd128`, `DEDALO_RELATION_TYPE_FILTER` = `dd675`.

## Properties & options

`component_filter_master` has **no component-specific ontology properties**: its behaviour is fixed by the system constants above, and the live `dd170` node ships an empty `properties: {}`. It honours only the generic context blocks carried into the datum `context`:

- **`css`** — style stamped on the wrapper / `content_data` (the verified instance uses it to set `grid-column: span 4` and `max-height: none`).
- **`request_config`** — RQO context (null on the live instance; the target is resolved from constants, not from an RQO).
- **`view`** — the render view to use (see [Render views & modes](#render-views--modes)).

[component_filter](component_filter.md) documents an optional per-node default-data mechanism (`properties.data_default`); that mechanism has no confirmed implementation in this checkout, and in practice the master instance relies on the global-admin / first-authorized-project fallbacks rather than per-node defaults.

!!! warning "Verify in ontology before relying on a property"
    Any custom key seen on a `component_filter_master` node in a specific installation should be verified in the ontology — the core distribution defines none.

## Render views & modes

Views are taken from `context.view` (default `default`) and dispatched by the shared `component_filter` render files (the master is a client alias of `component_filter`). Verified from the source:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | yes | Hierarchical tree of project checkboxes (`get_content_data`). Edit/search are interactive; list is read-only (a check icon next to assigned projects). |
| `line` | yes | — | — | Compact inline variant of the edit tree (`view_line_edit_filter`). |
| `print` | yes | — | — | Reuses the `default` edit view but forces `permissions = 1` (read-only render). |
| `mini` | — | yes | — | Minimal list output (`view_mini_list_filter`). |
| `text` | — | yes | — | Plain joined value (`view_text_list_filter`). |
| `collapse` | — | yes | — | Collapsible list output (`view_collapse_list_filter`). |

Modes:

- **edit** — interactive checkbox tree. Each toggle goes through `change_handler()` -> `build_changed_data_item()` and **saves on every change** (no batch); at least one project must stay selected (`You must select at least one project`). The *reset* button removes all entries.
- **list / tm** — read-only. `tm` (Time Machine) reuses the list render. The displayed value keeps only the labels of projects that are both in the stored data **and** in the user's authorized projects (`getFilterListValue()`, `src/core/relations/filter_projects.ts`); the rest are discarded.
- **search** — same checkbox tree built by `get_content_data`, but each toggle publishes a `change_search_element` event and updates the instance data instead of saving (used to filter by project membership).

## Import / export model

`component_filter_master` uses the generic relation import/export contract (see [component_check_box](component_check_box.md) for the shared engine).

**Import.** `conformImportData()` (`src/core/tools/import_data.ts`) accepts the JSON locator array:

```json
[{"type":"dd675","section_id":1,"section_tipo":"dd153","from_component_tipo":"dd170"}]
```

!!! warning "Gap: bare section_id shorthand not implemented"
    Because the target section is a single fixed section (`dd153`), a plain `section_id` (or comma-separated list of ids such as `1,5,8`) conformed into locators with `type = dd675` and `from_component_tipo = dd170` would be a natural shorthand — but the generic import engine has no such shorthand today; only the JSON locator array round-trips (see [component_check_box](component_check_box.md) for the same gap verified against the shared import engine).

An empty cell clears the existing data (result `null`). See [importing data](../../using/importing_data.md#related-data).

**Export.** Uses the generic relation export path: each locator resolves to the project name (via the target section's `dd156` name component) and the labels join with the configured separator. See [exporting data](../../using/exporting_data.md).

## Notes

- **Cache invalidation follows membership.** The authorized-projects cache (`src/core/relations/filter_projects.ts`) is keyed by the caller's *membership set* plus the data language, never by the user. Saving `component_filter_master` on a user record (`dd128`) evicts that user's membership cache (`src/core/security/permissions.ts`), and the next datalist read lands on the entry for the new set — the revoked project disappears and a granted one appears at once. A write to the Projects section (`dd153`) itself and the ontology-cache hub clear the whole cache (`clearFilterProjectsCache()`).
- **Propagation disabled.** Unlike `component_filter` — which can cascade a record's project assignment to child portals — changing a user's master membership must **not** propagate as a cascading data change.
- **Security guard (design).** A non-global-admin user should not be able to remove projects they do not have access to: any current locator outside the user's own project set should be preserved on save. Global admins see/assign every project; a non-admin's datalist offers only its own projects.
- **Default tools.** The live instance exposes `tool_propagate_component_data` and `tool_time_machine`; tools are read-only context.
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin); the live instance is set to `3`. Read users (level 1) get the read-only tree; toggling requires level >= 2.
- **Related components:** [component_filter](component_filter.md), [component_portal](component_portal.md), [component_select](component_select.md), [component_check_box](component_check_box.md), [component_relation_parent](component_relation_parent.md), [component_input_text](component_input_text.md).
