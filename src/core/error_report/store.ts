/**
 * Error-report store — the ONE owning module for the dedalo_ts_error_reports
 * table (sql_confinement T4). It holds the reports THIS installation's global
 * admins sent through tool_error_report (WC-2026-11-19-error-report-email-transport);
 * no other installation writes here — there is no network intake.
 *
 * Append-only by construction: this module exports insert/list/count plus the
 * retention prune — no UPDATE exists and the only DELETEs are the retention
 * ones (by age, and the oldest-first eviction that enforces the row ceiling), so
 * a stored report cannot be edited, and cannot be singled out for removal,
 * through any door. The retention prune (opportunistic, on
 * insert — the session_store login-attempts GC precedent) bounds total disk
 * footprint; "append-only" governs integrity WITHIN the retention window, not
 * permanence.
 *
 * DDL lives twice by the migrate.ts documented model: the authoritative copy in
 * install/db/migrations/0002_error_reports.sql (applied at boot) and the lazy
 * fallback below — keep them in lockstep when evolving the table.
 */

import { config } from '../../config/config.ts';
import { sql } from '../db/postgres.ts';

export const ERROR_REPORTS_TABLE = 'dedalo_ts_error_reports';

/** Same identifier guard as migrate.ts — table names are interpolated. */
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** Max rows one list() call may return (the admin widget pages through). */
export const LIST_MAX_LIMIT = 100;

/** One stored report row (written by tool_error_report's send_report;
 * source_ip is always 'local' since the intake was retired). */
export interface ErrorReportRow {
	readonly source_ip: string;
	readonly entity: string | null;
	readonly dedalo_version: string | null;
	readonly user_id: number | null;
	readonly section_tipo: string | null;
	readonly section_id: string | null;
	readonly page_url: string | null;
	readonly description: string;
	readonly js_errors: readonly unknown[] | null;
	readonly context: Readonly<Record<string, unknown>> | null;
}

export interface StoredErrorReport extends ErrorReportRow {
	readonly id: number;
	readonly received_at: string;
}

function tableOrThrow(table: string | undefined): string {
	const name = table ?? ERROR_REPORTS_TABLE;
	if (!TABLE_NAME_PATTERN.test(name)) {
		throw new Error(`error_report store: invalid table name '${name}'`);
	}
	return name;
}

/**
 * Idempotently provision the table + list index. Lazy fallback for installs
 * where the boot migration could not run — the 0002 migration is authoritative.
 */
export async function ensureErrorReportsTable(table?: string): Promise<void> {
	const name = tableOrThrow(table);
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${name}" (
			id             bigserial PRIMARY KEY,
			received_at    timestamptz NOT NULL DEFAULT now(),
			source_ip      text        NOT NULL,
			entity         text,
			dedalo_version text,
			user_id        integer,
			section_tipo   text,
			section_id     text,
			page_url       text,
			description    text        NOT NULL,
			js_errors      jsonb,
			context        jsonb
		)`,
		[],
	);
	await sql.unsafe(
		`CREATE INDEX IF NOT EXISTS "${name}_received_idx" ON "${name}" (received_at DESC)`,
		[],
	);
}

/**
 * Append one report and return its id. Afterwards, opportunistically prune
 * rows older than the retention window (config errorReport.retentionDays,
 * 0 = keep forever) — best-effort: a prune failure never fails the insert.
 */
export async function insertErrorReport(
	report: ErrorReportRow,
	options?: { table?: string; retentionDays?: number; maxRows?: number },
): Promise<number> {
	const name = tableOrThrow(options?.table);
	const rows = (await sql.unsafe(
		`INSERT INTO "${name}"
			(source_ip, entity, dedalo_version, user_id, section_tipo, section_id,
			 page_url, description, js_errors, context)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10::text::jsonb)
		 RETURNING id`,
		[
			report.source_ip,
			report.entity,
			report.dedalo_version,
			report.user_id,
			report.section_tipo,
			report.section_id,
			report.page_url,
			report.description,
			report.js_errors === null ? null : JSON.stringify(report.js_errors),
			report.context === null ? null : JSON.stringify(report.context),
		],
	)) as { id: number }[];

	try {
		await pruneErrorReports({
			apply: true,
			table: name,
			retentionDays: options?.retentionDays,
			maxRows: options?.maxRows,
		});
	} catch (error) {
		console.warn('[error_report] retention prune failed', error);
	}

	return Number(rows[0]?.id);
}

/**
 * THE ONE PRUNE for this store — by AGE and by ROW COUNT (audit 2026-08-26
 * SEC-20). Registered in core/retention/prune.ts; also run opportunistically by
 * every insert, the way session_store GCs its own login attempts.
 *
 * WHY A ROW CEILING AND NOT ONLY A WINDOW. Writers are admins only, throttled
 * per installation (tool_error_report SEND_MAX_PER_WINDOW), but a report may
 * carry an inline screenshot of up to ~200 KiB, and an age window alone bounds
 * time, not size. The ceiling bounds the disk footprint outright.
 *
 * EVICT THE OLDEST, DO NOT REFUSE THE NEWEST. A new report describes the problem
 * someone is facing now; dropping it to keep an old one would lose the report
 * that matters most.
 */
export async function pruneErrorReports(options: {
	apply: boolean;
	table?: string;
	retentionDays?: number;
	maxRows?: number;
}): Promise<{ candidates: number; deleted: number; detail: Record<string, unknown> }> {
	const name = tableOrThrow(options.table);
	const retentionDays = options.retentionDays ?? config.errorReport.retentionDays;
	const maxRows = options.maxRows ?? config.errorReport.maxRows;
	const detail: Record<string, unknown> = {
		table: name,
		window_days: retentionDays,
		max_rows: maxRows,
	};
	const total = await countErrorReports(name);
	const aged = await countAgedReports(name, retentionDays);
	const candidates = aged + (maxRows > 0 ? Math.max(0, total - maxRows) : 0);
	if (!options.apply) return { candidates, deleted: 0, detail };
	const deletedByAge = await deleteAgedReports(name, retentionDays);
	// Recount AFTER the age pass: the window may already have brought the store
	// under the ceiling, and evicting rows nobody asked to lose is not free.
	const deletedByCeiling = await evictOldestReports(name, maxRows);
	return { candidates, deleted: deletedByAge + deletedByCeiling, detail };
}

/** How many rows are outside the age window (0 when there is none). */
async function countAgedReports(name: string, retentionDays: number): Promise<number> {
	if (retentionDays <= 0) return 0;
	const counted = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${name}" WHERE received_at < now() - make_interval(days => $1)`,
		[retentionDays],
	)) as { n: number }[];
	return Number(counted[0]?.n ?? 0);
}

/** Remove the rows outside the age window. Returns how many went. */
async function deleteAgedReports(name: string, retentionDays: number): Promise<number> {
	if (retentionDays <= 0) return 0;
	const removed = (await sql.unsafe(
		`DELETE FROM "${name}" WHERE received_at < now() - make_interval(days => $1) RETURNING id`,
		[retentionDays],
	)) as unknown[];
	return removed.length;
}

/** Bring the store under the row ceiling, oldest first. Returns how many went. */
async function evictOldestReports(name: string, maxRows: number): Promise<number> {
	if (maxRows <= 0) return 0;
	const remaining = await countErrorReports(name);
	if (remaining <= maxRows) return 0;
	const evicted = (await sql.unsafe(
		`DELETE FROM "${name}" WHERE id IN (
			SELECT id FROM "${name}" ORDER BY received_at ASC, id ASC LIMIT $1
		) RETURNING id`,
		[remaining - maxRows],
	)) as unknown[];
	return evicted.length;
}

/** Newest-first page of stored reports for the admin widget. */
export async function listErrorReports(options?: {
	offset?: number;
	limit?: number;
	table?: string;
}): Promise<StoredErrorReport[]> {
	const name = tableOrThrow(options?.table);
	const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, options?.limit ?? 25));
	const offset = Math.max(0, options?.offset ?? 0);
	return (await sql.unsafe(
		`SELECT id, received_at::text AS received_at, source_ip, entity, dedalo_version,
				user_id, section_tipo, section_id, page_url, description, js_errors, context
		 FROM "${name}"
		 ORDER BY received_at DESC, id DESC
		 LIMIT $1 OFFSET $2`,
		[limit, offset],
	)) as StoredErrorReport[];
}

/** Total stored reports (the admin widget's counter). */
export async function countErrorReports(table?: string): Promise<number> {
	const name = tableOrThrow(table);
	const rows = (await sql.unsafe(`SELECT count(*)::int AS total FROM "${name}"`, [])) as {
		total: number;
	}[];
	return Number(rows[0]?.total ?? 0);
}
