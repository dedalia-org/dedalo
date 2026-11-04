# WC-2026-11-04-nested-paging-add-show — a nested portal pages with the show its context was injected with (consistent paging, owner decision (a))

- **Date:** 2026-11-04 (nested-ddo_map plan, owner decision (a) of 2026-11-03; landed in
  W4/W5 — `src/core/relations/request_config/from_rqo.ts`, `src/core/relations/caller_chain.ts`,
  client `component_portal.js` `sends_own_show` / `attach_show_maps`).
- **Decision:** DEC-12 (gated below). Canon: `engineering/RELATIONS_SPEC.md` §1 addendum
  *Effective config per element (2026-11-04)*.

## Shape before (PHP)

A nested portal's context is injected by its caller (tch197 → rsc1400 shows
`[rsc86 surname, rsc85 name]`), but its paging get_data is built with `add_show=false`: the
rqo carries NO show, so `build_request_config_from_rqo` does not apply and page 2 resolves
the element's OWN map (`[rsc85, rsc86]`). The client keeps page 1's write-once context, so
page 2's values arrive in another membership/order than the columns that render them —
columns can shift or empty.

## Shape after (TS)

- The client sends the context's `show` (and `search`) **ddo_map** on a nested portal's
  get_data whenever it can name the verified caller chain (`sends_own_show`: action
  `get_data`, mode `edit|list`, not a dataframe, `create_callers` non-null). Only the maps
  travel (`attach_show_maps`, cloned); never `sqo_config`, `choose` or `hide`.
- The request carries `source.callers` (`WC-2026-11-04-rqo-source-callers`). Stage 1
  (`buildRequestConfigFromRqo`) validates and consolidates the show; under a VERIFIED chain
  the element's inherited ddos are its effective config (own + caller-injected), so page 2
  keeps exactly page 1's columns, read level included.
- **Stage-1 merge on a component:** the client show REPLACES the show slot (and the search
  slot, when the client sent one) on the base's FIRST dedalo item; the server's `hide` (a
  hidden dataframe), `choose`, `sqo` and non-dedalo engine items stay the element's
  (`mergeComponentStageOne`, configSource `rqo`) — when the element HAS a dedalo config
  item, the client's sqo never becomes the effective config (a fresh `fixed_filter` stays
  server-side). A base with NO dedalo item (an external-only component, or no base at all)
  has nothing to merge onto and takes stage 1 as is — its sqo is then the client's,
  already through `sanitizeClientSqo` (`WC-2026-11-04-stage1-authorized-sqo-scrub`).
- A target record lacking a value renders an empty component in its column (the column is
  declared by the context, not by the values that came back).

## Reason

A component's definition must resolve the same way on every page. PHP's mismatch is a
heritage-data hazard: a cataloguer sees surname values under a name column on page 2.

## Gate reconciliation

- `test/unit/nested_ddo_data_native.test.ts` — *get_data paging WITHOUT a show (the
  PHP-limit control)* and *get_data paging WITH the show (decision (a))*, *(f) stage 1*.
- `test/unit/subdatum_permission_native.test.ts` — *stage 1 under the verified chain keeps
  the SERVER slots* (hidden dataframe on page 1 and 2, server sqo, non-dedalo item), *page 2
  under the verified chain*.
- `client/dedalo/test/client/js/test_nested_portal.js` — *consistent paging (a) on the suite
  server* (page 1 → page 2 → refresh, empty value keeps its column), *add_show helpers*.
- Parity: no frozen fixture carries a nested paging get_data with a show; nothing re-banked
  (`scripts/parity_baseline.ts --check`: no drift). **Re-harvest: none** (impossible by
  definition, `engineering/ORACLE_HARVEST.md`).
