# WC-2026-11-02-ui-preferences — `ui_preferences` page_globals key (TS-only) + dd1206 self-editable

- **Date:** 2026-11-02.
- **Shape:** `buildPageGlobals` (`src/core/resolve/environment.ts`) emits
  `ui_preferences`: the logged user's own dd1206 "User interface preferences"
  (`component_json`, dd128 → dd129) first item `value` when it is a plain object
  of at most 4 KiB (`pickUiPreferences`, `src/core/security/user_identity.ts`),
  else `null`; `null` for anonymous callers. PHP `get_page_globals` has NO twin.
  Known key: `active_style` (`default` = the tinted Background look | `frame` | `lift` | `margin`, the client registry
  `client/dedalo/core/page/js/active_styles.js`; unknown ids fall back to `default`).
- **Permission:** dd1206 joins `SELF_EDITABLE_COMPONENTS`
  (`src/core/security/permissions.ts`): a user writes it on their OWN record at
  level 2 without a dd128 grant, as name/email/password/image. A display
  preference — it grants nothing, so the self-service set cannot become an
  escalation through it.
- **Why:** the active-field style choice must follow the user across browsers and
  logins, not live only in `localStorage` (which stays as the first-paint cache).
- **Gate reconciliation:** `test/parity/environment_differential.test.ts`
  (page_globals key-set test) asserts the key present TS-side / absent PHP-side,
  then strips it — the WC-031 pattern.
