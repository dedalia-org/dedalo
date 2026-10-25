---
title: The publication-marker index is now repaired every 10 minutes as well as at startup, and a repair held off by a running publication is retried instead of skipped.
type: fixed
audience: admin
date: 2026-10-22
breaking: false
wc: WC-2026-10-22-reconcile-deferred-rearm
---
The web server decides whether anonymous visitors may open a record's media by a marker the engine keeps in `.publication/pub`. That set is re-derived from the per-publication truth after every start, to repair a marker pair a crash left half-written. When a publication was writing at that moment for longer than two minutes, the repair was skipped and not tried again until the next restart, so a published record's media could stay unreachable — or a withdrawn one stay public — for as long as the server kept running. The repair is now retried a minute later until it completes, and it also runs every 10 minutes, which heals a pair left half-written by a publication process that died while the server stayed up. The periodic repair holds the publication targets only when it actually has something to repair, and when it did hold them it then completes the removals of records deleted meanwhile, so a record deleted while it ran leaves the public site with that run instead of waiting for the next publication. In the maintenance area, **Reconcile** shows the schedule as `boot + every 10 min` and marks a run that had to wait as *DEFERRED*, with the reason; `GET /api/v1/counters` carries it as `last_deferred`.
