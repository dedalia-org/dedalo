---
title: A user who may write a relation field can now search and pick its target records without a read grant on the target section.
type: security
audience: admin
date: 2026-11-04
wc: WC-2026-11-04-writer-chain-scoped-search, WC-2026-11-04-tree-picker-read-gate-retired
---
This changes what a profile's grants allow. Until now, filling a portal or autocomplete field, or picking a term in the thesaurus tree picker, needed a read grant on the section the field points at. Now a write grant on the field itself is enough to search and pick its target records, when the field's configuration declares the columns it shows from that target. The user sees only the columns the field declares, and only within the chain of fields that leads to it, which the server verifies. They get no other access to the target section: opening its records or listing it still needs a read grant. A field shown in those columns that itself links to a third section shows only what the user may read there. A thesaurus search now skips the sections the user cannot read, and is refused when none is left. Review your profiles if a writer of a relation field must not see the target's declared columns, and remove the write grant on that field where needed.
