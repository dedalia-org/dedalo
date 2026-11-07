# Diffusion parsers — cookbook & reference

> See also: [The native diffusion engine](native_engine.md) · [Ontology](../core/ontology/index.md)

Parsers are the transformation steps an institution writes in the **diffusion ontology** (dd1190). Each publishable field node carries a `properties->process` object; its `parser` entry is an **ordered array of steps** that turns the field's resolved component values into the published cell:

``` json
"properties": {
    "process": {
        "ddo_map": [ ... ],
        "parser": [
            { "fn": "class::method", "id": "a", "options": { ... } }
        ],
        "output_format": "json"
    }
}
```

This page is a **cookbook first** (goal-titled recipes you can paste into a field node) and a **complete reference second** (every registered `fn`, with faithful input → output examples). Source of truth: `src/diffusion/parsers/` (implementations + registry) and `src/diffusion/plan/compile.ts` (how steps are compiled into the publication plan).

## How to read a recipe

Five things explain every recipe on this page:

- **The step shape.** A parser step is `{fn, id?, options}`. `fn` is a `"class::method"` name from the registry (e.g. `parser_helper::merge`). A single step object (no array) is accepted and normalized to a one-step array at compile time.
- **Chaining.** Steps run **in order**; each step's output is the next step's input. After the last step, the engine's *default completion* collapses any remaining array-valued results into the final cell (column-aware merge, or a per-lang join using the last step's `records_separator`) — so a parser that emits row arrays still publishes as one string unless `output_format` says otherwise.
- **The `id` handle.** Every `ddo_map` entry (a source component in the field's resolution chain) may declare an `id` (`"a"`, `"b"`, …). Pattern options reference values by handle — `"pattern": "${a}, ${b}"`. A parser **step** with an `id` consumes only the values carrying that handle and parks its result under it; a later id-less step consumes all parked results combined. This lets you transform one source, then compose it with the others.
- **Per-language grouping.** Parsers receive the atoms of *all* output languages at once, group them by language internally, and emit one result per language (language-neutral values are `lang: null`). Projection then builds one published row per configured language, filling gaps with the fallback ladder: exact lang → language-neutral → main lang → any available.
- **Runtime vs compile time.** Of the 33 registered fn names, **23 run at runtime** as pure value transforms and **10 are compile-time rewriters**: the plan compiler absorbs them into plan structure (chain transforms, lookup tables, synthetic fields, run constants). All 33 names keep working in ontologies **unchanged** — only where they execute moved. See [Compile-time rewriters](#compile-time-rewriters).

!!! danger "`validate` is your safety net"
    An `fn` not in the registry is a **loud compile error** naming the field — never a silent skip:
    `field 'oh110' (informant): unknown parser fn 'parser_text::defalt_join' — not in the parser registry`.
    Run the diffusion `validate` action after editing `properties->process`; it reports every violation (unknown fns, broken `ddo_map` tipos, invalid SQL identifiers) in one pass.

---

## Recipes

Each recipe shows: the goal, the `process` JSON as you would paste it into the field node, the resolved input, the published output, and why each step is there.

### Publish a plain translatable text

No parser needed. A field node whose related component is a text component publishes each language's value as-is; multiple values in one language join with `' | '`.

``` json
"process": {}
```

```
input : [{value:'My Interview', lang:'lg-eng'}, {value:'Mi Entrevista', lang:'lg-spa'}]
output: lg-eng row → 'My Interview' · lg-spa row → 'Mi Entrevista'
```

`parser_text::default_join` is the explicit spelling of this default — add it only when you want to set `records_separator`.

### Join a multi-value field with a custom separator

**Goal:** several stored values, one cell, your separator.

``` json
"process": {
    "parser": [
        { "fn": "parser_text::default_join", "options": { "records_separator": ", " } }
    ]
}
```

```
input : [{value:'A'}, {value:'B'}, {value:'C'}]
output: 'A, B, C'
```

Variant — **deduplicate first** (e.g. the same toponym referenced by several records), then join:

``` json
"parser": [
    { "fn": "parser_helper::merge", "options": { "merge": "unique", "implode": true } }
]
```

```
input : [{value:'Murtili'}, {value:'Mirtilis'}, {value:'Myrtilis'}]
output: 'Murtili | Mirtilis | Myrtilis'
```

`merge:'unique'` drops repeated values; `implode:true` collapses the surviving list into one string joined by `records_separator` (default `' | '`).

### Map a select/enum relation to labels

**Goal:** a select component stores a *reference* (`{section_tipo, section_id}`) to a controlled list; publish a human label instead of the raw id. Classic three-step chain:

``` json
"process": {
    "parser": [
        { "fn": "parser_locator::get_section_id" },
        { "fn": "parser_helper::get_first" },
        { "fn": "parser_text::map_value",
          "options": { "map": [ { "a": { "1": "yes", "2": "no" } } ] } }
    ]
}
```

```
input : [{section_tipo:'dd64', section_id:2}]            — the resolved reference
step 1: parser_locator::get_section_id  → [2]            — project to the id (int)
step 2: parser_helper::get_first        → 2              — array → scalar
step 3: parser_text::map_value          → 'no'           — dictionary substitution
```

Why each step: `get_section_id` reduces the reference to its id **list**; `get_first` keeps one scalar per language (a select holds one value); `map_value` looks the raw value up in `options.map` — an id-scoped mapping (map key = source handle) wins, otherwise the first mapping that knows the value applies, and **unmapped values pass through unchanged**. The map is keyed by the value's
string form, so an integer id still matches a `"2"` key.

### Publish a related record's id list as JSON

**Goal:** a portal points at N related records; publish their ids as a JSON array column.

``` json
"process": {
    "parser": { "fn": "parser_locator::get_section_id" },
    "output_format": "json"
}
```

```
input : [{section_tipo:'rsc197', section_id:1}, {section_tipo:'rsc197', section_id:2}]
output: '[1,2]'
```

`output_format: "json"` keeps the projected list as a JSON array instead of joining it into a display string. A record address is an integer, so the array publishes as `[1,2]`; a column migrated from a v6 install keeps the old `["1","2"]` bytes by resolving through `parser_locator::get_v6_section_id` instead (see below). (Relation-family fields default to `json` even without the explicit setting.) To publish the **full references** rather than bare ids, use `parser_locator::get_locator` — see the [rewriters](#compile-time-rewriters).

### Publish a date — year, formatted string, or Unix timestamp

Dates are stored as **dd date objects**: `{start, end, period}`, each a `{year, month, day, hour, minute, second}` bag. Pattern tokens are `Y y m d H i s`.

**Year only:**

``` json
"parser": { "fn": "parser_date::string_date", "options": { "pattern": "Y" } }
```

```
input : [{value:[{start:{year:2024, month:3, day:15}}]}]
output: '2024'
```

**Formatted string** (default pattern `Y-m-d`):

``` json
"parser": { "fn": "parser_date::string_date", "options": { "pattern": "Y-m-d" } }
```

```
output: '2024-03-15'
```

**Unix timestamp** (epoch seconds of the selected part):

``` json
"parser": { "fn": "parser_date::unix_timestamp" }
```

```
output: 1710460800
```

`string_date` selects `start` by default and only the **first** stored date (`keys:[0]`); pass `"keys": [0, 1]` to publish both, joined by `fields_separator`: `'2020-01-01, 2021-06-15'`. Negative years zero-pad under `Y` (`'-094-05-02'`) and stay raw under `y` (`'-94'`).

### Publish the ancestor path of a hierarchy term

**Goal:** a thesaurus/hierarchy reference publishes as its term ladder — "district, city, country" — optionally truncated below the root.

``` json
"process": {
    "parser": [
        { "fn": "parser_locator::parents",
          "options": {
              "value": "term",
              "include_self": false,
              "parent_end_by_term_id": ["ts1_1"],
              "fields_separator": ", "
          } }
    ]
}
```

```
input : chain [Sol(ts1_5) → Centro(ts1_4) → Madrid(ts1_2) → España(ts1_1)]
        (each node carries its term per language, prefetched by the engine)
output: lg-spa row → 'Centro, Madrid'
```

Why: `parents` walks the reference's ancestor chain and emits each node's term in every output language (fallback: exact lang → main lang → any). `include_self:false` drops the term itself; `parent_end_by_term_id` cuts the ladder **before** the listed node (here the root "España" is excluded). This fn is a compile-time rewriter — full options in the [rewriters section](#compile-time-rewriters).

### Compose one column from other columns

**Goal:** a synthetic column built from the *already-published values* of sibling fields in the same table (e.g. a display name from `name` + `surname` columns).

``` json
"process": {
    "parser": { "fn": "parser_global::merge_columns",
                "options": { "columns": ["oh100", "oh110"], "fields_separator": " — " } }
}
```

```
input : (none of its own — reads the record's other resolved columns)
        oh100 → 'Code-001' · oh110 → 'Manuel González'
output: 'Code-001 — Manuel González'
```

`columns` lists the **field node tipos** of the source columns; per column the value is picked language-neutral first, then main language, then any. Empty columns are skipped; the default separator is a single space. The compiler turns this field into a deferred synthetic column — it resolves **after** all normal fields of the record.

### Publish the run's stable publish timestamp

**Goal:** a `published_at` column, identical for every record of one publication run.

``` json
"process": {
    "parser": { "fn": "parser_global::publication_unix_timestamp" }
}
```

```
output: 1751712000       — epoch seconds, captured once per run
```

The compiler replaces the field's source with a run constant: every record of the run gets the **same** timestamp (deterministic output, diffable re-runs), emitted language-neutral.

### Publish a geolocation as GeoJSON

``` json
"process": {
    "parser": { "fn": "parser_geo::geojson" },
    "output_format": "json"
}
```

```
input : [{value:[{lat:'41.5', lon:'2,1'}]}]
output: [{layer_id:1, text:'', layer_data:{type:'FeatureCollection',
          features:[{type:'Feature', properties:{},
                     geometry:{type:'Point', coordinates:[2.1, 41.5]}}]}}]
```

Stored map layers (`lib_data`) that already carry features pass through as-is; otherwise a Point FeatureCollection is built from `lat`/`lon` (comma decimal separators normalized, GeoJSON `[lon, lat]` order), accepting both the string and the number form of a coordinate.

**This parser emits layers, so the view only reaches it as a fallback.** Where the item carries drawn features, those layers are what the parser publishes; where it does not, the view becomes a one-Point layer. That is a property of this output format, not a precedence rule about the value: the **view** (`lat`/`lon`/`zoom`) and the **features** (`lib_data`) are independent, and no path drops one because the other exists — the standalone geolocation atom (`src/diffusion/resolve/default_value.ts`) publishes both, as stored (see [Geolocation values](../core/data_model/geolocation.md#the-view-and-the-features-are-independent)).

**Emptiness is structural, and `0` is a real coordinate.** `lat` and `lon` must both parse to a finite number or no point is built — `null`, `undefined`, `""` and unparseable text are absence, and a missing axis is never completed with a zero. Conversely `[0, 0]`, the equator and the prime meridian publish like any other position; the old falsy guard dropped them, so such records publish a point now where they published nothing before.

**One pair is refused: the studio default `39.462571, -0.376295`.** Those are the Dédalo facilities' own coordinates, shipped as the client's factory map position and written into the record by the v6 client on save, so an item holding exactly that pair is a fabricated view and never reaches a consumer. The refusal lives at the publication doors only — `isStudioDefault()`, `src/core/concepts/geo_coordinate.ts` — and everywhere else in the engine the pair is an ordinary coordinate (see [Geolocation values](../core/data_model/geolocation.md#the-studio-default--the-one-pair-publication-refuses)).

**A geolocation's `sources` and `legend` never publish.** They sit beside `lib_data` in the stored item, and no publication path publishes them. This parser and the point fallback read `lib_data` and `lat`/`lon` by name and never see them; the standalone geolocation atom publishes the stored item **minus its `id`, `sources` and `legend`** — a withhold list, not an allowlist, so any other key an item carries goes out with it. The upstream addresses of a map source (which may carry a provider token) and the legend icons therefore never reach a published site. An item whose only content is `sources` and `legend` publishes nothing (see [Map sources and legend](../core/data_model/geolocation.md#map-sources-and-legend)).

### Publish IRIs as one flat string

``` json
"process": {
    "parser": { "fn": "parser_iri::flat" }
}
```

```
input : [{value:[{iri:'https://dedalo.dev', title:'Official Dédalo web'},
                 {iri:'https://other.es',  title:'other'}]}]
output: 'Official Dédalo web, https://dedalo.dev | other, https://other.es'
```

`fields_separator` (default `', '`) sits between title and iri; `records_separator` (default `' | '`) between entries. Title-less entries emit the bare iri; fully empty entries keep their slot (`'https://dedalo.dev | '`).

### Compose text from several sources with `${id}` handles

**Goal:** one cell formatted from several components — here "name surname" of each person linked through a portal.

``` json
"process": {
    "ddo_map": [
        { "tipo": "oh24",  "section_tipo": "self",   "parent": "self" },
        { "tipo": "rsc85", "section_tipo": "rsc197", "parent": "oh24", "id": "a" },
        { "tipo": "rsc86", "section_tipo": "rsc197", "parent": "oh24", "id": "b" }
    ],
    "parser": [
        { "fn": "parser_text::text_format",
          "options": { "pattern": "${a} ${b}", "group_by_section_id": true,
                       "records_separator": " | " } }
    ]
}
```

```
input : a='Manuel', b='González' (record 1) · a='María', b='Gómez' (record 2)
output: 'Manuel González | María Gómez'
```

Why: the `ddo_map` hops through the portal (`oh24`) into each linked person record and reads name (`id:"a"`) and surname (`id:"b"`); `text_format` fills the pattern per language group. `group_by_section_id:true` formats each related record as a coherent unit before joining with `records_separator` — without it, all values of one handle zip positionally across records (single values broadcast). Separators around empty handles are cleaned automatically: pattern `'${a}, ${b}/${c}'` with an empty `b` publishes `'Title/Code'`, not `'Title, /Code'`.

---

## Reference — runtime parsers

The 23 runtime fns, by family. Every example is taken from the engine's test suite (`test/unit/diffusion_parsers.test.ts`); input lines show the resolved values a step receives (references appear as `{section_tipo, section_id}` link lists, dates as dd date objects).

### parser_helper

| fn | Purpose |
| --- | --- |
| `parser_helper::get_first` | Keep only the **first** value of each language group; array values collapse to their first element. |
| `parser_helper::get_tail` | The complement: drop the first value of each language group, keep the rest. |
| `parser_helper::count` | Publish the number of value elements (arrays count their length; a resolved reference counts one per link; a bare reference with no literal value still counts 1). |
| `parser_helper::merge` | The workhorse collapse/join — see below. |

```
input : [{value:'A', lang:'lg-spa'}, {value:'B', lang:'lg-spa'}, {value:'X', lang:'lg-eng'}]
step  : {fn:'parser_helper::get_first'}
output: [{value:'A', lang:'lg-spa'}, {value:'X', lang:'lg-eng'}]

step  : {fn:'parser_helper::get_tail'}
output: [{value:'B', lang:'lg-spa'}]

input : [{value:['a','b']}, {value:'x'}, {value:''}, [{section_tipo:'es1',section_id:5},{section_tipo:'es1',section_id:6}]]
step  : {fn:'parser_helper::count'}
output: 5
```

**`parser_helper::merge`** has two modes. *Standalone* (as written in ontologies): collapses the value list per language; `merge:'unique'` dedupes, `implode:true` joins into one string. *Column-aware* (the engine injects `columns` when a field draws from several source components): builds one slot per record × source column and shapes the result by `merge` style — with per-slot language fallback (exact → neutral → main → any):

| `merge` option | Output for `Madrid/Spain` + `Paris/France` (2 records × 2 columns) |
| --- | --- |
| *(unset)* | `['Madrid','Spain','Paris','France']` — flat list of non-empty slots |
| `'string'` | `'Madrid, Spain | Paris, France'` — columns joined by `fields_separator`, records by `records_separator` |
| `'nested'` | `[['Madrid','Spain'],['Paris','France']]` |
| `'flat'` | `['Madrid, Spain','Paris, France']` |
| `'pipe'` | `'["Madrid","Spain"] | ["Paris","France"]'` — JSON per record (pure-integer strings become JSON numbers: `'[1,"007"]'`) |
| `'unique'` | deduplicated flat list; `implode:true` joins it |

Other options: `fields_separator` (default `', '`), `records_separator` (default `' | '`), `empty_columns` (default `true` — keep empty slots, producing adjacent separators under `'string'`).

### parser_text

| fn | Purpose |
| --- | --- |
| `parser_text::default_join` | Collapse all values into one string per language (alias of `merge` with `merge:'string'`). Option: `records_separator`. |
| `parser_text::text_format` | `${id}` pattern formatting — see the [recipe](#compose-text-from-several-sources-with-id-handles). Options: `pattern`, `group_by_section_id`, `fields_separator`, `records_separator`. Without a `pattern` it falls back to `default_join`. |
| `parser_text::map_value` | Dictionary substitution — see the [enum recipe](#map-a-selectenum-relation-to-labels). Option: `map: [{ handle: { raw: mapped } }]`. |
| `parser_text::v5_html` | Normalize legacy editor HTML: empty paragraphs removed, `<p>…</p>` converted to `<br>` flow, boundary `<br>`/`&nbsp;` trimmed. Each language keeps its own value. |

```
input : [{value:'<p>Hello</p><p>World</p>', lang:'lg-spa'}]
step  : {fn:'parser_text::v5_html'}
output: [{value:'Hello<br>World', lang:'lg-spa'}]
```

### parser_locator — reference projections

The five runtime survivors of the locator family project **resolved reference chains** down to publishable scalars. Input values are link lists: `[{section_tipo, section_id}, …]`.

| fn | Purpose | Options |
| --- | --- | --- |
| `parser_locator::get_section_id` | Project each reference to its `section_id` list. | `split:true` → one value **per id** (with synthetic per-value grouping, so a following `merge:'unique'` dedupes individual ids) |
| `parser_locator::get_v6_section_id` | Same projection, value emitted as a **string**. A record address is an integer everywhere else; this twin exists only so a column already published by a v6 install keeps its `["1","2"]` bytes for consumers that read them as strings. New columns use `get_section_id`. | `split` |
| `parser_locator::get_section_tipo` | Same projection for `section_tipo`. | `split` |
| `parser_locator::get_term_id` | Build `"{section_tipo}_{section_id}"` per link. | `split`; `coerce_non_locator:true` → non-reference values (e.g. a color `'#f78a1c'`) yield the `'_'` marker, empty values publish nothing |
| `parser_locator::get_section_id_grouped` | Group dataframe-paired references (a new group starts when the pairing id resets) and publish each group as a JSON array, groups joined by `records_separator`. | `records_separator` |

```
input : [[{section_tipo:'numisdata3', section_id:2062}], [{section_tipo:'numisdata3', section_id:2063}]]
step  : {fn:'parser_locator::get_section_id'}
output: [[2062], [2063]]                           — with output_format json: '[2062]' per value

input : [{section_tipo:'oh1', section_id:25}]
step  : {fn:'parser_locator::get_term_id'}
output: ['oh1_25']

input : ref#1 → 99927 · ref#1 → 128187 · ref#2 → 133934   (pairing ids 1, 1, 2)
step  : {fn:'parser_locator::get_section_id_grouped'}
output: '["99927"] | ["128187","133934"]'      — grouped ids are serialized as strings
```

### parser_date

| fn | Purpose | Options (defaults) |
| --- | --- | --- |
| `parser_date::select_properties` | Pick `start`/`end`/`period` parts out of dd date objects. | `select: ['start']` |
| `parser_date::select_keys` | Pick stored dates by position; pads missing `month`/`day` with `0` for SQL compatibility. | `keys: [0]` |
| `parser_date::format_string_date` | Format date parts with a pattern (`Y y m d H i s`); multiple dates collapse into one joined value. | `pattern: 'Y-m-d'`, `fields_separator: ', '`, `records_separator: ' | '` |
| `parser_date::string_date` | The convenience chain `select_properties → select_keys → format_string_date` — see the [date recipe](#publish-a-date--year-formatted-string-or-unix-timestamp). | all of the above |
| `parser_date::unix_timestamp` | Selected part → epoch seconds (UTC). | `select: ['start']`, `keys: [0]` |
| `parser_date::default` | Mode-aware formatting via `date_mode`: `'date'` (default) → `'Y-m-d H:i:s'` of the start; `'range'`/`'time_range'` → `'start,end'` (separator via `range_separator`, default a bare comma); `'period'` → localized duration per output language. | `date_mode`, `range_separator` |

```
input : [{value:[{start:{year:2020,month:1,day:1}, end:{year:2024,month:12,day:31}}]}]
step  : {fn:'parser_date::default', options:{date_mode:'range'}}
output: '2020-01-01 00:00:00,2024-12-31 00:00:00'

input : [{value:[{period:{year:5, month:3, day:10}}]}]   — output langs lg-eng, lg-spa
step  : {fn:'parser_date::default', options:{date_mode:'period'}}
output: lg-eng → '5 years 3 months 10 days' · lg-spa → '5 años 3 meses 10 días'

input : [{value:[{year:2024}]}]
step  : {fn:'parser_date::select_keys', options:{keys:[0]}}
output: [{year:2024, month:0, day:0}]
```

### parser_info / parser_iri / parser_geo / parser_map

| fn | Purpose | Options |
| --- | --- | --- |
| `parser_info::widget` | Pick computed widget values out of a `component_info` field: entries matching parallel `widget_name[i]`/`select[i]` pairs are collected; `keys` picks positions from the collected list. | `widget_name: []`, `select: []`, `keys` |
| `parser_info::default` | Clean a `component_info` string: strip `<mark>` markers; with `keys`, keep only the listed `record_separator`-split parts. | `keys`, `record_separator: ', '` |
| `parser_iri::flat` | `{iri, title}` records → one flat string — see the [IRI recipe](#publish-iris-as-one-flat-string). | `fields_separator`, `records_separator` |
| `parser_geo::geojson` | Geolocation → GeoJSON layer array — see the [geo recipe](#publish-a-geolocation-as-geojson). | — |
| `parser_map::custom` | Build a JSON array of objects from a `map` template: values group by originating record, each group resolves the template row matching its `section_tipo` (or the `'${section_tipo}'` wildcard) by interpolating `${id}` placeholders per index. | `map: [template]` |

```
input : [{widget:'get_archive_weights', widget_id:'media_diameter', value:12},
         {widget:'get_archive_weights', widget_id:'media_weight',   value:3.4}, ...]
step  : {fn:'parser_info::widget', options:{widget_name:['get_archive_weights'], select:['media_diameter']}}
output: 12

input : [{value:'<mark>one</mark>, two, three'}]
step  : {fn:'parser_info::default', options:{keys:[0,2]}}
output: 'one, three'

input : a='bbb' · b='jo jo' · c='la 11'          (one publication record, rsc205/1)
step  : {fn:'parser_map::custom', options:{map:[{table:'publications', title:'${a}',
         author:'${b}, ${c}', section_tipo:'${section_tipo}'}]}}
output: [{section_tipo:'rsc205', section_id:'1', table:'publications',
          title:'bbb', author:'jo jo, la 11'}]
```

`parser_map::custom` details worth knowing: repeated handles interpolate **per index** (the i-th surname pairs with the i-th name: `'Gomez, Élian, Ugolini, Daniela'`); a field whose placeholders all resolve empty publishes `null`; values are tag-stripped and trimmed; `${section_id}`/`${section_tipo}` are always available as built-in handles. Those two built-ins are template **handles**, so the row publishes `section_id` in its string form — the published byte shape, not the engine's int-canonical record address.

---

## Compile-time rewriters

These 10 fn names are **still written in ontologies exactly as before** — but they are not runtime value transforms. The plan compiler absorbs each step into plan structure, and the engine realizes its effect from data it prepares up front (resolved ancestor chains with prefetched terms, plan lookup tables, run constants). `validate` reports each absorption as a `rewriter:<fn>@<field>` notice.

| fn | The compiler turns it into | Author-visible effect |
| --- | --- | --- |
| `parser_locator::get_locator` | The resolved chain itself, projected to reference objects. | Publishes `[{section_tipo, section_id}, …]` (usually with `output_format: "json"`). `with_meta:true` adds `from_component_tipo`/`type`; `index_meta:true` emits the relation-index key order (`type, section_id, section_tipo, from_component_tipo, from_component_top_tipo`). Results sort by the first reference's `section_tipo`. |
| `parser_locator::parents` | The reference's ancestor chain, with per-language terms prefetched. | The term-ladder output of the [ancestor recipe](#publish-the-ancestor-path-of-a-hierarchy-term). Options: `value` (`'term'` default, `'term_id'`, `'section_id'`), `include_self` (default `true`), `include_parents` (default `true`), `fields_separator` (`', '`), `records_separator` (`' - '`), `merge` (`'string'` default for terms; `'unique'` → one label per node, **not** deduplicated; `'flat'` → array of ladder strings) — plus all chain-filter options below, applied in order: end-by-term, end-by-typology, tipo filter, term-id filter, splice, slice. |
| `parser_locator::truncate_by_term_id` | A chain-truncation option on the resolve step. | Cuts the chain before the first node whose term id is in `parent_end_by_term_id` (node excluded). |
| `parser_locator::filter_parents_by_term_id` | A chain-filter option. | Keeps only nodes whose term id is in `parent_term_id`. |
| `parser_locator::filter_by_section_tipo` | A chain-filter option. | Keeps only nodes whose section is in `parent_section_tipo`. |
| `parser_locator::slice_chain` | A chain-slice option. | Slices the chain by `parents_slice: [start, length?]` (array-slice semantics, negative values allowed). |
| `parser_locator::map_section_tipo_to_name` | A plan lookup table. | Maps each link's `section_tipo` through `options.map`, or — when no map is given — through the plan's own section → published-table lookup (so a reference publishes the *name of the table it lands in*). |
| `parser_global::merge_columns` | A deferred synthetic column. | The field is emitted from the record's other already-resolved columns — see the [compose recipe](#compose-one-column-from-other-columns). Options: `columns` (sibling field tipos), `fields_separator` (default `' '`). |
| `parser_global::publication_unix_timestamp` | A system source step (run constant). | Every record publishes the same run-scoped epoch-seconds value — see the [timestamp recipe](#publish-the-runs-stable-publish-timestamp). |
| `parser_locator::truncate_by_model` | *(not yet realized)* | Would truncate the ancestor chain by typology **model**. Fields using it (or `parents` with `value: 'typology…'`) fail with a **named error collected in the run report** — never a silently wrong value. |

The `parents` typology truncation `parent_end_by_typology_term_id` **is** supported: the engine prefetches each ancestor's typology term id and cuts the chain at the first match (node excluded) — e.g. stop the ladder at the first node typed "country".

---

## Authoring checklist

!!! note "Before you publish"
    - **Run `validate` first.** It surfaces every unknown `fn` (naming the field), every broken `ddo_map` tipo, and every identifier violation in one report — a plan only compiles clean or fails loud.
    - **Empty-cell policies are not parsers.** `empty_to_string` and `default_value` in `properties->process` are field policies applied **after** language projection; `empty_value` injects a placeholder before the parser chain runs. Don't reach for a parser to fill blanks.
    - **`output_format` decides the cell type**, not the parser: `json` keeps arrays/objects as JSON, `int` coerces to an integer, default is string joining. Relation-family fields default to `json`.
    - **Rewriter names are fine to keep using** — `parents`, `get_locator`, `merge_columns`, `publication_unix_timestamp` and the chain filters behave as documented; `validate` listing them as `rewriter:…` notices is expected, not a problem. Only `truncate_by_model` / typology `value` extraction fail (loudly, per field) until ported.
    - **Where to look in the source:** the registry and classification — `src/diffusion/parsers/registry.ts`; runtime behaviors — `src/diffusion/parsers/parser_{text,date,helper,locator,misc}.ts`; the chain state machine and default completion — `src/diffusion/resolve/transform.ts`; rewriter semantics — `src/diffusion/resolve/rewriters.ts`; the compile-time split and `validate` errors — `src/diffusion/plan/compile.ts`; behavior-pinning examples — `test/unit/diffusion_parsers.test.ts`.
