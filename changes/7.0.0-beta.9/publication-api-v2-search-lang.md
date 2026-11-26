---
title: "Publication API v2: fulltext search takes `lang`."
type: added
audience: developer
date: 2026-11-24
---
`GET /{db}/tables/{table}/search` and the MCP `fulltext_search` / `count_records` (with `q`) accept `lang`. Without it a multilingual record matches once per language row, so a page of hits held the same record several times and `pagination.total` counted rows. On a table without a `lang` column the parameter is a `400`, as on the record list (see [Search and fragments](./diffusion/publication_api/v2/search_and_fragments.md)).
