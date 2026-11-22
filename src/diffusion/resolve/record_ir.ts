/**
 * The diffusion intermediate representation (DIFFUSION_SPEC §4.1 stage D).
 *
 * RecordIR replaces the old half-resolved PHP datum wire shape: one
 * work-system record, fully resolved for one PublicationPlan, with TYPED
 * values. Everything downstream (runtime parsers → projection → writers)
 * consumes this; nothing downstream touches the ontology or the matrix.
 *
 * Deliberately killed here (spec §7): the `fields:'delete'` string sentinel
 * (→ `status:'unpublish'`), the load-bearing `"errors":[]` serialization, and
 * the frozen datum key order — parity is judged at the ARTIFACTS, not at this
 * internal type.
 */

/** One hop of a resolved relation chain (what the locator projections read). */
export interface ResolvedLink {
	sectionTipo: string;
	sectionId: number | string;
	/** Prefetched display term per lang, present when the plan needs terms. */
	term?: Record<string, string | null>;
	/**
	 * The node's TYPOLOGY term id ("{section_tipo}_{section_id}" of the
	 * section_map 'model' element's first stored locator — PHP
	 * resolve_map_node_data typology resolution). Prefetched on ancestor
	 * chains; consumed by the parents rewriter's
	 * parent_end_by_typology_term_id truncation.
	 */
	typologyTermId?: string | null;
	model?: string;
	fromComponentTipo?: string;
	/**
	 * INVERSE-INDEX EDGE EXTRAS (component_relation_index, relation_list).
	 *
	 * parseInverseEntry (core/resolve/relation_index.ts) reconstructs the whole
	 * dd96 edge from matrix_relation_index — type, tag_id, component_tipo,
	 * section_top_id, section_top_tipo, from_component_top_tipo — and the
	 * index_meta projection republishes all of it verbatim. They live here
	 * because a link carrying only its own address cannot describe the edge it
	 * arrived on: keeping just sectionTipo/sectionId reduced a v6 indexation
	 * cell of nine keys to five, so the published column never matched.
	 *
	 * Absent on ordinary stored locators, which have no edge to describe.
	 */
	type?: string;
	tagId?: string | number;
	tagType?: string;
	componentTipo?: string;
	sectionTopId?: string | number;
	sectionTopTipo?: string;
	fromComponentTopTipo?: string;
	/**
	 * DATAFRAME PAIRING (T2-DIF-3): a frame locator's `id_key` (the stable id
	 * of the main item it extends) and its `main_component_tipo`. Present only
	 * on frames read from a component_dataframe slot; the locator projection
	 * (get_locator) republishes them as `id_key` / `main_component_tipo`.
	 */
	idKey?: number | string;
	mainComponentTipo?: string;
}

/**
 * A typed value atom. `lang` is the data language of the value, or null for
 * language-independent data (projected under the ladder's NOLAN rung).
 */
export type ValueIR =
	| { kind: 'scalar'; value: string | number | boolean | null; lang: string | null }
	| { kind: 'date'; value: unknown; lang: null }
	| { kind: 'geo'; value: unknown; lang: null }
	| { kind: 'chain'; links: ResolvedLink[]; lang: null }
	| { kind: 'json'; value: unknown; lang: string | null };

/** All resolved values of one plan field for one record (multi-item, multi-lang). */
export interface FieldIR {
	/** FieldPlan.id — stable compile-time identity (NOT the column name). */
	planFieldId: string;
	values: ValueIR[];
}

/** One record, fully resolved for one plan. */
export interface RecordIR {
	sectionTipo: string;
	sectionId: number | string;
	/**
	 * Publication-gate outcome. 'unpublish' → writers remove the record's
	 * rows/files (the typed successor of the fields:'delete' sentinel).
	 * Fail-closed: any gate resolution error must yield 'unpublish'.
	 */
	status: 'publish' | 'unpublish';
	fields: Map<string, FieldIR>;
}

/** Convenience: a scalar atom. */
export function scalarValue(value: string | number | boolean | null, lang: string | null): ValueIR {
	return { kind: 'scalar', value, lang };
}

/** Convenience: a relation-chain atom. */
export function chainValue(links: ResolvedLink[]): ValueIR {
	return { kind: 'chain', links, lang: null };
}

/**
 * Flatten a ValueIR to its final string form for tabular projection —
 * the LAST step after parsers ran. Chains must have been transformed to
 * scalars by then; hitting a chain here is a plan/parser bug, surfaced loudly.
 */
export function valueIrToString(value: ValueIR): string | null {
	switch (value.kind) {
		case 'scalar': {
			if (value.value === null) return null;
			if (typeof value.value === 'boolean') return value.value ? '1' : '0';
			return String(value.value);
		}
		case 'json':
			return value.value === null ? null : JSON.stringify(value.value);
		case 'date':
		case 'geo':
			return value.value === null || value.value === undefined
				? null
				: typeof value.value === 'string'
					? value.value
					: JSON.stringify(value.value);
		case 'chain':
			throw new Error(
				'valueIrToString: unprojected chain value reached stringification — a parser/plan step must resolve chains first',
			);
	}
}
