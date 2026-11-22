---
name: dedalo-relations-ts
description: >-
  The Dédalo v7 TypeScript/Bun RELATION component family — src/core/relations/ (registry dispatch, relation_core expandPortal, per-model resolvers, implicit/explicit request_config builders, inverse children/related/index engines, save hooks) and the full component_dataframe contract (id_key pairing, normalizeDataframeEntry/dataframeEntriesEqual, the paired get_data graft, the client gates). Use when editing src/core/relations/**, the relation emission in src/core/section/read.ts (emitDdoData), src/core/search/conform.ts relation dispatch, or debugging why a portal/autocomplete/dataframe/children/index/related component resolves wrong. Also for ANY dataframe symptom: frames saved but not shown, duplicate frames, a frame paired to the wrong main item, "shows the previous data", a dataframe widget missing from a literal or portal main, the rating chip colour missing, or a frame stored without type dd490. Spec: engineering/RELATIONS_SPEC.md.
---

# Dédalo v7 relations (TypeScript rewrite)

The relation family lives in `src/core/relations/`, ported from the PHP monolith (frozen tree `v7_php_frozen/master_dedalo`, outside the repo — historical reference only, never an oracle). Read-path parity replays the frozen fixture store (`test/parity/fixtures/oracle_harvest/`); write-path contracts are TS-native `test/unit/*_native.test.ts` gates. Never silently narrow scope — uncovered paths throw `engine.uncovered_scope` and carry their reason next to the code (a descriptor `search.reason`, a named exemption).

**One law:** sections (`section_tipo` + `section_id`) connect ONLY via locators. Every relation component declares target section(s) + a `request_config`, resolves data from the target(s), and represents part of it inside the host section. All models share ONE engine; each adds a small particularity.

## Architecture — strangler-fig into `src/core/relations/`

The old resolve/read_rows.ts monolith is **DELETED**: its exports live in `src/core/section/read.ts` (`readSection`, `readComponentData`, `resolveSearchData`, `readSectionRows` — the shared `emitDdoData` lives here) and the save path in `src/core/section/record/save_component.ts` + `src/core/relations/save.ts`. Layering (no static-import cycles — `import_scc_tripwire` is the gate): `relations/` imports `concepts/`, `ontology/`, `db/`, `search/search_related.ts`, `search/builders/*`; `section/read.ts` / `section/record/save_component.ts` / `search/conform.ts` import `relations/registry.ts`. Child recursion goes through the `emitDdo` CALLBACK handed into resolvers — so `relations/` never imports `section/read.ts`. Edges DOWN into the record layer:
- **`section_record/`** (the write chokepoint) — static: `children_orphan_sweep.ts` → `persistRecordKeys`; `datalist.ts` / `filter_projects.ts` / `select_lang.ts` → `save_event.ts registerSectionDataListener` (cache-invalidation registration). Lazy: `deletePortalLocator` (`save.ts`) → `persistRelationRemovalKeys`, whose obligation-ledger entry carries the **REMOVED** locators to observer propagation after COMMIT — no door calls `propagateToObservers` itself (`WC-2026-09-30-record-write-obligation-ledger`; see **`dedalo-observers-ts`**). No cycle: `section_record/` reaches `relations/save.ts` only by `import type` + lazy imports (`record_write.ts`, the chokepoint seam of `engineering/CONVENTIONS.md` §2.1).
- **`section/record/`** — all lazy: `save.ts` → `record_defaults.ts`, `create_record.ts`; `dataframe.ts` → `delete_record.ts`. Only the last is load-bearing: `delete_record.ts` imports `dataframe.ts` statically, so making it static closes an SCC.

```
src/core/relations/
  registry.ts            # RESOLVER_IMPLEMENTATIONS (resolver-id → impl) + search face
  relation_core.ts       # shared engine: expandPortal, emitDataframeItem, nested recursion, re-stamp
  children.ts parent.ts related.ts   # inverse-question engines (who declares me?)
  dataframe.ts datalist.ts save.ts picker_constraint.ts order_locators.ts filter_projects.ts select_lang.ts config_ddo_map.ts
  models/{portal,select_family,relation_children,relation_index,relation_related}.ts
  request_config/{build,implicit,explicit,external,filters,presets,engine_select,target_sources}.ts
```

### Registry dispatch (`registry.ts`)
- `getRelationResolver(model)` reads the RUNTIME model's descriptor `resolveData` (a resolver ID, data in `src/core/components/component_<model>/descriptor.ts`) and binds it through `RESOLVER_IMPLEMENTATIONS`. `component_autocomplete(_hi)` reaches it as `component_portal` via the descriptor `alias` (`ontology/resolver.ts` `getModelByTipo`; its `STRUCTURAL_MODEL_REPLACEMENT_MAP` holds only non-component structural aliases). No `resolveData` ⇒ THROWS `engine.uncovered_scope` — never silently portal-shaped.
- Bindings: portal/relation_parent/dataframe → `portal`; filter/filter_master → `filter` (portal WITHOUT own-config child expansion); relation_children → `relation_children`; select/select_lang/radio_button/check_box/publication/relation_model → `select_family`; relation_index → `relation_index`; relation_related → `relation_related`. `component_external` declares NO `resolveData` (its value is derived from a third-party API at read time) — it throws.
- SEARCH face `getRelationSearchFragmentBuilder(model)`: shared containment builder (`search/builders/builder_relation.ts`) for the family; `component_relation_children` → `builder_relation_children.ts` (inverse-parent EXISTS pipeline), `component_relation_index` → `builder_relation_index.ts` (computed-inverse); `component_external` (descriptor `search.status: 'unported'`, no SQL surface — searched through `src/external/search.ts`) THROWS. The autocomplete_hi ancestor `$or` wrap (`buildRelationSearchAncestorFragment`) is LIVE (WC-2026-08-09-autocomplete-hi-ancestor-search) but applied by `search/conform.ts` keyed on the STORED model, not by this registry (the runtime model is already `component_portal`).

### Shared engine (`relation_core.ts`)
`expandPortal(record, portalDdo, model, childDdos, portalMode, portalLang, row, callerTipo, emission, emitDdo, options)` — `emission` is the per-read `EmissionContext` (`resolve/component_data.ts`: `items` + `markStamped`/`isStamped`):
- EMPTY relation → emits NO item (PHP portal_json guards the push on non-empty `data_value`). **Exception:** `relation_children` emits its empty own item — see below.
- Paginate locators (`total = FULL locator count`), stamp `paginated_key = index + offset`.
- EDIT limit chain: `ddo.limit ?? ownEditLimit() ?? 10` where `ownEditLimit` = LAST config item's `sqo.limit ?? show.sqo_config.limit`. LIST/TM: `ddo.limit ?? cellLimit ?? (autocomplete_hi ? locators.length : 1)`.
- Expand each paged locator's target record through child ddos via `emitDdo`, then OUTER re-stamp (PHP `class.common.php:2792-2799`): rewrite `from_component_tipo`/`parent_tipo`/`row_section_id` outward, but an item a nested expansion already stamped (`emission.markStamped`) keeps its own identity.
- `emitDataframeItem`: id_key→id pairing (type dd490) via the pure predicate `dataframeEntryMatches(entry, mainComponentTipo, pairId, fromComponentTipo?)` in `concepts/subdatum.ts`; frame item ALWAYS emits (even `entries: []`); stamps `id_key` (INT), `main_component_tipo`, `from_component_tipo`.

## Semantics resolvers MUST honor (ported from PHP; each backed by a real client bug)

1. **`section_tipo: 'self'` resolves to the SQO TARGET sections, not the caller** (PHP `resolve_ddo_self_references`). Caller scalar only for dataframes; `undefined` stays untouched. Getting this wrong made every self-declaring child skip the per-locator grouping → autocomplete cells emitted no subdatum. (`request_config/explicit.ts processSingleDdo`.)
2. **`get_subdatum` flattens SHOW + HIDE ddo_map** into one deduped set. Hide-block ddos are server-resolved data the client widgets consume without rendering as columns (e.g. `numisdata585`'s `hierarchy31` geolocation feeds the map observer). Own-config expansion must concat `show.ddo_map` + `hide.ddo_map`. (`models/portal.ts` edit path.)
3. **Multi-target ddos carry the FULL section_tipo ARRAY.** A `hierarchy_types` portal's `self` child resolves to EVERY target (`numisdata20`'s `hierarchy25` spans 26 hierarchy sections). Flattening to `[0]` makes the per-locator grouping skip all but the first target. Keep the declared array intact; per-locator grouping picks the compatible target.
4. **`sqo.section_tipo` entries are ENRICHED ddo objects**, not plain tipos: `{typo:'ddo',tipo,model,permissions,label,buttons,color,matrix_table}` (`build_sqo_section_tipo_ddo`; color default `#b9b9b9`). This is the CLIENT contract — portal link/new buttons read `target_section[0].tipo`. Both implicit and explicit builders emit them; engine consumers project via `extractSqoSectionTipos`.
5. **`component_relation_children` emits its OWN item even when EMPTY** in every non-search mode: `entries: [], pagination: {total:0, limit:10, offset:0}, lang:'lg-nolan'`, plus parent/row stamps. The generic portal path skips empty relations, so the resolver special-cases `computed.length === 0`. (`models/relation_children.ts`; mirrors the dz1 §503 get_data empty pin.)
6. **`get_data` serves ANY component, not just relations.** The autocomplete_hi edit-in-place widget refreshes the chosen term's `component_input_text` value via `get_data`. `readComponentData` routes non-relation models through the generic `emitDdoData` path instead of throwing. (`section/read.ts`.)
7. **Section reads must include subdatum CHILD contexts** — one context entry per unique emitted child item (`parent = from_component_tipo`, view from the generating config). Without them the client's portal rows have no component structure to render. (`readSection` `appendDerivedItemContexts`.)
8. **`component_filter` needs `context.target_sections`** = `[{tipo:'dd153', label}]` (PHP `component_filter_json`); missing it TypeErrors and kills the whole render. Filter cells also do NOT run subdatum over the project targets (`filterResolver` sets `allowOwnConfigChildren: false`).

## request_config builders

- `build.ts` = the explicit/implicit data-driven branch (single entry `buildRequestConfigForElement`; explicit ≡ PHP v6, implicit ≡ PHP v5). Explicit = `properties.source.request_config`; implicit = ontology graph walk (no-source components: `numisdata967/71/1562`; legacy source objects: `numisdata55`).
- `explicit.ts`: `processSingleDdo` (the self→targets rule #1), `resolveGetDdoMap`, `parseBlock`, dynamic `hierarchy_types` + multi-section targets, self-targeting SQOs (`numisdata36/1006` — no section_tipo, filter_by_list only → resolve to caller), `filter_by_list`/`fixed_filter` expansion (disables cache), external `api_config` attach.
- `implicit.ts`: graph-walk targets; parent/children throw (EXPLICIT_CONFIG_REQUIRED_MODELS); `getMainRelatedSectionTipo`.
- `filters.ts`: `filter_by_list` datalist expansion (per filter: `context.target_sections`, strnatcmp-sorted options).
- `external.ts`: zenon-style `api_config` resolution; the HTTP remote-fetch proxy refuses writes (unused by the corpus install).

## Inverse-question engines (data-driven components own NO stored rows)

- `children.ts`: `getChildren/countChildren/getChildrenRecursive` — inverse dd47 ("who declares me as parent?"), INT section_ids (`ChildLocator.section_id: number`, off the int-typed relation index; WC-2026-08-10-section-id-int-canonical), sibling-ordered via `resolveParentLinkIdKey` + `getInlineValueByIdKey`.
- `related.ts`: transitive closure (dd620 none / dd467 one inverse hop / dd621 full symmetric closure, typeRel read from `properties.config_relation.relation_type_rel`) with cycle cache. **`getStoredWithReferences` is load-bearing OUTSIDE relations**: it is the peer-expansion primitive of the observer `set_dato_external` value law — measured, weakening the dd621 closure to the stored bag loses 247,933 locators over 19,908 numisdata3 records. The dispatch is polymorphic on purpose (only a `component_relation_related` peer computes the closure). Touch it only with **`dedalo-observers-ts`** in hand.
- `relation_index.ts` (`models/`): computed inverse dd96 ("who calls me", tag_id anchors); `mode:external` inverse (hierarchy40). Preserves pinned PHP-era quirks.
- `datalist.ts`: select-family option lists — a FAITHFUL C `natsort` port (whitespace-skipping strnatcmp; "Petit-Aledón" before "Petit 1981"), multi-ddo `' | '` labels.

## Dataframe (id_key pairing, type dd490)

`concepts/subdatum.ts` is the pure contract home: `dataframeEntryMatches(entry, mainComponentTipo, pairId, fromComponentTipo?)`, plus **`normalizeDataframeEntry`** (the persisted-frame normalizer) and **`dataframeEntriesEqual`** (identity over `DATAFRAME_TEST_EQUAL_PROPERTIES`). `dataframe.ts` consolidates emit + literal pairing onto them. `build_dataframe_subdatum` counter contract + blank-slot dummy locator at counter+1. **Round-trip is gated TS-natively** (`dataframe_idkey_native.test.ts` — twin of the retired dataframe_roundtrip differential) on records the test BUILDS; never assert against a real record. `absorbComponentItemIds` raises the `meta` counter to max ids (counters live in the `meta` column).

### The persisted-frame contract (a frame the reader can't see IS corruption)

Every frame write funnels through `normalizeDataframeEntry`, from BOTH doors — `validateRelationInsert` (`relations/save.ts`, via its `pairing` option) and `mergeCallerEntries` (`relations/dataframe.ts`). It FORCES `type: 'dd490'`, takes `from_component_tipo`/`main_component_tipo`/`id_key` from the **server's** caller context (never the payload), canonicalizes `section_id` to INT (`canonicalizeStoredSectionId` — WC-2026-08-10-section-id-int-canonical; external remote ids pass verbatim), and strips `paginated_key` + the legacy `section_id_key`/`section_tipo_key`.

**Frames of a COVERED observer mirror move with the mirror** (CLOSURE_PLAN Step 2, 2026-10-01 — the covered-unit law, `WC-2026-09-30-record-write-obligation-ledger`): a mirror and the frames paired to its items (`id_key → id`) are ONE unit. A whole-record replace keeps the LIVE unit (mirror and frames), an undelete keeps the snapshot's unit with its item ids (so every frame stays on its referencer), a new birth (create, duplicate) drops the unit (`dropCoveredObserverUnits`) and the duplicate re-mints no frame target for it; the slot is then recomputed after COMMIT. See `dedalo-observers-ts` §The obligation ledger.

Dedup compares `DATAFRAME_TEST_EQUAL_PROPERTIES` — **excludes `id`** (minted per insert, so including it makes every duplicate unique) and **includes `id_key`** (framing the same target from two different main items is legitimate). The generic relation key `[section_id, section_tipo, type, tag_id]` must NOT be used: it would collapse those two.

**Why this exists (2026-07-31, record oh1/368).** `component_dataframe` was the ONE relation column excluded from the normalizer — `!isDataframeSave` guarded all three value-carrying branches of `save_component.ts`. The client's raw picker locator was stored verbatim: no `type`, numeric `section_id`, echoed `paginated_key`, no dedup. Since `isDataframeEntry` demands dd490, every such frame was invisible to the reader — stored, unreadable, undeletable through the UI, and each retry appended another. 9698 legacy frames were correct; exactly 3 were not.

**One validity rule for every door**: `dataframePairingOf` (`concepts/rqo.ts`) — a pairing needs a non-empty `main_component_tipo` AND an integer `id_key >= 1`, returned as a NUMBER. Three doors each having their own predicate (read: any finite; save: `>=1`; merge: non-null) was itself a hole — a payload passing one and failing another wrote through the UNPAIRED path. The save door **refuses loudly** on an unusable pairing rather than persisting garbage.

### Reading one item's frames

`get_data` on a `component_dataframe` is a **paired** read: it honours `source.caller_dataframe` (DECLARED on `rqoSourceSchema`, read only through `callerDataframePairing`), and does it by **grafting** the caller's filtered subset into a cloned record then letting the STANDARD portal expansion run — the same substitution trick `component_relation_children` uses. Do NOT hand-roll a bespoke emitter here: the first attempt did, and silently lost sqo limit/offset paging, the `source.properties` override, the ddinfo breadcrumb, and the pinned `'edit'` mode (it re-derived mode from `source.mode`, which routes the client into a different view). Search mode is excluded outright — the client sends `caller_dataframe` on *every* dataframe request.

The item MUST carry `id_key` + `main_component_tipo`. That stamp is load-bearing, not cosmetic: the client assigns the response onto `self.data` and sources the NEXT write's `id_key` from it (`common.js create_source`), so an unstamped echo destroys the following write's pairing. An empty pairing still emits an item (`entries: []`) — `expandPortal` emits nothing for an empty relation, and the client's `self.data = data || {}` would leave the widget with no entries array.

### The CLIENT half (server-correct ≠ rendered)

The server can emit context + data perfectly and nothing appears. Two independent client gates:

- **`context.request_config[0].show.ddo_map` must contain a ddo with `model === 'component_dataframe'`** — that is the ONLY way `get_dataframe` (`component_common/js/dataframe.js`) finds the slot; it returns `null` silently otherwise. The builder stamps `model` from the tipo, so the ontology ddo need not spell it. A literal main gets `request_config` on its context only when it carries its own `source.request_config` (`structure_context.ts`) — the DATA path activates on `has_dataframe` + ontology parentage and needs no config, so the two halves can disagree.
- **`mode` resolution is now ONE rule on every kind of main** (unified 2026-07-31 at the user's call — "why do we need to think in 2 ways?"): the **declared ddo's** `mode` wins, then the slot NODE's `properties.mode`, then `'list'`. The literal path used to pass a SYNTHETIC ddo `{tipo, section_tipo}` and read only `resolveFrameConfig(...).nodeMode ?? 'list'`, so a ddo declaring `"mode":"edit"` was silently dropped on a literal while a relation main honoured it — and `context.view` came from the ddo (`ddoViewOf`) while `context.mode` came from the node. It now looks the slot up in the main's own config (`resolveOwnConfigMap`) exactly as the relation path uses `childDdo.mode ?? portalMode`. Pinned by `has_dataframe_literal_native.test.ts` ("a LITERAL main honours its declared ddo mode"), whose golden pins the fallback. **Symptom of the old split: copying a relation-main slot config (e.g. `numisdata1447`, which carries no node mode) onto a literal yielded `mode:'list'` and rendered nothing.**
- Omitted mode + non-section owner ⇒ `mode: 'list'` (`request_config/explicit.ts` step 7) + `fixed_mode: true`. And the two modes resolve views DIFFERENTLY: **edit** uses the portal views verbatim (`line`, `tree`, `default`, `mosaic`, `indexation`, `content`, `text`); **list** prefixes to `dataframe_<view>` and only `dataframe_default`/`dataframe_text`/`dataframe_mini` exist — anything else falls through to `view_default_list_portal`, which shows nothing for a frameless slot. `{"view":"line"}` with no `mode` is the classic trap: a good edit view demoted to a dead list one. `get_dataframe` ignores its own `view` param; the DDO's `view`/`mode` win on the instance.

The rating chip colour comes from the datalist: each option carries `hide: [{literal, tipo, section_id, section_tipo}]` (resolved per option in `relations/datalist.ts`), and `view_default_list_dataframe.js` paints `hide[0].literal`. That resolution was missing (`hide: []` hardcoded) until 2026-07-31 and threw, killing the whole record render.

Gates: `dataframe_write_contract_native.test.ts` (submits RAW client payloads ONLY — if a test there spells `type:'dd490'` in an input it has stopped testing the contract), `dataframe_contract_tripwire.test.ts`, `datalist_hide_ddos.test.ts` (seeds its own vocabulary: the corpus records are absent from the test DB, and an install-data assertion there passed with ZERO expect() calls).

## Client RQO contract (schemas are the sanitization gate)

- `concepts/ddo.ts ddoSchema` is BOTH the client whitelist (`.strip()` drops unknown keys = PHP `sanitize_client_ddo_map`) AND the wire schema. `section_tipo` is `string | string[]` (the client echoes back the multi-target arrays our contexts ship — a plain-string schema 400s the portal search RQO). Do NOT add server-only fields.
- `concepts/rqo.ts` block schemas (`show`/`search`/`choose`) mirror `ddoSchema`.

## Gotchas

- **`section_id` is INT-CANONICAL** (WC-2026-08-10-section-id-int-canonical, repealing the old string-canonical law): writers mint int via `canonicalizeStoredSectionId`, emissions (children, datalist, echoes) are int, and jsonb `@>` probes are DUAL-FORM + polarity-aware (`src/core/search/containment.ts`) because pre-sweep stored data still carries strings. External remote ids ('001338683', 'Q42') stay strings VERBATIM — protected by the value invariant (never strict-numeric-without-leading-zeros), NOT by tipo. Never blanket-`Number()` a stored value; never single-form a containment probe.
- **`parent_section_id` on children differs by flow**: `resolve_data` chips stamp entry-carrying children; `get_data` stamps portal items only. Both are pinned by different gates — don't unify.
- **Locator lookup key**: 5-field default predicate joined with `_` (PHP `class.locator.php`), NOT a 2-field or control-char join. Unit-gated in `locator_law.test.ts`.
- **Empty portal still emits pagination `{total:0}`** for children; a real (non-children) empty relation emits nothing.
- **`ownConfig` flag** in `expandPortal` gates BOTH nested-own-config recursion (list/tm) AND ddinfo breadcrumb emission (autocomplete_hi) — must be `true` in edit when children came from own config, else the breadcrumb vanishes.

## PHP-era defects TS deliberately does not replicate

- `component_calculation` READ on an unstored value crashed the whole PHP request (`array_sum`) — TS serves `entries: []`.
- (Kept, not a defect: counters in the `meta` column absorb max ids — `absorbComponentItemIds`, `db/matrix_write.ts`.)

## Testing

Tests BUILD their situation with the generic `test` TLD on the suite DB (`bun run test:db:setup`; writers call `assertTestDatabase()`) — never read an install's records. See **`dedalo-ts-testing`**; for a red frozen-fixture parity gate or a fixture/WC edit, **`dedalo-parity-debugging`**. Key relation gates: parity `relation_corpus_config.test.ts` (§7 corpus, FULL enriched sqo compare), `relation_inverse_differential.test.ts`, `request_config_differential.test.ts` (frozen fixtures; corpus-bound ones are red on the suite DB by construction); native `dataframe_idkey_native.test.ts`, `portal_edit_subdatum_native.test.ts`, `portal_drag_capture_native.test.ts`, `external_request_config_native.test.ts`; units `locator_law.test.ts`, `request_config_implicit.test.ts`, `request_config_source_cases.test.ts`, `relation_search_builders.test.ts`, `tm_filter.test.ts`. A frozen-fixture gate stays green with ZERO fixture/normalization changes — a needed change is a deliberate contract edit with a same-day `engineering/wire_contract/` entry, never a normalization to hide a behaviour change.
