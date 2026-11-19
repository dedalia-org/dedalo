---
name: dedalo-ts-foundation
description: >-
  Master orientation for the Dédalo v7 TypeScript/Bun engine — READ THIS FIRST before any src/ work. Covers what the engine is (the single engine and sole writer since the 2026-07-11 cutover; the frozen PHP tree is historical reference only), the load-bearing law ("tripwire or delete") and where the tripwire index lives (engineering/TRIPWIRES.md), the subsystem/dependency map, the post-WS-C home rule (dispatch.ts = registry+gates+envelope only → api/handlers/<class>.ts; read routing in section/read_facade.ts), and the map to every sibling skill. Use when starting any src/ TS work, asking "where does X live", "how is the TS server structured", architecture/layering/boundary questions, "is there an invariant about…", checking a flagged path before touching it, or onboarding. Spec: engineering/REWRITE_SPEC.md.
---

# Dédalo v7 foundation (TypeScript/Bun engine)

**Read this first for any `src/` work.** Dédalo v7 is a from-scratch Bun + strict TypeScript engine. Since the **2026-07-11 cutover** it is the single engine and the sole writer; the PHP monolith (`v7_php_frozen/master_dedalo`, outside the repo) is decommissioned dead code — cite it as history of how a behaviour was ported, never as something to verify against. Verification now is the frozen read-path fixture store + TS-native write-path gates (see `dedalo-ts-testing`). Authoritative overview: `engineering/REWRITE_SPEC.md`. Measured state (baselines, per-subsystem coverage, known-open gaps) lives in rewrite/LEDGER.md — gitignored, local-only, never on a clone.

Do not read this skill as a spec copy — it POINTS. Specs hold the content; this teaches how to work without breaking the rails.

## THE LOAD-BEARING LAW: "tripwire or delete"

The 2026-07 foundation audit reached one central, empirical finding: **every invariant enforced only by docs or memory was violated in practice; every TRIPWIRED boundary held.** A documented-but-untripwired rule WILL rot.

So the rule for all new work: **if you add an invariant, add its tripwire in the same change. If a rule has no tripwire, treat it as already-rotting and either tripwire it or delete it.** Never rely on "the docs say don't do X."

### The tripwire index

The authoritative, machine-read list is **`engineering/TRIPWIRES.md`** — one row per gate with the invariant it guards. `scripts/verify.ts` `TRIPWIRES` must equal its first column exactly (`test/unit/ci_workflow_tripwire.test.ts`); adding a tripwire means a row there AND in `verify.ts` in the same change. Read the index, not a copy — it grows every week. Load-bearing examples you will hit early:

- `sql_confinement_tripwire` — tiered SQL confinement (DEC-09); matrix/dd_ontology DML only in the `src/core/db/` writer homes.
- `config_env_tripwire` — no `process.env` / `Bun.env` outside `src/config/`.
- `module_state_tripwire` — no cross-request module-level mutable state.
- `diffusion_boundaries` + `boundary_seam_tripwire` — diffusion→core direction only; core reaches diffusion only through the facade.
- `import_scc_tripwire` — no static value-import cycle; `descriptor_completeness_tripwire` — component descriptors declare required facets.
- `ws_a_tripwires` — `encodeForJsonb` at every jsonb bind; no inline locator compares.
- `section_id_int_tripwire` — a matrix record address is an INT (WC-2026-08-10-section-id-int-canonical).
- `coex_tag_tripwire` — post-cutover: NO `COEX` tag may exist in `src/` or `tools/`.
- `client_serving` — `client/` serves byte-identical to the TS-owned tree on disk (self-consistency).
- `gate_vacuity_tripwire` — a test that returns before asserting is debt (shrink-only budget).
- `test_db_marker_tripwire` / `test_media_root_tripwire` — the suite writes only to a database / media root that SAYS it is one.
- `generic_tld_tripwire` — tests use the generic `test` TLD (shrink-only).

## Never silently narrow scope

When a code path can't yet handle a case, **throw loudly and ledger the gap** — never return a plausible-but-narrowed result. A silent narrowing looks green and is wrong forever; a loud throw is a visible TODO. Where the gap lives: a state row in rewrite/LEDGER.md (local-only), or — if a gate must verify it — next to the code (a `reason` field, a named exemption). This is why unregistered models THROW, unsupported search faces THROW, and `oracle_canary` refuses a silent pass.

## Subsystem map & dependency direction

Current per-subsystem state lives in rewrite/LEDGER.md (local-only). The durable *shape*:

- **Kernel:** `src/core/db/` (Postgres/Bun.sql, transactions, jsonb codec, matrix writes) + `src/core/concepts/` (locators, subdatum, ddo/rqo). Everything depends inward on these; they depend on nothing above.
- **Layers above:** ontology, resolve, section, components, search, relations, security — each imports the kernel and lower layers, never sideways into a peer's internals.
- **Diffusion is self-contained** under `src/diffusion/` behind the `src/core/diffusion_bridge/` seam (a DIRECTORY: `diffusion_delete.ts`, `diffusion_graph.ts`, `diffusion_map.ts`, `published_files.ts`). Core reaches diffusion ONLY through that facade (`src/diffusion/api/`); diffusion never imports core upward. MariaDB dialect lives only in `src/diffusion/targets/mariadb/`. Both directions are tripwired. Spec: `engineering/DIFFUSION_SPEC.md`.
- **External record services** (`src/external/`) are a PEER of core with one outbound door — one of the engine's three. Spec: `engineering/EXTERNAL_SPEC.md`.
- **Harvesting door** (`src/core/harvest/`) — how a tool reads another site: per-hop vetting, robots.txt, per-origin pacing, on the shared pinned hop. Doors map: `engineering/OUTBOUND_SPEC.md`.
- **AI** (`src/ai/` — agent, MCP, RAG, identify) runs on its own connections (the RAG vector store has its own pool), not the request kernel.

### The post-WS-C home rule (know this before adding a handler or read sub-action)

- `src/core/api/dispatch.ts` is **registry + gates + envelope ONLY.** Do NOT add per-action business logic there.
- Per-api-class handlers live in **`src/core/api/handlers/<class>.ts`** (e.g. `dd_core_api.ts`, `dd_ts_api.ts`, `dd_diffusion_api.ts`, `dd_area_maintenance_api.ts`). Add a class's actions there.
- Section read sub-action routing lives in **`src/core/section/read_facade.ts`** (the shared `emitDdoData` and read engine live in `src/core/section/read.ts`).
- Other clusters: `src/core/area_maintenance/` (maintenance widgets), `src/core/components/component_info/` (info widgets), and `hierarchy_provision.ts` + `ontology_delete.ts` in `src/core/ontology/`.

## Extension: components are descriptor-routed

A component model is added by writing a descriptor (`src/core/components/component_*/descriptor.ts`) and registering it — NOT by scattering `if model === …` across the engine. Required facets must be DECLARED; `descriptor_completeness_tripwire` fails a half-declared model. The registry↔resolver cycle is inverted by boot-time registration: `src/core/components/registry.ts` calls `registerComponentModelFieldsLookup` (from `src/core/ontology/resolver.ts`) so the resolver never static-imports the registry. Deeper: **`dedalo-ts-extension`**.

## Config: one env reader

`readEnv` (`src/config/env.ts`) is the ONLY thing that reads the environment; the typed catalog is `src/config/config.ts`, the key census `src/config/catalog/`. **No direct `process.env` outside `src/config/`** — tripwired. Deeper: **`dedalo-ts-ops-config`**; operating the server: `engineering/PRODUCTION.md`, `engineering/STAGING_VALIDATION.md`.

## The audit (local-only)

The foundation audit lives in audits/2026-07_foundation/ (FINDINGS / DECISIONS / REMEDIATION) — **gitignored, local-only**: ids like S2-26, DEC-19 or P2-19 cited in code and in the tripwire index resolve there only on a machine that has it. Where you have it: do NOT re-litigate a settled DEC; before touching a flagged path, read its finding. Where you don't: the tripwire row and the code comment carrying the id are the enforceable part.

## Sibling skills — the foundation family

Reach for the specialist when you cross into its area:

- **`dedalo-ts-write-path`** — the one jsonb serializer and the `::text::jsonb` bind trap (`encodeForJsonb` in `src/core/db/json_codec.ts`), `withTransaction` (`src/core/db/postgres.ts`), atomic matrix DML (`insertMatrixRecordWithCounter` in `src/core/db/matrix_write.ts`), `compareLocators` (`src/core/concepts/locator.ts`), `dbTimestamp` (`src/core/db/db_timestamp.ts`).
- **`dedalo-ts-isolation-caching`** — request identity on AsyncLocalStorage (the transaction stores in `postgres.ts` — `withTransaction`, `deferPostTransaction`, `registerCommitAction`; request-lang ALS `runWithRequestLangs`/`currentApplicationLang`/`currentDataLang` in `src/core/resolve/request_lang.ts`; request-context ALS `currentPrincipal` in `src/core/security/request_context.ts`) and the cache factories `createOntologyCache`/`createDataCache` (`src/core/ontology/cache_factory.ts`). Model: `engineering/REQUEST_ISOLATION.md`.
- **`dedalo-ts-testing`** — the suite: the dedicated suite DB + `dedalo_test_marker`, the suite media root, the generic `test` TLD law, frozen-fixture parity (`test/parity/oracle_fixtures.ts`), TS-native write gates, vacuity and mock leaks. Fixture store: `engineering/ORACLE_HARVEST.md`.
- **`dedalo-parity-debugging`** — when a frozen-fixture parity gate reds (divergence vs bug, fixture edit = same-day WC entry, the retired-differential twin map), probe scripts against our own server, and driving the client via Chrome DevTools MCP.
- **`dedalo-ts-extension`** — adding component models / descriptors / facets, areas.
- **`dedalo-tools-ts`** — creating or adapting a tool (`tools/tool_<name>/`): registration, permissions, client, CSS, phone.
- **`dedalo-ts-ops-config`** — env/config catalog, pool/observability, running & supervising the server.
- **`dedalo-errors-ts`** — the closed error system: the `DedaloError` code registry (`src/core/errors/registry.ts`), the ONE converter (`convert.ts`), envelope v2 + its schema (`schema.ts`), the disclosure ladder and `DEDALO_DEBUG_API_ERRORS`, and the client contract (`api_error.js`, `error_policy.js`, `error_dispatch.js`). Spec: `engineering/ERRORS_SPEC.md`.
- **`dedalo-labels-ts`** — repo-owned UI-label catalogs (WC-033/034): `master.json` + `catalog/lg-<code>.json`, the `getLabels` fallback chain (`src/core/labels/catalog.ts`), `labels_tripwire`, `scripts/labels_fill.ts`. Labels ship with code, never ontology updates.
- **`dedalo-media-protection`** — web-server-enforced media access: the `.publication` marker store, the per-session media cookie and its revocation, SVG response headers, the generated Apache/nginx rule files (`src/core/media/protection.ts`). Spec: `engineering/MEDIA_PROTECTION.md`.

## Subsystem skills (the deep dives)

- **`dedalo-relations-ts`** — the relation family (`src/core/relations/`) + the full `component_dataframe` contract. Spec: `engineering/RELATIONS_SPEC.md`.
- **`dedalo-observers-ts`** — server-side observers / `set_dato_external`: an edge fires because the OBSERVER declares it (reverse discovery through the subscription registry in `src/core/section/record/observer_subscriptions.ts`); the mirror persists the FULL law, drops included (the grow-only fail-safe was retired 2026-08-06 — the one remaining withholder is the degraded-seed shrink refusal); the bounded, commit-only cascade; `scripts/observer_reconcile.ts`.
- **`dedalo-section-family-ts`** — section reads/edits, structure-context, virtual sections, and the client render contract. Spec: `engineering/SECTION_SPEC.md`.
- **`dedalo-ontology-ts`** — ontology definition/provisioning, `dd_ontology` writes, the hierarchy invariant.
- **`dedalo-tree-ts`** — the thesaurus/ontology tree (`src/core/ts_object/`, `dd_ts_api`) + the shared tx/advisory-lock primitives.

## Writing the manual

**`dedalo-docs-authoring`** — anything under `docs/`. The load-bearing rule: **every ontology `tipo` in an example must be a REAL, verified node whose MODEL matches the prose** (readers copy examples straight into their ontology). Also the `docs_current_engine_tripwire` gates (PHP-free prose, links resolving inside `docs/`, no `rewrite/` paths). Prose canon: `docs/development/documentation_style_guide.md`.

## Cross-cutting docs (point, don't duplicate)

`engineering/CONVENTIONS.md` (error handling, dynamic imports) · `engineering/WIRE_CONTRACT.md` + `engineering/wire_contract/` (deliberate wire divergences, one file per entry, e.g. WC-001 unified `entries:[]`) · `engineering/ORACLE_HARVEST.md` (the frozen fixture store + retired-differential twin map) · the per-subsystem specs `RELATIONS_SPEC.md` / `SECTION_SPEC.md` / `DIFFUSION_SPEC.md` / `MEDIA_SPEC.md` / `TOOLS_SPEC.md` / `AREA_SPEC.md` / `EXTERNAL_SPEC.md` / `IDENTIFY_SPEC.md`.
