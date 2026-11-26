---
title: An RDF property over a relation list may narrow the referencing records by section and by linking field (its `config`); such elements compile again.
type: fixed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-rdf-relation-list-config
---
An RDF property whose source is a relation list ("who points at this record") may carry a
`config` with `section_filter` (the sections whose records count) and `component_filter` (the
fields through which they must point). Such a property made the whole RDF element fail to
compile ("not ported"); it now publishes one value per referencing record that passes both
filters. A `config` on any other kind of source, or with other keys, is still refused with a
message naming the field, so nothing is published partially.

