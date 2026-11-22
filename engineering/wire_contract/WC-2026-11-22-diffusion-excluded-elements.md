# WC-2026-11-22-diffusion-excluded-elements — `tool_diffusion`'s `EXCLUDE_DIFFUSION_ELEMENTS` hides an element's panels AND refuses `diffuse` to it

- **Date:** 2026-11-22 (owner ruling R3: port the v6 `EXCLUDE_DIFFUSION_ELEMENTS`, option (a) — a
  `tool_diffusion` config key, filter AND server-door refusal; the v6→v7 config migration moves the
  define into it).
- **Decision:** owner ruling R3 (gated: `test/unit/diffusion_excluded_elements_native.test.ts` —
  zzdif scratch domain, scratch dd996 record, both doors, the alias match, malformed refusal, the
  migration move and its four outcomes). Code: `src/diffusion/api/excluded_elements.ts` (THE list +
  both checks), `src/diffusion/api/info.ts` (`selectPublishablePanelNodes`),
  `src/diffusion/api/actions.ts` (`diffuseAction` → `assertPublishableElement`),
  `src/core/tools/tool_config_move.ts` + `src/config/migration_map.ts` class `TOOL_CONFIG` +
  `scripts/migrate_v6_config.ts` (the move).
- **Shape before (PHP v6):** `tool_diffusion::get_diffusion_info` read `EXCLUDE_DIFFUSION_ELEMENTS`
  from the tool's Tools-configuration record (dd996 → dd999 config object), falling back to the
  define of the same name when the tool config had no non-empty array, and dropped every diffusion
  map item whose (real, alias-resolved) element tipo was listed. A UI filter only: `diffuse` never
  checked the list, so a hand-posted tipo published. A non-array value was silently ignored.
- **Shape before (TS):** the key was read by nothing; `migration_map.ts` dropped the define as
  `NO_CONSUMER`. Every element of the section's domain reached `get_diffusion_info`, and `diffuse`
  published to any of them.
- **Shape after (TS):**
  - **Where the list lives.** ONE place: the `tool_diffusion` tool configuration under v6's own key
    spelling `EXCLUDE_DIFFUSION_ELEMENTS` (install dd996/dd999 over the register default, via
    `getToolConfigValue`; the `{value: [...]}` option form reads as its `.value`). A v6 install
    that set it there keeps it with no data change. There is no env key and no define.
  - **`get_diffusion_info`.** The `section_diffusion_nodes` items (panels) of an excluded element
    are absent from `data` — same shape, fewer entries.
  - **`diffuse`.** An excluded `diffusion_element_tipo` is refused before anything is queued, after
    the SEC-13 permission check: `diffusion.element_excluded` (NEW code, category `permission`,
    HTTP 403, disclosure `public`, not retryable, label `error_diffusion_element_excluded`;
    `coordinates.diffusion_element_tipo` log-only). No job row is written.
  - **Matching.** An element is excluded when its own tipo OR, for a `diffusion_element_alias`, the
    real element it resolves to is listed (v6's match, on real tipos, is kept; listing an alias
    tipo is new — v6 could never match one).
  - **Malformed list.** Anything other than absent/null or an array of non-empty strings refuses
    BOTH actions with `tool.config_invalid` (public message names dd996; see the LOW-7 addendum). v6 ignored it — a
    list written to stop a publication must not become "publish everywhere" through a typo.
  - **Not filtered:** delete propagation / `retry_pending_deletions` (unpublishing records already
    in a target is never blocked), and a job queued before the list changed is not re-checked by
    the runner.
- **Migration.** `dedalo:migrate-config` classifies the define `TOOL_CONFIG` (report section of
  that name, no `.env` line); `--execute` moves a non-empty value into the dd996 record naming
  `tool_diffusion` through the engine's write doors (one transaction, TM-audited): created when no
  record names the tool, written when the record has the key absent/empty, kept when it already
  holds a non-empty value (v6 read the tool config first), refused (`resource.conflict`) when two
  records name the tool.
- **Reason:** the define was a live v6 publication guard that v7 had silently dropped; a hidden
  panel is no refusal to a caller who posts the tipo by hand, so the server door enforces it.
- **Gate reconciliation:** no parity fixture covers an install with the key set (the frozen store
  never exercised it); no fixture change, no re-harvest.

## Addendum 2026-11-22 — review LOW-7: a malformed list is a CONFIG fault

The malformed-list refusal was first shipped as `request.invalid_options` (category `caller`,
HTTP 400) — a fault of the request, which the caller cannot fix. It is now the NEW code
`tool.config_invalid` (category `unavailable`, HTTP 503, disclosure `public`, not retryable,
label `error_tool_config_invalid`): the installation's tool configuration is malformed, the
operator fixes it. The public message is unchanged (it names the key and dd996). Same code for
the v6→v7 move's refusal of a non-object stored config (MED-2 addendum). Gate:
`diffusion_excluded_elements_native` D (read, `get_diffusion_info` and `diffuse` all assert the
code).
