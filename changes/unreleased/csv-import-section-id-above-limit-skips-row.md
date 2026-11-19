---
title: "CSV import: a record number above the limit skips only its row."
type: fixed
audience: user
date: 2026-11-18
wc: WC-2026-08-27-csv-ingest-refusals
---
In **Import CSV**, a row whose `section_id` was a whole number above 2147483647 — the highest
record number Dédalo holds — made the whole file fail: no row of it was imported, not even the
valid ones, and the report showed a message from the database
(`value "2147483648" is out of range for type integer`).

Now only that row is skipped. The report names it, with the value and the limit — for example
`Row 3: SKIPPED — the section_id cell is '2147483648', which is above the highest record number (2147483647)` —
and every other row of the file is imported. The check step reports the same row before
anything is written.

**Action needed:** none. Details: [CSV import](./using/tools/using_import_dedalo_csv.md).
