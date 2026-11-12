/**
 * Published-language coherence audit + phantom-lang sweep for the MariaDB
 * publication targets (DIFFUSION_SPEC §4.3 — the repair half of the lang
 * policy).
 *
 * WHY THIS EXISTS AT ALL — the defect it repairs:
 * `DEDALO_DIFFUSION_LANGS` was read RAW and comma-split, while the v6→v7
 * config migration JSON-ENCODES the v6 PHP array. `["lg-spa","lg-cat"]` was
 * therefore shredded into the four "language codes" `["lg-spa`, `"lg-cat"]`,
 * … — and the publication plan builds ONE TARGET ROW PER POLICY LANG
 * (project/lang_ladder.ts:111-118), so those phantoms became real rows, with
 * real `lang` values, in the operator's published tables. The engine now
 * derives the set once (`config.diffusion`, src/config/config.ts) and refuses
 * a malformed policy at plan compile, which stops NEW breakage and nothing
 * else.
 *
 * WHY A BOOT CHECK CANNOT FIND THE ALREADY-BROKEN INSTALLS: after the fix a
 * migrated install's JSON array parses into perfectly VALID codes. Nothing is
 * malformed any more, so the boot-time verdict on the CONFIG is silent
 * exactly for the population that was damaged. The only honest detection
 * compares the POLICY against what is actually PUBLISHED — this module.
 *
 * WHY A REPUBLISH IS NOT THE REPAIR: publication is
 * `INSERT … ON DUPLICATE KEY UPDATE` on the composite key (section_id, lang)
 * (sql_generator.ts:203-205/316-345). A republish UPDATES the rows the policy
 * names and NEVER TOUCHES a row whose lang the policy no longer contains, so
 * the publication API keeps serving the garbage until it is swept. Removal is
 * the only repair, and removal of published data is an EXPLICIT, operator-
 * triggered act: nothing here runs on its own, and the sweep deletes only
 * lang values the caller enumerated after seeing them counted.
 *
 * ⚠️ A PUBLICATION DATABASE IS SHARED GROUND (2026-08-23 repair). The target
 * schema commonly also holds a CMS, a translations table, or a colleague's
 * working table — anything of which may carry a column called `lang`. So
 * "has a lang column" is NOT a diffusion marker and this module never treats
 * it as one: a table is swept only when it is POSITIVELY IDENTIFIED as
 * diffusion-created, by BOTH
 *   (1) the exact table anatomy the generator emits — a PRIMARY KEY of
 *       exactly two columns, `section_id` then `lang`, in that order
 *       (sql_generator.ts generateCreateTable), AND
 *   (2) a table name the install's own diffusion MAP declares (a `table` /
 *       `table_alias` node label, put through the same requireSqlIdentifier
 *       chokepoint the publish path uses).
 * Anything else is counted in `unmarked_tables` and left strictly alone. When
 * in doubt this module SKIPS a table; it never guesses. Gate:
 * test/unit/diffusion_lang_sweep_native.test.ts.
 *
 * Cost posture: `lang` is the SECOND column of the composite primary key, so
 * "which langs are published" is a full index scan — cheap enough for an
 * operator action, not something to run unbounded behind a dashboard read.
 * Every statement therefore carries an explicit `max_statement_time` budget
 * (MariaDB 10.1+; the server kills the query rather than the client
 * abandoning a still-running one) and the caller declares how many tables it
 * is willing to scan. A budget that runs out is REPORTED (`complete:false`,
 * `skipped_tables`), never quietly dropped.
 */

import { config } from '../../../config/config.ts';
import {
	boundSqlTargetStatement,
	OPERATOR_FENCE_BOUND_MS,
	remainingFenceBudget,
	sqlTargetLockKey,
	type TargetLockMode,
	type TargetLockOutcome,
	withTargetLock,
} from '../../../core/diffusion_bridge/target_lock.ts';
import { DedaloError } from '../../../core/errors/index.ts';
import { globalTableMapsOfNode, globalTableNamesOf } from '../../plan/global_tables.ts';
import { escapeSqlIdentifier, requireSqlIdentifier } from '../../plan/identifier.ts';
import { buildVirtualDiffusionTree } from '../../plan/virtual_tree.ts';
import {
	getTargetPool,
	isMissingDatabaseError,
	isMissingTableError,
	type MariadbExecResult,
} from './db.ts';

/** One published lang value and how many target rows carry it. */
export interface PublishedLang {
	lang: string;
	rows: number;
}

/** Per-table audit result. `error` set ⇒ this table was not measured. */
export interface TableLangAudit {
	table: string;
	/** Every non-NULL lang value present, with its row count. */
	published: PublishedLang[];
	/** The subset of `published` that the current policy does not name. */
	phantom: PublishedLang[];
	/**
	 * Rows whose lang IS NULL. Reported, NEVER swept: a NULL lang is what the
	 * projector writes when the policy is empty (lang_ladder.ts:101-108) — a
	 * legitimate lang-less publication, not a phantom code.
	 */
	null_lang_rows: number;
	error?: string;
}

/** Per-target-database audit result. */
export interface DatabaseLangAudit {
	database: string;
	/** false ⇒ unreachable/ungranted; `tables` is empty and `errors` says why. */
	reachable: boolean;
	tables: TableLangAudit[];
	/** Union of every table's phantom lang values, in first-seen order. */
	phantom_langs: string[];
	/** Total rows carrying a phantom lang across this database. */
	phantom_rows: number;
	/**
	 * Tables of this schema that carry a `lang` column but are NOT positively
	 * identified as diffusion-created (see the header). They are never read
	 * and never swept — the number is here so the narrowing is VISIBLE to the
	 * operator instead of silent.
	 */
	unmarked_tables: number;
	errors: string[];
}

/** The whole coherence verdict — what the widget row and the dry-run both read. */
export interface LangCoherenceReport {
	/**
	 * false ⇒ this install publishes to no MariaDB database (the common case).
	 * `reason` says so in one sentence; every other field is empty. NOT an
	 * error: "no target" is a healthy answer, and the caller must render it as
	 * "not applicable" rather than as a failed probe.
	 */
	applicable: boolean;
	reason: string | null;
	/** The policy the published rows are compared against (config.diffusion.langs). */
	policy: string[];
	databases: DatabaseLangAudit[];
	/** Union across every database — the one number an operator acts on. */
	phantom_langs: string[];
	phantom_rows: number;
	/** false ⇒ the table budget ran out; `skipped_tables` counts what went unseen. */
	complete: boolean;
	skipped_tables: number;
	/** Sum of every database's `unmarked_tables` — foreign ground, left alone. */
	unmarked_tables: number;
	errors: string[];
}

/** What one sweep removed, per (database, table, lang). */
export interface SweptLang {
	database: string;
	table: string;
	lang: string;
	rows: number;
}

export interface LangSweepResult {
	policy: string[];
	requested_langs: string[];
	swept: SweptLang[];
	total_rows: number;
	errors: string[];
	/**
	 * The operator's remaining step, stated in the result rather than only in
	 * the docs — see the media-marker note on sweepPhantomLangs.
	 */
	next_step: string;
}

/**
 * Scan budget. The defaults are the OPERATOR-ACTION budget; the dashboard
 * passes a tighter one (a widget read must never sit on a long scan).
 */
export interface LangAuditBudget {
	/** Server-side ceiling per statement, seconds (MariaDB max_statement_time). */
	statementSeconds: number;
	/** How many tables this call may scan before reporting `complete:false`. */
	maxTables: number;
}

export const OPERATOR_AUDIT_BUDGET: LangAuditBudget = { statementSeconds: 30, maxTables: 500 };
export const WIDGET_AUDIT_BUDGET: LangAuditBudget = { statementSeconds: 2, maxTables: 25 };

/** Rows deleted per statement — a sweep never opens one unbounded transaction. */
const SWEEP_DELETE_CHUNK = 5000;
/** Safety stop for the chunked delete loop (chunk × iterations = 25M rows). */
const SWEEP_MAX_ITERATIONS = 5000;

/**
 * The narrow slice of a target pool this module uses. Declared as an interface
 * (rather than taking `SQL`) so the discovery/decision logic can be gated
 * without a live MariaDB: the tests inject a fake through
 * `LangSweepDependencies`. No module-level mutable state — the seam is a
 * parameter with a frozen default, never a settable singleton.
 */
export interface MariadbQueryable {
	unsafe(sql: string, params?: unknown[]): PromiseLike<unknown>;
}

/** Everything this module reaches for outside itself. Injectable, all of it. */
export interface LangSweepDependencies {
	/** Pool for one target database. */
	getPool: (database: string) => MariadbQueryable;
	/** The MariaDB databases the diffusion map addresses. */
	listTargetDatabases: () => Promise<{ databases: string[]; invalid: string[] }>;
	/** Lower-cased table names the diffusion map declares (positive id, part 2). */
	listDeclaredTables: () => Promise<Set<string>>;
	/** The publication language policy the published rows are judged against. */
	policyLangs: () => string[];
	/**
	 * Run one database's sweep under its publication-target fence, waiting for
	 * a writer at most `mode`. Default: the lock a publication run's batch holds
	 * (jobs/target_fence.ts), taken exclusively.
	 */
	fenceDatabase?: (
		database: string,
		work: () => Promise<void>,
		mode: TargetLockMode,
	) => Promise<TargetLockOutcome<void>>;
}

/** The default database fence: the publication-target lock (DIFF-2), within the sweep's budget. */
function fenceDatabase(
	database: string,
	work: () => Promise<void>,
	mode: TargetLockMode,
): Promise<TargetLockOutcome<void>> {
	return withTargetLock(sqlTargetLockKey(database), work, { mode });
}

/**
 * Wrap a read in MariaDB's own statement timeout. The server aborts the query
 * at the budget instead of the client abandoning a still-running scan — the
 * distinction matters here because the abandoned one keeps burning the target
 * server's IO long after the panel gave up. `SET STATEMENT … FOR` is MariaDB
 * 10.1+ (2015); an older server answers with a syntax error, which surfaces as
 * this table's `error` string rather than as a hang.
 */
function withStatementBudget(sql: string, seconds: number): string {
	return `SET STATEMENT max_statement_time=${Number(seconds)} FOR ${sql}`;
}

/** Human-readable driver detail (never the raw object into a report string). */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The MariaDB databases this install publishes into, as the PLAN addresses
 * them. `database` / `database_alias` nodes exist for exactly that purpose
 * (getDatabaseNameForElement reads their label), and the label is put through
 * the SAME requireSqlIdentifier chokepoint the publish path uses — probing the
 * raw label would address a DIFFERENT database than the one written to (the
 * `Web MDCAT` → `web_mdcat` drift documented in api/info.ts).
 *
 * A label that cannot yield an identifier is DROPPED here and named in
 * `invalid`: it can hold no published rows, because nothing could ever have
 * been written to it.
 */
export async function listMariadbTargetDatabases(): Promise<{
	databases: string[];
	invalid: string[];
}> {
	const tree = await buildVirtualDiffusionTree();
	if (tree === null) return { databases: [], invalid: [] };
	const databases: string[] = [];
	const invalid: string[] = [];
	for (const node of tree.nodes) {
		if (node.model !== 'database' && node.model !== 'database_alias') continue;
		if (node.label === null || node.label === '') continue;
		try {
			const name = requireSqlIdentifier(node.label, 'database');
			if (!databases.includes(name)) databases.push(name);
		} catch (_error) {
			if (!invalid.includes(node.label)) invalid.push(node.label);
		}
	}
	return { databases, invalid };
}

/**
 * The table names the diffusion MAP declares — `table` / `table_alias` node
 * labels through the same requireSqlIdentifier chokepoint compileSectionPlan
 * uses to derive `SectionPlan.tableName`, so this set is exactly the set of
 * names the publish path can ever CREATE. Lower-cased: MariaDB compares table
 * names case-insensitively on the platforms this ships to, and a case
 * mismatch must not silently exclude a real published table.
 *
 * Read from the map, never from the target server: an empty set means this
 * install declares no published table, and therefore that nothing here may be
 * deleted.
 */
export async function listDeclaredPublicationTables(): Promise<Set<string>> {
	const tree = await buildVirtualDiffusionTree();
	const declared = new Set<string>();
	if (tree === null) return declared;
	for (const node of tree.nodes) {
		if (node.model !== 'table' && node.model !== 'table_alias') continue;
		if (node.label === null || node.label === '') continue;
		try {
			declared.add(requireSqlIdentifier(node.label, 'table').toLowerCase());
		} catch (_error) {
			// A label that yields no identifier names no real table (nothing could
			// have been created under it) — dropping it can hide no published data.
		}
		// The GLOBAL tables its maps write (plan/global_tables.ts): a global node
		// may live outside this domain's subtree and still hold its rows.
		const maps = await globalTableMapsOfNode(tree.index, node);
		for (const name of await globalTableNamesOf(tree.index, maps)) {
			declared.add(name.toLowerCase());
		}
	}
	return declared;
}

/** The real wiring. A frozen const: injectable, but never mutable at runtime. */
export const DEFAULT_LANG_SWEEP_DEPENDENCIES: LangSweepDependencies = Object.freeze({
	// The target as the sweep sees it: every statement lock-wait bounded
	// (boundSqlTargetStatement, merged into a read's own max_statement_time) —
	// the DELETE chunks run under the database's EXCLUSIVE fence, and a row or
	// metadata lock another session holds must fail a chunk into `errors`, not
	// keep the fence (and the operator's request) waiting.
	getPool: (database: string): MariadbQueryable => {
		const pool = getTargetPool(database);
		return { unsafe: (sql, params = []) => pool.unsafe(boundSqlTargetStatement(sql), params) };
	},
	listTargetDatabases: listMariadbTargetDatabases,
	listDeclaredTables: listDeclaredPublicationTables,
	policyLangs: (): string[] => [...config.diffusion.langs],
});

/**
 * Positive identification, part 1 — the generator's exact table anatomy:
 * PRIMARY KEY (section_id, lang) and NOTHING ELSE in that key
 * (sql_generator.ts generateCreateTable). Read off INFORMATION_SCHEMA.STATISTICS,
 * which lists one row per key column: a two-column PRIMARY whose SEQ_IN_INDEX
 * 1 is `section_id` and 2 is `lang`.
 *
 * A CMS/translations/working table that merely HAS a `lang` column does not
 * match, which is the entire point (see the header's shared-ground warning).
 */
export const PUBLISHED_TABLE_MARKER_SQL =
	'SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.STATISTICS ' +
	"WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY' " +
	'GROUP BY TABLE_NAME ' +
	'HAVING COUNT(*) = 2 ' +
	"AND LOWER(MAX(CASE WHEN SEQ_IN_INDEX = 1 THEN COLUMN_NAME END)) = 'section_id' " +
	"AND LOWER(MAX(CASE WHEN SEQ_IN_INDEX = 2 THEN COLUMN_NAME END)) = 'lang' " +
	'ORDER BY TABLE_NAME';

/** How many tables of a schema carry a `lang` column at all (honesty counter). */
export const LANG_COLUMN_TABLE_COUNT_SQL =
	'SELECT COUNT(DISTINCT TABLE_NAME) AS n FROM INFORMATION_SCHEMA.COLUMNS ' +
	"WHERE TABLE_SCHEMA = ? AND LOWER(COLUMN_NAME) = 'lang'";

function rowTableName(row: { table_name?: string; TABLE_NAME?: string }): string {
	return row.table_name ?? row.TABLE_NAME ?? '';
}

/** Result of discovery: what may be touched, and how much was left alone. */
export interface PublishedTableDiscovery {
	/** Tables positively identified as diffusion-created. The ONLY sweepable set. */
	tables: string[];
	/** Tables with a `lang` column that failed identification — never touched. */
	unmarked: number;
}

/**
 * Published tables of one target database: the intersection of the marker
 * anatomy (PUBLISHED_TABLE_MARKER_SQL) and the names the diffusion map
 * declares. BOTH are required — one alone is a heuristic, and a heuristic here
 * deletes a stranger's data.
 */
export async function discoverPublishedTables(
	database: string,
	budget: LangAuditBudget,
	dependencies: LangSweepDependencies = DEFAULT_LANG_SWEEP_DEPENDENCIES,
): Promise<PublishedTableDiscovery> {
	const pool = dependencies.getPool(database);
	const markerRows = (await pool.unsafe(
		withStatementBudget(PUBLISHED_TABLE_MARKER_SQL, budget.statementSeconds),
		[database],
	)) as { table_name?: string; TABLE_NAME?: string }[];
	const declared = await dependencies.listDeclaredTables();
	const tables = markerRows
		.map(rowTableName)
		.filter((name) => name !== '' && declared.has(name.toLowerCase()));

	let langColumnTables = tables.length;
	try {
		const countRows = (await pool.unsafe(
			withStatementBudget(LANG_COLUMN_TABLE_COUNT_SQL, budget.statementSeconds),
			[database],
		)) as { n?: number | string }[];
		langColumnTables = Number(countRows[0]?.n ?? tables.length) || 0;
	} catch (_error) {
		// The counter is REPORTING only: a schema that will not answer it still
		// gets a correct (narrower) sweepable set from the marker read above.
		langColumnTables = tables.length;
	}
	return { tables, unmarked: Math.max(0, langColumnTables - tables.length) };
}

/** `SELECT lang, COUNT(*)` for one published table, under the statement budget. */
async function auditTable(
	database: string,
	table: string,
	policy: Set<string>,
	budget: LangAuditBudget,
	dependencies: LangSweepDependencies,
): Promise<TableLangAudit> {
	const audit: TableLangAudit = { table, published: [], phantom: [], null_lang_rows: 0 };
	try {
		const pool = dependencies.getPool(database);
		const rows = (await pool.unsafe(
			withStatementBudget(
				`SELECT lang, COUNT(*) AS n FROM ${escapeSqlIdentifier(table)} GROUP BY lang`,
				budget.statementSeconds,
			),
			[],
		)) as { lang: string | null; n: number | string }[];
		for (const row of rows) {
			const count = Number(row.n) || 0;
			if (row.lang === null) {
				audit.null_lang_rows += count;
				continue;
			}
			const entry: PublishedLang = { lang: row.lang, rows: count };
			audit.published.push(entry);
			if (!policy.has(row.lang)) audit.phantom.push(entry);
		}
	} catch (error) {
		// A table that vanished between the INFORMATION_SCHEMA read and this
		// statement holds nothing to sweep — the same idempotent tolerance the
		// delete path applies (delete_record.ts). Anything else is reported.
		if (!isMissingTableError(error)) {
			audit.error = errorText(error);
		}
	}
	return audit;
}

/**
 * THE DETECTION: compare `config.diffusion.langs` against the langs actually
 * present in the publication targets, and name every published lang the policy
 * does not contain.
 *
 * NEVER THROWS on a target-side failure — an unreachable database is a
 * reported verdict, not an exception, because both callers (a dashboard row
 * and a dry-run) must still render the rest. The policy itself is read from
 * config, never from the caller: an audit against a lang set the caller
 * supplied would answer a question nobody asked.
 */
export async function auditPublishedLangs(
	budget: LangAuditBudget = OPERATOR_AUDIT_BUDGET,
	dependencies: LangSweepDependencies = DEFAULT_LANG_SWEEP_DEPENDENCIES,
): Promise<LangCoherenceReport> {
	const policy = dependencies.policyLangs();
	const policySet = new Set(policy);
	const report: LangCoherenceReport = {
		applicable: false,
		reason: null,
		policy,
		databases: [],
		phantom_langs: [],
		phantom_rows: 0,
		complete: true,
		skipped_tables: 0,
		unmarked_tables: 0,
		errors: [],
	};

	let targets: { databases: string[]; invalid: string[] };
	try {
		targets = await dependencies.listTargetDatabases();
	} catch (error) {
		// The ontology read failed — say so instead of reporting "no targets",
		// which would read as a clean bill of health.
		report.reason = `diffusion map unreadable: ${errorText(error)}`;
		report.errors.push(report.reason);
		return report;
	}
	for (const label of targets.invalid) {
		report.errors.push(`database label '${label}' is not a usable SQL identifier`);
	}
	if (targets.databases.length === 0) {
		report.reason = 'no MariaDB publication target is configured';
		return report;
	}
	report.applicable = true;

	let tableBudget = budget.maxTables;
	for (const database of targets.databases) {
		const entry: DatabaseLangAudit = {
			database,
			reachable: true,
			tables: [],
			phantom_langs: [],
			phantom_rows: 0,
			unmarked_tables: 0,
			errors: [],
		};
		report.databases.push(entry);
		let discovery: PublishedTableDiscovery;
		try {
			discovery = await discoverPublishedTables(database, budget, dependencies);
		} catch (error) {
			entry.reachable = !isMissingDatabaseError(error);
			entry.errors.push(errorText(error));
			continue;
		}
		entry.unmarked_tables = discovery.unmarked;
		report.unmarked_tables += discovery.unmarked;
		for (const table of discovery.tables) {
			if (tableBudget <= 0) {
				report.complete = false;
				report.skipped_tables += 1;
				continue;
			}
			tableBudget -= 1;
			const tableAudit = await auditTable(database, table, policySet, budget, dependencies);
			entry.tables.push(tableAudit);
			if (tableAudit.error !== undefined) {
				entry.errors.push(`${table}: ${tableAudit.error}`);
			}
			for (const phantom of tableAudit.phantom) {
				entry.phantom_rows += phantom.rows;
				if (!entry.phantom_langs.includes(phantom.lang)) entry.phantom_langs.push(phantom.lang);
			}
		}
		report.phantom_rows += entry.phantom_rows;
		for (const lang of entry.phantom_langs) {
			if (!report.phantom_langs.includes(lang)) report.phantom_langs.push(lang);
		}
		for (const message of entry.errors) report.errors.push(`${database}: ${message}`);
	}
	return report;
}

/**
 * The caller's lang list, validated into the ONLY list a sweep may act on.
 * PURE and exported so every refusal is gated without a target server.
 *
 * Refusals, all loud (`request.invalid_options`), because each one is a caller
 * bug that would otherwise become a silent deletion or a silent no-op:
 *  - a non-array, or ANY element that is not a string (a filtered-out element
 *    would make the sweep act on a list the caller never approved);
 *  - an empty or whitespace-only lang ('' matches no published row on MariaDB's
 *    padded comparison rules only by accident — a caller asking to delete "the
 *    empty language" has lost track of what it read in the report);
 *  - an empty list (a sweep with no target is a caller bug, never a no-op
 *    "success");
 *  - a lang that IS in the current policy (that is live published data — the
 *    whole point of the sweep is that it removes ONLY what the policy dropped).
 */
export function normalizeSweepLangs(langs: unknown, policy: readonly string[]): string[] {
	if (!Array.isArray(langs)) {
		throw new DedaloError('request.invalid_options', {
			message: 'sweep_published_langs requires options.langs to be an array of language codes',
			publicMessage: 'The languages to remove must be given as a list',
		});
	}
	const requested: string[] = [];
	for (const item of langs) {
		if (typeof item !== 'string' || item.trim() === '') {
			throw new DedaloError('request.invalid_options', {
				message: `sweep_published_langs: every entry of options.langs must be a non-empty language code (got ${JSON.stringify(item)})`,
				publicMessage: 'Every language to remove must be a non-empty code',
			});
		}
		if (!requested.includes(item)) requested.push(item);
	}
	if (requested.length === 0) {
		throw new DedaloError('request.invalid_options', {
			message: 'sweep_published_langs requires at least one lang to remove',
			publicMessage: 'At least one language must be named for removal',
		});
	}
	const protectedLangs = requested.filter((lang) => policy.includes(lang));
	if (protectedLangs.length > 0) {
		throw new DedaloError('request.invalid_options', {
			message: `refusing to sweep languages that ARE in the publication policy: ${protectedLangs.join(', ')}`,
			publicMessage: `Refused: ${protectedLangs.join(', ')} ${protectedLangs.length === 1 ? 'is' : 'are'} in the current publication policy`,
			coordinates: { langs: protectedLangs.join(',') },
		});
	}
	return requested;
}

/**
 * THE REPAIR: delete the rows carrying the named lang values.
 *
 * Deliberately NOT `DELETE … WHERE lang NOT IN (policy)`. The operator acts on
 * a dry-run they READ, and the predicate must be the same one they read: an
 * enumerated `lang IN (…)` can only remove values that were counted and shown,
 * while a NOT IN would also catch whatever appeared between the audit and the
 * sweep — including a lang added to the policy in between, whose rows are the
 * newest and most correct data in the table.
 *
 * FOUR NARROWINGS, in order, each of which can only ever delete LESS:
 *  1. normalizeSweepLangs — the list itself (see its refusals);
 *  2. discoverPublishedTables — only positively identified diffusion tables
 *     (the header's shared-ground warning; a foreign table with a `lang`
 *     column is never even read);
 *  3. a database the diffusion map does not name is REFUSED (the caller may
 *     pass a subset to scope the run, never a name of its own);
 *  4. a per-table re-audit immediately before the delete: the statement runs
 *     only for a lang this table actually holds AND that the audit classified
 *     as phantom, so a policy lang cannot be deleted even if the policy
 *     changed between the caller's report and this call.
 *
 * MEDIA MARKERS ARE DELIBERATELY NOT TOUCHED. A `.publication/` marker is
 * keyed by (database, table, section_id) and says nothing about langs, so the
 * phantom rows of a record that is still published correctly share the marker
 * with its policy-lang rows — dropping it here would unpublish live media. The
 * honest order is: fix the policy, REPUBLISH (which rewrites rows and markers
 * for the section ids that belong), then sweep what the policy no longer
 * names, and run the existing `rebuild_media_index` action if any record left
 * the published set entirely. `next_step` carries that sentence to the caller.
 */
export async function sweepPhantomLangs(
	options: {
		langs: unknown;
		/** Restrict the sweep to these target databases; omit for all of them. */
		databases?: string[];
		/**
		 * How long the WHOLE sweep waits for databases a publication writer
		 * holds (ms), one budget across every database; default
		 * OPERATOR_FENCE_BOUND_MS. A database still held when it is spent is
		 * reported in `errors` and left untouched.
		 */
		boundMs?: number;
	},
	dependencies: LangSweepDependencies = DEFAULT_LANG_SWEEP_DEPENDENCIES,
): Promise<LangSweepResult> {
	const policy = dependencies.policyLangs();
	const requested = normalizeSweepLangs(options.langs, policy);
	const policySet = new Set(policy);
	const result: LangSweepResult = {
		policy,
		requested_langs: requested,
		swept: [],
		total_rows: 0,
		errors: [],
		next_step:
			'Republish the affected elements, then run rebuild_media_index if any record ' +
			'left the published set — this sweep removes rows only, never media markers.',
	};

	const targets = await dependencies.listTargetDatabases();
	const scope =
		options.databases === undefined
			? targets.databases
			: targets.databases.filter((name) => options.databases?.includes(name));
	if (options.databases !== undefined) {
		for (const name of options.databases) {
			if (!targets.databases.includes(name)) {
				throw new DedaloError('request.invalid_options', {
					message: `'${name}' is not a MariaDB publication target of this install`,
					publicMessage: 'Unknown publication target database',
					coordinates: { database: name },
				});
			}
		}
	}

	// Each database under its publication-target fence (DIFF-2): a sweep never
	// deletes rows while a publication run is writing the same database. The
	// operator's request waits for writers on ONE budget: a runner's unit can
	// hold its database for as long as its target statement runs (R4), so a
	// database still held when the budget is spent is REPORTED, never waited on.
	const fence = dependencies.fenceDatabase ?? fenceDatabase;
	const deadline = Date.now() + (options.boundMs ?? OPERATOR_FENCE_BOUND_MS);
	for (const database of scope) {
		const fenced = await fence(
			database,
			() => sweepDatabase(database, requested, policySet, result, dependencies),
			remainingFenceBudget(deadline),
		);
		if (!fenced.acquired) {
			result.errors.push(
				`${database}: publication target busy (${fenced.busyKey} held by a publication writer past the sweep's wait) — nothing swept here; re-run the sweep`,
			);
		}
	}
	return result;
}

/** One database's phantom-lang sweep (inside its fence). */
async function sweepDatabase(
	database: string,
	requested: readonly string[],
	policySet: Set<string>,
	result: LangSweepResult,
	dependencies: LangSweepDependencies,
): Promise<void> {
	let discovery: PublishedTableDiscovery;
	try {
		discovery = await discoverPublishedTables(database, OPERATOR_AUDIT_BUDGET, dependencies);
	} catch (error) {
		result.errors.push(`${database}: ${errorText(error)}`);
		return;
	}
	const pool = dependencies.getPool(database);
	for (const table of discovery.tables) {
		// Narrowing 4: what this table ACTUALLY holds, judged against the
		// policy one more time. A lang the table does not carry, or that the
		// policy (re-)acquired, never reaches a DELETE.
		const before = await auditTable(
			database,
			table,
			policySet,
			OPERATOR_AUDIT_BUDGET,
			dependencies,
		);
		if (before.error !== undefined) {
			result.errors.push(`${database}.${table}: ${before.error}`);
			continue;
		}
		const deletable = before.phantom
			.map((entry) => entry.lang)
			.filter((lang) => requested.includes(lang));
		for (const lang of deletable) {
			let removed = 0;
			try {
				// Chunked so one sweep never becomes a single multi-million-row
				// transaction on the operator's live publication server.
				//
				// `BINARY lang = ?` — the byte-exact half is LOAD-BEARING, not belt and
				// braces. Classification above is an exact JS string compare, but a bare
				// `lang = ?` compares under the TABLE's collation, which on a stock
				// MariaDB is case-insensitive and PAD SPACE. So a published `lg-spa `
				// (trailing space) or `LG-SPA` is phantom to us while its DELETE would
				// ALSO match the real `lg-spa` rows — the sweep would destroy the
				// translations it exists to protect. Comparing on the same terms as the
				// classification closes that gap. The plain `lang = ?` stays alongside it
				// so the index seek is preserved; BINARY alone would force a scan.
				for (let iteration = 0; iteration < SWEEP_MAX_ITERATIONS; iteration++) {
					const outcome = (await pool.unsafe(
						`DELETE FROM ${escapeSqlIdentifier(table)} WHERE lang = ? AND BINARY lang = ? LIMIT ${SWEEP_DELETE_CHUNK}`,
						[lang, lang],
					)) as MariadbExecResult;
					const affected = outcome?.affectedRows ?? 0;
					removed += affected;
					if (affected < SWEEP_DELETE_CHUNK) break;
				}
			} catch (error) {
				if (isMissingTableError(error) || isMissingDatabaseError(error)) continue;
				result.errors.push(`${database}.${table} [${lang}]: ${errorText(error)}`);
				continue;
			}
			if (removed === 0) continue;
			result.swept.push({ database, table, lang, rows: removed });
			result.total_rows += removed;
		}
	}
}
