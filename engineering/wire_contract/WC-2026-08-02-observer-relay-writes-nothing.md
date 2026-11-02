# WC-2026-08-02-observer-relay-writes-nothing — the observer trigger relay re-saves nothing

- **Date:** 2026-08-02 (D1, the relay branch of the observer cascade).
- **Decision:** — (write-path side-effect rule; DEC-12 gates shipped with it:
  `test/unit/observer_cascade_native.test.ts`).

### Shape before (PHP)

PHP's DEFAULT observer branch (no `perform`, observer not an info model — v6
`class.component_common.php:1651-1660`) reads the observer component's value,
sets `observable_dato` to that value WITH REFERENCES
(`get_dato_with_references()` for `component_relation_related`, `get_dato()`
otherwise) and calls `$component->Save()`. The value DOES NOT CHANGE — the
re-save exists purely to re-enter `propagate_to_observers` (:1372); it is a
trigger relay, a dependency edge (the live edges: `numisdata161 →
numisdata36`, `tch241 → tch40`; the ontology's own comment documents the
chain numisdata161 saves → fires numisdata36 → fires numisdata77). But
`Save()` carries side effects: a `matrix_time_machine` row for the unchanged
value, a bump of the record's modified stamps (dd197/dd201), an activity-log
line, and a live-column rewrite of identical bytes.

### Shape after (TS)

The relay in `src/core/section/record/observers.ts` is modelled as
**write:'none' + payload 'with references'**: it reads the observer's value
with references (`getStoredWithReferences` — same model dispatch as PHP) and
re-enters propagation through the bounded D2 dispatch, writing NOTHING — no
TM row, no dd197/dd201 bump, no live-column write, no activity line. The
relay also contributes nothing to the save response's `observers_data` (PHP
merges the re-saved observer's component JSON for same-record targets; the
shipped relay edges are all `use_self_section:false`, so no live config ever
produced such an item anyway).

Relay execution is UNCONDITIONAL: the `DEDALO_OBSERVER_CASCADE` rollout flag
that briefly gated it was retired the same day it landed (see
WC-2026-08-02-observer-cascade-bounded-flag — the benchmark cleared the
cascade, and a deploy flag over declared edges meant data divergence between
identical installs). Every declared relay edge re-enters the bounded D2
dispatch.

### Reason

The re-save's side effects are pure noise at best and wire divergence at
worst: a TM row for an unchanged value pollutes the record's history (and TM
restore surfaces), a modified-stamp bump misreports WHO/WHEN for a record no
user touched, and an identical-bytes rewrite is a wasted write inside the
hot save path. The relay's ONLY semantic content is the child propagation
event, which TS preserves exactly (payload = the value with references).

### Gate reconciliation

`test/unit/observer_cascade_native.test.ts` — the unconditional-cascade
convergence gate (gate 1; no mode exists since the flag's retirement)
asserts the relay observer's stored bag stays byte-identical and holds
ZERO `matrix_time_machine` rows while its child recompute lands normally. No
parity fixture replays observer writes, so no fixture is affected. **No
re-harvest** (impossible anyway): the read-path store never contained a
relay re-save's TM row.

## Addendum 2026-10-31 — the default branch writes nothing UNLESS the observer's own save rules change its stored value; it also accepts `use_inverse_relations`

Portal order model (owner ruling, `WC-2026-10-31-portal-order-model`). PHP's default branch is a
RE-SAVE, and a re-save runs the observer's own save rules; TS now honours that half while
keeping every side-effect rule above for the identity case:

- **Re-save through the observer's own save rules.** Per relay target, BEFORE the hop,
  `observers.ts` `resaveObserverThroughSaveRules` first asks the cheap pre-gate — may the
  observer's DATA tipo declare an `order` at all (`order_locators.ts` `mayDeclareOrder`)? No ⇒
  outcome `no_rule`: no transaction, no row lock, no read, so an identity-rule relay still
  locks AND writes nothing. Otherwise it reads the observer's stored value under the
  target row's `FOR UPDATE` lock, passes it through `record_write.ts` `applyKeySaveRules` (the
  ONE function every key write applies — today one rule: a portal declaring a per-ddo `order`
  is sorted by it; identity for every other key) and writes it back ONLY when the result
  differs (`JSON.stringify` compare). A difference goes through the cascade-owned door
  `persistObserverResaveKeys` (no ledger entry — the relay's own hop re-enters propagation)
  with the modified stamps and the observer's TM pair (the mirror write tail). **Identity rules
  ⇒ still NOTHING written** — no TM row, no dd197/dd201 bump, no live write:
  `numisdata161 → numisdata36` and every shipped relay edge are unchanged (none of their
  observers declares `order`). A declared-order portal ⇒ one re-sorted write, TM-audited. The
  re-save skips a target whose section does not declare the observer (the mirror kernel's
  host precondition) and is deduplicated per operation on the guard's OWN `resaved` namespace
  (`resave|observer|section|id`), never the mirror recompute's `recomputed` set, so a slot that
  needs both gets both. The re-save is ISOLATED per target (`observers.ts` `resaveIsolated`):
  a throw (a rank search refusing a legacy array, a lock timeout) is logged with the edge and
  the record and counted (`observers_resave_failed`, engineering/PRODUCTION.md); the target's
  hop, the remaining targets and the save's later subscriptions still run — one derived
  re-sort never cancels the relay it rides on.
- **`use_inverse_relations` reaches the default branch.** A no-`perform`, `filter`-absent entry
  with `use_inverse_relations` (and no `use_observable_dato`, which keeps precedence) used to
  fall to the `set_dato_external` shape classifier and be refused (`perform_not_covered`,
  counted). It now relays: targets = the records referencing the saved one through the
  edge's `via` (`external_laws/resolvers.ts` `inverseHostTargets`, the body the
  `set_dato_external` inverse resolver now shares), each re-saved then hopped. Census
  2026-10-31: zero AUTHORED entries of that shape on the app ontology (no install behaviour
  flips); its producer is the registry's pass-4 ORDER-DERIVED edges
  (`observer_subscriptions.ts`), built from each portal's `order` declaration (no ontology
  node).

- **The mirror recompute compares what it would STORE.** The `set_dato_external` kernel
  (`observers.ts` `recomputeExternalRelation`) passes the law's merge — and the withheld
  grow-only merge — through the same `applyKeySaveRules` BEFORE its no-drift compare. A copy
  law (`source_overwrite`, `observed_data`) builds its merge in the LAW's order (order
  `'desired'`); on a slot that also declares `order` the chokepoint stores it sorted, so the
  law-order compare never matched: every recompute wrote a TM row, a stamp and a cascade hop,
  the value never converged, and the `observer_mirrors` reconcile reported it drifted forever.
  The "no drift → no write" rule above now holds for those slots too (the second recompute
  writes nothing; the dry run agrees). Identity rules ⇒ unchanged bytes for every other slot.
- **Pass-4 edges follow DATA-driven targets.** A declared-order portal whose
  `sqo.section_tipo` resolves from records (`hierarchy_types`, `section_model`,
  `ontology_sections`, `field_value`) clears the subscription registry on a write to those
  sections (`observer_subscriptions.ts` ORDER DATA SOURCES), so activating a hierarchy adds its
  edges without an ontology write.

### Gate reconciliation (addendum)

`test/unit/observer_cascade_native.test.ts` — gate 1 KEPT unchanged (a `use_observable_dato`
relay whose observer's save rules are identity: bag byte-identical, zero TM rows) plus the
default-branch legs (inverse edge reaches the branch, no `observers_server_shape_not_covered`;
a declared-order observer re-written sorted with one TM row; depth/visited bound; non-host
skipped; `resaved` ≠ `recomputed` in either drain order).
`test/unit/observer_subscriptions_native.test.ts` — pass-4 legs, the ORDER DATA SOURCES map.
`test/unit/portal_order_native.test.ts` — the end-to-end re-sort (one- and two-hop) through
real saves; the copy-law mirror that declares an order converging (second recompute
`changed:false`, no TM row); a `field_value`-targeted declared-order portal gaining its edge
on the data write. No parity fixture replays observer writes; no fixture is affected.
