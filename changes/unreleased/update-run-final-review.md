---
title: Update runs refuse ontology sources without file digests and resume more safely.
type: changed
audience: admin
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-update-run
---
An update run (*Update ontology*, or a code update's ontology phase) refuses an ontology source that publishes no file digests; re-export on the master. A data change that is resumed after it already committed is not run again. If the server loses its database connection during a run, the run stops before its next phase and the next start resumes it; at start the server waits up to two hours for a lock still held by a dead session. A run that has no schema phase after the code swap now ends with one, so a development build's migrations are applied. Maintenance jobs that need the update lock are refused while an update run is in flight.
