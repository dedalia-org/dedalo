---
title: The Docker host record reports the generated salt like the engine's record.
type: fixed
audience: admin
date: 2026-11-08
---
`sh install.sh --route docker --status --json` said `salt_generated: false` while the container's own record said `true`; the host record now says what the container's says.
