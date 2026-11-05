# DIFFUSION_SPEC — Rebuild Dédalo Diffusion as a first-class TS/Bun engine

Standing master specification for the diffusion rebuild (the diffusion counterpart of
`engineering/REWRITE_SPEC.md`). Produced 2026-07-05 from three exploration passes (PHP
diffusion engine + dd1190 ontology mechanics; the production Bun engine at
`v7/master_dedalo/diffusion/api/v1/`; the export subsystem + TS tree state) and
two design passes (engine core; runtime/operations), with the user's decisions
locked in:

1. **Ontology contract:** consume v7 diffusion ontologies (dd1190) and
   normalize internally — but v7 `properties` is **beta, not frozen**: the
   format may evolve where the design clearly benefits (deliberate,
   user-approved, ledgered, shipped with updated dd1190 definitions). Legacy v6
   `propiedades` has its own migration plan and is out of scope.
2. **Export unification:** one shared engine, two schema sources (diffusion
   ontology; user-defined export columns); the shipped tool_export converges
   later, behind its existing parity gates.
3. **Topology:** spawned job-runner processes; main server = control plane;
   runner-on-a-separate-machine stays a deployment option (Postgres-claimed
   job queue, zero runner↔server RPC).
4. **The PHP model is not presumed correct.** PHP/Bun behavior is the oracle
   only at true contract surfaces (ontology semantics, client wire, published
   artifacts, shared state conventions). Internal mechanics are free to be
   replaced.

---

> **ADDENDUM 2026-07-29 — cutover lever 1 is now the default, not an opt-in.**
> `DEDALO_DIFFUSION_NATIVE` defaulted to unset-meaning-`false`, so an install
> that never wrote the key kept emitting `DEDALO_DIFFUSION_API_URL` and pointed
> `tool_diffusion` at a route this server does not serve — every call 404'd.
> The catalog default is now `true` (`src/config/catalog/diffusion.ts`) and the
> three readers use `readBool`, not `readEnv(...)==='true'` (which ignores
> catalog defaults). P5 step 3 below is therefore satisfied for the *client
> wire*: the key is no longer advertised by default. Gate:
> `test/unit/diffusion_native_default.test.ts`; ledger: WC-003 addendum.

> **ADDENDUM 2026-08-24 (module homes — the `resolve/` → `diffusion_bridge/`
> move).** The two core-side bridge modules this spec names under
> `src/core/resolve/` live in their own subsystem home now:
> `src/core/diffusion_bridge/diffusion_delete.ts` and
> `src/core/diffusion_bridge/diffusion_map.ts` (alongside `diffusion_graph.ts`).
> `src/core/resolve/` holds neither. Paths are corrected in place below; where
> the body names the files bare (`diffusion_map.ts`, `diffusion_delete.ts`) the
> filenames are still exact — only the directory moved. This is a MOVE, not a
> rewrite: the delete-propagation and section-map/delete-target cache designs
> §3/§4/§7/§10 describe are unchanged, and so is the §2 module boundary
> (`src/core/**` never imports the MariaDB client — the bridge is core-side, the
> MariaDB half stays in `src/diffusion/targets/mariadb/`).
>
> Date is the date of record, not of the move: repo history is squashed at the
> 2026-07-11 initial commit, so the move is not datable from `git log`.

## 1. Mission

Build the Dédalo **diffusion engine** as a native subsystem of the TS server in
`v7/master_dedalo`: ontology-driven publication of work records (Postgres
JSONB matrix) to external targets — MariaDB SQL tables, RDF, XML, Markdown,
CSV, JSON (new first-class), Socrata (stub). Design it as **one engine with two
schema sources** (the dd1190 diffusion ontology; tool_export's user-defined
column sets) and **pluggable format writers**, able to publish sections of
hundreds of thousands of records with millions of relations, in durable
background runs that survive browser disconnects, user logouts, and server
restarts.

**You are not porting the PHP+Bun split.** That architecture existed because
PHP couldn't do the work. You are re-founding diffusion on a single organizing
principle:

> **One compiler, one resolver, one IR, many writers.** Schema sources compile
> into a `PublicationPlan`. One streaming resolver turns plan + records into a
> typed intermediate representation. Format writers are plugins that consume
> the IR and know nothing about ontology or resolution.

## 2. Absolute constraints

> **Runtime note (2026-08-25, Bun 1.3.9 -> 1.4.0).** The `Bun.sql` MariaDB adapter
> changed two decodings, both verified against MariaDB 12.2.2 with a scratch table:
> `DATETIME`/`TIMESTAMP` now decode as **UTC**, where 1.3.9 read them as local time
> and shifted them (a `14:30` column came back as `13:30Z` under CET); and `JSON`
> columns now decode to **objects** instead of strings. Neither reaches the engine:
> every query Dedalo issues against a target pool reads only `section_id`, `lang`,
> `COUNT(*)` or INFORMATION_SCHEMA metadata, and the writer binds projected
> **strings**, never a JS `Date` — so a decode change cannot move written bytes.
> Recorded because the 1.3.9 hour-shift was real: anything that starts reading a
> DATETIME or JSON column back from a target must be written against the 1.4
> behaviour, not against what the old adapter did.


1. **The v7 diffusion ontology is the baseline input — but it is beta, not
   frozen.** Existing dd1190 subtrees (models
   `diffusion_domain/group/element[_alias]/database[_alias]/table[_alias]/diffusion_section/diffusion_component`
   + field nodes; `properties->diffusion->{type,service_name}`;
   `properties->process->{ddo_map,parser,...}`; parser fn names like
   `parser_text::text_format`; alias-wins resolution; labels-as-names) are the
   starting contract, and internal normalization into the PublicationPlan is
   where cleanup happens by default. However, since v7 `properties` is still in
   beta, **you may evolve the v7 properties format when the rethought design
   clearly benefits** (e.g. promoting a side-channel flag to a first-class
   property, retiring a parser fn in favor of a declarative field). Every such
   change must be: deliberate and user-approved, documented in a running
   "v7 properties changes" ledger, and shipped with the updated dd1190
   definitions so ontology and engine never diverge. Legacy v6
   `propiedades`/`process_dato` is out of scope (separate migration plan) — the
   engine reads v7 `properties` only.
   **Correction (2026-09-03, audit 2026-08-26 PUB-04 / P1-13).** The
   "starting contract" above was asserted, not measured: until this date every
   ontology the repo shipped spelled the output format with the RETIRED v6 key
   `properties->diffusion->class_name` (`diffusion_mysql`/`_rdf`/`_socrata`) —
   the install seed, the generic `test` TLD source of record and all 13
   importable packages carrying diffusion definitions — and several elements
   had no v7 block at all (the block only in v5 `propiedades`). The compiler
   reads `type` ONLY and has no alias, so on a fresh install no shipped element
   compiled. The rule stands and is now enforced in the three shipped copies:
   the seed is corrected at first boot by
   `install/db/migrations/0008_diffusion_element_type.sql` (a SHARED-ROW SEED
   CORRECTION moving `matrix_ontology.ontology18`, `dd_ontology.properties` and
   `dd_ontology_recovery` together, v5 copies left byte-identical), the JSON
   source of record and the packages were rewritten once
   (`scripts/seed_diffusion_type_rewrite.ts`). Retired keys are REPORTED,
   never aliased: `process_dato` in either shape (the shipped string fn, or an
   object with `parser`) compiles to a `retired_parser_spelling` degradation
   naming the field and the replacement (`process`). dd60
   (`diffusion_section_stats`, a v6 renderer with no v7 format) is the one
   shipped element that stays untyped and fails loudly. Gates:
   `diffusion_seed_compiles_native` (every shipped element of every domain
   through the real compiler, on the suite database as a booted install),
   `diffusion_seed_vocabulary_tripwire` (the three shipped copies + the
   mapping), `diffusion_publication_gate_native` (both `process_dato` shapes).
2. **Parity is judged at the artifacts.** The oracle contract surfaces are:
   (a) published MariaDB rows/schema, (b) rendered RDF/XML/MD files, (c) the
   copied tool_diffusion client's wire (action set + SSE format), (d) shared
   state conventions (dd1758 activity ledger, `.publication/` media markers).
   The internal PHP datum wire shape, parser side-channel flags, and chunking
   mechanics are **not** contracts — replace them.
3. **The copied client works with zero edits.** tool_diffusion JS falls back to
   the main API URL when `DEDALO_DIFFUSION_API_URL` is undefined
   (`tool_diffusion.js:251,363,404,543`) — serve the identical action set there
   and keep the SSE format verbatim (`"data:\n{json}\n\n"`, 16KB padding, 2s
   heartbeat, `X-Accel-Buffering: no`).
4. **Security ≥ PHP+Bun.** Every chokepoint in §8, fail-closed. The old
   engine's separate public socket + internal token surface must *disappear* at
   cutover, not be reproduced.
5. **Postgres only via `src/core/db/`; MariaDB only via
   `src/diffusion/targets/mariadb/`.** "Bun owns MariaDB" becomes a **module
   boundary**: `src/core/**` never imports the MariaDB client (enforce with a
   lint/grep gate). Amend `engineering/REWRITE_SPEC.md` §4 accordingly.
6. **Don't fork shared conventions.** dd1758 (publication ledger, actions
   published/unpublished/unpublish_pending, locator `section_id` serialized as
   *string*), the media-marker store (key `{section_tipo}_{section_id}`,
   `pub/`/`dbs/`/`auth/` layout, fail-closed web enforcement), and
   `section_record.delete()`'s "diffusion failure never blocks the work-system
   delete" invariant are shared with the rest of the system — reuse
   `src/core/diffusion_bridge/diffusion_delete.ts`'s implementations.

   **Retention of the ledger (audit 2026-08-26 PUB-14).** dd1758 is append-only
   and grows with how OFTEN you publish, not with how much you hold: one row per
   primary record per run, and republishing the same catalogue writes them all
   again (measured 293 MB for a single 500k-record run, inside the matrix
   database every backup copies). The rule is now stated and executable —
   `DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS`, registered in
   `src/core/retention/` and applied by
   `pruneSettledLedgerRows`. Default `0` = keep everything, which is the right
   default for a publication audit trail; what was wrong was having no rule at
   all while the job purge cited this table as "the durable audit trail".
   **PENDING rows are never pruned at any window**: an unpublish still owed to a
   public target is outstanding debt, not history, and dropping it would leave a
   withdrawn record live with nothing left to say it should not be.
7. **REWRITE_SPEC §2b code style and §4 request-isolation rules apply.** All
   mutable run state lives in a per-run context; the only process-global is the
   immutable plan cache.

## 3. Prime directive: master the diffusion concepts before coding

Study these in the reference trees, then re-express their *semantics*:

- **Flat virtual diffusion tree** —
  `diffusion_utils::get_virtual_diffusion_tree()`
  (`v7 .../diffusion/class.diffusion_utils.php:194`): dd1190 subtree flattened,
  aliases resolved in place (alias wins tipo/label, inherits properties,
  suppresses consumed real branch). Already part-ported in
  `src/core/diffusion_bridge/diffusion_map.ts`.
- **Element→database→table→field naming** — db/table/column names come from
  ontology node **labels** (alias-aware); field model → SQL column type
  (field_date→DATE, field_int→INT, field_varchar→VARCHAR(n),
  field_text→TEXT+FULLTEXT...).
- **A table's columns are its DIRECT children — never the recursive list.**
  The oracle reads `ontology_node::get_ar_children` (`v7 .../core/api/v1/common/
  class.dd_diffusion_api.php:996`), documented "direct (first-level only) child
  tipos" (`.../core/ontology_engine/class.ontology_node.php:1225`); an alias
  prepends its TARGET's direct children so alias-own children come last and
  override (`:1017-1018`). A `table` node may CONTAIN another `table` node
  (mdcat `documentales` → `documentales_portal`, 9 such pairs), so the
  *recursive* child list — which PHP builds "to populate the fields list for
  the UI" (`class.diffusion_utils.php:320`) and which
  `VirtualTreeNode.childrenTipos` mirrors — drags the nested table's fields
  into the PARENT table and emits a duplicate column when both declare the same
  field label. The plan compiler therefore reads `directChildrenTipos`;
  `childrenTipos` is for the info panel only (`diffusion/api/info.ts`, the twin
  of PHP `get_section_diffusion_nodes`). Note the oracle applies NO model
  filter: the nested `table` node itself still becomes a column (default TEXT)
  unless it declares `properties->exclude_column`. Gate:
  `test/unit/diffusion_nested_table_columns.test.ts`.
- **ddo_map chains** — per-field resolution paths
  (`{tipo,parent,section_tipo:'self',fn?...}`); terminal components yield
  values, relation components yield locators that are BOTH recursed per the
  chain AND queued breadth-first for top-level publication with a levels budget
  (`DEDALO_DIFFUSION_RESOLVE_LEVELS`, default 2), cycle guard, and per-run
  dedup (`diffusion_chain_processor`).
- **Parser chains** — ordered `{fn:"class::method", id?, options}` executed
  today in the old Bun engine (`diffusion/api/v1/lib/parsers/`, ~30 fns) with a
  state-machine chain (`diffusion_processor.ts:873-1070`).
- **Lang ladder** — one output row per lang, 5-level fallback: exact → nolan →
  main_lang → any → null (`diffusion_processor.ts:700-745`). Business-critical.
- **Publication gate** — `component_publication` per record + ontology
  `is_publishable` override; unpublishable ⇒ row/file **removal** (the old
  `fields:'delete'` sentinel), fail-closed.
- **Delete propagation + retry** — `section_record.delete()` → target
  resolution → per-format removal; failures → dd1758 `unpublish_pending`,
  retried at a run's start / after a `media_index` apply that held the fence /
  manually — there is no boot drain (native in
  `src/core/diffusion_bridge/diffusion_delete.ts`). Since 2026-09-03 (audit
  2026-08-26 P1-12): the pending rows are written INSIDE the delete
  transaction and settled post-commit (durable intent, LIFE-07); the file
  paths come from the ONE producer publish uses
  (`core/diffusion_bridge/published_files.ts`, PUB-03); the retry queue is
  drained least-recently-attempted first with an attempt stamp per row
  (`misc.dd1758_retry`), and never-resolving targets (csv/json full exports,
  an element without service_name, an rdf without an owl:Class for the
  section, an sql element without a database) are TERMINAL — ledgered with a
  reason, excluded from the queue, reported by the `public_tier` reconcile
  (PUB-02). Gate: `test/unit/unpublish_debt_native.test.ts`.
- **v6-parity side-channels** — `global_table_maps`, `merge_columns`,
  `preserve_order`, `empty_value`, `empty_to_string`, `default_value`,
  `add_parents`: today smuggled through the wire context; in the new engine
  these become **compile-time plan concepts** (§5).

Key oracle files: PHP `diffusion/class.diffusion_utils.php`,
`class.diffusion_chain_processor.php`,
`core/api/v1/common/class.dd_diffusion_api.php`,
`diffusion/class.diffusion_delete.php`,
`diffusion/migration/diffusion_ontology_migration.json`; old engine
`diffusion/api/v1/{index.ts, lib/types.ts, lib/diffusion_processor.ts,
lib/sql_generator.ts, lib/db.ts, lib/progress_store.ts, lib/media_index.ts,
lib/parsers/}`; TS tree `src/core/diffusion_bridge/{diffusion_map,diffusion_delete}.ts`,
`tools/tool_export/server/tool_export.ts`,
`src/core/components/{registry,types}.ts`.

> **Deliverable gate:** before feature code, write the TS model of these
> concepts (plan/IR/writer types + resolver flow) and validate it by compiling
> real dd1190 elements and replaying real publications against old-engine
> artifacts.

## 4. Architecture

### 4.1 Pipeline (the engine core)

```
[A] Schema source     dd1190 element | export column set
      │ compile (cached per ontology revision)
[B] PublicationPlan   immutable, serializable, principal-independent
      │
[C] Selection         sanitized SQO → keyset-batched cursor (buildSearchSql, principal-aware)
      │ per batch (~500 records)
[D] Resolution        plan × batch → RecordIR   (breadth-first relation frontier,
      │                levels budget, per-run dedup + related-record memoization)
[E] Transform         parser registry: pure ValueIR[] → ValueIR[]
      │
[F] Projection        lang ladder + field policies → ProjectedRow per lang (tabular)
      │
[G] Writers           DiffusionWriter plugins → target I/O layer
      │
[H] Ledger            dd1758 rows, media markers, run report
```

Stages C–G run as one streaming loop; a full run is never materialized in
memory.

**PublicationPlan** (stage B): compiled once per (element, ontology revision)
from the flat virtual tree — aliases resolved, ddo_maps → `ResolveStep[]`
chains, parser configs split (see §5), column defs typed, recursion policy
(`maxLevels`, dedup, cycle-skip) and lang policy explicit, v6 side-channels
promoted to `FieldPolicy`/plan tables. Plain JSON-serializable (dumpable,
diffable, shippable to a runner process). Cache: process-global map invalidated
**whole** by an ontology-revision counter bumped in the dd_ontology write layer.
The `diffusion_map.ts` section-map/delete-targets caches stay a SEPARATE
domain: they register their own clearers with the same ontology
cache-invalidation hub at module load (not by-products of plan compilation).

**Uninstalled ontology packages** (stage B): a Dédalo install carries only some
of the optional per-TLD ontology packages, so a shared diffusion element routinely
names tipos that do not exist here (e.g. the `zenon*` bibliographic nodes of
`src/external/services/zenon.ts` on an install that does not use Zenon). Compile
therefore splits the two reasons a tipo has no `dd_ontology` node — the same split
PHP draws with `check_active_tld` vs `check_tipo_is_valid`:

- the tipo's **TLD carries no ontology content** → the package is not installed
  on this deployment. Measured with `getPopulatedTlds`, NOT `getActiveTlds`:
  declaring an ontology creates its registry root `<tld>0` before anything is
  imported, and `check_active_tld` ("has rows") counts that lone row as
  installed. The ddo (or whole field) is SKIPPED with a
  `uninstalled-tld:<tld>@<field>` plan warning and a `[diffusion/compile]` log
  line. The field keeps its column, empty: the published schema must not shift
  with which optional packages an install happens to carry. A deployment fact
  must never fail an element's compile, and never blocks a run.
- the **TLD is installed but that node is missing** → an authoring defect, and
  still a hard `PlanCompileError` naming the field.

The field keeps its column, but WITHIN a multi-ddo field the skipped entry takes
its own leaf column with it, and that IS a wire divergence: PHP derives a datum's
`columns` from the full `ddo_map` with no ontology lookup
(`build_datum_context` :1288-1308), so the oracle joins an empty slot where this
engine joins nothing — `Historia, ` vs `Historia` on `rsc1194`. Accepted
deliberately; see `WC-2026-08-11-diffusion-uninstalled-package-skip`, which also
records why the `output_format` fallback still reads `ddo_map[0]` rather than the
pruned chain.

Gate: `test/unit/diffusion_plan_uninstalled_tld.test.ts` (both directions —
without the second case the rule would degrade into "diffusion never complains")
plus `test/unit/diffusion_compile_degrade_native.test.ts` for the divergence and
the `output_format` carve-out.

**RecordIR** (stage D output) replaces the dead PHP datum wire shape:
`{sectionTipo, sectionId, status: 'publish'|'unpublish', fields:
Map<planFieldId, FieldIR>}` where `FieldIR.values: ValueIR[]` are typed atoms
(`scalar|date|geo|chain|json`, lang-tagged; relation chains carry resolved
`{sectionTipo, sectionId, term?, model}` links with prefetched terms). The
`fields:'delete'` string sentinel, the load-bearing `"errors":[]`, and the
frozen datum key order all die with the seam.

**Resolution mechanics** (stage D): keyset pagination (never OFFSET); batched
matrix reads (`readMatrixRecords(ids[])` — add it; retire per-record loops);
relation frontier drained breadth-first per batch with one `IN` query per
section per level; LRU-bounded memo of resolved related records (thesaurus
targets repeat thousands of times per run); `Promise.all` within a batch
(I/O-bound), writers consume sequentially (transaction ordering, deterministic
files). Determinism for a given snapshot is a hard requirement (parity diffs +
resume equivalence depend on it).

**Computed-inverse relation hops** (stage D, added 2026-08-11): a `relation-hop`
step normally reads the record's STORED slice for the hop's tipo
(`record.columns.relation[<tipo>]`), because for most relation models the
locators ARE the stored data. Three models store nothing under their own tipo —
they are inverse questions answered per read, and a stored-slice dereference
returns `[]` for them, which produced zero atoms, an early return in
`fieldValuesToColumn`, and a NULL column with no error and no warning:

- **`relation_list`** — inverse references of the host record, narrowed by the
  ddo's section/component filters (`findInverseReferences`).
- **`component_relation_index`** — the inverse index ("who points at me?"), read
  from `matrix_relation_index`. The inverse question is ontology-derived:
  `resolveIndexConfig` (`src/core/relations/models/relation_index.ts`) yields the
  relation type (`properties.config_relation.relation_type ?? 'dd96'`) and the
  pointing sections (the `request_config` sqo targets, else `all`), and
  `findInverseReferenceLocators` (`src/core/search/search_related.ts`) answers
  it — the SAME two engines the edit read path rides, minus pagination: a
  publication takes the FULL inverse set, never an edit page (`limit: false`;
  the component's `editLimit` is an edit-view concern).
- **`component_relation_children`** — derived dd48 children, resolved through
  `getChildren` (`src/core/relations/children.ts`), the same engine
  `relationChildrenResolver` uses, with limit 0 = all.

**Only the locator SOURCE is model-aware.** Everything downstream of the locator
list is model-agnostic and driven by the diffusion node's own ddo chain: the
child-ddo recursion per locator, the fallback-to-the-locator value, the
breadth-first frontier queueing and its levels budget, the publishability gate
(`STRUCTURAL_HOP_MODELS` already keeps unpublishable structural locators in
values), `add_parents`, and the parser chain. A computed model must never grow a
resolution special case borrowed from another model's shape — the node defines
how its chain resolves, and resolution obeys THAT definition.

Both computed sources are memoized in per-run `RunContext` maps beside
`relationListCache`, keyed by record identity plus every resolved filter the
query depends on (index: hop tipo + relation type + target sections; children:
hop tipo). This is load-bearing, not cosmetic: an index hop on a hub record and
a `section_map`-ordered children hop each cost real queries per call, and a
publication revisits the same record through several fields. Locator
`section_id` is the canonical INT
(`engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md`);
`relation_list`'s `String()` is a pinned frozen-consumer edge and is NOT copied
to the computed sources. Ledger:
`engineering/wire_contract/WC-2026-08-11-diffusion-computed-inverse-hops.md`.

### 4.2 Runtime (control plane / data plane)

- **Control plane = main server.** All actions (`diffuse, get_process_status,
  list_processes, cancel_process, follow_queue, validate, get_diffusion_info,
  get_diffusion_status, retry_pending_deletions, rebuild_media_index,
  check_database, backup_database`) register in `src/core/api/dispatch.ts`
  under `dd_diffusion_api` (precedent: rebuild_media_index already there) —
  normal session auth, CSRF-equiv, allowlists.
- **`follow_queue` (WC-067, 2026-07-29)** is the odd one out and intentionally
  so: every other action is owner-scoped, this one is GLOBAL-ADMIN only, because
  each frame names every owner's active job. It streams the whole ACTIVE queue
  plus scheduler state for the `diffusion_server_control` maintenance widget.
  Its per-job key set is a narrow contract (nine display fields — never `spec`,
  `checkpoint`, `result`, `runner` or `errors[]`), because the frame is
  re-serialized once a second per connected admin; that makes the narrowness
  both the cost bound and the data-minimisation bound. Full shape, the
  SSE-framed refusal, and the cadence/lifetime rationale: `engineering/wire_contract/`
  WC-067.
- **Data plane = spawned runner.** `diffuse` enqueues a durable job; a
  scheduler claims it (`FOR UPDATE SKIP LOCKED`, global limit default 2,
  uniqueness: one active run per element+section — a second `diffuse` ATTACHES
  only when it is the same owner's identical run, anything else is the typed
  409 `diffusion.target_busy`, and the follow stream reads the job through an
  owner-scoped getter: DIFF-3, `WC-2026-09-30-diffusion-attach-scope`) and spawns
  `<this process' bun> run src/diffusion/runner.ts --job <uuid> --epoch <n>` — same
  codebase, own process, own memory ceiling, killable. The interpreter is
  `process.execPath`, never a bare `bun` off `$PATH`: a deployment pins an
  absolute binary its unit file's `$PATH` need not contain, and the spawn throws
  AFTER the row is claimed. That path fails the job it could not start — nothing
  else owns a claimed row with no runner behind it. Deletes/admin ops stay
  in-process (fast).
- **Dispatch control is the lifecycle surface.** There is no daemon to start or
  stop (WC-005), so `set_scheduler` — `pause` / `resume` / `drain_resume` — is
  what an admin actually operates. `drain_resume` quiesces: hold dispatch, wait
  for the running jobs, then resume and kick; bounded, and on timeout it stays
  paused rather than resuming over runners that would not drain. All in-memory,
  reset to running on restart. Shape: `engineering/wire_contract/` WC-075.
- **Claiming has ONE gate.** `DEDALO_DIFFUSION_SCHEDULER_ENABLED=false` means
  this process never claims — that is the key's whole promise (a second instance
  sharing the database, the ops smoke tests). It is enforced inside
  `schedulerTick`, not at the boot cadence, because claiming has three entry
  points: the cadence, the enqueue kick and the widget's requeue kick. Gate:
  `test/unit/diffusion_dispatch_gate.test.ts`.
- **Separate-machine option (design requirement):** the runner communicates
  *only* through Postgres (job claim, checkpoint, progress NOTIFY), the MariaDB
  targets, and the media path. A runner daemon on another machine claiming from
  the same queue must be possible without code changes — document the
  reachability requirements (Postgres, target DBs, shared media mount for file
  formats) and keep zero runner↔server RPC.
- **Durable jobs:** TS-owned tables `diffusion_jobs` + `diffusion_job_events`
  + `diffusion_job_ledger` (created by the TS tree, accessed only through
  `src/core/db/`). Job row:
  server-UUID `job_id` (the capability), `client_process_id` (the client's
  deterministic label — correlation only, never authorization), owner,
  immutable sanitized `spec`, `state`
  (queued/running/completed/failed/cancelled/interrupted), `checkpoint`
  (`{v: 2, cursor, run_started_at, processed, batch_seq, writer, errors}` —
  the primary keyset position, the number of committed batches, the writer
  session's own resumable state, the run's error lines so far), totals/ETA,
  bounded errors, runner pid/host, heartbeat. dd1758 remains the *user-facing*
  ledger; the queue is infrastructure (matrix-as-state is wrong for high-churn
  heartbeats/checkpoints — deliberate, documented exception to "no bespoke
  tables").
- **The lease is `(job_id, attempt)`.** A row can be claimed more than once —
  the sweep requeues a stale-heartbeat run and the next tick hands it to a new
  runner — so ownership must be checkable, not assumed. `attempt` is stamped
  inside the claim and is STRICTLY MONOTONIC for the life of the row, which
  makes each claim's number a unique EPOCH. The claim is the only statement that
  assigns it and only as `attempt + 1`; NOTHING rewinds it, because an epoch that
  can be re-issued is not an epoch (a reset hands the same number to a second
  claim while a slow-but-alive earlier holder still has it, and the fence then
  matches for the loser — an ABA, measured). Retry BUDGET therefore lives in
  `max_attempts`: the admin requeue grants it forward
  (`max_attempts = attempt + 3`) and leaves the counter alone. It travels to the
  runner on its argv (never re-read
  from the row: a re-read is a second race) and fences every write a lease
  holder makes — `recordRunnerPid`, `heartbeatJob`, `updateJobProgress`,
  `checkpointJob`, `finishJob` — with `AND attempt = $epoch AND state =
  'running'`. Zero rows affected throws `diffusion.lease_revoked` and the caller
  writes NOTHING; the runner treats it as an abort and exits without finishing
  the job, because the ending belongs to the live epoch. The control plane's own
  writes (the claim that issues the epoch, the sweep that revokes it, the cancel
  flag, the queued-row finalizer, the admin requeue) are unfenced by
  construction and enumerated in the census gate. The sweep deliberately does
  NOT cross-check `runner.pid`: a remote runner has no pid on this host, so pid
  liveness could only ever cover the local deployment — the epoch fence is the
  closure it was reaching for, and it holds whether the loser is alive or not.
  Gates: `test/unit/queue_fence_native.test.ts`,
  `test/unit/queue_fence_tripwire.test.ts`. Wire:
  `engineering/wire_contract/WC-2026-09-05-diffusion-lease-epoch-fence.md`.
- **The TARGET is fenced too (DIFF-2, 2026-09-30).** The epoch fences the job
  ROW; what two writers can corrupt is the publication TARGET (a MariaDB
  database, a files directory). Every durable effect of a run — the schema
  step, each batch, the close — is ONE unit (`jobs/target_fence.ts`
  `withFencedBatch`, over the bridge's lock `core/diffusion_bridge/target_lock.ts`
  — a core↔diffusion contract, so core's own doors can take it): one Postgres
  transaction that takes the target's advisory
  lock (`pg_try_advisory_xact_lock(17580002, hashtext('sql:<database>' |
  'files:<format>/<label>'))`, a try-lock loop that holds no connection while
  the target is busy and writes the busy message to the job row once), THEN
  re-reads the lease `FOR KEY SHARE`, then does the target I/O and the batch's
  tail (dd1758 rows — fatal on failure, run ledger, progress, checkpoint),
  committed together. A runner revoked while it waited writes nothing; the
  sweep takes stale rows `FOR UPDATE SKIP LOCKED` and so can never revoke a
  runner mid-batch (heartbeat / progress / cancel are NO KEY UPDATE and never
  wait on it); a record deleted while its batch waited is revalidated under the
  lock and unpublished. The other target doors take the same key: the record
  delete executor (on the request path it never waits — a busy target stays
  pending in dd1758; a retry drain — a run's start, a `media_index` apply
  that held the fence (`runMediaIndexReconcile`), the
  `retry_pending_deletions` action, the maintenance widget's retry — waits one
  10 s budget in all), the ghost
  unpublish, the lang sweep, the media-index apply. The two DELETE-ONLY doors
  (record delete — the MariaDB executor and core's files unlink alike — and
  ghost unpublish) take it SHARED: unpublishers never exclude each other, only
  the exclusive writers (runner unit, lang sweep, media-index apply). The per-target
  exclusion is batch-granular: two runs on one target interleave batch by
  batch, and since consolidated artifacts are built from each run's own ledger,
  that is equivalent to running them one after the other. ONLY a fence unit may
  hold a Postgres transaction across target I/O (no matrix row locks, bounded
  by `idle_in_transaction_session_timeout` = 300 s for a FROZEN holder; a live
  unit's timer keepalive resets the clock however long its target step takes);
  a runner needs a pool of at least two connections (the unit + its
  heartbeat). Because progress, checkpoint and the terminal transition ride
  the unit, their liveness stamps are the WALL clock (`clock_timestamp()`,
  never the transaction-start `now()`), and a heartbeat stamp never moves
  `heartbeat_at` backwards (`GREATEST`): a long unit's commit must not set the
  heartbeat back to when it began, or the sweeper — its KEY SHARE gone at
  commit — would revoke a healthy runner. The rdf/xml `abort()` sweeps no temps — it may run unfenced, and
  a `.tmp-*` in a shared directory may be another session's; the runner's
  FENCED close sweeps a crashed holder's leftovers.
  Gate: `test/unit/diffusion_target_fence_native.test.ts`. Wire:
  `engineering/wire_contract/WC-2026-09-30-diffusion-target-fence.md`.
  Ledgered residuals: a thawed zombie whose fence session Postgres killed can
  finish at most its one in-flight batch (a MariaDB `GET_LOCK` would close it
  for sql targets — owner call); a live unit whose
  target statement never returns (a lock wait, a half-open connection) holds
  its target — and every door waiting on it — until the runner is killed:
  the bound (a target socket/statement timeout, or a per-unit wall-clock
  ceiling) is an owner call (WC R4). The OPERATOR doors (the phantom-lang
  sweep, the ghost unpublish, the media-index rebuild/reconcile) never wait
  on it unbounded: ONE `OPERATOR_FENCE_BOUND_MS` (120 s) budget per call,
  a target still held when it is spent is reported busy, nothing written
  (gate `test/unit/diffusion_operator_fence_budget_native.test.ts`). The media-index store's apply
  doors ARE fenced, in `targets/mediastore/media_index.ts`: the reconcile
  checks before it writes (a database it did not hold voids the round) and
  the rebuild syncs each database under its fence (gate
  `test/unit/media_index_reconcile_fence_native.test.ts`).
- **Crash recovery:** boot + periodic sweep requeues STALE-HEARTBEAT jobs from
  their checkpoint (budget in `max_attempts`). Liveness is the heartbeat alone —
  never `runner.pid`, see the sweep note above; the epoch fence, not pid death,
  is what stops the old holder. THE RUN LEDGER (DIFF-1, 2026-09-30) is what
  makes the resume exact: a run's state is not its keyset cursor — the relation
  FRONTIER (records queued by processed records, drained after the primaries),
  the USED set and the per-record ARTIFACTS the run published all lived only
  in the dead runner's memory. (PHP's queue-time publishable overrides are NOT
  carried — neither in-run nor in the ledger: the drain asks the gate against
  the record as it is when drained, so a record unpublished while a run was
  down is never republished by its resume; WC-2026-09-30-diffusion-run-ledger.) Each
  committed batch now appends those transitions (`queue`/`open`/`used` from the
  resolver, `wrote`/`removed` from the writer) to the job-scoped
  `diffusion_job_ledger` in its own unit; a resumed runner replays them
  (`resolve/frontier_ledger.ts`) into the exact frontier, restarts the
  primaries after the cursor, reopens its writer from the checkpoint (csv/json
  truncate their job-scoped `.part-<job>` partial back to the checkpointed
  durable length), and the close consolidates the WHOLE run from the ledger's
  manifest. A pre-ledger checkpoint (no `v: 2`) restarts from zero. A cancelled
  run never consolidates (the ledger is kept: an admin requeue resumes it); a
  completed run clears it. What the ledger records is ON DISK before it is
  recorded (`src/core/files/durable.ts`, 2026-10-01): each file fsynced before
  its rename, a batch's directory fsynced once in the writer's `checkpoint()`,
  every close artifact (snapshot, archive, merged document) and its directory
  fsynced before the close returns — and the partial never unlinked before the
  snapshot replacing it is durable; a power cut cannot leave a "completed" run
  with empty, missing or resurrected files (gate: diffusion_file_writers
  "what survives a power cut"). Gates: `test/unit/diffusion_resume_ledger_native.test.ts`
  (a crash among the primaries, a crash inside the frontier drain, a real
  kill -9 → byte-identical trees; exactly one dd1758 row per primary; cancel
  leaves the published archive unchanged), `test/unit/diffusion_frontier_replay.test.ts`
  (every cut of a real resolution). Wire:
  `engineering/wire_contract/WC-2026-09-30-diffusion-run-ledger.md`.
- **Progress:** SSE handlers are views over the durable job row — any server
  instance can stream any runner's progress. Keep the old status vocabulary and
  every field `render_tool_diffusion.js` consumes; echo `client_process_id` so
  the client's reconnect (`list_processes` → find by process_id →
  `get_process_status`) works unchanged.
- **Progress transport is a server-side POLL, not `LISTEN/NOTIFY` — a recorded
  NEGATIVE RESULT, not an oversight.** This section originally specified
  LISTEN/NOTIFY and the implementation has always polled; the decision is
  written down here (2026-07-29) so it stops being re-litigated every time
  someone reads `pg_notify` in `jobs/queue.ts` and assumes a subscriber was
  forgotten. Why polling stands: each tick is ONE indexed sub-millisecond
  statement (`getJobById` for a single run; `listActiveJobs` over the partial
  state index for `follow_queue`), the value observed only moves once per
  `DEDALO_DIFFUSION_BATCH_RECORDS` batch so a faster transport would observe
  nothing new, and a `LISTEN` connection is a long-lived DEDICATED Postgres
  connection — not something the pooled `sql` accessor in `src/core/db/` hands
  out, and a subscriber registry would be exactly the module-level state
  `module_state_tripwire` exists to keep out. The in-process fan-out pattern
  proven in `src/core/media/jobs.ts` does not transfer either: the runner is a
  SEPARATE PROCESS, so there is no local emitter to subscribe to. The
  `pg_notify` emitted on every observable change stays as forward
  compatibility. Revisit when either changes: Bun.sql grows a notification API,
  or `src/core/db/` gains a sanctioned dedicated-connection seam.
- **`src/core/tools/background.ts`** stays for cheap tool actions; generalizing
  it onto the job service is a ledgered follow-up, not a dependency.

### 4.3 Writers and the target I/O layer

```ts
interface DiffusionWriter {
  readonly format: string;                          // ontology properties->diffusion->type
  open(plan: PublicationPlan, context?: {jobId: string; resume: unknown | null}): Promise<WriterSession>;
}
interface WriterSession {
  readonly continuity: 'fresh' | 'resumed' | 'restart_required';
  ensureSchema(): Promise<void>;      // ONCE per run, serialized per table (DDL auto-commits!)
  writeRows(section, rows): Promise<WriteBatchResult>;
  removeRecords(section, ids): Promise<WriteBatchResult>;  // unpublish + delete propagation
  takeArtifacts(): ArtifactEvent[];   // per-record files wrote/removed → the run ledger
  checkpoint(): Promise<unknown>;     // durability barrier; the resumable state (JSON)
  runSummary(): WriterRunSummary;     // counts so far (resumed counts included)
  close(ctx?: WriterCloseContext): Promise<WriterRunSummary>; // consolidate the RUN (ledger manifest)
  abort(): Promise<void>;             // release handles; never consolidates, never sweeps shared temps
}
```

Consolidated artifacts (the rdf/xml merged document, every zip) are built
STREAMED in bounded memory (PERF-2/DIFF-4, 2026-09-30): the merge reads one
part at a time and writes through a file handle; `createZip` stores each file
from disk twice through ONE open handle (CRC + size, then bytes —
`core/files/zip.ts` `addStoredFile`; an unlink after the open cannot break the
entry), byte-identical to the frozen in-memory STORE writer, refusing
duplicate entry names (case-insensitive), typed, and an empty archive — typed
by default, or landing nothing (`empty: 'none'`, the markdown close over a
manifest whose files were all unpublished mid-close). Gate:
`test/unit/diffusion_artifact_rss_native.test.ts` (spawned-child peak RSS).

Registry keyed by the ontology `type` string; unknown type = loud `validate`
error (never a silent no-op). Adding a community format = ontology extension +
one registered writer.

- **mariadb-sql**: Bun-native `Bun.sql` (mysql/mariadb adapter) isolated in
  `src/diffusion/targets/mariadb/`, gated by the P2 driver spike
  (DIFFUSION_PLAN D1); `mysql2` is the contingency if the spike finds a gap
  (port the old engine's proven db.ts/sql_generator patterns + tests either
  way).
  Self-evolving **additive-only** schema (CREATE IF NOT EXISTS +
  INFORMATION_SCHEMA diff → ALTER ADD), run-start critical section, then pure
  DML. **True multi-row batched upserts** (~200 rows, `max_allowed_packet`-aware;
  PK `(section_id, lang)`), transaction per write-batch (never per run),
  batched sentinel deletes (errno 1146/1049 tolerated). Bounded channel (2–4
  batches) between resolution and writes for backpressure. Pool per target db;
  runner owns write pools; main server keeps a tiny pool for deletes/admin.
  Socrata = dormant registry alias of this writer (confirm with the user
  whether Socrata is still live before investing more).
- **rdf / xml**: consume RecordIR; one deterministic file per record (path
  logic exists in `diffusion_delete.ts`); rendering absorbs the old PHP
  `diffusion/parser/*` set (killing the second parser language); `close()` does
  type-aware merge + ZIP, all temp+rename.
- **markdown**: rides the tabular semantics (as today), per-record .md, ZIP
  only.
- **csv / json**: new first-class; one streamed file per table target, ZIP on
  close.

### 4.3.1 Published-language coherence and the phantom-lang repair — 2026-08-23

**The policy.** The publication language set is resolved ONCE, at boot, as
`config.diffusion` (`resolveDiffusionLangs`, `src/config/config.ts`). Unset, it
DERIVES from the project languages; set, it is a SUBSET override, order
preserved — `langs[0]` is the main language. It used to be re-derived at every
plan compile from a raw `readEnv` plus a hand `.split(',')` in four places,
which is how a JSON-encoded value became four phantom "language codes" that were
published as real rows. A code that is malformed, or outside the project
languages, is reported at boot and REFUSES the publication plan
(`langPolicyErrors`); it never stops the engine booting, because a
publication-only setting must not take the CMS down.

**Why a republish does not repair it.** One target row per policy language, PK
`(section_id, lang)`, and publication is `INSERT … ON DUPLICATE KEY UPDATE`
(`targets/mariadb/sql_generator.ts`). A republish updates the rows the policy
names and NEVER removes the others, so the publication API keeps serving the
phantom rows until they are swept. Detection compares the POLICY against what is
PUBLISHED — `targets/mariadb/lang_sweep.ts`, surfaced as the `diffusion_langs`
row of `check_config` and as `dd_diffusion_api sweep_published_langs`
(admin-only, reports before it removes, `confirm:true`, deletes only enumerated
values, never a `NOT IN` predicate, and refuses any language still in the policy).

**Which tables the sweep may touch — the safety property.** A publication
database is routinely SHARED with other content, so "has a `lang` column" is not
evidence a table belongs to diffusion; sweeping on that alone would `DELETE` from
a stranger's table. Discovery therefore POSITIVELY identifies a diffusion-created
table and requires BOTH markers: the exact anatomy `generateCreateTable` emits —
a two-column `PRIMARY KEY` that is `(section_id, lang)` in that order, read from
`INFORMATION_SCHEMA.STATISTICS` — AND a table name the install's own diffusion
MAP declares. Either test alone is a guess: the key shape is one another product
could satisfy, and the map alone names a table someone else may own. A table
failing either test is never read, never deleted from, and is COUNTED as
`unmarked_tables`, so the narrowing is visible rather than silent. An install
with an empty diffusion map has nothing sweepable. Gate:
`test/unit/diffusion_lang_sweep_native.test.ts`, which asserts that no statement
of any kind reaches an unmarked table.

**Phantom langs have two causes, and only one is repaired by deleting.** Debris
(`["lg-cat"`) is a value that was never a language code — nothing legitimate is
stored under it, so the sweep is the repair. A well-formed code (`lg-cat`) the
policy no longer names is usually a LOST policy: with `DEDALO_DIFFUSION_LANGS`
unset the set derives from the project languages, which may be narrower than what
was published, and those rows are real translations. The `check_config` row
reports the two separately and names the sweep only for debris — for a
well-formed phantom it points at the policy first, because sweeping there
destroys data.

### 4.4 Language model

The 5-level ladder lives in **Projection** as one pure, exported,
table-driven-tested function — not in writers, not in resolution (the IR keeps
all langs so future formats choose their own policy).
`FieldPolicy.emptyToString/defaultValue/emptyValue` apply here, in one place.

### 4.4.1 Names vs labels: which diffusion nodes have a machine name — 2026-11-04

`engineering/wire_contract/WC-2026-11-04-ontology-machine-names.md`. This
supersedes the "labels-as-names" wording above (§2, §4.1, §8): a node that
NAMES a publication object is identified by `dd_ontology.machine_name`, which
has no language. Only a LABEL node is read through its translations.

**Name models.** The closed list is `NAME_MODELS` in
`src/core/ontology/machine_name.ts`, the single source; the PHP upgrade step
copies it. For diffusion it holds:
- `database` and `database_alias` (the target database);
- `table` and `table_alias` (the target table, and an rdf class file's
  `SectionPlan.tableName`);
- the 11 `field_*` models (the column name);
- `diffusion_domain`, matched against `DEDALO_DIFFUSION_DOMAIN`;
- `rdf:predicate`, `rdf:subject`, `rdf:object`, `owl:ObjectProperty` and
  `owl:Class` (QNames, and the rdf file name on both the publish side and the
  delete side).

Every model definition under dd2 is a name node too.

**Label models.** These are found by model, by `properties.diffusion.type` or
by `service_name`, never by their term:
- `diffusion_element` and `diffusion_element_alias`;
- `diffusion_group`, `diffusion_section`, `diffusion_section_stats`,
  `diffusion_component` and `diffusion_head`;
- the document containers `xml`, `rdf`, `head`, `body` and `structure_data`.

Their term only reaches display (`api/info.ts`) and the alias-dedup sets.

**One reader.** `nameOrLabelOf` in `src/core/ontology/labels.ts` is the only
place that turns a node into its identifying string. It returns `machine_name`
when `use_machine_name` is set, strictly (NULL on a `missing` or `collision`
defect, never a guessed translation), and otherwise the label chain. It
replaced three first-non-empty readers: `virtual_tree` termLabelOf,
`diffusion_graph` termOf and `published_files` publishedTermLabel. The publish
and delete sides therefore cannot name a node differently.

Consequences:
- A mixed walk (the virtual tree, alias dedup, the rdf importer) branches per
  node on the flag.
- A table whose name collided refuses its element's compile, through the
  identifier chokepoint (§8).

**Gates.**
- `machine_name_outcome_native` (G1) covers every consumer named above.
- `machine_name_classification_native` (G5) keeps each dd1226 model classified
  as a name model or a label model, with the label list declared in the gate.

## 5. Parser registry (the compatibility surface, rethought)

Every fn name in the old engine's registry stays **resolvable** — but split at
compile time:

1. **Compile-time rewriters** (never run at runtime): locator re-synthesis dies
   (IR keeps typed chains); `parser_locator::parents/filter_*/truncate_*/slice`
   → chain-transform options on `ResolveStep`; `global_table_maps` → plan
   lookup tables; `parser_global::merge_columns` → synthetic merged fields;
   `publication_unix_timestamp` → a `{kind:'system'}` source step; the context
   flags → `FieldPolicy`.
2. **Runtime parsers** (~12 survivors, pure
   `(ValueIR[], options, ctx) => ValueIR[]`, **no I/O** — terms are prefetched
   by the resolver): text format/map/join, the date forms, helper
   first/tail/count/merge, iri/geo/info/map, and the trivial locator
   projections (get_section_id etc., names honored).

Unknown fn in an institution's ontology = **compile error surfaced by
`validate`** — never a silent skip.

Because v7 `properties` is beta (§2.1), the registry may also be *simplified at
the source*: where a parser fn or option exists only to patch a v6-parity
quirk, prefer proposing a v7 properties change (with updated dd1190 definitions
and a ledger entry) over carrying the quirk into the new engine forever.
Compatibility-by-normalization is the default; ontology evolution is the escape
hatch when normalization would enshrine a mistake.

## 6. Export unification (design now, converge later)

Build the shared primitive as part of the core: an optional
`resolvePublicationValue` on the component descriptor contract
(`src/core/components/types.ts`) — the TS successor of
`component_common::get_diffusion_data`: typed values from stored matrix data,
no formatting, no lang collapsing; relation models return chains the resolver
queues. A `defaultPublicationValue` covers most of the 38 models; only the
relation family + date/geo/iri/media/publication need bespoke resolvers.

The plan compiler gets a second front-end signature —
`compileExportColumns(ar_ddo_to_export) → PublicationPlan` — proven with the
CSV writer. **Do not refactor the shipped tool_export in the initial build**;
migrate it onto the primitive in a later phase behind its existing parity
gates. The standing rule: no third resolution walker may ever be written.

## 7. What is deliberately killed (and why)

| Killed | Replaced by |
|---|---|
| PHP↔Bun seam, per-chunk PHP re-entry, cookie/CSRF forwarding, session_write_close deadlock dance | native in-process resolution |
| Half-resolved datum wire + `diffusion_datum`/`diffusion_data_object` + `fields:'delete'` sentinel | typed RecordIR + `status:'unpublish'` + writer `remove()` |
| Context side-channel flags | compile-time `FieldPolicy`/plan concepts, applied once in Projection |
| Second (PHP) parser set for RDF/XML | rdf/xml writer rendering helpers; one registry, one language |
| chunk_size=1, per-record INSERT loops | keyset batches + multi-row upserts |
| In-memory progress store (lost on restart), split retry state | durable Postgres job queue + checkpointed resume |
| Public engine socket + `X-Diffusion-Internal-Token` | main-API dispatch + CLI entrypoints with a system principal (removal is a cutover step) |
| Per-run virtual-tree walks | revision-cached compiled PublicationPlan |

## 8. Security chokepoints (all fail-closed; adversarial review mandatory)

1. Single dispatch chokepoint: main-API class/action allowlist, session auth,
   CSRF-equiv, principal gating; SEC-13 read-perm on the source section at
   enqueue, re-asserted at job start (start-time authority for overnight runs —
   documented).
2. Server-generated UUID job capability; status/cancel authorized by owner
   match or admin, never id knowledge.
3. **Identifier grammar chokepoint (critical, new emphasis):** db/table/column
   names derive from institution-editable ontology labels → one
   `validateSqlIdentifier` function (strict `^[a-z][a-z0-9_]{0,63}$`
   post-sanitize) applied at plan validation before any run; backtick-quoting
   everywhere regardless. Mirrors REWRITE_SPEC §7.6.
4. Values always parameterized; selection always through `sanitizeClientSqo` +
   `buildSearchSql` with the caller's principal; job spec stores only the
   sanitized SQO.
5. Publication gate fail-closed: any resolution error on the gate ⇒ unpublish,
   never publish.
6. Per-target-db MariaDB user with minimal grants (deployment requirement).
   NOTE (2026-07, audit S2-35): no mysqldump surface is implemented anywhere —
   MariaDB publication tables are DERIVED data; additions and changes are
   rebuildable by re-publishing. **Deletions are NOT** (amended 2026-09-03,
   audit 2026-08-26 LIFE-02): delete propagation is event-driven, a restored
   matrix emits no event for rows it no longer holds, and a re-publish is a
   per-record upsert against tables that are never truncated — so a ghost
   row survives every re-publish and a later re-minted id replaces its content
   under the same public URL. The public tier is therefore RECONCILED, not
   rebuilt: the `public_tier` definition in the reconcile registry
   (`src/diffusion/targets/mariadb/public_tier_reconcile.ts`, operator-run,
   dry by default) compares MariaDB rows, `.publication/dbs` markers and the
   per-record rdf/xml/markdown files against record existence + the
   publication flag, reports ghosts / missing publications / the pending and
   terminal dd1758 debt, and on apply unpublishes ghosts only — an unreachable
   target is reported, never silent. Run it after every matrix restore. Back
   the tables up externally if desired (see engineering/PRODUCTION.md, backup
   set). If a dump surface ever lands: mysqldump via argv + `MYSQL_PWD`,
   validated names, version-probed binary, output outside web root.
7. Media markers in lockstep with dedalo-media-protection; marker failures
   never fail a run; `reconcile()` on boot.
8. **Publication scope is the ELEMENT's, never the caller's** (decided
   2026-09-03, audit 2026-08-26 CARRY-03 / DIFF-C). A plan spans whatever
   sections its element declares; the PRIMARY selection is principal-scoped
   (the enqueuing caller's projects predicate), and every FRONTIER record —
   reached through a stored locator — passes the same two keys the search and
   export surfaces apply (`security/frontier_scope.ts`, property 3): section
   grant, then record scope. A record the caller may not read is DROPPED from
   the run with a `[frontier] REFUSED` ledger line naming the section and the
   key — never published, and never marked 'unpublish' either (a caller who
   cannot read a record must not be able to remove it from the public tier).
   A dropped record's publication state is left exactly as the last run that
   could read it set it. `diffuse` therefore stays enqueueable by non-admins:
   with DIFF-B stripping `skip_publication_state_check` and clamping `levels`,
   a scoped caller can only move records inside their own scope, under the
   per-record publication gate (item 5). Gate:
   `test/unit/diffusion_frontier_scope_native.test.ts` (the flag ↔ frontier
   census and the drop-and-ledger law); class gate `frontier_class_native`.

## 9. Phases & parity gates

- **P0 — Foundation.** Job tables + scheduler + runner skeleton + SSE control
  plane serving the verbatim action set over a stub job. Pin the old engine's
  exact `list_processes`/status payloads from
  `lib/progress_store.ts`/`lib/status.ts` first. *Gates:* golden SSE transcript
  vs a recorded old-engine stream; Chrome-MCP smoke with the byte-identical
  client, zero client edits. Ask-the-user items: Socrata liveness; any non-tool
  consumers of the old engine socket.
- **P1 — Plan compiler + resolver + IR.** dd1190 → PublicationPlan (subsuming
  diffusion_map.ts), component primitive, parser split, lang ladder. *Gates:*
  compiled plans for real elements diffed against PHP virtual-tree semantics;
  old-engine processor fixtures replayed through a one-way `legacyDatumToIR()`
  test adapter; ladder table-tests.
- **P2 — SQL path.** MariaDB target module + writer; in-process delete path
  (drop the socket hop in diffusion_delete.ts). *Gates (functional, like the
  old engine's ~180-test discipline):* publishing a fixture element **creates
  the database/tables, adds the typed columns (model→SQL type, indexes,
  additive evolution), and sets the data rows** (upsert per lang, ladder
  correct, sentinel deletes remove rows) — asserted by env-gated real-MariaDB
  integration tests + the old engine's ported golden fixtures
  (processor/sql_generation). Old-engine output comparison on a small fixture
  is a **spot-check aid**, not a byte-identical requirement.
- **P3 — File paths.** rdf/xml/markdown, then csv/json. *Gates:* published
  files exist at the deterministic paths with correct rendered content per
  fixtures; merge/zip products valid; `.publication/` marker tree correct after
  publish and delete. Spot-check against old-engine output where convenient.
- **P4 — Durability & scale.** *Gates:* kill -9 runner mid-run → resume →
  byte-identical artifacts — CLOSED 2026-09-30 by the run ledger:
  `test/unit/diffusion_resume_ledger_native.test.ts` (before it the claim was
  false: a resume lost the relation frontier and archived only the resumed
  session's files); server restart mid-run → job resumes; cancel
  semantics; throughput benchmark vs old engine recorded (expect
  order-of-magnitude on SQL).
- **P5 — Convergence & cutover.** Admin ops re-homed; maintenance widget
  re-pointed; staged cutover: (1) deletes+retries native, (2) per-element flag
  routes `diffuse` to the new engine with the old engine idle as fallback
  (coexistence is safe on the same MariaDB for *different* elements —
  idempotent upserts, additive schema — but never run both on the same
  element+section), (3) remove proxy route + `DEDALO_DIFFUSION_API_URL` +
  internal token; decommission. Old wire-contract goldens retire with the seam;
  their fixture *data* is retained against the IR→SQL layer; the client-facing
  SSE/action contract gets standing golden transcripts. tool_export migration
  onto the shared primitive follows as its own parity-gated phase.

## 10. Definition of done

- **The publish process works end-to-end, verified functionally:** for real
  dd1190 elements, a run creates the target databases and tables, adds the
  typed columns (with additive schema evolution on re-runs), sets the data rows
  (per-lang upserts, lang ladder, publication gate), and removes rows/files on
  unpublish/delete — proven by the engine's own test suite (unit + env-gated
  real-MariaDB/file integration tests + golden fixtures carried from the old
  engine). Old-engine comparison is a spot-check tool, not the bar.
  Compatibility of previously published **v6 diffusion data** is a separate
  migration process, out of scope.
- Copied client works with zero edits; runs survive disconnects, logouts,
  restarts; kill/resume is byte-equivalent (gate:
  `test/unit/diffusion_resume_ledger_native.test.ts`).
- Runner placement (local spawn vs separate machine) is a deployment choice; no
  runner↔server RPC exists.
- Security posture strictly stronger: no public engine socket, no internal
  token, identifier chokepoint on ontology-derived names, minimal-grant DB
  user.
- Export-ready: the shared primitive + CSV writer prove the two-schema-source
  design; tool_export migration is unblocked and ledgered.
- Measurably faster than the old engine on representative sections; benchmarks
  recorded.
- Coverage ledger maintained (STATUS.md convention) — nothing silently
  narrowed.

## 11. Method

Follow REWRITE_SPEC §9b sub-agent orchestration: spec-extractor agents against
the PHP/old-engine oracles, implementer + parity-tester pairs per phase,
security review on §8, synthesis pass for §2b style uniformity. When a
diffusion ontology semantic is ambiguous (e.g. an obscure parser option only
one institution uses), **ask — never invent**.
