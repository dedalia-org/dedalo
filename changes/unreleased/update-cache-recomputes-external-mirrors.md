---
title: Update cache now recomputes external portals instead of reporting a false success.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-update-cache-external-mirror-refresh
---
A portal or autocomplete whose data is computed from other records (an "external" portal —
for example the coins of a type, or a catalog's copy of a type's coins) was "regenerated" by
saving back the value it already held. A stale list stayed stale, an empty one stayed empty,
and the run still said every component was regenerated.

Now update cache recomputes such a portal from the records it mirrors, exactly like its
**update** button does, on every matched record. A record the portal does not belong to, or a
portal whose definition cannot be computed, is listed in the run's errors and counted apart —
nothing is written to it. A recomputed portal is not undone by reverting the run: it is
derived from other records, and reverting would only bring back the stale list.
