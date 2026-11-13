---
title: A selected value you may not see, or that no longer fits the record, now shows as *(restricted)* instead of vanishing.
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter
---
Since the option lists of selects, radio buttons and check boxes became the search you are allowed to run (and, where configured, the options that fit the record), a value stored on the record but outside your list simply disappeared: no label in the list view, no option in the edit form — and a save of that field would have dropped it without anyone noticing.

Now such a value stays visible as an opaque *(restricted)* entry: the edit form keeps it selected under that label and the list view shows *(restricted)* in its place, so you know something is there without being told what. Its real label is never shown. A stored value whose target record has been deleted still shows nothing, as before. See [component_select](./core/components/component_select.md).
