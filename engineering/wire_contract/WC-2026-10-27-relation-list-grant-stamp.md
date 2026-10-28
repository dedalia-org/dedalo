# WC-2026-10-27-relation-list-grant-stamp — principal-gated `config.relation_list_tipo`; `count` mode 'related' runs Gate A

- **Date:** 2026-10-27 (owner report: a profile granting a section but not its `relation_list` node
  — numisdata267/numisdata296, material1/hierarchy97 — saw the inspector Relations block, and
  opening it was refused `perm.denied` while its count was served). Successor addendum to
  `WC-2026-10-22-tm-scope-whole-request` (which defines `config` = `{relation_list_tipo,
  time_machine_list}`).
- **Decision:** DEC-12 (gated: `test/unit/relation_list_inspector_access_native.test.ts`, client
  `test_inspector_relation_list_access`). Human decision #2 (2026-10-27): the per-section
  `relation_list` node grant stays.
- **Shape before (TS):** section context `config.relation_list_tipo` = the section's relation_list
  node for every caller (`sectionRelationListTipo`, no principal). `read` `get_relation_list`
  asked Gate A (`getRecordComponentPermission(principal, section, node)`) → `403 perm.denied`
  without the node grant; `count` with `sqo.mode:'related'` asked only the host-section gate →
  `200 {total}` for the same caller.
- **Shape after (TS):** `config.relation_list_tipo` is the node tipo iff
  `getPermissions(principal, section_tipo, node) >= 1` (keyed on the possibly virtual section tipo,
  the pair Gate A asks), else `null`; no principal → `null`. Stamped per call, per principal (the
  node lookup stays cached; the grant check never is). `count` mode 'related' runs Gate A on its
  `source` before the host gate — the same decision as `read` for the same source. The node grant
  gates the PANEL (its offer + its own requests, `source.tipo` = the node), NOT the data: the
  delete dialog's references panel (`source.tipo` = the section; 806 of 885 sections have no
  relation_list node at all) is served on host-section read, rows scoped by `rowScopeFor`
  (AUTHZ-05) exactly as before — refusing it would break the delete warning for every caller.
- **Client:** a null `relation_list_tipo` already meant no Relations block and no graph inverse
  request. A refused/failed read now paints the quiet `.inspector_block_failure` line
  (`relation_list.build()` → `false`, `build_error` set, `total` 0) instead of an empty panel under
  a count — on first open and on a page turn (inspector and the delete dialog's panel both route a
  `false` build to their failure path).
- **Reason:** the trigger must not be offered to a principal the read refuses; count and read must
  not disagree.
- **Gate reconciliation:** TS-only. `section_context_extras_differential` runs its TS read as the
  superuser (the fixtures' principal) and `start_differential` as root: the stamped value is
  unchanged for them — no fixture edit, no re-harvest.
