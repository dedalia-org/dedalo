---
title: The Publication server API maintenance panel shows its "Open Swagger UI" buttons again.
type: fixed
audience: admin
date: 2026-10-01
---
The panel (Maintenance → Publication → Publication server API) never showed the buttons that open the interactive documentation of the publication server API v1, because `API_WEB_USER_CODE_MULTIPLE` was not read. It is a configuration key again: list each publication database and its API code, e.g. `API_WEB_USER_CODE_MULTIPLE=[{"db_name":"web_my_entity","code":"my_api_code"}]`, optionally with `api_ui` when the API runs on another server — see [the configuration reference](./administration/configuration/config.md). A v6 configuration migrated with the config migrator now carries the value across; the empty placeholder entry of a stock v6 configuration is left out, so a migrated install does not report a dropped entry on every start.
