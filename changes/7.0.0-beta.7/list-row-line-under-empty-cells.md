---
title: The line under a list row is unbroken across empty columns
type: fixed
audience: user
date: 2026-10-18
---
A list row draws its separator as a 1px line under each cell. A cell that held no
value was given a zero width, so it painted no line: in a relation table the
separator stopped where the record's first empty column began, and the row read as
if it ended there.

An empty cell now keeps the width of its column, so the line continues to the end
of the row. No column moves: the column widths come from the grid, not from the
cells.
