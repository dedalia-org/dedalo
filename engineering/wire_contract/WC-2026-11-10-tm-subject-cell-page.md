# WC-2026-11-10-tm-subject-cell-page — a Time Machine row's own relation cell pages to 10

- **Date:** 2026-11-10.
- **Decision:** narrows WC-2026-08-14-tm-cells-obey-list-emit-policy for ONE column.
- **Shape before (TS):** every dd15 cell is emitted in LIST mode, so a relation
  (portal-family) column paged to the list cell size — the column's list-config limit,
  else `PORTAL_LIST_LIMIT` (1). A related-terms history row holding 3 terms showed only
  the first, silently (the client list views draw no "more" marker).
- **Shape after (TS):** in `src/core/resolve/read_tm.ts` `emitTmRow`, the cell of the
  row's SUBJECT component (`tipo === row.tipo`) of the portal family (relation column,
  not select family) is emitted with ddo `tm_subject_limit = TM_SUBJECT_CELL_LIMIT` (10),
  read as the cell page in `models/portal.ts` (never the governing `limit`, which would
  reach the node and the column context's `sqo.limit`): the own item carries the first 10 stored locators
  (`pagination.total` = all, `limit` = 10) plus one child item per paged locator. A
  history row is a version of that field; the cap keeps a portal of hundreds of
  locators from expanding every target per row.
- **Unchanged:** every other dd15 column (meta columns Who/Where/…, and non-subject
  columns of a record snapshot) keeps the list policy; still LIST mode, every emit hook
  fires; the column context (`sqo.limit`) is not touched.
- **Fixtures:** none — no frozen fixture covers a multi-locator subject relation cell.
- **Gate:** `test/unit/relation_related_list_cells_native.test.ts` ("the SUBJECT cell
  pages to TM_SUBJECT_CELL_LIMIT without a client limit"); the context half:
  `nested_ddo_data_native` / `nested_ddo_map_injection_native` TM column tests (context
  keeps the list page, the subject cell pages wider).
