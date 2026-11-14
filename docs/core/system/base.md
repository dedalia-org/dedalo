# Bootstrap

> See also: [Architecture overview](../architecture_overview.md) ·
> [Sections](../sections/index.md) · [Components](../components/index.md) ·
> [The engine layer](common.md)

How the Dédalo server starts: the config catalog, the module graph, the component
registry and the process entry point. There is no loader, no autoloader and no
boot ritual — starting the server is a plain module load.

## Role

Booting is three things, in order:

1. **Config.** `src/config/env.ts` reads `../private/.env`; `src/config/config.ts`
   builds the frozen, typed config catalog once at import. A missing required key
   throws at boot — a misconfigured server refuses to start rather than failing
   at the first request.
2. **The module graph.** Every symbol is reached by an explicit `import`. The
   dependency order *is* the import graph, resolved statically at load. A missing
   symbol is a load error, not a runtime resolution miss.
3. **The process entry.** `src/server.ts` runs `Bun.serve` on a **unix socket** —
   the reverse proxy owns TCP — and creates a per-request `RequestContext`.

```text
bun src/server.ts
 ├─ import src/config/config.ts
 │    └─ import src/config/env.ts   → read ../private/.env (requireEnv throws on a missing key)
 │       → build + freeze the config catalog once
 ├─ import src/core/…               (the module graph resolves statically as files are imported)
 │    └─ src/core/components/registry.ts runs its load-time integrity check
 ├─ initRagHooks()                  → wire the AI/RAG hooks
 └─ Bun.serve({ unix: config.server.unixSocketPath, fetch: handleRequest })
```

!!! warning "The module graph cannot be redirected at runtime"
    There is no name→path resolver and no dynamic include. A compromised config
    value cannot make the server load a different module: the graph is static.
    This removes an entire class of attack surface rather than guarding it.

## Files & structure

The bootstrap-adjacent files are few:

```text
src/
├── config/
│   ├── env.ts        # ../private/.env loader (readEnv / requireEnv)
│   └── config.ts     # the frozen typed config catalog (built once at import)
├── server.ts         # Bun.serve entry (unix socket) + per-request RequestContext
└── core/
    └── components/
        └── registry.ts   # model → descriptor map
```

!!! warning "Configuration has exactly one door"
    `src/config/config.ts` is the only module the rest of the codebase reads
    configuration from. **Nothing else may touch `process.env` or the `.env` file
    directly** — a tripwire fails the build on any `process.env.` outside
    `src/config/`. `../private/.env` is append-only: documented keys only.

    Secrets and per-instance settings live *outside* the web root, in a sibling
    `private/` directory.

## The registry

"Given a model, find its behavior" is answered by the **component registry**, not
by a class lookup:

- every component model lives in
  `src/core/components/component_<model>/descriptor.ts` and is imported and listed
  once in `src/core/components/registry.ts`;
- `getComponentModel(model)` returns the descriptor — `column`,
  `classSupportsTranslation`, `resolveData`, `search`, `alias`, … — that the
  horizontal engines read;
- the registry build runs **at import** and **throws** on a duplicate model, or on
  an alias pointing at a model that does not exist or stores nothing.

A broken registry is therefore a boot failure, not a surprise on some request in
production three weeks later.

Tools and diffusion resolve through their own registries and serving layers
(`src/core/tools/`, `src/diffusion/api/`), not through a shared loader.

## The surface

### Config — `src/config/env.ts`, `src/config/config.ts`

| symbol | purpose |
| --- | --- |
| `readEnv(key, fallback?)` | Read one env value (process env wins over `../private/.env`, then the fallback). |
| `requireEnv(key)` | Like `readEnv`, but throws a clear boot-time error when the key is missing or empty. |
| `config` | The frozen `DedaloConfig` catalog (db, server, menu, tools, media, …), built once at import. |

### Registry — `src/core/components/registry.ts`

| symbol | purpose |
| --- | --- |
| `getComponentModel(model)` | The descriptor for a component model (`undefined` for a non-component model). |
| `allComponentModels()` | Every registered descriptor. |

### Process entry — `src/server.ts`

| symbol | purpose |
| --- | --- |
| `handleRequest(request, context)` | Route one request: health, media, API, raw/environment views, client assets. It is a plain function, so tests call it without a socket. |
| `RequestContext` | Per-request state (`requestId`, `startedAt`), created per request and threaded explicitly. |

## Error handling

There are no global error, exception or shutdown handlers. Instead:

- the API dispatch layer (`src/core/api/dispatch.ts`) wraps handler execution and
  returns the standard `{result, msg, …}` JSON envelope on a failure;
- audit writes (`src/core/api/handlers/activity_log.ts`) catch and log their own
  failures, so an audit write can never break the user's action;
- an uncaught throw surfaces through Bun's normal process error path.

## Caching

The server is one long-lived process. The few module-level caches — ontology
nodes, structure-context cores, permission tables — hold **request-invariant**
content and carry no request identity. Request-scoped state lives in
`AsyncLocalStorage` and dies with the request. See
[the engine layer](common.md#caches-and-why-there-is-no-per-request-reset).

## Host and environment reporting

Two narrow surfaces report the runtime to the client, and only what the client
needs:

- `src/core/api/handlers/system_info.ts` — the upload-limit numbers (temp dir, max
  size, chunk size, OCR-engine presence) the upload and import services read;
- `src/core/api/environment_view.ts` — the developer environment view.

## How it fits with the rest of Dédalo

- **config → everything.** A boot failure here refuses to start the server.
- **registry → the engine layer.** `components/registry.ts` is read by the
  horizontal engines ([the engine layer](common.md)):
  `getColumnNameByModel` / `getModelByTipo` in `ontology/resolver.ts`, the relation
  dispatch in `relations/registry.ts`, and the datum emitter in `section/read.ts`.
- **server.ts → the API.** `handleRequest` routes API traffic into
  `src/core/api/dispatch.ts` and its security gates, and serves the client assets.

## Examples

### Read a required config value at boot

```ts
import { requireEnv, readEnv } from './config/env.ts';

const dbName = requireEnv('DB_NAME');              // throws at boot if unset
const port   = Number(readEnv('DB_PORT', '5432')); // fallback when unset
```

### Resolve a component model's behavior

```ts
import { getComponentModel } from './core/components/registry.ts';

const descriptor = getComponentModel('component_input_text');
descriptor?.column;                    // 'string' — the matrix column it stores in
descriptor?.classSupportsTranslation;  // true
```

### The process entry, testable without a socket

```ts
import { handleRequest } from './server.ts';

const context = { requestId: crypto.randomUUID(), startedAt: performance.now() };
const response = await handleRequest(new Request('http://x/health'), context);
```

## Related

- [Architecture overview](../architecture_overview.md) — the whole-system map.
- [The engine layer](common.md) — where the per-element machinery lives.
- [Components](../components/index.md) — the field models the registry maps to
  descriptors.
- [Sections](../sections/index.md) · [section](../sections/section.md) — the table
  abstraction resolved above the config/registry bootstrap.
- [Glossary](../../understanding/glossary.md) — nomenclature (tipo, entity, section_tipo, …).
