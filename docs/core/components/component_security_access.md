# component_security_access

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
            "mode"    : "list"
        }
    ],
    "data": "array of permission objects",
    "sample_data": [
        {"id": 1, "tipo": "rsc197", "section_tipo": "rsc197", "value": 2},
        {"id": 2, "tipo": "rsc85",  "section_tipo": "rsc197", "value": 2},
        {"id": 3, "tipo": "rsc261", "section_tipo": "rsc197", "value": 1}
    ],
    "value": "array of permission objects",
    "sample_value": [
        {"id": 1, "tipo": "rsc197", "section_tipo": "rsc197", "value": 2}
    ]
}
```

!!! note "Atypical literal component"
    Unlike most literal components (whose value is an array of scalar strings keyed by lang), `component_security_access` stores an **array of permission objects**. It is a non-translatable, direct literal component — it owns and saves its own data — but the payload is a flat permission matrix, not a list of localized strings. The component is registered as single-value at the section level: one permission set per profile record.

## Definition

`component_security_access` is the access-control component of Dédalo. It stores, for a single security profile, the **permission level the profile holds over every reachable ontology element** (areas, sections, section groups, components, buttons, relation lists, etc.). It is the data backbone of role/profile-based security: when a user logs in, their profile's `component_security_access` data is read to build the permission table that gates every read, write and admin operation across the application.

It lives in the **Profiles** section (`dd234`) as component tipo `dd774` (`DEDALO_COMPONENT_SECURITY_ACCESS_PROFILES_TIPO`). Each profile record carries one instance whose data answers the question *"what may this profile do with each part of the ontology?"*.

The editing UI renders the whole ontology as an expandable tree. Each node exposes a set of radio buttons for the four permission levels:

| value | level |
| --- | --- |
| 0 | no access |
| 1 | read only |
| 2 | read and edit |
| 3 | admin (full control) |

Areas and sections do not store permissions themselves; they **derive and propagate** a calculated permission from the combination of their children's values (a parent shows a level only when all its children share it). Only the leaf nodes inside sections (components, buttons, groupers) carry stored permission rows.

**Why it exists.** Dédalo follows the standard schema: state lives in sections/components, never in bespoke tables. Security is no exception — profiles are ordinary section records and their permission map is an ordinary component datum. This keeps permissions versioned in Time Machine, propagable, and importable/exportable like any other component.

**When to use it.** Only inside the Profiles section to define what a profile may access. In a cultural-heritage installation, a typical profile might grant:

- `value: 2` (read+edit) over the *Archaeological objects* section and its description fields,
- `value: 1` (read only) over the linked *Thesaurus* sections so cataloguers can pick terms but not edit the controlled vocabulary,
- `value: 0` (implicit, simply absent) over the administration area,
- `value: 3` (admin) for a curator profile that manages section structure.

**When not to use it.** Never as a generic field in domain sections. It is not a data-entry widget for object metadata; it is the security configuration surface. To restrict a *single* record (not a whole profile) use the projects/filter machinery instead.

## Data model

**Data:** `array` of permission objects, or `null`.

**Value:** `array` of permission objects, or `null`. (For this component, *data* and *value* coincide — there is no per-lang split because the component is non-translatable.)

**Storage:** the persisted unit is the standard datum `{context, data}`; the values live in `data`. In the matrix table the data column for `component_security_access` is **`misc`** (`data_column_name = 'misc'`). The stored array is a flat list of permission rows, each carrying the standard counter `id`, the target element `tipo`, the owning `section_tipo`, and the integer permission `value`:

```json
[
    {"id": 1, "tipo": "rsc197", "section_tipo": "rsc197", "value": 2},
    {"id": 2, "tipo": "rsc85",  "section_tipo": "rsc197", "value": 2},
    {"id": 3, "tipo": "rsc261", "section_tipo": "rsc197", "value": 1},
    {"id": 4, "tipo": "rsc170", "section_tipo": "rsc170", "value": 2}
]
```

Each row reads as: *"this profile has permission `value` over element `tipo`, located in section `section_tipo`."* When `tipo === section_tipo` the row is the section (or area) itself; otherwise it is a leaf element belonging to that section.

!!! note "Non-translatable, no lang split"
    The component is instantiated with `lang = lg-nolan` and `translatable: false`. There is no `lg-spa` / `lg-eng` variant of the permission matrix — a single map applies across all languages.

!!! note "Zero values are not persisted"
    Rows whose `value` is `0` (no access) are **not** saved. The client builds a full `filled_value` array (every datalist node, defaulting absent ones to `0`) for the UI, but on save (`save_changes()`) it strips every `value <= 0` entry before persisting. Absence of a row therefore means *no access*.

### Datalist (the tree), not stored

In `edit` mode the datum also ships a `datalist`: the complete ontology hierarchy (areas → sections → elements) used to render the tree. This is **derived, not stored data** — it is computed by `getSecurityAccessDatalist()` (`src/core/resolve/security_access_datalist.ts`) and is identical for all profiles (permissions differ, the tree does not). Resolving it is expensive (measured ≈3–6 s); there is currently no per-language cache for it, so the tree is recomputed on every read. Each datalist item carries its full parent chain in `ar_parent`, letting the client resolve children/parents (and propagate values up the tree) without re-walking the ontology:

```json
{
    "tipo"        : "rsc85",
    "section_tipo": "rsc197",
    "model"       : "component_input_text",
    "label"       : "Title",
    "parent"      : "rsc76",
    "ar_parent"   : ["rsc197", "rsc76"]
}
```

!!! danger "Gap: the datalist covers only the GLOBAL-ADMIN (unfiltered) branch"
    The intended full behavior narrows the returned **area list** to the areas
    present in a caller's own security-access data for non-global-admin
    callers. `security_access_datalist.ts` implements **only** the
    global-admin/unfiltered branch — its own module header records this as
    a ledgered gap: *"This port implements ONLY the global-admin / unfiltered
    branch, because the TS read path currently runs as admin/root. A future
    ACL-threading pass must pass the principal here and filter `getAreas` to
    the areas present in the user's own security-access data."* Until that
    lands, requesting this datalist as a non-admin principal returns the
    full unfiltered tree rather than one narrowed to the caller's own access.

## Ontology instantiation

`component_security_access` is a singular core component: in a stock install there is one instance, `dd774`, wired into the Profiles section `dd234`. You normally do not create new instances; the node already exists. The node definition looks like:

```json
{
    "tipo"          : "dd774",
    "model"         : "component_security_access",
    "parent"        : "dd234",
    "parent_grouper": "dd1718",
    "lg-eng"        : "Permissions",
    "lg-spa"        : "Permisos"
}
```

Wiring into the section:

- `parent` / `section_tipo` is the **Profiles** section `dd234`.
- `parent_grouper` places it inside a section group of the profile edit view.
- The security subsystem binds to this node through the named constants `PROFILES_SECTION` and `SECURITY_ACCESS_COMPONENT` (`src/core/security/permissions.ts`, values `dd234` / `dd774`; `src/core/tools/ontology_map.ts` also names the profiles section as `PROFILE_SECTION_TIPO`). `src/core/section/read.ts` additionally matches on the literal model string `component_security_access` to trigger direct datalist emission for this node.

Realistic `properties` block — in practice **empty**:

```json
{}
```

The component is configuration-free in the ontology: it consumes no special properties of its own. Its behavior (tree shape, exclusions, permission levels) is derived from the live ontology and from the section's own structure, not from per-node properties. Only the generic, shared context applies (e.g. an optional `css` block). What it *does* read from the ontology is structural, resolved at runtime while the datalist tree is walked:

- **`exclude_elements`** — a relation on the *target* section being walked. If a section declares an `exclude_elements` child, the elements it lists are dropped from that section's permission tree (they will never get a permission row).
- A section's `source.request_config` `show.ddo_map` (v6-style virtual sections) is honored to enumerate the virtual components shown for permissioning.

Hard-coded structural exclusions (not configurable via properties) are also applied while walking: models `component_security_administrator`, `section_list`, `search_list`, `component_semantic_node`, `box_elements`, `exclude_elements`, `edit_view`, plus any tipos listed in the install constant `DEDALO_AR_EXCLUDE_COMPONENTS`. The whole **Admin** area and its children are likewise excluded from the tree.

## Properties & options

This component defines **no component-specific ontology properties**. In stock installations `properties` is `{}` and the read path only inspects the generic `unique` flag (shared by all components) to decide whether to attach a search RQO — it is not meaningful for security access and is not used in practice.

| property | accepted values | default | effect |
| --- | --- | --- | --- |
| `css` | object | `null` | Generic, common-level style block stamped into `context.css` (e.g. `grid-column` span). Not specific to this component. |

!!! warning "Do not invent properties"
    There are no `permission_levels`, `tree`, `exclude`, etc. properties on this component. Tree construction and exclusions are driven by **ontology structure** (the section's own children, its `exclude_elements` relation, and the global exclude lists), not by node properties. If you think you need a new property here, verify in the ontology and against the datalist builder (`src/core/resolve/security_access_datalist.ts`) first.

The values consumed at runtime that *behave like* configuration but originate elsewhere:

| source | where it lives | effect |
| --- | --- | --- |
| `exclude_elements` relation | on each walked **section** node | removes the listed elements from that section's permission tree |
| `DEDALO_AR_EXCLUDE_COMPONENTS` | install config constant | globally removes the listed tipos from the tree |
| Admin area (`area_admin`) | ontology | the admin area and its descendants are never shown for permissioning |

## Render views & modes

The client (`component_security_access.js`) maps modes to renderers as follows:

| mode | renderer | views |
| --- | --- | --- |
| `edit` | `render_edit_component_security_access` | `default`, `line`, `print` (all routed to `view_default_edit_security_access`; `print` forces read-only by setting `permissions = 1`) |
| `list` | `render_list_component_security_access` | `default`, `mini`, `text` |
| `tm` | (same as `list`) | `default`, `mini`, `text` |
| `search` | `render_search_component_security_access` | `default` (placeholder — search UI is minimal) |

- **edit** is the rich view: the ontology tree is rendered as nested `ul`/`li`, each node showing radio buttons for permission levels (color-coded in CSS: `val_0` red, `val_1` orange, `>=2` green). Selecting a value on a node propagates up the parent chain (`update_parents_radio_butons`) and a `button_save` (sticky) commits the change. A side `changes_container` can display schema change files. A **tree filter** above the tree narrows it to the entries whose *label or tipo* match, keeping each match's ancestor path, opening the branches on the way down and highlighting the matching rows (`security_access_filter.js`; the counter reports the real number of reachable matches, at most 500 of them are drawn). Matching is per *entry*, not per tipo — a section group shared by many sections appears once per section. Filtering is visual only: permission values, and every propagation walk, always read the full datalist, so a global radio set while a query is active still grants the whole subtree.
- **list / tm** views are intentionally austere — the raw permission matrix is not human-friendly, so `view_default_list_security_access` renders the placeholder string `"View list unavailable"`. The Time Machine mode reuses the list renderer.
- **search** mode renders a placeholder (`"Working here! (search mode)"`); saving is blocked in search mode at the component level. The Profiles section is not filtered by search: the descriptor declares no `searchBuilder` and this is not a relation model, so `src/core/search/conform.ts` throws (`model 'component_security_access' declares no searchBuilder family and is not a relation model — unsearchable through conform`) rather than applying a row filter.

!!! note "Web worker for tree math"
    `init()` registers `worker_security_access.js`. The recursive `get_children` / `get_parents` walks over the (potentially large) datalist are offloaded to this worker to keep the UI responsive while propagating permission values across the tree.

## Import / export model

`component_security_access` declares no import or export handling of its own, so it goes through the generic engines like any other literal component. The import/export unit is the JSON of its `data` — the array of permission objects:

```json
[
    {"id": 1, "tipo": "rsc197", "section_tipo": "rsc197", "value": 2},
    {"id": 2, "tipo": "rsc85",  "section_tipo": "rsc197", "value": 2},
    {"id": 3, "tipo": "rsc261", "section_tipo": "rsc197", "value": 1}
]
```

Because the meaning of each row depends on live ontology tipos, importing a permission matrix is only sound between installations that share the same ontology tipos. The canonical JSON-array-of-objects shape imports through the generic engine (`conformImportData()`, `src/core/tools/import_data.ts`) without any component-specific handling needed. Permission data is not expected to be published to diffusion targets; no `component_security_access` handling was found under the diffusion engine's source tree, and this has not been independently verified for this pass.

See the full import model in [importing data](../importing_data.md) and the export model in [exporting data](../exporting_data.md).

## Notes

- **Single source of truth for permissions.** The stored matrix feeds the runtime permission table: `src/core/security/permissions.ts` reads a caller's grants straight from the `dd774` datum in their profile record (`dd234`, via the profile-select `dd1725`), with its own per-user cache (`clearPermissionsCache`). Editing the matrix itself requires admin-level access.
- **`setSectionPermissions()`.** The programmatic entry point used when generating hierarchies for users (grants a profile a permission over a list of section tipos *and all their children*) is `setSectionPermissions()` in `src/core/security/section_permissions.ts`. It resolves the user's profile (`dd1725` → `dd234`), expands each section to its elements through the same recursive ontology walk the ACL tree uses (`getGrantChildrenTipos()`), merges into the existing `dd774` matrix (an existing `(tipo, section_tipo)` pair is updated in place, never duplicated), and writes through the normal save chokepoint — so the grant is Time-Machine audited and invalidates the permissions cache (`clearPermissionsCache`). Default level `2`; `0` is accepted.
- **Tree logic without a file cache.** `src/core/resolve/security_access_datalist.ts` reproduces the tree-building algorithm (see the gap note under [Ontology instantiation](#ontology-instantiation) regarding the non-admin filtering branch), but there is no per-language file cache — the tree is recomputed on every request.
- **Not sortable.** This component's list columns are never sortable: the descriptor declares `sortable: false`, and `resolveSortable()` (`src/core/resolve/structure_context.ts`) honors it directly.
- **Default tools** (from `context.tools`): `tool_propagate_component_data` (copy a profile's permission set to other records) and `tool_time_machine` (permission changes are versioned like any other save). No `tool_lang` — the component is non-translatable.
- **Observers/observables:** none configured; permission propagation happens entirely client-side across the tree via `event_manager` topics (`update_item_value_*`, `update_area_radio_*`), not through the ontology observer mechanism.
- Related components: this is a literal-direct component like [component_input_text](component_input_text.md) and [component_number](component_number.md); for relational components see [component_portal](component_portal.md). Permission *levels* (0–3) are documented in [the components index](index.md#permissions).
