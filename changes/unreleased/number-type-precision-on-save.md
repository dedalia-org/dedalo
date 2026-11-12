---
title: Number fields are now stored with the type and decimals their definition declares, whichever way the value arrives.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-number-type-precision-on-save
---
A number field defined as an integer (`type: int`) or with a fixed number of decimals
(`type: float`, `precision`) was only formatted while typing in the edit form. A value that
arrived any other way — a CSV or RDF import, the AI assistant, Propagate, an API call — was
stored exactly as sent: `3.14159` in a 2-decimal field, `3.7` in an integer field.

Now the server formats every value before storing it: an integer field drops the decimals
(`3.7` → `3`), a decimal field rounds half away from zero (`85.3568` → `85.36`,
`1.005` → `1.01`). The import preview shows the value that will be stored. A field with no
`type` is stored as given, as before. `0` is kept as `0` in the thesaurus order.

A field whose definition has a `precision` that is not a whole number (for example `"2"` in
quotes) is now reported as an ontology error: saving it is refused, and an import marks the
cell as failed.

Values already stored are shown as they were stored: values imported or written by the
assistant before this release may hold extra decimals, and changing a field's `precision`
does not change existing values. **Update cache → regenerate** on a section re-stores its
number values formatted.
