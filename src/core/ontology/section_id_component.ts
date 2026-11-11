/**
 * The component_section_id child of a section's ontology subtree (PHP
 * get_ar_children_tipo_by_model_name_in_section with recursion) — the id
 * column component (request_config filters resolve a term's id through it).
 */

import { createOntologyCache } from './cache_factory.ts';
import { registerOntologyCacheClearer } from './cache_invalidation.ts';
import { findFirstDescendantTipoByModel } from './resolver.ts';

const cache = createOntologyCache<string, string | null>();

/** Drop the component_section_id lookup cache. */
export function clearSectionIdComponentCache(): void {
	cache.clear();
}
registerOntologyCacheClearer(clearSectionIdComponentCache);

export async function getSectionIdComponentTipo(sectionTipo: string): Promise<string | null> {
	const cached = cache.get(sectionTipo);
	if (cached !== undefined) return cached;
	// Canonical T3 accessor (audit S2-19). Strict own-subtree semantics: a
	// virtual section has no own id component and resolves to null, exactly
	// like the hand-rolled walk this replaced.
	const result = await findFirstDescendantTipoByModel(sectionTipo, 'component_section_id', {
		virtualFallback: false,
	});
	cache.set(sectionTipo, result);
	return result;
}
