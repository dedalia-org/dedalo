# `src/core/components/` — per-model homes

Dédalo is ontology-driven: the component **model** (`component_input_text`,
`component_relation_parent`, …) is the atom of the system. Resolution itself is
horizontal — it lives in the engines (`resolve/`, `search/`, `relations/`,
`section/`). This directory is not another engine; it is the **named home** for
each model, so a developer or an AI agent can open one place and understand a
model completely without reverse-engineering the PHP tree.

## Layout

```
component_<model>/
  descriptor.ts     # the ComponentModel: what this model IS (see ./types.ts)
  samples/          # what this model LOOKS LIKE (reference, most models)
    data.json       # §3.7 Data     — the stored value shape
    context.json    # §3.7 Context  — ontology structure (properties, css, tools, permissions…)
    api_data.json   # the emitted API item (matches DataItem in resolve/component_data.ts)
registry.ts         # collects every descriptor; getComponentModel(model); load-time coverage check
types.ts            # the ComponentModel / ComponentSearch interfaces
```

The `samples/` sets mirror the copied client's `client/dedalo/core/component_*/samples/`
trees — same shape on both sides of the seam. They are **reference only**: no
runtime code reads them. Two canonical models carry no client sample set yet
(`component_dataframe`, `component_autocomplete_hi`); alias-only stubs
(`component_html_text`, …) have a descriptor but no samples by nature.

## The descriptor is DECLARATIVE

A `descriptor.ts` holds small data (which matrix column, is it class-translatable,
which relation resolver, is its search ported) and **links out** to the modules
that carry heavier behavior — it must never grow inline logic, or it rots into a
god-registry. Example: `component_relation_parent/descriptor.ts` reuses
`portalResolver` for row emission and points to `relations/parent.ts` (hierarchy /
ancestor walk / sibling order) and `relations/dataframe.ts` (id_key order) in a
comment.

## Adding a component model — the HONEST checklist (S2-26)

The registry routes a lot, but **not everything** — the old "nothing in the
engines changes" claim was overstated and is retired. Work the list top to
bottom; the descriptor-facet steps are enforced by
`test/unit/descriptor_completeness_tripwire.test.ts`, the engine steps are not
(yet) and will bite silently if skipped.

**Descriptor side (registry-routed — declare, don't edit engines):**

1. Create `component_<model>/descriptor.ts` exporting one `ComponentModel`;
   add its import + array entry in `registry.ts`.
2. Declare `column` (or `alias` for a legacy name) — routes storage +
   column resolution.
3. Declare `classSupportsTranslation` if the PHP class supports translation.
4. Relation-column model? Declare `resolveData` (row emission), `search`
   (`{status:'ported'}` or a ledgered `'unported'` reason), and
   `defaultRelationType` (the PHP class-level `$default_relation_type`).
   The propagate/relation-data set derives automatically from the column.
5. Non-relation searchable model? Declare `searchBuilder`
   (`'string' | 'number' | 'date' | 'iri' | 'section_id' | 'json'`) — without it,
   SQO searches on the model throw loudly in `search/conform.ts`.
6. CSV-importable scalar model? Declare `importValueProperty: true`
   (PHP `$components_using_value_property`) — without it, bare cells import
   as raw strings instead of `{value:…}` items.
6b. Does the model have a HUMAN-authored CSV form ('21-05-1998', '1.234,56',
   '41.38, 2.17', '273,418')? Declare `importConform` (an `ImportConformId`)
   and add its parser to `tools/import_conform.ts` IMPORT_CONFORM (PHP's
   per-class `conform_import_data()` override). Omitted = the model has no
   flat form: a JSON cell still round-trips (that path is model-agnostic), but
   a flat cell is REFUSED rather than written as a silent clear — which is the
   correct default for the media models. Every relation-column model MUST
   declare it (`'relation'`); `descriptor_completeness_tripwire` enforces that,
   because a relation without a parser silently refuses every section-id list.
7. Flat display string in grids? Declare `flatValue` — one of the
   `FlatValueFamily` names (`'string'`, `'datalist'`, `'section_id'`,
   `'date'`, `'iri'`, `'media'`, `'external'`). Omitting it is legal and
   means "this model has no flat form"; the consumers then LEDGER the cell
   unresolved rather than guessing a string.
8. Emit-time particularity? Declare `emitHook` (an `EmitHookId`) and add its
   implementation to `components/emit_hooks.ts` EMIT_HOOKS — in the model's
   own folder (`component_<model>/emit.ts`) or its engine home (the media
   family shares `core/media/component_emit.ts`; the transliterable models —
   component_input_text, component_iri — share `components/lang_versions_emit.ts`). A hook either owns the
   whole emission (`emitItem`) or adjusts the generic literal path
   (`transformValue` / `decorateItem`). Models that ALWAYS pair with fixed
   dataframe frames declare `fixedDataframeTipos` (component_iri's dd560).

   **`emitHook: 'external'` is not just an emission detail — it DEFINES the
   derived family.** A model declaring it has no stored value at all: the item
   is derived at read time from a third-party service through the
   `src/external/api/` facade (`component_external/value.ts`;
   `engineering/EXTERNAL_SPEC.md`). Declaring it therefore carries four
   consequences a new derived model inherits with no further edit, because
   every one of them keys on the FACET and not on a model name:
   `saveComponentData` refuses the write (`ExternalWriteRefused`),
   `delete_record.ts EXCLUDED_EMPTY_MODELS` skips the model instead of
   emptying it, an import cell is refused per cell (declare NO
   `importConform`), and the model must NOT declare `resolveData` — there is
   no matrix row to resolve. Both omissions are named exemptions in
   `descriptor_completeness_tripwire` (NO_IMPORT_CONFORM / NO_RESOLVE_DATA);
   the write half is gated by `external_write_refusal_tripwire`.
8b. Single-value model (only element 0 of the data array is ever read — the
   PHP `$components_monovalue` class: media, geolocation, json, password,
   publication, section_id, security_access, select, select_lang, text_area)?
   Declare `monovalue: true`. It is THE value law every writer consults through
   `isMonovalueModel` (registry): `saveComponentData` REPLACES the (lang-)slice
   on `insert` and on an id-less `update` of the one stored item, and
   `tool_propagate_component_data` refuses `add`. Omitted = multi-value
   (append). Pinned against the frozen PHP list by `value_law_agreement_tripwire`.
8c. **Render class — REQUIRED on every column-bearing descriptor.** Declare
   `render: 'text' | 'html' | 'url' | 'number'` (types.ts RenderClass): what
   the client may DO with the value at the DOM boundary. `'html'` is the
   decision to store markup — `saveComponentData` runs the ONE HTML sanitizer
   on that class (never on a model name), and the client's ONE escaper
   (`client/dedalo/core/common/js/utils/render_escape.js`) passes it
   through; `'url'` runs the scheme allowlist then escapes; `'number'`
   renders a numeral; `'text'` (every other model, the relation family
   included) is HTML-escaped. The structure context stamps it on the wire as
   `render_class` (WC-2026-09-04-context-render-class), so a client view
   never guesses by model name. Alias stubs inherit through the hop and must
   NOT declare it. Gates: `descriptor_completeness_tripwire`,
   `render_class_native`, `render_escape_tripwire`.
8d. **CSV-import append policy — REQUIRED on every canonical descriptor.**
   Declare `importAppend` (types.ts ImportAppendPolicy): what an
   `import_mode:'append'` column of tool_import_dedalo_csv does with the
   stored data. `'items'` adds the imported items next to the stored ones
   (duplicates skipped); `'geo_layer'` adds a new geolocation layer
   (geolocation only); `'text_paragraphs'` appends a paragraph per language
   (the html render class only); `{ refuse: '<reason>' }` refuses the column
   loudly — REQUIRED for media, single-choice/opaque, and derived models, and
   never on a model that can take `'items'`. No monovalue model may be
   `'items'`. Read through `getImportAppendPolicy` (alias-following; throws
   `internal.invariant` on a canonical model without it). Alias stubs inherit
   and must NOT declare it. Gate: `descriptor_completeness_tripwire` (the
   placement laws + the policy map of record).
9. (Optional) drop a `samples/` reference set alongside it.

**Engine side (STILL SCATTERED — check each; this is the honest part):**

10. `resolve/relation_list.ts` dispatches on `getFlatValueFamily` — nothing
    to edit there; a model whose `flatValue` family is wrong renders the
    wrong cell, so step 7's facet is the one to get right.
11. `resolve/section_elements_context.ts` `DEFAULT_EXCLUDE` — media/system
    models excluded from the simple-context panel (PHP parity list).
12. RAG embedding is AUTHORED per section (the section_map `rag.embed`
    groups; the model allowlist was retired 2026-07-22) — nothing per model.
13. A model whose PHP search is a dedicated pipeline (children/index/
    external/_tm twins) needs its builder ported under `search/` or
    `relations/` — `search: {status:'unported', reason}` keeps the throw
    honest meanwhile.
14. `section/read.ts` emitDdoData keeps exactly ONE per-tipo quirk inline
    (the dd546 activity-'where' transform — a per-TIPO rule has no
    per-MODEL descriptor home); everything per-model dispatches through
    `emitHook`.

The load-time coverage check in `registry.ts` fails at boot if a descriptor is
malformed or an alias dangles. Registry/table equivalence is pinned by
`test/unit/component_registry.test.ts`; facet completeness by
`test/unit/descriptor_completeness_tripwire.test.ts`.
