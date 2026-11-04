# WC-2026-11-04-ddinfo-gates-kept — the ddinfo breadcrumb keeps its TS gates; only its trigger moved to the governing children (owner decision (g))

- **Date:** 2026-11-04 (owner decision (g) of 2026-11-03; landed W4 —
  `src/core/relations/relation_core.ts` `expandPortal` ddinfo block,
  `portalCellEmitsDdinfo`).
- **Decision:** DEC-12.

## Shape before (PHP)

`get_subdatum` emits a `dd_info` (ancestor breadcrumb) item per child ddo declaring
`value_with_parents`, for any relation model, in every mode.

## Shape after (TS)

- The TS gates stay: ddinfo is emitted ONLY for a `component_autocomplete_hi` cell and never
  on a Time Machine read (the TM record-snapshot list renders the flat term subdatum —
  oracle-verified; `WC-2026-08-14-tm-ddo-mode-retired`).
- Inside those gates the TRIGGER is the GOVERNING children — the node's effective config,
  whoever supplied it (own or caller-injected): a child ddo with `value_with_parents: true`
  compatible with the target section. Before, only the element's OWN config could trigger
  it, so a caller-declared `value_with_parents` child was ignored.
- The thesaurus-TABLE branch (a target in a thesaurus table qualifies without a vwp ddo)
  applies only when the children are the element's own, uninjected config — it is not
  widened to caller-supplied children.

## Reason

The gates encode where the client renders the breadcrumb (the hierarchy widget); widening
to every relation model would emit items no client view consumes. The trigger follows the
effective config so data and context agree.

## Gate reconciliation

`test/unit/subdatum_permission_native.test.ts` *(g) ddinfo* (inside / outside the model
gate, caller vwp vs own); `test/unit/nested_ddo_data_native.test.ts` *(k)*, *(n)*. Parity:
the frozen autocomplete_hi fixtures are own-config reads — unchanged, no drift.
**Re-harvest: none.**
