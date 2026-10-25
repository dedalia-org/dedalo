---
title: Mosaic hover: the record id is no longer cut off, and the publication switch is centred
type: fixed
audience: user
date: 2026-10-18
---
Hovering a mosaic tile in edit mode shows a small overlay on its top-left corner:
the record id with its pen, and — in portals that carry one — the publication
switch on the other side. Two things were wrong there.

The id chip was a fixed cell, narrower than an id of five or more digits, so the
leading digits of the number were cut off by the tile's edge: `104299` read
`04299`. The chip is now as wide as the id it holds, so the number is whole.

The publication switch sat slightly left of and above the middle of its cell.
Its value is centred in the cell now, so the switch rides the tile's corner
evenly, and the id chip's own drag handle stays where it was: a band under the
chip, revealed when you hover it.

Nothing else moved: tile size, the record's image, the pen, the switch's colours
and every other control are the same.
