---
title: Thesaurus labels drawn from a linked term, a list value or the record id are no longer blank or truncated.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-10-section-terms-read-door
---
A section's display term can be built from a field that links to another record (for
example a catalogue entry labelled by its linked type), from a list value, or from the
record's own id. Those parts used to come out empty: such a record showed a blank label
wherever it was referenced — portal and autocomplete chips, the thesaurus tree, the graph
view, export parent chains, person and info tags — and a term combining several fields
lost the linked part. They now show the linked record's term, the list value or the id,
exactly as the field itself shows them, and a renamed linked record is reflected at once.
