# Rebuild the Dédalo area family in native TypeScript

Standing spec for the area family, companion to `engineering/REWRITE_SPEC.md` (whose constraints — §2 absolute constraints, §2b code style, §7 security — apply here unchanged), `engineering/RELATIONS_SPEC.md`, and `engineering/SECTION_SPEC.md` (areas contain sections; this spec does not re-open section internals). PHP reference tree: `v7/master_dedalo` (read-only). All `file:line` anchors below point into that tree and have been verified against it. Live-ontology corpus from `dedalo_mib_v7`.

Scope: **area, area_root, area_activity, area_publication, area_resource, area_tool, area_thesaurus, area_admin, area_development, area_ontology** (+ `area_common`, the PHP base they all extend, as the shared TS core). Out of scope, explicitly ledgered — never silently narrowed:

- **area_maintenance (dd88)** — already ported and differential-gated (widget catalog `resolve/widgets.ts`, execution `resolve/widget_request.ts`, `widgets_differential` + `widget_request_differential`). This rebuild only gives it a clean module boundary (§13 Phase A); its internals do not move semantically.
- **area_graph (dd630)** — **dead/deprecated, dropped from the rewrite by user decision (2026-07-03).** It stays in the PHP root-area walk behind an ontology guard (`class.area.php:250-258`); the TS canonical model list must NOT include it, and the menu differential must be re-pinned accordingly if the live menu ever emits it. **Done 2026-11-01** (WC-2026-11-01-menu-dead-area): the walk keeps its root slot, the menu `tree_datalist` does not emit it.
- **dd_ts_api / ts_object tree mutations** — the thesaurus/ontology *tree* subsystem (expand/move/add/order/locks) is a separate port; this spec covers only what the AREA serves (the boot payload and the search seed) and names the boundary (§5.5).

---

## 1. Mission & status

**An area is a non-data definition.** It is an ontology model that groups sections (the main data definitions) or other areas, and together the areas define the shape of the cultural-heritage organization (tangible, intangible, activities, resources, …). An area has a `tipo` but **no `section_id` and no matrix row** — `get_section_id()` is a `null` shim (`class.area_common.php:134`), `get_section_tipo()` returns its own tipo (`:117`), and `common::get_matrix_table_from_tipo()` returns null for `area*` models (`class.common.php:887-888`). Some areas are pure groupers (the plain `area` model — 71 live nodes); others are entities with behavior. The behavioral split (§2) is the whole spec.

The current TS implementation is judged **not done correctly** and is hereby superseded as a foundation. What exists is real and differential-gated, but:

- **The dashboard does not exist.** Every dashboard area (area_root, area_activity, area_publication, area_resource, area_admin, area_development, area_tool, plain `area`) must serve the statistics dashboard of the section data inside it — `area_common::get_dashboard_data()` (`class.area_common.php:367`) plus the `dd_core_api.get_activity_metric` action (`:662`). The vendored client actively renders `data.dashboard` (`client/dedalo/core/area/js/render_area.js:181-185`) and fires the range-switch call (`area_common/js/dashboard.js:1789-1801`). **TS implements neither**: an area read falls past three special-case branches in `dispatch.ts:89-122` into the section gates and never emits a dashboard; the action table has no `get_activity_metric`. Every non-tree, non-maintenance area page renders blank today. STATUS.md never ledgered this — its "31 dashboard widgets ✅" line is the *maintenance-widget* subsystem, an unrelated framework. This is the honesty gap that triggered the rebuild.
- **No area module.** There is no `src/core/area/` and no `concepts/area.ts`. Area logic is inline branches in the 1088-line `dispatch.ts` (`:89-122` tree/maintenance reads, `:750-758` element contexts) and model-sniffing `startsWith('area')` in `structure_context.ts` (`:86` elementTypeOf, `:253` lang exception, `:293` tools) — the same structural defect RELATIONS_SPEC §1 and SECTION_SPEC §1 named for their families.
- **No canonical model list.** `menu.ts:69-80` `ROOT_AREA_MODELS` includes `area_graph` but not `area_publication`; the test corpus (`areas_differential.test.ts:26-37`) lists 12 including both. Nothing owns "what is an area model".
- **area_ontology gate divergence.** `dispatch.ts:95-96` admits any global admin or any dd774 self-keyed profile. The mandated rule is **superuser, or global admin AND dd5 profile grant** (§9, 2026-10-07; superuser-only 2026-07-03 → 2026-10-07) — and PHP itself has NO hard gate here (verified §9), so this is a deliberate TS strengthening, not a parity bug.
- **Cache hygiene.** `area_hierarchy.ts:47` `childrenTipoCache` and the structure-context `labelCache` are unbounded module-level caches with no clear hook — safe from cross-user bleed (ontology-derived, request-invariant) but stale after an ontology import; they must register with the maintenance cache-clear path (`clear_cache_files`) or be dropped.
- **Fixture drift.** `area_hierarchy_differential.test.ts:18` drives area_ontology with tipo `dd917` — a `field_text`, not the area node (`dd5`). Live PHP accepted it, proving the model-vs-tipo dispatch quirk (§9). `areas_differential.test.ts:32` correctly uses `dd5`.

**Salvage (proven — keep, do not rewrite blind):** `area_hierarchy.ts` semantics (byte-parity-gated boot data for both tree areas — relocate + de-hardcode, don't re-derive), the `menu.ts` walk (order, deny/skip re-parenting, section_tool + hierarchy56/57 thesaurus-virtual rewrites, all differential-gated), `getAuthorizedAreaTipos` + the dd88/dd770 role gates (`permissions.ts:164-174,:200-202`, gated by `menu_nonadmin.test.ts`), the runtime `config_areas`/`menu_skip_tipos` panels, and the entire maintenance widget subsystem. The differential suite is the validation harness: it must stay green throughout with **zero fixture/normalization changes** (the relations Phase A rule) — except the dd917 fixture, whose correction is itself a gated deliverable (§9).

Keep a coverage ledger of what the rebuild does not yet cover.

## 2. The unifying model — one base, four behaviors

PHP class tree (verified): `common` → `area_common` → { `area`, `area_root`, `area_admin`, `area_activity`, `area_resource`, `area_tool`, `area_publication`, `area_development`, `area_thesaurus` } ; `area_thesaurus` → `area_ontology`. **All seven "no special behavior" areas are verified EMPTY class bodies** with no own `_json.php` (`class.area_root.php:47-51`, `class.area_admin.php:27-31`, `class.area_activity.php:50-53`, `class.area_resource.php:47-50`, `class.area_tool.php:37-40`, `class.area_publication.php:42-46`, `class.area_development.php:26-29`) — all fall through `area_common::get_json()` to the generic dashboard controller. Behavior partitions as:

| Behavior | Models | What it serves |
|---|---|---|
| **Pure grouper** | `area` (71 live nodes) | Menu structure + its own dashboard of the sections inside (`area_json.php` is functionally identical to the common controller) |
| **Dashboard** | area_root, area_activity, area_publication, area_resource, area_admin, area_development, area_tool | The statistics dashboard (§4) via `area_common_json.php` |
| **Tree** | area_thesaurus, area_ontology (extends thesaurus) | The ts_object hierarchy boot payload + thesaurus search (§5) |
| **Maintenance** | area_maintenance | Widget dashboard — done, boundary only |

`area_tool` additionally *contains* `section_tool` nodes (§6), but the class itself is a pure stub — the section_tool magic happens in dd_core_api/menu, not in the area.

- **Registry & constants**: area tipo constants live in `core/base/dd_tipos.php` — `DEDALO_AREA_ROOT_TIPO='dd242'` (`:43`), `DEDALO_AREA_MAINTENANCE_TIPO='dd88'` (`:44`), `DEDALO_AREA_DEVELOPMENT_TIPO='dd770'` (`:45`); every other area is resolved by model name (`ontology_utils::get_ar_tipo_by_model`). Live tipos: dd242 root, dd207 admin, dd69 activity, dd222 publication, dd14 resource, dd35 tool, dd100 thesaurus, dd5 ontology, dd770 development (all parented at dd1; dd88 under dd207).
- **The child-walk model filter** (`class.area.php`): include `['area','section','section_tool']` (`:35`), exclude `['login','tools','section_list','filter']` (`:46` — the property name's `modelo` typo is deliberate and documented `:43-44`); double filter enforced at `:210-212`. This is why `section_list` and `filter` never surface as navigable children.
- **Root order**: `get_ar_root_area_tipos()` (`:240`) is a FIXED model order — root, activity, resource, tool, thesaurus, (graph — excluded), admin, maintenance (guarded, dd88 fallback `:262-275`), development, ontology. Menu order is implicit ontology pre-order from `area::get_areas()` (`:103` — flat ordered list of `{tipo, model, parent, properties, label}`); **there is NO order_number field** in the menu payload.
- **Deny/allow**: `get_config_areas()` (`:380`) reads catalog keys `areas.deny`/`areas.allow` (`:396-397`) — v7 no longer reads `config_areas.php`. TS already mirrors this with runtime `ts_state.json` overrides (gated); the rebuild routes it through the area module.

In TS: `src/core/area/` (registry + per-behavior resolvers) with a `concepts/area.ts` contract module owning the ONE canonical model list, the behavior taxonomy, and the walk-filter sets. Kill every `startsWith('area')` in favor of the contract's `isAreaModel()`/`areaBehaviorOf()`.

## 3. area_common — the base (`core/area_common/class.area_common.php`)

- `get_instance(model, tipo, mode='list')` `:68` — `new $model($tipo, $mode)`, not a singleton (`:70-72`). Ctor is **protected** `:94`: set tipo/mode/`lang=DEDALO_DATA_LANG`, then `load_structure_data()` (`:97-102`).
- `get_json(?request_options)` `:165` — the controller dispatch: if `core/<model>/<model>_json.php` exists → `parent::get_json()` (`:168-173`); else `$options{get_context:true, get_data:true, get_request_config:false}` and include `area_common_json.php` (`:177-185`); exception → empty `build_element_json_output([],[])` (`:193`). Concrete `_json.php` exist only for: area (identical), area_thesaurus, area_ontology (a one-line delegate to thesaurus), area_maintenance, area_graph (excluded).
- `get_dashboard_child_sections()` `:225` — the recursive walk that defines "the sections inside": accept `['section']` (`:229`), descend `['area','section']` (`:230`), exclude `['login','tools','section_list','filter','section_tool']` (`:231`), visited-set cycle guard (`:235-238`), order-preserving dedup (`:264`). Untabled sections are NOT filtered here — the metric layer does that (`:221`).
- Duck-type shims `:117`/`:134` (§1) — areas pass through section-shaped code paths without a row identity.

## 4. The dashboard engine — the top rebuild item

The dashboard is what every grouper/dashboard area serves: **statistics of the section data inside the area.**

### 4.1 Server contract (`class.area_common.php`)
- **`get_dashboard_data(?ar_metric_names)` `:367`** — default metrics `['total']` (`:369`). Per child section (from §3's walk): item `{section_tipo, label, model, color}` (`:380-384`) + one field per metric name, discovered by the **`metric_<name>(section_tipo)` method contract** via `method_exists` + dynamic dispatch (`:387-391`). Envelope (`:397-406`): `{area_tipo, area_label, generated_at, metrics, sections}` + always `activity_30d = metric_activity_30d(30)`. Then each section gains a **`recent_7d`** badge derived from the last 7 days of activity_30d (`:411-429`).
- **`metric_total`** `:451` → `count_section_records()` `:288`: returns **null** when `get_permissions(tipo,tipo) < 1` (`:291-294`) or the section is untabled (`:297-300`); else an SQO count — `section_tipo=[tipo], limit 0, full_count` (`:303-306`) → `(int)(result->total ?? 0)`. The permission gate is per-section and per-caller — **the dashboard is an ACL surface**, not just decoration.
- **`metric_activity_30d(range_days=30)`** `:504` — null when no child sections (`:506-509`). Direct parameterized SQL on `matrix_activity` (`:527-540`): per-day `date_trunc('day')`, user from `relation->'dd543'->0->>'section_id'`, where-tipo from `string->'dd546'->0->>'value'` (who/where tipos from `logger_backend_activity::$_COMPONENT_WHO/WHERE` — dd543 portal `:96-97`, dd546 input_text `:116`), bounded `[DEDALO_ACTIVITY_SECTION_TIPO, date_from, date_to)`. Legacy JSON-array `where` decode (`:563-568`). Return (`:629-635`): `{date_from, date_to, days:[{date, by_section:{tipo:count}, by_user:{uid:count}}], users:[{id,label}], available_ranges:[{key,label,days}]}` — ranges 1m/30 3m/90 6m/180 1y/365 (`:622-627`), **empty days filled** for a continuous chart (`:610-619`), user labels via `login::logged_user_username` fallback `"User #N"` (`:600-604`).
- **`get_activity_metric(area_tipo, range_days)` static `:662`** — the API entry: resolve model by tipo, `area_common::get_instance`, `method_exists` guard, delegate (`:669-684`). **This is a `dd_core_api` ACTION the TS dispatcher must add.** Client envelope (`dashboard.js:1789-1801`): request `{action:'get_activity_metric', dd_api:'dd_core_api', options:{area_tipo, range_days}}` → response `result===true` + **top-level `data`** in the activity_30d shape — a different envelope from the `{context,data}` read; do not force it into the read shape.
- **`get_dashboard_color(tipo)` static `:711`** — deterministic `#rrggbb` from `crc32(tipo)` hue, sat 65 / light 52, HSL→RGB. Byte-parity requires a faithful crc32 (PHP crc32 = CRC-32/PHP signed→unsigned semantics — unit-test against PHP outputs for the corpus tipos).

### 4.2 Controller (`core/area_common/area_common_json.php`)
Context (`:83-97`): `from_parent = tipo` (`:89`), one `get_structure_context(permissions, add_rqo=true)` entry. Data (`:106-145`), only when `permissions > 0`: reads `properties->dashboard->disabled` (bool) and `->metrics` (string[]) (`:119-126`); item `{tipo, section_tipo(=tipo), section_id(=null)}` (`:132-135`); when not disabled, `item->dashboard = get_dashboard_data(metrics)` (`:141-143`). Return `{context:[…], data:[…]}` (`:154`). `core/area/area_json.php` is functionally identical (`:85-113`).

### 4.3 Client consumption (the parity target's observable half)
`build_dashboard` (`client/dedalo/core/area_common/js/dashboard.js:92`) consumes: `sections[]` (required Array `:97`) with `{section_tipo, label, total, recent_7d, model(→'section' default), color(→fallback)}`; `area_label || area_tipo` header; optional `activity_30d` `{days, users, available_ranges}`. **`metrics` and `generated_at` are declared but never consumed** (`:49-50`) — ship them anyway (byte-parity + future use). Missing `data.dashboard` → silently empty content (`render_area.js:181-185`). Card click navigates `{tipo: section_tipo, model: model||'section', mode:'list'}` (`dashboard.js:690-696`).

### 4.4 TS design notes
Per-section metric computation is independent → resolve with `Promise.all` (REWRITE_SPEC §4 concurrency win; PHP loops sequentially — this is a headline latency delta), preserving the per-section permission gate and the child-walk ORDER in the emitted array. The activity SQL is one query regardless of range — keep it single. All identifiers through the §7.6 chokepoint; dates as bound params.

## 5. The tree areas — area_thesaurus & area_ontology

**area_thesaurus** groups the hierarchy sections (regular sections whose records link via parent/children relations) and represents them as a tree via ts_object. **area_ontology** does the same over the *editable ontology* sections (the main definitions — NOT the active parsed ontology in `dd_ontology`). `class area_ontology extends area_thesaurus` with exactly two overrides: `get_hierarchy_section_tipo()` → `'ontology35'` (`class.area_ontology.php:63`) and `get_main_table()` → `matrix_ontology_main` (`:84`); `area_ontology_json.php:55` is a one-line include of the thesaurus controller.

### 5.1 Controller flow (`core/area_thesaurus/area_thesaurus_json.php`, shared)
- **Context** (`:85-114`): `get_structure_context(permissions, true)`, then **`current_context->section_tipo` is OVERWRITTEN to the area tipo** (`:103`) — search presets are namespaced per area, not per hierarchy section — and `current_context->thesaurus_mode = properties->thesaurus_mode ?? 'default'` (`:109`).
- **Data** (`:121-248`): read `properties->hierarchy_types` / `->hierarchy_sections` filters (`:125-126`), `terms_are_model = build_options->terms_are_model ?? false` (`:132`), then `get_hierarchy_sections(...)` (§5.2) and per-hierarchy filtering (§5.3). Typologies dedup by `typology_section_id` (`:226-239`) → `{section_id, type:'typology', label, order}`. Data item: **`{tipo, value: hierarchy_section[], typologies: typology[]}`** (`:245-248`).
- **ts_search** (`:256-272`): when `properties->hierarchy_terms` is set → `get_hierarchy_terms_sqo()` + `search_thesaurus()`; when `properties->action==='search'` → `search_thesaurus(properties->sqo)`. Attached as `item->ts_search`.

### 5.2 Element source (`class.area_thesaurus.php:197` `get_hierarchy_sections`)
Dispatch: called class `area_thesaurus` → `hierarchy::get_active_elements()` (`core/hierarchy/class.hierarchy.php:1809` — cached SQO over `hierarchy1` filtered `hierarchy4=1`); else `ontology::get_active_elements()` (`core/ontology/class.ontology.php:1615` — same over `ontology35`; element shape doc `:1685-1698`). Per element (`:269-279`): `{section_id, section_tipo, target_section_tipo, target_section_name, children_tipo, typology_section_id, order, type:'hierarchy', active_in_thesaurus, root_terms}`.
- **children_tipo law** (`:261-263`): ontology → fixed `ontology::$children_tipo = 'ontology14'` (`class.ontology.php:111`); thesaurus → dynamic `section::get_ar_children_tipo_by_model_name_in_section(target, ['component_relation_children'], …)[0] ?? null` (virtual-aware).
- **typology_section_id** (`:275`): ontology pinned `'14'`; thesaurus from the element. Typology metadata: section `hierarchy13`, name `hierarchy16` (`:47,:54`; name/order caches `:80-94`, resolvers `:345,:415,:464`).
- root_terms via `<class>::get_root_terms(section_tipo, section_id, terms_are_model)` (`:250`).

### 5.3 Per-hierarchy filtering (`area_thesaurus_json.php:141-219`) — the ACL surface
In order: **ontology + global-admin → add unconditionally** (`:147-150` — the PHP bypass; TS drops it (§9, 2026-10-07): an ontology hierarchy is kept iff the principal holds read on its TLD section, and keeps the inactive/rootless bypasses below); skip when `get_permissions(target_section_tipo) < 1` (`:155-160`); skip inactive (`:167-169` — **bypassed for ontology** `:212`, which keeps inactive entries); skip missing children_tipo (`:176-183`); **prune root_terms lacking read permission** (`:189-198`); skip when no authorized root terms remain (`:203-210` — bypassed for ontology `:251`, which keeps rootless entries); clone before mutating (`:216-218`). **The client never re-checks any of this** (`active_in_thesaurus` is unreferenced in client JS; `render_area_thesaurus.js:356` assumes server pruning) — server-side pruning IS the contract.

### 5.4 Thesaurus search (`class.area_thesaurus.php`)
`search_thesaurus(sqo)` `:551` — run the SQO, then walk each hit's ancestor chain via `component_relation_parent::get_parents_recursive` (memoized `:587-592`), building a **flat ts_object map keyed `'section_tipo:section_id'`** (`:570`) of hit + sibling + ancestor nodes (`:619-713`). Return `{result: ts_object_data[], msg, errors, total, found:[{section_tipo,section_id}]}` (`:716-724`). `get_hierarchy_terms_sqo(hierarchy_terms)` `:764` — OR-of-AND filter over path `hierarchy22`/`component_section_id` (`:779-787`), sqo id `'thesaurus'`, limit 100 (`:826-830`). The client hands `ts_search.result/found` to `ts_object.parse_search_result` (`render_area_thesaurus.js:137-155`) and totals from `found.length` (`area_thesaurus.js:806-818`).

### 5.5 RQO source add-ons & the dd_ts_api boundary
The client folds into `rqo.source`, in `area_thesaurus.generate_rqo` (awaited BEFORE `build_autoload`, so it rides the one read a boot page performs): `build_options:{terms_are_model}` (model view), `source.caller` when the area was opened as a picker (§5.7), plus `sqo.limit ?? 30`. Ontology deep-link: URL `search_tipos` → `sqo.filter` over `ontology7`(tld)/`ontology2`(id), `sqo.section_tipo = tlds.map(tld+'0')`, `source.search_action='search'`.

**`hierarchy_sections` / `hierarchy_terms` / `thesaurus_mode` are NOT a client channel** (2026-08-14, `engineering/wire_contract/WC-2026-08-14-thesaurus-picker-caller-declared.md`). The retired engine let the client declare all three as URL variables and filtered on them; this engine DERIVES every one of them and reads none of them from a request. The post-response fold that still writes them onto the follow-up rqo of a refresh/search read is the server's own answers travelling back to it, never a declaration — a client-declared mode would open relation mode over any thesaurus with no caller that ever declared `view:'tree'`, which is the objection `src/core/area/read.ts` already makes about `source.model`. Gate: `test/unit/thesaurus_picker_tripwire.test.ts` (the mode's writers are a census; nobody mints a mode literal client-side).

**The ONE request-declared input: `source.properties.hierarchy_types`** (2026-10-29, `engineering/wire_contract/WC-2026-10-29-area-declared-hierarchy-types.md`). A tool `ddo_map` entry for `dd100` may declare typology ids (the cataloguing tool: `[8]`); `area_thesaurus` then loads only the hierarchies of those typologies — the others are dropped before projection and never reach the payload. It is narrowing-only (cannot add a hierarchy, grant a mode or skip the ACL loop), which is why it is admitted where the three fields above are not. Empty list = no narrowing (PHP `!empty()` rule); ignored by `area_ontology`. Gate: `test/unit/area_typology_filter_native.test.ts`.

**Everything after boot — node expand (`get_children_data`), move (`save_parent`), add (`add_child`), order (`save_order`) — goes to `dd_ts_api`** (`ts_object.js:521,:634,:1183,:1407,:2651`); the tree *search* uses the generic read API (`:1059-1060`). The area rebuild stops at the boot payload + ts_search; ledger the rest against the ts_object port.

### 5.6 TS status & rebuild orders
`readAreaHierarchyData` (`src/core/area/tree.ts`) is byte-parity-gated for BOTH areas (37 thesaurus + 80 ontology entries, `area_hierarchy_differential.test.ts`). It re-derives the projection with direct SQL rather than the engine's own search path — acceptable, pinned. Remaining relocation work: lift the hardcoded tipos (`hierarchy4/5/9/45/48/53/125`, `hierarchy13/16/106`, `ontology35/14`, `'14'`, `dd64`) into the contract module with names, give `childrenTipoCache` a clear hook.

**Ledgered-uncovered to close in Phase C**: per-hierarchy/root-term permission pruning (the current harness runs admin — the non-admin differential is mandatory), `ts_search` (both trigger paths), `terms_are_model` variants, the ontology `search_tipos` deep-link, the context `section_tipo` overwrite.

**CLOSED 2026-08-14 — the `thesaurus_mode` variants and the mode stamp.** They are no longer an uncovered variant of the area property: the mode is DERIVED per read (§5.7), so the two values are two distinct code paths with their own gates. `test/unit/area_picker_mode_native.test.ts` covers the grant (all three conditions, and each one alone denying), the `relation`-mode emissions and the two refusal codes; `test/unit/thesaurus_picker_tripwire.test.ts` covers the single derivation site and the absence of any client mint; the four frozen differentials (`area_hierarchy`, `areas`, `area_security`, `ts_search`) pin the `default`-mode shape byte-for-byte. Wire: `WC-2026-08-14-thesaurus-picker-caller-declared`.

### 5.7 The TERM PICKER — one contract, defined here (2026-08-14)

A relation component whose ontology declares `properties.view: "tree"` opens its target
thesaurus as a **picker**: the same tree read, rendering a link affordance per term instead
of navigating. It is a capability of the RELATION family served by the AREA read, so the
contract lives here and the component docs link to it — never restate it. Wire ledger:
`WC-2026-08-14-thesaurus-picker-caller-declared` (the read),
`WC-2026-08-14-relation-insert-target-validation` and
`WC-2026-08-14-relation-insert-accepts-batch` (the write).

**1. The request declares a CALLER; the server derives everything else.**
`rqo.source.caller = {section_tipo, section_id, tipo}` (the `section_id` may be the
URL-shaped string; the server canonicalizes it). A present-but-malformed caller, a caller
naming an element the ontology does not define, and a caller whose section holds no records
each get their own named 400 — the four message constants live in `src/core/concepts/area.ts`
so engine and gate cannot disagree about them. An ABSENT caller is an ordinary browse read,
byte-unchanged. Nothing else about the picker travels in the request: a client conclusion
(`thesaurus_mode`, a target list) would be authority the client does not have (§5.5).

**2. The mode is GRANTED, on three conditions, all server-resolved.** Relation mode requires
the caller's resolved `context.view === 'tree'` (a `ddo_map`-injected view counts — it is the
resolved view, not the node property), a model that stores in the relation column, and
edit (`>= 2`) on the caller granted by the principal's PROFILE or the superuser
(`getPermissionGrant`, basis `'profile'`/`'superuser'`). A RULE-basis level is refused: the
dd655 editing-preset rule answers 2 for every tipo under dd655 and every principal, bounded
only by the preset assembler's owner predicate, and that bound does not travel into a
thesaurus read (the read floor's law — `src/core/security/read_floor.ts`; gate
`area_picker_mode_native`, "a RULE-granted EDIT is not a picker grant"). Otherwise the read
proceeds in `'default'` mode:
the intent is simply not granted. On a caller-declared read the AREA NODE's own
`properties.thesaurus_mode` no longer decides anything — it is the install default for
ordinary browse reads and must not be able to hand a picker request a mode the caller did
not earn.

**3. ONE resolver answers "what may this caller link", for both paths.**
`src/core/relations/picker_constraint.ts` derives `{selection_limit, remaining, targets}`:

- `selection_limit` = the caller's `properties.data_limit`. ABSENT → `null` = uncapped; a
  literal `0` is a real answer ("none may be linked") and is honoured as such.
- `remaining` = `selection_limit − (locators the caller already holds)`. **This, never the
  raw limit, is what a picker session may add**, and it is deliberately not clamped at 0 —
  "over capacity by 2" is information an operator needs.
- `targets` = the caller's resolved sqo sections, kept as DECLARED — deliberately NOT
  collapsed through `getSectionRealTipo`. Every thesaurus is a virtual section over the
  same real node (`es1`, `ad1`, `fr1` … all resolve to `hierarchy20`), so real-resolving
  the declared side would make a caller naming ONE thesaurus indistinguishable from one
  naming all ~150 — the constraint would stop constraining. The virtual/real
  reconciliation happens in the COMPARISON (`isTargetAllowed`), asymmetrically: a declared
  target matches when it equals the incoming section, or when EITHER side is the other's
  real section, never real-vs-real;
  the comparison law (`isTargetAllowed`) resolves BOTH sides, so a virtual target matches a
  hierarchy whose target is the real section and vice versa.

The READ calls it for the affordances; the WRITE calls it again before it persists. Two call
sites, one answer — which is what makes a rendered affordance stop being an authorization
and a forged client cap stop mattering.

The WRITE side (`relations/save.ts refuseByPickerConstraint`, on every NET-NEW locator —
a locator the component already holds is re-persisted untouched, `storedItems`) runs four
gates: TARGET (`isTargetAllowed`, every caller); READ GRANT on the linked section
(**tree-picker callers only** — the write twin of §7's pruning; a non-picker caller is
authorized by the CALLER grant dispatch enforced, the read-side `inheritSubdatumPermission`
model — and **fail-closed**: no principal ⇒ refused, never exempted); SELECTABILITY
(tree-picker callers whose target declares `is_indexable`); the CAP (`data_limit`, counted
in the cap scope — per main item for a frame — on BOTH the held and the resulting side).
A refusal reaching a save is THROWN — `relation.insert_refused` (400) or, for the read
grant, the generic `perm.denied` (403) — never a silent ok. Wire:
`WC-2026-08-14-relation-insert-target-validation` (+ its 2026-08-16 addendum).

**4. What the request_config does and does NOT constrain.** The `sqo` names the target
section(s) and nothing more. The tree's CONTENTS are the thesaurus's; it is not paged
(`sqo_config.limit` is the autocomplete's dropdown size, a different surface); its nodes are
rendered by `ts_object`, not by the caller's `ddo_map` (which governs how a LINKED value is
displayed back in the caller). The only count field that binds a picker is `data_limit`.

**5. Selectability is the TERM's own answer.** `isIndexable` (`src/core/ts_object/`) is the
relation-mode rule and always was: `hierarchy*`/`ontology*` tipos are structural and never
selectable; otherwise the section's `section_map.thesaurus.is_indexable` names a component
tipo whose value on the TERM's own record decides. So a curator marks, term by term, inside
the thesaurus, what may be linked. A non-selectable term stays **visible and navigable** —
they are the levels one passes through to reach a leaf — and simply carries no link
affordance: never hidden, never a dead click.

**6. Emissions, relation mode only.** `context[0].thesaurus_mode = 'relation'`,
`context[0].picker = {selection_limit, remaining, targets}` (the constraint verbatim), and
per hierarchy item `root_terms_selectable: [{section_tipo, section_id, selectable}]`,
addressed by locator rather than by position. Default mode emits none of them, which is what
keeps the frozen differentials byte-identical.

**7. The two empty trees are two different facts.** Every candidate dropped by a permission
check → a thrown `perm.denied` (403) with the GENERIC registry message, naming no section
(the code's disclosure is `operator`, so a site's sentence never reaches the wire). Dropped by the data-driven skips (no
active hierarchy, or none of them among the caller's targets) → `409 read: no active
hierarchy is configured for this component target`, which the client renders as "this picker
has no thesaurus" rather than as a permission error. The two causes are counted separately at
each drop site and never inferred from an empty result.

**8. The client is a renderer.** One module publishes the pick (`link_terms_<linker_id>`, an
ARRAY, one per pick — picking is ONE STEP), one module writes the mode onto the context, one writer
composes a portal's toolbar per view, and the relation `type` is the server's to fill.
Enforced by `test/unit/thesaurus_picker_tripwire.test.ts`.

## 6. area_tool & section_tool — a tool's face on a section's data

`area_tool` (dd35) groups **section_tool** nodes: pointers that open a specific SECTION pre-loaded with a specific TOOL — a purpose-built interface over one section's data (e.g. interview transcription: audiovisual section rsc167, av component rsc35 + transcription component rsc36, driven by tool_transcription).

- **section_tool has NO PHP class and NO directory** — it is a pure ontology model string, handled as a rewrite at two sites:
  - **Page context** (`class.dd_core_api.php:388-428`, `case model==='section_tool'`): load the node's `properties` (`:392-393`); **overwrite** `model='section'`, `tipo = properties->config->target_section_tipo ?? tipo`, `config = properties->config` (`:395-398`); resolve the tool — `tool_name = array_key_first(properties->tool_config)` (`:401-403`), validate via `tool_common::get_user_tools(logged_user_id())` (`:406`), `config->tool_context = tool_common::create_tool_simple_context(tool_info, properties->tool_config->{tool_name})` (`:420-422`); then **non-break fall-through** into the section case (`:425-428`) so the real section loads carrying the injected `tool_context`.
  - **Menu** (`class.menu.php:216-258`): same rewrite on the datalist item; the entry is **dropped** (`continue 2`) when the user lacks the tool (`:231-242`).
- **Naming**: source = `properties.tool_config` (single key = tool name) + `properties.config.target_section_tipo`; produced = `config.tool_context`. Don't conflate.
- **Client contract**: menu forwards `config` verbatim (`render_menu_tree.js:540-548`); the page uses `config.source_section_tipo` as `id_variant` (`page.js:1259-1267`); the section instance detects `config.source_model==='section_tool'` (`section.js:547`), takes label/css from `config.tool_context` (`:470-471,:1236-1243`), and gates the open-tool button on permissions > 1 (`render_list_section.js:433-468`).
> **ADDENDUM 2026-08-31 (P3-2 / GATE-47).** The exemplars below are RECORDED
> OBSERVATIONS from one install, not fixtures to pin: `generic_tld_tripwire`
> refuses a gate naming `oh*`/`numisdata*`/`rsc*`, and the differential they
> were written for is retired with the live oracle. Build the situation on a
> `test` TLD through `src/core/test_data/`.

- **Live exemplars** (observed, not pinned): `oh81` under grouper `oh80` — `config:{source_model:'section_tool', source_section_tipo:'oh81', target_section_tipo:'rsc167'}`, `tool_config.tool_transcription.ddo_map` with roles `media_component`→rsc35 / `transcription_component`→rsc36 (section_id 'self'); siblings oh83/oh85/oh98; plus `numisdata201/625/670` under grouper `numisdata200` (dd35 subtree).
- **TS status**: the MENU rewrite is done and gated (`menu.ts:276-286,:331-382`, incl. the drop-if-unauthorized ledger). The PAGE-CONTEXT reroute **landed 2026-07-10** in the `start` handler (dd_core_api.ts) — on a direct URL the client fires ONLY `start` (`page.js:513-527`); PHP's `get_element_context` has NO section_tool branch (default `new $model()` fatals), so `start` is the one reroute site. Shared enrichment: `tools/section_tool_context.ts` (also used by the menu rewrite). Gate: `section_tool_start_differential` (config byte-pin oh81 + numisdata201/670; result:false pin for config-less numisdata625). `area_tool` itself is a dashboard area (§4) whose child walk *excludes* section_tool from the stats (`class.area_common.php:231`) — its dashboard shows the plain sections in its subtree, and the section_tool entries surface via the menu.

## 7. Menu & placement

Already ported and differential-gated (`menu_differential`, `menu_nonadmin`) — this section pins the law so the rebuild relocates without drift:

- Walk = `area::get_areas()` order (`class.menu.php:124`); global-admin+developer path unfiltered (`:127-133` — deliberately, so development stays hidden from an admin who is not a developer); everyone else filtered by `security::get_ar_authorized_areas_for_user()` (`:138,:157-162`).
- **Hard gates**: dd88 skipped unless global-admin OR developer (`:147-150`; security twin `class.security.php:259-265`); dd770 skipped unless developer (`:152-155`). TS adds the dd5 gate (§9: superuser, or global admin AND dd5 grant).
- **Skip-tipos** re-parenting (`DEDALO_ENTITY_MENU_SKIP_TIPOS(_CUSTOM)`, `:180-201,:334-349`); items `{tipo, model, parent, label}` (`:205-210`).
- **Rewrites** (`:214-294`): section_tool (§6); `DEDALO_THESAURUS_VIRTUALS_AREA_TIPO` → model `area_thesaurus` + `config.swap_tipo=dd100` (`:260-272`); `..._VIRTUALS_MODELS_AREA_TIPO` → + `thesaurus_view_mode:'model'` (`:274-289`).
- Client nav: `user_navigation` with `source:{tipo, model, mode:'list', config}` (`render_menu_tree.js:540-548`), `swap_tipo` applied client-side pre-publish (`:519-521`). Anti-lockout: the TS config panels already guard area_root/area_maintenance/area_admin out of the deny list — keep.
- Rebuild order: `menu.ts` keeps its behavior but consumes the §2 contract module for the model list and the walk filters (closing the area_publication/area_graph list inconsistency; area_graph removed per scope decision).

## 8. Areas in the generic machinery

- **Context**: areas ride the standard `get_structure_context`. Model guard for buttons: `model==='section' || str_starts_with(model,'area')` (`class.common.php:4189-4193`); button tipos from ontology children (`:4201`), **per-button `get_permissions(tipo, button_tipo) >= 2`** (`:4207-4210`), `properties->disable` skip (`:4225`), button_import/button_trigger attach tool contexts (`:4232-4306`), emitted as `type='button'` DDOs (`:4309-4315`). Area tools via `affected_models('area')`/affected_tipos — already TS-gated on the admin path (`structure_context.ts:293`); the non-admin run lands with the section-family per-button work (coordinate with SECTION_SPEC §9, don't duplicate).
- **Widgets in the read payload**: the client selects area widgets as context entries with **`typo==='widget'`** (misspelled field — `area.js:213`, `area_thesaurus.js:581`) parented at the area tipo. Any area widget the server emits must use `typo`, not `type`.
- **Lang**: areas take the app lang regardless of translatable (`structure_context.ts:249-253` — keep, verified across all models).
- The client module map is mechanical: `core/<model>/js/<model>.js`, export = model name; 8 of 10 area modules are one-line aliases of `area` (`area_root.js:30` etc.), `area_ontology.js:41` aliases `area_thesaurus`. No server work, but it means the ten models MUST each resolve — a model missing from the TS registry breaks navigation for that area even if a sibling model works.

## 9. Security — per-area gates

| Area | PHP gate | TS mandate |
|---|---|---|
| area_maintenance (dd88) | global-admin OR developer (`security.php:259-265` + menu `:147-150`) | same (already gated) |
| area_development (dd770) | developer-only, MENU layer only (`menu.php:152-155`) | same (already gated) |
| **area_ontology (dd5)** | **NO hard gate** — ordinary ACL + a *positive* global-admin bypass (`area_thesaurus_json.php:147-150`); a dd774 self-keyed profile could open it | **superuser, OR global admin AND profile grants dd5 (level ≥ 1); fail-closed, read AND menu, ONE predicate** (`canAccessOntologyArea`, `src/core/security/permissions.ts`). Inside, NO admin bypass: an ontology hierarchy is served iff read on its TLD section; sections/fields answer the ordinary ACL. User decision 2026-10-07 (TODO-025/026), replacing superuser-only (2026-07-03). Divergence from PHP: a non-admin dd5 grant and an ungranted admin are refused. WC-2026-10-07-ontology-area-admin-grant; gate `test/unit/ontology_area_access_native.test.ts`. |
| all others | dd774 self-key via `get_ar_authorized_areas_for_user` (`security.php:582`) | same (`getAuthorizedAreaTipos` — gated) |

- **The model-vs-tipo dispatch quirk**: PHP dispatches area reads on `source.model` without validating that the tipo IS that model — proven by the dd917 fixture (a `field_text` tipo accepted as area_ontology). An unvalidated client string choosing server code paths is a §7 smell. **TS mandate: validate `source.model === ontology model of source.tipo` for area reads, refuse loudly on mismatch.** Fix the dd917 fixture to dd5 and pin BOTH sides: PHP accepts the mismatch (quirk pin), TS refuses (strengthening pin).
- The dashboard is an ACL surface (§4.1 per-section null-out) and the tree payload is an ACL surface (§5.3 pruning) — both need non-admin differentials; the admin-only harness cannot see either gate.
- Fail-closed everywhere: unknown area model → refuse; area write actions do not exist (areas have no data) — any save/delete addressed at an area tipo must be refused, not routed to section code via the duck-type shims.

## 10. Wire quirks to preserve (client contract — do not "fix")

- `rqo.action` is always `'read'` on the wire; the `get_data` intent rides in **`source.action`** (`common.js:1754` vs `:1137`). Key the dispatch on `source.action`.
- Widgets filter on **`typo==='widget'`** (§8).
- Data pick differs by family: generic area takes `data.find(el => el.tipo === el.section_tipo)` (`area.js:212`); thesaurus takes `data.filter(el => el.tipo === self.tipo)` — an ARRAY (`area_thesaurus.js:580`). Emit accordingly.
- Missing `data.dashboard` → silent empty render (`render_area.js:181-185`); `properties.dashboard.disabled` is the legitimate way to get that.
- `metrics`/`generated_at` shipped though unconsumed (§4.3).
- `get_activity_metric` uses the second envelope (`result:true` + top-level `data`), not `{context,data}` (§4.1).
- Tree sort: ordered-before-unordered by `order`, tiebreak **`target_section_name`** (`render_area_thesaurus.js:576-585`); empty `root_terms` hierarchies are skipped client-side too (`:355`).
- `show_ontology` menu shortcut is dead code (`view_default_edit_menu.js:397-411`) — do not wire it.

## 11. Verified real-world corpus (mandatory fixtures)

> **ADDENDUM 2026-08-31 (P3-2 / GATE-47).** "Mandatory fixtures" is HISTORY, not
> instruction. `dedalo_mib_v7` is the live APPLICATION database and is never a
> fixture source or a gate target: the suite writes only to a database carrying
> the `dedalo_test_marker` row. A gate naming an install-specific TLD is refused
> by `generic_tld_tripwire` (shrink-only).
>
> The `dd*` nodes below are different from the `rsc*`/`oh*` case, and the
> distinction matters: `dd` is the CORE ontology every install ships, so these
> nodes exist everywhere rather than being one museum's records. Read the table
> for what the area family DOES; build the situation through the engine's own
> write path (`src/core/test_data/`) and assert against that.

Live ontology (`dd_ontology`, `dedalo_mib_v7`), verified 2026-07-03:

| Node | Model | Notes |
|---|---|---|
| dd242 | area_root | dashboard; anti-lockout guarded |
| dd207 | area_admin | dashboard; parent of dd88 |
| dd69 | area_activity | dashboard (activity section dd542 lives elsewhere — the AREA is a plain dashboard) |
| dd222 | area_publication | dashboard; **missing from `menu.ts` ROOT_AREA_MODELS today** — fix via the contract list |
| dd14 | area_resource | dashboard |
| dd770 | area_development | dashboard; developer-gated |
| dd35 | area_tool | dashboard + section_tool subtree (oh80, numisdata200 groupers) |
| dd100 | area_thesaurus | tree; 37 active hierarchies pinned |
| dd5 | area_ontology | tree; 80 entries pinned; **superuser-only in TS**; the dd917 fixture must move here |
| 71× `area` | pure groupers | e.g. dd68/dd32 (admin subtree), numisdata1, oh80, numisdata200, hierarchy56/57 (thesaurus-virtual rewrite targets) |
| oh81 (+oh83/85/98) | section_tool | tool_transcription over rsc167 (rsc35/rsc36 roles) — the §6 exemplar |
| numisdata201/625/670 | section_tool | under numisdata200 |
| dd88 | area_maintenance | out of scope (done) |
| dd630 | area_graph | **excluded — dead (user decision)** |

Existing gates to keep green: `areas_differential.test.ts` (12-model element-context subset — will extend per §12), `area_hierarchy_differential.test.ts` (boot data byte-equal — dd917→dd5 correction is the ONE sanctioned fixture change), `menu_differential.test.ts`, `menu_nonadmin.test.ts`, `widgets_differential` + `widget_request_differential` (maintenance, untouched), `permissions_differential.test.ts`.

## 12. Gates (definition of done for the area family)

1. **Standing suite green, zero fixture/normalization changes** throughout the strangler migration — sole exception: the sanctioned dd917→dd5 correction, which lands WITH its quirk/strengthening pins (§9).
2. **Dashboard parity.** For every dashboard-behavior area in §11: full `{context, data:[{tipo, section_tipo, section_id:null, dashboard}]}` read byte-equal vs live PHP (admin AND non-admin — the per-section permission null-out is invisible to the admin harness), including `sections` order, `recent_7d`, `color` (crc32 parity), day-filled `activity_30d`; `get_activity_metric` action parity for every range key; `properties.dashboard.disabled/metrics` honored. End-to-end: drive the real client in Chrome against the TS server and see the dashboard render (the project's client-fix precedent).
3. **Tree areas complete.** Boot parity relocated intact; the §5.6 ledger closed: non-admin permission-pruning differential (hierarchies skipped, root_terms pruned), ts_search both trigger paths, `terms_are_model`, the ontology `search_tipos` deep-link, context `section_tipo` overwrite. dd_ts_api remains explicitly ledgered. ✅ 2026-08-14 for the mode half — `thesaurus_mode` is no longer an uncovered variant but a derived, gated decision (§5.7): `area_picker_mode_native` covers the grant and both refusal codes, `thesaurus_picker_tripwire` the single derivation site, and the four frozen differentials the `default`-mode shape.
4. **area_ontology superuser-only, fail-closed**: global admin refused, dd774 self-keyed profile refused, superuser passes; dd5 absent from every non-superuser menu; divergence-from-PHP pinned.
5. **section_tool page-context reroute** parity (oh81 + one numisdata exemplar): rewritten section context carrying `tool_context`, unauthorized-tool refusal matching the menu drop. ✅ 2026-07-10 — `section_tool_start_differential` (oh81 + numisdata201/670 byte-pinned; note START semantics differ from the menu: an unauthorized tool ships the rerouted context WITHOUT tool_context, PHP :410-418 — only the MENU drops the item).
6. **Structure.** `src/core/area/` + `concepts/area.ts` exist; ONE canonical model list consumed by menu, dispatch, contexts, and tests (area_publication present, area_graph absent); the `dispatch.ts` area branches and `structure_context.ts` `startsWith('area')` sites are decomposed into the module; `childrenTipoCache`/`labelCache` get clear hooks registered with the maintenance cache-clear path; area writes refused (§9).
7. **Ledger closure.** STATUS.md gains the Area rebuild table; the dashboard gap, area_graph exclusion, dd_ts_api boundary, and any remaining narrows are written down. Never silently narrow.

## 13. Suggested phasing (executor may evolve; mirror the relations A–F pattern)

- **A. Contracts + module home + relocation** — `concepts/area.ts` (model list, behavior taxonomy, walk filters, tipo constants); `src/core/area/`; move `area_hierarchy.ts`, the dispatch area branches, the structure_context area logic, and the maintenance boundary in with ZERO behavior change; suite green untouched.
- **B. Dashboard engine** — §4 in full: child walk, metric contract, activity SQL, color, controller shape, the `get_activity_metric` action; admin + non-admin differentials; Chrome end-to-end.
- **C. Tree-area completion** — §5.6 ledger: permission pruning, ts_search, modes, deep-link, context stamps; non-admin differential; dd917→dd5 with pins.
- **D. section_tool + security** — the page-context reroute; the dd5 superuser gate + menu hiding; model-vs-tipo validation; area-write refusal.
- **E. Corpus sweep + teardown + ledger closure** — §11 full sweep; the inline area code deleted from `dispatch.ts`/`structure_context.ts`; STATUS.md rows updated.
