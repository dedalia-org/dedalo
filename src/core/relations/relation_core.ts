/**
 * RELATION CORE — the shared engine of the relation family
 * (RELATIONS_SPEC.md §2/§5): stored-locator paging, per-locator target
 * expansion through the child ddos, nested recursion, dataframe slot
 * emission, the batched EXTERNAL-target prepass (a locator may point at a
 * section whose records live in a third-party service — see
 * prefetchExternalTargets), and the outer-subdatum re-stamp bookkeeping. Every
 * model resolver (relations/models/*) builds its particularity on these. The
 * emission protocol (items array + nested-stamp ledger) is the EXPLICIT
 * per-read EmissionContext (resolve/component_data.ts, S2-29) — no module
 * state.
 *
 * PHP references: component_portal_json.php + common::get_subdatum
 * (class.common.php:2254, child re-stamp :2792-2799), dataframe branch +
 * frame json (trait.dataframe_common.php:395).
 *
 * The code here is the strangler-fig extraction of section/read.ts'
 * expandPortal/emitDataframeItem — semantics unchanged, dispatch inverted:
 * child recursion goes through the `emitDdo` callback (the generic emission
 * path) handed in by the caller, so this module never imports read_rows.
 */

import { config as dedaloConfig } from '../../config/config.ts';
import type { Ddo } from '../concepts/ddo.ts';
import { configOwnerOf, type EmitRow } from '../concepts/emit_row.ts';
import { canonicalizeStoredSectionId, isSectionId } from '../concepts/section_id.ts';
import { dataframeEntryMatches } from '../concepts/subdatum.ts';
import type { MatrixRecord } from '../db/matrix.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import {
	buildDataItem,
	type DataItem,
	type EmissionContext,
	type TmAsOf,
} from '../resolve/component_data.ts';
import { isTimeMachineRead } from '../section/list_definitions/tm_scope_context.ts';
import { loadRecordCached } from '../section/record_loader.ts';
import {
	assertViewOrder,
	rankByViewColumn,
	storedIndexOf,
	type ViewOrder,
} from './order_locators.ts';
import type { EmitDdoFn } from './registry.ts';

/** List-cell locator page size (PHP portal list mode paginates the cell to 1). */
export const PORTAL_LIST_LIMIT = 1;

// ---------------------------------------------------------------------------
// EXTERNAL TARGETS — the batched prepass
// ---------------------------------------------------------------------------

/**
 * A portal's locators may point at an EXTERNAL section (rsc368's second config
 * item targets zenon1, whose records live in the DAI catalogue). Such a section
 * has no matrix row anywhere — zenon1 has zero rows in any table and no
 * `matrix_zenon` — so the per-locator `loadRecordCached` below returns null and
 * the locator used to vanish silently, which is the whole rsc368 bug.
 *
 * The expansion still needs SOMETHING in the `record` slot: `emitDdo` is the
 * generic path and takes a MatrixRecord. This is that placeholder — identity
 * only, columns deliberately EMPTY. A component_external's value is DERIVED
 * (components/component_external/value.ts) and never reads it; any other model
 * at an external target is refused loudly in the child loop rather than served
 * this empty record, because "no stored columns" would render as a blank field
 * indistinguishable from a genuinely empty one.
 */
function externalTargetRecord(sectionTipo: string, sectionId: number | string): MatrixRecord {
	return {
		id: 0,
		// The locator's RAW id type survives (a zero-padded '001338683' stays a
		// string) — the cast keeps the shared MatrixRecord shape honest without
		// rewriting the value, exactly as the dedalo path does for targetRow.
		section_id: sectionId as number,
		section_tipo: sectionTipo,
		columns: {},
		rawText: {},
	};
}

/** How a target section's compatible child ddos are made up, per section tipo. */
interface TargetChildShape {
	/** At least one compatible child derives its value from a remote service. */
	readonly hasDerived: boolean;
	/** At least one compatible child reads the STORED record. */
	readonly hasStored: boolean;
}

/**
 * The child-model shape of each of a page's target sections, answered ONCE per
 * expansion over the DISTINCT section tipos rather than per locator.
 *
 * THE DISCRIMINATOR IS THE CHILD DDO SET, NOT `properties.api_config`. An
 * earlier cut asked the facade "is this section external?", which answers "does
 * the node carry an api_config" — and that is NOT the same question. `test3` is
 * an ordinary playground section with 7 stored rows and ~30 children of every
 * model that merely also carries an api_config; `rsc205` (bibliography, ~21.7k
 * rows) carries a stale duplicate left by a 2024 edit. Classifying either as
 * external refuses all of its ordinary children and blanks every citation.
 *
 * `getMatrixTableFromTipo(...) === null` is equally wrong as a discriminator:
 * `zenon1` IS `model:'section'` with no `matrix_table` relation, so it resolves
 * to the DEFAULT 'matrix' table, not to null.
 *
 * What actually matters at this call site is per-target and already in hand: a
 * target is external when every compatible child derives its value remotely.
 * A MIXED target (test3: `test52` stored + `test215` derived) takes the dedalo
 * path and still renders its derived children — the emit hook resolves those
 * through the facade on its own. So nothing is refused and nothing is blanked.
 */
async function targetChildShapes(
	page: readonly Record<string, unknown>[],
	childDdos: readonly Ddo[],
): Promise<ReadonlyMap<string, TargetChildShape>> {
	const shapes = new Map<string, TargetChildShape>();
	const distinct = new Set<string>();
	for (const locator of page) {
		const sectionTipo = locator.section_tipo;
		if (typeof sectionTipo === 'string' && sectionTipo !== '') distinct.add(sectionTipo);
	}
	for (const sectionTipo of distinct) {
		let hasDerived = false;
		let hasStored = false;
		for (const childDdo of childDdos) {
			if (!ddoTargetsSection(childDdo, sectionTipo)) continue;
			const childModel = await getModelByTipo(childDdo.tipo);
			if (childModel === 'component_external') {
				// THE OWNERSHIP RULE (value.ts externalComponentAppliesTo), not the
				// ddo's declaration: a ddo with NO section_tipo passes
				// ddoTargetsSection for every target, and a component_external owned
				// by zenon1 says nothing about a local rsc205 target — it resolves to
				// nothing there, so it neither derives nor reads the stored row.
				// Counting it as derived would send the LOCAL id to the service.
				// An 'orphan' still counts: its own derivation renders it
				// 'misconfigured' instead of letting the target vanish.
				if ((await externalComponentApplies(childDdo.tipo, sectionTipo)) !== 'foreign') {
					hasDerived = true;
				}
			} else if (childModel !== 'component_dataframe') {
				// A dataframe pairs with the CALLER's record, never the locator
				// target, so it says nothing about where the target is stored.
				hasStored = true;
			}
		}
		shapes.set(sectionTipo, { hasDerived, hasStored });
	}
	return shapes;
}

/**
 * The stored row a target id ADDRESSES, or null. Only a matrix address
 * (`isSectionId`) has one; an external remote id ('000012281', verbatim) is
 * never Number()-ed into a different local record (12281).
 */
async function loadAddressedRecord(
	emission: EmissionContext,
	table: string,
	sectionTipo: string,
	sectionId: number | string,
): Promise<MatrixRecord | null> {
	return isSectionId(sectionId) ? loadRecordCached(emission, table, sectionTipo, sectionId) : null;
}

/**
 * A portal target's record: loadAddressedRecord — or, for a DIRECT dataframe
 * read inside a TM preview (`targetsAsOf`: the locators are frames), the target
 * AS OF the preview's bound with its compatible children grafted
 * (tm_record/frame_as_of.ts) — only a frame of the bound's own main
 * (`locator.main_component_tipo`, isSubjectMain). Called BEFORE the null-record fallback, so a
 * target gone live that has history still renders. Cold path: dynamic import.
 */
async function loadPortalTarget(
	emission: EmissionContext,
	targetsAsOf: TmAsOf | undefined,
	locator: Record<string, unknown>,
	table: string,
	sectionTipo: string,
	sectionId: number | string,
	childDdos: readonly Ddo[],
): Promise<MatrixRecord | null> {
	if (targetsAsOf === undefined || !isSectionId(sectionId)) {
		return loadAddressedRecord(emission, table, sectionTipo, sectionId);
	}
	const { isSubjectMain, loadFrameTargetAsOf } = await import('../tm_record/frame_as_of.ts');
	// CONFINEMENT per frame: only the previewed main's frames read as of the
	// bound — another main's frame in a shared slot stays LIVE, children too.
	if (!(await isSubjectMain(targetsAsOf, locator.main_component_tipo))) {
		return loadAddressedRecord(emission, table, sectionTipo, sectionId);
	}
	return loadFrameTargetAsOf(
		emission,
		table,
		sectionTipo,
		sectionId,
		targetsAsOf,
		childDdos
			.filter((childDdo) => ddoTargetsSection(childDdo, sectionTipo))
			.map((childDdo) => childDdo.tipo),
	);
}

/** value.ts externalComponentAppliesTo, reached lazily (core → component module, no static edge). */
async function externalComponentApplies(
	componentTipo: string,
	targetSectionTipo: string,
): Promise<'owner' | 'foreign' | 'orphan'> {
	const { externalComponentAppliesTo } = await import('../components/component_external/value.ts');
	return externalComponentAppliesTo(componentTipo, targetSectionTipo);
}

/**
 * The remote FIELD NAMES one external target section needs: the union of
 * `fields_map[].remote` over THE DDOS ACTUALLY IN THIS MAP that are compatible
 * with that section and are component_external.
 *
 * This is only what THIS map needs (it decides whether the target is worth
 * prefetching at all). The REQUEST is wider: the row layer asks for the
 * section's whole record field set (src/external/record_fields.ts — the id
 * field + every field any of the section's component_external nodes maps), so
 * a record is ONE request and ONE cache entry whichever map, cell or export
 * asks first (2026-09-24, WC-2026-09-24-external-record-field-set — the v6
 * shape, restored: asking per map dropped the row's own `id` and the identity
 * check then refused every row).
 */
async function collectRemoteFields(
	childDdos: readonly Ddo[],
	targetSectionTipo: string,
): Promise<string[]> {
	const { parseFieldsMap, remoteFieldsOf } = await import('../../external/api/index.ts');
	const { getPropertiesByTipo } = await import('../ontology/resolver.ts');
	const seen = new Set<string>();
	const fields: string[] = [];
	for (const childDdo of childDdos) {
		if (!ddoTargetsSection(childDdo, targetSectionTipo)) continue;
		if ((await getModelByTipo(childDdo.tipo)) !== 'component_external') continue;
		// Only a component the target section OWNS asks the service anything
		// (a foreign one resolves to nothing; an orphan has no service to ask).
		if ((await externalComponentApplies(childDdo.tipo, targetSectionTipo)) !== 'owner') continue;
		const properties = (await getPropertiesByTipo(childDdo.tipo)) as {
			fields_map?: unknown;
		} | null;
		let entries: ReturnType<typeof parseFieldsMap>;
		try {
			entries = parseFieldsMap(properties?.fields_map, { tipo: childDdo.tipo });
		} catch {
			// A malformed mapping is reported per component by the value derivation
			// (source_status: 'misconfigured'); here it simply contributes no fields.
			continue;
		}
		for (const field of remoteFieldsOf(entries)) {
			if (seen.has(field)) continue;
			seen.add(field);
			fields.push(field);
		}
	}
	return fields;
}

/**
 * The per-locator child compatibility rule, in one place: 'self' and an
 * undeclared section_tipo match every target; an array matches by membership
 * (numisdata20's hierarchy25 spans 26 sections — never flatten it to [0]).
 */
function ddoTargetsSection(ddo: Ddo, targetSectionTipo: string): boolean {
	const declared = ddo.section_tipo;
	if (declared === undefined || declared === 'self') return true;
	return Array.isArray(declared)
		? declared.includes(targetSectionTipo)
		: declared === targetSectionTipo;
}

/**
 * Resolve EVERY external target of this page in ONE bounded fan-out and park
 * the rows on the emission context for the component_external emit hook.
 *
 * The batching is the point. v6 fetched inside the per-locator loop, so a
 * 10-locator page cost 10 × the 4 s timeout in series when the service was
 * unreachable; here the whole page is one `fetchExternalRows` call, whose
 * targets are deduped by `${sectionTipo}|${remoteId}`, field sets unioned, and
 * parallelism capped at `DEDALO_EXTERNAL_MAX_CONCURRENCY` at the transport door.
 *
 * NEVER THROWS. `fetchExternalRows` degrades per record, and anything it does
 * raise is a wiring error that must not blank the DEDALO rows sharing this page
 * — the prepass is an optimisation, and each component_external falls back to
 * fetching its own row when its view is absent.
 */
async function prefetchExternalTargets(
	page: readonly Record<string, unknown>[],
	childDdos: readonly Ddo[],
	childShapes: ReadonlyMap<string, TargetChildShape>,
	emission: EmissionContext,
): Promise<void> {
	// Prefetch keyed on hasDerived, NOT on "fully external": a MIXED target
	// (test3's test215 alongside its stored children) has remote values to batch
	// too. Without this it would fall back to one fetch per component.
	let anyDerived = false;
	for (const shape of childShapes.values()) {
		if (shape.hasDerived) {
			anyDerived = true;
			break;
		}
	}
	if (!anyDerived) return;
	const api = await import('../../external/api/index.ts');
	const { externalTransportDepsForRead, mergePrefetchedExternalRows } = await import(
		'../components/component_external/value.ts'
	);

	const fieldsBySection = new Map<string, string[]>();
	const targets: { sectionTipo: string; remoteId: string; remoteFields: string[] }[] = [];
	const seenTargets = new Set<string>();
	for (const locator of page) {
		const sectionTipo = locator.section_tipo;
		if (typeof sectionTipo !== 'string' || childShapes.get(sectionTipo)?.hasDerived !== true) {
			continue;
		}
		// STORAGE FORM, verbatim: the remote id IS the section_id and it is a
		// zero-padded string ('001338683'). Number() would drop the padding and
		// ask the service for a different record.
		const rawId = locator.section_id;
		const remoteId = rawId === null || rawId === undefined ? '' : String(rawId);
		if (remoteId === '') continue;
		const key = api.externalRowViewKey(sectionTipo, remoteId);
		if (seenTargets.has(key)) continue;
		seenTargets.add(key);
		let remoteFields = fieldsBySection.get(sectionTipo);
		if (remoteFields === undefined) {
			remoteFields = await collectRemoteFields(childDdos, sectionTipo);
			fieldsBySection.set(sectionTipo, remoteFields);
		}
		if (remoteFields.length === 0) continue; // nothing to ask for
		targets.push({ sectionTipo, remoteId, remoteFields });
	}
	if (targets.length === 0) return;

	const deps = externalTransportDepsForRead(emission);
	try {
		const views = await api.fetchExternalRows(targets, deps === undefined ? {} : { deps });
		mergePrefetchedExternalRows(emission, views);
	} catch (error) {
		// Loud (CONVENTIONS §1) and non-fatal: the dedalo rows of this page must
		// render regardless, and each external component re-derives on its own.
		console.error(
			'[relations/relation_core] external prepass failed; falling back per component',
			error,
		);
	}
}

/**
 * Whether the own-config child ddos ask for the target's breadcrumb: a child
 * with `value_with_parents: true` compatible with the target section (same
 * compatibility rule as the child-expansion loop — 'self'/undeclared pass).
 * PHP emits dd_info per vwp ddo (common::get_subdatum), so this is the
 * config-driven trigger; the thesaurus-TABLE check alone misses user-defined
 * thesauri living in the generic `matrix` table (`tch555`'s `tchi1`).
 */
export function portalCellEmitsDdinfo(childDdos: Ddo[], targetSectionTipo: string): boolean {
	return childDdos.some(
		(childDdo) =>
			(childDdo as { value_with_parents?: unknown }).value_with_parents === true &&
			ddoTargetsSection(childDdo, targetSectionTipo),
	);
}

/** Options steering one portal expansion (see call sites for the flow rules). */
export interface ExpandPortalOptions {
	childRowFromTarget?: boolean;
	/** resolve_data only: stamp parent_section_id on entry-carrying children. */
	stampParentSectionId?: boolean;
	/** Full config ddo map for RECURSIVE descendant resolution. */
	descendantsMap?: Ddo[];
	/** The REQUEST lang for translatable children (portals are nolan). */
	childrenLang?: string;
	/** Effective list-config page limit (show.sqo_config.limit ?? sqo.limit). */
	cellLimit?: number | null;
	/** Children came from the component's OWN config (not the client map). */
	ownConfig?: boolean;
	/** Nesting depth (cycle guard for list-cell recursion). */
	depth?: number;
	/** Page offset (the get_data pagination rqo's sqo.offset). */
	offset?: number;
	/**
	 * The TEMPORARY client view order (the get_data rqo's sqo.view_order — a
	 * header click on a `sort_by_column` column, WC-2026-10-31-portal-order-model):
	 * orders the full list before paginating; never written. Top-level portal
	 * get_data only (read.ts readComponentData); never passed to a nested
	 * expansion.
	 */
	viewOrder?: ViewOrder | null | undefined;
	/**
	 * Component get_data / save-echo ddinfo shape (PHP component get_json):
	 * bare {tipo,section_id,section_tipo,value,parent} — no row stamps, chain
	 * ends at the root term (no trailing hierarchy label). Byte-diffed vs the
	 * oracle on rsc92/fr1 (2026-07-09).
	 */
	ddinfoBare?: boolean;
	/**
	 * The tool_time_machine preview's bound, set ONLY on the top-level
	 * expansion of a DIRECT dataframe read (section/read.ts readComponentData,
	 * model component_dataframe): its locators are frames, so each target
	 * record reads its compatible children AS OF the bound
	 * (tm_record/frame_as_of.ts). Never passed to a nested expansion.
	 */
	targetsAsOf?: TmAsOf;
}

/** A validated view order: the request's column + its wire direction. */
interface ValidViewOrder {
	tipo: string;
	direction: 'ASC' | 'DESC';
}

/**
 * The request's `sqo.view_order`, VALIDATED (order_locators.ts assertViewOrder:
 * column offered, column readable), or null when none was sent. Asked whatever
 * the record holds — expandPortal calls it BEFORE its empty short-circuit.
 */
async function validatedViewOrder(
	viewOrder: ViewOrder | null | undefined,
	locators: readonly unknown[],
	portalTipo: string,
	ownerSectionTipo: string,
	effectivePropertiesOf: (tipo: string) => Promise<unknown>,
): Promise<ValidViewOrder | null> {
	if (viewOrder === null || viewOrder === undefined) return null;
	const direction = await assertViewOrder(
		viewOrder,
		locators,
		await effectivePropertiesOf(portalTipo),
		portalTipo,
		ownerSectionTipo,
	);
	return { tipo: viewOrder.tipo, direction };
}

/** The FULL locator list in the view order (the stored array itself when none applies). */
async function rankedForView<T>(locators: T[], viewOrder: ValidViewOrder | null): Promise<T[]> {
	if (viewOrder === null || locators.length < 2) return locators;
	const reordered = await rankByViewColumn(locators, viewOrder.tipo, viewOrder.direction);
	return reordered === null ? locators : (reordered as T[]);
}

/**
 * One page of the (possibly view-ordered) list, each item stamped
 * `paginated_key` (PHP get_data_paginated: index + offset). Under a READ order
 * the key is the locator's STORED index (WC-2026-10-31-portal-order-model): it
 * is what a later persisted reorder (sort_data source_key/target_key)
 * addresses, and the display position is not. Without one the two coincide.
 */
function paginateLocators(
	locators: readonly Record<string, unknown>[],
	ordered: readonly Record<string, unknown>[],
	pageOffset: number,
	limit: number,
): Record<string, unknown>[] {
	const storedIndex = ordered === locators ? null : storedIndexOf(locators);
	return ordered
		.slice(pageOffset, limit > 0 ? pageOffset + limit : undefined)
		.map((locator, index) => ({
			...locator,
			paginated_key: storedIndex?.get(locator) ?? index + pageOffset,
		}));
}

/**
 * Portal subdatum expansion (PHP component_portal_json.php + get_subdatum):
 * emit the portal's own item (paginated locator slice + pagination stamp),
 * then expand each paginated locator's target record through the child ddos.
 * Child items are stamped row_section_id = locator.section_id and
 * parent_tipo = the portal tipo (class.common.php :2792-2799).
 */
export async function expandPortal(
	record: MatrixRecord,
	portalDdo: Ddo,
	model: string,
	childDdos: Ddo[],
	portalMode: string,
	portalLang: string,
	row: EmitRow,
	callerTipo: string,
	emission: EmissionContext,
	emitDdo: EmitDdoFn,
	options: ExpandPortalOptions = {},
): Promise<void> {
	// component_alias data key (WC-020): an alias's locators live in the
	// TARGET's relation slot; its stored model + effective config come from
	// the alias module (merged properties).
	const { resolveDataTipo, getEffectivePropertiesByTipo, getTargetStoredModel } = await import(
		'../ontology/alias.ts'
	);
	const portalDataTipo = await resolveDataTipo(portalDdo.tipo);
	const locators =
		((record.columns.relation as Record<string, unknown[]> | null)?.[portalDataTipo] as Record<
			string,
			unknown
		>[]) ?? [];

	// A present `sqo.view_order` is VALIDATED whatever the record holds —
	// column offered, column readable (order_locators.ts assertViewOrder) —
	// BEFORE the empty short-circuit: the same RQO is never refused on a record
	// with three locators and silently ignored on one with none
	// (WC-2026-10-31-portal-order-model item 4). Only the RANKING needs two.
	const viewOrder = await validatedViewOrder(
		options.viewOrder,
		locators,
		portalDdo.tipo,
		configOwnerOf(row).section_tipo,
		getEffectivePropertiesByTipo,
	);

	// EMPTY relation components emit NO data item at all (PHP portal_json:
	// the item push sits inside the `if data_value non-empty` guard :163).
	if (locators.length === 0) return;

	// LIST/TM cell page size: the ddo-declared limit (rsc139→5 in rsc368's
	// map) wins, then the component's EFFECTIVE list-config limit
	// (numisdata161→15, rsc860→1000, numisdata20→30, section_list-substituted
	// numisdata163→1), then the 1-locator cell (autocomplete_hi with no config
	// shows all its locators inline). Edit uses the ddo limit or default 10.
	const storedModel = (await getTargetStoredModel(portalDdo.tipo)) ?? model;
	const effectiveProperties = await getEffectivePropertiesByTipo(portalDdo.tipo);
	// EDIT limit chain (PHP calculate_default_limit + sync_pagination_from_config):
	// ddo/rqo limit → own request_config sqo.limit ?? show.sqo_config.limit
	// (LAST config item wins) → the component+edit default (maxRowsPerPage, the
	// same value request_config/build.ts stamps for the client paginator).
	const ownEditLimit = (): number | undefined => {
		const rawConfig = (
			effectiveProperties as {
				source?: {
					request_config?: {
						sqo?: { limit?: unknown };
						show?: { sqo_config?: { limit?: unknown } };
					}[];
				};
			} | null
		)?.source?.request_config;
		if (!Array.isArray(rawConfig)) return undefined;
		let resolved: number | undefined;
		for (const item of rawConfig) {
			const candidate = item?.sqo?.limit ?? item?.show?.sqo_config?.limit;
			if (typeof candidate === 'number') resolved = candidate;
		}
		return resolved;
	};
	const limit =
		portalMode === 'list'
			? (portalDdo.limit ??
				options.cellLimit ??
				(storedModel === 'component_autocomplete_hi' ? locators.length : PORTAL_LIST_LIMIT))
			: (portalDdo.limit ?? ownEditLimit() ?? dedaloConfig.features.maxRowsPerPage);
	// READ ORDER (WC-2026-10-31-portal-order-model — the stored array is the
	// only real order; no PHP oracle, no frozen fixture declares either key, so
	// parity is unchanged). A declared `order` is NOT applied here: the
	// record-write chokepoint stores a declared-order key sorted, so the read
	// serves it as stored (an array stored before the order was declared is the
	// `portal_declared_order` reconcile's to sort). The ONE read-time order is a
	// TEMPORARY client `view_order` (sqo.view_order, the header click on a
	// `sort_by_column` column — honoured on a declared-order portal too): over
	// the FULL locator list before paginating, never written, through the same
	// ranking function (order_locators.ts) the write uses.
	// (validated above, before the empty short-circuit; ranked here).
	const orderedLocators = await rankedForView(locators, viewOrder);

	// The get_data pagination rqo pages with sqo.offset (paginated_key: paginateLocators).
	const pageOffset = options.offset ?? 0;
	const page = paginateLocators(locators, orderedLocators, pageOffset, limit);

	// The portal's own data item: paginated locators + pagination info.
	// PHP re-stamps portal-descendant items in the OUTER section subdatum
	// (class.common.php :2792-2799 runs on the portal's whole element_json):
	// parent_tipo = the SECTION tipo and row_section_id = the outer record.
	const portalItem = buildDataItem(
		portalDdo.tipo,
		row.section_tipo,
		row.section_id,
		portalMode,
		'lg-nolan', // relation components are not translatable
		page,
	);
	portalItem.pagination = { total: locators.length, limit, offset: pageOffset };
	portalItem.parent_tipo = callerTipo;
	portalItem.parent_section_id = row.section_id;
	portalItem.row_section_id = row.section_id;
	emission.items.push(portalItem);

	// EXTERNAL targets of this page, resolved in ONE bounded fan-out before the
	// emit loop (see prefetchExternalTargets). Nothing about the dedalo path
	// changes: `externalSections` is empty for every portal in the installation
	// that does not point at an external section, and the two calls below return
	// immediately.
	const childShapes = await targetChildShapes(page, childDdos);
	await prefetchExternalTargets(page, childDdos, childShapes, emission);

	// Expand each paginated locator through the child ddos (record-major).
	for (const locator of page) {
		const targetSectionTipo = locator.section_tipo as string;
		// CANONICAL address for every emission below (the child items, their
		// row anchor and parent_section_id): the stored locator may still hold
		// the legacy string form, so canonicalize ONCE here rather than pass
		// the raw type through. External-service targets ('001338683', 'Q42')
		// are not convertible and keep their own bytes — which is why this is
		// canonicalizeStoredSectionId and not Number()
		// (WC-2026-08-10-section-id-int-canonical; repeals "PHP keeps the
		// locator's raw section_id type").
		const targetSectionId = canonicalizeStoredSectionId(locator.section_id) as number | string;
		const shape = childShapes.get(targetSectionTipo);
		// A target every one of whose compatible children DERIVES has no stored
		// row to look for — skip the pointless matrix query. Purely an
		// optimisation: the null-record fallback below is what carries
		// correctness, so a mis-declared over-broad ddo costs a query, not a
		// blank cell.
		const skipStoredLookup = shape?.hasDerived === true && !shape.hasStored;
		let targetRecord: MatrixRecord | null;
		// True when the target has NO stored row and we are rendering it from a
		// placeholder — the only situation in which a stored-value child cannot
		// resolve. A target that HAS a record (test3, rsc205) never sets this,
		// so no ordinary child is ever refused.
		let targetIsDerivedOnly = false;
		if (skipStoredLookup) {
			targetIsDerivedOnly = true;
			targetRecord = externalTargetRecord(targetSectionTipo, targetSectionId);
		} else {
			const targetTable = await getMatrixTableFromTipo(targetSectionTipo);
			if (targetTable === null) continue;
			// Per-read cached read (targets repeat across a page's rows and nested
			// expansions) — consulted AFTER the null-table early-return, same
			// contract as the bare read it replaces.
			// Only a matrix ADDRESS has a stored row. A non-address id (an external
			// remote id '000012281', verbatim) is never Number()-ed into one — that
			// read local record 12281 and rendered it as the remote record.
			targetRecord = await loadPortalTarget(
				emission,
				options.targetsAsOf,
				locator,
				targetTable,
				targetSectionTipo,
				targetSectionId,
				childDdos,
			);
			if (targetRecord === null) {
				// NO STORED ROW. v6 dispatches purely by component MODEL —
				// component_external::get_dato() never reads the record — so a
				// target whose compatible children derive their value still
				// renders; the record was never their source. Every other target
				// keeps the original skip, byte for byte.
				if (shape?.hasDerived !== true) continue;
				targetIsDerivedOnly = true;
				targetRecord = externalTargetRecord(targetSectionTipo, targetSectionId);
			}
		}

		// Resolve each child through the SHARED emission path (full model-family
		// logic — relations/media/selects inside a portal render correctly). The
		// items are collected here so the outer-subdatum re-stamp (PHP
		// :2792-2799) can rewrite from_component_tipo/parent_tipo/row_section_id.
		const before = emission.items.length;
		// Keep the locator's RAW id type — components instantiated from a
		// locator inherit its string form (PHP get_subdatum passes it as-is;
		// the dd560 frame's section_id "17976" is the pinned case).
		const targetRow = {
			section_tipo: targetSectionTipo,
			section_id: targetSectionId as number,
		};
		// The DESCENDANT map — every level below this portal, not just its own
		// children — so a grandchild resolves by walking the parent chain. The
		// `?? childDdos` fallback is a LAST RESORT for callers that pass no map
		// at all (relation_index's deliberate one-level expansions): a caller
		// that HAS a map must hand the whole thing down, or every level below
		// the first is silently dropped (the numisdata3 list bug).
		const descendantsMap = options.descendantsMap ?? childDdos;
		// LIST-cell subdatum recurses into nested portals' OWN configs (PHP goes
		// bibliography → reference → author, three levels); get_data/resolve_data
		// stay one level (their gates pinned the PHP depth). The CYCLE guard is
		// not here — `depth < 4` below gates the own-config lookup only; the
		// child recursion itself is bounded by MAX_DDO_DEPTH in section/read.ts
		// emitDdoData, the one place every hop passes through.
		const depth = options.depth ?? 0;
		// PHP recursion is STRUCTURAL: nested portals re-enter portal_json in
		// EVERY mode. LIST/TM keep the ownConfig gate (their effective config
		// is the substituted section_list map); EDIT portals always recurse —
		// a nested portal with declared grandchildren uses the parent-map
		// slice (childDdos filtering), otherwise its OWN config (PHP injected
		// request_config precedence, class.common.php:2603-2681). depth<4 is
		// the pragmatic bound on how far the own-config lookup chases.
		const allowNestedOwnConfig =
			depth < 4 && (portalMode === 'edit' || (portalMode === 'list' && options.ownConfig === true));
		for (const childDdo of childDdos) {
			// PHP get_subdatum groups child ddos BY section_tipo and expands only
			// the ones compatible with the current locator's target (numisdata97
			// declares numisdata33 → skipped at an object1 target). 'self' and
			// undeclared section_tipos pass (they resolve to the portal targets).
			if (
				!ddoTargetsSection(childDdo, targetSectionTipo) &&
				(await getModelByTipo(childDdo.tipo)) !== 'component_dataframe'
			) {
				continue;
			}
			// THIS filter is what makes a multi-engine child map safe, and why no
			// api_engine branch is needed anywhere in the read path: a zenon1
			// locator only ever sees the ddos declared at zenon1, an rsc205
			// locator only the dedalo ones. Dispatch stays model-polymorphic.
			//
			// The gate is RECORD ABSENCE, never `properties.api_config`: test3 and
			// rsc205 both carry an api_config and are ordinary sections with rows,
			// so they never reach it and never lose a child.
			if (targetIsDerivedOnly) {
				const childModel = await getModelByTipo(childDdo.tipo);
				// With no stored row, only a DERIVED-value model can render.
				// Anything else would be handed the empty placeholder and emit a
				// blank that looks exactly like a genuinely empty field — refuse it
				// loudly instead (a component_dataframe pairs with the MAIN record
				// and is handled below).
				if (childModel !== 'component_external' && childModel !== 'component_dataframe') {
					console.warn(
						`[relations/relation_core] ddo '${childDdo.tipo}' (model ${childModel}) cannot resolve at target '${targetSectionTipo}' id '${String(targetSectionId)}' — that target has no stored record; only a derived model renders there`,
					);
					continue;
				}
			}
			// component_dataframe ddos pair with the MAIN record (never the
			// locator target): route to the frame emitter (PHP get_subdatum's
			// dataframe branch — section_id = the caller's record, id_key = the
			// locator's item id).
			if ((await getModelByTipo(childDdo.tipo)) === 'component_dataframe') {
				await emitDataframeItem(
					childDdo,
					record,
					portalDdo.tipo,
					(locator.id as number | string | undefined) ?? (locator.section_id as number | string),
					childDdo.mode ?? portalMode,
					row,
					options.childrenLang ?? portalLang,
					callerTipo,
					emission,
					depth,
					emitDdo,
				);
				continue;
			}
			await emitDdo(
				childDdo,
				descendantsMap, // full map → grandchildren resolve by parent chain
				targetRecord,
				targetRow,
				'list',
				options.childrenLang ?? portalLang,
				callerTipo,
				emission,
				allowNestedOwnConfig,
				depth + 1,
			);
		}
		// ddinfo: the HIERARCHY widget (component_autocomplete_hi) appends each
		// thesaurus target's ancestor-breadcrumb item after the term children
		// (PHP dd_info — parent chain + hierarchy label). Plain autocompletes
		// with thesaurus targets (numisdata34 → object1) do NOT emit it.
		// The TM record-snapshot list renders the flat term subdatum only — PHP's
		// service_time_machine cell emits no ddinfo breadcrumb (verified against
		// the live oracle), unlike the edit widget.
		//
		// A target qualifies when it lives in the thesaurus table OR when the
		// own config declares `value_with_parents` on a child ddo compatible
		// with it (portalCellEmitsDdinfo): PHP emits dd_info per vwp ddo, and
		// USER-DEFINED thesauri live in the generic `matrix` table (`tch555`'s
		// `tchi1`), so the table check alone loses their edit-cell breadcrumb.
		// The TM check is the READ's data source, not the cell's render mode:
		// dd15 cells now emit mode 'list' like every other list cell
		// (WC-2026-08-14-tm-ddo-mode-retired), so `portalMode !== 'tm'` stopped
		// being able to see a Time Machine cell. This is one of the two sites where
		// 'tm' was a real branch rather than a synonym of 'list'; the suppression
		// itself is unchanged and still oracle-verified.
		if (
			options.ownConfig === true &&
			storedModel === 'component_autocomplete_hi' &&
			!isTimeMachineRead()
		) {
			const { buildDdInfoChain, isThesaurusTarget } = await import('../resolve/dd_info.ts');
			if (
				portalCellEmitsDdinfo(childDdos, targetSectionTipo) ||
				(await isThesaurusTarget(targetSectionTipo))
			) {
				// ddinfoBare (the component get_data / save-echo surface, PHP
				// component get_json → get_subdatum → get_ddinfo_parents): the item
				// carries ONLY {tipo, section_id, section_tipo, value, parent} — no
				// row stamps — and the chain ends at the ROOT TERM (no trailing
				// hierarchy label). Byte-diffed vs the oracle on rsc92/fr1
				// (2026-07-09). The section-read portal cell keeps the stamped,
				// label-terminated shape.
				const ddInfoItem = {
					tipo: 'ddinfo',
					section_id: targetSectionId,
					section_tipo: targetSectionTipo,
					value: await buildDdInfoChain(
						targetSectionTipo,
						targetSectionId,
						options.childrenLang ?? portalLang,
						options.ddinfoBare !== true,
					),
					parent: portalDdo.tipo,
				} as unknown as DataItem;
				if (options.ddinfoBare !== true) {
					(ddInfoItem as Record<string, unknown>).row_section_id = row.section_id;
					(ddInfoItem as Record<string, unknown>).parent_tipo = callerTipo;
				}
				emission.markStamped(ddInfoItem);
				emission.items.push(ddInfoItem);
			}
		}
		for (let i = before; i < emission.items.length; i++) {
			const childItem = emission.items[i] as DataItem;
			if (emission.isStamped(childItem)) {
				// The BARE ddinfo (component get_data / save echo) carries no row
				// stamps at all — PHP get_ddinfo_parents emits exactly
				// {tipo, section_id, section_tipo, value, parent} (byte-diffed
				// 2026-07-09); skip the anchor/parent rewrite entirely.
				if (options.ddinfoBare === true && childItem.tipo === 'ddinfo') {
					continue;
				}
				// A deeper expansion already fixed this item's identity — PHP keeps
				// the NESTED creating portal's from_component_tipo; only the row
				// anchor and outward parent rewrite.
				childItem.row_section_id = options.childRowFromTarget
					? childItem.row_section_id
					: row.section_id;
				childItem.parent_tipo = callerTipo;
				continue;
			}
			childItem.from_component_tipo = portalDdo.tipo; // the CREATING portal (PHP :2684)
			childItem.section_id = targetSectionId; // canonical (see the expansion head)
			// get_data children belong to the OUTER record; resolve_data children
			// (injected locators, no outer record) belong to their TARGET.
			childItem.row_section_id = options.childRowFromTarget ? targetSectionId : row.section_id;
			// parent_section_id on children is FLOW-specific (both pinned live):
			// resolve_data (search chips) stamps it on ENTRY-CARRYING children —
			// PHP's !empty($value) test, i.e. a non-empty entries array (since
			// WC-001 unified empty entries on [], a null check would stamp
			// every child); get_data does NOT — there it is portal-item
			// decoration only (nested portal items carry it from their OWN
			// expansion). The authentic-capture replay + resolve_data gates pin
			// both sides.
			if (
				options.stampParentSectionId === true &&
				Array.isArray(childItem.entries) &&
				childItem.entries.length > 0
			) {
				childItem.parent_section_id = targetSectionId;
			}
			childItem.parent_tipo = callerTipo;
			emission.markStamped(childItem);
		}
	}
}

/**
 * The record a frame bag is read from (emitDataframeItem). It lives on the
 * record of the ddo's DECLARED section_tipo (PHP builds the component_dataframe
 * instance with the ddo's scalar section_tipo + the caller's section_id).
 * Components shared across sections may anchor their frames on a SIBLING
 * record: numisdata75 in a numisdata3 read stores its numisdata1531/1532 frames
 * on the numisdata4 record with the SAME section_id. 'self'/undeclared reads
 * the main record.
 *
 * Under a TM bound (`asOf`, the subject's own frames only: `mainRecord` is
 * the emission ROOT) the record is addressed by the SUBJECT (frame_as_of.ts
 * subjectRowOf): in the dd15 history list `mainRecord` is the virtual row
 * record standing in for it, whose own section/id address nothing. A sibling bag is then read AS OF the bound (the
 * main's own slots are already grafted into `mainRecord`: applyTmGraft on a
 * preview, the list's row frame state).
 */
async function frameBagRecord(
	emission: EmissionContext,
	frameDdo: Ddo,
	mainRecord: MatrixRecord,
	mainComponentTipo: string,
	row: { section_tipo: string; section_id: number },
	bound: FrameBound | null,
): Promise<MatrixRecord | null> {
	const subject = bound?.module.subjectRowOf(bound.asOf, mainRecord) ?? {
		section_tipo: mainRecord.section_tipo,
		section_id: row.section_id,
	};
	// The main record itself (a literal main's undeclared slot names it) or the
	// subject it stands for holds the bag; any other section is a sibling.
	const declared = siblingFrameSection(frameDdo, [subject.section_tipo, mainRecord.section_tipo]);
	if (declared === null) return mainRecord;
	const frameTable = await getMatrixTableFromTipo(declared);
	if (frameTable === null) return null;
	const anchor = { sectionTipo: declared, sectionId: Number(subject.section_id) };
	const live = await loadRecordCached(emission, frameTable, declared, anchor.sectionId);
	if (bound === null) return live;
	return bound.module.frameBagAsOf(
		emission,
		anchor,
		live,
		mainComponentTipo,
		frameDdo.tipo,
		bound.asOf,
	);
}

/** A frame emission's TM bound and the (lazily loaded) module that reads it. */
interface FrameBound {
	asOf: TmAsOf;
	module: typeof import('../tm_record/frame_as_of.ts');
}

/** The frame ddo's declared section when it is a SIBLING (none of `ownSections`); null = the main record holds the bag. */
function siblingFrameSection(frameDdo: Ddo, ownSections: readonly string[]): string | null {
	const declared = Array.isArray(frameDdo.section_tipo)
		? frameDdo.section_tipo[0]
		: frameDdo.section_tipo;
	if (typeof declared !== 'string' || declared === 'self' || ownSections.includes(declared)) {
		return null;
	}
	return declared;
}

/**
 * component_dataframe slot (PHP get_subdatum's dataframe branch + the frame's
 * own json): the frame pairs with the MAIN record — entries are the main
 * record's relation[frameTipo] dd490 locators matching this main component
 * and the paired item id (id_key), paged by the frame's OWN config limit.
 * Emitted even when empty (entries [], total 0 — numisdata1447). The frame's
 * config children (rsc1246 mode edit) resolve at each paired entry's target,
 * stamped from_component_tipo = the frame.
 */
export async function emitDataframeItem(
	frameDdo: Ddo,
	mainRecord: MatrixRecord,
	mainComponentTipo: string,
	pairId: number | string,
	frameModeIn: string,
	row: { section_tipo: string; section_id: number },
	requestLang: string,
	callerTipo: string,
	emission: EmissionContext,
	depth: number,
	emitDdo: EmitDdoFn,
): Promise<void> {
	const { resolveFrameConfig } = await import('../section/list_definitions/section_list.ts');
	const frame = await resolveFrameConfig(frameDdo.tipo);
	const frameLimit = frame.limit;
	// TM PREVIEW / HISTORY-LIST ROW: the subject's own frames read AS OF the
	// row (WC-2026-09-29-tm-preview-frame-children-as-of) — the sibling bag and
	// the frame children. Null for every other read, and for every NESTED
	// dataframe (a main record other than the emission root — the subject's own
	// record met again nested included; confinement: frameTargetsAsOf).
	const asOfModule = emission.tmAsOf === null ? null : await import('../tm_record/frame_as_of.ts');
	const asOf =
		asOfModule === null
			? null
			: await asOfModule.frameTargetsAsOf(emission, mainComponentTipo, mainRecord);
	const bound: FrameBound | null =
		asOf !== null && asOfModule !== null ? { asOf, module: asOfModule } : null;
	const bagRecord = await frameBagRecord(
		emission,
		frameDdo,
		mainRecord,
		mainComponentTipo,
		row,
		bound,
	);
	// component_alias data key (WC-020) — uniformity; no live alias targets a frame.
	const { resolveDataTipo: resolveFrameDataTipo } = await import('../ontology/alias.ts');
	// KEPT UNION below: the raw stored dataframe bag — unswept rows still hold
	// the legacy string id, and a frame paired to an external target holds that
	// service's non-convertible remote id. Entries are re-emitted VERBATIM.
	const bag =
		((bagRecord?.columns.relation as Record<string, unknown[]> | null)?.[
			await resolveFrameDataTipo(frameDdo.tipo)
		] as
			| {
					id_key?: number | string;
					main_component_tipo?: string;
					section_tipo?: string;
					section_id?: number | string;
			  }[]
			| undefined) ?? [];
	const matched = bag.filter((entry) => dataframeEntryMatches(entry, mainComponentTipo, pairId));
	const page = matched.slice(0, frameLimit).map((entry, index) => ({
		...entry,
		paginated_key: index,
	}));

	const item = buildDataItem(
		frameDdo.tipo,
		// Frame ddos are caller-scoped: a single declared section (never a
		// multi-target array) or the host row's section.
		(Array.isArray(frameDdo.section_tipo) ? frameDdo.section_tipo[0] : frameDdo.section_tipo) ??
			row.section_tipo,
		row.section_id,
		frameModeIn,
		'lg-nolan',
		page, // [] when empty — the frame item ALWAYS emits
	);
	item.pagination = { total: matched.length, limit: frameLimit, offset: 0 };
	item.from_component_tipo = mainComponentTipo;
	// The pairing context rides ON the frame item (PHP: the caller-aware
	// component_dataframe instance stamps its dataframe_caller onto the data
	// item — id_key as INT + the main component; the resolve_data empty-slot
	// items pinned the same shape).
	item.id_key = Number(pairId);
	item.main_component_tipo = mainComponentTipo;
	item.row_section_id = row.section_id;
	item.parent_tipo = callerTipo;
	emission.markStamped(item);
	emission.items.push(item);

	// Frame children at each paired target (frame config modes AS DECLARED).
	for (const entry of page) {
		const targetSection = entry.section_tipo;
		const targetId = entry.section_id;
		if (typeof targetSection !== 'string' || targetId === undefined) continue;
		const table = await getMatrixTableFromTipo(targetSection);
		if (table === null) continue;
		// A matrix ADDRESS reads its stored row; anything else (an external remote
		// id, verbatim — never Number()-ed into a different local record) has none,
		// and only a DERIVED child (component_external) can render there, on the
		// identity-only placeholder — the portal expansion's rule.
		const frameTargetId = canonicalizeStoredSectionId(targetId) as number | string;
		const isAddress = isSectionId(frameTargetId);
		// TM preview: an addressed target reads its frame children AS OF the bound.
		const targetRecord = !isAddress
			? externalTargetRecord(targetSection, frameTargetId)
			: asOf !== null && asOfModule !== null
				? await asOfModule.loadFrameTargetAsOf(
						emission,
						table,
						targetSection,
						frameTargetId as number,
						asOf,
						frame.ddos.map((child) => child.tipo),
					)
				: await loadRecordCached(emission, table, targetSection, frameTargetId as number);
		if (targetRecord === null) continue;
		for (const child of frame.ddos) {
			if (!isAddress && (await getModelByTipo(child.tipo)) !== 'component_external') continue;
			// Frame config children default to LIST mode (dd1715); declared modes
			// pass through (rsc1246 edit).
			const childMode = child.mode ?? 'list';
			const before = emission.items.length;
			await emitDdo(
				{
					tipo: child.tipo,
					section_tipo: targetSection,
					parent: frameDdo.tipo,
					mode: childMode,
					lang: child.lang,
				} as Ddo,
				[],
				targetRecord,
				{ section_tipo: targetSection, section_id: frameTargetId as number },
				childMode,
				requestLang,
				callerTipo,
				emission,
				false,
				depth + 1,
			);
			for (let i = before; i < emission.items.length; i++) {
				const childItem = emission.items[i] as DataItem;
				childItem.from_component_tipo = frameDdo.tipo;
				childItem.section_id = targetId; // keep the entry's raw id type
				childItem.row_section_id = row.section_id;
				childItem.parent_tipo = callerTipo;
				(childItem as DataItem & { parent?: string }).parent = frameDdo.tipo;
				emission.markStamped(childItem);
			}
		}
	}
}
