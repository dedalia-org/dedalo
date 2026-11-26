---
title: Exporting a related field no longer refuses what the record already shows you.
type: fixed
audience: user
date: 2026-11-09
breaking: false
wc: WC-2026-11-09-export-relation-display
---
A related field (a portal or an autocomplete) shows the labels of the records it points to, even
when those records are outside your projects. Exporting that same field stopped with "links to
records outside your scope", although the record on screen already showed every value.

An export of a related field now carries exactly what the record shows you for it, in every format.
Anything beyond that is still checked: picking a field inside the linked records, the thesaurus
parents, and a linked record the field does not show. If one of those reaches a record you cannot
open, the export still stops and names the column. Media files of linked records you cannot open
are still left out of the media archive.
