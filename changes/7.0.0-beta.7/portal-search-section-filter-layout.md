---
title: The autocomplete options panel no longer clips its section list
type: fixed
audience: user
date: 2026-10-15
---
In a search or edit field that offers an autocomplete, the gear panel that lists
the searchable sections (and the related-record filters) laid its options out as a
two-column table. A long section name such as *Tipologías de ontología* or
*Causas de restauración* made that table wider than the panel itself, so the
right-hand column was cut off at the panel edge: some sections were half-visible
and, because the overflow was hidden rather than scrollable, some checkboxes could
not be reached to deselect them one by one.

The list is now a grid that fits the space it is given. It shows a single readable
column on a narrow field and two or more columns once there is room for whole
names, so no option is clipped and the panel stays inside its card.
