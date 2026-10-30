/**
 * MULTI-ENGINE ddo-map FLATTENING — the shared step that makes a component with
 * MORE THAN ONE request_config item resolve every one of them.
 *
 * A relation component may declare several config items: a `main` + a
 * `secondary` scope (numisdata573's two hierarchy filters), or — the case this
 * module exists for — a `dedalo` item plus a non-dedalo one (rsc368 declares
 * dedalo + zenon; five nodes in this installation do). Until this landed, every
 * consumer took `request_config[0]`, so the SECOND item's children were never
 * resolved at all: rsc368's zenon1 locators expanded through the dedalo item's
 * ddos, matched none of them (per-locator section_tipo filter), and rendered an
 * empty cell.
 *
 * NO api_engine BRANCH LIVES HERE, and none may. Dispatch stays
 * model-polymorphic exactly as the oracle does it: the flattened map is filtered
 * PER LOCATOR by the locator's own `section_tipo` (relation_core.expandPortal),
 * so a zenon1 locator sees only the ddos declared at zenon1 and an rsc205
 * locator only the dedalo ones. The engine name never enters the read path.
 *
 * ORACLE: class.common.php:2312-2341 (`full_ddo_map`), reproduced faithfully:
 *  - every item contributes `show.ddo_map` then `hide.ddo_map` (hide ddos are
 *    server-resolved data the client widgets consume without rendering as
 *    columns — numisdata585's hierarchy31 feeds the map observer);
 *  - an item whose SHOW map is empty is SKIPPED WHOLE — its hide map does not
 *    contribute either (PHP `continue`s before the hide push, :2325) — and the
 *    skip is logged, because PHP logs it as a WARNING and the usual cause is a
 *    permission drop that emptied the map;
 *  - duplicates are removed keeping the FIRST occurrence.
 *
 * THE HIDE MAP IS EMISSION-ONLY. `full_ddo_map` is what the CLIENT gets; the
 * FLAT/EXPORT consumer (export atoms, list-cell JOIN) is built by PHP from
 * `show->ddo_map` alone — see `includeHideDdos` below for the oracle lines and
 * what leaks without it.
 *
 * ONE DELIBERATE DIVERGENCE, in the dedup KEY. PHP keys on
 * `tipo + '_' + parent + '_' + json_encode(section_tipo)`; this keys on the
 * WHOLE normalised ddo. PHP's coarse key silently drops a second ddo that
 * differs only in `mode`, `lang`, `limit` or `value_with_parents` — two
 * genuinely different renders of the same component collapse into one. The
 * structural key never collapses two ddos that differ, so it is a strict
 * superset of what PHP keeps. Ledgered: engineering/wire_contract/
 * WC-2026-08-05-multi-engine-ddo-expansion.md.
 *
 * `section_tipo` is normalised for the KEY ONLY by sorting a COPY: it is a SET
 * of target sections, so [a,b] and [b,a] are the same ddo (PHP's json_encode is
 * order-sensitive and would keep both). The EMITTED ddo keeps the declared
 * array verbatim — flattening it to [0] is the numisdata6 §2 bug (a multi-target
 * child then matched only the first target section).
 */

/**
 * One request_config item, as far as this module cares. NO index signature —
 * callers pass their own richer item types unchanged (ParsedRequestConfigItem,
 * the raw ontology shape) without widening.
 */
export interface ConfigDdoMapSource {
	readonly show?: { ddo_map?: unknown } | null;
	readonly hide?: { ddo_map?: unknown } | null;
}

/** A raw ddo entry — shape is the caller's business; only `tipo` is assumed. */
export type ConfigDdo = Record<string, unknown>;

/**
 * Stable structural rendering of any JSON-ish value: object keys sorted, array
 * ORDER PRESERVED (an ordered list is not a set — only `section_tipo` is
 * normalised, by its caller below).
 */
function stableKey(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`).join(',')}}`;
}

/**
 * The dedup identity of one ddo: the full normalised ddo (see the module doc on
 * why a coarse (tipo, section_tipo) key is wrong). Exported so the gates can
 * assert the collapse rule directly instead of inferring it from a map.
 */
export function normalizedDdoKey(ddo: ConfigDdo): string {
	const rawSection = ddo.section_tipo;
	// A section_tipo ARRAY is a set of targets — sort a COPY for the key. Never
	// mutate, and never flatten: the emitted ddo keeps the declaration.
	const normalized: ConfigDdo = Array.isArray(rawSection)
		? { ...ddo, section_tipo: [...(rawSection as unknown[])].map(String).sort() }
		: ddo;
	return stableKey(normalized);
}

export interface FlattenConfigDdoMapsOptions {
	/** The component the config belongs to — names it in the skip log. */
	readonly ownerTipo: string;
	/**
	 * Log an item skipped for an empty show map. PHP logs it in get_subdatum
	 * ONLY (:2319), so the subdatum caller opts in; the config-shape readers
	 * (section_list) stay quiet — a component with a search-only config item is
	 * ordinary, not a warning.
	 */
	readonly logEmptyShowMap?: boolean;
	/**
	 * Include each item's `hide.ddo_map` (default TRUE — PHP full_ddo_map).
	 *
	 * FALSE for the FLAT/EXPORT consumer, which the oracle builds from
	 * `show->ddo_map` ONLY: class.component_relation_common.php:756-761
	 * (get_export_value) and :331-339 (get_grid_value). PHP resolves hide
	 * separately into `$ar_hide` — "used as internal data … it doesn't show into
	 * the list" (class.component_common.php:2932-2960). Emitting them as flat
	 * fields double-prints every dataframe rating (numisdata188 declares rsc1246
	 * in BOTH maps, differing only in mode → "Alta, Alta") and pushes the 8
	 * hierarchy31-hiding autocomplete_hi nodes into the `unresolved` ledger.
	 *
	 * The exclusion is at the INPUT, not a post-filter: a hide ddo must never win
	 * the dedup slot of a later item's show ddo it collides with.
	 */
	readonly includeHideDdos?: boolean;
}

/** Flatten EVERY config item's show (+ hide, unless refused) maps into one deduped list. */
export function flattenConfigDdoMaps(
	items: readonly ConfigDdoMapSource[] | null | undefined,
	options: FlattenConfigDdoMapsOptions,
): ConfigDdo[] {
	if (!Array.isArray(items)) return [];
	const includeHide = options.includeHideDdos !== false;
	const flattened: ConfigDdo[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const showDdos = item?.show?.ddo_map;
		if (!Array.isArray(showDdos) || showDdos.length === 0) {
			// PHP :2317-2326 — the whole item is skipped, hide map included. The
			// usual cause is step-11 permission drops emptying the map, which an
			// operator must be able to see.
			if (options.logEmptyShowMap === true) {
				console.warn(
					`[relations/config_ddo_map] ${options.ownerTipo}: request_config item with an empty show.ddo_map ignored (its hide map too) — PHP class.common.php:2317`,
				);
			}
			continue;
		}
		const hideDdos = includeHide ? item?.hide?.ddo_map : undefined;
		const candidates = Array.isArray(hideDdos) ? [...showDdos, ...hideDdos] : showDdos;
		for (const candidate of candidates) {
			if (candidate === null || typeof candidate !== 'object') continue;
			const ddo = candidate as ConfigDdo;
			const key = normalizedDdoKey(ddo);
			if (seen.has(key)) continue; // FIRST occurrence wins (PHP array_filter)
			seen.add(key);
			flattened.push(ddo);
		}
	}
	return flattened;
}

/**
 * The render fields a config child ddo carries VERBATIM into the subdatum map —
 * ONE definition shared by the two twins that build that map from a
 * component's own config: the section read (models/portal.ts
 * buildOwnConfigDescendants) and the component get_data read
 * (section/read.ts readComponentData). `tipo`, `parent` and `lang` stay the
 * caller's business (each twin resolves `'self'` and stamps the lang its own way).
 *
 * WHY ONE MAPPER. The get_data twin once copied only tipo/section_tipo/parent/
 * mode/lang, so a child `limit` was lost there: a nested portal cell
 * (numisdata965 → numisdata9 `limit: 4`) rendered 4 coins per row on the first
 * load and collapsed to the 1-locator list default on every refresh, save echo
 * or page of the outer portal. Gate: test/unit/portal_nested_ddo_limit_native.test.ts.
 *
 *  - `section_tipo` keeps the DECLARED list intact (a multi-target child spans
 *    every target; the per-locator grouping picks the match — numisdata6 §2);
 *  - `limit` is the child cell's own page size (relation_core.expandPortal);
 *  - `value_with_parents` is the breadcrumb trigger
 *    (relation_core portalCellEmitsDdinfo).
 */
export interface ConfigChildRenderFields {
	section_tipo: string | string[] | undefined;
	mode: string | undefined;
	limit: number | undefined;
	value_with_parents: boolean | undefined;
}

export function configChildRenderFields(child: ConfigDdo): ConfigChildRenderFields {
	return {
		section_tipo: child.section_tipo as string | string[] | undefined,
		mode: child.mode as string | undefined,
		limit: child.limit as number | undefined,
		value_with_parents: child.value_with_parents as boolean | undefined,
	};
}
