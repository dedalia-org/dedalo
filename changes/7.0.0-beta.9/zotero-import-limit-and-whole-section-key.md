---
title: "Zotero import: the highest record number is the only limit of a call number, a Zotero key is checked in the whole section, and you are warned about a record you may not change."
type: changed
audience: user
date: 2026-11-18
wc: WC-2026-11-12-zotero-csl-json-import
---
Three things change in how the Zotero import decides which record a reference is written to.

- **The limit of a call number is the highest record number.** A call number is taken as
  written up to 2147483647, the highest number a record can have; there is no lower bound. A
  whole number **above** it is refused, and the import now says so in a warning that names
  each such value and the limit — before, it was listed as "not a record number", which it
  was not.
- **A Zotero key is looked for in the whole section.** Before, the import only saw the records
  of your own projects: a reference whose key was already held by a record of another project
  was created a second time, or written at its call number, and the key then lived on two
  records. Now the key's record is found wherever it is. If it is another record than the one
  the call number names, the reference is refused and the report names both records by their
  number.
- **A record you may not change is named to you.** A reference that names such a record — by
  its call number, or because that record holds its Zotero key — is refused, nothing is
  written, and a warning lists the record numbers. Nothing the record holds is shown.

The warnings appear first in the report, in your language. Administrators, who may change
every record, see no difference beyond the first point.

**Action needed:** none. If an import warns about a record you may not change, ask whoever
manages that record for access, or ask them to import the reference. Details:
[Zotero import](./using/tools/using_import_zotero.md#how-a-reference-finds-its-record).
