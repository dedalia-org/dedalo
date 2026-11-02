# Tools on a phone

> See also: [Tools](index.md) · [Creating new tools](creating_tools.md) · [Tools JS lifecycle](js_lifecycle.md)

Every tool must **display and work on a 360 CSS-pixel phone**. The bar is *usable*, not *comfortable*: nothing clipped, no sideways page scroll, every action reachable, every input typeable. This page is the contract a tool author works to, and how it is checked.

## The contract

At the phone tier (`@width_break_point_phone`, 600px) and down to the floor `@min_target_viewport` (360px):

- **The page never scrolls sideways.** A wide child reflows, or scrolls inside its *own* box (`overflow-x: auto`) — a translation matrix or an A4 print preview legitimately pans; the page does not.
- **Every visible control is on screen and at least 44px** on its shortest side (WCAG 2.5.5). This includes disabled controls: a disabled control is the same target the moment it is enabled.
- **Text stays readable.** A column so narrow that a word stands one letter per line fails, even when nothing overflows.
- **A tool that opens in a dialog is a full-screen sheet.**
- **A drag has a touch alternative.** HTML5 drag-and-drop does not fire from a finger, so a drag-only action is impossible on a phone (see [Gestures](#gestures)).

## What you get for free

`client/dedalo/core/tools_common/css/tool_responsive.less` (imported by `tool_common.less`) applies to every tool:

| Surface | Phone behaviour |
|---|---|
| `.tool_header` | Title above description, description capped at two lines, sticky. The dialog title bar grows with it; the body starts below. |
| `.tool_header > .tool_buttons_container` | Controls wrap and become 44px tall. |
| `.wrapper_tool` inputs, selects, buttons | 44px targets; inputs at 16px text (iOS zooms the page on focus of anything smaller). |
| images, video, canvas | `max-width: 100%`. |
| `table` | Scrolls inside its own box. |
| `.phone_stack` | Opt-in: add the class to a grid and it becomes one column. |
| Dialogs (`dd-modal`) | Full-viewport sheet. |

Most tools pass on this alone. Write tool-specific rules only for what it does not cover.

## Writing phone rules for your tool

Put them in your tool's own sheet, nested in the rule they change, against the **token** — a literal width fails `tool_phone_tripwire`:

```less
.wrapper_tool.tool_my_tool {
	>.content_data {
		grid-template-columns: 240px 1fr 1fr;

		@media screen and (max-width: @width_break_point_phone) {
			grid-template-columns: minmax(0, 1fr);
		}
	}
}
```

Your sheet must import the variables (`@import (once) '../../../client/dedalo/core/page/css/layout/vars';`), then `bun run css:build`.

The mistakes the phone check found most often:

| Symptom | Cause | Fix |
|---|---|---|
| Content 500px wide in a 360px sheet | A desktop `min-width` (often `34rem`) | Lift it at the phone tier. |
| Buttons spill off **both** edges | `display: flex; justify-content: center` without wrapping | `flex-wrap: wrap`. |
| One letter per line | Many `1fr` columns in a narrow box | Stack the columns, or give them a minimum width and let the box scroll. |
| A 44px rule has no effect | A more specific original selector wins | Nest the phone rule inside the original rule. |
| An item shrinks to 10px | It is a flex item beside a long label | `flex: 0 0 44px`. |

## Gestures

Three shared helpers cover what CSS cannot:

- **Tap to pick, tap to place** — `client/dedalo/core/common/js/touch_pick.js`. The touch twin of a drag *onto a target* (a record onto a thesaurus term, a coin into a slot). The drag source calls `touch_pick.pick(payload, label)` with **the same payload its `dragstart` puts in `dataTransfer`**; the drop target, on a tap while `touch_pick.active()`, calls its existing drop handler with `touch_pick.as_drop_event()`. One drop implementation, two gestures. Offer the tap only when `touch_pick.is_touch()` (a coarse pointer, not a narrow window). Used by tool_cataloging, tool_numisdata_order_coins and the portal rows themselves (reorder and move, see [component_portal](../../core/components/component_portal.md#drag-and-drop)).
- **Up/down buttons** — `client/dedalo/core/tools_common/js/phone_reorder.js`. The touch twin of a drag that *sorts a list*. `render_phone_reorder({on_move, labels, is_first, is_last})`; `on_move(-1|1)` must run the same reorder the drop does.
- **Pane switch** — `client/dedalo/core/tools_common/js/pane_switch.js`. For a two-pane tool that is unusable stacked: `render_pane_switch(host, [{key, label}, …])` shows one `data-pane` at a time on a phone and nothing changes on a desktop.

## Checking your tool

```bash
bun run test:tools:phone --tool tool_my_tool --shots /tmp/shots
```

It starts its own server on the **suite** database, logs in, opens the tool **the way a user does** (the caller's page, then `open_tool` on the live instance) at 360×740 with touch emulation, and reports every failure of the contract above, plus the tool rendering its error panel. `--shots` saves a full-page screenshot: **read it** — the check measures geometry, and a screenshot is the only review of whether the tool is actually usable.

To add a tool, give it a probe in `test/helpers/tool_phone_ratchet.ts`. For a tool on a component of the suite's `test3` playground section (a `component_input_text` is `test52`):

```ts
tool_my_tool: test3('test52', 'component_input_text', 'lg-spa'),
```

Other probe kinds cover a list button, a `section_tool`, a real tap, and a launcher's own open function; a probe can also build a scratch record, which is swept afterwards. A tool whose screen only exists once a file is queued (`service_upload`) adds `queue_file: true` so the harness puts one scratch file into its upload queue before judging — without it the tool opens empty and its per-file row goes unmeasured. To find which live elements offer your tool: `bun run test:tools:phone --discover test3/1`.

The ratchet only shrinks: a tool in `NOT_YET_PHONE` whose probe starts passing turns the run red until it moves to `PHONE_CASES`. `test/unit/tool_phone_tripwire.test.ts` keeps the list complete — a new tool directory must appear in one of the lists.

A tool the deployment hides behind an AI capability that no configuration can raise (today `tool_identify`, see `src/ai/capabilities.ts`) is listed in `HIDDEN_BY_CAPABILITY` with its flag and a reason: its probe must *not* render, and the run turns red the day it does, so the entry moves back to `PHONE_CASES`. The assistant needs a configured model; the run pins a stub one (`PHONE_RUN_ENV`, never called) on its own server, so the verdict does not depend on your `../private/.env`.
