---
title: Selects, radio buttons and check boxes offer only the options you may see, and the ones that fit the record.
type: security
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-datalist-principal-record-scope
---
The option list of a select, radio button or check box used to hold every record of its target section, whoever asked. Now it is the same search a list of that section runs for you: a user who is not a global administrator is offered only records of their own projects, and a per-user record allow-list narrows it for everyone. A stored value outside your scope shows no label.

A field configured to depend on the record (a `fixed_filter` reading the record's own data — for example, the milestones of the person the record names) now offers only the matching options, and a field configured with `filtered_by_search` is narrowed by that filter, as the ontology intended. See [component_select](./core/components/component_select.md).
