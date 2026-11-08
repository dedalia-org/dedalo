---
title: Interface labels are a separate, cacheable download — `get_environment` and `start` no longer carry `get_label`.
type: changed
audience: developer
date: 2026-11-07
wc: WC-2026-11-07-labels-separate-resource
---
The localized interface-label dictionary used to ride every `start` / `get_environment` response as `get_label`, so every page load downloaded it again. The environment now carries only `page_globals.labels_version`, and the client fetches the dictionary from the public `GET /api/v1/labels?lang=<lang>&v=<labels_version>`, which the browser keeps until the labels actually change (a code update). An API consumer that read `get_label` from the environment must fetch that URL instead; the body is the same dictionary. Pages load faster; nothing to configure.
