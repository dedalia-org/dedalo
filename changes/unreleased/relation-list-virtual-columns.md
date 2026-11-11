---
title: The References panel and delete dialogs show the columns of thesaurus terms and other virtual sections again.
type: fixed
audience: user
date: 2026-11-10
---
When a record is referenced by a record of a virtual section — every thesaurus term, and
sections such as the ones built on Images, Audiovisual or Documents — the **References** panel
of the inspector, the delete dialog and the "who points at me" lists of the transcription,
indexation and print tools showed only the record id for those references. They now show the
same columns as the section they are built on, unless the virtual section defines its own
list of columns.

When a section defines more than one list of columns, the first one in ontology order is now
always used.
