---
title: Tools can open attached to their component, with no modal or window.
type: added
audience: developer
date: 2026-11-24
wc: WC-2026-11-24-tool-open-as-attach
---
A tool's `properties.open_as` now takes a third value, `attach`, beside `modal` and `window`;
any other value is refused at registration. An `attach` tool puts its controls straight on
the component it was opened from — a toolbar on a map, for instance — and the engine
re-attaches it when the component redraws, removes it when the component goes away, and
switches it off on a second press of its button. Tools of this kind used to open an empty
modal and close it again, which users saw as a flash on screen; it is gone. How to write one:
[JS lifecycle](./development/tools/js_lifecycle.md#the-attach-lifecycle) and
[register.json](./development/tools/register_json.md#propertiesopen_as).
