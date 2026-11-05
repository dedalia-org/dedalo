# WC-2026-11-04-ontology-machine-names — dd_ontology gains machine_name / use_machine_name, derived from ontology43 / ontology44

- **Date:** 2026-11-04 (owner decisions C1/C2 of 2026-11-03: the two components are
  master-defined — `ontology43` machine name, `ontology44` use machine name; D3, D12, D15,
  D16 of 2026-11-04). Landed P1a (storage + parser): `install/db/migrations/0015_dd_ontology_machine_names.sql`,
  `src/core/ontology/machine_name.ts` (the kernel and the closed name-model list),
  `src/core/ontology/parser.ts`, `src/core/ontology/ontology_state.ts`, `src/core/db/dd_ontology.ts`.
- **Decision:** DEC-12 (the new invariants are pinned by `test/unit/machine_name_kernel.test.ts`
  and the existing ontology gates; the reader repoint and the G1/G2/G5 gates follow in P1b).

## Shape before (TS)

- A model name, a table/column/database name, an rdf/owl QName and the diffusion domain token
  lived in `dd_ontology.term['lg-spa']` (DEDALO_STRUCTURE_LANG). `model` was
  `dd_ontology(model_tipo).term[STRUCTURE_LANG]`, strict.
- `dd_ontology` had 13 columns (the PHP set).

## Shape after (TS)

- **Two columns** on `dd_ontology` (and on the static `dd_ontology_recovery` twin, which must
  stay a column superset): `machine_name text` (the node's language-free name; NULL unless
  `use_machine_name`) and `use_machine_name boolean` (true → named by `machine_name`; false →
  named by its translatable label `term`; NULL → no parser has derived the row yet). Both are
  DERIVED ONLY: the parser fills them, the upsert door derives them for a rows-only writer
  that does not state them; nothing else writes them. Migration 0015 adds them
  (metadata-only, `incompatible`: a code rollback past it needs a human); the boot that ran
  it re-derives every tld still holding a NULL row (`deriveUnderivedMachineNames`: rebuild
  where source records exist, a door re-upsert for rows-only tlds). The seed is recompiled
  with the columns filled.
- **Derivation** (`projectMachineName`): the flag is ontology44 (dd64/1 yes, other no),
  CANONICAL ONLY; unset → the classification (name class = a model definition — a strict dd2
  descendant, stated as `is_model ∧ tld dd ∧ no model_tipo ∧ ≠ dd2` — or an instance of a
  model in `NAME_MODELS`: database, database_alias, table, table_alias, matrix_table, the 11
  field_*, diffusion_domain, rdf:predicate/subject/object, owl:ObjectProperty, owl:Class).
  Flag yes → the name is ontology43 (an override's value REPLACES the canonical one, no
  per-lang merge); else ontology5's lg-spa item; else ontology5's single distinct non-empty
  value; several distinct values on the first rung that has any → NULL plus `collision`;
  none → NULL plus `missing`. `''` is absent everywhere. A node with ontology43 and no
  ontology5 at all is valid (D16). The lg-spa / single-value / derived-flag rungs are the
  P1→P4 bridge (D15), counted (`ontology_machine_name_rung_*` counters, the
  `machineNameLegacyRungs` tally) and retired at P6.
- **`model`** = the model node's `machine_name`; bridge rung: a model row not derived
  (`use_machine_name` not true and no name) reads its `term['lg-spa']`, STRICT — byte-identical
  to the old rule on every unconverted row.
- **inspect** (`OntologyState`) gains a WARNING channel, never a drift kind:
  `machineNameDefectNodes`, `machineNameDefects[]` (`{source, tipo, kind, values?}`, kinds
  `missing`, `collision`, `name_without_flag`, `flag_mismatch`, `override_flag_flip`,
  `model_unresolved`) and `machineNameLegacyRungs`. A rebuild's message names them like the
  invalid-reference note. `flag_mismatch` / `missing` / `model_unresolved` are the
  post-v6-upgrade verification (plan §6b: PHP converts, TS verifies). An override's differing
  ontology44 is never applied (`override_flag_flip`). `machine_name` / `use_machine_name` are
  diff columns: an underived row is `stale` until its tld is rebuilt.
- **Inverse** (`ontology_record_inverse.ts`): ontology43 / ontology44 are written only where
  the node's values differ from the legacy derivation, so an unconverted node keeps its
  legacy record shape.
- **Archive restore**: row equality compares the machine-name columns AS DERIVED, so an
  archive from before 0015 (rows without the keys) restores unchanged definitions as
  unchanged; its rows are upserted with the derived pair.
- Readers (diffusion names, matrix_table, getRelationTables, rdf import, labels) are NOT yet
  repointed: they still read `term`. Output is unchanged.

## Reason

A machine name is not a translation: storing it in lg-spa pushed every project toward Spanish
names, and changing DEDALO_STRUCTURE_LANG nulled every `model`. A per-node non-translatable
component carries the right lang rule at every door (Time Machine, tool_lang, search,
context, CSV, MCP). Plan: `rewrite/ONTOLOGY_NAME_TERMS_PLAN.md` (internal).

## Gate reconciliation

No fixture of the frozen store reads `dd_ontology` rows by column, and no read or wire shape
changes in P1a (the readers are not repointed; `model` is byte-identical on unconverted
data), so neither the parity fixtures nor `engineering/parity_baseline.json` move. The test
TLD JSON is unconverted: its loader fills the pair through the same legacy derivation, so
`test_tld_ontology_gate` still compares like with like. Re-harvest: impossible, not needed.

## Addendum 2026-11-04 — P1b: readers repointed, STRUCTURE_LANG split

- **Readers read the column.** Every consumer that NAMES something by an ontology node reads
  `machine_name` / `model`, through ONE reader, `nameOrLabelOf` (`src/core/ontology/labels.ts`):
  use_machine_name true → `machine_name`, STRICT (NULL on a `missing` / `collision` node — a
  multi-valued guess now refuses); false → the label chain in the label-fallback lang; NULL /
  absent (a row not derived yet, an in-memory node) → the same label chain, which is the old
  `lg-spa → first non-empty` reading (counted, `ontology_machine_name_rung_underived_row`).
  Repointed: `resolver.ts` relatedMatrixTable (matrix_table name), `search_related.ts`
  getRelationTables (was raw `term->>'lg-spa'`), the diffusion virtual tree (domain match,
  database / table names, alias dedup, `compile.ts` field column names, `diffusion/api/info.ts`
  labels), `diffusion_graph.ts` (domain match, database / table names), `diffusion_delete.ts`
  (the rdf file's owl:Class name — the publish and delete sides now share the reader), the rdf
  importer's node names (`RdfOntologyReader.structureLang` removed; `engineRdfOntologyReader()`
  takes no lang), `ontology_update.ts` census model (`modelNameOf`). The three duplicate
  first-non-empty readers (`virtual_tree.termLabelOf`, `diffusion_graph.termOf`,
  `published_files.publishedTermLabel`) are DELETED. `OntologySubtreeNode`, `RawOntologyNode`,
  `DiffusionNode` and `RdfReaderNode` carry the pair.
- **One label chain**, ONLY in `labels.ts` (`resolveLabel`): requested lang → its declared
  equivalent → `ONTOLOGY_LABEL_FALLBACK_LANG` → the first non-empty translation → the node's
  machine name → null. `term_label.ts` is deleted (its `getOntologyTermLabel` and row cache
  moved into `labels.ts`); `resolver.ts` getTermByTipo and `create_record.ts`
  resolveSectionLabel use the chain. Shape change on old data only where a node lacks the
  requested lang and its equivalent but has the fallback lang among several translations
  (it now reads the fallback lang instead of the first in jsonb order), and where a stored
  value is `''` (absent, never served).
- **Tree: the section_map roles select, never a hardcoded tipo.** The node term is resolved
  from the section's `section_list_thesaurus` ddo_map, steered by two `section_map` roles beside
  `term` (owner decision 2026-11-05: `term` is not the place for a machine name):
  `machine_name` (the language-free name component) and `use_machine_name` (the si/no component
  saying which one names the node) — on the ontology: `ontology33.thesaurus.machine_name =
  ontology43`, `use_machine_name = ontology44`. Flag Yes → the TRANSLATABLE members of `term`
  (the label) are replaced by `machine_name` at the label's position; tld/id stay
  (`ts_object.ts` termTiposShown). Flag No or unset, or a map without both roles → the declared
  tipos. The element's `tipo` (and `model`) is what it SHOWS, so a click on the text edits the
  component being read — the machine name, not the label. Never a fallback: a Yes node with an
  empty machine name (or a No node with an empty label) is not filled from the other field; the
  client (`render_ts_line.js` mark_missing_term, both term renderers) shows a `term_missing`
  placeholder naming the element's tipos, so a misconfigured definition is visible instead of
  spreading. (A first draft hardcoded an ontology5 → ontology43 fallback; removed 2026-11-05.)
  Gate: `test/unit/ts_object_machine_name_term_native.test.ts`.
- **STRUCTURE_LANG is gone** (the export is deleted so every site states its role): names →
  the columns; labels → `ONTOLOGY_LABEL_FALLBACK_LANG` (`labels.ts`, = config
  DEDALO_STRUCTURE_LANG, re-documented as "ontology label fallback" only; the key and `.env`
  are unchanged); the hierarchy8 registry lang → `REGISTRY_LANG = 'lg-spa'`
  (`ontology_tipos.ts`, a real lg1 record — owner decision D7; no longer follows
  DEDALO_STRUCTURE_LANG); the label placeholders of a TLD with no stated name (the `<tld>0`
  root term, hierarchy5 — translatable) → the label-fallback lang.
- **D7, ontology7 descriptor:** hierarchy provisioning writes the `<tld>0/1` descriptor's
  ontology7 tld item as `{id:1, lang:'lg-nolan', value:<tld>}` (was `lg-spa`, a PHP byte pin):
  ontology7 is not translatable, and the registration (createMainSection, ontology_write) already
  wrote lg-nolan. Readers of ontology7 are lang-agnostic. Re-pinned:
  `test/unit/hierarchy_provision_native.test.ts`.
- **Gate:** `test/unit/machine_name_outcome_native.test.ts` (G1) asserts the outcome of every
  naming consumer against decoy translations.
- **Gate reconciliation:** no fixture of the frozen store reads a machine name or a
  `<tld>0/1` descriptor; the label-chain change affects only labels without the requested
  lang. The parity run was measured before and after on the suite DB (same red set — see the
  P1b report); `engineering/parity_baseline.json` does not move. Re-harvest: impossible, not
  needed.


## Addendum 2026-11-04 — P2: the save rules (plan §4) and the restore conversion

- **Shape before:** an ontology node record accepted any ontology43 / ontology44 / ontology5 /
  ontology6 value; a flag-Yes node could be left without a name (its `machine_name` NULL, its
  instances' data routed to the fallback `matrix` table — plan §11.1).
- **Shape after (TS):** the record-write chokepoint (`src/core/section_record/record_write.ts`
  §3g → `machine_name_save.ts`, pure rules in `src/core/ontology/machine_name_rules.ts`) checks
  a key write onto a `<tld>0` record touching ontology43/44/5/6/30, or onto a localontology0
  override touching ontology42/43/44, under the row lock in the write's own transaction. A
  write that INTRODUCES a violation fails with one of five NEW codes, all `caller` / HTTP 400,
  operator disclosure, `details: {node[, rule]}`:
  - `ontology.machine_name_invalid` — surrounding whitespace, a control character, or several
    values (`rule`: `surrounding_whitespace` | `control_character` | `single_value`);
  - `ontology.machine_name_without_flag` — a name on a node whose flag is No;
  - `ontology.machine_name_required` — a flag-Yes node left with no derivable name (bridge
    rungs included: a name still in ontology5 lg-spa counts);
  - `ontology.machine_name_flag_mismatch` — D12: flag No on a name-class node (a model change
    to a name model, or the flag set No), refused with guidance, never auto-converted;
  - `ontology.machine_name_override_flag` — an override stating another ontology44.
  A violation the record already had does not block an unrelated write. The Time Machine
  doors (`persistRestoredKeys`, `persistRecordColumns`, the undelete birth) are NEVER refused:
  on a node already in the machine-name shape, a restored legacy ontology5 lg-spa name moves
  into ontology43 (D16; other langs stay labels, D3), a restored state without a flag gets the
  node's flag back, several candidates are left and reported (counter
  `ontology_machine_name_restore_<outcome>`, a log line for an ambiguous or renaming restore).
  ARMED only on an ontology that defines ontology43 AND ontology44: the vendored 7.0 release
  does not yet, so no response changes until it does.
- **Reason:** plan §4 — the derived columns must never be NULL where a name is the node's
  identity, and the flag is canonical-only.
- **Gate reconciliation:** new hermetic gate `test/unit/machine_name_save_rules.test.ts`
  (TRIPWIRES.md). `write_obligations_tripwire` B4 amended deliberately: the raw per-key write
  `writeKeys` is now reached only through `writeKeyEntry` (the rule step), which carries the
  five-entry exclusivity row `writeKeys` held. No fixture in `test/parity/fixtures/oracle_harvest/` holds an ontology43/44
  write; the frozen store and `engineering/parity_baseline.json` are unaffected. Re-harvest:
  impossible, not needed.

## Addendum 2026-11-04 — P3: the converter (plan §6)

- **Shape before (TS):** no door moved a legacy name (ontology5 lg-spa) into ontology43; every
  node relied on the parser's bridge rungs, and no node stated its flag unless an editor did.
- **Shape after (TS):** one pure kernel (`src/core/ontology/machine_name_convert.ts`) classes
  every ontology source record — **L** lossless (`move`, `move_single`, `deduplicate`,
  `flag_yes`, `flag_no`; overrides `override_move`, `override_deduplicate`), **S** strays (the
  lg-spa name beside DIFFERENT translations: kept as labels, D3), **C** refused (`name_differs`,
  `ambiguous_legacy`, `ambiguous_values`, `ambiguous_name`, `no_name`, `name_without_flag`,
  `flag_no_on_name_model`) — and states what the record stores after it: ontology43 the name
  (one lg-nolan item), ontology44 the flag (dd64/1 or dd64/2, every node — so the
  `derived_flag` rung can retire), and the lg-spa item OUT of ontology5 (D16). An explicit flag
  or name is input: never flipped or overwritten, a disagreement reported (`flag_mismatch`).
  An override's flag is canonical-only and never written. Three doors
  (`src/core/ontology/machine_name_reconcile.ts`):
  - reconcile **`ontology_machine_names`** (class L): `boot`, `autoApply`; saves through
    `saveComponentData` (TM row per key, the P2 save rules, actor `-1`), in the order name →
    flag → label slices, then rebuilds every touched tld (`mainNode: 'existing'`);
  - reconcile **`ontology_machine_names_strays`** (class S): `operator`, `applyRootOnly`;
  - the **package-import rewrite**, after COPY + ONT-TLD and before the re-derive, in
    `importOntologyPackage` (update panel, installer, seed compiler) and `importOntologyFile`:
    class L only, through `persistRecordKeys` with no audit and no TM row, a message line,
    NON-FATAL (a failure leaves the readable legacy shape).
  Class C is reported by both reconciles (`detail.refused`), written by none. Both reconciles
  and the import rewrite are ARMED only on an ontology that defines ontology43/44 under their
  fixed columns (`string` / `relation`): unarmed, a dry run still measures, an apply writes
  nothing and reports `detail.apply_refused`. On an ontology server an apply WITHOUT an
  explicit TLD scope is refused (master is converted by a human, P4); the import rewrite is
  not, because it converts the package being imported and the seed compiler must be
  reproducible. Post-restore: both DRY (`POST_RESTORE_PLAN`). The Time Machine restore kernel
  (legacy lg-spa of a converted name node → ontology43) is P2's `convertRestoredMachineName`,
  reused, not duplicated.
- **Reason:** plan §6 — the name must reach ontology43 without a reader ever deriving a
  different name, label or model, and a change of which label a lang shows is root's.
- **Gate reconciliation:** new gates `test/unit/machine_name_convert.test.ts` (hermetic:
  every class; L measured lossless against the parser's own kernel; idempotent) and
  `test/unit/machine_name_reconcile_native.test.ts` (the doors on a `zzmr` scratch section;
  the unarmed and ontology-server refusals write nothing). `reconcile_registry_tripwire` pins
  amended deliberately: `autoApply` = {media_index, ontology_machine_names, media_copy,
  publication_probe}; `applyRootOnly` = {ontology_machine_names_strays, media_copy,
  rich_text_images, web_image_exposure}; `reconcile_registry_native` gained the two planters
  (`zzmach`). The post-restore apply set is unchanged. NOT YET DRIVEN: the armed apply (saves,
  rebuild, a second run at 0) — it needs a vendored release defining ontology43/44, the same
  blocker as G2. No fixture in `test/parity/fixtures/oracle_harvest/` is touched; the frozen
  store and `engineering/parity_baseline.json` are unaffected. Re-harvest: impossible, not
  needed.

## Addendum 2026-11-04 — the plan §10 gates (G1, G2, G5, G6, G7)

- **Shape:** unchanged. This addendum adds gates only, no wire or storage change.
- **G1 `machine_name_outcome_native` extended.** New consumers:
  - `getRelationTables`;
  - a compiled sql plan's table and `field_*` column names;
  - a `collision` table refusing its element's compile;
  - `table_alias` child dedup by machine name;
  - the rdf file name agreeing between the publish side (`SectionPlan.tableName`) and the
    delete side (`resolvePublishedFile`);
  - the rdf importer's predicate names.

  Mutation measured: with `nameOrLabelOf`'s name branch disabled, 9 legs go red.
- **G2 `machine_name_native` (new).** `zzmp` raw source records plus two `localontology0`
  overrides, through `rebuildOntology`. It covers:
  - every name rung, `''` read as absent, `collision` and `missing`;
  - label nodes and stray-as-label;
  - `model` = the model node's machine name through the fixpoint;
  - an override replacing the name, and a non-spa override never renaming it.

  ontology43/44 are asserted READ when the installed ontology defines them, and IGNORED
  (rungs) when it does not. Both branches are written; only the unarmed one has run.
  The rdf publish/delete-agree and alias-dedup legs live in G1, because they need its
  diffusion situation.
- **G5 `machine_name_classification_native` (new).** Over the installed ontology:
  - flag ⟺ `isNameClassNode`;
  - the dd2-descendant predicate equals the tree;
  - `NAME_MODELS` entries exist;
  - every dd1226 diffusion model is a name model or one of the declared label models
    (DIFFUSION_SPEC §4.4.1);
  - ontology6 targets are model definitions;
  - no flag-yes node is nameless, and no model is unresolved.
- **G6 `machine_name_rung_ratchet_native` (new).**
  - The rung vocabulary is closed.
  - The `legacy_lang` tld set is banked, shrink-only: {dd, hierarchy, oh, rsc, test}.
  - `single_value` is banked empty.
  - `derived_flag` is universal while ontology43/44 are undefined (that leg goes red on
    arrival, to have the set banked).
  - There are no un-derived rows and no defects.
- **G7.** The existing hermetic `machine_name_save_rules` (the rules, the "introduced" policy,
  the TM restore kernel) is the gate. A DB leg of the ARMED chokepoint has the same blocker as
  G2.
- **Still blocked on the vendored release defining ontology43/44:** G3's armed apply, G2's
  armed branch, the derived-flag bank, and the armed record_write chokepoint.
- **Gate reconciliation:** no fixture in `test/parity/fixtures/oracle_harvest/` is touched.
  Re-harvest: impossible, not needed.

## Addendum — review fixes (2026-11-04)

- **First arrival is not circular.** The parser reads ontology43/44 under the contract
  models (`component_input_text` / `component_radio_button`, `parser.ts`
  MACHINE_NAME_CONTRACT_MODELS) while their own dd_ontology rows do not resolve — the update
  that first brings them stages `dd` before `ontology`, and a converted model definition
  (lg-spa moved out, D16) would otherwise derive no name, NULL every instance's `model`, and
  keep ontology43's own model NULL for good. A read fallback only: arming (save rules,
  converter) still asks `getModelByTipo`. The update's pass 2 also re-derives a tld whose
  `machine_name` / `use_machine_name` is stale (a model definition has no model_tipo, so a
  `model` diff never flagged it). Gate: G2 first-arrival leg (zzmp15/16).
- **An unconverted override keeps renaming.** A localontology0 override that states no
  ontology43 but holds an lg-spa value renames a name node exactly as before, winning over
  the canonical ontology43 (kernel `overrideLegacyName`, rung `legacy_lang`) until the
  reconcile's `override_move` converts it. Gate: G2 zzmp13, kernel leg.
- **A stated flag ends the single-value rung.** On a node that states ontology44, a lone
  non-Spanish value is a D3 stray label, never the name: an empty ontology43 there is
  `missing`. lg-spa still names a half-converted node. The save rules refuse EMPTYING a
  stated ontology43 on a flag-Yes node (`required`, write-scoped,
  `canonicalTransitionViolation`), and a name-class node at flag No may stage its name (no
  `without_flag`) — the editor's way out of a `flag_mismatch`.
- **A nameless matrix_table is refused, not defaulted.** `relatedMatrixTable` throws
  `ontology.invalid_node` (coordinates `tipo`, `matrix_table`, reason
  `machine_name_unresolved`) instead of answering null, which sent the section's reads and
  writes to the virtual/default table. Gate: G1.
- **An un-derived row reads lg-spa.** `nameOrLabelOf` over a `use_machine_name` NULL row is
  the deleted readers' reading (lg-spa, else first non-empty), never the configurable
  label-fallback lang. Gate: G1 (child bound to `DEDALO_STRUCTURE_LANG=lg-eng`).
- **Converter.** A record whose model does not resolve is class C `model_unresolved` (never
  read as a label, which wrote a permanent ontology44 No); a candidate breaking the name
  grammar is class C `invalid_name` (the save rules would refuse it on every apply); the
  package import rewrite is refused outright on an ontology server (the seed compile child is
  hermetic, never one, so the seed stays reproducible).
- **Gates.** `NAME_MODELS` is pinned literally in `machine_name_kernel`; G6 walks the
  registered engine-source lister (census_derivation_tripwire); G2's mutation claim names
  only discriminating records.
