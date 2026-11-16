---
title: A tool configuration record can again redefine which components a tool uses on one field or button.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-tool-configuration-override
---
A *Tools configuration* record (or a tool's registered default configuration) may list, under `properties.tool_config`, the components a tool works with on one specific field or section button. Since the move to v7 those entries were ignored and the tool always used the components the ontology declares. They now apply again: the configuration record wins, then the registered default, then the ontology. Installations upgraded from v6 that carry such entries will see the configured components appear in those tools after updating. Section toolbars now also send each tool's configured components, as the field toolbars always did. See [Server contract](./development/tools/server_contract.md).
