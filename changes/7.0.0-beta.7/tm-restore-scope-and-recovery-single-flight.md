---
title: Time machine restores respect every record's projects and every field's permission; the ontology recovery file is built one at a time
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-tm-restore-component-write-doors, WC-2026-10-21-ontology-recovery-single-flight
---
- **Reverting a bulk change never brings back a record outside your projects.** When a
  revert re-links a record that an earlier revert deleted, that record is now checked
  against your projects like any other. If it is outside them, that change is skipped as
  *out of scope* and the record stays deleted.
- **Restoring a field's history needs permission on its dataframe too.** *Apply value* in
  the time machine also rewrites the dataframe attached to the field, such as roles or
  ratings. It now needs edit permission on that dataframe as well. A user who can only
  read the dataframe gets a permission error, and nothing is restored.
- **One recovery-file build or restore at a time.** In *Maintenance → Build database
  version*, a second build or restore of the ontology recovery file started while one is
  running is refused with *already running*. Before, two at once could leave a damaged
  recovery file behind a success message.
- **An ontology update that has finished is not undone by a late error.** If a final
  report step of *Update ontology* fails after the new ontology is in place, the update
  stays in place. The message now says that the update landed and that nothing was rolled
  back.
