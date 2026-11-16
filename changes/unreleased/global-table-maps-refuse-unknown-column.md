---
title: A publication aggregate table whose column mapping names a column that exists nowhere is refused at validation instead of being silently left out; a column only a table alias carries is filled by the alias.
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-11-12-global-table-maps
---
An aggregate (global) table mapping (`global_table_maps`) that names a target column the
aggregate table does not declare, or a source column that none of the publishing tables carries,
now stops the element at validation with a message naming the column, the aggregate table's
columns and each publishing table with its columns. Before, the mapping was quietly not written
and only a warning said so, leaving the public search and map layers short of the rows the
ontology meant to publish. A source column that only a table alias carries is legal: the alias's
rows fill it, the real table's rows leave it empty.

**Action needed:** an installation whose ontology still maps `filter_date` onto `mdcat4500`
without declaring that column (mdcat260, mdcat1133, mdcat1332) needs the master ontology update
of 2026-11-13 before those elements publish again; the validation report names the column.

