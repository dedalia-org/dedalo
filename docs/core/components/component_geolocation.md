# component_geolocation

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_leaflet_special_tools",
        "tool_propagate_component_data",
        "tool_time_machine",
        "tool_dev_template"
    ],
    "render_views" :[
        {
            "view"    : "default | line | print | mini",
            "mode"    : "edit"
        },
        {
            "view"    : "default | mini | text",
            "mode"    : "list | tm"
        }
    ],
    "data": "array of items",
    "sample_data": [{
        "id": 3,
        "alt": 16,
        "lat": 28.760289075631214,
        "lon": -17.87981450557709,
        "zoom": 17,
        "lib_data": [{
            "layer_id": 1,
            "layer_data": {
                "type": "FeatureCollection",
                "features": [{
                    "type": "Feature",
                    "properties": {"layer_id": 1},
                    "geometry": {"type": "Point", "coordinates": [-17.879337, 28.760041]}
                }]
            }
        }]
    }],
    "value": "array of coordinate objects",
    "sample_value": [{"lat": 28.760289, "lon": -17.879814, "zoom": 17, "alt": 16}]
}
```

## Definition

`component_geolocation` stores a geographic position and, optionally, the vector shapes drawn over it. It is a **literal-direct** component (it owns its data: there is no relation locator, no media file and no language). It renders an interactive [Leaflet](https://leafletjs.com/) map in `edit` mode where the curator can pan/zoom to set the map center and draw points, circles, polygons and polylines with the [Leaflet-Geoman](https://geoman.io/) editor.

It exists because a single pair of coordinates is rarely enough for cultural-heritage description: an excavation site has an extent (a polygon), a findspot has a precise point, a survey transect is a polyline, a monument has a viewshed radius. The component captures both the **map state** (center + zoom + altitude) and the **GeoJSON geometry** drawn on it, in a format ready for mapping, spatial queries and diffusion to GIS targets.

**Use it when** a record needs to be placed on a map: the location of an archaeological site, the findspot of an artifact, the birthplace of a person, the mint of a coin, the boundary of a protected area.

**Do not use it when** you only need a textual place name or a link to a gazetteer/thesaurus term — use [component_input_text](component_input_text.md) for a literal toponym, or a relation component such as [component_portal](component_portal.md) pointing at a *Places* thesaurus section (which can itself carry a `component_geolocation`). A common pattern combines both: a portal to the toponymy thesaurus that, on selection, pushes its coordinates into a local `component_geolocation` (see [Notes](#notes), `map_update_coordinates`).

!!! note "Single point per component"
    Although the data is modelled as an array, the editor manages **one item** (one map) per component instance; the fixed array key is always `0`. Multiple positions are expressed as multiple GeoJSON features inside `lib_data`, not as multiple array items.

## Data model

**Data:** `array` of coordinate items (one item in practice), or `null`.

**Value:** `array` of objects `{lat, lon, zoom, alt, lib_data?, sources?, legend?}`, or `null`.

**Storage:** the data is stored in the **`geo` column** of the matrix table. The component is **non‑translatable**: its language slot is always `DEDALO_DATA_NOLAN`, so there are no per-language rows.

Each item carries:

| key | type | meaning |
| --- | --- | --- |
| `lat` | float | map center latitude, range `[-90, 90]` |
| `lon` | float | map center longitude, range `[-180, 180]` |
| `zoom` | int | Leaflet zoom level (default `16`) |
| `alt` | int | altitude / elevation (default `0`) |
| `lib_data` | array | optional drawn shapes as GeoJSON layers (the rendering-library data) |
| `sources` | array | optional map sources (tile templates and WMS endpoints) the map is drawn over; the server numbers them — see [Map sources and legend](../data_model/geolocation.md#map-sources-and-legend) |
| `legend` | object | optional legend (title, groups, symbols with small raster icons) — same section |
| `id` | int | item id assigned by the component counter |

A stored item with drawn shapes:

```json
[{
    "id": 3,
    "alt": 16,
    "lat": 28.760289075631214,
    "lon": -17.87981450557709,
    "zoom": 17,
    "lib_data": [{
        "layer_id": 1,
        "layer_data": {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"layer_id": 1},
                    "geometry": {"type": "Point", "coordinates": [-17.879337, 28.760041]}
                },
                {
                    "type": "Feature",
                    "properties": {"layer_id": 1, "color": "#3388ff", "shape": "circle", "radius": 284.49},
                    "geometry": {"type": "Point", "coordinates": [-17.879723, 28.760324]}
                }
            ]
        }
    }]
}]
```

!!! warning "Coordinate order"
    The item fields `lat`/`lon` are stored in human order (**latitude first**). Inside `lib_data` GeoJSON, the `geometry.coordinates` use the GeoJSON convention `[lon, lat]` (**longitude first**). Do not swap them.

`lib_data` is an array of **layers**; each layer is `{layer_id, layer_data}` where `layer_data` is a GeoJSON `FeatureCollection`. Each feature stamps its `layer_id` in `properties`. Non-point shapes carry extra `properties`: `shape:"circle"` + `radius` for circles, `color` for any drawn shape. Layers exist so that a transcription [component_text_area](component_text_area.md) can pair each drawn shape with a `geo` tag in the text (the layer is loaded/removed as the tag is inserted/removed).

### No value, no data

A component with no position **stores nothing**: absence is the absence of an item, never a particular coordinate. Opening a record and saving it writes no geolocation value, the four coordinate inputs render empty, and nothing is published. Every finite coordinate is real — `0` included, so the equator and the prime meridian are legal positions. See [Geolocation values](../data_model/geolocation.md#absence-is-structural--there-is-no-magic-coordinate) for the full storage law.

Where the map *opens* on an empty component is a **camera**, not data: `default_view` (below). It is never stored and never published, and it is operator-configurable per install and per component.

### The view and the features are independent

`lat`/`lon`/`zoom` are the **view** — the map framing, manually controlled, asserting no feature. `lib_data` holds the **features**, the drawn shapes. Neither determines the other and neither is dropped in favour of the other: an operator frames the space they need to see, so the useful view is often nowhere near any single feature, and for very many records the view is the only positional data there is. Publication emits both, as stored. See [Geolocation values](../data_model/geolocation.md#the-view-and-the-features-are-independent).

**Both of the operator's gestures are data.** Panning or zooming sets the view, writes it into the component's value and marks it dirty — on an empty record too, where it creates the view — and the `lat`/`lon`/`zoom` inputs track the map live. The `map_point` button in the map-inputs row reads those inputs and creates a **feature**. Nothing auto-saves: only the save button commits. A record whose value is features with no stored view opens fitted to the extent of its own drawing, which is a camera move and not a write.

!!! danger "Legacy data: the studio default"
    `39.462571 / -0.376295` is the coordinates of the Dédalo facilities, shipped as the client's factory map position. The v6 client wrote it into the record on save whether or not anyone touched the map, so an item holding exactly that pair is fabricated — and because it is a factory default rather than a place, a record merely *named* after the studio's city is fabricated like any other. **Publication refuses that pair**, at that one door; everywhere else it is an ordinary coordinate. To take the fabricated views out of an upgraded store, `scripts/repair_geolocation_studio_default.ts` removes a default-only item outright and, for an item that also carries features, **fits the view to the geometry** (bounding-box centre of its own features; features, `zoom`, `alt` and `id` untouched). Fitting a view to the features is not authoring a location — it is what a view is for. Full law: [Geolocation values](../data_model/geolocation.md#the-studio-default--the-one-pair-publication-refuses).

## Ontology instantiation

Define the component as an ontology node whose `model` is `component_geolocation`, parented to the section or (normally) to one of its `section_group` groupers. The node carries the structure (`tipo`, `model`, `parent`, `lg-*` label) and the `properties` JSON that configures behaviour. The example below is the live node of the `monedaiberica` install (`dedalo_mib_v7`): `numisdata264`, under the grouper `numisdata14` of section `numisdata6`; `numisdata585` is the `component_autocomplete_hi` it observes.

Node JSON (structure):

```json
{
    "tipo"          : "numisdata264",
    "model"         : "component_geolocation",
    "parent"        : "numisdata14",
    "lg-eng"        : "Map",
    "lg-spa"        : "Mapa",
    "translatable"  : false
}
```

Example `properties` block for this component (provider override + observers; see [Properties & options](#properties--options)):

```json
{
    "geo_provider": "OSM",
    "observe": [
        {
            "client": {
                "event"  : "update_value",
                "perform": {"function": "map_update_coordinates"}
            },
            "component_tipo": "numisdata585"
        }
    ]
}
```

`css` may set the map height (the editor needs a tall container):

```json
{
    ".wrapper_component >.content_data": { "min-height": "500px" }
}
```

`section_tipo`/`parent` wire the node into a section: instantiating the section resolves its element tree and builds the component for the current `section_id` in the requested mode. The component never reaches the database itself — its section is the single writer, and reads/writes the `geo` column on its behalf.

## Properties & options

`geo_provider`

options: `OSM` | `GOOGLE` | `ARCGIS` | `NUMISDATA` | `VARIOUS`

default: the `DEDALO_GEO_PROVIDER` env var, read into the TS config catalog as `config.geoProvider` (`src/config/config.ts`, `readEnv('DEDALO_GEO_PROVIDER', 'VARIOUS')`).

Selects the base tile layer(s) of the Leaflet map. The server stamps the resolved value into `context.features.geo_provider` (`properties.geo_provider ?? config.geoProvider`) and the client switches on it: `src/core/resolve/structure_context.ts` appends `entry.features = {geo_provider}` for `component_geolocation` in the FULL (non-`simple`) context — without it the client's Leaflet widget cannot pick a tile backend and the map renders as an empty box (fixed 2026-07-04; gated by `component_geolocation_features_differential.test.ts`). The same `features` carries `tile_direct`, the built-ins the browser loads straight from their provider instead of through the [map tile proxy](../system/map_tile_proxy.md#built-in-sources): `["osm"]` on an installation without a public `DEDALO_HOST`, `[]` otherwise.

- `OSM` — OpenStreetMap tiles, with automatic dark/light tile swap on theme change.
- `GOOGLE` — Google `ROADMAP` layer (requires the Google plugin to be available).
- `ARCGIS` — Esri *World Imagery* satellite tiles.
- `NUMISDATA` — layer selector offering the *Imperium* (DARE/ancient world) tiles + ArcGIS + OSM.
- `VARIOUS` — layer selector offering ArcGIS + OSM.

`default_view`

options: `{"lat": <number>, "lon": <number>, "zoom": <number>}`

default: the `DEDALO_GEO_DEFAULT_LAT` / `DEDALO_GEO_DEFAULT_LON` / `DEDALO_GEO_DEFAULT_ZOOM` env vars, read into the TS config catalog as `config.geoDefaultView` (see [Configuration](../../config/config.md)); shipped default is the world view `{lat: 20, lon: 0, zoom: 2}`.

The position the map **opens** on when the record has no coordinate. It is a camera, not a value: it is never written into the record and never published, so a record the cataloguer never touched stays empty. The server resolves it per instance and stamps it into `context.features.default_view` (`src/core/resolve/structure_context.ts`, FULL context only — the `simple` list/portal context emits no `features`).

The override is **all or nothing**: each of `lat`, `lon` and `zoom` must resolve to a usable number, or the whole `default_view` is discarded and the configured camera is used — a half-specified camera is a config error, not a blend. `0` is a valid member. A member may be written as a number **or as a numeric string** (`"41.65"`), because ontology `properties` JSON quotes numbers routinely and the client's own reader coerces them. Each is also **range-checked** — `lat` −90..90, `lon` −180..180, `zoom` 0..22 — so a typo cannot open the map off-planet; an out-of-range member invalidates the whole override, silently, and the configured camera is served instead. Set it (or the three env keys) when the collection is regional, so cataloguers do not pan the world map on every new record.

```json
{
    "default_view": {"lat": 41.65, "lon": -4.72, "zoom": 12}
}
```

`map_sources`

options: array of source objects `{id, label?, type, url, params, attribution}`

default: none.

Default map sources offered to **every record** of the field: tile templates (`xyz`) and WMS endpoints (`wms`) the map can be switched onto, chosen by the administrators in the ontology rather than by each cataloguer. `id` is a short name (lowercase letters, digits and `_`), unique in the list; `label` is the plain text the layer control shows. An entry that fails the same checks as a source stored in a record is rejected with its position and reason and never offered. The browser is told each default's name, label, type and attribution (plus an `xyz` source's zoom bounds or a `wms` source's CRS) and **never its address**: the tiles are asked of the server's [map tile proxy](../system/map_tile_proxy.md) by `default_id`, so a provider key written in the `url` stays on the server. Use it, rather than a source stored in a record, for an address that carries a key, or when the installation (and not each editor) carries the provider's licence. The shape of a source, its checks and the difference with a stored source are in [Map sources and legend](../data_model/geolocation.md#map-sources-and-legend); no node of this install carries the key today (shape only), so the example is generic:

```json
{
    "map_sources": [
        {"id": "regional_ortho", "label": "Regional orthophoto", "type": "wms",
         "url": "https://wms.example.org/service",
         "params": {"version": "1.3.0", "layers": "ortho", "styles": "", "format": "image/png",
                    "transparent": false, "crs": "EPSG:3857"},
         "attribution": "Example Org"}
    ]
}
```

`observe`

options: array of observer rules `{client:{event, perform:{function}}, component_tipo}`

Client-side event subscriptions handled by the component. Recognised perform functions on this component:

- `map_update_coordinates` — on a related component's `update_value`, copy the coordinates of a referenced record's geolocation into this map (see [Notes](#notes)).
- `load_tag_into_geo_editor` — on `click_tag_geo`, load the layer pointed by a transcription `geo` tag.
- `layer_data_change` — on `editor_tag_geo_change`, insert/remove a layer when its tag is added/removed in the text.
- `get_data_tag` — on the text editor request (e.g. `key_up_f2`), hand a new `geo` tag descriptor to the calling [component_text_area](component_text_area.md).

`map_update_coordinates` reads, on the **observable** related component, a `request_config` `hide` entry with `role: "target_geolocation_tipo"` to know which geolocation component of the pointed record to copy; absent that, it falls back to the thesaurus default geolocation tipo.

!!! note "Common component properties"
    The shared `mandatory`, `css`, `tools`, `permissions` and `request_config` apply as for any component (see [Introduction to components](index.md)). `unique`, `with_lang_versions` and `multi_line` are not meaningful here (the component is non‑translatable and is not a plain text field). Verify any project-specific property in the ontology.

## Render views & modes

The component is built by the shared `ui.component` builders; the view is read from `context.view` (default `default`).

| view | edit | list / tm | notes |
| --- | --- | --- | --- |
| `default` | yes | yes | full interactive map; in `edit` the Geoman draw toolbar and coordinate inputs (`lat`,`lon`,`zoom`,`alt`) are shown |
| `line` | yes | — | compact fixed-height map (falls through to the default editor view) |
| `print` | yes | — | read-only map (forces `permissions = 1`, hides Leaflet controls) |
| `mini` | yes | yes | minimal map view |
| `text` | — | yes | textual list rendering |

The map disables scroll-wheel zoom by default and recenters through a single non-animated camera move when the inputs change, so a typed coordinate is not overwritten by an animation settling afterwards.

!!! warning "Search mode under construction"
    `search` mode is wired (`render_search_component_geolocation`) but the search view is not currently exposed in the search list (`UNDER CONSTRUCTION` in the source). Consistent with that, the TS search dispatcher (`src/core/search/conform.ts`) has no `component_geolocation` branch either — a filter against this model would throw `builder for model 'component_geolocation' not implemented yet`. The component is also **not sortable**: its descriptor declares the `sortable: false` opt-out (sortability otherwise defaults to true — `resolveSortable()`, `src/core/resolve/structure_context.ts`), so a list cannot be ordered by it.

## Import / export model

The component is non‑translatable, so the import value is the bare data array (no lang keys). Four import shapes are defined:

1. Full v7 dato — JSON array of items:

    ```json
    [{"lat":39.4625,"lon":-0.3762,"zoom":16,"alt":0}]
    ```

2. A single bare item — JSON object (wrapped into a one-item array):

    ```json
    {"lat":39.4625,"lon":-0.3762}
    ```

3. A bare GeoJSON `FeatureCollection` — the map center is taken from the first `Point` feature and the whole collection is stored as `lib_data` layer 1 (a missing `layer_id` is stamped as `1`):

    ```json
    {"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[-0.3762,39.4625]}}]}
    ```

4. A flat string `lat, lon[, zoom[, alt]]` with dot decimals (latitude first):

    ```text
    39.4625, -0.3762, 16
    ```

All four shapes are converted by the model's own conform step (`importConform: 'geolocation'` on the descriptor → `src/core/tools/import_conform.ts`).

Validation: `lat` and `lon` are needed **together** — one without the other is a malformed pair — and each must parse to a number in range (`lat ∈ [-90,90]`, `lon ∈ [-180,180]`); comma decimals are normalized in the JSON shapes, and `0` is a legal coordinate. `zoom` defaults to `16` and `alt` to `0`; `lib_data` (when present) must be an array of layers each defining `layer_id` and a `FeatureCollection`. A legacy lang-keyed export object (`{"lg-nolan":[...]}`) is accepted by extracting the first lang value.

An item with **no coordinate but with drawn `lib_data` features** is a value in its own right and imports as geometry-only.

!!! warning "A refusal is not a clear"
    An empty cell — and only a source that **states** there is no location: both coordinate keys present and blank, or an item carrying a `lib_data` key — clears the component data. Everything else with no usable coordinate (a typo'd header, `{}`, `{latitude,longitude}`, `{"zoom":12}`, an out-of-range value) is **refused**: it is reported in the run's failed rows and the record's stored value is left untouched. A field with any refused value is not written at all, including the values of that field which did conform, and the report says so. This is the one door that enforces the coordinate ranges — by refusing loudly, never by silently dropping a stored value.

See the full geolocation import definition in [Importing data](../importing_data.md#geolocation) and the round-trip raw format in [Exporting data](../exporting_data.md#raw-export-and-round-trip).

## Notes

- **Storage column & language.** Data lives in the matrix `geo` column, pinned to `DEDALO_DATA_NOLAN` (language‑neutral). The component reads/saves only through its section.
- **Coordinate accessors.** The center is resolved as floats from `lat`/`lon` when both parse to a finite number (`0` included); `null`, `""` and unparseable text resolve to no coordinate, and a missing axis is never completed with a zero. A cache-rebuild reload-then-resave path (used by cache-update tooling) has not been verified for this pass.
- **Diffusion.** The stored item can convert to a GeoJSON `Point` object `{type, coordinates:[lon, lat]}` (Socrata-style) or to an encoded `FeatureCollection` (layer wrapper, 16‑decimal `[lon, lat]` coordinates). Precedence is the same on every path: drawn geometry publishes as the location (and on the standalone path the stored center is dropped from the published value), otherwise a usable coordinate publishes as the point, otherwise nothing is published at all. See [Diffusion parsers](../../diffusion/parsers.md).
- **Observers / observables (client).** Configured via the `observe` property. The flagship pattern is `map_update_coordinates`: a related component (e.g. a toponymy portal) is the *observable*; on its `update_value` it fires the observer geolocation, which copies the coordinates of the referenced record (the geolocation identified by `role: "target_geolocation_tipo"` in the observable's `request_config` `hide`) and re-centers the map, recording the change like any save. Only the coordinate travels: the borrowed item's own id is dropped, so the copy replaces **this** record's item instead of appending a second one beside it, and the other record's map `sources` and `legend` are not copied — this record keeps its own, because saving replaces the whole item.
- **Text-area integration.** `lib_data` layers pair with `geo` tags in a [component_text_area](component_text_area.md) transcription; inserting/removing a tag loads/unloads the matching layer (`layer_data_change`, `load_tag_into_geo_editor`, `get_data_tag`). See the `geo` tag in [Importing data](../importing_data.md#geo).
- **Default tools.** `tool_leaflet_special_tools`, `tool_propagate_component_data`, `tool_time_machine`, `tool_dev_template` (per the ontology node; exact set is ontology-driven).
- **Client libraries.** Leaflet, Leaflet-Geoman, Turf (measurements) and iro (color picker) are lazy-loaded on first map build (`load_libs`). The map never auto-saves on pan/zoom — saving is always explicit via the save button, and navigating a record that holds no value writes nothing at all.
- **Related docs:** [component_input_text](component_input_text.md), [component_portal](component_portal.md), [component_text_area](component_text_area.md), [component_json](component_json.md), [Introduction to components](index.md).
