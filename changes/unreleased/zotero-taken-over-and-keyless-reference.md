---
title: "Zotero import: a record taken over by a reference is listed apart, and a reference without a Zotero key that names another reference's record is refused with an explanation."
type: changed
audience: user
date: 2026-11-18
wc: WC-2026-11-12-zotero-csl-json-import
---
Two things change in the report of the Zotero import. What the import writes does not change.

- **Taken over — the record had no Zotero key.** When a reference's call number names a record
  that exists but did not belong to any Zotero reference yet (one created by hand, for
  instance), the record is written with the reference's values and holds its Zotero key from
  then on — as before. The report now lists these records under their own heading, apart from
  the records created and the records updated, and the summary counts them apart ("1 taken
  over"), so you can check that each one is the record you meant.
- **A reference without a Zotero key.** A reference that carries no Zotero key and whose call
  number names a record that already belongs to a Zotero reference is still not imported —
  the import cannot tell whether it is the same reference. It is now explained: the refused
  line and a warning, in your language, name the record by its number, say why, and say what
  to do — export the reference from Zotero again so that it carries its key, or remove its
  call number to create a new record. Nothing the record holds is shown.

These rules, like the call-number limit, belong to the Zotero import only: the CSV import
reads and writes its `section_id` column exactly as before.

**Action needed:** none. Details:
[Zotero import](./using/tools/using_import_zotero.md#a-reference-without-a-zotero-key).
