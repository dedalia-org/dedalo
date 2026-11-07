# WC-033 — UI labels are repo catalogs: `get_label` is catalog-derived, the generated JS lang files are gone

- **Date:** 2026-07-16 (post-cutover; PHP is decommissioned dead code).
- **Why:** the inherited model had THREE simultaneous truths and none worked.
  `getLabels` PREFERRED the committed `client/…/js/lang/lg-*.js` files (frozen
  at the cutover — nothing regenerates them, `rebuild_lang_files` is denied),
  silently falling back to a dd_ontology rebuild — so a WC-023 ontology update
  changed label rows but the UI kept serving cutover-day strings; the ledger
  ("labels are DB-derived") contradicted the code; and the files had ALREADY
  become the de-facto authoring surface (26 TS-era keys — the login-recovery
  set — existed ONLY there, 0 DB rows). Program strings are coupled to CODE,
  not to the data model: a key exists because a line of client/widget code
  references it, so labels now ship in the same commit as that code.
- **Shape after (TS):** repo label files with TWO deliberately separated
  ROLES (amended same day — no language is privileged at runtime):
  `src/core/labels/master.json` is the SOURCE OF DEFINITIONS — the complete
  key set with its source strings, tripwired complete; it is *authored in*
  `MASTER_SOURCE_LANG` (currently lg-eng — a fact about who writes the
  strings, gettext-msgid style). `src/core/labels/catalog/lg-<code>.json`
  (sorted keys, sparse allowed) are per-lang TRANSLATIONS, all equal — EVERY
  application lang has one, including the master-source lang, whose file is
  a sparse display-text OVERRIDE of the master (starts empty; the tripwire
  fails entries byte-equal to the master, so it can never silently become a
  duplicate). Requesting the master-source lang applies only that override —
  no other lang may shadow a master the requester already reads natively.
  `getLabels` (`src/core/labels/catalog.ts`) serves the merged dictionary by
  the fallback criteria: master ← the INSTALL's default application lang
  (`DEDALO_APPLICATION_LANGS_DEFAULT` — the operator's choice) ← declared
  linguistic alias (lg-vlca→lg-cat, the aliasing PHP baked into its generated
  file) ← requested lang. (The first cut hardcoded eng-as-reference plus a
  structure-lang overlay; both were language priorities the engine had no
  business asserting — structure lang is an ontology-authoring concept.) So
  `get_label` now always carries the FULL key set (pre-migration, a lang file
  missing a key served `undefined` to the client). The dd_ontology
  `model='label'` rows (dd383 children) are INERT for the TS engine: a WC-023
  ontology update still imports them (v6 consumers may read them) but they
  drive nothing. The environment `get_label` WIRE SHAPE is unchanged (a
  lang-keyed string map); only its provenance moved. The eng catalog also
  absorbed 181 keys that previously resolved ONLY through scattered client
  `|| 'literal'` fallbacks or rendered `undefined` (the literals ARE the
  catalog values — bytes preserved).
- **Client file census:** `client/dedalo/core/common/js/lang/lg-*.js` is
  DELETED (the client never fetched it — labels arrive via get_environment;
  the files were server-read only). `get_dedalo_files` (the SW pre-cache
  manifest) therefore lists no lang files; the frozen PHP fixture still does —
  `dedalo_files_differential` filters `/dedalo/core/common/js/lang/` from
  BOTH sides (the WC-013 normalization pattern).
- **Sync story:** labels ride CODE updates (git/`update_code`), never
  `update_ontology`. `rebuild_lang_files` / `export_to_translate` stay
  `engineDenied` (the CSV translation workflow is superseded by
  `scripts/labels_fill.ts` — per-lang missing-key backlog vs lg-eng).
- **Two deliberate VALUE divergences from the oracle dictionary** (dd_ontology
  duplicate-`properties.name` collisions where PHP's generator let the later
  row win): `no_hay_etiqueta_seleccionada` now says 'No tag selected…' (dd1640
  — the string component_portal.js actually shows on the index-without-tag
  confirm; the oracle served dd1664's 'User code does not exist' there) and
  `tool_watermark` now says 'Watermark' (dd1547; the oracle served dd1548's
  'Notes').
- **Gate reconciliation:** `environment_differential` `get_label` moves from
  byte-equality to CONTAINMENT — every oracle key present with the oracle's
  value except the two fixes above (asserted present AND changed); TS-only
  keys are the catalog additions. `dedalo_files_differential` filters the lang
  path (above). `labels_tripwire` (catalog integrity, reference completeness,
  the shrink-only uncataloged ratchet) is the new invariant gate. The one-time
  DB↔file reconcile (dup-name rows, the 22 mojibake-corrupted DB Italian
  values, baked-fallback removal) is recorded in rewrite/LABELS_RECONCILE.md.

## Addendum 2026-11-07 — the dictionary no longer rides the environment (WC-2026-11-07-labels-separate-resource)

The catalogs and the fallback chain are unchanged, but `environment.result.get_label` is gone. The merged dictionary is served by `GET /api/v1/labels?lang=&v=`, versioned by `page_globals.labels_version`. `environment_differential` now checks the containment law against `getLabels(lang)` directly.
