# WC-2026-11-22-properties-label-override-chain — an OBJECT `properties.label` overrides the context label through the ONE ontology label chain

- **Date:** 2026-11-22 (T2 batch B5: SC-2).
- **Decision:** T2 triage row SC-2 (O08; no carrier in the 7.0 ontology). Code:
  `src/core/resolve/structure_context.ts` (`stampPostEmission` → `applyLabelOverride`),
  `src/core/ontology/labels.ts` (`resolveLabel`).
- **Shape before (PHP v6/v7, frozen :1928-1941):** `properties.label` as a lang map replaced
  the element's `label`: the `DEDALO_APPLICATION_LANG` entry, else the FIRST non-empty entry
  in stored order. A string `label` was ignored. TS before this entry never read the key
  (the label was always the ontology term).
- **Shape after (TS):** an OBJECT `properties.label` — from whichever properties source won
  (the ontology, an RQO properties override, a governing ddo) — is resolved through the
  engine's ONE ontology label chain: the request application lang → its declared equivalent
  (`lg-vlca` → `lg-cat`) → the structure lang (`ONTOLOGY_LABEL_FALLBACK_LANG`) → the first
  non-empty entry. A string or array never overrides; a map with no non-empty value leaves the
  ontology label.
- **Reason:** "first in stored order" is an artefact of jsonb key order, not a language choice
  (the same defect WC-2026-08-02-tool-string-lang-fallback retired for tool strings); every
  other ontology-derived label already degrades through this chain, so a Valencian interface
  shows the Catalan override instead of whichever lang sorts first.
- **Gate reconciliation:** no frozen fixture carries `properties.label` (no carrier in the
  harvested ontology); no re-harvest. Gate: `test/unit/structure_context_label_override_native.test.ts`
  (map in two langs, string ignored, alias over first-stored, empty map, RQO override).
