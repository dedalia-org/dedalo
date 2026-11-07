# WC-2026-11-06-map-tile-proxy — map tiles come from `GET /dedalo/core/api/v1/map_tile`, and the page's `img-src` loses the OpenStreetMap and Carto hosts

- **Date:** 2026-11-06.
- **Decision:** — (maintainer decision of the same day: the tile proxy is a core route, not a tool
  action; it relays a source the request NAMES and never a URL; built-in providers only where their
  terms allow a server to relay them, OpenStreetMap "subject to verified terms"; the cache holds
  successful image responses only, follows the provider's `Cache-Control` and is bounded by bytes).
  Gates: `test/unit/map_tile_proxy_native.test.ts`, `test/unit/map_tile_geometry_native.test.ts`,
  `test/unit/xss_csp_tripwire.test.ts`, `test/unit/read_door_acl_native.test.ts`,
  `test/unit/ssrf_one_guard_tripwire.test.ts`, `test/unit/module_state_tripwire.test.ts`.
  Data side (what a source may store): `WC-2026-11-06-geolocation-map-sources-legend`.
- **Open — not decided by the maintainer, so recorded and not assumed:**
  1. *OpenStreetMap on an installation with no public origin.* The verified terms
     (operations.osmfoundation.org/policies/tiles/, read 2026-11-06) ask a caching proxy for a clear,
     contactable `User-Agent` identifying the service, no tunnelling of every client behind one
     anonymous identity, the `Referer` kept, the caching headers honoured (or 7 days) and conditional
     requests on expired tiles. The proxy now meets all of them where the installation has a public
     origin an outside machine could reach. Where it has none it cannot meet the first and the
     `Referer`: it sends the plain Dédalo identity (shared by every such installation, which the policy
     lets OSM block) and no `Referer`. Whether such an installation may relay `osm` at all (today it
     does; the alternative is to refuse the built-in there) needs the maintainer's word.
  2. *`Cache-Control: private, max-age=120` on the 404 for "the provider has no such tile".* The proxy
     itself keeps no refusal (the decision for the cache: successful images only). The `max-age` is a
     hint to the one browser that asked, so a pan does not ask again, and it is the only thing that
     spares the person's budget a repeat. It was not part of the decision; removing it is one line
     (`absentCacheControl`) and makes every pan over uncovered ground a charged provider call.

This entry records what a CLIENT of the engine sees change: a new authenticated route, the
narrowing of the page's `img-src`, the tile addresses the geolocation client now forms, and the
extra keys the structure context carries for an ontology default.

## Shape before (PHP)

The geolocation client built every tile address itself and the BROWSER fetched it from the
provider:

```js
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { … })
```

so the app CSP named the providers' hosts:

```
img-src 'self' data: blob: [MEDIA_CSP_ORIGIN] *.tile.openstreetmap.org *.tile.osm.org
        *.basemaps.cartocdn.com server.arcgisonline.com dh.gu.se
```

The provider saw every viewer's address, a canvas export of the map was tainted (a cross-origin
image cannot be read back), and a source an editor typed into a record could not have been drawn
without letting the page load an image from wherever they typed.

## Shape after (TS)

### The route

`GET /dedalo/core/api/v1/map_tile?<source>&<view>` — authenticated (the session cookie), a classified
read door (`READ_DOOR_EXTRA_DOORS`, posture `component`). The query is a CLOSED grammar
(`src/core/geo/tile_proxy/tile_request.ts`): a key outside it is refused, so is a key given twice, and
no key carries an address, a host, a header or a parameter of the provider's.

| Source (exactly one) | Keys |
|---|---|
| stored | `section_tipo`, `section_id`, `component_tipo`, `source_id` |
| ontology default | `section_tipo`, `component_tipo`, `default_id` |
| built-in | `section_tipo`, `component_tipo`, `builtin` (`osm`, `ign_admin_units`) |

| View (exactly one) | Keys |
|---|---|
| tile | `z`, `x`, `y` |
| free WMS image | `bbox` (`minx,miny,maxx,maxy`, x = easting), `width`, `height` (1..1024) |

Responses:

| Status | Body | When |
|---|---|---|
| `200` | the image: `Content-Type` one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, its header declaring a size within 2048 px a side and 4 Mpx; `Cache-Control: private, max-age=<freshness left>` — at most a day for a built-in source, **at most 300 seconds for a stored source or an ontology default** (the source behind a proxy URL can be edited without the URL changing) — or `private, no-store` when the provider forbade keeping it; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none'; sandbox`; `Cross-Origin-Resource-Policy: same-origin`; `Referrer-Policy: no-referrer`; `Vary: Cookie` | a verified tile |
| `404` `resource.not_found` | the converter's envelope, `Cache-Control: no-store` | no session, a cross-site or speculative request (`Sec-Fetch-Site: cross-site`, `Sec-Purpose: prefetch`), a source the caller may not read or that does not exist (ONE body for both), a view the source does not take, or a provider that answers a 2xx that is not an image |
| `404` `resource.not_found` | the same envelope, `Cache-Control: private, max-age=120`, `Vary: Cookie` | **a provider that has no such tile** (404, 410, no content). The proxy remembers nothing of it: every ask is a provider call, charged like any other; the `max-age` is for the BROWSER that asked, so a pan over ground a source does not cover does not ask again for two minutes. The body is byte-identical to every other 404; only a caller who passed every gate sees the `max-age` |
| `400` `request.invalid` | envelope | the query is outside the grammar (depends on the query alone, so it is no oracle) |
| `429` `rate.limited` | envelope + `Retry-After` (seconds) | the caller has used their share of provider calls (a token bucket per user: a burst of 400, 5 a second), **or the proxy is at capacity** (an origin's queue is full of OTHER people's tiles — one person holds at most four places in it, the rest of their view waits in a line of their own — or the start could not happen within the wait ceiling, which is also what an origin held off by its provider's `Retry-After` looks like): `Retry-After: 2`, a moment and not a verdict; the page asks again, twice |
| `503` `external.transport` | envelope; names no host, address or token | a FAULT upstream: the door's refusal (other than its capacity), a provider status that is not "no such tile", an image whose bytes are not its type or whose header declares a size past the limits or none |

### The page's CSP

`img-src` no longer names `*.tile.openstreetmap.org`, `*.tile.osm.org` or `*.basemaps.cartocdn.com`:
`'self'` admits the proxy's same-origin tiles. The hosts it still names (`DIRECT_TILE_HOSTS`:
`server.arcgisonline.com`, `dh.gu.se`) are exactly the ones a client script still draws from directly
(the ArcGIS, DARE and Google base maps are not relayed: their terms do not allow it or are not
confirmed), and `xss_csp_tripwire` reads every script of `client/` and `tools/` to keep that true.

### The client

`component_geolocation` forms every proxied tile address through `get_tile_url`, which names a source
and keeps `{z}`, `{x}`, `{y}` literal for Leaflet. The OpenStreetMap base layer is
`builtin=osm`; the sources stored in the entry and the ontology's defaults are switchable overlays,
off until the viewer switches them on. A source's own `min_zoom` is the layer's Leaflet `minZoom`: below
it the layer asks for NO tile (a `minNativeZoom` would have Leaflet load that zoom's tiles and scale them
down, four times as many per zoom level of difference: 37 000 tiles for a 1000x600 map at zoom 2 over a
source that starts at zoom 8); above its `max_zoom` its last tiles are scaled up (`maxNativeZoom`). The
OSM provider's base layer, which the page re-adds on every theme change and which is not in the layer
control, is z-index 0, under every source (the control numbers the sources 1, 2, 3 …), so a theme toggle
does not hide an overlay the viewer had switched on.

### The structure context, for an ontology default

`context.properties.map_sources` still carries NO address: each valid default is replaced by
`{ id, label, type, attribution, min_zoom?, max_zoom?, crs? }` (flat keys; no `params` object, no
`url`, no layer list). `attribution` is what the licence asks to be shown; `min_zoom`/`max_zoom` (xyz)
and `crs` (wms) are what the page needs to ask only for tiles worth asking for. A default that earlier
carried `{ id, label, type }` alone is unchanged for a consumer that ignores the extra keys.

### Geographic-CRS WMS sources are relayed as tiles from zoom 8

A WMS source whose CRS is `EPSG:4326` or `EPSG:4258` is asked for the tile's longitude/latitude
corners and answers a plate carrée crop, which the (mercator) map draws as a mercator tile. The two
agree to under a pixel from zoom 8 and are visibly misregistered below it (about 47 px at zoom 2,
12 px at zoom 4, 3 px at zoom 6). This is NOT what Leaflet's own WMS layer does (it asks the service
for the MAP's CRS, `EPSG:3857`, and projects the bounds itself, which a service offering only a
geographic CRS cannot answer). So a TILE view of such a source below zoom 8 is refused (`404`, as any
view the source does not take) and the client does not ask for it; a FREE IMAGE view carries its own
bbox and is not affected.

### Operator-visible behaviour

Not wire shape, but contract: a provider failing every tile of every viewer writes one log line per
source and reason per minute (`map_tile_log_suppressed` counts the rest); what a caller controls (a
zoom outside a source, a view it does not take, a provider's "no such tile") is counted
(`map_tile_no_address`, `map_tile_absent`, `map_tile_not_an_image`) and never logged; a person held to
their budget is counted (`map_tile_rate_limited`), the proxy at capacity is counted apart (`map_tile_busy`, one line per source per minute, never `map_tile_relay_failed`), and asking for a map one may not read is counted (`map_tile_denied`) and written once a minute per person (no `[frontier]` line per request). Identical concurrent misses are one provider call.

**The server now needs outbound access to the providers.** The browser used to reach
`tile.openstreetmap.org` and the other providers itself; now the SERVER does (outbound HTTPS to
`tile.openstreetmap.org`, `www.ign.es` and every host a stored source or an ontology default names), and
the browser needs nothing but the server. An installation whose server has no egress (a firewalled
network, a DMZ) shows blank maps after the update until it is given some. The changelog fragment is
`breaking: true`, audience `admin`, for this reason.

**Identity toward the provider.** The interactive harvesting profile's `User-Agent` names the
INSTALLATION as contact: `dedalo/<release> (+https://museum.example.org)` (amended 2026-11-07, owner
decision: the installation, not only the software, is identified). Its origin, the tile `Referer`'s and
the geo services' are ONE derivation (`resolve/public_reach.ts` `reachablePublicOrigin`), so the three are
byte-equal whenever present and present or absent together. The configured `DEDALO_PROTOCOL` +
`DEDALO_HOST` is parsed once (WHATWG URL) and judged: http(s); a bare origin (no credentials, path but
`/`, query or fragment); no control character or whitespace; a well-formed host reachable from outside
(`.arpa` and `.alt` added to the unreachable suffixes, malformed labels refused); canonical origin ≤100
characters, ASCII (an IDN host is sent as punycode; scheme case, `https:` without slashes and a default
port are canonicalized). An installation with no such origin — unset, loopback, private, an intranet name,
a malformed host, OR a configured value carrying credentials/a path/a query/a fragment, which is not
repaired — sends the shared `dedalo/<release> (+https://dedalo.dev; heritage cataloguing)` and no
`Referer`. Same-day amendment 2026-11-07 (deliberate, gated in `map_tile_geometry_native`,
`map_tile_proxy_native`, `geo_services_native`): the `Referer` and the geo services' origin used to
canonicalize a value with credentials or a path into its bare origin; they now follow the single rule
and send none, so the contact identity and the `Referer` can never disagree
(OpenStreetMap's policy generally does not recommend a caching proxy, requires one to identify the
service and not to tunnel every client behind one anonymous identity, and may block traffic that does
not; documented in `docs/core/system/map_tile_proxy.md`; the open question of this entry, item 1).

**Conditional requests for expired tiles.** A tile that came with an `ETag` or `Last-Modified` is kept
past its freshness (at most a week more) and asked about with `If-None-Match` / `If-Modified-Since`:
`304` renews it by the freshness the `304` states, `200` replaces it, `404`/`410` drops it. The condition
carries only the validators THAT provider gave for THAT address and goes to that address alone; the
route is still a call to the provider and still charged. A tile without a validator is fetched in full
when it expires, as before. The OpenStreetMap policy asks a cache for exactly this.

**One person's share of the places.** For an address an editor wrote, a person holds at most three of the
eight slots that stored sources share (the interactive profile's `holder`, a required field of the
request, is the session's user id). For an address the administrators chose (the built-in registry, an
ontology default), a person holds at most four places in an origin's queue and the rest of their view
waits in a line of their own (512), so one person's 300 tiles never fill the queue everyone shares and
another person's tile is served after one turnover. A call every viewer left while it waited for its
place (a pan or a zoom abandons every tile still queued) never reached the provider and is not charged.
This is invisible on the wire except as a viewer of a busy origin waiting its turn.

**The ontology default's label is plain text** (`<` and `>` refused, as for the attribution): a default
whose label carries either is rejected at read time, never offered, and the page escapes the name
again before Leaflet's layer control writes it as HTML.

## Reason

The page must load only from itself (a CSP with no tile host for what the proxy relays), a canvas
export of a map must not be tainted, a stored source must be an editor's DATA and never a URL the page
fetches, and the provider must see the installation (as its terms ask) and not every viewer. The route
is the one place the permission, the address, the provider's terms and the SSRF guard meet.

## Gate reconciliation

No PHP differential exists for this seam (the PHP engine drew these layers in the browser). The
contract is held by the native gates named above: the route end to end against a loopback provider
(permission matrix, order of the gates against the memory, SSRF, answer kinds, WMS injection, budgets,
single flight, noise), its pure half (grammar, geometry and the measured misregistration, upstream
address, freshness, the bounded memory, the request handed the door), the CSP scan over every client
script, and the read-door census. No oracle fixture is affected.
