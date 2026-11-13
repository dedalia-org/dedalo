/**
 * Matrix table access — the JSONB record store shared with the PHP server.
 *
 * Every Dédalo section stores its records as one row per (section_tipo,
 * section_id) in a matrix table. v7 splits component data across TYPED JSONB
 * columns (verified against the live dedalo_mib_v7 schema):
 *
 *   data, relation, string, date, iri, geo, number, media, misc,
 *   relation_search, meta
 *
 * plus the structural columns id (serial), section_id, section_tipo.
 * Which matrix table a section lives in is resolved FROM THE ONTOLOGY
 * (common::get_matrix_table_from_tipo in PHP) — hardcoding table names outside
 * the allowlist below is forbidden.
 *
 * BYTE-COMPAT RULE (spec §2.2): reads return the JSONB columns BOTH parsed
 * (for logic) and as raw ::text (for parity diffing). All WRITES will go
 * through json_codec.ts (Phase 2) — none exist yet.
 *
 * SECURITY: table names are identifiers and cannot be parameterized; they are
 * validated against MATRIX_TABLE_ALLOWLIST before interpolation (§7.6 pattern).
 * section_tipo/section_id are always bound parameters.
 */

import { MATCH_TRIM_PATTERN } from '../concepts/match_text.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { sql } from './postgres.ts';

/** JSONB data columns of a v7 matrix table (mirrors search trait.utils allowlist). */
export const MATRIX_JSONB_COLUMNS = [
	'data',
	'relation',
	'string',
	'date',
	'iri',
	'geo',
	'number',
	'media',
	'misc',
	'relation_search',
	'meta',
] as const;
export type MatrixJsonbColumn = (typeof MATRIX_JSONB_COLUMNS)[number];

/**
 * Matrix tables that follow the STANDARD record contract (the typed JSONB
 * column set above + id/section_id/section_tipo). Verified against the live
 * dedalo_mib_v7 information_schema. The ontology resolver (Phase 2) will own
 * tipo→table mapping; this allowlist is the identifier gate either way.
 *
 * Deliberately NOT here — different column contracts, separate modules:
 * - matrix_time_machine        → flat audit columns; see time_machine.ts
 * - matrix_counter / _dd       → (tipo, value, ref) counter store
 * - matrix_notifications       → (id, data) queue
 * - matrix_updates             → (id, data) queue
 * - matrix_structurations      → legacy v6 leftover ('datos' column)
 *
 * matrix_activity / matrix_activity_diffusion carry one EXTRA column
 * (timestamp) on top of the standard set; the standard reader works for them
 * because it projects explicit columns only.
 */
export const MATRIX_TABLE_ALLOWLIST: readonly string[] = [
	'matrix',
	'matrix_activities',
	'matrix_activity',
	'matrix_activity_diffusion',
	'matrix_dataframe',
	'matrix_dd',
	'matrix_hierarchy',
	'matrix_hierarchy_main',
	'matrix_indexations',
	'matrix_langs',
	'matrix_layout',
	'matrix_layout_dd',
	'matrix_list',
	'matrix_nexus',
	'matrix_nexus_main',
	'matrix_notes',
	'matrix_ontology',
	'matrix_ontology_main',
	'matrix_profiles',
	'matrix_projects',
	'matrix_stats',
	'matrix_test',
	'matrix_tools',
	'matrix_users',
];

/** A matrix row: structural columns + parsed JSONB + raw text twins for parity. */
export interface MatrixRecord {
	id: number;
	section_id: number;
	section_tipo: string;
	/** Parsed JSONB columns (null when the column is NULL). */
	columns: Partial<Record<MatrixJsonbColumn, unknown>>;
	/** Raw `column::text` twins — byte-exact for parity diffing. */
	rawText: Partial<Record<MatrixJsonbColumn, string | null>>;
}

/** Whether tableName is a known matrix RECORD table (the allowlist, no throw). */
export function isMatrixTable(tableName: string): boolean {
	return MATRIX_TABLE_ALLOWLIST.includes(tableName);
}

/** Throws unless tableName is a known matrix table (identifier gate). */
export function assertMatrixTable(tableName: string): void {
	if (!MATRIX_TABLE_ALLOWLIST.includes(tableName)) {
		throw new DedaloError('internal.invariant', {
			message: `Refusing unknown matrix table '${tableName}' (identifier allowlist, spec §7.6)`,
			coordinates: { table: tableName },
		});
	}
}

/**
 * Read one record by (section_tipo, section_id) from a matrix table.
 * Returns null when the record does not exist.
 */
/**
 * Which of `sectionIds` already exist in the section — ONE query for the whole
 * set. A bulk import must decide create-or-update per row; asking the DB once
 * per row turns a 10k-row CSV into 10k round-trips for a question a single
 * `= ANY()` answers.
 */
export async function readExistingSectionIds(
	tableName: string,
	sectionTipo: string,
	sectionIds: readonly number[],
): Promise<Set<number>> {
	assertMatrixTable(tableName);
	if (sectionIds.length === 0) return new Set();
	// The table identifier is allowlist-validated; both values are bound. The id set
	// rides as a comma string through string_to_array (the driver does not bind a JS
	// array to ANY($n::int[]) — same pattern as relations/select_lang.ts).
	const rows = (await sql.unsafe(
		`SELECT section_id
		   FROM "${tableName}"
		  WHERE section_tipo = $1
		    AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[sectionTipo, [...new Set(sectionIds)].join(',')],
	)) as { section_id: number }[];
	return new Set(rows.map((row) => row.section_id));
}

/**
 * THE MATCH FOLD — `lower(f_unaccent(<match trim>(text)))`, computed BY
 * POSTGRES, where the match trim is `regexp_replace(text, MATCH_TRIM_PATTERN,
 * '', 'g')` (concepts/match_text.ts: exactly `String.prototype.trim`'s set —
 * `btrim` strips the ASCII space only, so a stored "x" + NBSP folded apart
 * from an imported "x"). {@link readSectionIdsByFoldedValue} compares with
 * this fold; it is exposed so a caller that must key something else on "the
 * same value" (an advisory lock) derives the key from the SAME function — a
 * JS-side fold disagrees with `unaccent` on ø ł æ ß đ þ, and two folds are two
 * identities. ONE round trip for a whole set: text → fold.
 */
export async function foldMatchTexts(texts: readonly string[]): Promise<Map<string, string>> {
	const folds = new Map<string, string>();
	if (texts.length === 0) return folds;
	// The set rides as one jsonb array (the driver binds no JS array); the
	// pattern is bound too — no text reaches the statement.
	const rows = (await sql.unsafe(
		`SELECT t.text, ${matchFoldSql('t.text', '$2')} AS folded
		   FROM jsonb_array_elements_text($1::text::jsonb) AS t(text)`,
		[JSON.stringify([...new Set(texts)]), MATCH_TRIM_PATTERN],
	)) as { text: string; folded: string | null }[];
	for (const row of rows) folds.set(row.text, row.folded ?? '');
	return folds;
}

/** The match fold over a SQL expression, the trim pattern bound at `patternParam`. */
function matchFoldSql(expression: string, patternParam: string): string {
	return `lower(public.f_unaccent(regexp_replace(${expression}, ${patternParam}, '', 'g')))`;
}

/**
 * The records of `sectionTipo` whose string-family component `componentTipo`
 * (items `{value}` in `column`) holds a value EQUAL to `text` under the match
 * fold (`foldMatchTexts`: match trim, unaccent, lower) on BOTH sides — whole value, never a
 * substring; ascending by section_id; any language slice.
 *
 * NO PRINCIPAL, NO PROJECT FILTER: this is a raw record-store read. Its callers
 * are allow-listed (`test/unit/iri_label_unscoped_lookup_tripwire.test.ts`)
 * because an unscoped answer is only right for a shared vocabulary a caller
 * LINKS to (T0-12, D6b). It answers ids only, never a stored value. No cap: the
 * predicate is exact, so the answer is the whole truth (the caller decides what
 * several matches mean).
 */
export async function readSectionIdsByFoldedValue(
	tableName: string,
	sectionTipo: string,
	column: MatrixJsonbColumn,
	componentTipo: string,
	text: string,
): Promise<number[]> {
	assertMatrixTable(tableName);
	if (!(MATRIX_JSONB_COLUMNS as readonly string[]).includes(column)) {
		throw new DedaloError('internal.invariant', {
			message: `readSectionIdsByFoldedValue: '${column}' is not a matrix jsonb column`,
			coordinates: { table: tableName },
		});
	}
	// Table + column are allowlist-validated identifiers; every value is bound.
	const rows = (await sql.unsafe(
		`SELECT m.section_id
		   FROM "${tableName}" AS m
		  WHERE m.section_tipo = $1
		    AND jsonb_typeof(m."${column}"->$2) = 'array'
		    AND EXISTS (
		      SELECT 1 FROM jsonb_array_elements(m."${column}"->$2) AS item
		       WHERE jsonb_typeof(item) = 'object'
		         AND ${matchFoldSql("item->>'value'", '$4')} = ${matchFoldSql('$3::text', '$4')})
		  ORDER BY m.section_id`,
		[sectionTipo, componentTipo, text, MATCH_TRIM_PATTERN],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/**
 * The OTHER records of `sectionTipo` (never `exceptSectionId`) whose component
 * `componentTipo` stores an item whose `value` is `value` BYTE-EXACT, ascending,
 * at most `limit`. The one read behind the `properties.image_id` stem
 * uniqueness rule (media/stem_rules.ts): ONE containment probe on the whole
 * column — `"<column>" @> '{"<tipo>":[{"value":"<v>"}]}'` — which is the shape
 * the per-column `jsonb_path_ops` GIN indexes answer (an item with more keys,
 * lang included, still contains the probe). Exact on the stored bytes: a
 * stored value differing by surrounding whitespace resolves to the same stem
 * (the resolver trims) but is not matched here — stated in the WC entry.
 *
 * NO PRINCIPAL, NO PROJECT FILTER: a uniqueness check must see every record of
 * the section, whatever the curator may read — it answers ids only, never a
 * stored value.
 */
export async function readOtherSectionIdsHoldingValue(
	tableName: string,
	sectionTipo: string,
	column: MatrixJsonbColumn,
	componentTipo: string,
	value: string,
	exceptSectionId: number,
	limit = 5,
): Promise<number[]> {
	assertMatrixTable(tableName);
	if (!(MATRIX_JSONB_COLUMNS as readonly string[]).includes(column)) {
		throw new DedaloError('internal.invariant', {
			message: `readOtherSectionIdsHoldingValue: '${column}' is not a matrix jsonb column`,
			coordinates: { table: tableName },
		});
	}
	// Table + column are allowlist-validated identifiers; the probe is bound as
	// text and cast server-side (never a Bun-encoded object: ::text::jsonb).
	const probe = JSON.stringify({ [componentTipo]: [{ value }] });
	const rows = (await sql.unsafe(
		`SELECT m.section_id
		   FROM "${tableName}" AS m
		  WHERE m.section_tipo = $1
		    AND m.section_id <> $2
		    AND m."${column}" @> $3::text::jsonb
		  ORDER BY m.section_id
		  LIMIT ${Math.max(1, Math.trunc(limit))}`,
		[sectionTipo, exceptSectionId, probe],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

export async function readMatrixRecord(
	tableName: string,
	sectionTipo: string,
	sectionId: number,
): Promise<MatrixRecord | null> {
	assertMatrixTable(tableName);

	// Build the projection once: each JSONB column plus its ::text twin.
	// Column names come from the fixed const above — never from input.
	const jsonbProjection = MATRIX_JSONB_COLUMNS.map(
		(column) => `"${column}", "${column}"::text AS "${column}__text"`,
	).join(', ');

	// Table and column identifiers are allowlist-validated constants; the two
	// user-facing values are bound parameters ($1, $2).
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, ${jsonbProjection}
		 FROM "${tableName}"
		 WHERE section_tipo = $1 AND section_id = $2
		 LIMIT 1`,
		[sectionTipo, sectionId],
	)) as Record<string, unknown>[];

	const row = rows[0];
	if (row === undefined) {
		return null;
	}

	const columns: MatrixRecord['columns'] = {};
	const rawText: MatrixRecord['rawText'] = {};
	for (const column of MATRIX_JSONB_COLUMNS) {
		columns[column] = row[column];
		rawText[column] = row[`${column}__text`] as string | null;
	}

	return {
		id: row.id as number,
		section_id: row.section_id as number,
		section_tipo: row.section_tipo as string,
		columns,
		rawText,
	};
}

/**
 * Read MANY records of one section by id — ONE `= ANY()` query for the whole
 * set, the batch twin of readMatrixRecord (identical projection, ::text twins
 * included). A section-list page resolving each row's record one query at a
 * time turns a 30-row page into 30 round-trips for a question a single ANY()
 * answers. Missing ids are simply absent from the returned map.
 */
export async function readMatrixRecordBatch(
	tableName: string,
	sectionTipo: string,
	sectionIds: readonly number[],
): Promise<Map<number, MatrixRecord>> {
	assertMatrixTable(tableName);
	const byId = new Map<number, MatrixRecord>();
	if (sectionIds.length === 0) return byId;

	const jsonbProjection = MATRIX_JSONB_COLUMNS.map(
		(column) => `"${column}", "${column}"::text AS "${column}__text"`,
	).join(', ');

	// Identifiers are allowlist-validated constants; values are bound. The id
	// set rides as a comma string through string_to_array (the driver does not
	// bind a JS array to ANY($n::int[]) — same pattern as readExistingSectionIds).
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, ${jsonbProjection}
		 FROM "${tableName}"
		 WHERE section_tipo = $1
		   AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[sectionTipo, [...new Set(sectionIds)].join(',')],
	)) as Record<string, unknown>[];

	for (const row of rows) {
		const columns: MatrixRecord['columns'] = {};
		const rawText: MatrixRecord['rawText'] = {};
		for (const column of MATRIX_JSONB_COLUMNS) {
			columns[column] = row[column];
			rawText[column] = row[`${column}__text`] as string | null;
		}
		byId.set(row.section_id as number, {
			id: row.id as number,
			section_id: row.section_id as number,
			section_tipo: row.section_tipo as string,
			columns,
			rawText,
		});
	}
	return byId;
}

/**
 * EVERY section_id a section holds, ascending — the enumeration the archive
 * extraction (core/archive/extract.ts) walks. It answers ids only: the rows
 * themselves are read in batches through readMatrixRecordBatch, so a section of
 * a million records never has to be held in memory as parsed jsonb twice.
 */
export async function readSectionIdsOfSection(
	tableName: string,
	sectionTipo: string,
): Promise<number[]> {
	assertMatrixTable(tableName);
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${tableName}" WHERE section_tipo = $1 ORDER BY section_id`,
		[sectionTipo],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}
