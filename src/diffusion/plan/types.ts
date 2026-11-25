/**
 * PublicationPlan — the compiled, executable form of a publication schema
 * (DIFFUSION_SPEC §4.1 stage B).
 *
 * A plan is compiled ONCE per (schema source, ontology revision) from either
 * a dd1190 diffusion element (P1) or a tool_export column set (later phase),
 * then cached process-globally. It is a PLAIN JSON-SERIALIZABLE value:
 * principal-independent, dumpable for debugging, diffable in tests, and
 * shippable to a runner process. All ontology interpretation happens at
 * compile time — the resolver and writers never touch dd_ontology.
 */

/** Where a run publishes to. */
export type TargetAddress =
	| { kind: 'table'; database: string }
	| { kind: 'files'; serviceName: string };

/** One step of a field's resolution path (compiled from the ontology ddo_map). */
export type ResolveStep =
	| {
			kind: 'component';
			/** Component tipo to read in the CURRENT record's section. */
			tipo: string;
			model: string;
			sectionTipo: string;
			/**
			 * ddo_map chain parent TIPO. Undefined = root step (executes against
			 * the section's own record); set = executes against the linked records
			 * of that relation-hop step (PHP resolve_chain parent linkage).
			 */
			parent?: string;
			/** Custom component fn (ddo.fn → get_diffusion_data variant), rare. */
			fn?: string;
			/** ddo_map entry id — the handle parser patterns reference ('${a}'). */
			ddoId?: string;
			/**
			 * ddo lang pin (ddo.lang): resolve this terminal in the fixed lang only
			 * and emit it lang-neutral (component_common::get_diffusion_data pin).
			 */
			pinLang?: string;
			/**
			 * Verbatim ddo `options` bag (PHP `$ddo->options`). The media primitive
			 * reads `quality`/`extension` from it (component_media_common::
			 * get_diffusion_data :530-536); ANY other key is refused loudly at
			 * resolution time rather than ignored — an option the engine does not
			 * implement must never narrow a publication silently.
			 */
			options?: Record<string, unknown>;
	  }
	| {
			kind: 'relation-hop';
			tipo: string;
			model: string;
			sectionTipo: string;
			/** ddo_map chain parent TIPO (undefined = root step). */
			parent?: string;
			/** Chain options compiled from rewriter parser fns / ddo flags. */
			addParents?: boolean;
			preserveOrder?: boolean;
			filterSection?: string;
			/** relation_list ddo section_filter: linked-section whitelist. */
			sectionFilter?: string[];
			/** relation_list ddo component_filter: relation-origin whitelist. */
			componentFilter?: string[];
			/**
			 * ddo data_slice — PHP array_slice(locators, offset, length), applied
			 * BEFORE the hop resolves (frozen oracle class.relation_list.php
			 * :1457-1460). v6's diffusion_sql::split_data filters the stored
			 * locators by its `q` rule and only then asks the component for its
			 * ordinary value, so the slice MUST happen on the locators: by the time
			 * the values exist, the records_separator join has already collapsed
			 * them into one string and slicing them is a no-op.
			 */
			dataSlice?: { offset: number; length?: number };
			/**
			 * relation_list only: publish each referencing SECTION once instead of
			 * one entry per stored relation. Set by the migration for v6
			 * `data_to_be_used: 'dato_full'` nodes, whose published list has no
			 * repeats; empty-props relation_list nodes keep every relation.
			 */
			dedupeSections?: boolean;
			/**
			 * The ddo declared a `label`: its child components are a LABEL
			 * expansion (v6 get_locator_value), not direct component reads.
			 */
			labelExpansion?: boolean;
			/** ddo_map entry id — the handle parser patterns reference ('${a}'). */
			ddoId?: string;
			/**
			 * ddo-level `empty_value` (T2-DIF-2; frozen-v7 dd_object::$empty_value,
			 * the v6 resolve_value per-locator placeholder): when a parent locator of
			 * this hop resolves to nothing through its child ddos, ONE placeholder
			 * locator (section_id = this value) is emitted in its place, so per-item
			 * alignment survives (a coin with no hoard publishes "0"). The first
			 * element of the declared list, as a string. Absent = no placeholder.
			 */
			emptyValue?: string;
			/**
			 * component_dataframe ddo whose `parent` names its MAIN component
			 * (T2-DIF-3; frozen-v7 component_dataframe::get_diffusion_data): the hop
			 * reads the slot of the record that holds the main (the HOST record — the
			 * step is compiled at the main's own chain level, not under it) and keeps
			 * only the frames whose `main_component_tipo` is this tipo. Each frame
			 * carries its pairing id (`id_key`) onto the published locator.
			 */
			mainComponentTipo?: string;
	  }
	| {
			kind: 'system';
			source: 'publish_timestamp' | 'section_id' | 'section_tipo';
	  }
	| {
			/**
			 * A ddo the compiler could not turn into a readable step (today: a
			 * tipo absent from the ontology). It stays in the chain and resolves
			 * to ZERO atoms.
			 *
			 * It is NOT dropped, because the oracle derives a datum's `columns`
			 * from the FULL ddo_map — dd_diffusion_api::build_datum_context :1294
			 * keeps every ddo that is not referenced as another ddo's `parent`,
			 * WITHOUT looking the tipo up; danglingness is only discovered later,
			 * at resolve time (diffusion_chain_processor::resolve_ddo_value :133-
			 * 152 returns [] for it). Dropping the entry would silently re-shape
			 * the field's leaf/column topology: mht2's rsc1194 would publish
			 * 'Historia' where the oracle publishes 'Historia, ' (the empty slot
			 * of the dangling zenon4 column, `empty_columns` defaulting to true).
			 * DEGRADE THE VALUE, NEVER THE SHAPE.
			 */
			kind: 'degraded';
			/** The ddo tipo VERBATIM as the ontology declares it. */
			tipo: string;
			/** ddo_map chain parent TIPO (undefined = root step). */
			parent?: string;
			/** ddo_map entry id — the handle parser patterns reference ('${a}'). */
			ddoId?: string;
			/** Machine-readable cause; mirrors PlanDegradation.reason. */
			reason: 'dangling_ddo_tipo';
	  };

/** Per-field emit policies (compiled from the old context side-channels). */
export interface FieldPolicy {
	/**
	 * v6 `is_publicable: true` on a FIELD (migrated to `is_publishable`): an
	 * OVERRIDE that disables the per-locator publication check for THIS column.
	 * v6 reads it in diffusion_sql::resolve_value (:5034-5040) and
	 * count_data_elements (:4396-4402) as
	 * `isset($args->is_publicable) ? (bool)$args->is_publicable : get_is_publicable($locator)`.
	 * v7 previously honoured `is_publishable` only on the TABLE node, so the
	 * field-level override was silently dropped and publications.authors_count
	 * published 0 where v6 counted 1.
	 */
	publishableOverride?: boolean;
	/**
	 * v6 diffusion_sql::resolve_value FILTERS unpublishable locators outright
	 * (:5034-5041) — no value-source exemption, unlike the generic chain walk.
	 * Only columns migrated FROM resolve_value carry this, so the stricter rule
	 * applies exactly where v6 applied it. Measured: dropping the exemption
	 * globally fixed editorial (124→0) but broke eight previously-perfect
	 * columns (authors_name 0→40, authors_surname 0→40, interview_place 0→8…),
	 * which is why it is per-field rather than engine-wide.
	 */
	filterUnpublishable?: boolean;
	emptyToString?: boolean;
	defaultValue?: string;
	emptyValue?: string;
	preserveOrder?: boolean;
}

/** Tabular column typing (sql writer input; ignored by document writers). */
export interface ColumnDef {
	/** Diffusion field model — drives the SQL type (field_text, field_int...). */
	fieldModel: string;
	/** Ontology `varchar` — sizes VARCHAR(n) and the text index prefix only. */
	varcharLength?: number;
	/** Ontology `length` — sizes INT(n) only (never `varchar`: INT width caps at 255). */
	intLength?: number;
	/** Ontology `index` override; absent = model-default indexing. */
	index?: unknown;
}

/** A parser step that survived compile as a RUNTIME transform. */
export interface ParserStepConfig {
	fn: string;
	id?: string;
	options: Record<string, unknown>;
}

/**
 * P6 export front-end metadata (compile_columns.ts): what the export
 * PROJECTION (atoms → NDJSON grid) needs beyond the shared sourceChain.
 * Carried on FieldPlan additively; every other plan consumer ignores it.
 */
export interface ExportColumnMeta {
	/** ar_ddo_to_export ordinal — column identity = the user's DOM order. */
	ordinal: number;
	/** The export ddo `path` VERBATIM (the protocol col line's `path` field). */
	path: Record<string, unknown>[];
	/**
	 * Per-ddo value_with_parents flag (the column's parents checkbox, WC-049:
	 * per-ddo ONLY — no request-global form). The projection emits each
	 * relation locator's ancestor chain as a sibling '#parents' column
	 * (grid_value format; atoms.ts resolveParentsChain).
	 */
	valueWithParents?: boolean;
	/**
	 * Per-ddo value_with_references flag (T0-9 D4, the column's references
	 * checkbox): a declared leaf component_relation_related with derived
	 * relations (dd467 / dd621) also exports its CALCULATED locators (stored
	 * excluded) as a sibling '#references' column (value + grid_value;
	 * atoms.ts emitReferencesAtoms). dedalo_raw ignores it.
	 */
	valueWithReferences?: boolean;
}

/** One output field of one section (a field node of a table). */
export interface FieldPlan {
	/** Stable plan identity = the diffusion field-node tipo. */
	id: string;
	/** Sanitized + validated column name (identifier chokepoint applied). */
	columnName: string;
	/** Resolution path: first step reads the record; hops recurse. */
	sourceChain: ResolveStep[];
	/** Runtime transforms (rewriter fns already absorbed into the plan). */
	transform: ParserStepConfig[];
	column: ColumnDef;
	policy: FieldPolicy;
	/** 'string' | 'int' | 'json' — final stringification hint. */
	outputFormat?: string;
	/** Resolution-only field: participates in logic, emits NO column. */
	excludeColumn?: boolean;
	/** Export front-end only (P6): projection metadata, see ExportColumnMeta. */
	exportColumn?: ExportColumnMeta;
	/**
	 * rdf get_data_number only: number leaves carry the PHP type json_decode
	 * gave the STORED token (ValueMeta.phpNumberType) — `1.0` is a double,
	 * `1` an integer, which JS numbers cannot tell apart.
	 */
	leafNumberTypes?: true;
}

/** All fields of one publishable section (a 'table' node). */
export interface SectionPlan {
	sectionTipo: string;
	/** Table name from the (alias-aware) table-node label, validated. */
	tableName: string;
	/** The table/diffusion-section node tipo this plan came from. */
	tableTipo: string;
	/**
	 * The table node's `is_publishable` (v6: always honoured), compiled here so
	 * the run never needs the ontology tree to honour it (T2-DIF-1). `false`
	 * unpublishes every record of the section, `true` publishes every one
	 * whatever its component_publication says; ABSENT = no override, the
	 * per-record gate decides. Any non-boolean value refuses the compile.
	 */
	publishable?: boolean;
	fields: FieldPlan[];
	/**
	 * Secondary aggregate tables this section's rows ALSO land in — the v6
	 * `global_table_maps` (diffusion_sql::save_global_table_data), compiled
	 * (plan/global_tables.ts). Absent = none. Only on sql elements.
	 */
	globalTables?: GlobalTablePlan[];
	/**
	 * rdf elements only: the owl:Class GRAPH this section publishes
	 * (plan/rdf_compile.ts). Its data-reading properties are ALSO compiled as
	 * `fields` (id = the property node tipo) so the ONE chain walker resolves
	 * them; this describes how their values become triples.
	 */
	rdfClass?: RdfClassPlan;
}

/**
 * A subject IRI recipe (PHP resolve_base_uri + resolve_var_uri): the base IRI
 * is the dd1010 publication-service entry of the element's entity whose
 * `title` equals `baseTitle`; the record part is the var_uri components'
 * values (or the section_id when none), then the `#` fragment.
 */
export interface RdfUriSpec {
	/** base_uri_entity.title ('self' already resolved to the node name). */
	baseTitle: string;
	/** base_uri_entity.component_tipo — the dd1010 component_iri holding the bases. */
	baseComponentTipo: string;
	/** var_uri component parts (absent ⇒ the record's section_id). */
	varUri?: { componentTipo: string; model: string }[];
	/** var_uri `#` literal, appended LAST (a fragment ends an IRI). */
	fragment?: string;
}

/** The base IRI alone (get_data_uri / get_resource_link reference one). */
export interface RdfBaseRef {
	baseTitle: string;
	baseComponentTipo: string;
}

interface RdfPropertyCommon {
	/** The owl:ObjectProperty / rdf node tipo. */
	nodeTipo: string;
	/** The predicate IRI (the node name expanded through the plan's table). */
	predicate: string;
}

/** A property whose values come from a compiled field chain (`fields[].id === nodeTipo`). */
interface RdfChainProperty extends RdfPropertyCommon {
	fieldId: string;
}

/** One property of an rdf class, by `properties.process.type`. */
export type RdfPropertyPlan =
	| (RdfChainProperty & {
			/** default: literals per published lang (text_format / php_formula / ', ' join). */
			kind: 'literal';
			/** The ddo_map END ddos (no child) — the per-lang fallback slots. */
			endDdos: { tipo: string; id: string | null }[];
			textFormat?: string;
			/** php_formula {type:'empty', sentence:'${a} ? ${b} : ${c}'} pre-split. */
			emptyFormula?: { condition: string; whenEmpty: string; otherwise: string };
	  })
	| (RdfChainProperty & { kind: 'data_uri'; base: RdfBaseRef })
	| (RdfChainProperty & {
			kind: 'data_date';
			getDate: string;
			/** date key (year, month…) → datatype IRI. */
			format: Record<string, string>;
	  })
	| (RdfChainProperty & {
			kind: 'data_number';
			/** PHP gettype ('integer' | 'double' | 'string') → datatype IRI. */
			format: Record<string, string>;
	  })
	| (RdfChainProperty & { kind: 'section_id' })
	| (RdfChainProperty & { kind: 'resource_link'; base: RdfBaseRef | null })
	| (RdfPropertyCommon & {
			/** get_portal: a sub-resource, linked only when a child produced a triple. */
			kind: 'portal';
			subject: RdfUriSpec;
			children: RdfPropertyPlan[];
	  })
	| (RdfPropertyCommon & {
			/** ObjectProperty entity_publication_uri: a standalone resource typed `predicate`. */
			kind: 'typed_resource';
			subject: RdfUriSpec;
	  })
	| {
			/** model `rdf`: build the linked records' class into the same document (no triple of its own). */
			kind: 'link';
			nodeTipo: string;
			componentTipo: string;
			componentModel: string;
			/** The owl:Class whose SectionPlan builds each linked record. */
			classTipo: string;
	  };

/** The owl:Class graph of one section. */
export interface RdfClassPlan {
	classTipo: string;
	/** rdf:type IRI (the class node name expanded). */
	typeUri: string;
	subject: RdfUriSpec;
	properties: RdfPropertyPlan[];
}

/** rdf elements only: the document-level contract. */
export interface RdfElementPlan {
	/** properties.diffusion.xmlns, in declaration order (RdfNamespace::set). */
	namespaces: [string, string][];
	/** properties.diffusion.service_type — the dd1020 service the entity lookup keys on. */
	serviceType: string;
}

/** One `columns_map` item of a global table map (v6 save_global_table_data). */
export interface GlobalColumnMap {
	/** A column the global table node declares (validated at compile). */
	targetColumn: string;
	/** Source-table column names in order, or the automatic `section_id` / `lang`. */
	sourceColumns: string[];
	/** `'string'`: join the source values with `separator` (v6 default ' | '). */
	format?: 'string';
	separator?: string;
	/**
	 * Owner C11 (2026-11-13): the CARRIERS (the real table node and every
	 * `table_alias` sharing its maps) on which EVERY source of this item
	 * exists, by virtual tipo — set only when some carrier lacks one (a source
	 * that is an alias's own column). A carrier absent from the list writes
	 * NULL under `targetColumn` for its rows (project/global_table.ts); the
	 * carrier that has the column fills it. Absent = every carrier has them.
	 */
	sourceCarriers?: string[];
}

/** Provenance columns v6 writes on every global row (each only when the node declares it). */
export type GlobalProvenanceColumn = 'ref_section_id' | 'ref_section_tipo' | 'ref_table' | 'link';

/**
 * A global (aggregate) table: one row per (source record, lang), keyed by the
 * composite `<section_tipo>_<section_id>` (project/global_table.ts globalRowKey),
 * written delete-then-insert by the sql writer in the source rows' transaction
 * and withdrawn by every door that withdraws the source row.
 */
export interface GlobalTablePlan {
	/** The global table node (`global_table_maps[].table_tipo`, model `table`). */
	tableTipo: string;
	/**
	 * DDL anatomy: the node's OWN direct field children as column-only fields
	 * (empty sourceChain/transform). `tableName` = the validated global table
	 * name; `sectionTipo` is '' (a global table belongs to no section).
	 */
	schema: SectionPlan;
	/** VARCHAR length of the composite key (the node's own `section_id` field `varchar`, default 255). */
	keyLength: number;
	/** The provenance columns the node declares — only those are written. */
	provenance: GlobalProvenanceColumn[];
	columnsMap: GlobalColumnMap[];
}

export interface RecursionPolicy {
	/** Breadth-first levels budget (DEDALO_DIFFUSION_RESOLVE_LEVELS, default 2). */
	maxLevels: number;
}

export interface PlanLangPolicy {
	langs: string[];
	mainLang: string | null;
}

/**
 * A FIELD-LOCAL degradation found at compile time: the element still
 * publishes, but this field resolves less than the ontology asks for. It is a
 * STRUCTURED channel of its own (never mixed into `warnings`, whose strings
 * are parsed by the resolver's rewriter/hop-fn recovery) because the operator
 * has to be told exactly which column lost what.
 *
 * Oracle: diffusion_chain_processor::resolve_ddo_value :133-152 —
 * component_common::get_instance returns null for a tipo that is not in the
 * ontology, PHP logs "Component instance not found" and returns [] for THAT
 * ddo. The rest of the field, and every other field of the element, still
 * publishes. Before this, the TS compiler raised a fatal element error, so one
 * dangling tipo (mht2's zenon4/5/6/9 bibliography ddos) blocked every run.
 *
 * The degradation is about the VALUE only: the ddo keeps its place in the
 * compiled chain as a `degraded` ResolveStep, so the field's column topology
 * is the oracle's (see that step's doc comment).
 */
export interface PlanDegradation {
	/** The diffusion field node whose resolution was narrowed. */
	fieldId: string;
	/** The column that will publish empty / partial. */
	columnName: string;
	/**
	 * Machine-readable cause (one per known degradation kind).
	 *
	 * `retired_parser_spelling` (P2-13 / PUB-08): the field carries the v6
	 * `process_dato` directive — the shipped STRING fn shape
	 * (`"diffusion_sql::resolve_value"`) or an object with a `parser` — which
	 * nothing reads, so it publishes with no transform at all, where the v7
	 * spelling naming an unknown fn would have been a hard compile error.
	 * Silence about a directive the engine no longer reads is worse than
	 * loudness about a misspelt one.
	 */
	reason: 'dangling_ddo_tipo' | 'retired_parser_spelling';
	/** The offending ddo tipo (empty for a degradation that is not about a ddo). */
	ddoTipo: string;
	/**
	 * ddos hanging UNDER the degraded one (transitively). They keep their place
	 * in the chain and their column slots, but nothing ever executes them: the
	 * oracle reaches a child ddo only through its parent's resolved locators,
	 * and this parent resolves to none. Named so the operator sees the whole
	 * disabled subtree, not just its root. Empty for a leaf ddo.
	 */
	disabledDdoTipos: string[];
	/** Operator-facing sentence (what was skipped and what the effect is). */
	message: string;
}

/** The compiled plan for one diffusion element. */
export interface PublicationPlan {
	/** Cache key: elementTipo + ontology revision at compile time. */
	planId: string;
	elementTipo: string;
	/** Output format type from properties->diffusion->{type} ('sql', 'rdf'...). */
	format: string;
	serviceName: string | null;
	target: TargetAddress;
	sections: SectionPlan[];
	recursion: RecursionPolicy;
	langPolicy: PlanLangPolicy;
	/** rdf elements only: namespaces + service type (plan/rdf_compile.ts). */
	rdf?: RdfElementPlan;
	/** Compile diagnostics surfaced by the `validate` action (never silent). */
	warnings: string[];
	/**
	 * Field-local degradations (see PlanDegradation). OPTIONAL on the type so a
	 * hand-built plan literal (writer/integration fixtures) stays valid;
	 * `compileElementPlan` ALWAYS sets it, and every consumer reads it through
	 * `plan.degradations ?? []`.
	 */
	degradations?: PlanDegradation[];
	/**
	 * The compiled argument of the `map_target_section_tipo` ddo fn: section
	 * tipo → the table name this element publishes it under
	 * (virtual_tree.ts getTargetSectionTableNames). Set ONLY when a field step
	 * uses that fn, so the resolver never walks dd_ontology and every other
	 * plan stays byte-equal.
	 */
	targetSectionTables?: Record<string, string>;
	/**
	 * sql elements only: the row the writer stores as `publication_schema` id 1
	 * (the v6 table the publication APIs read for `resolve_portal` /
	 * `resolve_inverse_relations=true`). The element's
	 * `properties.diffusion.publication_schema` verbatim, with `dd_relations`
	 * = this element's section tipo → table map (getTargetSectionTableNames)
	 * under the ontology's own entries. Optional so hand-built plan literals
	 * stay valid; absent = nothing written.
	 */
	publicationSchema?: Record<string, unknown>;
}
