---
title: /health shows only the state of an update run and of the data version, not their identifiers.
type: changed
audience: admin
date: 2026-10-30
breaking: false
---
`/health` answers without a session, so its `update_run` and `data_version` entries now carry only `state`. The run id, target release and version pair are shown by `bun run update status` and the maintenance panel. The health verdict is unchanged.
