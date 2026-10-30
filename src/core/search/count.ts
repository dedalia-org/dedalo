/**
 * Count the live records of one section (PHP area_common::count_section_records,
 * class.area_common.php:288). Permission-gated (read >= 1) and matrix-table
 * guarded (virtual/untabled sections return null), then a full_count SQO search
 * — the same engine dd_core_api.count uses. Returns null when not
 * countable/accessible so callers can tell "zero records" from "no access".
 */

import { sanitizeClientSqo } from '../concepts/sqo.ts';
import { isMatrixTable } from '../db/matrix.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { getPermissions, type Principal } from '../security/permissions.ts';
import { runSearch } from './search_statement.ts';
import { buildSearchSql } from './sql_assembler.ts';

export async function countSectionRecords(
	principal: Principal,
	sectionTipo: string,
): Promise<number | null> {
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) return null;
	// A section can DECLARE a table that is not a matrix record store: dd15 Time
	// Machine → matrix_time_machine (flat columns, read through the mode 'tm'
	// source, not the search assembler). buildSearchSql refuses it via the
	// identifier allowlist, and that throw used to kill the WHOLE area dashboard
	// (dd207 area_admin lists dd15). "Not countable" is the documented null.
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (!table || !isMatrixTable(table)) return null;

	const sqo = sanitizeClientSqo({ section_tipo: [sectionTipo] });
	sqo.full_count = true;
	const rows = await runSearch<{ full_count: number | string }>(
		await buildSearchSql(sqo, { principal }),
	);
	// Multi-section UNION would yield one count row per branch; a single section
	// yields one — sum for safety (PHP trait.count).
	return rows.reduce((total, row) => total + Number(row.full_count), 0);
}
