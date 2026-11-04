# Rebuild the Dédalo section family in native TypeScript

Standing spec for the section family, companion to `engineering/REWRITE_SPEC.md` (whose constraints — §2 absolute constraints, §2b code style, §7 security — apply here unchanged) and `engineering/RELATIONS_SPEC.md` (the relation family; sections and relations meet at the subdatum seam and this spec does not re-open relation internals). PHP reference tree: `v7_php_frozen/master_dedalo` (read-only). All `file:line` anchors below point into that tree and have been verified against it.

---

## 1. Mission & status

> **ADDENDUM 2026-07-07 (S3-31 — read this before the rest of §1).** The
> rebuild this section instructs **already landed** (see `rewrite/STATUS.md`
> for the measured state). §1's audit findings describe the PRE-rebuild
> tree and are no longer present-tense facts:
> - the section IS a first-class module now: `src/core/section/` (read.ts —
>   the shared read pipeline that replaced the deleted 829-line
>   `resolve/read_rows.ts`; context.ts — section context extras incl. the
>   `section_map` stamp; buttons.ts; locks.ts; record/ — create/duplicate/
>   save_component/delete; list_definitions/);
> - grouper contexts ARE built and emitted (`type:'grouper'` — the client
>   edit view nests components under them);
> - `section_map` IS stamped into the emitted section context
>   (section/context.ts:41-43);
> - the structure-context core cache carries NO user-dependent values —
>   tools/buttons are filled at per-call stamp time (see the re-dated header
>   of `resolve/structure_context.ts`).
> Keep §1's salvage list and the PHP anchors — still-valid oracle
> references. Remaining §1 gaps are ledgered in rewrite/STATUS.md (e.g.
> `prevent_lock`, list-column sortability) — check there before planning
> work from this spec.

> **ADDENDUM 2026-08-10 (section_id is an INT).** Wherever this spec shows a
> `section_id` as a string — stored locators, emitted context/data, echoes —
> the canonical form is now a **safe integer** (negatives valid). Writers mint
> ints, every app-API surface emits ints, numeric strings still coerce at the
> boundary as a counted deprecation, and external remote ids / synthetic tokens
> stay verbatim. Locator comparison remains LOOSE on `section_id`, and locator
> search probes are DUAL-FORM (int + string) while unconverted stock exists.
> Law: `engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md`.

> **ADDENDUM 2026-07-22 (list_thesaurus read mode).** `readSectionRows`
> now serves mode `'list_thesaurus'` (previously an uncovered-path throw).
> It is a plain list read on the row side — PHP row acquisition is
> mode-agnostic (`dd_core_api:2256`) — whose only server-side effect is the
> request_config swap to the **`section_list_thesaurus`** child (§7.5;
> `trait.request_config_utils.php:270-280`), i.e. a different derived
> column selection. Sender: **tool_indexation**'s People browser — the
> ontology-authored tool-config ddo `{role:'people_section',
> mode:'list_thesaurus', view:'thesaurus_list'}` becomes a section
> instance verbatim (`tool_indexation.js:469-84`); the client then
> normalizes the mode back to `'list'` (`section.js:800` — server-side-only
> alias). Session-sqo persistence includes it (PHP `$session_save_modes`,
> `:2276`). Gate: `test/unit/list_definitions.test.ts`.

> **ADDENDUM 2026-07-21 (WC-044).** List-column sortability DIVERGES from
> the PHP oracle for the Activity section (dd542): only the When column
> (dd547) is sortable and its ORDER path maps to the indexed `section_id`
> direct column (append-only log ⇒ When-order ≡ insertion order); every
> other dd542 column emits `sortable:false`. Rationale, the flattened
> ordered-search SQL shape that accompanies it, and its unique-key guard
> (`tableHasUniqueSectionKey`) are in `engineering/wire_contract/`
> WC-044; gate: `test/unit/activity_sort_policy.test.ts`.

**The section is THE main structure of Dédalo.** A section is the definition of a data schema — the analogue of a table in SQL: a named set of fields (components), defined in the ontology, organized by hierarchy relations. It is instantiated as a **section_record** in the matrix DB under a `section_id` that, combined with the `section_tipo`, is the base of the **locator** — every relation in the system points at that pair. A rewrite that gets sections wrong gets Dédalo wrong.

The current TS implementation of the section family is judged **not done correctly** and is hereby superseded as a foundation. It works — 56 differential parity gates and 24 unit gates pin real behavior — but it has no shape: the section is nowhere a first-class module. Audit findings the rebuild must resolve rather than inherit:

- **No section module.** Section CRUD verbs live inline in the 1,088-line `src/core/api/dispatch.ts`; section context is one branch of the model-sniffing 413-line `src/core/resolve/structure_context.ts` (section, component, and area in one function); row iteration + per-ddo emission live in the 829-line `src/core/resolve/read_rows.ts`. This is the same structural defect `RELATIONS_SPEC.md` §1 named for relations: one dispatcher instead of a shared core + per-concern modules.
- **The concept layer has no home for sections.** There is no `concepts/section*.ts` at all — section, section_record, and sections (the SQO group) have no contract modules; their semantics are implicit in the resolvers.
- **Scattered semantics.** `section_map` is correctly built (`src/core/ontology/section_map.ts`) but never stamped into the emitted section context (PHP stamps it — §6); `columns_map` is split between `structure_context.ts` and `relations/request_config/build.ts`; delete is spread over `delete_record.ts` + `diffusion_delete.ts` + a dispatch-inline cascade.
- **Three list-definitions are absent entirely** — `indexation_list`, `time_machine_list`, `section_list_thesaurus` have zero implementation (§7).
- **Groupers are skipped.** `read_rows.ts:513` drops any non-`component_` child with a comment ("groupers etc. contribute context only (deferred)") and no grouper context is ever built — the client edit view cannot group components into its DOM (§8).
- **`prevent_lock` is dead.** Declared in `concepts/rqo.ts:87` and the MCP write tools, enforced nowhere (§10).
- **Latent cache-identity bug.** The structure-context core cache key omits the user dimension (`structure_context.ts:15-16,:67`) while tools and buttons are user-gated — a cross-user bleed waiting for the first non-admin differential. And the buttons permission gate is a caller-cap proxy (`callerPermissions<2 → []`) instead of PHP's **per-button** `get_permissions(section_tipo, button_tipo) < 2` skip (§9).

**Salvage (proven — keep, do not rewrite blind):** `list_cell_config.ts` (the section_list substitution rule, clean and isolated), `section_map.ts`, the counter allocators in `db/matrix_write.ts`, `db/time_machine.ts`, the create/duplicate record logic, and — by explicit prior decision — the **TS-native `lock_components.ts` redesign** (per-lock rows + PK mutual exclusion instead of PHP's single-JSON-row contention; wire contract preserved). The differential test suite is the validation harness for the rebuild: it must stay green throughout, with zero fixture/normalization changes, exactly as the relations Phase A demanded.

Never silently narrow: keep a coverage ledger of what the rebuild does not yet cover.

## 2. The unifying model — one definition node, five child families

A section node (ontology `model === 'section'`) has children that partition into **five families, dispatched by model**. Everything in this spec is the resolution of one of these families:

| Family | Models | Role |
|---|---|---|
| **Fields** | `component_*` | The data schema — resolve context + data (already specified: REWRITE_SPEC §3.7/3.8, RELATIONS_SPEC) |
| **Groupers** | `section_group`, `section_group_div`, `section_tab`, `tab` | Organize components in edit mode; components are ontology children *of the grouper*; client groups the DOM by them (§8) |
| **List-definitions** | `section_list`, `relation_list`, `indexation_list`, `time_machine_list`, `section_list_thesaurus` | Per-view component selections — *which* fields resolve *where* (§7) |
| **Buttons** | `button_new`, `button_delete`, `button_print`, `button_stats`, `button_import`, `button_trigger` | Action definitions attached to the section context (§9) |
| **Markers** | `section_map` | Maps common roles (term/parent/order/…) to concrete component tipos per scope (§6.2) |

Around that definition, three runtime concepts:

- **section** — the schema definition instantiated per (tipo, mode): owns the ontology traversal, the context build, permissions, and the record set (§3).
- **section_record** — one matrix row addressed by (`section_tipo`, `section_id`): load/save/delete lifecycle, counter allocation, audit stamps, TM snapshot (§4).
- **sections** — a group of section_records instantiated from an **SQO** (one or many section_tipos): the search→rows→per-record fan-out that produces the API `{context, data}` (§5).

**Section is a peer of component_portal in the resolution machinery**: it uses the *same* `get_structure_context` and the *same* subdatum expansion. The rebuild must express that as shared code, not parallel copies.

The **list-definition consumption map** (the load-bearing table of this spec):

| Definition | Consumed by / when | Selection source |
|---|---|---|
| `section_list` | LIST + TM view rows: replaces the section's own properties/config | node `relations` (+ node properties as list request_config) |
| `relation_list` | Inverse-relations grid ("who calls me?") + the inspector trigger `config.relation_list_tipo` | `section_map` scope `relation_list` (columns) else legacy node `relations` |
| `indexation_list` | Thesaurus tag-indexation grid (component_relation_index / tool_indexation) | node **properties `head`/`row` → `show->ddo_map`** — NOT `relations` |
| `time_machine_list` | Inspector time-machine access **permission target only** — no rendering resolver | none (permission flag node; `relations` empty) |
| `section_list_thesaurus` | Thesaurus/hierarchy tree node rendering (ts_object) | node **properties `show->ddo_map`** |

## 3. section — the schema definition (`core/section/class.section.php`)

- `get_instance(tipo, mode='list', cache=true, caller_dataframe=null)` `:245` — validates `model==='section'` via `ontology_node::get_model_by_tipo` (`:248`; **returns false on mismatch, does not throw**). Cache bypass when `cache===false || mode==='update' || mode==='tm'` (`:270`); key `tipo_mode` (`:303`), extended with `id_key`+host+main tipo for dataframe callers (`:306`). Static instance cache bounded 1200 / evict 400.
- Per-request static caches — `$ar_section_instances`, `$cache_ar_children_tipo` `:194`, `$section_map_cache` `:204`, all purged by `clear()` `:215`. In TS these must be per-request-scoped or keyed independently of request identity (REWRITE_SPEC §4).
- `__construct` `:347` — `lang = DEDALO_DATA_NOLAN` (`:353` — section data is not per-lang; components are), data column via `section_record_data::get_column_name` (`:358`).
- **`get_ar_children_tipo_by_model_name_in_section(section_tipo, ar_model_name_required, from_cache=true, resolve_virtual=false, recursive=true, search_exact=false, ar_tipo_exclude_elements=false, ar_exclude_models=null)` `:868` — the primary ontology-traversal entry point** of the whole family (components, buttons, groupers, list-definitions, section_map are all located through it). Traversal law (doc `:824-835`): model names containing `'component'` recurse through groupers; other models are first-level only; >1 requested model forces recursive (`:955-976`). Virtual sections resolve to the real tipo and subtract `exclude_elements` (`:900-940`). `search_exact` toggles `===` vs `str_contains` (`filter_children_by_models` `:1021`).
- Virtual sections: `get_section_real_tipo` `:770` / static `:809`. A virtual section (e.g. a thesaurus section like cult1) borrows the real section's children minus its `exclude_elements` node — every child-family lookup in this spec must be virtual-aware.
- `create_record(?options)` `:403` — the section-level create: guards (int `section_id` `:427`, logged user `:437`, **Activity section refused** `:452`), `build_metadata` (`:466`) + `build_modification_data('new_record')` (`:476`), `section_record::create` (`:491`), 'NEW' activity log (`:507`), per-tipo cache invalidation switch (`:525` — dd1244 presets / dd1324 tools / filter_master).
- `get_section_buttons_tipo()` `:1121` — §9. `get_section_map(section_tipo)` `:1702` — §6.2. `get_ar_grouper_models()` `:1891` — §8.
- `get_section_permissions()` `:1918` — memoised; `common::get_permissions(tipo, tipo)` (`:1926`); **Activity section capped to 1** (`:1929`).
- `get_search_query` `:1774` — section-level filters hardwire `component_path=['section_tipo']` (search on the section column, not JSONB).
- Metadata/audit tipos: `get_metadata_definition` `:1830`/`:1866` — dd200 created_by, dd199 created_date, dd197 modified_by, dd201 modified_date.
- Session SQO: `build_sqo_id(tipo)` `:1953` (identity), `get_session_sqo` `:1976` / `set_session_sqo` `:2002` — per-user pagination/filter state keyed by sqo_id; stamped into context as `sqo_session` (§6.1). In TS this is per-session server state, not PHP `$_SESSION` — design the equivalent.
- Relations stored on the section's own dato: `get_relations` `:1355`, `add_relation` `:1390`, `remove_relation` `:1515`, `remove_relations_from_component_tipo` `:1593`.

## 4. section_record — the row lifecycle (`core/section_record/class.section_record.php`)

- `get_instance(section_tipo, section_id, is_temporal=false)` `:156` — per-request instance cache keyed `tipo_id` (+`_temp`); string `section_id` is deprecated → cast + ERROR log, continues (`:159`). Quirk: `__destruct` `:250` evicts with a key that omits `_temp`, so temp+normal share an eviction slot.
- `save()` `:539` — `data_handler::update` (`:550`; `matrix_activity` uses its own db manager `:225`), `save_event()` (`:558` — post-write cache invalidation switch `:281`: dd1244 presets / dd1324 register tools / dd996 tools config / dd234 profiles), **RAG enqueue hook** gated + non-fatal (`:564-571`).
- `delete(delete_diffusion_records=true)` `:860` — the ordered pipeline: `section_id<1` aborts (`:870`); **(1) TM snapshot ALWAYS first** (`:878-894`, throws on TM failure `:901`, then re-reads and verifies saved-vs-source with **loose `==`** (`:921`) aborting the delete on mismatch — a deliberate safety gate the TS rebuild must reproduce or consciously strengthen with a documented decision); (2) row delete (`:936`); (3) `remove_all_inverse_references` (`:951`) + `remove_section_media_files` (`:954`); (4) diffusion unpublish, per-target failures non-blocking (`:956`); RAG delete enqueue (`:985-990`). The TS delete pipeline already implements most of this (including pinned PHP live-defects) — the rebuild consolidates it under the section_record module, it does not re-derive it.
- **Counter allocation** — the identity-critical part: `allocate_component_ids(tipo, count=1)` `:1284` takes `pg_advisory_lock` on hashed `"{table}_{section_tipo}_{section_id}_{tipo}"` (`:1309-1312`), re-reads persisted `meta->tipo->0->count` (`:1320`), `base = max(persisted, in_memory)` (`:1335` — raise-never-lower), persists via `jsonb_set` (`:1344`), unlocks in `finally` (`:1362`); DB-down fallback is non-atomic in-memory (`:1295`). `raise_component_counter` `:1390` same lock. The TS `matrix_write.ts` allocators (`insertMatrixRecordWithCounter :269`, `allocateComponentItemId :186`, `absorbComponentItemIds :236`) are proven equivalents — keep them; the rebuild gives them a home, not a rewrite.
- `build_modification_data(section_tipo, mode, user_id)` `:1581` — static/pure; skips Activity (`:1584`); `new_record` → dd200+dd199 (`:1622`); `update_record` → dd197+dd201 (`:1636`); fixed user-locator item id 1 (`:1606`). `build_metadata` `:1679` — the initial flat `data` column (label, created_date, section_id, section_tipo, diffusion_info:null, created_by_user_id).
- `create(section_tipo, section_id=null, values=null)` static `:1974` — **only `section` may call it, but the assert is SHOW_DEBUG-only** (`:1980`) — in TS make it a real module boundary. With explicit `section_id` → update-merge path (`:1996-2050`); else INSERT allocating `section_id` (`:2057`) + forced `get_data()` refresh (`:2072`).
- `read(cache=true)` `:2258` — quirk: `matrix_time_machine` is never queried here; TM rows are injected by `tm_record` (`:2273`).
- Audit stamp accessors `:2484-2775` (created/modified date + user id + user name).

## 5. sections — the SQO-instantiated group (`core/sections/class.sections.php` + `sections_json.php`)

The concept the user names "sections": *a group of multiple section_records, one or many section_tipos, instantiated with an SQO*.

- `__construct` `:134` — **clones the SQO** (`:138`) so the caller's object is never mutated (a per-request-safety rule the TS engine must keep).
- `set_up()` `:167` — limit normalization: edit mode → 1 (`:178`); when the caller is itself a section, inherit the limit from the caller's `build_request_config` 'dedalo' entry (`:190-199`); default 10 (`:204`). Forces `select=[]` (`:214`) — sections only fetches `section_tipo`/`section_id`; all values resolve later per record through the context machinery.
- `get_data()` `:232` — memoised; `search::get_instance(sqo)->search()` (`:240`); **returns false on search error** (`:244`) — callers must check; in TS: throw typed errors instead, but preserve the wire outcome.
- `get_ar_section_tipo()` `:274` — related mode with `['all']` forces the search and collects the distinct `section_tipo` per row (`:288-307`); otherwise mirrors `sqo->section_tipo` — this is the multi-section/`mix` seam.
- `delete(options)` `:421` — group delete: `delete_mode` default `'delete_data'`, `delete_with_children`, `prevent_delete_main` (`:429-435`); permission `<2` refused (`:463`); empty SQO defaults from the source section_id (`:478`).
- **`sections_json.php` — the rows envelope** (the shape `read_rows.ts:454` currently emits inline):
  - empty-result path (`:94-127`): per `ar_section_tipo`, build a bare section, propagate pagination/view, emit **context only**;
  - data path (`:128`): one envelope item `{typo:'sections', tipo: caller_tipo, section_tipo: [], entries: []}` (`:136`); per-request `$section_instances` reuse cache (`:157`) and `$rejected_sections` permission-skip cache (`:169`); **TM rows converted via `tm_record::get_section_record()` keeping `tm_origin_section_tipo` for the SEC-024 permission gate** (`:182-214`); per-record perms cap (`:217-259`); `current_value` locator with `paginated_key = row_key + offset` (`:292`) + TM metadata (`:297-307`); per-instance `get_json()` fans out `get_subdatum`; context deduplicated via `common::context_key` (`:318-339`); data spread-appended (`:344`).
- `core/section/section_json.php` — the per-record controller: **intentionally ignores `get_context`/`get_data` flags** (doc `:28-32`); permissions>0 → `get_structure_context(permissions, add_rqo=true)` stored for subdatum (`:68`), `get_subdatum` over the section_records (`:85`), merge + flatten (`:89-92`).
- `dd_core_api` routing (`core/api/v1/common/class.dd_core_api.php`): `read` `:731`; `build_json_rows` `:2022` — session key = `section::build_sqo_id` (`:2062`), **pre-hoc read permission gate** (`:2067-2129`) + per-`sqo->section_tipo[]` target gate (`:2135`), session-SQO merge when `session_save` (`:2170-2199`) and reuse when the client sends none (`:2205`), action `search` → `sections::get_instance(null, sqo, tipo, mode, lang)` (`:2264`), session save (`:2277-2298`), **component unlock on read** (`:2321`); `create` `:975` (perms<2 `:994` → `section::create_record` `:1006`); `duplicate` `:1057` (SEC-024 record-in-user-scope assert); `delete` `:1177` (model must be 'section' `:1196`, `delete_mode` default `delete_data` `:1208`, perms `:1218`, → `sections::delete` `:1229`); `save` `:1304` (**Activity section blocked** except `search_*` ids `:1330`; changed-data atomic actions doc `:1248-1258`); `read_raw` section → `fetch_all` `:919-921`; `section_tool` nodes re-route to `model='section'` (`:388-428`).

## 6. Section context — what a section stamps beyond a component

### 6.1 The structure-context law (`core/common/class.common.php`)
`get_structure_context(permissions, add_request_config)` `:1604` → cached invariant core `build_structure_context_core` `:1739` + per-call stamping **on a clone** (`:1644`; properties deep-cloned `:1653`): permissions `:1659`, parent `:1661`, lang `:1667`, request_config `:1670`, columns_map (gated on request_config presence) `:1679`, **section-only `sqo_session`** `:1696-1699`, search-mode `parent_grouper_label` `:1701`. The core **cache key is `user_tipo_sectiontipo_mode_addrqo_simple`** (+`_p{md5(properties)}` on injection) `:1768-1770` — note the **user** dimension the current TS cache omits. The core returns the cache entry itself — callers must clone (`(!)` in-code warning); in TS, never leak the cache by reference.

Inside the core, section-relevant steps in order: `section_list` property swap for list/tm (`:1806-1822`, §7.1); css `:1828`; **tools** `:1857-1917` (config override chain configuration→register→ontology `:1882`); **buttons** via `get_buttons_context` `:1919-1922` (skipped in `simple` mode); label preset override `:1930`; columns_map when add_rqo `:1947`; then the **`$model==='section'` block `:2056-2101`**: stamps `section_map` (`:2075`), `config->relation_list_tipo` = first legacy `relation_list` child (`:2077-2094` — the in-code comment records that the section_map `relation_list` *scope* only changes grid columns and does NOT replace this trigger), and `matrix_table` (`:2097`).

> **ADDENDUM 2026-11-04 — the request_config stamp comes from the element NODE.**
> The `request_config` a context entry stamps (`:1670`) is no longer rebuilt
> per door from the element's own ontology map: every context door (section
> read column pass, derived subcontexts, get_data, resolve_data, the save echo
> incl. the last-page swap, resolve_echo, relation_index, TM framed and
> whole-record rows) serialises it from the SAME `ElementNode` the data was
> emitted from — `buildStructureContext` takes a REQUIRED `configFrom`:
> `{source:'emission', node}` or a censused `{source:'own', reason}`
> (`OWN_CONTEXT_REASONS`, `test/unit/structure_context_own_census.test.ts`).
> The section-column pass reads the node registry instead of pre-seeding its
> `seen` set from the raw show map; entries ship in element-tree order and
> first-wins only for identical projections, a conflicting key being split per
> parent occurrence with `caller_chain`. The model is defined in
> `engineering/RELATIONS_SPEC.md` §1 *Effective config per element
> (2026-11-04)* — read it there, not here.

### 6.2 section_map — the role marker (`core/section/class.section_map.php`)
Scopes `main`/`thesaurus`/`relation_list`, per-scope keys `term/model/order/parent/is_indexable/is_descriptor` + optional `fields_separator` (class doc `:1-40`). Pure stateless static service: `SCOPE_FALLBACK = ['main','thesaurus','relation_list']` `:52`; `get_scope` `:139`; `resolve_key_scope` `:172` — **per-KEY fallback**: a scope that exists but lacks the key does not stop the walk (doc `:26`); `get_element_tipo` `:222`, `get_term_tipos` `:273`, `get_fields_separator` `:299` (default `', '` `:60`), `get_term` `:331` (delegates to `ts_term_resolver`). The raw map is the `section_map` child node's `properties`, read by `section::get_section_map` `:1702-1740` (virtual fallback `:1723`, cache `:1743`). Consumers: thesaurus tree, hierarchy, relation_list columns, `resolve_get_ddo_map` (§7.6), component_relation_parent, filters, dd_core_api. The TS `src/core/ontology/section_map.ts` is faithful — the rebuild's job is to **stamp it into the section context** and route all consumers through it.

## 7. The list-definitions — which components resolve where

All are first-level section children found via the §3 traversal law. They are *definitions*, not data — none has records.

### 7.1 section_list — LIST/TM view selection
Not every component appears in list view. The `section_list` child node's `relations` array names the list columns, and its `properties` carry the list request_config. Resolution: `resolve_ar_related_list_section` (`core/common/trait.request_config_v5.php:389-418`, with virtual fallback) and `resolve_source_properties` (`trait.request_config_utils.php:264-309`) — for list/tm/list_thesaurus modes the section's **own properties are swapped for the `section_list` child's properties, unless the section carries a direct `source->request_config`** (`:274`). Context-side swap for `model in ('section','component_portal') && mode==='list'` at `class.common.php:1806-1822`. The same substitution law applies to relation components rendering list cells — already implemented and gated in TS (`list_cell_config.ts`); keep it, and unify both consumers on one module. Excluded from the permission tree / edit context (`class.area.php:46,176`, `component_security_access.php:543`).

> **ADDENDUM 2026-07-10 — the css block is a SEPARATE resolution site (ported).**
> PHP resolves the trait swap above (the request_config feed) and the
> **emission block** `class.common.php:1801-1846` INDEPENDENTLY, and they
> disagree: the emission swap is `(section|component_portal) && mode==='list'`
> only (no `source->request_config` skip, plain-parent child lookup, first by
> `order_number`), while the trait covers list/tm/list_thesaurus with the
> own-config skip. Emission rules beyond the swap: (a) `remove_edit_css` —
> every OTHER element in list mode emits `css = null` (component css add-ons
> are edit-oriented and must not leak into list rows); (b) `properties.css` is
> **unconditionally unset** from the emitted properties (`:1834`) — css travels
> only as the top-level context field, and PHP's null-dropping serializer makes
> a stripped css an ABSENT key (TS emits `css:null`; the client treats both as
> absence); (c) the **section-node override** (`:1840-1846`): for any
> `component_*`, `section.properties.css->{tipo}` REPLACES the css in ANY mode,
> even over a list-stripped null. TS home: `resolveEmittedPropertiesAndCss`
> ("Site A") vs `resolveSourceProperties` ("Site B"), both inside the
> mode-keyed `buildCore` (`resolve/structure_context.ts`) — the strip is a pure
> build-time derivation, never a post-hoc mutation of a cached context.
> `view` is a THIRD independent resolution (`get_view` `:4464-4506`, TS
> `structuralView`): list-mode section_list-child preference for ANY
> component_*/section, then the element's OWN properties.view (never the
> Site-A swapped object's — 16 live mosaic portals depend on that fallback),
> then the model default.
> TS-only WC-016 extension: reserved `css.list`/`css.search` mode keys
> (`engineering/wire_contract/`). Gates: `component_list_css_strip_differential`,
> `section_list_css_differential`, the `css` field in `context_differential`,
> `test/unit/structure_context_css.test.ts`.

> **ADDENDUM 2026-07-17 — the VIRTUAL fallback of the list-column resolution
> landed (was missing).** `resolve_ar_related_list_section`'s virtual fallback
> (the "with virtual fallback" above, PHP `trait.request_config_v5.php`) had no
> TS counterpart: `relations/request_config/build.ts` looked for a `section_list`
> child only under the section's OWN tipo (`findSectionListChild`, a plain
> `WHERE parent = tipo` — correct, non-virtual, matching Site-B
> `resolve_source_properties`), and for a SECTION in list mode with none it
> returned `[]`. This is the exact section_list analog of the §9 buttons bug: a
> virtual section whose only children are `section_list`/`exclude_elements`/
> buttons resolves fine, but a **hierarchy/thesaurus-instance section with ZERO
> ontology children** (`es1` "Spain" → real section `hierarchy20` → `section_list`
> `hierarchy37` → 11 columns) got an empty ddo_map — its list view rendered only
> the built-in `Id` column. Fix: when the own-tipo lookup misses AND the owner is
> a section, resolve the real tipo via `getSectionRealTipo`
> (`resolve/security_access_datalist.ts`, mirror of
> `section::get_section_real_tipo_static`) and retry there; the resolved child
> then flows through the SAME explicit/implicit builder as a real section's own
> `section_list` (no new column logic, no `exclude_elements` subtraction — PHP's
> list fallback inherits the columns verbatim, unlike the edit walk). Gate:
> `test/unit/virtual_section_list_columns.test.ts` (DB unit, oracle-free —
> columns derived from the real section, never hard-coded).

> **ADDENDUM 2026-08-17 — `columns_map` is a FOURTH resolution site, and it does
> NOT read the Site-B swap.** PHP `common::get_columns_map` (class.common.php:4339-4374)
> reads `$this->get_properties()` — the element's OWN properties — and does its
> OWN `section_list` child lookup, but only for `list`/`tm`. Every other mode
> (`list_thesaurus`, `search`, `edit`, …) reads the element's own properties
> verbatim. TS was feeding `getElementColumnsMap` the Site-B output
> (`resolveSourceProperties`, which ALSO swaps for `list_thesaurus`), so a
> thesaurus list inherited its `section_list_thesaurus` child's
> `source.columns_map`. Concretely: `rsc197` (Personas) → `rsc1050` declares two
> columns (`a: rsc85`, `b: rsc1051`) while `rsc85` and `rsc86` both carry
> `column_id:'a'` — so the client's `get_columns_map` (common.js:1440) merged
> Nombre+Apellidos into ONE header while the row renderer still emitted a cell
> per ddo. The "Apellidos" header vanished and every header after it shifted
> left. Fix: `structure_context.ts` keeps the pre-swap properties as the internal
> `ownConfigProperties` (destructured out at stamp, never on the wire) and feeds
> `getElementColumnsMap` from it; the list/tm section_list lookup inside
> `getElementColumnsMap` is unchanged, exactly as PHP does it. Gate:
> `test/unit/virtual_section_list_columns.test.ts` — "columns_map feeds from the
> element OWN properties".

### 7.2 relation_list — inverse relations ("who calls me?")
Two distinct consumptions:
- **Grid columns** for the inverse-references view: `relation_list::get_relation_list_obj` (`core/relation_list/class.relation_list.php:261-339`) — prefers `section_map::get_scope(tipo,'relation_list', strict)` (`:292-304`), falls back to the legacy `relation_list` node's `relations` (`:311-322`).
- **Inspector trigger**: the section context stamps `config.relation_list_tipo` from the legacy node (§6.1); the client shows the "who references me" block only when it is set (`core/inspector/js/render_inspector.js:835-838`).
Related-list rows resolution: `resolve_ar_related_related_list` (`trait.request_config_v5.php:295-331`). The TS `relation_list.ts` implements the pipeline but its **value formatting is ledgered narrow** (string/number/datalist families only, others `value:null`) — the rebuild completes the value contract (it converges with the export-atoms value work; coordinate, don't duplicate).

### 7.3 indexation_list — thesaurus inverse relations (tag indexation)

> **ADDENDUM 2026-07-09.** The grid this section describes **is implemented**:
> config resolver `section/list_definitions/indexation_list.ts` + live drive
> `section/indexation_grid.ts` behind the `get_indexation_grid` dd_core_api
> action — a TS-NATIVE engine (batched per-table record prefetch + memoized
> reads instead of PHP's per-cell component instances) with a byte-parity
> wire shape. Gate: `test/parity/indexation_grid_differential.test.ts`
> (8 live-corpus grids deep-equal vs the oracle — the "orphaned data" claim
> below §"Definition of done" item 4 was WRONG: ~48k live dd96 relations).
> PHP quirk mirrored: `indexation_grid:553 set_dato([$locator])` is
> observably a NO-OP (Accessors magic sets `$dato`, `get_data()` reads the
> section record) — portals render their record's stored dato. Residuals
> (LEDGER "Known-open gaps"): the `av`-format text_area columns and live
> media-URL cells are corpus-unexercised; the media atom FAILS LOUD on data.

Consumed by the tag-indexation grid (`core/dd_grid/class.indexation_grid.php`): node find with real-section fallback and a hard ERROR-log+skip when missing (`:283-309`); selection comes from the node's **properties `head`/`row` → `show->ddo_map`** resolved through `process_ddo_map` (`:320-345`) — **not** from `relations`; `properties->color`/`class_list` feed the grid cell (`:274-280,:325-328`). Source locators via `get_ar_section_top_tipo` (`:221`); per-locator cell rendering `get_grid_value` (`:356,:387`). `component_text_area` has a dedicated `'indexation_list'` mode rendering interactive tag-fragment cells (`class.component_text_area.php:87-190`). This connects to `component_relation_index`/tag indexation (RELATIONS_SPEC §6.4 — Phase D); the stored tag-link contract is already pinned in the TS suite.

### 7.4 time_machine_list — the Time Machine permission target
**No rendering resolver exists** — it is a pure permission-target node (its `relations` are empty in the live corpus). It participates in the security-access permission tree (`component_security_access.php:502,:885`, walk `:493-534`): the user's permission level on this tipo governs whether a section's record history is readable — explicitly distinct from `tool_time_machine` availability, which is granted through the tools-profile system. Client: `render_inspector.js:840-854` + lazy `load_time_machine_list` (`inspector.js:201-212,:313-315`).

#### ADDENDUM 2026-08-14 — implemented, and it is now THE rule

The line "Zero TS implementation today" is retired. `src/core/section/list_definitions/time_machine_list.ts` implements `getTimeMachineListTipo` (virtual-aware, via `findSectionChildByModel`) and `canAccessTimeMachineList` (grant >= 1; **fail-closed** when the section declares no such node). Three things changed with the Time Machine unification — see `WC-2026-08-14-tm-scope-server-owned`, `WC-2026-08-14-tm-permission-floor`, `WC-2026-08-14-tm-ddo-mode-retired` and `WC-2026-08-14-tm-cells-obey-list-emit-policy`:

- **The gate now evaluates the CALLER SECTION.** It reads the scope off the SQO (`resolveTimeMachineScopeSection`), not `source.section_tipo` — the client pins that to `'dd15'`, so the gate used to evaluate dd15 against itself and this grant was, in practice, never consulted. Locators spanning two sections are REFUSED rather than reduced to the first: one section's grant cannot authorize another's history.

- **dd15's own columns derive their read level from this grant** (`WC-2026-08-14-tm-permission-floor`). The former wrapper rule in `security/permissions.ts` (`parentTipo === 'dd15' → isGlobalAdmin ? 1 : 0`) directly contradicted this node's existence and is gone. A principal holding the grant on oh1/oh25/rsc36 reads THAT section's history; the level is never above 1 (reverts go through `tool_time_machine`, never inline edit). The scope reaches `getPermissions` through a request-scoped ALS (`list_definitions/tm_scope_context.ts`), because the permission API has no parameter to carry it.

- **BROWSE vs SCOPED.** The bare browse (`?tipo=dd15&mode=list`, no SQO scope) shows every section's history at once, so no per-section grant can authorize it: it stays **global-admin only**. The grant authorizes the SCOPED surfaces — the tool (section and component callers) and the inspector's record/component history.

**The audit-lang rule.** A Time Machine cell renders the SNAPSHOT's own language (`matrix_time_machine.lang`), never the request data lang — a row recorded in `lg-eng` must not render blank when browsed under `lg-spa`, on the very surface a user reads to decide whether to restore. Whole-record snapshots are recorded `lg-nolan`, which is not a data lang: those follow the request lang like any list, because their snapshot holds every language.

**`tm` is a row source, not a render mode** (`WC-2026-08-14-tm-ddo-mode-retired`). `sqo.mode === 'tm'` selects the `matrix_time_machine` backend; every dd15 ddo, context entry and data item emits `mode: 'list'` and therefore obeys the ordinary component emit hooks (this is what gives a history column the same 130-char text_area truncation and tag rendering as the section's own list). Read-only-ness travels on the request-scoped TM read (`tm_scope_context.ts`) plus the consultation-only permission cap (level 1) the read pipeline applies; list chrome is the CALLER's decision (embedded panels pass `buttons:false, filter:false`). Tripwire: `test/unit/tm_mode_retired_tripwire.test.ts`.

### 7.5 section_list_thesaurus — hierarchy (tree) view selection
Consumed by the thesaurus tree (`core/ts_object/class.ts_object.php`): `get_ar_elements` finds the node first-level/exact with virtual fallback (`:212-256`); selection from the node's **properties `show->ddo_map`** (`:258-274`), with `link_children` vs `link_children_model` filtering (`:271-274`) and DEDALO_HIERARCHY/ONTOLOGY root special-cases. Also feeds `resolve_source_properties` list_thesaurus mode (`trait.request_config_utils.php:279-296`). **Zero TS implementation today** — it is the gateway to the ts_object/tree port, so specify the resolver now even if the full tree lands later; ledger the remainder.

### 7.6 Server-derived ddo_map — when the client sends no `show`
The section derives its own resolution map from the ontology (the TS server already relies on this — "no ddo_map needed"): `build_request_config` (`class.common.php:2944` — client-show short-circuit, base build, session/rqo overlay), `get_ar_request_config` (`:3434` — `resolve_source_properties` `:3476`, pagination defaults section 1/10 vs component 10/1 `:3483`, **explicit/implicit fork** `:3504/:3507`, non-cacheable when data-dependent `:3515`). The implicit edit-mode walk is where the five child families meet: `resolve_ar_related_edit` (`trait.request_config_v5.php:232-267`) requests `['component_', 'section_group', 'section_group_div', 'section_tab', 'tab']` **excluding `component_dataframe`**, expands groupers to their direct children (`:256`), then `filter_authorized_related` applies permissions (`:574`) and `build_legacy_ddo_map` (`:618`) emits `show->ddo_map` + `sqo_config`. Dynamic maps: `resolve_get_ddo_map` (`trait.request_config_ddo.php:424`) builds a ddo_map from **section_map columns** per target section (`:456-555`, scope-fallback per column, dedup-merge extending `section_tipo`) — already ported for the relations corpus (rsc860); route it through the same module.

### 7.7 Search-mode component reads — synthetic filter-row ids (ADDENDUM 2026-07-10)

The search **filter panel** (`core/search/js/search.js`) is a separate `search`
model, not a section read. It builds each filter component via
`get_component_instance` → `component_common.build(true)`, which issues a normal
`get_data` read (`create_source(self,'get_data')`, `mode:'search'`) against a
**synthetic, client-minted `section_id`** — `search.js get_section_id()` returns
`'search_1'`, `'search_2'`, … These address **no matrix record**; `Number('search_1')`
is `NaN`.

Two invariants follow, both pinned by
`test/parity/component_publication_search_differential.test.ts`:

- **The SELECT/FILTER family MUST emit its option datalist for a synthetic id.**
  PHP's json controllers switch on mode, and `search` falls into the edit branch
  → `get_list_of_values` (the target section's records — yes/no, projects, … —
  independent of any stored value). `render_search_component_publication.js`
  iterates `self.data.datalist` to draw its yes/no radios, so a datalist-less
  item leaves the filter blank. In TS, `readComponentData` resolves a null record
  for the synthetic id and, for the select/filter family (`SELECT_FAMILY_MODELS`
  + `component_filter`/`component_filter_master`) in search mode, materializes an
  **empty virtual record** and dispatches through the same select-family emit
  path (`emitDdoData`), echoing the raw non-numeric `section_id` verbatim so the
  client build matches by `String(el.section_id) === String(self.section_id)`.
  The item's lang stays the model's forced lang (publication → `lg-nolan`), never
  the request lang. Applies to component_select, select_lang, radio_button,
  check_box, publication, relation_model, filter, filter_master.

- **The per-record ACL gate (AUTHZ-01) EXEMPTS non-numeric ids.** `read_facade`'s
  `principalCanAccessRecord(section_tipo, Number(section_id), …)` gate would call
  `isRecordInScope(NaN)` → `false` and return an empty shell, blanking the whole
  search form for NON-admins (search is enabled for all users). PHP never gates
  this path — `security::user_can_access_record` is **RAG-only**; core `get_data`
  serves the datalist to every searcher. The gate now skips **non-numeric ids
  only**; every real numeric id — including non-positive ones (`0`, root `-1`) —
  stays gated, so no record reach is opened (`principalCanAccessRecord` returns
  `false` for `section_id < 1`).

## 8. Groupers — DOM organization of the edit view

Registry: `common::$groupers = ['section_group','section_group_div','section_tab','tab']` (`class.common.php:457-462`); legacy alias `section_group_div` → `section_group` (`:430`); `section::get_ar_grouper_models` (`:1891-1896`). Semantics:

- Components are ontology **children of the grouper**; the grouper is a child of the section. The §3 traversal recurses through groupers when hunting components — that is why the schema stays flat for search while the edit view is a tree.
- **Context inclusion**: in the structure-context children loop, a grouper child is instantiated *with its own model* and nested — `case in_array($model, common::$groupers): new $model(tipo, section_tipo, mode)` (`class.common.php:2696-2698`, also `:3926`). Each grouper contributes its own DDO context object (label, css); `section_group_div` sets `add_label=false` (`:3892-3899`). Components carry `parent_grouper` so the client can mount them under the right group.
- The classes are near-empty leaves (`core/section_group/class.section_group.php`, `core/section_tab/class.section_tab.php` — two visual modes `section_tab`/`tab`); both override `get_tools()` → `[]` (`:88-91`/`:99-102`).
- **List mode drops groupers** from the show map (grouper doc `section_group.php:23-25`); edit mode includes them. The current TS behavior (skip everywhere, `read_rows.ts:512-514`) is wrong for edit context.

## 9. Buttons — action definitions

- **Enumeration**: `section::get_section_buttons_tipo()` (`class.section.php:1100-1196`) — first-level only; virtual sections merge real-section buttons (minus `exclude_elements`) + virtual-specific buttons (`:1127-1177`).
  - **TS (landed 2026-07-10):** `section/buttons.ts::sectionButtonRows` is virtual-aware — it resolves the real section via `relations[0].tipo` (only when that node's model is `section`; a `matrix_table` relation like `dd623→dd22` keeps the section *real*), then returns `[...realButtons, ...ownButtons]` filtered by the FIRST `exclude_elements` child's relation tipos. The prior flat `WHERE parent = tipo` query returned `[]` for a virtual section whose only children are `section_list`/`exclude_elements` — e.g. **dd1244 (→ dd623)** rendered with no `button_new`/`button_delete`. Gated by the `dd1244` case in `buttons_differential.test.ts` (oracle) + `section_buttons_virtual.test.ts` (DB unit, oracle-free).
- **Context build**: `common::get_buttons_context()` (`class.common.php:4179-4326`) — only `section`/`area*` models produce buttons (`:4189-4193`); **per-button permission gate `common::get_permissions(section_tipo, button_tipo) < 2 → skip`** (`:4206-4210`) — this is the real ACL, not a caller-level cap; `properties->disable===true` skip (`:4225`); `button_import`/`button_trigger` attach tool contexts via `tool_common` with a static cache (`:4229-4306`); emits `type='button'` DDOs (`:4308-4318`). Injected into the section context at `:1919-1922` (skipped in `simple` mode).
- `button_common` ctor (`core/button_common/class.button_common.php:102-115`) — int `target` (matrix row), app lang. `button_new` permissions additionally via `security::get_section_new_permissions` / `ts_object::get_permissions_element` (`:29-30` doc); `button_delete` carries a SEC-054 mode allowlist.
- Client consumption: the inspector reads `section.context.buttons` and finds models (`render_inspector.js:510,:564-611`). Inspector body order (spec for future inspector work, doc `render_inspector.js:478-503`): paginator → buttons → tools → selection_info → element_info → project → relation_list → time_machine_list → component_history → activity_info → buttons_bottom.
- The TS `buildSectionButtons` is differential-gated but uses the caller-cap proxy — the rebuild replaces it with the per-button `get_permissions` gate and re-runs the buttons differential as a **non-admin** user (the admin harness cannot distinguish the two).

## 10. Locking & prevent_lock

Two distinct mechanisms — do not conflate:
- **Component locks** (collaborative editing, "who is editing what"): `core/component_common/class.lock_components.php` — opt-in `DEDALO_LOCK_COMPONENTS`, storage in UNLOGGED `matrix_notifications` row id=1, every mutation in a transaction with `SELECT … FOR UPDATE` (doc `:12-16`); `update_lock_components_state` `:134` (focus/blur; refuses focus held by another user), lazy TTL GC `drop_expired` `:353`, `force_unlock_all_components` `:399` (logout/expiry **and on every section read** — `dd_core_api:2321`), `get_lock_status` `:623`, `get_active_users(_full)` `:503/:575`. The TS `lock_components.ts` is a deliberate, approved redesign (per-lock rows + PK mutual exclusion; wire contract preserved; PHP-held locks honored read-only) — **keep it**; the rebuild only relocates it under the section family and verifies the read-path unlock hook.
- **`prevent_lock`** (RQO flag): in PHP this gates `session_write_close()` before long queries (`dd_core_api` doc `:1541`) — a PHP-session-runtime concern with **no TS equivalent** (Bun sessions are not file-locked). The TS flag is currently declared and dead. **Disposition it explicitly**: either wire the observable client contract (if any behavior is client-visible) or delete the flag from `concepts/rqo.ts`/MCP with a ledger entry. Do not leave it dangling.

## 11. PHP quirks to preserve or consciously decide

- `section::get_instance` returns **false** (not throw) on model mismatch; `sections::get_data` returns **false** on search error — TS should throw typed errors but keep the wire outcome identical.
- Loose `==` verify on the TM snapshot before delete (`section_record:921`) — reproduce or strengthen with a documented, gated decision.
- String `section_id` → cast + ERROR log, continues (`section_record:159`).
- `section_record::create` caller restriction is SHOW_DEBUG-only (`:1974-1980`) — make it a real boundary in TS.
- Activity section (dd542) special-casing everywhere: create refused (`section:452`), permissions capped 1 (`:1929`), save blocked except `search_*` (`dd_core_api:1330`), modification_data skipped (`section_record:1584`).
- All per-request static caches (`ar_section_instances`, `cache_ar_children_tipo`, `section_map_cache`, `cache_structure_context`, record instances) — per-request scoping is the standing §4 invariant; the structure-context cache must gain the **user** key dimension.
- Cache-key order dependence in the traversal cache uid (`section:883` — `md5(serialize(params))`).

## 12. Verified real-world corpus (mandatory fixtures)

> **ADDENDUM 2026-08-31 (P3-2 / GATE-47).** "Mandatory fixtures" is HISTORY.
> `dedalo_mib_v7` is the live APPLICATION database — never a fixture source, never
> a gate target; the suite writes only where the `dedalo_test_marker` row says it
> may. A gate naming an install-specific TLD (`rsc*`, `oh*`, `numisdata*`, …) is
> REFUSED by `generic_tld_tripwire`, shrink-only, so a new one cannot land. And
> the differentials these rows were written for are retired: the oracle is a
> FROZEN fixture store and a re-harvest is impossible by definition
> (`engineering/ORACLE_HARVEST.md`). Read the rows for WHAT the family does;
> build the situation through the engine's own write path on a `test` TLD
> (`src/core/test_data/`) and assert against that.

Resolved against the live ontology (`dd_ontology`, database `dedalo_mib_v7`). Every row is a required differential-parity fixture.

| Section | section_list | relation_list | time_machine_list | section_list_thesaurus | indexation_list | section_map | Groupers | Buttons |
|---|---|---|---|---|---|---|---|---|
| numisdata3 (Type) | numisdata122 (12 rel: 413,309,27,30,81,35,34,39,40,70,71,77) | numisdata577 (rel 309,27,30) | numisdata587 (empty) | numisdata317 (empty) | — | numisdata316 | 6× section_group (25,311,74,78,37,1255) + section_group_div numisdata1105 | new 123, delete 124, trigger 672 |
| numisdata4 (Object) | numisdata189 | numisdata578 | numisdata588 | — | — | numisdata53 | 10× section_group | new 222, delete 223, **import 256** |
| numisdata6 (Mint) | numisdata119 | numisdata576 | numisdata586 | — | — | numisdata667 | 3× section_group | new 120, delete 121 |
| rsc167 (Audiovisual) | rsc169 | — | — | — | — | rsc427 | — | trigger rsc1383 |
| rsc197 (People) | rsc199 | — | — | rsc1050 | **rsc1129** (properties `row` ddo_map, no `head`) | — | — | — |
| cult1 (thesaurus Cultura) | cult3 | — | — | **cult9** (14 hierarchy rel) | — | — | — | — (cult5 = exclude_elements, cult7 = diffusion alias) |
| hierarchy20 (Thesaurus) | hierarchy37 | — | — | — | — | — | 5 groupers | new hierarchy38, delete hierarchy39 |

Notable: sections WITHOUT a given definition are fixtures too (rsc167 has no relation_list → no inspector trigger; rsc197 is the only sampled section with an indexation_list). Anchored records for lifecycle gates: reuse the RELATIONS_SPEC §7 records (numisdata3 §15657 / §7 / §14073) plus the scratch-twin pattern for writes.

## 13. Gates (definition of done for the section family)

1. **Standing suite green with zero fixture/normalization changes** throughout the strangler migration (the relations Phase A rule). The 56 parity + 24 unit gates are the safety net — re-point imports, never weaken assertions.
2. **Section context parity, admin AND non-admin.** For every §12 section: full context in list and edit modes diffs clean vs live PHP — including `section_map` stamped, `config.relation_list_tipo`, `matrix_table`, per-button-permission buttons, tools, columns_map, `sqo_session`. The non-admin run is mandatory (it is what the current caller-cap proxy and user-less cache key cannot pass).
3. **Groupers.** Edit context contains the grouper DDOs with components mounted under them (`parent_grouper` consistent); list mode drops them; the §12 grouper corpus (numisdata3's 6+1, numisdata4's 10) byte-parity vs PHP.
4. **List-definitions complete.** section_list substitution gates stay green; relation_list grid with the full value contract (narrow ledger closed or explicitly re-ledgered with reason); indexation_list grid resolves rsc1129's `row` ddo_map (differential vs PHP `build_indexation_grid` where drivable, else pinned from the stored contract + unit gates — this install's indexation data is known-orphaned, see STATUS); time_machine_list recognized in the security-access tree + gating the inspector TM path; section_list_thesaurus resolver produces ts-tree elements for cult1/cult9 and hierarchy20 (full tree consumption may be ledgered to the ts_object port).
5. **section_record lifecycle consolidated.** create/save/delete/duplicate/counters under one module with the existing differential gates re-pointed; the delete pipeline order (TM-first, verify, inverse refs, media, diffusion, RAG) preserved; the loose-`==` TM verify decision documented and gated.
6. **sections envelope.** `{typo:'sections'}` envelope semantics — `paginated_key = key+offset`, permission-skip cache, TM conversion with SEC-024, empty-result context-only path — byte parity (largely pinned today; the gate is that the rebuild relocates without drift).
7. **prevent_lock dispositioned** (§10) — wired with a gate or deleted with a ledger entry.
8. **Structure.** The section family has a real home (`src/core/section/` or equivalent) with concept contracts in `concepts/` that do not lie about where semantics live; `dispatch.ts` section verbs, `structure_context.ts` section branch, and `read_rows.ts` row iteration are decomposed into it; the structure-context cache key carries the user dimension; the standing concurrency-interleave test extended to two users with different button/tool visibility.
9. **Security §7 unchanged or stronger.** Pre-hoc read gate + per-SQO-target ACL, SEC-024 duplicate/TM scope, per-button permissions, Activity-section special cases, security-access permission targets (`section_list` excluded, `time_machine_list`/`relation_list` included) — every chokepoint holds; fail-closed tests for each.

## 14. Suggested phasing (executor may evolve; mirror the relations A–F pattern)

- **A. Contracts + module home + relocation** — `concepts/section*.ts` contracts; `src/core/section/` registry; move CRUD verbs, context branch, rows envelope, lock hooks with ZERO behavior change; suite green untouched.
- **B. Context completion** — section_map stamp, per-button permissions, user-keyed cache, groupers in edit context; non-admin differentials.
- **C. List-definitions** — relation_list value contract; indexation_list; time_machine_list; section_list_thesaurus resolver.
- **D. Lifecycle consolidation + prevent_lock disposition** — one section_record module; delete pipeline relocation; interleave test extension.
- **E. Corpus sweep + monolith teardown + ledger closure** — §12 full sweep; `read_rows.ts`/`structure_context.ts` section code deleted; STATUS.md rows updated.
