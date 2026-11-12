# The v7 rewrite: from PHP to TypeScript

Dédalo has been cataloguing Cultural Heritage and Memory for more than two decades, coins and hoards, oral histories, archaeological records, etnographic records, thesauri, censuses. Software that carries data like that has an unusual duty: it has to *outlive its own technology*.
The collections will still matter in thirty years; the code that holds them has to be alive, understandable, and trustworthy for just as long.

This document explains a significant step in that direction: **the Dédalo server is being rebuilt from scratch in TypeScript on the Bun runtime**, replacing the PHP server that has served the project for years. It is written for two audiences at once: the developers who will build and maintain it, and the archivists, curators and researchers whose work depends on it. Wherever we use a technical term, we explain it in plain language.

---

## First, what Dédalo actually is

Most catalog software hard-codes its data model: a programmer decides there is a "People" table with a "surname" column, and changing that means changing code. Dédalo does the opposite. Its defining idea is an **active ontology** — think of it as *a living thesaurus that is also the database schema*. Every section (a kind of record), every field, every relation, menu, tool and button is a **node in that ontology**, resolved while the program runs. Reshape the catalog — add a field, turn a text box into a picker, define a new kind of record — and you do it by *editing definitions*, not by asking a programmer to alter tables.

Dédalo is also **two connected systems**, and the analogy is a museum:

- **The work system**: the private *workshop* where curators create, relate and refine records. This is the part being rewritten.
- **The diffusion system**: the public *gallery*, a flattened, published copy of the data served to websites and portals. Data flows one way only: workshop → gallery.

Underneath both, the data lives in PostgreSQL in a compact set of "matrix" tables as JSON.
None of that changes in the rewrite. **The rewrite is about the engine, not the collection.**

---

## Why rewrite at all?

Rewriting a large, mature system is not a decision to take lightly, and we don't. The reasons are specific and, we think, honest:

**1. The old runtime model fought us.** PHP handles one request at a time and then forgets everything, it's a clean slate per click. That's simple, but it left performance on the table (work that could happen in parallel happened in sequence), and the workarounds needed to make it fast introduced a whole category of subtle, hard-to-catch bugs. The rewrite's runtime creates a solid foundation that eliminates that entire hazard *by design* (more below).

**2. More than two decades leave sediment.** A long-lived system accumulates *scar tissue*, two ways to do the same thing because a migration was never finished, deprecated-but-still-load-bearing vocabulary, mechanisms layered on mechanisms. None of it is anyone's fault; it's the natural geology of software that has survived long enough to matter. A rewrite is a rare chance to keep the good foundation and let the sediment go.

**3. The system is finally *understood well enough* to re-express.** You can only safely rebuild something you deeply understand. After twenty seventy years, Dédalo's concepts are clear and documented.
We are not inventing a new system, we are re-expressing a well-understood one in a better medium.

**4. Durability and stewardship.** For a cultural-heritage platform maintained by a small team, the single greatest long-term risk isn't any line of code, it's whether *a second person* can learn the system and keep it alive. A modern, typed, modular, well-documented foundation is a direct investment in that: it lowers the barrier for the next contributor, human or AI.

**5. AI changes the perspective.** AI-assisted tools are opening new possibilities in the Digital Humanities — tasks that were simply not feasible for curators, researchers, and technicians a few years ago are now within reach. TypeScript's modern ecosystem, strong typing, and native integration with AI libraries and runtimes make it a far better foundation for building these tools than PHP. This rewrite positions Dédalo to take full advantage of that, bringing AI capabilities directly into the cultural-heritage workflow.

---

## The promise: what does **not** change

If you are a curator or researcher, this is the section that matters most. The rewrite is built around a set of hard guarantees:

- **Your data is untouched.** Same PostgreSQL database, same records, same per-field JSON shapes — read and written *byte-compatibly*. The old and new servers can run against the **same database at the same time** without corrupting each other's data. Nothing migrates; nothing is reshaped.
- **The ontology is the same.** Your sections, components, thesauri and relations are the same living definitions. Editing the catalog works as it always has.
- **Multilingual, versioning and provenance stay.** Every-value-in-every-language, the **Time Machine** (the full editable history of every record), uncertainty and qualifiers — all preserved exactly. These aren't features we're re-deciding; they are the essential complexity of heritage data, and the rewrite honours them faithfully.
- **The way you work is the same.** The screens, the editing forms, the visual design — the entire look and feel — are **copied over unchanged**. The rewrite replaces what happens on the *server*; the client you click on is deliberately left as it is.
- **The meaning of the API is preserved.** Integrations that speak Dédalo's request model keep working conceptually; only the low-level "wire" details are modernized, and only at the seam.

The mental image: we are **replacing the engine of a well-loved vehicle** without changing how you drive it, where your cargo sits, or the road you travel.

---

## What changes: the engine under the hood

For developers, here is the substance of what's new.

**A persistent, concurrent runtime with per-request isolation.** The new server is a single long-lived Bun process behind Apache or Nginx. Unlike PHP's clean-slate-per-request model, it stays warm — but every request runs inside its own **request-scoped context** (via `AsyncLocalStorage`). That single design choice *structurally eliminates* the cross-request state-bleed hazard that PHP could only hold at bay with discipline: instead of everyone sharing one desk where papers might get mixed up, **each visitor gets their own clean desk**. It also lets us exploit real concurrency — resolving independent parts of a record in parallel, streaming large results — so the API is measurably faster than the sequential original.

**Components as descriptions, not class hierarchies.** In PHP, each of the ~38 component types was a class in a deep inheritance tree. In the rewrite, a component *model* is a small, declarative **descriptor**, one named home per model (`src/core/components/component_X/`), that the shared "horizontal" engines read. The behaviour that used to be scattered across a class, a controller, and several base classes is now expressed once, in engines, and *configured* per model. Concepts kept; mechanics simplified.

**Types as the contract.** TypeScript (and `zod` schemas at the boundary) make the request and search formats *self-documenting and self-validating*. The shapes that were once conventions enforced by hope are now checked by the compiler and at the wire.

**A brand-new, native authentication.** Rather than reproduce PHP sessions, the rewrite ships a modern auth designed from scratch — Argon2id password hashing, rotating server-side sessions, fixation resistance, brute-force throttling, meeting or exceeding every security guarantee of the original. Security is **at least as strong as before, by rule**.

**AI as a first-class citizen.** Clean, typed service boundaries and structured action schemas mean the system can safely expose its ontology-typed data and actions to AI tools, respecting *exactly the same permissions as a human*. Retrieval-augmented search, agents and the tool protocol are being built fresh on this foundation, not bolted on.

---

## A new paradigm — and a rare chance to re-think

The most important thing about this rewrite is a stance: **it is a re-expression, not a translation.** We are not converting PHP line by line. We understood the *contracts and semantics* deeply, then implemented them the best modern way.

That stance gives us a once-in-a-generation opportunity to separate two kinds of complexity:

- **Essential complexity** — the parts that are hard because *cultural heritage is hard*: a knowledge graph of related records, uncertainty and re-attribution, deep multilingual hierarchies, data that must outlive the software. This foundation is *right* — it's the same conclusion the field's best thinking (CIDOC-CRM, the Getty's Arches) reaches independently. **We keep it, and we protect it.**
- **Accidental complexity** — the sediment: unfinished migrations, duplicated mechanisms, conventions only the original author fully held. **We shed it.**

And we add one goal the original never made explicit: **teachability**. A foundation that only one person can hold is fragile no matter how elegant. So the rewrite optimizes, deliberately, for the newcomer — human or AI — who has to understand it next. Clear names, one home per concept, generous comments, honest documentation of what is *not* done yet. This document, and the documentation set it belongs to, are part of that goal.

---

## How we keep it honest

A rewrite is only trustworthy if it can *prove* it matches the original. So the PHP server is treated as the **oracle** — the source of truth — and the method is **differential testing**: drive the same request at both servers and compare the results, byte for byte, until they agree. Write a record through the new server, read it through the old one, and assert the stored JSON is identical. Every subsystem is gated this way before it is accepted, and every phase keeps a **coverage ledger** that records what is done and — just as importantly — *what is not yet covered*. We never silently narrow the scope; a gap is written down, not hidden.

---

## What this means for you

**If you work with the collections:** nothing you do changes. Same login, same forms, same records, same languages, same history. Over time you'll notice it's faster and, quietly, that it will be here for the long haul, easier to maintain, easier to fund, easier to hand to the next generation of maintainers. Your catalog is safe; this is care taken under the hood.

**If you build or maintain Dédalo:** you get a codebase you can actually onboard into; typed, modular, request-scoped, differentially tested, with per-model homes and honest gap ledgers, and AI-friendly seams from day one. The concepts you already know (ontology, RQO, SQO, locator, ddo, context-vs-data, subdatum) are preserved; where they live and how they're wired is cleaner. Start with the [Architecture Overview](core/architecture_overview.md) and the [Glossary](understanding/glossary.md).

---

## Where we are (an honest status)

**The rewrite is done, and the TypeScript engine is the only engine.** The cutover ran on
2026-07-11: the PHP server was frozen, and TS became the single engine and the sole writer to the
database. The whole system — the data/matrix layer, search, context/data resolution, API dispatch,
security, the components, tools, areas, diffusion and media — runs on Bun.

The engine is in **beta**: it is complete and gated, but it has not yet accumulated the years of
production mileage the engine it replaces had. Treat it accordingly.

A handful of wire shapes diverge from the original **on purpose** — usually to *fix* a bug rather
than faithfully reproduce it. Each of those is recorded, with its reason, in the wire-contract
ledger (`engineering/wire_contract/`). Correctness is held by the tripwires and by a parity
suite that replays a fixture store harvested from the old engine before it was retired — see
[Testing](development/testing.md).

The rest of this manual documents the engine as it is today. This page is the only place that
looks backwards.

---

## Why this matters

Cultural heritage software is a long game. The institutions that use Dédalo think in decades; their data is often irreplaceable. A rewrite like this isn't chasing novelty — it's an act of **stewardship**: taking a system that got the hardest architectural call right, freeing it from the weight of its own history, and setting it on a foundation that a small, dedicated community can keep alive and teach to newcomers for another twenty years.

The engine is changing. The mission — *produce good data, and keep it safe* — is exactly the same.
