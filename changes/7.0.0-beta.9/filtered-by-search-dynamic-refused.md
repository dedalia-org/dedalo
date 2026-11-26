---
title: The old `filtered_by_search_dynamic` option filter is no longer read; a field that still relies on it alone is refused.
type: removed
audience: admin
date: 2026-11-13
breaking: true
wc: WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter
---
The v5-era `filtered_by_search_dynamic` property, which narrowed a select's options by a value of the record being edited, is superseded by a `fixed_filter` of source `component_data` on the field's request configuration — the form every shipped ontology already uses. The engine does not read the old key.

**Action needed:** a field whose live definition still carries `filtered_by_search_dynamic` with neither a `fixed_filter` nor a `filtered_by_search` is now refused when its option list is built (the error names the field and the fix), rather than silently offering every record. Declare the `fixed_filter` translation, then remove the key. A field that carries both is served by the `fixed_filter`; the old key is ignored. No vendored ontology ships the old key on a live definition.
