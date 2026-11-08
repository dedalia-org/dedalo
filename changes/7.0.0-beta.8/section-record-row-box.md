---
title: Section lists, portals and the tool mosaics place their rows through one client module, the record window, with a fixed row DOM contract.
type: added
audience: developer
date: 2026-10-30
wc: WC-2026-10-30-section-record-row-box
---
A new client module, `core/section_record/js/record_window.js`, places the rows of every section list, every portal row view and the two tool mosaics, through one door, `window_section_rows` in `section.js`. Code that renders or reads list rows can rely on this contract (see [The row box](./core/sections/section_list.md#the-row-box)):

- `content_data.children` holds exactly one `.section_record` per entry, in order: `children[i]` is row *i* with `data-index="i"`, at every page size, 0 included. Nothing else goes into `content_data`. A "no records" node, a footer, back-references, the print notice and a portal's order indicator go into the one `.list_after` sibling (hand it over as `content_data.list_after`; `common.js` `place_list_after` places it).
- Table views mark their `list_body` with `layout_table`: header, `content_data` and every row are column subgrids with table roles, so each row is one box.
- Above 200 rows only the rows near the screen are built; the rest are childless placeholders (`.section_record.placeholder`). Find a row with `content_data.children[i]` or `row_of()`, and its entry with the window's `entry_of(i)` — never a node map of your own. `caller.ar_instances` holds the built rows only.
- Row gestures are delegated: one listener set per `content_data`, bound to the window's `signal` (`bind_row_drag`, `bind_tool_row_drag`, `delegate_row_hover`), never a listener per row.
- Any operation that replaces rows takes the owner row lock first (`common.js` `lock_rows`), which commits typed-but-uncommitted values and asks before discarding one.
- A portal reorder sends absolute keys: `paginated_key` is the index in the stored array; never add the paginator's offset.

The module is also part of the files the browser pre-caches.
