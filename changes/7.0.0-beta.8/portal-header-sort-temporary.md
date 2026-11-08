---
title: Sorting a portal by a column header is now a temporary view; **Save** makes it the stored order.
type: changed
audience: user
date: 2026-11-01
wc: WC-2026-10-31-portal-order-model
---
Before, clicking the sort arrow of a portal column header (on columns configured with `sort_by_column`) reordered the linked records and saved that order at once. Now the click only changes how the list is shown: every page follows the chosen column and direction, and nothing is written. A line under the list shows the active order ("Order: <column> ↓") with two buttons: **Save** stores the shown order as the portal's order (recorded in Time Machine, as before), and **Reset** returns to the saved order. While a temporary order is shown, rows cannot be dragged; they can again after Save or Reset. Linking, unlinking or adding a record keeps the temporary order. Users with read-only access can sort the view and reset it, but not save it.

On a portal whose ontology declares a permanent order, the same line shows that order. A header click there still gives a temporary view with **Reset**, but no **Save**, and rows are never dragged: the declared order is applied automatically on every save.
