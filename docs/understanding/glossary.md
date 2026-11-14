# Glossary

A developer-oriented glossary of Dédalo-specific terms. Dédalo abandoned the standard SQL schema in v4 and built its own NoSQL-over-JSONB model driven by an active ontology, so most of the words below mean something different from their SQL homonyms. Each entry gives the closest **SQL / standard equivalent** (when one exists), a short definition, and cross-links to the relevant documentation and to related glossary terms.

The seed of this glossary is the nomenclature table in the [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Terms are listed alphabetically; codes such as `dd151` are filed under D, and acronyms under their first letter.

!!! note "Notation"
    Ontology codes (`oh1`, `rsc197`, `dd151`…) are *tipos*. A live definition for any tipo can be inspected at `https://dedalo.dev/ontology/<tipo>` (e.g. [oh1](https://dedalo.dev/ontology/oh1)).

---

## A

### area
*SQL equivalent: a top-level grouping / database schema namespace (no direct SQL analogue).*

A group of related [sections](#section) sitting at the top of the ontology hierarchy; areas are what appear in the main menu. Example: an *Intangible Heritage* area containing the *Oral History* and *Intangible Cultural Assets* sections. Working areas also drive editors — [`area_thesaurus`](#area_thesaurus) and `area_ontology` are areas.
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [section](#section), [ontology](#ontology), [area_thesaurus](#area_thesaurus).

### area_thesaurus
*No SQL equivalent.*

The working area that renders and edits thesaurus trees — hierarchies under the `hierarchy` TLD and any project thesaurus (`ts1`, `es1`, `on1`…). `area_ontology` (the editor of Dédalo's own ontology) is *the same machinery*, an alias differentiated only by runtime flags (`is_ontology`, `area_model`).
See: [Thesaurus and Ontology tree](../core/thesaurus/index.md). Related: [hierarchy / thesaurus](#hierarchy--thesaurus), [ts_object](#ts_object), [node](#node), [TLD](#tld).

---

## C

### component
*SQL equivalent: a column / field (with format and logic).*

A field with managed data of a specific type, living inside a [section](#section). Because the `matrix` table has no real columns, components supply the column concept: each component resolves its value through the ontology and renders through client views. Server-side, a per-model **descriptor** (`src/core/components/component_xxx/descriptor.ts`) declares each component's behavior; descriptors are gathered by `src/core/components/registry.ts` and dispatched by the horizontal resolve/relations/save engines — there is no per-component class or controller file.
See: [Components](../core/components/index.md), [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [section](#section), [component_tipo](#component_tipo), [model](#model), [matrix (table)](#matrix-table).

### component_tipo
*SQL equivalent: a specific column.*

A unique definition of a column in the ontology — the [tipo](#tipo) of one [component](#component) (e.g. `rsc85` = person *Name*). Distinguished from [tipo](#tipo) (any node) and [section_tipo](#section_tipo) (a section node).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [tipo](#tipo), [component](#component), [from_component_tipo](#from_component_tipo).

### context
*No SQL equivalent (the JSON-API description layer).*

The small piece of the ontology that *describes* an element (section, component, tool…): its `tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `request_config`, `view`. Context is used to build and instantiate or modify an element. In the JSON-API contract the transmitted unit is a `{context, data}` pair (a [datum](#datum)); **context carries the description, never the values**.
See: [dd_object](../api/dd_object.md), [Introduction](../core/index.md#definitions-of-dédalos-nomenclature); skill *dedalo-context-data-layers*. Related: [subcontext](#subcontext), [data](#data), [datum](#datum), [DDO (dd_object)](#ddo-dd_object).

---

## D

### data
*SQL equivalent: the cell payload (the value plus its envelope).*

The data container of a [component](#component) or element: the stored [value](#value) plus optional companions such as the [datalist](#datalist) (option list) or value fallbacks. Sits opposite [context](#context) in the `{context, data}` [datum](#datum). Note the difference from the raw JSONB storage of a [matrix](#matrix-table) row — a single legacy `datos` column, or the v7 typed columns (`string`, `number`, `relation`, …) — which holds *all* of the record's data. v7 settled the vocabulary on **`data`** (not the v6 term `dato`): raw stored `data`, resolved `value`, transport `datum.data` — see the [data model](../core/data_model/index.md).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [data model](../core/data_model/index.md); skill *dedalo-context-data-layers*. Related: [value item](#value-item), [value](#value), [datum](#datum), [subdata](#subdata), [datalist](#datalist), [context](#context).

### datalist
*SQL equivalent: the candidate rows of a foreign-key `SELECT` (the option list).*

The list of selectable options/autocomplete suggestions a component offers (for `select`, `check_box`, `radio_button` and relation-based components). It travels inside [data](#data), is resolved from the target component's `get_list_of_values()` and served through [`relation_list`](#relation), and is cached.
See: [component_portal](../core/components/component_portal.md); skill *dedalo-datalist-resolution*. Related: [data](#data), [relation](#relation-bidirectional--unidirectional), [value](#value).

### datum
*SQL equivalent: a single resolved field result.*

The transmitted unit of the JSON API: one `{context, data}` object describing and carrying one element's result. A component returns a datum; a [portal](#component) appends the target components' datums and merges their [context](#context). Plural usage: *datums*. Companion resolved values pulled in for related records arrive as [subdata](#subdata) via `get_subdatum()`.
See: [component_portal](../core/components/component_portal.md); skill *dedalo-context-data-layers*. Related: [data](#data), [context](#context), [subdata](#subdata).

### dataframe
*SQL equivalent: a side-table of per-cell annotations keyed to a row's array index.*

A Dédalo v7 mechanism that pairs *frame records* (uncertainty, qualifiers, context) with the individual data items of a main component, via the unified `id_key` contract. Dataframe locators are positively marked with `type` = `dd490` ([DEDALO_RELATION_TYPE_DATAFRAME](#dd151)).
See: [component_dataframe](../core/components/component_dataframe.md); skill *dedalo-dataframe*. Related: [locator](#locator), [relation](#relation-bidirectional--unidirectional), [component](#component).

### dd151
*SQL equivalent: a foreign-key relation flavor.*

The ontology tipo for the **link** relation type (`DEDALO_RELATION_TYPE_LINK`), the default kind of pointer a [locator](#locator) carries in its `type`. It is one of the relation tipos stamped on the `relation` JSONB column. Siblings: `dd48` children, `dd47` parent, `dd96` index (`DEDALO_RELATION_TYPE_INDEX_TIPO`), `dd98` model, `dd675` filter, `dd490` dataframe, `dd89`/`dd620`/`dd467`/`dd621` related (uni-/bi-/multi-directional). These are declared where needed, split across `src/core/ontology/ontology_tipos.ts` (`RELATION_TYPE_LINK`/`_PARENT`/`_CHILDREN`/`_INDEX`), `src/core/relations/related.ts` (`RELATED_UNIDIRECTIONAL`/`_BIDIRECTIONAL`/`_MULTIDIRECTIONAL`) and `src/core/concepts/subdatum.ts` (`DATAFRAME_RELATION_TYPE`) — there is no single central constants file.
See: [locator](../core/locator.md#properties). Related: [locator](#locator), [relation](#relation-bidirectional--unidirectional), [relations array](#relations-array), [dataframe](#dataframe).

### dd_date
*SQL equivalent: a normalized date/time literal (richer than SQL `DATE`).*

A normalized Dédalo object representing dates, able to express ranges, periods, calendars and uncertainty beyond a single SQL date. It is the `value` of a [value item](#value-item) in the `date` typed column, produced by `component_date`.
See: [Date values (data model)](../core/data_model/dd_date.md), [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [value item](#value-item), [DDO (dd_object)](#ddo-dd_object), [ts_object](#ts_object), [dd_grid](#dd_grid).

### dd_grid
*SQL equivalent: a flat result set / pivoted view with rows and columns.*

A normalized Dédalo object that represents a table of rows and columns; `dd_grid` resolves data relations and flattens them into a table of plain data (used heavily by export).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [Exporting data](../using/exporting_data.md); skill *dedalo-export*. Related: [DDO (dd_object)](#ddo-dd_object), [matrix (table)](#matrix-table), [subdata](#subdata).

### DDO (dd_object)
*No SQL equivalent.*

The **D**édalo **D**ata **O**bject — a normalized, extensible object that *calls and modifies* ontology nodes (it is **not** a node itself). One ddo is a configuration specific to the node it represents: it defines order, view, [mode](#mode-edit--list--search--tm), [permissions](#permissions), [properties](#properties--descriptor), css and so on. ddos are assembled into `ddo_map` layouts (`show`/`search`/`choose`/`hide`) inside an [RQO](#rqo) and let callers change section/component behavior on the fly.
See: [dd_object](../api/dd_object.md). Related: [context](#context), [RQO](#rqo), [request_config](#request_config), [model](#model), [view](#view).

### descriptor
See [properties / descriptor](#properties--descriptor) (ontology properties) and [hierarchy / thesaurus](#hierarchy--thesaurus) for the thesaurus sense (a *descriptor* is a preferred term; a *non-descriptor*/ND is a synonym or variant).

### diffusion
*SQL equivalent: an ETL/publishing pipeline to a classic SQL schema.*

The publication side of Dédalo: the system that *publishes* curated work data to SQL / RDF / XML / Markdown / CSV / JSON targets for public consumption. The publication database (MariaDB/MySQL by default) uses a classic columnar SQL schema, written only by the diffusion engine built into the work server — publishing runs as durable jobs, driven by the diffusion ontology.
See: [Diffusion (system overview)](../core/system/diffusion.md), [The diffusion engine](../diffusion/native_engine.md). Related: [work system vs publication system](#work-system-vs-publication-system), [ontology](#ontology).

---

## F

### from_component_tipo
*SQL equivalent: the source/owning column of a foreign key.*

A [locator](#locator) property naming the **source** component that stores the locator (the caller side of the relation), prefixed `from_`. Companions: `from_section_tipo` and `from_section_id` identify the source section/record. In a thesaurus parent locator, for instance, `from_component_tipo` is `hierarchy36` (the `component_relation_parent` tipo).
See: [Locator → Properties](../core/locator.md#properties). Related: [locator](#locator), [component_tipo](#component_tipo), [relation](#relation-bidirectional--unidirectional).

---

## H

### hierarchy / thesaurus
*SQL equivalent: a self-referencing parent/child taxonomy table.*

A controlled vocabulary modeled as a hierarchical tree of terms (toponymy, onomastic, thematic thesauri, material/technique taxonomies, typology catalogues). A **hierarchy** is a record of section `hierarchy1` describing one tree; a **term** is an ordinary section record inside a thesaurus section (e.g. `es1_42`). Hierarchy is stored bottom-up: each term keeps one parent [locator](#locator) (`type` = `dd47`), and children are *always computed* by searching for that pointer.
See: [Thesaurus and Ontology tree](../core/thesaurus/index.md). Related: [area_thesaurus](#area_thesaurus), [ts_object](#ts_object), [node](#node), [TLD](#tld), [properties / descriptor](#properties--descriptor).

---

## I

### id
*SQL equivalent: the table primary key.*

The unique row id of a [matrix](#matrix-table) table — unique across the *whole* table, which holds many sections at once. It is therefore distinct from [section_id](#section_id), which is unique only within one [section_tipo](#section_tipo). The homonymy is exactly why Dédalo keeps both names.
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [section_id](#section_id), [matrix (table)](#matrix-table), [section_tipo](#section_tipo).

---

## L

### lg-nolan
*SQL equivalent: a non-translatable / locale-neutral column value.*

The reserved "no language" language code (`DEDALO_DATA_NOLAN`, value `lg-nolan`) used to store data that is **not** translatable — codes, technical literals, `root`, internal values — so the value lives outside any real language slot (`lg-eng`, `lg-spa`…).
There is no named config constant for it — `'lg-nolan'` is used directly as a literal (e.g. `src/core/section/read.ts`, `src/core/section/record/*.ts`). Related: [translatable / lg-nolan / transliterate](#translatable--lg-nolan--transliterate), [value](#value).

### locator
*SQL equivalent: a foreign-key relation (a pointer between rows).*

The object Dédalo uses to connect data — a relative, multi-reference, directional pointer. The minimal form is `{section_id, section_tipo}`; it can also target a [component](#component) (`component_tipo`) or a tag (`tag_id`), and names its source with the `from_` prefix. The `type` property carries the relation flavor (e.g. [dd151](#dd151) link, `dd47` parent). A flat string form (`component_tipo_section_tipo_section_id`, e.g. `rsc29_rsc170_3`) is used as media filenames. A locator is the [value item](#value-item) of every relation component, stored in the `relation` typed column.
See: [Locator](../core/locator.md), [data model — relations](../core/data_model/relations.md). Related: [value item](#value-item), [relation](#relation-bidirectional--unidirectional), [from_component_tipo](#from_component_tipo), [dd151](#dd151), [relations array](#relations-array), [datalist](#datalist).

---

## M

### matrix (table)
*SQL equivalent: a single physical table standing in for ~1100 logical tables.*

The PostgreSQL table where Dédalo stores most data, with the columns `id`, `section_id`, `section_tipo` plus per-type JSONB columns (`data`, `string`, `relation`, `iri`, `number`, `date`, `geo`, `media`, `misc`, `relation_search`, `meta`) that hold each data shape, keyed by component tipo (`data` holds the section's own metadata). There are a few sibling matrix tables sharing this schema (`matrix_hierarchy`, `matrix_users`, `matrix_dataframe`, `matrix_activities`…). The **`meta`** column keeps the per-component id counters that mint stable [value item](#value-item) ids. A full schema can hold ~1100 sections / ~16,000 components in these few tables.
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [data model](../core/data_model/index.md), [Locator → Function and structure](../core/locator.md#function-and-structure). Related: [section](#section), [section_tipo](#section_tipo), [id](#id), [section_id](#section_id), [data](#data), [value item](#value-item).

### mode (edit / list / search / tm)
*SQL equivalent: the request/view mode (no direct analogue).*

How an element is configured for the current request. Core values: `edit` (single-record editing), `list` (tabular multi-record), `search` (build a query), `tm` (time machine — address a specific [matrix](#matrix-table) row / history). Mode drives which components show, default pagination, and which client view files (`yyy` segment of `view_yyy_*`) load.
See: [RQO](../api/rqo.md), [request_config](../core/request_config.md). Related: [view](#view), [DDO (dd_object)](#ddo-dd_object), [RQO](#rqo), [request_config](#request_config).

### model
*SQL equivalent: the column/table data type (the typology).*

A node's *typology* — the unique definition that says **what** a node is and which logic it runs. `section` is a model; `component_input_text`, `component_portal`, `button_new` are models. A [tipo](#tipo) has exactly one model: `oh1` → `section`, `rsc85` → `component_input_text`. (In a [DDO](#ddo-dd_object), `type` is the broad family — section/component/button — while `model` is the specific one.)
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [Ontology](../core/ontology/index.md). Related: [tipo](#tipo), [node](#node), [component](#component), [DDO (dd_object)](#ddo-dd_object).

---

## N

### node
*SQL equivalent: a schema-definition row (table/column DDL entry).*

A single entry in the ontology hierarchy: a definition (or instance) identified by a [tipo](#tipo) and classified by a [model](#model). Nodes nest like thesaurus terms (parent / children / related) and carry translations and [properties](#properties--descriptor). Sections, components, tools, areas, buttons are all nodes. [DDOs](#ddo-dd_object) point at nodes; they are not nodes themselves.
See: [Ontology](../core/ontology/index.md). Related: [model](#model), [tipo](#tipo), [ontology](#ontology), [DDO (dd_object)](#ddo-dd_object), [hierarchy / thesaurus](#hierarchy--thesaurus).

---

## O

### ontology
*SQL equivalent: the database schema — but **active**, not passive.*

The live, dynamic definition of Dédalo's behavior and schema: it defines tables ([sections](#section)), columns ([components](#component)), relations, tools, data formats and more. It is consulted at execution time, so editing the ontology changes Dédalo's behavior in real time (within limits) without touching code or the database schema. Organized by [TLD](#tld) and identified by [tipo](#tipo); its interface is a thesaurus-style [hierarchy](#hierarchy--thesaurus).
See: [Ontology](../core/ontology/index.md), [Introduction](../core/index.md#dédalo-ontology). Related: [TLD](#tld), [tipo](#tipo), [node](#node), [model](#model), [area_thesaurus](#area_thesaurus).

---

## P

### permissions
*SQL equivalent: row/column GRANT level.*

The access level of a [DDO](#ddo-dd_object), an integer (`0` none, `1` read-only, `2` read/write). It defaults to the current user's permissions and can be *reduced* per node (to hide it or make it read-only) but **never raised above** the user's actual level.
See: [dd_object](../api/dd_object.md). Related: [DDO (dd_object)](#ddo-dd_object), [mode](#mode-edit--list--search--tm), [request_config](#request_config).

### properties / descriptor
*SQL equivalent: column metadata / DDL attributes.*

`properties` is the ontology configuration object attached to a [node](#node) and surfaced on its [DDO](#ddo-dd_object): data defaults, source/relation config, css, search behavior, etc. The v7 convention is `properties` (never the v6 `propiedades`). A node's `properties->source->request_config` is what the [request_config](#request_config) v6 builder parses. (For the thesaurus sense of *descriptor* — a preferred term vs a non-descriptor/ND — see [hierarchy / thesaurus](#hierarchy--thesaurus).)
See: [dd_object](../api/dd_object.md), [request_config](../core/request_config.md); skill *dedalo-request-config*. Related: [request_config](#request_config), [DDO (dd_object)](#ddo-dd_object), [node](#node).

---

## R

### Raspa score
*No SQL equivalent (a data-quality metric).*

The **Raspa Data Quality Score**, Dédalo's cumulative 0–10 metric for evaluating cultural-heritage data across progressive levels of computational readiness, semantic richness and ethical transparency (e.g. L1 structured, L2 ontologically modeled, L4 traceable, L7 translatable, L10 fully FOSS-processed), with an extra point for sustainable data. It has a technical and a community/social dimension.
See: [The Raspa Data Quality Score](raspa_score.md). Related: [ontology](#ontology), [diffusion](#diffusion), [translatable / lg-nolan / transliterate](#translatable--lg-nolan--transliterate).

### relation (bidirectional / unidirectional)
*SQL equivalent: a foreign key — one-way or mutually maintained.*

A connection between records, materialized as one or more [locators](#locator) whose `type` carries the flavor. A **unidirectional** relation points only one way (the source stores the locator); a **bidirectional** relation is mirrored on both records so each knows the other; a **multidirectional** relation links several. The related-relation tipos: `dd620` unidirectional, `dd467` bidirectional, `dd621` multidirectional (also `dd89` related, [dd151](#dd151) link, `dd47`/`dd48` parent/children). All relation locators are stored in the `relation` typed column, keyed by component tipo.
See: [Locator](../core/locator.md), [data model — relations](../core/data_model/relations.md). Related: [locator](#locator), [dd151](#dd151), [relations array](#relations-array), [from_component_tipo](#from_component_tipo).

### relations array
*SQL equivalent: a join/junction table for one record (inline).*

The `relations` container of a section record: a flat array of all the [locators](#locator) that record participates in. It is the section-level index of relationships, kept alongside the components' own data. Distinct from the **`relation` typed column** (the per-component locator store keyed by component tipo, from which a section-level index could be assembled). The write path (`src/core/section/record/save_component.ts`, `src/core/relations/save.ts`) writes only the per-component `relation` typed column; it does not maintain a section-level aggregate — inverse/related lookups instead compute on demand via `src/core/search/search_related.ts` (`findInverseReferences`).
See: [Locator](../core/locator.md), [data model — relations](../core/data_model/relations.md). Related: [locator](#locator), [relation](#relation-bidirectional--unidirectional), [section](#section), [matrix (table)](#matrix-table).

### request_config
*No direct SQL equivalent (a layout/retrieval configuration layer).*

The system that defines **how** sections and components retrieve and display data — *what* fields/columns, *how* to search, *where* the data comes from, *which* elements show or hide. It bridges ontology [properties](#properties--descriptor) with API requests through a trait-based orchestrator (`get_ar_request_config()`), preferring the v6 builder (`properties->source->request_config`) and falling back to v5 `relation_nodes`. Carried on a [DDO](#ddo-dd_object) and inside the [RQO](#rqo).
See: [Request Config Architecture](../core/request_config.md), [examples](../core/request_config_examples.md); skill *dedalo-request-config*. Related: [DDO (dd_object)](#ddo-dd_object), [RQO](#rqo), [mode](#mode-edit--list--search--tm), [properties / descriptor](#properties--descriptor).

### RQO
*SQL equivalent: an API request envelope (wrapping the query).*

**Request Query Object** — the single normalized message of every client→server work-API call. One RQO answers: *who* calls (`source`), *what* to do (`dd_api` + `action`), *over which records* (an embedded [SQO](#sqo)), and *what to return / lay out* (`show`/`search`/`choose`/`hide` ddo_maps). Mantra: **SQO = the query; RQO = the request.** One RQO per HTTP call.
See: [Request Query Object (RQO)](../api/rqo.md). Related: [SQO](#sqo), [DDO (dd_object)](#ddo-dd_object), [request_config](#request_config), [mode](#mode-edit--list--search--tm).

---

## S

### section
*SQL equivalent: a table (with format and logic).*

A group of records of the same kind (people, interviews, images…). It plays the role of an SQL table but is *not* one: many sections share the same physical [matrix](#matrix-table) table, distinguished by [section_tipo](#section_tipo). Its fields are [components](#component).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [section_tipo](#section_tipo), [component](#component), [matrix (table)](#matrix-table), [section_id](#section_id), [area](#area).

### section_id
*SQL equivalent: a per-table primary key (scoped to one section).*

The unique record id **within** a [section_tipo](#section_tipo) — paired with `section_tipo` it addresses one specific row. Because one matrix table mixes many sections, two records can share `section_id = 1` if their `section_tipo` differs. Distinct from the table-wide [id](#id).

Always an **integer**, negatives included (`-1` is the root record). Values that are not integers are a different concept sharing the field name: an external-service remote id (`001338683`, `Q42`) or a synthetic client token (`search_1`), both kept verbatim. See [Canonical form of `section_id`](../core/locator.md#canonical-form-of-section_id).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [id](#id), [section_tipo](#section_tipo), [locator](#locator), [matrix (table)](#matrix-table).

### section_tipo
*SQL equivalent: a specific table identity.*

The unique ontology definition (a [tipo](#tipo)) of one [section](#section) — e.g. `oh1` (Oral History), `rsc197` (People). It is the discriminator column that, combined with [section_id](#section_id), pinpoints a record in the shared [matrix](#matrix-table) table.
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [section](#section), [tipo](#tipo), [section_id](#section_id), [from_component_tipo](#from_component_tipo).

### service
*No SQL equivalent.*

A reusable piece of interface + logic *shared* between components, sections or tools — e.g. a *text processor* used by text areas, or an *upload files* service used by image/PDF/audiovisual components.
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [Services](../development/services/index.md). Related: [tool](#tool), [widget](#widget), [component](#component).

### SQO
*SQL equivalent: a `SELECT … WHERE … ORDER … LIMIT` query (abstracted).*

**Search Query Object** — a JSON abstraction of an SQL query, inspired by CouchDB's Mango language and adapted to Dédalo's ontology-driven, columnless schema. Its `filter` maps to `WHERE`, `order`/`limit`/`offset` to the rest; the search engine parses it into JSONB jsonpath SQL over the [matrix](#matrix-table) tables. A client-built SQO is untrusted and passes the `sanitize_client_sqo()` / `conform_filter()` security chokepoint; a server-built SQO is trusted.
See: [Search Query Object](../api/sqo.md), [search config](../administration/configuration/search.md); skill *dedalo-search*. Related: [RQO](#rqo), [matrix (table)](#matrix-table), [component](#component).

### subcontext
*No SQL equivalent.*

The small piece of the ontology holding **all the [context](#context) needed to build a composite element**: for a [section](#section) it is the context of its inner [components](#component); for a `component_portal` it is the context of the components it points at in other sections.
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature); skill *dedalo-context-data-layers*. Related: [context](#context), [subdata](#subdata), [component](#component).

### subdata
*SQL equivalent: the joined-in column values of related rows.*

The [data](#data) of *other* elements needed to build a composite element: for a section, all its components' data; for a `component_portal`, the resolved data of the pointed section/components. Resolved via `get_subdatum()` and merged into the [datum](#datum). The singular *subdatum* is one such resolved unit.
See: [component_portal](../core/components/component_portal.md), [Introduction](../core/index.md#definitions-of-dédalos-nomenclature); skill *dedalo-context-data-layers*. Related: [data](#data), [subcontext](#subcontext), [datum](#datum).

---

## T

### tipo
*SQL equivalent: an internal identifier code.*

The alphanumeric code identifying *every* node in the ontology (`oh1`, `rsc85`, `dd151`). *Tipo* is Spanish for "type" and is also glossed as the acronym **T**ypology of **I**ndirect **P**rogramming **O**bjects. A tipo is a [TLD](#tld) plus a sequential number (`dd5` = the 5th `dd` node) and resolves to exactly one [model](#model). Specializations: [section_tipo](#section_tipo), [component_tipo](#component_tipo).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [Ontology](../core/ontology/index.md). Related: [TLD](#tld), [model](#model), [node](#node), [section_tipo](#section_tipo), [component_tipo](#component_tipo).

### TLD
*SQL equivalent: a schema/namespace prefix.*

**Top-Level Domain** — the identifying prefix of a [tipo](#tipo) that partitions the ontology so it can grow without code collisions. Examples: `dd` (Dédalo core), `rsc` (resources/media), `hierarchy` (thesauri), `lg` (languages), `oh` (Oral History), `ich`/`tch`/`tchi` (intangible/tangible heritage), `utoponymy`, `ontology`. Local projects can mint their own unique TLD.
See: [Ontology → TLD Organisation](../core/ontology/index.md). Related: [tipo](#tipo), [ontology](#ontology), [node](#node), [hierarchy / thesaurus](#hierarchy--thesaurus).

### tool
*No SQL equivalent.*

A self-contained interface + logic for a task — either a work process (e.g. *transcription of interviews*) or an action (e.g. *propagate data between records*). Tools are registered (v7 `register.json`), permission-checked (`tool_security`/`API_ACTIONS`), and attached to nodes via the [DDO](#ddo-dd_object) `tools` array.
See: [Creating tools](../development/tools/creating_tools.md), [Introduction](../core/index.md#definitions-of-dédalos-nomenclature); skill *dedalo-tools*. Related: [service](#service), [widget](#widget), [DDO (dd_object)](#ddo-dd_object).

### translatable / lg-nolan / transliterate
*SQL equivalent: per-locale column variants / collation.*

**Translatable** data is stored per language in keyed slots (`lg-eng`, `lg-spa`, `lg-cat`…), decoupling linguistic content from structure; the [DDO](#ddo-dd_object) `translatable` flag (default `true`) marks whether a node is. Non-translatable values use the reserved [lg-nolan](#lg-nolan) slot. **Transliterate** is the orthogonal idea that a value in one language *could be transliterated* to others (handled by `tool_lang`): components expose a `transliterate_value` to signal that a translation exists.
See: [dd_object](../api/dd_object.md). The per-tipo `translatable` flag is resolved from the ontology in `src/core/ontology/resolver.ts` (`getTranslatableByTipo`, backed by node `is_translatable`), and a component model's OWN translation support is declared on its descriptor as `classSupportsTranslation` (e.g. `src/core/components/component_input_text/descriptor.ts`). Related: [lg-nolan](#lg-nolan), [value](#value), [Raspa score](#raspa-score).

### ts_object
*No SQL equivalent.*

A normalized Dédalo object representing thesaurus/ontology hierarchies — the server node builder (`src/core/ts_object/ts_object.ts`, `buildNodeData`) that turns a `ddo_map` into the JSON shape of one tree node consumed by the client tree widget. Backed by `ts_node_repository` (batched reads; `src/core/ts_object/node_repository.ts`) and `ts_term_resolver` (term cache; `src/core/ts_object/term_resolver.ts`).
See: [Thesaurus and Ontology tree](../core/thesaurus/index.md), [Introduction](../core/index.md#definitions-of-dédalos-nomenclature); skill *dedalo-ts-tree*. Related: [hierarchy / thesaurus](#hierarchy--thesaurus), [area_thesaurus](#area_thesaurus), [node](#node), [DDO (dd_object)](#ddo-dd_object).

---

## V

### value
*SQL equivalent: the stored cell value.*

The data actually stored in the database for a [component](#component) — the payload inside the [data](#data) container, distinct from its companions ([datalist](#datalist), fallbacks) and from the [context](#context) that describes it. For relation components the value is an array of [locators](#locator).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature), [component_portal](../core/components/component_portal.md), [data model](../core/data_model/index.md). Related: [value item](#value-item), [data](#data), [datum](#datum), [datalist](#datalist), [locator](#locator).

### value item
*SQL equivalent: one stored cell value plus its identity/language envelope.*

The consolidated v7 envelope every component stores inside a typed [matrix](#matrix-table) column: an **array** of `{id, lang?, value}` item objects (even mono-value fields store a one-element array). `id` is a stable, server-minted per-item identity (never recycled — the pairing key for [dataframes](#dataframe) and Time Machine); `lang` is `lg-xxx` or [`lg-nolan`](#lg-nolan); `value` is the payload (a scalar, or a structural object such as an IRI `{title, uri}` or a date datum). **Relation** components carry no `value` — their item *is* a [locator](#locator). Empty values are deliberately preserved to hold a multivalue position and keep dataframe attachments alive.
See: [Value item](../core/data_model/value_item.md), [data model](../core/data_model/index.md). Related: [value](#value), [data](#data), [locator](#locator), [dd_date](#dd_date), [dataframe](#dataframe), [lg-nolan](#lg-nolan).

### view
*SQL equivalent: none (a presentation/render template).*

The render template (final HTML/CSS) used to display an element — `default`, `line`, `mini`, `text`, `mosaic`, etc. (the `zzz` segment of `view_zzz_yyy_*` client files). Set on the [DDO](#ddo-dd_object) `view`; if unset, `default` is used. `children_view` propagates a view to a node's children.
See: [dd_object](../api/dd_object.md), [Components nomenclature](../core/components/index.md). Related: [mode](#mode-edit--list--search--tm), [DDO (dd_object)](#ddo-dd_object), [component](#component).

---

## W

### widget
*No SQL equivalent.*

A small, focused piece of code that performs a cross-cutting task — e.g. summarize some components, or collect data from sections. Lighter than a [tool](#tool), it is composed into sections/areas (examples: `media_control`, `dataframe_control`).
See: [Introduction](../core/index.md#definitions-of-dédalos-nomenclature). Related: [tool](#tool), [service](#service).

### work system vs publication system
*SQL equivalent: an editorial/staging database (PostgreSQL/JSONB) vs a published read database (classic columnar SQL).*

Dédalo's two halves. The **work system** is where curators create and edit data: PostgreSQL/JSONB [matrix](#matrix-table) tables, the ontology-driven work API ([RQO](#rqo)/[SQO](#sqo)), full history and permissions. The **publication system** ([diffusion](#diffusion)) exposes selected, finalized data to the public: the diffusion engine writes it into a classic columnar SQL database (MariaDB/MySQL by default) or file targets, and the [Publication API](../diffusion/publication_api/index.md) serves it to websites.
See: [Introduction](../core/index.md#what-is-dédalo), [The diffusion engine](../diffusion/native_engine.md). Related: [diffusion](#diffusion), [ontology](#ontology), [matrix (table)](#matrix-table).
