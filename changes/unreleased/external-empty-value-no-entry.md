---
title: An empty Zenon field no longer shows a blank column.
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-external-empty-entry-dropped
---
When a Zenon record has nothing in a field (for example no publication date, or no
authors), the search results, the record and the list columns showed an empty column
framed by its separators (`| |`). The empty field is now simply left out, as in v6, and
an export leaves the cell empty (null) instead of writing an empty text.

An authors value Zenon sends in an unexpected shape is no longer shown blank or as
numbers: it is left out and the field is marked as partially unavailable.
