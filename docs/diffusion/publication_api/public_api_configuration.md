# Publication API v1 configuration files

!!! warning "Legacy (v1) API"
    This page documents the **v1 PHP Publication API**, kept in Dédalo v7 for backward compatibility
    with existing published websites. It is in **maintenance / legacy status** — no new features.
    For new projects and integrations, use the current [Publication API v2](v2/index.md)
    (Bun/TypeScript): resource-oriented REST, RFC 9457 errors, `ETag` / `Link` caching, a bracketed
    filter DSL, batch queries and MCP support.

When Dédalo is downloaded from GitHub, publication config files should be configured with the proper parameters. All those config files come with a 'sample' prefix that need to be removed from the names to get the functionality.

The first step would be locating and renaming config files from their original value in GitHub to target file names that Dédalo can will locate and use. Some of these files may already be renamed.

---

## Rename public API server config file

./dedalo/publication/server_api/v1/config_api/server_config_api.php

This config file sets the public API server. This file will be used to configure all server parameters for the publication API.

It is independent from the back-end config files and has its own properties and database connection. The API server files can be moved to other server machines, to create an independent space for the public websites because the server API is not connected directly to the back-end.

Public API is located in `../httpdocs/dedalo/publication/server_api/` and it has its own config file.

1. Locate the file into the directory: `../httpdocs/dedalo/publication/server_api/v1/config_api`

    ```shell
    cd ../httpdocs/dedalo/publication/server_api/v1/config_api
    ```

2. Rename the config file from sample.server_config_api.php to server_config_api.php

    ```shell
    mv sample.server_config_api.php server_config_api.php
    ```

## Rename public API server config headers file

./dedalo/publication/server_api/v1/config_api/server_config_headers.php

This config file sets the public API server headers. This file will be used to configure http headers will use for calls. It is possible to config to admit or deny CORS or any other access control.

Public API is located in `../httpdocs/dedalo/publication/server_api/` and it has its own config file.

1. Locate the file into the directory: `../httpdocs/dedalo/publication/server_api/v1/config_api`

    ```shell
    cd ../httpdocs/dedalo/publication/server_api/v1/config_api
    ```

2. Rename the config file from sample.server_config_api.php to server_config_api.php

    ```shell
    mv sample.server_config_headers.php server_config_headers.php
    ```
