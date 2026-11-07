# Geolocation values — the `geo` column

> **Data model series.** This page documents a Dédalo v7 **data type** — the
> JSON value shape as it is *stored*, independent of the component that produces
> it. For the field/UI object that creates this value, see
> [`component_geolocation`](../components/component_geolocation.md). For where
> these typed columns live, see [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns).

## What it is

A **geolocation value** holds two independent things: the **view** —
`lat` / `lon` / `zoom`, the map framing — and the **features**, the vector shapes
(points, circles, polygons, polylines) drawn on the map and stored as GeoJSON in
`lib_data`. `alt` is an operator-editable altitude that travels with the item.

It has two parts because a single coordinate pair is rarely enough for
cultural-heritage description: an excavation site has an extent (a polygon), a
findspot has a precise point, a survey transect is a polyline, a monument has a
viewshed radius — and the frame an operator needs to *see* that work is a
separate question from the work itself.

!!! important "The view is a frame, not a feature"
    `lat`/`lon`/`zoom` say where the map looks from; they assert no feature, and
    the features do not determine them. An operator frames the space they need
    to see, so with several points — or with context drawn around one — the
    useful frame is often nowhere near any single feature. The view is under
    manual control and it is **data**: changing it is the operator acting, and
    it saves.

    Both parts are ready for mapping, spatial queries and diffusion to GIS
    targets.

The value is **language-neutral**: it never carries `lg-*` keys. The producing
component forces `lang = DEDALO_DATA_NOLAN`, so a position is the same in every
interface language.

## Canonical JSON shape

The stored data is an **array of items** (in practice one item — one map per
component). Each item is the view plus the optional drawn features in
`lib_data`:

```json
[{
  "id": 3,
  "lat": 41.562363,
  "lon": 2.012151,
  "zoom": 16,
  "alt": 0,
  "lib_data": [{
    "layer_id": 1,
    "layer_data": {
      "type": "FeatureCollection",
      "features": [{
        "type": "Feature",
        "properties": {"layer_id": 1},
        "geometry": {"type": "Point", "coordinates": [2.012151, 41.562363]}
      }]
    }
  }]
}]
```

The item fields:

| key | type | meaning |
| --- | --- | --- |
| `lat` | float | the **view**'s latitude, range `[-90, 90]` (human-facing, latitude first) |
| `lon` | float | the **view**'s longitude, range `[-180, 180]` |
| `zoom` | int | the **view**'s Leaflet zoom level (default `16`) |
| `alt` | int | altitude / elevation — real data on the installs that use it (default `0`) |
| `lib_data` | array | the **features**: drawn shapes as GeoJSON layers (the rendering-library data) |
| `sources` | array | optional: the **map sources** the map is drawn over — see [Map sources and legend](#map-sources-and-legend) |
| `legend` | object | optional: the **legend** that explains the drawing — see [Map sources and legend](#map-sources-and-legend) |
| `id` | int | per-item counter id (from the component `meta` counter) |

!!! warning "Coordinate order — read this twice"
    The item fields `lat`/`lon` are stored in **human order (latitude first)**.
    Inside `lib_data` the GeoJSON `geometry.coordinates` follow the **GeoJSON
    convention `[lon, lat]` (longitude first)**. The two orders coexist in the
    same value; do not swap them.

### The `lib_data` layers

`lib_data` is an array of **layers**. Each layer is `{layer_id, layer_data}`
where `layer_data` is a GeoJSON [`FeatureCollection`](https://datatracker.ietf.org/doc/html/rfc7946).
Every feature stamps its own `layer_id` into `properties`. Non-point shapes
carry extra `properties`:

```json
{
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
}
```

- `shape:"circle"` + `radius` (metres) describe a Leaflet circle (GeoJSON has no
  native circle, so it is encoded as a Point + `radius`).
- `color` is the stroke/fill colour of any drawn shape.

Layers exist so a transcription [`component_text_area`](../components/component_text_area.md)
can pair each drawn shape with a `geo` tag in the text — the layer is
loaded/removed as the tag is inserted/removed.

### Map sources and legend

Two optional keys sit **beside** `lib_data`, never inside it — `lib_data` stays pure
GeoJSON. They are saved with the field like the rest of the value, so they follow the
record's permissions, history, duplication and export.

```json
{
  "lat": 41.38, "lon": 2.17, "zoom": 12, "alt": 16,
  "lib_data": [],
  "sources": [
    {"id": 4, "type": "xyz", "url": "https://tiles.example.org/{z}/{x}/{y}.png",
     "params": {"max_zoom": 18}, "attribution": "Example Org"},
    {"id": 5, "type": "wms", "url": "https://wms.example.org/service",
     "params": {"version": "1.3.0", "layers": "base", "styles": "", "format": "image/png",
                "transparent": false, "crs": "EPSG:3857"},
     "attribution": "Example WMS"}
  ],
  "legend": {"title": "Roman roads",
             "groups": [{"name": "Surface",
                         "symbols": [{"label": "Paved", "icon": "data:image/png;base64,…"},
                                     {"label": "Track"}]}]}
}
```

A **source** is data the server reads, never an address the browser fetches. `type` is
`xyz` (a tile template carrying `{z}`, `{x}` and `{y}`, and no other placeholder) or
`wms` (a plain endpoint; the server asks it for map images of each tile). `params` is
closed per type — an unknown key is refused, not dropped:

- `xyz`: `{}` or `min_zoom` / `max_zoom` (integers 0–22);
- `wms`: `version` (`1.1.1` or `1.3.0`), `layers`, `styles`, `format` (png, jpeg, gif
  or webp), `transparent`, `crs` (`EPSG:3857`, `EPSG:4326` or `EPSG:4258`). Nothing else
  is stored: the server fixes the request itself.

`attribution` is plain text (up to 300 characters; `<` and `>` are refused).

The address of a source must use `http` or `https`, carry no credentials and no
fragment, use the **standard web port of its scheme** (80 or 443, written or implied: the
server reaches no other, so a source on `:8080` would save and never draw), and name a public
host: a private or loopback address literal, a loopback name or a single-label name is refused,
in whatever spelling. A stored template is checked when it is saved and again whenever it is
used.

A `wms` source whose `crs` is geographic (`EPSG:4326`, `EPSG:4258`) is drawn from zoom 8 up.
The server asks such a service for each tile's longitude and latitude corners and gets a
plate carrée picture, which the map draws as a Web Mercator tile; the two agree to under a
pixel from zoom 8 and are visibly misregistered below it (about 12 pixels at zoom 4). A
service that offers `EPSG:3857` should be stored with it, and is drawn at every zoom. See
[the tile proxy](../system/map_tile_proxy.md).

**Source numbers are issued by the server.** `id` comes from the field's own item
counter, so it is unique among the field's sources and is never given out twice. A number is
a per-record number — "this record's source 4" — and is settled on every save:

- a source that names a number the field **holds** keeps it (the first source to name it
  holds it);
- a source with **no** number, or a number the field does not hold, that equals a source the
  field already stores (apart from the number) **takes that source's number** — so saving an
  unchanged file again changes nothing: the same bytes, the same numbers, and no new history
  from an import run;
- anything else is **new** and receives a new number; the save response carries the final
  numbers. A deleted source's number is never handed out again: a source sent back with it
  (an undo, a copy, a re-imported export) is new.

The same number twice in one value is not an error: the second source is a copy and is
numbered. Two sources that name the **same** stored number are therefore resolved by
**position** — the one listed first keeps the number, so a source you need to keep under its
number goes first. (An explicit number outranks a match by content wherever the two sit; only
this tie depends on the order.) A source that comes from **another record** (a propagated
value, a file written from another record's export) carries *that* record's numbers, and
small numbers coincide often: a foreign source naming a number this field holds is an **edit
of that source** — its content is replaced — and any other foreign number is replaced by a
new one. A value is settled **per record**: the same value saved into many records (a
propagation) numbers each one as if it were saved alone, whatever numbers the others
received. At most 24 sources per item, and at most 96 across all the items of one value.

The **legend** is a title and named groups of symbols; a symbol has a `label` and, if you
want one, an `icon`. An icon is a base64 `data:` URI of a **png, jpeg or webp** image (an
svg is refused, and so is any address), the image's own header must match the declared
type, and it is shown only as an image. An icon is at most 64 KiB and one legend carries
at most 256 KiB of icons. The size the image *declares* is bounded too, because a few
kilobytes of png can declare a bitmap of a gigabyte: an icon is at most 256 × 256 pixels
and the icons of one legend together at most one megapixel. All the items of one value
together carry at most four legends, 1 MiB of icons and 832,800 characters of legend text
(four legends' worth). Text that reads as the start of a tag is refused
(which keeps it inert as page text; a label is always shown as text, never built into
markup).

Saving a value **replaces** the item: a value sent without `sources` or `legend` stores
without them. An empty list or an empty legend is stored as no key at all. A save that is
refused stores nothing; the failing source and rule are written to the server log (the
response to a browser carries only the generic "invalid data" message) and an import
reports them per cell.

**Who sees what.** A stored source's address is part of the record, so **everyone who can
read the field reads it** — the edit view, the raw export and the Time Machine carry it as
stored. Put a provider key that must stay private in an ontology default (below), never in a
record's source. The list view carries the view and the drawn layers only: a grid row never
holds `sources` or `legend`. The map definition is checked again as it is sent out, because
a restore from history writes the record back without the save checks: an icon that is no
longer a valid png, jpeg or webp image of an allowed size is left out, a legend whose text
opens a tag is not sent, and a source whose attribution is no longer plain text is sent with
a blank attribution (the source itself stays).

An ontology node may offer **default sources** to every record of the field in
`properties.map_sources`: a list of the same objects, each with a short name as `id`
(lowercase letters, digits and `_`) and an optional `label` for the picker (plain text, like the
attribution: a label with `<` or `>` is rejected). An entry that
does not pass the checks above is rejected with its position and reason, and is never
offered. The browser is told each default's name, label, type and attribution, plus an `xyz`
source's `min_zoom` / `max_zoom` or a `wms` source's `crs` (what it needs to show the licence's
attribution and to ask only for tiles worth asking for) — never its address, its layer list or
any other parameter, so a key kept in a default stays on the server.

### Absence is structural — there is no magic coordinate

**A record with no position stores no geolocation item.** Emptiness is the
absence of a value, never a particular value. (One pair *is* refused, but at
the publication door only — see
[the studio default](#the-studio-default--the-one-pair-publication-refuses).)

| stored | meaning |
| --- | --- |
| no item for the component tipo | no position — nothing is resolved, nothing is published |
| `lat` / `lon` `null`, `undefined`, `""`, or unparseable text | no coordinate — the point is not built, and the missing axis is **never** completed with a zero |
| any finite `lat`/`lon`, **`0` included** | a real coordinate — `[0, 0]`, the equator and the prime meridian are legal positions and publish like any other |
| `lat`/`lon` as a JSON **string** (`"41.5"`) or **number** (`41.5`) | identical; both forms occur in the same column |

Both axes are required together: a point needs `lat` **and** `lon`.

!!! info "The opening camera is a view, never a value"
    Where the map *opens* when a record has no coordinate is server
    configuration — `DEDALO_GEO_DEFAULT_LAT` / `DEDALO_GEO_DEFAULT_LON` /
    `DEDALO_GEO_DEFAULT_ZOOM`, delivered to the editor as
    `context.features.default_view` (see [Configuration](../../config/config.md)).
    It is a camera position: it is never stored in the record and never
    published. Opening a record and saving it stores **no** coordinate.

### The studio default — the one pair publication refuses

`39.462571 / -0.376295` is not a place. It is the **studio default**: the
coordinates of the Dédalo facilities, shipped as the client's factory map
position. The v6 client wrote it into the record on save whether or not anyone
touched the map, so **an item holding exactly that pair is fabricated** — nobody
frames a map on the studio to six decimals, and a genuinely positioned record
carries its own coordinates. Exact equality is therefore a sound test.

It is treated specially at **one door only, publication**: a fabricated view is
never emitted to a consumer. `isStudioDefault()`
(`src/core/concepts/geo_coordinate.ts`) is the single definition, and this is
standing law, not a temporary shim.

Everywhere else — storage, editing, search, import, migration — the pair is an
**ordinary coordinate** with no special handling at all.

!!! info "A factory default is not a place"
    Because the pair is a factory default rather than a place, a record merely
    *named* after the studio's city holds it as fabricated as any other record
    does. There is no place-name test anywhere in the engine and there must
    never be one again.

!!! danger "Legacy data: repairing the fabricated views"
    An install upgraded from those versions carries items whose stored view
    nobody chose. Publication already withholds them, but they are still in the
    store, edited and migrated like real data. The repair is
    `scripts/repair_geolocation_studio_default.ts` — dry-run by default;
    `--table` and `--user` are both mandatory, and `--apply` is refused on any
    table that has not been authorised in writing. It covers the two stores that
    carry the pair, the record store and the thesaurus store:

    | the item | what the repair does |
    | --- | --- |
    | the studio-default view and **no** features and no map definition | the whole item is **removed**, `alt` included — it is fabricated in its entirety and the record ends with no geolocation at all |
    | the studio-default view **with** features (and no map definition) | the view is **fitted to the geometry**: `lat`/`lon` become the bounding-box centre of every feature across the item's `lib_data` layers. Features, `zoom`, `alt`, `id` and every other key are untouched. For a single drawn Point the fitted view *is* that point, verbatim |
    | an item that carries a **map definition** — a non-empty `sources` list, or a `legend` with a title or a group — whatever its view | **untouched**: it is content somebody wrote, never a fabrication, so it is neither removed nor fitted (its view stays a human decision; publication still refuses the pair) |
    | anything else | **untouched** |

    An empty `sources` list or an empty legend is "none" (it is stored as no key at all), so an
    item that carries only those is still a bare default and is repaired like one.

    Fitting a view to the features is not authoring a location — it is what a
    view is for.

    Two cases are **held** rather than repaired, and the first surprises people:
    a fabricated item that shares its component with **another item** is left
    alone entirely, because the repair writes the component's whole key at once
    and removing one item of several is not expressible — so on a record holding
    several geolocation items you get a reported no-op, not a repair. The other
    is features from which no coordinate can be extracted: the view is never
    guessed. The repair is **not reversible**: assume there is no Time
    Machine row to restore from.

### The view and the features are independent

The two parts of the value do not constrain each other:

- an item may hold a view and no features — for very many records the view is
  the only positional data that exists;
- it may hold features and no view;
- it may hold both, and the view need not be anywhere near them.

Neither is derived from the other, and neither is dropped in favour of the
other. Publication emits both, exactly as stored (the one refusal is the studio
default, above). The operator's two gestures map straight onto the two parts:
panning and zooming sets the **view**, and the `map_point` button reads the
coordinate inputs and creates a **feature**. Both are savable.

## Database column

Geolocation values live in the typed **`geo`** JSONB column of the `matrix`
table (one row per record; see [Sections — the matrix table model](../sections/index.md#the-matrix-table-model)).
The mapping is resolved through `getColumnNameByModel('component_geolocation')`
(`src/core/ontology/resolver.ts`), which reads `column: 'geo'` off
`component_geolocation/descriptor.ts`.

### Keyed by component tipo (extra nesting)

Unlike most typed columns, the `geo` column value is **keyed by the originating
component tipo** — there is an extra object level around the item array:

```json
{
  "numisdata264": [
    { "lat": 41.562363, "lon": 2.012151, "zoom": 16, "alt": 0, "lib_data": [ /* … */ ] }
  ]
}
```

Because of this nesting, the GIN index and any search query reach the item
properties with a wildcard path that crosses both the tipo key and the array:

```sql
-- GIN index sample (src/core/db/db_pg_definitions.json)
SELECT * FROM matrix
WHERE jsonb_path_query_array(geo, '$.*[*]') @> '[{"lat":"42.31412288249575"}]'
LIMIT 10;
```

`$.*` walks the component-tipo keys and `[*]` walks the item array, yielding the
flat list of point objects to match `lat` / `lon` / `alt` against. The
`geo` column is one of the typed columns that PostgreSQL can index and query
independently of the rest of the record payload.

## Components that produce / use it

| component | role | translatable |
| --- | --- | --- |
| [`component_geolocation`](../components/component_geolocation.md) | the only producer — edits the position and shapes on a Leaflet map | no (`lg-nolan`) |

It is a **literal-direct** component: it owns its data, with no relation
locator, no media file and no language. The component never touches the
database directly — the write path
(`src/core/section/record/save_component.ts`) reads and writes the `geo`
column on its behalf.

## Server-side handling

There is no dedicated "geo value" class; the shape is produced and consumed
entirely through the generic item pipeline. The read side is
`readComponentItems()` / `resolveComponentValue()`
(`src/core/resolve/component_data.ts`); the `geo` column itself is declared in
`MATRIX_JSONB_COLUMNS` (`src/core/db/matrix.ts`) and the model→column entry
resolves from `component_geolocation/descriptor.ts` (`column: 'geo'`).

**Emptiness is enforced structurally, in every emitting path.**
`geojsonPointFallbackLayers()` (`src/diffusion/resolve/ddo_fns.ts`) builds a
point only when `lat` **and** `lon` both parse to a finite number (comma
decimals normalized first); `null`, `undefined`, `''` and unparseable text
yield no layer, and neither axis is ever defaulted to `0`. A stored `0` is a
coordinate and does build a point. `parser_geo::geojson`
(`src/diffusion/parsers/parser_misc.ts`) answers identically — see
[Diffusion parsers](../../diffusion/parsers.md). The single parse law is
`src/core/concepts/geo_coordinate.ts`, read by these paths and by the import
door. The only pair with a meaning of its own is the
[studio default](#the-studio-default--the-one-pair-publication-refuses), refused
at the publication doors and ordinary everywhere else.

That fallback-point builder is wired into one specific diffusion path today:
a paired `component_text_area`'s `get_geojson_data` step
(`src/diffusion/resolve/resolver.ts`) publishes the linked
`component_geolocation`'s `lib_data` layers verbatim, falling back to a
single-point `FeatureCollection` built from `lat`/`lon` when `lib_data` is
empty (`buildGeojsonLayers()`, `src/diffusion/resolve/ddo_fns.ts`).

!!! warning "Standalone diffusion reshaping and search: not yet implemented"
    A **standalone** `component_geolocation` field (not paired with a
    text-area geo tag) diffuses as a raw `'geo'` atom
    (`src/diffusion/resolve/default_value.ts`) — it strips the item `id` but
    does **not** reshape the value into a GeoJSON `Point` or a layer-wrapped
    `FeatureCollection`; it carries essentially the storage shape. There is
    also no `geo`-family search builder yet — geolocation values cannot
    currently be matched by a search query.

That atom publishes what is stored, per item:

1. an item with a **usable view** (both axes parse, `0` included) or with
   **features**, or both, publishes as it stands, `id` stripped and every other
   key — `lat`, `lon`, `zoom`, `alt`, `lib_data` — verbatim. The view is never
   dropped because the item also carries features;
2. an item whose view is the **studio default** has that pair withheld: if it
   carries features they publish without `lat`/`lon`; if it carries none, there
   is **no atom**;
3. an item with **neither** a usable view nor features produces **no atom**.

`sources` and `legend` are **never published**: a source is an upstream address that may
carry a provider token, and a legend carries embedded icons. An item whose only content
is `sources` and `legend` produces no atom.

The other two emission paths — `parser_geo::geojson`
(`src/diffusion/parsers/parser_misc.ts`) and `buildGeojsonLayers`
(`src/diffusion/resolve/ddo_fns.ts`) — publish stored `lib_data` layers when
there are any and build a point from the view otherwise, and they refuse the
studio default the same way.

## Client-side model

In the [datum `data` layer](../request_config.md) the value reaches the browser
as the same item array, exposed on the component instance as
`self.data.entries`. Each entry is an `{lat, lon, zoom, alt, lib_data?}` object;
the drawn shapes live in `entries[0].lib_data`.

The component renders an interactive [Leaflet](https://leafletjs.com/) map with
the [Leaflet-Geoman](https://geoman.io/) draw editor
(`client/dedalo/core/component_geolocation/js/component_geolocation.js`). The
stored value maps onto Leaflet as follows:

```javascript
// the CAMERA (view only) — the stored coordinate when there is one,
// otherwise the server-configured default view. Never a stored value.
const map_data = self.get_view(0)
self.map = new L.Map(map_container, {
    center : new L.LatLng(map_data.lat, map_data.lon),   // (lat, lon)
    zoom   : map_data.zoom
})

// the default view, delivered by the server (DEDALO_GEO_DEFAULT_*)
self.default_view = self.context.features.default_view   // {lat:20, lon:0, zoom:2}
```

The component's **value** is a separate thing from the camera:
`self.get_stored_entry(0)` returns the stored item or `null` and never
fabricates one, so a record the user did not touch has no value to save. The
four coordinate inputs render empty on absence — and render `0` when the
stored coordinate *is* zero.

Notes on the client model:

- **Setting the view is data entry.** Panning or zooming writes the new view
  into the component's value and marks it dirty — on an empty record too, where
  it *creates* the view. The `lat`/`lon`/`zoom` inputs track the map live, which
  is how an operator approximates a position by eye and spots bad manual data.
  The `map_point` button in the map-inputs row reads those inputs and creates a
  **feature**; it does not touch the view.
- The map **never auto-saves**: a gesture only marks the component dirty, and
  only the save button commits. The component's own camera moves are masked
  (`self.camera_is_moving`), so a programmatic `setView`/`fitBounds` never
  writes Leaflet's pixel-rounded centre over a typed or stored value.
- A record whose value is features with **no** stored view opens fitted to the
  extent of that geometry rather than on the world view. That fit is a camera
  move, not a write.
- Editing the `lat`/`lon`/`zoom`/`alt` inputs recenters the map through a single
  non-animated camera move, so a typed coordinate is never overwritten by the
  animation settling afterwards.
- Each drawn `lib_data` layer becomes a Leaflet `L.FeatureGroup` keyed by
  `layer_id`; `layer_id` is also the overlay name in the layer control. The
  active layer defaults to `1` (`self.active_layer_id = 1`).
- Map libraries (Leaflet, Leaflet-Geoman, Turf for measurements, iro for the
  colour picker) are lazy-loaded on the first map build.
- The text-area `geo` tag form is `[geo-n-{id}-data:{…FeatureCollection…}:data]`;
  inserting/removing a tag loads/unloads the matching `lib_data` layer.

## Examples

### A point with a drawn circle

```json
{
  "numisdata264": [{
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
}
```

### Import shapes

The import value is the bare data array (no lang keys). The model has its own
conform step (`src/core/tools/import_conform.ts`, reached through
`conformImportData()`), and all four documented shapes are converted into the
canonical item shape:

```json
// a full array of items — parses and passes through as-is
[{"lat": 39.4625, "lon": -0.3762, "zoom": 16, "alt": 0}]
```

```json
// a single bare item — wrapped into a one-item array
{"lat": 39.4625, "lon": -0.3762}
```

```json
// a bare GeoJSON FeatureCollection — the center is its first Point feature,
// the whole collection is stored as lib_data layer 1
{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[-0.3762,39.4625]}}]}
```

```text
a flat text cell, latitude first, dot decimals: lat, lon[, zoom[, alt]]
39.4625, -0.3762, 16
```

**Absence is structural at the import door too, and a refusal is not a clear.**
The import never fabricates a coordinate — no default center, no default
framing — and the three outcomes are kept distinct:

| the source cell | outcome |
| --- | --- |
| a usable item | stored |
| an item that **states** there is no location — both coordinate keys present and blank, or an item carrying a `lib_data` key — or an empty cell | the component is **cleared**: the source said so |
| anything else with no usable coordinate: one axis without the other, a typo'd header, `{}`, `{"zoom":12}` | **refused**, reported in the run's failed rows, and the stored value is left untouched |

An item with no coordinate but with drawn `lib_data` features is a value in its
own right and imports as geometry-only. `zoom` defaults to `16` and `alt` to
`0` on a coordinate item; comma decimals are normalized in the JSON shapes
(the flat cell uses the comma as its own separator, so it needs dot decimals);
and this is the one door that enforces the coordinate **ranges**
(`lat` −90..90, `lon` −180..180) — by refusing loudly, never by silently
dropping a value. A field with **any** refused value is not written at all,
including its values that did conform; the run report says so.

See the full import definition in
[Importing data](../importing_data.md#geolocation) and the round-trip raw format
in [Exporting data](../exporting_data.md#raw-export-and-round-trip).

## v7 consolidation / evolution

- **Typed column, not the legacy blob.** In v7 the position lives in its own
  GIN-indexed `geo` JSONB column rather than buried in a monolithic data blob,
  so it can be spatially queried (`jsonb_path_query_array(geo,'$.*[*]')`)
  without decoding the whole record. See
  [the typed-column storage model](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns).
- **Standard GeoJSON inside.** Drawn shapes are stored as plain GeoJSON
  `FeatureCollection`s under `lib_data` — no Dédalo-specific geometry format —
  which is what makes them reusable by the paired text-area geo-tag diffusion
  path (see [Server-side handling](#server-side-handling)).
- **Single-point-per-component model.** Although the value is an array, the
  editor manages one map (key `0`); multiple positions are expressed as multiple
  GeoJSON features inside `lib_data`, not as multiple array items.
- **No magic coordinate in the store.** Emptiness is the absence of a value, not
  a reserved position: an untouched map stores nothing, so no place on earth is
  unrecordable and `0` is a legal coordinate. The opening camera moved out of
  the data and into configuration (`DEDALO_GEO_DEFAULT_LAT` /
  `DEDALO_GEO_DEFAULT_LON` / `DEDALO_GEO_DEFAULT_ZOOM`), delivered as
  `context.features.default_view` — a camera, operator-configurable per install
  and per component, never a value. The one pair with a meaning left is the
  studio default, and it means something at the publication door only.
- **`0` publishes.** The v6 guards were falsy-based, so a stored `lat: 0` or
  `lon: 0` published nothing while a blank axis was coerced to a literal `0` and
  published an invented point. Both are gone: a record on the equator or the
  prime meridian now publishes the position it holds, and a blank axis publishes
  nothing. This changes the published bytes of such records, deliberately.
- **The view and the features are both published.** The three publication paths
  agree: nothing is dropped in favour of the other part of the value.

## See also

- [`component_geolocation`](../components/component_geolocation.md) — the
  producing component (Leaflet/Geoman editor, properties, render views).
- Sibling data-model pages — [media values](media.md) · [IRI values](iri.md) ·
  [misc values](misc.md) · [meta counters](misc.md#the-meta-column).
- [Sections — typed-column storage](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns)
  — how `geo` and the other typed columns are split out of the record payload.
- [Importing data](../importing_data.md#geolocation) ·
  [Exporting data](../exporting_data.md#raw-export-and-round-trip) — the import
  shapes and round-trip raw format.
