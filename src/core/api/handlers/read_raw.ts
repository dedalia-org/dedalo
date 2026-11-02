/**
 * Raw record/component read (PHP dd_core_api::read_raw).
 *
 * read_raw returns the UNRESOLVED stored value(s) for the records a SQO matches
 * — no component resolution, labels, or subdatum. It is the low-level accessor
 * the client uses when it needs the exact jsonb a record holds:
 * - type 'component' → for each matched record, the raw value of ONE component
 *   (the tipo's slice of its model's jsonb column), or null when absent;
 * - type 'section'   → the matched rows' jsonb columns (fetch_all);
 * - type 'target_section' → walk every matched row's relation column and
 *   collect the stored locators whose section_tipo === options.tipo (the
 *   relation-locator harvest tool_export and delete propagation use).
 *
 * PERMISSION — two layers, and this file owns the second:
 *   1. read (>= 1) on each SQO target section, enforced by the CALLER
 *      (dd_core_api read_raw; raw_view adds global-admin + the dd128 denylist);
 *   2. THE COMPONENT KEY, per landed row, enforced HERE through
 *      `security/read_door.ts` (P1-3 / SEC-04, 2026-09-03). DECISION, recorded:
 *      read_raw applies `ddoIsAuthorized` per component key — the human read's
 *      exact predicate — and NOT the GET twin's sensitive-section denylist. A
 *      denylist names the one section somebody thought of (dd128's dd133 hash)
 *      and leaves every other level-0 component of every other section
 *      readable; the per-key grant is what the human read already promises and
 *      what a curator's profile actually says. Concretely:
 *        'component'      → the ONE requested tipo denied on the PRIMARY
 *                           section THROWS `perm.denied` (one typed question,
 *                           one answer); a row that LANDED in another section
 *                           where it is denied yields null + the request notice.
 *        'section'        → every jsonb column is PROJECTED to the keys the
 *                           caller may read on the row's own section
 *                           (projectAuthorizedColumns); a refused key is absent.
 *        'target_section' → locators stored under a denied component key are
 *                           not harvested.
 *      The superuser (-1) resolves to level 3 everywhere, so the frozen
 *      read_raw differential (runs as -1) is byte-identical; a global admin
 *      resolves through their profile like the human read. An ABSENT principal
 *      is an internal read and gates nothing. A narrowed answer carries
 *      `notices:[{code:'perm.out_of_scope'}]` (readDoorNotices) — never silent.
 *      WC-2026-09-03-read-door-component-acl.
 */

import type { Sqo } from '../../concepts/sqo.ts';
import { sanitizeClientSqo } from '../../concepts/sqo.ts';
import { MATRIX_JSONB_COLUMNS, readMatrixRecord } from '../../db/matrix.ts';
import { DedaloError } from '../../errors/index.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../ontology/resolver.ts';
import { runSearch } from '../../search/search_statement.ts';
import { buildSearchSql } from '../../search/sql_assembler.ts';
import type { Principal } from '../../security/permissions.ts';
import {
	authorizeComponentRead,
	doorComponentAllowed,
	projectAuthorizedColumns,
	type ReadDoorScope,
} from '../../security/read_door.ts';

export interface ReadRawResult {
	result: unknown[];
	/** The matrix table the primary section lives in (PHP response->table). */
	table: string | null;
}

/** The door name every refusal log line of this handler carries. */
const DOOR = 'dd_core_api.read_raw';

export interface ReadRawInput {
	sectionTipo: string;
	tipo: string;
	/** Runtime model (defaults to the tipo's ontology model). */
	model?: string;
	/** 'component' (default) | 'section'. */
	type?: string;
	sqo?: Sqo;
}

/**
 * Resolve raw stored values for a SQO's matched records. `principal` scopes the
 * search (per-record projects ACL for non-admins), exactly as a normal read.
 */
export async function readRaw(input: ReadRawInput, principal?: Principal): Promise<ReadRawResult> {
	const table = await getMatrixTableFromTipo(input.sectionTipo);
	const type = input.type ?? 'component';
	const rawData: unknown[] = [];
	// ONE scope per call (frontier property 1); principal undefined = internal.
	const scope: ReadDoorScope = principal === undefined ? { door: DOOR } : { principal, door: DOOR };

	if (input.sqo === undefined) {
		return { result: rawData, table };
	}

	// Run the search (Phase 3 engine) — the matched record coordinates.
	const sqo = sanitizeClientSqo(structuredClone(input.sqo) as Record<string, unknown>);
	const rows = await runSearch<{ section_tipo: string; section_id: number }>(
		await buildSearchSql(sqo, { principal }),
	);

	if (type === 'component') {
		const columnName = await resolveComponentColumn(input);
		// The ONE typed question: (primary section, tipo). Denied → perm.denied,
		// before any row is read.
		await authorizeComponentRead(scope, {
			sectionTipo: input.sectionTipo,
			componentTipo: input.tipo,
		});
		for (const row of rows) {
			rawData.push(await componentValueOf(scope, input, row, columnName));
		}
		return { result: rawData, table };
	}

	if (type === 'section') {
		// fetch_all: the matched rows' jsonb columns (PHP db_result->fetch_all()).
		for (const row of rows) {
			rawData.push(await sectionRowOf(scope, row));
		}
		return { result: rawData, table };
	}

	if (type === 'target_section') {
		// Every stored locator (any component key, any position) whose
		// section_tipo equals the requested tipo, in row → key → item order
		// (PHP nested foreach over the relation object).
		for (const row of rows) {
			const relation = await relationColumnOf(row);
			if (relation === null) continue;
			await harvestTargetLocators(scope, row, relation, input.tipo, rawData);
		}
		return { result: rawData, table };
	}

	throw new DedaloError('request.invalid_options', {
		message: `readRaw: type '${type}' not implemented (covered: 'component', 'section', 'target_section')`,
		coordinates: { type },
	});
}

/** A matched row's coordinates, as the search returned them. */
interface MatchedRow {
	section_tipo: string;
	section_id: number;
}

/** The jsonb column the requested component stores in — or the typed refusal. */
async function resolveComponentColumn(input: ReadRawInput): Promise<string> {
	const model = input.model ?? (await getModelByTipo(input.tipo));
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `readRaw: cannot resolve model for tipo '${input.tipo}'`,
			coordinates: { tipo: input.tipo },
		});
	}
	const columnName = getColumnNameByModel(model);
	if (columnName === null) {
		throw new DedaloError('request.invalid_model', {
			message: `readRaw: cannot resolve data column from model '${model}'`,
			coordinates: { tipo: input.tipo, model },
		});
	}
	return columnName;
}

/**
 * One row's value of the requested component. A row that LANDED in another
 * section (a multi-section SQO, a sibling sharing the table) is that section's
 * read: its own grant decides, and a refusal is a null in position + the
 * request notice (the MANY law).
 */
async function componentValueOf(
	scope: ReadDoorScope,
	input: ReadRawInput,
	row: MatchedRow,
	columnName: string,
): Promise<unknown> {
	if (
		row.section_tipo !== input.sectionTipo &&
		!(await doorComponentAllowed(scope, {
			sectionTipo: row.section_tipo,
			componentTipo: input.tipo,
			sectionId: row.section_id,
		}))
	) {
		return null;
	}
	const recordTable = (await getMatrixTableFromTipo(row.section_tipo)) ?? 'matrix';
	const record = await readMatrixRecord(recordTable, row.section_tipo, row.section_id);
	const column = record?.columns[columnName as (typeof MATRIX_JSONB_COLUMNS)[number]] as
		| Record<string, unknown>
		| null
		| undefined;
	return column?.[input.tipo] ?? null;
}

/** One matched row, whole: every key of every column is a component read of the row's OWN section. */
async function sectionRowOf(
	scope: ReadDoorScope,
	row: MatchedRow,
): Promise<Record<string, unknown>> {
	const recordTable = (await getMatrixTableFromTipo(row.section_tipo)) ?? 'matrix';
	const record = await readMatrixRecord(recordTable, row.section_tipo, row.section_id);
	const columns: Record<string, unknown> = {};
	for (const column of MATRIX_JSONB_COLUMNS) {
		columns[column] = record?.columns[column] ?? null;
	}
	const projected = await projectAuthorizedColumns(
		scope,
		{ sectionTipo: row.section_tipo, sectionId: row.section_id },
		columns,
	);
	const fullRow: Record<string, unknown> = {
		section_id: row.section_id,
		section_tipo: row.section_tipo,
	};
	for (const column of MATRIX_JSONB_COLUMNS) {
		fullRow[column] = projected[column] ?? null;
	}
	return fullRow;
}

/** The row's stored `relation` column, or null when the record or the column is absent. */
async function relationColumnOf(row: MatchedRow): Promise<Record<string, unknown[]> | null> {
	const recordTable = (await getMatrixTableFromTipo(row.section_tipo)) ?? 'matrix';
	const record = await readMatrixRecord(recordTable, row.section_tipo, row.section_id);
	return (record?.columns.relation ?? null) as Record<string, unknown[]> | null;
}

/**
 * Push every locator of `relation` pointing at `targetTipo`, in key → item
 * order. The locators live under a component key: the key's grant on the row's
 * own section decides whether they are harvested.
 */
async function harvestTargetLocators(
	scope: ReadDoorScope,
	row: MatchedRow,
	relation: Record<string, unknown[]>,
	targetTipo: string,
	out: unknown[],
): Promise<void> {
	for (const [componentTipo, componentEntries] of Object.entries(relation)) {
		if (!Array.isArray(componentEntries)) continue;
		const allowed = await doorComponentAllowed(scope, {
			sectionTipo: row.section_tipo,
			componentTipo,
			sectionId: row.section_id,
		});
		if (!allowed) continue;
		for (const locator of componentEntries) {
			if ((locator as { section_tipo?: string } | null)?.section_tipo === targetTipo) {
				out.push(locator);
			}
		}
	}
}
