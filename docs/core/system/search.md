# search

> See also: [SQO](../../api/sqo.md) (the query DTO contract) · [RQO](../../api/rqo.md) (the request that wraps an SQO) · [Sections](../sections/index.md) · [common](common.md)

The server query engine compiles a **Search Query Object (SQO)** into a single prepared PostgreSQL statement over the JSONB `matrix_*` tables, runs it, and returns the matched rows.

This page is the **subsystem reference** for the `search` engine. For *what an
SQO is* — its fields, the Mango-style filter grammar and the two-phase `parsed`
lifecycle — read [SQO](../../api/sqo.md) first; this document is about the engine that
**consumes** an SQO and emits SQL, and does not repeat the SQO field contract at
length.

## Role

The search engine lives in **`src/core/search/`**. It is the TypeScript runtime
that turns a `Sqo` into prepared SQL and executes it via `Bun.sql`
(`src/core/db/postgres.ts`). It is the single query builder in Dédalo: every
read that filters, counts or paginates records — list views, portals,
autocompletes, the thesaurus tree, diffusion exports, server-internal lookups —
funnels through it.

The engine is **a set of pure functions across a handful of modules** — no
instance, no shared caches, nothing to reset. The compile step is idempotent and
the process holds no cross-request search state:

| module | responsibility |
| --- | --- |
| `conform.ts` | **Phase A** — walk the SQO filter tree, gate every identifier, resolve each leaf's model/column, dispatch to the per-model fragment builder. |
| `builders/` | the per-component SQL fragment builders (`builder_string`, `builder_number`, `builder_iri`, `builder_date`, `builder_section_id`, `builder_relation`). |
| `identifier_gate.ts` | the injection chokepoint — `assertValidTipo` / `assertValidLang` / `assertValidDataColumn` / `assertValidTipoOrColumn`. |
| `deep_path.ts` | between the phases — renders every multi-hop filter leaf as a semi-join over the related records it reaches, and applies the same-path rule (see [Deep-path filters](#deep-path-filters)). |
| `sql_assembler.ts` | **Phase B** — assemble SELECT / FROM / JOIN / WHERE / ORDER / LIMIT into the final `{sql, params}`; multi-section UNION; per-record projects ACL. |
| `params.ts` | `ParamsCollector` — the positional `$1..$n` prepared-param list; `resolveBuilderResult()` renders a builder fragment onto it. |
| `search_related.ts` | the inverse-reference / relation-breakdown engine — one btree query over `matrix_relation_index`, the only relation engine (see [The relation index](#the-relation-index-matrix_relation_index)). |
| `search_store.ts` | coverage gates for the two derived stores: `matrix_string_search` (string contains pre-filter) and `matrix_relation_index` (inverse/related engine + WC-012 translation). Coverage = sync triggers present AND the store backfilled. |
| `count.ts` | `countSectionRecords()` — the `full_count` variant for one section. |

It sits at the boundary between the request layer and the database:

| layer | responsibility |
| --- | --- |
| **Client JS** (`client/dedalo/core/search/js/search.js`, copied as-is) | builds the SQO (filter groups, `q_operator`, limit/offset) for the search UI. |
| **API gate** (`dispatch.ts`) | `sanitizeClientSqo()` (`src/core/concepts/sqo.ts`) — the **only** place an untrusted, client-authored SQO is sanitized before it reaches the engine. |
| **the engine** *(`src/core/search/`)* | compiles the SQO → one prepared SQL string + a positional `$params` list. |
| **`Bun.sql` / `postgres.ts`** | `sql.unsafe(sqlString, params)` binds `$1..$n` and returns the rows; JSONB columns arrive decoded by the one JSON codec. |

```mermaid
flowchart TB
    JS["client search.js"] -->|"rqo.sqo"| GATE["sanitizeClientSqo()<br/>(concepts/sqo.ts, at the dispatch gate)"]
    GATE --> BUILD["buildSearchSql(sqo, {principal})"]
    SRV["server-internal callers"] -->|"build a Sqo"| BUILD
    BUILD -->|"Phase A"| CONF["conformFilter()<br/>→ identifier_gate assert*<br/>→ per-model builders/*"]
    CONF -->|"Phase B"| ASM["assemble SELECT/FROM/JOIN/WHERE/ORDER<br/>+ projects filter + UNION"]
    ASM -->|"{sql, params}"| EXEC["sql.unsafe(sql, params) (Bun.sql)"]
    EXEC --> ROWS["decoded matrix rows"]
    JS -. "mode 'related'" .-> REL["search_related.ts<br/>(inverse refs / breakdown / count)"]
```

!!! warning "Two entry doors, one gate"
    Client SQOs are sanitized by `sanitizeClientSqo()` at the API edge (inside
    the `dd_core_api` handlers in `dispatch.ts`). **Server-internal callers
    build a `Sqo` object and call `buildSearchSql()` directly, bypassing that
    gate** — so they keep full access to server-only fields
    (`skip_projects_filter`, `limit:'all'`, …). The in-engine identifier gate
    (`identifier_gate.ts`, below) is what protects *both* paths against SQL
    injection through un-parameterizable identifiers.

## Responsibilities

- **Mode dispatch** — there is no single `get_instance()` factory. The default
  (`edit` / `list`) path compiles through `buildSearchSql()`; Time Machine
  (`mode:'tm'`) and relation breakdown (`mode:'related'`) are selected one layer
  up, by the read strategy `pickReadSource()` (`src/core/section/read_source.ts`)
  and by `search_related.ts` respectively.
- **SQO conform** — `conformFilter()` walks the filter tree and asks each
  component model's builder to translate its filter leaf into a SQL fragment.
- **Injection chokepoint** — `identifier_gate.ts` validates every
  `section_tipo` / `component_tipo` path step and the `lang` selector *before*
  any component dispatch, because those identifiers are string-interpolated into
  JSONB keys / jsonpath and cannot be parameterized.
- **SQL assembly** — `buildSearchSql()` builds SELECT / FROM / JOIN / WHERE /
  ORDER / LIMIT in a load-bearing order, using the window-subquery pattern.
- **Access-control filter** — `buildProjectsFilter()` (per-user project scoping)
  reaches the WHERE clause for non-global-admins with a `principal`. Every WHERE
  part (the section pin, the client filter tree, the projects filter, the
  per-user record allow-list, `filter_by_locators`) is parenthesized where the
  parts are joined, so an `OR` inside one part — a root `$or` filter, say — can
  never bind across the access-control parts next to it.
- **Prepared params** — `ParamsCollector.getPlaceholder()` maintains the
  positional `$1..$n` list that `sql.unsafe()` binds; every literal value becomes
  a `$n` placeholder.
- **Multi-section UNION** — `buildSearchSql()` emits one `UNION ALL` branch per
  matrix table when an SQO spans more than one section.
- **Counting** — `full_count` builds the count variant: `count(*)` when no
  join chain fans records out, `count(DISTINCT …)` when one does (only a
  multi-hop ORDER path still joins; a filter never does);
  `countSectionRecords()` and `countInverseReferences()` wrap it for their
  callers.

!!! warning "The compile functions must stay stateless"
    One long-lived process serves every user. The compile functions hold **no
    per-user cache** and no shared state, so there is nothing to reset between
    requests and nothing that can bleed from one user's search into another's.

    Add a module-level cache here keyed on anything user-specific and you
    reintroduce that hazard. Request-scoped context belongs in
    `AsyncLocalStorage`, not in a module variable.

## Key concepts

### The SQO → SQL flow (one pass, end to end)

```text
buildSearchSql(sqo, { principal })          entry (sql_assembler.ts)
  → conformFilter(sqo.filter, alias, table) Phase A (conform.ts)
      → identifier gate: assertValidTipo / assertValidTipoOrColumn / assertValidLang
      → ontology resolve: getModelByTipo, getColumnNameByModel, getTranslatableByTipo
      → per-leaf builder: builders/builder_string|number|iri|date|section_id
                           relation family → relations/registry getRelationSearchFragmentBuilder
      → returns a ConformedFilter tree whose leaves carry BuilderResults
  → assemble (Phase B):
      FROM → SELECT → ORDER (may add sort-select aliases) → WHERE
      + buildProjectsFilter() for non-admins
      + filter_by_locators / multi-section UNION ALL
      window-subquery wrapper when a custom ORDER (or join) is present
  → { sql, params }
  → sql.unsafe(sql, params)                  Bun.sql, $1..$n bound
  → decoded matrix rows
```

!!! note "Execution order is load-bearing"
    `buildSearchSql()` builds **FROM → SELECT → ORDER → WHERE**, documented in
    its own header comment. ORDER runs before WHERE because component-based
    ordering may add join fragments (`buildJoinChain()`) and sort-select aliases,
    and those need the base FROM established and their aliases available. Do not
    reorder.

### The working arrays

`buildSearchSql()` keeps **function-local arrays** — no shared state — that are
joined into the final query:

```ts
const mainWhere: string[]                 // section_tipo = / IN (...)
const whereParts: string[]                // filter, projects filter, filter_by_locators
const select: string[]                    // SELECT columns (DISTINCT ON unless removeDistinct)
const selectExtra: string[]               // component sort-select aliases
const orderClauses: string[]              // custom (sqo.order) ordering
const orderDefault = [`${alias}.section_id ASC`] // deterministic tie-break
const joinFragments: Map<string,string>   // LEFT JOIN LATERAL chains of multi-hop ORDER paths, dedup by alias
```

### Identity / table resolution

`getSectionTipos(sqo)` normalizes `sqo.section_tipo` to an array. The **first**
entry is the main section tipo; its alias is `trimTipo()` (e.g. `rsc197` →
`rs197`) for a single section, or the literal **`mix`** when more than one
section is queried. The matrix table is resolved from the first reliable section
tipo via `getMatrixTableFromTipo()` (skipping tipos with no resolvable table).
When more than one section is queried, `removeDistinct` is forced `true`
(cross-section search wants duplicate `section_id`s across sections).

Time Machine reads override the source entirely (`pickReadSource('tm')` →
`read_tm.ts`, which queries the flat `matrix_time_machine` table); they do not go
through `buildSearchSql()`.

### Ranking by locator position (`{mode:'locator_position'}`)

Semantic search returns records **best-first**, and that rank has to survive the
ordinary search machinery (pagination, `full_count`, export). The client
achieves it with a **resolve-once-then-pin** step (WC-047): it pins the hit
locators into `sqo.filter_by_locators` and appends a single
`{mode:'locator_position'}` entry to `sqo.order`. `buildOrderClauses()`
(`src/core/search/sql_assembler.ts`) renders that entry as a `selectExtra`
alias —
`array_position(ARRAY[…]::int[], mix.section_id) AS locator_position_order` —
so the rank rides the normal component-sort path and is preserved across the
windowed/count/export wrappers.

Load-bearing details, all enforced in the assembler:

- It is emitted as a **select alias**, never an alias-qualified raw `ORDER`
  expression: the windowed wrapper strips only a *leading* alias prefix
  (`stripAliasPrefix`), so a raw `array_position(…, mix.section_id)` clause
  would reference an out-of-scope table there ("missing FROM-clause entry").
- The ids are **inlined as integer literals** validated with
  `Number.isSafeInteger`, never a bound `$n` parameter — the count path reuses
  the same SQO but emits no `ORDER BY`, so an order-time bind would leave a
  `$n` with no placeholder in the count SQL and fail every paginator count.
- **Single-tipo pin lists only** in v1 — a mixed-tipo pin list throws; an empty
  pin list is a silent no-op (a session-merged leftover order without pins).
- `sanitizeClientSqo` clamps `filter_by_locators` to
  [`CLIENT_MAX_LOCATOR_PINS`](../../administration/configuration/search.md#semantic-search-rank-pinning)
  (1000) **loudly** (DEC-07) — a longer pin list truncates the result set with
  a logged warning rather than silently.

This ordering mode is TS-native, additive (WC-047) — there is no counterpart in
the previous engine.

### The identifier gate — the injection chokepoint

`identifier_gate.ts` is the **central** security gate; it covers *all* component
search builders at one point. Builders string-interpolate `component_tipo` (as a
JSONB key / jsonpath member step) and `lang` (into jsonpath / string literals) —
neither can be parameterized (jsonpath `vars` can't parameterize a member
accessor). So before any builder dispatch, `conformLeaf()` (in `conform.ts`)
calls the gate on every path step:

- `assertValidTipo()` — `isValidTipo` (`^[a-z]+[0-9]+$`, `src/core/concepts/ontology.ts`)
  for each `section_tipo`,
- `assertValidTipoOrColumn()` — a valid tipo **or** a legitimate data column
  (`section_id`, `id`, `tipo`, `lang`, `type`, `section_tipo`, the matrix jsonb
  columns) for each `component_tipo`,
- `assertValidLang()` — `isValidLang` (`^(lg-[a-z0-9_]+|all)$`) for the optional
  `lang`,

and every assert **throws** on a malformed value (allowlist only — invalid input
is rejected, never repaired). A new per-component builder that interpolates a new
SQO field into SQL must gate it here, not in the leaf. The multi-hop join builder
(`buildJoinChain()`) re-asserts each hop's tipos for the same reason.

### Prepared params model

`ParamsCollector` (`params.ts`) returns `$1..$n` from `getPlaceholder()` and
stores the values as a **0-indexed positional list** (dedup by **strict**
equality, so `1`/`'1'`/`true` never collapse onto the same slot). Component
builders build sentences with `_Q1_`, `_Q2_`… named token placeholders plus a
token→value map; `ParamsCollector.substitute()` swaps each token for a real `$n`.
`buildSearchSql()` returns `params.toArray()`, which `sql.unsafe()` binds
directly. Everything that *can* be parameterized is — the only verbatim
interpolations are the gate-validated identifiers above.

### Access-control filter (reaches WHERE)

`buildProjectsFilter()` (in `sql_assembler.ts`) — for a non-global-admin
`principal`, restricts results to records whose `component_filter` relation
references one of the user's projects (`getUserProjects()`). A section that is
not project-gated (`getComponentFilterTipo()` returns null) contributes nothing;
a gated section queried by a user with **no** projects yields an impossible
clause (empty result — fail closed). Project ids ride as bound params.

!!! warning "Passing no principal skips the record ACL"
    Global admins and internal searches (no principal) skip the projects filter.
    Trusted server code must therefore pass a `principal` **whenever it intends
    user-scoped results** — omitting it is not a shortcut, it is a full-visibility
    search.

!!! note "Exempt tables"
    Sections living in the shared vocabulary/infrastructure tables —
    `matrix_hierarchy`, `matrix_hierarchy_main`, `matrix_list`, `matrix_dd`,
    `matrix_langs`, `matrix_tools`, `matrix_stats`, `matrix_notes` — are
    **never project-gated** (`PROJECTS_FILTER_EXEMPT_TABLES` in
    `sql_assembler.ts`), applied per section in a multi-section UNION. Their
    records carry no project locators, so gating them would blank the whole
    thesaurus for every non-admin — exactly what happened for one day when
    the virtual→real filter fallback landed without this rule (autocomplete
    regression caught 2026-07-20).

### The string-search store (`matrix_string_search`)

Accent/case-insensitive **contains** searches on string components compile to a
per-row predicate (`EXISTS(jsonb_path_query(string, …) WHERE f_unaccent(value)
~* f_unaccent(q))`) that no JSONB index can serve — on a 21k-record section that
is ~1.4 s per search, for admins and regular users alike. The engine therefore
maintains a derived **per-value search store**:

```text
matrix_string_search (
    section_tipo    varchar(64),   -- the record's section
    section_id      integer,       -- the record
    component_tipo  varchar(64),   -- WHICH component the value belongs to
    string          text           -- lower(f_unaccent(value)) — one row per value
)
```

The `string` column is named after its **source**: only components stored in the
matrix `string` column are included (dates, numbers, relations etc. have their
own typed columns and their own search shapes). One composite
[`btree_gin`](db.md#schema-assets-db_assetsts) index —
`gin (component_tipo, string gin_trgm_ops)` — resolves the component scoping
**and** the trigram containment in a single index scan, so a component-scoped
contains is served in ~1 ms with no reliance on the planner combining separate
indexes.

`builder_string` prepends the store lookup as a **pre-filter** in front of the
exact predicate (which always remains and decides membership — results are
byte-identical with or without the store):

```sql
mix.section_id = ANY (ARRAY(
    SELECT sv.section_id FROM matrix_string_search sv
    WHERE sv.component_tipo = $t
      AND sv.string LIKE '%' || lower(f_unaccent($q)) || '%'))
AND ( …the exact jsonb predicate, unchanged… )
```

The shape is deliberate, and each choice is load-bearing:

| choice | why |
| --- | --- |
| uncorrelated `ANY(ARRAY(…))`, not a correlated `EXISTS` | plans as a one-shot InitPlan so the main table is **entered by `section_id`**; the correlated form let jsonb selectivity misestimates invert the plan back to the per-row scan. |
| no `section_tipo` condition inside the subquery | the multi-section UNION replicates the WHERE verbatim into every branch; a section pin would fail-close other branches — cross-section ids only **widen** the superset, the outer `section_tipo` pin and the exact predicate still decide. |
| emitted for **positive** shapes only (contains / begins / ends / `==` / `=` / quoted literal) with a **regex-plain** `q` | the exact predicate is regex-semantic, the store `LIKE` is literal-substring — they only agree on plain text; `%`/`_` are escaped. Negations (`!*`, `!=`, `-`, `!!`) and bare `*` never carry it. |
| never inside a **correlated** deep semi-join | there the pre-filter's tiny cardinality estimate flips the join order into an unindexed filter join (measured 4× slower on the old forward join). A multi-hop leaf gets a second, pre-filtered fragment that only the **reversed** shape uses, where the leaf is the driving set (see [Deep-path filters](#deep-path-filters)). |
| gated on the table's **sync trigger presence** (`search_store.ts`, cached; the maintenance rebuild actions clear the cache) | against an unmaintained table the empty store would wrongly *exclude* rows — the gate is correctness, not just performance. Uncovered tables (e.g. `matrix_time_machine`) keep the classic SQL byte-identically. |

The store is **derived data** kept in sync by `AFTER INSERT OR DELETE OR UPDATE
OF string` row triggers (`{table}_string_search_sync` → the plpgsql
`matrix_string_search_sync()`, delete-then-reinsert per record) on every
string-searchable matrix table — engine writes, scripts and manual SQL all stay
consistent, in the same transaction as the write. **Fresh installs are born with
the store**: the seed dump (`install/db/dedalo_install.pgsql.gz`) creates the
table, function, triggers and indexes and backfills the seed rows at restore
time. On a pre-existing instance (a database created by a previous beta) the
server **self-provisions at boot**: `ensureSearchStores()` (db_assets.ts,
called by startServer after the boot migrations, before serving) detects a
missing store table / sync trigger, or a store that is empty while its
sources would produce rows, and runs the targeted DDL + one-time backfill —
so updating the code and restarting is the whole upgrade. The `database_info`
maintenance widget keeps the same operations as MANUAL repair actions:
**Recreate database assets** (full DDL incl. legacy cleanups) and **Backfill
search stores** (`backfill_search_stores` → `backfillSearchStores()`:
TRUNCATE + `INSERT … SELECT` per covered table, mirroring the trigger row
filters). Until provisioning ran, the presence gate keeps string searches on
the classic scan.

!!! note "Why a side table and not an in-record column"
    Trigram (`pg_trgm`) indexes plain text only, so an in-record column (the
    `relation_search` pattern) forces one concatenated text per record — and
    lossy GIN-trigram rechecks then re-read that whole (often TOASTed) text per
    candidate row, which **measured slower than the un-indexed scan**. One row
    per value is what makes the recheck a short string and the component scoping
    index-resolvable; `relation_search` works as a column because its `@>`
    semantics are exact-match, which jsonb GIN serves per-element.

### The relation index (`matrix_relation_index`)

The relation twin of the string store: one **typed row per locator** stored in
any `relation` column —

```text
matrix_relation_index (
    section_tipo         varchar(64),  -- the OWNING record
    section_id           integer,
    from_component_tipo  varchar(64),  -- the component holding the locator
    type                 varchar(64),  -- locator type (dd151…)
    target_section_tipo  varchar(64),  -- the record it points AT
    target_section_id    integer       -- signed: system refs (user -1) included
)
```

— with three btree indexes (target-side for inverse lookups, from-side for the
sync trigger, type-side for delete-propagation shapes), kept in sync by
`{table}_relation_index_sync` row triggers on the same content-table list as
the string store. **Derived and never authoritative**: consumers either treat
it as an exact-but-rebuildable index behind a coverage gate, or read it for
integrity reporting.

The index is **the only relation engine** — every consumer runs on it:

| consumer | shape | measured |
| --- | --- | --- |
| `search_related.ts` finds/counts (relation_list panels, children, observers, delete propagation, diffusion) | one btree query, `GROUP BY` owner, op AND via `HAVING bool_or` | st_si 14→0.3 ms · fct_st_si 6→0.2 ms · ty_st 1,014→54 ms (vs the retired flat GIN) |
| breakdown (`findInverseReferenceLocators` — exact locator payload recovery) | tuple-IN row-narrowing + a jsonb cross-join (only the payload side touches the jsonb, so it stays exact) | — |
| relation filter leaves (autocomplete catalogue pre-filter): canonical `format:'relation'` (q = partial locator object(s)) + the DEPRECATED `format:'function'` reader (WC-012) | exact tuple-IN over typed bound params — see [sqo.md → Relation filter leaves](../../api/sqo.md#relation-filter-leaves-format-relation) | — |
| `database_info.relation_integrity_report` (maintenance) | dangling-target anti-joins + non-integer locator census | first run on MIB: 5,148 dangling refs found |

Coverage (`relationIndexCovers` = triggers present AND the index backfilled —
or legitimately empty because the source tables hold no locators at all) is a
**requirement, not an optimization gate**: an uncovered instance fails loudly
(`requireRelationIndex`) with the remediation — Area Maintenance → Database
info → **Recreate database assets**, then **Backfill search stores** — instead
of silently degrading. In practice an uncovered instance should not survive a
restart: the boot self-provisioning (`ensureSearchStores()`, see the string
store section above) heals a previous-beta database automatically; the widget
actions are the manual repair for a damaged store or a boot-provisioning
failure. Fresh installs and v6→v7 closures arrive with everything in place.

!!! info "The v6-era flat functions are gone (2026-07-20)"
    Earlier engines answered these queries with four flattening functions
    (`data_relations_flat_{st_si,fct_st_si,ty_st_si,ty_st}`) that projected
    the nested `relation` JSONB into flat `"a_b_c"` strings, plus a functional
    GIN index per function per table (~411 MB, five GIN updates on every
    relation write). v7 removed the functions, their indexes and every SQL
    path that called them — the definitions survive only as **drop-only
    cleanup entries** in `db_pg_definitions.json`, the v6→v7 update drops
    them (both name families) on upgraded installs, and the fresh-install
    dump ships without them. The client-side vocabulary was cleaned the next
    day (WC-012 amendment 3): the shipped client emits `format:'relation'`
    with a partial-locator `q`; the old `format:'function'` /
    `use_function:'relations_flat_*'` spelling survives only as a deprecated
    reader — see [sqo.md → Relation filter leaves](../../api/sqo.md#relation-filter-leaves-format-relation).

!!! warning "This is NOT the v6 `relations` table"
    v6's table was application-maintained (drift → a dedicated regenerate
    tool), the join spine of every search, redundant with the JSONB path, and
    indexed the activity logs (~50M rows) while dropping the locator `type`.
    This index inverts each decision: DB triggers in the write transaction,
    never a hot-path join spine (consumers enter by id set or tuple-IN),
    replaces the flat-GIN redundancy instead of adding to it, content tables
    only (~9.7M rows at MIB), `type` kept.

### Deep-path filters

A filter leaf whose `path` crosses one or more relations (an interview's
Informants → the person's date of birth; a coin's Tipo → its Ceca → the mint's
name) is answered over **R** = the related records the searched record reaches
through the path: any stored locator at every hop, and never a record the
caller may not read at that hop. The leaf is never tested row by row on a join:
nothing enters the main `FROM`, so a record comes back once and the count is a
plain `count(*)`.

**What each operator means over R** (each builder family declares it once, in
its `classify<Family>()`, which its own builder also dispatches on):

| operator | meaning |
| --- | --- |
| positive (`abc`, `=`, `==`, `*`, `<`, a locator…) | **some** related record matches |
| `-abc`, `!*`, `!==`, section_id `!=n` | **no** related record matches the positive twin (`abc`, `*`, the locator, `=n`). A record with no relation, or only dangling or hidden targets, matches. |
| `!=abc` (text, iri, json, number, relation) | some related record has a value **and** none equals `abc` |
| `$not` / `$nand` / `$nor` | negate the whole answer above |

With `q_split`, the positive words of one clause must all hold on the same
related record, and each negative word is its own "none" (`-a b` = no related
record contains `a` and none contains `b`).

**Several conditions on the same path.** Under an AND (`$and`, and inside
`$not` / `$nand`), sibling leaves on the identical path follow the *mixed rule*:

| siblings | meaning | example |
| --- | --- | --- |
| positive, on **different** fields | one related record holds them all | "a movement to Madrid in 1939" |
| positive, a field **repeated** | each is matched on its own related record — and so are the other positive siblings on that path | "a movement to Madrid and a movement to Valencia" |
| any **negated** leaf | never shares: it keeps meaning "no related record matches" | "a movement to Madrid, and none in 1939" |

Under `$or` / `$nor` every leaf is matched on its own. A longer path that shares
only a prefix with another leaf is a different path.

**Two SQL shapes, one answer** (`deep_path.ts`):

- **Reversed** — used for a positive semi-join outside any negation when
  `matrix_relation_index` covers every source table of the path (every
  UNION branch table included). The matching LEAF records are found first (with
  the string-store pre-filter), then each hop is walked back through the index:

    ```sql
    (main.section_tipo, main.section_id) IN (
      SELECT ri1.section_tipo, ri1.section_id FROM matrix_relation_index AS ri1
      WHERE ri1.from_component_tipo = '<hop 1>'
        AND (ri1.target_section_tipo, ri1.target_section_id) IN (
          SELECT leaf.section_tipo, leaf.section_id FROM <leaf table> AS leaf
          WHERE <leaf ACL> AND (<leaf predicate>)))
    ```

    Measured on a 184,000-record section with a three-hop text filter: 3,049 ms
    on the old forward join, 19 ms reversed, same records.

- **Correlated** — everything else: every negated clause, anything under
  `$not` / `$nand` / `$nor`, and tables the index does not cover (the Time
  Machine and activity logs):

    ```sql
    [NOT] EXISTS (SELECT 1
      FROM jsonb_array_elements(main.relation->'<hop 1>') AS rel_1
      JOIN <table 1> AS j_1 ON <locator identity> AND (<hop 1 ACL>)
      CROSS JOIN LATERAL jsonb_array_elements(j_1.relation->'<hop 2>') AS rel_2
      JOIN <table 2> AS j_2 ON <locator identity> AND (<hop 2 ACL>)
      WHERE (<leaf predicate>))
    ```

    A negation is never reversed: an anti-join over the index is plan-fragile
    (measured on a 38,750-record section: `!*` took 177 s reversed against
    0.23 s correlated).

The per-hop access control is in both shapes: the hop's record predicate sits in
the `ON` clause of its join (correlated), or on the leaf `WHERE` and a join of
each intermediate table (reversed). Its values bind as named tokens that become
`$n` placeholders only when the semi-join is actually rendered, so a leaf that
contributes nothing — an empty `q`, or a step the caller holds no grant on
(literal `1=0`) — opens no hop and leaves no unbound parameter.

Gates: `test/unit/search_deep_semantics_native.test.ts` (the meaning of every
case above, as record sets), `test/unit/search_deep_path_reverse_native.test.ts`
(which shape each case takes), `test/unit/search_path_acl_native.test.ts` (the
ACL census over both shapes), `test/unit/builder_shallow_snapshot.test.ts`
(the classifiers leave single-section SQL byte-identical).

### Multi-section UNION

`buildSearchSql()` builds one `UNION ALL` branch per distinct matrix table. Each
branch keeps the same main alias (`mix`); only the main `FROM <table> AS mix` is
swapped via an **exact-substring** `String.replace` (never a regex — a regex over
the generated SQL would corrupt correlated subqueries). The outer `ORDER BY`
strips the `mix.` qualifier because UNION result columns aren't alias-qualified
(`stripAliasPrefix()`).

## Pipeline entry & lifecycle

There is **no** `search` class and no `get_instance()`. The single compile entry
is a pure async function:

```ts
export async function buildSearchSql(
    sqo: Sqo,
    options: SearchOptions = {}   // { principal? } — non-admin ⇒ projects filter applies
): Promise<{ sql: string; params: unknown[] }>
```

Mode selection happens above the engine:

```ts
// mode → path:
//   'tm'                      → pickReadSource('tm') → read_tm.ts (matrix_time_machine)
//   'related'                 → search_related.ts (findInverseReferences / countInverseReferences)
//   'edit' | 'list' | default → buildSearchSql() → matrix_* tables
```

`buildSearchSql()` **throws** when the SQO carries no resolvable section tipo (no
matrix table), and when it hits uncovered scope (multi-hop ORDER on unported
shapes, non-admin multi-section search over a project-gated section, group_by,
children_recursive) — never a silent narrowing.

### Typical usage

```ts
import { sanitizeClientSqo, type Sqo } from '../concepts/sqo.ts';
import { buildSearchSql } from '../search/sql_assembler.ts';
import { sql } from '../db/postgres.ts';

// 1. build a Sqo (server-internal — trusted; a client Sqo would be
//    sanitized with sanitizeClientSqo() at the API gate instead)
const sqo: Sqo = sanitizeClientSqo({
    section_tipo: ['rsc197'], // People
    mode: 'list',
    limit: 50,
    offset: 0,
    // filter: { ...Mango-style filter... }
});

// 2. compile to prepared SQL + params (projects filter applies when principal is a non-admin)
const { sql: query, params } = await buildSearchSql(sqo, { principal });

// 3a. fetch records
const rows = await sql.unsafe(query, params as (string | number | null)[]);
for (const row of rows) {
    // row.section_id, row.section_tipo, decoded JSON columns ...
}

// 3b. or count (full_count variant)
const total = await countSectionRecords(principal, 'rsc197'); // number | null
```

!!! note "Untrusted vs trusted SQOs"
    A client SQO arriving over the API is run through `sanitizeClientSqo()` first
    (strips server-only fields, forces `parsed=false`, clamps `limit` to the
    client ceiling `CLIENT_MAX_LIMIT`, coerces `offset`/`total` to ints).
    Server code that builds its own `Sqo` is trusted and skips that step. Both
    are protected by `identifier_gate.ts`.

## Public API

Grouped by concern. All are plain exported functions (no class methods) unless
noted.

### Compile & execute (`sql_assembler.ts`)

| symbol | purpose |
| --- | --- |
| `buildSearchSql(sqo, options)` | The compile entry: conform the SQO, assemble FROM→SELECT→ORDER→WHERE, add the projects filter / `filter_by_locators` / multi-section UNION, return `{sql, params}`. |
| `trimTipo(tipo)` | Contract a tipo for compact SQL aliases (`rsc453` → `rs453`); `null` on malformed input. |
| `renderConformedFilter(node, params)` | Render one conformed filter tree to a WHERE fragment against a caller-owned `ParamsCollector` (reused by the TM read, which owns its own query shell). |
| `SearchOptions` | `{ principal? }` — scopes the projects ACL. |

### Conform / dispatch to builders (`conform.ts`)

| symbol | purpose |
| --- | --- |
| `conformFilter(filter, alias, table)` | Recursively conform a filter node: `$and`/`$or`/`$not`/`$nand`/`$nor` groups + leaves; returns a `ConformedFilter` tree. |
| `buildJoinChain(path, mainAlias)` | Build the `LEFT JOIN LATERAL jsonb_array_elements(...)` + matrix-table join chain for a multi-hop path; gates every hop's tipos. Used by filter leaves **and** ORDER paths. |
| `ConformedFilter` / `JoinFragment` / `JoinHop` / `DeepLeafPlan` | The conform-tree types the assembler consumes; a multi-hop leaf carries its `deep` plan, a reversed unit becomes a `reverse` node. |
| `reverseDeepPaths(tree)` (`deep_path.ts`) | Rewrite the provably-exact multi-hop leaves into the reversed shape; called by `buildSearchSql()` right after `conformFilter()`. |

### Identifier allowlists (`identifier_gate.ts`)

| symbol | purpose |
| --- | --- |
| `assertValidTipo(v, where)` | Throw unless `^[a-z]+[0-9]+$` — gate for tipos interpolated into JSONB keys. |
| `assertValidTipoOrColumn(v, where)` | Throw unless a valid tipo **or** a bare data column — `path.component_tipo` accepts both, e.g. ordering by `section_id`. |
| `assertValidLang(v, where)` | Throw unless `^(lg-[a-z0-9_]+|all)$`. |
| `assertValidDataColumn(v, where)` / `isValidDataColumn(v)` | The allowlist of real matrix columns, plus the structural and Time Machine columns. |
| `VALID_DATA_COLUMNS` | The exported column allowlist. |

### Per-component builders (`builders/`)

| symbol | purpose |
| --- | --- |
| `buildStringFragment` | `component_input_text` / `component_text_area` / `component_email` — LIKE/`=`/accent-insensitive, `q_split` fan-out, the `!!` duplicated-operator self-join. |
| `buildNumberFragment` | `component_number` — numeric comparisons. |
| `buildIriFragment` | `component_iri`. |
| `buildDateFragment` | `component_date` — jsonpath time-range comparisons. |
| `buildSectionIdFragment` | `component_section_id` — structural `section_id` predicates (incl. between). |
| `getRelationSearchFragmentBuilder(model)` | The relation family's search face (`src/core/relations/registry.ts`): the shared JSONB-containment builder; unported relation pipelines throw loudly. |
| `BuilderContext` / `BuilderResult` / `fragment()` / `compound()` | The builder contract (`builders/types.ts`): a leaf resolves to `false`, a `Fragment` (sentence + `_Qn_` tokens), or a `CompoundFragment` (`$and`/`$or`). |

### Params (`params.ts`)

| symbol | purpose |
| --- | --- |
| `ParamsCollector` | `getPlaceholder(value)` → `$n` (strict dedup); `substitute(sentence, tokenValues)` swaps `_Qn_` tokens; `toArray()` returns the bound values in `$1`-first order. |

### search_related (relation breakdown, `search_related.ts`)

| symbol | purpose |
| --- | --- |
| `findInverseReferences(...)` | Which records point at a locator — one btree query over `matrix_relation_index` (coverage required, `requireRelationIndex`). |
| `findInverseReferenceLocators(...)` | Exact inverse-locator recovery (the `breakdown` case). |
| `countInverseReferences(locators, options)` | The relation_list paginator total, with per-`group_by` breakdowns. |
| `getRelationTables()` / `clearRelatedTablesCache()` | The ontology-enumerated relation-table set (module-level memo). |

### Count (`count.ts`)

| symbol | purpose |
| --- | --- |
| `countSectionRecords(principal, sectionTipo)` | Read-gated `full_count` for one section; `null` when not countable/accessible so callers can tell "zero" from "no access" — unreadable, untabled, or declaring a table that is not a matrix **record** store (`dd15` → `matrix_time_machine`). |

## How it fits with the rest of Dédalo

- **[SQO](../../api/sqo.md)** — the query DTO this engine consumes. `search.md`
  documents the *engine*; `sqo.md` documents the *contract* (filter grammar,
  field cheat-sheet, the `parsed` two-phase lifecycle). They are companions.
- **[RQO](../../api/rqo.md)** — the request envelope that carries the SQO from the
  client; `sanitizeClientSqo()` runs while the `dd_core_api` handlers in
  `dispatch.ts` unpack the RQO.
- **[Sections](../sections/index.md) / [section](../sections/section.md)** —
  list views and the per-section navigation build SQOs and call this engine; the
  read strategy (`section/read_source.ts`) chooses the matrix vs Time Machine
  source.
- **[Components](../components/index.md)** — each component model's filter leaf is
  turned into `{sentence, tokenValues}` by a builder under
  `src/core/search/builders/`, or, for the relation family, by the relations
  registry.
- **[The engine layer](common.md)** — the search engine depends on the ontology
  resolver (`getMatrixTableFromTipo`, `getModelByTipo`, …) for table and model
  resolution. It holds no cache of its own.
- **Time Machine** — the `matrix_time_machine` table (single `data` column
  instead of tipo-keyed JSONB; default `timestamp DESC`) is served by
  `read_tm.ts`, selected through `pickReadSource('tm')`, not by
  `buildSearchSql()`.

## Examples

### A simple filtered, paginated list

```ts
const sqo = sanitizeClientSqo({
    section_tipo: ['oh1'], // Oral History
    mode: 'list',
    limit: 20,
    offset: 0,
});

const { sql: query, params } = await buildSearchSql(sqo, { principal });
const rows = await sql.unsafe(query, params as (string | number | null)[]);
for (const row of rows) {
    // process each matched record
}
```

### Inverse relations (which records point at me)

```ts
// resolve the count of every record that references this locator, per group
const related = await countInverseReferences(
    [{ section_tipo: 'rsc197', section_id: 3 }], // reference locators
    { sectionTipos: 'all' }
);
// related.total, related.totals_group ...
```

### Reading the generated SQL (debug)

```ts
const { sql: query, params } = await buildSearchSql(sqo, { principal });
console.log(query);   // 'SELECT ... WHERE ... = $1'
console.log(params);  // the bound values, $1 first
```

The `convert_search_object_to_sql_query` action of `dd_utils_api`
(`dispatch.ts`, the SQO-test-environment maintenance widget, global-admin only)
exposes exactly this: it sanitizes the client SQO, calls `buildSearchSql()`,
substitutes the `$N` placeholders back into a human-readable string for display,
then executes the real bound query.

!!! note "How the search engine is tested"
    Two flavours, both `bun:test`:

    - **unit / SQL-string** — `test/unit/search_gates.test.ts`,
      `test/unit/relation_search_builders.test.ts`,
      `test/unit/search_related.test.ts`: build a `Sqo`, call `buildSearchSql()`
      (or one builder), and assert on the generated SQL and `params` — or expect a
      throw for a rejected injection payload or an uncovered scope.
    - **fixture replay** — `test/parity/`: replay the frozen fixture store and
      assert the returned ids and rows still match.

    Run with `bun test test/unit/search_gates.test.ts`, or a `test/parity/…` path.

## Related

- [SQO](../../api/sqo.md) — the Search Query Object contract (filter grammar, fields,
  `parsed` lifecycle).
- [RQO](../../api/rqo.md) — the request format that wraps an SQO.
- [Sections](../sections/index.md) · [section](../sections/section.md) — list
  views and the read-source strategy.
- [Components](../components/index.md) — the per-component fragment builders.
- [common](common.md) — the ontology resolver the engine leans on.
- [Locator](../locator.md) — the typed pointers `search_related` resolves.
- [Architecture overview](../architecture_overview.md#a-note-on-search-sqo) —
  where search sits in the request lifecycle.
