# Rebuild the Dédalo relation-component family in native TypeScript

Standing spec for the relation family, companion to `engineering/REWRITE_SPEC.md` (whose constraints — §2 absolute constraints, §2b code style, §7 security — apply here unchanged). PHP reference tree: `v7_php_frozen/master_dedalo` (read-only). All `file:line` anchors below point into that tree and have been verified against it.

---

## 1. Mission & status

> **ADDENDUM 2026-07-07 (S2-46 — read this before the rest of §1).** The
> rebuild this section instructs **already landed**: phases A–E completed
> 2026-07-03 (see `rewrite/STATUS.md` "Relations rebuild"); only Phase F (corpus
> parity sweep + ledger closure) remains. The files §1 names as the
> to-be-superseded state are **deleted**: `src/core/resolve/read_rows.ts` →
> `src/core/section/read.ts` (shared emitDdoData; relations re-enter via
> callback), `src/core/resolve/request_config_v6.ts` →
> `src/core/relations/request_config/` (build/implicit/explicit), and
> `src/core/resolve/save_component.ts` →
> `src/core/section/record/save_component.ts` + `src/core/relations/save.ts`.
> The live subsystem is `src/core/relations/` (registry.ts dispatch,
> relation_core.ts shared engine, models/, request_config/, dataframe.ts,
> parent.ts, children.ts, related.ts, datalist.ts, filter_projects.ts,
> save.ts) — do NOT plan a rebuild from the paragraphs below; they are kept
> as the design rationale and PHP-anchor record. The PHP `file:line` anchors
> throughout remain valid oracle references.

> **ADDENDUM 2026-07-20 (relation engine = matrix_relation_index).** Where §5
> and later sections describe inverse/related searches over the four
> `data_relations_flat_*` stored functions and their GIN indexes: those
> functions are **removed** (with their indexes and every calling SQL path).
> The single engine is `matrix_relation_index` — a typed per-locator side
> table `(section_tipo, section_id, from_component_tipo, type,
> target_section_tipo, target_section_id)` maintained by row triggers in the
> same transaction as every write, backfilled at install/upgrade, gated by
> `requireRelationIndex` (uncovered = loud error, never a fallback). The
> `use_function` flat names survive as wire vocabulary only (WC-012,
> amendment 2). See `docs/core/system/search.md` → "The relation index".

> **ADDENDUM 2026-08-10 (locator `section_id` is an INT).** The
> string-canonical storage law this spec assumes is **repealed**: a stored
> locator's `section_id` is a safe integer (negatives valid), minted by every
> writer through `canonicalizeStoredSectionId()`
> (`src/core/concepts/section_id.ts`) — `relations/save.ts`'s `String(...)` and
> the emit-side stringifies are gone. Parse stays tolerant of the legacy string
> form, `compareLocators` stays LOOSE on `section_id`, and relation expansion
> probes jsonb containment in DUAL FORM (int + string) until the data sweep
> completes. External-service remote ids and synthetic tokens are NOT addresses
> and are stored/echoed verbatim.
> Law: `engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md`.

> **ADDENDUM 2026-08-05 (multi-source components).** A relation component may
> declare SEVERAL `request_config` items, and **every one of them contributes
> children**: `src/core/relations/config_ddo_map.ts` flattens each item's
> `show` + `hide` ddo maps into one deduped list, reproducing PHP's
> `full_ddo_map` (`class.common.php:2312-2341`). Which of those children a
> given locator sees is decided by the **locator's own `section_tipo`** against
> the child ddo's declared `section_tipo` — the filter that already lived in
> `relation_core.expandPortal`. **No `api_engine` branch exists anywhere in the
> read path, and none may be added**: dispatch stays model-polymorphic, exactly
> as the oracle does it. A locator whose target section is EXTERNAL (its
> ontology carries `properties.api_config`) has no matrix row at all; those
> locators are partitioned out of the page and resolved in ONE bounded
> fan-out through the `src/external/` facade before the emit loop, and only
> `component_external` (plus `component_dataframe`, which pairs with the MAIN
> record) may resolve there. Sites that must narrow a multi-item config to ONE
> item negotiate with the adapter's `capabilities`
> (`relations/request_config/engine_select.ts`) and refuse loudly where
> unsupported; the full census is
> `test/unit/external_config_narrowing_census.test.ts`. Wire law:
> `engineering/wire_contract/WC-2026-08-05-multi-engine-ddo-expansion.md` +
> `-external-request-field-union.md`.

> **ADDENDUM 2026-11-04 — Effective config per element (read this before §5.3).**
> The nested-ddo_map rebuild (plan W1–W6) replaced the per-site config builds
> with PHP's model: **ONE effective request_config per element instance**, and
> the data AND the context are projections of it (PHP `build_request_config`
> memo :2956, injected in place by the parent's `get_subdatum` :2603-2681,
> read by the context :1668-1672 and the element's own subdatum :2280).
>
> 1. **The node.** `relations/element_node.ts resolveElement(ddo, parentNode,
>    …)` returns an `ElementNode` `{tipo, section_tipo, mode, view, lang,
>    limit, parent_grouper, properties, effectiveConfig, configSource,
>    injectedSlots, …}`, memoised in the emission's `ElementNodeRegistry`
>    (scoped to the `EmissionContext`, never module state; TM forks share it by
>    reference), keyed per PARENT OCCURRENCE. `effectiveConfig` = the stage-1
>    config when the rqo targets the element (configSource `rqo`), otherwise the
>    ONE base own-config resolver (`request_config/own_config.ts`: override →
>    alias → `section_list` swap in list/tm, real mode) with the caller's
>    children injected; an element with no config of its own takes the
>    caller's DEDALO children as its config (configSource `caller`). The
>    governing ddo's `limit` lands on `sqo.limit` (the context reads it, the
>    data pages by it); its `view` / `mode` / `lang` / `parent_grouper` ride the
>    node, its `properties` merge into the context properties only.
> 2. **Injection** (`request_config/caller_injection.ts`).
>    `collectCallerChildren(callerConfig, tipo)`: per `api_engine`, the
>    caller's FIRST item of that engine, four slots (show / search / choose /
>    hide), PARENT-only match, depth-first in caller order, DUPLICATES KEPT (a
>    diamond keeps both paths), only a cycle on the ancestor path cut.
>    `injectCallerChildren(base, children)`: onto the element's FIRST item of
>    each engine, a slot replaced ONLY when the caller's list is non-empty (a
>    hide-only caller keeps the own show, a show-only caller keeps the own
>    hidden dataframe, a choose slot is created where the element had none),
>    an engine the element lacks skipped silently, the caller's PROCESSED ddos
>    injected verbatim. `sqo` and every other key stay the element's.
> 3. **Data.** Children = `show + hide` of the node's effective config, in
>    EVERY mode except `solved` (tm forced to list). **Rule 2 and the
>    `depth < 4` sentence of the 2026-08-31 addendum (§5.3) are SUPERSEDED**:
>    PHP has no depth/ownConfig/list gate — a nested element without caller
>    children falls back to its OWN config in list exactly as in edit
>    (`WC-2026-11-04-nested-list-payload-growth`). Bounds: `MAX_DDO_DEPTH` (12)
>    — an ontology-driven chain stops softly with `relation.depth_bound_stopped`,
>    a client map past it is still refused — and a per-path record-cycle guard
>    on `(section_tipo, section_id, tipo)` with `relation.record_cycle_stopped`
>    (`WC-2026-11-04-record-cycle-stop`). relation_index related_list children:
>    a relation child with an explicit request_config expands its own show in
>    `related_list` mode, a config-less one stays one-level (PHP-verified).
> 4. **Context** (`section/node_contexts.ts`). Serialised from the SAME nodes
>    (`buildStructureContext` `configFrom: {source:'emission', node}`; an
>    `{source:'own', reason}` door is censused —
>    `test/unit/structure_context_own_census.test.ts`), in element-tree order
>    (`WC-2026-11-04-context-traversal-order`), first-wins by context key for
>    identical projections; distinct configs of one key under different parents
>    ship one entry each stamped `caller_chain` (owner decision (b),
>    `WC-2026-11-04-caller-chain-per-occurrence`). Time Machine (dd15) top-level
>    columns are NOT flat: their parent is the root map, so children the
>    client's column map declares under a column are injected (show replaced,
>    sqo/limit the column's own `section_list` ones), in the cells and the
>    column context alike (`test/unit/nested_ddo_map_injection_native.test.ts`,
>    "TM, caller children").
> 5. **Stage 1** (`request_config/from_rqo.ts`, PHP
>    `build_request_config_from_rqo` + validate/consolidate): applies when the
>    rqo targets the element and carries a show object; only `ddo_map` is
>    copied, the client sqo goes through `sanitizeClientSqo`, every ddo is
>    judged by `ddoIsAuthorized` (stricter than PHP —
>    `WC-2026-11-04-stage1-authorized-sqo-scrub`). On a component the client
>    replaces show (and search when sent) on the base's first dedalo item;
>    hide / choose / sqo / other engines stay the server's. A base with no
>    dedalo item (external-only, or none) takes stage 1 as is, its sanitized
>    client sqo included.
> 6. **Caller chains** (`relations/caller_chain.ts`). A request targeting a
>    nested element names its callers in `source.callers`
>    (`WC-2026-11-04-rqo-source-callers`); the server verifies every link
>    (root readable by grant, every further link a declared data child in the
>    effective config) and resolves the element under it — page 2 keeps page
>    1's columns (owner decision (a), `WC-2026-11-04-nested-paging-add-show`).
> 7. **Permissions** (decision (d), exact PHP): a child of a COMPONENT caller —
>    literal or relation, at any depth, own-config or injected alike — is
>    raised to read (1) and capped at read under a read-only caller
>    (`inheritSubdatumPermission`, PHP :2564-2571); only a SECTION caller's ddos
>    are dropped without a grant (STEP 11). (f) The search read floor is
>    computed from the effective config through the verified chain. (h) An
>    autocomplete WRITER may search an ungranted target only through its
>    verified chain, scoped to its config's columns
>    (`WC-2026-11-04-writer-chain-scoped-search`); (i) the tree picker follows
>    the same scope and its save-door read gate is retired
>    (`WC-2026-11-04-tree-picker-read-gate-retired`); (j) a config-less (v5)
>    component keeps PHP's STEP 5 `filter_authorized_related` and opens no
>    scope.
> 8. **`self`** (decision (c)). `section_tipo: 'self'` (four spellings) means
>    the owner's targets at the FIRST level only; at depth ≥ 2 the ddo is
>    refused with `ontology.ddo_self_refused` — on the response whatever owns
>    the map, a section's own `section_list` / edit map included (owner = the
>    section; only a door with no response keeps the log line) — and listed by
>    the `ddo_self_depth` ontology check, which measures a list node from every
>    section that reads it (a virtual reader as its own owner)
>    (`WC-2026-11-04-ddo-self-first-level-only`). A ddo
>    `section_tipo` may be an SQO source array, resolved by the sqo resolver.
> 9. **ddinfo** (decision (g)): the TS gates (`component_autocomplete_hi`, not
>    TM) stay; the trigger is the governing children's `value_with_parents`
>    (`WC-2026-11-04-ddinfo-gates-kept`).
>
> Gates: `test/unit/nested_ddo_data_native.test.ts`,
> `test/unit/nested_ddo_map_injection_native.test.ts`,
> `test/unit/subdatum_permission_native.test.ts`,
> `test/unit/caller_injection.test.ts`, `test/unit/request_config_from_rqo.test.ts`,
> `test/unit/element_node_registry.test.ts`, `test/unit/ddo_self_depth.test.ts`,
> `test/unit/ddo_section_tipo_source_array.test.ts`; client
> `test_nested_portal.js`, `test_caller_chain.js`.

**Relation components are the first-class, critical part of Dédalo.** Sections connect to sections *only* through locators stored by relation components; the thesaurus tree, portals, indexation, access control (projects filter), and the dataframe system are all expressions of the same relation machinery. A rewrite that gets relations wrong gets Dédalo wrong.

The current TS implementation of relations is judged **not done correctly** and is hereby superseded as a foundation. It is concentrated in `src/core/resolve/read_rows.ts` (~1,600 lines, the portal/subdatum/dataframe renderer), `src/core/resolve/request_config_v6.ts`, `src/core/search/search_related.ts`, and `src/core/resolve/save_component.ts`, with good value objects in `src/core/concepts/locator.ts` and `src/core/concepts/ddo.ts`. **Audit it, salvage what is proven (the differential parity tests and the locator/ddo value objects are assets), then rebuild the relation family on the coherent model below — do not patch around the existing shape.** Known defects and ledgered gaps in the current code, which the rebuild must resolve rather than inherit:

- `src/core/concepts/subdatum.ts` and `src/core/concepts/request_config.ts` are contract-only stubs marked `TODO`, while the real logic lives elsewhere — the concept layer lies about where the semantics are. The rebuild must make the concept modules the real home of the contracts.
- Relation resolution is a single monolithic dispatcher (`read_rows.ts`) instead of a shared relation core + per-model particularities (§2). This is the structural defect: every new model grows the monolith.
- Deferred and still missing: `filter_by_list`/`fixed_filter` expansion, external `api_config` resolution, per-ddo permission gating, `fields_map`, dataframe **saves**, `relation_search` ancestor-index SQO wrapping for hierarchical autocomplete, the `_tm` (time machine) search twin, `filter_by_locators_op: 'AND'`, multi-ddo datalist labels.
- `component_indexation`-style tag indexation has no dedicated resolution path.

Never silently narrow: keep a coverage ledger of what the rebuild does not yet cover, exactly as the master spec demands.

## 2. The unifying model — one concept, many particularities

A **section** is an ontology definition of a group of components; every record of it is addressed by a unique pair (`section_tipo`, `section_id`). Sections connect to other sections **only** through relation components, and the connection value is always a **locator** (§3).

Every relation component, whatever its model, does the same thing:

> Declare, in the ontology, the **target section(s)** and **what information of the target section it needs** (a `request_config`, §4) — then resolve data from the target(s) and represent part of it inside the main section.

All relation components must work the same way through a **shared relation core**, with per-model *particularities* layered on top (§6):

- some need the **full list of records of the target section** as selectable options (select, radio_button, check_box → datalist, §5.1);
- some **calculate** their data instead of storing it — "who calls me?" via inverse relations (relation_index / indexation, children);
- some obtain data through a **mix of conditions or an external API** (external);
- some resolve **indirectly/transitively** (relation_related: if a=b and b=c then c=a);
- **dataframe** points at target section(s) like any relation, but its locators pair to *individual data items* of a main component via `id_key` (§6.2).

PHP shared core: `core/component_relation_common/class.component_relation_common.php:61` (abstract base of the family). Key methods: `add_locator_to_data` `:1223` (append with dedup, `type` mandatory), `remove_locator_from_data` `:1306` (default match on `['section_tipo','section_id','from_component_tipo','type']`), `validate_data_element` `:1058`, `get_locator_value` `:1412`, `get_filter_list_data` `:2375` (datalist attach at `:2404`), `sort_data_by_column` `:3310`, `add_new_element` `:3770`.

**Model inventory** (base class in parentheses; all under `v7_php_frozen/master_dedalo/core/`):

| Model | Base | Role |
|---|---|---|
| component_portal | relation_common | Editable, sortable, paginated locator list to target-section records |
| component_select | relation_common | Single choice from full target-section datalist |
| component_radio_button | relation_common | Single choice, radio semantics (new selection replaces prior) |
| component_check_box | relation_common | Multi choice from closed vocabulary |
| component_select_lang | relation_common | Select bound to the languages thesaurus |
| component_relation_parent | relation_common | Upward hierarchy link (stores parent locators) |
| component_relation_children | relation_common | **No own data** — computes children from who points at me via component_relation_parent (§6.3) |
| component_relation_related | relation_common | Associative links with directionality + transitive closure (§6.6) |
| component_relation_index | relation_common | Indexation / inverse relations, "who calls me?" (§6.4) |
| component_relation_model | relation_common | Model/template link (dd98) to a catalogue section — target derived from the CALLER (§6.7) |
| component_filter | relation_common | Projects filter — locators to project records, drives record visibility |
| component_filter_master | component_filter | User-section variant defining a user's project permissions |
| component_dataframe | component_portal | Frame records paired to main-data items via `id_key` (§6.2) |
| component_external | component_common | Read-only proxy to a third-party API (§6.5) |
| component_inverse | component_common | Generic read-only backlink viewer (same primitive as relation_index) |
| component_filter_records / component_security_access | component_common | Row-level ACL / ontology-permission editors — relation-shaped data, not relation_common |

**Legacy model aliases (load-bearing):** the ontology still names `component_autocomplete` and `component_autocomplete_hi` as models; v7 PHP maps both to **component_portal** via `common::$ar_temp_map_models` (`core/common/class.common.php:427-432`). "Autocomplete" is a client rendering/interaction mode of portal-family components, not a server model. `component_relation_struct` is in the excluded-legacy list (`:439`). The rest of that excluded list is DEAD, not aliased — `component_security_areas` (live case: `dd249`), `component_autocomplete_ts`, `component_html_file`, `component_ip`, `component_layout`, `component_score` have no model and no client module, so the implicit section-edit walk must never emit a ddo for them (`DEAD_LEGACY_MODELS`, `relations/request_config/implicit.ts`) or the client's dynamic import 404s and the edit render aborts. The TS ontology resolver must reproduce this mapping table — several corpus rows in §7 hit it. The `component_autocomplete_hi` legacy model additionally maintains the `relation_search` ancestor-index column on save (`core/component_common/class.component_common.php:2020-2022`) so hierarchical targets can be searched by ancestry — preserve that write and the matching SQO wrap.

## 3. Locator — the universal relation pointer

Reference: `core/common/class.locator.php` (field schema in the class doc-block `:14-29`). Mandatory: `section_tipo`, `section_id`. Relational/optional: `component_tipo`, `from_component_tipo`, `type`, `type_rel`, `tag_id`/`tag_component_tipo`/`tag_type`, `lang`, `label`, `paginated_key`, and the dataframe pairing fields **`id_key`** + `main_component_tipo` (legacy `section_id_key`/`section_tipo_key` are read-only BC).

Equality/lookup semantics are the integrity foundation of all relation data — implement them as pure, exhaustively unit-tested functions:

- `compare_locators(l1, l2, ar_properties=[], ar_exclude=[])` — `class.locator.php:956`. Empty `ar_properties` = strict full-property compare; a subset = loose compare.
- `in_array_locator(l, ar, ar_properties=['section_tipo','section_id','type','component_tipo','tag_id'])` — `:1031`. Loose membership on that default 5-field predicate.
- `build_locator_lookup_key(l, properties=<same 5 fields>)` — `:1099`. Delimiter-joined compound key (`DELIMITER='_'`, `:50`).

Preserve the PHP quirks deliberately: string-vs-int `section_id` tolerance, and which fields participate in each default predicate. The existing `src/core/concepts/locator.ts` already models this correctly (passthrough schema, byte-compat) — keep it as the base and extend, don't rewrite it blind.

## 4. request_config — how a relation declares its targets (implicit vs explicit)

TS nomenclature: **explicit** ≡ PHP v6, **implicit** ≡ PHP v5 (the PHP trait/file names keep the version labels; the anchors below are verbatim oracle references).

Builder selection is **data-driven**, not per-model: `common::get_ar_request_config()` chooses the explicit builder when `properties->source->request_config` exists on the ontology node, else falls back to the implicit one (`core/common/class.common.php:3434`, branch at `:3502`).

- **IMPLICIT (legacy — deprecated but must work).** No explicit config; targets and child ddo tipos are derived by walking the ontology relation graph. When a relation is simple, the implicit walk is enough, and real installations still carry legacy `source` objects (see corpus row numisdata55). Entry: `trait.request_config_v5.php:78` `build_request_config_v5`, resolvers `:186-:441`, legacy ddo_map builder `:618`. `component_relation_parent`/`component_relation_children` are **not** supported implicitly — they require explicit config.
- **EXPLICIT (modern — the default builder).** `properties->source->request_config` is an array of config items, each carrying an **SQO naming the target section(s)** plus `show`/`search`/`choose`/`hide` ddo_maps and an optional `api_engine`/`api_config`. Entry: `trait.request_config_v6.php:69` `build_request_config_v6`; item parse `:158` (api_engine `:171`, external branch → `resolve_external_config` `:628`); target resolution `resolve_sqo_section_tipo` `:245` — note targets may be **fixed sections** (`["numisdata3"]`), **dynamic** (`hierarchy_types: [1,2,8]` resolved to the active hierarchies at runtime), or **self-targeting** (SQO with only `filter_by_list`, no `section_tipo` — see corpus rows numisdata36/numisdata1006).
- Wire object: `class.request_config_object.php:207`; client ddo whitelist `sanitize_client_ddo_map` `:673` (a §7 security chokepoint — client-supplied ddo fields are capped to the display allowlist).

Some components have **no** `source`/`request_config` at all and derive their target purely from ontology `relations` (corpus rows numisdata967, numisdata71, numisdata1562) — the implicit path must cover this.

> **ADDENDUM 2026-07-10 — user PRESET override (dd1244 layout maps, LANDED).**
> Before builder selection, a **SECTION** owner applies a STAGE-2 override that
> can REPLACE its `source.request_config` with a user/admin-saved layout preset
> (PHP `common::build_request_config` → `resolve_preset_properties`,
> `class.common.php:2986/3156`; store `class.request_config_presets.php`). An
> ACTIVE record in section **dd1244** (`dd1566 → dd64/1`) matching the
> `(tipo, section_tipo, mode)` triple — the caller's OWN preset (`dd654 = user`)
> first, then any PUBLIC one (`dd640 = yes`) — supplies a `request_config` array
> (component `dd625`) that is injected onto a CLONE of the section's properties,
> so the explicit builder parses it exactly as an ontology config. This narrows
> the section's rendered layout (edit-form tree / list columns) to the preset's
> `show.ddo_map`, carrying its per-ddo `properties`/`parent_grouper`/`width`/`view`
> overrides. TS home: `relations/request_config/presets.ts` (reader + per-user
> match, active-list cached and dropped by construction on any dd1244 write) and
> the injection at the `buildRequestConfigForElement` chokepoint (`build.ts`,
> section owners only). The match is computed LIVE from the request principal —
> never cached — so two users share the active list but resolve different
> presets. Gate: `test/parity/request_config_presets_differential.test.ts` +
> `test/unit/request_config_presets.test.ts`.

## 5. The resolution pipeline

### 5.1 Datalist — list-of-values models
select / radio_button / check_box need the **full records of the target section** as options. Built and cached by `component_common::get_list_of_values()` (`core/component_common/class.component_common.php:2740`, caches `:262-286`), attached as `->datalist` by `component_relation_common::get_filter_list_data()` (`:2404`). Edit payload shape (confirmed in `class.component_select.php:37`): `data: [{ value: <locator[]>, datalist: <option[]> }]`. Respect `fixed_filter`/`filter_by_list` when building the option set.

### 5.2 Subdatum — the recursive glue
`subdatum` expands a component's stored locators into resolved child structures + data through the ddo_map: output `{context, data}` (deduplicated child contexts + resolved rows). Base: `common::get_subdatum(?from_parent, ar_locators)` — `core/common/class.common.php:2254`, assembly `:2834-2836`. Dataframe variant `dataframe_common::build_dataframe_subdatum(value, mode)` — `trait.dataframe_common.php:395` — returns `{context, data, counter}`; gated on `properties->has_dataframe === true` and `mode !== 'search'`; when empty it fabricates a dummy locator at `counter+1` so the client still receives context for a blank frame row. `counter` is the main component's item-id allocator that mints new `id`/`id_key` values — it is part of the contract.

### 5.3 ddo_map depth
A ddo_map is a flat list made a tree by each ddo's `parent` (=`tipo` of the ddo it hangs under; `"self"` = the calling component). Relations to related sections carry further ddos resolved *in the target section*, to arbitrary depth, declaratively (`class.common.php:2295` get_children_recursive, `:2454` parent filter). Multi-hop chains (sort/search by a value two sections away) are normal, not edge cases.

> **ADDENDUM 2026-08-31 (the descendant map travels DOWN, and the recursion is
> BOUNDED).** Two rules the paragraph above implies but the engine did not
> hold:
>
> 1. **The whole map, every level.** `relation_core.expandPortal` recurses with
>    `options.descendantsMap`, and `relations/models/portal.ts` must hand it the
>    map it was itself given (`portalDescendants ?? ddoMap`) — the FULL flat
>    list, so a grandchild resolves by walking `parent`. Passing only the
>    portal's direct children silently drops every level below the first
>    whenever the children came from the CALLER's map instead of the
>    component's own `request_config`. That was live until 2026-08-31: the
>    `numisdata3` list chain `numisdata77 → numisdata164 → rsc29` lost its
>    `component_image` ddo, so the server shipped `rsc29` in `context` but no
>    `rsc29` item in `data` and every coin rendered the placeholder. The
>    `?? childDdos` fallback inside `expandPortal` is now a last resort for
>    callers that pass no map at all (`relation_index`'s deliberate one-level
>    expansions), never the normal path.
> 2. **The caller owns its map.** In list mode a caller-map child does NOT fall
>    back to its own `request_config` (`portal.ts` `ownConfig`, false for
>    caller-map children — PHP's substituted-config semantics). A map that
>    declares a nested portal but not its leaf therefore resolves the portal and
>    stops. In EDIT mode the corollary is a precedence: caller-map grandchildren
>    win over the nested portal's own config (`class.common.php:2603-2681`).
> 3. **"Arbitrary depth" is not unbounded.** The map is CLIENT-supplied and is a
>    flat list, so `[{A,parent:section},{B,parent:A},{A,parent:B}]` is a cycle,
>    and with the full map travelling down every hop with stored locators
>    re-enters the emitter one level deeper. `relation_core`'s `depth < 4` gates
>    the nested own-config lookup ONLY. The bound is `MAX_DDO_DEPTH` (12) in
>    `section/read.ts emitDdoData`, the one point every hop passes through:
>    exceeding it is a loud `request.invalid_rqo`, never a silent truncation.
>    Gate: `test/unit/portal_caller_map_descendants_native.test.ts`.
>
> **Superseded 2026-11-04 (rule 1's mechanism, rule 2, rule 3's `depth < 4` and
> its placement):** see the §1 addendum *Effective config per element*.
>
> - **Rule 1** — only its PRINCIPLE stands: every level is resolved from the
>   full flat map, so a grandchild resolves by walking `parent`. Its MECHANISM is
>   gone: there is no `options.descendantsMap`, no `portalDescendants ?? ddoMap`
>   and no `?? childDdos` fallback in `src/` any more. An element's children now
>   come from its NODE (`relations/element_node.ts`): the parent's
>   `effectiveConfig` is the map, and `collectCallerChildren`
>   (`request_config/caller_injection.ts`) hands each element the descendants
>   its caller declares for it, slot by slot. The relation_index exception is
>   narrowed, not gone: a `related_list` relation child with an EXPLICIT
>   request_config expands its own show in `related_list` mode (PHP
>   `component_relation_index_json.php` :190-206); a config-less (v5) child or a
>   literal stays a one-level `list` cell
>   (`WC-2026-11-04-nested-list-payload-growth`).
> - **Rule 2** — the caller owns the slots it fills, the element's own config
>   fills the rest in EVERY mode (PHP has no list gate).
> - **Rule 3** — the `depth < 4` own-config gate is gone. The bound is still
>   `MAX_DDO_DEPTH` (12), now DEFINED in `relations/element_node.ts`: a
>   CLIENT-sent map past it is still the loud `request.invalid_rqo` in
>   `section/read.ts emitDdoData`; an ONTOLOGY-driven chain past it is a soft
>   stop — the element renders its own item, its targets are not expanded, and
>   the response carries `relation.depth_bound_stopped`.

## 6. The particular cases — same concept, specific twist

### 6.1 List-of-values (select, radio_button, check_box, select_lang) + portal/autocomplete
Datalist (§5.1) + single/multi selection semantics. Portal adds pagination (total = full locator count), drag-reorder (`sort_data`), `sort_by_column`, `add_new_element` (creates a target record inheriting the caller's projects filter, then appends the link), and nested-portal recursion.

> **ADDENDUM 2026-07-31 (WC-081 — the SAVE echo of an inserting action).** The
> save response of a relation component is the client's next `self.data`, so
> the two INSERTING actions (`insert`, `add_new_element`) page it to the **last
> page** — `offset = limit * (ceil(total/limit) - 1)`, else 0 — because that is
> where the appended locator lives; the page size is the client's own
> `data->pagination->limit` when it sends one. `add_new_element` also reports
> `result->created_section_id`, the address of the record it created (absent on
> every other save). Both doors comply: `api/handlers/dd_core_api.ts` and the
> temporal one (`section/record/temporal.ts`). Before this the echo was page
> ONE at the component's config limit, and a client that treats "the last
> echoed entry" as the new record opened the FIRST one on any portal where
> `limit < total`. See `engineering/wire_contract/` WC-081; gate:
> `test/unit/save_add_new_element_page_native.test.ts`.
 Autocomplete is portal/select with a search-driven choose flow (`choose` ddo_map + `search` SQO); the `_hi` (hierarchical) flavor targets thesaurus hierarchies and needs the `relation_search` ancestor index (§2).

### 6.2 Dataframe — relation data paired to main-data items
A dataframe works like any relation — it points to target section(s) and stores locators — but each frame locator is **connected to one data item of the main component** via `id_key → id`, where the locator's `id_key` equals the `id` of the item in the main component's data. The main component can be **any** component — relation or literal (text, date, iri, …). Dataframes are an *extension of the main data*: they qualify a specific item (uncertainty, context, references, qualifiers) without polluting it.

Contract (never pair by array index):
- Match predicate: `(type, from_component_tipo, main_component_tipo, id_key)` — `trait.dataframe_common.php:82` `dataframe_entry_matches` (id_key compare `:101-103`); `component_dataframe::$test_equal_properties = ['type','section_id','section_tipo','from_component_tipo','id_key','main_component_tipo']` (`class.component_dataframe.php:82`).
- `component_dataframe extends component_portal` (`class.component_dataframe.php:61`) — it *is* a portal, plus pairing.
- Inline id_key value API (also used by relation sibling order, §6.3): `get_data_by_id_key` `:833`, `add_value_by_id_key` `:864` (sets item `id = id_key`), `remove_by_id_key` `:882` in `trait.dataframe_common.php`.
- Save path stamps the caller's `id_key` onto incoming frames (`trait.dataframe_common.php:205-213`). **Dataframe saves are a known gap in the current TS code — mandatory in the rebuild.**
- Legacy `section_id_key`/`section_tipo_key` are accepted on import only (`import_dataframe_data` `:544`, alias strip `:577`).

### 6.3 Children/parent — nested sections, hierarchy
Some sections are nested; the hierarchy chain is stored only upward. `component_relation_parent` stores the parent locators. `component_relation_children` **has no data of its own**: its save pipeline is a no-op (doc `class.component_relation_children.php:80-83`); writes go to each child's component_relation_parent; reads compute "who declares me as parent" — `get_data` `:113` → `get_children` `:132`, paginated `:167`. **Sibling order** is itself an `id_key` dataframe: an order `component_number` (named by `section_map->thesaurus->order`) attached to the child's parent-link locator — `sort_children` `:1033`, order component resolution `:1077`. The thesaurus tree (`core/ts_object/`) is a consumer of exactly this machinery.

> **TS addendum 2026-10-02 (`WC-2026-10-02-relation-children-write-through`).** The TS
> save is NOT a no-op: `relations/children_write.ts` (entered from `saveComponentData`)
> diff-syncs the requested list against the computed children and writes each affected
> child's component_relation_parent (+ its order value) through the normal
> `saveComponentData`, in one transaction under the host's node lock, every child
> authorized first; removal is by locator and drops every link targeting the host,
> whatever its type. The descriptor is `derived` (update_cache skips it, the CSV import
> refuses it). Gate: `test/unit/relation_children_write_through_native.test.ts`.

### 6.4 Indexation — inverse relations, "who calls me?"
`component_relation_index` stores nothing meaningful forward; it **calculates** its data by resolving inverse locators (backlinks) — every locator anywhere whose target is this record. Engine: `core/search/class.search_related.php:79`, which dispatches to four PostgreSQL flat-GIN stored functions (`data_relations_flat_st_si`, `_fct_st_si`, `_ty_st_si`, `_ty_st`; doc `:19-42`, DDL in `core/db/db_pg_definitions.php`); public entry `get_referenced_locators(filter_locators, limit, offset, count, target_section)` `:489` (SQO `mode='related'` + breakdown: one row per inverse locator, enriched with `from_section_tipo`/`from_section_id`). Model side: `class.component_relation_index.php` — `get_data` `:160` (cached `:797`), `get_data_paginated` `:205`, `count_data`/`count_data_group_by` `:298`/`:351`, `remove_locator` `:681`; default relation type dd96. Tag indexation (locators carrying `tag_id`/`tag_component_tipo` pointing into transcription text) rides the same inverse machinery and needs a real resolution path in TS.

### 6.5 External — mixed conditions / third-party sources
`component_external` (`class.component_external.php:54`, extends component_common) is a read-only proxy: `load_data_from_remote` `:110` reads `section_properties->api_config` (`api_url`, `response_map`, `entity` at `:166-169`); `set_data` refuses local writes `:449`. On the request_config side, an explicit-config item whose `api_engine !== 'dedalo'` routes through `resolve_external_config` (`trait.request_config_v6.php:210`/`:628`). More broadly, "external mode" components (e.g. hierarchy40 in the corpus, `source: {mode: "external"}`) obtain their data from a combination of other components/conditions resolved at runtime — the shared core must allow a model to supply its own data-acquisition strategy while keeping the same context/data/subdatum output contract.

### 6.6 relation_related — indirect resolution
Associative links with directionality (`type_rel`: uni/bi/multidirectional). For multidirectional relations the resolution is **transitive**: if a=b and b=c then c=a. `get_references_recursive` — `class.component_relation_related.php:274` (doc `:250-273`) computes the closure with a resolved-cache guarding against cycles; `get_data_with_references` `:114`, `get_calculated_references` `:152`, `get_type_rel` `:231`.

### 6.7 relation_model — the target is a function of the CALLER
**LANDED 2026-08-14.** Every other relation model names its target in its own node. `component_relation_model` cannot: `hierarchy27` ("Tipología") is ONE node, defined on `hierarchy20` and inherited by its 54 virtual sections, and the section it must offer differs per caller — `es1 → es2`, `fr1 → fr2`, `mht72 → ww2`. Its ontology therefore ships `sqo.section_tipo: []` plus an `_info` note admitting the value "is calculated in class". PHP's class override (v6 `class.component_relation_model.php:115-177`, consumed by `component_common::get_list_of_values` v6 `:2199-2208`) bypassed the sqo entirely and kept the answer in a private field, re-derived per consumer.

**The rule** — `getModelSectionForSection(sectionTipo)` (`src/core/ontology/model_section.ts`), candidates tried IN ORDER, first VALIDATED one wins (a failing candidate does not stop the walk):

1. **Registry pairing.** The registry record whose `hierarchy53` (target section) EQUALS `sectionTipo` yields its `hierarchy58` (target model section). Exact string equality, never a substring/search match — section tipos nest (`ich1` ⊂ `ich145`, `hierarchy1` ⊂ `hierarchy13`, `rsc2` ⊂ `rsc202`; all real sections on `dedalo_v7_mht`). No active-flag filter, lowest `section_id` wins on a duplicate (PHP `hierarchy::get_hierarchy_section` v6 `:679-713` `reset()`); `hierarchy53` is unique across all 264 rows on this install. An absent/empty `hierarchy58` falls through (live: `mht134`, `mht140`).
2. **`tld(sectionTipo) + '2'`** (`ontology/tld.ts`). Load-bearing, not a courtesy: 32 of the 57 sections hosting this model have no registry answer, `actv1 → actv2` among them.
3. **VALIDATE every candidate** — `getModelByTipo(candidate) === 'section'`, plus the refusal of a `hierarchy58` equal to its own row's `hierarchy53` (that would aim the option list at the TERMS section: `es1` = 69,148 records, and `getDatalist` reads every option record).
4. **None valid → `[]` + ONE `console.warn`** naming the component, the caller section and every rejected candidate with the model it resolved to (CONVENTIONS §1: degraded, reported, defined).

**TWO registries, DERIVED not hard-coded.** The registry family is every section whose `getSectionRealTipo` is `hierarchy1`: `hierarchy1` itself (thesauri, `matrix_hierarchy_main`, 264 rows) and `ontology35` (main ontologies — a VIRTUAL section of `hierarchy1`, so it carries the same `hierarchy60` components on `matrix_ontology_main`, 204 rows, ALL of them without `hierarchy58` today). A third registry section added later is read with no code edit. `explicit.ts`'s `resolveHierarchySectionsFromTypes` (`:266-308`) and `resolveOntologySections` (`:336-350`) are WHERE-clause variants of the same registry read; the terms→model column of it lives once, in `model_section.ts`.

**Applied at ONE seam.** `buildRequestConfigForElement` (`request_config/build.ts`) — not `buildExplicitRequestConfig`. `component_relation_model` is absent from `EXPLICIT_CONFIG_REQUIRED_MODELS` (`concepts/request_config.ts:73-77`), so a node with no `source.request_config` takes the IMPLICIT branch, whose relations walk picks the first section-model entry — for `hierarchy27` that is `hierarchy20`, the raw 69k-row template: plausible, silent and wrong. Only the wrapper sees both branches' result. It resolves the default ONCE, before either builder runs, and threads it in as `RequestConfigContext.modelDefaultTargets` — so `section_tipo: 'self'` in the show/search/choose/hide ddo maps resolves to the SAME targets (`hierarchy27` in `es1` emits "read `hierarchy25` on **es2**"); stamping the finished sqo instead would leave every `self` ddo pointing at the caller's own section. Precedence: a DECLARED `sqo.section_tipo` that resolved something wins; the IMPLICIT walk's pick does NOT count as a declaration and loses (it is the component's belongs-to link, not a target statement); and an EMPTY default is still the model's answer — the walk's pick is discarded rather than kept as a fallback, because a plausible wrong list is worse than an empty one with a logged reason. The result lands in the main item's `sqo.section_tipo`, so all consumers inherit it from one place (`datalist.ts:236`, `structure_context.ts:1009,1302`, `getElementTargetSectionTipos` → `import_conform.ts:821`/`section_elements_context.ts:258`/`relation_index.ts:84`, `ai/mcp/tools/discovery.ts:245`).

**Declarative, not a model branch.** The binding is the descriptor facet `targetSource: 'section_model'` (`components/types.ts` `TargetSourceId`), whose id→implementation map is `request_config/target_sources.ts` — NOT `relations/registry.ts`, where the forward edge would close the live SCC `registry.ts → models/select_family.ts → datalist.ts → request_config/explicit.ts` and red `import_scc_tripwire`. The same id is an sqo source in `KNOWN_SQO_SOURCES`, so an ontology node can request the rule explicitly: `{"source":"section_model"}` = the model twin of the caller's own section, `{"source":"section_model","value":["es1","fr1"]}` = the twins of those.

**Ships with the datalist cache key.** `getDatalist`'s key was `${componentTipo}_${lang}` — no owner section. Invisible while this model resolved `[]` everywhere; the moment the target became caller-dependent, the first caller's option list would be served to the rest, and picking one writes `{section_tipo:'es2'}` into an `fr1` record. The key is now `${componentTipo}_${ownerSectionTipo}_${lang}` at both the build and the `probeDatalistSize` sites (`relations/datalist.ts`). The same latent bleed existed for any `{source:'self'}` sqo.

**A model section targets ITSELF** — `es2`/`fr2`/`ww2` are also virtual sections of `hierarchy20`, so the component renders there and resolves to its own section (registry miss → `tld+'2'`). 27 of the 54 inheriting sections are this case: PHP-identical, cheap, and rejected on save by the auto-reference guard. Coherent, not a defect.

**`properties.target_mode` / `target_values` are RETIRED** — a second grammar for what `sqo.section_tipo` states for every other component. A node still carrying them gets ONE `console.error` per build naming the node and the exact replacement descriptor, then resolves by the ordinary rule (live: the playground `test169` only, until its ontology migration lands).

**Registry writer invariant (§1b of the plan).** `ontology/hierarchy_state.ts` used to REWRITE `hierarchy53`/`hierarchy58` to `${tld}1`/`${tld}2` on every Ensure — which would silently repoint the legitimate `mht72 → ww2` row at `ww1` the moment anything read the pairing. The invariant is now `hierarchy109`-shaped: DEFAULT when unset, NEVER overwrite a set value; a set-but-invalid value is a FAILED `targets` check in `inspectHierarchy`, never a silent repair.

**Four deliberate divergences from the frozen oracle**, each with its `engineering/wire_contract/` entry: `properties.target_mode`/`target_values` are no longer read (`WC-2026-08-14-target-mode-retired`); resolved targets now appear in `request_config[].sqo.section_tipo` where PHP emitted `[]` (`WC-2026-08-14-relation-model-target-in-sqo`); a non-section candidate is REFUSED where PHP forwarded it to a search — `ich145 → ich2` section_group, `hierarchy20 → hierarchy2` component_number, `mht134`/`mht140`/`mht160 → mht2` diffusion_element (`WC-2026-08-14-non-section-target-refused`); and the registry branch actually RUNS — the frozen v7 PHP always fell through to `tld+'2'` because `get_valor()` no longer exists and `common::__call`'s accessor bridge answers `false`, so following v6 is a knowing divergence from the frozen tree, adjudicable by no fixture since the only frozen datapoint (`cult1`) is a case where both paths agree (`WC-2026-08-14-model-section-registry-branch`).

Gates: `test/unit/model_section_native.test.ts`, `test/unit/datalist_cache_key_native.test.ts`, `test/unit/descriptor_completeness_tripwire.test.ts` (facet ↔ implementation pairing), the `hierarchy27` case in `test/parity/relation_corpus_config.test.ts` + the config-less twin that must NOT resolve `hierarchy20`, and the `hierarchy27` context assertion in `test/parity/section_context_extras_differential.test.ts`.

## 7. Verified real-world corpus (mandatory fixtures)

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

Every row below was resolved against the live ontology (`dd_ontology`, database `dedalo_mib_v7`) and is a **required differential-parity fixture** for the rebuild. Legacy model names appear as stored in the ontology; remember the §2 alias map.

Sections: numisdata3 = Type, numisdata4 = Numismatic object, numisdata6 = Mint, rsc167 = Audiovisual, rsc197 = People, cult1/tema1 = thesaurus sections (Cultura/Tema).

| Main → component | Model (ontology) | Label | request_config |
|---|---|---|---|
| numisdata4 → numisdata161 | component_autocomplete | Type | explicit; targets `["numisdata3"]`, `filter_by_list` numisdata3/numisdata309, show+search ddo_map, `$or` |
| numisdata4 → numisdata55 | component_relation_related | Equivalents | **legacy `source` object** (mode autocomplete, type_map numisdata147/151/159, hierarchy_sections) — the live implicit exercise |
| numisdata6 → numisdata20 | component_autocomplete_hi | Indexation | explicit; **dynamic targets** `hierarchy_types [1,2,8]`, show hierarchy25 with `value_with_parents` |
| numisdata6 → numisdata163 | component_portal | Bibliography | explicit; targets `["rsc332"]`; ddo_map + **dataframes numisdata1529/1530** |
| numisdata3 → numisdata77 | component_portal | Coins | explicit; targets `["numisdata4"]`, mosaic views |
| rsc167 → rsc860 | component_autocomplete_hi | Indexation | explicit; `hierarchy_types [1,2,4,5,6,8,11,12]`, show via section_map `get_ddo_map` |
| rsc197 → rsc1435 | component_portal | Family unit | explicit; targets `["rsc424"]`; father/children/other sub-portals |
| cult1/tema1 → hierarchy40 | component_relation_index | Indexations | `source: {mode: "external"}` — inverse/runtime resolution, no request_config |
| any thesaurus → hierarchy93 | component_autocomplete | Library | explicit; targets `["rsc205"]` |
| numisdata3 → numisdata34 | component_autocomplete | Denomination | explicit; targets `["object1"]` (NOT numisdata33, which is DEPRECATED) + dataframe numisdata1449 |
| numisdata3 → numisdata967 | component_radio_button | Status | **no source** — datalist from ontology relations → dd501; data_default section_id 1 |
| numisdata3 → numisdata71 | component_autocomplete | Reverse legend | **no source** — ontology relations → numisdata41/43/195 |
| numisdata3 → numisdata75 | component_portal | Bibliography | explicit; targets `["rsc332"]` + dataframes numisdata1531/1532 |
| numisdata3 → numisdata36 | component_relation_related | Equivalent terms | explicit; SQO with **no section_tipo** (self-targeting) + filter_by_list |
| numisdata3 → numisdata1006 | component_relation_related | Related types | explicit; same self-targeting shape as numisdata36 |
| numisdata3 → numisdata1562 | component_select | Category | **no source** — datalist from ontology relations → numisdata1554 |
| numisdata3 → numisdata159 | component_autocomplete_hi | Collection | explicit; **multi-section targets** `["rsc197","rsc106"]` + dataframe numisdata885 |
| numisdata3 → numisdata249 | component_portal | Authority | explicit; targets `["numisdata1374"]`, deep ddo_map reaching rsc1152/rsc106/rsc197 + dataframe numisdata813 |

Anchored records (all verified present in table `matrix` of `dedalo_mib_v7`):
- **numisdata3 §15657** (matrix id 453888) — has data for **both main components and their dataframes**; the canonical dataframe fixture.
- **numisdata3 §7** (matrix id 438258) — fixture for numisdata75 (portal + dataframe).
- **numisdata3 §14073** (matrix id 452309) — fixture for numisdata249 (deep portal + dataframe).

## 8. Gates (definition of done for the relation family)

1. **Corpus parity.** For every §7 row: resolved `context`, `data`, `subdatum`, datalist (where applicable), and search results diff clean against the live PHP server, in list and edit modes. Reuse/extend the existing `test/parity/` differential harness — the surviving tests (portal subdatum, drag replay, relation_list, iri/has_dataframe, multihop) remain green throughout.
2. **Dataframe round-trip on §15657.** Read → mutate a frame → save via TS → read via PHP (and the reverse): `id_key` pairing intact, `data::text` byte-compatible, counter semantics preserved.
3. **Both config strategies exercised.** explicit rows plus the implicit/no-source rows (numisdata55, numisdata967, numisdata71, numisdata1562) — deprecated is not optional.
4. **Inverse parity.** hierarchy40 indexations and a delete-with-inverse-references case match PHP, including counts and `count_data_group_by`.
5. **Locator law.** `compare_locators`/`in_array_locator`/`build_locator_lookup_key` as pure functions with exhaustive unit tests, including string/int `section_id` and the default-predicate field sets.
6. **Gap ledger closed or logged.** Every §1 defect either implemented (with a gate) or explicitly recorded as uncovered — never silently narrowed.
7. **Security unchanged.** `sanitize_client_ddo_map` whitelist, SQO sanitization, per-target ACL before search, projects-filter inheritance in `add_new_element` — all §7 chokepoints of the master spec hold for every relation path.
