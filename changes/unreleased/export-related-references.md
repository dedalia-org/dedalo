---
title: Exports can include the calculated relations of a related-terms column, in a column of their own.
type: added
audience: user
date: 2026-11-11
wc: WC-2026-11-11-export-related-references-column
---
A **Related** column exports the relations stored on the record. A related-terms field that works
in both directions also shows the terms that point at it; those are calculated, not stored, and
were never exported. A new per-column **references** checkbox in the export tool, offered only on
those fields, adds a sibling
column, headed with the column name followed by *references*, with those calculated relations only, never repeating the stored
ones. It works in the **Standard** and **Breakdown** formats; the **Dédalo (Raw)** format exports
stored data only, so the checkbox is disabled there. Presets keep the choice. See
[Export](./tools/using_export.md).
