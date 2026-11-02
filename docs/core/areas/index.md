# Areas

> The top-level groupings of the Dédalo back-office menu — Resources, Activity,
> Admin, Thesaurus, Ontology, Maintenance, Development, Tools and Root.
> An *area* is an ontology node that *contains* sections and sub-areas; it holds
> no records of its own, only structure, permission context and an aggregated
> dashboard over its descendant sections.

> See also: [Architecture overview](../architecture_overview.md) ·
> [Sections](../sections/index.md) · [Menu](../ui/menu.md) ·
> [Ontology](../ontology/index.md)

This page is the **index for the Areas domain**. It explains what an area is,
how the engine decides what each area model *does*, and lists every area model
with a one-line purpose and a link to its full reference where one exists. For
the wider picture of how areas, sections and components form the back-office,
read the [Architecture overview](../architecture_overview.md) first.

## What an area is

An area is a **top-level grouping** in the back-office menu — the major
divisions of the application. Each area is an **ontology node** whose `model` is
`area` or a model-name variant such as `area_root`, `area_admin` or
`area_thesaurus`.

Unlike a [section](../sections/section.md), an area is **not backed by a matrix
table and owns no records of its own**. It is a structural node that *contains*
sections and sub-areas as ontology children. Areas anchor three things:

- the **menu tree** — areas are the top-level nodes; sections and sub-areas are
  their children, resolved through the ontology parent/children graph rather
  than a fixed map (see [Menu](../ui/menu.md));
- **permission scoping** — an area is a node over which permissions can be
  evaluated, even though it carries no record id;
- the **dashboard** — the aggregated statistics view over an area's descendant
  sections.

Writes are refused: an area has no matrix row, so `save` / `create` / `delete` /
`duplicate` aimed at an area tipo fails closed.

## No per-model class — one contract, three resolvers

There is no object per area model. A single contract module,
`src/core/concepts/area.ts`, owns the canonical model list, the walk-filter sets,
the menu root order and the area `tipo` constants; the resolvers in
`src/core/area/` consume it:

| module | what it owns |
| --- | --- |
| `src/core/concepts/area.ts` | The contract — `AREA_MODELS`, `areaBehaviorOf()`, `isAreaModel()`, `MENU_ROOT_MODEL_ORDER`, the child include/exclude sets, the area tipo constants. |
| `src/core/area/read.ts` | The read dispatcher and the write refusal. |
| `src/core/area/dashboard.ts` | The statistics engine. |
| `src/core/area/tree.ts` | The thesaurus/ontology tree boot payload. |
| `src/core/area/color.ts` | The deterministic per-tipo dashboard color. |
| `src/core/api/handlers/menu.ts` | The menu walk over the area graph. |

Every area model resolves to exactly one of three **behaviors** —
`dashboard`, `tree` or `maintenance` — and an area model with no behavior is
refused loudly rather than silently dashboarded. See
[area → the behavior taxonomy](area.md#the-behavior-taxonomy).

`area_ontology` is additionally **superuser-only and fail-closed** (see
[area_ontology](area_ontology.md)).

## The area models

### Documented areas

| area model | behavior | purpose | doc |
| --- | --- | --- | --- |
| `area` | dashboard | The plain grouper — the model most areas in an installation use, and the reference for the whole family. | [area.md](area.md) |
| `area_admin` | dashboard | Administration — users, profiles, projects, configuration and other system-administration sections. | [area_admin.md](area_admin.md) |
| `area_thesaurus` | tree | Thesaurus — controlled vocabularies rendered as a hierarchical tree. | [area_thesaurus.md](area_thesaurus.md) |
| `area_ontology` | tree | Ontology — the in-app editor over the ontology nodes themselves. Superuser-only. | [area_ontology.md](area_ontology.md) |
| `area_maintenance` | maintenance | Maintenance — operational widgets (backups, caches, indexing, media control, integrity checks). | [area_maintenance.md](area_maintenance.md) |

### Grouping-only areas

These models add no behavior of their own. They exist to give a distinct
ontology node — and therefore a distinct menu grouping, permission scope and
dashboard — and they all resolve to the `dashboard` behavior.

| area model | one-line description |
| --- | --- |
| `area_root` | The root grouping — the top of the area tree the menu walk starts from. |
| `area_resource` | Resources — the curatorial data sections (people, media, audiovisual, …); the primary working area. |
| `area_activity` | Activity — the activity-log views that record who changed what and when. |
| `area_tool` | Tools — the grouping under which the registered tools (import, export, diffusion, …) appear. |
| `area_development` | Development — developer-facing sections and scaffolding. |
| `area_publication` | Publication — the grouping for publication / diffusion-facing sections. |

!!! note "Menu roster"
    The menu emits its root areas in a fixed order, `MENU_ROOT_MODEL_ORDER` in
    `src/core/concepts/area.ts`: `area_root`, `area_activity`, `area_resource`,
    `area_tool`, `area_thesaurus`, `area_graph`, `area_admin`,
    `area_maintenance`, `area_development`, `area_ontology`. Each root is
    resolved to its ontology node, its child areas/sections are collected
    recursively, and the result is filtered against the `areas.deny` list.

    That order is **not** the behavior-carrying set. `area_graph` holds a slot in
    it for the walk only; it carries no behavior, a read addressed at it is
    refused, and the menu does not emit it. See
    [area → the menu roster](area.md#the-menu-roster).

## See also

- [area](area.md) — the family reference: behavior taxonomy, the two walks, the
  dashboard payload, the deny/allow config.
- [Architecture overview](../architecture_overview.md) — where areas sit in the
  `areas → sections → components → data` hierarchy.
- [Sections](../sections/index.md) — the record-bearing leaves an area groups.
- [Menu](../ui/menu.md) — the navigation tree built from the area graph.
- [Ontology](../ontology/index.md) — the active schema the area walk reads.
