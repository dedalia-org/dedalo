/**
 * THE DECLARED COMPONENTS OF A SECTION — the ONE census, with the record
 * WIPE's scope derived from it in this module. Two questions, one walk:
 *   - declaredSectionComponents: "may a record of this section STORE / HOST
 *     it" — the covered-slot RESTORE (section_record/record_write.ts
 *     requestCoveredSlotRecompute: every covered observer slot it must
 *     recompute) and the observer host predicate read it;
 *   - wipeScopeComponents: "what does delete_data EMPTY" (delete_record.ts
 *     deleteSectionData) — the census MINUS a virtual section's
 *     exclude_elements subtrees (ontology/virtual_scope.ts; PHP delete_data
 *     resolves the virtual and subtracts its first exclude_elements child,
 *     class.section.php:900-987). Filtered from the SAME walk, so
 *     wipe ⊆ census holds by construction: every slot the wipe empties is one
 *     the restore recomputes.
 * Two censuses drifted once: the restore walked the own subtree without
 * crossing nested sections and fell back to the real section only when the own
 * subtree held NO component, while the wipe crossed them — so a slot the wipe
 * emptied could be one the restore never recomputed (left wiped-empty until a
 * reconcile). One walk, so they cannot diverge again.
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

import {
	getOrderedSubtree,
	getSectionRealTipo,
	type OntologySubtreeNode,
} from '../../ontology/resolver.ts';
import { getSectionIdFromTipo } from '../../ontology/tld.ts';
import { pruneExcludedSubtrees, resolveVirtualEditScope } from '../../ontology/virtual_scope.ts';

/** One declared component: its tipo and model. */
export interface DeclaredComponent {
	tipo: string;
	model: string;
}

/**
 * The subtree roots a section's declared components are walked from: its own
 * tipo (unless it is a TLD ROOT `<tld>0`, see the header) and, when it is
 * virtual, its real section.
 */
async function declarationRoots(sectionTipo: string): Promise<string[]> {
	const roots = getSectionIdFromTipo(sectionTipo) === '0' ? [] : [sectionTipo];
	const realTipo = await getSectionRealTipo(sectionTipo);
	if (realTipo !== sectionTipo) roots.push(realTipo);
	return roots;
}

/** A subtree node that is a component (its model names a component family). */
function isComponentNode(node: { model?: string | null }): boolean {
	return node.model?.startsWith('component') === true;
}

/**
 * The census walk: every root's subtree (crossing nested sections), each passed
 * through `prune` first. Own subtree first, real second: the first walk to
 * reach a tipo keeps it.
 */
async function walkDeclaredComponents(
	sectionTipo: string,
	prune: (nodes: OntologySubtreeNode[]) => OntologySubtreeNode[],
): Promise<DeclaredComponent[]> {
	const seen = new Set<string>();
	const components: DeclaredComponent[] = [];
	for (const root of await declarationRoots(sectionTipo)) {
		for (const node of prune(await getOrderedSubtree(root, { crossSections: true }))) {
			if (!isComponentNode(node) || seen.has(node.tipo)) continue;
			seen.add(node.tipo);
			components.push({ tipo: node.tipo, model: node.model as string });
		}
	}
	return components;
}

/** Every component a record of `sectionTipo` may store (see the header). */
export async function declaredSectionComponents(sectionTipo: string): Promise<DeclaredComponent[]> {
	return walkDeclaredComponents(sectionTipo, (nodes) => nodes);
}

/**
 * What delete_data EMPTIES on a record of `sectionTipo` (see the header): the
 * census minus the subtrees a virtual section's FIRST exclude_elements child
 * names. `excluded` = every pruned tipo (the excluded ones and their
 * descendants: an excluded grouper's components, an excluded main's slots) —
 * the wipe keeps an excluded main's frames wherever they are stored. A real
 * section (and a `<tld>0` root) excludes nothing: its scope IS its census.
 */
export async function wipeScopeComponents(
	sectionTipo: string,
): Promise<{ components: DeclaredComponent[]; excluded: ReadonlySet<string> }> {
	const { excludeSet } = await resolveVirtualEditScope(sectionTipo);
	const excluded = new Set<string>();
	const components = await walkDeclaredComponents(sectionTipo, (nodes) => {
		const { kept, pruned } = pruneExcludedSubtrees(nodes, excludeSet);
		for (const tipo of pruned) excluded.add(tipo);
		return kept;
	});
	return { components, excluded };
}
