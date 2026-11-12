# Search configuration and access control

Dédalo search is driven by the [Search Query Object (SQO)](../../api/sqo.md): a JSON query definition parsed into a single prepared PostgreSQL statement over the JSONB `matrix_*` tables. This page documents the **configuration constants** that affect search and the **access-control boundary** applied to queries that arrive from the HTTP API.

For the full query language (filter operators, paths, order, pagination, related/time-machine modes) see [Search Query Object](../../api/sqo.md).

## The trust boundary

There are two sources of SQOs and they are **not** equally trusted:

| Source | Trust | Gate |
| --- | --- | --- |
| **HTTP API** (client-built SQO inside the RQO) | untrusted | `sanitizeClientSqo()` |
| **Server-internal builders** (sections, autocompletes, portals, exports, …) | trusted | none — they construct a search object and call the search assembler directly |

`sanitizeClientSqo()` (`src/core/concepts/sqo.ts`) runs at every API entry point that accepts a client-supplied SQO — section reads, the tree search, relation datalists, record-scope checks, count, RAG retrieval, MCP search, and the diffusion export/queue paths all call it before the SQO reaches the search pipeline. It:

1. **Strips server-only SQL fields** at any depth: `sentence`, `params`, `column_sql`, `table`, `table_alias`. These are server-built and always regenerated; a client must never inject them (they would reach raw SQL without going through the component conform pipeline).
2. **Strips access-control flags**: `skip_projects_filter`, `skip_duplicated`, `include_negative`. A client must never weaken its own access control (see [`skip_projects_filter`](../../api/sqo.md#skip_projects_filter) — it is honored only when set server-side).
3. **Forces `parsed = false`** so a client can never skip the component conform pipeline and hand a pre-built filter straight to SQL building.
4. **Coerces and clamps pagination**: `offset`/`total` are cast to integers and `limit` is clamped to [`DEDALO_SEARCH_CLIENT_MAX_LIMIT`](#dedalo_search_client_max_limit).
5. **Clamps `filter_by_locators`**: an untrusted SQO's pin list is truncated to `CLIENT_MAX_LOCATOR_PINS` (1000, fixed in code) **loudly** — over-length lists truncate the result set with a logged warning, never silently (DEC-07). See [Semantic search rank pinning](#semantic-search-rank-pinning).

Beyond the boundary, two further validations run for every SQO regardless of source, from the identifier-validation chokepoint in `src/core/search/identifier_gate.ts`, enforced from `src/core/search/conform.ts` before any SQL string is built:

- **Identifier validation** — every `section_tipo`/`component_tipo` in a filter path is checked against the tipo shape (`^[a-z]+[0-9]+$`) or the pseudo-tipo allowlist (`section_id`, `id`, `tipo`, `lang`, `type`, `section_tipo`). These values are interpolated verbatim as JSONB keys / jsonpath member steps and cannot be parameterized, so a malformed value throws.
- **Language validation** — a filter item `lang` is checked against the language shape (`^(lg-[a-z0-9_]+|all)$`) before it reaches a jsonpath/string literal.

Both checks are pure, allowlist-only and throw-not-repair — there is no path that silently drops or rewrites a bad identifier.

## Configuration constants

### DEDALO_SEARCH_CLIENT_MAX_LIMIT

`int` — default `1000`.

Ceiling applied to a **client-supplied** SQO `limit`. Untrusted clients cannot request unbounded result sets: the `all` sentinel, non-positive values and values above the ceiling are all clamped to this value. Server-internal search builders bypass the gate (`sanitizeClientSqo`), so they keep full access to `limit: 'all'` for exports, recursive children, count passes, etc.

```bash
# ../private/.env
DEDALO_SEARCH_CLIENT_MAX_LIMIT=1000
```

Raise it if your front-end legitimately pages with larger windows; lower it to harden a public-facing installation.

## How search restricts records (overview)

For non-admin users, the search assembler always adds a project-scope restriction to the query, branching by section:

- **Users section** (`DEDALO_SECTION_USERS_TIPO`): the root user record (`section_id -1`) is always excluded from results, for every caller including admins.
- **Project-gated sections**: results are restricted via `EXISTS` to records whose `component_filter` relation references one of the user's own projects. A user with no projects sees no gated records in that section. Sections with no `component_filter` child are exempt, so shared/transversal data (common value lists, the `dd` catalog) stays reachable.
- **Multi-section searches**: each searched section is scoped by its own `component_filter` predicate, gated on `section_tipo` so the right restriction applies inside each branch of the query — a section with no gating imposes no restriction on that branch, and a gated section is never left unfiltered by a sibling's shape.

Global administrators and internal (principal-less) searches are not filtered. The server-only `skip_projects_filter` flag can disable the filter for a trusted internal caller (e.g. to read common value lists) — but it is stripped from every client SQO by `sanitizeClientSqo`, so a client can never set it itself.

## Semantic search rank pinning

Semantic search returns records best-first, and the client preserves that rank the **resolve-once-then-pin** way (WC-047): it pins the hit locators into `filter_by_locators` and appends a single `{mode:'locator_position'}` entry to `order`, which the assembler renders as a stable `array_position(…)` sort alias. The mechanics are documented in [Ranking by locator position](../../core/system/search.md#ranking-by-locator-position-modelocator_position); two access-control facts belong here:

- **Pins are filters, not grants.** A pinned locator restricts the result set to those records; it never widens access. Every pinned record still passes the ordinary project-scope ACL (`buildProjectsFilter`), and semantic search itself ACL-gates every hit before it can be pinned (schema ACL + per-record projects ACL, `src/ai/rag/retrieval.ts`). A pin can never surface a record the caller could not already read.
- **The rank is never frozen into a shareable preset.** A stored search preset keeps only the live `{"semantic":{q,group}}` query, not the pinned locator list or its order; applying the preset **re-runs** semantic search against current data and pins the fresh result. A shared preset therefore carries the meaning, not a stale ranking snapshot.

This is TS-native, additive (WC-047) — there is no counterpart in the previous engine. For the meaning-based query surface it drives, see [the RAG subsystem](../ai/rag.md).

## Related

- [Search Query Object (SQO)](../../api/sqo.md) — the full query language.
- [Areas configuration](administration.md#11-denying-and-hiding-areas) — area-level access (a coarser grant than the project filter).
