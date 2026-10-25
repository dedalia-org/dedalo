---
title: Restoring a whole record from the time machine needs permission on every field it changes; a failed ontology re-index after an update no longer brings the old ontology back
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-tm-section-restore-write-door, WC-2026-10-21-ontology-update-derive-landed, WC-2026-10-21-ontology-recovery-deadline
---
- **Restoring a whole record checks every field it changes.** *Apply value* on a whole
  record in the time machine now needs edit permission on each field the restore would
  change, like restoring a single field already does. A user who manages user accounts can
  no longer give their own account back an earlier profile or administrator flag this way,
  and a field you may only read is never rewritten by a restore. A refused restore changes
  nothing. Undeleting a record works as before.
- **An ontology update whose re-indexing fails keeps the new ontology.** If *Update
  ontology* has imported the new ontology but rebuilding the ontology tree from it fails,
  the update now stays in place and the message names the ontologies to rebuild in
  *Maintenance*. Before, the old ontology was put back under a tree already partly rebuilt
  from the new one.
- **A stuck recovery-file build no longer blocks the next one.** Building or restoring the
  ontology recovery file in *Maintenance → Build database version* now gives up after ten
  minutes and reports it, instead of waiting forever and refusing every later attempt as
  *already running*.
