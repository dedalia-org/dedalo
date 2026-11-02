# WC-2026-08-06-observer-grow-only-failsafe-retired — the mirror recompute applies the full law, drops included

- **Date:** 2026-08-06. Supersedes the Phase-0 grow-only fail-safe adopted
  2026-08-02, which never had an entry of its own — this file backfills it and
  retires it in one pass, so the ledger records that the engine diverged at
  all and for how long.
- **Decision:** — (write-path value rule; DEC-12 gates shipped with it:
  `test/unit/observer_failsafe_native.test.ts`,
  `test/unit/observer_reconcile_native.test.ts`,
  `test/unit/observer_equivalence_native.test.ts`,
  `test/unit/observer_native.test.ts`).

### Shape before (PHP)

PHP's `set_dato_external` recompute (v6
`class.component_relation_common.php`) rebuilds the observer's value from the
inverse search and saves whatever it computed. Entries that no longer match
are simply absent from the new value — PHP **shrinks**. There is no fail-safe,
no opt-in, and no report: a recompute that returns fewer references silently
removes them.

### Shape before (TS, 2026-08-02 → 2026-08-06)

For four days the TS engine did **not** shrink. `recomputeExternalRelation`
split the recompute into `kept` + `additions` and persisted
`existing ∪ additions` — every stored entry kept in place — unless the caller
passed `allowShrink: true`, which no production caller ever did. Withheld
drops were logged and counted (`observers_shrink_refused`); the operator path
was `bun scripts/observer_reconcile.ts --apply --allow-shrink`.

The reason was honest and is worth recording: the value law was known to be
TOO SMALL. `properties.source.data_from_field` (the equivalents closure) was
unported, so the computed reference set under-reported by a quarter of a
million locators (measured: self-only seed = 318,122 locators lost across
19,908 numisdata3 records), and every drop the recompute wanted was therefore
suspect. A blanket refusal was the correct response to a law that could not be
trusted.

### Shape after (TS)

The full law persists, drops included. `allowShrink` is **deleted** — from the
kernel's `options`, from `ReconcileOptions`, and as the `--allow-shrink` CLI
flag. There is no caller-supplied shrink switch, deliberately: a parameter
that can mean "allow the drop" is always one omitted argument away from the
unsafe value, and that is precisely the hole that armed the 2026-08-02 wipe
(`undefined !== false`). A static gate
(`observer_failsafe_native.test.ts`, "there is NO caller-supplied shrink
switch") fails if one comes back.

The four remaining escapes are all **derived by the kernel**:

| Escape | Outcome flag | Counter |
|---|---|---|
| unported PHP sub-law (`source_overwrite` / `set_observed_data`) | `refusedSublaw` | `observers_unported_sublaw_refused` |
| >2000-reference freeze (PHP parity) | `refusedBigResult` | `observers_big_result_refused` |
| finite non-zero `references_limit` | `possiblyTruncated` | `observers_references_limit_refused` |
| **degraded seed** (new) | `skippedShrink` + `seedDefects` | `observers_shrink_refused_degraded_seed` |

The degraded-seed refusal is what made the retirement landable and is a
divergence with no PHP equivalent — see
`WC-2026-08-06-observer-degraded-seed-refuses-shrink`.

### Reason

The premise expired. The D3 closure landed and the value law is now measured
exact on 19,885 of 19,908 records, so "the computed set is too small" is no
longer true. Meanwhile the guard had become the defect: **a mirror that can
only grow is not a mirror.** A user who removed an equivalence between two
coin types saw both types keep each other's coins in the public portal, with
no way to correct it short of an operator running a maintenance script — the
reported bug this change fixes.

Corpus impact, measured on monedaiberica/dedalo_mib_v7 immediately before the
flip: **22 records / 1,673 locators** of accumulated wrong data across the
whole install (the rest of the 847-record drift was pure growth). Each drop
was verified genuine by checking the referencing records directly — e.g.
`numisdata5/367` stored 879 referencers while only 120 of those 879 still
pointed at it, and all 879 records still exist. After the flip a full
`--apply` converged the corpus (845 repaired, 0 held) and a re-run reports 0
drifted.

The exposure the fail-safe was really protecting — `numisdata679`/
`numisdata965`, whose unported sub-law would recompute 131,806 locators to
zero — is untouched by this change: that refusal is a **pre-compute early
return**, so it fires before any read, lock or write regardless of what the
shrink rule says.

### Gate reconciliation

No fixture re-harvest. The oracle store carries read-path shapes; this is a
write-path value rule with no wire-shape change — `set_dato_external` emits
the same entry bytes (`{id, type:'dd151', section_id, section_tipo,
from_component_tipo}`), only the membership of the array changes, and TS now
matches PHP's own shrink behaviour more closely than before.

The three behavioural gates that previously PINNED the withholding were
inverted in the same commit, deliberately and with their reasoning rewritten
in place rather than deleted:

- `observer_native.test.ts` — "duplicate ADDS the copy to the mirror;
  delete_locator REMOVES it" (was: "…shrink is REFUSED (Phase-0 fail-safe)").
- `observer_reconcile_native.test.ts` — "a bypass DELETE makes the recompute a
  pure shrink, and the shrink APPLIES" and "a MASKED SWAP … applies BOTH
  halves".
- `observer_failsafe_native.test.ts` — the `allowShrink` static pins migrated
  onto the four kernel refusals.

`engineering/observer_shrink_budget.json` + `observer_reconcile.ts --budget`
is the standing check: a corpus dry run exits non-zero if the install ever
wants to delete more than the declared ceiling, so a future change to the
value law that would mass-delete fails there instead of at the next save.

## Addendum 2026-10-30 — the sub-law row of the escape table is retired

The first row of the escape table ("unported PHP sub-law … `refusedSublaw` …
`observers_unported_sublaw_refused`") no longer holds. Both sub-laws are ported behind a
closed classifier (`WC-2026-10-30-observer-external-value-laws`), so `numisdata679` /
`numisdata965` now COMPUTE — as a copy of the type's `numisdata77` / `numisdata11`, not
under the default law whose zero result this row guarded against. The escapes now read:

| Escape | Outcome flag | Counter |
|---|---|---|
| refused external law (ambiguous / malformed node) | `refusedLaw: {reason}` | `observers_law_refused` (+ alias `observers_unported_sublaw_refused`) |
| target section does not declare the observer, no stored slot | `targetNotHost` | `observers_target_not_host` (`WC-2026-10-30-observer-target-not-host`) |
| >2000-reference freeze — law (c) only | `refusedBigResult` | `observers_big_result_refused` |
| finite non-zero `references_limit` | `possiblyTruncated` | `observers_references_limit_refused` |
| degraded seed, or an unanswerable copy law | `skippedShrink` + `seedDefects` | `observers_shrink_refused_degraded_seed` (+ `observers_source_overwrite_*` / `observers_observed_data_unanswerable`) |

All are still derived by the kernel; there is still no caller-supplied shrink switch.
The `refusedSublaw` outcome key is renamed `refusedLaw`.
