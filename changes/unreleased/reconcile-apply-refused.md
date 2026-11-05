---
title: A reconcile apply that is refused now says why, and the Reconcile panel can narrow a run.
type: fixed
audience: admin
date: 2026-11-05
wc: WC-2026-11-05-reconcile-apply-refused
---
When a reconcile refuses to apply because one of its own conditions is not met, the
maintenance **Reconcile** panel and the command line used to show only `applied 0`, which
looked like a run with nothing to repair. They now say *REFUSED* and give the reason, and
`GET /api/v1/counters` carries it as `last_refused`. A refused run is not retried on its own:
it waits for you to change what the reason names.

Reconciles that can be narrowed (to a TLD, a section…) now have a scope field in the panel;
Check and Apply use it, and leaving it empty runs everything. On an ontology server, the
ontology machine-name conversion requires this: give the TLDs to convert and apply them one
at a time.
