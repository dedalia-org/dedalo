---
title: Related-records columns show their values in lists and in the record history.
type: fixed
audience: user
date: 2026-11-10
breaking: false
wc: WC-2026-11-10-related-list-cells, WC-2026-11-10-tm-subject-cell-page
---
A "related records" field (component_relation_related) shown as a list column was blank, or
showed only the related record's id: the server sent the id instead of the fields the column
is configured to display. Lists, the Time Machine history list and nested cells now show those
fields, like any other relation column; a Time Machine history row shows up to 10 values of its own
field, not just the first. Nothing is written or changed in your data. AI search
indexes built before this change keep the old (empty) text for these fields until reindexed.
