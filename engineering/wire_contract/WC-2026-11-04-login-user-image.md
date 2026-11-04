# WC-2026-11-04-login-user-image — the login answer names the ACCOUNT'S OWN image (dd522) as a top-level key

- **Date:** 2026-11-04 (task: "on user login, the login image should display the
  user image (component_image dd522)").
- **Context:** the login panel shows one picture while the asset cache warms —
  the `--user_login_image` background of the files-loader circle
  (`client/dedalo/core/login/css/login.less`, `render_files_loader`). The TS
  login handler never emitted any image key, so every account saw the bundled
  grey icon. The client was reading `result_options.user_image`, a PHP-era
  nesting no TS envelope carries (`error_dispatch.js` states the same for
  `result_options.user_id`). The neighbouring `result_options?.user_id` read is
  corrected in the same edit: it gated the root-only `raspa_loading` background,
  which therefore never ran, and it now paints the same `--user_login_image`
  behind the page for root on a development server — the behaviour its CSS
  already declares.
- **Shape before (PHP):** `result_options: { user_image:
  "/dedalo/core/themes/default/raspas/raspa_screen.jpg", user_id }` — the
  THEME's screen-saver picture, not the user's own image (frozen oracle,
  `test/parity/fixtures/oracle_harvest/context_differential.json`, login RQO).
- **Shape after (TS):** `ok(true, {data:true, user_id, user_image})` — envelope
  v2 extension keys ride at TOP LEVEL beside `data`. `user_image` is the account's
  `dd522` file URL: `${config.media.webBase}${file_path}?v=<mtime>-<size>`,
  default quality first and the `thumb` tier as fallback, `null` when the
  account has no image on disk (the client then keeps its bundled icon — a
  grammar-only URL would 404 and blank the circle, which is why the resolver
  stats the file: `security/user_identity.ts resolveUserImageUrl`). Root (-1)
  is `null` by construction: the media grammar names files by a POSITIVE
  section id, so root's record can hold no media file, and the resolver answers
  null instead of throwing — measured: the refusal escaped the handler and
  turned root's login into a 400.
- **Reason:** the login panel is the first surface every curator meets, and the
  engine has held each account's image (dd522, editable in tool_user_admin)
  since v6. The TESTS-OWNER task was "show it"; PHP's theme path was never that.
- **Gate reconciliation:** no parity gate replays `dd_utils_api:login` (the
  frozen store recorded it only inside `context_differential`'s cache, which no
  differential diffs), so no fixture change and no re-harvest. The TS-native
  contract gate is `test/unit/login_user_image_native.test.ts`: the resolver
  against real files on disk (default quality → thumb → null) and a REAL login
  on the suite database carrying `user_image` at the top level.
