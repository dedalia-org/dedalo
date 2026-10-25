---
title: Opening a record by link no longer lands on a one-row list.
type: fixed
audience: user
date: 2026-10-19
breaking: false
---
A link that names a record — `?tipo=<section>&section_id=<id>`, which is what the
inspector's **Local Ontology** pen, a list row's edit button and a job's record
link all produce — used to open the record as a **list of one**: the columns of the
section list, no edit form, no inspector. It now opens the record for editing, as
it did before the engine rewrite.

The cause was on the server: the first-boot request (`start`) received the record
id but described the page element in *list* mode, and the page then inherited that
mode into its own data request. A section link that carries a record id is now
always answered in **edit** mode, whatever mode the link asks for. Links to a
component or an area keep the mode they ask for.
