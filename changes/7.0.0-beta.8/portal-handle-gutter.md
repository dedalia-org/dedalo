---
title: A portal row’s reorder handle is fully visible and grabbable again.
type: fixed
audience: user
date: 2026-11-04
breaking: false
---
A portal in edit mode whose rows can be reordered shows the drag handle in a
gutter at the left of the row. The list cut the left half of that gutter off at
its edge, so the handle was half hidden and a drag aimed at the cut part did
nothing at all. The gutter is now reserved inside the list, so the whole handle
is shown and a drag from it starts every time.
