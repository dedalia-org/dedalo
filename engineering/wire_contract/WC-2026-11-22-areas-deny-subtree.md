# WC-2026-11-22-areas-deny-subtree — a denied area hides itself AND its whole subtree; menu and permissions tree apply ONE filter; guarded areas never hidden; the area root is picked in sibling order

- **Date:** 2026-11-22 (T2 batch B9: T2-O15-1, T2-SC-5b).
- **Decision:** owner ruling Q4 (b), 2026-11-19 — "a denied area hides itself AND its whole
  subtree, at any depth" (menu and permissions tree identical), with an anti-lockout guard on the
  static `AREAS_DENY`. T2-SC-5 (fold the area-root pick into the one sibling order). Code:
  `src/core/concepts/area.ts` (`applyAreasDeny`, `AREAS_DENY_GUARDED_MODELS`),
  `src/core/api/handlers/menu.ts` (`getOntologyAreas`, `collectAreaRows`),
  `src/core/resolve/security_access_datalist.ts` (`getAreas`, `loadOntologySnapshot`,
  `getChildrenOfThis`), `src/core/area_maintenance/widgets/config_areas.ts` (guarded set).
- **Shape before (PHP):** `area::get_areas()` checked the deny when ADDING a node: a denied ROOT
  took its descendants (the walk never started), a denied CHILD only itself — its descendants
  stayed in the area list (unattachable in the menu, grantable in the permissions tree). Roots by
  `ontology_utils::get_ar_tipo_by_model` (`LIMIT 1`, heap order).
- **Shape before (TS):** both walks filtered the denied ROW only, root or child — a denied root's
  whole subtree stayed listed. The static `AREAS_DENY` was never guarded (only the config_areas
  save stripped `area_root` / `area_admin` / `area_maintenance`). Root pick: the menu `rows.find`
  over an UNORDERED read; the permissions tree `LIMIT 1` unordered; siblings ordered by
  `order_number, id` (menu: NULL first; tree: NULL last).
- **Shape after (TS):** ONE function, `applyAreasDeny(rows, deny)`, applied by the menu walk and
  the permissions-tree walk to the same ordered area list: a row is hidden when it, or any walked
  ancestor, is denied — at every depth. A row whose model is guarded (`area_root`, `area_admin`,
  `area_maintenance`) is never hidden, whichever list (static or runtime) names it or its ancestor.
  Both walks pick each root as the FIRST node of its model in THE sibling order
  (`DD_ONTOLOGY_SIBLING_ORDER_SQL`: order_number, NULL last, tipo) and order siblings by it.
  The UNfiltered catalog (`getAllAreas`, config_areas / menu_skip_tipos panels) is unchanged:
  `denied` still marks list membership.
- **Consequence on the shipped default** (`AREAS_DENY=["dd137","rsc1","hierarchy20"]`): the
  sections under dd137 (the private value lists: dd64, dd42, dd90, …, 37 on the suite DB) and
  under rsc1 (rsc2) are no longer in the profile permissions tree. Existing dd774 grants on them
  are untouched (the tree is display; grants live in the profile record).
- **Client:** none — both surfaces render what they are given.
- **Gate reconciliation:** TS-only. `test/unit/menu_tree_datalist_native.test.ts` re-pinned:
  DENY (subtree at depth 4), denied ROOT (both doors), menu ≡ permissions tree, ANTI-LOCKOUT,
  no orphan, ROOT PICK (a second `area_graph` with the lower order_number wins in both walks); the
  former "DENY does NOT re-parent" pin is retired with the rule it pinned.
  `ordered_child_lookup_tripwire`: the `security_access_datalist.ts` pick exemption (SC-5b) is
  deleted with its offender. `menu_differential` / `component_datalist_lifecycle_differential`:
  their banked reds are pre-existing and unchanged — no fixture edit.
