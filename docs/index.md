---
title: Home
---

# Dédalo v7 Documentation

!!! info "This is the manual for Dédalo v7"
    Running **v6**? Its manual is kept, unchanged, at
    [dedalo.dev/docs/v6/](https://dedalo.dev/docs/v6/). Use the version selector in the
    header to move between them.

Dédalo is a Free and Open Source Cultural Heritage Management System for archives, censuses, inventories and catalogs — archaeology, ethnology, oral memory, numismatics and more. Unlike a generic CMS, it is built to **produce good data** and publish it.

Its defining trait is an **active ontology**: the data schema, the relations between data, the components and tools, and even much of the program behavior are defined as nodes in a thesaurus-like hierarchy and resolved at execution time. Change the ontology and Dédalo's behavior changes — usually without touching the database or the code.

Dédalo is two connected systems:

- **Work system** — the private editing application (TypeScript/Bun server + JavaScript/HTML/CSS client) that manages the full catalog. Data is stored as JSONB in a PostgreSQL "matrix" table.
- **Diffusion system** — a separate, public, flat copy of the data published to SQL/RDF/XML targets and served through a public API. Data flows one way only, work → diffusion.

New to the vocabulary (section, component, tipo, locator, sqo, rqo, ddo)? Read the **[Introduction & core hub](core/index.md)** and the **[Glossary](core/glossary.md)** first.

> **Not a developer?** **[Dédalo in plain language](understanding/index.md)** explains the
> whole system — where it lives, how a record travels, what the APIs are, and what the AI
> layer does — in four diagrams and one text written for curators, archivists and
> humanities researchers. Start there, and come back here when you want the detail.

> **Where the engine came from.** Dédalo v7's server was rebuilt from scratch in TypeScript on
> the Bun runtime, replacing the engine that served the project for two decades. If you want
> the *why, what and the new foundation* — written for developers and humanities readers alike
> — read **[The v7 rewrite](rewrite.md)**. You do not need it to use, install or extend
> Dédalo: everything else in this manual documents the engine as it is today.

---

## Reading paths by role

Pick the path that matches what you are trying to do. Each is a short, ordered list — read top to bottom.

### 1. New developer — understand the architecture

1. [The v7 rewrite](rewrite.md) — where the engine came from and why it was rebuilt (background; skip it if you just want to build)
2. [Introduction (core hub)](core/index.md) — what Dédalo is, the nomenclature, the active ontology
2. [Architecture Overview](core/architecture_overview.md) — how it all fits together: two systems, the matrix data model, server build → client render
3. [Data model](core/data_model/index.md) — how a value actually lives: the JSON/JSONB foundation, the typed `matrix` columns and the consolidated v7 value item, with a page per data type
4. [Glossary](core/glossary.md) — the full nomenclature reference
5. [Ontology](core/ontology/index.md) — the active schema that drives everything
6. [Sections](core/sections/index.md) and [Components](core/components/index.md) — the table and field abstractions
7. [Development guide](development/index.md) — ecosystem, code style, commit and testing conventions

### 2. Integrator — consume the APIs

1. [Dédalo API v1 (work system)](api/dedalo_api_v1.md) — the JSON API entry point and request flow
2. [Request Query Object (RQO)](core/rqo.md) — the request structure callers send
3. [Search Query Object (SQO)](core/sqo.md) — the JSON abstraction of SQL queries
4. [DD Object (ddo)](core/dd_object.md) and [Locator](core/locator.md) — the data-pointer primitives
5. [API class reference](api/classes/dd_core_api.md) — per-class actions (core, tools, ts, utils, components, manager)
6. [The diffusion engine](diffusion/native_engine.md#client-compatibility) — the `dd_diffusion_api` publication action set served by the work API, plus [RQO field mapping](api/RQO_FIELD_MAPPING.md)
7. [Publication API](diffusion/publication_api/index.md) — serving published data to websites, integrations and AI agents. Use **[v2](diffusion/publication_api/v2/index.md)** (Bun/TypeScript: resource-oriented REST, bracketed filter DSL, RFC 9457 errors, `ETag`/`Link` caching, batch and MCP) for all new integrations; v1 is legacy
8. [RAG & semantic search](core/ai/rag.md) — the `dd_rag_api` action set (semantic search, grounded `ask`, object-image similarity) and the agent/MCP surface; the **[operational cookbook](core/ai/rag_cookbook.md)** has the request recipes
9. [AI Assistant](core/ai/assistant/index.md) — the in-app chat agent; drive it from your own code via `dd_mcp_api` (`agent_models` / `agent_chat_stream` / `agent_apply`), with the full **[SSE protocol + HTTP recipes](core/ai/assistant/cookbook.md#part-b--for-integrators)**

### 3. Core developer — extend Dédalo

1. [Development guide](development/index.md) — conventions, code style, breaking-change detection, metrics
2. [Components reference](core/components/index.md) — typologies, base classes, per-component docs
3. [Sections](core/sections/index.md) and [Areas](core/areas/index.md) — record containers and top-level groupers
4. [Data model](core/data_model/index.md) — the value-item contract under every component: typed `matrix` columns, the `{id, lang?, value|locator}` envelope, server-minted item ids, and a page per data type (string, number, date, IRI, geo, media, relations, misc)
5. [Ontology authoring](core/ontology/index.md) — defining sections, components, relations and tools as nodes
6. [Extending Dédalo](development/extending/index.md) — the ontology-first cookbooks: [add a component](development/extending/add_a_component.md), [section](development/extending/add_a_section.md), [area](development/extending/add_an_area.md), [service](development/extending/add_a_service.md), [widget](development/extending/add_a_widget.md) (+ the **[component_info widget cookbook](core/components/component_info_cookbook.md)** of copy-paste recipes)
7. [Request Config](core/request_config.md) + [examples](core/request_config_examples.md) — how data is retrieved and displayed
8. [Client side](core/client/index.md) — instances, lifecycle, render and views, data/event managers
9. [Tools](development/tools/creating_tools.md) — build a tool: [register.json](development/tools/register_json.md), [server contract](development/tools/server_contract.md), [JS lifecycle](development/tools/js_lifecycle.md), [security](development/tools/security.md), [tool catalog](development/tools/reference/index.md)
10. [Media pipeline](development/media_pipeline.md) and [Internationalization](development/internationalization.md) — the media-file lifecycle and the two translation planes
11. [Testing](development/testing.md) — the test layers run by `bun test` (unit gates, parity against the frozen fixture store, the client browser harness), the tripwires that enforce every invariant, and how to write a server test
12. [Services](development/services/index.md) and [System & infrastructure](core/system/index.md) — shared services, persistence, caching, workers

### 4. System administrator — install, configure, operate

1. [Installation](install/index.md) — **start here**: one terminal installer (`sh install.sh`) and four routes — [Production](install/production.md), [Docker](install/docker.md), [Trial](install/quickstart.md) or [Developer](install/dev_quickstart.md). Then the [installer reference](install/installer_reference.md), [the web server site](install/reverse_proxy.md), [upgrading](install/upgrading.md) and [troubleshooting](install/troubleshooting.md)
2. [Configuration](config/index.md) — the one `.env` file: [how it works](config/administration.md), [every setting](config/config.md), [database](config/config_db.md), [areas](config/administration.md#11-denying-and-hiding-areas)
3. [Media protection](config/media_protection.md) and [search config](config/search.md) — **before you expose media to the internet**: the two-rule access gate the web server enforces, and search tuning
4. [Management & maintenance](management/index.md) — environments, root user, [maintenance status](management/maintenance_status.md), [recovery mode](management/recovery_mode.md)
5. [Users, profiles & permissions](management/users_and_permissions.md) — creating users and profiles, the 0–3 permission levels, how access is computed and enforced
6. [Backup](management/backup.md) + [best practices](management/backup.md#best-practices) — protecting the data
7. [Updates](management/updates/index.md) — [updating code](management/updates/updating_code.md), [data](management/updates/updating_data.md), [ontology](management/updates/updating_ontology.md)
8. [Runtime](development/runtime_and_workers.md) — one long-lived process, per-request isolation, and what that means operationally
9. [Diffusion setup](diffusion/publication_api/index.md) — configure the publication server: [v2 deployment](diffusion/publication_api/v2/deployment.md) (`.env`, Apache/Nginx/standalone) for new servers, or the legacy v1 [public API configuration](diffusion/publication_api/public_api_configuration.md) and [server config API](diffusion/publication_api/server_config_api.md)
10. [RAG install & operations](core/ai/rag_cookbook.md) — provision the pgvector store, connect embedding/LLM sidecars, the full `DEDALO_RAG_*` config reference, and wire the index-drain cron
11. [AI Assistant — install, connect a model, configure, secure](core/ai/assistant/index.md) — turn on the in-app assistant, connect a cloud or **local/private** model, and control what may reach an external provider with the **[egress gate](core/ai/assistant/privacy_and_security.md)**

### 5. Data curator / manager — work with the data

1. [Dédalo in plain language](understanding/index.md) — the whole system without the jargon, and [the ideas behind it](understanding/the_ideas_behind_dedalo.md) for curators and humanities readers
2. [Introduction (core hub)](core/index.md) and [Glossary](core/glossary.md) — the concepts and vocabulary
3. [Areas](core/areas/index.md) and [Sections](core/sections/index.md) — how records are organised and edited
4. [Talk to your catalogue — the AI Assistant](core/ai/assistant/use_cases.md) — search by meaning, understand a record, and (with confirmation) propose edits in plain language
5. [Thesaurus & ontology tree](core/ontology/ts_object.md) — managing hierarchies, descriptors and related terms
6. [Tools user guide](tools/index.md) — the day-to-day toolbox: import, export, print, media, transcription, translation, batch edits and record history, tool by tool
7. [Importing data](core/importing_data.md) and [Exporting data](core/exporting_data.md) — the import/export model behind those tools
8. [Media pipeline](development/media_pipeline.md) — how uploaded files become masters, derivatives, thumbnails and published media
9. [Diffusion data flow](diffusion/diffusion_data_flow.md) — deciding what is published and how; [the native engine](diffusion/native_engine.md) is what runs the publish
10. [Raspa Data Quality Score](core/raspa_score.md) — assessing the quality of your catalog
11. [Backup](management/backup.md) and [installing new hierarchies](management/install_new_hierarchies.md) — day-to-day stewardship

---

## Section index

Every documentation area, with a one-line description and an entry link. The **[core hub](core/index.md)** is the central landing for everything under `core/`.

| Area | Description | Entry |
| ---- | ----------- | ----- |
| **In plain language** | The non-technical entry to the whole system: four diagrams (infrastructure, the journey of a record, the three APIs, the AI layer) plus the concepts written for curators and humanities researchers | [understanding/index.md](understanding/index.md) |
| **The rewrite** | Where the v7 engine came from, and why it was rebuilt — background, not required reading | [rewrite.md](rewrite.md) |
| **Core hub** | Introduction, nomenclature, active ontology and the index of all core documentation | [core/index.md](core/index.md) |
| Architecture overview | How the two systems, the matrix data model and the active ontology fit together | [core/architecture_overview.md](core/architecture_overview.md) |
| Data model | How a value lives: the JSONB foundation, typed `matrix` columns, the v7 value item, and a page per data type (string, number, date, IRI, geo, media, relations, misc) | [core/data_model/index.md](core/data_model/index.md) |
| Glossary | The full Dédalo nomenclature (section, component, tipo, locator, sqo, rqo, ddo, …) | [core/glossary.md](core/glossary.md) |
| Areas | Top-of-hierarchy groupers that gather sections and surface them in the menu | [core/areas/index.md](core/areas/index.md) |
| Sections | The table abstraction: a group of records of the same kind, and its view modes | [core/sections/index.md](core/sections/index.md) |
| Components | The field abstraction: typologies, base classes and the full per-component reference | [core/components/index.md](core/components/index.md) |
| Ontology | The active schema: sections, components, relations and tools defined as nodes | [core/ontology/index.md](core/ontology/index.md) |
| Thesaurus | The thesaurus hierarchy and ts_object tree model | [core/thesaurus/index.md](core/thesaurus/index.md) |
| User interface | The client render layer: page, menu, buttons, widgets, inspector, themes | [core/ui/index.md](core/ui/index.md) |
| Client | Browser runtime: instances, lifecycle, render/views, data and event managers | [core/client/index.md](core/client/index.md) |
| System & infrastructure | Persistence, APIs, caching, search, security, media engine, dd_grid, login, backup | [core/system/index.md](core/system/index.md) |
| Request Config | How sections and components retrieve and display data (+ practical examples) | [core/request_config.md](core/request_config.md) |
| RQO | Request Query Object — the API request structure | [core/rqo.md](core/rqo.md) |
| SQO | Search Query Object — the JSON abstraction of SQL queries | [core/sqo.md](core/sqo.md) |
| DD Object | Normalized object used in RQO/SQO to build and instantiate elements | [core/dd_object.md](core/dd_object.md) |
| Locator | The pointer/relation primitive between data | [core/locator.md](core/locator.md) |
| Events | The server-side event system | [core/events.md](core/events.md) |
| Importing data | CSV/RDF/Dédalo import model and per-component conform contract | [core/importing_data.md](core/importing_data.md) |
| Exporting data | The export atoms contract and flat-table export protocol | [core/exporting_data.md](core/exporting_data.md) |
| **Tools user guide** | Using every shipped tool in day-to-day work: import, export, print, media, transcription, translation, batch edits and record history | [tools/index.md](tools/index.md) |
| **AI** | The AI hub: RAG & semantic search (concept + [operational cookbook](core/ai/rag_cookbook.md)) and the in-app AI Assistant (install, connect a cloud or local/private model, egress privacy gate, use cases, HTTP/SSE integration cookbook) | [core/ai/index.md](core/ai/index.md) |
| Raspa score | The data-quality evaluation metric | [core/raspa_score.md](core/raspa_score.md) |
| Work API (v1) | The JSON API entry point, RQO format and request handling | [api/dedalo_api_v1.md](api/dedalo_api_v1.md) |
| API classes | Per-class action reference (core, tools, ts, utils, components, manager) | [api/classes/dd_core_api.md](api/classes/dd_core_api.md) |
| RQO field mapping | Field-level mapping used when issuing API requests | [api/RQO_FIELD_MAPPING.md](api/RQO_FIELD_MAPPING.md) |
| **Diffusion — the engine** | The publication engine built into the work server: plan compiler, resolver, parsers, format writers (SQL/CSV/JSON/Markdown/RDF/XML), durable job queue | [diffusion/native_engine.md](diffusion/native_engine.md) |
| Diffusion parsers | Cookbook + reference for the ontology parser functions (`properties->process->parser`): recipes with paste-ready JSON and in→out examples for all 33 fns | [diffusion/parsers.md](diffusion/parsers.md) |
| Diffusion (work side) | Deciding what gets published and how: server topologies, the diffusion ontology with worked examples, resolve levels, output formats ([Markdown](diffusion/diffusion_markdown.md)) | [diffusion/diffusion_data_flow.md](diffusion/diffusion_data_flow.md) |
| Publication API | Serving published data to the web — v2 (Bun/TypeScript, recommended) and legacy v1 | [diffusion/publication_api/index.md](diffusion/publication_api/index.md) |
| Development | Ecosystem, code style, commit/test conventions, breaking-change detection | [development/index.md](development/index.md) |
| Documentation standards | How Dédalo is documented: the code doc-block standard and the prose [style guide](development/documentation_style_guide.md) | [development/code_documentation_standard.md](development/code_documentation_standard.md) |
| Extending Dédalo | The ontology-first cookbooks: add a component, section, area, service or widget | [development/extending/index.md](development/extending/index.md) |
| Testing | The `bun test` layers (unit gates, parity against the frozen fixture store, client browser harness) and the tripwires | [development/testing.md](development/testing.md) |
| Media pipeline | The end-to-end media-file lifecycle: upload → master → derivatives → publication | [development/media_pipeline.md](development/media_pipeline.md) |
| Internationalization | The two translation planes (data vs interface) and the language model | [development/internationalization.md](development/internationalization.md) |
| Tools (developer) | Building tools and the full per-tool developer reference | [development/tools/reference/index.md](development/tools/reference/index.md) |
| Services | Shared services (e.g. upload) used by components, sections and tools | [development/services/index.md](development/services/index.md) |
| Runtime | One long-lived process, per-request isolation, and the operational consequences | [development/runtime_and_workers.md](development/runtime_and_workers.md) |
| Metrics | The performance metrics subsystem and per-request monitor | [development/metrics.md](development/metrics.md) |
| Media components | Embedding Dédalo media components in third-party code | [development/using_media_components.md](development/using_media_components.md) |
| CSS architecture | The LESS-based design system and styling structure | [core/ui/css_architecture.md](core/ui/css_architecture.md) |
| Installation | The terminal installer and its routes (production, Docker, trial, developer), the installer reference, the web server site, upgrading and troubleshooting | [install/index.md](install/index.md) |
| Configuration | The one config file (`../private/.env`): settings, database, areas, media/search tuning | [config/index.md](config/index.md) |
| Management | Environments, root user, maintenance status, recovery, hierarchies, updates | [management/index.md](management/index.md) |
| Users & permissions | Users, profiles, the 0–3 permission levels and how access is enforced | [management/users_and_permissions.md](management/users_and_permissions.md) |
| Backup | Backup procedure and best practices | [management/backup.md](management/backup.md) |
| Updates | Updating code, data and ontology safely | [management/updates/index.md](management/updates/index.md) |
| Change log | Release history and notable changes | [change_log.md](change_log.md) |

---

## Upgrading from Dédalo v6

These two pages exist only for operators who already run a **v6** install and are moving it to
v7. They are the one place the previous engine's configuration files are named — because those
files are the *input* you are converting. If you are installing Dédalo for the first time, you
do not need them: go to [Installation](install/index.md).

| Page | What |
| ---- | ---- |
| [Migrating a v6 install to v7](install/migrating_from_v6.md) | **The one migration manual**: transform the data on v6, move the database and the media, convert the config, migrate the passwords, first v7 boot, and what to do when the data is wrong |
| [What changed in v7](config/whats_changed_v7.md) | The v6 → v7 settings map: renamed, reshaped and removed |
