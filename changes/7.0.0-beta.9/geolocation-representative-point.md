---
title: A published geolocation column places an area or a route at one representative point instead of publishing the whole outline under the longitude.
type: fixed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-geolocation-representative-point
---
The flat geolocation column of a text field's geo tag (`get_geolocation_data`) publishes one
`{type, lon, lat}` per drawn feature. For a point that was right; for a polygon or a line the
engine copied the outline's first ring under `lon` and nothing under `lat`, so the public map
could not place the record. A polygon now publishes the centre of its outer ring (a multipolygon
its largest ring), a line the midpoint along its path, and anything else the centre of its
bounding box; the geometry type is kept. Points are unchanged.

Republish the elements carrying such a column to refresh the public tables.

