---
title: The TOOLS_ENABLE_REGISTRY_IMPORT setting is retired; a code update now always re-registers tools and keeps each one's Active choice.
type: changed
audience: admin
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-tools-registry-import-switch-retired
---
`TOOLS_ENABLE_REGISTRY_IMPORT` no longer exists; a line left in `.env` is ignored. A code update now always reconciles the tools registry from the release's tool packages, so a tool added by the release appears without pressing *Register tools*. Each tool keeps the Active value an administrator set, even one changed while the update runs.
