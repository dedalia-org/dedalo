---
title: "The language settings now all carry their v6 DEDALO_ names."
type: changed
audience: admin
date: 2026-11-22
---
Early v7 installations spelled four language settings without the `DEDALO_` prefix. They are now
`DEDALO_APPLICATION_LANG` (was `APPLICATION_LANG`), `DEDALO_DATA_LANG` (was `DATA_LANG`),
`DEDALO_DATA_NOLAN` (was `DATA_NOLAN`) and `DEDALO_PROJECTS_DEFAULT_LANGS` (was
`PROJECTS_DEFAULT_LANGS`) — the v6 names, so a v6 configuration carries over unchanged. The
installer has written `PROJECTS_DEFAULT_LANGS`, `APPLICATION_LANG` and `DATA_LANG` into
`../private/.env` since 7.0.0-beta.6: rename those lines before updating. An old spelling no
longer configures anything — if it is still there, the server refuses to start and names the line
to rename. See [Defining application language](./administration/configuration/config.md#defining-application-language).
