---
title: List headers stay readable in Safari, even when rows have different heights
type: fixed
audience: user
date: 2026-10-18
---

In Safari, after paging through a list whose rows have different heights (for example the interviews list, with its identifying images and information widgets), the column headers could collapse into a thin, clipped strip and the first rows below them were hard to read. The header cells no longer let Safari recompute the header height from the data rows after a page change, so paging, sorting and late-loading widgets leave the header intact in every page.

No action is needed on update.
