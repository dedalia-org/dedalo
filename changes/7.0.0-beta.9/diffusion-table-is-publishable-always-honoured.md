---
title: "Publication: a table's `is_publishable` setting is honoured in every publication run."
type: fixed
audience: admin
date: 2026-11-22
---
A publication table whose ontology node sets `is_publishable` decides for all of its records:
`false` withdraws every record, `true` publishes every record whatever its publication field
says. Until now the setting was read only in the runs that happened to load the full ontology
tree; every other run ignored it and published the records whose publication field said yes.
It is now part of the compiled publication plan and holds in every run.

A value other than `true` or `false` (for instance the text `"false"`) now stops the publication
with an error naming the table node, instead of being ignored.

**Action needed:** none, unless a table node carries a non-boolean `is_publishable` — correct
it in the ontology.
