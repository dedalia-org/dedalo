# db

> See also: [Architecture overview](../architecture_overview.md) · [Sections](../sections/index.md) · [section_record](../sections/section_record.md) · [SQO](../../api/sqo.md)

The PostgreSQL access layer (`src/core/db/`) holds the connection/transaction primitives, the matrix table read/write functions, the single JSONB codec, the ontology and Time Machine table modules and the schema-asset rebuilders. It is the **only** code in the TS work server that opens a PostgreSQL connection or issues SQL.

## Role

`src/core/db/` is the bottom layer of the work-system stack. Everything above it —
[`section`](../sections/section.md), [`section_record`](../sections/section_record.md),
components, search — resolves *what* to read or write; `src/core/db/` is *how* the
bytes actually reach PostgreSQL. There is no object-per-record here: this is plain
infrastructure — a handful of modules exporting functions over Bun's built-in SQL
client.

It sits directly below the section-record write pipeline:

```text
section / component / resolve  (resolve data; never touch the DB)
        │
section_record/record_write    (the per-record write contract)
        │  delegates every read/save/delete to a db-layer function
        ▼
src/core/db/                    ← this subsystem
  ├── postgres.ts        connection pool, transactions, advisory locks
  ├── matrix.ts          matrix table READ + the identifier allowlists
  ├── matrix_write.ts    matrix CRUD writes (update / update_by_key / insert / delete)
  ├── json_codec.ts      the single JSONB encode/decode chokepoint (byte-compat)
  ├── time_machine.ts    matrix_time_machine read + the audit-write function
  ├── dd_ontology.ts     the ontology (dd_ontology) table I/O
  ├── db_assets.ts       schema extensions/functions/constraints/indexes rebuild
  └── db_pg_definitions.json   the canonical extension/table/trigger/function/index/constraint SQL
        │
PostgreSQL                      matrix tables (typed JSONB columns)
```

!!! note "MariaDB is not here"
    This layer talks **only to PostgreSQL** (Bun's `SQL` Postgres client). The
    publication / diffusion database (MariaDB/MySQL) is owned **exclusively** by
    the diffusion engine (`src/diffusion/`); the work server ships no MariaDB
    connector at all. See the
    [architecture overview](../architecture_overview.md#the-two-systems) for the
    work-vs-diffusion split.

!!! warning "One process, one pool, no global connection state"
    The server is a single long-lived process holding **one shared connection
    pool** (`postgres.ts`), and request identity never touches it. An in-flight
    transaction is pinned to a reserved connection through `AsyncLocalStorage`,
    never through a module-level variable. Store a connection — or a transaction —
    at module level and you have just handed one request's transaction to another.

## Responsibilities

- **Connection handling** — hold the single process-wide `SQL` pool and expose
  the `sql` handle every caller uses (`postgres.ts`).
- **Transactions** — a managed transaction API (`withTransaction`) with
  single-connection semantics via `AsyncLocalStorage` and flatten-nesting (an
  inner `withTransaction` joins the ambient transaction).
- **Matrix record read** — `readMatrixRecord` returns one row's typed JSONB
  columns both parsed and as raw `::text` twins for parity diffing;
  `readMatrixRecordBatch` answers a whole set of ids with one `ANY()` query
  (`matrix.ts`).
- **Read-scoped row memo** — within ONE section read, a row is fetched from the
  database once however many components ask for it (`record_memo.ts`). The memo
  lives in a scope opened by the section read and dies with it, so it needs no
  invalidation: it can only serve a row that same read already saw. The page-level
  batch loaders seed it, so a component asking for a row the page already fetched
  costs no round trip. It is never active on the write path — a save legitimately
  re-reads a row it just modified.
- **Matrix record write** — the typed write verbs over the `matrix*` tables:
  `updateMatrixRecord` (whole-column upsert), `updateMatrixKeysData` /
  `updateMatrixKeyData` (surgical per-key `jsonb_set_lax`), the item-id
  allocators, the counter-driven and explicit-id inserts, and
  `deleteMatrixRecord` (`matrix_write.ts`).
- **JSONB codec** — the single encode/decode chokepoint every write passes through
  (`json_codec.ts`).
- **Ontology I/O** — CRUD, whole-row upsert, filtered search and the identifier
  grammar over the ontology table `dd_ontology` (`dd_ontology.ts`).
- **Time Machine I/O** — read of `matrix_time_machine` snapshots and the audit
  `recordTimeMachine` write appended by the save pipeline (`time_machine.ts`).
- **Schema maintenance** — (re)apply the declared extensions/tables/functions/
  triggers/constraints/indexes and the `REINDEX`/`VACUUM` maintenance sentences
  (`db_assets.ts` over `db_pg_definitions.json`).
- **Injection boundary** — table and column names are identifiers (they cannot
  be bound as parameters) and are validated against fixed allowlists before
  interpolation; every user-facing value is a bound parameter.

## Data model

The physical model is the **matrix** table family described in the
[sections concept page](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns).
Every matrix row is keyed by the composite `(section_tipo, section_id)` and stores
the record payload across **typed JSONB columns** rather than one blob. The
canonical lists live as `const` allowlists in `matrix.ts`:

| const | contents | purpose |
| --- | --- | --- |
| `MATRIX_JSONB_COLUMNS` | `data`, `relation`, `string`, `date`, `iri`, `geo`, `number`, `media`, `misc`, `relation_search`, `meta` | the 11 typed JSONB columns of a matrix row; `readMatrixRecord` projects each column plus its `::text` twin, and every write validates its column against this set. |
| `MATRIX_TABLE_ALLOWLIST` | the allow-list of `matrix*` table names (`matrix`, `matrix_hierarchy`, `matrix_users`, `matrix_dataframe`, `matrix_activity`, …) | every read/write validates its `tableName` against this list via `assertMatrixTable()` — a table not in it is refused. This is the SQL-injection guard for table names. |

Each component model maps to exactly **one** of these columns. The mapping lives
on the per-model DESCRIPTOR (`src/core/components/component_X/descriptor.ts`,
field `column`; e.g. `component_input_text → string`, `component_portal →
relation`) and is read through `getColumnNameByModel()` in
`src/core/ontology/resolver.ts`. The db layer itself does not know about
components — it reads and writes columns and JSON keys; the tipo→column mapping is
done one layer up.

!!! note "`section_id` is allocated by a counter table"
    `insertMatrixRecordWithCounter()` does **not** rely on a serial PK for the
    logical record id. In one statement it takes an advisory lock, computes
    `COALESCE(MAX(section_id),0)+1` as a self-healing fallback, UPSERTs a
    per-section counter into `matrix_counter` (or `matrix_counter_dd` for
    `_dd`/ontology tables), and inserts the row with the returned counter as its
    `section_id`. `insertMatrixRecordWithExplicitId()` is the import/provisioning
    twin that takes a caller-chosen id and raises the counter to
    `GREATEST(value, section_id)` so a later auto-allocation can never reuse it.

## Files & structure

```text
src/core/db/
├── postgres.ts            connection pool + withTransaction + acquireNodeLock
├── matrix.ts              matrix READ + MATRIX_JSONB_COLUMNS / MATRIX_TABLE_ALLOWLIST
├── matrix_write.ts        matrix CRUD writes + item-id allocators + inserts
├── json_codec.ts          encodeForJsonb / decodeFromJsonb — the byte-compat chokepoint
├── time_machine.ts        matrix_time_machine read + recordTimeMachine audit write
├── dd_ontology.ts         dd_ontology CRUD/upsert/search + identifier grammar
├── db_assets.ts           schema-asset (re)build over the vendored definitions
└── db_pg_definitions.json the canonical extension/table/trigger/function/constraint/index SQL
```

There is **no record-object family and no row cache**. Raw record data is fetched
by the plain `readMatrixRecord()` function and resolved by the horizontal engines
(`src/core/resolve/`, `src/core/section/read.ts`) — never by a cached per-row
object. Resolution is request-scoped, so there is nothing to keep alive between
requests and nothing to invalidate.

### How the write pipeline dispatches into this layer

`src/core/section_record/record_write.ts` is the per-record write contract. It
owns the *shape* of a save (which keys, which columns, the delete-key guard) and
delegates the actual SQL to the db-layer functions — a normal component save
resolves to `updateMatrixKeysData(table, section_tipo, section_id, writes)`; a
whole-column replace to `updateMatrixRecord(...)`; a delete to
`deleteMatrixRecord(...)`. The matrix table for a tipo is resolved from the
ontology (`getMatrixTableFromTipo()`), never hardcoded.

### The single JSONB codec

`json_codec.ts` is the one place matrix JSONB values are encoded for a write.
`encodeForJsonb()` walks the value and **rejects** what JSON cannot represent
faithfully (`undefined`, `NaN`/`Infinity`, functions, symbols, dropped object
properties) rather than let `JSON.stringify` silently lose data. An unmodified
column can be passed through untouched as the branded `RawJsonText` — its raw
`::text` read — instead of being re-encoded. That is the lossless path: a column
nobody edited is written back byte-for-byte as it was read.

!!! warning "Bind jsonb as `::text::jsonb`"
    Bun's SQL client JSON-encodes a parameter it infers to be jsonb, which would
    double-encode a pre-encoded JSON string. Every write in this layer therefore
    binds jsonb values as `$n::text::jsonb`: the parameter is sent as text and
    Postgres parses it, keeping `json_codec` — not the driver — in charge of the
    byte-compat semantics.

## Public API

Grouped by concern. Names below are verified against the source; signatures are
abbreviated.

### Connection & transactions (`postgres.ts`)

| symbol | purpose |
| --- | --- |
| `sql` | The database handle used everywhere. A `Proxy` over the pool that, on every use, routes to the ambient transaction connection when one is active (see `withTransaction`) and to the pool otherwise. The tagged-template form ``sql`SELECT … ${value}` `` always binds values as parameters; `sql.unsafe(text, params)` is the positional-parameter form used when the query text is built from allowlisted identifiers. |
| `withTransaction(work)` | Run `work` inside a single `BEGIN … COMMIT/ROLLBACK` on one reserved connection; every query issued through `sql` while `work` runs is pinned to it, so in-transaction reads see in-transaction writes. A throw rolls back. Nesting **joins** the ambient transaction — no nested `BEGIN`, no savepoint. |
| `isInTransaction()` | `true` when the current async context is inside a `withTransaction` block. |
| `acquireNodeLock(sectionTipo, sectionId)` | `SELECT pg_advisory_xact_lock(hashtext('<tipo>_<id>'))` — a per-record transaction lock. Throws if called outside a transaction, where the lock would release immediately. |
| `closeDatabasePool()` | End the pool (tests and graceful shutdown). |

!!! note "Transactions flatten, they do not nest with savepoints"
    An inner `withTransaction` **joins** the outer one: the outer commit or
    rollback is authoritative. This is what stops composed mutation helpers — each
    defensively wrapping its own writes — from fragmenting one logical operation
    into several independent transactions.

### Matrix read (`matrix.ts`)

| symbol | purpose |
| --- | --- |
| `readMatrixRecord(tableName, sectionTipo, sectionId)` | `SELECT id, section_id, section_tipo, <each JSONB column + its ::text twin> … WHERE section_tipo=$1 AND section_id=$2 LIMIT 1`. Returns a `MatrixRecord` (`columns` parsed, `rawText` byte-exact) or `null`. |
| `assertMatrixTable(tableName)` | Throw unless `tableName` is in `MATRIX_TABLE_ALLOWLIST` (the identifier gate every read/write calls first). |
| `MATRIX_JSONB_COLUMNS` / `MATRIX_TABLE_ALLOWLIST` | The canonical column set and table allowlist (see [Data model](#data-model)). |

### Matrix write (`matrix_write.ts`)

| symbol | purpose |
| --- | --- |
| `updateMatrixRecord(table, sectionTipo, sectionId, values, options?)` | Whole-column upsert: UPDATE the given columns, INSERT the same columns if 0 rows matched. `values` is `{column: value}`; each jsonb value goes through the codec, or passes through as `RawJsonText` with `rawTextPassthrough`. Returns `'updated' | 'inserted'`. |
| `updateMatrixKeysData(table, sectionTipo, sectionId, writes)` | Surgical per-key update — one UPDATE covering every `{column, key, value}` pair. A non-null value upserts via `jsonb_set_lax` over `COALESCE(col,'{}')`; a `null` value **removes** the key with `#-` (a NULL column stays NULL; a column that loses its last key keeps `'{}'`). This is the call a component save resolves to. |
| `updateMatrixKeyData(table, sectionTipo, sectionId, column, key, value)` | Single-pair convenience wrapper over `updateMatrixKeysData`. |
| `allocateComponentItemId(table, sectionTipo, sectionId, componentTipo)` | Atomically allocate the next data-item id for a component (increment the per-component counter in the `meta` column via one `UPDATE … RETURNING`; row-level locking serializes concurrent allocations — no explicit advisory lock needed). |
| `absorbComponentItemIds(table, sectionTipo, sectionId, componentTipo, items)` | Raise a component's item-id counter to at least the highest explicit id in `items` (imports, migrations, restored data) so a later allocation can never reuse one. It never lowers the counter. Run it on every write that carries explicit item ids. |
| `insertMatrixRecordWithCounter(table, sectionTipo, jsonbColumns)` | INSERT a new record, allocating `section_id` from the matrix counter under an advisory lock, in one statement. Returns the new `section_id`. |
| `insertMatrixRecordWithExplicitId(table, sectionTipo, sectionId, jsonbColumns)` | INSERT with a caller-chosen `section_id` (import / ontology-provisioning path), raising the counter to `GREATEST(value, section_id)`. Throws if the row already exists. |
| `deleteMatrixRecord(table, sectionTipo, sectionId)` | `DELETE … WHERE section_tipo AND section_id RETURNING id`. Returns the number of rows removed (0 or 1). |

!!! warning "Column names are identifiers, keys are data"
    In `updateMatrixKeysData()` the **column** is interpolated into the SQL `SET`
    clause (PostgreSQL cannot bind a column name), so it is validated against
    `MATRIX_JSONB_COLUMNS`. The JSON **key** (the component tipo) is likewise
    checked against the tipo grammar `/^[a-z]+[0-9]+$/` before it is inlined into
    the jsonb path. Every value is a bound `$n::text::jsonb` parameter — data,
    never SQL. This is the injection boundary of the write path.

### JSON codec (`json_codec.ts`)

| symbol | purpose |
| --- | --- |
| `encodeForJsonb(value)` | Validate — rejecting `undefined`, `NaN`/`Infinity`, functions, symbols, `bigint` and dropped keys — and return compact JSON text (`RawJsonText`) to bind as a `::text::jsonb` parameter. Unicode is left unescaped. |
| `decodeFromJsonb(jsonText)` | Parse jsonb text back into a JS value (thin `JSON.parse` wrapper kept for auditability). |
| `asRawJsonText(jsonText)` | Brand a string as already-encoded JSON so a write passes it through untouched (the lossless path for an unmodified column read via `rawText`). |

### Ontology I/O (`dd_ontology.ts`)

The ontology lives in its own table (`dd_ontology`), keyed by `tipo`.
`dd_ontology.ts` is the ontology counterpart of `matrix_write.ts` and the WRITE
side of the ontology; the cached READ registry every engine resolves against lives
in `src/core/ontology/resolver.ts`.

| symbol | purpose |
| --- | --- |
| `upsertDdOntologyNode(node)` | Whole-row `INSERT … ON CONFLICT(tipo) DO UPDATE` writing every allowlisted column, so a re-parse never leaves stale data behind. Refuses a node that breaks the identifier grammar (below) before any SQL. Returns the row id. |
| `readDdOntologyRow(tipo)` | Read one raw node's columns by `tipo` (uncached probe for the parser). |
| `updateDdOntologyColumns(tipo, values)` | Partial column update of an EXISTING row — the sync-order path. An absent tipo answers `false` and writes nothing (there is no INSERT fallback). Checks the tipo and every identifier column it is given. |
| `deleteDdOntologyNode(tipo)` | Delete one node. |
| `searchDdOntology(values, order?, limit?)` | Filtered node search (scalar `=` or `{operator, value}` over an operator allowlist); returns matching tipos. |
| `getActiveTlds()` / `deleteTldNodes(tld)` | The installed-TLD set and per-TLD delete (`safeTld`-gated). |
| `ddOntologyIdentifierViolations(row)` | The identifier grammar as a pure predicate: every rule the row breaks, as `{column, value, reason}`. |
| `createRecoverySlice(tlds)` | Build the `dd_ontology_recovery` slice the recovery file dumps. Rows that break the grammar are left out and returned in `skipped`. |
| `validateDdOntologyIdentifierConstraints()` | VALIDATE each grammar constraint that is still NOT VALID and whose rule no stored row breaks; report the ones that stay blocked. |
| `dropBackupTable()` | Remove the `dd_ontology_bk` table an upgraded installation may still hold. The backup protocol itself is gone: a rebuild is one transaction. |

#### The identifier grammar

`tipo`, `parent`, `model_tipo`, `tld` and `properties.alias_of` are read back as
identifiers (the search engine builds queries from them, tree walks follow them), so
they obey one grammar, stated in the predicate, the write doors, and six CHECK
constraints on the table (migration `0013_dd_ontology_identifier_grammar.sql`):

| constraint | rule |
| --- | --- |
| `dd_ontology_tipo_grammar` | `tipo` is lowercase letters then digits (`dd55`, `rsc170`), at most 32 characters |
| `dd_ontology_parent_grammar` | `parent` is NULL or the same grammar, at most 32 |
| `dd_ontology_model_tipo_grammar` | `model_tipo` is NULL or the same grammar, at most 8 |
| `dd_ontology_tld_grammar` | `tld` is NULL or two or more lowercase letters, at most 32 |
| `dd_ontology_tipo_in_tld` | `tld` is NULL, or the tipo's letter prefix is exactly the tld (`rsc170` in `rsc`) |
| `dd_ontology_alias_of_grammar` | when `properties` is an object with an `alias_of` key, its value is a string in the tipo grammar, at most 32 |

The constraints are added NOT VALID: an installation that already holds violating rows
keeps booting and updating, and every row written from then on is checked. A legacy
violating row is also re-checked when anything UPDATEs it, so such a write is refused
with `ontology.invalid_node` naming the constraint. The reconcile `ontology_identifiers`
(`src/core/ontology/identifier_grammar.ts`) reports the violating rows (a dry run, also at
boot) and, applied by an operator, first deletes the rows that cannot be rebuilt (each
returned whole in the report and written whole to the server log), then rebuilds each
remaining row from its TLD's ontology source, and then VALIDATEs every clean constraint.
If that final VALIDATE fails, the report still comes back, listing the deleted rows and a
`validation_error`; run the reconcile again to validate. An ontology update runs the same validation
after its rebuild and lists any rows that still block it.

Every write fans out `clearOntologyDerivedCaches()` — the single invalidation
chokepoint, in `src/core/ontology/cache_invalidation.ts` — so no reader observes a
stale node.

### Time Machine I/O (`time_machine.ts`)

`matrix_time_machine` does **not** follow the standard matrix contract: rows are
flat audit columns, one row per component change. The dd15 virtual section
addresses a row by its own `id` (as `section_id`), while the row's `section_tipo`
column holds the **source** section — never filter TM by `section_tipo='dd15'`.

| symbol | purpose |
| --- | --- |
| `readTimeMachineRow(tmRowId)` | Read one TM row by its primary key (the dd15 `section_id`). |
| `readTimeMachineHistory(sourceSectionTipo, sourceSectionId, componentTipo, limit?)` | Change history of one component on one source record, newest first. |
| `recordTimeMachine(entry, timestamp)` | Append one audit row for a component data change; skipped for excluded sections and non-positive ids. Called by the save/delete pipeline. |
| `TimeMachineWriteHook` / `TimeMachineEntry` | The hook contract the save pipeline honours so Time Machine history cannot be silently dropped. |
| `nowDbTimestamp()` | The Postgres-style timestamp stamped on a Time Machine row. |
| `TIME_MACHINE_SECTION_TIPO` (`'dd15'`) / `TM_EXCLUDED_SECTIONS` | The virtual section tipo and the excluded-section set. |

### Schema assets (`db_assets.ts`)

| symbol | purpose |
| --- | --- |
| `createExtensions()` | Run the `CREATE EXTENSION` sentences (`pg_trgm` / `unaccent` / `btree_gin` — the trigram- and composite-indexes need them). |
| `rebuildTables()` | Create the declared derived-store tables (`matrix_string_search`) — **add-only** (see below). |
| `rebuildFunctions()` | Recreate the declared SQL functions (`f_unaccent`, `matrix_string_search_sync`, `matrix_relation_index_sync` …) via their `CREATE OR REPLACE` adds — **add-only** (see below). Drop-only cleanup entries (empty `add`) execute their recorded `drop` — e.g. the removed v6-era `data_relations_flat_*` family. |
| `rebuildTriggers()` | Per-declared-table drop + recreate of the row triggers (`{table}_string_search_sync`). |
| `rebuildConstraints()` / `rebuildIndexes(tables?)` | Per-entry, per-declared-table drop + add of constraints / indexes. |
| `execMaintenance()` | Run the `ar_maintenance` sentences (`REINDEX TABLE …` etc.). |
| `recreateDbAssets()` | The full sequence: extensions → tables → constraints → functions → triggers → indexes → maintenance. |
| `backfillSearchStores(onlyStores?)` | TRUNCATE + refill the derived stores (`matrix_string_search`, `matrix_relation_index`) from the source tables, one transaction per store, then `ANALYZE`. Row filters mirror the sync trigger functions exactly. Exposed as the `backfill_search_stores` widget action (manual repair). |
| `ensureSearchStores()` | Boot self-provisioning (startServer, after migrations, before serving): cheap catalog probes on a healthy install; a missing store table/trigger triggers the targeted DDL pass, a store empty-with-producible-sources triggers that store's backfill. Heals a previous-beta database on restart with no operator action. |
| `optimizeTables(tables)` | Per validated table, `REINDEX TABLE CONCURRENTLY` then `VACUUM ANALYZE`. |

`db_pg_definitions.json` declares the extensions, tables, triggers, functions,
constraints, indexes and maintenance sentences; `db_assets.ts` consumes it, so
every schema extra is declared in exactly one place.

!!! warning "Function/table rebuilds are add-only — the recorded `drop` is a definition, not a routine step"
    Every function/table entry keeps its `drop` DDL **recorded** (it is the
    deliberate-teardown definition), but `rebuildFunctions()` /
    `rebuildTables()` execute only the idempotent `add` (`CREATE OR REPLACE` /
    `IF NOT EXISTS`); the `drop` runs solely for pure-cleanup entries whose
    `add` is empty. Executing `DROP FUNCTION … CASCADE` on a routine rebuild
    silently destroys every dependent object — measured in the wild
    (2026-07-19): one standalone function rebuild cascade-dropped all 96
    `data_relations_flat_*` functional GIN indexes and turned record edit
    views into 18 s loads until they were rebuilt. A function **signature**
    change makes the add fail loudly — that is a deliberate migration: run the
    recorded drop by hand and rebuild the dependents explicitly. The contract
    is pinned by `test/unit/db_assets_definitions.test.ts`.

## How it fits with the rest of Dédalo

- **The write pipeline is the main caller of the matrix functions.** A component
  reads via the section-read engines and writes via
  `section_record/record_write.ts`, which resolve to `readMatrixRecord()` /
  `updateMatrixKeysData()`. Resolution code never issues SQL directly.
- **Search compiles down to `sql`.** The [SQO](../../api/sqo.md) search engine in
  `src/core/search/` builds a prepared statement over the JSONB matrix columns and
  runs it through the shared `sql` handle (Bun's client caches/prepares
  statements itself; there is no hand-rolled prepared-statement registry to
  invalidate).
- **The ontology is itself matrix/`dd_ontology` data.** The active schema (areas,
  sections, components, tools) is stored in `dd_ontology` and read/written through
  `dd_ontology.ts` / `resolver.ts`. See the
  [architecture overview](../architecture_overview.md#the-ontology-is-the-active-schema).
- **Time Machine** snapshots flow through `time_machine.ts`; the save and delete
  pipelines append audit rows via `recordTimeMachine()`.
- **Diffusion is out of scope.** Publication data goes to MariaDB via the Bun
  diffusion engine, not through this layer. See the
  [architecture overview](../architecture_overview.md#the-two-systems).

## Examples

### Run a unit of work in a managed transaction

```ts
// Commits on success; rolls back and rethrows on any throw.
const newId = await withTransaction(async () => {
    const id = await insertMatrixRecordWithCounter('matrix', sectionTipo, values);
    // ... more writes, all pinned to the same connection ...
    return id;
});
```

### Lock a record before mutating it (must be inside a transaction)

```ts
await withTransaction(async () => {
    // serialize concurrent writers on this exact record
    await acquireNodeLock(sectionTipo, sectionId);

    // ... read-modify-write the row safely ...
    await updateMatrixKeysData('matrix', 'oh1', 5, [
        { column: 'string', key: 'oh25', value: ['Hello'] },
    ]);
});
```

### A surgical per-key write (what a component save becomes)

```ts
// set string.oh25 = ['Hello'] and clear meta.oh25 in one UPDATE
await updateMatrixKeysData('matrix', 'oh1', 5, [
    { column: 'string', key: 'oh25', value: ['Hello'] },
    { column: 'meta',   key: 'oh25', value: null }, // null removes the key
]);
```

### Read a record with automatic JSON decoding + a byte-exact twin

```ts
const record = await readMatrixRecord('matrix', 'oh1', 5);
if (record !== null) {
    record.columns.string;   // already parsed (a JS value)
    record.rawText.string;   // the byte-exact ::text of the same column (parity)
}
```

!!! note "Prefer the high-level path"
    The examples above touch the db functions directly to document the surface. In
    application code you almost always go through the section-read engines /
    `section_record/record_write.ts` and the [SQO](../../api/sqo.md) engine — those add
    the metadata, Time Machine, permission and relation handling that the raw
    functions deliberately do not.

## Related

- [section_record](../sections/section_record.md) — the per-record write contract; the main caller of the matrix write functions.
- [section](../sections/section.md) — the section type/orchestrator; resolves records through the read engines.
- [Sections concept](../sections/index.md) — the matrix table model and the typed-JSONB column split.
- [Architecture overview](../architecture_overview.md) — the work-vs-diffusion split, the matrix data model, the request lifecycle.
- [SQO](../../api/sqo.md) — the search query object compiled into prepared SQL over the matrix columns via the `sql` handle.
- [Locator](../locator.md) — the pointer type stored in the `relation` column.
