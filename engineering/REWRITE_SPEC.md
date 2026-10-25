# Dédalo → TypeScript/Bun Greenfield Rewrite — Master Spec

> Standing specification for the TS/Bun rewrite. Authored 2026-07-01 with the project owner.
> PHP reference tree: `../../v7_php_frozen/master_dedalo/` (READ-ONLY). This tree: the rewrite workspace.

> **CUTOVER ADDENDUM — executed 2026-07-11, recorded here 2026-08-24. Read this before §2.**
> The rewrite this spec instructs **shipped**: the TS/Bun server is the SINGLE
> engine and the **sole writer** of the matrix database; the PHP engine is
> **decommissioned**. `../../v7_php_frozen/master_dedalo/` is unmaintained
> **dead code**, a historical reference only — and a **BETA snapshot,
> incomplete versus the v6 production tree**, so behaviour read there is a
> hint, never an authority (diff against v6 before porting anything out of
> it). The spec below is kept whole, as the design record; where it describes
> a live PHP peer it is **history, not present tense**. In force:
> - **§2.1 — PHP is no longer "the source of truth"** (amended in place).
>   Authority today: this tree, the frozen fixture store
>   (`test/parity/fixtures/oracle_harvest/`) and the wire-divergence ledger
>   (`engineering/wire_contract/`).
> - **§2.2 — half survives, half is dead** (amended in place). Schema and
>   per-component `data` shapes: preserved exactly, still non-negotiable —
>   live heritage installs upgrade IN PLACE onto their existing database.
>   "Both servers run against the same database": **dead**, nothing else
>   connects as a writer.
> - **§2.5 — superseded.** `client/` is the PRIMARY, TS-OWNED source, edited
>   directly; `scripts/sync_client.sh` is retired and refuses to run.
> - **§2.6 — built, not pending.** RAG/Agent/MCP live under `src/ai/`.
> - **The live-oracle era is OVER** (§3 gate, §9, §10 and the Verification
>   section amended below). Read-path parity replays the FROZEN store
>   (`ORACLE_MODE` defaults to `fixtures`, credless); a re-harvest is
>   impossible by definition, so any fixture change is a deliberate contract
>   edit with its `engineering/wire_contract/` entry the same day. The store
>   is corpus-bound and NOT green on the vendored suite database — it is
>   being replaced gate-by-gate with generic-`test`-TLD twins; write-path
>   contracts already live in TS-native `test/unit/*_native.test.ts` gates.
>   Full story + the twin map: `engineering/ORACLE_HARVEST.md`.
> - **Unchanged by the cutover:** §2.3 (security floor), §2.4 (independent
>   runtime/config), §2b (code style), §4, §5, §6, §7. The PHP `file:line`
>   anchors throughout stay valid as historical oracle references.

## Context

Dédalo is a large, mature, **ontology-driven** content/collections platform currently written in PHP (~3,663 PHP files) with a framework-free vanilla-JS client (~2,606 JS files), a LESS design system, and a PostgreSQL JSONB "matrix" data model. Everything in the app — menus, areas, sections, components, tools, buttons, widgets — is *generated from the ontology*, not hard-coded. A small amount of TypeScript/Bun already exists in production only for the **diffusion** engine (`diffusion/api/v1/`, MariaDB) and the MCP server.

This document is the **standing master specification** for the effort that re-implements the Dédalo **server** as a native TypeScript application running on **Bun**, from scratch, in this tree, while the PHP tree remains the untouched functional reference. This is a *greenfield* — freed from PHP's file/class organization and its sequential execution model — but it must preserve 100% of current functionality, the database schema and per-component data structures, and the conceptual API contract, and it must be **at least as secure** as the PHP version. Per explicit direction: the wire contract may be **modernized freely** (the client's server-call layer may be adapted at the seam; CSS and view JS are copied as the base), auth is a **new native TS design** (not PHP-session-compatible).

---

# Re-implement the Dédalo server in native TypeScript on Bun

## 1. Mission

Rebuild the Dédalo **server** as a modern, native TypeScript application on the **Bun** runtime, from scratch. Preserve every current functionality of the PHP server, but build it freely in idiomatic TS/Bun without inheriting PHP's structure or its one-request-one-sequential-process model. Exploit JS/TS concurrency (async/await, `Promise.all`, worker threads, streaming) to make the API materially faster than the sequential PHP. Design with **AI integration** as a first-class concern from day one.

**You are not translating PHP line by line.** You are re-expressing a well-understood system. Understand the *contracts and semantics* deeply, then implement them the best modern way.

## 2. Absolute constraints (non-negotiable)

1. **Do not modify the PHP project** at `v7_php_frozen/master_dedalo/`. It is the source of truth and functional reference — read it, never write it.
   > **SUPERSEDED 2026-07-11 (cutover).** PHP is DECOMMISSIONED dead code:
   > unmaintained, not the source of truth, not the functional reference of
   > record. Do still not modify it — not because it is authoritative but
   > because it is a frozen historical artifact, and a BETA snapshot that is
   > incomplete versus v6. What replaced it as authority: this tree, the
   > frozen fixture store (`engineering/ORACLE_HARVEST.md`) and
   > `engineering/wire_contract/`.
2. **Preserve the database schema and data model exactly.** The PostgreSQL JSONB **matrix** tables (`matrix`, `matrix_default`, `matrix_list`, `matrix_hierarchy`, `matrix_hierarchy_main`, `matrix_langs`, `matrix_tools`, `matrix_time_machine`, etc.) and the **per-component `data` JSON structures** stored inside them must be read and written byte-compatibly with the PHP version. Both servers must be able to run against the same database without corrupting each other's data.
   > **AMENDED 2026-07-11 (cutover) — one half stands, one half is dead.**
   > STANDS, non-negotiable: schema and per-component `data` JSON shapes are
   > preserved exactly. The reason is no longer a peer process but **data
   > continuity** — long-lived heritage installs upgrade IN PLACE onto the
   > rows they already hold, so a shape change is a migration event and needs
   > its `engineering/wire_contract/` entry. Byte-compatibility is owed to the
   > RECORDS ON DISK. DEAD: "both servers must be able to run against the same
   > database" — TS is the sole writer, no second engine connects.
3. **At least as secure as PHP.** Every security chokepoint in §7 must have an equal-or-stronger equivalent. Never ship a regression in the security posture.
4. **Independent projects.** The TS tree has its own directory architecture, its own config system, and its own runtime. The PHP and TS developer versions must each run standalone — including independent config definitions (no shared runtime config files, no shared sessions).
5. **Copy, don't rewrite, the client view layer.** The vanilla-JS client and the LESS/CSS are copied from PHP as the starting base. You may *adapt the client's server-communication layer* (the code that builds RQO/SQO and calls the API) to match a modernized wire contract — but the rendering/view/CSS stays as-is.
   > **SUPERSEDED 2026-07-11 (cutover).** `client/` is the **PRIMARY,
   > TS-OWNED client source** — edit it directly; there is no upstream left to
   > copy from, and `scripts/sync_client.sh` is RETIRED (it refuses to run:
   > syncing would overwrite owned files with dead-code copies). "Adapt only
   > the call layer, keep views/CSS untouched" goes with it: views, LESS/CSS
   > and call layer are all ours to change — under the wire contract, and with
   > the old law surviving in spirit (a blank widget is a server-payload bug
   > first; the client is vanilla JS against an exact contract). Gates:
   > `test/unit/client_serving.test.ts` (serving self-consistency) +
   > `bun run test:client` (Mocha in headless Chrome, its own server on the
   > suite database).
6. **RAG, Agent, and MCP are greenfield.** The PHP implementations of these are **not in production** — do **not** port them. Design them fresh in TS/Bun when their phase comes, taking advantage of native tooling.
   > **STATUS 2026-08-24 — built greenfield as instructed, no longer pending.**
   > They live under `src/ai/`: `src/ai/rag/` (indexer, chunker, embedding +
   > LLM providers, vector store, retrieval/fusion/reranker, multimodal image
   > source), `src/ai/agent/` (loop, provider adapters, change_plan, egress)
   > and `src/ai/mcp/` (server, registry, tool_spec, tools/). Nothing was
   > ported from PHP. Object identification (`src/core/identify/`) rides the
   > same image index — `engineering/IDENTIFY_SPEC.md`. Manual: `docs/core/ai/`.

## 2b. Code style & maintainability (standing rule)

Write the TypeScript with **long-term development** in mind. This code will be read, extended, and debugged for years by both **new human developers and AI agents** — optimize for their comprehension over cleverness.
- **Prefer the most standardized, idiomatic, boring options.** Favor widely-used, conventional TS/Bun patterns and mainstream libraries over exotic ones, so anyone (human or AI) can onboard quickly. You have freedom in *how* you build, but bias toward the least-surprising choice.
- **Readable names, always.** No cryptic short identifiers (`kk`, `x2`, `tmp3`, …). Variables, functions, and types must be self-descriptive and pronounceable by a human.
- **Comment and describe generously.** Every module, non-trivial function, type, and tricky branch gets a clear comment explaining *what it does and why* — especially where it re-expresses a Dédalo concept (RQO/SQO/ddo_map/locator/subdatum/context-vs-data) so a newcomer or an AI agent can follow the intent without reverse-engineering PHP. Document the contracts, not just the mechanics.
- **Consistency over local optimization.** Keep naming, file layout, error handling, and async patterns uniform across the codebase.
- **When a requirement or a Dédalo concept is ambiguous, ask** rather than guessing — surface the question instead of inventing behavior.

## 3. Prime directive: learn the core concepts before writing any code

Dédalo's entire behavior is an emergent property of a small set of interlocking concepts. **You must internalize all of them before planning or writing implementation code.** Study them in the PHP reference at the file:line anchors given, confirm your mental model against real ontology records and API responses, then re-implement their *semantics* — not their PHP shape.

The core vocabulary: **Ontology, RQO, SQO, Locator, ddo / ddo_map, request_config (implicit vs explicit), Context vs Data, Subdatum.**

### 3.1 Ontology — the core of everything
Every menu, area, section, component, tool, button, and widget is *defined by* an ontology node (a record with a `tipo` like `dd207`, a `model` = the class/behavior, a `parent`, and a `properties` JSON blob). There are no bespoke feature tables — new capability comes from new ontology definitions plus a `model` that knows how to resolve them. The ontology also carries the schema flexibility that makes Dédalo Dédalo. **Model the ontology as the resolver/registry that produces every runtime instance's structure.**

### 3.2 RQO — Request Query Object (the API request contract)
The client's request to resolve/read/act on data. Canonical top-level keys (`class.request_query_object.php:360`): `id`, `api_engine`, `dd_api`, `action`, `source`, `sqo`, `show`, `search`, `choose`, `data`, `prevent_lock`, `options`, `pretty_print`. `source` names the target (`model`, `tipo`, `section_tipo`, `section_id`, `mode`, `lang`). `show`/`search`/`choose` each carry a **`ddo_map`** (see 3.4) plus `sqo_config`.
- Parse/validate/dispatch reference: `core/api/v1/json/index.php` → `dd_manager::sanitize_client_rqo()` → `dd_manager::manage_request()` → `<dd_api>::<action>()` → `dd_core_api::read()` → `build_json_rows()`.
- **The RQO defines a component-resolution over a `ddo_map` chain**; each `ddo` says how one component is resolved; components that point to related sections carry further `ddo`s resolved deeply via the `parent` property (see 3.4). This chain *is* the heart of the RQO.

### 3.3 SQO — Search Query Object (the query contract)
An ontology-driven, Mango/CouchDB-inspired abstraction over the JSONB matrix that compiles to SQL. Reference: `core/common/class.search_query_object.php`, compiled by `core/search/class.search.php` (+ `search_tm`, `search_related`, and the `select/from/where/order/count/utils` traits). Key fields: `section_tipo` (mandatory, array — **one or many target sections**; multi-section triggers `UNION ALL` under a `mix` alias), `mode`, `filter` (`$and`/`$or` trees of leaf clauses with `q`, `q_operator`, `path:[{section_tipo,component_tipo}]`, `format`, `use_function`, `lang`, …), `select`, `order`, `limit`, `offset`, `full_count`, `filter_by_locators`, and server-only flags. SQO has a two-phase life: **conform/parse** (per-component `resolve_query_object_sql()` builds SQL fragments + bound params) then **SQL build** (FROM→SELECT→ORDER→WHERE→projects-filter, load-bearing order). **Preserve the SQO as pure data; keep identifier validation and value parameterization strictly separate (see §7).**

### 3.4 ddo / ddo_map — the resolution graph
A **ddo** (data-description object) describes how to resolve one component in a response. Client-allowed display fields (`class.request_config_object.php:683`): `tipo`, `section_tipo` (`self` = current section), `parent`, `mode`, `lang`, `view`, `label`, separators, `value_with_parents`, `column_id`, `width`, `limit`, `offset`, etc.
- **The `parent` property is the key.** A `ddo_map` is a flat list; it becomes a tree because each ddo's `parent` equals the `tipo` of the ddo it hangs under (`parent:"self"` = direct child of the calling component). Resolution walks the map, taking only direct children at each level, then recursing (`class.common.php:2295` `get_children_recursive`, and `:2454` the `parent === $this->tipo` filter). This is how a component that relates to another section carries the sub-components to resolve *in that related section*, to arbitrary depth, declaratively and without per-relation code.

### 3.5 Locator — the universal relation pointer
The value object that connects sections. Reference `core/common/class.locator.php`. Mandatory: `section_tipo`, `section_id`. Optional/relational: `component_tipo`, `from_component_tipo`, `type`, `type_rel`, `tag_id`/`tag_component_tipo`/`tag_type`, `lang`, and the **dataframe pairing** field `id_key` (the stable main-item id; legacy `section_id_key`/`section_tipo_key` still read for BC) plus `main_component_tipo`. Relation components store arrays of locators; **subdatum** expands those locators into resolved child component data. Preserve locator equality/lookup semantics (`compare_locators`, `in_array_locator`, `build_locator_lookup_key`) — relation data integrity depends on them.

### 3.6 request_config — how relation components resolve (implicit vs explicit; PHP oracle names them v5/v6)
Every relation component declares how to resolve its target(s):
- **IMPLICIT (legacy; PHP v5):** no explicit config; child component tipos are derived by walking the ontology relation graph (`trait.request_config_v5.php`). `component_relation_parent`/`children` are **not** supported here and require explicit config.
- **EXPLICIT (modern; PHP v6):** `properties.source.request_config` in the ontology defines `show`/`search`/`choose`/`hide` ddo_maps plus the **SQO** that names the target section(s) and data filters, plus an optional external `api_engine`/`api_config` (`trait.request_config_v6.php`, `class.request_config_object.php:41`). Support both; explicit is the default builder.

### 3.7 Context vs Data — the two definitions every data element has
Every component/section/widget that manages data has **two** definitions:
- **Context** = the ontology-derived *structure* needed to instantiate it: label, tipo, model, properties, translatable, css, tools, buttons, columns_map, and the resolved `request_config`. Built + cached by the structure-context core (`class.common.php:1604`/`:1739`), then per-call **stamped** with variant fields (permissions, parent, lang, request_config, view). It is **immutable within a request** — always clone before mutating; never leak the cache by reference (`:1644`).
- **Data** = the instance value(s) for a specific record/lang, lazily loaded from the matrix (`component_common::get_data()`; e.g. `[{id, value, lang}]`). Context can be built without paying for data I/O.
Keep this split. It is what makes caching, permissions capping, and lazy loading tractable.

### 3.8 Subdatum — the recursive glue
`subdatum` is the recursive expansion of child-component data through the `request_config`/`ddo_map` hierarchy, bridging a parent's stored **locators** to their resolved child **values** (`class.common.php:2254` `get_subdatum()`; dataframe variant `trait.dataframe_common.php:395`). Output shape: `{context, data}` (deduplicated child structures + resolved data rows). Portals and relations are all built on it. The dataframe **id_key** contract (pairing frame records to individual data items of a main component, never by array index) must be preserved exactly.

> **Deliverable gate:** Before writing feature code, produce a written model of these eight concepts *as you will implement them in TS* (types + resolver flow), and validate it by replaying real RQO/SQO requests from the PHP server and matching the resolved context/data/subdatum semantics.
>
> **AMENDED 2026-07-11 (cutover).** The gate was met, and the PHP server it
> names no longer answers. §3's concepts and PHP `file:line` anchors remain
> the canonical description and stay valid as historical references — but
> "replay against the PHP server" now means **replay the frozen fixture
> store** (`test/parity/fixtures/oracle_harvest/`, `ORACLE_MODE=fixtures`,
> credless). The live implementations are the reading of record:
> `src/core/ontology/resolver.ts`, `src/core/concepts/` (locator, ddo,
> subdatum, request_config), `src/core/section/read.ts`,
> `src/core/relations/`, `src/core/search/`.

## 4. Architecture & runtime

- **Reverse proxy in front:** Apache/Nginx serves static assets and media and enforces media access control, and **proxies API traffic to Bun over a unix socket** (as the existing diffusion engine already does). Design the Bun server to listen on a socket and to be horizontally runnable.
- **Bun serves all dynamic content / the API.** Own your own HTTP layer, routing, and dispatch.
- **PostgreSQL is the system of record** (same schema/matrix as PHP). Use Bun-native Postgres access with prepared statements; preserve the matrix read/write contract.
  > **AMENDED 2026-07-07 (S3-38 — native diffusion engine).** The parenthetical that stood here ("MariaDB remains the *old external* diffusion engine's concern — do not entangle core with it") predates the native rebuild. Since 2026-07-05 diffusion is a **native TS subsystem of this server**: `src/diffusion/` (parsers, writers, plan compiler, job queue/scheduler, MariaDB target). The rule is now: **MariaDB lives ONLY under `src/diffusion/targets/mariadb/`; `src/core/**` never constructs a MariaDB client and never imports `src/diffusion/**` except through the sanctioned facade seams.** Authority: `engineering/DIFFUSION_SPEC.md` §2; mechanically enforced by `test/unit/diffusion_boundaries.test.ts` (direction + MariaDB confinement) and `test/unit/boundary_seam_tripwire.test.ts` (facade-only seam growth). Cutover levers: `DEDALO_DIFFUSION_NATIVE*` (../private/.env).
  > **ADDENDUM 2026-08-05 (S3-38's rule, applied to the OUTBOUND side).** `src/external/` — records resolved from a third-party service — is a **PEER of `src/core`, `src/diffusion` and `src/ai`, never a part of core**, and the seam grows the same way: `src/core/**` reaches it ONLY through lazy imports of the `src/external/api/` facade (`test/unit/boundary_seam_tripwire.test.ts` FACADE_PREFIX; rationale 2 in `engineering/CONVENTIONS.md` §2), so transport, breaker, cache and the per-service adapters stay private and an install with no external section loads none of it. Two rules are specific to this subsystem because it is the one place an editor's keystroke becomes a request LEAVING the institution: (a) **exactly one outbound door for the subsystem** — `external/transport.ts`, whose nine-step order is itself the invariant (`external_outbound_tripwire`) (scoped 2026-09-29: it is the SUBSYSTEM's door, not the engine's — the engine has three, chosen by the kind of request, all on one SSRF guard: `engineering/OUTBOUND_SPEC.md`); (b) **the operator's host allowlist is the door, not a narrowing of one** — empty refuses everything, because the target URL is assembled from the ontology, which is editable data. And it is READ-ONLY in both directions: Dédalo never writes to the service and never writes a remote value into a matrix record (`external_write_refusal_tripwire`). Authority: `engineering/EXTERNAL_SPEC.md`; wire law: the `WC-2026-08-0{5,6}-external-*` entries. Levers: `DEDALO_EXTERNAL_*` (../private/.env).

- **Exploit concurrency the PHP could not:** resolve independent components/subdatums with `Promise.all`, stream large search/export responses, parallelize per-section `UNION` branches and per-row context building, cache structure-context in-process with correct invalidation, and offload CPU-bound work (media, embeddings) to workers. Latency reduction versus sequential PHP is an explicit success metric.
- **Persistent-runtime discipline (critical):** Bun is a long-lived process, unlike PHP's per-request lifecycle. **Any state that PHP kept in per-request statics/globals must become per-request scoped in TS.** No cross-request bleed of session, permissions, language, caches, or headers. (This is the single biggest correctness risk in a persistent rewrite — treat request isolation as a design invariant, not an afterthought.)

## 5. Config & independence
Design a self-contained TS config system (env-based, its own catalog, outside the web root for secrets), conceptually equivalent to the PHP `../private/.env` + catalog + per-entity routing, but **not shared** with PHP. Both trees must boot and run independently. Support the same multi-tenant/per-entity notion (one deployment, multiple databases/instances).

## 6. Functional scope to preserve
Re-implement, ontology-driven, the full surface: **38 component models** (data-entry, media, relation family, structural, portal, dataframe, geolocation, iri, etc.), **13 areas**, **35 tools**, the **widget** and **button** families, sections/section_record lifecycle (create/read/update/delete, locking via `prevent_lock`), the **search** subsystem, the **thesaurus/ontology tree**, the **time machine**, **import/export**, **datalist** resolution, **diffusion** integration points, and **media protection**. Use the PHP `_json.php` controllers and per-component search traits as behavioral specs. Match each component's stored `data` structure exactly.

## 7. Security — meet or exceed every chokepoint
Re-implement all of the following with equal-or-greater strength (PHP reference in parentheses):
1. **API class + action allowlists.** Only known api classes are dispatchable; when a class declares its action allowlist, enforce it; handlers are explicitly registered (not reflection over arbitrary methods). (`dd_manager` `$allowed_api_classes`, `API_ACTIONS`.)
2. **Auth gate + new native auth.** Design a modern TS auth/session from scratch (e.g. signed, rotating tokens + server-side session store) that is **not** PHP-session-compatible but preserves every guarantee: session-fixation resistance (rotate on login), Argon2id password verification with lazy upgrade, brute-force throttling (sliding window, per namespace|user|ip), maintenance-mode gating, optional SAML with IdP-IP allowlisting. (`class.login.php`.)
3. **CSRF-equivalent protection** for state-changing actions, with a defined exempt-action set, constant-time comparison. (`dd_manager` CSRF.)
4. **Authorization / permissions matrix.** Three-tier ACL (schema-level (section_tipo,component_tipo)→0–3; per-record projects filter; hard-coded bypasses for superuser/tools/maintenance/time-machine), computed with a layered cache and correct invalidation, and enforced **before** search runs and **per-SQO-target**. Permissions are capped per caller and are **server-authoritative** — never trust client-supplied permission or `skip_projects_filter`-style flags. (`class.security.php`.)
   - **Own-user-record rules (dd128).** On the actor's OWN user record the matrix level is both RAISED and LOWERED, and the rules are a WRITE gate, not only a display stamp — every door onto a dd128 component — the save write door AND the read doors (`read` Gate A, the component `get_data` gate, the per-element context stamp) — must consult `resolveOwnUserRecordPermission` (`src/core/security/permissions.ts`, via `getRecordComponentPermission`) before the matrix: the security-administrator flag (dd244) is forced to read even for a global admin; profile/developer/username/section_id (dd1725/dd515/dd132/dd330) are forced to read for non-global-admins (anti self-elevation); name/email/password/image (dd452/dd134/dd133/dd522) are forced to write, which is the only reason the self-service profile editor works at all — dd128 is not project-assigned, so most profiles grant 0 on it. Dropping the downgrade half lets a user with a dd128 write grant assign themselves a profile or the developer flag through the ordinary save API. (`component_common::resolve_component_read_permission`.) Gated by `test/unit/user_self_record_permissions.test.ts`.
5. **SQO sanitization gate** on every untrusted SQO at the API boundary: strip server-only keys (`sentence`, `params`, `column_sql`, `table`, `table_alias`, `skip_projects_filter`, `skip_duplicated`, `include_negative`), clamp `limit`/`offset`/`total`, force re-parse. (`search_query_object::sanitize_client_sqo`.)
6. **Identifier validation chokepoint.** `section_tipo`/`component_tipo`/`lang`/column names are interpolated into JSONB keys/jsonpath and **cannot** be parameterized — validate every one against strict allowlists at a single chokepoint before any SQL is built (`is_valid_tipo` `^[a-z]+[0-9]+$`, `is_valid_lang` `^(lg-[a-z0-9_]+|all)$`, the fixed matrix-column allowlist). (`conform_filter`, `trait.utils.php`.)
7. **Value parameterization.** All dynamic values go through prepared-statement parameters; JSONB operators are fixed fragments. Zero string-concatenated user values.
8. **ddo_map sanitization.** Whitelist client-supplied ddo fields to the display allowlist only.
9. **Media access control.** Preserve the web-server-enforced model: fixed-name daily-rotated auth cookie + `.publication/auth` markers (Rule A), publication markers + quality allowlist + filename grammar (Rule B), fail-closed 404s, path-traversal guards, script-exec blocking. Keep the marker store, `media_index`, and rewrite rules in lockstep. (`class.media_protection.php`.)
Also carry over: failed-login timing/ambiguity, activity logging, and never revealing record/media existence to the unauthorized.

## 8. AI integration (design-in, build greenfield)
Architect the server so AI is native, not bolted on: clean typed service boundaries, structured tool/action schemas, and data access suitable for embedding/retrieval. **RAG, Agent, and MCP are fresh greenfield builds** (do not port the non-production PHP versions) — but leave the seams for them from the start (e.g. a way to expose ontology-typed data and actions to LLM tools, respecting the same ACL as human access). Default to the latest, most capable Claude models when wiring AI features.

> **Work-system MCP foundation (built 2026-07-07).** One shared, ACL-gated tool registry serves the stdio MCP server, the in-app `dd_mcp_api` bridge (the tool_assistant chat), and the server-side agent loop. Discovery/search/read + fail-closed write tiers, a propose→confirm→apply change-plan protocol for the image→extract→fill-ontology flow, and image-capable vision input. Live code: `src/ai/mcp/` (server.ts, registry.ts, tool_spec.ts, tools/), the agent loop in `src/ai/agent/`, and the in-app bridge in the API dispatch. Operator + user documentation: `docs/core/ai/assistant/`.

## 9. Method & sequencing (how to proceed)
1. **Concept mastery + type foundations** — implement the §3 concepts as TS types and resolver skeletons; validate against live PHP responses (§3 gate).
2. **DB + matrix layer** — Bun-native Postgres, matrix read/write parity, prepared-statement discipline; round-trip real records byte-for-byte.
3. **SQO engine** — pure-data SQO → conform → SQL, with the §7 gates; verify generated SQL/results against PHP for representative queries (single- and multi-section, filters, order, pagination, full_count).
4. **Context/Data/Subdatum engine** — structure-context cache (per-request-safe), lazy data, subdatum + dataframe id_key; match resolved output for portals/relations.
5. **API dispatch + auth/security** — routing, allowlists, new native auth, CSRF-equiv, permissions, all sanitization chokepoints.
6. **Component/area/tool/widget/button models** — ontology-driven, per model, using PHP `_json.php`/search traits as specs; parity-test each component's context+data+search+export.
7. **Client seam** — copy client JS/CSS; adapt only the RQO/SQO-building + API-call layer to the modernized contract; keep views/CSS untouched.
8. **AI/RAG/Agent/MCP** — greenfield, last, on the stable typed core.
- **Every phase is parity-gated against the PHP reference.** Prefer differential testing (same input → compare TS vs PHP output) over hand-written expectations wherever feasible. Never silently narrow scope — log what a phase does not yet cover.

> **AMENDED 2026-07-11 (cutover).** All eight steps ran; the sequencing is
> history. Two of them read differently now: step 7 is not a client copy —
> `client/` is TS-owned primary source (§2.5 addendum) — and the closing
> parity rule has no live peer to diff against. Parity today = replay of the
> frozen read-path store plus TS-native write-path gates
> (`test/unit/*_native.test.ts`), with each retired differential mapped to its
> twin in `engineering/ORACLE_HARVEST.md`. What did NOT change: never silently
> narrow scope — an uncovered path throws loudly and gets a ledger line, and a
> stated invariant is tripwired or deleted (`engineering/TRIPWIRES.md`).

## 9b. Multi-agent orchestration (how to execute at scale)

You may — and for a rewrite of this size, *should* — **use sub-agents freely, each with a distinct role**, to parallelize and de-risk the work. Build a solid orchestration foundation before scaling it out:
- **Role specialization.** Spin up focused agents for well-scoped roles, e.g. *explorer/spec-extractor* (read the PHP reference and produce concept specs), *implementer* (write a component/tool/subsystem in TS), *parity-tester* (differential test TS vs PHP), *security-reviewer* (audit against §7 chokepoints), *DB/matrix specialist*, *client-seam adapter*. Give each a crisp remit and the contracts from §3.
- **Solid basements first.** Do not fan out until the shared foundations are stable and agreed: the §3 concept types, the DB/matrix contract, the SQO engine, and the security gates. Parallelize *breadth* (many components/tools) only on top of a settled *core*.
- **Independent, verifiable units.** Prefer parallel work that is isolated and parity-gated (one component/tool per agent, each with its own differential tests) so results can be verified independently and merged without cross-contamination.
- **Adversarial verification.** Have reviewer/verifier agents independently confirm implementer output (correctness + security) before it is accepted — especially for the §7 chokepoints and any cross-request-state risk (§4).
- **Consistency guardrails.** Keep the §2b code-style rules, naming, and contracts uniform across all agents; a synthesis/coherence pass should reconcile divergences. Log any scope an agent did not cover — never silently narrow.

## 10. Definition of done
- Feature-complete versus PHP for §6, verified by parity tests.
- Same DB schema and per-component data structures; both servers coexist on one database safely.
  > **AMENDED 2026-07-11 (cutover).** Clause 1 stands (schema + per-component
  > `data` shapes preserved, for in-place upgrade of existing installs);
  > clause 2 is dead — there is no second server. Read as: **the engine reads
  > and writes the records existing installs already hold, and is the only
  > thing that writes them.**
- Security posture equal-or-stronger on all §7 chokepoints; no cross-request state bleed.
- Measurably lower API latency than sequential PHP on representative workloads.
- Runs standalone behind Apache/Nginx over a socket, with its own independent config; the copied client works against it through the adapted call layer.
  > **AMENDED 2026-07-11 (cutover).** "The copied client" is now the owned
  > client: `client/`, served by this engine, gated by
  > `test/unit/client_serving.test.ts` + `bun run test:client`.
- RAG/Agent/MCP built fresh in TS, ACL-respecting, or cleanly seamed for a later phase.

## Verification (how the executor proves parity)

> **AMENDED 2026-07-11 (cutover) — the live-oracle workflow below is HISTORY.**
> There is no running PHP server to drive, so:
> - **Differential harness** → replay of the frozen store. `ORACLE_MODE`
>   defaults to `fixtures`: `test/parity/php_client.ts` serves the recorded
>   response by canonical request hash, no network, no credentials. The store
>   is corpus-bound (harvested against one install's records) and therefore
>   NOT green on the vendored suite database; its gates are being replaced by
>   generic-`test`-TLD twins. Map + measured state: `engineering/ORACLE_HARVEST.md`.
> - **DB round-trip via PHP** → gone with the peer. The write-path contracts
>   are asserted by TS-native gates (`test/unit/*_native.test.ts`) against a
>   database that SAYS it is a test database (`dedalo_test_marker`), on
>   generic-`test`-TLD situations the test BUILDS itself.
> - **Security tests** and **perf** stand unchanged — those never needed the
>   oracle; the §7 bypass attempts must still fail closed.
> - Any change to a frozen fixture is a deliberate contract edit and needs its
>   `engineering/wire_contract/` entry the same day.
- **Differential harness:** drive identical RQO/SQO requests at the running PHP server and the TS server; diff resolved `context`, `data`, `subdatum`, and search results. Reuse the diffusion engine's existing Bun test patterns.
- **DB round-trip:** write a record via TS, read via PHP (and vice-versa); assert byte-identical `data` JSON in the matrix.
- **Security tests:** attempt each bypass the PHP gates block (server-only SQO keys, invalid tipo/lang injection, over-limit, unauthorized action/class, cross-project record access, media without cookie/marker) and confirm they fail closed.
- **Perf:** benchmark parallelized context/subdatum resolution and multi-section search against PHP; record the delta.
