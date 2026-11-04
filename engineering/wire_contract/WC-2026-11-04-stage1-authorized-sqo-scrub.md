# WC-2026-11-04-stage1-authorized-sqo-scrub — stage 1 (`build_request_config_from_rqo`) judges client ddos by grant and scrubs the client sqo

- **Date:** 2026-11-04 (nested-ddo_map plan W1/W4; `src/core/relations/request_config/from_rqo.ts`
  `buildRequestConfigFromRqo`, used at every door: `readComponentData`, the get_data context
  main entry, the section door).
- **Decision:** DEC-12. Stricter than PHP (security floor).

## Shape before (PHP)

`build_request_config_from_rqo` (:3056-3131) builds `{dedalo, main, show, search?, sqo}` from
the client's show/search, validated (`validate_requested_ddo`: tipo, model, active TLD) and
consolidated (`consolidate_requested_ddo`: direct-child `self`, label, mode). It CLONES the
client `sqo`, drops every `section_tipo` entry that is not a string or not a valid tipo
(`add_request_config_warning('drop', 'Removed client sqo section_tipo: invalid tipo')`) and
rebuilds `section_tipo` as ddo objects (`build_sqo_section_tipo_ddo`); every OTHER key
(`limit`, `offset`, `filter`, server-only keys) is copied unclamped. `check_ddo_permissions` (STEP 11) drops ungranted ddos only for a
SECTION caller (`get_called_class() === 'section'`) and judges only the FIRST section a ddo
names (`reset()`); a COMPONENT element's client ddos are never judged.

## Shape after (TS)

PHP's validation and consolidation, exactly, plus:

- **Only `ddo_map`** is copied from `show` / `search` — never the client's `sqo_config` (its
  `limit` would escape `CLIENT_MAX_LIMIT`), never `choose` / `hide`.
- **The client `sqo`** goes through THE client SQO gate `sanitizeClientSqo` (server-only key
  strip, depth / node ceilings, locator-pin cap, `parsed=false`, limit / offset clamps) — the
  divergence; its `section_tipo` validation and ddo enrichment are PHP's, unchanged. A `limit` / `offset` the client did not send
  stays absent. On a COMPONENT whose base has a dedalo config item the client sqo never
  becomes the effective config (the server's own sqo stands — the client replaces show, and
  search when sent); a base with no dedalo item takes stage 1 as is, sanitized sqo included
  (`WC-2026-11-04-nested-paging-add-show`).
- **`ddoIsAuthorized` on every ddo**: SECTION element — EVERY declared section judged, a list
  narrowed to the readable ones, the ddo dropped when none is left. COMPONENT element — a
  client ddo matching the element's EFFECTIVE config (own + caller-injected under a verified
  chain) inherits the decision-(d) read raise; ANY OTHER client ddo is judged like a section
  element's (the dd200 → dd128 hole: a client-invented chain is never raised to read).
- Direct children of a component are bound to its targets (sections intersected, a
  dataframe bound to the owner section as a scalar); a client source-array `section_tipo`
  is limited to the client grammar (`hierarchy_types` / `field_value` / unknown sources
  dropped); level ≥ 2 `'self'` refused (`WC-2026-11-04-ddo-self-first-level-only`).
- Dropped / clamped ddos are reported in ONE bounded, escaped log line per map.

## Reason

The stage-1 item can become an element's paging config and its columns are served to the
caller: a client-asserted map or sqo must never widen what the actor can read or how much.

## Gate reconciliation

`test/unit/request_config_from_rqo.test.ts` (the semantics table: gate, PHP show gate,
only-ddo_map, consolidation, the four `self` spellings, invalid / inactive-TLD drops, the
email-shaped show, STEP 11 on every section, inheritance vs invention, target binding,
dataframe binding, the sqo scrub); `test/unit/nested_ddo_data_native.test.ts` *(f)*, *W3
adversarial round*. Parity: the frozen store's stage-1 requests are root reads with valid
maps and no sqo extras — no drift. **Re-harvest: none.**
