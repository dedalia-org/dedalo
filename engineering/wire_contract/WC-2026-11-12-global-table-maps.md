# WC-2026-11-12-global-table-maps — `global_table_maps` is ported: global (aggregate) tables are written, refreshed and withdrawn again

- **Date:** 2026-11-12 (RC-closure T1-3 / audit O09).
- **Decision:** DEC-12 (gate in the same change). Owner decision T1-3 D1 (a map naming a
  column that does not exist) is OPEN — the behaviour below for that case is the pre-port one,
  not a ruling. D2 (correcting the vendored mdcat / numisdata maps) belongs to the master
  ontology.

## Shape before (v6)

- `diffusion_sql::update_record` (:277-302): after the source save, per map →
  `save_global_table_data` (:2477-2652). Maps read from the table node's own properties, else
  the real table's (key-level alias fallback).
- Per (record, lang) row: `section_id = "<section_tipo>_<section_id>"`, `ref_section_id`,
  `ref_section_tipo`, `lang`, `ref_table`, `link` (`{table, section_id}` JSON), then each
  `columns_map` item (sources JSON-decoded, `format:'string'` → implode with `separator`,
  default `' | '`; else one source → the value, two or more → JSON array). Delete by the
  composite key, then insert. Columns the global table does not declare were SKIPPED silently;
  a single source not found wrote `0`.
- Unpublish (`publication=no`, :1439-1483) deleted the global row. Record DELETE
  (`diffusion::delete_record`) did NOT — a deleted record stayed public in the global table.

## Shape before (TS, 2026-07-11 → this entry)

- `compile.ts` pushed the warning `global_table_maps:<table tipo>` and nothing else: no writer,
  no delete, no reconcile knew a global table. Every install's global tables
  (mdcat `global_search`, numisdata `map_global`, dd `globalontology`) froze at the cutover.

## Shape after (TS)

- **Plan / `validate` payload:** `sections[].globalTables?: GlobalTablePlan[]`
  (`{tableTipo, schema, keyLength, provenance, columnsMap}`, `src/diffusion/plan/types.ts`).
  The warning `global_table_maps:<tipo>` is GONE. New refusals (compile errors): a map without
  `table_tipo`; a `table_tipo` missing in an installed package; a target that is not a `table`
  node; a global name the SQL identifier chokepoint rejects; maps on a non-sql element; a global
  name equal to a source table of the element; two nodes under one global name; a global table
  wider than MariaDB's row ceiling; a malformed `columns_map` item. A `table_tipo` in an
  uninstalled package → `uninstalled-tld:<tld>@<table_tipo>` warning, map skipped.
- **Published table:** the global node's OWN direct field children are its columns;
  `section_id` is `VARCHAR(<its section_id field varchar>, default 255) NOT NULL`, PK
  `(section_id, lang)`, additive-only like every target table. Provenance columns are written
  only when the node declares them.
- **Writes:** in the SAME MariaDB transaction as the source batch — DELETE by composite key,
  then multi-row INSERT (refreshes values, drops a lang the record no longer has, holds on a
  legacy table without the composite key). `removeRecords` deletes the global rows of the
  unpublished ids. Run summary `tables[]` includes each global table.
- **Withdrawal (DELIBERATE DIVERGENCE 1):** the record-delete door deletes the record's global
  rows too (`DiffusionSqlTarget.global_tables`), and a target is confirmed (dd1758
  `unpublished`) only when its own row AND every global row are gone — otherwise pending, retried.
  The `public_tier` reconcile compares global tables per section (`<st>\_%` keys): ghosts carry
  `global: true`; apply deletes them. v6 left a deleted record public.
- **Values (DELIBERATE DIVERGENCES 2-4):** (2) a non-scalar inside `format:'string'` renders as
  compact JSON (v6 pretty-printed), an empty array as `''` (v6 `Array(empty)`); (3) a source
  column is always found (the compiler proved it exists), so a NULL value writes NULL (v6 could
  write `0` for a source it did not find); (4) the key column is always VARCHAR (v6 created INT
  unless the node overrode `section_id`).
- **UNRULED (D1):** a map naming a target the global node does not declare, or a source that is
  neither a source-table column nor `section_id`/`lang`, is NOT written (whole map — the
  pre-port behaviour) and reported as `global_table_maps_unruled:<table tipo>><global tipo>:
  <columns>`. Real cases in the vendored ontology: `filter_date` on mdcat260 / mdcat1133 /
  mdcat1332 → mdcat4500; sources `coins`, `types` on numisdata701.
- **Legacy tables:** a pre-existing global table whose `section_id` is INT cannot hold the
  composite key → MariaDB error, loud run failure; the operator drops / recreates it.

## Reason

Global tables feed the public search and map layers; frozen since the cutover they served
missing, stale and withdrawn heritage records. Repair on an install: republish the affected
elements, then run the `public_tier` reconcile (apply) to withdraw rows of records deleted
meanwhile.

## Gate reconciliation

- `test/unit/diffusion_global_table_native.test.ts` — compile on the zzdif global element
  (zzdif100 → zzdif110); hermetic compile laws incl. the D1 status-quo pin; pure row derivation;
  a real `runJob` into the suite MariaDB (rows per lang, VARCHAR key, planted unpublishable /
  stale-lang rows removed, refresh, idempotence); the delete door (confirmed / pending when only
  the global row fails); the reconcile ghost + apply. Mutation-verified RED: no global DELETE in
  `removeRecords`, key without the section prefix, target confirmed on its source row alone,
  reconcile without the global branch.
- Fixtures: no frozen parity fixture covers a global table — no fixture edit, no re-harvest.
