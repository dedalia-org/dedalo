/**
 * request_config SQO FILTER EXPANSION (RELATIONS_SPEC.md §4) — the two
 * declarative sqo entries a relation config may carry, resolved at build
 * time into their live values:
 *
 * - `filter_by_list`: the autocomplete search-panel pre-filter fields. Each
 *   descriptor {section_tipo, component_tipo} expands to the component's
 *   SIMPLE context + its full datalist (list of selectable option values) so
 *   the client can render a filter dropdown. PHP
 *   component_relation_common::get_filter_list_data (:2375).
 *
 * - `fixed_filter`: SQO filter clauses pre-applied to every search this
 *   config executes. Three source types (PHP get_fixed_filter :2948):
 *     'fixed_dato'      embedded SQO filter objects, each validated against
 *                       the installed ontology (missing tipo → skipped);
 *     'component_data'  the search value resolves from live component data
 *                       reached through a ddo_map chain from the calling
 *                       record (multi-hop; rsc1214 is the live user);
 *     'hierarchy_terms' section_id IN-filters from a thesaurus subtree
 *                       (children flat or recursive via relations/children.ts;
 *                       the single live user is the test-bench portal test64).
 *
 * CACHING (the PHP use_cache=false rule): both expansions read LIVE record
 * data with no invalidation signal — PHP refuses to cache any request_config
 * carrying them. The TS build path recomputes per structure-context build
 * (no config-level cache exists), and the datalist behind filter_by_list has
 * its own explicitly-flushable cache; callers must never memoize a parsed
 * config item whose sqo carries either key.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';
import { getNode } from '../../ontology/resolver.ts';
import type { Principal } from '../../security/permissions.ts';
import {
	ddoFunctionName,
	readStoredComponentData,
	type WalkDdo,
	type WalkReader,
	walkComponentData,
} from '../component_data_walk.ts';

/**
 * The most ids ONE `hierarchy_terms` fixed_filter term may expand to.
 *
 * ARITHMETIC. The expansion becomes a single bound `integer[]` parameter, and
 * a picker's filter is a NARROWING device: a term whose subtree runs past
 * 50,000 records is not narrowing anything — it names a root where the author
 * meant a branch. 50,000 is well above every real branch a fixed_filter points
 * at and well below the 200,000-node ceiling the walk itself refuses at
 * (`relations/children.ts` CHILDREN_RECURSIVE_MAX_NODES), so this cap reports
 * a config mistake while the walk's cap reports a runaway subtree. Fixed, not
 * configurable: a bound an install can move is not a bound.
 */
export const HIERARCHY_TERMS_MAX_IDS = 50000;

/**
 * REFUSE an over-cap `hierarchy_terms` expansion. Exported so the bound is
 * gateable as arithmetic: the 50,000-id case cannot be built as records, and a
 * cap enforced only inside a branch no test can reach is not enforced.
 */
export function assertHierarchyTermsWithinCap(
	expanded: number,
	sectionTipo: string,
	sectionId: number,
): void {
	if (expanded <= HIERARCHY_TERMS_MAX_IDS) return;
	throw new DedaloError('ontology.invalid_node', {
		message:
			`fixed_filter hierarchy_terms: term ${sectionTipo}/${sectionId} expands to ${expanded} ` +
			`ids, past the ${HIERARCHY_TERMS_MAX_IDS} cap. Name a narrower term, or drop \`recursive\`.`,
		coordinates: { section_tipo: sectionTipo, section_id: sectionId },
	});
}

/** One filter_by_list descriptor as stored in the ontology. */
interface FilterByListDescriptor {
	section_tipo?: string;
	component_tipo?: string;
}

/**
 * Expand filter_by_list descriptors into {context, datalist} pairs (PHP
 * get_filter_list_data): context = the component's SIMPLE structure context
 * (no request_config — PHP context_type 'simple'), datalist = its full list
 * of option values in the request data lang.
 */
export async function expandFilterByList(
	descriptors: unknown,
	lang: string,
): Promise<{ context: unknown; datalist: unknown[] }[]> {
	const list = Array.isArray(descriptors) ? (descriptors as FilterByListDescriptor[]) : [];
	const expanded: { context: unknown; datalist: unknown[] }[] = [];
	for (const descriptor of list) {
		const componentTipo = descriptor?.component_tipo;
		const sectionTipo = descriptor?.section_tipo;
		if (typeof componentTipo !== 'string' || typeof sectionTipo !== 'string') continue;

		const { buildStructureContext } = await import('../../resolve/structure_context.ts');
		const context = await buildStructureContext({
			configFrom: { source: 'own', reason: 'search-panel-element' },
			tipo: componentTipo,
			sectionTipo,
			mode: 'edit',
			lang,
			...(await filterFieldPermissions(sectionTipo, componentTipo)),
			addRequestConfig: false, // PHP simple context omits request_config
		});

		// No owner RECORD: a search-panel filter field lists the vocabulary, not
		// one record's options. The principal scopes it inside getDatalist.
		const { getDatalist } = await import('../datalist.ts');
		const node = await getNode(componentTipo);
		const datalist = await getDatalist(
			componentTipo,
			node?.properties ?? null,
			{ section_tipo: sectionTipo, section_id: null },
			lang,
		);

		expanded.push({ context, datalist });
	}
	return expanded;
}

/**
 * A filter field's simple-context permissions: the CALLER's real level (PHP
 * builds the context through the component instance, get_permissions), not a
 * hard-coded 3 — and the principal, so the context's own principal-gated parts
 * match (the search panel's precedent, resolve/section_elements_context.ts).
 * No request principal (an internal build) keeps the old full level.
 */
async function filterFieldPermissions(
	sectionTipo: string,
	componentTipo: string,
): Promise<{ permissions: number; principal?: Principal }> {
	const { currentPrincipal } = await import('../../security/request_context.ts');
	const principal = currentPrincipal();
	if (principal === undefined) return { permissions: 3 };
	const { getPermissions } = await import('../../security/permissions.ts');
	return { permissions: await getPermissions(principal, sectionTipo, componentTipo), principal };
}

/** One fixed_filter descriptor as stored in the ontology. */
interface FixedFilterDescriptor {
	source?: string;
	operator?: string;
	value?: unknown[];
}

/**
 * Expand fixed_filter descriptors into SQO filter clause groups (PHP
 * get_fixed_filter): each group wraps its resolved items in
 * {<operator>: [...]} (default '$or') and only non-empty groups survive.
 */
export async function expandFixedFilter(
	descriptors: unknown,
	callerSectionTipo: string,
	callerSectionId: number | string | null,
): Promise<Record<string, unknown[]>[]> {
	const list = Array.isArray(descriptors) ? (descriptors as FixedFilterDescriptor[]) : [];
	const groups: Record<string, unknown[]>[] = [];

	for (const descriptor of list) {
		const operator = descriptor?.operator ?? '$or';
		const source = descriptor?.source;
		const items: unknown[] = [];

		switch (source) {
			case 'fixed_dato': {
				// Embedded SQO filter objects; skip entries whose last path tipo is
				// not installed (PHP check_active_tld — a tipo cannot exist without
				// its TLD installed, so node existence is the equivalent gate).
				// PHP ontology_utils::check_active_tld:271 allowlists the PSEUDO
				// tipo 'section_id' (SQO paths address the record id through it —
				// the rsc80 state-vocabulary filter is the live user).
				for (const object of descriptor.value ?? []) {
					const path = (object as { path?: { component_tipo?: string }[] } | null)?.path;
					const lastPath = Array.isArray(path) ? path[path.length - 1] : undefined;
					const lastTipo = lastPath?.component_tipo;
					if (
						typeof lastTipo === 'string' &&
						lastTipo !== 'section_id' &&
						(await getNode(lastTipo)) === null
					) {
						continue; // PHP: WARNING + skip
					}
					items.push(object);
				}
				break;
			}

			case 'component_data': {
				for (const rawValue of descriptor.value ?? []) {
					const value = rawValue as {
						q?: string;
						path?: unknown[];
						ddo_map?: WalkDdo[];
						q_operator?: unknown;
						search_section_id?: boolean;
						use_from_component_tipo?: boolean;
					} | null;
					if (value === null || typeof value?.q !== 'string') continue;

					// A missing ddo_map means the data component lives in the CALLING
					// section (PHP :3055-3061).
					const ddoMap =
						value.ddo_map ??
						([
							{ tipo: value.q, parent: callerSectionTipo, section_tipo: callerSectionTipo },
						] as NonNullable<typeof value.ddo_map>);
					const initDdo = ddoMap.find(
						(ddo) => ddo.parent === 'self' || ddo.parent === callerSectionTipo,
					);
					// The leaf is the first ddo naming `q` — passed to the walker, never
					// written onto the (cached, ontology-owned) ddo as PHP's `last`.
					const leafDdo = ddoMap.find((ddo) => ddo.tipo === value.q);

					const componentData =
						initDdo !== undefined && callerSectionId !== null
							? await walkComponentData({
									ddoMap,
									start: initDdo,
									leaf: leafDdo,
									address: { section_tipo: callerSectionTipo, section_id: callerSectionId },
									read: fixedFilterReader,
								})
							: [];

					if (value.search_section_id === true) {
						// Join the resolved locators' section_ids for an IN-style lookup
						// (PHP :3092-3108) — emitted even when empty (q '').
						const joined = componentData
							.map((entry) => (entry as { section_id?: unknown } | null)?.section_id)
							.filter((id) => id !== undefined && id !== null)
							.join(',');
						items.push({ q: joined, path: value.path });
					} else {
						for (const entry of componentData) {
							const searchData = { ...(entry as Record<string, unknown>) };
							if (value.use_from_component_tipo === false) {
								// biome-ignore lint/performance/noDelete: PHP unset — the key must be ABSENT in the emitted filter
								delete searchData.from_component_tipo;
							}
							items.push({ q: searchData, path: value.path });
						}
					}
				}
				break;
			}

			case 'hierarchy_terms': {
				// Thesaurus-subtree filters (PHP get_hierarchy_terms_filter :2431):
				// each term expands to its children (flat or recursive) and becomes
				// ONE filter item {q: 'id1,id2,…', path: [the section_id path]}.
				const { getChildren, getChildrenRecursive } = await import('../children.ts');
				const { getSectionIdComponentTipo } = await import(
					'../../ontology/section_id_component.ts'
				);
				for (const rawTerm of descriptor.value ?? []) {
					// KEPT UNION: `descriptor.value` is HAND-AUTHORED ontology config
					// (properties.fixed_filter), not swept matrix jsonb — a term id
					// written as "7" in dd_ontology is legitimate input here.
					const term = rawTerm as {
						section_id?: number | string;
						section_tipo?: string;
						recursive?: boolean;
					} | null;
					if (term === null || typeof term.section_tipo !== 'string') continue;
					const termId = term.section_id ?? 0;
					const children =
						term.recursive === true
							? await getChildrenRecursive(termId, term.section_tipo)
							: await getChildren(termId, term.section_tipo);
					// THE EXPANSION IS CAPPED. This filter becomes ONE `q` of joined
					// ids, bound downstream as `= ANY(_Q1_::integer[])`
					// (builder_section_id.ts), so it never reaches statement TEXT —
					// but it is still unbounded in SIZE, and a recursive term over a
					// whole thesaurus root turns a picker's filter into a
					// hundred-thousand-element array parameter. A fixed_filter is
					// HAND-AUTHORED ontology config, so an expansion past the cap is
					// a configuration error and says so (operator disclosure), never
					// a silent truncation to a filter that quietly matches less.
					assertHierarchyTermsWithinCap(children.length, term.section_tipo, Number(termId));
					const idComponent = await getSectionIdComponentTipo(term.section_tipo);
					items.push({
						q: children.map((child) => child.section_id).join(','),
						path: [
							{
								section_tipo: term.section_tipo,
								component_tipo: idComponent,
								model: 'component_section_id',
								name: 'Id',
							},
						],
					});
				}
				break;
			}

			default:
				throw new DedaloError('ontology.invalid_node', {
					message: `expandFixedFilter: unknown fixed_filter source '${source}'`,
					coordinates: { fixed_filter_source: String(source) },
				});
		}

		if (items.length > 0) {
			groups.push({ [operator]: items });
		}
	}

	return groups;
}

/**
 * The fixed_filter READ POLICY for the shared ddo_map walker
 * (relations/component_data_walk.ts): a plain ddo reads its stored data; an
 * `fn` / `data_fn` ddo (PHP dispatches get_calculation_data) is UNCOVERED here
 * — no live fixed_filter uses it, and a silent empty filter would match more
 * than the author meant.
 */
const fixedFilterReader: WalkReader = async (ddo, address) => {
	const fn = ddoFunctionName(ddo);
	if (fn !== undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `resolveComponentDataRecursively: fn '${fn}' is not implemented (uncovered scope)`,
			coordinates: { fn: String(fn) },
		});
	}
	return readStoredComponentData(ddo.tipo, address);
};
