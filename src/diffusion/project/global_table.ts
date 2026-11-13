/**
 * Global-table rows from a section's projected rows — the PURE half of v6
 * diffusion_sql::save_global_table_data (:2477-2580). One global row per
 * source ProjectedRow (same lang), keyed by the composite
 * `<section_tipo>_<section_id>` (core/diffusion_bridge/global_tables.ts).
 *
 * Per row: the provenance columns the global node declares
 * (`ref_section_id`, `ref_section_tipo`, `ref_table`, `link` = JSON
 * `{table, section_id}`), then every `columns_map` item:
 *   - each source value is read from the source row (`section_id` / `lang`
 *     are the automatic ones) and a string is JSON-decoded when it decodes to
 *     a non-null value (v6 `json_decode($v) ?? $v`);
 *   - `format: 'string'` → the values joined by `separator` (default ' | '),
 *     each as v6 to_string renders it;
 *   - otherwise one source → that value, two or more → a JSON array of them;
 *   - the result is conformed like v6 conform_field_value: null / '[]' / an
 *     empty array or object → NULL, a non-empty one → JSON, a boolean → 1/0.
 *
 * Deliberate divergences from v6 (engineering/wire_contract/
 * WC-2026-11-12-global-table-maps.md): a non-scalar inside `format: 'string'`
 * renders as COMPACT JSON (v6 pretty-printed it) and an empty array as ''
 * (v6 'Array(empty)').
 *
 * CARRIERS (owner C11, 2026-11-13 — WC addendum): a map item whose
 * `sourceCarriers` does not name THIS section's table node (its sources are
 * an alias's own columns, absent from this carrier's rows) writes NULL under
 * its target column — the carrier that has the column fills the same
 * composite-keyed row. Never a `0` for a source "not found" (v6).
 */

import { globalRowKey } from '../../core/diffusion_bridge/global_tables.ts';
import type { GlobalColumnMap, GlobalTablePlan, SectionPlan } from '../plan/types.ts';
import type { ProjectedRow } from './lang_ladder.ts';

/** v6 default separator of `format: 'string'`. */
const DEFAULT_SEPARATOR = ' | ';

/** v6 `json_decode($value) ?? $value` on a string; anything else as is. */
function decodeSourceValue(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		const decoded: unknown = JSON.parse(value);
		return decoded ?? value;
	} catch {
		return value;
	}
}

/** One element of `format: 'string'` (v6 to_string, compact where v6 was pretty). */
function scalarText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '';
		const first = value[0];
		if (typeof first === 'string' || typeof first === 'number') return value.join('|');
	}
	return JSON.stringify(value);
}

/** v6 diffusion_mysql::conform_field_value, as the bound parameter it produces. */
function conformValue(value: unknown): string | null {
	if (value === null || value === undefined || value === '[]') return null;
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.length === 0 ? null : JSON.stringify(value);
	if (typeof value === 'object')
		return Object.keys(value).length === 0 ? null : JSON.stringify(value);
	return String(value);
}

/** The value of one source column in one row (decoded). */
function sourceValue(row: ProjectedRow, source: string): unknown {
	if (source === 'section_id') return row.sectionId;
	if (source === 'lang') return row.lang;
	return decodeSourceValue(row.columns[source] ?? null);
}

/** One `columns_map` item's bound value. */
function mappedValue(row: ProjectedRow, map: GlobalColumnMap): string | null {
	const values = map.sourceColumns.map((source) => sourceValue(row, source));
	if (map.format === 'string') {
		return values.map(scalarText).join(map.separator ?? DEFAULT_SEPARATOR);
	}
	if (values.length < 2) return conformValue(values[0]);
	return JSON.stringify(values.map((value) => value ?? null));
}

/** The provenance columns' values (only the declared ones are written). */
function provenanceValues(
	section: SectionPlan,
	global: GlobalTablePlan,
	row: ProjectedRow,
): Record<string, string | null> {
	// v6 iterates `$ar_fields` by its int keys: the link carries a NUMBER id.
	const id =
		typeof row.sectionId === 'string' && /^[0-9]+$/.test(row.sectionId)
			? Number(row.sectionId)
			: row.sectionId;
	const all: Record<string, string> = {
		ref_section_id: String(row.sectionId),
		ref_section_tipo: section.sectionTipo,
		ref_table: section.tableName,
		link: JSON.stringify({ table: section.tableName, section_id: id }),
	};
	const columns: Record<string, string | null> = {};
	for (const column of global.provenance) columns[column] = all[column] ?? null;
	return columns;
}

/** The global rows of a batch of source rows (one per row, same lang). */
export function deriveGlobalRows(
	section: SectionPlan,
	global: GlobalTablePlan,
	rows: readonly ProjectedRow[],
): ProjectedRow[] {
	return rows.map((row) => {
		const columns = provenanceValues(section, global, row);
		for (const map of global.columnsMap) {
			columns[map.targetColumn] =
				map.sourceCarriers !== undefined && !map.sourceCarriers.includes(section.tableTipo)
					? null
					: mappedValue(row, map);
		}
		return {
			sectionId: globalRowKey(section.sectionTipo, row.sectionId),
			lang: row.lang,
			columns,
		};
	});
}
