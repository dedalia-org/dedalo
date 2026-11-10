/**
 * List-definition node lookup (SECTION_SPEC §2, §7): find the first-level
 * section child of a given model, virtual-aware. Every list-definition
 * (section_list, relation_list, indexation_list, time_machine_list,
 * section_list_thesaurus) and the section_map marker are located this way —
 * PHP section::get_ar_children_tipo_by_model_name_in_section with
 * resolve_virtual=true (class.section.php:868).
 *
 * A VIRTUAL section (its 'section'-model relation → the real section) inherits
 * the real section's definition nodes.
 */

import { sql } from '../../db/postgres.ts';
import { getSectionRealTipo } from '../../ontology/resolver.ts';

/** A located definition node (its tipo + raw properties + relations). */
export interface ListDefinitionNode {
	tipo: string;
	properties: Record<string, unknown> | null;
	relations: { tipo?: unknown }[] | null;
}

/**
 * Find the first-level child of `sectionTipo` whose ontology model is `model`,
 * resolving through the real section when `sectionTipo` is virtual. Returns null
 * when the section declares no such definition node.
 *
 * - Own node FIRST: a virtual that declares its own node keeps it (even with
 *   null relations); only an ABSENT own node falls back to the real section's.
 * - FIRST BY order_number (PHP ontology_node::get_ar_children_of_this order;
 *   `tipo` breaks ties so the pick never depends on heap order) — sections with
 *   several nodes of one model exist (tch546: two relation_list, two
 *   time_machine_list).
 * - `exclude_elements` is NOT applied. For relation_list that is an owner
 *   decision (T0-7 D1, 2026-11-10): relation_list defines what a CALLER section
 *   shows of itself in the inspector, not an edit-form child, so a virtual's
 *   exclusions never remove it. Gate: relation_list_virtual_lookup_native.
 *
 * The ONE lookup for these nodes — relation_list consumers
 * (getRelationListColumns, sectionRelationListTipo, getRelatedListChildTipos)
 * keep only their own post-step and cache on top of it.
 */
export async function findSectionChildByModel(
	sectionTipo: string,
	model: string,
): Promise<ListDefinitionNode | null> {
	const read = async (parent: string) =>
		(await sql.unsafe(
			`SELECT tipo, properties, relations FROM dd_ontology
			 WHERE parent = $1 AND model = $2
			 ORDER BY order_number ASC NULLS LAST, tipo ASC
			 LIMIT 1`,
			[parent, model],
		)) as ListDefinitionNode[];
	let rows = await read(sectionTipo);
	if (rows.length === 0) {
		// virtual section: borrow the REAL section's definition (the one law,
		// getSectionRealTipo — a matrix_table at relations[0] is NOT a real section).
		const real = await getSectionRealTipo(sectionTipo);
		if (real !== sectionTipo) rows = await read(real);
	}
	return rows[0] ?? null;
}
