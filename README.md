<img height="200" src="https://dedalo.dev/tpl/assets/img/logos/logo_dedalo.svg" alt="Dédalo logo" />

# Dédalo v7 — TypeScript / Bun

Dédalo is a knowledge management system for tangible and intangible Cultural Heritage, Natural Heritage, and Oral History and Memory. It is Free and Open Source software built on an **active ontology** model.

[Official Dédalo webpage](https://dedalo.dev) · [Demo](https://demo.dedalo.dev/)

---

## What is Dédalo?

Most catalog software hard-codes its data model: a programmer decides there is a "People" table with a "surname" column, and changing that means changing code. Dédalo does the opposite. Every section (a kind of record), every field, every relation, menu, tool and button is a **node in the ontology**, resolved while the program runs. Reshape the catalog (add a field, turn a text box into a picker, define a new kind of record) and you do it by *editing definitions*, not by asking a programmer to alter tables.

Dédalo uses the structured ontology to:

1. **Make the data structured** — user data is stored without a fixed schema, in JSONB format.
2. **Build programming objects at runtime** — components, sections, and tools are constructed from ontology definitions during execution.
3. **Interpret and translate data** — to multiple formats: RDF, JSON-LD, SQL, CSV, XML, Dublin Core, HTML, PDF, and more.

The ontology can be modified at any time, subsequently changing both the data and the code. You can develop new functionalities without changing the data, and alter the metadata independently of the code and the data.

### Two connected systems

Dédalo is **two connected systems**, and the analogy is a museum:

- **The work system** — the private *workshop* where curators create, relate and refine records. This is the core of the application.
- **The diffusion system** — the public *gallery*, a flattened, published copy of the data served to websites and portals. Data flows one way only: workshop → gallery.

The work system (main application) stores all data in **PostgreSQL** in a compact set of "matrix" tables as JSONB.
The diffusion system stores public resolved data in **SQL, RDF, XML, etc.**

### Key capabilities

- **Multilingual** — any language for the user interface and managed data, with a multi-thesaurus engine.
- **Multi-resource** — manages multiple resolutions for video, image, PDF, notation scores, etc.
- **Geo-reference** — points, areas, and paths for cultural properties and interviews.
- **Video handling** — real-time video cutting for thematic fragments; 4K, 1080p, 720p, and 404p supported.
- **Time Machine** — the full editable history of every record, with uncertainty and qualifiers.
- **Universal locator** — a relative, multi-reference locator that can find entities, sections, components, and tags.

---

## Why TypeScript? The rewrite from PHP

Dédalo has been cataloguing cultural heritage and memory for more than two decades, coins and hoards, oral histories, archaeological records, etnological records, thesauri, censuses. Software that carries data like that has an unusual duty: it has to *outlive its own technology*. The collections will still matter in thirty years; the code that holds them has to be alive, understandable, and trustworthy for just as long.

The Dédalo server has been **rebuilt from scratch in TypeScript on the [Bun](https://bun.sh) runtime**, replacing the PHP server that served the project for years. This is not a line-by-line translation, it is a **re-expression** of a deeply understood system in a better medium.

### The reasons

**1. The old runtime model fought us.** PHP handles one request at a time and then forgets everything, a clean slate per click. That's simple, but it left performance on the table (work that could happen in parallel happened in sequence), and the workarounds needed to make it fast will introduce a whole category of subtle, hard-to-catch bugs.

**2. More than two decades leave sediment.** A long-lived system accumulates *scar tissue*, two ways to do the same thing because a migration was never finished, deprecated-but-still-load-bearing vocabulary, mechanisms layered on mechanisms. A rewrite is a rare chance to keep the good foundation and let the sediment go.

**3. The system is finally understood well enough to re-express.** After twenty seven years, Dédalo's concepts are clear and documented. This is not inventing a new system, it is re-expressing a well-understood one in a better medium.

**4. Durability and stewardship.** For a cultural-heritage platform maintained by a small team, the single greatest long-term risk isn't any line of code, it's whether *a second person* can learn the system and keep it alive. A modern, typed, modular, well-documented foundation is a direct investment in that: it lowers the barrier for the next contributor, human or AI.

**5. AI changes the perspective.** The introduction of AI-assisted tools in the Digital Humanities, within the field of Cultural Heritage and Memory, represents an incredible new paradigm. AI will help curators, researchers, technicians and other professionals to carry out tasks that were previously impossible. AI tools written in PHP are not as powerful as those written in TypeScript, so this rewrite will facilitate the integration of these tools.

### What does NOT change

The rewrite is built around hard guarantees:

- **Your data is untouched.** Same PostgreSQL database, same records, same per-field JSON shapes — read and written byte-compatibly. Nothing migrates; nothing is reshaped.
- **The ontology is the same.** Sections, components, thesauri and relations are the same living definitions.
- **Multilingual, versioning and provenance stay.** Every-value-in-every-language, the Time Machine, uncertainty and qualifiers — all preserved exactly.
- **The way you work is the same.** The screens, editing forms, and visual design are copied over unchanged. The rewrite replaces what happens on the *server*; the client is deliberately left as-is.
- **The meaning of the API is preserved.** Integrations that speak Dédalo's request model keep working conceptually; only the low-level wire details are modernized.

The mental image: **replacing the engine of a well-loved vehicle** without changing how you drive it, where your cargo sits, or the road you travel.

### What changes: the engine under the hood

- **A persistent, concurrent runtime with per-request isolation.** A single long-lived Bun process behind Apache or Nginx. Every request runs inside its own request-scoped context (`AsyncLocalStorage`), structurally eliminating cross-request state-bleed. Real concurrency — resolving independent parts of a record in parallel, streaming large results — makes the API measurably faster.
- **Components as descriptions, not class hierarchies.** In PHP, each of the ~38 component types was a class in a deep inheritance tree. Now a component model is a small, declarative descriptor — one named home per model — that shared "horizontal" engines read and configure.
- **Types as the contract.** TypeScript and `zod` schemas at the boundary make request and search formats self-documenting and self-validating.
- **A brand-new, native authentication.** Argon2id password hashing, rotating server-side sessions, fixation resistance, brute-force throttling — meeting or exceeding every security guarantee of the original.
- **AI as a first-class citizen.** Clean, typed service boundaries and structured action schemas mean the system can safely expose its ontology-typed data and actions to AI tools, respecting exactly the same permissions as a human.

> The full story of the rewrite is in [`docs/rewrite.md`](docs/rewrite.md).

---

## Who uses Dédalo?

Some projects that use Dédalo to manage their Cultural Heritage and/or Oral Archive:

- [Freie Universität Berlin](http://www.occupation-memories.org/de/archive/index.html)
- [Moneda Ibérica catalog](https://monedaiberica.org)
- [Museu de Prehistòria de València](http://mupreva.org/home/?q=en)
- [Memorial Democràtic](https://banc.memoria.gencat.cat/en/)
- [Mujer y Memoria](https://www.mujerymemoria.org) — Woman and Memory: Mothers and daughters of the Spanish transition
- [Arxiu de la Memòria Històrica de Paiporta](http://memoriahistorica.paiporta.es)
- [Nuestra Memoria](http://memoriahistorica.dival.es/recursos/archivo-memoria-historica/) — Archivo de historia oral
- [Lur Azpian / Bajo tierra](https://exhumacionestempranas.navarra.es) — Early exhumations in Navarra
- [Museu de la Paraula](http://www.museudelaparaula.es) — Archivo de la Memoria Oral Valenciana
- [Collection of funds from MUVAET](http://www.museudelaparaula.es/colecciones/?lang=es) — Museu Valencià d'Etnologia

---

## Dependencies

### Runtime

- [Bun](https://bun.sh) 1.4.4+
- [PostgreSQL](https://www.postgresql.org) 18.1+
- Apache 2.4.6+ or Nginx (reverse proxy in front of the Bun process)
- MySQL / MariaDB (optional — only for the diffusion publication target)

### OS-level libraries

- **FFmpeg** 5.0+ (with FFprobe 2.6.1+ and `qt-faststart`)
- **ImageMagick** 6.9+
- [Xpdf command line tools](https://www.xpdfreader.com/download.html) 4.00.01+

### Client-side libraries

Dédalo's client uses: leaflet, geoman, d3, nvd3, svgCanvas, pdfjs, pdfkit, ckeditor 5+, and others. These are bundled with the client source.

---

## Quick start

```sh
bun install
bun run dev       # server on the unix socket / port configured in ../private/.env
```

For testing:

```sh
bun test                    # unit + parity tests
bun test test/unit/...      # targeted unit gates
bun test test/parity/...    # parity tests (replays frozen fixtures, no oracle, no creds)
bun run test:client         # client suite; starts its own server on the suite DB
                             # (bun run test:db:setup builds that DB)
bunx tsc --noEmit           # typecheck (zero-NEW-errors rule)
bun run lint                # biome
```

### Installation

For full installation instructions, see the [installation guide](https://dedalo.dev/docs/v7/install/).

The TS server reads its configuration from `../private/.env` (a sibling directory, *not* the PHP tree's private dir). Every key is declared once in **`src/config/catalog/`**, which GENERATES the copy-paste census `install/sample.env` and the [settings reference](docs/config/config.md); the installer drops a copy of the census at `../private/sample.env`. Regenerate with `bun run config:gen` — `config_docs_tripwire` fails if you forget.

Install with the terminal installer — `./install.sh` (or `bun run dedalo:install` in a checkout); it asks every question in the terminal. A server started before it ran refuses to start (exit 78, "not installed"). Once installed:

1. Log in and head to the Development Area.
2. Update the Ontology and register all tools.
3. Create an admin user.
4. Log out and log in with the admin user.
5. Create Users and Projects as needed.

---

## Architecture in one breath

Ontology-driven: `dd_ontology` defines everything; `src/core/ontology/resolver.ts` is the cached accessor layer. Reads flow RQO → `core/api/dispatch.ts` → `section/read.ts` (context + data) with relations expanding through `core/relations/registry.ts`. Component models are declarative descriptors (`core/components/`). Writes go through `section/record/save_component.ts` (tx-wrapped, TM-audited) + `db/matrix_write.ts` / `json_codec.ts`. Diffusion is native under `src/diffusion/`. Request identity (lang, principal) is ALS-scoped — never captured at module level.

### Core concepts (the 8-word glossary)

| Concept | One-liner |
|---|---|
| **Ontology** | Every menu/area/section/component/tool/button is defined by an ontology node (`tipo` + `model` + `properties`). The app is generated from it. |
| **RQO** | Request Query Object — the client's API request: `action` + `source` + `sqo` + `show/search/choose` ddo_maps. |
| **SQO** | Search Query Object — pure-data, Mango-style query that compiles to SQL over the JSONB matrix tables. |
| **Locator** | Universal relation pointer: `{section_tipo, section_id, ...}`. Relation components store arrays of these. |
| **ddo / ddo_map** | Data-description objects; a flat list that becomes a resolution tree via each ddo's `parent` property. |
| **request_config** | How a relation component resolves its targets: v6 = explicit `show/search/choose/hide` + SQO in ontology properties; v5 = legacy implicit graph walk. |
| **Context vs Data** | Context = cached ontology-derived structure (stamped per call); Data = lazy instance values from the matrix. Every data element has both. |
| **Subdatum** | Recursive expansion of a parent's locators into resolved child `{context, data}` through the ddo_map hierarchy. |

---

## Project structure

```
master_dedalo/
├── src/
│   ├── server.ts              # Entry point — the Bun HTTP server
│   ├── config/                # Typed config catalog, env reading (readEnv/envSnapshot)
│   ├── core/
│   │   ├── api/               # Request dispatch (RQO → handler)
│   │   ├── ontology/          # Cached ontology resolver
│   │   ├── components/        # Declarative component descriptors (one home per model)
│   │   ├── section/           # Section reads, records, list definitions, locks
│   │   ├── search/            # SQO → SQL over JSONB matrix tables
│   │   ├── db/                # Postgres connection, matrix write, JSON codec (PHP byte-compat)
│   │   ├── relations/         # Relation registry and expansion
│   │   ├── security/          # Auth (Argon2id, sessions, throttling)
│   │   ├── resolve/           # Resolution pipeline
│   │   ├── ts_object/         # Thesaurus tree
│   │   ├── tools/             # Tool subsystem
│   │   ├── media/             # Media processing
│   │   └── ...
│   ├── diffusion/             # Native diffusion (workshop → gallery publishing)
│   ├── external/              # External record services (Zenon connector)
│   └── ai/                    # RAG / semantic search, AI tool protocol
├── client/                    # TS-owned primary client source (vanilla JS)
├── test/
│   ├── unit/                  # TS-native unit gates (*_native.test.ts)
│   └── parity/                # Frozen-fixture parity tests (no oracle, no creds)
├── tools/                     # Dédalo tools (tool_export, tool_print, etc.)
├── engineering/               # Specs + contracts: REWRITE_SPEC, wire_contract/, TRIPWIRES, CI, etc.
├── docs/                      # Documentation (incl. rewrite.md)
├── scripts/                   # Install, migration, verification scripts
└── install/                   # Install subsystem
```

---

## Documentation

| Doc | What |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents — hard rules, commands, docs index (`CLAUDE.md` is a symlink to it) |
| [`docs/rewrite.md`](docs/rewrite.md) | The full story of the PHP → TypeScript rewrite |
| [`engineering/REWRITE_SPEC.md`](engineering/REWRITE_SPEC.md) | Master spec: constraints, security, architecture |
| [`engineering/TRIPWIRES.md`](engineering/TRIPWIRES.md) | The tripwire index — every enforced invariant and the gate that proves it |
| [`engineering/wire_contract/`](engineering/wire_contract/) | Ledgered wire-shape divergences from PHP — one file per entry; [`WIRE_CONTRACT.md`](engineering/WIRE_CONTRACT.md) is its rules + id grammar |
| [`engineering/CONVENTIONS.md`](engineering/CONVENTIONS.md) | Error-handling/logging convention + dynamic-import rules |
| [`engineering/DIFFUSION_SPEC.md`](engineering/DIFFUSION_SPEC.md) | Native diffusion subsystem spec |
| [`engineering/RELATIONS_SPEC.md`](engineering/RELATIONS_SPEC.md) | Relations family spec |
| [`engineering/SECTION_SPEC.md`](engineering/SECTION_SPEC.md) | Section family spec |
| [`engineering/ORACLE_HARVEST.md`](engineering/ORACLE_HARVEST.md) | The frozen parity fixture store: how it replays, why it can't be re-harvested |
| [`engineering/CI.md`](engineering/CI.md) | CI/CD pipeline map, hermetic vs self-hosted tiers |
| [`engineering/PRODUCTION.md`](engineering/PRODUCTION.md) | Ops: supervision, socket, backups, health |

---

## Server system compatibility

The backend is tested on:

- Ubuntu Server 26.04 LTS / 24.04 LTS
- Debian 12.0+
- macOS 26.0+

Any other Linux will probably be compatible, but without guarantees. Windows: not tested.

### Compatible browsers

Dédalo v7+ is tested in Chromium and WebKit browsers.

| Browser | Version | Compatible |
|---|---|---|
| Chrome | 140+ | Yes — recommended |
| Safari | 26+ | Yes |
| Firefox | 115+ | Yes |
| Edge | 150+ | Yes |
| Internet Explorer | All | No |

---

## License

Dédalo is Free and Open Source software. See [`License.md`](License.md) for details.

---

## The PHP reference

The original PHP server (`v7_php_frozen/master_dedalo/`) is preserved as a **read-only historical reference**. It is decommissioned, unmaintained dead code. The TypeScript server in this repository is the single engine and sole writer. The PHP tree exists only to document the system's heritage and to serve as a reference for the contracts that were re-expressed.

> The engine is changing. The mission — *produce good data, and keep it safe* — is exactly the same.
