---
title: Publication fills the global search and map tables again
type: fixed
audience: admin
date: 2026-11-12
breaking: true
wc: WC-2026-11-12-global-table-maps
---
Tables declared with `global_table_maps` (for example the global search table of a memorial
portal or the `map_global` layer of a numismatic site) gather every published record of
several sections in one table. Since the switch to the new publication engine they were no
longer updated: new records were missing, edited ones kept their old values, and unpublished
or deleted records stayed public.

Publishing now writes them again, one row per record and language, refreshed on every
publication and removed when the record is unpublished or deleted. The public-tier reconcile
also reports and removes their stale rows.

**After updating:** republish the elements that declare global tables, then run the
`public_tier` reconcile with apply to withdraw the rows of records deleted in the meantime.
A map that names a column existing in neither table is not written yet; `validate` lists it
as a `global_table_maps_unruled:` warning; the reconcile does not count its records as missing,
but still removes rows an earlier version left in that table.
