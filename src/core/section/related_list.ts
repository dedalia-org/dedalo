/**
 * A SECTION's `related_list` — how ANY section presents itself when it is
 * listed as "a record that points at X" (SECTION mode `related_list`). Its
 * columns are defined by the section's `relation_list` ontology child: the
 * child's `relations` name the component tipos.
 *
 * Kept apart on purpose from the component that CONSUMES it:
 * `component_relation_index` (the host's computed inverse — who points at me)
 * is ONE consumer; the References panel / related_search
 * (resolve/relation_list.ts getRelationListColumns, resolve/related_sections.ts)
 * are others. This module is the ONE source of truth for the section-level
 * fact, so the consumers cannot drift apart:
 *
 *   sectionRelationListTipos   the raw relation_list column tipos (virtual-aware,
 *                              ontology-cached) — the ONE lookup every
 *                              consumer starts from;
 *   sectionRelatedListConfig   PHP resolve_ar_related_related_list
 *                              (trait.request_config_v5.php:295-331) + clean +
 *                              filter_authorized_related + build_legacy_ddo_map:
 *                              the related_list ddo map the relation_index DATA
 *                              (relations/models/relation_index.ts) and its
 *                              CONTEXT merge both read — a column the viewer
 *                              may not read has neither a ddo nor a data cell.
 *
 *   rsc205 (virtual → rsc3) → relation_list rsc133 → [rsc349, rsc140, rsc224]
 *   sectionRelatedListConfig('rsc205') →
 *     [{typo:'ddo', tipo:'rsc349', section_tipo:'rsc205', parent:'rsc205',
 *       mode:'related_list', model:'component_input_text', label:'Nombre personal'}, …]
 *
 * PRINCIPAL-DEPENDENT: the authorised map is per viewer, so it is NEVER cached
 * (only the raw tipo lookup is — ontology-derived, invalidated by the hub).
 */

import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { LABEL_NODE_MODEL } from '../ontology/label_node_guard.ts';
import { labelByTipo } from '../ontology/labels.ts';
import { getModelByTipo, getNode } from '../ontology/resolver.ts';
import { findSectionChildByModel } from './list_definitions/node_find.ts';

/** The section mode a related_list ddo renders in (PHP: a SECTION caller keeps its own mode). */
export const RELATED_LIST_MODE = 'related_list';

/**
 * Relation nodes of a relation_list that never become a column (PHP
 * clean_and_extract_related :508-538): a target-section node, the exclude
 * marker, the deprecated dd249 security component, inert label nodes, and a
 * tipo whose model does not resolve at all.
 */
const NEVER_A_RELATED_COLUMN_MODELS: ReadonlySet<string> = new Set([
	'section',
	'exclude_elements',
	LABEL_NODE_MODEL,
]);
/** PHP DEDALO_COMPONENT_SECURITY_AREAS_PROFILES_TIPO — deprecated, always skipped. */
const DEPRECATED_SECURITY_AREAS_TIPO = 'dd249';

/** One related_list column ddo (PHP build_legacy_ddo_map in a section caller's mode). */
export interface RelatedListDdo {
	typo: 'ddo';
	tipo: string;
	/** The pointing section the column is read on (scalar — legacy implicit shape). */
	section_tipo: string;
	/** The section itself here; a consumer re-parents it (relation_index: the index tipo). */
	parent: string;
	mode: typeof RELATED_LIST_MODE;
	model: string;
	label: string | null;
	/** Only when the column node declares one (PHP get_view's own-properties branch). */
	view?: string;
}

const relationListTiposCache = createOntologyCache<string, string[]>();

/** Drop the ontology-derived relation_list column-tipos cache. */
export function clearRelatedListCache(): void {
	relationListTiposCache.clear();
}
registerOntologyCacheClearer(clearRelatedListCache);

/**
 * The section's relation_list column tipos, verbatim (ontology order): the
 * relation_list child found by THE one lookup, findSectionChildByModel — own
 * node first, then the VIRTUAL section's real one (T0-7), first by
 * order_number. No section_map scope here: that is the References grid's own
 * post-step (getRelationListColumns), never part of the section fact.
 */
export async function sectionRelationListTipos(sectionTipo: string): Promise<string[]> {
	const cached = relationListTiposCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	const node = await findSectionChildByModel(sectionTipo, 'relation_list');
	const tipos = (node?.relations ?? [])
		.map((link) => link.tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
	relationListTiposCache.set(sectionTipo, tipos);
	return tipos;
}

/** The tipos of `tipos` that may become a related_list column, with their models (clean step). */
async function columnCandidates(tipos: readonly string[]): Promise<Map<string, string>> {
	const candidates = new Map<string, string>();
	for (const tipo of tipos) {
		if (tipo === DEPRECATED_SECURITY_AREAS_TIPO || candidates.has(tipo)) continue;
		const model = await getModelByTipo(tipo);
		if (model === null || NEVER_A_RELATED_COLUMN_MODELS.has(model)) continue;
		candidates.set(tipo, model);
	}
	return candidates;
}

/**
 * THE clean step on any declared column list (ontology order kept, duplicates
 * dropped): the tipos that may become a related_list / References column —
 * never a section node, the exclude_elements marker, dd249, a label node or an
 * unresolvable tipo. The References grid's column list
 * (resolve/relation_list.ts getRelationListColumns) runs its declared tipos —
 * relation_list node or section_map scope — through it, so the grid and the
 * relation_index columns cannot disagree on what a column is (T2-REL-1).
 */
export async function cleanRelatedColumnTipos(tipos: readonly string[]): Promise<string[]> {
	return [...(await columnCandidates(tipos)).keys()];
}

/**
 * The section's related_list COLUMN tipos with their models, principal-free
 * (the clean step only, ontology order) — the per-locator children of a
 * config-less component_relation_index in the export / flat reader
 * (relations/config_children.ts, tagged implicit), whose consumers filter per
 * call with the SAME predicate authorizedColumns applies below: the export
 * through its frontier, the interactive flat reader through
 * filterAuthorizedRelated (resolve/relation_list.ts readableChildren).
 */
export async function sectionRelatedListColumns(
	sectionTipo: string,
): Promise<{ tipo: string; model: string }[]> {
	const candidates = await columnCandidates(await sectionRelationListTipos(sectionTipo));
	return [...candidates].map(([tipo, model]) => ({ tipo, model }));
}

/**
 * PHP STEP 5 filter_authorized_related: the columns the CURRENT principal may
 * read on the pointing section — the very predicate the implicit builders
 * apply (implicit.ts filterAuthorizedRelated, the frontier key). No principal
 * (an internal resolution) = no filter, as there.
 */
async function authorizedColumns(
	sectionTipo: string,
	tipos: readonly string[],
): Promise<Set<string>> {
	const { filterAuthorizedRelated } = await import('../relations/request_config/implicit.ts');
	return filterAuthorizedRelated([...tipos], sectionTipo);
}

/** A column node's OWN declared view, or undefined (the ddo then carries none, as PHP's). */
async function declaredViewOf(tipo: string): Promise<string | undefined> {
	const view = ((await getNode(tipo))?.properties as { view?: unknown } | null)?.view;
	return typeof view === 'string' && view !== '' ? view : undefined;
}

/**
 * The pointing section's related_list ddo map for the current viewer (module
 * header): one ddo per authorised relation_list column, parented to the
 * section itself, in ontology order. A section with no relation_list (own or
 * real) answers [].
 */
export async function sectionRelatedListConfig(sectionTipo: string): Promise<RelatedListDdo[]> {
	const candidates = await columnCandidates(await sectionRelationListTipos(sectionTipo));
	if (candidates.size === 0) return [];
	const authorized = await authorizedColumns(sectionTipo, [...candidates.keys()]);
	const ddoMap: RelatedListDdo[] = [];
	for (const [tipo, model] of candidates) {
		if (!authorized.has(tipo)) continue;
		const ddo: RelatedListDdo = {
			typo: 'ddo',
			tipo,
			section_tipo: sectionTipo,
			parent: sectionTipo,
			mode: RELATED_LIST_MODE,
			model,
			label: await labelByTipo(tipo),
		};
		const view = await declaredViewOf(tipo);
		if (view !== undefined) ddo.view = view;
		ddoMap.push(ddo);
	}
	return ddoMap;
}
