# section_record

> The per-record physical I/O for one row of the `matrix` table — how Dédalo
> reads, writes, duplicates and deletes a `(section_tipo, section_id)` pair.

## Role

A logical record is the pair **`(section_tipo, section_id)`**. Its payload
lives in one row of the `matrix` table, physically split across typed JSONB
columns (`data`, `string`, `number`, `relation`, `date`, `iri`, `geo`, `media`,
`misc`, `relation_search`, `meta`). The storage model — which column holds
what, and the model→column map — is described in
[the sections concept page](index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns).
This page documents the read/write/delete/duplicate **API**, not the storage
layout.

## The shape of the API: stateless functions over a passive struct

There is **no record object**. A record is a passive `MatrixRecord` struct
(`src/core/db/matrix.ts`) threaded **explicitly** through the call tree, and
every operation on it is a plain function:

| concern | module |
| --- | --- |
| pure contract (delete modes, audit tipos re-export, counter/delete-order laws) | `src/core/concepts/section_record.ts` |
| the record struct | `src/core/db/matrix.ts` (`MatrixRecord`, `MATRIX_JSONB_COLUMNS`, `MATRIX_TABLE_ALLOWLIST`, `readMatrixRecord`) |
| the write chokepoint | `src/core/section_record/record_write.ts` (`persistRecordKeys`, `persistRecordColumns`, `persistModifiedStamp`, `buildModifiedAuditWrites`) — re-exported from `src/core/section_record/index.ts` |
| virtual-record substitution | `src/core/section_record/virtual_record.ts` (`makeVirtualRecord`, `cloneRecord`, `injectComponentData`, `injectColumnData`, `isVirtualRecord`) |
| post-write fan-out | `src/core/section_record/save_event.ts` (`fireSaveEvent`, `registerRagRecordHook`, `fireRagRecordEvent`) |
| create / duplicate / delete | `src/core/section/record/create_record.ts`, `duplicate_record.ts`, `delete_record.ts` |
| per-component save | `src/core/section/record/save_component.ts` (`saveComponentData`) |
| counters | `src/core/db/matrix_write.ts` (`allocateComponentItemId`, `absorbComponentItemIds`, `insertMatrixRecordWithCounter`, `insertMatrixRecordWithExplicitId`) |
| Time Machine audit | `src/core/db/time_machine.ts` (`recordTimeMachine`, `nowDbTimestamp`, `readTimeMachineHistory`) |
| Time Machine record materializer (`dd15`) | `src/core/tm_record/` (`buildTmSectionRecord`) |

Bun's Postgres driver parses `jsonb` natively, so a record is read once and
passed down **already decoded** — there is no per-column lazy decode step, and
no per-request instance singleton. Explicit record passing is the rule: ambient
request state is forbidden, because a shared per-request record cache is exactly
the kind of thing that leaks across requests in a long-lived process.

Two guarantees are load-bearing and are called out here because breaking either
one corrupts data:

> **COUNTER LAW** — component item-ids are allocated under a PostgreSQL
> advisory lock keyed `"{table}_{section_tipo}_{section_id}_{tipo}"`; the base
> is `max(persisted meta counter, in-memory)` — **raise, never lower** — so a
> seeded or imported id can never be re-allocated. The allocators
> (`allocateComponentItemId` / `absorbComponentItemIds` /
> `insertMatrixRecordWithCounter`, all in `src/core/db/matrix_write.ts`)
> implement this; the section engine reuses them.

> **DELETE PIPELINE ORDER** (the sequence is the guarantee): ONE transaction runs
> (1) Time Machine snapshot via `SELECT … FOR UPDATE`; (2) Time Machine audit row
> (state `'deleted'`); (3) remove inverse references held by other records
> (**before** the row delete); (4) delete the row (`deleteMatrixRecord`); (5) RAG
> delete enqueue. **After commit**: (6) move media files to the deleted folder;
> (7) diffusion unpublish (per-target failures non-blocking); (8) fire the save
> event. There is no re-read/verify step.

!!! note "Components never touch the database"
    A component resolves its value by reading straight off a `MatrixRecord`'s
    `.columns` and persists through `persistRecordKeys()` /
    `persistRecordColumns()`. The component knows its data shape; the write
    chokepoint knows where (which typed column) and how it is stored. See
    [`section`](section.md) for the record-lifecycle callers
    (`createSectionRecord`, `deleteSectionRecord`, `duplicateSectionRecord`).

---

## Reading a record

A caller reads a row directly:

```ts
import { readMatrixRecord } from '../db/matrix.ts';
import { getMatrixTableFromTipo, getColumnNameByModel } from '../ontology/resolver.ts';

const table = await getMatrixTableFromTipo('oh1'); // resolves the matrix* table
const record = await readMatrixRecord(table!, 'oh1', 5); // MatrixRecord | null

if (record !== null) {
  // a component_input_text (model maps to the 'string' column)
  const column = getColumnNameByModel('component_input_text'); // 'string'
  const value = (record.columns[column as 'string'] as Record<string, unknown> | null)?.['oh25'];
}
```

`MatrixRecord` is the uniform record interface every caller gets — a passive
struct:

```ts
export interface MatrixRecord {
  id: number;
  section_id: number;
  section_tipo: string;
  columns: Partial<Record<MatrixJsonbColumn, unknown>>;   // parsed JSONB
  rawText: Partial<Record<MatrixJsonbColumn, string | null>>; // ::text twins, byte-parity
}
```

There is **no record cache**. A caller that needs the same record twice in one
request passes down the `MatrixRecord` it already has, rather than re-fetching.

`isVirtualRecord(record)` distinguishes a record built in memory
(`id === VIRTUAL_RECORD_ID`, i.e. `0` — the Time Machine case, or a synthetic
search-data row) from one backed by a real DB row.

---

## Writing data

Every writer that persists component keys **must** route through
`persistRecordKeys()` — it is the single write chokepoint (grep-gated by
`test/unit/section_record.test.ts`):

| operation | function | DB op |
| --- | --- | --- |
| whole-column write | `persistRecordColumns(target, columns, audit?)` | `updateMatrixRecord` — replaces the given columns wholesale; fires the save event **and** the RAG `'index'` seam. |
| one or more `{column, key}` writes, value + modified-audit stamp in ONE update | `persistRecordKeys(target, savePath, audit)` | `updateMatrixKeysData` — `value: null` removes the key (removing the last key leaves `'{}'`; a `NULL` column stays `NULL`); fires the save event. |
| modified-audit stamp only, no data write | `persistModifiedStamp(target, audit)` | Same underlying write, savePath built purely from the audit stamp. |
| the per-component entry point a save request calls | `saveComponentData(request)` — `src/core/section/record/save_component.ts` | Reads the component's current items, applies the changed-data ops, writes the full updated array back via `persistRecordKeys`, and appends a Time Machine audit row. |

```ts
import { persistRecordKeys } from '../section_record/index.ts';

// persist one component's value: value + modified-audit stamp in ONE update
// (the chokepoint builds the audit writes from `audit` itself — there is no
// separate "stage in memory" step to call first)
await persistRecordKeys(
  { table: 'matrix', sectionTipo: 'oh1', sectionId: 5 },
  [{ column: 'string', key: 'oh25', value: ['Hello world'] }],
  { userId: 42 },
);
```

`buildModifiedAuditWrites(sectionTipo, audit)` produces the audit half of that
update: `[]` for the `Activity` section or a missing user, otherwise the `dd197`
user-locator write into `relation` and the `dd201` virtual-date write into
`date` — merged into the same update as the component's own value.

### Delete family

| operation | function | effect |
| --- | --- | --- |
| full record delete | `deleteSectionRecord(sectionTipo, sectionId, userId, now?)` — `src/core/section/record/delete_record.ts` | In ONE transaction: (1) Time Machine snapshot (`SELECT … FOR UPDATE`); (2) Time Machine audit row (state `'deleted'`); (3) remove inverse references held by other records; (4) remove the row (`deleteMatrixRecord`); (5) RAG delete enqueue. Post-commit: (6) move media files to the deleted folder (`removeSectionMediaFiles`); (7) diffusion unpublish (per-target, non-blocking); (8) fire the save event. Refuses `section_id < 1`. |
| empty data, keep the row (the default `delete_data` mode) | `deleteSectionData(sectionTipo, sectionId, userId, now?)` | Empties the data of every component in the section's edit scope in place (a virtual section's FIRST `exclude_elements` set and its subtrees are left untouched, with an excluded component's dataframe entries; skipping `component_section_id` / `component_external` / `component_inverse`; `component_filter` resets to the default project instead of `null`), backfills a Time Machine pair per emptied component, refreshes the modified stamp. The row itself survives; meta counters are **kept**. |

### Duplicate

```ts
export async function duplicateSectionRecord(
  sectionTipo: string,
  sourceSectionId: number,
  userId: number,
  now?: Date,
): Promise<number>
```

`src/core/section/record/duplicate_record.ts` clones every JSONB column except
`data`/`meta`/`relation_search` into a brand-new counter-allocated
`section_id`, drops the audit tipos from the copy and re-stamps fresh
created/modified metadata, rebuilds the per-component `meta` counter
(`[{count: maxItemId}]`), copies media files for every copied media component
(`duplicateMediaFiles` / `refreshStoredFilesInfo`), and writes two Time Machine
rows per copied component (a backfill-repair row, then the save row). Returns
the new `section_id`.

---

## Component value ids & counters

String-type component values carry a per-value unique id (the dataframe
pairing `id_key`). The next id is tracked by a per-component counter stored in
the `meta` column under the component tipo, as `[{ "count": N }]`.

| function | purpose |
| --- | --- |
| `allocateComponentItemId(table, sectionTipo, sectionId, componentTipo, count?)` — `src/core/db/matrix_write.ts` | Atomically allocate fresh ids under a PostgreSQL advisory lock keyed `(table, section_tipo, section_id, component_tipo)`; re-reads the *persisted* counter (concurrent writers may have advanced it), persists the raised counter immediately, syncs back. |
| `absorbComponentItemIds(...)` | Raise the counter to at least a given value (no-op if already there) under the same lock — absorbs explicit ids carried by imported/migrated data without racing live allocations. |
| `insertMatrixRecordWithCounter(table, sectionTipo, columns)` | Allocate a new `section_id` from the section's own counter and insert the row in one call — the path `createSectionRecord()` and `duplicateSectionRecord()` both use. |
| `insertMatrixRecordWithExplicitId(table, sectionTipo, sectionId, columns)` | Insert at a caller-forced `section_id` (the ontology-provisioning path, which needs deterministic node ids), raising the counter afterward so a later auto-allocation never collides. |

!!! warning "Item ids are never reused"
    Item ids must be unique per component per record and never recycled, so a
    plain read-increment-write is unsafe across concurrent writers. Always go
    through `allocateComponentItemId()` / `absorbComponentItemIds()`, which
    lock and persist atomically.

---

## Metadata

Records carry created/modified by-user and date, stored as fixed private tipos
(`AUDIT_TIPOS`, `src/core/concepts/section.ts`, also re-exported as
`RECORD_AUDIT_TIPOS` from `src/core/concepts/section_record.ts`):

| concept | tipo | column |
| --- | --- | --- |
| created by user | `dd200` | `relation` |
| created date | `dd199` | `date` |
| modified by user | `dd197` | `relation` |
| modified date | `dd201` | `date` |

| function | purpose |
| --- | --- |
| `buildRecordMetadata(sectionTipo, userId, now)` — `src/core/section/record/create_record.ts` | Builds the initial `data`-column section metadata (label, created timestamp, `section_tipo`, `diffusion_info: null`, `created_by_user_id`) for a brand-new record. |
| `buildModifiedAuditWrites(sectionTipo, audit)` — `src/core/section_record/record_write.ts` | The created/modified user-locator + date writes, keyed by column and tipo. `[]` for the Activity section or a missing user — no DB side effect by itself; the chokepoint functions call it internally. |
| `auditUserLocator(userId, componentTipo)` / `auditDateItem(now)` | The locator / virtual-date item shapes an audit write carries. |

`fireSaveEvent(sectionTipo)` (`src/core/section_record/save_event.ts`) is fired
after every persist and invalidates the dependent caches: the tools
register/config/profile sections (`dd1324`/`dd996`/`dd234`, via
`invalidateAllToolCaches()`) and the Ontology section
(`clearOntologyDerivedCaches()`). The request-config presets (`dd1244`) are read
uncached, so there is nothing to invalidate for them.

---

## Public API

| function | module | purpose |
| --- | --- | --- |
| `readMatrixRecord(table, sectionTipo, sectionId)` | `db/matrix.ts` | Read one record (parsed + raw-text twin). |
| `isVirtualRecord(record)` | `section_record/virtual_record.ts` | Whether the record is DB-backed or in-memory only. |
| `makeVirtualRecord(sectionTipo, sectionId)` | same | Build an empty in-memory record. |
| `cloneRecord(record)` | same | Deep-copy before substituting (never mutate a shared row). |
| `injectComponentData(record, tipo, model, items)` | same | Route items into the model's mapped column, keyed by tipo (`null` removes the key). |
| `injectColumnData(record, column, value)` | same | Replace one whole column. |
| `persistRecordKeys(target, savePath, audit)` | `section_record/record_write.ts` | Persist `{column,key}` writes + modified-audit stamp in one update. |
| `persistRecordColumns(target, columns, audit?)` | same | Persist whole columns + audit merge; fires the RAG index seam. |
| `persistModifiedStamp(target, audit)` | same | Persist only the modified-audit stamp. |
| `buildModifiedAuditWrites(sectionTipo, audit)` | same | The audit savePath items (pure, no I/O). |
| `fireSaveEvent(sectionTipo)` | `section_record/save_event.ts` | Post-write cache invalidation. |
| `registerRagRecordHook(hook)` / `fireRagRecordEvent(event)` | same | The RAG index/delete seam. |
| `createSectionRecord(sectionTipo, userId, now?, sectionId?)` | `section/record/create_record.ts` | Insert a new row with fresh audit metadata. |
| `duplicateSectionRecord(sectionTipo, sourceSectionId, userId, now?)` | `section/record/duplicate_record.ts` | Clone into a new `section_id`. |
| `deleteSectionRecord(sectionTipo, sectionId, userId, now?)` | `section/record/delete_record.ts` | Full delete (TM snapshot, inverse refs, media, diffusion). |
| `deleteSectionData(sectionTipo, sectionId, userId, now?)` | same | Empty all component data, keep the row. |
| `saveComponentData(request)` | `section/record/save_component.ts` | The per-component save entry point. |
| `allocateComponentItemId(...)` / `absorbComponentItemIds(...)` | `db/matrix_write.ts` | Atomic item-id counter operations. |
| `recordTimeMachine(entry, timestamp)` | `db/time_machine.ts` | Append a Time Machine audit row. |

---

## Examples

### Read and save a component's value

```ts
import { readMatrixRecord } from '../db/matrix.ts';
import { getColumnNameByModel, getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { persistRecordKeys } from '../section_record/index.ts';

const table = (await getMatrixTableFromTipo('oh1'))!;
const record = await readMatrixRecord(table, 'oh1', 5);

if (record !== null) {
  const column = getColumnNameByModel('component_input_text'); // 'string'
  const value = (record.columns.string as Record<string, unknown> | null)?.['oh25'];
}

// persist a new value + modified-audit stamp in ONE update
await persistRecordKeys(
  { table, sectionTipo: 'oh1', sectionId: 5 },
  [{ column: 'string', key: 'oh25', value: ['Hello world'] }],
  { userId: 42 },
);
```

### Duplicate a record

```ts
import { duplicateSectionRecord } from '../section/record/duplicate_record.ts';

const newSectionId = await duplicateSectionRecord('oh1', 5, principal.userId);
// media files regenerated for the new id, Time Machine entries created
```

### Delete a record

```ts
import { deleteSectionRecord } from '../section/record/delete_record.ts';

// (1) Time Machine snapshot + verify, (2) delete row,
// (3) strip inverse refs + move media, (4) diffusion unpublish
const { deleted, removed } = await deleteSectionRecord('oh1', 5, principal.userId);
// deleted → ['5'], removed → true. Refuses section_id < 1 (throws).
```

---

## Related

- [Sections concept](index.md) — the matrix-table model and the typed-column split.
- [section](section.md) — the section *type*: context, permissions, children, relations.
- [sections](sections.md) — the multi-record collection concept.
- [Components](../components/index.md) — the fields that read and save through this API.
- [Locator](../locator.md) — the pointer stored in the `relation` column and inverse references.
