# Tools server contract

The contract every tool's server package must follow. Reference implementation: `tools/tool_dev_template/server/index.ts` (+ its handlers). Machinery: `src/core/tools/{module,dispatch,security,loader,paths,config,register,background,cache}.ts`. Concept spec: `engineering/TOOLS_SPEC.md`.

A tool's server module is discovered once by an allowlisted directory scan (`loader.ts`), and its actions are typed functions keyed in a plain object (`apiActions`) — "the method exists and is callable" is a `Map`/`Object.hasOwn` lookup, not a reflection check. There is no base class and no autoloader: dispatch runs an ordered gate chain (registry → per-user authorization → loaded module → `apiActions` lookup → declarative permission → execute) entirely against typed data.

## The module

- File `server/index.ts` in the tool root — never served to the browser (`serving.ts` refuses the whole `server/` subtree).
- Exports `const tool: ToolServerModule` (`src/core/tools/module.ts`):

```ts
interface ToolServerModule {
  name: string;                                // must equal the directory name, ^tool_[a-z0-9_]+$
  apiActions: Record<string, ToolActionSpec>;   // the remote surface
  backgroundRunnable?: readonly string[];       // second allowlist for async execution
  reasonKeys?: Readonly<Record<string, string>>; // closed map: refusal reason key → its English fallback sentence — NOT an action
  isAvailable?: (context) => boolean | Promise<boolean>;  // toolbar availability
  onRegister?: () => Promise<void>;             // lifecycle hook — NEVER inside apiActions
  onRemove?: () => Promise<void>;               // lifecycle hook — NEVER inside apiActions
  httpRoutes?: readonly ToolHttpRoute[];        // GET routes outside dd_tools_api (file downloads)
  onBoot?: () => ToolBootHandle | undefined;    // boot timer; the handle is stopped on shutdown
}
```

- The loader validates this contract at scan time (`loader.ts::validateToolModule`): `tool.name` must equal the directory name and match the tool-name pattern; `apiActions` must be an object; none of the reserved lifecycle keys (`isAvailable`/`onRegister`/`onRemove`/`onBoot`/`httpRoutes`) may appear inside it; every action's `handler` must be a function; `onBoot` must be a function and every `httpRoutes` entry must pass the route rules below. A tool that fails validation logs a warning and is simply absent from the registry — it never aborts the whole scan.
- `reasonKeys` declares the closed set of reasons the tool may put on a refusal (`details.reason_key`), each with the English fallback sentence it rides with: `{ bad_bbox: 'The bounding box is not numeric.' }`. Each key matches `^[a-z][a-z0-9_]{0,47}$` and each sentence is a non-empty string of at most 200 characters with no control, line-separator or invisible formatting character (a bidi override, a zero-width space), or the tool is refused at load. The loader serves the tool through `admitToolModule`, which wraps every action handler, `admit` hook and route: a key outside the map, a code that does not carry the key, or a sentence other than the declared one becomes `internal.invariant`, whether the refusal is thrown or is a failure envelope the handler returns. A refusal throws the key **without** a `publicMessage`; the wrapper puts the declared sentence on it, so nothing a request or an upstream produced can reach the field the browser prints as it arrives. The wrapper keeps the function you wrote reachable (`unguarded(fn)` in `src/core/tools/reason_keys.ts`) for gates that read a served handler. A refusal you embed in an answer instead of throwing it is built with `toolErrorBody(tool, action, error)` (which also logs a refusal it replaces), and a tool that declares `reasonKeys` names none of the converter's body builders (`toErrorBody`, `toErrorEnvelope`, `toStructuredErr`, `toFailureRecord`, `toStreamFrame`). The translated sentence for each key is the tool's `register.json` label `reason_<key>` — see [A tool's refusal reason](../../core/system/errors.md#a-tools-refusal-reason). One code is retryable, `tool.source_unavailable`: refuse with it from a [read-only action](#read-only-actions-readonly-true), because the transport resends a retryable error from a mutating one and the resend is answered `idempotency.outcome_unknown`, hiding your reason.
- Server logic imports `src/core/**` via relative paths. The dependency points tool → core: everything a tool offers the engine (actions, lanes, routes, boot timers) is registered through this module, and new engine code must not import a tool or name one. This is a ratchet, not yet an absolute rule: `test/unit/core_tool_edge_tripwire.test.ts` derives every `src/` → `tools/tool_*` import (static, re-export or dynamic) and every tool name that appears in `src/` code or string literals, and holds both to shrink-only ledgers. One import edge remains today: `src/core/tools/transcription_asr.ts` uses the transcription tool's shared paragraph builder. A small number of files also still name a specific tool, for example the export grid's gate coordinates. A new edge, or a new name occurrence, fails the gate.

## Remotely callable methods (API actions)

Every entry in `apiActions` is a `ToolActionSpec`:

```ts
interface ToolActionSpec {
  permission: 'section' | 'section_list' | 'targets' | 'tipo' | 'record' | 'record_tipo' | 'developer' | null;
  minLevel?: number;   // dd774 level: 1=read, 2=write (default), 3=admin
  sectionTipos?: (options) => unknown[];   // REQUIRED for 'section_list'
  targets?: (options) => WriteTarget[];    // REQUIRED for 'targets'
  readOnly?: true;     // the action writes nothing — see "Read-only actions"
  handler: (context: ToolActionContext) => Promise<ToolResponse>;
}
interface WriteTarget { section_tipo: unknown; tipo?: unknown; section_id?: unknown }
```

`handler` receives `{ principal, userId, options, background, publishProgress?, clientIp? }` and returns a `ToolResponse`, which **replaces the API envelope wholesale**. So a `ToolResponse` **is** the API envelope: build it with `ok(data, …)`, and add the extra top-level fields the client reads by name (a streaming body, a job id, a per-item report) as `extend`.

**To fail, throw — never build a failure body.** A thrown `DedaloError` carries a registered code from the closed set, and the tools dispatcher converts it into the standard error envelope with the status that code's category implies. There is no `failed()` helper and no `'Error. Request failed.'` prefix any more.

```ts
handler: async ({ options, principal }) => {
  const target = String(options.target ?? '');
  if (target === '') throw new DedaloError('tool.invalid_target');          // → 400
  const report = await runTheWork(target, principal);                        // may throw its own code
  return ok({ processed: report.done, failures: report.failures }, { extend: { job_id: report.jobId } });
}
```

Note where the per-item failures went: **inside `data`**. A run that processed 117 records and could not process 3 is a SUCCESS with a report — `ok: false` is reserved for "this run did not happen". The same rule as elsewhere in the engine: `ok` describes the request, not the quality of every row it touched. See [the API reference](../../api/dedalo_api_v1.md#response-envelope) for the envelope's full field list.

Two of those fields are optional and carry a caveat:

| field | when it is present |
| --- | --- |
| `publishProgress` | Background execution only — a foreground call has no job record to publish into. |
| `clientIp` | The proxy-validated client address, for an action that appends an [activity row](../../core/system/logger.md). Under background execution it is the value captured at **submit** time: the job outlives the request that started it, so there is no live socket to ask. |

Pass `clientIp` through `hostFromClientIp` rather than deriving the host rule yourself.

### The request envelope

The client sends this (built by the JS helper `this.tool_request()`):

``` json
{
	"dd_api": "dd_tools_api",
	"action": "tool_request",
	"source": { "model": "tool_x", "action": "my_method", "...": "..." },
	"options": { "section_tipo": "oh1", "section_id": 5, "...": "..." }
}
```

`dispatchToolRequest` (`src/core/tools/dispatch.ts`, called from `dd_tools_api.tool_request` in `src/core/api/dispatch.ts`) runs this gate chain, in order:

1. `options` must be an object (or absent);
2. the tool name must match `^tool_[a-z0-9_]+$` — rejected before any lookup;
3. + 4. the tool must be **ACTIVE** in dd1324 **and** authorized for the calling user (`getUserTools` in `registry.ts`: admins get every active tool; others the profile-granted dd1067 set + `always_active` dd1601 tools);
5. the tool must have a **loaded server module** (`getLoadedTool`);
6. the method must be a key of the module's `apiActions` (`resolveAction`, the allowlist lookup);
7. the action's declarative permission gate must pass (`assertActionPermission`) — **before** any background fork;
8. execute: directly, or (when `options.background_running === true`) via `scheduleBackground`, which additionally enforces the `backgroundRunnable` allowlist.

## Permission kinds (`src/core/tools/security.ts`)

| `permission` | Reads from `options` | Asserts |
| --- | --- | --- |
| `section` | `section_tipo` | permission level ≥ `minLevel` on `(section_tipo, section_tipo)` |
| `tipo` | `section_tipo` + `tipo` | permission level ≥ `minLevel` on `(section_tipo, tipo)` |
| `record` | `section_tipo` + numeric `section_id` | the `tipo`-equivalent section-level check **plus** the record must be inside the caller's project scope (global admins skip this) |
| `record_tipo` | `section_tipo` + `tipo` (alias `component_tipo`) + numeric `section_id` | the `(section_tipo, tipo)` PAIR **plus** the record scope — the gate for a component OF a record |
| `section_list` | whatever `sectionTipos(options)` returns | level ≥ `minLevel` on every returned section; an empty list or an invalid entry is a denial |
| `targets` | whatever `targets(options)` returns | level ≥ `minLevel` on every `(section_tipo, tipo?)` — the PAIR when `tipo` is named — and, when `section_id` is named, a positive record inside the caller's scope; an empty list, a malformed entry or a throwing extractor is a denial |
| `developer` | — | `principal.isDeveloper` |
| `null` | — | always passes here — the handler gates imperatively (defense in depth), e.g. `tool_export`'s `get_export_grid` (which must additionally assert read on every SQO target the grid touches, something the declarative gate cannot express) |

`minLevel` defaults to `2` (write) when omitted. A missing or ill-typed required option field (e.g. no `section_tipo` for a `tipo` gate) is a **fail-closed denial**, never a pass — the request never reaches the handler. The dispatcher enforces the declarative spec before the handler runs.

**Declare the gate on the target the action WRITES.** When the effect target is not a top-level option — the scope rides in `options.sqo` (`tool_update_cache::update_cache` re-saves the selected components on every matched row), in a nested client map (`tool_import_files` writes into every `tool_config.ddo_map` destination), or the handler pins a section by constant (`tool_hierarchy` writes `hierarchy1/<section_id>` whatever `section_tipo` arrives) — use `targets` and derive the write targets **off the same keys the handler reads**. A `section`/`tipo` gate on a sibling field authorizes something the action never touches and leaves what it does touch ungated. A target the handler can only resolve at run time — an ontology-derived portal section, or a RECORD it binds while running (a filename prefix, a matcher hit, a role write's destination) — is authorized inside the handler at the point it is bound, before the first write into it, through the save door's own record-scope rule (`assertRecordWriteTarget`); a record created in the same run is admitted as a create is. `test/unit/action_scope_binding_tripwire.test.ts` binds every such handler to its extractor; `permission: null` remains the named exemption for an action no declarative kind can express, and it must say in `gatedInHandler` what the handler does instead.

!!! warning "Never list lifecycle hooks"
    `isAvailable`, `onRegister`, `onRemove`, `onBoot` and `httpRoutes` are called by the framework, not remotely. `loader.ts` throws (refusing to load the tool) if any of them appears as a key of `apiActions`.

## Background execution

Long-running actions can run detached: the client passes `options.background_running = true`. Bun's server is a **persistent process**, so `scheduleBackground` (`src/core/tools/background.ts`) runs the handler as a fire-and-forget promise plus an in-process job record — it returns an `ok` envelope with the job id as an extension key immediately and runs the handler afterwards, capturing the outcome on the job record (`getBackgroundJob(id)`).

The method must ALSO be listed in the module's `backgroundRunnable`:

```ts
backgroundRunnable: ['my_long_method'],
```

The declarative permission gate already ran (step 7 above) **before** the background fork, so unauthorized callers are refused observably, not silently queued. The background executor does not re-run the per-action gate; keep imperative asserts inside long-running write handlers as defense in depth (see `tool_propagate_component_data`'s handler, which re-derives its own gate because the target is SQO-wide, not a single record).

!!! note "Ledgered (engineering/TOOLS_SPEC.md)"
    Background jobs die on server restart — the in-process job table does not survive a Bun restart — and a CPU-bound handler currently shares the event loop with every other request. A Bun `Worker`-based executor is a drop-in follow-up behind the same `scheduleBackground` signature.

## Read-only actions (`readOnly: true`)

An action that writes nothing declares it, next to its permission:

```ts
lookup: {
  permission: 'section',
  minLevel: 1,            // required: the gated default is 2 (write)
  readOnly: true,
  handler: lookupPlace,
},
```

`readOnly: true` is a **claim** the framework acts on, so it is narrow: executing the action twice leaves the same end state. It **may** call an external service — that is the usual reason to declare it. Absent means mutating, which is the safe default.

The claim is your attestation. The framework checks the doors it can name — no record write (including the per-component item-id counters), no Time Machine row, no activity row, no job — and nothing else. It does **not** check media files, a directly spawned `psql` child, writes to other stores (user stats, locks, queues, the ontology, the derived search tables) or a streamed response body: a read-only action must not touch them, and nothing refuses it if it does.

What the declaration changes:

- **No idempotency ledger.** The browser transport stamps every request it may resend with an idempotency key, and the server executes a stamped request once and replays its answer. For a mutating action that is the protection against a duplicate record. For an action that cannot have written anything it only does harm: a handler that throws (an upstream `external.http_status`) leaves an *ambiguous* reservation, the transport retries the retryable error under the same key, and the retry is answered `idempotency.outcome_unknown` — hiding the real error. A read-only action is never ledgered, so every attempt re-executes and answers its own outcome. The server decides this from the **loaded module's** declaration, never from the client, and any doubt (unknown tool or action, a background request, a caller the tool is not granted to) keeps the request ledgered.
- **A read-only request scope.** The handler runs inside `runReadOnly` (`src/core/security/read_only_scope.ts`). Every door that writes a record, an item-id counter, a history row, an activity row or a job (`matrix_write.ts`, `time_machine.ts`, the job manager's `submit`) refuses there with `internal.invariant` — a wrong declaration fails loudly instead of skipping the ledger for a writer. One refusal is quiet: the activity log's writer (`logActivity`) never throws, by design (an audit write must not fail the user's action), so inside the scope the row is dropped and the refusal is a line in the server log. A read-only action that logs activity is therefore not failed at runtime; the static check below is what names it.

What the loader enforces (`validateToolModule`; a violation keeps the tool out of the registry, like any contract breach): only the literal `true` is accepted; the action may not be in `backgroundRunnable` (a job is a write, and a request that asks for background execution is never classified read-only); and a level-gated action must declare `minLevel: 1` explicitly — exactly 1: `0`, a negative number or `NaN` would pass the level comparison for every caller and leave the action with no level gate at all.

`test/unit/tool_read_only_action_tripwire.test.ts` proves the claim statically: the action's own entry in `tool.apiActions` — **declare it as a literal key**, the walk cannot see an action built elsewhere — must not reach a raw matrix write, an off-home psql writer, the activity (including `logActivity`), item-counter or Time Machine writers or the job manager through any import-resolved path.

!!! warning "A read-only action is never replayed"
    A stalled call can reach the provider more than once, and the transport's own resend would re-execute the action up to five times. The tool's browser code therefore calls a read-only action through `this.tool_request()` with the literal `retries: 1` (and a longer `timeout` if the provider is slow): with `retries: 1` the transport sends once, stamps no key and never resends. `test/unit/client_idempotency_tripwire.test.ts` checks this in the source of every tool that declares a read-only action. It reads each `tool_request(` call's own properties (a `retries` nested inside `options` does not count, and a spread after the properties could replace them); a call of a read-only action must spell `retries: 1`; a call whose `action` is not a string literal must spell it too; and such a tool may not build the `dd_tools_api` request by hand (the older `create_source` plus `data_manager.request` shape) nor use `tool_request` as a value (`.call`, `.bind`, an alias), because the check cannot follow where those end up. It is a check of source text: a read-only action requested by another tool's code, or by the core client, is not covered. Pacing a third-party service (a minimum interval, a concurrency cap) belongs to the service module the action calls, not to the transport's retry loop.

## Fetching from other sites (`src/core/harvest/harvest.ts`)

A tool that reads another institution's site (an auction catalogue, a journal's OAI endpoint, a publisher's PDF) fetches through `harvestFetch`, never through `fetch` itself. A bare `fetch` in a tool fails `ssrf_one_guard_tripwire`.

```ts
import { harvestFetch } from '../../../src/core/harvest/harvest.ts';

const page = await harvestFetch({
  url: lotUrl,
  hosts: ['example.org'],           // or 'public' for a URL the cataloguer pasted
  headers: { Accept: 'text/html' },
  onWait: (ms, origin) => reportProgress(`waiting ${Math.round(ms / 1000)} s for ${origin}`),
});
if (!page.ok) {
  // a 404 lot or a 403 bot wall: page.status says which — report it, don't retry blindly
}
const html = page.text();           // decoded in the charset the site declared

const scan = await harvestFetch({
  url: imageUrl,
  hosts: ['example.org'],
  expectContentType: ['image/'],    // a 200 HTML error page is refused before it is downloaded
  maxBytes: 50 * 1024 * 1024,
});
```

### What the door does on every hop

A redirect is a new request, and each hop of a redirect chain goes through the whole policy again. For each one, the door:

- accepts http(s) only, with no user name or password in the URL, and never a switch from https to http. With `requireHttps: true`, it accepts https only, the first hop included;
- applies your host policy: `'public'`, or a list of sites. A name entry also admits its subdomains (`example.org` admits `lots.example.org`). An IP entry admits only that address; write an IPv6 address bracketed or bare. An entry is a host only: with a port or a path it is a programming error;
- asks the site's `robots.txt` (RFC 9309) and obeys it — for every request: a page, an image, a PDF or a POST alike;
- waits for the site's turn (see below);
- checks that every address the host resolves to is public, and connects to the address it checked, not to a second lookup of the name;
- follows at most 5 redirects; a sixth is refused.

`robots.txt` is read once per origin and remembered for an hour. What it answers decides:

| `robots.txt` answer | Meaning |
| --- | --- |
| 2xx | its rules apply, to the group that names `dedalo` (any case, `dedalo/7` included), else to `*` |
| 4xx, including a missing file | everything is allowed |
| 5xx, 429, a timeout, a network failure, or a 3xx the door does not follow (one with no `Location`, or a 300, 304 or 305) | nothing is allowed: `harvest.robots_unavailable`, asked again after 5 minutes |
| more than 5 redirects | everything is allowed (RFC 9309 treats it like a missing file) |
| a redirect the door refuses (https to http, a user name or password, a URL that is too long or not a URL) | nothing is allowed: `harvest.refused`, reason `robots_redirect_refused`, remembered for the hour — the same redirect is refused every time |
| more than 4096 rules for us, or a rule longer than 2048 characters | nothing is allowed: `harvest.refused`, reason `robots_too_complex`. These two limits are stricter than RFC 9309, which asks a reader to parse at least 500 KiB: a short file of 4097 rules is refused. Within them, any file up to 512 KiB is obeyed as written, in any script |

A `robots.txt` larger than 512 KiB is read up to that size and the rest is ignored. Redirects of the `robots.txt` request are followed to other hosts too, still address-checked, and the answer applies to the site you asked for. A path is judged both as sent and with repeated `/` collapsed and `;parameters` removed, each of those also with a literal `*` and `$` written `%2A` and `%24` (so `Disallow: /file-%2A.html` covers `/file-*.html`), and each form both as encoded and with percent-encoded reserved characters (`%3A`, `%2F`, …) decoded; if any form is disallowed, the request is refused. A rule and a path are compared in one percent-encoding, so `Disallow: /Collections Online/` also covers the `/Collections%20Online/` a browser sends, and `/%70rivate` is `/private`. A `robots.txt` that is not UTF-8 (an older site's Latin-1 file) is read byte by byte, so `Disallow: /café` written in Latin-1 still covers the `/caf%E9` that site's links send. Before any rule is matched, the work that judging the path would cost (the rules with a `*`, times the length of every form) is weighed; past a fixed bound the request is refused with `harvest.refused`, reason `robots_too_complex`, and no rule is matched. No real site comes near it.

### The pace

The door sends one request at a time per **origin** — scheme, host and port, so `example.org` and `www.example.org` are paced separately, while `example.org.` (with the trailing dot) is the same server as `example.org` and shares its pace and its `robots.txt`. The pace belongs to the installation, not to your job: every user and every job share it, because the remote site sees one Dédalo. A request holds the origin's turn until its whole body has arrived, and the next one starts at least 3 seconds after it ended. A site's `Crawl-delay` lengthens that interval, up to 60 seconds. A `429` or `503` answer with `Retry-After` makes the next request to that origin wait that long, also capped at 60 seconds. Each redirect hop is a request of its own and takes its own turn.

`onWait(ms, origin)` is called before each wait. While your request is queued behind another one to the same origin, `ms` is the least that wait can last; once the pause is known, `ms` is the pause. Stopping the background job ends any of these waits at once. An `onWait` that throws is logged and ignored: the wait goes on, and the origin's queue is never held up by it.

### Limits

| Option | Default | Ceiling | Meaning |
| --- | --- | --- | --- |
| `maxBytes` | 20 MiB | 100 MiB | the body, counted as it streams; past it, `harvest.too_large` |
| `timeoutMs` | 120 s | 10 min | the TOTAL time of one hop: connecting, headers and the whole body |
| `idleTimeoutMs` | 30 s | `timeoutMs` | how long the body may stall without a byte before the site is dropped |

A value above its ceiling is lowered to the ceiling. A value that is not a positive number (`0`, `NaN`, `Infinity`) is a programming error (`internal.invariant`). So a 100 MiB PDF can arrive over a slow link within 10 minutes, while a site that stops sending is dropped after 30 seconds.

### The request

- `method` is `GET` or `POST`. A `body` needs `POST`. A `URLSearchParams` body is sent as a form (`application/x-www-form-urlencoded`) unless you set a `Content-Type`.
- A `301` or `302` turns a `POST` into a `GET` without a body, as browsers do; `303` always does; `307` and `308` keep the method and the body.
- Of the headers, you may set only `Accept`, `Accept-Language`, `Content-Type`, `Referer` and `X-Requested-With`. Any other name, `Cookie` and `Authorization` included, is a programming error. The door sends its own `User-Agent` (`dedalo/<version>`, the name `robots.txt` rules are written for). The `robots.txt` request never carries your headers.

### The answer

A non-2xx answer is returned, not thrown: `ok` is `false` and `status` says what happened. The response is:

| Field | Content |
| --- | --- |
| `url` | the URL that finally answered, after redirects |
| `status`, `ok` | the HTTP status; `ok` is true for 200–299 |
| `contentType` | the `Content-Type` header, lower-cased; `''` when absent |
| `headers` | only `cf-mitigated`, `content-disposition`, `content-length`, `content-type`, `etag`, `last-modified` and `retry-after`, when present, keyed in lower case; read-only |
| `bytes` | the body |
| `text()` | the body decoded: the `charset` of the `Content-Type` header first; else, in the first KiB, an XML declaration's `encoding` or an HTML `<meta charset>`; else UTF-8. An unknown charset name falls back to UTF-8 |

With `expectContentType`, a 2xx answer whose media type does not start with one of the listed prefixes is refused before its body is read (`harvest.unexpected_type`). A non-2xx answer is returned as usual.

Recognising a bot-challenge page served with status 200 (the `cf-mitigated` header helps), and deciding what a page means, stay in your tool.

### What it throws

| Code | When | What the user is told |
| --- | --- | --- |
| `harvest.refused` | the URL or a redirect breaks the policy above | the site asked for and the reason: `unparseable`, `protocol`, `credentials`, `url_too_long`, `requires_https`, `downgrade`, `host_not_allowed`, `bad_location`, `too_many_redirects`, `robots_too_complex`, `robots_redirect_refused` |
| `harvest.robots_disallowed` | `robots.txt` disallows the path | the site whose `robots.txt` said no |
| `harvest.robots_unavailable` | `robots.txt` could not be read (retryable) | the site |
| `harvest.too_large` | the body passed `maxBytes` | the site and the limit |
| `harvest.unexpected_type` | `expectContentType` did not match | the site and the media type it sent |
| `security.ssrf_blocked` | an address is not public (private, loopback, DNS failure…) | a fixed sentence only; the address stays in the server log |
| `security.outbound_failed` | a timeout, a stalled body, a network failure, or the job was stopped (retryable) | a fixed sentence only |
| `internal.invariant` | your call is wrong: a header you may not set, a bad limit, a body without `POST`, an allowlist entry that is not a host | a fixed sentence only |

The site named on the wire is the origin you asked for, never a path, a query or credentials, never a resolved address. The exception is every `robots.txt` verdict — `harvest.robots_disallowed`, `harvest.robots_unavailable` and `harvest.refused` with reason `robots_too_complex` or `robots_redirect_refused`: after a redirect they name the site whose `robots.txt` decided, which has already answered from a public address. A URL that does not parse has no site, so `harvest.refused` with reason `unparseable` names the fixed text `(not a web address)`, never what was typed. The addresses the guard refused, and the host a refused redirect pointed at, go to the server log only.

When a tool reports failures per item (one line per lot or per image), put the error system's wire body in the result, never `error.message`. The message is a log field: it can name the address the guard refused.

```ts
import { toDedaloError, toErrorBody } from '../../../src/core/errors/index.ts';

try {
  const page = await harvestFetch({ url, hosts: 'public' });
  results.push({ url, status: page.status });
} catch (error) {
  // { code, category, message, label_key, retryable, details? } — the same text the user would see
  results.push({ url, error: toErrorBody(toDedaloError(error)) });
}
```

A tool that declares [`reasonKeys`](#the-module) builds that body with `toolErrorBody(tool, 'action', error)` instead, so a `reason_key` in it passes the same check as a thrown one.

## Configuration (`src/core/tools/config.ts`)

Three storage points, one accessor set:

| Where | What |
| --- | --- |
| dd1324 / `default_config` (component dd1633) | factory defaults shipped by the tool's register.json |
| dd996 "Tools configuration" section (component dd999) | per-install overrides, edited by admins |
| `properties` (register.json) | UI hints (`open_as`, `windowFeatures`, `events`) |

Resolution helpers:

- `getToolConfig(toolName)` — the whole effective config object; install value wins per key over the register default.
- `getToolConfigValue(toolName, key, fallback)` — **per-key** precedence: install (dd996/dd999) → register default (dd1324/dd1633) → the caller-supplied `fallback`. Preferred for single keys.
- `getToolClientConfig(toolName)` / `getToolClientConfigRaw(toolName)` — only options flagged `"client": true` in either layer, resolved to their effective value (`ClientConfig`) or kept as the full prop definition (`ClientConfigRaw`, used by the tool element context). Everything else never reaches the browser — never put secrets in a `client: true` property.

`invalidateAllToolCaches()` (`src/core/tools/cache.ts`) is the single entry point clearing the registry reader, both config caches, the paths memo and the loaded-tools registry; call it (or trigger the "Register tools" widget) after any dd1324/dd996/dd234 write.

## Lifecycle hooks (optional module properties)

| Hook | Signature | Called |
| --- | --- | --- |
| `isAvailable` | `(context: ToolAvailabilityContext) => boolean \| Promise<boolean>` | by the section/component tool filter (`getElementTools` in `registry.ts`) after the `affected_models`/`affected_tipos` match, with `{callerModel, tipo, sectionTipo, isComponent, mode}`. Return `false` to hide the tool for that element. Must be fast and side-effect-free — results are cached per user/tipo/section. Tools without a loaded module fall back to a small set of core rules (`tool_diffusion`'s section-only + diffusion-map check is the one still resolved in `registry.ts` today). |
| `onRegister` | `() => Promise<void>` | after the registry record is reconciled during `importTools()`. Sanctioned place for setup (e.g. seeding a dd996 config record). A throw is logged, never fails the import. |
| `onRemove` | `() => Promise<void>` | best-effort, before the registry record of a removed tool is deleted. |
| `onBoot` | `() => ToolBootHandle \| undefined` | once per serving boot (not in a smoke boot), after the tool registry loads (`loader.ts::startToolBootHooks`). For timers the tool owns — tool_export's TTL sweeper. Must not block: arm and return. The returned `{stop()}` runs on shutdown. A throw is logged (`[tools] <name>.onBoot failed`), never fatal. |

## HTTP routes (`httpRoutes`)

A tool that must answer a plain GET outside `dd_tools_api` — a file download the browser saves directly — declares it on the module:

```ts
httpRoutes: [
  {
    pathPrefix: EXPORT_ARTIFACT_URL_PREFIX, // '/dedalo/export/artifact/'
    handle: (request, pathname) => serveExportArtifact(pathname, request.headers.get('cookie')),
  },
],
```

- The router (`src/server.ts`) asks `loader.ts::toolHttpRouteFor(pathname)` AFTER every engine route and just before the client static tree, so no tool route can shadow an engine one. `handle` answers a `Response`, or `null` for the engine's 404.
- The handler does its own authentication; the router passes the raw request.
- The loader refuses (the tool fails to load, loudly): a prefix that is not `/dedalo/<segment>[/<segment>…]/` in lowercase `[a-z0-9_]`; a first segment the client tree or an engine route owns (`TOOL_ROUTE_RESERVED_SEGMENTS`, plus the media directory); a prefix that overlaps, in either direction, one an already-loaded tool serves.
- Declare the prefix as an exported `*_URL_PREFIX` constant in the tool's server module, and add it to the reverse-proxy configurations: `install_restart_supervisor_tripwire` derives tool route constants too and requires every loaded tool route to be proxied.
- Gate: `test/unit/tool_http_routes_native.test.ts`.

## Registration-time validation (`src/core/tools/register.ts`, `register_schema.ts`)

`importTools({dryRun})` scans the roots, parses each `register.json`, detects its format, and validates it:

- top-level `components` key → legacy v6 dump — **not supported this wave** (none of the 34 in-repo tools use it, so this has not blocked any real port);
- top-level `name` key → the flat **authoring** format (`authoringRegisterSchema`, a Zod mirror of `src/core/tools/register.schema.json`) — converted to the column-keyed shape;
- column-keyed (`data`/`string`/`relation`/…) → pass-through, validated as-is. **All 34 in-repo `register.json` files are this form** — they are seeded matrix-row dumps, not hand-authored files.

**Write gating.** `importTools()` without options is a **dry run**: for every tool it reports whether the registry already reflects the declared identity (empty diff = no-op), writing nothing. A caller writes by passing `dryRun: false` — the installer, the *Register tools* widget, and the code update's ancillary phase (which passes `keepStoredActive: true`, so each tool keeps the Active value an administrator stored).

A missing/invalid `apiActions` shape, a `tool.name` that does not match the directory, or a lifecycle hook listed inside `apiActions` all fail the loader's `validateModule` check (logged, tool absent from the registry) — there is no silent partial registration.

## Multi-root resolution (`src/core/tools/paths.ts`)

All path/URL resolution goes through `getRoots()` / `resolveToolRoot()` / `getToolUrl()`: index 0 is always the in-repo `tools/` root; extra roots come from `config.tools.additionalRoots` (env `DEDALO_ADDITIONAL_TOOLS`, JSON `[{path,url}]`), each canonicalized and refused if missing, not a directory, or a system temp dir. First-root-wins name collisions are reported via `getToolLoadCollisions()`, never silently overridden. Never build a tool path/URL from a raw config value in new code — always go through these helpers so additional-root tools resolve to their own URL and the client's `DEDALO_TOOLS_URLS` map stays in lockstep.
