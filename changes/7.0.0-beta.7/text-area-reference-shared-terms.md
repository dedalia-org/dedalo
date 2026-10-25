---
title: A text area reference can link the same term from several references, and deleting a reused reference keeps the others linked.
type: fixed
audience: user
date: 2026-10-21
---
In the reference picker of a text area, giving a second reference a term that another reference already used was refused as a duplicate, yet the reference was still written into the text, pointing at a link the database never saved. The same term can now be linked from any number of references.

Opening an existing reference (or draw tag) showed an empty *New tag* field instead of its current term, and pressing *Apply* there deleted the link of the reference. The picker now shows the current term, and *Apply* without changes keeps it.

Reusing a reference (the *Reuse tag* list) is also clearer and safer: each entry shows its tag number and an icon, selecting one shows its term in the *New tag* field, and deleting or moving one of several text fragments that share a reused reference no longer unlinks the term the other fragments still point at. A reused reference also takes the label of the reference it reuses.

Draw tags: *Apply* in the draw tag picker saves the chosen term again (it failed before), and *Delete* no longer fails on a record without draw links.
