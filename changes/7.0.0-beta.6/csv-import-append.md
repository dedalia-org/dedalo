---
title: The CSV import can now add a column's values to what a record already holds, instead of replacing them.
type: added
audience: user
date: 2026-09-27
wc: WC-2026-09-27-csv-import-append-mode
---
Until now every column of a CSV import replaced the component's data, and an
empty cell cleared it. Each mapped column now has a **Mode**: *Replace* (the
default, unchanged) or *Append*. In append mode the file's values are added
after the stored ones and nothing stored is changed: related records are added
next to the existing links, a geolocation cell becomes a **new map layer**, a
text becomes a new paragraph, and an empty cell leaves the record untouched.
Values already present are skipped and counted in the report, so importing the
same file twice adds nothing the second time. Components where adding has no
meaning — media, single-choice lists, computed values — refuse append before
anything is written. An append records the same Time Machine entry per language
as a replace import. See
[Adding instead of replacing](./using/tools/using_import_dedalo_csv.md#adding-instead-of-replacing).
