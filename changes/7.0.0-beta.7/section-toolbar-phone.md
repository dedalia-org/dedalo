---
title: On a phone, the section list buttons and their show/hide arrow no longer overlap or jump around.
type: fixed
audience: user
date: 2026-10-17
---

The list toolbar of every section has a small arrow that shows or hides the row of
action buttons (New, Delete, Tools). On a phone the action row used to wrap onto its own
line and push that arrow onto a **third** line, alone and stuck to the left edge, while
the collapsed state kept it on the right of the search row — so the arrow jumped across
the screen as the row was shown or hidden.

Now the arrow keeps the right edge of the search row in both states, the action buttons
keep their own full row underneath, and the arrow is a normal (no longer rotated) button
that is big enough to tap comfortably. On a desktop nothing changes.

Screen readers also get the state of that button (`aria-expanded`) and the region it
controls (`aria-controls`), which they did not before.
