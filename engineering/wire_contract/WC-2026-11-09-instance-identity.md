# WC-2026-11-09-instance-identity — `dedalo_instance_color` + `dedalo_entity_label` page_globals keys (TS-only)

- **Date:** 2026-11-09.
- **Shape:** `buildPageGlobals` (`src/core/resolve/environment.ts`) emits two new
  keys: `dedalo_instance_color` (`#rrggbb` from `config.identity.instanceColor` —
  `DEDALO_INSTANCE_COLOR` via `src/config/instance_color.ts` — or `null` when the
  key is unset or invalid: the feature is OPT-IN) and `dedalo_entity_label`
  (`DEDALO_ENTITY_LABEL`). PHP `get_page_globals` has NO twin. Emitted
  UNCONDITIONALLY like WC-031 `is_ontology_server`, so the login form is marked
  too; the label is already public pre-auth (`login_context.ts`), the colour
  reveals nothing.
- **Validation:** a malformed `DEDALO_INSTANCE_COLOR` is logged at boot and
  resolves to `null` (feature off) — never passed through, because the value is
  painted into page CSS and an SVG favicon. Gates: `test/unit/instance_color.test.ts` (resolver), `test/unit/instance_identity_served_native.test.ts` (keys served pre-auth with the configured values).
- **Client effect:** only when the colour is non-null, `page.js` sets `--instance_color` + `body.has_instance_color`,
  swaps the favicon for an inline SVG (colour + two letters of the label) and
  prefixes the tab title with `[label]`; `page/css/layout/instance_identity.less`
  tints the menu logo (mask), draws a 3px inset line under the menu bar and
  colours the developer info bar. The menu gains NO element; the logo gets the
  label as its `title`.
- **Gate reconciliation:** `test/parity/environment_differential.test.ts`
  asserts both keys present TS-side / absent PHP-side, then strips them before
  the exact key-set compare (the WC-031 pattern).
