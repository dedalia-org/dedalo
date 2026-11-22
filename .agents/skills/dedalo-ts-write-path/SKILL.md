---
name: dedalo-ts-write-path
description: >-
  Writing to the matrix Postgres safely in the Dédalo v7 TypeScript/Bun engine — the one JSONB serializer (encodeForJsonb), the ::text::jsonb Bun.sql bind trap, transaction wrapping (withTransaction) and its two post-tx lanes (registerCommitAction vs deferPostTransaction), the locator equality law (compareLocators), the one TM/data timestamp (dbTimestamp), atomic matrix DML (insertMatrixRecordWithCounter / updateMatrixRecord). Use when editing src/core/section/record/** (create/delete/duplicate_record.ts, save_component.ts), src/core/relations/save.ts, src/core/db/{json_codec,postgres,matrix_write,db_timestamp}.ts, src/core/concepts/locator.ts, ANY INSERT/UPDATE/DELETE touching matrix_* or dd_ontology, or debugging ERR_POSTGRES_UNSAFE_TRANSACTION, a lost update, a double-encoded jsonb string scalar, a re-minted section_id, or a wrong-row write. Tripwires: ws_a_tripwires, sql_confinement_tripwire, matrix_counter_monotonic_tripwire, module_state_tripwire.
---

# Dédalo v7 write path (matrix Postgres)

TS/Bun is the single engine and sole writer of the matrix Postgres (PHP decommissioned 2026-07-11). The rules below are not niceties: each is a fixed S1/S2 finding from the 2026-07 foundation audit (`audits/2026-07_foundation/`, local-only, gitignored), and each is guarded by a **tripwire** because "documented but untripwired invariants all rotted" is that audit's central lesson. Break a rule and the guard test goes red; there is no "I'll be careful" path.

**The load-bearing rule:** never hand-roll a matrix write. Serialize JSONB with `encodeForJsonb`, run DML through the `src/core/db` writer homes, wrap saves in `withTransaction`, compare locators with `compareLocators`, and stamp time with `dbTimestamp`. Five helpers, no exceptions.

Measured state (gate numbers, open gaps) lives in the local-only ledger rewrite/LEDGER.md — do not restate it here. Tripwire index: `engineering/TRIPWIRES.md`.

## 1. The ONE JSONB serializer — `encodeForJsonb`

`encodeForJsonb(value)` (`src/core/db/json_codec.ts`) returns a branded `RawJsonText` and is the ONLY thing allowed to produce the JSON string for a matrix JSONB write.

Why it exists: raw `JSON.stringify` silently drops `undefined` object properties and turns `NaN`/`Infinity`/`undefined` array slots into `null` — silent data loss on a write path. The codec **rejects** all of them loudly, preserves `[]` vs `{}` verbatim, and keeps the stored shape identical to the historical rows already in the matrix, in one place.

Enforced by: **`test/unit/ws_a_tripwires.test.ts`** (§S2-07, "json_codec owns encoding").

## 2. The `::text::jsonb` bind trap (Bun.sql)

Bun.sql infers a bound plain object / native array as jsonb and **JSON-encodes it itself**. If you pass `encodeForJsonb`'s output (already a JSON string) to a `$n::jsonb` param, it arrives **double-encoded** — stored as a jsonb *string scalar* `'"{...}"'` instead of the object. This bit the TM repair script twice.

The rule: bind app-encoded JSON as **`$n::text::jsonb`** (text in, cast to jsonb server-side — no Bun re-encode). For arrays passed as a param, use **`string_to_array($n, ',')`** (live example: `src/core/relations/select_lang.ts` `resolveProjectLangs`, `= ANY(string_to_array($2, ','))`).

Enforced by: **`ws_a_tripwires.test.ts`** — every placeholder feeding a matrix jsonb column in a write position must carry `::text::jsonb` (small object-binding allowlist for TS-owned jobs tables).

## 3. Wrap saves in `withTransaction` — never raw `BEGIN`

`withTransaction(work)` (`src/core/db/postgres.ts`) reserves ONE pooled connection, opens `BEGIN…COMMIT/ROLLBACK` on it, and stashes the reserved handle in an **AsyncLocalStorage** (`transactionStore`) so every ambient `sql\`…\`` issued inside `work` routes onto that same reserved connection.

Why: a save reads-then-writes under `SELECT … FOR UPDATE`. If the lock and the write land on **different pooled connections**, the lock is worthless and a concurrent request writing the same row clobbers you — the lost-update bug (S1-02 / DEC-01). Wrapping keeps the `FOR UPDATE` row-lock held to commit.

Never issue a raw `BEGIN`: **Bun pooled connections reject it** with `ERR_POSTGRES_UNSAFE_TRANSACTION`. Nested `withTransaction` is a no-op join (no inner BEGIN/savepoint); the outer commit is authoritative. In-tx reads never seed shared caches, and cache clears fired inside a tx are deferred and replay after the tx settles (COMMIT **or** ROLLBACK — see the lanes below).

**Two post-tx lanes, NOT interchangeable** (both in `postgres.ts`, each its own ALS store): `registerCommitAction` fires ONLY on COMMIT (awaited, outside the tx) and is discarded on ROLLBACK — the lane for deferred WRITES (the observer cascade schedules its hops here); `deferPostTransaction` replays on COMMIT **and** ROLLBACK — synchronous, idempotent cache invalidation only, **never writes**. Both return `false` when the ambient queue already drained (a leaked continuation past `withTransaction`, S2-14); the caller then owns the action.

Every record write also owes post-commit **observer propagation** and the `_hi` **`relation_search`** index — and since CLOSURE_PLAN Step 2 (2026-10-01, `WC-2026-09-30-record-write-obligation-ledger`) the CHOKEPOINT owns both, never a door. `afterRecordWrite` REQUIRES an `observed` declaration (`keys` before/after, `replace`, `birth`, `death`, `recompute`, `cascade-owned`, or `none` + reason; missing = typed refusal) and enqueues it on the obligation ledger (`src/core/section_record/obligation_ledger.ts`), which drains on the `registerCommitAction` lane — so propagation never runs inside your transaction (it REFUSES to; the old in-tx rethrow lane is gone) and a ROLLBACK, or a savepoint rollback, discards exactly its own entries. `relation_search` is derived by `relations/save.ts deriveRelationSearch` and written by the chokepoint in the SAME UPDATE as the value (SAVE law for saves/restores/recomputes; REMOVAL law at the portal unlink, the delete's inverse strip and the data wipe). Pick the right entry: `persistRecordKeys` (a save), `persistRestoredKeys` (a component restore — a restored covered mirror is recomputed, never propagated), `persistRelationRemovalKeys` (removal doors), `persistObserverMirrorKeys` (the recompute's own write), `persistAppendedKeyItems` (pure append), `persistRecordBirth` (undelete); the per-key kernel `writeKeys` has exactly four callers and `write_obligations_tripwire` B4 holds that. `files_info` is NOT an obligation: it is written only through the one locked media-key writer (`media/tools/files_info_persist.ts transformStoredMediaItems` — read under the row lock, transform synchronously, own short transaction, refused inside yours, `lockWait` declared). The observer subsystem itself — discovery, the mirror value law, covered slots, the degraded-seed shrink refusal — is the **`dedalo-observers-ts`** skill.

## 4. The locator law — `compareLocators`

A locator (`section_tipo` + `section_id` + component coords) is how two records point at each other. Equality (ported from PHP `property_exists` semantics) lives in ONE place: `compareLocators` (`src/core/concepts/locator.ts`) / `isLocatorInArray`.

Why it is a law: two matchers that disagree by even a hair (e.g. an inline `String(section_id) === …` vs the canonical 5-field predicate) resolve the "same" locator to **different rows** → you write to, or delete an inverse-ref from, the WRONG record (S1-06 / S2-03 / S2-04, DEC-21). NEVER inline a `String(section_id)` compare or a 2-field join.

**section_id is INT-CANONICAL** (WC-2026-08-10-section-id-int-canonical): every locator writer applies `canonicalizeStoredSectionId` (`src/core/concepts/section_id.ts`) — convertible string → int, EVERYTHING else verbatim (external remote ids are protected by the value invariant: never strict-numeric-without-leading-zeros). Minting `section_id: String(...)` is a tripwired recontamination source (`section_id_int_tripwire` — named exemptions only: diffusion→MariaDB rewriters, inline tag markers, the locks text-table key, dual-probe variant generators). Pre-sweep stored data still carries strings, so `compareLocators`' loose section_id equality stays, and any jsonb `@>` probe over locator data must be dual-form + polarity-aware (`src/core/search/containment.ts` — a single-form probe silently returns 0 rows on the other typed half).

Enforced by: **`ws_a_tripwires.test.ts`** (locator-law ratchet) — no NEW inline section_id compares outside the allowlisted files.

## 5. The ONE timestamp — `dbTimestamp`

Every TM/data stamp path uses `dbTimestamp()` (`src/core/db/db_timestamp.ts`), which emits **wall-clock time in `config.timezone` (DEDALO_TIMEZONE)** — the same local wall-clock shape every historical TM row already carries.

Why: if one path stamps UTC while the stored history is local, the Time Machine history **interleaves out of order** and a restore replays the wrong sequence (S1-03). One helper, timezone-aware, everywhere.

## 6. Atomic matrix DML — the `src/core/db` writer homes only

Matrix / dd_ontology `INSERT/UPDATE/DELETE` never appears as ad-hoc SQL. **Tiered SQL confinement** (DEC-09), enforced by **`test/unit/sql_confinement_tripwire.test.ts`**:
- **T1** `new SQL(` only in the sanctioned pool owners: `src/core/db/postgres.ts` (system of record), `src/ai/rag/vector_store.ts` (separate pgvector DB), `src/diffusion/targets/mariadb/db.ts` (MariaDB publication target).
- **T2** matrix_*/dd_ontology DML lives in the per-family **writer homes**: `matrix_write.ts` (record tables + matrix_updates), `time_machine.ts` (matrix_time_machine), `dd_ontology.ts` (dd_ontology*), `db_assets.ts` (derived search stores). Every other site is an enumerated, shrink-only entry with an exact write count; plus the P0-3 rule (no unlocked jsonb read paired with a jsonb UPDATE outside `matrix_write.ts`). Counter tables are owned by `matrix_counter_monotonic_tripwire`.
- **T3** dd_ontology reads via `core/ontology` accessors (ratchet); **T4** named subsystem tables keep local SQL, one owner each.

Key `matrix_write.ts` exports and their pinned guarantees:
- `insertMatrixRecordWithCounter` — THE id allocator. **A section_id is never re-minted** (P0-14): the counter is a high-water mark, not a live-row count. The born-row INSERT is `ON CONFLICT DO NOTHING`; on a collision (stale counter) it realigns the counter to `GREATEST(value, counterFloorExpression)` — the historical max over live rows **and** `matrix_time_machine` — and retries once (S2-01). No writer may lower a counter (`test/unit/matrix_counter_monotonic_tripwire.test.ts`).
- `insertMatrixRecordWithExplicitId` — caller-chosen id; raises the counter with GREATEST.
- `updateMatrixRecord` / `updateMatrixKeyData` / `updateMatrixKeysData` — per-key jsonb writes (the save path).
- `deleteMatrixRecord` — the row delete inside the atomic delete phase.
- `allocateComponentItemId` / `absorbComponentItemIds` — per-item id counters (live in the `meta` column; absorb raises meta to max id).

Record-lifecycle homes (the callers): `src/core/section/record/{create,delete,duplicate}_record.ts` + `save_component.ts`, and relation save hooks in `src/core/relations/save.ts` — all writing through the chokepoint `src/core/section_record/` (`record_write.ts` `persist*` → `afterRecordWrite`, `obligation_ledger.ts`; above).

**Atomicity invariants (each verified by its dedicated native gate):**
- **Delete is one transaction** (S2-02, `delete_record.ts` `deleteSectionRecord`): snapshot + TM audit row + the record's own frame policies + inverse-reference rewrites + the row delete + the RAG delete event (S2-13) + the dd1758 diffusion **unpublish-intent** rows (LIFE-07, `ledgerUnpublishIntent`) all commit together; **media file moves, settling the unpublish intent, cache invalidation and observer propagation run POST-COMMIT** (irreversible side-effects never inside the tx).
- **Dataframe cascade on all three removal paths** (S1-05): removing a locator/item strips its paired frame entries (`delete_record.ts` per-removed-locator cascade; `save_component.ts` `remove` cascade). Gate: `test/unit/dataframe_cascade_removal.test.ts`.
- **Duplicate refreshes media `files_info`** (S1-04): every copied media item re-scans against the new paths and persists the refreshed `files_info` onto the new row (per-key write, no TM). See `duplicate_record.ts`.

## 7. `set_data` is LANG-SLICED for translatable literals

`saveComponentData` `set_data` is **not** a whole-array replace on the translation-supporting literal models (`classSupportsTranslation`: input_text, text_area, email, iri, password). Ported from PHP `set_data_lang` (`component_common.php:4380` in the frozen tree): only the **effective-lang slice** is replaced; other-lang stored items are preserved; lang-orphan stored items are dropped; every new item is clone-stamped with the slice lang. Relations and non-literal models keep the flat replace.

Consequences for callers:
- **Saving a multi-language dato = one `set_data` call PER LANG.** Group with `groupItemsByLang` (`src/core/tools/import_data.ts`) — a flat merged save re-stamps every translation onto one lang (the pre-2026-07-16 import bug: each lang save wiped the previous one).
- An empty `set_data` (`value: []`) clears ONLY that lang's slice for these models.
- Gates: `test/unit/tool_import_dedalo_csv.test.ts` (v6 multi-lang cell import + flat-save slice preservation), `test/unit/tool_update_cache.test.ts` (regenerate preserves both langs un-duplicated), `test/unit/save_multilang_siblings.test.ts` (the sibling-preservation twin for `update`).

## Caches & request state (why writes never leak across requests)

The write path reads request identity from ALS: request-lang (`currentApplicationLang`/`currentDataLang`, seeds lang-scoped writes) and request-context (`currentPrincipal`, seeds the audit actor), beside the three transaction-side stores in `postgres.ts` (tx handle, deferred queue, commit-only lane). A write that reads the wrong principal or lang stamps the wrong row. **Never hand-roll a module-level `Map`/`Set`/`let` carrying request/principal/lang state** — that is cross-request bleed; use `createOntologyCache`/`createDataCache` (`src/core/ontology/cache_factory.ts`) for request-derived caches. Guarded by `test/unit/module_state_tripwire.test.ts`.

Full model — the stores, the cache factories, in-tx seeding rules, background-job identity: the **`dedalo-ts-isolation-caching`** skill. Authoritative: `engineering/REQUEST_ISOLATION.md`.

## Config

Read env only via `readEnv` / `requireEnv` (`src/config/env.ts`); typed catalog in `src/config/config.ts` (`config.timezone`, `config.ops.*`, etc.). **No direct `process.env` outside `src/config/`** — tripwired by `test/unit/config_env_tripwire.test.ts`.

## Verifying a write

Write-path contracts are **TS-native gates**: `test/unit/*_native.test.ts` (the retired PHP differentials' twins are mapped in `engineering/ORACLE_HARVEST.md`, DEC-14b). They BUILD their situation — generic `test` TLD / `zz*` scratch TLDs materialized through the engine's own write path (`src/core/test_data/`), records created at runtime, torn down after — and assert against it. A deliberate change to a pinned wire shape needs its `engineering/wire_contract/` entry the same day. Test design: the **`dedalo-ts-testing`** skill.

**Scratch-write hygiene — NEVER mutate a real record.** Tests write only to the dedicated SUITE database (`<app db>_test`, built by `bun run test:db:setup`, stamped with the `dedalo_test_marker` row); every test-data writer calls `assertTestDatabase()` (`src/core/test_data/test_database_marker.ts`) before its first write and is refused on a database without the marker. There is NO reserved section_id band — isolation is the database, never an id range. (`dedalo_ts_test_*` is only the MariaDB diffusion scratch prefix.)

## When you add a new write path

1. Serialize JSONB with `encodeForJsonb`; bind it `$n::text::jsonb` (arrays via `string_to_array`).
2. Route DML through the `src/core/db` writer home for that table family; wrap the save in `withTransaction`.
3. Compare locators with `compareLocators`; stamp with `dbTimestamp`.
4. Keep irreversible side-effects (media/diffusion/cascade writes) POST-COMMIT — `registerCommitAction` for writes, never `deferPostTransaction`.
5. Add/extend a `*_native.test.ts` gate on the suite DB; a new site outside the writer homes needs an enumerated `sql_confinement_tripwire` entry with its reason.

Authoritative rules: `engineering/CONVENTIONS.md` (§1 errors — fail loud, never silently narrow; §2 dynamic imports), `engineering/REQUEST_ISOLATION.md` (the ALS model), `engineering/TRIPWIRES.md` (the tripwire index).
