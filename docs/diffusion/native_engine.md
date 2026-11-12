# The diffusion engine

> See also: [Diffusion (system overview)](../core/system/diffusion.md) · [Diffusion data flow](diffusion_data_flow.md) · [Parser cookbook & reference](parsers.md) · [Publication API](publication_api/index.md) · [Exporting data](../core/exporting_data.md)

The **diffusion engine** is Dédalo's publication pipeline, built directly into
the work server (`src/diffusion/`): **one engine in one codebase**, driven by
the **diffusion ontology**, operated by the **`tool_diffusion` client**, and
producing the **published artifacts** — SQL tables and RDF / XML / Markdown /
CSV / JSON files. This page is the full technical reference: architecture,
lifecycle, formats, configuration. For the conceptual role of diffusion inside
Dédalo read [Diffusion (system overview)](../core/system/diffusion.md); for how
you *decide* what gets published read
[Diffusion data flow](diffusion_data_flow.md).

Standing spec: `engineering/DIFFUSION_SPEC.md`.

---

## Design in one sentence

> **One compiler, one resolver, one IR, many writers.** A schema source (the
> dd1190 diffusion ontology, or a tool_export column set — both live)
> compiles into an executable `PublicationPlan`; one streaming resolver turns
> plan + records into a typed intermediate representation; format writers are
> plugins that consume it and know nothing about ontology or resolution.

A little history: earlier Dédalo versions split publication across two runtimes
— resolution in the work server, parsing and MariaDB ownership in a separate
external engine — because that runtime could not sustain long publication runs.
In this server resolution is native, so that seam (per-record HTTP hops,
half-resolved wire payloads, a second public socket) is gone: what used to be a
runtime side-channel (`merge_columns`, `global_table_maps`, `empty_to_string`,
alias resolution, the virtual-tree walk itself) is now a *compile-time plan
concept*.

## Architecture

[![The diffusion API: the control plane enqueues a durable job, the scheduler spawns one runner process per job, and the runner compiles a plan and runs the selection, resolution, transform and writer stages, checkpointing after every batch](../assets/images/diagrams/diffusion_api.svg)](../assets/images/diagrams/diffusion_api.svg)

*Click the diagram to open it full size; the Mermaid view below is the same
architecture with the module names attached.*


```mermaid
flowchart TB
    subgraph CLIENT ["Client (byte-identical tool_diffusion)"]
        TD[tool_diffusion.js<br/>publish / status / cancel / panels]
    end

    subgraph SERVER ["Main TS server — CONTROL PLANE"]
        API[dd_diffusion_api actions<br/>session + CSRF + allowlist + SEC-13]
        Q[(dedalo_ts_diffusion_jobs<br/>durable job queue, Postgres)]
        SSE[SSE streams<br/>poll the job row]
        SCHED[scheduler + sweeper]
    end

    subgraph RUNNER ["Spawned runner process — DATA PLANE"]
        PLAN[PublicationPlan<br/>compiled from dd1190, cached]
        RES[Resolver<br/>selection → chains → gate]
        TRF[Transform<br/>runtime parser registry]
        PRJ[Projection<br/>5-rung lang ladder + policies]
        WRT[Format writers<br/>sql · csv · json · markdown · rdf · xml]
    end

    subgraph TARGETS ["Publication targets"]
        MDB[(MariaDB<br/>publication databases)]
        FILES[/media path<br/>rdf · xml · md · csv · json files/]
    end

    TD -->|RQO diffuse| API --> Q
    SCHED -->|claim FOR UPDATE SKIP LOCKED| Q
    SCHED -->|Bun.spawn --job uuid --epoch n| RUNNER
    RUNNER -->|heartbeat · progress · checkpoint| Q
    Q --> SSE --> TD
    PLAN --> RES --> TRF --> PRJ --> WRT
    WRT --> MDB
    WRT --> FILES
```

Two planes, one codebase:

- **Control plane (main server).** All client actions dispatch through the
  normal API gates. `diffuse` enqueues a **durable job** and answers with an SSE
  stream that *observes the job row* — the stream is a view, not the run.
- **Data plane (runner process).** A scheduler claims queued jobs
  (`FOR UPDATE SKIP LOCKED`, bounded by `DEDALO_DIFFUSION_MAX_RUNNERS`) and
  spawns `bun run src/diffusion/runner.ts --job <uuid> --epoch <attempt>`: same codebase, its own
  process — own memory ceiling, crash-isolated from the interactive API,
  killable. The runner communicates **exclusively** through the job row
  (heartbeat, progress, checkpoint, terminal state) plus the targets. Because
  there is zero runner↔server RPC, a runner daemon on **another machine** can
  claim from the same queue — placement is deployment, not architecture.

### The pipeline stages

| Stage | What happens | Module |
| --- | --- | --- |
| **A → B Compile** | The dd1190 element subtree (flat virtual tree: aliases resolved in place, consumed branches suppressed, parents paths) compiles into an immutable, JSON-serializable `PublicationPlan`: per-section field plans, ddo-map trees with parent linkage, parser split, column typing, policies, lang + recursion policy. Cached per ontology revision; any dd_ontology write invalidates via the core cache-invalidation hub. | `src/diffusion/plan/{virtual_tree,compile,cache,types,identifier}.ts` |
| **C Selection** | Keyset-batched cursor over the **sanitized** SQO (`WHERE section_id > cursor ORDER BY section_id LIMIT batch`; never OFFSET) + batched matrix reads (one `IN` query per batch). | `src/diffusion/resolve/selection.ts` |
| **D Resolution** | Per record: publication gate first (fail-closed), then the recursive ddo-tree chain walk — the previous engine's `resolve_chain` twin: per-locator recursion, cross-section hops with batched term/typology prefetch, breadth-first frontier for linked-section publishing (levels budget + per-run dedup + cycle guard), rewriter semantics (`parents`, truncations, `merge_columns`, `publication_unix_timestamp`, …). Output: typed `RecordIR` with `status: publish | unpublish`. | `src/diffusion/resolve/{resolver,rewriters,default_value,record_ir}.ts` |
| **E Transform** | The surviving runtime parsers run as **pure functions** over typed atoms — an exact port of the old parser-chain state machine, fed the same per-lang grouping. Unknown parser fn = loud compile error, never a silent skip. | `src/diffusion/resolve/transform.ts`, `src/diffusion/parsers/` |
| **F Projection** | The 5-rung language ladder (exact → nolan → main lang → any → null) collapses each field per output language; `empty_to_string` / `default_value` policies apply here, in exactly one place. Output: `ProjectedRow` per lang. | `src/diffusion/project/lang_ladder.ts` |
| **G Write** | The format writer for `properties->diffusion->type` consumes rows/records behind a fixed session contract: `ensureSchema()` once per run (serialized, outside row transactions), idempotent `writeRows`/`removeRecords` per batch, `close()` finalizes (merge/zip/counts). | `src/diffusion/writers/`, `src/diffusion/targets/mariadb/` |
| **H Ledger** | dd1758 activity rows (`published` per primary record), media markers, run report. | `src/core/resolve/diffusion_delete.ts` (`logDiffusionActivity`) |

## From the user's click to a published row

1. **Click.** The (byte-identical) client builds the same RQO it always built —
   `{action:'diffuse', dd_api:'dd_diffusion_api', source, sqo, options}` — and,
   with `DEDALO_DIFFUSION_API_URL` absent from the environment payload, its own
   fallback posts it to the **main API**.
2. **Gate + enqueue (milliseconds).** Session, CSRF, action allowlist, read
   permission on the source section (SEC-13). The SQO is sanitized at the
   boundary; the plan is loaded from cache (or compiled — a bad parser fn or a
   label that fails the SQL-identifier chokepoint dies **here**, loudly). A job
   row is inserted; a partial-unique index guarantees **one active run per
   element + section** — the same user repeating the same request *attaches*
   to their running job instead of double-publishing; another user, or another
   selection, on a target with an active run is refused with
   `diffusion.target_busy` (409, retry when it finishes) and never sees the
   other run's progress. The HTTP response is the SSE stream.
3. **Claim + spawn.** The scheduler claims the job and spawns the runner
   process.
4. **The run.** Schema-ensure once, then the streaming batch loop
   (`DEDALO_DIFFUSION_BATCH_RECORDS`, default 500 records/batch): select →
   resolve → transform → project → cancel-flag check → **one fenced unit**:
   the publication target's lock (a second writer of the same database or
   directory waits — the job shows *Waiting for the publication target*),
   the job's lease re-checked, batched writes (~200-row multi-row upserts,
   PK `(section_id, lang)`), then the dd1758 rows, the batch's **run ledger**
   events and the **checkpoint** `{v: 2, cursor, run_started_at, processed,
   batch_seq, writer, errors}` and the progress update (the user's bar moves),
   all committed together → next batch. Unpublishable records become
   `removeRecords` calls (the typed successor of the old `fields:'delete'`
   sentinel); a record deleted from the archive while its batch waited is
   unpublished instead of written.
5. **Finish / disconnect / crash.** File formats merge + zip on `close()`; the
   final SSE chunk carries the result (tables summary, or
   `consolidated_files` + `diffusion_data` links for file runs). A closed
   browser changes nothing — the client reconnects later via
   `list_processes` → `get_process_status` by its deterministic process label.
   A dead runner is swept (stale heartbeat) and **re-queued from its
   checkpoint** (≤3 attempts). The resumed runner replays the job's run ledger
   — the relation frontier still to drain, the records already published, the
   files the run wrote — so its result, archives included, is
   **byte-identical** to an uninterrupted run's (gate
   `test/unit/diffusion_resume_ledger_native.test.ts`: a crash among the
   primaries, a crash in the frontier drain, a crash inside a batch's tail, a
   real `kill -9`), and its report keeps the error lines the batches before the
   crash produced (*Partial success*). A linked record unpublished while the
   run was down is not republished by the resume: the drain asks the
   publication gate against the record as it is then. A cancelled run publishes no archive; an
   admin requeue resumes it.
6. **Deletes (the reverse path).** `section_record.delete()` calls the
   diffusion hook in-process: MariaDB rows deleted natively (per-target
   isolation, missing table/database = idempotent success), files unlinked,
   failures ledgered as dd1758 `unpublish_pending` and retried on boot,
   opportunistically, or from the tool button. A diffusion failure never blocks
   the work-system delete.

## The ontology contract

The engine consumes the **v7 diffusion ontology exactly as it exists** — it
never writes to `dd_ontology` and needs no migration:

| Ontology construct | Consumed as |
| --- | --- |
| `diffusion_domain / group / element[_alias]` | Element enumeration; `properties->diffusion->{type, service_name}` picks the writer + file service dir |
| `database[_alias]` / `table[_alias]` node **labels** | MariaDB database / table names — every one passes the SQL-identifier chokepoint (`^[a-z][a-z0-9_]{0,63}$` after the oracle-parity sanitize) at compile time; rdf/xml labels are XML identities and are **not** SQL-sanitized |
| `*_alias` nodes | Resolved in place at compile: alias tipo/label win, properties inherit, the consumed real branch is suppressed (institution redirection keeps working) |
| Field node `properties->process->ddo_map` | Compiled to a `ResolveStep` tree with parent linkage (`self` resolution, auto-from-relations fallback, `fn` variants) |
| `properties->process->parser` chains | Split at compile: **10 rewriter fns** are absorbed into plan structure (`parents`, `get_locator`, `merge_columns`, `map_section_tipo_to_name`, `publication_unix_timestamp`, truncations/filters/slices); **23 runtime fns** run as pure value transforms — see the [parser cookbook & reference](parsers.md) for every fn with in→out examples. All 33 names stay resolvable; an unknown name fails `validate` loudly |
| `exclude_column`, `varchar/length/index`, `output_format`, `empty_to_string`, `default_value`, `preserve_order` | First-class `FieldPlan` / `FieldPolicy` / `ColumnDef` concepts (including the component-class `output_format` fallback: relation-family fields default to `json`) |
| Table node `properties->global_table_maps` | Global (aggregate) tables, e.g. `numisdata701` → `numisdata876` (`map_global`): compiled to `SectionPlan.globalTables`. The global `table` node's own fields are its columns; every published row of the section is also written there, one row per language, keyed `<section_tipo>_<section_id>` (a VARCHAR sized by the node's own `section_id` field), with the provenance columns the node declares (`ref_section_id`, `ref_section_tipo`, `ref_table`, `link`) and each `columns_map` item (`source_columns` read from the source table or the automatic `section_id`/`lang`; `format: "string"` joins them with `separator`, default ` \| `). Rows are replaced on every publication and withdrawn on unpublish, record delete and the `public_tier` reconcile. A map naming a column that exists in neither table is not written and is reported as a `global_table_maps_unruled:` warning by `validate` |
| `component_publication` + ontology `is_publishable` | The publication gate — evaluated per record, **fail-closed** (any gate error ⇒ unpublish) |

The admin-only `validate` action compiles an element and returns every error and
warning — the loud pre-run gate (missing `service_name`, invalid identifiers,
unknown parser fns, rewriter absorptions).

## Formats

| `type` | Writer | Target & layout | Notes |
| --- | --- | --- | --- |
| `sql` | `writers/mariadb_sql.ts` | MariaDB, one table per section; PK `(section_id, lang)`; additive-only self-evolving schema (CREATE IF NOT EXISTS → INFORMATION_SCHEMA diff → ALTER ADD) | True multi-row upserts (~200 rows, 4 MB budget); oracle-parity column typing/indexes/comments |
| `socrata` | alias of `sql` | — | Dormant, as in the old engine |
| `csv` | `writers/csv.ts` | `<media>/csv/<db-or-service>/<table>.csv` | RFC 4180, streamed, header = plan column order |
| `json` | `writers/json.ts` | `<media>/json/…/<table>.ndjson` + `.meta.json` sidecar | One JSON object per row line |
| `markdown` | `writers/markdown.ts` | `<media>/markdown/<service>/<st>_<id>.md` (+ zip) | Same name grammar as the delete path, byte-pinned |
| `rdf` | `writers/rdf.ts` | `<media>/rdf/<service>/<sanitized rdfName_st_id>.rdf` + merged + zip | EasyRdf envelope pinned against a file published by the previous engine; `xml:lang` literals |
| `xml` | `writers/xml.ts` | `<media>/xml/<service>/<st>_<id>.xml` + merged + zip | Matches the previous engine's `render_dom` output shape; per-lang alpha-2 children |

Adding a community format = one ontology `type` string + one registered writer
(`writers/registry.ts`); an unknown type throws a named error.

All file artifacts are written temp-then-rename (atomic), zips are deterministic
(zeroed timestamps; a duplicate entry name or an empty archive is refused), the
merged documents and zips are built **streamed** — one file in memory at a time,
whatever the publication's size — and **no wall-clock leaks into content** —
who/when lives in the dd1758 ledger, and determinism plus the run ledger is what
makes crash-resume byte-equivalent.

## Durability & the job queue

Job state lives in three TS-owned Postgres tables (`dedalo_ts_diffusion_jobs`,
`dedalo_ts_diffusion_job_events`, `dedalo_ts_diffusion_job_ledger` — the run
ledger of each job, cleared when it completes; the deliberate, documented
exception to the
"no bespoke tables" convention: a queue is high-churn infrastructure, while
dd1758 remains the *user-facing* publication ledger).

- **States:** `queued → running → completed | failed | cancelled`, plus
  `interrupted → queued` (sweeper re-queue, ≤ `max_attempts`).
- **Lease:** a row can be claimed more than once, so ownership is checked, not
  assumed. The lease is `(job_id, attempt)`: the claim stamps `attempt`, the
  scheduler passes it to the runner as `--epoch`, and every write the runner
  makes is fenced on it — a runner whose row was taken from it writes nothing
  and aborts. `attempt` only ever moves forward; an admin requeue grants a fresh
  retry budget by raising `max_attempts`, never by resetting the counter.
- **Identity:** the server-generated `job_id` UUID is the internal capability;
  the client's deterministic label
  (`process_diffusion_{user}_{element}_{section}`) is the **client-facing**
  `process_id` — authorization is by owner (or admin), never by id knowledge.
- **Checkpoint:** `{v: 2, cursor, run_started_at, processed, batch_seq,
  writer}` committed with every batch, together with the batch's run-ledger
  events. `run_started_at` is captured once and reused on resume, so the
  `publication_unix_timestamp` system field is stable across crashes. A
  checkpoint from before the run ledger (no `v: 2`) restarts the run.
- **Target fence:** a publication target (a MariaDB database, a files
  directory) is written by one unit at a time — runs, record deletes, ghost
  unpublishes and the lang sweep take the same lock. A runner whose lease was
  taken while it waited for the target writes nothing; a runner in the middle
  of a batch is never swept. A long step — an `ALTER` adding a column to a
  large published table, a lang sweep — keeps its lock for as long as it runs
  (a timer keepalive on its connection); only a frozen process loses it, after
  5 minutes. A record delete never waits for a busy target: the unpublish stays
  pending in dd1758 and a retry drain (the next run's start, the `retry_pending_deletions`
  action, the maintenance panel's retry) pays it, waiting for the run's batch.
- **Cancel:** queued jobs finalize immediately; running jobs honor the flag
  between batches; committed work stays, and **no consolidated archive** is
  written from a cancelled run (a requeue resumes it and consolidates the whole
  run).
- **Progress transport:** SSE streams poll the job row (the old engine's exact
  wire: `data:\n{json}` padded to 16 KB, 2 s heartbeat, `X-Accel-Buffering: no`);
  any server instance can stream any runner's progress.

Measured throughput (dev hardware, real 62-column `coins` plan, publication
gates + cross-section chains included): **≈226 records/s** single-runner —
against the old architecture's floor of one full API round-trip per record
(chunk size 1, ≤5 records/s).

## Security chokepoints

1. Single dispatch surface: session auth, CSRF, class/action allowlist — there
   is no separate publicly-proxied diffusion socket and no internal-token
   header.
2. `diffuse`/`get_diffusion_info` require read permission on the source section
   (server-enforced); `validate` and `rebuild_media_index` are admin-only.
3. Status/cancel/list are **owner-scoped** (admins see all) — stronger than the
   old engine, which accepted any authenticated cookie for any process id.
4. Ontology labels → SQL identifiers pass one strict chokepoint at compile time;
   backtick-escaping applies everywhere regardless; values are always
   parameterized.
5. The job spec stores only the **sanitized** SQO — a replay can never smuggle
   server-only keys.
6. Publication gate fail-closed; media markers fail closed (a marker failure
   never fails a run, and markers only ever widen access when present).

## Client compatibility

The copied `tool_diffusion` client works with **zero edits**. The full action
set it calls is served natively:

| Action | Behavior |
| --- | --- |
| `diffuse` | Enqueue-or-attach + SSE stream |
| `get_process_status` | Reconnect stream by client process label (poll rate honored, `:\n` heartbeat, pinned not-found chunk) |
| `list_processes` | `{result, processes: progress_data[]}`, 24 h window — the reconnect-by-label predicate **actually works** (the old engine only ever exposed its internal UUID, so the client's reconnect could never match) |
| `cancel_process` | Pinned `{result, msg}` shapes |
| `get_diffusion_info` | Panel descriptors from the virtual tree, with a real per-target-database `connection_status` (`{result,msg}`, or `null` for non-MariaDB formats — WC-065) |
| `get_engine_advisory` | Native subsystem health (there is no separate engine process to be "down") |
| `retry_pending_deletions` | Native dd1758 pending-unpublish retry |
| `validate` | Admin plan validation |
| `rebuild_media_index` | Media-marker resync (admin) |

## Configuration

All keys live in `../private/.env` (see [config](../config/index.md)):

| Key | Default | Meaning |
| --- | --- | --- |
| `DEDALO_DIFFUSION_DOMAIN` | — | The dd1190 domain the virtual tree/plans are built for |
| `DEDALO_DIFFUSION_RESOLVE_LEVELS` | `2` | Breadth-first linked-record publishing budget |
| `DEDALO_DIFFUSION_LANGS` | the project languages | Output languages (the ladder's row set), first entry = main language. **Derived** from `DEDALO_PROJECTS_DEFAULT_LANGS` verbatim when unset or empty; set it only to publish a subset. Accepts a JSON array or a comma-separated list. Every entry must be a `lg-xxx` code (never the `all` sentinel) and must be one of the project languages — otherwise the value is reported at boot and the publication plan is REFUSED rather than publishing empty renditions |
| `DEDALO_DIFFUSION_DB_SOCKET` / `_DB_HOST` / `_DB_PORT` / `_DB_USER` / `_DB_PASSWORD` | socket `/tmp/mysql.sock` | MariaDB target access (never reuses the old engine's `DB_*` keys — both must coexist during transition). Target databases are **pre-created**; a missing one is a loud config error, never auto-created |
| `DEDALO_DIFFUSION_MAX_RUNNERS` | `2` | Concurrent runner processes |
| `DEDALO_DIFFUSION_NATIVE` | `true` | Emits no `DEDALO_DIFFUSION_API_URL` in the environment payload, so the client calls the main API and this server answers. Set to `false` ONLY on a deployment that still runs the external service behind a route of its own — this server serves no `/dedalo/diffusion/api/v1/`, so with the flag off the tool 404s (WC-003). Defaulted to `true` on 2026-07-29; it was previously unset-meaning-`false` |
| `DEDALO_DIFFUSION_NATIVE_ELEMENTS` | unset | **Cutover lever 2**: the element tipos allowed to publish natively — a JSON array or a comma-separated list, or the single value `all`; un-routed elements refuse loudly (never both engines on one element+section) |
| `DEDALO_DIFFUSION_FILES_ROOT` | media path | File-writer root override (tests) |

## Migrating from an older Dédalo installation

Coming from an older Dédalo installation that published through the legacy
external diffusion service? Migration is operational, not structural — the
diffusion ontology, the client tool and the published artifacts are unchanged,
and during the transition both publishers coexist safely on the same MariaDB
**for different elements** (idempotent upserts, additive schema):

1. Pilot: set `DEDALO_DIFFUSION_NATIVE_ELEMENTS` to a short list of element
   tipos; spot-check published rows. To keep the client on the external service
   while you pilot, set `DEDALO_DIFFUSION_NATIVE=false` — it is `true` by
   default, so this step is now an explicit opt-out.
2. Flip: remove that `DEDALO_DIFFUSION_NATIVE=false` (or set it `true`) — the
   byte-identical client lands on the native actions; browser-smoke the tool
   panel.
3. Remove the `/dedalo/diffusion/api/v1` proxy route,
   `DEDALO_DIFFUSION_SOCKET_PATH` and `DEDALO_DIFFUSION_INTERNAL_TOKEN` (RETIRED at the 2026-07-11 cutover — the keys are unread; the native seams are the only transport),
   then decommission the old service.

## Technical reference

**Module map** (`src/diffusion/`):

```
plan/       virtual_tree.ts  compile.ts  cache.ts  types.ts  identifier.ts
resolve/    selection.ts  resolver.ts  rewriters.ts  transform.ts
            default_value.ts  record_ir.ts  ddo_fns.ts
export/     atoms.ts  compile_columns.ts  grid.ts  index.ts  ndjson_stream.ts
parsers/    registry.ts  parser_{text,date,helper,locator,misc}.ts  item_bridge.ts
project/    lang_ladder.ts
writers/    types.ts  registry.ts  mariadb_sql.ts  files.ts
            csv.ts  json.ts  markdown.ts  rdf.ts  xml.ts
targets/    mariadb/{db,sql_generator,delete_record}.ts   ← the MariaDB importer
            mediastore/media_index.ts   ← the native media-marker writer
jobs/       schema.ts  queue.ts  scheduler.ts  sse.ts
api/        actions.ts  info.ts
runner.ts   the data-plane process entry
```

Boundary rules (mechanically enforced by `test/unit/diffusion_boundaries.test.ts`):
Postgres only via `src/core/db/`; MariaDB only inside `src/diffusion/targets/mariadb/`;
`src/core/**` never imports `src/diffusion/**` (registration seams instead —
the native delete executor and the plan-cache invalidation hook).

**Test gates** (228 tests, 16 suites — `bun test test/unit/diffusion_* test/integration/diffusion_*`):

| Gate | What it pins |
| --- | --- |
| `diffusion_sse` + `test/parity/fixtures/diffusion/pinned.ts` | The verbatim client wire (chunk framing, progress_data shape, cancel messages) |
| `diffusion_jobs` / `diffusion_actions` | Queue lifecycle; real runner spawn → SSE → reconnect → cancel → SIGKILL → sweep → requeue |
| `diffusion_plan_compile` | Real-domain compilation (37 sections / 961 fields), alias semantics, loud failures |
| `diffusion_parsers` | 84 oracle-mined parser cases + classification completeness |
| `diffusion_datum_replay` | **Frozen-fixture parity**: the old engine's golden datum → identical processed tables through the production transform+ladder |
| `diffusion_resolver` | Real-DB end-to-end record resolution, gate variants, frontier levels, determinism |
| `diffusion_mariadb` / `diffusion_file_writers` / `diffusion_rdfxml_writers` | Live-target writer behavior; file grammars byte-pinned against the delete path and real files published by the previous engine |
| `diffusion_publish_e2e` | The keystone: real plan → real matrix → scratch tables; oracle spot-check vs old-engine-published rows (53 matching cells / 8 differing, every diff hard-asserted); **interrupted-resume byte-equivalence** |

## Extending the engine: custom fns

The ontology names behaviors; the engine implements them — an ontology can
never inject code, only *demand* it. When an ontology references a fn the
engine does not know, nothing silently breaks: a **parser** fn fails plan
compilation (surfaced by `validate`, naming the field and fn, before any run);
a **ddo** fn becomes a per-field collected error in the run report while the
rest of the publication proceeds. That fail-loud contract is the designed path
for needs that cannot be known in advance.

Implementing a new fn is one registered function plus tests:

- **Parser fns** (`properties->process->parser[].fn`) — pure value transforms,
  `(values: ValueIR[], options, ctx) => ValueIR[]`, no I/O ever. Add the
  function in the matching `src/diffusion/parsers/parser_*.ts` family file and
  one entry in `parsers/registry.ts` (`PARSER_CLASSIFICATION` +
  `RUNTIME_PARSERS`). Chaining, `${id}` handles, per-lang grouping and
  projection compose around it automatically. See the
  [parser cookbook](parsers.md).
- **ddo fns** (`ddo_map[].fn`) — component-resolution variants that may need
  data access. They live in `src/diffusion/resolve/` (dispatch in
  `resolver.ts`, implementations in `ddo_fns.ts`) where batched matrix reads,
  the relations engine and the per-run caches are available. Examples:
  `parse_tag_to_html` (text-tag → publication HTML), `get_geojson_data`
  (geo-tag ↔ geolocation pairing) and its flat `get_geolocation_data`
  variant, `get_diffusion_iconography` (nested iconography portals),
  `map_target_section_tipo` (a hierarchy's target section → the table name the
  element publishes it under, e.g. `hierarchy83` reading `hierarchy53`) — each
  gated against the values the previous engine published.

Every fn ships with the engine (the ontology stays pure data — a deliberate
security line); the registries are the single place to touch.

!!! warning "Honest ledger — known gaps"
    - One niche fn variant remains unported and fails **loudly per field** (the
      column falls to its policy default): the typology-based `parents`
      truncation options. No use in the reference domain; the extension seam
      above is its landing path.
    - SQL-target **media publication markers** are now written natively by
      `src/diffusion/targets/mediastore/media_index.ts` — the single writer of
      the filesystem marker allowlist, mirroring row existence in the target
      MariaDB tables (wired into `writers/mariadb_sql.ts` and
      `targets/mariadb/delete_record.ts`). The old marker-store dependency is
      retired (S2-31/DEC-19 cutover).
    - The `diffusion_server_control` maintenance widget still reports the old
      engine; its re-home is coordinated with the cutover.
    - rdf publishes each record's RDF graph: subject IRIs from the
      publication-services base IRIs (dd1010), namespaces from the element's
      `properties.diffusion.xmlns`. An element whose definition is incomplete
      (no `service_type`, a class without `entity_publication_uri`, an
      undeclared prefix) is refused at compile time with every cause named; a
      record whose base IRI does not resolve is not written, its previous
      file is removed, and the run report names it. A linked record is
      inlined only when the user who started the publication may read it. A relation_list `config` inside an rdf property is not
      supported yet (refused at compile time).
    - File-run `diffusion_data` lists the merged + zip links (not yet one link
      per record).
    - `tool_export` record resolution now RIDES the shared engine
      (`src/diffusion/export/`: the ar_ddo_to_export plan front-end + the
      resolver's atom-level entry point `resolveRecordAtoms`); the NDJSON
      grid protocol and projection stay export-specific and byte-identical
      (A/B keystone `test/unit/diffusion_export_unified.test.ts` + the live
      live differential run through the unified route).
      `DEDALO_EXPORT_UNIFIED=false` is the kill-switch back to the legacy
      in-tool walker, whose DELETION is ledgered until the tools refactor
      settles.
