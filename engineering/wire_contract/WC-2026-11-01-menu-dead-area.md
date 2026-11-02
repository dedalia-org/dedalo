# WC-2026-11-01-menu-dead-area — the menu does not offer an area model the read refuses (area_graph)

- **Date:** 2026-11-01 (feature crawl: `root:dd630:area:api:request.invalid_model`).
- **Decision:** DEC-15, executing `engineering/AREA_SPEC.md` §1 (area_graph dead by user decision
  2026-07-03; "the menu differential must be re-pinned accordingly if the live menu ever emits it").
  DEC-12 (gate: `test/unit/menu_tree_datalist_native.test.ts` "DEAD AREA").
- **Shape before (PHP, and TS until now):** the menu `tree_datalist` carried the `area_graph` root
  (`{tipo:"dd630", model:"area_graph", parent:"dd1", label:"Grafos"}`) for every viewer holding it.
  Its read answers `request.invalid_model` (`src/core/area/read.ts`: an area model with no behavior
  resolver is refused, never dashboarded), so the entry was a dead link.
- **Shape after (TS):** `getMenuTreeDatalist` drops every item whose model is an area model with no
  behavior (`isAreaModel(model) && areaBehaviorOf(model) === null` — today only `area_graph`) and
  records it in `skipped` (reason `area model '<model>' has no behavior`). The WALK is unchanged:
  `MENU_ROOT_MODEL_ORDER` keeps PHP's root order and the config_areas / menu_skip_tipos catalogs
  (`getAllAreas`) and the security-access datalist still list it.
- **Client:** none (the client renders what the menu lists).
- **Gate reconciliation:** `test/parity/menu_differential.test.ts` drops the `area_graph` node from
  the frozen PHP side before diffing and tolerates its `skipped` record. No fixture change, no
  re-harvest (the gate transforms the frozen body — the WC-001 pattern).
