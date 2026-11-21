---
title: A text field cleared in every language is stored as absent, not as an empty item.
type: changed
audience: admin
date: 2026-11-21
wc: WC-2026-11-21-empty-literal-stored-absent
---
Clearing the last value of a text field (input text, text area, e-mail, IRI) used to leave an
empty item behind in the record, so the record still "had" the field: a search for records
*without* a value could miss it, and exports carried an empty cell item. The field is now
removed from the record when no language holds a value, as version 6 did; a translation cleared
beside a language that still has text is kept as before, so its fallback keeps working. The
frames (dataframe values) paired with an item removed this way are removed with it, and the Time
Machine records the field becoming empty.

Records saved before this change keep their empty items until they are next saved; every reader
already treats them as empty.
