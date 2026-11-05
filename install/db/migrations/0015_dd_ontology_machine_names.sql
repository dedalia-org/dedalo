-- 0015 — dd_ontology.machine_name + use_machine_name: language-free node names (2026-11-04).
--
-- SHARED-SCHEMA ADDITIVE COLUMN: two nullable, default-less columns on the
-- ontology runtime table (and on its static recovery-slice twin), which the
-- parser derives for every node from the machine-name components ontology43 /
-- ontology44. No existing row changes meaning: `model`, `term` and every other
-- column read exactly as before.
--
-- WHAT THE COLUMNS MEAN (src/core/ontology/machine_name.ts, the writer home;
-- WC-2026-11-04-ontology-machine-names):
--   machine_name      text     the node's language-free name (a model name, a
--                              table/column/database name, an rdf/owl QName, the
--                              diffusion domain token); NULL unless
--                              use_machine_name
--   use_machine_name  boolean  true → machine_name is the node's name; false →
--                              the node is named by its translatable label
--                              (term); NULL → no parser has derived the row yet
-- DERIVED ONLY: written by the parser (rebuildOntology) and the upsert door,
-- never by hand. Every existing row reads NULL / NULL after this file: inspect
-- reports it `stale` (machine_name, use_machine_name) and the tld's next
-- rebuild — the ontology update, the `ontology` reconcile, the parser tool —
-- fills both. Until then the parser's bridge rung reads a NULL model row's
-- name from its term['lg-spa'], so `model` is unchanged.
--
-- WHY THIS IS SAFE: ADD COLUMN with no DEFAULT and no NOT NULL is
-- METADATA-ONLY (no rewrite, no scan, no backfill). The instant ACCESS
-- EXCLUSIVE lock is bounded by lock_timeout and a timeout is retried by the
-- runner (install/db/migrate.ts, SQLSTATE 55P03). SET LOCAL dies with this
-- migration's transaction.
--
-- dd_ontology_recovery: the install seed ships it as a static table whose
-- columns must stay a superset of dd_ontology's (createRecoverySlice re-creates
-- it LIKE dd_ontology, then INSERT … SELECT *), so it gains the same pair.
--
-- IDEMPOTENT: IF NOT EXISTS on every column.

SET LOCAL lock_timeout = '5s';

ALTER TABLE dd_ontology ADD COLUMN IF NOT EXISTS machine_name text NULL;

ALTER TABLE dd_ontology ADD COLUMN IF NOT EXISTS use_machine_name boolean NULL;

ALTER TABLE IF EXISTS dd_ontology_recovery ADD COLUMN IF NOT EXISTS machine_name text NULL;

ALTER TABLE IF EXISTS dd_ontology_recovery ADD COLUMN IF NOT EXISTS use_machine_name boolean NULL;

COMMENT ON COLUMN dd_ontology.machine_name IS 'Language-free node name (ontology43); NULL unless use_machine_name. Derived by the parser.';

COMMENT ON COLUMN dd_ontology.use_machine_name IS 'True: machine_name is the node name (ontology44); false: named by its label (term); NULL: not derived yet.';
