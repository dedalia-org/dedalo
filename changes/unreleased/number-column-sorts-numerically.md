---
title: Sorting a list by a number column orders the values numerically (2, 9, 10), not as text (10, 2, 9).
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-number-sort-numeric
---
Before, a list sorted by a number field (a diameter, a weight, a year) compared the
values as text, so 10 came before 2 and 100 before 20. Now the column sorts by the
number itself, ascending or descending. A value stored as text by an older version
sorts last instead of breaking the page.
