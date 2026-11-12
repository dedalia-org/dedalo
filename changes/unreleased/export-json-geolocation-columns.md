---
title: JSON and geolocation columns are no longer blank in exports.
type: fixed
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-export-json-geolocation-cells
---
A JSON field or a geolocation field added to an export came out as an empty column, in every
format. The same fields were also blank in the relation list panel and the references list.

The cell now holds the field's value as JSON, one entry per stored value, separated by commas. A
geolocation cell holds the map view (latitude, longitude, zoom) and the drawn features. It does not
include the map's tile sources or its legend; the raw export format still carries those. Earlier
exports with these columns were incomplete: export again to get the values.
