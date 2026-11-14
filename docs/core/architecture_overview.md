# Architecture overview

This is the "how it all fits together" map of Dédalo v7. It is written for a
developer who has just cloned the repository and wants the mental model before
diving into any single subsystem. Every concept here has a dedicated document;
this page only connects them.

If you have not yet read the [Introduction](index.md) and the
[Ontology](ontology/index.md), start there. The rest of this page assumes you
know that a *section* is the abstraction of an SQL table, a *component* is the
abstraction of a column, and that a *tipo* is the alphanumeric code that
identifies any node in the ontology.

> Quick nomenclature pointers: [Glossary](../understanding/glossary.md) ·
> [Sections](sections/index.md) · [Components](components/index.md) ·
> [Ontology](ontology/index.md) · [Locator](locator.md) ·
> [dd_object](../api/dd_object.md) · [RQO](../api/rqo.md) · [SQO](../api/sqo.md) ·
> [request_config](request_config.md)

## The two systems

Dédalo is not one application but two, sharing one body of data.

1. **The work system** — the back office where curators and researchers create,
   edit and relate records. Its server is a **TypeScript server on the Bun
   runtime** (`src/server.ts`, a single long-lived process — see below); its
   client is HTML, CSS and JavaScript. It talks to PostgreSQL, where all data
   lives as JSON in the `matrix` tables. The work API is the **Dédalo API**
   (see [RQO](../api/rqo.md)).
2. **The publication / diffusion system** — the read side that publishes the
   subset of work data marked for publication into a classical SQL database
   (MariaDB/MySQL by default) with one table-and-columns schema per section, so
   that websites and third-party portals can consume it. Its API is the
   **diffusion API**, and it speaks a flat, denormalized dialect rather than the
   abstract ontology dialect of the work system.

Both systems have a server half and a client half (HTML/CSS/JS). Both servers
run as native TypeScript on Bun — diffusion is a native subsystem of the same
codebase (`src/diffusion/`), publishing via spawned job-runner processes under
the main server's control (see
[Diffusion](../diffusion/diffusion_data_flow.md)). This document is almost
entirely about the **work system**, because that is where the ontology,
sections, components and the request lifecycle live. Diffusion is the
downstream consumer.

```mermaid
flowchart LR
    subgraph work["Work system (back office)"]
        WC["Client: HTML / CSS / JS"]
        WS["Server: TypeScript / Bun"]
        PG[("PostgreSQL<br/>matrix tables (JSON)")]
        WC <-->|"Dédalo API (RQO)"| WS
        WS <--> PG
    end
    subgraph diff["Diffusion system (publication)"]
        DC["Client / portals / websites"]
        DS["Server: TypeScript / Bun"]
        SQL[("MariaDB / MySQL<br/>classic columns")]
        DC <-->|"Diffusion API"| DS
        DS <--> SQL
    end
    WS -.->|"publish marked data"| DS
    ONT(["Ontology<br/>(active schema)"])
    ONT -.->|drives| WS
    ONT -.->|maps formats| DS
```

**Prose description of the diagram above:** Two boxes sit side by side. On the
left, the *work system* contains a client (HTML/CSS/JS) and a server
(TypeScript on Bun) that exchange Request Query Objects over the Dédalo API;
the server reads and writes PostgreSQL, where data lives as JSON in the
`matrix` tables. On the right, the *diffusion system* contains portals/websites
and a TypeScript/Bun server exchanging data over the diffusion API; that server
reads and writes a classic SQL database with conventional columns. A dotted arrow
runs from the work server to the diffusion server labelled "publish marked
data" — diffusion is downstream. Below everything, an "Ontology (active
schema)" node sends dotted arrows to both servers: it drives the work system
and maps the output formats for diffusion.

## Architecture diagrams

These are the presentation-sized companions to the prose on this page and on the
subsystem pages. They live once, under `docs/assets/images/diagrams/`, and each
is embedded from the page it documents — **click any diagram to open it full
size**.

[![The three planes: the work system, diffusion, and the publication API, with the two seams between them](../assets/images/diagrams/overview_work_diffusion_publication.svg)](../assets/images/diagrams/overview_work_diffusion_publication.svg)

**Prose description of the diagram above:** three columns, read left to right.
The first, *the work system*, runs down from the client and `server.ts` through
the five dispatch gates and the handler classes into the read and write paths,
ending at the PostgreSQL matrix database and the envelope every answer is
wrapped in. The second, *diffusion*, starts at `dd_diffusion_api`, passes
through the durable job row and the scheduler that spawns one runner process,
and down the runner's pipeline into the format writers and their targets. The
third, *the publication API*, starts at the published MariaDB database that the
runner wrote, and rises through the routing choke point, the read-only REST
surface and the MCP endpoint to the websites and agents that consume it. A
single arrow joins the first column to the second (the engine enqueues a job)
and a single arrow joins the second to the third (the runner publishes rows and
files) — each boundary is crossed once, in one direction, through a database.

| Diagram | Documented in |
|---|---|
| **[From the work system to the public web](../assets/images/diagrams/overview_work_diffusion_publication.svg)** — the three planes and the two seams between them | this page |
| **[The Work API](../assets/images/diagrams/work_api.svg)** — one RQO in, five gates, handler classes, the read and write paths, envelope v2 | [API](../api/index.md) |
| **[The Diffusion API](../assets/images/diagrams/diffusion_api.svg)** — control plane, durable job row, runner pipeline, writers and targets | [The diffusion engine](../diffusion/native_engine.md) |
| **[Publication API v2](../assets/images/diagrams/publication_api_v2.svg)** — the routing choke point, the route table, the services, and the isolation law | [Publication API v2](../diffusion/publication_api/v2/index.md) |
| **[The RAG subsystem](../assets/images/diagrams/rag_system.svg)** — indexing, the two stores, hybrid retrieval and its ACL gate, the `ask` pipeline | [RAG & semantic search](../administration/ai/rag.md) |
| **[MCP and the agent loop](../assets/images/diagrams/mcp_system.svg)** — the surfaces, the one tool registry, `runTool`, and the propose-confirm-apply protocol | [The AI Assistant](../administration/ai/assistant/index.md) |

## The matrix data model

Since v4 Dédalo abandoned the classic one-table-per-entity SQL schema. Instead,
almost everything lives in a handful of identically shaped tables named
`matrix`, `matrix_hierarchy`, `matrix_users`, and so on. The three identity
columns are always the same; the record itself is stored as JSON:

| column | meaning |
|---|---|
| `id` | the unique row id of the physical table |
| `section_id` | the record id *within its section* (unique per `section_tipo`, not per table) |
| `section_tipo` | which section (which abstract "table") this row belongs to |
| *typed JSONB columns* | the record's values, split by data shape — `data`, `relation`, `string`, `date`, `iri`, `geo`, `number`, `media`, `misc`, `relation_search`, `meta` (see note) |

A People record and an Interview record can both have `section_id = 1` because
they live under different `section_tipo` values (`rsc197` vs `oh1`). The payload
JSON keys are component tipos, not human field names — the human names live in
the ontology and are resolved at runtime per language.

> **Physical storage of the payload.** Every record table (`MATRIX_TABLE_ALLOWLIST`
> in `src/core/db/matrix.ts`) splits a record's
> values across several **typed** JSONB columns — `data`, `string`, `number`,
> `relation`, `date`, `iri`, `geo`, `media`, `misc`, `relation_search`, `meta` —
> assigning each component to one column by its model. Inside each column the
> values are keyed by component tipo — except `data`, which holds the section's
> own metadata (label, created/modified date and user). The model→column
> mapping is `getColumnNameByModel()` in `src/core/ontology/resolver.ts`, and
> the JSONB column set is `MATRIX_JSONB_COLUMNS` in `src/core/db/matrix.ts`, so
> PostgreSQL can index every data shape.
> [Sections](sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns)
> documents the full column map.

```mermaid
erDiagram
    PEOPLE_SQL {
        int id PK
        string name
        string surname
    }
    INTERVIEW_SQL {
        int id PK
        string title
    }
    matrix {
        int id PK
        int section_id
        string section_tipo
        jsonb data
        jsonb string
        jsonb relation
        jsonb date
        jsonb meta
    }
```

**Prose description of the diagram above:** The first two entities,
`PEOPLE_SQL` and `INTERVIEW_SQL`, show the classic approach: each concept gets
its own table with its own typed columns (`name`, `surname`; `title`). The third
entity, `matrix`, shows the Dédalo approach: a single table with `id`,
`section_id`, `section_tipo` and a fixed set of typed JSONB columns (`string`,
`relation`, …). Where classic SQL needs N tables for N concepts, Dédalo needs
one — the concept is encoded in `section_tipo` and the fields are encoded as
component-tipo keys inside the typed columns.

The same People record in both worlds:

| classic SQL `people` table | | |
|---|---|---|
| **id** | **name** | **surname** |
| 1 | Alicia | Gutierrez |

```json
// one row in the Dédalo `matrix` table (only `data` and `string` shown;
// `relation`, `date`, `meta` … omitted)
{
    "id"           : 1,
    "section_id"   : 1,
    "section_tipo" : "rsc197",
    "data" : {
        "label"        : "People",
        "section_id"   : 1,
        "section_tipo" : "rsc197",
        "created_date" : "2017-11-15 22:51:42"
    },
    "string" : {
        "rsc85" : [{ "id": 1, "lang": "lg-nolan", "value": "Alicia" }],
        "rsc86" : [{ "id": 1, "lang": "lg-nolan", "value": "Gutierrez" }]
    }
}
```

A full Dédalo installation has roughly 28 physical tables — most of which share
this same column set — yet expresses around 1,100 logical sections with some
16,000 logical fields. The schema explosion that would cripple classic SQL is
folded into JSON and the ontology. The price is paid in resolution: reading a
field is never a column read; it is an ontology lookup followed by JSON
traversal. (See [Locator](locator.md) for the matrix tables in detail.)

## The ontology is the active schema

The ontology is not documentation *about* the schema — it **is** the schema, and
it is live. There is no `CREATE TABLE` anywhere; sections and components are
nodes in one hierarchical ontology (stored in `dd_ontology`, with instances in
the matrix tables). Dédalo reads the ontology at execution time and resolves it
into the running objects dynamically — server-side, per-model **descriptors**
(`src/core/components/component_*/descriptor.ts`, gathered by
`src/core/components/registry.ts`) plus the JS client objects — so editing a
node changes behavior with no code change. Changing a `component_select` into a
`component_autocomplete` is a node edit, not a migration.

Each node is a single JSON object. The load-bearing fields:

```json
{
  "tipo"           : "rsc197",
  "parent"         : "rsc203",
  "model"          : "section",
  "model_tipo"     : "dd6",
  "order_number"   : 5,
  "tld"            : "rsc",
  "is_translatable": false,
  "lg-eng": "People", "lg-spa": "Personas", "lg-cat": "Persones",
  "relations"  : [ { "tipo": "rsc75" } ],
  "properties" : { }
}
```

- `tipo` is the unique id; it is a **TLD + sequence**: `rsc197` is the 197th node
  of the `rsc` (Resources) TLD, `oh1` is the first node of `oh` (Oral History),
  `dd5` the fifth core node. Core TLDs `dd`, `ontology`, `lg`, `hierarchy` are
  mandatory; domain TLDs (`rsc`, `tch`, `oh`, …) and custom local TLDs extend the
  tree by setting `parent` to an existing node.
- `model` (resolved via `model_tipo`, e.g. `dd6` → `section`,
  `dd592` → `component_portal`) declares what logic the node uses.
- `parent` places the node in the tree; the resolved context also carries a
  `parent_grouper` (the layout parent, usually a `section_group`), derived from
  `parent` rather than stored on the node.
- the `lg-*` keys are the translatable label (the *term object*).
- `properties` (JSONB) is the per-node descriptor: behavior, options, layout/CSS,
  and `request_config`. `relations` (JSONB) is the node's list of `{"tipo": …}`
  references to **other definitions** — here `rsc75`, marking `rsc197` a virtual
  section that borrows the real section's children. Both flow, through the
  structure-context cache, into the **context** the client renders (see
  [request_config](request_config.md) and [dd_object](../api/dd_object.md)).

!!! warning "Node `relations` is not record data"
    A node's `relations` array points at other **ontology nodes**. It has
    nothing to do with a record's stored [locators](locator.md), which live in
    the `relation` column — singular — of the record's matrix row, keyed by
    component tipo. Same word, two unrelated things; see
    [Sections](sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns).

## The areas → sections → components → data hierarchy

The ontology is a tree. The top levels organize the application; the bottom level
is the actual data.

- **Area** — a top-level grouping shown in the main menu (e.g. "Intangible
  Heritage"). Areas contain sections.
- **Section** — the abstraction of a table (model `section`); a group of records
  of the same kind (People, Interviews). See [Sections](sections/index.md).
- **Component** — the abstraction of a column (model `component_*`); a typed
  field inside a section, grouped under `section_group` nodes for layout. See
  [Components](components/index.md).
- **Data** — the actual records, stored as JSON in the matrix tables, with keys
  that are component tipos.

```mermaid
flowchart TD
    A["Area: Intangible Heritage (dd323)"]
    A --> S1["Section: People (rsc197)<br/>model = section"]
    A --> S2["Section: Oral History (oh1)<br/>model = section"]
    S1 --> G1["section_group (layout)"]
    G1 --> C1["component_input_text<br/>Name (rsc85)"]
    G1 --> C2["component_input_text<br/>Surname (rsc86)"]
    S1 --> C3["component_portal<br/>Birth town (rsc91)"]
    C1 --> D[("Record data in matrix<br/>{section_tipo: rsc197, section_id: 1,<br/>rsc85: Alicia, rsc86: Gutierrez}")]
    C2 --> D
```

**Prose description of the diagram above:** At the top is the area "Intangible
Heritage". It branches to two sections, "People" (`rsc197`) and "Oral History"
(`oh1`), both with model `section`. The People section branches to a
`section_group` layout node, which in turn holds two `component_input_text`
fields, "Name" (`rsc85`) and "Surname" (`rsc86`); People also directly holds a
`component_portal`, "Birth town" (`rsc91`). The two text components point down to
a single record stored in the matrix table — a JSON object keyed by section_tipo,
section_id and the component tipos. The tree is the schema; the bottom box is the
data described by that schema.

## Abstraction layers: the cost and the benefit

Dédalo never calls things directly. To resolve a single field, the runtime
fetches the ontology node, often follows it to other nodes (a portal points into
another section whose components must themselves be resolved), and only then
traverses JSON to get the value. The layers, top to bottom:

1. **Ontology nodes** — the active definitions (areas/sections/components/tools).
2. **Models** — on the server, the TS descriptors (`section`,
   `component_input_text`, `component_portal`, …) chosen by each node's
   `model`; on the client, the same-named JS classes.
3. **Instances** — runtime objects built per request, carrying a *context* and
   *data* (see [Components](components/index.md) and [dd_object](../api/dd_object.md)).
4. **The datum `{context, data}`** — the transport unit; `context` is the
   description (from the ontology), `data` is just the values.
5. **Locators** — typed pointers that turn standalone records into a relational
   graph (see [Locator](locator.md)).
6. **The matrix JSON** — the physical storage.

**Benefit:** extreme flexibility. The schema, the relations, the render and even
the output format (RDF, JSON-LD, Dublin Core, CIDOC, MARC21, CSV…) are all
ontology-driven, so Dédalo can re-shape data to any standard without touching
code or the database. **Cost:** resolution is slower than a direct column read,
and the complexity of resolving one record grows quickly as relations deepen.
This trade-off is the central design decision of the whole system and explains
the caches you will meet (structure-context cache, instance caches, request_config
caching).

## Server build vs client render: the data flow

The server no longer renders HTML. It resolves data and ships a normalized object
(the [dd_object / ddo](../api/dd_object.md)) carrying **context** (the ontology
description: tipo, model, mode, label, properties, css, request_config,
permissions, tools) and **data** (only the values). The client turns that into
DOM.

```mermaid
flowchart LR
    O(["Ontology node<br/>(model, properties, relations)"])
    O --> B["Server build:<br/>resolve engines (structure_context,<br/>section/read.ts emitDdoData, relations/)"]
    B --> CTX["context<br/>(description: label, model, properties,<br/>css, request_config, permissions, tools)"]
    B --> DAT["data<br/>(values only: array of {id, value, lang?})"]
    CTX --> DDO["ddo / datum {context, data}"]
    DAT --> DDO
    DDO -->|JSON API response| R["Client render layer<br/>(ui.component builders)"]
    R --> H["DOM: wrapper_component > content_data > content_value > value"]
```

**Prose description of the diagram above:** It reads left to right. An ontology
node (with its model, properties and relations) feeds the server build step —
in the TS server, the horizontal resolve engines (`src/core/resolve/structure_context.ts`
for context, `src/core/section/read.ts`'s `emitDdoData` and `src/core/relations/`
for data, dispatched via each model's descriptor rather than a per-class
factory). That build emits two things: a `context` (the description — label,
model, properties, css, request_config, permissions, tools) and a `data`
payload (values only — an array of `{id, value}` items, with `lang` when
translatable). Both are packed into a single `ddo`/datum of shape
`{context, data}` and sent as the JSON API response. The client render layer
(the shared `ui.component` builders, copied over unchanged) consumes that datum
and produces the DOM tree
`wrapper_component > content_data > content_value > value`. The key idea: the
server describes, the client draws; the ontology is the source of the
description.

### The datum contract

The persisted and transmitted unit is `{context, data}`:

- **`data`** carries values only: an array of items `{id, value, lang?}`, where
  `value` is the literal payload or a locator, and `lang` is present only for
  translatable components.
- **`context`** carries the description — tipo, model, mode, label, `properties`,
  `css`, `request_config`, permissions and tools — never the values.

A component **never** touches the database directly; persistence is delegated to
its section's write chokepoint through explicit functions rather than instance
methods — reads resolve through `src/core/section/read.ts` (`emitDdoData`) and
the `relations/` engines, and writes go through
`src/core/section/record/save_component.ts` and
`src/core/section_record/record_write.ts` (`persistRecordKeys`/
`persistRecordColumns`), the single place that reads and writes the matrix.
There is no factory and no per-component class to instantiate: a model is
looked up in the components registry (`src/core/components/registry.ts`) and
dispatched to its descriptor and the shared resolve/save engines; `tipo` and
`section_tipo` are mandatory and the `model` is force-corrected from the
ontology. Modes are `edit` (read/write a real record), `list` (read-only
listing), `search` (build SQO filters; saves blocked) and `tm` (Time Machine
read; saves blocked).

## How components compose into sections, and how portals link across them

A section node is the table; its component children point back at it with
`parent = <section_tipo>` and are arranged for layout under `section_group`
nodes. When a section is built, it gathers its component children, resolves
each (in the TS server, one pass of `emitDdoData` per ddo — see
[dd_object](../api/dd_object.md#how-a-ddo_map-resolves-the-chain)), and assembles
their contexts and data into the section's response. Most components are
**literal** — they own their value (input_text, number, date, media). Others
are **related** — they store [locators](locator.md) instead of literals and
resolve their displayed value from a *target* record.

`component_portal` is the canonical cross-section link. Its data is not a value
but an array of locators of shape
`{type, section_tipo, section_id, from_component_tipo}` (the related-components
reference). `type` is the relation-type tipo — for a portal it defaults to
`dd151` (the generic link). `section_tipo`/`section_id` point at the target
record; `from_component_tipo` records which component owns the locator. To show a
value, the portal resolves each locator against the *target* section/component
via `expandPortal()` in `src/core/relations/relation_core.ts` (dispatched through
`src/core/relations/registry.ts` and the per-model resolver in
`src/core/relations/models/portal.ts`) — so the value is always live: edit
the target record and every portal that links to it shows the change. A
record's `relation` JSONB column holds every relation component's locators in
**one** place, as an object keyed by the owning component tipo —
`{"rsc91": [ … ], "rsc1435": [ … ]}` — so a component slices out its own subset
by that key (`relation_list` uses `from_component_tipo` on the entries for the
same purpose). There is no flat record-wide array and no `relations` key on a
record.

```mermaid
flowchart LR
    subgraph People["Section: People (rsc197), section_id 1"]
        Name["component_input_text<br/>Name (rsc85) = 'Alicia'"]
        Birth["component_autocomplete_hi<br/>Birth town (rsc91)"]
    end
    subgraph Town["Section: Town (es1), section_id 3896"]
        Term["component_input_text<br/>Term = 'Valencia'"]
    end
    Birth -->|"locator { type: dd151,<br/>section_tipo: es1,<br/>section_id: 3896,<br/>from_component_tipo: rsc91 }"| Town
    Birth -.->|"resolves display value from target"| Term
```

**Prose description of the diagram above:** On the left is the section "People"
(`rsc197`), record `section_id` 1, containing a literal `component_input_text`
"Name" holding the value "Alicia" and a `component_autocomplete_hi` "Birth town"
(`rsc91`) — a related component of the portal family, sharing its locator
storage. On the right is a different section, "Town" (`es1`), record 3896,
containing a `component_input_text` whose term is "Valencia". A solid arrow runs
from the portal to the Town section carrying a locator
`{type: dd151, section_tipo: es1, section_id: 3896, from_component_tipo: rsc91}` —
that locator is the portal's stored data. A dotted arrow shows the portal
resolving its *displayed* value by reaching into the target record's term
component. The portal stores only the pointer; the displayed text is fetched live
from the target.

## The request lifecycle

A typical round trip: the client builds a Request Query Object describing who is
calling, what action to run and what to show; the Dédalo API dispatches it; the
server resolves the section/component, builds the context and data, and
returns a ddo; the client renders the DOM.

```mermaid
sequenceDiagram
    participant C as Client (JS)
    participant API as Dédalo API<br/>(src/server.ts → core/api/dispatch.ts)
    participant SRV as Section / Component resolvers<br/>(section/read.ts, relations/)
    participant ONT as Ontology + matrix (PostgreSQL)
    C->>API: RQO { source, action, dd_api, sqo, show/search/choose }
    API->>API: sanitize (zod, §7.5) + dispatch (ACTION_REGISTRY lookup)
    API->>SRV: readSection / saveComponentData(tipo, section_tipo, section_id, mode, lang)
    SRV->>ONT: read node (model, properties, relations)
    SRV->>ONT: read record typed columns (and resolve locators if related)
    SRV->>SRV: build context (description) + data (values) = ddo
    SRV-->>API: ddo { context, data }
    API-->>C: JSON response (result = ddo)
    C->>C: render DOM (ui.component builders)
```

**Prose description of the diagram above:** The client (JavaScript) sends a
Request Query Object to the Dédalo API — that RQO names the `source` (who is
calling: tipo, section_tipo, section_id, mode, lang), the `action` and `dd_api`
(what to do), an optional `sqo` (which records), and `show`/`search`/`choose`
layout maps (what to return). The server (`src/server.ts`) parses and
zod-validates the RQO and dispatches it through `src/core/api/dispatch.ts`'s
explicit action registry — no dynamic method lookup or reflection. The matched handler resolves
the section or component (`src/core/section/read.ts` for reads,
`src/core/section/record/save_component.ts` for writes, the `relations/`
engines for related components) against its ontology node (model, properties,
node relations) and the record's stored data in PostgreSQL, resolving locators if it
is a related component. It assembles a `context` (the description) and `data`
(the values) into a `ddo` of shape `{context, data}`, which travels back
through the API as a JSON response. Finally the client renders the DOM using
the shared `ui.component` builders. See
[RQO](../api/rqo.md) for the request format and [dd_object](../api/dd_object.md) for the ddo.

## The multilingual model

Dédalo is multilingual to the core: every label and every translatable value can
exist in many languages, and the language is never baked into the schema.

- **Labels** live in the ontology node as `lg-*` term keys, resolved to the
  current application language at render time. Renaming a label in any language
  never touches the data or the schema.
- **Translatable components** store one value per language; an instance is bound
  to a single language at a time (an input_text instantiated in Català manages
  only the Català value). The `lang` field appears on each `data` item.
- **Non-translatable components** (e.g. `component_number`) declare
  `is_translatable: false` and store a single value under the sentinel language
  `lg-nolan`, working otherwise identically.
- **With-lang-versions / transliterate** is the middle ground: components such as
  `component_iri` or personal names default to `lg-nolan` but can still carry a
  tool language when needed.

Because labels, values and the UI language are independent ontology-driven
layers, the same record renders in any installed language with no duplication.

## A note on search (SQO)

Reads that filter or page over records do not hand-write SQL. They build a
**Search Query Object** — a JSON abstraction of an SQL query (its `filter` maps
to `WHERE`, `order` to `ORDER BY`, plus `limit`/`offset`), inspired by Mango and
adapted to the matrix/JSONB model. The SQO is the query; the RQO wraps it and
adds the caller identity, the action and the layout. The server compiles the SQO
into prepared SQL over the JSONB matrix tables through a security chokepoint that
sanitizes and clamps client input. For the full contract, see [SQO](../api/sqo.md) and,
for how it rides inside a request, [RQO](../api/rqo.md).

## Where to go next

- [Sections](sections/index.md) — the entity/class/table abstraction in depth.
- [Components](components/index.md) — the field abstraction, inheritance, datum.
- [Ontology](ontology/index.md) — the active schema, TLDs, node shape.
- [Locator](locator.md) — typed pointers and the relational graph.
- [dd_object (ddo)](../api/dd_object.md) — the normalized object behind every request.
- [RQO](../api/rqo.md) — the request format. · [SQO](../api/sqo.md) — the query format.
- [request_config](request_config.md) — how context is configured and resolved.
- [Glossary](../understanding/glossary.md) — the full nomenclature table.
