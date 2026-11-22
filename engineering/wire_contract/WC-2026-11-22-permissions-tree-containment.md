# WC-2026-11-22-permissions-tree-containment — the permissions tree and the section grant walk a section under the containment law

- **Date:** 2026-11-22 (T2 batch B9: T2-SL-3b).
- **Decision:** owner ruling SL-3a (b), 2026-11-21 — the box-elements containment law EVERYWHERE,
  as v6 (WC-2026-11-22-section-containment-law). Code:
  `src/core/resolve/security_access_datalist.ts` (`getArRecursiveChildren`,
  `getChildrenRecursiveSecurityAccess`), using the law's predicate
  `isOutsideSectionContainment` (`src/core/ontology/resolver.ts`).
- **Shape before (TS):** the ACL tree's element walk excluded `component_semantic_node` and a
  misspelled `box_elements` (the runtime model is `box elements`): a box — or a stored legacy
  `dataframe` / `component_relation_struct` — under a grouper was walked and its components
  offered for granting; an `area_*` child was walked; a nested section was ENTERED. The grant
  expansion (`getGrantChildrenTipos`, what a section grant writes) excluded `box elements`,
  `area` (exact) and `component_semantic_node`, and entered a nested section too.
- **Shape after (TS):** both walks skip every node the law puts outside a section (box elements
  and the stored models that read as it, `component_semantic_node`, `area` / `area_*`) with its
  subtree, and list a nested section without entering it. The grant expansion's set equals the
  resolver's own section walk (`getRecursiveChildrenTipos`) filtered by the grant models.
- **Client:** none.
- **Gate reconciliation:** TS-only. `test/unit/security_access_containment_native.test.ts` (new,
  scratch TLD `zzsacl`).
