# WC-2026-10-28-menu-orphans — a menu entry whose parent area the viewer lacks is re-parented or dropped, never left unreachable

- **Date:** 2026-10-28 (feature crawl #13).
- **Decision:** DEC-15 (divergence from PHP, decided by the maintainer 2026-10-28). DEC-12 (gate:
  `test/unit/menu_nonadmin.test.ts` "no entry is left under a parent the viewer cannot see").
- **Shape before (TS = PHP):** the filtered menu (`getMenuTreeDatalist` for a non-admin+developer
  viewer) dropped every area the viewer is not granted but kept its granted children with their
  original `parent`. The client builds the tree from the roots down, so such a child never rendered:
  a grant with no menu entry (crawl: `ontology40` under `dd5` for an editor).
- **Shape after (TS):** after the filter, an item whose parent is not in the viewer's tree is
  - **dropped** (listed in `skipped`, reason `under a role-gated area the viewer lacks`) when its
    ancestor chain crosses a hidden ROLE-gated area — `dd5` ontology, `dd770` development, `dd88`
    maintenance: what those areas hold stays hidden with them;
  - otherwise **re-parented** to its nearest visible ancestor, or the menu root (a parent that is no
    area at all, e.g. `dd1`, is kept as it is — the client treats it as the top level).
  The superuser / admin+developer tree is unchanged (nothing is filtered, so nothing is orphaned).
- **Suite fixture:** the hand-authored `test1` (Test area) moved from `dd770` to Catalogue `dd242`,
  where an installation's project areas live (e.g. `numisdata1` under `dd322` under `dd242`); under
  `dd770` the rule above would hide the whole test TLD from every non-developer persona.
- **Client:** none.
- **Gate reconciliation:** TS-only.
