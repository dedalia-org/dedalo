# WC-2026-11-21-resolve-data-injected-value-bound — search-mode `resolve_data` expands every injected locator, echoes the page, and refuses an oversized `source.value`

- **Date:** 2026-11-21 (T2-SL-1).
- **Decision:** T2 triage row SL-1 (needs_code); DEC-12 (gated:
  `test/unit/search_mode_component_read.test.ts` → the two "T2-SL-1" cases).
- **Shape before (TS):** `resolve_data` (a relation component in `search` mode resolving the
  locators the client injects in `source.value` — the filter chips) sliced the injected locators
  by `sqo.limit` (default: the edit page size) with no offset, so only the first page of chips got
  child data (labels); the main item's `pagination` was `{ total, limit, offset: 0 }`.
- **Shape before (PHP):** the full injected value resolved, unpaginated; `sqo.limit` /
  `sqo.offset` only stamped on the element. No size bound.
- **Shape after (TS):** every injected locator resolves its child data; the main item's
  `pagination` is `{ total: <injected count>, limit: <sqo.limit, else the default page size>,
  offset: <sqo.offset, else 0> }` — an echo, never applied. A `source.value` of more than
  `CLIENT_MAX_LOCATOR_PINS` (1000, the same cap as `sqo.filter_by_locators`) locators is refused:
  `request.invalid_source`, 400, nothing resolved.
- **Reason:** a chip without a label is a filter the user cannot read; and since the whole value
  is the work of the request, its size is bounded loudly instead of trimmed to a page that looks
  complete. The bound is the one divergence from PHP.
- **Gate reconciliation:** TS-native only. No frozen fixture replays a `resolve_data` with more
  locators than its page (`resolve_data` differentials unchanged); no re-harvest, no fixture edit.

## Addendum 2026-11-21 — the cost the bound admits (B3 review L1)

- **The bound is a COST bound, stated:** one `resolve_data` request may fully expand up to
  `CLIENT_MAX_LOCATOR_PINS` (1000) injected locators — each one a target record load plus every
  child ddo of the portal's search config emitted for it (no page applies to the injected value),
  so the work and the response grow linearly with the value, times the width of the child map.
  Beyond it the request is refused (`request.invalid_source`), never trimmed.
- **Measured 2026-11-21** (suite DB, root, `dd543` → `dd128`, one display child `dd132`,
  distinct scratch targets, warm): 10 locators 3 ms / 6.7 KB, 100 → 8 ms / 37 KB, 1000 → 88 ms /
  342 KB. Linear, well inside an ordinary list read; no measured case justifies a lower bound, so
  it stays at the shared `filter_by_locators` cap. Lower it only on a measured case (a wide child
  map, a cold cache) that shows otherwise.
