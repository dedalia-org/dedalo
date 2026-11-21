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

import { findFirstChildByModel, getSectionRealTipo } from '../../ontology/resolver.ts';

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
 * - FIRST IN SIBLING ORDER (ontology/resolver.ts findFirstChildByModel — the
 *   one ordered primitive: order_number, NULL last, tipo) — sections with
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
	let node = await findFirstChildByModel(sectionTipo, model);
	if (node === null) {
		// virtual section: borrow the REAL section's definition (the one law,
		// getSectionRealTipo — a matrix_table at relations[0] is NOT a real section).
		const real = await getSectionRealTipo(sectionTipo);
		if (real !== sectionTipo) node = await findFirstChildByModel(real, model);
	}
	return node;
}
