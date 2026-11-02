---
title: The newest update run is always the one shown as newest.
type: fixed
audience: admin
date: 2026-11-02
breaking: false
---
Update run ids now carry the start time to the millisecond. Before, two runs started in the same second (for example a refused submission followed by the real update) could be ordered by the random part of their id, so `bun run update status` could report the older run as the newest one.
