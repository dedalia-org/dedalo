---
title: Names and values typed by one user can no longer run script in another user's browser
type: security
audience: admin
date: 2026-10-25
---
Four places in the work interface inserted a stored value into the page as
markup instead of text: the name of an image annotation layer in its
**Delete** confirmation, the field labels of a saved or shared search preset,
the record terms and field values in the graph view's node panel, and the
selected record's title in the autocomplete choice grid. A value containing
markup — for example a layer named `<img src=x onerror=…>` — ran as script for
any other user who opened it. These values are now always shown as plain text.
Two internal lookups keyed by text a user controls (URL parameters and the
autocomplete search cache) were also hardened so such a key cannot alter them.
No action is needed on update.
