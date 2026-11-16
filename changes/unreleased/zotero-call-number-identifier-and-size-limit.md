---
title: "Zotero import: the call number identifies the record instead of numbering it, and an export over 64 MB is refused."
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-11-12-zotero-csl-json-import, WC-2026-11-13-csv-ingest-size-ceiling
---
The Zotero **call number** (the `field_to_section_id` variable of the tool's configuration)
was a record number in earlier versions — a typo overwrote an unrelated record — and since the
import was restored it was neither stored nor applied, with a notice per reference.

Now it is an identifier, when the configuration names one: it is stored in the field the
configuration binds it to, and a re-import first looks for the record that already holds it. Found → that record is updated
(and now also carries the Zotero key); not found → the Zotero key decides, or a new record is
created holding both. A call number held by two records, repeated on two references of one
export, or pointing at a different record than the reference's key refuses **that reference
only**, listed under the file errors; the rest of the export is imported.

An export larger than 64 MB — the same limit as a CSV import — is refused when the import
runs, with a line naming the file, its size and the limit, and is left where it was staged.
Export the library in parts.

The configuration shipped with Dédalo now names **no** such identifier: the Publications
section has no call-number field to hold one (the earlier default pointed the call number at a
node that is not a field, so every reference carrying one was refused), and the Zotero key alone
identifies a reference. A call number in the export is listed once under notices.

**Action needed:** none for the shipped configuration. A Tools configuration whose
`field_to_section_id` names a Zotero field the map does not bind, or binds to a field that holds
no text, now stops the import (or refuses that reference) with a message naming it — bind the
field to a text or URL field of the section.
