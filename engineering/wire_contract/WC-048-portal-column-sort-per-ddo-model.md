# WC-048 — Portal column sort: PER-DDO model (`sort_by_column` + `order` on the ddo, top-level property RETIRED) (2026-07-23)

Portal column-sort is a **v7-native feature with no PHP oracle**; PHP is now
reference-only, so TS takes its own shape. The sort directives are declared **on
the column ddo** — a `properties.source.request_config[].show.ddo_map` entry —
NOT on top-level component properties. The PHP-inherited `properties.sort_by_column`
(`true` | allowlist array) and the earlier interim `properties.order_by` are
**both retired**; nothing in the corpus used either (`dd_ontology` scan: 0 hits).
Two independent per-ddo keys:

```jsonc
"show": { "ddo_map": [
  { "tipo": "rsc85", "sort_by_column": true, "order": "asc" },
  { "tipo": "rsc86", "sort_by_column": true, "order": "asc" }
] }
```

- **`sort_by_column: true`** (WRITE, user-triggered) — the column may be
  persistently re-ordered by a header click (Time Machine data change). Gate
  moved from the top-level property to the column ddo: `applySortByColumn`
  (`save.ts`) requires the resolved column ddo's `sort_by_column === true`; the
  client `ui.allow_column_order` reads the per-column `column.sort_by_column`
  (stamped by `get_columns_map` from the ddo). The old `true | [tipos]` allowlist
  is gone — an allowlist of column tipos was just a per-ddo flag in disguise.
- **`order: "asc"|"desc"`** (READ, declared default; `true` = asc) — the portal
  is ordered by the column(s) carrying `order` EVERY read, FOR DISPLAY, without
  touching the stored array. Applied in `expandPortal` (`relation_core.ts`)
  between reading the stored locators and paginating (page 1 = top-ranked);
  priority = ddo_map declaration order; unresolvable targets fall to the END.

Both share ONE ranking engine `rankLocatorsByColumns`
(`src/core/relations/order_locators.ts`): a target-section search over the
linked `section_id`s ordered on the column(s), then a rank-map re-order.

- **Wire carrier.** The per-ddo keys ride the parsed request_config PASSTHROUGH
  (`request_config/explicit.ts` spreads `...rawDdo`; `parseBlock` spreads
  `...block`) to the server read/save paths AND to the client — no `ddoSchema`
  change (that schema is the INBOUND client-RQO strip only; the outbound
  server-built config never re-parses through it).
- **Fixture impact: NONE.** Opt-in; no corpus record carries either key, so the
  frozen read-path store replays byte-identical.
- **Two latent-bug fixes in the shared engine** (both were masked because the
  pre-existing `sort_by_column` had no DB happy-path gate and never actually
  reordered):
  1. `limit: 0` renders as a literal `LIMIT 0` (zero rows); only
     `limit: 'all'`/null is unbounded → the rank search returned nothing.
  2. The ranking SCOPE was resolved from the column ddo's `section_tipo: 'self'`
     mapped to the CALLER section — but a portal column's 'self' is its TARGET
     section (where the linked records live). Searching the caller table matched
     no ids → empty rank → stable no-op. Fixed: the target section is derived
     from the LOCATORS being sorted (`locatorTargetSections`), so both
     `sort_by_column` and `order` rank over the correct table. Verified in the
     browser (tch551 → tch10) — `section_id` DESC reorders `[1,2]→[2,1]`.
  3. The order path was a naive single-step `[{target, column}]` — correct for
     literals/dates, but a RELATION column (checkbox/autocomplete/portal) stores
     a LOCATOR with no `.value`, so the assembler's `.value`-by-lang extraction
     ranked everything NULL (tie → no-op). Fixed: each order column resolves
     through `buildOrderPath` (`buildOrderEntries`), which emits the per-model
     JOIN chain to the linked sortable leaf. Verified in the browser (tch191
     checkbox: ASC `[2,1]` vs DESC `[1,2]`).
  No parity fixture pins `sort_by_column` output.

  Separately, this required fixing `component_date` SAVE to stamp
  `start.time` (PHP `component_date::save → add_time`, ported as
  `addTimeToDateItem` and wired into `save_component.ts`) — the generic write
  path had no per-model date hook, so v7-entered dates lacked the sort/search
  key entirely (`file_date.ts`/`media_file_date.test.ts`).

### Gate

`test/unit/portal_order_by_columns_native.test.ts` — `normalizeDirection`,
`buildPortalOrderSpecs` (per-ddo `order`, self→section, skip-un-ordered column,
declaration-order priority, invalid→null), `hasDeclaredColumnOrder` (cheap raw
gate) + DB-backed end-to-end (`rankLocatorsByColumns` re-orders real test3
locators by `section_id`, unresolved last; the `limit: 'all'` fix is what makes
the rows non-empty). Save gate: `test/unit/portal_edit_writes_native.test.ts`
(`sort_by_column` refuses when the column ddo does not opt in).

## Addendum 2026-10-31 — declared `order` becomes WRITE-time; `sort_by_column` refused on a declared-order portal; the header click becomes a temporary `view_order`

Superseded in part by `WC-2026-10-31-portal-order-model` (portal order model, owner ruling):

- **`order`** is no longer a read-time display order. The record-write chokepoint
  (`record_write.ts` `applyKeySaveRules`) stores every declared-order key SORTED, on every door,
  through the same ranking engine (`order_locators.ts`). The read-time sort in `expandPortal`
  is REMOVED: the stored array is served as stored; an array stored before its order was
  declared is the `portal_declared_order` reconcile's to sort.
- **`sort_by_column`** keeps its per-ddo gate, but on a portal that ALSO declares `order` (on a
  column of its resolved edit config — the ONE declared-order predicate the context and the
  chokepoint share, WC-2026-10-31-portal-order-model item 8) the persisted action is refused
  (`request.invalid_data`, reason `declared_order`), as is `sort_data`: the chokepoint would
  re-sort on the same write.
- The header click on a `sort_by_column` column is a TEMPORARY read (`sqo.view_order`, ordered
  before paginating, never written; allowed on a declared-order portal; refused for a column
  the request principal may not read — the column itself or, for a relation column, any hop of
  its order path down to the sortable leaf — whatever the record holds); its "save current
  order" is the existing `sort_by_column` action. SERVER half only: the shipped client still
  persists the header click (so on a declared-order portal it answers the refusal above) and
  sends no `view_order` yet; the client gating is stage O2, in the same release — WC-2026-10-31-portal-order-model, *Client status* (OPEN).
- The declared-order predicate is asked by the DATA tipo: a `component_alias` answers as its
  target (WC-020); an `order` in an alias's own `source` override is ignored and named by the
  reconcile (WC-2026-10-31-portal-order-model item 8).
- Under a read order, `paginated_key` is the locator's STORED index.
- Context gains `declared_order` (`[{tipo, direction}]`) on a declared-order component.

Gate: `test/unit/portal_order_native.test.ts`.
