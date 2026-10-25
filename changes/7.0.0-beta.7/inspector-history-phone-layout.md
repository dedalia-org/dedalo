---
title: Inspector history panels read as blocks on a phone or tablet
type: fixed
audience: user
date: 2026-10-19
---

Below the desktop break the inspector drops its rail and renders inline, where
*Latest changes* and *Component history* kept a narrow multi-column table shape
designed for the side panel. The column labels were squeezed into 15px-wide
strips (one letter per line) and the values were pushed out of their cells.

Each history entry is now one block: the date (orange) and author on the first
line, what changed next, and the snapshot value last, separated by a hairline.
The desktop side panel is unchanged.
