# WC-2026-11-10-related-list-cells — component_relation_related list cells expand the declared show.ddo_map children

- **Date:** 2026-11-10.
- **Decision:** none (a client-blank bug fix; the PHP shape was the defect).
- **Shape before (PHP, and TS until this entry):** in LIST mode
  (`src/core/relations/models/relation_related.ts`) the cell emitted, for EVERY stored
  locator, the TARGET section's `component_section_id` item (`getSectionIdComponentTipo`,
  value `[Number(section_id)]`), then the own item with the raw stored locators paged to
  `PORTAL_LIST_LIMIT` (the column ddo's `limit` ignored). The frozen PHP fixture
  `complex_relation_sweep` (numisdata55 list → only `numisdata130` items) holds the same shape.
- **Shape after (TS):** list (incl. the TM history list, which reads in list mode) takes the SAME path as edit — the portal emission
  (`portalResolver.emitDdoItems` → `relation_core.expandPortal`): the own paginated item
  (cell page size = ddo `limit` → effective list-config limit → `PORTAL_LIST_LIMIT`) and,
  per PAGED locator, one item per child of the column's effective `request_config` show
  (+ hide) `ddo_map`. relation_related particularities kept: a non-search own item is
  emitted even when the relation is EMPTY (entries `[]`, `pagination.total` 0,
  `pagination.limit` = ddo `limit` → `PORTAL_LIST_LIMIT` in list / 10 elsewhere — no
  list-config lookup for an empty page) and the
  computed back-references (`references`) attach to it.
- **Stored-id forms:** a legacy STRING `section_id` is canonicalized by expandPortal
  (`canonicalizeStoredSectionId`) and renders like any address. A non-address remote id
  (`'001338683'`, an external-service target) is never `Number()`-ed: it stays verbatim
  in the own item's entries; it renders children only through derived models
  (`component_external`) — a locator whose target has no stored row and no derived
  child gets no child item (same as every portal), never a fake section_id item.
- **Reason:** the client renderer of component_relation_related is component_portal's:
  it builds `columns_map` from the column context's `request_config[0].show.ddo_map` and
  looks for data under those tipos. With only a section_id item the cell rendered BLANK
  (section lists, the Time Machine dd15 history list, nested portal cells, and the RAG
  embedding source that reads relations in list mode). Measured on a production
  install: five related columns blank, one showing the id only; all render values after.
- **Gate reconciliation:** `test/parity/complex_relation_sweep.test.ts` case
  `test6100.test6137` (twin of numisdata55) stays GREEN: its implicit config's children
  are test6204 (the section_id twin of numisdata130) + two relation components that are
  empty at the pinned targets, so the emitted item set equals the frozen one. No fixture
  edit, no re-harvest, no parity_baseline change. TS-native gate:
  `test/unit/relation_related_list_cells_native.test.ts` (list cell child values, own
  item entries + pagination, empty own item, dd15 history cell, string + remote ids).
