# WC-2026-11-24-tool-open-as-attach — `properties.open_as` is a closed set with a third mode, `attach`

- **Date:** 2026-11-24 (branch `feat/tool-open-as-attach`).
- **Decision:** none (core client feature). Code: `client/dedalo/core/tools_common/js/tool_common.js`
  (`open_tool` → `view_attach`), the register.json validation of `properties.open_as`.
- **Shape before (PHP v6/v7 and TS until this entry):** `properties.open_as` was a free
  string. `open_tool` sent `window` to `view_window` and EVERY other value (`modal`, `tab`,
  `popup`, a typo) to `view_modal`. A tool that only decorates its caller (a toolbar on a
  component's map) had to open a modal, attach itself to the caller and close the modal — a
  visible flash.
- **Shape after (TS):** `properties.open_as` accepts exactly `"modal"` (default), `"window"`,
  `"attach"`; anything else is a registration error. `"attach"` requires
  `show_in_component: true` and `show_in_inspector: false`. `open_tool` routes it to
  `view_attach`: no modal, no window; core loads the instance and CSS in parallel,
  `build(true)`, then calls the tool's `attach()` (async, truthy on success, idempotent);
  `render()` is not called. The tool also implements `detach()` (async, tolerant of a gone
  surface). Core owns the lifecycle: caller re-render (`render_<caller.id>`) → `detach` +
  `attach`; caller destroy → `detach` + `destroy`; second button press → `detach` +
  `destroy`; a press while loading is ignored. DOM: the button carries `aria-busy="true"` +
  class `loading` while loading and `aria-pressed="true"` while attached; the caller's root
  node carries `data-tools-attached` (space-separated tool names). A failure surfaces once
  through the standard client error path and leaves nothing attached. The tool context the
  server emits (`properties` on the tool ddo, `dd_tools_api`) is unchanged in shape; only the
  value set is closed.
- **Reason:** decorating tools need an open mode without a surface of their own; and an
  open-ended `open_as` silently turned a typo into a modal.
- **Gate reconciliation:** no parity gate diffs `open_as` routing (client-side); no fixture
  touched, no re-harvest. Every in-repo register.json already uses `modal` or `window`.
  Manual: `docs/development/tools/js_lifecycle.md`, `docs/development/tools/register_json.md`.
