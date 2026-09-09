# leaflet-imageoverlay-rotated (vendored)

`Leaflet.ImageOverlay.Rotated` — an `L.ImageOverlay` positioned by THREE corner
points (top-left, top-right, bottom-left) instead of a bounding box, rendered
with a CSS affine transform.

| | |
|---|---|
| Upstream | https://github.com/IvanSanchez/Leaflet.ImageOverlay.Rotated |
| Version | 0.1.4 (`bower.json` in the v6 vendor copy declares `0.0.0`; the file is upstream's last release) |
| License | Beerware (see `LICENSE`) — permissive, but NOT one of the usual OSI names: flagged for the Ágora thread, `docs/PREGUNTAS_FORO.md` |
| Source of this copy | `tool_leaflet_special_tools/external-lib/Leaflet.ImageOverlay.Rotated/` (the v6 tool's own vendor dir) |

**Why three points and not a bbox.** A GeoTIFF is georeferenced in a PROJECTED
CRS (UTM here). Its footprint reprojected to WGS84 is a slightly rotated,
slightly skewed quadrilateral — never an axis-aligned lat/lon rectangle. A
plain `L.imageOverlay(url, bounds)` would stretch the image onto the bbox and
misplace every pixel inside it. This is needed for a plain upload, before any
"reposition/rotate by hand" feature exists.

**One deliberate difference from the v6 copy**: v6 wrapped the whole file in a
silent `try { … } catch(e){}`, so a load failure left `L.imageOverlay.rotated`
undefined with nothing on screen and nothing in the console — the same silent
swallow the audit lists as bug #3 (`docs/Funcionalidades de
tool_leaflet_special_tools.md`, "Bugs"). Removed here: the loader
(`image_upload.js` `load_rotated_overlay`) rejects loudly instead.
