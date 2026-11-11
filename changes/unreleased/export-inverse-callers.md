---
title: Exports now include the records that point at each record (the Relations field), instead of an empty column.
type: fixed
audience: user
date: 2026-11-11
wc: WC-2026-11-11-export-inverse-callers
---
A field that lists the records pointing at the current one (the **Relations** field of the
*Section info* group, and any other field of that kind) always exported as an empty column, in
every format. It now exports its callers: in the **Standard** format one column with the ids of every calling
record; in the **Breakdown** format one column per calling field, and each caller gets its own
row (or its own `|n` column in the **Columns** mode), like any related item. Callers
you are not allowed to read are left out, exactly as in the record's edit view. The **Dédalo
(Raw)** format exports these calculated values too; the import tool skips them, since there is
nothing stored to write back. See [Exporting data](./core/exporting_data.md).

3D model fields also exported an empty column; they now export the file's address, like audiovisual
fields.
