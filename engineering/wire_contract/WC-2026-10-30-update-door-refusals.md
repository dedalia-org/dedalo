# WC-2026-10-30-update-door-refusals — ontology scope, data-version and release-ladder changes on the update doors

- **Date:** 2026-10-30 (update audit 2026-10-29, findings U-52, U-04, U-06; owner decisions D-6, D-4).
- **Decision:** DEC-12 (gated: `test/unit/ontology_update_tld_scope_native.test.ts`,
  `test/unit/boot_schema_verdict_native.test.ts`, `test/unit/release_ladder_patch_walk_native.test.ts`,
  `test/unit/code_update.test.ts`).
- **Shape before (TS):**
  1. `update_ontology` accepted any TLD list the browser sent; only the panel filtered by
     `ACTIVE_ONTOLOGY_TLDS`.
  2. `update_code` ran whatever the installed data version was.
  3. The code-update manifest walked its ladder from the asker's DATA version (`options.version`),
     so a patch that did not move the data version (7.0.2 on data 7.0.0) was never offered.
- **Shape after (TS):**
  1. `update_ontology` refuses the whole request, before staging, with `update.refused` naming every
     TLD outside `ACTIVE_ONTOLOGY_TLDS` ∪ the core pair (`ontology`, `ontologytype`) ∪ `matrix_dd`;
     `localontology` and the suite's `test` TLD are never admissible. The panel offers the same set.
  2. `update_code` refuses with `update.refused`, `coordinates.rule` `data_version_pending` |
     `data_version_ahead` | `data_version_unknown`, before anything is fetched, unless the installed
     data version equals the code's.
  3. The manifest walks from the asker's RELEASE identity (`options.release`, already sent by the
     panel); an asker without it is walked from its data triple, as before.
- **Reason:** a crafted request must not replace a local TLD (D-6); a code update over an
  un-updated database stacks two data models; a patch must reach the installs it was cut for.
- **Gate reconciliation:** TS-only; the frozen store holds no update-door interaction. No re-harvest.
