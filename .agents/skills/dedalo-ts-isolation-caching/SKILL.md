---
name: dedalo-ts-isolation-caching
description: >-
  Request isolation and caching without cross-request bleed or stale-after-edit serving in the Dédalo v7 TypeScript/Bun engine. ONE Bun process serves concurrent requests; request identity rides AsyncLocalStorage — request-lang (src/core/resolve/request_lang.ts runWithRequestLangs / currentApplicationLang / currentDataLang), request-context (src/core/security/request_context.ts currentPrincipal), and the transaction stores in src/core/db/postgres.ts (withTransaction, deferPostTransaction, registerCommitAction, runDetachedFromTransaction). Use when adding or editing ANY module-level cache/singleton (new Map/Set/let), any createOntologyCache / createDataCache (src/core/ontology/cache_factory.ts), any ALS read, background-job/scheduler identity threading, or when debugging "cross-request bleed", "wrong language shown to user", "wrong actor in audit rows", "stale after edit", or a module_state_tripwire.test.ts failure. Authoritative: engineering/REQUEST_ISOLATION.md.
---

# Dédalo v7 request isolation + caching (TypeScript/Bun)

The v7 TS server is **ONE long-lived Bun process** (`Bun.serve` on a unix socket) handling **concurrent** requests. There is no per-request process or worker. Anything you store at module scope is shared by every in-flight request. This is the single fact that makes the rules below load-bearing. Authoritative model: **`engineering/REQUEST_ISOLATION.md`**. Measured state / open gaps: the local-only ledger rewrite/LEDGER.md (never restate its numbers here).

The 2026-07 foundation audit's central lesson (`audits/2026-07_foundation/`, local-only, gitignored): **every invariant enforced only by documentation was violated in practice; every tripwired boundary held.** Every rule below is backed by a tripwire — respect the tripwire, not just the prose.

---

## The AsyncLocalStorage stores (per-request / per-scope state)

All request-scoped state lives in ALS, never at module scope. The **request-identity** core is three concerns:

| Concern | File | Read via | Carries |
|-------|------|----------|---------|
| request-lang | `src/core/resolve/request_lang.ts` (`runWithRequestLangs`) | `currentApplicationLang()`, `currentDataLang()` | interface language + component-data language |
| request-context | `src/core/security/request_context.ts` (`runWithRequestContext`) | `currentPrincipal()`, `currentSession()`, `currentRequestId()` | authenticated principal + session + request id |
| transaction | `src/core/db/postgres.ts` — THREE stores: `transactionStore` (reserved tx handle + tx-scoped memo), `deferredActionStore` (`deferPostTransaction` queue), `commitActionStore` (`registerCommitAction`, commit-only lane) | ambient — SQL auto-routes to the reserved tx client | the tx connection and its two post-tx lanes |

The two post-tx lanes are NOT interchangeable: `deferPostTransaction` replays after COMMIT **and** ROLLBACK (idempotent cache clears only); `registerCommitAction` runs only after COMMIT, discarded on ROLLBACK — the lane for deferred writes (the observer cascade depends on it).

Other, narrower ALS scopes exist (grep `new AsyncLocalStorage` in `src/`): the read-scoped row memo (`src/core/db/record_memo.ts`, opened by `readSection` only), the query tap (`query_tap.ts`), revocation suppression (`security/revocation.ts`), the Time Machine read scope (`section/list_definitions/tm_scope_context.ts`), and the media job abort signal (`media/job_scope.ts`). Same rule for all: state lives in the scope, never in a module binding.

The request entry point (`dispatchRqo` in `core/api/dispatch.ts`) seeds lang and context; everything downstream reads them ambiently. Interface/data language is **per-request**, not static config.

---

## RULE 1 — No module-level mutable state carrying request/principal/lang values

Never declare a module-scope `let` / `Map` / `Set` / mutated object that holds a value derived from *who is asking* or *in what language*. It bleeds: request B is served request A's interface language, principal, or cached rows because they share the one process.

- **Why it exists:** S1-12 / S1-13 were *reproduced* cross-request bleed — one user's lang / principal leaking to another. Not theoretical.
- **What breaks without it:** a concurrent second request reads the first request's leftover — wrong language rendered, wrong user's data served, wrong actor stamped.
- **Tripwire:** `test/unit/module_state_tripwire.test.ts` (census over `src/` + `tools/`). It flags every module-level `let`/`var`, `new (Weak)?Map/Set` outside `cache_factory.ts`, and self-mutated `const` object/array literals, each against its allowlist (`ALLOWLISTED_MODULE_LET`, `ALLOWLISTED_MODULE_MAPSET`, `ALLOWLISTED_MODULE_CONST` — every entry a genuine *process-lifetime* latch with a written lifecycle justification: who clears it, and when). A new module Map/Set fails CI unless it goes through the factory (Rule 3) or earns an allowlist entry. It also fails on a stale allowlist entry, on capturing a request-scoped accessor into a module binding, and on any `config.menu` lang read outside `src/config/` (the S2-11 / P0-7 class).

Process-lifetime, request-INDEPENDENT state (frozen dispatch tables → type them `ReadonlyMap`/`ReadonlySet`; ops registries; the event channels themselves) is fine — that's what the allowlists are for. Request-DEPENDENT state is never fine.

---

## RULE 2 — The ALS backstop foot-gun: never read `current*()` outside request scope

`currentApplicationLang()` falls back to `config.menu.applicationLang` and `currentDataLang()` to `config.lang.dataLangDefault` (DATA-01) when the store is empty; `currentPrincipal()` returns **`undefined`** outside a request. These backstops are deliberate — but they turn "no request scope" into a *silent wrong answer*, not an error.

You lose the store whenever you leave the request's async flow: a module-level `.then()`, a scheduler tick, a timer armed at boot. Read `current*()` there and you silently get the DEFAULT, not the caller's value.

- **Why it exists:** S1-16 — the activity log (`logActivity`, section dd542) recorded actor `user -1` because the write ran outside request scope and `currentPrincipal()` backstopped. Wrong-actor audit rows.
- **Two hard sub-rules:**
  1. **Never call `current*()` inside a cache-key builder.** The value's lang/principal dimension must be an explicit function argument (see Rule 4 keying), or the key silently defaults and you serve one lang's cache to every lang.
  2. **Never default identity to a constant on a write or audit path.** Thread the principal explicitly; if it's absent, fail loud — don't stamp a placeholder.

`currentPrincipal()` is documented in-code as a **backstop — prefer the explicitly-threaded `principal` parameter** wherever a call site has one. Follow that.

---

## RULE 3 — Build every cache through the factory, never a hand-rolled Map

Create module-level caches only via `src/core/ontology/cache_factory.ts`:

- `createOntologyCache<K,V>()` — content derived from `dd_ontology`. Registers with the invalidation hub (`ontology/cache_invalidation.ts`) at construction: **every dd_ontology write clears it**.
- `createDataCache<K,V>(onSectionData)` — content derived from matrix **record data**. Registers with the save/delete event channel (`src/core/section_record/save_event.ts`): after every persistent write/delete, your callback evicts what derived from that section tipo.

A cache is invalidation-wired **by construction** — the module cannot forget to register, because registration happens inside the constructor before the Map is handed out.

- **Why it exists:** S1-09 — ≥16 of ~20 hand-rolled caches were never registered with the hub, so they served **stale data after an edit** (S1-10 / S1-11 defect class). "Modules remember to register" was proven a nonviable convention.
- **What breaks without it:** you edit a record / ontology node, but reads keep returning the pre-edit value until the process restarts.
- A cache that is BOTH ontology- and data-derived (e.g. datalist option lists — shape from ontology, values from target records) is made with `createOntologyCache` and *additionally* wires its own `registerSectionDataListener` (pattern: `relations/datalist.ts`).
- Keep exporting your named `clearXxxCache` too — deliberate redundancy; it's the module's public invalidation API. Double-clearing a Map is free.
- Invalidation is COMPLETE in-process because this engine is the sole writer: every ontology/registry/record write flows through the two channels. Only an out-of-band DB write (manual psql surgery) needs a server restart (`cache_factory.ts` header, "SINGLE-WRITER SEMANTICS").

---

## RULE 4 — Key a cache by EVERY dimension its value depends on

The value depends on `tipo` **AND** lang **AND** (where relevant) principal/project — put all of them in the key. A cache keyed only by tipo serves lang A's value to a lang B request: same bleed as Rule 1, just laundered through a Map. And per Rule 2, the lang/principal dimension must arrive as an explicit argument, never via a `current*()` call inside the key builder. Behavioural proof: `test/unit/concurrency_interleave.test.ts`.

---

## RULE 5 — No in-transaction seeding of shared caches

A cache populated *inside* an open transaction must not persist rows into a process-shared cache (S1-14): the tx may have written them, and a concurrent request would read state that might ROLLBACK. The resolver's writers skip the store when `isInTransaction()` (`resolver.ts` `cacheWrite` / `cacheSet`) — the read itself stays correct on the tx connection; pre-tx cache hits are still served. Inside a tx the hub's cache drop is **deferred** via `deferPostTransaction` and replays after COMMIT **and** ROLLBACK (over-invalidation is harmless; a skipped replay is not). Don't defeat it by writing your own mid-tx cache population.

When a derived value is expensive and needed repeatedly within one tx, use the **tx-scoped memo** `getTransactionMemo()` (`postgres.ts`) — it dies with the transaction, so nothing uncommitted crosses the tx boundary (the observer subscription registry uses it). The `<tld>0` matrix-table short-circuit in `resolver.ts` (hierarchy provisioning) is tipo-derived and cache-independent, so it never needs a mid-tx cache at all.

---

## RULE 6 — Background executors: know which stores they keep

- **Media jobs** (`MediaJobManager.submit`, `src/core/media/jobs.ts`) start every worker through `runDetachedFromTransaction`, which EXITS the three transaction-side stores (tx handle, deferred queue, commit lane) — the request's tx handle expires long before a transcode ends (S2-14). The request-lang and request-context stores are **NOT inherited**: `submit()` PINS the submitter's langs and a job-owned request context (principal snapshot, `session: null`, own `requestId` `job:<id>` and `frontierRefusals`, the submitter's `clientIp`) and `runWorker` enters them around the worker, whatever scope calls it (`JobRunScope`; `engineering/REQUEST_ISOLATION.md` rule 3; gate `test/unit/media_jobs_reconcile.test.ts`). A handler reads `currentApplicationLang()`/`currentDataLang()` ambiently and gets the submitter's. Limits: the principal is a submit-time snapshot (re-resolve it yourself if a long job must decide AS OF NOW), and an `EventEmitter` listener runs in the EMITTER's scope — no pin reaches it. It is the ONE legal caller of the escape hatch — never use it to "avoid holding the transaction" around ordinary work; the importer set is frozen by `module_state_tripwire`.
- **Timer/scheduler work** (the diffusion scheduler, boot-armed sweepers) runs with NO request scope: every `current*()` returns the backstop. Decide the lang and principal and **thread them explicitly**, or open a scope yourself (diffusion export opens `runWithRequestLangs` per cell in `src/diffusion/export/atoms.ts`). Diffusion lang sets come from the diffusion configuration (bounded by the project's langs — `plan/compile.ts` flags `langsOutsideProject`), never from a request's single dataLang.
- `withTransaction` does not cross an unawaited timer/promise boundary — start async work *inside* the awaited callback or the tx handle is already expired (a query then throws the S2-14 error).

---

## Working checklist

- Adding module state? → route through `cache_factory.ts` or justify an allowlist entry; run `bun test test/unit/module_state_tripwire.test.ts`.
- Reading `current*()`? → confirm you are inside a request (or an explicitly opened scope), and NOT inside a cache-key builder or a write/audit identity slot.
- New cache? → factory-constructed, keyed by all of {tipo, lang, principal/project}, named clearer exported.
- Background job? → a `mediaJobs.submit` worker runs under the job manager's pin (submitter's langs + principal snapshot, null session, own request id/refusals — Rule 6); timer/scheduler work has NO scope: thread lang + principal explicitly there.
- Out-of-band psql surgery on dd_ontology or records? → restart the server (in-process invalidation cannot see it).

## See also

- **`engineering/REQUEST_ISOLATION.md`** — the authoritative ALS/isolation model.
- **`engineering/TRIPWIRES.md`** — the tripwire index.
- **`engineering/CONVENTIONS.md`** — error handling (§1), dynamic imports (§2).
- Sibling skills: `dedalo-ts-ops-config` (readEnv is the only env reader — `src/config/env.ts`; typed catalog `src/config/config.ts`; no `process.env` outside `src/config/`, tripwired by `config_env_tripwire.test.ts`), `dedalo-ts-write-path` (the transaction lanes from the write side), `dedalo-relations-ts` / `dedalo-section-family-ts` (cache-heavy consumers of these rules).
