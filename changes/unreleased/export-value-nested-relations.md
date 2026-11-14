---
title: Exports in the Standard format follow each column's configured fields and separators, and relation columns that came out blank now carry their values.
type: fixed
audience: user
date: 2026-11-11
wc: WC-2026-11-11-export-value-single-walker
---
A relation column in the **Standard** export format used to show the related record's own default
fields, not the sub-fields configured for that column, and ignored the separators configured for
it. It now exports exactly the configured sub-fields, joined with the configured separators, the
same way as the **Breakdown** format. A related record whose value is empty — an image not yet
uploaded, an empty text — keeps its place between the separators (and its own row in the
**Breakdown** format), so the pieces of a cell still line up with the related records.

The **Projects**, **Publishable**, **Language**, **Parent**, **Children**, **Related** and
**Index** (indexations) fields used to export as empty cells, and showed blank in the panels that
list a record's relations (for example the references panel). They now show their values
everywhere. In the **Breakdown** format, several values in one cell are now joined with the
field's own separator (for example `, ` between numbers).

Past exports were incomplete, not wrong: run the export again to get the full values. See
[Exporting data](./using/exporting_data.md).
