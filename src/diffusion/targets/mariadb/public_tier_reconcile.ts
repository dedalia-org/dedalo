/**
 * PUBLIC TIER ↔ MATRIX RECONCILE (audit 2026-08-26 P1-12: LIFE-02, LIFE-07,
 * PUB-02, PUB-03).
 *
 * THE DEFECT THIS CLOSES. What the public tier holds — rows in the MariaDB
 * publication tables, the `.publication/dbs/` media markers that make a
 * record's media anonymously fetchable, and the per-record rdf/xml/markdown
 * documents — was maintained ONLY by live events: a publish run upserts, a
 * record delete unpublishes. Nothing ever compared the two stores. So a matrix
 * RESTORE (rows that vanish without a delete event), a delete whose unpublish
 * never settled, or a curator flipping a record to "not publishable" without a
 * re-publish left GHOSTS served indefinitely under stable public URLs — and a
 * re-published id later REPLACED a ghost's content at the same address.
 *
 * WHAT THIS IS. One `ReconcileDefinition` (core/reconcile/registry.ts) with
 * the registry's shape — dry-run / apply / gauge — over the pair:
 *
 *   MATRIX  the record exists AND its publication flag (component_publication
 *           → dd64/1; a section without the component is always publishable)
 *   TIER    (a) `.publication/dbs/<db>/<table>/<st>_<id>` markers,
 *           (b) `SELECT DISTINCT section_id` per sql target table when the
 *               MariaDB target answers, (c) the per-record files under
 *               `<files root>/<type>/<service>/` (the ONE producer's grammar,
 *               core/diffusion_bridge/published_files.ts)
 *
 * DRIFT (units of disagreement):
 *   - GHOST: the tier holds a record the matrix does not, or holds as
 *     unpublishable, or whose section the ontology no longer knows;
 *   - MISSING: the matrix flags a record publishable and a target of its
 *     section lacks it (REPORTED ONLY — publishing is a job with a principal
 *     and a plan, never a reconcile side effect);
 *   - the dd1758 debt is reported beside them: rows still pending, and rows
 *     TERMINAL (PUB-02: a csv/json export still carrying a deleted record can
 *     only be settled by a re-publish — the operator must know).
 *
 * APPLY unpublishes GHOSTS only: the marker is dropped through the store's own
 * writer, the MariaDB row through the same executor a record delete uses,
 * the file by unlinking the exact path the producer named. MISSING stays a
 * report. A MariaDB target that does not answer is REPORTED in
 * `detail.unreachable` and its markers/files are still compared — never
 * silent, never a throw that hides the rest.
 *
 * `scope` = section tipos: only records of those sections are examined
 * (markers/files keyed by them, targets that publish them). Schedule is
 * 'operator': the walk reads every target table and the whole marker store.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isLocatorInArray, type Locator } from '../../../core/concepts/locator.ts';
import { sql } from '../../../core/db/postgres.ts';
import {
	activityTable,
	DIFFUSION_ACTION,
	diffusionActionContains,
	RETRY_STAMP_KEY,
} from '../../../core/diffusion_bridge/diffusion_delete.ts';
import type { DiffusionSqlTarget } from '../../../core/diffusion_bridge/diffusion_map.ts';
import { getAllSectionDiffusionTargets } from '../../../core/diffusion_bridge/diffusion_map.ts';
import {
	globalRowKey,
	globalRowKeyLikePattern,
	parseGlobalRowKey,
} from '../../../core/diffusion_bridge/global_tables.ts';
import {
	diffusionFilesRoot,
	PER_RECORD_FILE_FORMATS,
	parsePublishedRecordFileName,
} from '../../../core/diffusion_bridge/published_files.ts';
import {
	fileTargetLockKey,
	OPERATOR_FENCE_BOUND_MS,
	remainingFenceBudget,
	sqlTargetLockKey,
	withTargetLock,
} from '../../../core/diffusion_bridge/target_lock.ts';
import {
	findFirstDescendantTipoByModel,
	getMatrixTableFromTipo,
	getNode,
} from '../../../core/ontology/resolver.ts';
import type { ReconcileReport } from '../../../core/reconcile/registry.ts';
import { escapeSqlIdentifier } from '../../plan/identifier.ts';
import { applyTableState, markerStoreBase } from '../mediastore/media_index.ts';
import { getTargetPool, isMissingDatabaseError, isMissingTableError } from './db.ts';
import { executeSqlDeleteTargets } from './delete_record.ts';

/** PHP DEDALO_SECTION_SI_NO_TIPO / NUMERICAL_MATRIX_VALUE_YES (dd_tipos.php:83): the "yes" locator. */
const YES_LOCATOR: Locator = { section_tipo: 'dd64', section_id: 1 };

/** Marker keys are `<tipo>_<id>` — the store's own grammar (media_index.ts). */
const MARKER_KEY = /^([a-z0-9]+)_([0-9]+)$/i;

/** How long a MariaDB target may take to answer before it is reported unreachable. */
const TARGET_PROBE_TIMEOUT_MS = 5000;

export interface PublicTierGhost {
	store: 'marker' | 'mariadb' | 'file';
	/** `db|table` for marker/mariadb, `<type>:<service>` for a file. */
	target: string;
	section_tipo: string;
	section_id: number;
	reason: 'record_absent' | 'unpublishable' | 'unknown_section';
	/** The marker or file path (apply unlinks exactly this). */
	path?: string;
	/**
	 * A row of a GLOBAL table (`target` = `db|<global table>`), keyed there by
	 * `<section_tipo>_<section_id>` (core/diffusion_bridge/global_tables.ts).
	 */
	global?: true;
}

export interface PublicTierMissing {
	target: string;
	section_tipo: string;
	section_id: number;
}

export interface PublicTierScan {
	ghosts: PublicTierGhost[];
	missing: PublicTierMissing[];
	/** MariaDB databases that did not answer (their rows could not be compared). */
	unreachable: string[];
	/** dd1758 unpublish_pending rows still retryable. */
	pending_debt: number;
	/** dd1758 rows no retry can settle (reason in misc.dd1758_retry.terminal). */
	terminal_debt: number;
	/** What was examined — so an empty report is legible. */
	examined: { targets: number; markers: number; mariadb_rows: number; files: number };
}

/** The matrix's verdict on one record: exists? flagged publishable? */
type MatrixVerdict = 'publishable' | 'unpublishable' | 'absent' | 'unknown_section';

/**
 * Batched matrix lookup for one section: which of `ids` exist, and which of
 * those are flagged publishable (the resolver's isRecordPublishable, verbatim:
 * the FIRST publication locator must be dd64/1; no component ⇒ always yes).
 */
async function matrixVerdicts(
	sectionTipo: string,
	ids: readonly number[],
): Promise<Map<number, MatrixVerdict>> {
	const verdicts = new Map<number, MatrixVerdict>();
	if (ids.length === 0) return verdicts;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		for (const id of ids) verdicts.set(id, 'unknown_section');
		return verdicts;
	}
	const publicationTipo = await findFirstDescendantTipoByModel(
		sectionTipo,
		'component_publication',
	);
	const rows = (await sql.unsafe(
		`SELECT section_id, relation FROM "${table}"
		 WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
		// Bun.sql binds an array as a PG array LITERAL (node_repository.ts idiom).
		[sectionTipo, `{${ids.join(',')}}`],
	)) as { section_id: number; relation: Record<string, unknown> | string | null }[];
	for (const id of ids) verdicts.set(id, 'absent');
	for (const row of rows) {
		let verdict: MatrixVerdict = 'publishable';
		if (publicationTipo !== null) {
			const relation =
				typeof row.relation === 'string'
					? (JSON.parse(row.relation) as Record<string, unknown>)
					: (row.relation ?? {});
			const items = relation[publicationTipo];
			const first = Array.isArray(items) ? (items[0] as Locator | undefined) : undefined;
			// The locator law (concepts/locator.ts): loose section_id, exact tipo.
			const flagged =
				first !== undefined &&
				isLocatorInArray(first, [YES_LOCATOR], ['section_tipo', 'section_id']);
			verdict = flagged ? 'publishable' : 'unpublishable';
		}
		verdicts.set(Number(row.section_id), verdict);
	}
	return verdicts;
}

/** Every publishable record id of one section (the MISSING side's ground truth). */
async function publishableIds(sectionTipo: string): Promise<number[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id`,
		[sectionTipo],
	)) as { section_id: number }[];
	const ids = rows.map((row) => Number(row.section_id));
	const verdicts = await matrixVerdicts(sectionTipo, ids);
	return ids.filter((id) => verdicts.get(id) === 'publishable');
}

async function readdirQuiet(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		throw error;
	}
}

/**
 * `SELECT DISTINCT section_id` of one target table, or null when the target
 * does not answer. With `globalOf`, the table is a GLOBAL table: only the keys
 * of that section are read and parsed back to its section ids.
 */
async function tierRowIds(
	database: string,
	table: string,
	globalOf?: string,
): Promise<number[] | null> {
	const pool = getTargetPool(database);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(new Error(`target '${database}' did not answer in ${TARGET_PROBE_TIMEOUT_MS}ms`)),
			TARGET_PROBE_TIMEOUT_MS,
		);
	});
	try {
		const query =
			globalOf === undefined
				? pool.unsafe(`SELECT DISTINCT section_id FROM ${escapeSqlIdentifier(table)}`, [])
				: pool.unsafe(
						`SELECT DISTINCT section_id FROM ${escapeSqlIdentifier(table)} WHERE section_id LIKE ?`,
						[globalRowKeyLikePattern(globalOf)],
					);
		const rows = (await Promise.race([query, timeout])) as { section_id: unknown }[];
		if (globalOf !== undefined) {
			return rows
				.map((row) => parseGlobalRowKey(String(row.section_id), globalOf))
				.filter((id): id is number => id !== null);
		}
		return rows.map((row) => Number(row.section_id)).filter((id) => Number.isSafeInteger(id));
	} catch (error) {
		// Missing table/database = nothing published there (the delete executor's
		// own errno posture); anything else = the target is unreachable.
		if (isMissingTableError(error) || isMissingDatabaseError(error)) return [];
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** The ghost classification of a verdict, or null when the record belongs in the tier. */
function ghostReason(verdict: MatrixVerdict | undefined): PublicTierGhost['reason'] | null {
	switch (verdict) {
		case 'publishable':
			return null;
		case 'unpublishable':
			return 'unpublishable';
		case 'unknown_section':
			return 'unknown_section';
		default:
			return 'record_absent';
	}
}

/** The dd1758 debt counts (pending retryable / terminal), scoped when asked. */
async function debtCounts(
	scope: ReadonlySet<string> | null,
): Promise<{ pending: number; terminal: number }> {
	const params: unknown[] = [];
	const probe = diffusionActionContains(
		'relation',
		DIFFUSION_ACTION.unpublishPending,
		(payload) => `$${params.push(payload)}`,
	);
	let scopeClause = '';
	if (scope !== null) {
		// PG array literal; tipos are alphanumerics, quoted anyway (array_in grammar).
		params.push(`{${[...scope].map((tipo) => `"${tipo.replace(/["\\]/g, '')}"`).join(',')}}`);
		scopeClause = ` AND (relation->'dd1763'->0->>'section_tipo') = ANY($${params.length}::text[])`;
	}
	let rows: { terminal: boolean; n: number }[];
	try {
		rows = (await sql.unsafe(
			`SELECT (misc->'${RETRY_STAMP_KEY}'->>'terminal') IS NOT NULL AS terminal, count(*)::int AS n
			 FROM "${activityTable()}"
			 WHERE section_tipo = 'dd1758' AND ${probe}${scopeClause}
			 GROUP BY 1`,
			params,
		)) as { terminal: boolean; n: number }[];
	} catch (error) {
		// A scratch activity table that was never materialized (test seam) holds no
		// debt. Bun's PostgresError carries the SQLSTATE in `errno` (`code` is the
		// driver's own ERR_POSTGRES_SERVER_ERROR); read both spellings.
		const { code, errno } = error as { code?: string; errno?: string };
		if (errno === '42P01' || code === '42P01') return { pending: 0, terminal: 0 };
		throw error;
	}
	const counts = { pending: 0, terminal: 0 };
	for (const row of rows) {
		if (row.terminal) counts.terminal += Number(row.n);
		else counts.pending += Number(row.n);
	}
	return counts;
}

/**
 * THE DRY RUN: compare every tier store against the matrix. Writes nothing.
 */
export async function scanPublicTier(scope?: readonly string[]): Promise<PublicTierScan> {
	const inScope = scope === undefined || scope.length === 0 ? null : new Set(scope);
	const scan: PublicTierScan = {
		ghosts: [],
		missing: [],
		unreachable: [],
		pending_debt: 0,
		terminal_debt: 0,
		examined: { targets: 0, markers: 0, mariadb_rows: 0, files: 0 },
	};
	const verdictCache = new Map<string, Map<number, MatrixVerdict>>();
	const verdictOf = async (
		sectionTipo: string,
		ids: number[],
	): Promise<Map<number, MatrixVerdict>> => {
		const cached = verdictCache.get(sectionTipo) ?? new Map<number, MatrixVerdict>();
		const unknown = ids.filter((id) => !cached.has(id));
		if (unknown.length > 0) {
			for (const [id, verdict] of await matrixVerdicts(sectionTipo, unknown))
				cached.set(id, verdict);
		}
		verdictCache.set(sectionTipo, cached);
		return cached;
	};

	// (a) the marker store — every dbs/<db>/<table>/<key>, whatever the ontology says now.
	const base = markerStoreBase();
	if (base !== null) {
		const dbsDir = path.join(base, 'dbs');
		for (const dbName of await readdirQuiet(dbsDir)) {
			for (const tableName of await readdirQuiet(path.join(dbsDir, dbName))) {
				const tableDir = path.join(dbsDir, dbName, tableName);
				const byTipo = new Map<string, number[]>();
				for (const key of await readdirQuiet(tableDir)) {
					const match = MARKER_KEY.exec(key);
					if (match === null) continue;
					const sectionTipo = match[1] as string;
					if (inScope !== null && !inScope.has(sectionTipo)) continue;
					scan.examined.markers++;
					byTipo.set(sectionTipo, [...(byTipo.get(sectionTipo) ?? []), Number(match[2])]);
				}
				for (const [sectionTipo, ids] of byTipo) {
					const verdicts = await verdictOf(sectionTipo, ids);
					for (const id of ids) {
						const reason = ghostReason(verdicts.get(id));
						if (reason === null) continue;
						scan.ghosts.push({
							store: 'marker',
							target: `${dbName}|${tableName}`,
							section_tipo: sectionTipo,
							section_id: id,
							reason,
							path: path.join(tableDir, `${sectionTipo}_${id}`),
						});
					}
				}
			}
		}
	}

	// (b) + (c) + MISSING: per section, per target the ontology declares.
	const targetsBySection = await getAllSectionDiffusionTargets();
	let filesRoot: string | null = null;
	try {
		filesRoot = diffusionFilesRoot();
	} catch {
		filesRoot = null; // no root configured: file targets cannot be compared, reported below
	}
	const probedDatabases = new Map<string, boolean>();
	const scannedFileDirs = new Set<string>();
	for (const [sectionTipo, targets] of targetsBySection) {
		if (inScope !== null && !inScope.has(sectionTipo)) continue;
		let publishable: number[] | null = null;
		const publishableOf = async (): Promise<number[]> => {
			if (publishable === null) publishable = await publishableIds(sectionTipo);
			return publishable;
		};
		for (const target of targets) {
			scan.examined.targets++;
			if (target.type === 'sql' || target.type === 'socrata') {
				if (target.database_name === '' || target.table_name === '') continue; // terminal, on the ledger
				for (const table of sqlTablesOf(target)) {
					await scanSqlTable(scan, {
						database: target.database_name,
						table: table.name,
						sectionTipo,
						global: table.global,
						probedDatabases,
						verdictOf,
						publishableOf,
					});
				}
				continue;
			}
			if (!PER_RECORD_FILE_FORMATS.has(target.type) || filesRoot === null) continue;
			const service = await elementServiceName(target.element_tipo);
			if (service === null) continue; // never published (terminal on the ledger)
			const dir = `${filesRoot}/${target.type}/${service}`;
			const key = `${target.type}:${service}`;
			const held = new Set<number>();
			if (!scannedFileDirs.has(dir)) {
				scannedFileDirs.add(dir);
				const byTipo = new Map<string, { id: number; name: string }[]>();
				for (const name of await readdirQuiet(dir)) {
					const parsed = parsePublishedRecordFileName(target.type, name);
					if (parsed === null) continue;
					if (inScope !== null && !inScope.has(parsed.sectionTipo)) continue;
					scan.examined.files++;
					byTipo.set(parsed.sectionTipo, [
						...(byTipo.get(parsed.sectionTipo) ?? []),
						{ id: parsed.sectionId, name },
					]);
				}
				for (const [fileTipo, entries] of byTipo) {
					const verdicts = await verdictOf(
						fileTipo,
						entries.map((entry) => entry.id),
					);
					for (const entry of entries) {
						if (fileTipo === sectionTipo) held.add(entry.id);
						const reason = ghostReason(verdicts.get(entry.id));
						if (reason === null) continue;
						scan.ghosts.push({
							store: 'file',
							target: key,
							section_tipo: fileTipo,
							section_id: entry.id,
							reason,
							path: `${dir}/${entry.name}`,
						});
					}
				}
			} else {
				for (const name of await readdirQuiet(dir)) {
					const parsed = parsePublishedRecordFileName(target.type, name);
					if (parsed !== null && parsed.sectionTipo === sectionTipo) held.add(parsed.sectionId);
				}
			}
			for (const id of await publishableOf()) {
				if (!held.has(id))
					scan.missing.push({ target: key, section_tipo: sectionTipo, section_id: id });
			}
		}
	}

	const debt = await debtCounts(inScope);
	scan.pending_debt = debt.pending;
	scan.terminal_debt = debt.terminal;
	scan.ghosts.sort(compareGhosts);
	scan.missing.sort(
		(a, b) =>
			a.target.localeCompare(b.target) ||
			a.section_tipo.localeCompare(b.section_tipo) ||
			a.section_id - b.section_id,
	);
	return scan;
}

/** A sql target's tables to compare: its own, then every global table it writes. */
function sqlTablesOf(target: DiffusionSqlTarget): { name: string; global: boolean }[] {
	return [
		{ name: target.table_name, global: false },
		...(target.global_tables ?? []).map((name) => ({ name, global: true })),
	];
}

/** One MariaDB table of a section compared against the matrix (ghosts + missing). */
async function scanSqlTable(
	scan: PublicTierScan,
	input: {
		database: string;
		table: string;
		sectionTipo: string;
		global: boolean;
		probedDatabases: Map<string, boolean>;
		verdictOf: (sectionTipo: string, ids: number[]) => Promise<Map<number, MatrixVerdict>>;
		publishableOf: () => Promise<number[]>;
	},
): Promise<void> {
	const { database, table, sectionTipo } = input;
	const key = `${database}|${table}`;
	const ids = await tierRowIds(database, table, input.global ? sectionTipo : undefined);
	if (ids === null) {
		if (input.probedDatabases.get(database) !== false) {
			input.probedDatabases.set(database, false);
			scan.unreachable.push(database);
		}
		return;
	}
	input.probedDatabases.set(database, true);
	scan.examined.mariadb_rows += ids.length;
	const verdicts = await input.verdictOf(sectionTipo, ids);
	const held = new Set<number>();
	for (const id of ids) {
		held.add(id);
		const reason = ghostReason(verdicts.get(id));
		if (reason === null) continue;
		const ghost: PublicTierGhost = {
			store: 'mariadb',
			target: key,
			section_tipo: sectionTipo,
			section_id: id,
			reason,
		};
		if (input.global) ghost.global = true;
		scan.ghosts.push(ghost);
	}
	for (const id of await input.publishableOf()) {
		if (!held.has(id))
			scan.missing.push({ target: key, section_tipo: sectionTipo, section_id: id });
	}
}

function compareGhosts(a: PublicTierGhost, b: PublicTierGhost): number {
	return (
		a.store.localeCompare(b.store) ||
		a.target.localeCompare(b.target) ||
		a.section_tipo.localeCompare(b.section_tipo) ||
		a.section_id - b.section_id
	);
}

/** The element's `properties.diffusion.service_name`, or null (cached ontology accessor). */
async function elementServiceName(elementTipo: string): Promise<string | null> {
	const node = await getNode(elementTipo);
	const diffusion = (node?.properties as { diffusion?: { service_name?: unknown } } | null)
		?.diffusion;
	const service = diffusion?.service_name;
	return typeof service === 'string' && service !== '' ? service : null;
}

/**
 * APPLY: unpublish every ghost the scan found — nothing else. MISSING is
 * never repaired here (publishing is a job). Returns how many ghosts left the
 * tier; the ones that did not are reported in `failed`.
 *
 * Each publication TARGET is unpublished under its fence (SHARED — the lock a
 * publication run's batch holds exclusively, so a ghost never leaves while a
 * runner writes the target — `sql:<database>` for a MariaDB target and its
 * markers, `files:<type>/<service>` for a per-record file directory), targets
 * in sorted order. A ghost is never removed while an exclusive writer is inside
 * the same target. The apply waits for writers on ONE budget (`boundMs`,
 * default OPERATOR_FENCE_BOUND_MS) across every target: a runner's unit can
 * hold its target for as long as its target statement runs (R4), so a target
 * still held when the budget is spent is reported in `failed`, its ghosts left
 * for the next apply — never waited on.
 */
export async function unpublishGhosts(
	ghosts: readonly PublicTierGhost[],
	options: { boundMs?: number } = {},
): Promise<{ removed: number; failed: string[] }> {
	const outcome = { removed: 0, failed: [] as string[] };
	const deadline = Date.now() + (options.boundMs ?? OPERATOR_FENCE_BOUND_MS);
	const byTarget = new Map<string, PublicTierGhost[]>();
	for (const ghost of ghosts) {
		const lockKey = ghostLockKey(ghost);
		byTarget.set(lockKey, [...(byTarget.get(lockKey) ?? []), ghost]);
	}
	for (const lockKey of [...byTarget.keys()].sort()) {
		const group = byTarget.get(lockKey) as PublicTierGhost[];
		// SHARED (a delete-only door): excludes a writing runner, not a record delete.
		const fenced = await withTargetLock(lockKey, () => unpublishTargetGhosts(group, outcome), {
			mode: remainingFenceBudget(deadline),
			shared: true,
		});
		if (!fenced.acquired) {
			outcome.failed.push(
				`${lockKey}: publication target busy (held by a publication writer past the apply's wait) — ${group.length} ghost(s) left; re-run the reconcile`,
			);
		}
	}
	return outcome;
}

/** The fence key of the target a ghost lives in. */
function ghostLockKey(ghost: PublicTierGhost): string {
	if (ghost.store === 'file') {
		const separator = ghost.target.indexOf(':');
		return fileTargetLockKey(ghost.target.slice(0, separator), ghost.target.slice(separator + 1));
	}
	return sqlTargetLockKey(ghost.target.split('|')[0] as string);
}

/** One target's ghosts (inside its fence). */
async function unpublishTargetGhosts(
	ghosts: readonly PublicTierGhost[],
	outcome: { removed: number; failed: string[] },
): Promise<void> {
	// MariaDB rows: one executor call per (db|table, section), the record
	// delete's own executor — it also drops the markers of the ids it removes
	// (its own fence is re-entrant: this unit already holds the database).
	const rowsByTarget = new Map<string, { target: PublicTierGhost; ids: number[] }>();
	for (const ghost of ghosts) {
		if (ghost.store !== 'mariadb') continue;
		const key = `${ghost.target}#${ghost.section_tipo}#${ghost.global === true ? 'g' : 's'}`;
		const entry = rowsByTarget.get(key) ?? { target: ghost, ids: [] };
		entry.ids.push(ghost.section_id);
		rowsByTarget.set(key, entry);
	}
	for (const { target, ids } of rowsByTarget.values()) {
		const [database_name, table_name] = target.target.split('|') as [string, string];
		// A global row is keyed `<section_tipo>_<section_id>` and carries no
		// media markers (its source table holds them).
		const result = await executeSqlDeleteTargets([
			target.global === true
				? {
						database_name,
						table_name,
						section_ids: ids.map((id) => globalRowKey(target.section_tipo, id)),
					}
				: { database_name, table_name, section_ids: ids, section_tipo: target.section_tipo },
		]);
		if (result.deleted.includes(target.target)) outcome.removed += ids.length;
		else outcome.failed.push(...result.errors);
	}
	for (const ghost of ghosts) {
		try {
			if (ghost.store === 'marker') {
				const [database_name, table_name] = ghost.target.split('|') as [string, string];
				const applied = await applyTableState(
					database_name,
					table_name,
					ghost.section_tipo,
					[],
					[ghost.section_id],
				);
				if (applied.applied === 1) outcome.removed++;
				else
					outcome.failed.push(
						`marker ${ghost.target} ${ghost.section_tipo}_${ghost.section_id}: not applied`,
					);
			} else if (ghost.store === 'file' && ghost.path !== undefined) {
				await fs.unlink(ghost.path);
				outcome.removed++;
			}
		} catch (error) {
			outcome.failed.push(
				`${ghost.store} ${ghost.target} ${ghost.section_tipo}_${ghost.section_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** The registry-shaped run (dry by default). */
export async function runPublicTierReconcile(options: {
	apply: boolean;
	scope?: readonly string[];
}): Promise<ReconcileReport> {
	const scan = await scanPublicTier(options.scope);
	const drift = scan.ghosts.length + scan.missing.length;
	if (!options.apply) return { drift, applied: 0, detail: { ...scan } };
	const applied = await unpublishGhosts(scan.ghosts);
	return {
		drift,
		applied: applied.removed,
		detail: { ...scan, apply: applied },
	};
}
