---
title: Checkboxes and radio buttons fill with a deeper orange so the white tick shows in every browser
type: changed
audience: user
date: 2026-10-15
---

A ticked checkbox or a picked radio button no longer depends on which browser you
use. The checked fill was the bright brand orange, and each browser picks the
tick's colour from it: Chrome and Edge drew a near-black tick, Firefox and Safari
a white one, so the same box disagreed from one browser to the next.

The checked fill is now a deeper Dédalo orange (`#db760f`), dark enough that every
browser draws the tick — and the radio dot — in **white**, and it clears the 3:1
contrast floor a checked control needs to read as checked. The app's own drawn
boxes in the dark theme take the same white tick. Unchecked boxes, focus rings and
the rest of the bright accent are unchanged.
