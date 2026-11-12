/**
 * THE VIRTUAL EDIT SCOPE — the one home of the exclude_elements law.
 *
 * A virtual section (getSectionRealTipo names a real section: `rsc170` → `rsc2`,
 * `es1` → `hierarchy20`) shows its REAL section's elements MINUS the tipos its
 * FIRST `exclude_elements` child (by order) names in `relations` — PHP
 * get_ar_children_tipo_by_model_name_in_section with resolve_virtual=true,
 * class.section.php:897-987 (PHP reads exclude_elements[0] only). An excluded
 * tipo is skipped AND its whole subtree pruned (excluding a grouper drops its
 * children; excluding a main drops its dataframe slots — stricter than PHP,
 * which expanded only groupers and so tore an excluded main from its frames).
 *
 * Consumers: the implicit edit config (relations/request_config/implicit.ts),
 * the section elements context, the birth defaults (record_defaults.ts), the
 * record wipe scope (section/record/declared_components.ts wipeScopeComponents),
 * tool_posterframe and tool_import_dedalo_csv. Ontology-layer on purpose: it
 * depends only on the kernel and the resolver, so no consumer needs an import
 * seam to reach it.
 *
 * Not cached: one dd_ontology SELECT per call, so an exclude_elements edit takes
 * effect on the next call.
 */

import { sql } from '../db/postgres.ts';
import { getOrderedSubtree, getSectionRealTipo, type OntologySubtreeNode } from './resolver.ts';

/**
 * Resolve a section tipo to its REAL section (for virtual sections) plus the set
 * of tipos its first exclude_elements child names. Real (non-virtual) sections
 * resolve to themselves with an empty exclude set.
 */
export async function resolveVirtualEditScope(
	sectionTipo: string,
): Promise<{ realTipo: string; excludeSet: Set<string> }> {
	const excludeSet = new Set<string>();
	// The ONE virtual→real law (getSectionRealTipo: the first relation of model
	// 'section', identity for a real section).
	const candidate = await getSectionRealTipo(sectionTipo);
	if (candidate === sectionTipo) {
		return { realTipo: sectionTipo, excludeSet };
	}
	// The FIRST exclude_elements child (by order) of the VIRTUAL section names
	// the excluded tipos in its `relations` (PHP uses [0] only).
	const exRows = (await sql`
		SELECT relations FROM dd_ontology
		WHERE parent = ${sectionTipo} AND model = 'exclude_elements'
		ORDER BY order_number NULLS LAST, id LIMIT 1
	`) as { relations: { tipo?: unknown }[] | null }[];
	for (const rel of exRows[0]?.relations ?? []) {
		if (typeof rel?.tipo === 'string') excludeSet.add(rel.tipo);
	}
	return { realTipo: candidate, excludeSet };
}

/**
 * Drop every excluded node AND its subtree from a DFS PRE-ORDER node list (a
 * node's parent is always seen before it, so one pass prunes whole subtrees).
 * `pruned` names every dropped tipo — the excluded ones and their descendants.
 */
export function pruneExcludedSubtrees<T extends { tipo: string; parent: string | null }>(
	nodes: readonly T[],
	excludeSet: ReadonlySet<string>,
): { kept: T[]; pruned: Set<string> } {
	const pruned = new Set<string>();
	const kept: T[] = [];
	for (const node of nodes) {
		if (excludeSet.has(node.tipo) || (node.parent !== null && pruned.has(node.parent))) {
			pruned.add(node.tipo);
			continue;
		}
		kept.push(node);
	}
	return { kept, pruned };
}

/**
 * The VIRTUAL EDIT SCOPE's component nodes — what the edit form of
 * `sectionTipo` shows: the REAL section's subtree (DFS pre-order,
 * getOrderedSubtree containment — nested sections/areas are not crossed) MINUS
 * the virtual's FIRST exclude_elements subtrees. A virtual's own children are
 * never part of it. Full nodes, properties included.
 */
export async function editScopeComponents(sectionTipo: string): Promise<OntologySubtreeNode[]> {
	const { realTipo, excludeSet } = await resolveVirtualEditScope(sectionTipo);
	const { kept } = pruneExcludedSubtrees(await getOrderedSubtree(realTipo), excludeSet);
	return kept.filter((node) => node.model?.startsWith('component') === true);
}
