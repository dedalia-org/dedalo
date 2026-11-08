---
title: AI tools are hidden when no AI model is configured.
type: changed
audience: admin
date: 2026-10-29
breaking: false
wc: WC-2026-10-29-ai-capabilities-page-globals
---
The assistant appears only when the agent HTTP endpoint is enabled and at least one model is configured. Semantic search appears only when a real embedding model (the sidecar endpoint) is configured. Object identification is hidden until it is redesigned. On an installation without a working model, these entry points no longer show buttons that fail when clicked.
