---
title: After an update that needs a database restore, no new update starts until the run is closed.
type: changed
audience: admin
date: 2026-10-30
breaking: false
---
When an update run ends asking for a database restore, every new update run is refused until you have restored the database and closed the run with `bun run update abort <note>`. Each release's migrations now run in that release's own phase, after its ontology step. A code update on an installation with no ontology source no longer fails on the ontology phase: the step is skipped and the skip is recorded. *Restore* in the code update panel now offers to proceed without a recent database backup when the backup is stale.
