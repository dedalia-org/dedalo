---
title: "A field placed inside a `box elements` container of the ontology is no longer treated as a field of its section — deleting a record's data leaves it, and searches and lookups ignore it, as in v6."
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
- An archive of the section still includes the definition of such a field, because its values
  stay in the record and are archived as they are stored.
- A projects filter (`component_filter`) or a publication field (`component_publication`) placed
  inside such a container is not ignored silently: the section refuses to load with an error
  naming the node, because ignoring it would show every record to every user, or publish every
  record. Move the node out of the container.

Nothing stored is changed or removed by the update. A field that should belong to the section
must sit directly under the section or under one of its groups (section group, tab), not inside a
`box elements` node.

**Action needed:** none.
