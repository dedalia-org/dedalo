# WC-2026-11-22-start-area-page-door — `start` asks the area read's own door: an area page the next read would refuse is refused at `start`

- **Date:** 2026-11-22 (T2 batch B9 fix stage; review finding L3 on T2-O15-2).
- **Decision:** one door for an area page, beyond its grant — `canOpenAreaPage(principal, tipo,
  model)` in `src/core/security/permissions.ts`: `area_ontology` (or dd5) →
  `canAccessOntologyArea` (WC-2026-10-07-ontology-area-admin-grant); a maintenance-behaviour area
  → `canAccessMaintenanceArea` (WC-2026-11-22-maintenance-access-predicate); anything else → open
  (the grant decides). Asked by `src/core/area/read.ts` (`dispatchAreaRead`, before any tree or
  widget work) and by `src/core/api/handlers/dd_core_api.ts` (`start`: the deep-linked page and
  the dd1603 landing, `pageDoorOpen`).
- **Shape before (TS):** `start` special-cased only dd88; for dd5 it asked the grant alone
  (`getPermissions >= 1`). A user granted dd5 without the global-admin role — a developer, or no
  role — got a dd5 page from `start ?tipo=dd5` (or a dd1603 landing on dd5), and the next area
  read answered `perm.denied`.
- **Shape after (TS):** `start ?tipo=dd5` for that user answers `perm.denied` (403, the
  environment rides the refusal as for any refused page, WC-2026-08-12-authorization-denial-token);
  a dd1603 default naming dd5 is no landing (the fall-back applies, the login is not blocked).
  The superuser and a global admin granted dd5 are unchanged. The area read's refusal is
  unchanged (same rule, now the shared function; the maintenance check moved before the branch
  dispatch, same outcome).
- **Client:** none — a refused `start` renders the standard no-access page.
- **Gate reconciliation:** TS-only. `test/unit/maintenance_access_agreement_native.test.ts`
  describe *start agrees with the area read on a door-ruled area page (dd5)* — the superuser +
  six personas (`test/helpers/maintenance_persona_fixture.ts`; profile 954011 also grants dd5):
  `start` and the area read answer the same, and equal the ontology rule. No fixture edit.
