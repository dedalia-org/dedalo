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
 * - `sort_by_column: true` → the user may click the column header to
 *   PERSISTENTLY reorder the portal by this column (a write; gated in
 *   `save.ts applySortByColumn`, surfaced to the client via
 *   `ui.allow_column_order`).
 * - `order: "asc" | "desc"` (or `true` = asc) → this column is part of the
 *   DEFAULT read order applied every read FOR DISPLAY (this module), without
 *   writing the stored array. Multiple ordered columns → priority follows their
 *   ddo_map declaration order.
 *
 * Both share ONE ranking engine (`rankLocatorsByColumns`): a target-section
 * search restricted to the linked `section_id`s ordered on the column(s), then a
 * rank-map re-order of the stored locators (unresolved locators fall to the END,
 * stable — PHP usort with rank map). The per-ddo keys ride the parsed
 * request_config passthrough (`request_config/explicit.ts` spreads `...rawDdo`),
 * so the server read/save paths and the client all see them without any
 * `ddoSchema` change. No PHP oracle; opt-in, so read-path parity is unchanged.
 */

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
 * properties declare a per-ddo `order` on any request_config column? Lets the
 * portal read hot-path skip the whole ordering machinery unless it is used.
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
			const clean = entry.item as Record<string, unknown>;
			// biome-ignore lint/performance/noDelete: paginated_key must be ABSENT in persisted data
			delete clean.paginated_key;
			sorted[position] = clean;
		});
	return sorted;
}

/**
 * READ-time entry point: order a portal's stored locators by the per-ddo `order`
 * directives on its columns. Builds the portal's effective edit config to
 * resolve the columns (and their target sections), then ranks. Returns null
 * (caller keeps stored order) when no column declares `order` or fewer than two
 * locators exist.
 */
export async function orderLocatorsByDeclaredColumns(
	items: unknown[],
	properties: unknown,
	componentTipo: string,
	sectionTipo: string,
): Promise<unknown[] | null> {
	if ((items as unknown[]).length < 2) return null;
	if (!hasDeclaredColumnOrder(properties)) return null;

	// The ranking scope is the TARGET section(s) — where the linked records
	// live — read from the locators, NOT the caller `sectionTipo` (a portal
	// column's 'self' means its target, not the host).
	const targets = locatorTargetSections(items);
	const firstTarget = targets[0];
	if (firstTarget === undefined) return null;

	const { buildRequestConfigForElement } = await import('./request_config/build.ts');
	const config = await buildRequestConfigForElement(properties ?? null, {
		ownerTipo: componentTipo,
		ownerSectionTipo: sectionTipo,
		mode: 'edit',
		ownerIsSection: false,
	});
	const columns = (config[0]?.show?.ddo_map ?? []) as ConfigColumn[];

	const ordered = orderedColumnsFromDdoMap(columns);
	if (ordered.length === 0) return null;
	// Per-model order paths (relation columns join to the linked leaf), anchored
	// on the target section; search over EVERY distinct target section.
	const order = await buildOrderEntries(ordered, firstTarget);
	if (order.length === 0) return null;
	return rankLocatorsByColumns(items, targets, order);
}
