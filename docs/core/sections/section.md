# section

> The server-side **section concept** — the runtime notion of one record *type*
> of the `matrix` table, and the module family that resolves a section's
> children, relations, permissions, metadata and search.

> See also: [Sections concept](index.md) · [section_record](section_record.md) · [sections](sections.md) · [Components](../components/index.md)

This page is the **reference** for `section`. For the conceptual model — *what
a section is*, the single `matrix` table, and the typed-JSONB storage layout —
read [Sections](index.md) first; this document does not repeat that material
at length.

A section is **not an object you instantiate**. The concept is split in two:
the pure contract (grouper registry, traversal law, audit tipos, the Activity
special case) lives in `src/core/concepts/section.ts`; the I/O-bearing engine
(context stamping, buttons, permissions, record lifecycle) lives in
`src/core/section/` (`context.ts`, `buttons.ts`, `read.ts`, `record/`). A
caller resolves a section's context or reads its records by calling the
relevant function directly with a tipo, an `Rqo`, or a `Principal`.

## Role

The `section` concept is the "table with logic" idea: given a tipo, resolve
which components the section has, what permissions the current user holds over
it, how to create a record, the shared relations array, the section map and the
search query — and produce the context/data envelope the client renders. It
sits between two sibling concepts:

| concept | role |
| --- | --- |
| **`section`** *(this page)* | The section **type**: children/grouper resolution, permissions, buttons, metadata, virtual-section resolution. |
| **`sections`** | The multi-record **collection/list concept**: given an SQO, resolve and return many records of one `section_tipo` at once (list views, portals). See [`sections`](sections.md). |
| **`section_record`** | The physical **per-record I/O**: one `(section_tipo, section_id)` row, read/save/delete/duplicate. See [`section_record`](section_record.md). |

`section` does not issue SQL for record payloads itself. Persistence goes
through the write chokepoint in `src/core/section_record/record_write.ts`, and
components read their value straight off the already-decoded `MatrixRecord`
(`src/core/db/matrix.ts`) that the read engine hands down. The one payload the
section concept is uniquely responsible for describing is the **relations
array** (see [Relations](#relations-section-owned)) — though the actual mutation
is performed by the relating component's own write path, not by a generic
"section" object.

## Responsibilities

- **Context.** Stamp the section-only context extras — `matrix_table`,
  `config.relation_list_tipo`, `section_map`, `buttons`, admin-path `tools` —
  onto a structure-context entry (`stampSectionContext`,
  `src/core/section/context.ts`).
- **Ontology / children.** Walk the section node's recursive children and
  filter them by model (components, buttons, list-definitions, groupers),
  recognise groupers, and resolve **virtual → real** section tipos.
- **Permissions.** Resolve the user's integer permission over the section type,
  with the `Activity` clamp.
- **Metadata.** Declare the fixed created/modified audit tipos used when a
  record is built.
- **Record lifecycle.** Create / duplicate / delete a record (delegated to
  `src/core/section/record/`, documented in full on
  [`section_record`](section_record.md)).

## Resolving a section's context

A section's context is built as part of the generic structure-context walk
(`src/core/resolve/structure_context.ts`), which stamps the section-only extras
via `stampSectionContext` whenever the resolved model is `'section'`:

```ts
// resolve/structure_context.ts (essence)
if (core.model === 'section') {
  await stampSectionContext(entry, { tipo, permissions, properties, principal });
}
```

```ts
// section/context.ts
export async function stampSectionContext(
  entry: StructureContextEntry,
  params: SectionStampParams,
): Promise<void> {
  entry.matrix_table = await getMatrixTableFromTipo(params.tipo);
  entry.config = { relation_list_tipo: await sectionRelationListTipo(params.tipo) };
  entry.section_map = await getSectionMap(params.tipo);
  entry.buttons = await buildSectionButtons(params.tipo, params.permissions, params.principal);
  if (params.permissions >= 3) {
    entry.tools = (await getSectionTools(params.tipo, toolConfigKeys)).tools;
  }
}
```

There is no per-tipo instance cache to reason about: a request builds what it
needs and discards it when the request ends.

## What resolving a section gives you

- **`section_tipo`** — the tipo passed to whichever function you called; there
  is no held property to read back.
- **Component children** — resolved on demand by a recursive `dd_ontology` CTE
  walk, gated by the traversal law in `traversalRecurses()`
  (`src/core/concepts/section.ts`). Components are never held as objects; each
  is resolved and its value read straight from the `MatrixRecord` passed down
  the read pipeline.
- **Permissions** — the integer permission over this section type, resolved by
  `getSectionPermissions()` (`src/core/security/permissions.ts`), which clamps a
  `CONSULTATION_ONLY_SECTIONS` section (the `Activity` and Time Machine sections)
  to `1` via `isConsultationOnlySection` (`src/core/concepts/section.ts`).
- **The relations array** — the shared per-record `relation` typed column (see
  [Relations](#relations-section-owned)).
- **Metadata tipos** — the fixed audit component tipos from `AUDIT_TIPOS`
  (`src/core/concepts/section.ts`): `createdByUser` (`dd200`), `createdDate`
  (`dd199`), `modifiedByUser` (`dd197`), `modifiedDate` (`dd201`).
- **Virtual-section state** — resolved by the ontology resolver's "VIRTUAL
  SECTION fallback" (`src/core/ontology/resolver.ts`): a virtual section keeps
  its own ontology definition while storing data under a *real* section's matrix
  table.

## Public API

Grouped by concern.

### Context & lifecycle

| function | module | purpose |
| --- | --- | --- |
| `stampSectionContext(entry, params)` | `src/core/section/context.ts` | Stamp the section-only context extras onto a structure-context entry. |
| `createSectionRecord(sectionTipo, userId, now?, sectionId?)` | `src/core/section/record/create_record.ts` | Build audit metadata, insert a new row via the atomic counter allocator. Gated in the `create` action handler (`src/core/api/handlers/dd_core_api.ts`) by `getSectionPermissions(principal, sectionTipo) >= 2` (which refuses the Activity section implicitly, via its consultation-only clamp). |

### Relations (section-owned)

Relation-bearing components share **one** typed `relation` column per record.
Reads are direct; writes go through the owning component family's save path.

| operation | how | purpose |
| --- | --- | --- |
| read a component's locators | `record.columns.relation[tipo]` (`MatrixRecord`, `src/core/db/matrix.ts`) | The record's locator array for one component tipo. |
| append a locator | `applyAddNewElement()` — `src/core/relations/save.ts` | Validate + append. Not a generic section method: each relating component family (portal, dataframe, …) writes through its own save path into the same `relation` column. |
| remove a locator | `deletePortalLocator()` — `src/core/relations/save.ts` | Remove a locator by its identifying properties. |

Bulk removal of every locator originating from one component tipo is
component-family-specific; there is no single generic entry point for it.

### Permissions

| function | module | purpose |
| --- | --- | --- |
| `getSectionPermissions(principal, sectionTipo)` | `src/core/security/permissions.ts` | Resolve the integer permission over a section, clamping a `CONSULTATION_ONLY_SECTIONS` section (the `Activity` and Time Machine sections) to `1` via `isConsultationOnlySection`. |

### Ontology / children

| symbol | module | purpose |
| --- | --- | --- |
| `traversalRecurses()` | `src/core/concepts/section.ts` | The traversal law: which models the recursive `dd_ontology` children walk is allowed to descend through. |
| `GROUPER_MODELS` / `isGrouperModel()` | `src/core/concepts/section.ts` | The layout-grouper models that carry no data: `section_group`, `section_group_div`, `section_tab`, `tab`. |
| the "VIRTUAL SECTION fallback" | `src/core/ontology/resolver.ts` | Resolve a virtual section's real tipo. |
| `buildSectionButtons(sectionTipo, permissions, principal?)` | `src/core/section/buttons.ts` | Resolve the section's permission-gated `button_*` children. |
| `getSectionMap(sectionTipo)` | `src/core/ontology/section_map.ts` | The `section_map` child's properties (role→component-tipo map). |

### Search

Query conforming is not a section-level helper: it lives in the search and
relations subsystems. See [SQO](../../api/sqo.md) and
[request_config](../request_config.md).

### Metadata

| symbol | module | purpose |
| --- | --- | --- |
| `AUDIT_TIPOS` | `src/core/concepts/section.ts` | The fixed created/modified audit tipos: `createdByUser` (`dd200`), `createdDate` (`dd199`), `modifiedByUser` (`dd197`), `modifiedDate` (`dd201`). |

## How it fits with components and section_record

1. **Resolving the children.** The recursive `dd_ontology` walk filters by
   model; groupers (`GROUPER_MODELS`) carry no data and are skipped when
   collecting data-bearing components — see
   [section_group](section_group.md) / [section_tab](section_tab.md).
2. **Reading & saving a component value.** Each component reads its slice off
   the record's typed column directly and persists through
   `persistRecordKeys()` / `persistRecordColumns()`
   (`src/core/section_record/record_write.ts`) — see
   [`section_record`](section_record.md).
3. **The relations array.** Relation-bearing components write into the shared
   `relation` typed column through their own family's save path
   (`src/core/relations/save.ts` and friends), not through a generic "section"
   accessor.

```mermaid
flowchart TB
    RS["readSection(rqo, principal)"] --> SC["stampSectionContext() — section-only context extras"]
    RS -->|resolves children| C["component read/write"]
    RS -->|create| CR["createSectionRecord()"]
    C -->|read directly| MR["MatrixRecord (db/matrix.ts)"]
    C -->|persist| WRITE["record_write.ts: persistRecordKeys / persistRecordColumns"]
    WRITE --> DB[("matrix table")]
    C -->|write locator| REL["relations/save.ts (per component family)"]
    REL -.shares.- MR
```

## Examples

### Resolve a section's context and create a record

```ts
import { createSectionRecord } from '../section/record/create_record.ts';
import { getPermissions } from '../security/permissions.ts';

// 1. gate the write the same way the API dispatch does
const level = await getPermissions(principal, 'rsc197', 'rsc197');
if (level < 2) throw new Error('insufficient permissions');

// 2. create a new record; returns the new section_id
const sectionId = await createSectionRecord('rsc197', principal.userId); // e.g. 1
```

### Add and remove a relation

```ts
import { applyAddNewElement, deletePortalLocator } from '../relations/save.ts';

// add a relation through the owning component's write path (a portal here):
// creates the TARGET record (inheriting the host's project filter) and
// appends the link locator to the portal's stored items.
const added = await applyAddNewElement(
  currentItems,      // the portal's current stored items
  'oh1',              // target_section_tipo
  'rsc200',            // the portal component's own tipo (from_component_tipo)
  'rsc197',            // the HOST section_tipo
  1,                   // the HOST section_id
);
// added → { items: [...currentItems, newLocator], sectionId: newSectionId } | null

// remove a locator the same way, through the component's own delete action
const removed = await deletePortalLocator(
  principal,
  { tipo: 'rsc200', section_tipo: 'rsc197', section_id: 1 },
  { locator: { section_tipo: 'oh1', section_id: 7 } },
);
// removed → { result: <removed count>, msg: [], errors: [] }
```

!!! note "Mutations persist immediately — there is no in-memory staging step"
    Each relation-family save function reads the current record, computes the
    new `relation` column value, and persists it through `persistRecordKeys()`
    in the same call. Nothing accumulates in memory waiting for a later "save
    the record" call.

## Related

- [Sections concept](index.md) — what a section is, the `matrix` table and the
  typed-JSONB storage model.
- [section_record](section_record.md) — the per-record physical I/O sibling.
- [sections](sections.md) — the multi-record collection/list concept.
- [Components](../components/index.md) — the fields that live inside a section.
- [Locator](../locator.md) — the pointer type stored in the relations array.
- [SQO](../../api/sqo.md) — the search query object the read engine consumes.
