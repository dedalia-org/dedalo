---
title: "Zotero import: a whole-number call number is the record number — checked, and refused when it would overwrite another reference."
type: changed
audience: user
date: 2026-11-18
wc: WC-2026-11-12-zotero-csl-json-import
---
Zotero has no identifier you can edit, so the record number of a reference is read from its
**Call Number** field (the `field_to_section_id` setting of the tool's configuration, shipped
as `call-number`). Earlier versions cast whatever was there to a number — `12abc` wrote record
12 — and overwrote the record without a check.

Now only a whole number written with digits (1 to 2147483647) is a record number:

- a record with that number exists → it is updated, and takes the reference's Zotero key if it
  held none;
- no record has that number → it is created with exactly that number — also when the record
  was deleted, so a reference imported by mistake can be deleted and imported again at the same
  number;
- no call number → the reference is matched by its Zotero key, as before.

A reference is **refused**, and nothing is written for it, when its call number is not a whole
number, when the record with that number already holds another Zotero key, when its Zotero key
is already held by a different record, or when an earlier reference of the same import carries
the same call number. The rest of the export is imported. The report lists separately the
records created at their call number, the records updated at it, and each refused reference
with its reason. Permissions apply as to any import: a record you may not edit is not written,
and creating one needs the permission to create in the section.

**Action needed:** none for the shipped configuration — but check the call numbers of a library
before importing it: a call number is the record that is written, and a record created by hand
that holds no Zotero key is updated by a reference carrying its number. A Tools configuration
whose `field_to_section_id` names `id` now stops the import with a message; name the Zotero
field that holds the record number, or remove the setting to match by Zotero key only. Details:
[Zotero import](./using/tools/using_import_zotero.md#choosing-the-record-number-the-call-number).
