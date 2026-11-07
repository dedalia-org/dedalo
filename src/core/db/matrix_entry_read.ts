/**
 * A NARROW READ OF ONE NESTED ITEM OF A COMPONENT'S VALUE — what a caller that needs a
 * single small object out of a large value asks for, instead of reading the whole row.
 *
 * `readMatrixRecord` (matrix.ts) selects every JSONB column of the row and its `::text` twin,
 * and the caller parses all of it. For a component whose value carries something big beside
 * the small thing wanted — a geolocation entry holds its drawn layers (`lib_data`, GeoJSON
 * that can run to megabytes) next to the map `sources` the tile proxy needs one of — doing
 * that per request, with a viewport asking for dozens of tiles, is a megabyte read,
 * serialised and parsed in full, to find a 300-byte object.
 *
 * This asks Postgres for just the matching items, with a JSONPath evaluated inside the
 * database (`jsonb_path_query_array`), so only those objects are returned:
 *
 *   <column> -> <componentTipo> -> [every entry] -> <key> -> [every item] where item.id = <id>
 *
 * LAX mode on purpose: a value stored as a single object instead of an array (legacy matrix
 * compat) is read as a one-element array, and a null or malformed hole is skipped, which is
 * what `readComponentItems` does for the full read.
 *
 * SAFETY. The table is allowlist-validated (`assertMatrixTable`); the column is one of the
 * fixed JSONB columns; the component tipo, the key and the id are checked against their
 * grammar before they are written into the path, and the section tipo/id are bound
 * parameters. The path is built from those pieces and from nothing else, and a JSONPath has
 * no way to write: this is a read.
 */

import { isValidTipo } from '../concepts/ontology.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { assertMatrixTable, MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn } from './matrix.ts';
import { sql } from './postgres.ts';

/** The key of the items in an entry: a lower-case word (`sources`). */
const ITEM_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** What to find: items `key` of the entries of `componentTipo` whose `id` is `itemId`. */
export interface NestedItemQuery {
	readonly tableName: string;
	readonly sectionTipo: string;
	readonly sectionId: number;
	readonly column: MatrixJsonbColumn;
	readonly componentTipo: string;
	readonly key: string;
	readonly itemId: number;
}

/** The query's pieces are all of their grammar, or this says which is not. */
function queryProblem(query: NestedItemQuery): string | null {
	if (!MATRIX_JSONB_COLUMNS.includes(query.column)) return 'column';
	if (!isValidTipo(query.componentTipo)) return 'component tipo';
	if (!ITEM_KEY.test(query.key)) return 'key';
	return Number.isSafeInteger(query.itemId) && query.itemId > 0 ? null : 'item id';
}

/** The JSONPath for `query`, written from validated pieces only. */
function pathOf(query: NestedItemQuery): string {
	return `$."${query.componentTipo}"[*]."${query.key}"[*] ? (@.id == ${query.itemId})`;
}

/**
 * The items that match, raw as stored (an empty array when none, or when the record or the
 * component is absent). Throws on a query whose pieces are not of their grammar: that is a
 * defect in the caller, never a caller's input reaching the database.
 */
export async function readNestedItemsById(query: NestedItemQuery): Promise<unknown[]> {
	assertMatrixTable(query.tableName);
	const problem = queryProblem(query);
	if (problem !== null) {
		throw new DedaloError('internal.invariant', {
			message: `readNestedItemsById: the ${problem} is not valid`,
		});
	}
	const rows = (await sql.unsafe(
		`SELECT jsonb_path_query_array("${query.column}", $1::jsonpath) AS found
		   FROM "${query.tableName}"
		  WHERE section_tipo = $2 AND section_id = $3
		  LIMIT 1`,
		[pathOf(query), query.sectionTipo, query.sectionId],
	)) as { found: unknown[] | null }[];
	return rows[0]?.found ?? [];
}
