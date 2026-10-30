# WC-2026-10-30-search-referenced-by-leaf — the `referenced_by` SQO filter leaf and the `relation_targets` action

- **Date:** 2026-10-30 (plan "Open relationships → server-side `referenced_by` filter").
- **Decision:** DEC-12 (gated: `test/unit/referenced_by_filter_native.test.ts`,
  `test/unit/relation_targets_native.test.ts`, the inherited-filter case in
  `test/unit/sqo_session.test.ts`, the TM refusal in `test/unit/tm_filter.test.ts`, the client suite `client/dedalo/test/client/js/test_open_related_data.js`).
- **Shape before (TS):**
  - No relational filter form. "Open relationships" (inspector button, and the portal's
    "List from component data" button) sent `read_raw` with `options.type: target_section`
    on the source SQO's FIRST PAGE — clamped by `sanitizeClientSqo` to 1000 rows, the
    truncation visible only in a server log — read every row with one `readMatrixRecord`,
    shipped every target id to the browser, and opened one window per target section with a
    `section_id` comma-list `q`. That list was pinned in the session and re-sent on every
    page of the opened window. Wrong for any found set above 1000; cost grew with the
    relation.
  - The target sections offered by the modal were guessed client-side from the
    `component_portal` models in the loaded context (empty in list mode, blind to whether a
    target had rows).
  - A filter item carrying a `referenced_by` key and no `path` fell into the pathless-leaf
    drop, i.e. was silently ignored — which would have widened T to the whole section.
- **Shape after (TS):**
  - **Leaf** (any position inside `sqo.filter` `$and`/`$or`; the leaf object holds EXACTLY
    one key):

    ```json
    { "referenced_by": {
        "section_tipo": ["oh1"],
        "filter": { "$and": [ … ] },
        "filter_by_locators": [ { "section_tipo": "oh1", "section_id": 1 } ],
        "filter_by_locators_op": "OR",
        "from_component_tipo": "oh24"
    } }
    ```

    Meaning: the rows of the SQO's own section(s) T whose `(section_tipo, section_id)` is
    the TARGET of a locator STORED by a row of the source set — "records of T referenced by
    any record matching S". The pair is matched on the row's own `section_tipo`, so a
    multi-section T is exact.
  - **Forward lookup reads the ORIGINAL data, never the derived index.** The locators are
    the source rows' own `relation` jsonb column, expanded in SQL
    (`storedLocatorExpansionSql`, builder_referenced_by.ts — the ONE spelling, shared by the
    leaf and the census through `buildOwnerRelationScope` → `OwnerRelationScope
    {locatorsSql, tokenValues}`). Semantics = `read_raw` `type: target_section`
    (`harvestTargetLocators`): every key of the relation object, array values only, a
    non-object relation / non-array value / non-object entry contributes nothing,
    `locator.section_tipo` matched against T, the component key asked of the row's own
    section on the relation object's key. `matrix_relation_index` is NOT read on this path:
    that copy can drift (`session_replication_role = replica`, `DISABLE TRIGGER`,
    `pg_restore --disable-triggers`, `TRUNCATE`) and does not exist for log tables, so the
    answer has no index-coverage or index-drift dependency. The index stays the engine of
    the INVERSE lookups (`relation_list`, delete propagation) — unchanged.
  - **Compiled shape (fixed — part of the contract):**
    `((t.section_tipo, t.section_id) IN (SELECT DISTINCT l.target_section_tipo,
    l.target_section_id FROM (<stored locators of the source scoped row set, keyed>) l
    WHERE l.target_section_tipo IN (<T's sections>))) IS TRUE`. `<stored locators>` =
    `SELECT r.target_section_tipo, r.target_section_id FROM (<lateral expansion of
    buildScopedRowSetSql(source, withRelation)>) r WHERE <int4-addressable> AND <component
    key> [AND r.from_component_tipo = …]`. The source row set is the list's own WHERE
    (`buildScopedRowSetSql`, shared with `buildPlainSearchSql`; `withRelation: true` also
    projects the row's `relation`, so no join back to the matrix table): section pin, root
    exclusion, conformed filter, projects/owner ACL, the user-records filter. Every value is
    a NAMED bound token (`_RS<d>n<i>_` row set, `_RK<d>n<i>_` component key, `_RT<d>n<i>_`
    the T pin from the outer scope's `mainSectionTipos`). `IN … IS TRUE` keeps the sublink
    out of semi-join pull-up and `DISTINCT` keeps its row estimate small, so the planner
    always runs it as ONE hashed SubPlan: the source set and its expansion execute once,
    each T row probes the hash. Measured on the suite DB (zz* situation, 1037 sources,
    1038 targets, stale stats forced): a plain `IN` (pulled-up semi-join) chose a nested
    loop re-running the expansion per T row — 3.9 s flat, 16.6 s depth 2, > 20 s depth 4;
    a `MATERIALIZED` CTE rescans per T row (quadratic); the fixed shape 8 ms flat / 4 ms
    depth 2 / 4 ms depth 4 (10 / 2 / 5 ms after `ANALYZE`). Trade-off: T's own section is
    always scanned in full (no index probe from a small target set); the hash is in memory,
    sized by the distinct targets.
  - **Source keys (strict schema, `referencedBySourceSchema`, no passthrough):**
    `section_tipo` (string[], min 1, required); `filter` (same node schema as `sqo.filter`,
    root `$and`/`$or`, may itself contain `referenced_by` leaves); `filter_by_locators`
    (max 1000 pins); `filter_by_locators_op` (`OR` only — `AND` is refused, not narrowed);
    `from_component_tipo` (optional). Any other key (`limit`, `offset`, `order`, `mode`,
    `id`, `parsed`, …) or any key beside `referenced_by` on the leaf is refused: the source is
    the WHOLE found set by definition. Server-only keys are stripped recursively inside
    nested sources.
  - **Nesting:** `MAX_REFERENCED_BY_DEPTH = 4` (beside `MAX_SQO_DEPTH`); a top-level leaf is
    depth 1, depth 5 is refused. `MAX_SQO_DEPTH` / `MAX_SQO_NODES` still bound the whole
    object. Validated at `sanitizeClientSqo` (`assertReferencedByTree`) and again in
    `conformFilter` (server-built SQOs).
  - **Session:** the leaf lives in `filter`, so `mergeSessionSqo` hands it to the opened
    window's later pages unchanged — no id list is pinned any more.
  - **New action** (dd_core_api, read-only, `requirePrincipal`; action-specific input in
    `rqo.options`, the `read_raw` precedent — no `rqo.sqo`, so no page clamp):

    ```json
    { "dd_api": "dd_core_api", "action": "relation_targets",
      "options": { "source": { <exactly a referenced_by source object> } } }
    ```

    Response `data`: `[{ "tipo": "rsc197", "label": "People", "total": 12 }, …]`, ordered
    by `tipo`, labels in the request's application language. Targets the principal cannot
    read, targets with no matrix record table (logged) and targets with total 0 are omitted;
    `[]` = no targets (the modal shows `no_target_sections`). The client builds ONE source
    object and reuses it verbatim, here and as `{referenced_by: source}` in the opened
    window's filter; portal mode puts `from_component_tipo` inside the source.
  - **Census = TWO statements, whatever the number of targets** (`countRelationTargets`,
    search/relation_targets.ts), both over the SAME stored-locator SQL as the leaf
    (`OwnerRelationScope.locatorsSql`), so census and window cannot disagree about which
    locators exist:
    1. grouped: `SELECT l.target_section_tipo, count(DISTINCT l.target_section_id) FROM
       (<owner locators>) l GROUP BY 1` — the candidates and their UPPER BOUND; a candidate
       is kept only when openable (valid tipo, matrix record table) and readable (read ≥ 1).
    2. exact totals in ONE statement: `WITH census_targets AS MATERIALIZED (SELECT DISTINCT
       tipo, id FROM (<owner locators>) l WHERE tipo IN (<kept>))` then one branch per kept
       T, `UNION ALL`: `count(*)` over T's scoped row set (`buildScopedRowSetSql
       {section_tipo:[T]}` — the window's own WHERE: pin, root exclusion, T's records ACL,
       dd478) `WHERE ((tipo, id) IN (census_targets of T)) IS TRUE` — the leaf's hashed
       shape. The identical row predicate as the window's `full_count`, so `total` is EXACT
       and equals what the opened window paginates; total 0 → omitted.
    Why exact, not the grouped bound: the grouped count overstates targets through dangling
    locators (measured on the suite DB, pre-switch: es2 17 vs 1 exact; dd1706 18 vs 0; dd128
    4 vs 0).
  - **Whole-census deadline.** The census runs in one transaction with ONE deadline fixed at
    start: `RELATION_TARGETS_BUDGET_MS = 30000`, capped by the request pool ceiling
    (`DB_STATEMENT_TIMEOUT_MS`; its default 0 = no cap). Before EACH statement `SET LOCAL
    statement_timeout` = the time LEFT, so the statements can never sum past the budget;
    none left = refused without sending the statement. Either way the answer is the typed
    `db.statement_timeout` (503) with the door's coordinates (`door: relation_targets`,
    `ceiling_ms`). Inside a caller's transaction the census joins it and that ceiling
    governs. Internal override `RelationTargetOptions.budgetMs` (positive finite ms, else
    `internal.invariant`; still capped by the pool ceiling; not reachable from the wire — the
    handler passes only `principal` and the session's `supersessionKey`); < 1 ms refuses deterministically before the first
    statement. Ordering law: `RELATION_TARGETS_BUDGET_MS + RELATION_TARGETS_RESPONSE_MARGIN_MS`
    (2000) = 32000 < the client's `RELATION_TARGETS_TIMEOUT_MS` = 35000
    (render_open_list_with_direct_relations.js, per-attempt, `AbortController`), so the
    typed 503 reaches the modal before the transport gives up. The abort is client-side only
    (no `request.signal` handling server-side): an abandoned census ends at its budget —
    or sooner, superseded (next item).
  - **Every search carrying the leaf is bounded — ONE executor.** `buildSearchSql` (the
    plain search and the children_recursive pre-pass) returns an OPAQUE `SearchStatement`
    (`src/core/search/search_statement.ts`; text and values `#private`), which runs only
    through `runSearch` (rows), `wrapSearch` (embedded in an outer statement — the
    diffusion keyset batch, flag inherited) or `searchCursorSource` (the export selection
    cursor). A statement into which a `referenced_by` leaf RENDERED (`carriesReferencedBy`,
    set by the build's ParamsCollector where builder_referenced_by emits the expansion —
    never re-derived from an SQO) runs under `SET LOCAL statement_timeout =
    REFERENCED_BY_SEARCH_BUDGET_MS` (30000, the census's sibling; never above the ceiling in
    force, whose request-pool default 0 is no bound): in its own transaction, or — inside a
    caller's transaction, ANY lane, a maintenance transaction's 0 included — under a
    savepoint that restores the caller's recorded ceiling afterwards (`postgres.ts`
    `withStatementBudget`; a cut there leaves the caller's transaction usable; an unknown
    recorded ceiling is `internal.invariant`). Past it: `db.statement_timeout` (503,
    coordinates `door: referenced_by_search`, `ceiling_ms`). Covered: the section read's page
    and count (`read_source.ts`), the children_recursive ROOTS pass inside the assembler,
    read_raw, the multi-delete by SQO, the admin SQL console (`convert_search_object_to_sql_query`
    shows the text through the inspection door and runs it through `runSearch`; a TYPED
    refusal — this 503, an invalid SQO — keeps its own code, only an untyped throw becomes
    `search.failed`), the thesaurus
    search, identification pools, the MCP search/count/records reads, RAG scope probes, every
    tool that runs a search (propagate_component_data, update_cache, ontology, import_files,
    the acquisition tools), observers, datalists, order ranks, record scope, the diffusion
    selection — bounded PER keyset batch (each batch is one statement re-running the
    selection) — and the export selection cursor: a WITH HOLD cursor computes its whole
    selection in the COMMIT, where PostgreSQL has already disarmed `statement_timeout`, so the
    cursor arms the budget as its `transaction_timeout` (never above the connection's own
    statement ceiling; 25P04 → the same typed 503 with the search door's coordinates); its
    FETCHes read the materialized rows. Measured why: a degraded plan ran ~4 s flat and > 20 s
    at depth 4, and a client disconnect does not cancel it. A statement without the leaf runs
    exactly as before (one `sql.unsafe`, pooled or on the caller's transaction, that lane's
    ceiling). NOT a search statement, so not bounded here: the leaf's own embedded row set
    (`buildScopedRowSetSql` — bounded as part of its outer statement) and the relation_targets
    census (its own deadline, above). Internal overrides, never from the wire: `budgetMs`
    (`SearchStatementOptions`, positive finite ms, else `internal.invariant`; < 1 ms refuses
    before sending) and the ALS test seam `withSearchBudgetOverride`. Gates:
    `test/unit/referenced_by_filter_native.test.ts` (the flag follows what rendered — nested,
    count; the bound is the transaction's real `statement_timeout` and cuts a slow statement;
    inside a caller transaction it applies, the caller's ceiling is restored and the
    transaction goes on; read_raw, the MCP page and count, the SQL console, the diffusion
    keyset and the export cursor refuse a leaf past a forced bound and answer without the leaf; the cursor's
    transaction_timeout cuts a slow leaf selection) and
    `test/unit/statement_ceiling_scope_native.test.ts` (with no ambient transaction the
    budget applies on the request lane and an unbounded scope's maintenance lane, the lane
    kept, nothing leaked, the non-transactional lane refused under it) and
    `test/unit/search_statement_chokepoint_tripwire.test.ts` (opacity; pinned escape doors
    and pinned raw-SQL helpers — `buildScopedRowSetSql`, `renderConformedFilter`,
    `conformFilter`, and EVERY value export of builder_referenced_by.ts
    (`buildOwnerRelationScope`, `conformReferencedBy`, `storedLocatorExpansionSql`; that set
    derived from the module's parsed exports) — over a parsed, path-resolved import graph; a
    registered tripwire). The children_recursive ROOTS pass is measured, not spelled: a
    descendant-expanding leaf search refuses AT BUILD under a forced budget
    (referenced_by_filter_native).
  - **One census per session (single-flight by supersession).** The handler passes the
    session's token hash as the internal `supersessionKey`. Before its first census
    statement a census cancels every earlier census of that session holding or awaiting the
    transaction-scoped advisory lock `(RELATION_TARGETS_FLIGHT_LOCK_CLASS = 17580005,
    relationTargetsFlightKey(key))` (`cancelBackendStatement`, xact_start-guarded), then
    takes it under its own budget. Sticky: once holding, before EVERY statement a census
    asks whether a newer one waits on its lock, and refuses itself without sending it. So a
    session's abandoned censuses occupy at most the one rolling back plus the newest — a
    scope flip / reopen never stacks pooled connections. Superseded = `resource.conflict`
    (409, coordinates `door: relation_targets, reason: superseded`). The flight is PER
    SESSION, not per modal: after a scope flip / reopen inside one modal that modal already
    aborted the superseded request, but the modal in ANOTHER TAB OR WINDOW of the same
    session (one session cookie) supersedes a census its own modal still waits for. That
    modal receives the 409 and shows it as SUPERSEDED (not as a failure) with a reload button
    that asks again — manual, never automatic (two tabs would supersede each other forever;
    `resource.conflict` is `retryable: false` in the registry). Client gate:
    test_open_related_data.js ("a superseded census … offers a reload"). No module state
    (the lock is PostgreSQL's, so it also holds across processes). Every pg_locks /
    pg_stat_activity probe of the flight (the victims, the sticky check) is scoped to THIS
    database — an advisory lock is database-local, the views are cluster-wide — so another
    installation on the same cluster is never cancelled nor waited for (gate:
    relation_targets_native, a same-key holder on database `postgres` survives). The class's
    distinctness from every other declared `*_LOCK_CLASS` is the existing derived census
    `test/unit/advisory_lock_class_tripwire.test.ts`. The census budget is MEASURED on a
    statement the server runs (a lock wait behind an idle holder, cut at the remaining ms by
    the census's own SET LOCAL, nothing left behind), not only by the pre-send refusal.
    Accepted residue: a victim idle at the instant of the cancel that re-checks before the
    claimant enqueues runs that one statement to its budget; a 28-bit key collision between
    two sessions of this database makes one supersede the other (the same 409, re-asked by
    the user; never a wrong answer).
  - **Typed refusals** (all pre-registered codes; no registry change):
    - `request.invalid_options` (400): malformed leaf or source, a refused key, depth > 4,
      two different `from_component_tipo` values; and, NAMED, a source carrying
      `children_recursive: true` (or `fixed_children_filter`): a found set that expands to
      recursive children (the search panel's 'Children' checkbox) has no form here — the
      scoped row set has no descendant pre-pass — so it is refused by name, never narrowed to
      the matched terms. The client keeps the flag on a 'found' source
      (`build_relation_source`) so the modal shows this refusal instead of counting fewer
      records than the list and its found total show.
    - `perm.denied` (403): read < 1 on any source section (the `read_raw` rule), checked when
      a principal is present.
    - `request.invalid_tipo` (400): an invalid tipo, or a source section with no matrix table.
    - `db.statement_timeout` (503): the census ran past its whole budget (door
      `relation_targets`), or a window search carrying the leaf ran past its bound (door
      `referenced_by_search`) — both above.
    - `resource.conflict` (409, `relation_targets` only): superseded by a newer census of the
      same session (above).
    - NOT `search.index_unavailable`: the forward lookup reads stored data, so a log-table
      source (e.g. `dd542` → `matrix_activity`) is LEGAL, as in `read_raw` — every record
      table carries the `relation` column.
    - `engine.uncovered_scope` (503): the leaf anywhere in the filter of a Time Machine read
      (dd15 / `mode: tm`, every surface — bare list, `tipo`-column record list,
      `filter_by_locators` history). The leaf compiles over T's matrix row set; the
      Time Machine conformer over the flat `matrix_time_machine` log has no form for it;
      pathless, the leaf would
      have fallen into `conformTmFilter`'s pathless drop and WIDENED the list. Not
      `request.invalid_options`: the leaf is valid input (`sanitizeClientSqo` accepts it for any
      section) — the gap is engine scope on that table, the same code as TM's unmapped-component
      refusal. Refused in `buildTmWhere` before any surface (`assertNoTmReferencedBy`) and in
      `conformTmFilter` itself. Gate: `test/unit/tm_filter.test.ts` (referenced_by describe).
  - **Notice, not a failure:** `perm.out_of_scope` (door `search.referenced_by`) when the
    component key hides some or all relation components of a source section. An explicitly
    hidden `from_component_tipo` refuses that section; without one the condition becomes
    `r.from_component_tipo IN (<granted>)` over the relation object's keys — and for a
    non-admin principal it is that IN list EVEN WHEN NOTHING IS HIDDEN
    (`sectionFromComponentCondition(…, allowlistAlways)`): the expansion reads every stored
    key, so "nothing hidden → unrestricted" would follow a key outside the section's
    ontology (a removed/moved component, an import's key) only while no unrelated
    component is hidden; `read_raw` asks each key its own grant and never reads such a key
    for a non-admin. A global admin follows every key (as in `read_raw`). No notice when
    nothing is hidden. A source with no visible locator answers `1=0`
    (identical hit and miss). Internal searches (no principal) skip the read check and the
    component key.
  - **Exclusion:** a locator whose `section_id` is not an int4 (e.g. an external remote
    id) cannot name a record row and is skipped in both answers — the cast is guarded by a
    nested `CASE`, never raised.
- **Reason:** the question is relational and SQL answers it over the stored data: no
  limit, no materialization in the browser, an exact count, normal pagination and the ACL
  in SQL, instead of a silently truncated id list round-tripped through the browser.
  Revised the same day (user decision): the first cut read `matrix_relation_index`; the
  forward direction now reads the source rows' own `relation` column, because a derived
  copy can drift and does not cover log tables, and the forward answer must equal what
  `read_raw target_section` harvests from the same rows.
- **Gate reconciliation:** TS-only; additive (a new filter form + a new action). Existing
  searches are byte-identical (OLD vs NEW SQL probe, 144 cases, at the
  `buildPlainSearchSql` → `buildScopedRowSetSql` refactor; `withRelation` is opt-in, off
  for every other caller). No parity fixture records a
  `referenced_by` leaf or `relation_targets`; no re-harvest. `read_raw` is unchanged for its
  other callers.
