# WC-2026-11-12-update-cache-external-mirror-refresh — `tool_update_cache.update_cache` recomputes an external portal by its law; it never re-saves the stored mirror

- **Date:** 2026-11-12 (T1-38 / OX3, OX7 — RC-closure plan Tier 1).
- **Decision:** DEC-12 (gated: `test/unit/update_cache_external_mirror_native.test.ts`).
  Siblings: WC-2026-10-30-portal-get-data-external-refresh (the read door, whose runner
  this shares), WC-2026-10-21-update-cache-locked-resave (the re-save branch it leaves).
- **Shape before (PHP):** `component_portal::regenerate_component` (frozen v7 and v6
  `class.component_portal.php`): `properties.source.mode === 'external'` ⇒
  `set_data_external({save:true, changed:false, current_data:false, references_limit:0})`,
  then return — the mirror is recomputed from the records it mirrors. The PHP portal
  family (autocomplete, autocomplete_hi) inherits it.
- **Shape before (TS):** every non-media, non-derived component re-saved its STORED items
  (`resaveUnderRowLock`). For an external mirror that re-saved the stale value (a canonical
  no-op: nothing written); an absent slot answered `empty`; a node whose law is refused was
  re-saved as if curated. All three counted toward `regenerated` (or silently skipped) —
  the run reported "OK, regenerated N" while every mirror stayed stale.
- **Shape after (TS):** a selected component whose DATA tipo (an alias resolves to its
  target, WC-020) declares `source.mode === 'external'` is RECOMPUTED through the shared
  refresh runner (`external_refresh.ts runExternalRefresh` — law + host checked there →
  `observers.ts refreshExternalMirror`, a fresh cascade guard, the `'on-write'` hop),
  under the row's WRITE grant (level 2, door `tool_update_cache.update_cache`), its target
  row-lock wait bounded per record (`perRecordLockWaitMs`, the other branches' bound).
  Never re-saved. Once per row per data tipo (an alias and its target both ticked = one
  refresh). External tipos are resolved ONCE before the run: an alias breaking its
  contract (`ontology.invalid_node`) refuses the run before the dd800 record is minted.
  Per row × component:
  - ran (wrote, or found no drift) ⇒ `regenerated` + `external_refreshed`;
  - record gone under the lock ⇒ `vanished`, `errors[]`
    `<tipo>#<id>: record deleted during the run — nothing written` (never recreated);
  - lock bound ran out (55P03) ⇒ `locked`, `errors[]`
    `<tipo>#<id>: the record stayed locked past the lock timeout — nothing written`
    (also counted `observers_external_refresh_busy`);
  - any other withheld reason (`law_refused`, `target_not_host`, `frozen`,
    `degraded_seed`) ⇒ `external_withheld`, `errors[]`
    `<tipo>#<id>: external mirror not refreshed (<reason>) — nothing written`, summary
    `<n> external mirror(s) not refreshed (see errors).`
  Response keys ADDED: `external_refreshed`, `external_withheld` (numbers; also 0 in the
  "nothing to regenerate" answer). The client renders `summary` / `errors`; no client
  change.
- **Undo log:** the refresh write carries NO `bulk_process_id` — the named exemption of
  WC-2026-09-27-bulk-revert-undo-log ("observer mirror writes stay outside") and the owner
  ruling 2026-10-30 (no origin tag on a refresh: a mirror is a calculation). A bulk revert
  of the run leaves the fresh mirror; a restored covered slot is recomputed anyway.
  Attribution of these rows to the run is owner decision D1 (T1-38 plan), not taken here.
- **Reason:** an external mirror is derived state; "regenerate" for it means "recompute
  from the data it mirrors" (PHP parity). Re-saving it regenerated nothing and reported a
  false success to the administrator repairing stale mirrors.
- **Gate reconciliation:** `update_cache_external_mirror_native` (E1 source_overwrite
  stale ⇒ recomputed, one TM row; E6 converged ⇒ zero writes; E2 absent slot computed; E3
  law (c) referencer appended; E4 alias ⇒ target slot, no alias key; E4b broken alias
  refuses before any write; E5 refused law withheld, slot untouched; E7 a row held
  BETWEEN the read-door bound and `perRecordLockWaitMs()` is waited out and refreshed (pins
  the per-record bound); E7b held past it ⇒ `locked`, the exact error line; E8 non-host ⇒ `target_not_host`; E9 deleted while waiting ⇒ `vanished`, not
  recreated; E10 no run bulk id on the refresh rows). `write_obligations_tripwire` B4:
  `runExternalRefresh` callers = `maybeRefreshExternal` + `refreshExternalForRow`.
  `tool_lossless_writeback_tripwire`: cell `refreshExternalForRow × runExternalRefresh`
  (`derived-state`, `BYPASS.dataframeRemoval`). TS-only tool response: no oracle fixture
  replays it; no re-harvest.
