/**
 * RELATION_INDEX resolver (RELATIONS_SPEC.md §6.4 — indexation, inverse
 * relations, "who calls me?"): component_relation_index stores nothing
 * meaningful forward; it CALCULATES its data by resolving the dd96 inverse
 * locators (every locator anywhere whose target is this record) through the
 * search_related flat-GIN engine.
 *
 * PHP references: class.component_relation_index.php (get_data :160,
 * get_data_paginated :205, get_target_section :839, get_filter_locator :872),
 * class.search_related.php:489 (get_referenced_locators),
 * component_relation_index_json.
 *
 * The computed inverse question is CONFIGURABLE per component (PHP
 * component_relation_common __construct :217 + get_target_section):
 * - relation TYPE = properties.config_relation.relation_type ?? dd96 (tch60/
 *   tchi59 declare dd151 — a plain "who references me", not an indexation);
 * - pointing sections = the request_config sqo targets when a config exists
 *   (tch60 → tch1/tch100/tch178), else 'all' (hierarchy40).
 * Children follow the PHP json controller's two subdatum strategies: an own
 * request_config expands its ddo_map portal-style (get_subdatum); without one
 * the pointing sections' related_list components are dumped per locator.
 */

import type { Ddo } from '../../concepts/ddo.ts';
import { configOwnerOf } from '../../concepts/emit_row.ts';
import { clampClientLimit } from '../../concepts/sqo.ts';
import { memoizedReadMatrixRecord } from '../../db/record_memo.ts';
import { getMatrixTableFromTipo } from '../../ontology/resolver.ts';
import { buildDataItem, type DataItem, EmissionContext } from '../../resolve/component_data.ts';
import type { RelatedListDdo } from '../../section/related_list.ts';
import { depthBoundNotice, MAX_DDO_DEPTH } from '../element_node.ts';
import type { ElementNode, ElementNodeRegistry } from '../element_registry.ts';
import type { EmitDdoFn, RelationEmitContext, RelationModelResolver } from '../registry.ts';
import { PORTAL_LIST_LIMIT } from '../relation_core.ts';
import type { InjectableConfigItem } from '../request_config/caller_injection.ts';
import { portalResolver } from './portal.ts';

/** Pointing sections whose related_list ddos were already emitted in THIS
 * read — per-read memory in the EmissionContext scratch (S2-29; was a module
 * WeakMap keyed by the request's data array). PHP re-parents the SHARED cached
 * section context's ddo_map after the first relation_index row (json
 * controller "update parents" step), so every later row of the same request
 * finds no section children and emits the entries item alone — a pinned
 * per-request state bleed the differential must reproduce. */
const SOLVED_SECTIONS = Symbol('relation_index.solvedSections');

/**
 * The page an EMITTED relation_index cell reads from the inverse sink — the
 * ONE client clamp (DEC-07, READ-4), whatever the limit's source.
 *
 * The inverse set is unbounded by the record's own data (every locator
 * anywhere that points here), and the ddo whose limit pages it is
 * CLIENT-REACHABLE: a section read's literal `show.ddo_map` wins
 * (read.ts resolveSectionColumnDdoMap), and the ddo schema admits any
 * non-negative integer as `limit`. The server cannot tell that ddo from an
 * ontology one, so every cell page is bounded here — an over-ceiling value is
 * clamped (loud, clampClientLimit) and the cell's `pagination` names the
 * limit applied beside the full total, so a consumer pages through it.
 * (A PORTAL's limit is not this: it pages the record's OWN stored locators,
 * and limit 0 = "all" there is a contract tool_print relies on.)
 */
function inversePageLimit(rawLimit: number, tipo: string): number {
	return clampClientLimit(rawLimit, `relation_index ${tipo}`);
}

/** The component's effective inverse-question filters (see the header). */
interface RelationIndexConfig {
	/** PHP $this->relation_type: config_relation.relation_type ?? dd96. */
	relationType: string;
	/** PHP get_target_section(): request_config sqo targets, else 'all'. */
	targetSections: string[] | 'all';
	/** PHP isset(properties->source->request_config) — picks the subdatum strategy. */
	hasRequestConfig: boolean;
	/** Edit page size: own sqo/sqo_config limit (LAST config item wins) ?? 10. */
	editLimit: number;
}

/**
 * Shared beyond this resolver: ts_object's tree badge counter (PHP
 * get_count_data_group_by → component count_data_group_by, which applies the
 * SAME get_target_section filter) resolves the component's inverse question
 * through this too.
 */
export async function resolveIndexConfig(
	tipo: string,
	ownerSectionTipo: string,
): Promise<RelationIndexConfig> {
	const { getNode } = await import('../../ontology/resolver.ts');
	const node = await getNode(tipo);
	const properties = (node?.properties ?? null) as {
		config_relation?: { relation_type?: unknown };
		source?: {
			request_config?: {
				sqo?: { limit?: unknown };
				show?: { sqo_config?: { limit?: unknown } };
			}[];
		};
	} | null;
	const rawType = properties?.config_relation?.relation_type;
	const relationType = typeof rawType === 'string' && rawType !== '' ? rawType : 'dd96';
	const requestConfig = properties?.source?.request_config;
	const hasRequestConfig = requestConfig !== undefined && requestConfig !== null;

	// PHP get_target_section: the request_config sqo targets when a config
	// exists; an EMPTY extraction falls back to the ['all'] default.
	let targetSections: string[] | 'all' = 'all';
	if (hasRequestConfig) {
		const { getElementTargetSectionTipos } = await import('../request_config/build.ts');
		const tipos = await getElementTargetSectionTipos(tipo, ownerSectionTipo);
		if (tipos.length > 0) targetSections = tipos;
	}

	// The expandPortal EDIT limit chain (relation_core): sqo.limit ??
	// show.sqo_config.limit, LAST config item wins, default 10.
	let editLimit = 10;
	if (Array.isArray(requestConfig)) {
		for (const item of requestConfig) {
			const candidate = item?.sqo?.limit ?? item?.show?.sqo_config?.limit;
			if (typeof candidate === 'number') editLimit = candidate;
		}
	}
	return { relationType, targetSections, hasRequestConfig, editLimit };
}

export const relationIndexResolver: RelationModelResolver = {
	model: 'component_relation_index',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		// PHP component_relation_index_json runs the SAME computed flow in every
		// mode; TS routes list/tm cells AND the edit read through it. Remaining
		// modes (search rows carry no real record to invert) keep the generic
		// portal fallback.
		if (context.ddoMode !== 'list' && context.ddoMode !== 'edit') {
			await portalResolver.emitDdoItems(context);
			return;
		}
		const config = await resolveIndexConfig(
			context.ddo.tipo,
			configOwnerOf(context.row).section_tipo,
		);
		if (config.hasRequestConfig) {
			await emitOwnConfigIndexData(context, config);
			return;
		}
		await emitRelationIndexData(context, config);
	},
};

/**
 * Own-request_config strategy (PHP json controller's get_subdatum branch):
 * the computed inverse page becomes the component's relation slot on a
 * synthetic record, and the generic portal machinery expands the component's
 * OWN ddo_map children over each pointing record (per-locator grouping,
 * self→target resolution, re-stamp rules — all shared). The portal only sees
 * one page, so its pagination.total is re-stamped with the FULL inverse count
 * afterwards (PHP pagination->total = count_data()).
 */
async function emitOwnConfigIndexData(
	context: RelationEmitContext,
	config: RelationIndexConfig,
): Promise<void> {
	const { ddo, row, ddoMode, emission, dataTipo } = context;
	const { findInverseReferenceLocators, countInverseReferences } = await import(
		'../../search/search_related.ts'
	);
	const { parseInverseEntry } = await import('../../resolve/relation_index.ts');

	// The page limit mirrors expandPortal's mode chains EXACTLY, then is pinned
	// onto the delegated ddo so the pre-fetched page and the portal slice agree.
	let rawLimit: number;
	if (ddoMode === 'list') {
		const { resolveListCellMap } = await import('../../section/list_definitions/section_list.ts');
		rawLimit = ddo.limit ?? (await resolveListCellMap(ddo.tipo)).cellLimit ?? PORTAL_LIST_LIMIT;
	} else {
		rawLimit = ddo.limit ?? config.editLimit;
	}
	const limit = inversePageLimit(rawLimit, ddo.tipo);

	const filter = {
		type: config.relationType,
		section_tipo: row.section_tipo,
		section_id: row.section_id,
	};
	const page = await findInverseReferenceLocators([filter], {
		limit,
		offset: 0,
		order: 'section_id',
		sectionTipos: config.targetSections,
	});
	if (page.length === 0) return;
	const counted = await countInverseReferences([filter], {
		sectionTipos: config.targetSections,
	});

	const relationSlot = {
		...((context.record.columns.relation as Record<string, unknown[]> | null) ?? {}),
		[dataTipo]: page.map(parseInverseEntry),
	};
	const syntheticRecord = {
		...context.record,
		columns: { ...context.record.columns, relation: relationSlot },
	};
	const before = emission.items.length;
	await portalResolver.emitDdoItems({
		...context,
		record: syntheticRecord,
		ddo: { ...ddo, limit } as Ddo,
	});
	for (let i = before; i < emission.items.length; i++) {
		const item = emission.items[i] as DataItem;
		if (item.tipo === ddo.tipo) {
			item.pagination = { total: counted.total, limit, offset: 0 };
			break;
		}
	}
}

/**
 * Stamp the related_list child cell ITSELF (`childTipo` at the pointing
 * section, the first such item emitted from `from`) — never one of the items
 * its own show expanded. PHP builds
 * the direct cell in the pointing section's 'related_list' mode with no
 * component source (so from_component_tipo echoes its own tipo), while a
 * grandchild is built by that child's own get_subdatum: mode 'list'
 * (trait.request_config_ddo.php resolve_ddo_mode, a non-section caller) and
 * `from_component_tipo` = the child portal (class.common.php :2683-2686,
 * echoed by get_data_item :3665). Re-stamping a grandchild with the direct
 * cell's values would lose both.
 */
function stampDirectRelatedListCell(
	emission: EmissionContext,
	from: number,
	childTipo: string,
	pointingSection: string,
	indexTipo: string,
): void {
	const items = emission.items;
	for (let i = from; i < items.length; i++) {
		const item = items[i] as DataItem;
		if (item.tipo === childTipo && item.section_tipo === pointingSection) {
			item.mode = 'related_list';
			item.from_component_tipo = item.tipo;
			// Its CONTEXT is a column of the index (PHP stamps parent = the index
			// tipo on every pointing-section context), while its data keeps
			// from_component_tipo = its own tipo (PHP wire) — so the parent is
			// declared explicitly (element_registry.ts bindContextParent).
			emission.nodes.bindContextParent(item, indexTipo);
			return;
		}
	}
}

/**
 * The related_list children of ONE pointing section (emitRelationIndexData):
 * each child tipo resolved against each pool record, one hop deeper; the child
 * cell itself re-stamped as a related_list cell of this index item, and every
 * emitted item (its own expanded children too) given this row's stamps.
 */
async function emitRelatedListChildren(
	context: RelationEmitContext,
	table: string,
	pointingSection: string,
	recordIds: readonly number[],
	childTipos: readonly string[],
): Promise<void> {
	const { ddo, row, callerTipo, emission, depth, emitDdo } = context;
	const plans = await relatedListChildPlans(childTipos);
	for (const recordId of recordIds) {
		const targetRecord = await memoizedReadMatrixRecord(table, pointingSection, recordId);
		if (targetRecord === null) continue;
		for (const childTipo of childTipos) {
			const plan = plans.get(childTipo) as RelatedListChildPlan;
			const before = emission.items.length;
			await emitDdo(
				{
					tipo: childTipo,
					section_tipo: pointingSection,
					parent: ddo.tipo,
					mode: plan.mode,
				} as Ddo,
				[],
				targetRecord,
				{ section_tipo: pointingSection, section_id: recordId },
				plan.mode,
				'lg-nolan',
				callerTipo,
				emission,
				// OWN CHILDREN exactly where PHP expands them (RelatedListChildPlan).
				plan.ownChildren,
				depth + 1,
			);
			// mode + from_component_tipo are the DIRECT cell's only; the row stamps
			// and `parent` reach every item, grandchildren included (PHP
			// :2789-2794 + sub_value->parent).
			stampDirectRelatedListCell(emission, before, childTipo, pointingSection, ddo.tipo);
			for (let i = before; i < emission.items.length; i++) {
				const child = emission.items[i] as DataItem;
				child.row_section_id = row.section_id;
				child.parent_tipo = callerTipo;
				(child as DataItem & { parent?: string }).parent = ddo.tipo;
				emission.markStamped(child); // outer portals must not re-stamp
			}
		}
	}
}

/**
 * How ONE related_list child is emitted (verified 2026-11-04 against
 * component_relation_index_json.php :190-206). PHP's no-request_config branch
 * builds each pointing section in 'related_list' mode
 * (get_section_datum_from_locator) and its get_json runs get_subdatum over the
 * related_list ddos, whose mode stays 'related_list' (trait.request_config_v5
 * .php :117 — a SECTION caller keeps its own mode for its ddos). So:
 *
 *  - a RELATION child with an EXPLICIT request_config expands its OWN show map
 *    (component_portal_json.php :163 — every mode but 'solved' runs
 *    get_subdatum), resolved in 'related_list' mode: its own properties, never
 *    the section_list swap (trait.request_config_utils.php :270 swaps for
 *    list / list_thesaurus / tm only), paged by the default branch;
 *  - a config-less (v5) child resolves NO children in related_list mode
 *    (resolve_ar_related_related_list returns [] for a non-section), and a
 *    literal has none to resolve: both keep the pinned one-level 'list' cell
 *    the parity store recorded.
 */
interface RelatedListChildPlan {
	readonly mode: 'list' | 'related_list';
	readonly ownChildren: boolean;
}

/** The plan of every related_list child tipo (RelatedListChildPlan). */
async function relatedListChildPlans(
	childTipos: readonly string[],
): Promise<Map<string, RelatedListChildPlan>> {
	const { getModelByTipo, getColumnNameByModel } = await import('../../ontology/resolver.ts');
	const plans = new Map<string, RelatedListChildPlan>();
	for (const childTipo of childTipos) {
		const model = await getModelByTipo(childTipo);
		const expands =
			model !== null &&
			getColumnNameByModel(model) === 'relation' &&
			(await declaresOwnRequestConfig(childTipo));
		plans.set(
			childTipo,
			expands ? { mode: 'related_list', ownChildren: true } : { mode: 'list', ownChildren: false },
		);
	}
	return plans;
}

/**
 * Whether `tipo` declares its OWN `properties.source.request_config` (PHP
 * `isset($properties->source->request_config)`).
 */
async function declaresOwnRequestConfig(tipo: string): Promise<boolean> {
	// alias-aware: a component_alias inherits its target's config (ontology/alias.ts)
	const { getEffectivePropertiesByTipo } = await import('../../ontology/alias.ts');
	const properties = (await getEffectivePropertiesByTipo(tipo)) as {
		source?: { request_config?: unknown };
	} | null;
	const requestConfig = properties?.source?.request_config;
	return requestConfig !== undefined && requestConfig !== null;
}

/** A pointing section → its related_list ddos for the current viewer (section/related_list.ts). */
type RelatedLists = Map<string, RelatedListDdo[]>;

/**
 * The pointing sections of an inverse count, in totals_group order (PHP
 * count_data_group_by(['section_tipo'])): the FULL set of sections pointing
 * at the record, whatever page is read (owner decision D4 — the columns stay
 * stable while paging).
 */
function pointingSectionsOf(counted: {
	readonly totals_group?: readonly { readonly key: readonly (string | undefined)[] }[];
}): string[] {
	const sections: string[] = [];
	for (const group of counted.totals_group ?? []) {
		const section = group.key[0];
		if (section !== undefined && !sections.includes(section)) sections.push(section);
	}
	return sections;
}

/** Per-emission memory of each pointing section's related_list for the
 * current viewer (EmissionContext scratch: request- AND principal-scoped, like
 * SOLVED_SECTIONS — an emission never outlives its request). `null` = the
 * section contributes NO column (unreadable, or nothing authorised). */
const RELATED_LISTS = Symbol('relation_index.relatedLists');

/**
 * Each READABLE pointing section's related_list ddo map, read ONCE per
 * emission (memoised in the scratch) from THE section-mode builder
 * (section/related_list.ts sectionRelatedListConfig). Both the data cells and
 * the context merge are fed from this map, so a column the viewer may not
 * read has neither a ddo nor a data cell.
 *
 * A section is KEPT only when the viewer may read it — the very check Gate B
 * applies to every `sqo.section_tipo` of the client's paging request
 * (dd_core_api ungrantedTargetSections: getPermissions(principal, s, s) >= 1)
 * — AND it leaves at least one authorised column. Merging any other section
 * would (a) make the client's page-2 get_data (common.js build_rqo_show copies
 * the context's sqo.section_tipo) a perm.denied, and (b) disclose the
 * label/color/matrix_table of a section the viewer cannot read.
 */
async function relatedListsOf(
	emission: EmissionContext,
	sections: readonly string[],
): Promise<RelatedLists> {
	let memo = emission.scratch.get(RELATED_LISTS) as
		| Map<string, RelatedListDdo[] | null>
		| undefined;
	if (memo === undefined) {
		memo = new Map();
		emission.scratch.set(RELATED_LISTS, memo);
	}
	const lists: RelatedLists = new Map();
	for (const section of sections) {
		if (!memo.has(section)) memo.set(section, await readableRelatedList(section));
		const ddos = memo.get(section);
		if (ddos) lists.set(section, ddos);
	}
	return lists;
}

/** One pointing section's related_list for the current viewer, or null when it contributes no column. */
async function readableRelatedList(section: string): Promise<RelatedListDdo[] | null> {
	const { currentPrincipal } = await import('../../security/request_context.ts');
	const principal = currentPrincipal();
	if (principal !== undefined) {
		const { getPermissions } = await import('../../security/permissions.ts');
		if ((await getPermissions(principal, section, section)) < 1) return null;
	}
	const { sectionRelatedListConfig } = await import('../../section/related_list.ts');
	const ddos = await sectionRelatedListConfig(section);
	return ddos.length > 0 ? ddos : null;
}

/**
 * The related_list column tipos of one pointing section. A MISS (a section in
 * the page/pool but not in the merged set: unreadable, column-less, or absent
 * from the totals_group it was counted from — a write racing the read) is
 * "no columns": a cell must never be emitted without its ddo in the context.
 */
function relatedListTiposOf(lists: RelatedLists, section: string): string[] {
	return lists.get(section)?.map((ddo) => ddo.tipo) ?? [];
}

/** The tipo of an sqo.section_tipo entry (an enriched ddo, or a bare tipo). */
function sqoSectionTipoOf(entry: unknown): string | undefined {
	if (typeof entry === 'string') return entry;
	const tipo = (entry as { tipo?: unknown } | null)?.tipo;
	return typeof tipo === 'string' ? tipo : undefined;
}

/**
 * MERGE the pointing sections' related_list into the index element's NODE
 * config (T0-8; PHP get_section_datum_from_locator appends each pointing
 * section's dedalo `sqo.section_tipo` + `show.ddo_map` to the component's own
 * request_config, and its "update parents" pass re-parents them to the index).
 * The node is what BOTH context doors serialise (the get_data main entry and
 * the section read's column entry), so the client's get_columns_map finds
 * `show.ddo_map` items with `parent === <index tipo>`:
 *
 *   test25 @ test3 (config-less), pointed at from test3
 *   → request_config[dedalo].sqo.section_tipo [{typo:'ddo', tipo:'test3', …enriched}]
 *     request_config[dedalo].show.ddo_map    [{tipo:'test52', section_tipo:'test3',
 *                                              parent:'test25', mode:'related_list', …}]
 *
 * Owner decisions (WC-2026-11-11-relation-index-related-list-context): every
 * mode (D1); `sqo.section_tipo` = the pointing sections only, never the own
 * section (D2); no pointing-section (model section) contexts (D3); the FULL
 * totals_group set on every page (D4). Idempotent and dedup'd (a list read
 * merges once per row into the one shared node: the union of every row's
 * pointing sections). Built on a FRESH clone, swapped in through the
 * registry — never mutating the cached own config (cross-request bleed).
 */
async function mergeRelatedListIntoNode(
	nodes: ElementNodeRegistry,
	node: ElementNode,
	indexTipo: string,
	lists: RelatedLists,
): Promise<void> {
	if (lists.size === 0) return;
	const config = structuredClone(node.effectiveConfig) as InjectableConfigItem[];
	const { engineOf } = await import('../request_config/engine_select.ts');
	const dedalo = config.find((item) => engineOf(item) === 'dedalo');
	// No dedalo item to merge onto (PHP: final_request_config null ⇒ no merge).
	if (dedalo === undefined) return;
	await appendSqoSections(dedalo, [...lists.keys()]);
	appendRelatedListDdos(dedalo, indexTipo, lists);
	nodes.replaceEffectiveConfig(node, config);
}

/** Append the ENRICHED sqo ddos of the sections the item does not target yet (relations skill rule #4). */
async function appendSqoSections(item: InjectableConfigItem, sections: string[]): Promise<void> {
	const holder = item as { sqo?: Record<string, unknown> };
	holder.sqo ??= {};
	const sqo = holder.sqo;
	const current = Array.isArray(sqo.section_tipo) ? (sqo.section_tipo as unknown[]) : [];
	const known = new Set(current.map(sqoSectionTipoOf));
	const missing = sections.filter((section) => !known.has(section));
	if (missing.length === 0) return;
	const { buildSqoSectionTipoDdos } = await import('../request_config/explicit.ts');
	sqo.section_tipo = [...current, ...(await buildSqoSectionTipoDdos(missing))];
}

/** Append every related_list ddo, re-parented to the index, once per (tipo, section_tipo). */
function appendRelatedListDdos(
	item: InjectableConfigItem,
	indexTipo: string,
	lists: RelatedLists,
): void {
	const holder = item as { show?: Record<string, unknown> | null };
	holder.show ??= {};
	const show = holder.show;
	const ddoMap = Array.isArray(show.ddo_map) ? (show.ddo_map as Record<string, unknown>[]) : [];
	const seen = new Set(ddoMap.map((ddo) => `${String(ddo.tipo)}|${String(ddo.section_tipo)}`));
	for (const ddos of lists.values()) {
		for (const ddo of ddos) {
			const key = `${ddo.tipo}|${ddo.section_tipo}`;
			if (seen.has(key)) continue;
			seen.add(key);
			ddoMap.push({ ...ddo, parent: indexTipo });
		}
	}
	show.ddo_map = ddoMap;
}

/**
 * The get_data door's merge: onto the TARGET node the door pinned
 * (section/read.ts pinGetDataTarget — the node its main context entry is
 * serialised from), the index item bound to it. No pinned node (a direct call
 * with a private registry) = no context to complete.
 */
async function mergeIntoGetDataTarget(
	emission: EmissionContext,
	item: DataItem,
	target: { readonly tipo: string; readonly sectionTipo: string; readonly mode: string },
	lists: RelatedLists,
): Promise<void> {
	const targetNode = emission.nodes.targetFor(target.tipo, target.sectionTipo, target.mode);
	if (targetNode === undefined) return;
	emission.nodes.bindItem(item, targetNode);
	await mergeRelatedListIntoNode(emission.nodes, targetNode, target.tipo, lists);
}

/**
 * The index element's node in a SECTION read (the same resolveEmittedElement
 * input emitDdoData's binding pass would use — so that pass, the column
 * context and this merge all meet ONE memoised node).
 */
async function emittedIndexNode(context: RelationEmitContext): Promise<ElementNode> {
	const { resolveEmittedElement } = await import('../element_node.ts');
	return resolveEmittedElement({
		ddo: context.ddo,
		ddoMap: context.ddoMap,
		row: context.row,
		model: context.model,
		ddoMode: context.ddoMode,
		ddoLang: context.ddoLang,
		defaultMode: context.defaultMode,
		defaultLang: context.defaultLang,
		callerTipo: context.callerTipo,
		registry: context.emission.nodes,
		...(context.scope !== undefined ? { scope: context.scope } : {}),
		useOwnConfig: context.allowOwnConfigChildren,
	});
}

/**
 * No-request_config strategy (PHP json controller's per-locator branch):
 * entries = one page of inverse locators (+ full count pagination);
 * children = the pointing sections' related_list components resolved against
 * [representative record, …page records] — first row of the request only.
 * No inverse references → NO data item at all (PHP skips on empty page).
 */
async function emitRelationIndexData(
	context: RelationEmitContext,
	config: RelationIndexConfig,
): Promise<void> {
	const { ddo, row, ddoMode, callerTipo, emission, depth } = context;
	const { findInverseReferenceLocators, countInverseReferences } = await import(
		'../../search/search_related.ts'
	);
	const { parseInverseEntry, getRepresentativeSectionId } = await import(
		'../../resolve/relation_index.ts'
	);
	const filter = {
		type: config.relationType,
		section_tipo: row.section_tipo,
		section_id: row.section_id,
	};
	// list/tm keep the pinned 1-locator cell page; the edit read pages at the
	// component's edit limit (PHP get_data_paginated pagination->limit).
	const limit = inversePageLimit(
		ddoMode === 'list' ? PORTAL_LIST_LIMIT : (ddo.limit ?? config.editLimit),
		ddo.tipo,
	);
	const page = await findInverseReferenceLocators([filter], {
		limit,
		offset: 0,
		order: 'section_id',
		sectionTipos: config.targetSections,
	});
	if (page.length === 0) return;

	const counted = await countInverseReferences([filter], {
		sectionTipos: config.targetSections,
		groupBy: ['section_tipo'],
	});

	const item = buildDataItem(
		ddo.tipo,
		row.section_tipo,
		row.section_id,
		ddoMode,
		'lg-nolan',
		page.map(parseInverseEntry),
	);
	item.from_component_tipo = ddo.tipo;
	item.row_section_id = row.section_id;
	item.parent_tipo = callerTipo;
	item.pagination = { total: counted.total, limit, offset: 0 };
	emission.items.push(item);

	// The index's columns = the related_list of EVERY pointing section (D4),
	// merged into the node its item is bound to — the node the column context
	// is serialised from (mergeRelatedListIntoNode). Bound HERE so emitDdoData's
	// binding pass and the context door meet this same node.
	const relatedLists = await relatedListsOf(emission, pointingSectionsOf(counted));
	const node = await emittedIndexNode(context);
	emission.nodes.bindItem(item, node);
	await mergeRelatedListIntoNode(emission.nodes, node, ddo.tipo, relatedLists);

	// Children — once per pointing section per read (see the scratch note).
	let solved = emission.scratch.get(SOLVED_SECTIONS) as Set<string> | undefined;
	if (solved === undefined) {
		solved = new Set();
		emission.scratch.set(SOLVED_SECTIONS, solved);
	}
	for (const group of counted.totals_group ?? []) {
		const pointingSection = group.key[0];
		if (pointingSection === undefined || solved.has(pointingSection)) continue;
		solved.add(pointingSection);
		const table = await getMatrixTableFromTipo(pointingSection);
		if (table === null) continue;
		// Record pool: the representative first (limit-1 default-order search),
		// then this page's locators of the same section (pool accumulation).
		const recordIds: number[] = [];
		const representative = await getRepresentativeSectionId(table, pointingSection);
		if (representative !== null) recordIds.push(representative);
		for (const hit of page) {
			if (hit.section_tipo === pointingSection && !recordIds.includes(hit.section_id)) {
				recordIds.push(hit.section_id);
			}
		}
		const childTipos = relatedListTiposOf(relatedLists, pointingSection);
		if (childTipos.length === 0) continue;
		// DEPTH BOUND (element_node.ts MAX_DDO_DEPTH): the related_list children
		// sit one hop deeper, and the portal resolver's stop is not on this hop.
		// Their tipos come from the ONTOLOGY (the pointing section's relation_list
		// nodes), never from a client map — ordinary data, so stop here with a
		// typed notice; the index item is emitted and the rest of the read
		// completes.
		if (depth + 1 > MAX_DDO_DEPTH) {
			emission.nodes.addNotices([await depthBoundNotice(row, ddo.tipo, depth)]);
			continue;
		}
		await emitRelatedListChildren(context, table, pointingSection, recordIds, childTipos);
	}
}

/**
 * relation_index get_data (PHP component_relation_index_json through the
 * component read): offset-aware inverse page + pool-accumulated children.
 * PHP's per-locator loop calls get_json on the SAME cached related_list
 * section instance, whose record pool only grows — so locator pass i emits
 * the related_list components of EVERY pool record so far (duplicates and
 * all: limit 3 → 3+6+9 child items). offset 0 seeds the pool with each
 * pointing section's representative record (get_related_section_context);
 * later pages skip it. Children: mode 'related_list', row/parent stamped
 * with the TARGET record (row_section_id = target id, parent_tipo = the
 * pointing section tipo).
 */
export async function readRelationIndexData(
	tipo: string,
	sectionTipo: string,
	sectionId: string,
	limit: number,
	offset: number,
	requestLang: string,
	emitDdo: EmitDdoFn,
	mode = 'list',
	/**
	 * The producer's node registry (section/read.ts ProducedData): the
	 * emissions below resolve their element nodes into it, so a get_data of a
	 * relation_index hands its nodes on like every other producer. Absent = a
	 * private one.
	 */
	nodes?: ElementNodeRegistry,
): Promise<DataItem[]> {
	const { findInverseReferenceLocators, countInverseReferences } = await import(
		'../../search/search_related.ts'
	);
	const { parseInverseEntry, getRepresentativeSectionId } = await import(
		'../../resolve/relation_index.ts'
	);
	const config = await resolveIndexConfig(tipo, sectionTipo);
	const filter = { type: config.relationType, section_tipo: sectionTipo, section_id: sectionId };
	const page = await findInverseReferenceLocators([filter], {
		limit,
		offset,
		order: 'section_id',
		sectionTipos: config.targetSections,
	});
	if (page.length === 0) return [];
	const counted = await countInverseReferences([filter], {
		sectionTipos: config.targetSections,
		groupBy: ['section_tipo'],
	});

	// Own-request_config strategy: delegate to the portal machinery over a
	// synthetic record holding the computed page (see emitOwnConfigIndexData);
	// no representative seeding, no pool quirk (PHP get_subdatum branch).
	if (config.hasRequestConfig) {
		const emission = new EmissionContext([], nodes === undefined ? {} : { nodes });
		const syntheticRecord = {
			id: 0,
			section_id: Number(sectionId),
			section_tipo: sectionTipo,
			columns: { relation: { [tipo]: page.map(parseInverseEntry) } },
			rawText: {},
		};
		await portalResolver.emitDdoItems({
			ddo: { tipo, section_tipo: sectionTipo, mode, limit } as Ddo,
			ddoMap: [],
			record: syntheticRecord,
			row: { section_tipo: sectionTipo, section_id: Number(sectionId) },
			model: 'component_relation_index',
			dataTipo: tipo,
			ddoMode: mode,
			ddoLang: 'lg-nolan',
			defaultMode: mode,
			defaultLang: requestLang,
			callerTipo: tipo,
			emission,
			allowOwnConfigChildren: true,
			depth: 0,
			emitDdo,
		});
		for (const emitted of emission.items) {
			const item = emitted as DataItem;
			if (item.tipo !== tipo) continue;
			// get_data echoes the source's RAW (string) id + the FULL count.
			item.section_id = sectionId;
			item.pagination = { total: counted.total, limit, offset };
			break;
		}
		return emission.items as DataItem[];
	}

	const emission = new EmissionContext([], nodes === undefined ? {} : { nodes });
	const item = buildDataItem(
		tipo,
		sectionTipo,
		sectionId, // the source's raw (string) id — PHP echoes it as given
		mode,
		'lg-nolan',
		page.map(parseInverseEntry),
	);
	item.pagination = { total: counted.total, limit, offset };
	item.parent_tipo = tipo;
	emission.items.push(item);

	// The columns: the FULL pointing-section set on EVERY page (D4 — PHP only
	// merged the page's sections past offset 0), merged into the get_data
	// TARGET node the door pinned (section/read.ts pinGetDataTarget) — the node
	// its main context entry is serialised from.
	const relatedLists = await relatedListsOf(emission, pointingSectionsOf(counted));
	await mergeIntoGetDataTarget(emission, item, { tipo, sectionTipo, mode }, relatedLists);

	// The record pool (unique targets, insertion order).
	const pool: { sectionTipo: string; sectionId: number }[] = [];
	const seen = new Set<string>();
	const poolAdd = (targetSection: string, targetId: number): void => {
		const key = `${targetSection}_${targetId}`;
		if (seen.has(key)) return;
		seen.add(key);
		pool.push({ sectionTipo: targetSection, sectionId: targetId });
	};
	if (offset === 0) {
		for (const group of counted.totals_group ?? []) {
			const pointingSection = group.key[0];
			if (pointingSection === undefined) continue;
			const table = await getMatrixTableFromTipo(pointingSection);
			if (table === null) continue;
			const representative = await getRepresentativeSectionId(table, pointingSection);
			if (representative !== null) poolAdd(pointingSection, representative);
		}
	}
	for (const hit of page) {
		poolAdd(hit.section_tipo, hit.section_id);
		// One FULL pool dump per locator pass (the PHP instance-cache quirk).
		for (const entry of pool) {
			const table = await getMatrixTableFromTipo(entry.sectionTipo);
			if (table === null) continue;
			const targetRecord = await memoizedReadMatrixRecord(
				table,
				entry.sectionTipo,
				entry.sectionId,
			);
			if (targetRecord === null) continue;
			const childTipos = relatedListTiposOf(relatedLists, entry.sectionTipo);
			const plans = await relatedListChildPlans(childTipos);
			for (const childTipo of childTipos) {
				const plan = plans.get(childTipo) as RelatedListChildPlan;
				const before = emission.items.length;
				await emitDdo(
					{
						tipo: childTipo,
						section_tipo: entry.sectionTipo,
						parent: tipo,
						mode: plan.mode,
					} as Ddo,
					[],
					targetRecord,
					{ section_tipo: entry.sectionTipo, section_id: entry.sectionId },
					plan.mode,
					requestLang,
					entry.sectionTipo, // parent_tipo = the pointing SECTION here
					emission,
					// OWN CHILDREN exactly where PHP expands them (RelatedListChildPlan).
					plan.ownChildren,
					1,
				);
				stampDirectRelatedListCell(emission, before, childTipo, entry.sectionTipo, tipo);
				for (let i = before; i < emission.items.length; i++) {
					const child = emission.items[i] as DataItem & { parent?: string };
					// PHP sub_value->parent: every item of the dump (grandchildren
					// too) belongs to the index — the section path stamps the same.
					child.parent = tipo;
					emission.markStamped(child);
				}
			}
		}
	}
	return emission.items as DataItem[];
}
