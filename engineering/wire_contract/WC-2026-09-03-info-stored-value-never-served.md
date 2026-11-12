# WC-2026-09-03-info-stored-value-never-served — a `component_info` value is DERIVED: the read never serves a stored `misc` array

- **Date:** 2026-09-03, with the P1-8 remediation of the 2026-08-26 deep audit
  (DATA-15 — "component_info observers write only the Time Machine while the
  read serves the stale live column"). Repeals the stored-wins half of
  `WC-2026-08-09-info-legacy-stored-value-fallthrough`; that entry's v5-residue
  classification survives as a counter discriminator only.
- **Decision:** DEC-12 (invariants are tripwired). Option A of the P1-8 scoping
  (the read path ignores the store) over option B (the observer persists `misc`
  through the write chokepoint): B would have served ONE user's compute — the
  `media_icons` tool columns are principal-scoped — to every user, so the stored
  value could never be right for everyone. Gates:
  `test/unit/component_info_legacy_state_native.test.ts` (every stored shape →
  live compute, the ignore counter), `test/unit/info_widget_native.test.ts`
  (`archive_stored` now asserts the live result and the ABSENCE of the stored
  bytes; the oracle golden stays in the fixture as the record of what PHP did),
  `test/unit/write_obligations_native.test.ts` (observer write → read
  composition: a Time Machine row restored into `misc` is inert on the wire).
- **Shape before (PHP, and TS through 2026-09-02):**
  `component_info::get_db_data()` (`core/component_info/class.component_info.php:256`)
  is `$data = parent::get_data(); if (empty($data)) $data = $this->get_data();`
  under `use_db_data = true` (`class.common.php:2589`) — ANY non-empty stored
  `misc` array won the emission. TS kept that (the 2026-08-09 entry carved out
  the positively identified v5 blob only). Composed with this engine's own
  observer (`section/record/observers.ts` `recomputeInfoObserver`, which writes a
  `matrix_time_machine` row per observed save and never the live column) the
  rule was a trap: `tool_time_machine` resolves `component_info` to the `misc`
  column, so restoring one of the rows THE OBSERVER ITSELF MANUFACTURED populated
  `misc` with a modern-shaped array, after which the served value was FROZEN at
  that snapshot while the observer kept appending correct, unread history —
  self-baiting, with no repair path but clearing the column by hand.
- **Shape after (TS):** the emit hook
  (`src/core/components/component_info/emit.ts`) ALWAYS emits the live widget
  compute (`computeInfoWidgets` for this record, this principal, this mode —
  the insertion-ordered `{widget,key,widget_id,value,…}` shape, WC-026
  dualised). A non-empty stored array of ANY shape — v5 residue, a modern
  entry array, the tags shape, an unclassifiable shape — is ignored and
  COUNTED: `component_info_stored_value_ignored` on every read that ignored
  one, plus `component_info_legacy_stored_value` when the ignored array is the
  v5 blob (so the residue corpus of an install stays visible to ops, exactly as
  before). The `null`/`[]` cases are unchanged (live compute, nothing counted).
  When the ddo declares no widgets the live compute returns `null` and the read
  serves `entries: null` — the honest absence the 2026-08-09 entry already
  pinned for the residue case, now for every stored shape.

  **Nothing is rewritten.** The `misc` column is not touched by the read, the
  observer, or any migration; a stored value is simply not what is served. The
  observer keeps writing its Time Machine rows (a dated record of what the
  widgets computed then), and a Time Machine restore of one of them is now
  INERT for what is served — `write_obligations_native` composes the two.
- **Reason:** a `component_info` value is a DERIVED DISPLAY value and the engine
  has NO door that authors it: no client widget calls `change_value`/`save`
  (verified across `client/dedalo/core/widgets/**` and `component_info.js`), and
  the server-side observer writes only history. Everything that can land in
  `misc` is therefore residue of an engine that no longer exists (v5), a restore
  of a snapshot, or a PHP-era client save — and serving any of them freezes a
  per-principal computation at somebody's stale snapshot. The 2026-08-09
  never-narrow argument ("an unclassifiable stored array might be data the
  engine does not know") does not apply to a value nothing authors; it applied
  while stored-wins was the rule and the question was which stored arrays to
  discard. With stored-wins gone the question no longer exists. The client
  contract is unchanged: it already selected on `widget`/`key`/`widget_id`, the
  keys the live compute emits.
- **Gate reconciliation:** no re-harvest needed and none is possible
  (`engineering/ORACLE_HARVEST.md`): the frozen store holds no `misc`-bearing
  `component_info` fixture, so no replayed response changes. The one oracle
  golden that captured the stored branch — `archive_stored` in
  `test/unit/fixtures/info_widget_native/entries.golden.json` — is KEPT
  unmodified as the oracle record; its test now asserts the served value equals
  the `archive_empty` live result and that the stored bytes are absent, and
  that the repealed golden differs from what is served (so the pin is
  non-vacuous). `component_info_legacy_state_native` was re-pinned the same day:
  the modern / mixed / unclassifiable rows assert `served === control` where
  they asserted `served === stored`; the classifier test and the legacy
  fall-through tests are unchanged; the counter test covers both counters.

## Addendum — the diffusion and export doors (2026-11-12, T1-2)

The rule now holds on every door, not only the section read: diffusion publishes the live compute
(`src/diffusion/resolve/info_value.ts`; `defaultPublicationValue` refuses `component_info` with
`internal.invariant`, so the stored slice can never be published), and tool_export / the flat
readers / `dedalo_raw` compute live through the `info` flatValue family. See
`WC-2026-11-12-info-live-publication-export`.
