# geo_services

> See also: [map_tile_proxy](map_tile_proxy.md) · [component_geolocation](../components/component_geolocation.md) · [Geolocation data model](../data_model/geolocation.md) · [errors](errors.md) · [Tools server contract](../../development/tools/server_contract.md#read-only-actions-readonly-true) · [System hub](index.md)

The geo services are the engine's one way of asking a public geographic service a **fixed question**:
the places called *Tarraco*, the address of a point, a cadastral parcel, the administrative unit under
a pixel, the elevation of a point. A tool (or a job) calls one function with a service id and the
parameters of the question; the engine checks them, spaces the call the way the provider asks, and hands
back the provider's answer with the attribution it wants shown.

```ts
callGeoService('nominatim_search', { q: 'Tarraco', countrycodes: 'es', limit: 5 })
```

It lives in `src/core/geo_services/` and exports one function, `callGeoService(id, params)`.

!!! note "Nothing ships a user interface for it yet"
    No tool of this release calls it. It is the door a tool uses when it needs a place lookup (a
    geocoder in a geolocation editor, a parcel picker), so that the lookup is subject to one set of rules
    instead of each tool carrying its own.

## What a call can and cannot say

A request **never carries an address**. `id` is a key of a closed table, and `params` are checked against
that service's grammar; the engine builds the address itself from the table's origin and path, with
`URL` and `URLSearchParams`, so no value can move the host, the path or the structure of the query.

* An id outside the table (a URL, `__proto__`, another case) is refused as `request.invalid_data`, with
  no connection and no place taken in a queue.
* A parameter the service does not list, a missing required one, a value off its grammar, and a failed
  cross-check (an inverted box, a pixel outside the image, a box over the service's ceiling) are the same
  refusal.
* A value full of `& # = /` stays one value of its own key.
* No header, cookie, credential or `Referer` is the caller's, and none is sent.
* **No configuration key moves a service.** The endpoints, parameters, ceilings and spacings are the
  code's and a change is a reviewed edit of `src/core/geo_services/table.ts`. The table is frozen all
  the way down, so a tool that imports it cannot rewrite a row.

## The services

| `id` | Provider | Question | Caller parameters (all checked) |
| --- | --- | --- | --- |
| `nominatim_search` | Nominatim (OpenStreetMap) | a place by name | `q` (3 to 200 characters), `countrycodes`, `limit` (1 to 10), `viewbox`, `bounded`, `language`, `addressdetails` |
| `nominatim_reverse` | Nominatim | the place at a point | `lat`, `lon`, `zoom` (0 to 18), `language`, `addressdetails` |
| `dare_search_modern` | DARE, Digital Atlas of the Roman Empire (`imperium.ahlfeldt.se`) | a place by its modern name | `name` (3 to 100 characters) |
| `dare_search_ancient` | DARE | a place by its ancient name | `name` (3 to 100 characters) |
| `dare_nearest` | DARE | the atlas places nearest a point | `point`, `zoom`, `count` (1 to 20) |
| `dare_place` | DARE | one place, in full | `id` (digits) |
| `catastro_wms_featureinfo` | Catastro (Spain), INSPIRE view service | the parcel under a pixel | `crs`, `bbox`, `width`, `height`, `i`, `j` |
| `catastro_wfs_parcel` | Catastro, INSPIRE download service | one parcel by cadastral reference | `refcat` (14 or 20 characters), `crs` |
| `catastro_wfs_parcels_bbox` | Catastro | the parcels in a small box | `crs`, `bbox` |
| `ign_admin_units_featureinfo` | IGN (Spain), WMS-INSPIRE | the administrative unit under a pixel | `crs`, `bbox`, `width`, `height`, `i`, `j` |
| `open_elevation_lookup` | open-elevation | the elevation of up to 25 points | `locations` |

The WMS and WFS services take their box in the units of the `crs` they name. `CRS:84` is longitude then
latitude; `EPSG:4326` and `EPSG:4258` are **left out on purpose**, because a WMS 1.3.0 reads their box as
latitude first and a caller who writes longitude first would get a valid answer for the wrong place. A
box is accepted at its service's ceiling and refused one step over: the Catastro parcel box is about a
city block (1 000 metres, or 0.01 degrees), not a district, because the provider forbids massive
downloads.

An answer that is a **lookup** is a result: `{service, kind: 'json', data, attribution}` or, for the
two Catastro services whose answer is markup, `{service, kind: 'markup', text, attribution}`. The
`attribution` is the sentence the provider asks to be shown beside its data; show it.

## Being a good client

Each provider is an **origin** with its own pacing, which every service of that origin shares:

| Origin | Calls at once | Least time between calls |
| --- | --- | --- |
| `nominatim.openstreetmap.org` | 1 | 1.1 s |
| `imperium.ahlfeldt.se` | 1 | 0.5 s |
| `ovc.catastro.meh.es` | 2 | 0.25 s |
| `www.ign.es` | 2 | 0.25 s |
| `api.open-elevation.com` | 1 | 1 s |

* For an origin that lets one call fly at a time, the interval is also counted from the **end** of the
  previous call, so the rate holds on the wire and not only between two starts.
* Callers wait in a bounded queue for a bounded time. A caller that cannot start in time is refused
  `rate.limited`, which is **busy, not a fault**.
* After a `429` or a `503` the origin is left alone for a back-off (10 to 30 seconds, always longer than
  the wait ceiling), and a newcomer in that time is refused at once.
* **Identical calls in the air are one call.** A re-send of the question that is already flying (the
  browser re-sends a stalled request) joins it instead of taking a place and a second provider request.
* **Nominatim's answers are kept for an hour**, as its policy asks of a client: an identical question
  inside that time is answered from memory with no call at all, including the provider's "nothing
  there". The memory is small (2 MiB, oldest out first) and holds only good answers. The other providers'
  answers are not kept.
* Every call goes through the same address guard as the rest of the engine's outbound requests: the name
  is resolved and vetted, the connection goes to the address vetted, a redirect is never followed, and
  each service has its own deadline and its own byte ceiling (an answer over it is refused, never
  truncated).

A failure is typed and names no address, host or query: `external.not_found` (the provider answered and
there is nothing there), `external.http_status` (a transient provider error, retryable), `external.bad_config`
(the provider refused this request, not retryable), `external.timeout`, `external.transport`,
`external.too_large`, `external.protocol` (the answer is not the shape the service promises),
`external.blocked_host` and `rate.limited`. See [errors](errors.md).

Every service is a read. A tool action that calls one should declare itself
[read-only](../../development/tools/server_contract.md#read-only-actions-readonly-true), and refuse with
the retryable `tool.source_unavailable` and a `reason_key` when the provider is down, so that the
browser's resend shows the real reason (see [A tool's refusal reason](errors.md#a-tools-refusal-reason)).

## Who the engine says it is

Every call sends the same `User-Agent`:

```
dedalo/<release> (+https://dedalo.dev; https://museum.example.org)
```

the product and release, the project's site, and the installation's **public origin** (`DEDALO_PROTOCOL`
and `DEDALO_HOST`), so that a provider can tell one installation from another and write to it if it
misbehaves. The origin is left out when the host is unset, `localhost`, a private or reserved address, a
single-label name or a name under a suffix no outside resolver answers (`.local`, `.internal`, `.lan`,
`.home.arpa`, `.test`): an address that only means something inside the network is not published to
third parties. No person's address (the mailer's `From`, an administrator's email) is ever sent.

!!! warning "Privacy: what the providers learn"
    The question leaves **the server**, not the browser, and the provider receives the text or numbers of
    the question and the address the server connects from. What that means for an institution:

    * **Nominatim receives what the cataloguer typed or pointed at**: a place name, or a latitude and
      longitude. Sending the coordinates of a vulnerable site (an unexcavated or looted-at-risk
      archaeological site, a private collection) to a public geocoder tells the foundation that runs it
      and anyone who reads its logs where the site is. Reverse geocoding is the call that does this;
      `nominatim_search` sends only the name. The same holds for `open_elevation_lookup`, which sends
      the points themselves to a best-effort public service.
    * The provider sees the installation's public origin in the `User-Agent` (see above) and the server's
      own network address, never the cataloguer's session, name or browser. Many people's questions come
      from one address, which is also what the pacing and the memory above keep within the provider's rate.
    * Nominatim's policy asks for an identifying `User-Agent`, at most one request a second for the whole
      installation, attribution shown, no as-you-type search (hence the three-character floor on `q`) and
      results cached. These are the terms the maintainers recorded when the table was written
      (`src/core/geo_services/table.ts`); they were **not** re-read against the live policy for this page,
      and what the foundation does with the logs of a request was not checked at all. Treat the providers
      as third parties who may keep what they are sent.
    * The policy also asks that an application be switchable away from its service without a software
      update. With no configuration key this is **not** met: moving off a provider is a code update.
      That deviation was decided by the maintainers.
    * An installation that must not tell a third party where its sites are should not offer a tool that
      calls these services, or should leave the server without outbound access to the hosts above
      (every call then fails and nothing reaches the provider).

!!! warning "The server needs outbound access"
    The hosts are `nominatim.openstreetmap.org`, `imperium.ahlfeldt.se`, `ovc.catastro.meh.es`,
    `www.ign.es` and `api.open-elevation.com`, all on HTTPS (port 443). A server with no outbound access
    gets `external.transport` for every call.

## Terms of the providers

What each row of the table assumes. Nothing here was checked against a provider's live terms for this page: each row says whose
record it is.

| Provider | Terms the table keeps | Status |
| --- | --- | --- |
| Nominatim | usage policy: identifying `User-Agent`, one request a second, no as-you-type search, cached results, attribution `© OpenStreetMap contributors (ODbL)` | recorded by the maintainers; not re-read for this page |
| DARE | released under CC BY with scholarly attribution (Johan Åhlfeldt, Centre for Digital Humanities, University of Gothenburg) | recorded by the maintainers; not re-read for this page. Whether a **tile** may be relayed is unconfirmed, so DARE is not a [built-in tile source](map_tile_proxy.md#built-in-sources) |
| Catastro | the licence forbids distributing the original information over the Internet without transforming it, and its WMS notice forbids massive downloads: the services here are **lookups** that extract a field, never a relay of the provider's imagery, with the box capped | recorded by the maintainers; not re-read for this page |
| IGN | CC BY 4.0, attribution `CC BY 4.0 ign.es` | the maintainers' note records the attribution as read from the service's own `GetCapabilities` on 2026-11-06 (not repeated for this page) |
| open-elevation | a best-effort public service with a small keyless allowance; a `429` is a typed refusal, never something to route around | recorded by the maintainers |

## Gates

* `test/unit/geo_services_native.test.ts` drives every service end to end against a loopback peer, with
  no real network: the closed table and every number pinned as a literal, the grammar and the
  cross-checks, the failures and their codes, the pacing at the millisecond, the shared flights, the
  answer memory and the identity header.
* `test/unit/ssrf_one_guard_tripwire.test.ts` pins that exactly one module of the folder holds an
  outbound door (the guarded text one), that the entry point takes `(id, params)` and nothing else, and
  that no module outside the folder can open the test seams.
