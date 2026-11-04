---
title: A term duplicated in the thesaurus/ontology tree can be reordered right away.
type: fixed
audience: user
date: 2026-11-03
breaking: false
---
Changing the order number of a term just created with the tree's Duplicate button did nothing
(console: `[ts_object.save_order] Self not found in parent's children data`).

Cause: Duplicate re-rendered the parent's children from fresh server data but never stored
that data on the parent, so the new term was missing from the list the reorder looks itself up
in. The parent now keeps the fresh children list.
