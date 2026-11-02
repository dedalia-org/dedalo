# WC-2026-10-30-observer-target-resolvers — the `set_dato_external` target config is PHP's closed switch, with an inverse resolver

- **Date:** 2026-10-30 (lands with `WC-2026-10-30-observer-external-value-laws`).
- **Decision:** DEC-12 (gated: the resolver-table rows of
  `test/unit/external_law_classify.test.ts`; the reconcile shape rows of
  `test/unit/observer_reconcile_discovery_native.test.ts`; the derived-edge cases of
  `test/unit/observer_subscriptions_native.test.ts`).

### Shape before (PHP)

`update_observer_data` (frozen `class.component_relation_common.php:2426-2459`) picked
the records to recompute from `server.config`, in this order:

| `server.config` | Targets |
|---|---|
| `use_observable_dato` + `use_self_section: true` | the saved record + the saved data's locators |
| `use_observable_dato` + `use_self_section: false` | the saved data's locators (REPLACING a filter result — case b) |
| `use_inverse_relations: true` | `get_inverse_references()` of the saved record, unfiltered, visited once per locator |
| anything else, no config included | the saved record |

Any other `perform` method name was called as given.

### Shape before (TS, until 2026-10-30)

`!useObservable || perform !== 'set_dato_external'` ⇒ a bare `console.error`
"server shape not covered". Dropped: the `use_inverse_relations` edge
(`numisdata965` ← `numisdata11`) and every no-config edge (the six legend-symbol
observers `numisdata563`, `numisdata574`, `numisdata575`, `numisdata993`,
`numisdata1227`, `numisdata1229`). `use_inverse_relations` was not typed and nothing
read it.

### Shape after (TS)

`classifyObserverServerShape` (`src/core/section/record/external_laws/resolvers.ts`) is
the ONE table, shared by the live dispatch and the reconciler
(`isCoveredReconcileEdge`):

| `server.config` | Resolver | Targets |
|---|---|---|
| `use_observable_dato` + `use_self_section === true` | `self_and_observable` | saved + observable saved + removed locators (+ the equivalence-class expansion) |
| `use_observable_dato` + `use_self_section === false` | `observable` | observable saved + removed (replaces a filter — `test199` ← `test188`) |
| `use_inverse_relations === true` | `inverse` | `findInverseReferences` of the saved record **through the law's pointer** (`from_component_tipo` exact) when the law has one, host-filtered per row, deduped per record, lock-order sorted |
| anything else, no config included | `self` | the saved record |

- `perform.function` must be `set_dato_external`. `refresh_data` (`rsc1214` ←
  `rsc1156`) is a NAMED exemption (`SERVER_SHAPE_EXEMPTIONS`, reason inline), any other
  function `perform_not_covered`; both counted `observers_server_shape_not_covered`
  (was: an uncounted log line).
- An SQO `filter` next to `self` / `self_and_observable` is refused
  (`filter_not_covered`): those resolvers would ADD the filter's search result, which
  TS does not run; a silent drop would narrow the targets. No live edge has that shape.
- A refused law is reported ONCE per edge per save at dispatch (it was once per target
  inside the kernel); direct kernel callers (reconcile, ledger, duplicate) still count
  per record.

Divergences from PHP:

- **Inverse lookup filtered by the pointer.** For `source_overwrite` it is an
  equivalence: only a record whose pointer names X can have X as its copy source. For
  law (c) without a pointer the result equals PHP's restricted to host sections, which
  the host precondition (`WC-2026-10-30-observer-target-not-host`) enforces anyway — no
  live law (c) edge uses `use_inverse_relations`.
- **Deduped per record** (PHP visited a record once per referencing locator; the
  recompute is idempotent, so only the work differs).
- **`use_observable_dato` without `use_self_section` falls through to `self`** (PHP
  order). Census 2026-10-30: no live or fixture edge has that shape, so this changes
  nothing today.
- **A closed perform set** instead of calling the ontology-named method.

Live census of `set_dato_external` edges by config (`dedalo_mib_v7`, 2026-10-30): no
config 6 (the legend symbols); `{use_observable_dato, use_self_section: true}` 18;
`{…, use_self_section: false}` 2 (`hierarchy93` ← `rsc387`, `test99963`);
`{use_inverse_relations: true}` 1 (`numisdata965` ← `numisdata11`); `{…: false}` + a
filter 1 (`test199` ← `test188`). Every shape maps to a resolver.

### Reason

The skip dropped declared behaviour silently and without a count. The table is PHP's
own semantics, closed: a shape the engine does not implement is refused by name and
counted, never approximated.

### Gate reconciliation

No fixture re-harvest (write-path target selection; no served byte shape changes).
`observer_reconcile_discovery_native`'s "only the COVERED server shape" case now
expects the `self` edge too.
