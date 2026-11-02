/**
 * Selection — keyset-batched record cursor + batched matrix reads
 * (DIFFUSION_SPEC §4.1 stage C, DIFFUSION_PLAN D3-P1).
 *
 * Records are selected through the SAME assembler every other read uses
 * (buildSearchSql over the sanitized SQO — spec §8.4), then paginated by
 * KEYSET (WHERE section_id > cursor ORDER BY section_id LIMIT batch): never
 * OFFSET, so a resumed run re-selects exactly the remaining slice and a batch
 * boundary is a durable checkpoint (the section_id cursor in the job row).
 *
 * readMatrixRecords is the batched twin of core readMatrixRecord (one IN
 * query per batch, spec §4.1 "retire per-record loops") — it lives HERE, not
 * in core/db, because bulk publication reads are a diffusion concern; the
 * projection and allowlist gates are identical to the core reader.
 */

import { canonicalizeStoredSectionId, isSectionId } from '../../core/concepts/section_id.ts';
import type { Sqo } from '../../core/concepts/sqo.ts';
import type { MatrixRecord } from '../../core/db/matrix.ts';
import { assertMatrixTable, MATRIX_JSONB_COLUMNS } from '../../core/db/matrix.ts';
import { sql } from '../../core/db/postgres.ts';
import { runSearch, wrapSearch } from '../../core/search/search_statement.ts';
import { buildSearchSql } from '../../core/search/sql_assembler.ts';
import type { Principal } from '../../core/security/permissions.ts';

/**
 * Read MANY records of one section by id — one IN query (`= ANY($::int[])`).
 * Returns records ordered by section_id ASC (deterministic batches); missing
 * ids are simply absent from the result.
 */
export async function readMatrixRecords(
	tableName: string,
	sectionTipo: string,
	sectionIds: (number | string)[],
): Promise<MatrixRecord[]> {
	if (sectionIds.length === 0) return [];
	assertMatrixTable(tableName);

	// Matrix ADDRESSES only (the shared conversion rule, concepts/section_id.ts):
	// an int, or its canonical string form ('10'). Never Number(): that read a
	// padded external remote id '010' as LOCAL record 10 — another record's row,
	// answered under an id the caller's frontier had cleared as "no local record"
	// (2026-09-24). A non-address here is a caller bug worth failing loud on;
	// callers that can meet one (processBatch, loadRecords) drop it first.
	const numericIds = sectionIds.map((id) => {
		const address = canonicalizeStoredSectionId(id);
		if (!isSectionId(address)) {
			throw new Error(`readMatrixRecords: section_id '${String(id)}' is not a record address`);
		}
		return address;
	});

	const jsonbProjection = MATRIX_JSONB_COLUMNS.map(
		(column) => `"${column}", "${column}"::text AS "${column}__text"`,
	).join(', ');

	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, ${jsonbProjection}
		 FROM "${tableName}"
		 WHERE section_tipo = $1 AND section_id = ANY($2::int[])
		 ORDER BY section_id ASC`,
		[sectionTipo, `{${numericIds.join(',')}}`],
	)) as Record<string, unknown>[];

	return rows.map((row) => {
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
	});
}

/** One keyset batch: the selected ids plus the cursor to resume AFTER them. */
export interface RecordIdBatch {
	sectionIds: number[];
	/** Highest section_id of the batch — the durable checkpoint value. */
	cursor: number;
}

/**
 * Keyset-batched id cursor over one section's selection.
 *
 * The caller's SQO decides WHICH records qualify (filter tree,
 * filter_by_locators, principal-independent — the job spec stores the already
 * sanitized SQO); this generator owns ONLY the pagination: the base query is
 * wrapped as a subselect and windowed by
 * `section_id > $cursor ORDER BY section_id LIMIT $batch`. Any limit/offset/
 * order on the SQO itself is stripped — keyset pagination replaces them.
 */
export async function* selectRecordBatches(
	sqo: Sqo,
	sectionTipo: string,
	batchSize: number,
	afterSectionId = 0,
	principal?: Principal,
): AsyncGenerator<RecordIdBatch> {
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new Error(`selectRecordBatches: invalid batch size ${batchSize}`);
	}

	// Pagination belongs to the cursor, selection to the SQO (see module doc).
	const selectionSqo: Sqo = {
		...sqo,
		section_tipo: sectionTipo,
		limit: null,
		offset: null,
		order: false,
	};
	// DIFF-01: when the enqueuing principal is a non-admin, apply their per-record
	// projects filter so a section-wide diffuse publishes ONLY the caller's
	// in-scope records (never records outside their tenant). Global admins /
	// unresolved system owners select unscoped, exactly as before.
	const base = await buildSearchSql(selectionSqo, principal ? { principal } : {});

	let cursor = afterSectionId;
	for (;;) {
		// Each keyset batch is ONE statement embedding the selection
		// (search_statement.ts wrapSearch keeps its referenced_by flag), so a
		// selection carrying the leaf is bounded PER BATCH by the one executor.
		const batch = wrapSearch(
			base,
			(baseSql, next) =>
				`SELECT section_id
			 FROM (${baseSql}) diffusion_selection
			 WHERE section_id > $${next}
			 ORDER BY section_id ASC
			 LIMIT $${next + 1}`,
			[cursor, batchSize],
		);
		const rows = await runSearch<{ section_id: number }>(batch);

		if (rows.length === 0) return;

		const sectionIds = rows.map((row) => Number(row.section_id));
		cursor = sectionIds[sectionIds.length - 1] as number;
		yield { sectionIds, cursor };

		if (rows.length < batchSize) return;
	}
}

/**
 * Which of `sectionIds` still EXIST in the matrix — one `section_id = ANY`
 * read (DIFF-2 revalidation). A batch is resolved BEFORE its fenced unit takes
 * the target; while it waited, a record may have been deleted from the
 * archive. The runner re-asks under the lock, and a vanished record is
 * unpublished instead of written. Non-address ids are never "existing".
 * Returns canonical-string keys (String(section_id)).
 */
export async function existingSectionIds(
	tableName: string,
	sectionTipo: string,
	sectionIds: readonly (number | string)[],
): Promise<Set<string>> {
	const addresses: number[] = [];
	for (const id of sectionIds) {
		const address = canonicalizeStoredSectionId(id);
		if (isSectionId(address)) addresses.push(Number(address));
	}
	if (addresses.length === 0) return new Set();
	assertMatrixTable(tableName);
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${tableName}"
		 WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
		[sectionTipo, `{${addresses.join(',')}}`],
	)) as { section_id: number }[];
	return new Set(rows.map((row) => String(row.section_id)));
}
