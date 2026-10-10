---
name: dedalo-ontology-ts
description: The Dédalo v7 TS/Bun ONTOLOGY pipeline — the dd_ontology write layer, the parse_section_record_to_ontology_node parser, the write drivers (setRecordsInDdOntology + ontology_state inspect/rebuild), hierarchy provisioning + the HIERARCHY INVARIANT (hierarchy_state.ts, the single writer), and the tool_ontology/tool_ontology_parser/tool_hierarchy handlers. Use when editing src/core/db/dd_ontology.ts, src/core/ontology/{parser,ontology_write,ontology_state,hierarchy_state,hierarchy_provision,ontology_delete}.ts, src/core/install/hierarchy_activate.ts, tools/tool_{ontology,ontology_parser,hierarchy}/server/*.ts, or debugging a wrong parsed dd_ontology row, a stale/missing/orphaned/foreign drift item, a provisioned thesaurus that is wrong, or a hierarchy that cannot be activated (dangling general-term root, bare active locator, missing ontology). Shared foundation with dedalo-tree-ts. Historical PHP reference (frozen): class.ontology.php, class.hierarchy.php.
---

# Dédalo v7 ontology pipeline (TypeScript rewrite)

Dédalo keeps ontology in TWO layers, bridged by a parser. The frozen PHP tree (`v7_php_frozen/master_dedalo`, outside the repo) is historical reference for how behaviour was ported — never an oracle. Never silently narrow; throw + ledger the gap in the file header.

1. **STRUCTURE (editable source of truth):** matrix records — `matrix_ontology` (nodes) + `matrix_ontology_main` (`ontology35`/TLD-family rows); thesauri twins `matrix_hierarchy` + `matrix_hierarchy_main` (`hierarchy1` rows).
2. **ACTIVE (runtime, flat):** `dd_ontology` (v6 `jer_dd`, dead in v7). One row per node: `tipo, parent, term(jsonb), model, order_number(int), relations(jsonb), tld, properties(jsonb), model_tipo, is_model, is_translatable, is_main, propiedades(TEXT, v5 legacy)`. This is what `src/core/ontology/resolver.ts` READS at runtime.

**Identity:** tipo = TLD + section_id. Ontology main sections are ALWAYS `<tld>0` (dd0, rsc0, ontology0…). A hierarchy record with TLD `es` provisions sections `es1` (descriptors) / `es2` (models). See `src/core/ontology/tld.ts`. `ontology35` is a VIRTUAL section of `hierarchy1` — the same component model backs both, which is why the parser/tools read `hierarchy5/6/9/53` components off `ontology35`/`matrix_ontology_main` rows.

## Shared foundation (also used by dedalo-tree-ts)
`src/core/db/postgres.ts` `withTransaction`/`acquireNodeLock`; `ontology/tld.ts`; `ontology/ontology_tipos.ts` (ONTOLOGY_TLD='ontology7', ONTOLOGY_PARENT='ontology15', ONTOLOGY_IS_MODEL='ontology30', ONTOLOGY_MODEL='ontology6', ONTOLOGY_ORDER='ontology41', ONTOLOGY_TRANSLATABLE='ontology8', ONTOLOGY_CONNECTED_TO='ontology10', ONTOLOGY_PROPERTIES/CSS/SOURCE/PROPIEDADES_V5='ontology18/16/17/19', ONTOLOGY_TERM='ontology5', HIERARCHY_*, SECTION_MODEL_TIPO='dd6', STRUCTURE_LANG=`config.lang.structureLang` — `DEDALO_STRUCTURE_LANG`, only lg-spa accepted); `ontology/cache_invalidation.ts` `clearOntologyDerivedCaches()` — called after EVERY dd_ontology write.

## Layers
```
src/core/db/dd_ontology.ts        # PHP dd_ontology_db_manager: upsert/read/update/delete/search + getActiveTlds + deleteTldNodes + dropBackupTable (legacy dd_ontology_bk cleanup only) + the identifier grammar (ddOntologyIdentifierViolations; both write doors refuse ontology.invalid_node before SQL; six NOT VALID CHECKs, migration 0013; repair = reconcile ontology_identifiers). Every write ends with clearOntologyDerivedCaches().
src/core/ontology/parser.ts       # parseSectionRecordToOntologyNode + getOverwriteLocator + getTermIdFromLocator + phpPrettyJsonEncode
src/core/ontology/ontology_write.ts  # insertDdOntologyRecord, setRecordsInDdOntology, createDdOntologyRootNode, createParentGrouper, createMainSection/syncMainSectionFromDefinition/ensureMainSection (the registry-row law, see its block comment), getMainTld/Typology/NameData, syncOrderToDdOntology
src/core/ontology/hierarchy_provision.ts  # generateVirtualSection (ONE tx; refuses an already-provisioned tld)
src/core/ontology/hierarchy_state.ts     # ⭐ THE hierarchy invariant + THE only writer: inspectHierarchy / ensureHierarchy / rebuildHierarchy / inspectAllHierarchies
src/core/ontology/ontology_state.ts      # ⭐ THE dd_ontology reconcile authority: inspectOntology (drift: missing/stale/orphaned/foreign) / rebuildOntology (transactional wipe-and-rebuild). No incremental ensureOntology (removed 2026-08-11 — see its header). regenerateRecordsInDdOntology is RETIRED onto this.
src/core/ontology/ontology_delete.ts     # deleteOntologyByTld (ontology only — TERMS survive) + deleteOntologyMain (that + the caller's registry record: the dd_core_api delete cascade)
src/core/install/hierarchy_activate.ts   # install-time activation: find-or-create the registry record from the hierarchy.json manifest entry (hierarchy_meta.ts), then ensureHierarchy
tools/tool_{ontology,ontology_parser,hierarchy}/server/*.ts  # tool handlers (self-contained tool packages; import the core drivers above)
```

### The hierarchy law (2026-07-14) — read before touching ANY hierarchy write
A usable hierarchy satisfies TEN conditions at once (registry record, tld, typology, source
section, active flag, active-in-thesaurus, ontology nodes + `<tld>0` node records, target
sections, and the two general-term ROOTS). `hierarchy_state.ts` owns that invariant and is
the **single writer** — `hierarchy_single_writer_tripwire` fails if anything else calls
`generateVirtualSection` or writes a `hierarchy45`/`hierarchy59` locator (one named exemption:
`ontology_write.ts`, which seeds the `dd` ontology registry — not a thesaurus hierarchy).

Three rules, each of which was a shipped bug:
- **Ask whether the TARGET EXISTS, never whether the locator is SET.** The seed presets a
  dangling `hierarchy45 → <tld>1/1` on most registry records; the old check said "already
  seeded", the root was never created, and the hierarchy could not be activated at all.
- **Never hard-code a record id.** The model root was pinned to `<tld>2`/2 — an id that
  exists in almost no install. Resolve the root (lowest id) or create it.
- **Default, never overwrite, operator data.** `hierarchy109` (Real section tipo) is the
  operator's choice; ensure defaults it to `hierarchy20` when EMPTY and REFUSES when it names
  a non-section, rather than silently rewriting what the hierarchy IS.

A created root is NAMED after the hierarchy (`hierarchy5`, all langs); the term component comes
from the target section's `section_map` (`getSectionMapValue(tipo,'thesaurus','term')` →
`hierarchy25` for hierarchy20-based sections), never hard-coded. Naming is fill-only.

`resolver.ts` fixes shipped with this: `clearOntologyCaches()` clears ALL its resolver caches (node, matrix-table, component-filter, descendant/related-by-model, section-real-tipo, ancestor-section — was node-only), hub-registered; `getMatrixTableFromTipo` returns `matrix_ontology` for ANY `<x>0` tipo BEFORE the node lookup (PHP `class.common.php:861-870` — so a not-yet-installed local `<tld>0` still routes).

## Parser (parseSectionRecordToOntologyNode — PHP class.ontology.php:1811)
Reads components off a `matrix_ontology` row (via readMatrixRecord + component-data helpers), with OVERWRITE-locator fallback (a `localontology0` node may override the main; `getOverwriteLocator` null for localontology0 itself, null when canonical node is_model=true). Field map & subtleties (EACH an explicit test):
- tld←ontology7 (empty → skip/null); tipo = tld+section_id; is_main = tipo===tld+'0'.
- parent←ontology15 first locator; NULL iff locator→ontology35 (roots), else getTermIdFromLocator.
- **is_model←ontology30 CANONICAL-ONLY** (never via overwrite — structural integrity); `(int)section_id===1`.
- model_tipo/model←ontology6 (OVERWRITE-AWARE, code beats the docblock); model = dd_ontology(model_tipo).term[STRUCTURE_LANG] STRICT, NO fallback.
- order_number←ontology41 `(int)`; is_translatable←ontology8, **default TRUE when missing**.
- relations←ontology10 locators→`{tipo:termId}` (skip unresolvable, empty→null).
- properties←ontology18 + `.css`(16) + `.source`(17); empty → SQL NULL never `{}`; request_config validated NON-blocking (warn only).
- propiedades←ontology19 as `phpPrettyJsonEncode` TEXT (byte-exact PHP JSON_PRETTY_PRINT: 4-space indent, `\/`, `\uXXXX`); term←ontology5 all-langs `{lang:value}`.
Upsert is WHOLE-ROW replace (a cleared component → nulled column on re-parse).

## Write drivers (ontology_write.ts)
- `setRecordsInDdOntology({sectionTipo, sectionId | sectionIds})` — edit (one record) vs list (the ids the caller's live list SQO matches: `tool_ontology` REQUIRES `options.sqo` and refuses without it — no whole-section default, per WC-043). ontology35 record → getMainTld; TLD not in `getActiveTlds()` (= "already has dd_ontology rows", NOT hierarchy4) → deleteTldNodes; active → createDdOntologyRootNode. Else insertDdOntologyRecord. PARTIAL-SUCCESS (`ok=true` when processed>0).
- **RETIRED** `regenerateRecordsInDdOntology` → `ontology_state.rebuildOntology` (transactional; no `dd_ontology_bk`). The wipe-and-rebuild of a tld lives ONLY in `ontology_state.ts` now (see the reconcile law below).
- `createDdOntologyRootNode` — `<tld>0`: model 'section', model_tipo dd6, is_main, relations `[{tipo:'ontology1'},{tipo:'dd1201'}]`, properties `{main_tld,color:'#2d8894'}`, parent = typology grouper. `createParentGrouper('ontology40'/'ontologytype' | 'hierarchy56'/'hierarchytype' | 'hierarchy57'/'hierarchymtype', tld, typologyId)`.
- `syncOrderToDdOntology(changed, parentTipo, parentId)` — consumed by the tree's save_order (dedalo-tree-ts).

## Hierarchy provisioning (generateVirtualSection — PHP class.hierarchy.php:228)
Validate (hierarchy4 active=dd64/1 loose `==`; hierarchy6 tld lowercased; hierarchy109 source model==='section'; hierarchy9 typology int≥1; hierarchy5 name) → ONE `withTransaction`: ensureMainSection (create-if-missing; an existing registry row is never rewritten) → createDdOntologyRootNode → `<tld>0/1` descriptor (createSectionRecord sectionId 1; components ontology3 yes, ontology4 yes, ontology6 dd0/6, ontology8 no, ontology10→real source, **ontology7 lang lg-spa** [differs from createMainSection's lg-nolan — pin bytes], ontology5 name; grouper hierarchy56; **bare `{section_tipo,section_id}` parent locator** — no type field) → insertDdOntologyRecord(<tld>0,1) → `<tld>0/2` model twin (copy row-1 columns, ontology30→dd64/1, grouper hierarchy57) → write hierarchy53=`<tld>1`/hierarchy58=`<tld>2` back. set_section_permissions grant is PORTED (`security/section_permissions.ts` — grants the creating user's PROFILE level 2 over `<tld>1`/`<tld>2` + their elements) and stays NON-FATAL (failure → error string in response.errors, no rollback).

## Tools (self-contained packages)
Each tool is a package under `tools/tool_<name>/server/` whose handler imports the core drivers above (e.g. `tools/tool_ontology/server/tool_ontology.ts` calls `setRecordsInDdOntology`). Registered actions: tool_ontology.set_records_in_dd_ontology; tool_ontology_parser.{get_ontologies, inspect_ontologies (READ drift — the status panel), repair_tlds (rewrites a misfiled `ontology7` SOURCE value back to its section's tld), regenerate_ontologies (rebuildOntology — the ONE write door onto the projection), export_ontologies (`ontology/data_io.ts` pipeline: ontology.json → per-TLD dumps → LLM map)} — all `permission:'developer'`; tool_hierarchy.{inspect_hierarchy (READ — the status checklist), generate_virtual_section (WRITE — ensureHierarchy; force_to_create → rebuildHierarchy)} — `permission:'targets'` bound to the record the writer is pinned to, `hierarchy1/<options.section_id>` (`hierarchyTargets`), minLevel 1 / 2. The tools plumbing (registration, gates, serving) lives in `src/core/tools/` and routes through the `dd_tools_api` handlers (`src/core/api/handlers/dd_tools_api.ts`, `tool_request`).

## Testing
**dd_ontology reconcile law (2026-07-15):** dd_ontology is a PROJECTION of matrix_ontology; keeping them consistent lives ONLY in `ontology_state.ts` (`ontology_single_writer_tripwire`: `deleteTldNodes` importable only by its allowlist; `regenerateRecordsInDdOntology` exists NOWHERE). inspect diffs BY MEANING (jsonb key-order normalized, `{}`/`[]`/null all ≡ absent, `propiedades` compared parsed not as whitespace — else ~1400 `dd` nodes read falsely stale). rebuild = transactional wipe-and-rebuild in ONE `withTransaction` (no `dd_ontology_bk`; MVCC readers never see the empty window).

Tests build their situation on the suite DB (`bun run test:db:setup`; writers call `assertTestDatabase()`) — see **`dedalo-ts-testing`**. Unit: `test/unit/{php_pretty_json,dd_ontology_write,ontology_parser,tool_ontology,tool_ontology_parser,tool_ontology_scope,get_ontologies_native}.test.ts`; ontology-state: `test/unit/{ontology_state_native,ontology_state_foreign_tld,ontology_single_writer_tripwire}.test.ts` (scratch tld `zzo`); hierarchy: `test/unit/{hierarchy_state_native,hierarchy_generate_native,hierarchy_provision_native,install_hierarchy_activate_native,hierarchy_single_writer_tripwire}.test.ts` (scratch `zz*` tlds, zero residue) — the retired generate_virtual_section + ontology_delete differentials are pinned natively by `hierarchy_provision_native`; the retired ontology_parser/tool_ontology differentials' contracts live in `ontology_parser.test.ts` + `tool_ontology.test.ts`. Parity (frozen fixture store): `test/parity/{get_ontologies,regenerate}_differential.test.ts` — byte-exact dd_ontology columns; `get_ontologies` is corpus-bound (red on the suite DB by construction; `get_ontologies_native` is its twin). A red frozen-fixture gate or a fixture/WC edit → **`dedalo-parity-debugging`**. Write tests MUST leave zero residue — verify with `SELECT tld FROM dd_ontology WHERE tld LIKE 'zz%'` (empty); `dd_ontology_bk` should NOT exist (rebuild is transactional). NEVER mutate real records.

## Ledgered deferrals (in file headers)
dd_ontology term search `search_fuzzy_term`/`search_exact_term` (`dd_ontology.ts`); renaming the seeded general term after the hierarchy (PHP `set_term_value`, `hierarchy_provision.ts`); session `active_elements` invalidation (no TS twin). Implemented since (not deferred): export (`export_ontologies` via `ontology/data_io.ts`), import (`ontology/data_io_import.ts`), remote sync (`ontology/ontology_update.ts`), the LLM map (`src/ai/mcp/tools/llm_map.ts`), set_section_permissions (`security/section_permissions.ts`).
