# WC-2026-11-04-governing-limit-sqo-limit-only — a parent ddo's `limit` lands on the nested element's `sqo.limit` only, never on a synthesised `show.sqo_config`

- **Date:** 2026-11-04 (nested-ddo_map plan, plan E5; W7 review). Code:
  `src/core/relations/element_node.ts` (`withGoverningLimit`, module header step 4),
  `src/core/relations/request_config/explicit.ts` (the own-`sqo.limit` `show.sqo_config`
  synthesis).
- **Decision:** DEC-12 (gated below). Canon: `engineering/RELATIONS_SPEC.md` §1 addendum
  *Effective config per element (2026-11-04)*.

## Shape before (PHP)

The governing ddo's `limit` (the parent's ddo_map line for this element, `:2592-2596`)
becomes the child INSTANCE's `pagination->limit`. Two places read it:

- `resolve_pagination_override` (`trait.request_config_utils.php:597-598`) writes it to
  `$parsed_item->sqo->limit`.
- `resolve_pagination_defaults` (`trait.request_config_utils.php:336-348`) takes
  `$this->pagination->limit` FIRST, and `resolve_show_sqo_config`
  (`trait.request_config_v6.php:425-430`) builds `show.sqo_config` from it via
  `build_sqo_config_default` whenever the config declares no `show.sqo_config`.

So for a config with no declared `show.sqo_config`, PHP ships the GOVERNING limit on both
`sqo.limit` and the synthesised `show.sqo_config.limit`. A DECLARED `show.sqo_config.limit`
is left as declared (`:415-418`). Plan E5: governing `limit: 1`, own `sqo.limit: 10`, no
declared `sqo_config` → PHP `sqo.limit 1`, `show.sqo_config.limit 1`.

## Shape after (TS)

- `withGoverningLimit` writes the governing limit to `sqo.limit` ONLY.
- `show.sqo_config` is synthesised only for a config with its OWN `sqo.limit` (explicit.ts,
  PHP's emitted shape) and carries that OWN value; a config without its own `sqo.limit`
  gets no synthesised `show.sqo_config` at all (the general rule,
  `WC-2026-10-30-request-config-default-page-size`).
- Plan E5 in TS: `sqo.limit 1`, `show.sqo_config.limit 10`. A config declaring no
  `sqo.limit`: `sqo.limit` = governing, no `show.sqo_config` (PHP ships the governing value
  there).

## Reason

Harmless to every consumer, and the node keeps one page size: the data page reads the
governing limit first (`nodeListPageLimit`), and the client paginator reads
`request_config_item.sqo.limit` BEFORE `show.sqo_config.limit` (`component_portal.js`
limit sync, "Two possible locations for the limit"), so both pages and paginator follow the
governing limit. A nested element is always a component (a ddo_map child), never a section,
so section.js's `show.sqo_config.limit` read is not on this path. Synthesising the governing
value into `show.sqo_config` would need the builder to tell a declared block from its own
synthesised one, and would widen the general `show.sqo_config` emission that
`WC-2026-10-30-request-config-default-page-size` deliberately keeps off.

## Gate reconciliation

- `test/unit/nested_ddo_data_native.test.ts` — *(c') node: the governing limit lands on
  sqo.limit only; the own synthesised sqo_config stays*: NH (own `sqo.limit 3`, no declared `sqo_config`) under a governing
  `limit: 2` → `sqo.limit 2`, synthesised `show.sqo_config.limit 3`, list page 2 (PHP would
  ship `show.sqo_config.limit 2`).
- `test/unit/element_node_registry.test.ts` — *the governing limit lands on sqo.limit
  (only) and is the list page*: no own limit → no `show.sqo_config` synthesised.
- Parity: no frozen fixture carries a governed nested element's request_config; nothing
  re-banked (`scripts/parity_baseline.ts --check`: no drift). **Re-harvest: none**
  (impossible by definition, `engineering/ORACLE_HARVEST.md`).
