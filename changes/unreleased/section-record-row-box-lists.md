---
title: Section lists and portals now place their rows with the row box. Long lists stay fast, scrolling never loses an edit, and screen readers announce each list as a table or a list.
type: changed
audience: user
date: 2026-10-31
wc: WC-2026-10-30-section-record-row-box
---
Every section list, every portal view (default, content, line, tree, indexation, mosaic, and the list views) and the two tool mosaics (cataloguing, coin ordering) now draw one row per record, in order, through one shared engine. A page of more than 200 records keeps only the rows near the screen built. The others wait as empty, sized placeholders and are built when you scroll to them, so a "show all" page of 1000 records opens without freezing the browser. A row holding a value you typed but have not saved yet is never thrown away while you scroll. A page change, a filter or a reorder first saves what you typed. When it cannot save it, it asks before discarding, and Cancel leaves the list exactly as it was. When you print a long list, a note says how many rows were not printed (only the rows built on screen are). Use the print or export tool to get the whole list. Screen readers now announce list grids as tables, with a header row, and line, mosaic and tree views as lists. A portal row can be dragged by its handle, by touch with tap-to-pick and tap-to-place, or with the keyboard (Enter on the handle opens move-to-position).
