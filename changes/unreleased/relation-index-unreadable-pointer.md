---
title: A record that points at a term from a section you cannot read shows its section name and id, in the edit form, in panels and in exports.
type: changed
audience: user
date: 2026-11-11
wc: WC-2026-11-09-export-frontier-fanout, WC-2026-11-11-relation-index-related-list-context
---
Indexation fields (the fields that list the records pointing at a record) always list every
pointing record. A pointing record from a section you may not read is shown with its section's
name and its id, and nothing else. This now applies to every indexation field, including those
with their own configured columns, and in the panels and exports too: an export writes
the section name followed by the id for such a record, and the export does not stop.
Translatable columns of the pointing records now show the text in your data language instead of
an empty cell.
