# WC-2026-11-12-recovery-mode-retired — `recovery_mode` removed; the ontology is repaired offline

- **Date:** 2026-11-12 (owner decision of the same day: drop the toggle, add an offline repair).
- **Decision:** DEC-12 — a control that does not do what it says is deleted, not documented.

## Shape before

- PHP: `DEDALO_RECOVERY_MODE` made `RecordObj_dd` read `jer_dd_recovery` instead of the
  main ontology table, and the client stamped `recovery_mode:true` on every RQO.
- TS until today: `page_globals.recovery_mode` (from `ts_state.json`), the root-only
  `check_config.set_recovery_mode` action, `check_config` `runtime_mode.recovery`, a page
  banner, and the RQO stamp — but NO server reader: the resolver always read
  `dd_ontology`. The switch painted a banner and swapped nothing, while its form promised
  "Ontology backup table will be used instead the main Ontology table".

## Shape after (TS)

- `page_globals` OMITS `recovery_mode`; the client sends no `recovery_mode` in an RQO.
- `check_config.set_recovery_mode` is gone (an unknown action — refused);
  `runtime_mode` has no `recovery` key; `ServerState` has no `recovery_mode` field, and a
  `ts_state.json` written before sheds it on read.
- Labels `site_in_recovery_mode` and `maintenance_map_recovery_mode` removed.
- The need is served OFFLINE by `scripts/ontology_recover.ts`
  (`src/core/ontology/ontology_recover.ts`): with the engine stopped, swap the recovery
  file's core-tld slice into `dd_ontology` (`--snapshot`) and/or re-derive every tld from
  its source records (`--rebuild`). A toggle in the browser cannot be reached exactly when
  it is needed — a broken ontology renders no maintenance area — and serving a partial
  ontology to editors would let them save records whose components the engine can no
  longer define.

## Reason

The consumer (an administrator with a damaged ontology) needs a repair that works without
the UI; the toggle was neither working nor reachable.

## Gate reconciliation

- `environment_differential` strips `recovery_mode` from the PHP-side `page_globals`
  copy before the exact key-set compare (asserting present PHP-side, absent TS-side —
  the WC-038 pattern). Frozen fixtures are unchanged; no re-harvest.
- `test/unit/server_state.test.ts` pins the retirement (legacy file sheds the key, the
  action is refused); `test/unit/ontology_recover_native.test.ts` pins the repair door.
