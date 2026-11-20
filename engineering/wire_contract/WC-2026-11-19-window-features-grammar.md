# WC-2026-11-19-window-features-grammar — a tool's `windowFeatures` is parsed against a closed grammar, never evaluated

- **Date:** 2026-11-19 (T2 batch B1, item S10-a).
- **Decision:** — (DEC-12 gates: `test/unit/client_no_dynamic_code_tripwire.test.ts`,
  `test/unit/client_window_features.test.ts`).
- Code: `client/dedalo/core/tools_common/js/window_features.js` (new, pure),
  `client/dedalo/core/tools_common/js/tool_common.js` (`view_window`, `view_modal`).

## Shape before (PHP client = TS client until now)

`properties.windowFeatures` of a tool registration (dd1335), or
`open_tool({windowFeatures})`:

- **window:** a string passed verbatim to `window.open`, or an object whose
  every key became a `key=value` pair — a string value starting with `return`
  was RUN: `Function(value)()` (`tool_common.js`, e.g. tool_upload's
  `"left": "return screen.width -760"`).
- **modal:** an object; every key was assigned to `modal_content.style[key]`.

The value is registry data (a database record, writable by whoever can register
or edit a tool): script in it ran in every user's page.

## Shape after (TS)

The same property, the same registered values — read by a parser:

- **window:** keys `left`, `top`, `width`, `height` (aliases `screenX`,
  `screenY`, `innerWidth`, `innerHeight`) and the flags `popup`, `noopener`,
  `noreferrer`. A position/size value is a finite number, a digit string, or
  the legacy relative form `return (screen|window).<dimension> [(+|-) <integer>]`
  with `<dimension>` from a closed list (`screen.width|height|availWidth|
  availHeight|availLeft|availTop`, `window.innerWidth|innerHeight|outerWidth|
  outerHeight|screenX|screenY|screenLeft|screenTop`) — PARSED and computed, never
  evaluated. The inline string `'left=100,top=100,…'` is the same pairs and
  passes the same grammar (it is no longer forwarded verbatim).
- **modal:** keys `width`, `minWidth`, `maxWidth`, `height`, `minHeight`,
  `maxHeight`; a value is a number (pixels), a CSS length / percentage, or
  `auto | none | fit-content | max-content | min-content`.
- **Anything else is refused:** the tool does not open and the error names the
  key (never the value). `null` / absent: as before.

Every `register.json` in the repo passes unchanged (floored in the gate;
`tool_upload/register.json` is not edited).

## Reason

Data must not become script. The client is the consumer; the grammar covers
everything the registered tools use, and a registration outside it is a
registration defect to fix, not a value to run.

## Gate reconciliation

No parity gate carries this (client behaviour). Gates RED before: the tripwire
(`tool_common.js: Function(`). Mutations red: the parser evaluating (13), the
dimension list unenforced, the relative form unanchored, an unknown window key
passed through, the modal key allowlist off, the modal value unchecked,
`Function` back in `tool_common.js`. No re-harvest.
