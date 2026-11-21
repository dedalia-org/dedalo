/**
 * SECTION_MAP access (PHP section::get_section_map + class.section_map.php):
 * every section may declare a 'section_map' ontology child whose properties
 * name its FUNCTIONAL components per scope — e.g. {thesaurus: {term: 'es16',
 * parent: 'es48'}, relation_list: {...}}. Consumers resolve "the term
 * component of section X" without hardcoding tipos.
 *
 * Scope lookups fall back through SCOPE_FALLBACK (main → thesaurus →
 * relation_list) when the requested scope has no value — a section declaring
 * only 'main' still answers a 'thesaurus.term' query (PHP
 * section_map::get_element_tipo).
 *
 * Virtual sections (ontology aliases) resolve through their real section
 * (getSectionRealTipo).
 */

import { createOntologyCache } from './cache_factory.ts';
import { registerOntologyCacheClearer } from './cache_invalidation.ts';
import { findFirstChildByModel, getSectionRealTipo } from './resolver.ts';

/** PHP section_map::SCOPE_FALLBACK chain. */
export const SCOPE_FALLBACK = ['main', 'thesaurus', 'relation_list'];

const sectionMapCache = createOntologyCache<string, Record<string, unknown> | null>();

/** Drop the section_map properties cache. */
export function clearSectionMapCache(): void {
	sectionMapCache.clear();
}
registerOntologyCacheClearer(clearSectionMapCache);

/** section::get_section_map — the section_map child node's properties (virtual-aware). */
export async function getSectionMap(sectionTipo: string): Promise<Record<string, unknown> | null> {
	const cached = sectionMapCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	// The FIRST section_map child in sibling order (findFirstChildByModel): a
	// section may hold two, and an unordered pick answered either.
	let node = await findFirstChildByModel(sectionTipo, 'section_map');
	if (node === null) {
		// virtual section: borrow the REAL section's map (the one law,
		// getSectionRealTipo — a matrix_table at relations[0] is NOT a real section)
		const real = await getSectionRealTipo(sectionTipo);
		if (real !== sectionTipo) node = await findFirstChildByModel(real, 'section_map');
	}
	const map = node?.properties ?? null;
	sectionMapCache.set(sectionTipo, map);
	return map;
}

/** section_map::get_element_tipo — per-key scope chain walk. */
export async function getSectionMapValue(
	sectionTipo: string,
	scope: string,
	key: string,
): Promise<unknown> {
	const map = await getSectionMap(sectionTipo);
	if (map === null) return null;
	const direct = (map[scope] as Record<string, unknown> | undefined)?.[key];
	if (direct !== undefined && direct !== null && direct !== '') return direct;
	for (const candidate of [scope, ...SCOPE_FALLBACK]) {
		const node = map[candidate];
		if (node !== null && typeof node === 'object' && key in (node as Record<string, unknown>)) {
			return (node as Record<string, unknown>)[key];
		}
	}
	return null;
}

/**
 * The FIRST TIPO a section_map role names (scope chain as getSectionMapValue).
 * A role is either one tipo (`"term": "es16"`) or a list of them
 * (`"term": ["hierarchy25", "hierarchy90"]`): a consumer that needs ONE
 * component — the name of a root term, the term a tree row is labelled by —
 * reads the first. Null when the role is absent, empty, or names no tipo.
 */
export async function getSectionMapFirstTipo(
	sectionTipo: string,
	scope: string,
	key: string,
): Promise<string | null> {
	const value = await getSectionMapValue(sectionTipo, scope, key);
	const first = Array.isArray(value) ? value[0] : value;
	return typeof first === 'string' && first !== '' ? first : null;
}

/**
 * Does this section declare a per-term selectability contract? THE predicate —
 * one definition, every call site, because the two that matter used to answer
 * differently and the disagreement was user-visible.
 *
 * The precondition is `isIndexable`'s own (ts_object.ts): the section_map's
 * `thesaurus.is_indexable` must NAME a component tipo. `false`, `''`, `null`
 * and absent all mean the same thing — this section has no selectable-term
 * flag — which is the ordinary case for every non-thesaurus target (rsc197,
 * People, is one).
 *
 * WHY IT IS SHARED. `relations/save.ts` gate 3 reads it to EXEMPT such a
 * target: no contract, nothing to re-ask, the pick is authorized. `section/
 * read.ts` reads it to tell the client the same thing, so the pick ARROW is
 * drawn on exactly the rows the write door would accept. Before this was one
 * function the read simply stayed silent, the client's `term_selectability`
 * read that silence as UNKNOWN, and a People row the server would have linked
 * happily offered the operator no affordance at all. An affordance must not be
 * offered on a guess — but withholding one on a guess is the same defect.
 *
 * NOT the scope-fallback walk: `thesaurus` is the only scope that carries this
 * key, exactly as `isIndexable` reads it.
 */
export async function declaresTermSelectability(sectionTipo: string): Promise<boolean> {
	const declared = (
		(await getSectionMap(sectionTipo))?.thesaurus as { is_indexable?: unknown } | undefined
	)?.is_indexable;
	return typeof declared === 'string' && declared !== '';
}
