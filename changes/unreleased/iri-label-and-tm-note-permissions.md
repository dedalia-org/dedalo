---
title: IRI labels follow their IRI's permission; Time Machine notes belong to the change they annotate.
type: changed
audience: user
date: 2026-11-10
breaking: false
wc: WC-2026-11-10-iri-frame-and-tm-note-levels
---
**IRI labels.** Before, only root could save the label of an IRI link; every other user got
a permission error and saw the label read-only. Now the label has the same permission as its
IRI field: whoever can edit the IRI can edit its label, and whoever can only read the IRI
reads its label. When an import carries IRI labels, they are imported for users who can
edit the IRI; for others the label column is reported as ignored and the rest of the row is
still imported.

**Time Machine notes.** Before, any user allowed to edit the notes section could rewrite
anyone's note. Now a note belongs to the change it annotates:

- Only the author of a change can add a note to it, from the component history in the
  inspector or from the Time Machine. The note is linked to the change automatically.
- The author can edit and delete their own note. Everyone else — administrators and root
  included — can read it.
- A user who cannot see a section's history cannot see its notes either. Before, any logged-in
  user could read every note's text through the raw record view, the assistant's record tools
  or an export; now notes are reached through the Time Machine only.
- A note cannot be duplicated.
- Users given a specific permission on the Time Machine notes section keep working with it
  like any other section (for audits and exports); their changes are recorded in its
  history.
