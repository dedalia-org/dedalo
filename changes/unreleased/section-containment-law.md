---
title: "A field placed inside a `box elements` container of the ontology is no longer treated as a field of its section — deleting a record's data leaves it, and searches, lookups and archives ignore it, as in v6."
type: changed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-section-containment-law
---
In the ontology, a `box elements` node (and the older `dataframe` and
`component_relation_struct` nodes, which behave as one), a `component_semantic_node` or an area
placed inside a section is not part of that section's fields, and neither is anything under it.
The edit form never showed such a field. Until now, other parts of the application still counted
it as a field of the section; they no longer do, which is how v6 worked:

- **Delete data** (empty a record, keep it) leaves the values of such a field in the record. They
  are not removed.
- A search for "any related record" of the section no longer looks into such a field.
- A new record gets no default value for such a field.
- An archive of the section no longer includes the definition of such a field (the record values
  are archived as they are stored).

Nothing stored is changed or removed by the update. A field that should belong to the section
must sit directly under the section or under one of its groups (section group, tab), not inside a
`box elements` node.

**Action needed:** none.
