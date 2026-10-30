# WC-2026-10-30-observer-law-derived-edges — a copy law subscribes to the component it copies

- **Date:** 2026-10-30 (owner ruling Q1 of the same day: "derived edges YES").
- **Decision:** DEC-12 (gated: the derived / shadowed / dedup cases of
  `test/unit/observer_subscriptions_native.test.ts`; the end-to-end case of the
  `source_overwrite` native gate). Extends
  `WC-2026-08-02-observer-subscription-registry-activation` (see its 2026-10-30
  addendum).

### Shape before (PHP, and TS until 2026-10-30)

An edge existed only where an `observe` entry (or a forward `observers` spec) declared
it. `numisdata679` (*Coins* on a catalog term) copies `numisdata77` (*Coins* on the
type its `numisdata656` pointer names), but declares only `observe` ← `numisdata656`.
So the copy refreshed when the term's pointer changed and went stale whenever the
TYPE's coins changed — measured: `numisdata665/4684` holds 47 coins while its type
holds 53. Affects PHP identically.

### Shape after (TS)

The subscription registry's pass 3 (`observer_subscriptions.ts` `buildSubscriptionIndex`)
reads each covered observer's law and synthesizes one edge per declared input:

- **only `source_overwrite` yields one** — `{observed: data_from_field, via: pointer}`;
  `inverse_search` and `observed_data` yield none (the inverse search is already wired
  by its relay chain; the same-record text edge is already declared);
- the synthesized edge: `{observedTipo, observerTipo, declaration: 'law-derived',
  origin: 'law', via, entry: {component_tipo, server: {config:
  {use_inverse_relations: true}, perform: {function: 'set_dato_external'}}}}`, host =
  the observer's own section; its targets come from the `inverse` resolver through the
  pointer (`WC-2026-10-30-observer-target-resolvers`), host-filtered per row;
- **a declared key wins**, client-only entries included: a declared
  `(observed, observer)` is recorded in `diagnostics.lawShadowed` and gets no derived
  edge. A client-only `observe` entry naming the input is therefore the per-edge kill
  switch — an ontology edit, never code;
- derived edges are listed in `diagnostics.lawDerived`, take part in the cycle scan,
  and are exempt from the observe-entry contract checks (they have no authored entry);
- `isObservedTipo` (obligation ledger) and the hop leaf pre-gate read the same registry,
  so they see derived edges unchanged.

Measured on `dedalo_mib_v7` (2026-10-30): `lawDerived` = `numisdata77 → numisdata679`
(via `numisdata656`, host `numisdata651`); `lawShadowed` = `numisdata11 → numisdata965`
(already declared with `use_inverse_relations`); 0 cycles, 0 contract violations.
Suite twin: `test6157 → testcoincatalog1013` derived, `test6105 → testcoincatalog1019`
shadowed.

Resulting chain: a coin is linked (`numisdata161` saves) → relay `numisdata36` →
`numisdata77` written on the type → the derived edge finds every term whose
`numisdata656` names that type → `numisdata679` recomputed; the cascade guard dedups
`observer|section|id`.

### Reason

A law that reads D without depending on D is stale by construction. The edge is read
from existing properties; no ontology node is created. The alternative — an `observe`
entry on `numisdata679` modelled on `numisdata965` ← `numisdata11` — remains open as a
master-ontology proposal; once it lands the declared edge shadows the derived one with
no code change.

### Gate reconciliation

No fixture re-harvest (write-path dispatch; no served byte shape changes). The
registry's diagnostics gain two keys (`lawDerived`, `lawShadowed`); the
`observers_registry` gauge is unchanged.
