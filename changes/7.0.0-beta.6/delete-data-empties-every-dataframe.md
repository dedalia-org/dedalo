---
title: Deleting a record's data now also empties every dataframe of its fields.
type: fixed
audience: user
date: 2026-09-28
---
**Delete data** empties every field of a record, and now also removes the frames of every
[dataframe](./core/components/component_dataframe.md) those fields had — whatever the field
is: a portal, a text or number field, or a link (IRI) with its labels — even a field that
held no value of its own when the frames were saved first. Before, a dataframe
that was not itself a field of the section (an IRI's labels, a dataframe named only in a
field's configuration) kept its frames after the wipe, attached to nothing and impossible to
remove from the edit view. Restoring an older entry from the
[Time machine](./using/tools/using_time_machine.md) likewise removes the frames of the values it
takes out, in every dataframe of the field. The history entries **Delete data** writes are
filed in each language's own history (and the frames in the `lg-nolan` entry), so every
language's time machine lists the wipe.
