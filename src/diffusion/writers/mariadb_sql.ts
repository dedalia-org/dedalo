/**
 * MariaDB SQL writer — the 'sql' DiffusionWriter (DIFFUSION_SPEC §4.3).
 *
 * Consumes ProjectedRows (the lang ladder's output) and lands them in the
 * plan's target database through src/diffusion/targets/mariadb/ — the only
 * MariaDB surface in the tree. The writer knows the PLAN (tables, columns),
 * never the ontology.
 *
 * Session lifecycle (WriterSession contract, writers/types.ts):
 * - open(plan): pool for plan.target.database + LOUD reachability probe —
 *   a missing/ungranted database is MissingTargetDatabaseError (typed config
 *   failure at open, before any schema or row work; never auto-created).
 * - ensureSchema(): ONCE per run, serialized table by table: CREATE TABLE IF
 *   NOT EXISTS → INFORMATION_SCHEMA column diff → additive ALTER ADD. DDL
 *   auto-commits in MariaDB, so this NEVER runs inside a row transaction
 *   (plan D5.7) — deliberately unlike the old engine, which re-ran
 *   create/ensure inside every insert_table_data transaction.
 * - writeRows(): multi-row upserts (~DEDALO_DIFFUSION_BATCH_ROWS rows per
 *   statement, byte-budget capped) inside ONE transaction per call — the
 *   old engine's one-INSERT-per-record loop is deliberately replaced.
 * - removeRecords(): batched DELETE by section_id; a missing table/database
 *   (errno 1146/1049) is a tolerated no-op — the old engine's delete
 *   posture, kept verbatim.
 * - close(): per-table {table_name, records_affected, records_count} — the
 *   old engine's engine_response.tables shape (lib/types.ts:186), which the
 *   byte-identical client renders.
 * - abort(): no-op — SQL work is transactional; anything uncommitted was
 *   already rolled back by the failed writeRows call.
 *
 * Every statement that can WAIT on a target-side lock runs through
 * boundSqlTargetStatement (core/diffusion_bridge/target_lock.ts): the runner
 * calls this writer inside its fenced unit, which keeps its target for as long
 * as a statement waits — a metadata lock held by the public site's long read
 * would otherwise hold the target fence (and every door on it) for MariaDB's
 * default `lock_wait_timeout`, a day. Waited out, the statement fails (errno
 * 1205), the unit rolls back and the run fails loudly.
 */

import { readString } from '../../config/readers.ts';
import { globalRowKey } from '../../core/diffusion_bridge/global_tables.ts';
import { boundSqlTargetStatement } from '../../core/diffusion_bridge/target_lock.ts';
import { DedaloError } from '../../core/errors/index.ts';
import { globalKeyType } from '../plan/global_tables.ts';
import type { GlobalTablePlan, PublicationPlan, SectionPlan } from '../plan/types.ts';
import { deriveGlobalRows } from '../project/global_table.ts';
import type { ProjectedRow } from '../project/lang_ladder.ts';
import type { MariadbExecResult } from '../targets/mariadb/db.ts';
import {
	getTargetPool,
	isMissingDatabaseError,
	isMissingTableError,
	probeTargetDatabase,
} from '../targets/mariadb/db.ts';
import {
	DEFAULT_UPSERT_BATCH_BYTES,
	DEFAULT_UPSERT_BATCH_ROWS,
	generateAddColumns,
	generateBatchUpsert,
	generateColumnsQuery,
	generateCreateTable,
	generateDelete,
	planUpsertBatches,
	tableColumnFields,
} from '../targets/mariadb/sql_generator.ts';
import { applyTableState } from '../targets/mediastore/media_index.ts';
import { WriterRunLog } from './files.ts';
import type {
	ArtifactEvent,
	DiffusionWriter,
	TableCounters,
	WriteBatchResult,
	WriterCloseContext,
	WriterContinuity,
	WriterOpenContext,
	WriterRunSummary,
	WriterSession,
} from './types.ts';

/** Max section_ids per DELETE statement (IN-list kept boring and bounded). */
const DELETE_BATCH_IDS = 500;

/** Row cap per upsert statement (plan D1: DEDALO_DIFFUSION_BATCH_ROWS, default 200). */
function upsertBatchRows(): number {
	const configured = Number(readString('DEDALO_DIFFUSION_BATCH_ROWS'));
	return Number.isFinite(configured) && configured > 0
		? Math.floor(configured)
		: DEFAULT_UPSERT_BATCH_ROWS;
}

/**
 * The distinct global tables a plan writes (by name — the compiler refused two
 * nodes under one name, so one name is one anatomy).
 */
function distinctGlobalTables(plan: PublicationPlan): GlobalTablePlan[] {
	const byName = new Map<string, GlobalTablePlan>();
	for (const section of plan.sections) {
		for (const global of section.globalTables ?? []) {
			if (!byName.has(global.schema.tableName)) byName.set(global.schema.tableName, global);
		}
	}
	return [...byName.values()];
}

/** Anything `unsafe` can run on: the pool or one of its transactions. */
type SqlRunner = { unsafe(sql: string, params: (string | number | null)[]): Promise<unknown> };

/** Upsert rows into one table in byte-capped multi-row statements; returns affected rows. */
async function upsertRows(
	runner: SqlRunner,
	table: SectionPlan,
	rows: ProjectedRow[],
): Promise<number> {
	const columnNames = tableColumnFields(table).map((field) => field.columnName);
	const batches = planUpsertBatches(rows, columnNames, {
		maxRowsPerStatement: upsertBatchRows(),
		maxBytesPerStatement: DEFAULT_UPSERT_BATCH_BYTES,
	});
	let affectedRows = 0;
	for (const batch of batches) {
		const statement = generateBatchUpsert(table.tableName, columnNames, batch);
		const result = (await runner.unsafe(
			boundSqlTargetStatement(statement.sql),
			statement.params,
		)) as MariadbExecResult;
		affectedRows += result.affectedRows ?? 0;
	}
	return affectedRows;
}

/**
 * Batched DELETE by section_id. A missing table or database means "nothing was
 * ever published there" — a zero-row no-op (oracle errno 1146/1049 posture).
 */
async function deleteByIds(
	runner: SqlRunner,
	tableName: string,
	sectionIds: readonly (number | string)[],
): Promise<number> {
	let deletedRows = 0;
	for (let offset = 0; offset < sectionIds.length; offset += DELETE_BATCH_IDS) {
		const statement = generateDelete(
			tableName,
			sectionIds.slice(offset, offset + DELETE_BATCH_IDS),
		);
		try {
			const result = (await runner.unsafe(
				boundSqlTargetStatement(statement.sql),
				statement.params,
			)) as MariadbExecResult;
			deletedRows += result.affectedRows ?? 0;
		} catch (error) {
			if (isMissingTableError(error) || isMissingDatabaseError(error)) break;
			throw error;
		}
	}
	return deletedRows;
}

class MariadbWriterSession implements WriterSession {
	private readonly plan: PublicationPlan;
	private readonly database: string;
	/** Per-table counters (restored on resume: the summary counts the whole run). */
	private readonly log: WriterRunLog;
	private schemaEnsured = false;

	constructor(plan: PublicationPlan, database: string, context?: WriterOpenContext) {
		this.plan = plan;
		this.database = database;
		this.log = new WriterRunLog(
			[
				...plan.sections.map((section) => section.tableName),
				...distinctGlobalTables(plan).map((global) => global.schema.tableName),
			],
			context,
		);
	}

	get continuity(): WriterContinuity {
		return this.log.continuity;
	}

	private countersFor(tableName: string): TableCounters {
		return this.log.countersFor(tableName);
	}

	/**
	 * Schema critical section: serialized per table, strictly BEFORE any DML.
	 * Additive only — existing columns are never retyped or dropped.
	 */
	async ensureSchema(): Promise<void> {
		for (const section of this.plan.sections) await this.ensureTable(section);
		// Global tables: the same three steps, keyed by their VARCHAR composite key.
		for (const global of distinctGlobalTables(this.plan)) {
			await this.ensureTable(global.schema, globalKeyType(global));
		}
		this.schemaEnsured = true;
	}

	/** CREATE IF NOT EXISTS → INFORMATION_SCHEMA diff → additive ALTER ADD, for one table. */
	private async ensureTable(table: SectionPlan, sectionIdType?: string): Promise<void> {
		const pool = getTargetPool(this.database);
		// 1. Table with the full plan anatomy (no-op when it already exists).
		await pool.unsafe(
			boundSqlTargetStatement(
				generateCreateTable(table, sectionIdType !== undefined ? { sectionIdType } : {}),
			),
			[],
		);

		// 2. Diff live columns against the plan (covers pre-existing tables).
		//    Unbounded on purpose: INFORMATION_SCHEMA takes a high-priority
		//    metadata lock that never queues behind a pending writer.
		const columnsQuery = generateColumnsQuery(this.database, table.tableName);
		const rows = (await pool.unsafe(columnsQuery.sql, columnsQuery.params)) as {
			COLUMN_NAME: string;
		}[];
		const existingColumns = new Set(rows.map((row) => row.COLUMN_NAME));

		// 3. Additive ALTER ADD for every plan column the table lacks.
		const missingColumns = tableColumnFields(table)
			.map((field) => field.columnName)
			.filter((columnName) => !existingColumns.has(columnName));
		for (const alterSql of generateAddColumns(table, missingColumns)) {
			await pool.unsafe(boundSqlTargetStatement(alterSql), []);
		}
	}

	/**
	 * Upsert one section's projected rows: byte-capped multi-row statements,
	 * ONE transaction for the whole call (a write-batch is atomic; a failure
	 * rolls back the entire call and propagates to the runner).
	 */
	async writeRows(section: SectionPlan, rows: ProjectedRow[]): Promise<WriteBatchResult> {
		if (rows.length === 0) return { written: 0, deleted: 0 };
		if (!this.schemaEnsured) {
			const reason =
				'schema-ensure is a serialized run-start step (DDL auto-commits, never mid-DML)';
			throw new Error(
				`mariadb_sql writer: writeRows('${section.tableName}') before ensureSchema() — ${reason}`,
			);
		}

		const pool = getTargetPool(this.database);
		let affectedRows = 0;
		const globalAffected = new Map<string, number>();
		await pool.begin(async (transaction) => {
			affectedRows = await upsertRows(transaction, section, rows);
			// Global tables, in the SAME transaction (one unit with the source
			// rows): delete-then-insert per record, v6 save_global_table_data
			// :2599-2633 — drops a lang the record no longer has, and holds on a
			// legacy table without the (section_id, lang) key.
			for (const global of section.globalTables ?? []) {
				const globalRows = deriveGlobalRows(section, global, rows);
				const keys = [...new Set(globalRows.map((row) => String(row.sectionId)))];
				const deleted = await deleteByIds(transaction, global.schema.tableName, keys);
				const written = await upsertRows(transaction, global.schema, globalRows);
				globalAffected.set(global.schema.tableName, deleted + written);
			}
		});

		const counters = this.countersFor(section.tableName);
		counters.records_affected += affectedRows;
		counters.records_count += rows.length;
		for (const [tableName, affected] of globalAffected) {
			const globalCounters = this.countersFor(tableName);
			globalCounters.records_affected += affected;
			globalCounters.records_count += rows.length;
		}

		// S2-31: mirror the committed publish into the media marker store
		// (oracle index.ts:213 — after the write, per table; marker failures
		// are reported but never fail the diffusion, index.ts:212-224).
		try {
			const publishedIds = [...new Set(rows.map((row) => row.sectionId))];
			await applyTableState(
				this.database,
				section.tableName,
				section.sectionTipo,
				publishedIds,
				[],
			);
		} catch (error) {
			console.error(
				`[media_index] marker publish failed for ${this.database}.${section.tableName} (rows committed; markers heal on next reconcile/rebuild):`,
				error,
			);
		}
		return { written: rows.length, deleted: 0 };
	}

	/**
	 * Remove published records (unpublish sentinel + delete propagation). A
	 * missing table or database means "nothing was ever published there" —
	 * tolerated as a zero-row no-op (oracle errno 1146/1049 posture).
	 */
	async removeRecords(
		section: SectionPlan,
		sectionIds: (number | string)[],
	): Promise<WriteBatchResult> {
		if (sectionIds.length === 0) return { written: 0, deleted: 0 };

		const pool = getTargetPool(this.database);
		const deletedRows = await deleteByIds(pool, section.tableName, sectionIds);
		this.countersFor(section.tableName).records_affected += deletedRows;

		// The record's global rows leave with it (v6 publication=no :1439-1483).
		const globalKeys = sectionIds.map((id) => globalRowKey(section.sectionTipo, id));
		for (const global of section.globalTables ?? []) {
			const deleted = await deleteByIds(pool, global.schema.tableName, globalKeys);
			this.countersFor(global.schema.tableName).records_affected += deleted;
		}

		// S2-31: drop the markers for the unpublished ids (same posture as the
		// publish-side apply above — logged, never failing the run).
		try {
			await applyTableState(this.database, section.tableName, section.sectionTipo, [], sectionIds);
		} catch (error) {
			console.error(
				`[media_index] marker removal failed for ${this.database}.${section.tableName} (rows removed; markers heal on next reconcile/rebuild):`,
				error,
			);
		}
		return { written: 0, deleted: deletedRows };
	}

	/** SQL targets publish rows, not files: no artifact ever enters the run manifest. */
	takeArtifacts(): ArtifactEvent[] {
		return [];
	}

	/** Every write committed in MariaDB inside its call; the state is the counters. */
	async checkpoint(): Promise<unknown> {
		return this.log.checkpoint();
	}

	runSummary(): WriterRunSummary {
		return this.log.summary();
	}

	/** Final per-table counts — the old engine_response.tables shape. */
	async close(_context?: WriterCloseContext): Promise<WriterRunSummary> {
		return this.log.summary();
	}

	/**
	 * Nothing to clean for SQL: every write ran inside a transaction that
	 * either committed or already rolled back; schema DDL is idempotent and
	 * additive. Pools are process-cached, not session-owned.
	 */
	async abort(): Promise<void> {
		// no-op by design
	}
}

/** The 'sql' format writer (registry entry; 'socrata' aliases it, dormant). */
export const mariadbSqlWriter: DiffusionWriter = {
	format: 'sql',
	async open(plan: PublicationPlan, context?: WriterOpenContext): Promise<WriterSession> {
		if (plan.target.kind !== 'table') {
			throw new DedaloError('diffusion.invalid_target', {
				message:
					`mariadb_sql writer requires a 'table' target, got '${plan.target.kind}' ` +
					`(element ${plan.elementTipo})`,
				coordinates: { target_kind: plan.target.kind, element_tipo: plan.elementTipo },
			});
		}
		// Loud config gate: unreachable/ungranted database fails the run HERE.
		await probeTargetDatabase(plan.target.database);
		return new MariadbWriterSession(plan, plan.target.database, context);
	},
};
