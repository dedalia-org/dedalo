# WC-2026-11-22-maintenance-access-predicate — ONE rule opens the maintenance area (dd88): the superuser always; a global admin or developer whose profile grants dd88 at level 2

- **Date:** 2026-11-22 (T2 batch B9: T2-O15-2).
- **Decision:** owner ruling Q5, 2026-11-19 — "root ALWAYS; plus global admins AND developers,
  each with dd88 level 2". Code: `src/core/security/permissions.ts`
  (`canAccessMaintenanceArea`, `MAINTENANCE_AREA_GRANT_LEVEL`), asked by
  `src/core/api/handlers/menu.ts` (the dd88 entry), `src/core/area/read.ts` (the maintenance
  read), `src/core/api/handlers/dd_core_api.ts` (`start`: the dd88 page and the no-tipo landing,
  `pageDoorOpen`), `src/core/area_maintenance/widgets/registry.ts` (`requireMaintenanceAccess`:
  `widget_request`, `get_widget_value`, `parse_simple_schema_changes_files`) and
  `src/core/area_maintenance/widgets/lock_components.ts` (`lock_components_actions`).
- **Shape before (PHP):** the menu showed dd88 to a global admin OR developer
  (`class.menu.php:147-150`); `security.php:259-265` the same role pair; the API needed dd88 in
  the user's authorized areas.
- **Shape before (TS):** four doors, three answers. The menu offered dd88 to a global admin OR a
  developer holding a dd88 grant (the unfiltered admin+developer path to every admin+developer);
  the area read and every maintenance dispatcher asked "global admin" alone and never the grant;
  `start ?tipo=dd88` asked only the grant. A developer saw an entry whose read refused; an admin
  with no dd88 grant opened a panel the menu had not offered.
- **Shape after (TS):** every door asks `canAccessMaintenanceArea(principal)`: the superuser
  (`-1`) always; otherwise the principal must be a global admin OR a developer AND its profile
  must grant dd88 at level >= 2. The role is a precondition, never a grant; the grant alone is no
  role. Refusal: the menu omits dd88; the read, `start` and the dispatchers answer `perm.denied`
  (403, message names nothing); a dd1603 "Default section" naming dd88 for a principal the rule
  refuses is no landing (the fall-back applies, the login is not blocked). Inside the area a
  panel may ask MORE (root-only and destructive doors, `core/update/door_class.ts`) — never less.
- **Consequences:** a global admin without a dd88 level-2 grant loses the maintenance area; a
  developer (not admin) WITH it gains it, including every panel whose own door is the area rule
  alone (e.g. the `reversible_admin` class, the legacy-password conversion).
- **Client:** none — the menu omits the entry; a refused read renders the standard no-access page.
- **Gate reconciliation:** TS-only. `test/unit/maintenance_access_agreement_native.test.ts` —
  the superuser + six personas (`test/helpers/maintenance_persona_fixture.ts`: admin / developer
  / neither × dd88 2 / 1 / none), each asked at every door (predicate, menu, start, landing, area
  read, the four dispatchers): all doors equal the rule. Re-pinned to a rule-passing admin:
  `lock_components_actions_native`, `update_door_precondition_class_tripwire`,
  `update_preconditions`. `widgets_differential` / `widget_request_differential` replay as the
  superuser — unchanged, no fixture edit.
