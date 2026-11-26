---
title: Reloading a record's edit page keeps the record's place in its search results.
type: fixed
audience: user
date: 2026-11-09
breaking: false
wc: WC-2026-11-09-start-deep-link-found-set-position
---
Reloading the browser on a record opened in edit mode, or opening its address in a new tab, showed the
record alone: the paginator read 1 of 1 and the previous/next buttons went nowhere, whether or not the
list had been filtered. The page now reopens the record at its position in the records you were browsing,
with their total, so previous/next continue through the same search. When the record is not part of that
search (an address shared by a colleague, for example), the paginator moves through every record of the
section instead.
