---
title: A malformed DEDALO_MEDIA_WEB_BASE now stops the server from starting
type: changed
audience: admin
date: 2026-11-19
breaking: true
---

`DEDALO_MEDIA_WEB_BASE` is the address the browser fetches every image, video and PDF from when media is served from a different origin than the application. Its value was used as written. A slip such as `localhost:8080/dedalo/media` — no `http://` — produced addresses the browser read as paths of the page, so every image failed to load and no log said why.

The value is now checked when the server starts. It must be a root-relative path (`/dedalo/media`) or an absolute `http://` / `https://` URL with no user name or password, no query string and no fragment; a trailing slash is still removed. With any other value the server does not start, and the message names the parameter and the value it found. There is deliberately no fallback to the default. Before updating, check that line in `../private/.env` if you set it; an installation that leaves it unset is not affected. See [the configuration reference](./administration/configuration/config.md).

