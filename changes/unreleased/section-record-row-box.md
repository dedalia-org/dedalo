---
title: The client ships the row-box module the section and portal lists will place their rows with.
type: added
audience: developer
date: 2026-10-30
wc: WC-2026-10-30-section-record-row-box
---
A new client module, `core/section_record/js/record_window.js`, places the rows of a section list or a portal: exactly one row node per entry, in order, so row *i* is always the *i*-th child of its list. Above 200 rows it keeps only the rows near the screen built and stands the rest in for empty, sized placeholders, and it never discards a row that holds an unsaved or uncommitted edit. It is also part of the files the browser pre-caches. Nothing renders differently yet: the list and portal views adopt it in a later change, which will describe what users see.
