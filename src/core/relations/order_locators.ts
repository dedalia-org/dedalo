/**
 * PORTAL COLUMN SORT (RELATIONS_SPEC.md §6.1) — v7-native, per-ddo model.
 *
 * The portal's sort directives live ON the column ddo (a
 * `properties.source.request_config[].show.ddo_map` entry), NOT on top-level
 * component properties (the PHP-inherited `properties.sort_by_column` /
 * `properties.order_by` are GONE — DEC/WC-048). Two independent per-ddo keys:
 *
 *   { "tipo": "rsc85", "sort_by_column": true, "order": "asc" }
 *
 * - `sort_by_column: true` → the column header offers a sort: a TEMPORARY
 *   read-time view (`sqo.view_order`, below), whose "save current order" is
 *   the persisted `sort_by_column` action (gated in `save.ts
 *   applySortByColumn`, surfaced to the client via `ui.allow_column_order`).
 * - `order: "asc" | "desc"` (or `true` = asc) → this column is part of the
 *   portal's PERMANENT declared order, applied to the stored array at WRITE
 *   time (ORDER MODEL below). Multiple ordered columns → priority follows their
 *   ddo_map declaration order.
 *
 * Both share ONE ranking engine (`rankLocatorsByColumns`): a target-section
 * search restricted to the linked `section_id`s ordered on the column(s), then a
 * rank-map re-order of the stored locators (unresolved locators fall to the END,
 * stable — PHP usort with rank map). The per-ddo keys ride the parsed
 * request_config passthrough (`request_config/explicit.ts` spreads `...rawDdo`),
 * so the server read/save paths and the client all see them without any
 * `ddoSchema` change. No PHP oracle; opt-in, so read-path parity is unchanged.
 *
 * ORDER MODEL (owner ruling 2026-10-31 — WC-2026-10-31-portal-order-model,
 * addendum on WC-048). The STORED locator array is the only real order:
 *
 *  - a declared `order` is PERMANENT and enforced at WRITE time — the
 *    record-write chokepoint (section_record/record_write.ts
 *    `applyKeySaveRules`) sorts every relation key whose component declares it,
 *    through {@link sortByDeclaredOrder}, on every door (save, link, TM
 *    restore, removal, observer mirror, birth). This module is the ONE ordering
 *    function the chokepoint, the read path and the reconcile share;
 *  - the read serves the stored array AS STORED (no read-time declared sort);
 *    an array stored before its order was declared is sorted by the
 *    `portal_declared_order` reconcile (relations/declared_order_reconcile.ts:
 *    operator, and queued after an ontology change adds or changes an order);
 *  - a client header click is a TEMPORARY `view_order` (sqo.view_order):
 *    {@link orderLocatorsByViewOrder} orders the full list for display before
 *    paginating, never writes, and is honoured on a declared-order portal too;
 *  - under ANY read order each emitted locator's `paginated_key` is its STORED
 *    index ({@link storedIndexOf} in relation_core.ts expandPortal), so a later
 *    persisted reorder addresses the right item;
 *  - `sort_data` / `sort_by_column` on a declared-order portal are refused
 *    (relations/save.ts assertNoDeclaredOrder): the chokepoint would undo
 *    either on the same write.
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { getEffectivePropertiesByTipo, resolveDataTipo } from '../ontology/alias.ts';
import { getAncestorSectionTipo, getNode } from '../ontology/resolver.ts';
import { ddoIsAuthorized, type Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';

/** One ORDER BY step: an order PATH (single-step for literals/dates, multi-step
 * for relations — the join chain from the target section to the sortable leaf,
 * built by `buildOrderPath`), plus the direction. */
export interface PortalOrderEntry {
	direction: 'ASC' | 'DESC';
	path: { section_tipo?: string; component_tipo?: string }[];
}

/** One declared order column: which component, ascending or descending. */
export interface OrderedColumn {
	componentTipo: string;
	direction: 'ASC' | 'DESC';
}

/** A resolved config column (a `show.ddo_map` entry), carrying the per-ddo keys. */
interface ConfigColumn {
	tipo?: unknown;
	section_tipo?: unknown;
	order?: unknown;
	sort_by_column?: unknown;
}

/** `"asc"`/`"desc"` (any case) or boolean `true` (= asc) → direction; else null. */
export function normalizeDirection(raw: unknown): 'ASC' | 'DESC' | null {
	if (raw === true) return 'ASC';
	if (typeof raw !== 'string') return null;
	const dir = raw.toUpperCase();
	return dir === 'ASC' || dir === 'DESC' ? dir : null;
}

/**
 * CHEAP gate (no DB, no config build): does the component's raw effective
 * properties declare a per-ddo `order` on any request_config column? Lets every
 * key write (and the context build) skip the whole ordering machinery unless
 * it is used.
 */
export function hasDeclaredColumnOrder(properties: unknown): boolean {
	const requestConfig = (properties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	if (!Array.isArray(requestConfig)) return false;
	for (const item of requestConfig) {
		const ddoMap = (item as { show?: { ddo_map?: unknown } })?.show?.ddo_map;
		if (
			Array.isArray(ddoMap) &&
			ddoMap.some((ddo) => normalizeDirection((ddo as ConfigColumn)?.order) !== null)
		) {
			return true;
		}
	}
	return false;
}

/**
 * PURE: a node's DECLARED ORDER as a comparable signature — per request_config
 * item, the `[tipo, direction]` of every `show.ddo_map` column declaring a valid
 * `order`, in declaration order — or null when it declares none. The
 * ontology-change trigger (ontology_state.ts rebuildOntology,
 * ontology_projection.ts projectOntologyNode) compares it before/after a node
 * write: a change re-sorts the portal's hosts (relations/declared_order_reconcile.ts).
 * Reads RAW node properties (what the write changed), never the alias merge.
 */
export function declaredOrderSignature(properties: unknown): string | null {
	if (!hasDeclaredColumnOrder(properties)) return null;
	const requestConfig = (properties as { source: { request_config: unknown[] } }).source
		.request_config;
	return JSON.stringify(
		requestConfig.map((item) => {
			const ddoMap = (item as { show?: { ddo_map?: unknown } })?.show?.ddo_map;
			if (!Array.isArray(ddoMap)) return [];
			return ddoMap.flatMap((ddo) => {
				const direction = normalizeDirection((ddo as ConfigColumn)?.order);
				return direction === null ? [] : [[String((ddo as ConfigColumn).tipo), direction]];
			});
		}),
	);
}

/**
 * PURE: the tipos whose declared order a node write ADDED or CHANGED (`after`
 * declares one and it differs from `before`), sorted. A REMOVED declaration
 * re-sorts nothing: the stored array simply stops being re-ordered.
 */
export function changedDeclaredOrderTipos(
	before: ReadonlyMap<string, string | null>,
	after: ReadonlyMap<string, string | null>,
): string[] {
	const changed: string[] = [];
	for (const [tipo, signature] of after) {
		if (signature !== null && signature !== (before.get(tipo) ?? null)) changed.push(tipo);
	}
	return changed.sort();
}

/**
 * PURE: the columns that declare a valid `order`, in declaration order (= sort
 * priority), each with its normalized direction. DB-free, unit-tested directly.
 */
export function orderedColumnsFromDdoMap(columns: ConfigColumn[]): OrderedColumn[] {
	const out: OrderedColumn[] = [];
	for (const column of columns) {
		const direction = normalizeDirection(column.order);
		if (direction === null) continue;
		const componentTipo = typeof column.tipo === 'string' ? column.tipo : '';
		if (componentTipo === '') continue;
		out.push({ componentTipo, direction });
	}
	return out;
}

/**
 * Resolve each ordered column to a full ORDER entry via `buildOrderPath` — the
 * per-MODEL order path: single-step for literals/dates, a JOIN chain to the
 * sortable leaf for RELATIONS (a checkbox/autocomplete/portal column orders by
 * the LINKED record's sort column, not a non-existent `.value` on the locator).
 * `targetSectionTipo` is the section the linked records live in.
 */
export async function buildOrderEntries(
	ordered: OrderedColumn[],
	targetSectionTipo: string,
): Promise<PortalOrderEntry[]> {
	if (targetSectionTipo === '') return [];
	const { buildOrderPath } = await import('../search/order_path.ts');
	const order: PortalOrderEntry[] = [];
	for (const column of ordered) {
		const path = await buildOrderPath(column.componentTipo, targetSectionTipo);
		if (path.length === 0) continue;
		order.push({ direction: column.direction, path });
	}
	return order;
}

/** Distinct target section(s) of the locators being sorted (the ranking scope). */
export function locatorTargetSections(items: unknown[]): string[] {
	return [
		...new Set(
			(items as { section_tipo?: unknown }[])
				.map((item) => (typeof item?.section_tipo === 'string' ? item.section_tipo : ''))
				.filter((tipo) => tipo !== ''),
		),
	];
}

/**
 * The shared ranking engine (extracted from PHP sort_data_by_column): a
 * target-section search over the linked `section_id`s, ordered on the given
 * column(s); the stored locators are then re-ordered by that rank, unresolved
 * ones kept in relative order at the END (stable). `paginated_key` is stripped
 * so a persisted result never leaks the read-time page index.
 */
export async function rankLocatorsByColumns(
	items: unknown[],
	targets: string[],
	order: PortalOrderEntry[],
): Promise<unknown[]> {
	const locatorItems = items as { section_id?: unknown; section_tipo?: unknown }[];
	if (locatorItems.length < 2) return [...items];
	const firstTarget = targets[0];
	if (firstTarget === undefined || order.length === 0) return [...items];

	const ids = [...new Set(locatorItems.map((item) => Number(item?.section_id ?? 0)))];
	const { buildSearchSql } = await import('../search/sql_assembler.ts');
	const { runSearch } = await import('../search/search_statement.ts');
	const rankSearch = await buildSearchSql({
		section_tipo: targets,
		// 'all', NOT 0: the assembler renders `limit: 0` as a literal `LIMIT 0`
		// (zero rows) — only 'all'/null means unbounded. Every linked record must
		// be ranked, so the rank search is unbounded.
		limit: 'all',
		offset: 0,
		filter: {
			$or: [
				{
					q: ids.join(','),
					q_operator: null,
					path: [
						{
							section_tipo: firstTarget,
							component_tipo: 'section_id',
							model: 'component_section_id',
							name: 'Id',
						},
					],
				},
			],
		},
		order,
	} as never);
	const rows = await runSearch<{ section_tipo: string; section_id: number }>(rankSearch);
	const rank = new Map<string, number>();
	rows.forEach((row, index) => {
		rank.set(`${row.section_tipo}_${row.section_id}`, index);
	});

	const rankOf = (item: { section_id?: unknown; section_tipo?: unknown }): number =>
		rank.get(`${item?.section_tipo ?? ''}_${Number(item?.section_id ?? 0)}`) ??
		Number.MAX_SAFE_INTEGER;
	const sorted = [...locatorItems];
	// stable sort by rank (PHP usort with rank map; ties keep relative order)
	sorted
		.map((item, index) => ({ item, index }))
		.sort((a, b) => rankOf(a.item) - rankOf(b.item) || a.index - b.index)
		.forEach((entry, position) => {
			const clean = entry.item as Record<string, unknown> | null;
			// A non-object item (a legacy null / scalar the value-shape law now
			// refuses on save but never cleaned) is kept where it ranks (unresolved:
			// the END), untouched: this runs on the WRITE chokepoint, where a
			// TypeError here would block every door that re-persists the stored
			// array (a target delete, a TM restore) instead of writing it.
			if (clean !== null && typeof clean === 'object') {
				// biome-ignore lint/performance/noDelete: paginated_key must be ABSENT in persisted data
				delete clean.paginated_key;
			}
			sorted[position] = entry.item;
		});
	return sorted;
}

/**
 * The declared order columns of a portal, resolved through its effective EDIT
 * config (`config[0].show.ddo_map` — the same config the read and the column
 * sort build), in declaration order (= sort priority). Empty when none declare
 * `order`. The CHEAP raw gate runs first, so a portal without `order` never
 * builds its config here.
 */
export async function resolveDeclaredColumns(
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<OrderedColumn[]> {
	if (!hasDeclaredColumnOrder(properties)) return [];
	const config = await editConfigColumns(properties, componentTipo, sectionTipo);
	return orderedColumnsFromDdoMap(config);
}

/**
 * The component's effective EDIT config item (config[0]): its columns and its target sections.
 * The ONE narrowing of the declared-order family (external_config_narrowing_census:
 * deferred) — the observer subscription build reads it here, never re-narrows.
 */
export async function editConfig(
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<{ columns: ConfigColumn[]; targets: string[] }> {
	// CONVENTIONS §2 rationale 3 (rarely hit): only a portal that declares an
	// `order` or receives a `view_order` reaches the config build; every other
	// key write and read stops at the cheap raw gate without loading it.
	const { buildRequestConfigForElement } = await import('./request_config/build.ts');
	const { extractSqoSectionTipos } = await import('./request_config/explicit.ts');
	const config = await buildRequestConfigForElement(properties ?? null, {
		ownerTipo: componentTipo,
		ownerSectionTipo: sectionTipo,
		mode: 'edit',
		ownerIsSection: false,
	});
	return {
		columns: (config[0]?.show?.ddo_map ?? []) as ConfigColumn[],
		targets: extractSqoSectionTipos(config[0]),
	};
}

/** The `show.ddo_map` columns of the component's effective EDIT config (config[0]). */
async function editConfigColumns(
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<ConfigColumn[]> {
	return (await editConfig(properties, componentTipo, sectionTipo)).columns;
}

/** Rank `items` by `ordered` columns over their TARGET section(s); null = keep stored order. */
async function rankByColumns(
	items: unknown[],
	ordered: OrderedColumn[],
): Promise<unknown[] | null> {
	if (items.length < 2 || ordered.length === 0) return null;
	// The ranking scope is the TARGET section(s) — where the linked records
	// live — read from the locators, NOT the caller `sectionTipo` (a portal
	// column's 'self' means its target, not the host).
	const targets = locatorTargetSections(items);
	const firstTarget = targets[0];
	if (firstTarget === undefined) return null;
	// Per-model order paths (relation columns join to the linked leaf), anchored
	// on the target section; search over EVERY distinct target section.
	const order = await buildOrderEntries(ordered, firstTarget);
	if (order.length === 0) return null;
	return rankLocatorsByColumns(items, targets, order);
}

/**
 * THE declared-order ranking: order a portal's locators by the per-ddo `order`
 * directives on its columns. Returns null (caller keeps stored order) when no
 * column declares `order` or fewer than two locators exist. Shared by the
 * write chokepoint ({@link sortByDeclaredOrder}) and the `portal_declared_order`
 * reconcile — one function, so the two can never disagree on what "sorted" means.
 */
export async function orderLocatorsByDeclaredColumns(
	items: unknown[],
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<unknown[] | null> {
	if ((items as unknown[]).length < 2) return null;
	if (!hasDeclaredColumnOrder(properties)) return null;
	const ordered = await resolveDeclaredColumns(properties, componentTipo, sectionTipo);
	return rankByColumns(items, ordered);
}

/**
 * THE TIPO A DECLARED ORDER IS KEYED ON: the component's DATA tipo
 * (ontology/alias.ts resolveDataTipo — a component_alias's target, WC-020;
 * the tipo itself otherwise). The stored array lives under the data tipo, every
 * save is re-keyed to it before the chokepoint (save_component.ts), the
 * reconcile scans it — so the context, the refusal, the atomic-append gates,
 * the chokepoint's sort and the reconcile all ask THIS tipo, and an alias and
 * its target can never answer differently (WC-2026-10-31-portal-order-model
 * §"one predicate"). An alias's OWN `source` override may re-shape its columns
 * for display, but an `order` declared there is no declared order anywhere —
 * the reconcile census NAMES it ({@link aliasOwnDeclaredOrder}), never silently.
 */
async function orderKeyOf(componentTipo: string): Promise<{ tipo: string; properties: unknown }> {
	const tipo = await resolveDataTipo(componentTipo);
	return { tipo, properties: await getEffectivePropertiesByTipo(tipo) };
}

/**
 * CHEAP pre-gate on the data tipo (no config build): may `componentTipo`
 * carry a declared order at all? False = no save rule can change its value, so
 * a caller (the observer re-save) skips the row lock and the rank work. True
 * is only "maybe" — {@link componentDeclaresOrder} is the predicate.
 */
export async function mayDeclareOrder(componentTipo: string): Promise<boolean> {
	return hasDeclaredColumnOrder((await orderKeyOf(componentTipo)).properties);
}

/** Is `tipo` a component_alias NODE (its raw model — getModelByTipo answers the target's)? */
export async function isAliasNode(tipo: string): Promise<boolean> {
	return (await getNode(tipo))?.model === 'component_alias';
}

/**
 * A component_alias whose OWN effective properties declare an `order` that its
 * data tipo does not (a different signature): returns that target tipo, else
 * null (not an alias, no own order, or the same order as its target). That
 * order is ignored everywhere ({@link orderKeyOf}); the reconcile census names
 * it so the ontology can be corrected.
 */
export async function aliasOwnDeclaredOrder(tipo: string): Promise<string | null> {
	if (!(await isAliasNode(tipo))) return null;
	const own = declaredOrderSignature(await getEffectivePropertiesByTipo(tipo));
	if (own === null) return null;
	const target = await orderKeyOf(tipo);
	return own === declaredOrderSignature(target.properties) ? null : target.tipo;
}

/** The host section of a component when the caller has none (a birth's columns). */
async function hostSectionOf(componentTipo: string, hostSectionTipo?: string): Promise<string> {
	if (hostSectionTipo !== undefined && hostSectionTipo !== '') return hostSectionTipo;
	return (await getAncestorSectionTipo(componentTipo)) ?? '';
}

/**
 * Is the component a DECLARED-ORDER portal — the ONE predicate the refusal
 * (relations/save.ts assertNoDeclaredOrder), the atomic-append gates
 * (save_component.ts, record_write.ts assertAppendableKey), the context
 * (`declared_order`, {@link declaredOrderOf}) and the chokepoint's sort
 * ({@link sortByDeclaredOrder}) all answer through, all asked by the DATA tipo
 * ({@link orderKeyOf} — an alias answers as its target): the RESOLVED edit config
 * (config[0]) carries at least one column declaring `order`. The raw scan
 * ({@link hasDeclaredColumnOrder}) stays the cheap pre-gate only — an `order`
 * on a later request_config item, or on a column the edit build drops, is not
 * a declared order anywhere (WC-2026-10-31-portal-order-model §"one predicate"):
 * refusing a reorder there while the context offers it and the chokepoint never
 * sorts would leave the portal neither reorderable nor kept in order.
 */
export async function componentDeclaresOrder(
	componentTipo: string,
	hostSectionTipo?: string,
): Promise<boolean> {
	return (await declaredOrderOf(componentTipo, hostSectionTipo)) !== null;
}

/**
 * The declared order of a component as the CONTEXT emits it
 * (`context.declared_order`, WC-2026-10-31-portal-order-model): `[{tipo,
 * direction}]` in priority order, or null when it declares none — the client's
 * ONE authority for "is this a declared-order portal" (no client mirror of the
 * predicate).
 */
export async function declaredOrderOf(
	componentTipo: string,
	hostSectionTipo?: string,
): Promise<{ tipo: string; direction: 'ASC' | 'DESC' }[] | null> {
	const key = await orderKeyOf(componentTipo);
	if (!hasDeclaredColumnOrder(key.properties)) return null;
	const ordered = await resolveDeclaredColumns(
		key.properties,
		key.tipo,
		await hostSectionOf(key.tipo, hostSectionTipo),
	);
	if (ordered.length === 0) return null;
	return ordered.map((column) => ({ tipo: column.componentTipo, direction: column.direction }));
}

/**
 * WRITE-time entry (the record-write chokepoint's save rule, record_write.ts
 * `applyKeySaveRules`): the component's stored value sorted by its declared
 * order, or null when it declares none / nothing to sort (the caller writes the
 * value as given). Properties are read by the DATA tipo ({@link orderKeyOf});
 * the host section falls back to the component's ontology ancestor (a birth
 * carries columns, not a target).
 */
export async function sortByDeclaredOrder(
	items: unknown[],
	componentTipo: string,
	hostSectionTipo?: string,
): Promise<unknown[] | null> {
	if (items.length < 2) return null;
	const key = await orderKeyOf(componentTipo);
	if (!hasDeclaredColumnOrder(key.properties)) return null;
	return orderLocatorsByDeclaredColumns(
		items,
		key.properties,
		key.tipo,
		await hostSectionOf(key.tipo, hostSectionTipo),
	);
}

/** A TEMPORARY client view order (sqo.view_order): one column, one direction. */
export interface ViewOrder {
	tipo: string;
	direction: string;
}

/** A view_order direction in the wire spelling only (sqoSchema: 'ASC' | 'DESC'), never the ontology's lenient one; else null. */
function wireDirection(direction: unknown): 'ASC' | 'DESC' | null {
	return direction === 'ASC' || direction === 'DESC' ? direction : null;
}

/**
 * The TEMPORARY client view order's VALIDATION (sqo.view_order — the header
 * click), run whenever a view_order is present, whatever the record holds
 * (WC-2026-10-31-portal-order-model item 4 — the same RQO is never accepted on
 * a record with one locator and refused on one with three). Refused typed
 * (`request.invalid_data`, reason `view_order`) unless:
 *  - the direction is the wire spelling ("ASC" | "DESC");
 *  - the column is a `show.ddo_map` column of the component's own edit config
 *    declaring `sort_by_column: true` — the same opt-in the persisted
 *    `sort_by_column` honours (relations/save.ts applySortByColumn);
 *  - the request principal holds READ (level >= 1) on EVERY STEP of the order
 *    path the ranking will sort on, from every section the ranking could
 *    search (the edit config's target sections and the locators' own): the
 *    column itself there AND, for a relation column, each hop down to its
 *    sortable leaf (search/order_path.ts buildOrderPath — a filter column ends
 *    on the project name in dd153, a portal column on its target's list
 *    column, …), each judged in the step's own section
 *    (security/permissions.ts ddoIsAuthorized). The rank search is
 *    system-scoped (it is shared with the write chokepoint, which must see
 *    every value), so the relative order of the ranked page would otherwise
 *    compare values the caller may not read — the ordering side channel the
 *    general search closes on BOTH the root step (search/conform.ts
 *    rootOrderStepAllowed) and every hop (sql_assembler buildJoinChain, SEC-02).
 *    Here it is refused typed rather than silently dropped: the client asked
 *    for exactly this one column. No request principal (an internal
 *    resolution) applies no filter, as everywhere ddoIsAuthorized is asked.
 * Returns the validated direction.
 */
export async function assertViewOrder(
	viewOrder: ViewOrder,
	items: readonly unknown[],
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<'ASC' | 'DESC'> {
	const refuse = (why: string): never => {
		throw new DedaloError('request.invalid_data', {
			message: `view_order: column '${viewOrder.tipo}' (${String(viewOrder.direction)}) ${why} of '${componentTipo}'`,
			coordinates: { tipo: componentTipo, reason: 'view_order', column: viewOrder.tipo },
		});
	};
	const direction = wireDirection(viewOrder.direction);
	const { columns, targets } = await editConfig(properties, componentTipo, sectionTipo);
	const column = columns.find((entry) => entry.tipo === viewOrder.tipo);
	if (direction === null || column === undefined || column.sort_by_column !== true) {
		return refuse('is not a sort_by_column column');
	}
	const principal = currentPrincipal();
	if (principal === undefined) return direction;
	const searched = [...new Set([...targets, ...locatorTargetSections([...items])])];
	for (const section of searched) {
		const unreadable = await unreadableOrderStep(principal, viewOrder.tipo, section);
		if (unreadable !== null) {
			return refuse(
				`is not readable by the request principal (step '${unreadable.component}' in '${unreadable.section}' of its order path from '${section}'), a column`,
			);
		}
	}
	return direction;
}

/**
 * The first step of `columnTipo`'s ORDER PATH anchored on `section` (the path
 * {@link rankByColumns} sorts on — buildOrderEntries → buildOrderPath) that the
 * principal may NOT read, or null when every step is readable. Step 0 is the
 * column itself in `section` (asked by the column tipo: a section_id-model
 * column's path carries a structural `column` override, never a different
 * tipo); every later step is a relation HOP judged in its own section.
 */
async function unreadableOrderStep(
	principal: Principal,
	columnTipo: string,
	section: string,
): Promise<{ section: string; component: string } | null> {
	if (!(await ddoIsAuthorized(principal, section, columnTipo))) {
		return { section, component: columnTipo };
	}
	// CONVENTIONS §2 rationale 3 (rarely hit): only a request carrying a
	// view_order loads the order-path module here — the same lazy edge
	// buildOrderEntries takes.
	const { buildOrderPath } = await import('../search/order_path.ts');
	const hops = (await buildOrderPath(columnTipo, section)).slice(1);
	for (const hop of hops) {
		const hopSection = hop.section_tipo || section;
		if (!(await ddoIsAuthorized(principal, hopSection, hop.component_tipo))) {
			return { section: hopSection, component: hop.component_tipo };
		}
	}
	return null;
}

/**
 * READ-time TEMPORARY view order (sqo.view_order — the header click):
 * the full locator list ordered by ONE column for display, before paginating;
 * never written. Validated first ({@link assertViewOrder}: column offered,
 * column readable). Honoured on a declared-order portal too (the temporary
 * view is allowed there; only its SAVE is refused). Null = nothing to reorder
 * (fewer than two locators / unranked) — the validation has still run.
 */
export async function orderLocatorsByViewOrder(
	items: unknown[],
	viewOrder: ViewOrder,
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<unknown[] | null> {
	const direction = await assertViewOrder(viewOrder, items, properties, componentTipo, sectionTipo);
	return rankByViewColumn(items, viewOrder.tipo, direction);
}

/**
 * The view order's RANKING alone — for a caller that already ran
 * {@link assertViewOrder} (relation_core.ts expandPortal validates before its
 * empty short-circuit). Null = nothing to reorder.
 */
export async function rankByViewColumn(
	items: unknown[],
	columnTipo: string,
	direction: 'ASC' | 'DESC',
): Promise<unknown[] | null> {
	return rankByColumns(items, [{ componentTipo: columnTipo, direction }]);
}

/**
 * `paginated_key` under a read order = the locator's STORED index: a
 * map from each stored locator OBJECT to its position. The ranking functions
 * return the same object references they were given, so an ordered page looks
 * its items up here; an item not found (never, by construction) falls back to
 * the caller's display index.
 */
export function storedIndexOf(stored: readonly unknown[]): Map<unknown, number> {
	const index = new Map<unknown, number>();
	stored.forEach((item, position) => {
		if (!index.has(item)) index.set(item, position);
	});
	return index;
}
