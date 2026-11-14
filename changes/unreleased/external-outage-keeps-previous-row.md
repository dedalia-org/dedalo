---
title: A publication run no longer empties a record's remote (Zenon) values when the remote service is down: the record is held back, reported, and retried by the next run.
type: fixed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-external-outage-keeps-previous-row
---
When a published column reads a remote record (a Zenon bibliography entry) and the remote service
cannot be reached during the run — down, timing out, or temporarily closed after repeated
failures — the record's row is now **held back**: nothing is written for it and nothing is
removed, so the public table keeps the row of the previous run. The run finishes as a partial
success with one line per held record ("row SKIPPED, previous publication kept, retried by the
next run"), and the next run of the element publishes it as usual. For the RDF, XML and Markdown
publications the held record also stays in the merged document and the download archive the run
rebuilds, so a service outage never removes it from what the public downloads. Before, the row was written
with the remote values empty — the public site lost them until a later run succeeded.

Unchanged: a remote record the service reports as gone publishes an empty value (that is the
service's answer), and a disabled or misconfigured service publishes an empty value with its
message, since retrying cannot change either.

