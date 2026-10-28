# WC-2026-10-28-menu-role-areas-need-grant — dd88 / dd770 menu entries need the area grant, not only the role

- **Date:** 2026-10-28 (feature crawl problem #5: the non-root global admin's menu offered the
  maintenance area dd88, and opening it answered `perm.denied` — `getPermissions` reads the matrix
  for a global admin, and that profile grants nothing on dd88).
- **Decision:** DEC-12 (gated: `test/unit/menu_nonadmin.test.ts` "the role areas need the GRANT too").
  PHP parity restored (`class.menu.php` `get_tree_datalist`: the role check `continue`s past a
  non-qualifying viewer, then EVERY area goes through the same `ar_permissions_areas` lookup).
- **Shape before (TS):** filtered menu (any viewer that is not admin AND developer): dd88 present iff
  `isGlobalAdmin || isDeveloper`; dd770 present iff `isDeveloper` — no grant consulted.
- **Shape after (TS):** dd88 present iff (`isGlobalAdmin || isDeveloper`) AND the viewer's dd774
  table self-authorizes dd88; dd770 iff `isDeveloper` AND self-authorized. The admin+developer
  (unfiltered) path and the superuser tree are unchanged. Menu and `start`/`getPermissions` now
  agree: an entry the menu offers opens.
- **Client:** none — the entry is simply absent for a role holder without the grant.
- **Reason:** a menu must never offer what the page door refuses; the role is a precondition, never
  a grant.
- **Gate reconciliation:** TS-only. `menu_differential` replays the superuser/fixture viewer; its
  two banked reds are pre-existing and unchanged — no fixture edit.
