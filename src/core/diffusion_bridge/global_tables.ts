/**
 * GLOBAL (aggregate) publication tables — the pieces BOTH sides of the seam
 * read: the publish side (src/diffusion: plan compile, sql writer, reconcile)
 * and the delete side (this directory: diffusion_graph → diffusion_delete).
 * Core cannot import src/diffusion/**, so the shared grammar lives here, once.
 *
 * v6 `global_table_maps` (diffusion_sql::update_record :277-302 →
 * save_global_table_data :2477-2652): a table node may declare
 *
 *   "global_table_maps": [{ "table_tipo": "<global table node>",
 *     "columns_map": [{ "target_column": "...", "source_columns": ["..."],
 *                       "format"?: "string", "separator"?: " | " }] }]
 *
 * and every published row of its section is ALSO written, per lang, into that
 * global table under the composite key `<section_tipo>_<section_id>` (the key
 * column is the global node's own `section_id` field, a VARCHAR). The key
 * grammar below is the ONE producer/parser: the writer keys its rows with it,
 * the delete door and the reconcile withdraw by it.
 */

/** The table-node property that declares the maps (ontology vocabulary). */
export const GLOBAL_TABLE_MAPS_KEY = 'global_table_maps';

/** The composite global-row key of one source record (v6 `$section_tipo .'_'. $section_id`). */
export function globalRowKey(sectionTipo: string, sectionId: number | string): string {
	return `${sectionTipo}_${sectionId}`;
}

/**
 * The source section_id a global-row key carries for `sectionTipo`, or null
 * when the key belongs to another section (or is not a key at all). Exact:
 * `zzdif1_5` is NOT a key of `zzdif` nor of `zzdif10`.
 */
export function parseGlobalRowKey(key: string, sectionTipo: string): number | null {
	const prefix = `${sectionTipo}_`;
	if (!key.startsWith(prefix)) return null;
	const rest = key.slice(prefix.length);
	if (!/^[0-9]+$/.test(rest)) return null;
	const id = Number(rest);
	return Number.isSafeInteger(id) ? id : null;
}

/**
 * The SQL LIKE pattern selecting every global-row key of one section
 * (`_` escaped: it is a LIKE wildcard). Bind it as a parameter; the result
 * still goes through parseGlobalRowKey (LIKE alone cannot reject `<tipo>_x`).
 */
export function globalRowKeyLikePattern(sectionTipo: string): string {
	return `${sectionTipo.replace(/[\\%_]/g, (char) => `\\${char}`)}\\_%`;
}

/**
 * The maps a table node publishes with — KEY-LEVEL alias fallback (v6
 * update_record :278-287): the node's own `global_table_maps` when it declares
 * the key, else its real node's. (The virtual tree's whole-bag inheritance is
 * not enough: an alias carrying OTHER own properties would lose the real's maps.)
 */
export function globalTableMapsOf(
	ownProperties: Record<string, unknown> | null | undefined,
	realProperties: Record<string, unknown> | null | undefined,
): unknown {
	const own = ownProperties?.[GLOBAL_TABLE_MAPS_KEY];
	if (own !== undefined) return own;
	return realProperties?.[GLOBAL_TABLE_MAPS_KEY];
}

/** The distinct `table_tipo`s a maps value names (malformed entries ignored — the compiler reports them). */
export function globalTableTiposOf(maps: unknown): string[] {
	if (!Array.isArray(maps)) return [];
	const tipos: string[] = [];
	for (const entry of maps) {
		const tipo = (entry as { table_tipo?: unknown } | null)?.table_tipo;
		if (typeof tipo === 'string' && tipo !== '' && !tipos.includes(tipo)) tipos.push(tipo);
	}
	return tipos;
}
