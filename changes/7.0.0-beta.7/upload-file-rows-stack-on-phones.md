---
title: Uploaded-file rows stack on a phone instead of running off the side
type: fixed
audience: user
date: 2026-10-17
---

The file rows in **Tools → Import files** (and in the MARC 21 and Zotero importers, which use the same upload widget) were laid out as a single desktop row — a thumbnail, the filename, the file's two option menus and its Start / Cancel / Delete controls side by side. On a phone that row is wider than the screen, so the part past the right edge was simply not there: the row's menus and its Delete and Cancel controls could not be reached at all, and a long filename was squeezed into a column so narrow it broke one letter per line.

Each uploaded file now takes its own block on a phone: the thumbnail, then the filename and size, then the file's option menus full width, then its controls, one under the other. Nothing runs off the side, and every control is on screen.
