---
title: An activated text area no longer spills its text past the field and over the component below it.
type: fixed
audience: user
date: 2026-11-03
breaking: false
---
On records where the field's row is sized by the neighbouring column (the two-column
identification groups), clicking into a long text area made the editable box grow past the
field: the text painted over the next component — a map, another field — and, in the right
column, over the column beside it, with no scrollbar to reach the end. The activated field's
content box now takes the field's own height, so the editor scrolls inside the field and
nothing is painted outside it.

Idle text areas and the tool panes are unchanged: an idle field still grows with its text,
and the transcription/translation panes still size their own box.
