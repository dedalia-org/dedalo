# WC-2026-10-10-update-ontology-confirm-text — the panel confirm text no longer claims the local ontology is deleted

- **Date:** 2026-10-10.
- **Shape before (PHP):** the `update_ontology` panel's `confirm_text`
  (WC-023 byte list) stated the import "DELET[es] [the] ACTUAL ONTOLOGY … you will
  lose all changes made to the local Ontology". That is false: the import
  replaces only the SELECTED TLDs' slices (`matrix_ontology` per `sectionTipo`,
  `matrix_dd` whole-table) — by default the common/shared ontologies named by
  `ACTIVE_ONTOLOGY_TLDS`. Local records are a DIFFERENT namespace
  (`localontology0` overrides, custom TLDs) and are not part of those slices,
  so they are kept and re-applied when the updated nodes are re-processed
  (docs/core/ontology/local_ontology_overrides.md § "Overrides and ontology
  updates").
- **Shape after (TS):** `confirm_text` now names the real operation
  ("OVERWRITING THE COMMON ONTOLOGIES"), states the selected TLDs are replaced
  and re-processed, and states that the local ontology is NOT overwritten —
  custom TLDs and `localontology` overrides are kept, UNLESS `localontology` is
  added to the update list. The string is not hardcoded: it is the label
  `update_ontology_confirm_text`, resolved in the request's APPLICATION language
  (`currentApplicationLang`, the pattern the widget registry already uses) and
  translated in all 17 catalogs; the English literal is a fallback only. The
  client (`render_update_ontology.js`) prefers its own `get_label` copy of the
  same key, so the browser `confirm()` dialog is localized even against a server
  that sends the fallback.
- **Reason:** the operator-facing text is the safety surface of a destructive
  action; a warning that overstates the blast radius trains operators to ignore
  it and misrepresents what the update process actually does.
- **Gate reconciliation:** no gate asserted the old bytes (the string is unique
  to `src/core/area_maintenance/widgets/update_ontology.ts`); no fixture store
  carries it, so NO re-harvest. `test/unit/active_ontology_tlds.test.ts` gates
  the panel through `dispatchGetWidgetValue` on the key set, not the
  `confirm_text` value, and is unaffected.
