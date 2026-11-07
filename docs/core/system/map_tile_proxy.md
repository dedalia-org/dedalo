# map_tile_proxy

> See also: [component_geolocation](../components/component_geolocation.md) · [Geolocation data model](../data_model/geolocation.md#map-sources-and-legend) · [security](security.md) · [errors](errors.md) · [geo_services](geo_services.md) · [System hub](index.md)

The map tile proxy is the one door through which a map in the browser gets its tiles. The page asks
**its own server** for a tile; the server checks who is asking, finds the source the request
names, builds the provider's address itself, fetches the tile and hands it on. The page never
holds, builds or loads a provider's address.

```
GET /dedalo/core/api/v1/map_tile?<source>&<view>
```

It lives in `src/core/api/map_tile.ts` (the handler, which is its only export) with its pure parts
under `src/core/geo/tile_proxy/`.

## Why tiles go through the server

* **The page loads images from itself.** The Content-Security-Policy `img-src` needs no tile host for
  anything the proxy relays, and an editor-written source can never make a page load an image from
  wherever the editor typed.
* **A canvas export is not tainted.** A map drawn from same-origin tiles can be read back by a
  DOM-to-image export; one drawn from another origin cannot. (Do not append a cache-busting
  parameter to the tile URLs of an export: the request grammar below is closed and refuses it.)
* **The provider sees the installation**, as its terms usually ask, and not every viewer's address.
* **The permission is the record's.** A source stored in a record is served to those who may read
  that record's geolocation field, and to nobody else.

!!! warning "The server now needs outbound access to the providers"
    The browser used to fetch tiles from `tile.openstreetmap.org` and the other providers
    itself; now **the server** does, and the browser needs nothing but the server. An installation
    whose server cannot open outbound HTTPS (port 443) to the providers it relays (a firewalled
    network, a museum DMZ with no egress) shows **blank maps** after the update, for the
    OpenStreetMap base layer and for every stored or default source, until the server is allowed
    to reach them. The hosts are `tile.openstreetmap.org` and `www.ign.es` for the built-in sources,
    plus whatever host a stored source or an ontology default names (`http` sources use port 80).
    The browser itself no longer needs those hosts, so a client network that blocked them is
    no longer a problem.

## The request

A request **never carries an address**. It names a source in one of three closed shapes, and the
place on the map it wants.

| Source | Parameters | Resolves to |
| --- | --- | --- |
| stored | `section_tipo`, `section_id`, `component_tipo`, `source_id` | a source stored in that record's geolocation value (`sources[].id`) |
| default | `section_tipo`, `component_tipo`, `default_id` | an entry of the component node's `properties.map_sources` |
| built-in | `section_tipo`, `component_tipo`, `builtin` | an entry of the core's closed registry |

| View | Parameters | For |
| --- | --- | --- |
| tile | `z`, `x`, `y` | a slippy-map tile (256 px). Both source types. For a WMS source the **server** computes the GetMap bbox in the source's CRS. |
| image | `bbox`, `width`, `height` | a free GetMap image of a WMS source. `bbox` is `minx,miny,maxx,maxy` with `x` the easting or longitude; the server reverses the axes for the CRSs and WMS versions that ask for it. Each side is 1 to 1024 pixels. |

Example (a stored source of the geolocation `numisdata264` of section `numisdata6`, from the `monedaiberica` install; another install has its own tipos):

```
/dedalo/core/api/v1/map_tile?section_tipo=numisdata6&section_id=1&component_tipo=numisdata264&source_id=4&z=5&x=15&y=12
```

The grammar is closed: a key outside the shape's list is refused, so is a key given twice, and
every value must match its pattern in full. `url`, `host`, `layers`, `service` and every other
parameter that could steer the provider request are simply not keys.

## The gates, in order

Each step that fails gives **the same refusal**, so a response cannot tell "forbidden" from
"unknown":

1. The request is not cross-site (`Sec-Fetch-Site`) and not a browser prefetch or prerender
   (`Sec-Purpose`): the proxy fetches the tile a person is looking at and no other.
2. A live session, its permissions resolved for this request. No session answers `404`
   `resource.not_found`, the answer for every refusal below.
3. The query matches the grammar (otherwise `400` `request.invalid`, which depends on the query
   alone).
4. The user holds the **section** read grant and the **component** grant of the section as
   addressed (a virtual section's grants are keyed on the virtual tipo), the component is a
   `component_geolocation` of that section (a virtual section resolves to its real one), and, for a
   stored source, the record is in the user's scope.
5. The source exists and **still passes today's validator**. A source stored before a rule tightened,
   or written past the save gate by a restore, is refused here and never relayed.

Only after these does the server build the upstream address and look at its memory, so a tile held
in memory is never served to someone who failed a gate.

## The upstream address

The address is built from the source and numbers the server formats itself:

* **xyz.** The stored template with `{z}`, `{x}`, `{y}` replaced by the tile's integers. The
  source's own `min_zoom` and `max_zoom` are respected.
* **wms.** The stored endpoint (its own query, such as a `map=` parameter, is kept) with the
  query the server fixes: `service=WMS&request=GetMap`, the six stored values (`version`, `layers`,
  `styles`, `format`, `transparent`, `crs`, sent as `srs` for 1.1.1) and the bbox, width and height.
  With WMS 1.3.0 and a geographic CRS the bbox is sent latitude first.

A source is reached on the standard web port of its scheme only (80 for `http`, 443 for `https`): the
save, the import and the fetch-time check all refuse a source on `:8080`, so a source that saves is a
source that can be drawn.

!!! note "WMS sources in a geographic CRS are drawn from zoom 8"
    A WMS source whose CRS is `EPSG:4326` or `EPSG:4258` is asked for the tile's longitude and
    latitude corners, and answers a **plate carrée** crop: latitude runs linearly down the 256 rows,
    while the map draws the picture as a Web Mercator tile, where it does not. The two agree to under
    a pixel from zoom 8 up and are visibly misregistered below it (about 47 px at zoom 2, 12 px at
    zoom 4, 3 px at zoom 6). This is not what Leaflet's own WMS layer does (it asks the service for
    the map's CRS, `EPSG:3857`, and projects the bounds itself, which a service that offers only a
    geographic CRS cannot answer). So a tile view of such a source below zoom 8 is refused, the layer
    does not ask for it, and a source that offers `EPSG:3857` should be stored with it. A free image
    view carries its own bbox and size and is not affected.

The fetch goes through the harvesting door's interactive profile, so the SSRF guard vets every hop,
redirects are limited to the template's host and to the scheme's own port, and each origin has a
concurrency cap and the spacing its provider's terms ask for. A provider that answers `429` or `503`
is left alone for its `Retry-After`.

## The answer

The answer must be a `2xx` whose media type is exactly `image/png`, `image/jpeg`, `image/gif` or
`image/webp` (a WMS source is held to the format it declared) **and** whose bytes begin like that
type **and** whose header states a size within 2048 pixels a side and 4 megapixels in all. SVG,
HTML, a WMS exception document, an image with the wrong signature and an image that declares a
decode bomb (a few kilobytes of PNG can declare 30 000 x 30 000 pixels, which a browser would decode
in full) are never relayed (the table below says what the viewer gets). The body is capped at 2 MiB.
A header that states no size at all, or one that is cut short, is refused with the bomb: a browser
would not draw it either. The size is read from the header of each type (PNG IHDR, GIF logical
screen, JPEG start of frame, WebP `VP8`, `VP8L` and `VP8X`); a tile is 256 pixels, a retina tile
512, the largest free image the proxy asks for 1024.

What the provider's answer means decides the response:

| The provider answers | The viewer gets | Noise |
| --- | --- | --- |
| a verified image | the tile, `200` | none |
| `404`, `410`, or a `2xx` with no content type (a `204`) | `404` `resource.not_found`, the same body as any other "no", with `Cache-Control: private, max-age=120` and `Vary: Cookie` | counted (`map_tile_absent`), never logged: a source rarely covers the whole viewport, and that is the provider doing its job. The proxy remembers nothing of it; the `max-age` is for the browser that asked, so the same missing tile is not asked for again for two minutes |
| the proxy cannot take the request now: the origin's queue is full of other people's tiles, a person's own line did not move in time, the start cannot happen within the wait ceiling (which is also what an origin held off by a provider's `Retry-After` looks like), or the person has used their share | `429` `rate.limited` with `Retry-After`, body naming nothing | counted apart (`map_tile_busy`, or `map_tile_rate_limited` for the person's share), logged once a minute per source, **never** as a failing provider; a call the provider never heard of (refused by the door, or abandoned while it waited) is not charged |
| a `2xx` that is not an image (a WMS exception report under a `200`, a login page) | `404` `resource.not_found` | counted (`map_tile_not_an_image`) and logged once a minute per source: it is also what a wrong layer name looks like for every tile |
| any other status (`401`, `403`, `5xx`, a back-off), an image type over bytes that are not one or that declare a size past the limits, or a failure of the door itself (a refused address, a timeout) | **one** refusal, `503` `external.transport`, whose body names no host, address or token | counted (`map_tile_relay_failed`) and logged once a minute per source and reason |

A request the server does not even send to the provider (a zoom outside the source's own bounds, a view
its type does not take) is the same `404` and is only counted (`map_tile_no_address`).

The tile is returned with `Cache-Control: private, max-age=<freshness left>` (or `private, no-store`
when the provider forbade keeping it), `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`
and `Vary: Cookie`. It is never `public`: the route is authenticated.

The freshness the **browser** is told depends on what can change the source behind its address. The
proxy URL names a source by id and a tile by `z/x/y`, nothing else (the grammar is closed, so no
cache-buster can be added), and the source behind an id can change without the URL changing: an editor
changes the layers or the address of a stored source (it keeps its id), an ontology update changes a
default, a Time Machine restore brings back an older value. So a tile of a **stored source or an
ontology default** is kept by a browser for **at most five minutes**; a tile of a **built-in** source,
which changes only with the engine, for at most a day. The server's own memory is keyed by the upstream
address and is right the moment that address changes; a browser that already held an old tile can show
it for up to those five minutes after an edit.

## The memory, one call per address, and each person's share

A small cache answers an identical upstream request from bytes already held:

* it keeps only verified images, keyed by the upstream address (no user, session or record is in
  the key), for the time the provider's own `Cache-Control`, `Expires` and `Age` allow, at most a
  week; `no-store`, `no-cache` and `private` are never kept;
* it is bounded **by bytes** (32 MiB; a tile over 512 KiB is served but not kept) **and by count**
  (16 384 entries, and every entry counts at least 1 KiB however few bytes the tile has, so a source
  that answers a flood of tiny images cannot fill it with a hundred thousand entries). It evicts the
  oldest first, one entry at a time, and admitting a tile costs the same however full it is;
* it keeps **successful images only**. The provider's "there is no such tile" (a `404`, a `410`, an
  empty answer) is not remembered, nor is any failure: a stored regional source answers `404` for
  every tile outside its region, and every ask for one of those tiles that reaches the server is a call
  to the provider, charged like any other. What spares the repeat is the **browser's own cache**: the
  `404` carries `Cache-Control: private, max-age=120` (and `Vary: Cookie`), so a viewer who pans back over
  ground the source does not cover does not ask again for two minutes;
* a tile that has run out of freshness but came with an `ETag` or a `Last-Modified` is **revalidated**,
  not fetched in full again: it stays in the memory for at most a week more (in the same bounds, no
  second store), the server asks the provider `If-None-Match` / `If-Modified-Since` with the validators
  that provider gave for that very address, and a `304` renews the tile (by the freshness the `304`
  states) at the cost of a header, a `200` replaces it and a `404` drops it. A tile that came with no
  validator is fetched in full when it expires. OpenStreetMap's policy asks a cache for exactly this.
  A revalidation is a call to the provider and is charged like one.

When several people ask for the same tile at the same moment (a wall of kiosks, a dozen people on one
record) the first request starts the call to the provider and the others **join it**: the provider is
asked once, and each viewer is answered from that outcome. A viewer who leaves does not cancel a call
another still needs; the last one to leave stops it and frees its place in the queue. Joining happens
only after every gate, so nobody learns what someone else asked.

Each person also has a **share of the provider**: a bucket of 400 provider calls that refills five a
second. A request that must go to the provider and starts a call of its own spends one; a tile
answered from the memory, one that joins a call already in the air, and a call the provider never heard
of (the harvesting door refused it for its own capacity, or every viewer who needed it left while it
waited for its place — a pan or a zoom abandons every tile still queued) cost nothing; a call that did
reach the provider is charged whatever it answered, a "no such tile" included. A person who has used their share is refused `429` `rate.limited` (with `Retry-After`)
before they take a place in the provider's queue, so a script walking thousands of tiles cannot get the
installation's address refused by OpenStreetMap. A map asks for **every** tile of the viewport at once:
20 to 54 on a laptop or a phone, up to 160 on a 3840 x 2160 display at one device pixel per CSS pixel
(16 x 10), and a second layer doubles it; so a bucket of 400 lets the largest real view with two layers
load whole, and five a second sustains any real pan.

The bucket counts call **starts**, not how long a call holds a place, and it does not keep one person's
burst out of other people's way: a burst of 400 is larger than the whole queue of one origin (260), so
the bucket alone would let one person's view be everyone's line. That is the door's job (the interactive
profile, below):

* one origin has four calls in flight and a queue of 256 (a 4K layer waits whole), the whole proxy
  sixteen in flight and a queue of 512, both for at most ten seconds;
* at an origin the **administrators** chose (OpenStreetMap, an ontology default) **one person takes at
  most four places** (the origin's own four slots): the rest of their view waits in a line of their own
  (512) holding nothing, and joins the origin's queue only with a place. So one person's 300 tiles are
  four places in the queue, never 260, and another person's single tile is served after **one
  turnover**; a viewer alone on the origin is not slowed at all. Each layer on its own origin has its
  own four places. Many people at once can still fill an origin's queue (sixty-five at four places each):
  a limit per person is not a limit on a crowd;
* the addresses an **editor** wrote (stored sources) share eight of those sixteen places, and **one
  person holds at most three of the eight** at once. A person at their limit waits in a queue of their
  own (512) holding nothing, so they park no place that another reader of the same source needs. Several
  accounts that may edit records can still fill the eight: that takes several accounts, which is the cost of the attack, not a way
  round it.

A request the proxy cannot take in time (an origin's queue full of other people's tiles, or a person's
line that did not move within ten seconds) is **busy**, not a fault: `429` with `Retry-After: 2`,
counted as `map_tile_busy` and not charged, and the page asks again (below).

## What the log says

A viewport asks for dozens of tiles and anyone with a session can ask for a view a source does not
take, so the log is written sparingly: what a caller controls is only **counted**, and what an
operator can act on (a provider failing, a stored source that no longer passes the validator, a person
held to their share) is **one line per distinct reason and source per minute**, without a stack,
naming the door's code and the source (`stored:<section>.<component>#<record>/<source id>`,
`default:<component>/<id>` or `builtin:<id>`) and never an address. The counters are in
`GET /api/v1/counters`: `map_tile_relay_failed`, `map_tile_absent`, `map_tile_not_an_image`,
`map_tile_no_address`, `map_tile_rate_limited`, `map_tile_busy`, `map_tile_denied`,
`map_tile_log_suppressed`.

Asking for a map one may not read (a component without the grant, a section without the grant) is
**counted** (`map_tile_denied`) and, for the operator, written once a minute per person
(`[map_tile] perm.denied user=<id> …`, no tipo): anyone with a session can name any section and component
they can spell on a cheap request, so a line per request, or a line per spelled pair, would let a user
write the log as fast as they click. It is not the `[frontier] REFUSED` line of other read doors: the
refusal here is the uniform not-found of a route, not a narrowed answer.

## Built-in sources

The registry is code, not configuration, and holds only providers whose published terms allow a
server to relay their tiles with attribution:

| `builtin` | Provider | Type | Attribution |
| --- | --- | --- | --- |
| `osm` | OpenStreetMap standard tiles | xyz, zoom 0 to 19 | © OpenStreetMap contributors |
| `ign_admin_units` | IGN (Spain) WMS-INSPIRE, administrative units | wms | CC BY 4.0 ign.es |

What OpenStreetMap's tile policy says about a server that proxies its tiles (read 2026-11-06,
`operations.osmfoundation.org/policies/tiles/`): it **generally does not recommend** a caching proxy in
front of its servers, and where one is run it must send a clear, contactable `User-Agent` that
identifies the organisation or service, must honour the server's caching headers (or keep a tile at
least seven days when it cannot read them), must use conditional requests (`If-None-Match`,
`If-Modified-Since`) on expired tiles, must keep the `Referer`, and must not tunnel all clients behind a
single, anonymous identity (it may block such traffic without notice). So the built-in is conditional
on those. The proxy meets all of them on an installation that has a public origin, and two of them
(the identity and the `Referer`) are the ones an installation without one cannot meet:

* **Identity.** The interactive profile's `User-Agent` is the harvesting door's
  (`dedalo/<release> (+https://dedalo.dev; heritage cataloguing)`) **plus the installation's public
  origin** when an outside machine could reach it (`dedalo/<release> (+https://dedalo.dev; heritage
  cataloguing; https://museum.example.org)`), so OpenStreetMap sees one installation per origin and can
  rate-limit or block one abusive installation without taking down the others. The origin is the same
  one the geo services' `User-Agent` and the `Referer` carry (one rule).
* **Referer.** The installation's public origin, sent only to providers whose terms ask for one and
  only when that origin is one an outside machine could reach.
* **Caching.** The provider's own freshness, or a week when it states none, and a **conditional
  request** for an expired tile that came with a validator (see above).
* **No prefetch.** The proxy fetches the tile a person is looking at and no other.

An installation reachable only from its own network (`DEDALO_HOST` unset, `localhost`, a private
address, a `.local` name or a single label) **cannot** meet the identity and Referer terms: an
internal origin published to a third party is a map of the network for nothing, so the proxy sends no
Referer and the door's plain `User-Agent`, which is also what every other such installation sends.
That is **not compliant** with the policy as written, and the policy allows OpenStreetMap to block
that traffic without notice; whether such an installation should relay `osm` at all is an open
decision of the maintainers, not one this page makes for them. How OpenStreetMap treats it was not
confirmed against the live service; if an installation behind a private address finds its OpenStreetMap base layer
refused, give it a public `DEDALO_HOST` (or store another base map as a source of the record, or as an
ontology default, whose licence the installation then carries).

What the table above rests on, and what it does not. The `ign_admin_units` row is recorded in the
registry's header as read from the service's own `GetCapabilities` on 2026-11-06 (licence CC BY 4.0, the
attribution `CC BY 4.0 ign.es`, WMS 1.3.0 with `EPSG:3857` listed); the `osm` row is recorded as read from
the tile policy on the same day, as quoted above. Neither was read again for this page, and the
OpenStreetMap conditions are met only as described. DARE is **not** a built-in: its author's licence (CC BY)
is known, but nothing says whether a tile may be relayed, so it stays out until the author confirms in
writing (its place-name lookups are a different matter, see [geo_services](geo_services.md)).

Esri/ArcGIS, Carto and Google are not built-ins, and neither is Catastro: their terms do not allow a
relay. A provider an installation needs beyond the registry is data, not code: a source stored in
a record (the editor carries the licence) or an ontology default (`properties.map_sources`, chosen
by the administrators).

## In the browser

`component_geolocation` forms every tile address through `get_tile_url`, the one place the page
builds one: the OpenStreetMap base layer (`builtin=osm`), the sources stored in the entry and the
ontology's defaults are all requested from the proxy. Stored and default sources appear in the
layer control as switchable overlays, off until the viewer switches them on. The name shown in the
layer control (a default's label, a stored source's attribution) is plain text: the server refuses
`<` and `>` in both (when a stored source is saved, and when an ontology default is read), and the page
escapes them again before Leaflet writes them as HTML.

A tile the proxy refused is asked for **again**, up to twice (after about two seconds, then about five,
with a little jitter so the tiles of a viewport do not all come back in the same instant): Leaflet does
not retry a failed tile on its own, and a busy moment would otherwise leave a blank patch until the
viewer pans. An `<img>` cannot read the status or the `Retry-After`, so the retry is blind; a tile the
provider does not have is remembered by the browser for two minutes (the proxy says so in the `404`'s
`Cache-Control`), so asking again for it is answered by the browser's own cache and costs the server
nothing. A tile that has left the page by then is not asked for. An ontology default is
told to the page as its name, label, type and attribution, plus the numbers that decide which tiles
are worth asking for (an xyz source's zoom bounds, a WMS source's CRS) and never its address or layer
list, so a default shows the attribution its licence asks for and is not asked for tiles outside its
own zoom bounds. Below a source's first zoom the layer asks for **nothing** (Leaflet's `minZoom`, never
`minNativeZoom`, which would load that zoom's tiles and scale them down: at zoom 2 over a source that
starts at zoom 8 that is tens of thousands of tiles), and a geographic-CRS WMS layer is not shown below
zoom 8; above a source's last zoom its last tiles are scaled up. A source overlay is stacked above the
base map whatever order the two were added in (switching the theme re-adds the OpenStreetMap base layer
and would otherwise cover it).

The ArcGIS, DARE and Google base maps of the `ARCGIS`, `NUMISDATA`, `VARIOUS` and `GOOGLE`
`geo_provider` values are not relayed (the core relays only the providers above) and still load
straight from their providers, which is why `server.arcgisonline.com` and `dh.gu.se` remain in the
page's `img-src`.

## Gates

* `test/unit/map_tile_proxy_native.test.ts` drives the route end to end: the permission matrix
  (no session, component denied, section denied, another project, unknown source, another model's
  tipo, a virtual section), the order of the gates against the memory, SSRF (a private literal, a
  redirect to a private resolution, to another host and to another port), SVG and HTML, what each
  kind of answer means, the byte caps, the memory and its lifetimes, revalidation (a `304` renews, a
  `200` replaces, a `404` drops), WMS parameter injection, the door's budgets, each person's share
  (two people, the refill, the memory and a joined call costing nothing, an abandoned call refunded),
  one person's storm not being everyone's line, one call for identical concurrent misses (and a
  gate-failing caller never joining one), and the log: counted, not written, and one line a minute.
* `test/unit/map_tile_geometry_native.test.ts` drives the pure parts: the request grammar, the tile
  geometry and axis order (and the misregistration of a geographic-CRS tile, measured), the upstream
  address, the freshness rules, the memory's bounds and the flat cost of an admission (and that it
  can remember no refusal), the validators of a revalidation, what a provider's answer means, the request handed the door (with a synthetic non-zero spacing, through the
  real door), the budget, the flights, the log, the one rule for the origin the installation tells a
  provider, and the built-in registry.
* `test/unit/harvest_door_native.test.ts` drives the door's interactive profile itself: its numbers,
  the required `holder` and `addressFrom`, the `User-Agent` with the installation's origin, the two
  validators a revalidation sends, one person's cap on the stored slots and one person's places at a
  registry origin (the cap, the queue of their own that holds nothing, the ceiling, the bound, a
  stopped request).
* `test/unit/ssrf_one_guard_tripwire.test.ts` pins that this route is the only holder of the
  interactive profile and exports nothing that takes a URL; `read_door_acl_native` probes it as a read
  door; `xss_csp_tripwire` reads every script of `client/` and `tools/` to pin which tile hosts the
  page's CSP still names.
