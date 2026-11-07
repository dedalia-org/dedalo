/**
 * ComponentModel — the per-model DESCRIPTOR (the "named home" for a component
 * model, spec §3.1 "the ontology is the atom of the system").
 *
 * WHY THIS EXISTS. Component behavior in this rewrite lives in horizontal
 * engines (resolve/, search/, relations/, section/) that dispatch on the
 * `model` string. Historically that dispatch was spread across several private
 * lookup tables (MODEL_COLUMN_MAP, MODEL_REPLACEMENT_MAP,
 * CLASS_SUPPORTS_TRANSLATION, the relations RESOLVERS map, the SEARCH_UNCOVERED
 * ledger). A model therefore had no single place a developer could open. Each
 * model now has a FOLDER `component_<model>/` — its home — holding `descriptor.ts`
 * (this data) and, for most, a `samples/` reference set (data.json /
 * context.json / api_data.json: the model's real §3.7 Data, Context, and
 * emitted API item, mirroring the copied client's per-component tree). The
 * descriptor DECLARES the model's deltas and LINKS OUT to the modules that
 * carry its heavier behavior. The engines keep their existing accessor functions
 * (getColumnNameByModel, getRelationResolver, …) — those now just read a
 * descriptor instead of a private table.
 *
 * DISCIPLINE (do not let this rot into a god-registry): a descriptor is
 * DECLARATIVE. It holds small data (which column, is it translatable) and
 * REFERENCES to behavior (resolveData → a relations resolver). It must NEVER
 * grow inline behavior. Where a model's real logic lives elsewhere (e.g.
 * component_relation_parent's hierarchy/order machinery in relations/parent.ts
 * and relations/dataframe.ts), the descriptor file points to it in a comment —
 * a signpost, not a copy.
 *
 * SCOPE. Descriptors cover COMPONENT models only. The non-component `section`
 * pseudo-model and the structural legacy aliases (section_group_div, tab, the
 * "box elements" containers) stay residual in ontology/resolver.ts — they are
 * not component data behavior.
 */

/**
 * The relation-resolver IDs a descriptor may name in `resolveData` (S2-20:
 * relation-model bindings are DATA, resolved by relations/registry.ts —
 * components/ keeps zero value-import edges into relations/). Adding a
 * resolver = add the ID here + its implementation entry in
 * relations/registry.ts RESOLVER_IMPLEMENTATIONS.
 */
export type RelationResolverId =
	| 'portal'
	| 'filter'
	| 'select_family'
	| 'relation_children'
	| 'relation_index'
	| 'relation_related';

/**
 * The emit-hook IDs a descriptor may name in `emitHook` (audit S2-24).
 * Adding a hook = add the ID here + its implementation entry in
 * components/emit_hooks.ts EMIT_HOOKS.
 */
export type EmitHookId =
	| 'section_id'
	| 'media'
	| 'info'
	| 'text_area'
	| 'filter_records'
	| 'security_access'
	| 'external'
	| 'geo'
	| 'inverse'
	| 'lang_versions';

/**
 * The import-parser IDs a descriptor may name in `importConform`. Adding one =
 * add the ID here + its implementation entry in tools/import_conform.ts
 * IMPORT_CONFORM. (Declared here rather than imported from tools/ so that
 * components/ never depends on tools/ — the dependency runs the other way.)
 */
export type ImportConformId =
	| 'date'
	| 'email'
	| 'geolocation'
	| 'input_text'
	| 'iri'
	| 'json'
	| 'number'
	| 'relation'
	| 'select_lang'
	| 'text_area';

/**
 * The TARGET-SOURCE IDs a descriptor may name in `targetSource`: the rule that
 * says where a model's options come from when the NODE's own
 * `sqo.section_tipo` names no usable target. Same DATA shape as `resolveData` /
 * `emitHook` / `importConform` and for the same reason (audit S2-20):
 * components/ keeps ZERO value-import edges into the engine — a descriptor that
 * imported the resolver would drag relations/ + ontology/ back into the
 * component homes and re-fuse the import SCC. The ID is bound to its
 * implementation in relations/request_config/target_sources.ts
 * TARGET_SOURCE_IMPLEMENTATIONS (NOT relations/registry.ts, which would close a
 * 4-file cycle — see the plan's §3 placement rule), and applied at the single
 * seam relations/request_config/build.ts buildRequestConfigForElement, so it
 * covers the explicit AND the implicit config branches.
 *
 * Adding a source = add the ID here + its implementation entry in
 * TARGET_SOURCE_IMPLEMENTATIONS.
 *
 * - 'section_model': the MODEL section paired with the caller's own section by
 *   the hierarchy registry (`es1 → es2`), ontology/model_section.ts
 *   getModelSectionForSection. The default of component_relation_model — one
 *   node (hierarchy27) reused by every hierarchy, pointing somewhere different
 *   per caller, which is exactly what a per-node sqo cannot express.
 */
export type TargetSourceId = 'section_model';

/**
 * The DATALIST-SOURCE IDs a descriptor may name in `datalistSource`: a model
 * whose OPTIONS are not "every record of the request_config target section".
 * Same DATA shape as `targetSource` (S2-20 — components/ keeps zero value-import
 * edges into the engine). Bound to its implementation in relations/datalist.ts
 * DATALIST_SOURCE_IMPLEMENTATIONS and applied at the ONE door, `getDatalist` —
 * so every caller that asks a component for its options (edit read, save echo,
 * temporal echo, filter_by_list, state widget, identify vocabulary) gets the
 * model's options, never the generic enumeration.
 *
 * - 'project_langs': the project default languages (PHP
 *   component_select_lang::get_list_of_values → lang::resolve_multiple
 *   (DEDALO_PROJECTS_DEFAULT_LANGS)), a handful of lg1 records — NOT the ~21.7k
 *   records of the lg1 section its node targets. Asking the generic builder
 *   instead read every language record and put a 2.2 MB datalist on each
 *   select_lang save echo (the 8.7–10.3 s CI saves of test89, 2026-09).
 */
export type DatalistSourceId = 'project_langs';

/**
 * The search face of a relation model (mirrors the old SEARCH_UNCOVERED
 * ledger). Only relation-column models carry this; a model whose PHP search is
 * a dedicated, not-yet-ported pipeline is marked 'unported' with its reason and
 * makes the search dispatcher throw loudly instead of silently mis-searching.
 */
export interface ComponentSearch {
	status: 'ported' | 'unported';
	/** Required when status === 'unported': the ledgered reason it throws. */
	reason?: string;
}

/**
 * NON-relation SQO fragment-builder family (search/conform.ts dispatch,
 * S2-26). Names one of the ported builders in search/builders/ — the
 * descriptor stays declarative (a family NAME, never a function ref, so
 * components/ keeps zero import edges into search/). A model that declares
 * no family is unsearchable through conform and throws loudly there (the
 * no-silent-narrowing posture). Relation-column models never declare this:
 * their search face is `search` + the relations registry, derived from
 * column === 'relation'.
 */
export type SearchBuilderFamily = 'string' | 'number' | 'date' | 'iri' | 'section_id' | 'json';

/**
 * Flat display-value family (S2-26): how a component renders as a plain
 * string cell (relation_list grid values, export atoms).
 * - 'string': lang-sliced literal values joined ' | ';
 * - 'datalist': locators resolved to labels through the component datalist;
 * - 'section_id': the record's own numeric id (component_section_id);
 * - 'date': the dd_date flat form, rendered by the ONE formatter
 *   (components/component_date/date_value.ts `dateItemToValue`) on the node's
 *   `date_mode` — 'Y/m/d' degrading to 'Y/m' and then a bare year, ranges
 *   'start <> end', plus the clock and period modes;
 * - 'iri': the iri value + its dd560 label-dataframe field joined ', ';
 * - 'media': the default-quality file's absolute media URL
 *   (mediaTypeOf(model).defaultQuality — install-tunable via DEDALO_* keys).
 * - 'external': DERIVED from a third-party service (component_external) — the
 *   cell is the component's remote entries joined like a literal. It is its own
 *   family, not 'string', because 'string' means "lang-slice the stored jsonb
 *   value", and this model stores none: declaring 'string' would resolve every
 *   cell to a silent null while claiming a value exists.
 * Models with no family declared are LEDGERED unresolved by the consumers
 * (value null + a note, never a guessed string).
 */
export type FlatValueFamily =
	| 'string'
	| 'datalist'
	| 'section_id'
	| 'date'
	| 'iri'
	| 'media'
	| 'external';

/**
 * RENDER CLASS (audit P2-6 / CARRY-01 — XSS-03): what the client may DO with
 * this model's value at the DOM boundary. The client renders every component
 * value through ONE escaper (client/dedalo/core/common/js/utils/render_escape.js
 * `render_value(value, render_class)`), keyed on the `render_class` the
 * structure context stamps from this facet — never on a local per-view escape.
 *
 * - 'text':   plain text — HTML-escaped before it reaches innerHTML. The
 *             default for every literal AND for the relation family (a
 *             datalist label is another record's text).
 * - 'html':   TRUSTED markup — the write engine ran the ONE HTML sanitizer
 *             on it (security/html_sanitize.ts, keyed on THIS facet in
 *             save_component.ts), so the client passes it through. Only the
 *             rich-text model declares it; declaring it elsewhere is the
 *             decision to sanitize that model on save too.
 * - 'url':    a link — the client runs the scheme allowlist (util.js
 *             safe_url, url_sink_allowlist_tripwire) and THEN escapes.
 * - 'number': a numeral — rendered as String(Number(value)); anything
 *             non-numeric is escaped as text.
 *
 * REQUIRED on every column-bearing (canonical) descriptor; alias stubs inherit
 * through the canonical hop. Pinned by descriptor_completeness_tripwire;
 * the client half by render_escape_tripwire.
 */
export type RenderClass = 'text' | 'html' | 'url' | 'number';

/**
 * What a CSV import column in APPEND mode (tool_import_dedalo_csv
 * `import_mode:'append'`) does with the model's stored data — the
 * `importAppend` facet, read by registry.ts getImportAppendPolicy.
 *
 * - 'items':           the imported items are ADDED next to the stored ones
 *                      (relations: the insert dedup law; literals: per-lang
 *                      value equality). Stored items stay byte-identical.
 * - 'geo_layer':       the imported value becomes a NEW geolocation layer
 *                      (fresh layer_id); stored layers and centre untouched.
 * - 'text_paragraphs': per language, the imported text is appended as a new
 *                      paragraph; a value carrying index/tc tags is refused.
 * - { refuse }:        append has no meaning for the model (media,
 *                      single-choice/opaque, derived) — the column is REFUSED
 *                      loudly with this reason, never silently turned into
 *                      replace.
 *
 * REQUIRED on every canonical descriptor; alias stubs inherit through the
 * canonical hop and must NOT declare it. Pinned by
 * descriptor_completeness_tripwire (placement laws: media refuse, no
 * monovalue 'items', 'geo_layer' only on geolocation, 'text_paragraphs' only
 * on the html render class, derived + no-import-conform models refuse).
 */
export type ImportAppendPolicy =
	| 'items'
	| 'geo_layer'
	| 'text_paragraphs'
	| { readonly refuse: string };

/**
 * The ITEM-GATE IDs a descriptor may name in `itemGate`: a model whose saved
 * items carry keys the generic write engine cannot judge on its own, so the save
 * path runs a model-specific gate over the FINAL items (with the stored ones
 * beside them) before writing. Same DATA shape as `emitHook` / `importConform`:
 * the ID resolves to its implementation in section/record/item_gates.ts, so a
 * descriptor imports no engine module. Adding a gate = add the ID here + its
 * case in item_gates.ts.
 *
 * - 'geo_entry': component_geolocation's sibling keys `sources` and `legend`
 *   (geo/entry_gate.ts — validation, normal form, server-issued source ids).
 */
export type ItemGateId = 'geo_entry';

/**
 * One component model's declarative descriptor. Only the fields the engines
 * actually READ live here; heavier per-model behavior is linked out via file
 * comments (see the DISCIPLINE note above).
 */
export interface ComponentModel {
	/** Canonical model name — this descriptor's identity and its file name. */
	readonly model: string;
	/**
	 * Matrix jsonb column storing this model's data (PHP
	 * section_record_data::$column_map). Consumed by getColumnNameByModel.
	 * Omitted for alias-only stubs that never store data under their own name.
	 */
	readonly column?: string;
	/**
	 * Legacy stored model name → canonical runtime model (PHP
	 * ontology_node::get_model replacement map). Present on descriptors whose
	 * `model` is an obsolete v5/v6 name; getModelByTipo follows it.
	 */
	readonly alias?: string;
	/**
	 * CLASS-level translation support (PHP component_common supports_translation,
	 * :1301-1308) — deliberately independent of the ontology `translatable`
	 * flag. Only these lang-filter their data items. Consumed by component_data.
	 */
	readonly classSupportsTranslation?: boolean;
	/**
	 * The relation resolver implementing this model's row-emission particularity
	 * (only relation-column models), named as DATA (S2-20): the ID is resolved
	 * to its implementation by relations/registry.ts RESOLVER_IMPLEMENTATIONS,
	 * so descriptors never import relation model modules (that static edge was
	 * one of the two that fused the 33-file import SCC). Consumed by
	 * getRelationResolver. Its presence is also how the registry knows a model
	 * is a resolvable relation.
	 */
	readonly resolveData?: RelationResolverId;
	/**
	 * CLASS-level relation type fallback (PHP component_relation_common
	 * $default_relation_type, overridden per concrete subclass) — used only
	 * when the component's OWN tipo properties carry no
	 * config_relation.relation_type. Consumed by getRelationTypeByTipo
	 * (relations/save.ts). Only relation-column models declare it.
	 */
	readonly defaultRelationType?: string;
	/** Relation search coverage (only relation-column models). */
	readonly search?: ComponentSearch;
	/**
	 * NON-relation SQO builder family (search/conform.ts dispatch). Omitted =
	 * unsearchable through conform (throws loudly there). Never set on
	 * relation-column models — their dispatch derives from column==='relation'.
	 */
	readonly searchBuilder?: SearchBuilderFamily;
	/**
	 * Flat display-value family (relation_list grid cells / export atoms).
	 * Omitted = the consumers ledger the model as unresolved (null value).
	 */
	readonly flatValue?: FlatValueFamily;
	/**
	 * PHP component_common::$components_using_value_property: on CSV import a
	 * bare scalar cell wraps into {value: …} for this model (tools/
	 * import_data.ts conformImportData). Omitted = the raw JSON/data shape is
	 * kept as-is.
	 */
	readonly importValueProperty?: true;
	/**
	 * The model's IMPORT parser, named as DATA (the `emitHook` / `resolveData`
	 * shape): the ID resolves to its implementation in tools/import_conform.ts
	 * IMPORT_CONFORM, so a descriptor imports no engine module. It owns the
	 * HUMAN-authored cell — '12-03-1998', '1.234,56', '41.38, 2.17', '273,418' —
	 * and the model's JSON particularities (PHP's conform_import_data override).
	 *
	 * OMITTED = the model has no flat-value form: a JSON cell still round-trips
	 * (that path is model-agnostic), but a flat cell is REFUSED rather than
	 * written as a silent clear. That is the correct default for the media models.
	 * Pinned by descriptor_completeness_tripwire.
	 */
	readonly importConform?: ImportConformId;
	/**
	 * Emit-time particularity (audit S2-24): names this model's emit hook as
	 * DATA — the ID is resolved to its implementation by
	 * components/emit_hooks.ts (same shape as `resolveData`, so descriptors
	 * stay declarative and import no engine modules). The hook either fully
	 * owns the ddo's emission (media, section_id) or adjusts the generic
	 * literal path (value transform / item decoration). Omitted = the plain
	 * generic literal path.
	 */
	readonly emitHook?: EmitHookId;
	/**
	 * The stored value is a CREDENTIAL (component_password): it is never
	 * resolved for display. `resolveComponentValue` (resolve/component_data.ts)
	 * — the one resolver every display door reads through (section read, save
	 * response, Time Machine, portal list values, datalists, identify, term
	 * resolution) — serves each non-empty value as `SECRET_MASK`, keeping the
	 * item's `id`. The engine reads the real value only where it must (auth.ts
	 * verification, the write path), never through that resolver.
	 * WC-2026-09-30-password-hash-never-served.
	 */
	readonly secretValue?: true;
	/**
	 * The model's DEFAULT target source, named as DATA (the `emitHook` /
	 * `resolveData` shape — see TargetSourceId): where this model's options come
	 * from when the node's own `sqo.section_tipo` resolves no target. The ID is
	 * bound to its implementation in relations/request_config/target_sources.ts
	 * and applied by relations/request_config/build.ts
	 * buildRequestConfigForElement (the single seam — it covers the explicit AND
	 * implicit config branches).
	 *
	 * A node's DECLARED sqo always wins; this is the fallback for the legacy
	 * nodes that ship an empty `section_tipo: []` because their target is
	 * per-caller ("calculated in class" in PHP). Omitted = no default: a node
	 * with no usable sqo target resolves nothing, as today.
	 */
	readonly targetSource?: TargetSourceId;
	/**
	 * The model's OPTION source when it is not the generic target-section
	 * enumeration (see DatalistSourceId). Omitted = getDatalist enumerates the
	 * request_config target sections. Pinned by descriptor_completeness_tripwire
	 * (the id must name a real implementation).
	 */
	readonly datalistSource?: DatalistSourceId;
	/**
	 * Dataframe FRAME tipos this model ALWAYS pairs with, regardless of
	 * properties.has_dataframe (PHP component_iri_json's hardcoded
	 * DEDALO_COMPONENT_IRI_LABEL_DATAFRAME dd560). Omitted = frames come from
	 * the generic has_dataframe ontology walk.
	 */
	readonly fixedDataframeTipos?: readonly string[];
	/**
	 * Whether a list column of this model is SORTABLE (PHP get_sortable —
	 * component_common base returns true; media/relation_common/geolocation/
	 * info/security_access override to false). Consumed by the structure-context
	 * core (buildCore) to emit `sortable` + an order `path` per column; the
	 * client's list header shows a sort icon only when this is true (common.js
	 * get_columns_map + ui.js allow_column_order). OMITTED = true (the base).
	 * Set explicitly `false` only on the CANONICAL non-sortable models; alias
	 * stubs inherit their canonical target's value via getModelByTipo. The
	 * per-TIPO exception (DEDALO_NOTES_TEXT_TIPO rsc329 → false) lives inline in
	 * buildCore. Pinned by test/parity/list_column_sortable_differential.test.ts.
	 */
	readonly sortable?: boolean;
	/**
	 * MONOVALUE (PHP component_common::$components_monovalue, class.component_common
	 * .php:180-196): the data is an array but ONLY ELEMENT 0 IS EVER READ. The one
	 * value law every writer consults through registry.ts isMonovalueModel — an
	 * `insert` on such a model REPLACES the (lang-)slice instead of appending
	 * (PHP :4128-4131), an id-less `update` of the one stored item replaces it
	 * (WC-2026-08-08), and the propagate tool refuses `add`. Alias models
	 * (html_text → text_area) inherit through the canonical hop. Declared as
	 * `true` only; omitted = multi-value. Pinned against the frozen PHP list by
	 * value_law_agreement_tripwire.
	 */
	readonly monovalue?: true;
	/**
	 * The value's RENDER CLASS at the client DOM boundary (see RenderClass).
	 * Consumed by registry.ts getRenderClass → save_component.ts (the sanitizer
	 * runs iff 'html'), resolve/structure_context.ts (stamped on the wire as
	 * `render_class`, WC-2026-09-04-context-render-class) and
	 * section/indexation_grid.ts (the same key on every grid cell). Required on
	 * canonical descriptors; getRenderClass throws on a model without one.
	 */
	readonly render?: RenderClass;
	/**
	 * CSV-import APPEND policy (see ImportAppendPolicy). Consumed by
	 * registry.ts getImportAppendPolicy → the tool_import_dedalo_csv column
	 * mapper/resolver and the saveComponentData `appendImport` backstop.
	 * Required on canonical descriptors; the accessor throws on a model
	 * without one (no silent default — a guessed 'items' would append to a
	 * single-choice model, a guessed refusal would hide a capability).
	 */
	readonly importAppend?: ImportAppendPolicy;
	/**
	 * The model's ITEM GATE (see ItemGateId): run by saveComponentData over the
	 * final items of every save of this model, whatever door sent them. Omitted =
	 * the generic value gates are the whole story. Pinned by
	 * test/unit/geo_entry_gate_native.test.ts (placement: only a `geo`-column model).
	 */
	readonly itemGate?: ItemGateId;
	/**
	 * DERIVED: the component OWNS NO STORED VALUE — what a read serves is
	 * computed (an inverse question: who declares me as parent / who points at
	 * me; a remote service), never read back from its own matrix key. Whatever
	 * bytes sit under its tipo (an old no-op save's leftovers) are therefore NOT
	 * its value, and no door may treat them as one. Consumers (registry.ts
	 * isDerivedModel):
	 *   - tool_update_cache SKIPS it server-side (a "regenerate" re-saves the
	 *     stored bytes — for component_relation_children, whose save writes
	 *     THROUGH to the children, that would re-parent a thesaurus from stale
	 *     leftovers);
	 *   - the CSV import REFUSES a column mapped to it in any mode (its
	 *     `importAppend` refusal names what to import instead).
	 * A derived model must refuse append. Declared `true` only; omitted = the
	 * component stores what it serves. component_info is audited OUT: its
	 * widget values are stored mirrors the read and search consult. Pinned by
	 * descriptor_completeness_tripwire (the set of record, the append law).
	 */
	readonly derived?: true;
}
