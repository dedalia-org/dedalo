# WC-2026-11-04-nested-list-payload-growth — nested elements expand in every mode but 'solved' (the depth/ownConfig gate is gone); related_list relation children expand their own config

- **Date:** 2026-11-04 (nested-ddo_map plan W2, the related_list half W6).
- **Decision:** DEC-12. A CONVERGENCE on PHP; recorded because list / related_list payloads
  grow.

## Shape before (TS)

- Own-config recursion was gated to `depth < 4 && (edit || list && ownConfig)`
  (`relation_core.ts`), and `RELATIONS_SPEC.md` rule 2 called it PHP: a nested portal in a
  LIST cell with no caller children emitted NO values (plan E2).
- relation_index related_list children were always one-level: a related_list portal never
  expanded its own children.

## Shape after (TS) — PHP's

- `get_subdatum` runs in every mode except `solved`, with no depth bound but
  `MAX_DDO_DEPTH` and the record-cycle guard (`WC-2026-11-04-record-cycle-stop`): a nested
  element with no caller children falls back to its OWN config in edit, list and tm alike.
  List payloads grow by the nested values PHP always emitted.
- relation_index related_list (no request_config strategy,
  `component_relation_index_json.php` :190-206 — the pointing section built in
  `related_list` mode): a RELATION child with an EXPLICIT request_config expands its own
  show map, resolved in `related_list` mode (own properties, no `section_list` swap — PHP
  `resolve_source_properties` swaps for list / list_thesaurus / tm only); a config-less (v5)
  relation child resolves no children (`resolve_ar_related_related_list` → [] for a
  non-section) and a literal keeps the pinned one-level `list` cell. The expanded
  grandchildren carry PHP's stamps: built by the child portal's own `get_subdatum`, their
  `from_component_tipo` is that PORTAL (`class.common.php` :2683-2686, echoed by
  `get_data_item` :3665) and their mode its children's `list` (`resolve_ddo_mode`, a
  non-section caller); only the direct related_list cell is stamped `related_list` /
  `from_component_tipo` = its own tipo, while `parent` and the row stamps (`row_section_id`,
  `parent_tipo`, :2789-2794) reach every item.

## Gate reconciliation

`test/unit/nested_ddo_data_native.test.ts` *(b) OWN-CONFIG FALLBACK IN LIST MODE*, *(n)*;
`test/unit/nested_ddo_map_injection_native.test.ts` *shape* (5 hops) and *relation_index
related_list* (section and get_data doors, the grandchild stamps included). Parity: `scripts/parity_baseline.ts --check` —
no drift after the change (the frozen relation_index fixtures carry no explicit-config
related_list portal; their list reads already matched PHP); nothing re-banked.
**Re-harvest: none.**
