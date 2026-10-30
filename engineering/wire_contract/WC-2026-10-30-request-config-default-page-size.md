# WC-2026-10-30-request-config-default-page-size — a component's edit request_config always carries a page size, as `sqo.limit`

- **Date:** 2026-10-30 (portal paginator missing on config-less portals, e.g. `mht125`).
- **Decision:** DEC-12 (gated: `test/unit/request_config_implicit.test.ts` → "default page size").
- **Shape before (PHP):** every parsed item carried `show.sqo_config {full_count, limit, offset,
  mode, operator}` in every mode (`resolve_show_sqo_config` / v5 `calculate_default_limit`:
  component + edit → 10), and `sqo.limit` mirrored it. TS (until now) emitted neither when the
  config declared no limit — implicit configs and limit-less explicit ones alike.
- **Shape after (TS):** `buildRequestConfigForElement` stamps `sqo.limit =
  DEDALO_MAX_ROWS_PER_PAGE` on each item of a COMPONENT owner in EDIT mode that declares neither
  `sqo.limit` nor `show.sqo_config.limit`. No `show.sqo_config` is synthesized; other modes and
  section owners are unchanged. `expandPortal`'s edit default reads the same setting.
- **Reason:** the client paginator divides by `rqo.sqo.limit` (`component_portal.js` limit sync,
  `paginator.get_limit`); with no limit it computed one page and hid the paginator while the server
  paged the data at 10. `sqo.limit` rather than `show.sqo_config` keeps the autocomplete search size
  (`choose`/`show.sqo_config` → 25) untouched.
- **Gate reconciliation:** none needed — `request_config_differential` / `_presets_differential`
  stay green (no fixture compares an edit component's `sqo.limit`); no re-harvest, no fixture edit.
