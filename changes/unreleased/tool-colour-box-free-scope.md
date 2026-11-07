---
title: Tool-owned panels outside the tool window can wear the tool's colour
type: changed
audience: developer
date: 2026-11-06
---
A tool can now stamp `data-tool="<tool>"` on an element that sits outside its
window (a floating panel, a map overlay) and that element receives the tool's
colour tokens, the same ones the header and the action buttons use; checkboxes
and radio buttons inside it follow the tool fill too. Only the tokens are
provided: the header tint, the edge bar and the button styling stay inside the
tool window, and a button in such a panel takes the tool colour through
`.tool_action_button()`. The test suite now checks the scope exists for every
tool in both themes and cannot outrank the header.
