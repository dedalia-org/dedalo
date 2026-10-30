/**
 * THE DECLARED COMPONENTS OF A SECTION — the ONE census shared by the record
 * WIPE (delete_record.ts deleteSectionData: every component it may empty) and
 * the covered-slot RESTORE (section_record/record_write.ts
 * requestCoveredSlotRecompute: every covered observer slot it must recompute).
 * Two censuses drifted: the restore walked the own subtree without crossing
 * nested sections and fell back to the real section only when the own subtree
 * held NO component, while the wipe crossed them — so a slot the wipe emptied
 * could be one the restore never recomputed (left wiped-empty until a
 * reconcile). One function, so they cannot diverge again.
 *
 * THE SET: the section's own component subtree ∪ its REAL section's
 * (getSectionRealTipo — a virtual section's records store the real section's
 * components even when the virtual one declares a component of its own), each
 * walk CROSSING nested section/area nodes (PHP delete_data empties every
 * declared component key of the record). Deduplicated by tipo, own first, in
 * ontology order.
 *
 * A TLD ROOT `<tld>0` (section_id part '0' — an ontology main section, whose
 * records live in matrix_ontology and store the ontology-record components of
 * its REAL section) contributes ONLY its real section: its own dd_ontology
 * subtree is the TLD's node tree, not the structure of its records. Without
 * this, a root that parents a content section (the suite fixture's
 * `testcoincatalog0` → `testcoincatalog1`) "declared" every component of every
 * section of the TLD, and the host predicate made ontology records hosts of
 * content mirrors (the reconciler swept them; the kernel accepted them).
 */

import { getOrderedSubtree, getSectionRealTipo } from '../../ontology/resolver.ts';
import { getSectionIdFromTipo } from '../../ontology/tld.ts';

/** One declared component: its tipo and model. */
export interface DeclaredComponent {
	tipo: string;
	model: string;
}

/** Every component a record of `sectionTipo` may store (see the header). */
export async function declaredSectionComponents(sectionTipo: string): Promise<DeclaredComponent[]> {
	const roots = getSectionIdFromTipo(sectionTipo) === '0' ? [] : [sectionTipo];
	const realTipo = await getSectionRealTipo(sectionTipo);
	if (realTipo !== sectionTipo) roots.push(realTipo);
	const seen = new Set<string>();
	const components: DeclaredComponent[] = [];
	for (const root of roots) {
		for (const node of await getOrderedSubtree(root, { crossSections: true })) {
			if (node.model?.startsWith('component') !== true || seen.has(node.tipo)) continue;
			seen.add(node.tipo);
			components.push({ tipo: node.tipo, model: node.model });
		}
	}
	return components;
}
