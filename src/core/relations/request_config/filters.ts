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

import { memoizedReadMatrixRecord } from '../../db/record_memo.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo, getNode } from '../../ontology/resolver.ts';
import { readComponentItems } from '../../resolve/component_data.ts';

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
			permissions: 3,
			addRequestConfig: false, // PHP simple context omits request_config
		});

		const { getDatalist } = await import('../datalist.ts');
		const node = await getNode(componentTipo);
		const datalist = await getDatalist(componentTipo, node?.properties ?? null, sectionTipo, lang);

		expanded.push({ context, datalist });
	}
	return expanded;
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
						ddo_map?: { tipo?: string; parent?: string; section_tipo?: string; last?: boolean }[];
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
					const resolveDdo = ddoMap.find((ddo) => ddo.tipo === value.q);
					if (resolveDdo !== undefined) resolveDdo.last = true;

					const componentData =
						initDdo !== undefined
							? await resolveComponentDataRecursively(ddoMap, initDdo, {
									section_tipo: callerSectionTipo,
									section_id: callerSectionId,
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
 * Walk a ddo_map chain depth-first, reading each component's stored data and
 * passing the result locators as context to the next level (PHP
 * resolve_component_data_recursively :3171). The ddo marked `last` is the
 * leaf — its data returns directly; non-leaf ddos fan out into their
 * recursive descendants, merging results in order.
 */
async function resolveComponentDataRecursively(
	ddoMap: { tipo?: string; parent?: string; last?: boolean; fn?: string; data_fn?: string }[],
	current: { tipo?: string; last?: boolean; fn?: string; data_fn?: string },
	// KEPT UNION: the walk cursor is fed by the previous level's STORED locator
	// (see the fan-out below) — unswept string ids and external remote ids both
	// reach here; the value is only ever Number()'d for the row read.
	data: { section_tipo: string; section_id: number | string | null },
): Promise<unknown[]> {
	const tipo = current.tipo;
	if (typeof tipo !== 'string' || data.section_id === null || data.section_id === undefined) {
		return [];
	}
	const fn = current.fn ?? current.data_fn;
	if (fn !== undefined) {
		// PHP dispatches fn 'get_calculation_data'; no live fixed_filter uses it.
		throw new DedaloError('engine.uncovered_scope', {
			message: `resolveComponentDataRecursively: fn '${fn}' is not implemented (uncovered scope)`,
			coordinates: { fn: String(fn) },
		});
	}
	const model = await getModelByTipo(tipo);
	if (model === null) return [];
	const table = await getMatrixTableFromTipo(data.section_tipo);
	if (table === null) return [];
	const record = await memoizedReadMatrixRecord(table, data.section_tipo, Number(data.section_id));
	if (record === null) return [];
	const componentData = readComponentItems(record, tipo, model) ?? [];
	if (componentData.length === 0) return [];

	if (current.last === true) {
		return componentData;
	}

	// Fan out into the ddo's recursive descendants (PHP get_ddo_children_recursive).
	const children = collectDdoDescendants(ddoMap, tipo);
	const merged: unknown[] = [];
	for (const element of componentData) {
		// KEPT UNION: raw stored component element (unswept legacy string form /
		// external remote id) passed on as the next level's read cursor.
		const target = element as { section_tipo?: string; section_id?: number | string } | null;
		if (typeof target?.section_tipo !== 'string' || target.section_id === undefined) continue;
		for (const childDdo of children) {
			const result = await resolveComponentDataRecursively(ddoMap, childDdo, {
				section_tipo: target.section_tipo,
				section_id: target.section_id,
			});
			merged.push(...result);
		}
	}
	return merged;
}

/** All recursive descendants of a ddo in the flat map, pre-order (PHP :3238). */
function collectDdoDescendants(
	ddoMap: { tipo?: string; parent?: string; last?: boolean }[],
	parentTipo: string,
): { tipo?: string; parent?: string; last?: boolean }[] {
	const descendants: { tipo?: string; parent?: string; last?: boolean }[] = [];
	for (const ddo of ddoMap) {
		if (ddo.parent === parentTipo && typeof ddo.tipo === 'string') {
			descendants.push(ddo);
			descendants.push(...collectDdoDescendants(ddoMap, ddo.tipo));
		}
	}
	return descendants;
}
