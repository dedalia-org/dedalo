---
title: MARC21 import reads its field map from the Tools configuration and applies every mapping rule and the Values form.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-marc21-config-map-and-transforms
---
Before, the MARC21 import refused on every installation with "Missing marc21_map", because it
looked for the field map in what the browser sent. Where it did run, it imported every
repetition of a field as a separate value, kept the catalogue's trailing punctuation
("Barcelona :"), stored a bracketed date "[1987]" as a number, skipped the multi-field
"Indexations" rule, never set the publication date, language or material type, and threw
away the values typed in the tool's **Values** form.

Now the import reads its map from the **Tools configuration** of `tool_import_marc21` (or,
when that has none, the tool's shipped default), and applies every rule of it: the first
repetition of a field unless the rule joins them all (`field_multiple`), the conditional
rules for copies, the trailing-punctuation clean-up, years (`date_format`), coded values such
as languages and material types (`dd_data_map`) and the companion fields (`dd_action`). The
values of the **Values** form are written into every imported record.

**Action needed:** none for the shipped map. A Tools configuration whose map carries a key the
import does not know, or a malformed rule, now stops the import with a message naming the
entry and the key — fix the entry. A year or code that cannot be mapped is listed per record
and that field is not written.
