/**
 * THE LOCATOR SOURCE of a relation component on one record (T0-9 §3.2) — the
 * ONE answer to "which locators does this component hold here?", keyed on the
 * descriptor's `resolveData` contract, never on a consumer's model list.
 *
 * Two families:
 *   - STORED — the RAW stored slice of the component's column, verbatim: holes
 *     and invalid entries keep their array position, because every export
 *     consumer stamps the RAW position as the segment `item_index` (PHP
 *     get_export_value iterates get_data() with its keys);
 *   - COMPUTED — models that store nothing under their tipo:
 *       component_relation_children → the inverse parent question
 *         (relations/children.ts getChildren, limit 0 = ALL, sibling order);
 *       component_relation_index    → the inverse index (resolveIndexConfig's
 *         relation type + pointing sections, findInverseReferenceLocators,
 *         parseInverseEntry — the read path's own engines, unpaginated).
 *
 * component_relation_related reads its STORED slice (owner decision D4,
 * re-opened 2026-11-11: PHP export calls get_data() = stored only; the inverse
 * closure is get_data_with_references(), which export never calls).
 *
 * CALCULATED (a SEPARATE question, never folded into the default source):
 * `calculatedLocators` — the relations a component_relation_related DERIVES
 * (PHP get_data_with_references() MINUS get_data(): the dd467 one inverse hop /
 * dd621 recursive closure of relations/related.ts, minus every stored locator
 * by the locator equality law on the target identity). Consumer: the export's
 * opt-in `#references` sibling column (per-ddo `value_with_references`).
 *
 * Consumers: the diffusion resolver's hop dispatch, the export walk's hops and
 * leaves (diffusion/resolve/resolver.ts resolveRecordAtoms), its fan-out
 * (diffusion/export/atoms.ts) and the flat reader (resolve/relation_list.ts
 * resolveRelationTargetValues — panel, Referencias, related labels). The
 * source does not AUTHORIZE reads and never filters a set: every export
 * consumer crosses each returned locator through its own frontier (T0-1)
 * before reading a byte of the target.
 *
 * relation_index (T0-9 D6, re-decided 2026-11-11 —
 * WC-2026-11-11-relation-index-related-list-context): EVERY reader gets EVERY
 * pointing locator, exactly as the edit form's entries/total do ("nobody points
 * at it" is a delete decision, so a hidden pointer would make it wrong). What
 * a requester may not see is the CONTENT of a pointer in a section it cannot
 * read: {@link pointingSectionReadable} is THE predicate, asked by the edit
 * form (models/relation_index.ts readableRelatedList) and by the shared
 * children seam (config_children.ts exportConfigChildren → address only) —
 * one function, so the two cannot drift.
 */

import { getFlatValueFamily, getResolveDataId } from '../components/registry.ts';
import type { RelationResolverId } from '../components/types.ts';
import { compareLocators } from '../concepts/locator.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getColumnNameByModel } from '../ontology/resolver.ts';

/** One locator as a consumer reads it — RAW stored jsonb, or a computed entry. */
export interface SourcedLocator {
	section_tipo?: unknown;
	section_id?: unknown;
	id?: number | string;
	main_component_tipo?: string;
	[key: string]: unknown;
}

/** Where a model's locators come from (see the module header). */
export type LocatorSource = 'stored' | 'relation_children' | 'relation_index';

/**
 * Every resolver id's locator source. Typed as a full Record so a NEW resolver
 * id fails tsc here until it declares its source (the former switch's `never`
 * check); read through a Map so a runtime id outside the type misses cleanly.
 */
const LOCATOR_SOURCE_TABLE: Readonly<Record<RelationResolverId, LocatorSource>> = {
	relation_children: 'relation_children',
	relation_index: 'relation_index',
	portal: 'stored',
	filter: 'stored',
	select_family: 'stored',
	relation_related: 'stored',
};
const LOCATOR_SOURCE_BY_RESOLVER: ReadonlyMap<string, LocatorSource> = new Map(
	Object.entries(LOCATOR_SOURCE_TABLE),
);

/**
 * The locator source of a relation-column MODEL, from its descriptor. A
 * relation-column model without `resolveData` is covered only when its value is
 * DERIVED (`flatValue: 'external'`, the component_external family: its column is
 * inert, read as the stored slice it is); any other one THROWS — a new relation
 * model must declare its data contract, never fall through to a guessed one.
 */
export function locatorSourceOf(model: string): LocatorSource {
	const resolverId = getResolveDataId(model);
	if (resolverId === undefined) return derivedModelLocatorSource(model);
	const source = LOCATOR_SOURCE_BY_RESOLVER.get(resolverId);
	if (source !== undefined) return source;
	throw new DedaloError('engine.uncovered_scope', {
		message: `locatorSourceOf: resolver id '${String(resolverId)}' of '${model}' has no locator source`,
		coordinates: { model },
	});
}

/**
 * A model WITHOUT `resolveData`: covered only when its value is derived
 * (`flatValue: 'external'` → its inert column, read as the stored slice);
 * anything else THROWS (a relation model must declare its data contract).
 */
function derivedModelLocatorSource(model: string): LocatorSource {
	if (getFlatValueFamily(model) === 'external') return 'stored';
	throw new DedaloError('engine.uncovered_scope', {
		message: `locatorSourceOf: model '${model}' declares no resolveData (no locator source)`,
		coordinates: { model },
	});
}

/**
 * Does a model READ COMPUTED locators — store nothing under its tipo
 * (relation_children, relation_index: {@link locatorSourceOf} not 'stored')?
 * False for every non-relation model. For a "does this component hold data
 * on the record?" question: an empty stored slot proves NOTHING for such a
 * model (the diffusion resolver's holdsNoData).
 */
export function readsComputedLocators(model: string): boolean {
	if (getResolveDataId(model) === undefined) return false;
	return locatorSourceOf(model) !== 'stored';
}

/** The RAW stored slice of `componentTipo` on a record's columns (positions kept). */
export function storedLocatorSlice(
	columns: Readonly<Record<string, unknown>> | null | undefined,
	componentTipo: string,
	model: string,
): SourcedLocator[] {
	const column = getColumnNameByModel(model) ?? 'relation';
	const bag = (columns?.[column] as Record<string, unknown> | null | undefined)?.[componentTipo];
	return Array.isArray(bag) ? (bag as SourcedLocator[]) : [];
}

/**
 * relation_children: the child locators of (sectionTipo, sectionId) — every
 * child (limit 0), sibling-ordered, the four ChildLocator fields restated so a
 * ChildLocator change cannot leak unvetted extras into a published value.
 */
export async function computedChildrenLocators(
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
): Promise<SourcedLocator[]> {
	const { getChildren } = await import('./children.ts');
	const children = await getChildren(sectionId, sectionTipo, componentTipo, 0, 0);
	return children.map((child) => ({
		section_tipo: child.section_tipo,
		section_id: child.section_id,
		from_component_tipo: child.from_component_tipo,
		type: child.type,
	}));
}

/** relation_index's inverse question (relations/models/relation_index.ts resolveIndexConfig). */
export interface IndexQuestion {
	relationType: string;
	targetSections: string[] | 'all';
}

/** The inverse question of an index component on a section (ontology-derived). */
export async function relationIndexQuestion(
	componentTipo: string,
	sectionTipo: string,
): Promise<IndexQuestion> {
	const { resolveIndexConfig } = await import('./models/relation_index.ts');
	const config = await resolveIndexConfig(componentTipo, sectionTipo);
	return { relationType: config.relationType, targetSections: config.targetSections };
}

/**
 * relation_index: the inverse locators of (sectionTipo, sectionId) — the FULL
 * set (no edit page), section_id order, parsed by the read path's own
 * parseInverseEntry. `question` lets a caller pass a memoized
 * relationIndexQuestion. On an unmaintained instance the find THROWS (never an
 * empty list — that would be silent narrowing).
 *
 * NEVER FILTERED (owner rule, see the header): the same set for every
 * principal, with or without a request context — the edit form's own
 * entries. Content is withheld per pointing SECTION downstream
 * ({@link pointingSectionReadable}), never by dropping a locator here.
 */
export async function computedIndexLocators(
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	question?: IndexQuestion,
): Promise<SourcedLocator[]> {
	const resolved = question ?? (await relationIndexQuestion(componentTipo, sectionTipo));
	const { findInverseReferenceLocators } = await import('../search/search_related.ts');
	const { parseInverseEntry } = await import('../resolve/relation_index.ts');
	const hits = await findInverseReferenceLocators(
		[{ type: resolved.relationType, section_tipo: sectionTipo, section_id: sectionId }],
		{ sectionTipos: resolved.targetSections, limit: false, order: 'section_id' },
	);
	return hits.map((hit) => parseInverseEntry(hit) as SourcedLocator);
}

/**
 * THE "may the requester see a pointing record's content?" predicate of a
 * component_relation_index (WC-2026-11-11-relation-index-related-list-context,
 * owner rule): the AMBIENT principal's read grant on the pointing SECTION
 * itself (getPermissions(principal, section, section) >= 1 — Gate B's own
 * check). False ⇒ only the pointer's section name + section_id travel, its
 * columns stay blank. No request principal (a system walk, the diffusion
 * scheduler) ⇒ true. Read per call from the request context — never captured,
 * never a cache key. Callers: the edit form (models/relation_index.ts
 * readableRelatedList) and the children seam (config_children.ts).
 */
export async function pointingSectionReadable(pointingSectionTipo: string): Promise<boolean> {
	const { currentPrincipal } = await import('../security/request_context.ts');
	const principal = currentPrincipal();
	if (principal === undefined) return true;
	const { getPermissions } = await import('../security/permissions.ts');
	return (await getPermissions(principal, pointingSectionTipo, pointingSectionTipo)) >= 1;
}

/**
 * The locators `componentTipo` (model `model`) holds on one record. `columns`
 * is the record's columns (only the stored family reads them); the record
 * ADDRESS is what the computed family asks about.
 */
export async function componentLocators(
	record: {
		sectionTipo: string;
		sectionId: number | string;
		columns: Readonly<Record<string, unknown>> | null | undefined;
	},
	componentTipo: string,
	model: string,
): Promise<SourcedLocator[]> {
	switch (locatorSourceOf(model)) {
		case 'relation_children':
			return computedChildrenLocators(record.sectionTipo, record.sectionId, componentTipo);
		case 'relation_index':
			return computedIndexLocators(record.sectionTipo, record.sectionId, componentTipo);
		case 'stored':
			return storedLocatorSlice(record.columns, componentTipo, model);
	}
}

/**
 * Does a model DERIVE relations beyond its stored ones (a calculated set)?
 * Keyed on the descriptor contract: only the `relation_related` resolver
 * (component_relation_related) has one. Whether a given COMPONENT yields any is
 * its directionality — {@link componentHasCalculatedLocators}.
 */
export function modelHasCalculatedLocators(model: string): boolean {
	return getResolveDataId(model) === 'relation_related';
}

/**
 * Does this component (ontology node) yield calculated relations at all? A
 * related component whose directionality is dd467 BIDIRECTIONAL or dd621
 * MULTIDIRECTIONAL; dd620 UNIDIRECTIONAL (the default) derives nothing. Pure
 * ontology — the same answer for every record of a run.
 */
export async function componentHasCalculatedLocators(
	componentTipo: string,
	model: string,
): Promise<boolean> {
	if (!modelHasCalculatedLocators(model)) return false;
	const { getNode } = await import('../ontology/resolver.ts');
	const { getRelationTypeRel, RELATED_BIDIRECTIONAL, RELATED_MULTIDIRECTIONAL } = await import(
		'./related.ts'
	);
	const typeRel = getRelationTypeRel((await getNode(componentTipo))?.properties ?? null);
	return typeRel === RELATED_BIDIRECTIONAL || typeRel === RELATED_MULTIDIRECTIONAL;
}

/**
 * The CALCULATED locators of `componentTipo` on one record: PHP
 * get_data_with_references() minus get_data() — the related engine's closure
 * (relations/related.ts getCalculatedReferences: [] for dd620, one inverse hop
 * for dd467, the recursive closure for dd621), MINUS every locator the record
 * STORES under the component (compareLocators on the target identity
 * section_tipo + section_id — section_id loose, the equality law), in the
 * closure's own order. [] for a model without a calculated set. Nothing here
 * authorizes: each target is a crossing for the consumer's frontier.
 */
export async function calculatedLocators(
	record: {
		sectionTipo: string;
		sectionId: number | string;
		columns: Readonly<Record<string, unknown>> | null | undefined;
	},
	componentTipo: string,
	model: string,
): Promise<SourcedLocator[]> {
	if (!modelHasCalculatedLocators(model)) return [];
	const { getCalculatedReferences } = await import('./related.ts');
	const closure = (await getCalculatedReferences(
		componentTipo,
		record.sectionTipo,
		record.sectionId,
		'lg-nolan',
		{ onlyData: true },
	)) as SourcedLocator[];
	if (closure.length === 0) return [];
	const stored = storedLocatorSlice(record.columns, componentTipo, model);
	const identity = ['section_tipo', 'section_id'];
	return closure.filter(
		(reference) =>
			!stored.some((entry) => compareLocators(reference as never, entry as never, identity)),
	);
}
