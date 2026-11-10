# WC-2026-11-09-implicit-children-frontier-predicate — implicit relation children answer the frontier's component key

- **Date:** 2026-11-09 (T0-1; closes the `implicit.ts` entry of the open-frontier-door census in
  `test/unit/frontier_class_native.test.ts`).
- **Decision:** DEC-12 (gated: `test/unit/export_leaf_label_grant_native.test.ts`, the
  `component_filter` widget case).
- **Shape before (TS):** `request_config/implicit.ts filterAuthorizedRelated` asked the bare
  `getPermissions >= 1` per implicit child — the same predicate as the frontier's component key
  but WITHOUT its exemptions (globally visible tables, the `dd153` projects section). A non-admin's
  `component_filter` widget showed no project name (`dd156` dropped).
- **Shape after (TS):** it answers through `frontierAllowedComponents` (surface `door`,
  door `request_config.implicit`, no notice): one predicate for read-config and export. A
  non-admin's `component_filter` lists `dd156`.
- **Reason:** one predicate answered twice drifts; the stricter copy hid a label every user who
  may set a project needs to read.
- **Gate reconciliation:** TS-only; no fixture replays a non-admin implicit config. No re-harvest.
