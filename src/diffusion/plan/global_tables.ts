/**
 * `global_table_maps` → SectionPlan.globalTables (v6 save_global_table_data,
 * class.diffusion_sql.php :2477-2652; grammar + key: core/diffusion_bridge/global_tables.ts).
 *
 * Compiled ONCE per element like everything else: the global table node is
 * resolved, its name goes through the SQL identifier chokepoint, its own field
 * children become its DDL anatomy, and every `columns_map` item is checked
 * against BOTH tables. The writer (writers/mariadb_sql.ts) and the row
 * derivation (project/global_table.ts) never read the ontology.
 *
 * FAILURE POLICY (compile.ts header): structural defects refuse the element —
 * a map without `table_tipo`, a target that is not a `table` node, a name the
 * chokepoint rejects, maps on a non-sql element, a global name colliding with
 * a source table or with another global node. A `table_tipo` in an ontology
 * package this install does not carry is the usual `uninstalled-tld:` warning
 * (the map is skipped).
 *
 * UNRULED (owner decision T1-3 D1, open): a map naming a column that does not
 * exist — a target the global node does not declare, or a source that is not
 * a column of the source table nor `section_id`/`lang` (v6 skipped such
 * columns silently; the vendored mdcat/numisdata maps carry real cases). Until
 * it is ruled, such a map keeps the behaviour it had before this port: it is
 * NOT written, and a `global_table_maps_unruled:` warning names every unknown
 * column — neither the degrade-and-publish nor the refuse-the-element answer
 * is presupposed.
 */

import {
	globalTableMapsOf,
	globalTableTiposOf,
} from '../../core/diffusion_bridge/global_tables.ts';
import { nameOrLabelOf } from '../../core/ontology/labels.ts';
import { tableRowSizeViolation } from '../targets/mariadb/sql_generator.ts';
import { requireSqlIdentifier } from './identifier.ts';
import type {
	ColumnDef,
	FieldPlan,
	GlobalColumnMap,
	GlobalProvenanceColumn,
	GlobalTablePlan,
	SectionPlan,
} from './types.ts';
import type { OntologyIndex, VirtualTreeNode } from './virtual_tree.ts';

/** The provenance columns v6 writes, in its order (each only if the node declares it). */
const PROVENANCE_COLUMNS: readonly GlobalProvenanceColumn[] = [
	'ref_section_id',
	'ref_section_tipo',
	'ref_table',
	'link',
];

/** The automatic source columns every source row carries (v6 ar_fields keys). */
const AUTOMATIC_SOURCES: ReadonlySet<string> = new Set(['section_id', 'lang']);

/** Default VARCHAR length of the composite key when the node's `section_id` field says none. */
const DEFAULT_KEY_LENGTH = 255;

/** The compile diagnostics this module writes into (compile.ts CompileDiagnostics). */
export interface GlobalTableDiagnostics {
	errors: string[];
	warnings: string[];
}

/** What compileGlobalTables needs from the section it decorates. */
export interface GlobalTableSource {
	index: OntologyIndex;
	tableNode: VirtualTreeNode;
	sectionTipo: string;
	/** The section's emitted column names (non-excluded fields). */
	sourceColumns: readonly string[];
	sqlTarget: boolean;
	/** compile.ts uninstalledTldOf (injected: the package split stays one function). */
	uninstalledTldOf: (tipo: string) => Promise<string | null>;
}

/** The raw maps of a (possibly aliased) table node — key-level real fallback. */
export async function globalTableMapsOfNode(
	index: OntologyIndex,
	tableNode: VirtualTreeNode,
): Promise<unknown> {
	const realProperties =
		tableNode.realTipo !== null
			? ((await index.nodeOf(tableNode.realTipo))?.properties ?? null)
			: null;
	// The virtual node's `properties` already IS the real bag when the alias
	// declared none; its own row is what decides the key-level fallback.
	const ownProperties = tableNode.isAlias
		? ((await index.nodeOf(tableNode.tipo))?.properties ?? null)
		: tableNode.properties;
	return globalTableMapsOf(ownProperties, realProperties);
}

/** One global field node → its column-only FieldPlan (null = not a column). */
function columnFieldOf(
	node: { tipo: string; model: string; properties: Record<string, unknown> | null },
	columnName: string,
): FieldPlan {
	const properties = node.properties;
	const column: ColumnDef = { fieldModel: node.model };
	if (typeof properties?.varchar === 'number') column.varcharLength = properties.varchar;
	if (typeof properties?.length === 'number') column.intLength = properties.length;
	if (properties?.index !== undefined) column.index = properties.index;
	const field: FieldPlan = {
		id: node.tipo,
		columnName,
		sourceChain: [],
		transform: [],
		column,
		policy: {},
	};
	const outputFormat = (properties?.process as { output_format?: unknown } | undefined)
		?.output_format;
	if (typeof outputFormat === 'string') field.outputFormat = outputFormat;
	return field;
}

/** The global node's own anatomy: its direct field children (section_id/lang are the base). */
async function compileGlobalSchema(
	index: OntologyIndex,
	globalTipo: string,
	tableName: string,
	where: string,
	diagnostics: GlobalTableDiagnostics,
): Promise<{ schema: SectionPlan; keyLength: number } | null> {
	const fields: FieldPlan[] = [];
	let keyLength = DEFAULT_KEY_LENGTH;
	let failed = false;
	for (const childTipo of await index.childTipos(globalTipo)) {
		const child = await index.nodeOf(childTipo);
		if (child === null || !child.model.startsWith('field_')) continue;
		const label = nameOrLabelOf(child) ?? '';
		let columnName: string;
		try {
			columnName = requireSqlIdentifier(label, 'column');
		} catch (error) {
			diagnostics.errors.push(`${where}: field '${childTipo}': ${(error as Error).message}`);
			failed = true;
			continue;
		}
		if (columnName === 'section_id') {
			const varchar = child.properties?.varchar;
			if (typeof varchar === 'number' && varchar > 0) keyLength = varchar;
			continue;
		}
		if (columnName === 'lang') continue; // part of the base anatomy
		fields.push(columnFieldOf(child, columnName));
	}
	if (failed) return null;
	return {
		schema: { sectionTipo: '', tableName, tableTipo: globalTipo, fields },
		keyLength,
	};
}

/** Normalize one `columns_map` item, or a reason it is malformed. */
function columnMapOf(raw: unknown): GlobalColumnMap | string {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
	const item = raw as Record<string, unknown>;
	if (typeof item.target_column !== 'string' || item.target_column === '')
		return 'missing target_column';
	const sources =
		typeof item.source_columns === 'string' ? [item.source_columns] : item.source_columns;
	if (
		!Array.isArray(sources) ||
		sources.length === 0 ||
		!sources.every((source) => typeof source === 'string' && source !== '')
	) {
		return `target_column '${item.target_column}': source_columns must be a non-empty list of column names`;
	}
	const map: GlobalColumnMap = {
		targetColumn: item.target_column,
		sourceColumns: sources as string[],
	};
	if (item.format === 'string') map.format = 'string';
	else if (item.format !== undefined && item.format !== null)
		return `target_column '${item.target_column}': unknown format ${JSON.stringify(item.format)}`;
	if (typeof item.separator === 'string') map.separator = item.separator;
	return map;
}

/** Every column a map names that does not exist (the UNRULED D1 case). */
function unknownColumnsOf(
	columnsMap: readonly GlobalColumnMap[],
	targetColumns: ReadonlySet<string>,
	sourceColumns: ReadonlySet<string>,
): string[] {
	const unknown: string[] = [];
	for (const item of columnsMap) {
		if (!targetColumns.has(item.targetColumn)) unknown.push(`target '${item.targetColumn}'`);
		for (const source of item.sourceColumns) {
			if (!sourceColumns.has(source) && !AUTOMATIC_SOURCES.has(source))
				unknown.push(`source '${source}' (→ ${item.targetColumn})`);
		}
	}
	return unknown;
}

/** Resolve + validate one map's global node; null when it is skipped or refused (recorded). */
async function resolveGlobalNode(
	source: GlobalTableSource,
	globalTipo: string,
	where: string,
	diagnostics: GlobalTableDiagnostics,
): Promise<{ tableName: string } | null> {
	const node = await source.index.nodeOf(globalTipo);
	if (node === null) {
		const uninstalled = await source.uninstalledTldOf(globalTipo);
		if (uninstalled !== null) {
			diagnostics.warnings.push(`uninstalled-tld:${uninstalled}@${globalTipo}`);
			return null;
		}
		diagnostics.errors.push(`${where}: table_tipo '${globalTipo}' not found in the ontology`);
		return null;
	}
	if (node.model !== 'table') {
		diagnostics.errors.push(
			`${where}: table_tipo '${globalTipo}' is a '${node.model}', not a 'table' node`,
		);
		return null;
	}
	try {
		return { tableName: requireSqlIdentifier(nameOrLabelOf(node) ?? '', 'table') };
	} catch (error) {
		diagnostics.errors.push(`${where}: table_tipo '${globalTipo}': ${(error as Error).message}`);
		return null;
	}
}

/** The DDL type of a global table's composite `section_id` key. */
export function globalKeyType(global: Pick<GlobalTablePlan, 'keyLength'>): string {
	return `VARCHAR(${global.keyLength})`;
}

/** Compile one raw map entry into a GlobalTablePlan (null = skipped or refused, recorded). */
async function compileOneMap(
	source: GlobalTableSource,
	raw: unknown,
	diagnostics: GlobalTableDiagnostics,
): Promise<GlobalTablePlan | null> {
	const tableTipo = source.tableNode.tipo;
	const entry = (raw ?? {}) as { table_tipo?: unknown; columns_map?: unknown };
	const globalTipo = typeof entry.table_tipo === 'string' ? entry.table_tipo : '';
	if (globalTipo === '') {
		diagnostics.errors.push(
			`table node '${tableTipo}': global_table_maps entry without table_tipo`,
		);
		return null;
	}
	const where = `table node '${tableTipo}' global_table_maps → '${globalTipo}'`;
	const resolved = await resolveGlobalNode(source, globalTipo, where, diagnostics);
	if (resolved === null) return null;

	if (!Array.isArray(entry.columns_map)) {
		diagnostics.errors.push(`${where}: columns_map must be a list`);
		return null;
	}
	const columnsMap: GlobalColumnMap[] = [];
	for (const item of entry.columns_map) {
		const map = columnMapOf(item);
		if (typeof map === 'string') {
			diagnostics.errors.push(`${where}: columns_map item ${map}`);
			return null;
		}
		columnsMap.push(map);
	}

	const anatomy = await compileGlobalSchema(
		source.index,
		globalTipo,
		resolved.tableName,
		where,
		diagnostics,
	);
	if (anatomy === null) return null;
	const declared = new Set(anatomy.schema.fields.map((field) => field.columnName));
	const unknown = unknownColumnsOf(columnsMap, declared, new Set(source.sourceColumns));
	if (unknown.length > 0) {
		// UNRULED (header): not written — the pre-port behaviour — and named.
		diagnostics.warnings.push(
			`global_table_maps_unruled:${tableTipo}>${globalTipo}: ${unknown.join(', ')}`,
		);
		return null;
	}
	return {
		tableTipo: globalTipo,
		schema: anatomy.schema,
		keyLength: anatomy.keyLength,
		provenance: PROVENANCE_COLUMNS.filter((column) => declared.has(column)),
		columnsMap,
	};
}

/**
 * The compiled global tables of one section's table node ([] when it declares
 * none). Errors/warnings land in `diagnostics`; the caller decides fatality
 * (any error refuses the element, like every other structural violation).
 */
export async function compileGlobalTables(
	source: GlobalTableSource,
	diagnostics: GlobalTableDiagnostics,
): Promise<GlobalTablePlan[]> {
	const maps = await globalTableMapsOfNode(source.index, source.tableNode);
	if (maps === undefined || maps === null) return [];
	const tableTipo = source.tableNode.tipo;
	if (!Array.isArray(maps)) {
		diagnostics.errors.push(`table node '${tableTipo}': global_table_maps must be a list`);
		return [];
	}
	if (maps.length === 0) return [];
	if (!source.sqlTarget) {
		diagnostics.errors.push(
			`table node '${tableTipo}': global_table_maps on a non-sql element — only sql elements write global tables`,
		);
		return [];
	}
	const plans: GlobalTablePlan[] = [];
	for (const raw of maps) {
		const plan = await compileOneMap(source, raw, diagnostics);
		if (plan !== null) plans.push(plan);
	}
	return plans;
}

/**
 * Element-level laws over every compiled global table: a global name equal to
 * a source table of the element would mix two row grammars in one table; two
 * different global nodes under one name would fight over its anatomy; a
 * global table wider than MariaDB's row ceiling cannot be created.
 */
export function globalTableElementErrors(sections: readonly SectionPlan[]): string[] {
	const errors: string[] = [];
	const sourceNames = new Set(sections.map((section) => section.tableName));
	const tipoByName = new Map<string, string>();
	for (const section of sections) {
		for (const global of section.globalTables ?? []) {
			const name = global.schema.tableName;
			if (sourceNames.has(name)) {
				errors.push(
					`global table '${name}' (${global.tableTipo}) has the name of a source table of this element`,
				);
			}
			const seen = tipoByName.get(name);
			if (seen === undefined) {
				tipoByName.set(name, global.tableTipo);
				const violation = tableRowSizeViolation(global.schema, globalKeyType(global));
				if (violation !== null) errors.push(violation);
			} else if (seen !== global.tableTipo) {
				errors.push(
					`global table name '${name}' is declared by two different nodes ('${seen}', '${global.tableTipo}')`,
				);
			}
		}
	}
	return [...new Set(errors)];
}

/** The global table names a maps value resolves to (lang sweep: tables to declare). */
export async function globalTableNamesOf(index: OntologyIndex, maps: unknown): Promise<string[]> {
	const names: string[] = [];
	for (const tipo of globalTableTiposOf(maps)) {
		const node = await index.nodeOf(tipo);
		if (node === null || node.model !== 'table') continue;
		try {
			names.push(requireSqlIdentifier(nameOrLabelOf(node) ?? '', 'table'));
		} catch {
			// a name publish refuses was never created
		}
	}
	return names;
}
