---
title: The Indexations field of a thesaurus term shows the columns of the records that point at it.
type: fixed
audience: user
date: 2026-11-11
wc: WC-2026-11-11-relation-index-related-list-context
---
The field that lists the records pointing at a term (Indexations on every thesaurus term, and
the similar "who points at me" fields of other sections) showed one row per record but no
columns, in the term's edit form and as a list column. Each pointing record now shows the
columns its section defines for this purpose (its related list), in both edit and list, on every
page. A column the user may not read is not shown, and neither is its value.

The field always lists every record that points at the term, so "nobody points at this"
can be trusted before deleting it. A pointing record from a section the user may not read is
shown with its section's name and its id only, with blank columns.
