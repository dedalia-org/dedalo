---
title: Three sections with ontology defects now open, or say clearly why they cannot.
type: fixed
audience: user
date: 2026-10-28
wc: WC-2026-10-28-section-definition-defects
---
The Ontology and Ontology commons lists (in Development) failed to open on development servers and showed an empty column elsewhere, because their column list includes a program label. Labels are no longer treated as columns, so both lists open.

The Text structuration list (in Auxiliary) failed with an internal error. Its definition points at a table from Dédalo 6 that version 7 does not have. It now shows the message that an ontology definition is unusable, which is the real cause. The section is marked deprecated in the master ontology and no longer points at that table; installations receive the change with their next ontology update.
