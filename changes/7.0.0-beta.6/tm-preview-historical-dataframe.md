---
title: The time machine shows a field's frames and their values as they were at the chosen change.
type: fixed
audience: user
date: 2026-09-29
wc: WC-2026-09-29-tm-preview-frame-children-as-of
---
In the [time machine](./using/tools/using_time_machine.md), the preview of a field with a
[dataframe](./core/components/component_dataframe.md) could show today's frames instead of
the ones of the chosen entry, and a frame's own values — a role, a rating and its colour —
were always shown as they are now. The preview and the history list now show the frames and
their values as they were at that change: an entry from before a frame was added shows no
frame, a rating edited later shows its earlier value, and a frame record emptied since shows
what it held. Switching between entries, or clicking the same entry again, never shows the
previous entry's frames, and a save made elsewhere no longer changes an open preview. The
history list's frame column now matches the preview for every entry, including the entries
of one language of a translatable field, which showed no frames before, and each entry's frame
button shows the rating colour of that entry, not the newest one. In a record's whole history
(the entries of a deleted or recovered record), each field's frames show their values as they
were at that entry: a deleted record shows them as they were when it was deleted, not the
emptied values its dataframe policy left after the deletion. Recovering a deleted record now
adds its own entry to the record's history, so the deleted record's entry keeps showing those
values after the recovery. In the time machine a frame's button is now read-only: it shows the
frame's label and colour, but offers no **+** and opens nothing — before, clicking it opened the
record as it is now, editable, from a view of the past. The same holds for a user without
permission to edit the dataframe.
