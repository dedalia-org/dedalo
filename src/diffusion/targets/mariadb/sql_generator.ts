/**
 * Pure SQL-string builders for the MariaDB diffusion target (SPEC §4.3).
 *
 * Every function here is PURE — {sql, params} out, no I/O — so the statement
 * shapes are unit-testable without a database. Semantics ported from the old
 * engine's proven lib/sql_generator.ts (v7_php_frozen/master_dedalo/diffusion/api/v1)
 * with the deliberate spec §4.3 improvements:
 * - TRUE multi-row batched upserts (~200 rows per statement, byte-budget
 *   aware) instead of one INSERT per record;
 * - explicit plan-ordered column lists (every row of a batch binds every
 *   column, null-padded) so one statement serves the whole batch.
 *
 * KEPT oracle behaviors (published-schema compatibility):
 * - composite PRIMARY KEY (section_id, lang); section_id INT(12), lang
 *   VARCHAR(16) — identical to every table the old engine created;
 * - model→type map (field_date→DATE, field_int→INT(n), field_varchar→
 *   VARCHAR(n), field_text→TEXT, ... oracle sql_generator.ts:195-230);
 * - default index per model + explicit `index` override, incl. the (250)
 *   prefix rule for long text keys (oracle :246-291);
 * - COMMENT escaping incl. the DIFFTS-05 backslash fix (oracle :235);
 * - ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
 * - DELETE ... WHERE section_id IN (?) with stringified ids.
 *
 * Identifier safety: names arriving in a SectionPlan already passed the
 * compile chokepoint (plan/identifier.ts requireSqlIdentifier), but EVERY
 * identifier is still routed through escapeSqlIdentifier here — defense in
 * depth, exactly like the oracle.
 */

import { DedaloError } from '../../../core/errors/dedalo_error.ts';
import { escapeSqlIdentifier } from '../../plan/identifier.ts';
import type { ColumnDef, FieldPlan, SectionPlan } from '../../plan/types.ts';
import type { ProjectedRow } from '../../project/lang_ladder.ts';

/** A generated statement with its positional `?` parameters. */
export interface SqlStatement {
	sql: string;
	params: (string | number | null)[];
}

/**
 * The `section_id` column type of a source-section table. A GLOBAL table
 * (plan GlobalTablePlan) passes its VARCHAR composite-key type instead.
 */
export const SECTION_ID_TYPE = 'INT(12)';

/** Default cap for rows per multi-row upsert statement (plan D1 default). */
export const DEFAULT_UPSERT_BATCH_ROWS = 200;
/**
 * Byte budget per upsert statement — stay comfortably under MariaDB's
 * default max_allowed_packet (16MB since 10.2; 4MB leaves generous headroom
 * for statement text + protocol overhead on older configs).
 */
export const DEFAULT_UPSERT_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * The columns a section's table carries, in plan order. excludeColumn fields
 * participate in resolution only and NEVER reach the target schema or rows.
 */
export function tableColumnFields(section: SectionPlan): FieldPlan[] {
	return section.fields.filter((field) => field.excludeColumn !== true);
}

/**
 * Model→SQL type map (oracle get_column_definition:195-230, verbatim types).
 * `varcharLength` (ontology `varchar`) sizes VARCHAR(n); `intLength` (ontology
 * `length`) sizes INT(n) — two keys, exactly as the old engine's ctx read them.
 * Fallback: a model outside the map emits TEXT — unless the field's plan
 * outputFormat says 'int' (the model didn't decide, the format hint does).
 */
function sqlTypeFor(column: ColumnDef, outputFormat: string | undefined): string {
	switch (column.fieldModel) {
		case 'field_date':
			return 'DATE';
		case 'field_datetime':
			return 'DATETIME';
		case 'field_int':
			return `INT(${column.intLength ?? 8})`;
		case 'field_varchar':
			return `VARCHAR(${column.varcharLength ?? 255})`;
		case 'field_text':
			return 'TEXT';
		case 'field_mediumtext':
			return 'MEDIUMTEXT';
		case 'field_year':
			return 'YEAR';
		case 'field_boolean':
			return 'TINYINT(1)';
		case 'field_decimal':
			return 'DECIMAL(19,4)';
		case 'field_point':
			return 'POINT';
		case 'field_enum':
			return 'TEXT';
		default:
			return outputFormat === 'int' ? 'INT(8)' : 'TEXT';
	}
}

/**
 * MariaDB's server-level row ceiling: the summed in-row width of every column
 * may not exceed 65535 bytes, whatever the engine (errno 1118 at CREATE/ALTER).
 */
export const MARIADB_MAX_ROW_BYTES = 65535;

/** utf8mb4: every declared character reserves 4 bytes of row width. */
const UTF8MB4_BYTES_PER_CHAR = 4;

/**
 * In-row width of one column as MariaDB counts it toward MARIADB_MAX_ROW_BYTES
 * (the field's pack length): a VARCHAR reserves its FULL declared width plus a
 * 1-or-2-byte length prefix, while TEXT/BLOB-family types (POINT is one)
 * contribute only their length prefix + 8-byte pointer — the content lives
 * off-row. Calibrated against a live server (diffusion_row_size_mariadb gate).
 */
function columnRowBytes(sqlType: string): number {
	const varchar = /^VARCHAR\((\d+)\)$/.exec(sqlType);
	if (varchar !== null) {
		const bytes = Number(varchar[1]) * UTF8MB4_BYTES_PER_CHAR;
		return bytes + (bytes > 255 ? 2 : 1);
	}
	if (sqlType.startsWith('INT(')) return 4;
	switch (sqlType) {
		case 'TEXT':
			return 10;
		case 'MEDIUMTEXT':
			return 11;
		case 'POINT':
			return 12;
		case 'DATE':
			return 3;
		case 'DATETIME':
			return 5;
		case 'YEAR':
		case 'TINYINT(1)':
			return 1;
		case 'DECIMAL(19,4)':
			return 9;
		default:
			// A type added to sqlTypeFor without its width here must not be
			// guessed: the row check would silently under-count.
			throw new DedaloError('internal.invariant', {
				message: `columnRowBytes: no row width for SQL type '${sqlType}'`,
				coordinates: { sql_type: sqlType },
			});
	}
}

/** One plan column's SQL type + its in-row width. */
export interface ColumnRowWidth {
	columnName: string;
	sqlType: string;
	bytes: number;
}

/**
 * The row width the CREATE TABLE for this section would declare: the fixed
 * anatomy (section_id INT NOT NULL + lang VARCHAR(16)), every plan column, and
 * the NULL bitmap — one bit per PLAN column only: `lang` is declared
 * DEFAULT NULL but sits in the PRIMARY KEY, which MariaDB forces NOT NULL.
 */
export function tableRowBytes(
	section: SectionPlan,
	sectionIdType: string = SECTION_ID_TYPE,
): { total: number; columns: ColumnRowWidth[] } {
	const columns = tableColumnFields(section).map((field) => {
		const sqlType = sqlTypeFor(field.column, field.outputFormat);
		return { columnName: field.columnName, sqlType, bytes: columnRowBytes(sqlType) };
	});
	const nullableCount = columns.length;
	const total =
		columnRowBytes(sectionIdType) +
		columnRowBytes('VARCHAR(16)') +
		columns.reduce((sum, column) => sum + column.bytes, 0) +
		Math.ceil(nullableCount / 8);
	return { total, columns };
}

/**
 * The operator-facing violation when a section's table cannot be created
 * (row wider than MARIADB_MAX_ROW_BYTES), or null when it fits. Names the
 * widest columns: shrinking a `varchar` or moving a field to field_text is
 * the fix, and it is an ONTOLOGY decision — the engine never retypes.
 */
export function tableRowSizeViolation(
	section: SectionPlan,
	sectionIdType: string = SECTION_ID_TYPE,
): string | null {
	const { total, columns } = tableRowBytes(section, sectionIdType);
	if (total <= MARIADB_MAX_ROW_BYTES) return null;
	const widest = columns
		.filter((column) => column.sqlType.startsWith('VARCHAR('))
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, 8)
		.map((column) => `${column.columnName} ${column.sqlType}`);
	return (
		`table '${section.tableName}' (${section.tableTipo}): row width ${total} bytes exceeds ` +
		`MariaDB's ${MARIADB_MAX_ROW_BYTES} (each VARCHAR(n) reserves 4n bytes in utf8mb4; TEXT ~10) — ` +
		`reduce 'varchar' or use field_text on: ${widest.join(', ')}`
	);
}

/**
 * COMMENT literal escaping (oracle :235 incl. the DIFFTS-05 fix): escape
 * backslashes BEFORE doubling quotes — in MariaDB's default mode a stray
 * backslash could escape the closing quote of the literal.
 */
function escapeCommentLiteral(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/** The SQL type the plan declares for a field's column (what CREATE/ADD would emit). */
export function fieldSqlType(field: FieldPlan): string {
	return sqlTypeFor(field.column, field.outputFormat);
}

/**
 * One column's definition clause. The provenance COMMENT keeps the oracle's
 * `term - tipo` intent with what the plan carries: the sanitized column name
 * (the term post-chokepoint) and the diffusion field-node tipo.
 */
function columnDefinition(field: FieldPlan): string {
	const safeColumn = escapeSqlIdentifier(field.columnName);
	const sqlType = sqlTypeFor(field.column, field.outputFormat);
	const comment = escapeCommentLiteral(`${field.columnName} - ${field.id}`);
	return `${safeColumn} ${sqlType} DEFAULT NULL COMMENT '${comment}'`;
}

/**
 * Index clause for a column (oracle get_index_definition:246-291): explicit
 * ontology `index` override first (FULLTEXT / BTREE|KEY / NONE|false), then
 * the v6-mimicking model defaults. Long text-ish keys get the (250) prefix.
 */
function indexDefinition(field: FieldPlan): string | null {
	const safeColumn = escapeSqlIdentifier(field.columnName);
	const { fieldModel, varcharLength, index } = field.column;

	const textPrefix = (): string => {
		const maxLength = Number(varcharLength) || 0;
		return maxLength > 0 && maxLength < 250 ? '' : '(250)';
	};

	if (index !== undefined && index !== null) {
		const indexUpper = typeof index === 'string' ? index.toUpperCase() : '';
		if (indexUpper === 'FULLTEXT') {
			return `FULLTEXT KEY ${safeColumn} (${safeColumn})`;
		}
		if (indexUpper === 'BTREE' || indexUpper === 'KEY') {
			const needsPrefix =
				fieldModel === 'field_varchar' ||
				fieldModel === 'field_enum' ||
				fieldModel === 'field_text';
			return `KEY ${safeColumn} (${safeColumn}${needsPrefix ? textPrefix() : ''})`;
		}
		if (indexUpper === 'NONE' || index === false) {
			return null;
		}
	}

	switch (fieldModel) {
		case 'field_text':
		case 'field_mediumtext':
			return `FULLTEXT KEY ${safeColumn} (${safeColumn})`;
		case 'field_varchar':
		case 'field_enum':
			return `KEY ${safeColumn} (${safeColumn}${textPrefix()})`;
		case 'field_boolean':
		case 'field_int':
		case 'field_year':
		case 'field_decimal':
		case 'field_date':
		case 'field_datetime':
			return `KEY ${safeColumn} (${safeColumn})`;
		default:
			return null;
	}
}

/**
 * MariaDB allows at most 64 keys per table. The oracle (diffusion_mysql::
 * generate_keys) caps secondary indexes at 50 to stay safely under that ceiling
 * — without it, a wide element (e.g. an image/resource section publishing 60+
 * indexable fields) overflows the limit and CREATE TABLE fails with
 * "Too many keys specified; max 64 keys allowed". We match the 50 cap and,
 * unlike the oracle (which capped ONLY the CREATE and could still overflow via
 * ALTER ADD), apply it through a single source of truth consulted by BOTH the
 * CREATE and the additive-ALTER path, so schema evolution can never exceed it.
 */
const MAX_SECONDARY_KEYS = 50;

/**
 * The set of column names that receive a secondary index: the first
 * MAX_SECONDARY_KEYS indexable fields in stable plan order. Deterministic so
 * generateCreateTable and generateAddColumns always agree on the same columns.
 */
function indexedColumnNames(section: SectionPlan): Set<string> {
	const names = new Set<string>();
	for (const field of tableColumnFields(section)) {
		if (indexDefinition(field) === null) continue; // model/override yields no index
		if (names.size >= MAX_SECONDARY_KEYS) break;
		names.add(field.columnName);
	}
	return names;
}

/**
 * CREATE TABLE IF NOT EXISTS for a section plan — the oracle's exact table
 * anatomy: section_id INT(12) (a global table: its VARCHAR composite key) +
 * lang VARCHAR(16), composite PK, per-column
 * COMMENT provenance, model-default/overridden indexes, InnoDB/utf8mb4.
 */
export function generateCreateTable(
	section: SectionPlan,
	options: { sectionIdType?: string } = {},
): string {
	const safeTable = escapeSqlIdentifier(section.tableName);
	const fields = tableColumnFields(section);
	const indexed = indexedColumnNames(section);

	const definitionClauses = [
		`\`section_id\` ${options.sectionIdType ?? SECTION_ID_TYPE} NOT NULL`,
		'`lang` VARCHAR(16) DEFAULT NULL',
		...fields.map(columnDefinition),
		'PRIMARY KEY (section_id, lang)',
	];
	for (const field of fields) {
		if (!indexed.has(field.columnName)) continue; // 64-key ceiling guard
		const indexClause = indexDefinition(field);
		if (indexClause !== null) definitionClauses.push(indexClause);
	}

	return [
		`CREATE TABLE IF NOT EXISTS ${safeTable} (`,
		`  ${definitionClauses.join(',\n  ')}`,
		') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
	].join('\n');
}

/** The table the publication APIs read an element's schema row from (v6 name, kept). */
export const PUBLICATION_SCHEMA_TABLE = 'publication_schema';

/**
 * The element's schema row (PublicationPlan.publicationSchema): the v6 table
 * shape the publication APIs read (`SELECT data … WHERE id = 1`), one row per
 * database — merged into, never replaced blind (mergePublicationSchema).
 */
export function generatePublicationSchemaStatements(
	tableName: string,
	schema: Record<string, unknown>,
): { create: string; read: string; replace: SqlStatement } {
	const safeTable = escapeSqlIdentifier(tableName);
	return {
		create: [
			`CREATE TABLE IF NOT EXISTS ${safeTable} (`,
			'  `id` INT(11) NOT NULL,',
			'  `data` MEDIUMTEXT NOT NULL,',
			'  PRIMARY KEY (`id`)',
			') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
		].join('\n'),
		read: `SELECT \`data\` FROM ${safeTable} WHERE \`id\` = 1`,
		replace: {
			sql: `REPLACE INTO ${safeTable} (\`id\`, \`data\`) VALUES (1, ?)`,
			params: [JSON.stringify(schema)],
		},
	};
}

/**
 * Row 1 is per DATABASE, but a plan knows one element: several elements may
 * publish into one database, and a v6 install's row holds field maps no v7
 * property declares yet. So the run's map is laid OVER the stored one (its keys
 * win, `dd_relations` merged key by key) — an entry no element declares any
 * more stays until the row is deleted. An unreadable stored row is replaced.
 */
export function mergePublicationSchema(
	stored: unknown,
	ours: Record<string, unknown>,
): Record<string, unknown> {
	let previous: unknown = stored;
	if (typeof stored === 'string') {
		try {
			previous = JSON.parse(stored);
		} catch {
			previous = null;
		}
	}
	if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) return ours;
	const old = previous as Record<string, unknown>;
	const oldRelations =
		old.dd_relations !== null &&
		typeof old.dd_relations === 'object' &&
		!Array.isArray(old.dd_relations)
			? (old.dd_relations as Record<string, unknown>)
			: {};
	return {
		...old,
		...ours,
		dd_relations: {
			...oldRelations,
			...(ours.dd_relations as Record<string, unknown> | undefined),
		},
	};
}

/** INFORMATION_SCHEMA read listing a table's existing columns (ensure diff). */
export function generateColumnsQuery(database: string, tableName: string): SqlStatement {
	return {
		sql: 'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
		params: [database, tableName],
	};
}

/**
 * Additive-only schema evolution: ALTER TABLE ADD COLUMN (+ its index) for
 * every plan field missing from the live table. NEVER drops or retypes —
 * published tables only grow (oracle ensure_columns posture).
 */
export function generateAddColumns(section: SectionPlan, missingColumnNames: string[]): string[] {
	const safeTable = escapeSqlIdentifier(section.tableName);
	const fieldsByColumn = new Map(tableColumnFields(section).map((f) => [f.columnName, f]));
	const indexed = indexedColumnNames(section); // same 64-key cap as CREATE

	const statements: string[] = [];
	for (const columnName of missingColumnNames) {
		const field = fieldsByColumn.get(columnName);
		if (field === undefined) continue; // not a plan column (defensive)
		const indexClause = indexed.has(columnName) ? indexDefinition(field) : null;
		const addIndex = indexClause !== null ? `, ADD ${indexClause}` : '';
		statements.push(`ALTER TABLE ${safeTable} ADD COLUMN ${columnDefinition(field)}${addIndex};`);
	}
	return statements;
}

/** Byte-budget knobs for slicing rows into multi-row statements. */
export interface UpsertBatchLimits {
	maxRowsPerStatement: number;
	maxBytesPerStatement: number;
}

/** Rough per-value wire cost: UTF-8 bytes of the bound value + overhead. */
function estimateValueBytes(value: string | number | null): number {
	if (value === null) return 8;
	return Buffer.byteLength(String(value), 'utf8') + 8;
}

/**
 * Slice projected rows into statement-sized batches: at most
 * `maxRowsPerStatement` rows AND `maxBytesPerStatement` estimated bytes each
 * (a single oversized row still ships alone — MariaDB enforces the real
 * packet limit; we only avoid *aggregating* past it).
 */
export function planUpsertBatches(
	rows: ProjectedRow[],
	columnNames: string[],
	limits: UpsertBatchLimits = {
		maxRowsPerStatement: DEFAULT_UPSERT_BATCH_ROWS,
		maxBytesPerStatement: DEFAULT_UPSERT_BATCH_BYTES,
	},
): ProjectedRow[][] {
	const batches: ProjectedRow[][] = [];
	let currentBatch: ProjectedRow[] = [];
	let currentBytes = 0;

	for (const row of rows) {
		let rowBytes = estimateValueBytes(row.sectionId) + estimateValueBytes(row.lang);
		for (const columnName of columnNames) {
			rowBytes += estimateValueBytes(row.columns[columnName] ?? null);
		}
		const wouldOverflow =
			currentBatch.length >= limits.maxRowsPerStatement ||
			(currentBatch.length > 0 && currentBytes + rowBytes > limits.maxBytesPerStatement);
		if (wouldOverflow) {
			batches.push(currentBatch);
			currentBatch = [];
			currentBytes = 0;
		}
		currentBatch.push(row);
		currentBytes += rowBytes;
	}
	if (currentBatch.length > 0) batches.push(currentBatch);
	return batches;
}

/**
 * ONE multi-row upsert statement for a batch of projected rows:
 *   INSERT INTO t (section_id, lang, c1, c2)
 *   VALUES (?,?,?,?),(?,?,?,?)
 *   ON DUPLICATE KEY UPDATE c1 = VALUES(c1), c2 = VALUES(c2)
 * Every row binds EVERY plan column (missing values → NULL) so the column
 * list is uniform across the batch. With zero data columns the composite key
 * is the whole row — INSERT IGNORE, the oracle's no-op-on-conflict posture.
 */
export function generateBatchUpsert(
	tableName: string,
	columnNames: string[],
	rows: ProjectedRow[],
): SqlStatement {
	if (rows.length === 0) throw new Error('generateBatchUpsert requires at least one row');
	const safeTable = escapeSqlIdentifier(tableName);
	const safeColumns = columnNames.map(escapeSqlIdentifier);
	const allColumns = ['`section_id`', '`lang`', ...safeColumns].join(', ');

	const rowPlaceholders = `(${Array(columnNames.length + 2)
		.fill('?')
		.join(', ')})`;
	const valuesClause = Array(rows.length).fill(rowPlaceholders).join(',\n');

	const params: (string | number | null)[] = [];
	for (const row of rows) {
		params.push(row.sectionId, row.lang);
		for (const columnName of columnNames) {
			params.push(row.columns[columnName] ?? null);
		}
	}

	if (safeColumns.length === 0) {
		return {
			sql: `INSERT IGNORE INTO ${safeTable} (${allColumns})\nVALUES ${valuesClause}`,
			params,
		};
	}
	const updateClause = safeColumns.map((column) => `${column} = VALUES(${column})`).join(', ');
	return {
		sql: [
			`INSERT INTO ${safeTable} (${allColumns})`,
			`VALUES ${valuesClause}`,
			'ON DUPLICATE KEY UPDATE',
			updateClause,
		].join('\n'),
		params,
	};
}

/**
 * Batched removal of published records — all lang variants of each
 * section_id go (composite key). Ids are stringified like the oracle
 * (generate_delete:313) so numeric and composite string ids bind alike.
 */
export function generateDelete(tableName: string, sectionIds: (number | string)[]): SqlStatement {
	if (sectionIds.length === 0) throw new Error('generateDelete requires at least one section_id');
	const safeTable = escapeSqlIdentifier(tableName);
	const placeholders = sectionIds.map(() => '?').join(', ');
	return {
		sql: `DELETE FROM ${safeTable} WHERE section_id IN (${placeholders})`,
		params: sectionIds.map((id) => String(id)),
	};
}
