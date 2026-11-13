# Performance metrics

> See also: [Runtime & request-scoped context](runtime_and_workers.md) · [Testing](testing.md)

Dédalo carries a deliberately small operational-metrics surface: an in-process counter registry, a structured access log, and one admin-only endpoint that aggregates everything a running server knows about its own load. This page is the developer reference for what is measured, where it is recorded, and how to add a metric of your own.

The design rule is that metrics are **process-lifetime, low-cardinality and cheap**: plain named integers plus a latency aggregate, no persistence, no time series, no per-tipo or per-user label explosion. The counters answer *"is this server healthy and busy right now"* — they are not an analytics store.

!!! warning "Not to be confused with the dashboard's activity metrics"
    The **area dashboard** has its own `metric_total` / `metric_activity_30d`
    values (`src/core/area/dashboard.ts`). Those are a *data-domain* feature —
    record counts and activity charts per section, shown to cataloguers. They are
    unrelated to the developer-facing operational metrics described here.

## The counter registry

`src/core/api/counters.ts` holds the whole facility: a `Map<string, number>` of
named integers, a request-latency aggregate, and a set of named **gauge
providers** that subsystems register at boot.

| Function | Use |
| --- | --- |
| `incrementCounter(name, by = 1)` | bump a named integer |
| `observeRequest(status, ms)` | feed one finished request into the request counters + latency aggregate |
| `recordPoolWait(waitedMs)` | called by the DB layer whenever a query had to **wait** for a pooled connection |
| `registerOpsGauge(name, provider)` | register a live gauge, resolved on demand when the endpoint is read |
| `getCounters()` | snapshot of the plain counters (tests, endpoint) |
| `collectOpsCounters()` | the full aggregated payload the endpoint serves |

The counters that always exist:

| Counter | Meaning |
| --- | --- |
| `requests_total` | every API request that reached dispatch |
| `requests_4xx` / `requests_5xx` | client-error / server-error responses. **Meaningful since the error taxonomy landed**: a failure now answers a status derived from its error code's category, so a refused, throttled or crashed request is finally visible here. Before that, the dispatcher answered `200` for essentially every failure and both counters were structurally near zero on a server that was refusing everything. |
| `errors_total` | every failure that passed through `logError` — i.e. every typed failure the engine reported, on any surface (API, tools, the assistant, streams), not only the ones that produced an HTTP body |
| `requests_slow` | responses at or over `config.ops.slowRequestMs` |
| `db_pool_waits` | queries that had to wait for a free pooled connection |
| `db_pool_wait_ms_total` | cumulative milliseconds spent waiting on the pool |

`db_pool_waits` is the one to watch: a healthy server never waits for the pool, so
a rising count means `DB_POOL_MAX` is too small for the concurrency the install
actually sees.

Counters minted on demand, one key per named boundary:

| Counter | Meaning |
| --- | --- |
| `error_<code>` | one failure of that registered error code, with the dot replaced by an underscore (`error_auth_not_logged`, `error_perm_denied`, `error_external_timeout`, `error_internal_unexpected`). Minted by `logError` alongside `errors_total`, so the key set is exactly the codes this process has actually raised — the closed registry bounds the cardinality, and a code nobody hits costs nothing. This is the counter to graph: `requests_5xx` tells you something broke, `error_<code>` tells you what. |
| `section_id_string_coercions.<source>` | a `section_id` arrived as a numeric **string** at the door `<source>` and was coerced to its canonical integer. A deprecation signal: RQO-body doors must trend to zero before the string form is removed. `url.*` doors (`URLSearchParams` yields strings forever) are permanent and excluded from that gate. Law: `engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md` |

Read these against `uptime_s`: counters are process-lifetime, so a bare zero on a
freshly restarted process is not evidence. Each coercion also emits a sampled
`[section_id-string-coercion]` warning line — grep the access log for the tag to
locate the caller.

## The access log

`src/core/api/access_log.ts` is called once per request from `dispatchRqo()`'s
logging wrapper — the timing (`startedAt`, `performance.now()`-based) and the
caller identity are already in hand there, so the module only formats and counts.

- When `DEDALO_ACCESS_LOG` is on (`config.ops.accessLog`), it emits **one parseable
  JSON object per line** on stdout, which journald/systemd captures:

    ```json
    {"ts":"…","type":"access","request_id":"…","user_id":1,"api":"dd_core_api::read","status":200,"ms":42.3}
    ```

    A failed outcome adds `error_code` and `error_category` to the same line, and
    the response body carries the same `request_id` — so a user report and a log
    line join without guessing.

- **Independently of that flag**, any request at or over `config.ops.slowRequestMs`
  increments `requests_slow` and emits a `[slow-request]` warning line naming the
  API action, the duration, the threshold, the request id and the user. Set the
  threshold to `0` to disable the warning.

Every request — logged or not — feeds `observeRequest()`, so the counters are
always accurate even with the access log off.

## The counters endpoint

`GET /api/v1/counters` (also reachable at `/dedalo/core/api/v1/counters`) serves
the aggregated payload built by `collectOpsCounters()`.

It is **session-gated and global-admin-only**, and it fails **closed as a `404`** —
never a `403` — exactly like every other admin surface, so its existence is not
disclosed to an unauthorized caller. Counters leak operational shape (job names,
load); they never carry record data.

The payload:

```json
{
    "ts": "2026-07-12T10:27:50.000Z",
    "pid": 4711,
    "uptime_s": 86400,
    "rss_bytes": 214958080,
    "process_poison": false,
    "counters": { "requests_total": 19844, "requests_5xx": 0, "db_pool_waits": 0 },
    "requests": { "count": 19844, "avg_ms": 31.7, "max_ms": 1840.2 },
    "media_jobs": { "has_headroom": true },
    "background_jobs": { }
}
```

- `process_poison` mirrors the health latch (`src/core/api/process_health.ts`):
  `true` means `/health` is already answering `503` and the watchdog is about to
  recycle this process.
- `requests.max_ms` is the **tail-latency** signal, and it is the reason the
  aggregate keeps a max rather than only a total: a healthy-looking average can
  comfortably hide one 1.8-second request. Watch `max_ms` and `requests_slow`
  together — the average alone will not tell you the server has a problem.
- Each registered gauge is resolved **best-effort**: a provider that throws
  contributes `{ "error": "…" }` instead of taking the diagnostics endpoint down
  with it, which is precisely when it is needed most.

## Registered gauges

Some subsystems own state the counter registry must not import directly (`core/api`
may not import `src/diffusion` — the boundary tripwire allows exactly two seams).
Those subsystems therefore **register a provider at boot** and the endpoint pulls
from them on read:

| Gauge | Owner | What it reports |
| --- | --- | --- |
| diffusion | the diffusion boot chain in `startServer()` | queue depths |
| `media_jobs` | `src/core/media/jobs.ts` (`mediaJobs.hasHeadroom()`, `mediaJobs.laneDepths()`) | whether the media lane can take more work, plus `lanes[class] = {active, queued, max}` for every job lane (`media`, `transcription`, `rag`, `maintenance`) |
| `background_jobs` | `src/core/tools/background.ts` (`getBackgroundJobStats()`) | running/queued background tool jobs |

## Slow-query investigation

The counters tell you *that* the server is slow. Which SQL is to blame is the
**slow-query log**: the engine times every statement on all three lanes
(`src/core/db/query_tap.ts`) and writes one warn line per statement that takes
`DEDALO_SLOW_QUERY_MS` or longer — on by default at `5000` since 7.0:

```text
[db] slow query 7312ms (threshold 5000ms, lane transaction): SELECT …
```

The lane tells you where it ran: `transaction` is the write path (a save, an
import row), `pooled` an ordinary statement on the pool, `reserved` a connection
one caller holds for itself (the boot migrations, a long-running job). Raise
the threshold in `../private/.env` to log less, lower it to catch more;
`DEDALO_SLOW_QUERY_MS=0` turns the log off. The key is documented in
[config_db](../config/config_db.md). The log names the statement, not its plan:
for the *why*, use Postgres itself — `EXPLAIN ANALYZE` on the logged statement,
and `pg_stat_statements` for the ranking of what costs the install its time
overall, including statements that stay under the threshold.

## Adding a metric

1. **A plain counter** — `import { incrementCounter } from '../api/counters.ts'`
   and call it at the event site. Keep the name low-cardinality: `imports_failed`,
   not `imports_failed_<section_tipo>`.
2. **A live gauge** — if the value is *state* rather than an event count (a queue
   depth, a pool size), call `registerOpsGauge(name, provider)` once at boot from
   the subsystem that owns the state. This inverts the dependency, so the counters
   module never has to import the subsystem.
3. **Never a module-level mutable that is keyed by request.** The counter registry
   is process-global on purpose — it aggregates *across* requests and holds nothing
   request-specific. Anything that varies per caller belongs in the request-scoped
   context instead (see
   [Runtime & request-scoped context](runtime_and_workers.md#request-scoped-ambient-state-asynclocalstorage)),
   never in a counter.

## See also

- [Runtime & request-scoped context](runtime_and_workers.md) — where `startedAt`
  comes from and why per-request state must never live at module level.
- [Testing](testing.md) — `resetCountersForTests()` clears the registry between
  tests.
- Operations: `engineering/PRODUCTION.md` (supervision, health, the access-log
  contract).
