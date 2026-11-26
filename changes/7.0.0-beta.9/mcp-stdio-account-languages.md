---
title: The command-line MCP server answers in its account's languages.
type: fixed
audience: admin
date: 2026-11-22
wc: WC-2026-10-20-element-context-default-lang
---
The command-line (stdio) MCP server, started with `DEDALO_MCP_USER_ID`, ran every
tool without a language of its own, so a tool called without `lang` (section lists
and descriptions, record reads, searches, link targets) answered in the
installation's main data language, `DEDALO_DATA_LANG_DEFAULT`. Each call now runs
in the languages the configured account gets when it logs in to the web
application: the installation's interface and data languages (`DEDALO_APPLICATION_LANG`,
`DEDALO_DATA_LANG`). Where `DEDALO_DATA_LANG` differs from `DEDALO_DATA_LANG_DEFAULT`, tools
called without `lang` now answer in `DEDALO_DATA_LANG`. Send `lang` to ask for another.
