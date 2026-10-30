---
title: The ontology update lists the nodes it will remove or re-model, and a failed update says exactly what it restored.
type: changed
audience: admin
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-ontology-import-census-restore
---
**Update ontology** now reports, for each ontology it imports, the nodes the new version removes and the nodes whose model changes. When an affected node is a section, it counts the records stored under it. The report does not stop the update. If an update fails and its automatic restore runs, an ontology that was empty before the update is emptied again; before, the imported rows stayed. The message now says whether the restore was complete, partial or incomplete. See [Updating the ontology](./management/updates/updating_ontology.md).
