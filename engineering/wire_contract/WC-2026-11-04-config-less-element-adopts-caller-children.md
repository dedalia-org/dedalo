# WC-2026-11-04-config-less-element-adopts-caller-children — an element with no config of its own takes its caller's dedalo children as its config (PHP-equivalent shape)

- **Date:** 2026-11-04 (nested-ddo_map plan W2; `src/core/relations/element_node.ts`
  `resolveElement`, configSource `'caller'`).
- **Decision:** DEC-12. A CONVERGENCE on PHP, recorded because the context shape of such an
  element changed.

## Shape before (PHP)

`get_subdatum` injects the caller's children into whatever `build_request_config` returned;
for an element whose own build yields no config item, the caller's DEDALO children are what
stands as its config. (TS before: such an element emitted its own empty / implicit config in
the context while its data used the caller's map — data and context disagreed.)

## Shape after (TS)

The node's effective config is ONE dedalo item carrying the caller's collected slots
(`show` / `search` / `choose` / `hide`), and both the data and the context are projected
from it. Only the dedalo engine: a caller's non-dedalo children have nothing to land on,
exactly as PHP. An element that HAS a config but lacks one of the caller's engines is
skipped for that engine (unchanged, no throw).

## Gate reconciliation

`test/unit/element_node_registry.test.ts` (*an element with no own config takes its caller
children*, *only the caller's DEDALO children*); `test/unit/nested_ddo_map_injection_native.test.ts`
*engines*. Parity: no drift. **Re-harvest: none.**
