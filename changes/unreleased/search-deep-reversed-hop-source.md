---
title: A system search across two or more linked sections no longer matches through a record stored in another table.
type: fixed
audience: admin
date: 2026-11-17
wc: WC-2026-11-12-search-hop-join-record-address
---
A search can follow links through several sections — a record, the record it links, and the
record that one links. Searches a signed-in user runs were already exact. A search the system
runs on its own (no user behind it) could, for a positive condition, also return a record whose
link in the middle named a record of a section stored in a different table than the one the
search path goes through: that record's own links were followed although the search cannot
read it. The same search written as a negation did not, so the two answers disagreed. Now
every record in the middle of the path must be a record of the table the path names, for
every search.
