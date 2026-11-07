# WC-2026-11-06-geolocation-map-sources-legend — a geolocation entry carries `sources` and `legend` beside `lib_data`

- **Date:** 2026-11-06.
- **Decision:** — (maintainer decision of the same day: map sources and legend live in
  `component_geolocation`'s own data and are saved through the component's normal save; DEC-12
  gates: `test/unit/geo_map_source_native.test.ts`, `geo_entry_gate_native.test.ts`,
  `geo_sources_legend_save_native.test.ts`, `geo_sources_legend_import_native.test.ts`,
  `geo_sources_legend_diffusion_native.test.ts`, `geo_map_source_lookup_native.test.ts`,
  `geo_contract_guards_native.test.ts`).

The stored geolocation entry gains two OPTIONAL sibling keys. Nothing is removed or reshaped; an
entry without them is byte-identical to what v6 and every earlier v7 stored.

## Shape before (PHP)

```json
{ "id": 1, "lat": 41.38, "lon": 2.17, "zoom": 12, "alt": 16, "lib_data": [ { "layer_id": 1, "layer_data": { "type": "FeatureCollection", "features": [] } } ] }
```

`lat`/`lon`/`zoom` are the VIEW, `lib_data` the FEATURES (pure GeoJSON layers; see
`WC-2026-08-08-geolocation-emptiness-explicit`, second addendum). The base map was a client-side
constant per `geo_provider`; a record could not say which map it was drawn over, nor carry a legend.
The server saved any object under the key and judged nothing about it.

## Shape after (TS)

```json
{
  "id": 3, "lat": 41.38, "lon": 2.17, "zoom": 12, "alt": 16, "lib_data": [ … ],
  "sources": [
    { "id": 4, "type": "xyz", "url": "https://tiles.example.org/{z}/{x}/{y}.png",
      "params": { "max_zoom": 18 }, "attribution": "Example Org" },
    { "id": 5, "type": "wms", "url": "https://wms.example.org/service",
      "params": { "version": "1.3.0", "layers": "base", "styles": "", "format": "image/png",
                  "transparent": false, "crs": "EPSG:3857" },
      "attribution": "Example WMS" }
  ],
  "legend": { "title": "Roman roads",
              "groups": [ { "name": "Surface", "symbols": [ { "label": "Paved", "icon": "data:image/png;base64,…" }, { "label": "Track" } ] } ] }
}
```

`lib_data` stays PURE GeoJSON: the siblings are never inside it, and no reader of `lib_data` changes.
The contract lives in `src/core/geo/` (validators, pure) and is reached by the save through the
`itemGate` descriptor facet (`section/record/item_gates.ts`). The proxy that serves tiles and the
client that draws them are other changes; this one fixes the DATA and what the server will accept
into it.

### `sources[]` — a source is data the server reads, never a URL the browser fetches

| key | rule |
|---|---|
| `id` | positive integer, **issued by the server** (below) |
| `type` | `xyz` or `wms` |
| `url` | the stored TEMPLATE (below) |
| `params` | closed per type; an unknown key is refused, never dropped |
| `attribution` | plain text, ≤ 300 characters; `<` and `>` refused (a client that hands it to an HTML sink — Leaflet's attribution control — still cannot open a tag); may be empty; judged again when served (a stored one that no longer conforms is sent blank) |

`params`, `xyz`: `{}` or `{ min_zoom?, max_zoom? }` — integers 0..22, `min_zoom` ≤ `max_zoom`.
`params`, `wms`: `version` (`1.1.1` | `1.3.0`), `layers` (name list), `styles` (name list, may be
empty or carry empty items — one style per layer), `format` (`image/png` | `image/jpeg` |
`image/gif` | `image/webp`), `transparent` (boolean, default `false`), `crs` (`EPSG:3857` |
`EPSG:4326` | `EPSG:4258`). `layers`, `version`, `format` and `crs` are required. A name is
`[letters digits _ . : / - space]` — no `& # % ? = ;`, no CR/LF — at most 128 characters, 32 per
list, 512 per list. The CRS list is narrow on purpose: widening it is one line plus an addendum,
narrowing it later would orphan stored sources. NOTHING else is stored for a WMS source: the server
fixes `service=WMS&request=GetMap` and takes `bbox`/`width`/`height` from the tile request.

**The URL template** (`src/core/geo/map_source_url.ts`, ONE validator for the save gate, the import
conform and the proxy's fetch-time re-check): `http`/`https` only; no credentials; no fragment; no
whitespace or control character; at most 2048 characters. `xyz` carries `{z}`, `{x}` and `{y}` —
each at least once, in the path or the query, never in the host, port or userinfo — and **no other
placeholder** (`{s}`, `{r}`, `{-y}` are refused: a template language the server does not implement
is a hole). `wms` carries no placeholder, and its own query must not set a key the server sets
(`service request version layers styles format transparent crs srs bbox width height exceptions
bgcolor`). The host must not be a private or loopback ADDRESS LITERAL — judged by the SSRF guard's
own predicates (`isPrivateIp`, `isLoopbackHost`), so every spelling (`2130706433`, `0x7f000001`,
`[::ffff:127.0.0.1]`) is caught — nor a loopback or single-label name. That is the literal half;
a public name that resolves to an internal address only exists at connect time and is closed there
by the pinned fetch every outbound door uses. A refusal names the path and the rule and **never
quotes the value** (a template may carry a provider token; the log must not).

**Source ids are server-issued, unique across the component value, and never reused.** They are
numbered from the component's own item counter (`allocateComponentItemId`: atomic, monotonic, the
counter that already numbers items). An id is a **per-record number**: it means "this record's source
N". The gate settles every source of a value in three steps, in this order:

1. **keeps** its id when it names a source the component **already stores** and no earlier source of
   the value holds it (the first source to name an id holds it, across every entry of the value);
2. **adopts a stored id by content** when it keeps none — a source with no id (the only way a
   hand-written CSV/JSON cell can name one: ids are server-issued), with an id the component does not
   store, or that repeats an id already held, takes the id of a stored, still-unheld source it equals
   (id aside, as written or once normalized). An explicit id always outranks a content match, wherever
   in the value the two sit; a stored source is adopted once; twins are adopted in stored order;
3. is otherwise **new** and receives the next number from the counter.

**What the outcome does not depend on, and what it does.** An explicit id outranks a content match
wherever in the value the two sit, and a stored source is adopted once, however the value is ordered.
Two sources that name the **same stored id** are the exception: they are resolved by **position** —
the one listed first holds the number, the other is a copy and is numbered. So `[genuine, foreign]`
and `[foreign, genuine]`, both naming stored id 4, each keep ONE of the two under 4 — the first —
and the genuine stored source is renumbered in the second order. That is the same law as above
(*an id is a per-record number; a foreign entry that names a number the record holds is an edit of
that source*), not an accident of the implementation; a caller that needs the genuine source to keep
its number lists it first, or does not send the foreign one under that number.

Therefore:

- no caller can mint a colliding id, and none can name a future one;
- a deleted source's id is no longer a stored id, so a value that sends it back (an undo, a
  propagated copy, a re-imported export) gets a **fresh** id — never the old one. Only ids the
  component STORES are ever adopted;
- **re-importing an unchanged cell is a no-op.** The same id-less cell saved twice stores the same
  bytes and leaves the counter where it was; under a bulk run (an import, propagate) the undo log
  writes nothing for it (`WC-2026-09-27-bulk-revert-undo-log` §2). The gate also gives an entry that
  arrives without an id the id of the stored entry at its position when, once its sources are
  settled, it equals that entry (`concepts/item_value.ts`, the rule the `set_data` carry-over applies —
  run again here because that one runs before the gate and compares id-less sources with stored ones
  that carry ids). An ordinary (non-bulk) save of an unchanged value still leaves its visible history
  row, as every ordinary save does;
- the same stored id twice in one value is **not an error**: the second is a **copy** (a duplicated
  row, a propagated entry from another record) and is numbered like any new source;
- **an id the record holds is honoured by number, whatever its origin.** A value that comes from
  another record (`tool_propagate_component_data`, a `set_data` of a foreign entry, a re-import of
  another record's export) carries that record's numbers. Small numbers restart on every young record,
  so they coincide often: a foreign source that names an id the target holds is an **edit of the
  target's source N** — the content is replaced — exactly as editing that source would. A foreign id the
  target does not hold is replaced by a number from the target's counter. Identity is the number, never
  the content; "never reused" is a law of the number the SERVER hands out, not a claim that a number
  denotes the same URL forever;
- before minting, the save raises the counter past every stored source id: a duplicated record's
  counter is copied from the ITEM ids alone, a restored one can lag, and minting without the raise
  would hand out a taken number.

The save response echoes the final ids; the client learns them there and names a source by
`{section_tipo, section_id, component_tipo, source_id}` from then on.

### `legend` — text, and raster icons rendered only as `<img>`

`{ title, groups: [ { name, symbols: [ { label, icon? } ] } ] }`, closed at every level. Text
(title, name, label) is bounded and control-free; a value that reads as the START OF A TAG
(`<img`, `</`, `<!`, `<?`) is refused, while `Altitude < 50 m` is fine. An `icon` is a **base64
`data:` URI of `image/png`, `image/jpeg` or `image/webp`**, nothing else — never svg, never a URL —
and its header must agree with the declared type (a `data:image/png` whose payload is markup is
refused) and declare at most 256 x 256 pixels. The client renders an icon only as the `src` of an
`<img>`, and text only as text: refusing a tag start leaves text inert **as element content**, not
inside an attribute string (quotes stay legal).

| cap | value |
|---|---|
| sources per entry | 24 |
| URL | 2048 characters |
| attribution | 300 characters |
| groups per legend / symbols per group | 16 / 64 |
| title, name, label | 200 characters |
| one icon (the URI string) | 64 KiB |
| one icon's size, from its own header | 1 to 256 pixels a side |
| icons of one legend together | 256 KiB of characters, and 1 Mpx (1,048,576 pixels) |
| sources, all entries of one value together | 96 (four entries of 24) |
| icon characters, all entries of one value together | 1 MiB (four legends of 256 KiB) |
| legends that say something, all entries of one value together | 4 |
| legend text characters (title, names, labels), all entries of one value together | 832,800 (four legends of 208,200: 200 + 16 x (200 + 64 x 200)) |

**The icon bytes do not bound what the browser decodes; the header does.** A 1-bit PNG declaring
16000 x 16000 pixels is a few dozen bytes on the wire and about a gigabyte once decoded, and the legend
rides to every viewer who opens the record. So the width and height are read from the image's own
header (`src/core/geo/icon_image.ts`: PNG IHDR, the first WebP chunk — VP8, VP8L or VP8X — and the first
JPEG SOFn segment, read through any metadata before it) and bounded per icon and for the legend's
icons together; a header that cannot be read, or names an unknown first chunk, is "not the declared
format". Nothing is decoded.

The legend rides in the `geo` column. The caps bound ONE entry; what bounds a LIST page (up to 1000
rows) is that a `list` read carries neither `sources` nor `legend` (below, *Serving*), so a grid never
ships a quarter-megabyte of icons per row. The component is monovalue, yet its value is an array and
`set_data` stores every entry it is given, so the per-entry caps alone left a value of N entries
unbounded (and the gate's own work with it: every incoming source is compared with the stored ones, under
the row lock). The **value** is therefore bounded too: at most four entries' worth of sources, of
legends (an absent, null or empty legend is not counted), of legend text and of icon characters,
counted from what the value LISTS, before anything is compared or numbered (a text-only legend alone
is ~208K characters at its caps, so counting icons only left text unbounded across entries). Four is
the entry the editor works on plus the inert extra entries a propagate "add" stores; a value over it is
refused (`request.invalid_data`, the counts in the log, never the values).

### The save: one gate, no tool-only writer

`sources` and `legend` are keys of the component's own value. Every door that saves
`component_geolocation` — the client API, MCP, an agent change-plan, the CSV/JSON import, the
propagate tool — meets `saveComponentData`, and `applyItemGate` runs over the FINAL items of the save,
under the row lock, before the write:

1. **validates what changed.** A source byte-identical (key order aside) to the one stored under the
   same id, and a legend equal to a stored one, are TRUSTED and not re-judged: a record saved before
   a rule tightened stays editable, and the proxy's fetch-time validation is what keeps such a
   source from being served. An edited or new one is judged against today's rules. A refusal is
   `request.invalid_data` (log-only `coordinates`, no `details`), the whole save rolls back, and
   value, counter and Time Machine are untouched. **`request.invalid_data` is operator-disclosure
   (`src/core/errors/registry.ts`): a non-debug client receives only the generic message, so the
   failing path and rule (`sources[1].url: …`) are in the server log and under `debug.exception`, not
   in the response.** The import tool is the door that shows the reason — it reports it per cell;
2. **normalizes** to one stored form: `sources` null or `[]`, and a legend with no title and no
   group, are removed as keys, so equal values store equal bytes;
3. **settles ids** (above): keeps, adopts by content, or numbers.

**The gate writes nothing it was given.** The value a save receives is not the save's private data:
`set_data` carries the caller's own entry objects through, and `tool_propagate_component_data` hands
ONE value (one array of one set of entry objects) to every target record. A gate that settled ids in
place would leak record 1's minted numbers into that shared object, where records 2..N would read them
as ids the caller named — a source of record 2 overwritten by the content record 1 happened to number
the same, and "never reused" broken in the bulk door. So the gate settles its own copy of each entry
and **returns** the gated array, which the save continues with (`item_gates.ts`, `save_component.ts`);
the caller's objects and the stored baseline are left exactly as they were. Saving one shared value
into N records therefore settles each as saving a fresh copy of it would, to the byte
(`geo_sources_legend_save_native.test.ts`, *ONE value object saved into many records*). A model with
an `itemGate` is monovalue, so its inserts replace and always take the full-array write that writes
the gate's output; a gate test pins that placement.

**REPLACE semantics, deliberately.** Saving an entry replaces the entry (monovalue update): a value
sent without `sources` stores without them, exactly as one sent without `lib_data` stores without
features. The client always sends the whole entry it loaded; a writer that builds a value from
scratch deletes what it did not carry. The server does not "preserve" keys the caller omitted — a
preserve rule would make deletion impossible to express and would hide a writer that forgot them.

### Serving: what leaves the server

The save gate judges what is WRITTEN. Bytes also reach the `geo` column without it, and the gate
itself trusts what is unchanged, so the posture of the legend (icons only as raster `<img>`, text only
as text) is held a second time where the value LEAVES the server. The geolocation emit hook
(`emitHook: 'geo'`, `components/component_geolocation/emit.ts` → `servedGeoEntry`) is the one door:

- **a `list` read carries the view and the features only** — no `sources`, no `legend`. A grid reads
  `lat`/`lon`; the map definition has no consumer there and would otherwise ride every row;
- **every other mode carries the legend RE-VALIDATED and the sources' attribution RE-JUDGED.**
  `servedMapLegend`: an icon that fails today's icon rules is dropped (a `data:image/svg+xml`, a URL, a
  `data:image/png` whose bytes are not a PNG, a header that declares a pixel bomb), then, if the set
  still breaks the legend total (characters or pixels), all icons; text that opens a tag is not
  repaired — the legend is not served. `servedMapSources`: a source's `attribution` is the one field a
  browser hands to an HTML sink (Leaflet's attribution control, the sanctioned one), so an attribution
  that fails today's plain-text rule (markup, control characters, over the cap, not a string) is served
  **blank**; nothing else is touched and no source is dropped for another reason — the browser never
  fetches `url`, and dropping a legacy-but-trusted source would let the next save (REPLACE semantics)
  delete what nobody asked to delete. Elements that are not objects cannot be drawn and are dropped.
  The save echo passes the same door. The stored bytes are never rewritten by a read: the client loads
  the served entry and the next save stores the clean one;
- **the doors that write the column WITHOUT the save gate** — and so the reason serving re-validates —
  are: the Time Machine restore and the bulk revert (the recorded value is written back directly), the
  archive restore (the archived text is bound verbatim, `src/core/archive/restore.ts`), the
  studio-default repair script (it writes the component's whole key; it never edits a map definition,
  below), and the gate's own trust of a source/legend equal to the stored one. A stored source is
  re-validated at FETCH time by the proxy (`lookupStoredMapSource`), the legend at SERVE time;
- **the client rule has a gate, and the gate is a heuristic**: `geo_contract_guards_native.test.ts`
  scans the geolocation client files — parsed (`@babel/parser`), by statement, with a per-function taint
  pass (`test/helpers/geo_client_sink_scan.ts`) — for a legend/source/symbol/icon/attribution value, or a
  name assigned from one, that reaches an HTML sink in the same statement: `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `createContextualFragment`, `setHTMLUnsafe`, `parseFromString`,
  `srcdoc`, the project's `create_dom_element` `inner_html` option, jQuery's `.html()`, and the Leaflet
  calls that take HTML (`bindPopup`, `bindTooltip`, `setContent`, `divIcon`); or that is built into an
  HTML-looking string. Leaflet's ARGUMENT sinks are judged by the argument they write: the layer
  control's name (`addOverlay`/`addBaseLayer` second argument, the keys of `control.layers(base,
  overlays)`) and the attribution control's text (`addAttribution`, `setPrefix`) — there, and only
  there, a value through the client's escaper (`escape_markup`/`escape_html`) is the sanctioned shape. Each shape has a positive control (two-line variable hops, callback parameters,
  arrow bodies included), and the sanctioned destinations (`img.src`, `textContent`, a text node) have
  negative ones. **The Leaflet `attribution` option is deliberately not flagged**: it renders HTML, so it
  is a sink, but it is the one sanctioned sink — what keeps it inert is the server (plain text without `<`
  or `>`, held at save AND when served, above), not the scan. Text that cannot open a tag is inert as
  element content only; quotes stay legal, so it is not inert built into an attribute string — the client
  rule is `textContent`/a text node, never an HTML string of either kind. A scan holds the client to the
  rule statement by statement; it does not prove it, which is why none of the server layers leans on it.
  The client step must render an icon only as the `src` of an `<img>` and every label as text.

### Who can read a stored template

A source's `url` is a field of the record. **Everyone who can read the field reads the stored template**:
the edit read, the `dedalo_raw` export and the Time Machine all carry it verbatim, and REPLACE
semantics mean the server cannot redact it per reader without breaking the write-back. The save gate
therefore treats a template as PUBLIC TO ITS READERS: **a deployment-wide secret (a provider key) belongs
only in an ontology default** (`properties.map_sources`), which is server-side: the structure context
echoes a default's id, label and type and never its `url` or `params`
(`resolve/structure_context.ts sanitizeEmittedProperties`, gate: `geo_map_source_lookup_native.test.ts`).
The proxy request never carries an address — the client names a source by id — but a record's stored
template is data the browser holds. Nothing refuses a key-looking query parameter at save: whether an
editor may paste a personal key into a record they alone can read is a policy of the installation, and
the rule above is how it is kept off the records everyone reads.

### Import and append

- **Import conform** (`tools/import_conform.ts`) names the siblings, so a raw export round trip keeps
  them (source ids included — the save gate decides whether the record stores them); the item `id`
  is still dropped, as before. They are judged by the same validators, so a bad source is a
  REPORTED import failure with its path (the cell is left alone) and not a late exception. Empty
  siblings store no key.
- **A map definition needs no coordinate.** An item with no `lat`/`lon` and no features but with
  `sources` and/or `legend` is a value, like a geometry-only item. `{ "sources": [] }` alone says
  nothing and is refused as before (a typo'd header must not clear a stored value).
- **Append is layers-only.** `importAppend: 'geo_layer'` adds layers; it never reads, merges or
  rewrites the siblings. Onto a stored host they stay as stored (by reference) and an incoming
  item's are dropped; onto nothing, the first incoming item is the host as it is (its siblings are
  validated and numbered by the save), later items' are dropped; an incoming item carrying only
  siblings has no layer and is a reported `empty` skip. A sources merge would need new ids, a
  url+params identity and the caps re-judged — a different operation, not an append.

### Diffusion: withheld

A source is an upstream URL that may carry a provider token; a legend is up to 256 KiB of icons.
Neither is a fact about the heritage a publication describes. **Diffusion does not publish `sources`
or `legend`.** The decision is data (`GEO_SIBLING_PUBLICATION` in `src/core/geo/geo_entry_keys.ts`,
both `withheld`) applied at the one door that copies the stored entry whole
(`src/diffusion/resolve/default_value.ts`); `parser_geo::geojson`, `buildGeojsonLayers` and the
point fallback read `lat`/`lon`/`lib_data` by name and never see them. An entry whose only content is
the siblings publishes no atom. Publishing a key is a type change on that table plus an addendum
here, not a flag.

### `properties.map_sources` — ontology defaults (read path)

A component node may list default sources in its `properties` (a properties key the engine reads;
it is not an ontology node): `map_sources: [ { id, label?, type, url, params, attribution } ]`, the
stored-source shape with a short NAME as `id` (`^[a-z][a-z0-9_]{0,47}$`, unique in the list — a
namespace of its own, so a default can never collide with a numeric stored id) and an optional
`label` for the picker. At most 32. `parseMapSourceDefaults` (pure) validates each entry with the
same validator; a broken entry is **rejected with its index and reason**, never dropped quietly,
and is neither offered nor fetched. `mapSourcePickerEntries` is what a client may be told: names,
labels and types, **never a URL** — and it is what the node's emitted `properties.map_sources` IS on
the wire: the structure context (and the request_config echo, which shares the shaper) REPLACES the
key by the picker entries of the valid defaults, so no `url`, `params` or token of a default ever
reaches a browser.

### Other readers — verified to tolerate and carry the keys

Search (the `geo` column is a default SELECT column and has no search operators), the Time Machine
(the whole item is stored; a RESTORE writes the recorded bytes back directly, deliberately bypassing the save, so its source ids return as recorded — all below the counter, which never goes down — and a template that has become invalid since is caught by the proxy's fetch-time validation, not by the save gate), `duplicate_record` (copies the column whole; the counter raise above
covers its under-counted counter), `tool_propagate_component_data` (a `set_data` through the same
gate: a foreign id the target holds is an edit of that source, any other is re-numbered — see *Source
ids*), the section read (edit carries the keys, list does not — see *Serving*), and the archive/raw
export (jsonb verbatim). The list/mini/text views read only `lat`/`lon`.

**The studio-default repair** (`scripts/repair_geolocation_studio_default.ts`) never treats a map
definition as a fabrication: an item whose `sources` is non-empty or whose `legend` says something
(`carriesMapDefinition`: the gate's own emptiness rule, `hasNoLegendContent`) is classified OTHER —
not cleared and not fitted — even when its view is the studio default. The test is **presence, not
type**: only the gate's normal form for "none" (the key absent or null, `sources: []`, a legend object
with no title, no group and no other key) carries nothing, so such an item is still a bare default and
is still repaired. Every other value — a string or an object where a list belongs, an array or a string
where the legend belongs, a legend with an unknown key — is content a bypass door (Time Machine
restore, bulk revert, archive restore) can leave in the column and a repair must not delete.

## Reason

The editor needs to say which maps a drawing sits on and what its symbols mean, and the record must
keep that with the drawing. Keeping it in the component's own value (not a side table, not a tool
store) gives it the record's permissions, history, duplication and export for free; keeping it OUT of
`lib_data` keeps GeoJSON GeoJSON. The server-issued id is the only way "unique and never reused" can
be a property of the data rather than a promise of every client. Validating the template at save —
and again at fetch — is what makes a stored URL safe to put behind a server-side proxy: the
proxy request never carries an address and the server never fetches one it has not judged. (The
browser does hold the stored template its field returns — see *Who can read a stored template*; an
ontology default's address never reaches it.) The
trust-what-is-unchanged rule is for institutions with decades of records: tightening a rule must
not make them unsaveable.

## Gate reconciliation

**No fixture re-harvest, and none is possible (DEC-14b).** The frozen store
(`test/parity/fixtures/oracle_harvest/`, final harvest 2026-07-11) holds no geolocation entry with
`sources` or `legend`, and the one parity gate that touches the component's context
(`component_geolocation_features_differential`) reads `features`, which this change does not touch.
Every clause is proven TS-side:

- the validators and the caps, icon pixel bombs included — `test/unit/geo_map_source_native.test.ts`;
- the gate (ids, ownership, the value budget, trust-unchanged, normal form, the `itemGate` facet and its
  placement) — `test/unit/geo_entry_gate_native.test.ts`;
- the real save on scratch records (numbering, never-reuse, replace semantics, refused saves leave
  value/counter/history untouched, the wire door, Time Machine, duplicate, propagate, one shared value
  saved into many records, the section read, append) — `test/unit/geo_sources_legend_save_native.test.ts`;
- import conform and the layers-only append — `test/unit/geo_sources_legend_import_native.test.ts`;
- diffusion withholds — `test/unit/geo_sources_legend_diffusion_native.test.ts`;
- the stored-source lookup, the ontology defaults and the structure context's shaping of
  `map_sources` — `test/unit/geo_map_source_lookup_native.test.ts`;
- serving (legend re-validated, sources' attribution re-judged, list rows without the map definition,
  the real read and save echo on a restored legend and a restored markup attribution), the client-sink
  scan and the header-citation check — `test/unit/geo_contract_guards_native.test.ts`.

## Addendum 2026-11-06 — a source's address uses the scheme's own port; the picker is told what it needs to draw

Two changes to the contract above, both found while gating the tile proxy
(`WC-2026-11-06-map-tile-proxy`):

- **The URL template uses the standard web port of its scheme.** `checkSourceUrl` (the ONE validator
  of the save gate, the import conform and the proxy's fetch-time re-check) now refuses an explicit
  port other than the scheme's own — `https://host:443/…` and `http://host:80/…` are the default and
  read as no port at all; `:8443`, `:8080`, `https://host:80/` and `http://host:443/` are refused with
  "must use the standard web port of its scheme". The proxy's door reaches ports 80 and 443 only, so a
  source on another port used to save cleanly and then fail every tile as a generic upstream refusal
  with the cause only in the operator log (and not at all for an ontology default). A value stored
  before this change on another port is refused at fetch time like any other value that no longer
  validates (it reads as an unknown source; one log line per source per minute names the rule).
  An ontology default on another port is rejected with its index and reason, never offered.
- **A default's picker entry carries what the page needs to draw it.** `context.properties.map_sources`
  was `[{ id, label, type }]`; it is now `[{ id, label, type, attribution, min_zoom?, max_zoom?, crs? }]`
  (flat keys: `min_zoom`/`max_zoom` for an xyz default that states them, `crs` for a wms one). Still
  never a `url`, a `params` object or a layer list, so a provider key kept in a default stays on the
  server. Without them a default xyz source was requested at zooms its provider does not serve and its
  licence's attribution never appeared on the map.
- **A default's `label` is plain text, like the attribution** (fix round of the tile proxy). The
  label goes into Leaflet's layer control, which writes it as HTML, and was judged by "no control
  characters" alone: an ontology update could have carried `<img src=x onerror=…>` into the page.
  `parseMapSourceDefaults` now rejects a label with `<` or `>` (same rule and same reason format as the
  attribution: `map_sources[i].label: must be plain text, without < or >`), and the page escapes
  the name once more before the layer control (`escape_markup` in `component_geolocation.js`, which
  also covers a stored source's attribution used as its name). Held twice, as the attribution is.
