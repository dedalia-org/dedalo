---
title: A read-only field's value starts under its own label again
type: fixed
audience: user
date: 2026-10-24
---
When a text field is not editable — a view-only user, a Time Machine preview, a
print view — its value sat about half a character to the left of the label above
it, while an editable field's value sat exactly on it. The two looked like two
different grids in the same record.

The value now starts on the same left inset as its label, editable or not. The
alignment covers every single-line field that renders as plain text (text,
number, date, e-mail, URL), not just the one that was reported.
