---
title: Information fields (calculated widgets) are published and exported with their current value.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-info-live-publication-export
---
Publication columns that read an information field — for example the weight and diameter
totals of numismatic coin types — were published empty on every record. They now publish what
the field shows in the record today.

**Export** now includes information fields too. In **value** format the column holds every
result of the field. In **grid value** format each result the field declares gets its own
column, named after it. In **Dédalo raw** format the cell holds the values computed now; an old
stored copy is never exported.

**Action needed:** publish again the tables that carry information-field columns. Nothing in
the database needs repairing.
