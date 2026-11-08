---
title: A saved search whose field no longer exists in the ontology no longer breaks the search panel.
type: fixed
audience: user
date: 2026-10-28
---
A search filter stores each field as it was when it was saved. After an ontology
update removed a field, or changed its type, opening the search panel with that
filter left an empty row and could stop the panel from loading the rest. Now the
row shows *Invalid component* in the field's place, the field is left out of every
search, and your current (unsaved) filter is saved again without it, so the next
load is clean. A field that only failed to load (a network drop, a timeout, a
server error) also shows *Invalid component*, but its condition is kept. Named presets are not rewritten for you: load one, check it and save
it again to remove the field for good. Until the current filter has been saved
again, the panel may offer the error report once for the missing field.
