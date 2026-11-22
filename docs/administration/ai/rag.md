# RAG and semantic search

> See also: **[RAG install, connect, configure & cookbook](rag_cookbook.md)** (the hands-on operational guide) · **[AI Assistant](assistant/index.md)** (the in-app chat agent that consumes this layer) · [Architecture overview](../../core/architecture_overview.md) · [Search Query Object (SQO)](../../api/sqo.md) · [Exporting data](../../using/exporting_data.md) · [Glossary](../../understanding/glossary.md) · [Ontology](../../core/ontology/index.md)

This document has **two readers in mind** and is written for both:

- **Researchers in the humanities** — historians, archaeologists, anthropologists, art historians, archivists, oral-memory researchers — who want to understand *what* semantic search and RAG bring to their work, *why* it matters for cultural heritage and memory, and *how* it changes the questions they can ask of their data. **Parts I–IV** are for you; no programming required.
- **Developers** — who need to enable, use, operate and extend the subsystem. **Parts V–VI** are for you, with the API, the pipeline internals, configuration and tests. The subsystem code lives in `src/ai/rag/` (retrieval + generation), `src/ai/agent/` (the tool-use loop), and `src/ai/mcp/` (the Model Context Protocol server) — a **greenfield TypeScript/Bun build** (see [Part V](#part-v--for-developers) for the ledger).

If you read only one paragraph: Dédalo already stores cultural-heritage data as **meaningful, structured records** (sections and components governed by the ontology). RAG adds a **semantic layer** on top of that structure — a "vector version" of selected data — so the archive can be searched and questioned by **meaning**, not only by exact words. It does not replace the data model; it amplifies it.

---

# Part I — Why vectorize Cultural Heritage and Memory

## The problem: our archives know more than our searches can find

Imagine an oral-history archive with ten thousand interviews about life in a rural valley. A researcher wants every testimony that touches on **displacement caused by the building of a reservoir**. She types "reservoir" into the search box. She gets the interviews where someone literally said *reservoir* — and misses the ones where people said *the dam*, *when the water came*, *they flooded our houses*, *el pantano*, *quan ens van fer marxar*. The knowledge is in the archive. The search cannot reach it, because classic search matches **strings**, not **meaning**.

This is the everyday condition of cultural-heritage data. It is:

- **Multilingual and historical** — the same idea appears in Spanish, Català, English, in archaic spellings, in dialect, in the vocabulary of a particular decade or trade.
- **Paraphrastic** — humans describe the same object, event or idea in endlessly different words. An archaeologist's "glazed earthenware vessel with cobalt decoration" is a curator's "blue-and-white majolica jar" is a donor's "old blue pot".
- **Fragmented across collections** — a person named in an interview, an object in a catalog, a photograph, a thesis chapter, and a place in a gazetteer may all speak about the same thing, in different sections, never linked.

Classic keyword search, and even Dédalo's powerful structured search (the [SQO](../../api/sqo.md)), are precise and essential — but they answer the question *"where does this string / this exact value appear?"*. They cannot answer *"what is **about** this idea?"*.

## What RAG and semantic search actually are (in plain terms)

**Semantic search** finds records by **conceptual similarity**. Instead of comparing letters, it compares *meanings*. Ask for "displacement caused by a dam" and it surfaces the testimony that says "when the water came and we had to leave" — because those phrases *mean* almost the same thing, even though they share no words.

How is meaning compared by a machine? Through **embeddings** (also called **vectors**). An embedding model reads a piece of text — **or an image** — and turns it into a long list of numbers — a point in a high-dimensional "**meaning space**". The crucial property: **things that mean similar things land near each other** in that space, and things that mean different things land far apart. "Dam" and "reservoir" sit close; "dam" and "wedding" sit far; two photographs of the *same kind of coin* sit close even when nothing textual links them. Searching becomes **geometry**: embed the question (or the object's image), then find the nearest records.

> **A useful mental image.** Think of a vast library where books are not shelved alphabetically but **by subject affinity** — every book physically placed so that books about similar ideas are neighbours, across every language and phrasing. To research a topic you walk to its region and everything relevant is within arm's reach, regardless of the exact words on the spine. Embeddings build that library automatically; semantic search is walking to the right shelf.

**RAG — Retrieval-Augmented Generation** — adds a second step. After *retrieving* the most relevant passages by meaning, it can hand them to a language model to *generate* a grounded answer **with citations back to the source records**. The model does not answer from its own memory of the internet; it answers **from your archive**, quoting your records. Retrieval keeps generation honest.

```mermaid
flowchart LR
    Q["Researcher's question<br/>'testimonies about being displaced by the dam'"] --> E["Embed the question<br/>(turn meaning into a vector)"]
    E --> R["Retrieve nearest passages<br/>by meaning, across languages"]
    R --> A["Answer grounded in those passages<br/>+ citations to the exact records"]
    R --> L["(or) a ranked list of records<br/>for the researcher to read"]
```

## Why the *semantics* of heritage data matter

The [introduction](../../core/index.md) to this documentation states the Dédalo conviction plainly: *cultural-heritage data is information about ourselves, at the same level of importance as health or defense*. If the data is that important, then **being able to ask it the questions that matter** is equally important.

Cultural heritage is, at bottom, about **meaning** — what an object signified, what a witness understood, how a practice was lived. A data model that only matches exact strings captures the *letter* of the record but not its *sense*. Vectorizing heritage data is a way of giving the archive a memory that works the way human memory works: by **association and resemblance**, not only by exact recall.

This matters for memory in a deep way. Oral memory especially is **paraphrase all the way down** — no two people describe the same event identically, and the historical value often lives precisely in the *variation*. A semantic layer lets that variation become **findable** instead of being lost between non-matching keywords.

## How this changes research

| Without semantics (string search) | With semantics (RAG / vector search) |
| --- | --- |
| You must already know the words used in the record. | You describe the **idea**; the system finds the words. |
| Each language searched separately. | One question retrieves matches **across languages** (cross-lingual). |
| Synonyms, dialect, archaic spelling are missed. | Conceptually equivalent phrasings are found together. |
| Connections across collections are manual. | "Find records **similar to this one**" surfaces hidden links. |
| Answering a question = reading many records by hand. | A grounded, **cited** synthesis points you to the exact passages. |
| Exploratory questions ("what themes recur about X?") are hard. | Thematic and comparative exploration becomes a first-class operation. |

The point is **not** to replace the researcher's reading and judgment — it is to **remove the wall** between a well-posed question and the relevant evidence, so that the scholar spends time interpreting rather than hunting.

---

# Part II — Definitions (a short glossary)

These terms recur throughout. They are written for the non-specialist; developers will find precise mechanics in Part V.

| Term | Definition |
| --- | --- |
| **Embedding / vector** | A list of numbers representing the *meaning* of a piece of text (or media). Produced by an "embedding model". Similar meanings → nearby vectors. |
| **Embedding model** | The neural model that converts text into an embedding. Dédalo's default text model is **multilingual** so non-English heritage text is handled well. A separate **multimodal** model (a joint image+text encoder) embeds object images into a space shared with text, enabling text→image search. |
| **Multimodal / joint encoder** | An image+text model (CLIP/SigLIP-style) whose image and text "towers" share one space, so an image can be compared to another image *and* to a textual description. Used for object similarity and text→image search. |
| **Semantic / vector space** | The high-dimensional space the vectors live in. "Distance" in this space approximates *difference in meaning*. |
| **Distance (cosine)** | How meaning-similarity is measured. Small distance = similar meaning. Dédalo uses **cosine** distance. |
| **Chunk** | A coherent passage a long text is split into before embedding. Each chunk is one retrievable unit (e.g. a paragraph, a timecoded segment of a transcription). |
| **Semantic chunking** | Splitting text at **topic boundaries** (detected from meaning) and along document structure (headings, tables, pages), so each chunk is one coherent idea — not an arbitrary cut. |
| **Retrieval** | Finding the most relevant chunks for a query by vector (and lexical) similarity. |
| **Generation** | Producing a natural-language answer from retrieved passages, using a language model (LLM). |
| **RAG** | **R**etrieval-**A**ugmented **G**eneration: retrieve first, then generate grounded in what was retrieved. |
| **Grounding** | The discipline of answering **only** from retrieved sources. If nothing relevant is found, the system **refuses** rather than inventing. |
| **Hallucination** | When a language model states something plausible but unsupported. RAG mitigates it by grounding answers in real records and **refusing** when there is no evidence. |
| **Citation** | A pointer from a sentence in the answer back to the exact source record/passage it came from — so claims are verifiable. |
| **Hybrid search** | Combining **semantic** (vector) retrieval with **lexical** (keyword) retrieval, so exact terms — names, inventory numbers, signatures — are not lost. |
| **Reranking** | A second, more precise scoring pass over the top candidates to improve ordering. |
| **pgvector** | The PostgreSQL extension that stores vectors and searches them efficiently. Dédalo's vector store is a dedicated PostgreSQL + pgvector database. |
| **ACL** | Access-Control List — Dédalo's per-project permissions. RAG **never** returns a record a user may not see. |

---

# Part III — RAG in Dédalo: what, why, how

## What it is, concretely

Dédalo's RAG subsystem maintains a **vector version of selected data** — only the components an archive explicitly opts in — in a **separate, dedicated PostgreSQL + pgvector database**. It vectorizes both **text** (with a multilingual text model) and **object images** (with a joint image+text model). On top of it sit five capabilities, all exposed through one API (`dd_rag_api`):

1. **Semantic search** — find records by meaning.
2. **Q&A / chat** — grounded answers over the collection, with citations.
3. **Object image similarity & characterization** — find visually similar objects (coins, ceramics, …) and **propose attributes** (typology, period, material) aggregated from their cataloged neighbours.
4. **Agent / MCP context** — retrieval-backed passages an external AI agent can ground its reasoning on.
5. **External public semantic API** — semantic access over *published* data for third parties (a separate, later phase).

## Why it fits Dédalo so naturally

Everything in Dédalo is already **meaningful by construction**. A value is never a loose string in a spreadsheet cell; it is a component, governed by the ontology, with a model, a language, relations and context (see the [architecture overview](../../core/architecture_overview.md) and [data model](../../core/data_model/index.md)). That is exactly the substrate semantic search wants:

- **The ontology decides what gets vectorized.** Vectorization is *opt-in per section*, declared as named **embed groups** in the section's `section_map` node (each group a request_config `ddo_map` naming the components — including deep-resolved relations — that form one vector document). The same ontology mechanism that already drives the section's Term roles, diffusion, search and rendering. No bespoke tables, no parallel schema (the [Dédalo way](../../core/index.md)).
- **The text is already clean.** Dédalo can already produce a clean, flat textual value for any component through the export-atoms contract (`get_value()` / `get_export_value()` — see [exporting data](../../using/exporting_data.md)). RAG reuses it, so a relation component's linked labels, a thesaurus term's hierarchy, or a transcription's text all flow in without new extraction code.
- **Security is already per-record.** Dédalo's project ACL governs who sees what. RAG enforces the **same** ACL on every retrieved passage, so the semantic layer can never leak a record a user could not otherwise open.

## How it improves the Dédalo data model

RAG does not change the matrix, the sections or the components. It **adds a complementary index of meaning** beside the structured store:

```mermaid
flowchart TB
    subgraph Work["Dédalo work system (unchanged)"]
        M["matrix (PostgreSQL/JSONB)<br/>sections · components · ontology · relations · ACL"]
    end
    subgraph Sem["Semantic layer (new, opt-in)"]
        V["pgvector store<br/>chunks · embeddings · provenance"]
    end
    M -- "on save: extract → chunk → embed selected components" --> V
    Q["question / query"] --> V
    V -- "ranked locators (record keys)" --> M
    M -- "hydrate with full data + ACL" --> Out["results / grounded answer"]
```

The two databases are **bridged by a list of record locators**, never by a SQL join. A vector search produces *which records* are relevant; the **main Dédalo search then hydrates them with full data and enforces ACL**. This gives the best of both worlds:

- The **structured model remains the single source of truth** — vectors are a derived, rebuildable index.
- The **semantic layer is additive and reversible** — you can enable it for one section, rebuild it, or drop it, without touching heritage data.
- **Meaning becomes a queryable dimension** of the archive, alongside the exact, relational queries the SQO already provides. The two compose: *"records semantically about coastal trade **and** dated before 1500 **and** in project X"*.

In short, RAG turns Dédalo's already-excellent **data model** into an also-excellent **knowledge-retrieval model**, without compromising either.

## Multilingual and cross-lingual by design

Heritage collections are overwhelmingly non-English, often with historical orthography and dialect. Dédalo's default embedding model is **multilingual**, and — importantly — the system **does not silo searches by language**. A question in English can retrieve a testimony in Spanish, because in a multilingual embedding space the *meaning* sits in the same place regardless of the language it was written in. For a discipline where the same event is documented in several languages, this is transformative.

## Security, ethics and "do no harm"

Cultural-heritage and memory data can be sensitive: protected sites, culturally restricted knowledge, personal testimony, donor embargoes. The subsystem treats this as a first-class concern:

- **Per-record ACL on every retrieval.** A passage is returned only if the requesting user may access its record — checked explicitly, before any score or count leaves the server, for *every* action (search, retrieve, agent context, and chat).
- **Egress control.** If an embedding or language model is an *external* third-party service, restricted records are **never** sent to it — they are processed only by a local model, or skipped. This is enforced at **index time** (before any text leaves) and again at **answer time**.
- **Grounding and refusal.** The chat assistant answers **only** from retrieved, permitted passages and **refuses** when it has no grounded context — it does not improvise.
- **The archive stays in control.** Vectorization is opt-in per section facet (embed groups); an institution decides exactly which combination of fields enters each vector, per section — including per *virtual* section.

---

# Part IV — Use cases (worked examples)

These scenarios show the *kind* of question that becomes possible. They are written from the researcher's side; the developer's request/response forms are in Part V.

### 1. Identifying an object from a description

An archaeologist excavates a sherd and wants to know whether anything like it is already cataloged. She describes it in her own words:

> *"a glazed earthenware fragment with cobalt-blue floral motifs on a white tin glaze, probably tableware"*

Semantic search returns cataloged objects described — by different curators, in different decades, in different languages — as *"blue-and-white majolica plate"*, *"loza azul de reflejo"*, *"fajalauza"*. None share the searcher's exact words; all share her *meaning*. A keyword search would have required her to already guess the catalog's vocabulary. **The system bridges her description and the catalog's terminology.**

### 2. Searching oral-history documentation by theme

An anthropologist studying environmental memory asks:

> *"What did informants say about losing farmland when the valley was flooded?"*

The system retrieves **timecoded passages** from interview transcriptions where people speak of *the dam*, *when the water rose*, *we had to leave the fields*, *el pantano se lo llevó todo* — and each result deep-links to the **exact moment in the audio/video** (via the transcription's timecodes). She can jump straight to the testimony, in the informant's own voice. Months of listening become an afternoon of focused study.

### 3. Connecting fragments across collections

A historian is reading a thesis chapter (a long full-text document in a `component_text_area`) about a guild of silversmiths. With **"find records similar to this passage"**, the system surfaces: people records of named artisans, a numismatic catalog entry mentioning a related mint mark, a photograph's caption, and an archival document — scattered across different sections, never explicitly linked, but **conceptually adjacent**. The semantic layer reveals a web of relationships the manual cataloging never recorded.

### 4. A grounded research assistant with citations

A curator preparing an exhibition asks the chat assistant:

> *"Summarize what the collection documents about coastal trade in the 15th century."*

The assistant retrieves the relevant permitted passages, synthesizes a short answer, and **cites each claim** back to the specific records and passages it used — including the exact page of a document or the exact timecode of an interview. If the collection holds nothing on the topic, it says so plainly rather than inventing. The curator gets a starting map **and** the evidence to verify every statement.

### 5. Grounding an external AI agent (MCP)

A research tool or an AI agent (via [MCP](../../core/system/index.md)) needs trustworthy context about the collection. It calls `get_agent_context` and receives **permission-filtered passages** to ground its own reasoning — so the agent's output is anchored in the institution's real, access-controlled data, not in the model's general training.

### 6. Comparative and exploratory research

Because meaning is now a queryable dimension, new *shapes* of question become routine: *"which testimonies resemble this one?"*, *"what themes recur across these 300 interviews?"*, *"show me objects conceptually between these two."* Vectorization makes the archive **explorable by resemblance**, which is how humanistic inquiry often actually proceeds.

### 7. Cataloguing a coin from its images (typology proposal)

A numismatist registers a newly-found coin and uploads its **obverse** and **reverse** photographs. The moment it is saved, the images are vectorized. The system finds the cataloged coins whose obverse *and* reverse are visually closest — an object that matches on **both faces** ranks above one that matches on only one — and then **proposes a typology** by a similarity-weighted vote of those neighbours, showing the exact coins it relied on (with thumbnails) and a confidence. The numismatist confirms or overrides. The machine did the finding; the scholar keeps the judgment. *(This is "describe the object by its relatives" — a proposal grounded in real cataloged objects, never a generative guess.)*

### 8. Dating an object from its image

An excavation yields an object with no clear context. The researcher asks the collection to **estimate its period from its image**: the system retrieves the visually-(and metadata-)nearest objects and aggregates *their* recorded dates into a proposed **time-frame** — an earliest…latest range with a most-likely central estimate — again citing the objects that support it. It is a hypothesis to test, with its evidence attached, not an oracle's verdict.

### 9. "The same in the collection" / finding relatives

"Show me objects close to this one" returns the visually nearest pieces across the collection; raising the similarity threshold turns it into **near-duplicate detection** — the same object photographed twice, the same coin die, a re-used image — invaluable for deduplication, for spotting parallels, and for assembling a typological series. Because object similarity blends the image with the catalog **context** (material, typology, period), it does not confuse a bronze coin with a bronze button: the meaning of the object, not only its pixels, drives the match.

> **Why the context matters (and is ontology-defined).** What counts as an object's "context" is not universal — a coin's typology and a ceramic's fabric are different fields. So each section declares, **in the ontology**, which images carry the visual signal (and which face they show) and which components are the typology / period / material. Archaeology, numismatics and oral history each describe their material on their own terms, and the system respects that.

---

# Part V — For developers

**RAG, the agent loop, and MCP are a greenfield TypeScript/Bun build** — these
three subsystems never existed as a shipped subsystem before, so they are
designed fresh on top of the stable typed core. Two pieces of pure algorithm
math (the RRF fusion formula and the structural/semantic chunking pipeline)
were validated for confidence against an earlier internal prototype's frozen
test vectors (two dedicated cross-check test files under `test/unit/`) — but
the surrounding architecture (database choice, API wiring, ACL enforcement,
egress policy, the ingestion queue, the agent/MCP layer) is original TS
design from the ground up.

The code lives in three trees:

- **`src/ai/rag/`** — the vector store, chunker, embedding providers, hybrid retrieval, `ask()` grounded Q&A, and the object-image similarity/characterization stack.
- **`src/ai/agent/`** — a manual tool-use loop (`loop.ts`) over the same ACL-gated handlers MCP exposes, plus RAG semantic search, driven by a pluggable `AgentLlmProvider` (`llm_provider.ts`). The concrete provider is resolved from the model catalog (`model_catalog.ts`, `resolveProvider`, `DEDALO_AGENT_MODELS`): the official Anthropic SDK (`anthropic_provider.ts`) or an OpenAI-compatible provider for local models (`openai_compat_provider.ts`) in production, or a scripted/deterministic provider in tests.
- **`src/ai/mcp/`** — a Model Context Protocol server (`server.ts`, `@modelcontextprotocol/sdk`) exposing the same read (and, opt-in, write) handlers (`tools.ts`) to any MCP-speaking client.

It is registered in the API dispatch as the `dd_rag_api` action class (`src/core/api/dispatch.ts` → `ragApiActions` from `src/ai/rag/api.ts`) and is **strictly opt-in**: every action declines with `rag.disabled` unless `DEDALO_RAG_ENABLED` is `'true'`/`'1'` (`isRagEnabled()`, `src/ai/rag/rag_enabled.ts`) — with ONE deliberate exception, `embed_groups`, the capability probe the client fires unasked on every list render, which ANSWERS `{groups: []}` when RAG is off so an install that never implemented RAG shows its users nothing at all (the operator is told once, at boot); the three image actions additionally decline with `rag.media_disabled` unless `DEDALO_RAG_MEDIA_ENABLED` is set (`isMediaEnabled()`, `src/ai/rag/multimodal_config.ts`).

## Architecture at a glance

[![The RAG subsystem: a save enqueues a dirty marker, the indexer resolves each embed group into a document, chunks and embeds it into the pgvector store, and retrieval fuses a dense and a lexical leg before the ACL gate, feeding the grounded ask pipeline](../../assets/images/diagrams/rag_system.svg)](../../assets/images/diagrams/rag_system.svg)

*Click the diagram to open it full size.*


```mermaid
flowchart TB
    save["save_event.ts save/delete hook<br/>(registerRagRecordHook)"] -->|"enqueue marker (best-effort)"| Q[("rag_index_queue<br/>(matrix DB, dedalo7_mib)")]
    Q -->|cli/rag_drain.ts, advisory-lock single-flight| IDX["RagIndexer<br/>(indexer.ts)"]
    IDX -->|"resolveEmbedDocs: group ddo_maps via emitDdoData<br/>(system scope, READ-ONLY)"| EX["embed_source.ts"]
    IDX -->|structure-aware chunking per group| CH["chunker.ts"]
    IDX -->|embed changed chunks only| EP["EmbeddingProvider<br/>(deterministic hash / sidecar)"]
    IDX -->|atomic upsertEmbeddingRows| VS[("dedalo7_rag pgvector store<br/>rag_embeddings, per-model partitions")]
    API["dd_rag_api (ragApiActions)"] --> RET["retrieval.ts"]
    RET -->|denseSearch: pgvector cosine ANN| VS
    RET -->|lexicalSearch: Postgres FTS + f_unaccent| VS
    RET -->|"fuse: RRF (fusion.ts) → aclGate"| ACL["getPermissions (schema) +<br/>buildSearchSql filter_by_locators (per-record)"]
    RET -->|records or passages| API
    API -->|"ask: runAsk (ask.ts)"| LLM["LlmProvider<br/>(HttpLlmProvider / StubLlmProvider)"]
```

Two Postgres databases, bridged by a **locator/passage list**, never a join: the matrix (`dedalo7_mib`, wherever `config.db` points) holds the dirty-marker queue and is the ACL source of truth; a **separate** database (`dedalo7_rag` by default, overridable via `DEDALO_RAG_DB_NAME`/`RAG_DB_NAME`, reusing the matrix host/user/password from `config.db`) holds only vectors and is fully rebuildable. **ACL is enforced explicitly inside `retrieval.ts`'s `aclGate`/`aclFilterCandidates`** — never inside the store — as a two-step check per candidate: (1) schema ACL — `getPermissions(principal, sectionTipo, componentTipo) >= 1` for per-component chunks (the image path), and `getPermissions(principal, sectionTipo, sectionTipo)` (section-level read) for `rag:<group>` facet chunks, whose document composes several components; (2) per-record projects ACL, a principal-scoped existence probe built with `buildSearchSql({ filter_by_locators: […] })`, so a hit a non-admin's project scope excludes is dropped **before** any score or count leaves the server (never an existence oracle).

> **Gap.** The `rag_embeddings` parent table and its `rag_create_model_partition(model, dimension)` SQL function (which provisions each model's typed column, HNSW index, and the `unaccent`/`f_unaccent` lexical index) are **not self-provisioning** in this tree — unlike the matrix-side queue table, which `ensureRagQueueTable()` creates on demand, the `dedalo7_rag` schema must already exist before the store, indexer, or tests can run against it. Provisioning is a one-off out-of-band step, applied from the DDL vendored at `install/db/rag_embeddings.sql` (idempotent; `bun run test:db:setup` applies the same file when it builds the suite's own vector database, so the two cannot drift).

## Enabling RAG

1. **Provision the vector store.** A *separate* PostgreSQL with the `vector` extension, database name `dedalo7_rag` by default (`DEDALO_RAG_DB_NAME` / `RAG_DB_NAME` in `../private/.env` override the name; host/user/password are the same matrix credentials, `config.db`). Provision the `rag_embeddings` parent table and its `rag_create_model_partition()` function with `psql -d dedalo7_rag -f install/db/rag_embeddings.sql` — see the gap noted above.
2. **Choose an embedding provider.** The default, zero-config provider is `DeterministicHashProvider` — a deterministic, offline bag-of-words hasher (`src/ai/rag/embedding_provider.ts`) that makes the whole index→retrieve pipeline testable with no network and no keys, but is **not a semantic model**. For real semantic retrieval, set `DEDALO_RAG_EMBEDDING_PROVIDER=sidecar` plus `DEDALO_RAG_EMBEDDING_ENDPOINT` (and optionally `DEDALO_RAG_EMBEDDING_MODEL`, default `bge-m3`) to point at an HTTP embedding sidecar speaking `POST {endpoint}/embed {model, input:[…]} → {embeddings:[…]}`.
3. **Opt records in, via the section's `section_map` `rag` scope** (2026-07-22 — the *embed groups* descriptor, resolved by `RagConfig.getEmbedGroups`, `src/ai/rag/config.ts`; the earlier per-node boolean flags are **retired**). A section's `section_map` ontology node — the section's global "how to interpret me" contract, already used for its Term/parent roles — gains a `rag` key whose `embed` is an **array of named groups**, each an exact request_config `ddo_map`:
   - **A group = one vector document per (record, data-lang)**, stored under `component_tipo = 'rag:<id>'`. Groups are the *facet* unit: a person section can declare separate `profession` and `filiation` groups (independent vectors, so a profession query is not diluted by filiation text), and a 100 KB transcription gets its own group with its own chunking.
   - **Selection is per (virtual) section, not per shared component.** `getSectionMap` is virtual-aware (a virtual section's own `section_map` node wins, else the real section's via `relations[0].tipo`), so two virtual siblings sharing components can embed *different* combinations — impossible under the old component-node flag, which also indexed **zero text** for virtual sections (the selection walk was not virtual-aware).
   - **Deep resolution is inherited, not bespoke**: each group's `ddo_map` is resolved through the SAME `emitDdoData` machinery as the human section read (`src/ai/rag/embed_source.ts`), so a relation entry (a mint) resolves to its target's term text — and explicit child ddos reach arbitrary depth, exactly as in `request_config`.
   - **Record coherence**: every group always embeds its FULL definition under the system index-time scope (`RAG_SYSTEM_PRINCIPAL` + explicit per-doc data lang — guarded by `rag_index_scope_tripwire`), regardless of which user's save triggered the re-index. Retrieval gates `rag:` chunks at the **record** level (section read permission + per-record projects ACL): the record is the access unit for semantic search.
4. **Switch it on:** `DEDALO_RAG_ENABLED = true`. This both lets `dd_rag_api` actions run and registers the save/delete hook (`initRagHooks()`, `src/ai/rag/bootstrap.ts`, called once from `startServer()`) that enqueues a dirty marker into `rag_index_queue` on every write.
5. **Backfill and drain** — see *Operations* below.
6. **(Optional) object images** — declare `properties.rag.context` on the **section node** (images + views, and the typology/period/material components — see below; the image layer still reads the node's `properties`, not the section_map), stand up the multimodal sidecar (`DEDALO_RAG_MULTIMODAL_*`), and set `DEDALO_RAG_MEDIA_ENABLED = true`. **Gap:** only the *retrieval* side of the image layer is built; there is no automated ingestion path yet that reads a record's images off disk and embeds them into the store (see *Image similarity & object characterization* below).

Example `section_map` `properties.rag` for a publication section (a card facet plus a full-text facet):

```json
{
    "rag": {
        "embed": [
            { "id": "card",
              "ddo_map": [
                  { "tipo": "rsc140", "section_tipo": "self" },
                  { "tipo": "rsc221", "section_tipo": "self" },
                  { "tipo": "rsc138", "section_tipo": "self" },
                  { "tipo": "dd812", "section_tipo": "dd810", "parent": "rsc138" }
              ] },
            { "id": "fulltext",
              "ddo_map": [ { "tipo": "rsc210", "section_tipo": "self" } ],
              "mode": "long_document",
              "chunk": { "max_tokens": 450, "min_tokens": 120 } }
        ],
        "strategy": "structural_semantic",
        "system_prompt": "Answer as a publications archivist."
    }
}
```

The `dd812` entry is the deep case: `rsc138` is a relation, and its child ddo resolves `dd812` **in the target section** `dd810` — the target's text lands in the host record's `card` document (its origin is recorded in `chunk_meta.contributors`, which the `ask` egress gate also checks so a forbidden section's text can never egress through a host record). Retrieval takes an optional `group` option to scope any search to one facet.

## The API (`dd_rag_api`)

Registered in the static action registry (`src/core/api/dispatch.ts` → `ragApiActions`), so login/CSRF/session gating is inherited from the same dispatch chokepoint every other API class goes through. Every action reads `rqo.options` and returns the standard envelope v2 success — `{ status: 200, body: { ok: true, request_id, msg, data } }`, the payload in `data` and the RAG outcome token `msg` riding as an extension key; a refusal is a coded THROW, never an `ok:true` body. Each handler resolves the caller's `Principal` first (`resolveCaller`) and declines with `auth.not_logged` if there is none; every action declines with `rag.disabled` (`disabled()`) unless `DEDALO_RAG_ENABLED` is on — except `embed_groups`, which answers `{groups: []}` instead (see below).

**Actions:** `semantic_search`, `retrieve`, `get_agent_context`, `similar_to`, `ask`, `embed_groups` (a section's embed-group ids — the client's facet selector and semantic-availability gate; empty for RAG-off/malformed/denied/not-opted-in alike, never an existence oracle and never a red alert on an install without RAG), and (images, additionally gated by `DEDALO_RAG_MEDIA_ENABLED`) `similar_objects`, `search_by_text_image`, `characterize_object`.

**Who may spend, and how much.** Every action that calls a model is metered against the caller's **daily AI limits** (a per-user, per-UTC-day ledger in the *AI usage* section under Administration, `dd660`; `src/core/security/ai_spend.ts`) after its request is validated and before the model is touched: one query embedding for `semantic_search`, `retrieve`, `get_agent_context` and `search_by_text_image`; one model run, its token reservation (the context budget plus the output cap) and one query embedding for `ask`. A used-up budget is `429 ai.budget_exhausted`, with the budget's kind, its limit and when it resets; a ledger that cannot be used refuses `503 ai.budget_unavailable` (never an unmetered spend). `ask` is a **generated answer** and additionally needs the [`tool_rag`](../../development/tools/reference/tool_rag.md) grant (`403 tool.not_authorized` without it, before anything is read); a grounding miss refunds its run. `similar_to`, `similar_objects` and `characterize_object` reuse stored vectors, call no model and spend nothing; `embed_groups` is the capability probe. The limits are data on the caller's user and profile records (the *AI usage* group: user value, else profile value, else 0, each kind on its own — [AI spend limits](assistant/configuration.md#ai-spend-limits)); nobody is exempt.

A `limit` is clamped to `[1, 50]`, default `10` (`clampTopK`, `MAX_TOP_K = 50`). An optional `section_tipo` scope accepts a single string or an array of strings (`optionScope`) — pushed down into both store legs (recall) AND re-applied at the ACL gate, never a substitute for it. An optional `group` (slug) narrows to one embed facet's chunks. The CLIENT search UI consumes `semantic_search` through the resolve-once-then-pin flow: ranked hits become `sqo.filter_by_locators` pins plus the `{mode:'locator_position'}` order entry, so the normal section list renders them in relevance order (WC-047).

**Semantic search** — text → ranked records (`RagSearchHit[]`, from `semanticSearch()`, `src/ai/rag/retrieval.ts`):

```json
// request
{
    "dd_api": "dd_rag_api",
    "action": "semantic_search",
    "options": {
        "query": "displacement caused by the building of the reservoir",
        "section_tipo": ["oh1"],
        "limit": 8
    }
}
```
```json
// response.body.data (record-level, ACL-filtered, best-first)
[
    { "section_tipo": "oh1", "section_id": 412, "component_tipo": "oh23", "lang": "lg-spa",
      "snippet": "…cuando llegó el agua tuvimos que marcharnos…", "score": 0.031 }
]
```

`retrieve` and `get_agent_context` call the same hybrid pipeline (`retrievePassages()`) but return **passages** (chunks, not collapsed to records) — each hit is a `RagSearchHit` plus `chunk_index`, for chat/agent grounding.

**Ask** — grounded answer with citations (`runAsk()`, `src/ai/rag/ask.ts`):

```json
// request
{ "dd_api": "dd_rag_api", "action": "ask",
  "options": { "query": "What do informants say about losing farmland to the dam?",
               "section_tipo": ["oh1"] } }
```
```json
// response.body.data
{
    "answer": "Several informants describe being forced to leave when the reservoir flooded their fields…",
    "citations": [ { "locator": "oh1-412", "sectionTipo": "oh1", "sectionId": 412, "citedText": "…" } ],
    "provenance": [ { "section_tipo": "oh1", "section_id": 412, "component_tipo": "oh23", "lang": "lg-spa",
                      "chunk_index": 3, "text": "…cuando llegó el agua tuvimos que marcharnos…", "score": 0.031 } ],
    "grounded": true,
    "used_provider": "stub",
    "model": "stub-llm"
}
```

If no permitted, relevant context is found, `runAsk` returns `refusalResult()` — `grounded: false`, `citations: []`, `provenance: []`, `used_provider: ''` — and **makes no model call**; the envelope's `msg` becomes `no_grounded_context` instead of `ok`. A thrown transport/protocol error from the `LlmProvider` maps to a `generation_failed` envelope (never a fabricated answer). The answer is returned as **raw text in JSON** (transport-safe); the client escapes it at render.

There is a fourth outcome, the **egress-gated refusal** (`RESTRICTED_MSG = 'external_generation_restricted'`, `restrictedResult()`): at least one grounding passage is a restricted-egress record (a forbidden host or contributing section, or external generation globally off) and no local non-egressing provider is wired, so `runAsk` **makes no external model call** and returns `grounded: false`, `restricted: true`, `citations: []`. Unlike the grounding refusal it **keeps `provenance`** — the withheld sources — so the caller can show what was suppressed rather than pretending nothing matched. The `restricted?` field on `AskResult` flags this reason.

`similar_to` takes `{ section_tipo, section_id, group? }` and returns nearest-neighbour records (the seed excluded), reusing the seed's *already-stored* vectors — it never re-embeds the seed. With `group`, both the seed's vectors and the neighbours narrow to that facet ("similar by profession").

## Ingestion pipeline (text)

The save/delete hook (`registerRagRecordHook`, wired by `initRagHooks()`) enqueues a dirty marker (best-effort — swallows every error; a down vector store can never fail a save). The drain CLI (`bun run src/ai/rag/cli/rag_drain.ts`, or `RagQueue.drain()` directly) processes markers out-of-band, single-flighted by a Postgres advisory lock (`pg_try_advisory_lock`) so it's safe to run from cron on every worker:

- **Resolution** (`embed_source.ts`, `resolveEmbedDocs`) — reads the matrix record ONCE, then resolves each embed group's `ddo_map` through the read path's own `emitDdoData` (deep relation resolution included) into one composite document per `(group, data-lang)`, entries joined in map order under `## {component label}` headers, values flattened to plain text (`htmlToPlainText`). Every resolution runs inside the SYSTEM index-time scope — `RAG_SYSTEM_PRINCIPAL` + the explicit per-doc data lang (`runWithRequestContext`/`runWithRequestLangs`, guarded by `rag_index_scope_tripwire`) — so the document never depends on who saved. **Mode rule**: an explicit ddo `mode` is honored verbatim; an absent one defaults literal→`edit` (full value — `list` would apply the 130-char text_area list-preview truncation) and relation→`list` (compact target-term resolution). A lang-sensitive group (any translatable or relation entry) resolves once per configured data lang; a lang-independent one only in `DEDALO_DATA_NOLAN`. Empty documents prune their stored chunks on the next drain; each document records its `contributors` (component + target section tipos) into `chunk_meta`.
- **Chunking** (`chunker.ts`, `chunk()`) — **structure-aware semantic chunking**:
  1. **Structural hard boundaries** — `[h1]`…`[h6]` heading lines, blank-line paragraphs, page markers `[page-n-N]`, and transcription turns `[TC_HH:MM:SS(.mmm)_TC]`; a chunk never crosses one. Text and timecoded-transcription inputs are auto-detected (`detectMode`) or set explicitly (`mode: 'short'|'transcription'|'long_document'`).
  2. **Semantic soft boundaries** — with an injected sentence embedder, adjacent sentences are compared and split where cosine distance exceeds a percentile threshold (default the 92nd, `breakpointThreshold`); with no embedder this degrades cleanly to structural-only. **The production indexer currently injects none** (the seam is synchronous; wiring the async sidecar needs a chunker refactor), so deployed chunking today is structural boundaries + sentence-aligned packing.
  3. **Pack + orphan absorption** — segments are packed toward `maxTokens` (default 450) with a `minTokens` floor (default 120); a trailing chunk below the floor merges back into its predecessor.
  4. **Contextual enrichment** — `"{document title} › {heading path}\n{raw text}"` is embedded; the clean `raw text` alone is stored for citation.
  5. **Small-to-big** — each chunk carries a `parentKey` (its structural section's hash, or an `av:{mediaTipo}` key for a transcription) for a future parent-expansion step (not yet wired into `ask()` — see the ledgered simplification below).
  A `sourceHash = sha256(CHUNKER_VERSION '|' embedText)` versions the algorithm: bumping `CHUNKER_VERSION` forces every chunk to re-embed.
- **Indexing** (`indexer.ts`, `RagIndexer.indexRecordText`) — chunks each group document under the group's `chunk`/`mode`/`strategy` config and stores rows under `component_tipo = 'rag:<group>'`; diffs each chunk's hash against the stored `source_hash` (`diffHashes`) so unchanged chunks never re-embed — editing one group's source re-embeds only that group; embeds only the changed ones (soft-fails to a retryable `false` on any read/embed/store error, never throwing); flushes the changed rows plus stale-tail pruning **atomically** (`upsertEmbeddingRows` / `deleteStale`) — embedding happens *outside* the transaction, the write is atomic. An **orphan sweep** prunes stored `(component_tipo, lang)` pairs the current descriptor no longer produces, so renamed/removed groups and dropped languages self-heal on the next index.
- **Storage** (`vector_store.ts`) — `rag_embeddings` in the separate `dedalo7_rag` database, **partitioned by model** (`ensureModelPartitionTyped` / `rag_create_model_partition`, one typed `vector(N)` column + HNSW cosine index per partition — see the provisioning gap above).

**Ledgered simplification.** `ask()`'s small-to-big parent expansion is not implemented: the dense/lexical retrieval legs don't currently project `parentKey` back out, so expanding a hit to its parent section would be a no-op. Add it when the retrieval legs surface `parentKey`.

## Retrieval pipeline

`retrieval.ts` runs the hybrid search and gates every hit before it can leave the server:

1. **Hybrid candidates** (`hybridCandidates`) — dense ANN (`denseSearch`, pgvector cosine distance) and lexical full-text (`lexicalSearch`, Postgres `to_tsvector('simple', f_unaccent(…))` — accent-folded so *pantano* and *pantáno* both match) run in parallel, each over-fetching `max(limit*4, 20)` candidates, then merge via **Reciprocal Rank Fusion** (`fuse()`, `fusion.ts`, `k=60`, one map keyed on the chunk identity). An optional `group` narrows both legs to one facet's chunks (`component_tipo = 'rag:'+group`). Hybrid catches proper nouns, inventory numbers and archival signatures pure-vector retrieval misses.
2. **Rerank** — a `Reranker` seam (`reranker.ts`) sits between fusion and the token-budget fit in the `ask()` path; the shipped `PassThroughReranker` returns the fused order unchanged (contract: reorder only, never drop/add). No cross-encoder is wired yet.
3. **Explicit ACL** (`aclGate`, module-header chokepoint of `retrieval.ts`) — for every candidate, in order: (1) schema ACL — per-component for image-path chunks; for a `rag:<group>` facet chunk, **per contributing component** — the group document is composed at index time under the system principal, so it embeds the text of every component in the group's ddo_map, and the gate requires `getPermissions(principal, sectionTipo, componentTipo) ≥ 1` for the section read grant AND for every host-section component recorded in `chunk_meta.contributors` (drop on any level 0; an empty contributor set fails closed). This is the exact parity of the human read's per-component gate, so a role that holds level 0 on a component never matches its text through a group chunk. Memoised per key; (2) per-record projects ACL, a principal-scoped existence probe (`buildSearchSql` with `filter_by_locators`), memoised per `(sectionTipo, sectionId)` — **before** any score or count is returned, for every action (never an existence oracle).
4. **Shape** — `semantic_search`/`similar_to` collapse the gated candidates to the best-scored chunk per record (`collapseToRecords`); `retrieve`/`get_agent_context`/`ask` keep every gated passage (`retrievePassages`).

## Generation (`ask`)

`ask()`'s `LlmProvider` seam (`llm_provider.ts`) is pluggable via `DEDALO_RAG_LLM_ENDPOINT`: when set, `HttpLlmProvider` posts an OpenAI-compatible chat-completions request (works against any local TEI/vLLM/llama.cpp endpoint or a hosted OpenAI-compatible API, model/timeout/temperature from `DEDALO_RAG_LLM_*`); when unset, the deterministic `StubLlmProvider` answers with a templated, self-citing echo of the retrieved passages — so `ask()` is fully exercisable offline with no model running. (This is a **different** provider seam from the agent loop's Anthropic integration below — `ask()` does not currently have an Anthropic-native adapter.) The pipeline (`runAsk`, load-bearing order): retrieve (ACL enforced inside) → grounding gate (no passages ⇒ refuse, no model call) → rerank (pass-through) → `fitTokenBudget` (keeps ≥1 passage even over budget) → a **live** egress decision recomputed per record from current config (`buildEgressPolicy`: a `DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS` section, or `DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT` being off, forces `'restricted'`; the policy also accepts an optional per-record `publishable()` callback, not currently wired by `dd_rag_api`, so today the decision is **global**, not yet keyed off each record's actual diffusion-publish status) → generate. The system prompt resolves the section_map `rag.system_prompt` first, then the section node's `properties.rag.system_prompt` (legacy home), then `DEDALO_RAG_LLM_SYSTEM_PROMPT`, then a safe built-in default (`buildSystemPromptResolver`).

## Image similarity & object characterization

For object collections (coins, amphorae, ceramics, …) the **retrieval** side of an image layer is built: `ObjectRetrieval` (`object_retrieval.ts`) and `RagCharacterizer` (`characterizer.ts`) answer object-centric questions over image vectors already present in the store (`modality: 'image'` rows). A section opts in through `properties.rag.context` (`RagConfig.getContext`), which declares — **in the ontology, per section** (archaeology ≠ oral history) — which image components carry the visual signal (and their `view`, e.g. obverse/reverse), and which components are the *typology / period / material*:

```json
{ "rag": { "context": {
    "images":   [ { "tipo": "numd5", "view": "obverse" }, { "tipo": "numd6", "view": "reverse" } ],
    "metadata": { "typology": "numd10", "period": "numd20", "material": "numd30" },
    "compare_scope": ["numisdata4"]
  } } }
```

Capabilities (all ACL-filtered via `aclFilterCandidates`; each result carries a `thumb_url` built when it is read from the thumbnail path stored with the neighbour's vector (`chunk_meta.thumb_path`) on the current media web address, so a changed `DEDALO_MEDIA_WEB_BASE` is followed without re-indexing. A vector indexed before this storage carries no `thumb_path` and shows no thumbnail until its record is indexed again — the image staleness key changed with it, so that pass re-embeds it; see *Backfill* under Operations):

- **`similar_objects`** (`findSimilarObjects`) — "objects close to this one". Reads the seed's *stored* image vectors (no re-embedding) and finds the visually nearest others. A multi-image object (a coin's obverse + reverse) **fuses the per-view result lists** with RRF, so an object close on *both* faces ranks above one close on a single face. `mode: 'hybrid'` (default) adds a lexical leg over the stored context summary (the seed's own `source_text`) — essential for heritage, where pure visual similarity confuses a bronze coin with a bronze button; `mode: 'visual'` skips it. A `near_duplicate: true` request floors results at `DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY` (default `0.93`).
- **`search_by_text_image`** (`searchByTextImage`) — a textual description → matching object images, encoded through the multimodal model's **text tower** (`embedTextForImageSearch` — never the plain text `EmbeddingProvider`, which lives in an unrelated vector space).
- **`characterize_object`** (`RagCharacterizer.characterize`) — the "describe the object by its relatives" capability, **with no LLM involved**: retrieve the nearest neighbours (`findSimilarObjects`) then, for each declared metadata role, read every neighbour's value **through that neighbour's own** `properties.rag.context.metadata` mapping (`RoleReader`, `role_reader.ts`) and aggregate: a **similarity-weighted vote** over categorical roles (typology/material — `aggregateCategorical`, winner = highest-weight value, confidence = its share) or an **earliest…latest range + weighted-central estimate** for a date role (period — `summarizeDates`, confidence = `1 - midpoint-spread/span`). Each proposal carries a **confidence and cited evidence** (top-8-by-weight supporting neighbours, with thumbnails). No generative guess: a coin's typology is *proposed from real cataloged coins*, verifiably.

The multimodal provider seam (`multimodal_embedding_provider.ts`) mirrors the text one: `SidecarMultimodalProvider` speaks `POST {endpoint}/image {model, images:[base64,…]}` / `POST {endpoint}/text {model, input:[…]}` → `{embeddings:[…]}` (falls back to tolerating an OpenAI-style `{data:[{embedding}]}` shape) when `DEDALO_RAG_MULTIMODAL_ENDPOINT` is set; otherwise a deterministic, network-free `DeterministicMultimodalProvider` keeps the image pipeline exercisable offline. `isExternal()` reports non-`'local'` providers, and that is what the **egress gate** keys off: `buildMultimodalProvider` refuses to construct an external provider unless `DEDALO_RAG_IMAGE_EGRESS_POLICY` is `allow_external` — the institution's own switch, closed by default, so object images cannot leave the host through an oversight in a settings file. It refuses loudly rather than falling back to the deterministic provider, which would keep indexing and write meaningless vectors under a real model's name.

**Gap — no image ingestion pipeline yet.** `RagIndexer` (`indexer.ts`) only extracts and embeds **text**; its own header notes "*The IMAGE/multimodal path is a later brick and is not built here*". There is no code that reads a record's declared context images off disk, downsizes/embeds them, and writes `modality: 'image'` rows on save — `embedImage()` is exercised only by `test/unit/rag_multimodal.test.ts`. `similar_objects`/`search_by_text_image`/`characterize_object` are real, ACL-gated, and tested against hand-inserted vectors, but a deployment cannot yet catalog a new coin's photographs into the store through an ordinary save the way it can for text.

## Agent loop & MCP

Two more surfaces expose the same ACL-gated core to an LLM, sharing the read/write handlers in `src/ai/mcp/tools.ts` — a section/record the configured user cannot see is invisible to either:

- **MCP server** (`src/ai/mcp/server.ts`, `@modelcontextprotocol/sdk`, stdio transport) — a **thin transport shell** with no business logic of its own: `buildMcpServer(principal, { allowWrite })` exposes the full shared `TOOL_REGISTRY` (`src/ai/mcp/registry.ts`) under its gates — the read tools always on, the write tools only when `DEDALO_MCP_ALLOW_WRITE=true`. Reads: `dedalo_search_records`, `dedalo_count_records`, `dedalo_search_section`, `dedalo_read_record`, `dedalo_describe_node`, `dedalo_list_sections`, `dedalo_describe_section`, `dedalo_resolve`, `dedalo_resolve_path`, `dedalo_get_media_info`. Writes: `dedalo_save_component`, `dedalo_create_record`, `dedalo_delete_record`, `dedalo_set_field`, `dedalo_portal_link`, `dedalo_portal_unlink`, `dedalo_find_or_create`, `dedalo_duplicate_record`, `dedalo_upload_media`. The **principal is resolved once at startup** from `DEDALO_MCP_USER_ID` (a `dd128` user `section_id`, or `-1` for the superuser in trusted local dev) and is fixed for the process lifetime — there is no tool to change identity, and a missing/invalid id is a hard startup error (fail-closed, never a silent privileged fallback). Every write tool re-checks `getPermissions(...) >= 2` server-side and goes through the same `saveComponentData`/`createSectionRecord`/`deleteSectionRecord` engines (and Time Machine audit) the human save/create/delete actions use — an LLM acting through MCP can never write where its configured user could not through the web client.
- **Agent loop** (`src/ai/agent/loop.ts`, `runAgent()`) — a manual tool-use loop (capped at 12 turns, `MAX_ITERATIONS`) over the **same** shared registry handlers MCP exposes plus RAG's `semanticSearch()`/`retrievePassages()`, each tool call executed under the caller's `Principal` so a failed/denied call becomes an `is_error` tool result the model can adapt to rather than a privilege escalation. Its tool surface (`AGENT_TOOLS`) is the full MCP read registry (`registeredTools()`) plus RAG's `dedalo_semantic_search` and `dedalo_retrieve_passages`, and is provider-neutral (`AgentLlmProvider`, `agent/llm_provider.ts`): production wires the official `@anthropic-ai/sdk` (`AnthropicProvider`, model `claude-opus-4-8` by default, override via `AGENT_MODEL`) and **fails closed** — constructing it without `ANTHROPIC_API_KEY` throws, so the agent can never silently run keyless; the offline test gate (`agent_loop.test.ts`) drives the loop with a deterministic scripted provider instead, asserting the **same** scripted trajectory returns real data for an authorized principal and nothing for a denied one.

Both are read-only by default and additive on top of `dd_rag_api` — the MCP/agent tools do not bypass or duplicate the human API's dispatch, they call straight into the same engines it does.

## Operations

- **Drain (required).** Wire the CLI to cron — without it, markers never index:
  ```cron
  * * * * * cd /path/to/dedalo-ts && bun run src/ai/rag/cli/rag_drain.ts >> /var/log/dedalo/rag_drain.log 2>&1
  ```
  It no-ops cleanly (logs and exits 0) when `DEDALO_RAG_ENABLED` is off; it is safe to overlap (single-flighted by `pg_try_advisory_lock`, key `918273645`). A failing record backs off exponentially (`2^attempts` minutes, capped at 30) and is dropped after `DrainOptions.maxAttempts` (default 5).
- **Backfill.** No dedicated CLI yet — drive `RagIndexer.indexRecordText(locator)` (`buildRagIndexer()`) over a section's ids directly, or enqueue them via `RagQueue.enqueue()` and let the drain process them.
- **Monitoring.** `RagQueue.stats()` reports `{ pending, ready, blocked, failed, oldestAgeSec }` over `rag_index_queue`.
- **Reconcile.** `RagIndexer.reconcileSection(sectionTipo, matrixIds, enqueue)` diffs matrix-side ids against `listSectionIds()` (the vector store's distinct `section_id`s) and enqueues `index`/`delete` corrections for the drift — the matrix id source and the enqueue callback are both injected, so this is wired per-caller rather than a standalone CLI.

## Extending

- **Embedding provider** — implement the `EmbeddingProvider` interface (`embedding_provider.ts`: `name`, `model`, `dimension`, `embed(texts)`); `getEmbeddingProvider()` resolves `DeterministicHashProvider` by default or `SidecarEmbeddingProvider` when `DEDALO_RAG_EMBEDDING_PROVIDER=sidecar`. Dimension is **discovered** from the response, never hard-coded.
- **Reranker** — implement `Reranker.rerank(query, passages)` (`reranker.ts`) and wire it in place of `PassThroughReranker` in `askAction` (`api.ts`); no cross-encoder ships yet, and there is no `DEDALO_RAG_RERANK_ENDPOINT` config surface in this tree.
- **System prompt** — global `DEDALO_RAG_LLM_SYSTEM_PROMPT` or per-section section_map `rag.system_prompt` (node `properties.rag.system_prompt` as legacy fallback; `buildSystemPromptResolver`).

## Configuration & tests

Every `DEDALO_RAG_*` (and the shared `APPLICATION_LANGS`/`DEDALO_DATA_NOLAN`/`ANTHROPIC_API_KEY`/`AGENT_MODEL`/`DEDALO_MCP_*`) setting is read directly via `readEnv()` at the point of use (`src/config/env.ts`: real process env, then `../private/.env`). The **image layer's** keys are also declared in the config catalog (`src/config/catalog/ai.ts`), which is what puts them in `install/sample.env` and in the generated settings reference (`docs/administration/configuration/config.md`), and what makes the config census fail if one is added without an operator-facing entry; the ask/LLM keys are not declared there yet, so each of those modules' header comments is still the only place they are described. The full set actually referenced: `DEDALO_RAG_ENABLED`, `DEDALO_RAG_DB_NAME`/`RAG_DB_NAME`, `DEDALO_RAG_EMBEDDING_PROVIDER`/`_ENDPOINT`/`_MODEL`, `DEDALO_RAG_CONTEXT_TOKEN_BUDGET`, `DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT`, `DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS`, `DEDALO_RAG_LLM_ENDPOINT`/`_MODEL`/`_API_KEY`/`_TEMPERATURE`/`_TIMEOUT`/`_MAX_OUTPUT_TOKENS`/`_SYSTEM_PROMPT`, `DEDALO_RAG_MEDIA_ENABLED`, `DEDALO_RAG_MULTIMODAL_PROVIDER`/`_MODEL`/`_ENDPOINT`/`_API_KEY`, `DEDALO_RAG_IMAGE_EGRESS_POLICY`, `DEDALO_RAG_IMAGE_MAX_PX`/`_HYBRID`, `DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY`, `DEDALO_RAG_CHARACTERIZE_TOP_K`.

Tests live under `test/unit/` and run with `bun test`:

```bash
bun test test/unit/rag_chunker.test.ts \
  test/unit/rag_fusion.test.ts \
  test/unit/rag_config.test.ts test/unit/rag_indexer.test.ts test/unit/rag_queue.test.ts \
  test/unit/rag_ask.test.ts test/unit/rag_api.test.ts test/unit/rag_multimodal.test.ts \
  test/unit/mcp_tools.test.ts test/unit/mcp_write_tools.test.ts test/unit/agent_loop.test.ts
```

Pure-logic tests (chunker structure/semantic boundaries, RRF fusion, config resolution, the `ask` grounding/refusal/egress gates, the multimodal joint-space math) run fully offline with no keys or network. Two further cross-check test files pin the chunking and RRF math against a frozen historical set of numeric test vectors, for algorithmic confidence — everything else in the doc above is fresh TS design. `test/unit/rag_store.test.ts`, `rag_queue_integration.test.ts`, and `rag_pipeline.test.ts` run end-to-end against real databases — but never an installation's: the suite runs on the matrix suite database and, since P1-16 (2026-08-30), on its OWN vector database `<suite db>_rag`, which `test/preload/rag_db.ts` provisions and repoints to unconditionally via `DEDALO_TEST_RAG_DB_NAME`, and which every vector WRITE door refuses unless it carries the `dedalo_test_rag_marker` row (a disposable model/section per run, cleaned up in `afterAll`) — the DoD assertion in `rag_pipeline.test.ts` is that a denied principal gets nothing back from the same query a superuser gets real hits from. `mcp_tools.test.ts`/`mcp_write_tools.test.ts` assert the MCP handlers apply the exact same ACL/permission gates as the human API; `agent_loop.test.ts` drives the same scripted trajectory through a denied and an authorized principal and asserts the difference.

**Testing it end-to-end (as a user).** With `DEDALO_RAG_ENABLED=true` and the default deterministic providers, no external services are required: index a couple of records — either save them through the engine with the hook armed (`DEDALO_RAG_ENABLED=true` makes `initRagHooks()` register it) and then drain the markers (`bun run src/ai/rag/cli/rag_drain.ts`), or index them straight away with `buildRagIndexer().indexRecordText({ sectionTipo, sectionId })` — then call `semantic_search`/`ask` through `dd_rag_api`. To drive it as an agent, run the MCP server (`DEDALO_MCP_USER_ID=<user id> bun run src/ai/mcp/server.ts`, add `DEDALO_MCP_ALLOW_WRITE=true` for the write tools) against any MCP client, or run the agent loop (`runAgent()`, `src/ai/agent/loop.ts`) with the production `AnthropicProvider` (requires `ANTHROPIC_API_KEY`; model `claude-opus-4-8` by default, override via `AGENT_MODEL`) — its tool surface (`AGENT_TOOLS`) mirrors the full MCP read registry plus `dedalo_semantic_search` and `dedalo_retrieve_passages`. There is no reference embedding/image sidecar, `rag_selftest`, or `rag_backfill` CLI in this tree; the sidecar HTTP contracts above are the integration point for standing one up.

---

# Part VI — Limits, ethics, and the road ahead

## What RAG is *not*

- **Not a source of truth.** The matrix remains authoritative; vectors are a derived, rebuildable index.
- **Not an oracle.** A language model can still be wrong. RAG mitigates this by **grounding** answers in real records, **citing** every claim, and **refusing** when there is no evidence — but a researcher must still verify, exactly as with any secondary source. Treat the assistant as a **finding aid**, not an authority.
- **Not a replacement for structured search.** The [SQO](../../api/sqo.md) remains the right tool for exact, relational, faceted queries. RAG is for *meaning*; the SQO is for *precision*. They compose.

## Ethical considerations for heritage and memory

Vectorizing heritage and memory carries responsibilities beyond the technical:

- **Sensitive and restricted knowledge.** Some heritage is culturally restricted, embargoed, or personal. The egress and ACL controls exist precisely so the semantic layer cannot become a back door around them. Institutions should decide deliberately what is opted in.
- **Model bias.** Embedding and language models carry the biases of their training data, which may misrepresent minority languages, dialects or worldviews. A multilingual default helps; vigilance and local models for sensitive collections help more.
- **Provenance and consent.** When testimony is involved, retrieval should *point to* the source in the informant's own voice (timecodes, citations) rather than paraphrase it away. The design favours linking back to the original over substituting for it.
- **Interpretation stays human.** The system surfaces evidence and resemblance; the meaning-making — the actual scholarship — remains the researcher's.

## Roadmap

- **Image ingestion on save** — the nearest-term gap (Part V): a pipeline that reads a record's declared context images, downsizes and embeds them, and writes `modality: 'image'` rows, so `similar_objects`/`characterize_object` work off an ordinary save the way text indexing already does.
- **Self-provisioning RAG schema** — a TS migration for the `rag_embeddings` parent table + `rag_create_model_partition()`, mirroring `ensureRagQueueTable()`'s idempotent DDL on the matrix side, so a fresh `dedalo7_rag` database needs no out-of-band setup.
- **Per-record egress wiring** — key the `ask()`/image egress decision off each record's actual diffusion-publish status (the `buildEgressPolicy` seam already accepts an injected `publishable()` callback; nothing wires it to `dd_rag_api` yet).
- **Image region search & linking** — query by a *region* of an image (a segment of a painting) and **link** the matching objects to that segment, building on the implemented object image similarity (Part V).
- **Vision-LLM object description (optional)** — a generated description grounded in the visually-similar neighbours, for the cases where the neighbour-aggregated proposal isn't enough.
- **Reranking by default** — a real cross-encoder behind the `Reranker` seam, in place of `PassThroughReranker`.
- **Public semantic API** — a separate service over *published-only* data, for third parties, co-located with the diffusion engine.
- **Retrieval-quality evaluation** — a golden-set harness (recall@k, citation-grounding) so model and parameter choices are measurable and regression-safe.
- **Live-API smoke tests** — the `AnthropicProvider` agent path and a real embedding sidecar are wired but untested against live credentials in CI.

---

*Subsystem code: `src/ai/rag/`, `src/ai/agent/`, `src/ai/mcp/`. Conceptual neighbours: [architecture overview](../../core/architecture_overview.md), [SQO](../../api/sqo.md), [exporting data](../../using/exporting_data.md), [ontology](../../core/ontology/index.md).*
