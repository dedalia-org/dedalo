---
title: Sorting a list by a number or JSON column orders by its value again.
type: fixed
audience: user
date: 2026-11-12
---
Clicking the header of a number column (a weight, a diameter, a year) or of a JSON column in a
list, or any search ordered by such a field, came back in record-id order instead of by the
field's value — also when the field was reached through a portal. These fields now sort by
their value again, with empty values last. As in earlier versions of Dédalo, the values are
compared as text, not as numbers: 9, 10 and 2 sort as 10, 2, 9. Text columns are unchanged.
