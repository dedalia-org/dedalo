---
title: The setting TOOLS_REGISTRY_CACHE_TTL_MS is removed.
type: removed
audience: admin
date: 2026-11-20
---
It has had no effect since Dédalo became the only writer of the tools registry (every change
refreshes the tools list at once). It is no longer listed in `sample.env` or the settings
reference. A leftover line in `../private/.env` is ignored; you can delete it.
