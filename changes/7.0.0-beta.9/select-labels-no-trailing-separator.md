---
title: Select options with a dataframe no longer end in a stray separator.
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter
---
A select whose configuration declares a dataframe slot (such as the uncertainty of a coin's discovery method) listed its options as "Metal detector | " — the slot was counted as a label part and contributed an empty value. The separator is gone; options read "Metal detector" in the edit form and in the list view. The dataframe itself is unaffected.
