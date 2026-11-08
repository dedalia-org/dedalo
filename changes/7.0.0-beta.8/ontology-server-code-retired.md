---
title: An ontology server accepts the access codes listed in ONTOLOGY_SERVERS; ONTOLOGY_SERVER_CODE is retired.
type: removed
audience: admin
date: 2026-11-06
breaking: true
---
`ONTOLOGY_SERVER_CODE` no longer authorises anything (it was already deprecated in v6). An installation with `IS_AN_ONTOLOGY_SERVER=true` now accepts the `code` of every entry in its `ONTOLOGY_SERVERS`. **If clients pull from your ontology server with the code you set in `ONTOLOGY_SERVER_CODE`, add one `ONTOLOGY_SERVERS` entry per client carrying that code** (no `tlds`: such an entry is code-only and nothing is pulled from it) and restart. The old line still parses, so a v6 `.env` boots; remove it. The *Serve Ontology* panel now reports the codes of `ONTOLOGY_SERVERS`. See [ONTOLOGY_SERVERS](./config/config.md#ontology-servers).
