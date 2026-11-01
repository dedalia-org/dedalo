# area

> An area is a top-level grouping in the back-office menu — Resources, Activity,
> Admin, Thesaurus, Ontology, Maintenance, Development, Tools, Root. It is an
> *ontology node*, not a table: it holds no records, only structure, permission
> context and an aggregated dashboard over its descendant sections.

> See also: [Areas](index.md) · [Architecture overview](../architecture_overview.md) ·
> [Sections](../sections/index.md) · [Menu](../ui/menu.md) ·
> [Ontology](../ontology/index.md)

This page is the reference for the `area` model and for the area family as a
whole: what an area is, how the engine decides what an area *does*, how the menu
walk and the dashboard walk differ, and what a dashboard payload contains.

## Role

An area is a **top-level menu grouping**. Each area is an ontology node whose
`model` is `area` or a model-name variant (`area_root`, `area_admin`,
`area_thesaurus`, …).

An area is **not** backed by a `matrix` table and owns no records of its own. It
is a structural node that *contains* sections and sub-areas as ontology
children. Areas anchor three things:

- the **menu tree** — areas are the top-level nodes; sections and sub-areas are
  their children, resolved through the ontology parent/children graph rather
  than a fixed map (see [Menu](../ui/menu.md));
- **permission scoping** — an area is a node over which permissions are
  evaluated, even though it carries no record id;
- the **dashboard** — the aggregated statistics view over an area's descendant
  sections.

## Where the engine lives

The area family has no per-model object. It is one **pure contract module** plus
a small set of I/O-bearing resolvers:

| module | what it owns |
| --- | --- |
| `src/core/concepts/area.ts` | The contract. The canonical model list, the behavior taxonomy, the two walk-filter sets, the menu root order and the area `tipo` constants. No I/O. |
| `src/core/area/read.ts` | The read dispatcher (`dispatchAreaRead`) and the write refusal (`refuseAreaWrite`). |
| `src/core/area/dashboard.ts` | The statistics engine (`getDashboardChildSections`, `getDashboardData`, `metricActivity`). |
| `src/core/area/tree.ts` | The thesaurus/ontology boot payload (`readAreaHierarchyData`). |
| `src/core/area/color.ts` | The deterministic per-tipo dashboard color (`dashboardColor`). |
| `src/core/api/handlers/menu.ts` | The menu walk that turns the area graph into the navigation tree. |

The taxonomy has exactly one home. Use `isAreaModel()` / `areaBehaviorOf()`
rather than sniffing a model name for an `area` prefix.

## The behavior taxonomy

An area model is not defined by "which class it has" — it is defined by **what
it does when you read it**. `AREA_BEHAVIOR` in `src/core/concepts/area.ts` maps
every covered area model to one of three behaviors:

| behavior | area models | what a read returns |
| --- | --- | --- |
| `dashboard` | `area`, `area_root`, `area_admin`, `area_activity`, `area_resource`, `area_tool`, `area_publication`, `area_development` | The area's structure context plus one data item carrying the statistics dashboard of the sections inside it. |
| `tree` | `area_thesaurus`, `area_ontology` | The active-hierarchies boot payload for the `ts_object` tree (see [area_thesaurus](area_thesaurus.md) / [area_ontology](area_ontology.md)). |
| `maintenance` | `area_maintenance` | The widget catalog, served by its own subsystem (see [area_maintenance](area_maintenance.md)). |

`AREA_MODELS` is the set of keys of that map — the **behavior-carrying** models.
`areaBehaviorOf(model)` returns `null` for any area model outside it, and
`dispatchAreaRead` refuses such a read with `400 read: area model '…' is not
supported` rather than silently dashboarding it. An uncovered path fails loudly;
it never narrows into a plausible-looking default.

!!! warning "Areas hold no data — writes are refused"
    `refuseAreaWrite` (`src/core/area/read.ts`) fails closed on every write
    action (`save`, `create`, `delete`, `duplicate`) addressed at an area — both
    when the client *declares* an area model and when the target `section_tipo`
    merely *resolves* to one. An area has no matrix row; a write aimed at it must
    never be routed into section write code. The refusal is
    `400 Areas hold no data — write refused`.

### Read is validated against the ontology

`dispatchAreaRead` does not trust `source.model`. If the request also carries a
`source.tipo`, the engine resolves that tipo's real model and refuses the request
when the two disagree (`400 read: source.model '…' does not match tipo '…'`). An
unvalidated client string must not be able to choose a server code path.

`area_ontology` carries an additional, deliberate hard gate: it is
**superuser-only and fail-closed** — a non-superuser read is refused with `403`
before the ontology is touched at all.

## The menu roster

`MENU_ROOT_MODEL_ORDER` (`src/core/concepts/area.ts`) fixes the order in which
the menu emits its root areas:

```text
area_root, area_activity, area_resource, area_tool, area_thesaurus,
area_graph, area_admin, area_maintenance, area_development, area_ontology
```

`src/core/api/handlers/menu.ts` walks that list, resolves each model to its
ontology node, then collects the descendants (see the next section) and applies
the `areas.deny` list.

!!! note "The root order and the behavior set are two different lists"
    `MENU_ROOT_MODEL_ORDER` (menu emission order) and `AREA_MODELS` (the
    behavior-carrying set) are deliberately **not** the same list.
    `area_graph` appears in the root order of the walk, but it carries no
    behavior: it is absent from `AREA_BEHAVIOR`, a read addressed at it is
    refused, and the menu does not emit it. Do not conflate the two lists when you extend either.

### The deny/allow config

The menu subtracts the installation's **deny list** (`areas.deny`) from the walk.
A denied tipo is removed from the result but its descendants are *kept* — deny is
checked when a node is added, not when the walk recurses through it.

The deny/allow lists are runtime-editable through the `config_areas` maintenance
widget (`src/core/area_maintenance/widgets/config_areas.ts`), which persists the
override to `../private/ts_state.json`. The widget is anti-lockout guarded:
`area_root`, `area_maintenance` and `area_admin` cannot be denied. When no
override is set, the static catalog config applies, so an untouched installation
sees the default menu.

## Two walks, two filter sets

Which descendants an area collects depends on *why* you are walking it. The
**menu** walk and the **dashboard** walk have different criteria, and
`src/core/concepts/area.ts` names both sets so the divergence is a visible fact
rather than two filter lists drifting apart:

| set | value | consumer |
| --- | --- | --- |
| `AREA_CHILD_INCLUDE_MODELS` | `area`, `section`, `section_tool` | the menu walk (`api/handlers/menu.ts`) |
| `AREA_CHILD_EXCLUDE_MODELS` | `login`, `tools`, `section_list`, `filter` | the menu walk |
| `DASHBOARD_CHILD_EXCLUDE_MODELS` | the exclude set **plus** `section_tool` | `getDashboardChildSections` (`area/dashboard.ts`) |

The menu keeps `section_tool` nodes — they become navigable tool deep links. The
dashboard drops them: it counts plain data sections, not tool faces.

Both walks are depth-first pre-order over the ontology children ordered by
`order_number`, recursion descends only into kept nodes, and both carry a
visited-set cycle guard against a malformed ontology.

## The dashboard payload

A dashboard-behavior area serves an aggregate view over the sections inside it.
`getDashboardData` (`src/core/area/dashboard.ts`) returns:

```json
{
    "area_tipo"   : "dd14",
    "area_label"  : "Resources",
    "generated_at": 1731768000,
    "metrics"     : ["total"],
    "sections"    : [
        { "section_tipo":"rsc167", "label":"Audiovisual", "model":"section",
          "color":"#3b82f6", "total":4321, "recent_7d":12 }
    ],
    "activity_30d": {
        "date_from":"…", "date_to":"…",
        "days":[…], "users":[…], "available_ranges":[…]
    }
}
```

- The dashboard is attached only when the reader holds read permission on the
  area (`permissions > 0`) and the node's `properties.dashboard.disabled` is not
  `true`.
- The **metric list** is read from the area's ontology
  `properties.dashboard.metrics`, defaulting to `["total"]`. `total` is the only
  built-in per-section metric; it calls `countSectionRecords`
  (`src/core/search/count.ts`), which goes through the [SQO](../sqo.md) count
  path, so the number respects the reader's permissions and project filters.
  It is `null` — no badge — when the section is not countable: the reader lacks
  read permission, the section declares no table, or the table it declares is
  not a matrix **record** store. The last case is `dd15` (Time Machine →
  `matrix_time_machine`, a flat column store read only through the SQO mode
  `'tm'` source): counting it through the search assembler is refused by the
  identifier allowlist, and one such section would otherwise abort the whole
  dashboard (`WC-2026-08-18-dashboard-total-non-record-store`).
- `activity_30d` is an **area-level** metric. `metricActivity` queries
  `matrix_activity` directly with JSONB operators — no per-row component
  instances — grouping by day, section and user over a rolling 30-day window, and
  filling empty days so a chart is continuous. The component tipos it reads are
  `dd543` (who — the user) and `dd546` (where — the target section tipo). Its day
  window is derived in `DEDALO_TIMEZONE` wall-clock, not the host timezone, so a
  runner in another zone cannot shift the window by a day.
- `recent_7d` is derived from the already-computed `activity_30d` payload (no
  extra SQL) and attached to each section item.
- `color` is `dashboardColor(section_tipo)` (`src/core/area/color.ts`): a CRC-32
  of the tipo drives a fixed-saturation/lightness HSL hue, converted to
  `#rrggbb`. It is deterministic — the same section always gets the same color,
  across reloads and across installations.

### Adding a metric

Adding a per-section metric is an ontology node edit plus one branch in the
metric dispatch. Set the area node's `properties`:

```json
{ "dashboard": { "metrics": ["total"] } }
```

Each name in `metrics` is dispatched inside `getDashboardData`; an unknown name
simply contributes no key to the section item.

## Caching

There is nothing to instance and no per-area object cache. The menu walk reads
`dd_ontology` rows directly and `area/read.ts` dispatches a read straight off
`(model, tipo)`.

The module-level caches this path does carry — the children-tipo cache in
`area/tree.ts` and the ontology label cache — are **request-invariant**
(ontology-derived, identical for every user), so they are safe across concurrent
requests by construction. They register with the maintenance cache-clear hook so
an ontology import invalidates them; they are not per-request state.

## How it fits with the rest of Dédalo

- **Menu.** The back-office menu is the area graph, filtered. See
  [Menu](../ui/menu.md).
- **Sections.** Sections are the record-bearing leaves an area groups. An area
  holds no records — only structure, permission context and the dashboard. See
  [Sections](../sections/index.md).
- **Ontology.** Everything about an area — tipo, parent, label, properties,
  children — comes from the [Ontology](../ontology/index.md), resolved through
  `src/core/ontology/resolver.ts`.
- **Search.** The dashboard counts go through the [SQO](../sqo.md) count path, so
  they respect permissions and project filters.
- **Activity log.** `metricActivity` reads `matrix_activity` directly. See
  [Activity log](../system/logger.md).

## Related

- [Areas](index.md) — the family index.
- [area_admin](area_admin.md) · [area_thesaurus](area_thesaurus.md) ·
  [area_ontology](area_ontology.md) · [area_maintenance](area_maintenance.md)
- [Architecture overview](../architecture_overview.md) — where areas sit in the
  areas → sections → components → data hierarchy.
- [Section reference](../sections/section.md) — the record-bearing sibling.
- [Ontology](../ontology/index.md) — the active schema that defines area nodes.
- [Thesaurus / TS tree](../thesaurus/index.md) — the hierarchy stack the tree
  areas render.
- [SQO](../sqo.md) — the query object behind the dashboard counts.
