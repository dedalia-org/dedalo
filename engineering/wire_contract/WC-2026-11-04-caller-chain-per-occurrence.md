# WC-2026-11-04-caller-chain-per-occurrence — the same element under two parents ships one context per distinct config, keyed by `caller_chain` (owner decision (b))

- **Date:** 2026-11-04 (owner decision (b) of 2026-11-03; landed W3/W5 —
  `src/core/section/node_contexts.ts` `NodeContextSet`, client `section_record.js`
  `select_by_caller_chain`).
- **Decision:** DEC-12. Canon: `engineering/RELATIONS_SPEC.md` §1 addendum *Effective config
  per element (2026-11-04)*.

## Shape before (PHP)

Context dedup is first-wins by `tipo_section_tipo_mode` (`get_subdatum` :2779-2786). When
tch197 → rsc1400 shows `[rsc86, rsc85]` and a second portal P2 → rsc1400 shows `[rsc85]`,
both share `rsc1400_rsc197_list`: P2's cells borrow tch197's columns.

## Shape after (TS)

- Identical node projections (effective config + governing view / parent_grouper /
  properties / lang) still dedupe first-wins: ONE entry, **nothing stamped** — the wire is
  byte-unchanged for every read without a conflict.
- When the same context key occurs under DIFFERENT parents with DIFFERENT configs, each
  distinct config ships its own entry, and the entry AND every data item of that key carry a
  new string field `caller_chain`: the ancestor TIPO path from the read's top level to the
  element's parent, joined by `>` (`''` for a top-level element).

  ```json
  {"tipo":"rsc1400","section_tipo":"rsc197","mode":"list","caller_chain":"tch197", "request_config":[… rsc86, rsc85]}
  {"tipo":"rsc1400","section_tipo":"rsc197","mode":"list","caller_chain":"P2",     "request_config":[… rsc85]}
  ```
- Once a key is split, every parent chain names its own entry (a chain deduped into another
  chain's identical config gets a stamped copy — `NodeContextSet.absorb`). The copy carries
  the absorbing entry's CONFIG but its OWN direct `parent`: on every stamped entry `parent`
  equals the last segment of `caller_chain` (the read's root tipo when the chain is `''`).
  A consumer may match a child by `parent` or by the chain's last segment alike; the
  in-repo client reads the chain (`section_record.js` `belongs_to_parent`).
- Two configs under the SAME chain (a record-dependent `fixed_filter` per row) dedupe
  first-wins exactly as PHP.
- The client resolves a cell's context by `(tipo, section_tipo, mode, caller_chain)` when the
  key is stamped, first-wins otherwise; it never falls back to another parent's entry.
- A flat ddo_map still matches children by PARENT only (PHP `get_children_recursive`): one
  map naming NM under P1 and under P3 gives both occurrences the union of NM's children —
  per-occurrence configs come from distinct configs (own maps, injected maps), not from one
  flat map.

## Reason

Each occurrence must render its own declared columns; first-wins makes one definition
silently override another in the same response.

## Gate reconciliation

- `test/unit/nested_ddo_data_native.test.ts` — *(b) per occurrence*, *(b) identical
  configs … ONE context, nothing stamped*, *(b) fingerprint*, *(b) governing LANG*.
- `test/unit/nested_ddo_map_injection_native.test.ts` — *duplicates (b)* (different maps,
  one slot EMPTY, the flat-map parent-only rule).
- `test/unit/node_context_set.test.ts` (*a split key gives an absorbed chain its own stamped
  copy* — the copy's `parent` agrees with its chain); client `test_nested_portal.js` *per-occurrence
  caller_chain (b)*.
- Parity: the field appears only on a conflicting key; no frozen fixture has one — no drift,
  nothing re-banked. **Re-harvest: none.**
