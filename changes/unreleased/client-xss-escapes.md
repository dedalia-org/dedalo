---
title: Names and values typed by one user can no longer run script in another user's browser
type: security
audience: admin
date: 2026-10-25
---
Several places in the work interface inserted a stored value into the page as
markup instead of text: the name of an image annotation layer in its
**Delete** confirmation, the field labels of a saved or shared search preset,
the record terms and field values in the graph view's node panel, the
selected record's title in the autocomplete choice grid, the people offered by
the transcription tool's **Assign speakers** dialog, and the user and record
names listed by the **Lock components** maintenance panel. A value containing
markup — for example a layer named `<img src=x onerror=…>` — ran as script for
any other user who opened it. These values are now always shown as plain text,
and the same rule now holds for every label, count and message the interface
builds around a value: a confirmation dialog's title, for example, is always
text.
Two internal lookups keyed by text a user controls (URL parameters and the
autocomplete search cache) were also hardened so such a key cannot alter them.
No action is needed on update.
