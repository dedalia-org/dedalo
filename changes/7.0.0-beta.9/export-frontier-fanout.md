---
title: Exports no longer include linked records outside your projects.
type: security
audience: user
date: 2026-11-09
breaking: false
wc: WC-2026-11-09-export-frontier-fanout, WC-2026-11-09-implicit-children-frontier-predicate
---
An export follows the links of each record: the records a field points to, the records those
records point to, their frames, their thesaurus parents and their media files. Before, only the
first link was checked against your projects. A record outside your projects two links away could
appear in an export, while the same record reached directly was refused.

Every linked record is now checked, at every depth and in every export format. If a column would
include a record you cannot open, the export stops and names that column. Remove the column or ask
an administrator. Administrators are not affected.

A relation without a configured list of fields shows its target's label fields. Those you have no
permission to read are now left out of the export, and the rest still export. The project selector
now shows the project names to every user who may set a project.
