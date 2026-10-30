/**
 * GATE-SIDE INSPECTION of a built search: the assembler's statement as plain
 * `{ sql, params, carriesReferencedBy }`, for gates that assert the SQL shape
 * or replay it by hand.
 *
 * The assembler (src/core/search/sql_assembler.ts `buildSearchSql`) returns an
 * OPAQUE SearchStatement that production code can only run through the one
 * executor (src/core/search/search_statement.ts — the chokepoint, pinned by
 * test/unit/search_statement_chokepoint_tripwire.test.ts). Gates read the text
 * through `searchStatementText`, the inspection door; this helper is that read,
 * shaped like the pre-chokepoint `{ sql, params }` result. Use the real
 * `buildSearchSql` when a gate must hand the statement to an engine door.
 */

import { searchStatementText } from '../../src/core/search/search_statement.ts';
import { buildSearchSql as buildSearchStatement } from '../../src/core/search/sql_assembler.ts';

export async function buildSearchSql(
	...args: Parameters<typeof buildSearchStatement>
): Promise<{ sql: string; params: unknown[]; carriesReferencedBy: boolean }> {
	const shown = searchStatementText(await buildSearchStatement(...args));
	return {
		sql: shown.sql,
		params: [...shown.params],
		carriesReferencedBy: shown.carriesReferencedBy,
	};
}
