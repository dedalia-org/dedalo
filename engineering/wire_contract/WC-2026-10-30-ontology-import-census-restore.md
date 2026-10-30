# WC-2026-10-30-ontology-import-census-restore — the ontology update reports a census of what it removes, and its restore says what it restored

- **Date:** 2026-10-30 (update audit 2026-10-29, Phase 2; U-14, U-17). Extends
  `WC-2026-08-09-ontology-update-partial-restore`.
- **Decision:** DEC-12 (gated: `test/unit/ontology_import_census_native.test.ts`,
  `test/unit/ontology_update_shell_native.test.ts` case 4b,
  `test/unit/ontology_override_survives_native.test.ts`).
- **Shape before:** the `update_ontology` response carried `{result, msg, errors, …}` and no
  account of what an import would remove. The auto-restore after a failed import skipped an EMPTY
  snapshot (a TLD with no rows before the import), so the imported rows stayed while the message
  said "previous state restored".
- **Shape after (TS):**
  1. The response gains ONE key, `census`: one entry per staged TLD that derives nodes
     (`matrix_dd` and `localontology0` are skipped) —
     `{tld, removed: [{tipo, model, records?}], remodelled: [{tipo, from, to, records?}]}`.
     `records` (only for a node currently modelled `section`) is the count of stored records under
     that tipo; `null` when the count failed. Report only: the import proceeds. A TLD with findings
     also gets one `msg` line (`<tld>: import census — …`); a TLD whose read-only diff failed gets
     `<tld>: import census unavailable …`.
  2. The restore of an empty snapshot now runs its scoped DELETE (the TLD ends empty, as before
     the import). An import of an empty package is still a no-op (more likely a truncated export).
  3. The failure message names what the restore achieved: `Error. Import failed — the restore is
     INCOMPLETE (see errors); the database state is partial` when a file did not restore;
     `… matrix rows restored; registry and dd_ontology state may be partial` when a TLD was
     provisioned; `… previous state restored` otherwise. The separate `Error. ONT-TLD
     normalization failed — previous state restored` message is gone: it claimed a full restore
     after provisioning (its cause remains an `errors` line).
- **Client impact:** none required — the widget renders `msg` and `errors`; `census` is ignored by
  a client that does not read it.
