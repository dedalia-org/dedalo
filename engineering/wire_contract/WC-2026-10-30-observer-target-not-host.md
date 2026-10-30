# WC-2026-10-30-observer-target-not-host — a mirror is born only on a record whose section declares the observer

- **Date:** 2026-10-30 (lands with `WC-2026-10-30-observer-external-value-laws`; the
  read-only R3 census of the same day is the evidence below).
- **Decision:** DEC-12 (gated: the host cases of `test/unit/observer_cascade_native.test.ts`,
  `test/unit/observer_equivalence_native.test.ts`, `test/unit/observer_seed_native.test.ts`
  — their fixtures put each observer node under its target section — and
  `test/unit/obligation_ledger_native.test.ts` 16c, the restore that must converge).

### Shape before (PHP)

PHP instantiated the observer component on ANY target record the resolver produced
and saved it there. For a `use_observable_dato` edge the targets are whatever the saved
data points at, so a mirror was written onto records of sections that do not declare
the observer at all.

### Shape before (TS, until 2026-10-30)

The kernel had no host guard either. Harmless for the copy laws only because they were
refused; for law (c) the R3 census (`dedalo_mib_v7`, read-only) found two live edges
writing onto foreign sections:

- `hierarchy93` ← `rsc387`: targets on `numisdata6` (221 of 266), `tchi1` (3 of 8),
  `numisdata3` (3 of 3) — none declares `hierarchy93`;
- `numisdata321` ← `numisdata282`: targets on `tchi1` (808 of 813) — `tchi1` does not
  declare `numisdata321` (its declaring sections are `numisdata276` and `numisdata5`).

Every other law (c) edge targets host sections only; every post-cutover TM row for a
law (c) observer is on a host section.

### Shape after (TS)

**Host predicate** = `observer ∈ declaredSectionComponents(targetSection)` — the one
section census shared with the record wipe and the covered-slot birth (own ∪ real
children, nested sections crossed, so the virtual faces `numisdata665`, `numisdata691`,
`numisdatacatalog1` of `numisdata651` are hosts). A TLD ROOT `<tld>0` (an ontology
main section, records in `matrix_ontology`) contributes ONLY its real section: its own
subtree is the TLD's node tree, not record structure — so it never hosts a content
mirror, even where a content section is parented under it (the suite fixture's
`testcoincatalog0` → `testcoincatalog1`; gate: `observer_reconcile_sweep_native`, the
source_overwrite host-set case). It guards mirror **birth**, not
maintenance:

- non-host record **without** the observer key ⇒ counted no-op
  `observers_target_not_host`, outcome `targetNotHost: true`, no lock, no log line;
- non-host record that already **holds** the key (PHP-era orphans, ontology-move
  leftovers, a TM restore) ⇒ counted `observers_target_not_host_slot_converged` and
  recomputed normally, so a restored phantom converges on truth instead of staying
  stored forever (`obligation_ledger_native` 16c).

The reconciler applies the same rule per tuple: a non-host tuple visits stored holders
only, tagged `[not a host — stored slots only]`. The refresh door refuses a non-host
target before the kernel (withheld `target_not_host`).

Existing orphan slots stay where they are (owner ruling: no data repair):
`hierarchy93` on 45 `numisdata6` and 6 `tchi1` records, `numisdata321` on 11 `tchi1`
records, `numisdata250` on 5 `numisdata4` records.

### Reason

A mirror on a record whose section does not declare the component is never rendered,
never wiped with the record's own covered slots, and — once the copy laws run — a
wrong-row write (`numisdata679` on the type record `numisdata3/1`). The guard closes
that for every law and fixes the two latent law (c) cases above.

### Known open

- `numisdata321` is declared in `numisdata276` / `numisdata5`, but its findspot targets
  are `tchi1` records, so under the guard that mirror is maintained nowhere live (it
  never rendered on `tchi1` either). Fixing it is an ontology proposal (re-home the
  observer, or a `tchi1` twin) — a human decides on the master ontology.
- The converged orphans keep being recomputed. The 2026-10-30 corpus dry run wants
  742 drops across 3 `numisdata321@tchi1` records; a strict guard (holders skipped
  too) is a one-block change, and would re-spec 16c. Owner decision, open.

### Gate reconciliation

No fixture re-harvest (write-path target guard; no served byte shape changes).

## Addendum 2026-10-30 — strict host precondition (owner ruling): stored slots are skipped too

The guard no longer distinguishes birth from maintenance. Every record of a non-host
section is the counted no-op `observers_target_not_host` (outcome `targetNotHost: true`,
no read, no lock), **whether or not it already holds the observer key**: a slot stored
there is not that section's value, so it is neither grown, shrunk nor healed.

- The counter `observers_target_not_host_slot_converged` is retired.
- The obligation ledger's `'always'` hop (a restore / undelete wrote the slot) does not
  fire for such a slot either: its stored bytes are never propagated as a current-state
  `saved` (`recomputeMirrorAndHop`; gate `observer_cascade_native` 8b, with a host
  positive control).
- `obligation_ledger_native` 16c is re-specced: the component restore of a slot the
  record's section does not declare is STORED AS RESTORED, and the kernel was reached
  (counter delta).
- The reconciler never sweeps a non-host tuple: it counts its stored slots
  (`ReconcileSummary.notHostSlots`, new; not in `candidates` / `drifted`) and reports
  `[not a host]: N stored slot(s) left untouched`, apply included (gate:
  `observer_reconcile_sweep_native`, the non-host case — no write, no TM row). The
  reconcile detail numbers change accordingly.
- Known open, both closed: the strict guard is the decision above (the 742 dry-run drops
  on 3 `numisdata321@tchi1` records are legacy test data of an old definition moved
  numisdata → tch, per the owner); `numisdata321` needs no ontology change.
