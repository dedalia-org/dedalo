---
title: JSON and geolocation columns are no longer blank in exports.
type: fixed
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-export-json-geolocation-cells
---
A JSON field or a geolocation field added to an export came out as an empty column, in every
format. The same fields were also blank in the relation list panel and the references list, and in
any label built from them: a thesaurus or section term, or a linked record's label, that names such a
field now shows its JSON instead of leaving that part out.

The cell now holds the field's value as JSON, one entry per stored value, separated by commas.
Each entry is valid JSON that reads back to the stored value: a `/` is written `\/` and an `&` is
written `\u0026`, so the cleanup that turns rich text into plain text in the same export leaves
it untouched. A geolocation cell holds the map view (latitude, longitude, zoom) and the drawn features. It does not
include the map's tile sources or its legend; the raw export format still carries those. Earlier
exports with these columns were incomplete: export again to get the values.
