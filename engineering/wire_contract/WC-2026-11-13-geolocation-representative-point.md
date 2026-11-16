# WC-2026-11-13-geolocation-representative-point — `get_geolocation_data` publishes a REPRESENTATIVE POINT for a non-Point geometry (PHP published the ring under `lon`)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C15 (`T1_owner_decisions.md`, 2026-11-13; item T1-5 §7):
  "representative point (centroid) + WC — current output is wrong data". Closes the question
  the 2026-11-12 addendum of `WC-2026-08-09-diffusion-degradation-and-loud-ddo-fns` left open.
  DEC-12 gate: `test/unit/diffusion_ddo_fns.test.ts` (`get_geolocation_data` block: Polygon
  centroid incl. an L-shape that defeats a vertex average, MultiPolygon largest ring, LineString
  path midpoint, degenerate → bbox centre, no numeric position → null, Point control).
- Code: `src/diffusion/resolve/ddo_fns.ts` `flattenLayerFeatures` / `representativePoint`.

## Shape before (PHP = TS until today)

`component_text_area::build_geolocation_data(false)` (:1771-1782) flattened every feature to
`{type, lon: coordinates[0], lat: coordinates[1]}` whatever the geometry type. For a Point that
is the position; for a Polygon `coordinates[0]` is the OUTER RING (an array of positions) and
`[1]` the first hole (usually absent): the published cell carried
`{"type":"Polygon","lon":[[0,0],[1,0],…],"lat":null}` — a list under a scalar key, which the
public map layer could not place. MultiPolygon / LineString likewise.

## Shape after (TS)

| geometry | published `lon` / `lat` |
|---|---|
| `Point` | `coordinates[0]` / `[1]` VERBATIM (no number formatting, strings as stored) — unchanged |
| `Polygon` | the area centroid of the OUTER ring (shoelace formula; holes ignored) |
| `MultiPolygon` | the centroid of the LARGEST outer ring (by absolute area) |
| `LineString` | the midpoint OF THE PATH (the position half the path's length along it) |
| a degenerate ring/path (zero area / length), `MultiPoint`, `MultiLineString`, any other type | the centre of the bounding box over every numeric position |
| no numeric position at all | `null` / `null` (never a fabricated `0,0` — the GEO LAW of WC-2026-08-08) |

`type` is always the geometry's own type, verbatim. `text` stays `''`; the layer shape, the
no-fallback rule and `get_geojson_data` (layers VERBATIM) are untouched.

## Reason

The flat cell exists to place the record on a map: a ring under `lon` is not a place. The
centroid is the conventional representative point of an area; the path midpoint keeps a route's
marker ON the route. Both PHP engines published the ring. Repair on an install: republish the
elements carrying `get_geolocation_data` columns.

## Gate reconciliation

No frozen fixture replays `get_geolocation_data` with a non-Point geometry (the harvested mints
layers are Points, byte-identical before and after). The Polygon pin of `diffusion_ddo_fns`
("lon = the outer ring, lat = null, PHP parity") is REPLACED by the C15 matrix — a contract
edit, this entry.
