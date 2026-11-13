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
- **Targets** come from the same resolver table (`self_and_observable` for rsc1214) with
  NO law: an unfiltered inverse lookup, no equivalence expansion. The HOST precondition
  applies per target: a record whose section does not declare the observer is the counted
  no-op (`observers_target_not_host`). **PHP's empty write onto the observable's foreign
  section (`rsc197`) is NOT ported.**
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

### Counters

`observers_refresh_data_refused` (grammar refusals — configuration, should be 0),
`observers_refresh_data_unchanged` (trigger declined: an unchanged re-save — informational),
`observers_target_not_host` (shared), `observers_server_shape_not_covered` no longer ticks
for `refresh_data`.

### Gate reconciliation

No fixture re-harvest (write path; no served byte shape changes). `external_law_classify`
S10 pins the empty exemption table and rsc1214's shape → `self_and_observable` +
`refresh_data`; `external_law_registry_tripwire`'s fixture `server_shape_exemptions` is
`{}`; `write_obligations_tripwire` B4 pins `persistObserverResaveKeys` to its two callers
and the new unit `applyRefreshDataClear` → `dispatchRefreshData` → `propagateToObservers`.
