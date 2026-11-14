# WC-2026-11-13-observer-refresh-data — the `refresh_data` observer perform clears the observer on its host whenever the observed value changes; closed grammar, no foreign write

- **Date:** 2026-11-13 (T1-U05 / O13 — RC-closure plan Tier 1; owner ruling 2026-11-13 A4,
  option A of `T1-U05_plan`).
- **Decision:** DEC-12 (gated: `test/unit/observer_refresh_data_native.test.ts`; the
  classifier rows of `test/unit/external_law_classify.test.ts`; the lockstep legs of
  `test/unit/external_law_registry_tripwire.test.ts`; the exclusivity rows of
  `test/unit/write_obligations_tripwire.test.ts`).
  Siblings: WC-2026-10-30-observer-target-resolvers (the resolver table this perform
  shares — its dated addendum below), WC-2026-10-30-observer-target-not-host (the host
  precondition this perform obeys), WC-2026-08-02-observer-relay-writes-nothing (the
  cascade-owned re-save door this write takes).

### The edge

One shipped edge declares it — `rsc1214` (`component_select`, *Biographical milestone*,
section `rsc1152`) observing `rsc1156` (`component_autocomplete`, the person, `data_limit: 1`):

```json
"server": {
  "config":  { "use_self_section": true, "use_observable_dato": true },
  "perform": { "function": "refresh_data",
               "params": { "actions": [{ "condition": "on_empty", "action": "empty_data" }] } }
}
```

The select stores a locator the curator PICKS — a milestone of the chosen person (its
`fixed_filter` reads `rsc423` of the person in `rsc1156`). It is not an external mirror; no
value law applies.

### Shape before (PHP)

`update_observer_data` (frozen `class.component_common.php:2351-2511`, v6 identical): per
target (`self_and_observable` — the host record AND the person record(s) the saved value
names) a FRESH observer instance ran `refresh_data` (:2565-2597). `on_empty`:
`if (empty($this->get_observable_data())) { empty_data(); save(); }`. Any other
`condition` was a SILENT no-op; `action` could be `Class::method` — a static call of
whatever the ontology named. `empty_data` (:2606) = `set_data(null)`, then `save()`.

**Effective behaviour, for 20 years:** the fresh instance's `observable_data` was never set
(it is set on the OBSERVABLE, or on the observer in the no-perform branch), so `on_empty`
was ALWAYS TRUE. Every save of the person cleared the milestone on the host record and
also wrote an empty `rsc1214` onto the `rsc197` person record — a foreign section. The
documented intent ("clear when the observed becomes empty") was never the behaviour.

### Shape before (TS, until 2026-11-13)

`refresh_data` was a NAMED exemption (`SERVER_SHAPE_EXEMPTIONS`), refused and counted
(`observers_server_shape_not_covered`) at dispatch; nothing written. Changing or clearing
the person left the previous person's milestone stored — a value outside the field's own
`fixed_filter`, published and searchable (data-integrity drift). The exemption's stated
reason ("component_relation_index externals … computed at read time") was wrong: the node
is a `component_select` storing a user value.

### Shape after (TS)

- **The perform is dispatched.** `classifyObserverServerShape` answers
  `{resolver, perform}` with `perform ∈ {set_dato_external, refresh_data}` (closed); any
  other function is `perform_not_covered`, counted as before. `SERVER_SHAPE_EXEMPTIONS` is
  kept as a mechanism and is EMPTY.
- **Semantics — PHP's effective behaviour, named honestly (owner ruling A4):**
  `on_empty → empty_data` CLEARS the observer slot on each HOST target **whenever the
  observed value CHANGED** — a locator added or removed (the ledger's before-image vs the
  saved value, the one removed-set rule; a literal compares canonically). The condition's
  NAME is the ontology's and is kept; its real meaning is documented in code
  (`src/core/section/record/refresh_data.ts`), here, and in `docs/core/system/observers.md`.
  An **unchanged re-save** of the observed clears nothing (counted
  `observers_refresh_data_unchanged`). A cascade hop (no before-image) counts as a change —
  PHP re-entered propagation from that save unconditionally.
- **Closed grammar.** `perform.params` is `{actions:[{condition:'on_empty',
  action:'empty_data', arguments?: []}]}` — the object or PHP's one-item array holding it.
  Anything else (an unknown condition or action, a `Class::method`, non-empty arguments,
  keys outside the grammar, an empty `actions`) is REFUSED loudly, counted
  (`observers_refresh_data_refused`), and nothing is resolved or written. The engine never
  calls a function because the ontology names it.
- **The door it fires from (same-day amendment, review finding).** A COMPONENT SAVE —
  the ledger's `keys` declaration (save_component / persistRecordKeys / the appended-items
  door), PHP's `component_common::Save()`, the only place PHP ever ran it — and the cascade
  hop that re-enters from a written observer. A WHOLE-RECORD write never fires it: a birth
  (a create with values, `duplicateSectionRecord`, the Time Machine's undelete), a `replace`
  (the Time Machine's whole-record restore, `persistRecordColumns`) and a death declare
  every key of the record to the ledger, and the clear riding those declarations wiped the
  milestone the SAME write had just copied or restored (a duplicate born with person P and
  milestone M had M cleared by its own birth entry; a restore to (A, m(A)) over a live
  (B, m(B)) had m(A) cleared by the B→A change it declared). PHP's `section_record` never
  called `propagate_to_observers` from any of them. Counted
  `observers_refresh_data_skipped` (`refresh_data.ts` refreshDataTrigger /
  `ObservedChange.origin`, filled by the ledger's drain and the hop).
- **A slot the same operation wrote is never cleared.** The ledger marks every key a
  declared write touched on the per-transaction guard AT ENQUEUE (`CascadeGuard.written`,
  `touchedKeys` ∪ the declared changes), and `applyRefreshDataClear` skips a slot found
  there (outcome `self_written`, the same counter). The case: a CSV import row saving the
  person AND the milestone in ONE transaction (`import_csv_execute` wraps the row) drains
  the person's entry after BOTH writes landed. PHP propagated synchronously inside each
  component save, so its outcome depended on the COLUMN ORDER (person first: the clear hit
  the old slot and the milestone column then wrote M — kept; milestone first — cleared); TS
  keeps the row's milestone whatever the order. The shield is the operation's own write,
  never the order: the same person change in its own transaction clears.
- **Targets** come from the same resolver table (`self_and_observable` for rsc1214) with
  NO law: an unfiltered inverse lookup, no equivalence expansion. The HOST precondition
  applies per target: a record whose section does not declare the observer is the counted
  no-op (`observers_target_not_host`) — counted, NO log line (WC-2026-10-30-observer-target-not-host:
  the `use_observable_dato` row selects the person records on every save, so the skip is
  the edge's expected shape; the warn line the first cut wrote per person target is gone).
  **PHP's empty write onto the observable's foreign section (`rsc197`) is NOT ported.**
- **The write** replaces the slot by `[]` — the shape the save door stores when a curator
  empties the field — through the cascade-owned door `persistObserverResaveKeys` (an
  observer re-written by its OWN edge, no ledger entry), inside the audited tail (the TM
  pair, baseline backfill), modified stamps unless the record was born verbatim in the
  operation; the actor is the saving user. A slot **already empty** writes nothing — no TM
  row, no stamp (PHP saved anyway; elided). The cleared slot **hops** (kind `refresh`, the
  cleared locators as the hop's removed set), bounded and deduplicated like every hop
  (`refresh|…` on the guard's `resaved` namespace).
- **Repair of data written since the cutover: NONE** (owner ruling B4 — TS-beta data is
  test data; no census, no script, no release note).

### Divergences from PHP, stated

| PHP | TS | Why |
|---|---|---|
| cleared on EVERY save of the observed (`on_empty` always true) | cleared on a CHANGE of the observed value | the effective rule, minus the re-save noise; an unchanged save is not a change (gate case g) |
| wrote an empty observer onto the observable's record (foreign section) | counted not-host no-op | WC-2026-10-30-observer-target-not-host: a slot lives only where it is declared |
| saved even when already empty (TM row) | no write, no TM row | a write that changes nothing is noise |
| unknown `condition` = silent no-op; `action` = any `Class::method` | loud refusal, counted, nothing written | the dispatch-security rule of every closed table |
| never ran from a whole-record write (duplicate, undelete, whole-record restore: `section_record` did not propagate) | the same — a `birth` / `replace` / `death` declaration never fires the clear (counted skipped) | the first TS cut fired it from the ledger's every declaration and wiped the value the write itself carried |
| a multi-column write of one record (CSV import row) cleared or kept the milestone BY COLUMN ORDER | kept whatever the order (the operation's own write shields the slot) | PHP's order-dependence was an accident of synchronous propagation, not a rule; the row's value is the curator's |

### Counters

`observers_refresh_data_refused` (grammar refusals — configuration, should be 0),
`observers_refresh_data_unchanged` (trigger declined: an unchanged re-save — informational),
`observers_refresh_data_skipped` (trigger declined: a whole-record write, or a slot the same
operation wrote — informational), `observers_target_not_host` (shared; no log line),
`observers_server_shape_not_covered` no longer ticks for `refresh_data`.

### Gate reconciliation

No fixture re-harvest (write path; no served byte shape changes). `external_law_classify`
S10 pins the empty exemption table and rsc1214's shape → `self_and_observable` +
`refresh_data`; `external_law_registry_tripwire`'s fixture `server_shape_exemptions` is
`{}`; `write_obligations_tripwire` B4 pins `persistObserverResaveKeys` to its two callers
and the new unit `applyRefreshDataClear` → `dispatchRefreshData` → `propagateToObservers`.
The door and the self-write shield are gated in the same native file (cases i–k: a
`duplicateSectionRecord` copy keeps its milestone; one `withTransaction` saving person then
milestone, and milestone then person, keeps it; a `persistRecordColumns` replace that changes
the person keeps the milestone it writes; the pure trigger per origin; the clear unit's
`self_written`).

## Addendum 2026-11-14 — `ObservedChange.origin` is REQUIRED (owner ruling A4 Q3, 2026-11-13)

The first cut read an ABSENT origin as a component save (a hand-built dispatch — a gate, a
script calling `propagateToObservers` directly — fired the clear). That default is gone:

- **Type**: `ObservedChange.origin: ObservedChangeOrigin` (no `?`), the closed set
  `'keys' | 'replace' | 'birth' | 'death' | 'recompute' | 'hop'` (`refresh_data.ts`
  `OBSERVED_CHANGE_ORIGINS`).
- **Runtime**: `propagateToObservers` REFUSES (`internal.invariant`, the caller's bug — thrown
  before any edge is read, never swallowed, never counted as a propagation failure) a change
  whose origin is missing or outside the set. `refreshDataFiresOn` takes the origin alone; no
  branch reads `undefined`.
- **Producers**: the ledger drain (`entry.origin` = the declaration kind) and the cascade hop
  (`'hop'`) already named theirs; every direct dispatch in the gates now states `origin`.
- Gates: `observer_failsafe_native` ("origin is REQUIRED": the type has no `?` + every
  `src/`/`scripts/` call site states it; "the kernel REFUSES a dispatch without an origin" —
  RED before: it returned `[]`), `observer_refresh_data_native` (trigger per origin;
  `isObservedChangeOrigin`). No wire shape changes.
