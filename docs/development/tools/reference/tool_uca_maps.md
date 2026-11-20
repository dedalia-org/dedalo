# tool_uca_maps

Cartography toolkit for the map component (`component_geolocation`): an object console (measures,
style, centroid, uncertainty, properties, PDF, associated images), user XYZ/WMS layers saved in the
record, a manual legend, Catastro and administrative units, vector and image upload with
server-side reprojection, vector/raster downloads, place search, browser geolocation and three
Roman-world gazetteers. A native port of the previous version of the tool
(`tool_leaflet_special_tools`).

## What it does / why & when to use it

`tool_uca_maps` adds one toolbar button and one panel per feature to a **live** map component. Most
of the work happens in the browser on the component's own Leaflet map; the server does only what a
browser on a Dédalo page cannot: run GDAL/ImageMagick, read a third party's replies
(`connect-src 'self'`), read local gazetteer data, and fetch a URL the user typed through the
engine's guarded doors.

Use it on any section whose map holds archaeological sites, monuments or other places that need
real GIS work: loading a surveyor's shapefile, placing a georeferenced plan over the basemap,
drawing an uncertainty area, exporting an object to QGIS, or looking up the cadastral parcel under a
point.

Key behaviours to know:

- **No action writes section data.** Thirteen of the eighteen actions are `readOnly` and write only
  a private scratch directory. The map's data is written by the component's own save path, never by
  a tool action. `raster_download`, `vector_download` and `object_pdf_report` also delete the payload
  they were sent through the upload door (the map capture, the object's GeoJSON: a real one outgrows
  a request's options), and `upload_vector_layer` the user's file it converts, so they are not
  `readOnly`. `stage_external_image` stages a downloaded file for the standard
  image ingest and is gated at write level.
- **Nothing is saved on pan, zoom or a drawing gesture.** A gesture marks the component dirty and the
  component's save button commits it. Adding or deleting an XYZ/WMS layer is itself the commit
  ("Add and save"): the tile proxy can only serve a source the server has numbered, and that save
  sends the whole entry buffer, pending drawings included.
- **User layers and the legend live in the record**, as the geolocation entry's `sources` and
  `legend`, and the component draws them through core's tile proxy. A WMS layer's opacity is a
  session setting: the stored source schema is closed (`id, type, url, params, attribution`,
  `SOURCE_KEYS` in `src/core/geo/map_source.ts`).
- **Every fixed public service goes through core's closed table** (`src/core/geo_services/`), asked
  by id and parameters, never by URL: Catastro, IGN administrative units, Open-Elevation, Nominatim,
  DARE. A URL the user typed (a WMS server, a linked image) and the Pleiades place documents go
  through `harvestFetch` (`src/core/harvest/`). The tool holds no outbound door of its own.
- **Every binary runs through `runBinary`** (`src/core/media/engine/spawn.ts`): an argv array, no
  shell, a 60 s bound, offline (no proxy, no PROJ network), a private scratch directory per call,
  and the input driver always named (`-if`). Exit 0 without the promised file is a failure.
- **Catastro and administrative units are laid over the basemap**, not swapped for it (both WMS are
  transparent). When the component configures the source, the button ticks the checkbox core
  already offers for it instead of adding a second layer.

## How it works

### Server

`tools/tool_uca_maps/server/index.ts` declares eighteen actions, a `reasonKeys` list
(`server/reasons.ts`: every refusal carries a `reason_key` whose label the client shows), an
`isAvailable` hook (`callerModel === 'component_geolocation'`) and an `onBoot` hook
(`startScratchSweep`, `server/gdal.ts`).

**Diagnostics.** `get_capabilities` probes `gdalinfo`, `ogr2ogr` and `gdal_translate` on `$PATH`
(GDAL 3.2 at least: below it every action would fail on `-if`), core's resolved ImageMagick, the
gazetteer store, and the `external_images_enabled` option. It never throws: a failed option read is
logged and reported as off. The client greys out what the install cannot serve.

**Scratch and binaries** (`server/gdal.ts`). `withScratchDir` creates a `scratch_*` directory
under `<media root>/<upload tmp subdir>/tool_uca_maps/` (the media volume, never the OS temp
directory) and removes it in a `finally`. `runToolBinary` wraps `runBinary` with that directory as
`CPL_TMPDIR`/`TMPDIR`, the offline environment and `assertSpawnOk`. `startScratchSweep` removes
orphaned scratch directories idle for an hour, at boot and then hourly. GDAL is looked up on `$PATH`
(core has no config key for it); ImageMagick goes through core's resolver
(`src/core/media/engine/binaries.ts`).

**Downloads.**

- `vector_download`: SHP or KML of one object (GeoJSON is built in the browser). One `ogr2ogr` call;
  the input is Leaflet's WGS84 GeoJSON, labelled `EPSG:4326` with `-a_srs` (an assignment, no
  reprojection). A GeoJSON `crs` that GDAL would fetch is refused first (`assertOfflineGeoJsonCrs`).
- `raster_download`: the map image as JPG, GIF or WebP (ImageMagick) or GeoTIFF (GDAL). PNG is
  produced in the browser. The browser stages its PNG capture through the upload door (key_dir
  `uca_maps_map_image`: a real map is larger than a request's options may carry) and sends, for a
  GeoTIFF, the view's corners already in EPSG:3857 metres, so `gdal_translate -a_srs EPSG:3857
  -a_ullr` georeferences without a resampling `gdalwarp`. The action deletes the capture it read
  (and the caller's captures over an hour old), so it is not `readOnly`.
- `image_download`: an uploaded image in its current placement, without the display opacity, as
  GeoTIFF, PNG or JPG. The served file is warped into EPSG:3857 with its three corners as control
  points; `width` is a quality factor over the on-screen size. A CMYK source is refused with a reason.
- `object_pdf_report`: the selected object's properties, its geometry in EPSG:4326 and EPSG:3857,
  the elevation the console already shows, and up to 30 associated images. Written by the tool's own
  writer (`server/pdf_writer.ts`, no external script). Images are named by record identity only,
  each one passes the same `record_tipo` read gate as `get_image_file`, and a refused or
  non-embeddable image is named in the document instead of failing it.

Every download answers `{content_base64, filename, mime}` (`server/download_answer.ts`). The
download name is sanitized on the server by the same rule the browser runs
(`js/download_filename.js`); it never becomes a path.

**Vector upload.** `upload_vector_layer` reads a file the browser already staged through core's
upload door (`file_data.tmp_name` under key_dir `uca_maps_vector`, resolved inside the caller's own
staging directory) and deletes it, converted or refused, with the caller's uploads over an hour old.
It accepts `.zip` (shapefile), `.geojson` and `.kml` up to 10 MB, checks a zip's inflated size
before GDAL opens it (200 MB), and parses a GeoJSON as strict JSON (a lenient file is refused). A
GeoJSON's bytes go through core's ingest decoder (`decodeIngestBytes`): one that is not UTF-8 is read
as windows-1252 and the answer says so (`read_as`, which the panel shows as a warning to check the
texts); a binary file, or one already carrying U+FFFD, is refused. One
`ogr2ogr` reprojects to WGS84 GeoJSON. A file without a CRS of its own takes the user's EPSG (and,
for a UTM code, its zone and band, checked against the code's own PROJ string); a file that declares
one refuses the fields; a GeoJSON `crs` link is never followed. The output is checked to be
longitude/latitude and split into one feature per part (`explodeToSingleParts`), each part keeping
the whole feature's properties, so the console can measure and style every part.

**Images.** An uploaded image becomes an Image record (`rsc170`, core section; image component
`rsc29`) through the engine's own `create` and the `tool_upload` ingest. The tool then asks:

- `get_image_overlay`: where the image goes. `gdalinfo -json` reads the georeference from the
  **master** TIFF (the served JPEG derivative carries no CRS) and answers the three corners
  `js/rotated_image_overlay.js` takes (a reprojected rectangle is a skewed quadrilateral, not a
  bbox). A JPEG's EXIF GPS position is not an image footprint and is ignored; an image without a
  georeference is placed over the current view.
- `get_image_file`: the served path of an image (gallery, PDF captions). `server/image_media.ts` is
  the one place that turns a `component_image` identity into a displayable tier, shared by the four
  image actions. It answers a path, never bytes: the web server serves the file under media
  protection.
- `stage_external_image`: an image an object links to by URL (`properties.images`), downloaded
  through `harvestFetch` (public hosts only, image content types only, 100 MB) and handed to core's
  upload receiver, which refuses bytes that are not the declared type. It answers the same
  `file_data` a picked file produces, and the browser runs the standard ingest. Off when
  `external_images_enabled` is `false` (`tool.method_not_allowed`). The import is synchronous.

**External geo services** (`server/geo_call.ts`, `askGeoService`). A retryable `external.*`
failure becomes `tool.source_unavailable` with the tool's reason key, so the browser names the
service. A provider's refusal, `rate.limited` and a refused parameter pass through with core's own
code. Parameters are checked against core's own grammar first (`geoParamAccepts`), so a refusal
carries a reason.

- `get_catastro_parcel`: the parcel at a map click. The click (`bbox`, map `width`/`height`,
  pixel `x`/`y`, `server/click_params.ts`) becomes a 100 m feature-info box around the point.
  `catastro_wms_featureinfo` gives the 14-character cadastral reference, then `catastro_wfs_parcel`
  gives its ring in the click's UTM zone (29, 30 or 31), converted to WGS84 here (`server/utm.ts`).
  Outside those zones nothing is asked (`found: false`); the Canary Islands (zones 27 and 28) are
  refused with `catastro_canary_islands`, since Catastro serves them in EPSG:25828, which core's
  service does not offer.
- `get_administrative_unit`: `ign_admin_units_featureinfo` answers one unit, of no chosen level and
  without geometry: the unit is named in the panel, never drawn. Core's `external.not_found` (at sea,
  outside Spain) is `found: false`, not a failure.
- `get_elevation`: the object's centre through `open_elevation_lookup`. Any `external`/`rate`
  failure answers `{elevation: null, unavailable: true}`: a decorative line never blocks selecting an
  object. Coordinates are range-checked before they reach a URL.
- `search_places`: Nominatim through `nominatim_search` (core keeps the usage policy's pacing, cache
  and User-Agent). 3 to 200 characters, 8 results, named in the record's language when it maps to an
  ISO code.

**WMS capabilities.** `get_wms_layers` fetches the GetCapabilities of a server the user typed through
`harvestFetch` (public hosts, 10 MB), query and fragment dropped. A host that does not resolve, or
resolves somewhere non-public, gets one answer (`wms_server_unreachable`), so the reply never maps
the internal DNS. The XML goes back raw and `js/wms_services.js` parses it with `DOMParser`.

**Roman-world gazetteers** (`server/roman_empire.ts`, `server/gazetteer_store.ts`).

- `search_pleiades`: a name (3 characters at least) or an exact id, matched against a local
  name-to-id index read from disk on every call.
- `get_pleiades_place`: one place document from `pleiades.stoa.org` through `harvestFetch` (that host
  only, HTTPS, 8 MB, 15 s).
- `search_pelagios`: up to 10 matches across the selected local layers, a closed list of twelve
  `<name>.geojson` files.
- `search_dare`: the `dare_search_modern`/`dare_search_ancient` core services (modern or ancient
  name, 3 to 100 characters), with optional type and country filters.

The tool ships no gazetteer data: the install points the `gazetteer_data_path` option at a directory
it owns, and `tools/tool_uca_maps/gazetteers/provision.ts` fills it (ops tooling, never on a request
path). The Pleiades index is built from Pleiades' own dumps; the Pelagios layers are copied from a
checkout of the previous version of the tool. Dataset names from the browser are checked against
the closed list and every resolved file is prefix-checked against the store.

### Client

`tools/tool_uca_maps/js/tool_uca_maps.js` wires the standard lifecycle through `tool_common`. `init`
finds the live map with `get_caller_by_model(self.caller, 'component_geolocation')`, never a fixed
caller depth: the chain differs between edit, a list cell and a portal. The modal is transient:
`edit()` (`render_tool_uca_maps.js`) attaches the features to the component's map, then closes the
modal; the instance lives until the component is destroyed.

Each feature is one `X.js` (logic, `attach_X`/`detach_X`) and one `render_X.js` (DOM). The buttons
share one bar (`js/toolbar.js`), and the attach order is the visual order, top to bottom: object
console, map image download, objects, 1x1 polygon, XYZ basemaps, WMS services, Catastro,
administrative units, file upload, place search, geolocation, legend, Roman Empire. Then two
non-buttons: the scale bar (bottom right) and the image overlays' own lifecycle hook, which rebuilds
the overlays saved on the record. One panel is open at a time; every node the tool creates goes to
`self._toolbar_nodes`, which the map image capture skips. `destroy` calls every `detach_X`, which
removes listeners, controls, overlays, panels and in-flight followers: the map outlives the tool.

Per-object state lives in `layer.feature.properties.uca_maps` (`js/uca_maps_data.js`): style,
centroid and uncertainty flags, associated images, an image overlay's carrier descriptor.

- `js/map_sources.js` edits the entry's `sources` and saves through the component
  (`get_entry_buffer`, `build_changed_data_item`, `change_value`); a refused save restores the
  previous list. `js/core_limits.js` mirrors core's source and legend rules, so a value core would
  refuse is caught before it blocks the whole save (a unit gate fails when the mirror drifts).
- `js/legend.js` writes the legend (`{title, groups: [{name, symbols: [{label, icon}]}]}`) to the
  component's buffer and marks it dirty; the component's save button commits it. The legend overlay
  is map content, so the image download includes it.
- `js/armed_layer.js` is what Catastro and administrative units share: the language gate (record
  language Spanish, Catalan or Basque), the layer laid over the basemap, and the click the server is
  asked about. With a `catastro` or `ign_unidades` entry in the component's `map_sources`, arming
  ticks core's own checkbox for it; without `ign_unidades`, administrative units use core's built-in
  `ign_admin_units` layer (boundaries only).
- `js/map_image_download.js` captures the map with `dom-to-image-more` and warns, by name, about any
  layer that loads directly from its provider instead of through the tile proxy: the page's
  `connect-src 'self'` keeps it out of the capture.
- `js/request_budgets.js` sets each action's single-attempt timeout: `readOnly` actions are sent
  once (`retries: 1`), so one attempt gets the whole window.

## Actions & options

All gates are declarative, on the map record named in the options (`section_tipo`, `section_id`,
`tipo`). The image actions name the **image** record instead (`rsc170`, its `rsc29` component),
whose media path they disclose.

| Action | Permission gate | Key options it reads | Returns |
| --- | --- | --- | --- |
| `get_capabilities` | `record_tipo`, `minLevel: 1`, `readOnly` | — | `{gdal, ogr2ogr, gdalTranslate, imagemagick, gazetteers, externalImages}` |
| `vector_download` | `record_tipo`, `minLevel: 1` | `format` (`shp`/`kml`), `file_data` (the object's GeoJSON, staged under `uca_maps_object`) | `{content_base64, filename, mime}` |
| `raster_download` | `record_tipo`, `minLevel: 1` | `format` (`jpg`/`gif`/`webp`/`geotiff`), `file_data` (`key_dir`, `tmp_name`), `bounds` (geotiff, EPSG:3857), `file_name` | `{content_base64, filename, mime}` |
| `image_download` | `record_tipo`, `minLevel: 1`, `readOnly` (image record) | `format` (`geotiff`/`png`/`jpg`), `corners`, `width`, `file_name`, `file_path` | `{content_base64, filename, mime}` |
| `object_pdf_report` | `record_tipo`, `minLevel: 1`; each image re-gated | `file_data` (as `vector_download`), `elevation`, `images` (record identities, max 30), `labels` | `{content_base64, filename, mime}` |
| `upload_vector_layer` | `record_tipo`, `minLevel: 1` | `file_data` (staged under `uca_maps_vector`: `key_dir`, `tmp_name`, `extension`), `epsg`, `zone`, `band` | `{geojson, feature_count, read_as?}` |
| `get_image_overlay` | `record_tipo`, `minLevel: 1`, `readOnly` (image record) | `section_tipo`, `section_id`, `tipo` | `{file_path, quality, georeferenced, georeference_unavailable, corners}` |
| `get_image_file` | `record_tipo`, `minLevel: 1`, `readOnly` (image record) | `section_tipo`, `section_id`, `tipo` | `{file_path, quality}` |
| `stage_external_image` | `record_tipo`, `minLevel: 2` (not `readOnly`) | `url` | `{file_data}` for the standard ingest |
| `get_catastro_parcel` | `record_tipo`, `minLevel: 1`, `readOnly` | `bbox`, `width`, `height`, `x`, `y` | `{found, refcat?, url?, points?, attribution?}` |
| `get_administrative_unit` | `record_tipo`, `minLevel: 1`, `readOnly` | `bbox`, `width`, `height`, `x`, `y` | `{found, unit?: {name, level, code}}` |
| `get_elevation` | `record_tipo`, `minLevel: 1`, `readOnly` | `lat`, `lon` | `{elevation, unavailable, attribution?}` |
| `search_places` | `record_tipo`, `minLevel: 1`, `readOnly` | `query`, `lang` | `{results: [{name, point, bbox}], attribution}` |
| `get_wms_layers` | `record_tipo`, `minLevel: 1`, `readOnly` | `url` | `{url, xml}` |
| `search_pleiades` | `record_tipo`, `minLevel: 1`, `readOnly` | `type` (`name`/`id`), `value` | `{results}` |
| `get_pleiades_place` | `record_tipo`, `minLevel: 1`, `readOnly` | `id` (numeric) | `{place}` (GeoJSON) |
| `search_pelagios` | `record_tipo`, `minLevel: 1`, `readOnly` | `query`, `datasets` | `{results}` |
| `search_dare` | `record_tipo`, `minLevel: 1`, `readOnly` | `query`, `name_type` (`mss`/`ass`), `type_id`, `country` | `{results, attribution}` |

`record_tipo` asserts both halves: the level on the (section, component) pair and the record inside
the caller's project scope (`src/core/tools/module.ts`). Refusals are `DedaloError`s with a
`reason_key` from `server/reasons.ts`, labelled in `register.json` (`reason_<key>`).

## How it is registered & surfaced

`tools/tool_uca_maps/register.json` is a hand-authored flat registration:

- `name`: `tool_uca_maps`, `version`: `1.0.0`, `label`: "UCA Maps" (`lg-eng`) / "Mapas UCA"
  (`lg-spa`), `developer`: Universidad de Cádiz / Museu de Prehistòria de València.
- `affected_models`: `["component_geolocation"]`, `show_in_component`: `true`,
  `show_in_inspector`: `false`, `active`: `true`.
- `properties`: `{"open_as": "modal", "windowFeatures": {"width": "60rem", "maxWidth": "100%"}}`.
- `default_config`: `gazetteer_data_path` (empty: the Roman-world local searches report the store
  missing) and `external_images_enabled` (`true`).
- `labels`: every UI string, in `lg-eng` and `lg-spa` only. Another interface language shows the
  English fallback each call carries. The browser reads the copy the tools register keeps in the
  database (`dd1324`, labels field `dd1372`), so the `version` is raised on every label change:
  Register tools copies labels only for a new version.

The button renders inline on every map component (`getElementTools`, `src/core/tools/registry.ts`);
`isAvailable` refuses a request addressed from any other model.

**Optional sources, per map component.** Catastro is not one of core's built-in sources (its
licence is accepted by the institution that turns it on). The Catastro button appears only when the
map component's ontology node lists a `catastro` entry in `properties.map_sources` **and** the
record's data language is Spanish, Catalan or Basque. Two more entries are optional: `ign_unidades`
(IGN administrative units with names, CC BY 4.0) and `arcgis` (sends the tool's ArcGIS basemap
through the tile proxy, so it is included in the map image). On a real installation, set them in a
local override (`docs/core/ontology/local_ontology_overrides.md`), then process the node:

```json
"map_sources": [
  { "id": "catastro", "label": "Catastro", "type": "wms",
    "url": "https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx",
    "params": { "version": "1.1.1", "layers": "Catastro", "styles": "", "format": "image/png",
                "transparent": true, "crs": "EPSG:3857" },
    "attribution": "Sede Electrónica del Catastro — Dirección General del Catastro" },
  { "id": "ign_unidades", "label": "Unidades administrativas (IGN)", "type": "wms",
    "url": "https://www.ign.es/wms-inspire/unidades-administrativas",
    "params": { "version": "1.3.0", "layers": "AU.AdministrativeUnit", "styles": "",
                "format": "image/png", "transparent": true, "crs": "EPSG:3857" },
    "attribution": "CC BY 4.0 ign.es" },
  { "id": "arcgis", "label": "ArcGIS", "type": "xyz",
    "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "params": { "min_zoom": 0, "max_zoom": 19 },
    "attribution": "Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community" }
]
```

Each `component_geolocation` carries its own list; on the development install the core map
component `rsc900` (section `rsc295`, Entities) is one that does.

## Dependencies

- **GDAL ≥ 3.2** on `$PATH` (`ogr2ogr`, `ogrinfo`, `gdal_translate`, `gdalwarp`, `gdalinfo`,
  `gdalsrsinfo`): vector upload and downloads, GeoTIFF export, image placement and image download.
  Missing or too old, the action refuses with `tool.dependency_unavailable`, except image placement:
  `get_image_overlay` answers `georeference_unavailable: true` and the client places the image over
  the current view.
- **ImageMagick**, as core resolves it: the map image as JPG, GIF or WebP.
- **`dom-to-image-more` 3.11.0** (npm, served from `lib/dom-to-image/`): the map image capture.
- Leaflet, Leaflet-Geoman and Turf come from the map component itself.

## Known limits

- A Shapefile cuts text attributes at 254 characters (the DBF format, applied by GDAL). GeoJSON and
  KML keep the full text.
- The PDF writer embeds JPEG (RGB) only: a CMYK frame, or an install whose image derivative is not
  JPEG, is named in the PDF instead of embedded.
- Removing an image object from the map keeps its Image (`rsc170`) record.
- DARE does not match a name with accents (`Cádiz` finds nothing, `Gades` does): a limit of the
  service.
- `stage_external_image` downloads inside the request (2 min by default), not as a background job.
- A provider lookup the user abandons is ignored by the browser, but the server waits until its
  timeout: a synchronous action receives no cancellation signal.

## Examples

Client-side `search_places` dispatch (`js/place_search.js`):

``` js
const response = await self.tool_request({
    action  : 'search_places',
    retries : 1,
    timeout : LOOKUP_TIMEOUT_MS,
    options : {
        tipo         : self.geolocation.tipo,
        section_id   : self.geolocation.section_id,
        section_tipo : self.geolocation.section_tipo,
        query        : query,
        lang         : self.geolocation.section_lang
    }
})
```

The unwrapped `data` the panel reads (`PlaceResult`, `server/place_search.ts`; `bbox` is
`[south, west, north, east]`, the order Leaflet's `fitBounds` takes, reordered from Nominatim's
south/north/west/east; values from `test/unit/tool_uca_maps_search_places.test.ts`, attribution
from core's `nominatim_search` entry):

``` json
{
  "results": [
    { "name": "Sagunt, Camp de Morvedre, València",
      "point": [39.6795, -0.2733],
      "bbox": [39.6, -0.35, 39.75, -0.2] }
  ],
  "attribution": "© OpenStreetMap contributors (ODbL)"
}
```

## Related

- [User guide](../../../tools/using_uca_maps.md) — the panels, step by step.
- [component_geolocation](../../../core/components/component_geolocation.md) — the map, its
  `sources`/`legend` entry and its save path.
- [tool_upload](tool_upload.md) — the ingest an uploaded or linked image goes through.
- [Server contract](../server_contract.md), [Security](../security.md),
  [Creating new tools](../creating_tools.md) — the `ToolServerModule` contract and the declarative
  permission gates.
- Source: `tools/tool_uca_maps/server/index.ts`; binaries and scratch: `tools/tool_uca_maps/server/gdal.ts`;
  geo services: `tools/tool_uca_maps/server/geo_call.ts` over `src/core/geo_services/`; client
  entry: `tools/tool_uca_maps/js/tool_uca_maps.js`.
