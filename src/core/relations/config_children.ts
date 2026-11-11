/**
 * THE CHILDREN a relation component resolves per target in the EXPORT and the
 * FLAT reader (T0-9 §3.2) — ONE derivation for diffusion/export/atoms.ts (the
 * grid_value fan-out + media walk) and resolve/relation_list.ts (value cells,
 * relation_list panel, Referencias, related labels). It replaced two
 * model-blind copies (atoms.ts ownChildrenOf, relation_list.ts
 * ownConfigChildren) that disagreed with the edit form.
 *
 * Precedence (PHP component_relation_common::get_export_value
 * `$this->request_config ?? build_request_config()`):
 *   1. EXPLICIT — the component's own request_config show.ddo_map, verbatim and
 *      FULL (descendants included: the fan-out follows nested entries); read at
 *      the subdatum floor (T0-1 D3), never asked of the frontier;
 *   2. PER-LOCATOR — a config-less component_relation_index: per pointing
 *      section = [its component_section_id ddo, ...its relation_list columns]
 *      — what the edit form shows (T0-9 owner decision D10). A DELIBERATE
 *      divergence: PHP component_relation_index::resolve_export_ddo_children
 *      (:915-960) builds the same map but keeps as direct children only the
 *      ddos parented to the index — the section_id ddo — so PHP exported the
 *      id alone (WC-2026-11-11-export-value-single-walker). The id ddo is the
 *      record's own address (explicit), the columns are TAGGED implicit;
 *   3. IMPLICIT — request_config/implicit.ts implicitComponentChildren, the
 *      edit form's own derivation (component_filter → dd156;
 *      component_filter_master → its own `relations`, D2), TAGGED implicit.
 *
 * TAGGED = `isImplicitConfigChild`: EVERY reader filters exactly these, per
 * call, through `frontierAllowedComponents` — the export through its frontier
 * (CellFrontier.implicitChildren / resolver.ts exportImplicitChildren), the
 * interactive flat reader (relation_list.ts readableChildren, no frontier)
 * through the edit form's own STEP 5 door, implicit.ts filterAuthorizedRelated
 * (the ALS principal) — the predicate implicit.ts and related_list.ts apply
 * for the edit form. So a per-locator relation_index column is filtered the
 * same way for an interactive reader as in the edit form. The tag is a Symbol,
 * so no client ddo (JSON) can forge or strip it.
 *
 * EXISTENCE ONLY (T0-9 D6/D9, WC-2026-11-11-relation-index-related-list-context):
 * the children of ANY component_relation_index (explicit map or config-less)
 * at a pointer whose section the requester may not read (locator_source.ts
 * pointingSectionReadable — the edit form's own predicate) are the pointer's
 * ADDRESS alone (its section's
 * component_section_id): its columns stay blank, the pointer itself is never
 * dropped. Asked per call, AFTER the caches — {@link pointerIsExistenceOnly}.
 *
 * Caches: ontology-derived and principal-free (createOntologyCache, hub
 * cleared). The CONSUMERS filter per call (above); the cached derivations read
 * no principal (the existence-only predicate is asked outside them).
 */

import { getResolveDataId } from '../components/registry.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { findFirstDescendantTipoByModel, getModelByTipo } from '../ontology/resolver.ts';
import {
	type RawConfigDdo,
	resolveOwnConfigMap,
} from '../section/list_definitions/section_list.ts';

/** The origin tag on a child of an IMPLICIT map (see the header). */
const IMPLICIT_CONFIG_CHILD = Symbol('implicit_config_child');

/** Did this config child come from an implicit (ontology `relations`) map? */
export function isImplicitConfigChild(ddo: RawConfigDdo): boolean {
	return (ddo as { [IMPLICIT_CONFIG_CHILD]?: boolean })[IMPLICIT_CONFIG_CHILD] === true;
}

function implicitChild(tipo: string, model: string, sectionTipo?: string): RawConfigDdo {
	return {
		tipo,
		parent: 'self',
		model,
		...(sectionTipo === undefined ? {} : { section_tipo: sectionTipo }),
		[IMPLICIT_CONFIG_CHILD]: true,
	};
}

/**
 * THE "is this ddo_map entry a DIRECT child of `parentTipo`?" predicate (T0-9
 * owner decision D11) — one answer for the export walk and the flat reader:
 * its `parent` is `parentTipo`, or 'self' when `parentTipo` IS the map's owner
 * (PHP `$ddo->parent === $tipo`, after 'self' resolution; 'self' never
 * aliases a nested level). An entry WITHOUT `parent` is NOT a child — it
 * hangs from nothing, and reading it as the owner's would resolve a field the
 * curator never placed under this component. `mapOwnerTipo` defaults to
 * `parentTipo` (asking about the map owner's own children).
 */
export function isDirectConfigChild(
	ddo: { readonly parent?: unknown },
	parentTipo: string,
	mapOwnerTipo: string = parentTipo,
): boolean {
	return ddo.parent === parentTipo || (ddo.parent === 'self' && parentTipo === mapOwnerTipo);
}

const childrenCache = createOntologyCache<string, readonly RawConfigDdo[]>();
const perLocatorCache = createOntologyCache<string, boolean>();

/** Drop the ontology-derived export children caches. */
export function clearConfigChildrenCache(): void {
	childrenCache.clear();
	perLocatorCache.clear();
}
registerOntologyCacheClearer(clearConfigChildrenCache);

/**
 * Do this component's children depend on the LOCATOR's section? True only for
 * a component_relation_index (descriptor resolveData) WITHOUT an own explicit
 * map — its columns are the pointing section's (rule 2 in the header).
 */
export async function configChildrenArePerLocator(tipo: string): Promise<boolean> {
	const cached = perLocatorCache.get(tipo);
	if (cached !== undefined) return cached;
	const model = await getModelByTipo(tipo);
	const perLocator =
		model !== null &&
		getResolveDataId(model) === 'relation_index' &&
		(await resolveOwnConfigMap(tipo)).rawDdos === null;
	perLocatorCache.set(tipo, perLocator);
	return perLocator;
}

/**
 * Is `tipo` a component_relation_index — a column whose pointers are asked,
 * one by one, whether they are existence only ({@link pointerIsExistenceOnly})?
 * Every reader of such a column passes the locator section to
 * exportConfigChildren (or asks the predicate itself) for EVERY pointer, the
 * explicit-map index included (D9).
 */
export async function configChildrenArePerTarget(tipo: string): Promise<boolean> {
	const model = await getModelByTipo(tipo);
	return model !== null && getResolveDataId(model) === 'relation_index';
}

/**
 * Is a pointer of `tipo` in `locatorSectionTipo` EXISTENCE ONLY for the
 * ambient requester (see the header)? Only a component_relation_index asks
 * (configured or config-less — D9); the predicate is THE one the edit form
 * calls too, locator_source.ts pointingSectionReadable.
 */
export async function pointerIsExistenceOnly(
	tipo: string,
	locatorSectionTipo: string,
): Promise<boolean> {
	if (!(await configChildrenArePerTarget(tipo))) return false;
	const { pointingSectionReadable } = await import('./locator_source.ts');
	return !(await pointingSectionReadable(locatorSectionTipo));
}

/**
 * The config children of `tipo` (see the header), as a ddo map whose direct
 * children are parented 'self' / the tipo ({@link isDirectConfigChild}). `locatorSectionTipo` = the
 * section of the locator being expanded: REQUIRED for a per-locator component
 * (configChildrenArePerLocator) — without it that call THROWS rather than
 * answering an empty map — and the key of its existence-only rule
 * ({@link pointerIsExistenceOnly}).
 */
export async function exportConfigChildren(
	tipo: string,
	locatorSectionTipo?: string,
): Promise<readonly RawConfigDdo[]> {
	if (
		locatorSectionTipo !== undefined &&
		(await pointerIsExistenceOnly(tipo, locatorSectionTipo))
	) {
		return addressChildren(locatorSectionTipo);
	}
	if (await configChildrenArePerLocator(tipo)) {
		const sectionTipo = requireLocatorSection(tipo, locatorSectionTipo);
		return memoizedChildren(`${tipo}|${sectionTipo}`, () =>
			relationIndexLocatorChildren(sectionTipo),
		);
	}
	return memoizedChildren(tipo, () => staticChildren(tipo));
}

/**
 * The locator section a per-locator component needs: present ⇒ returned;
 * absent ⇒ THROWS (never an empty map — see exportConfigChildren).
 */
function requireLocatorSection(tipo: string, locatorSectionTipo: string | undefined): string {
	if (locatorSectionTipo !== undefined) return locatorSectionTipo;
	throw new DedaloError('engine.uncovered_scope', {
		message: `exportConfigChildren: '${tipo}' resolves its children per locator — the locator section is required`,
		coordinates: { tipo },
	});
}

/** Serve `cacheKey` from childrenCache, computing + storing it on a miss. */
async function memoizedChildren(
	cacheKey: string,
	compute: () => Promise<readonly RawConfigDdo[]>,
): Promise<readonly RawConfigDdo[]> {
	const cached = childrenCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const children = await compute();
	childrenCache.set(cacheKey, children);
	return children;
}

/** Rules 1 + 3: the explicit map verbatim, else the implicit derivation (tagged). */
async function staticChildren(tipo: string): Promise<readonly RawConfigDdo[]> {
	const own = await resolveOwnConfigMap(tipo);
	if (own.rawDdos !== null) return own.rawDdos;
	const { implicitComponentChildren } = await import('./request_config/implicit.ts');
	return (await implicitComponentChildren(tipo)).map((child) =>
		implicitChild(child.tipo, child.model),
	);
}

/**
 * Rule 2 (D10 — the edit form's columns, NOT PHP's id-only export; see the
 * header): [the pointing section's component_section_id (virtual-resolving,
 * recursive — PHP resolve_virtual true), ...its relation_list columns
 * (related_list.ts, principal-free)].
 */
async function relationIndexLocatorChildren(
	pointingSectionTipo: string,
): Promise<readonly RawConfigDdo[]> {
	const children: RawConfigDdo[] = [...(await addressChildren(pointingSectionTipo))];
	const sectionIdTipo = children[0]?.tipo ?? null;
	const { sectionRelatedListColumns } = await import('../section/related_list.ts');
	for (const column of await sectionRelatedListColumns(pointingSectionTipo)) {
		if (!column.model.startsWith('component_')) continue;
		if (column.tipo === sectionIdTipo) continue;
		children.push(implicitChild(column.tipo, column.model, pointingSectionTipo));
	}
	return children;
}

/**
 * A pointing record's ADDRESS as a ddo map: its section's component_section_id
 * (virtual-resolving, recursive — PHP resolve_virtual true), explicit (the
 * record's own id, read at the subdatum floor); [] when the section has none.
 */
async function addressChildren(pointingSectionTipo: string): Promise<readonly RawConfigDdo[]> {
	const sectionIdTipo = await findFirstDescendantTipoByModel(
		pointingSectionTipo,
		'component_section_id',
	);
	return sectionIdTipo === null
		? []
		: [
				{
					tipo: sectionIdTipo,
					parent: 'self',
					model: 'component_section_id',
					section_tipo: pointingSectionTipo,
				},
			];
}
