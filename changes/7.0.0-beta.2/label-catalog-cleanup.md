---
title: Label catalog cleanup
type: changed
audience: developer
date: 2026-07-16
wc: WC-034
---
The master key census went 686 → 413:
28 renames to English keys, 240 proven-unused removals, and 21 single-tool
keys migrated into their tools' own `register.json` labels (edited with
[`tool_dd_label`](./using/tools/using_dd_label.md)). The `get_label` wire shape is
unchanged; only the key set.
