/**
 * SQL-CONFINEMENT TRIPWIRE — mechanical enforcement of the TIERED SQL rule
 * (DEC-09 / audit S2-18, S2-19; README.md "Hard rules").
 *
 * The old absolute ("all SQL lives behind src/core/db/") was dead as written:
 * the audit census found 76 files legitimately authoring SQL. Its enforceable
 * successor is tiered, and THIS file is the tripwire the old rule never had:
 *
 *   T1  Connection ownership: `new SQL(` exists ONLY in core/db/postgres.ts
 *       plus the two sanctioned separate pools (RAG pgvector DB, MariaDB
 *       diffusion target). Everything else uses the exported `sql` proxy /
 *       tx helpers — which is what makes parameterization and pool lifecycle
 *       structurally uniform.
 *   T2  matrix_* / dd_ontology DML lives in the src/core/db WRITER HOMES — one
 *       per table FAMILY, each pinned to its own family (matrix_write.ts: the
 *       record tables + matrix_updates; time_machine.ts: matrix_time_machine;
 *       dd_ontology.ts: dd_ontology*; db_assets.ts: the derived search stores).
 *       Every DML site anywhere else is an ENUMERATED shrink-only entry with
 *       its exact write count and a reason; the psql/runPsql channel (DML
 *       text, stdin SQL, `-f` restores) is enumerated the same way with its
 *       encoding guarantee; the counter tables are owned by
 *       matrix_counter_monotonic_tripwire (same corpus, stricter law) and
 *       carved out here BY NAME. Plus the P0-3 rule: outside matrix_write.ts
 *       no file pairs an UNLOCKED read of a matrix jsonb column with an UPDATE
 *       that binds a jsonb value into one (the lost-update shape).
 *       Interpolated targets are FAIL-CLOSED: `${x}` counts as a matrix table
 *       unless it resolves to a string literal (same file / one import hop).
 *       Matching is POSTGRES-SHAPED, not a spelling: verbs and unquoted
 *       identifiers fold (case), `ONLY` and a schema qualifier
 *       (`public.matrix_test`, `"public"."matrix_test"`) name the same
 *       table, MERGE INTO and a server-side `COPY … FROM` are DML verbs, and
 *       a statement split across literals (`'UPDATE ' + t`, `'UPDATE' + ' matrix_test SET …'`,
 *       `${verb} matrix_test SET …`) is a site on either half, and SQL
 *       comments (`-- …`, block) between verb and target are stripped from
 *       every literal before matching. Residual limit, stated: a statement
 *       assembled from parts none of which carries a verb next to its target
 *       (`['UPDATE', 'matrix_test', 'SET …'].join(' ')`, `sql.unsafe(buildQuery())`)
 *       is outside any literal scanner — the corpus has no such shape (grep).
 *   T3  dd_ontology reads through core/ontology accessors (resolver.ts et
 *       al.), enforced as a RATCHET: the set of files still querying
 *       dd_ontology directly may only SHRINK. New code must use the
 *       resolver shapes (getNode / getOrderedSubtree / getChildrenNodes /
 *       getPropertiesByTipo / findFirstDescendantTipoByModel).
 *   T4  Named subsystem-owned tables keep local SQL — one owning module per
 *       table family, listed below; referencing those tables anywhere else
 *       fails.
 *
 * HONESTY CONTRACT: every list below is exact-file. Adding a violation makes
 * this suite FAIL (verified by temporary-violation probe at introduction);
 * removing one leaves a stale allowlist entry, which is safe (ratchet down
 * opportunistically). If a file on a list is MOVED (e.g. the WS-C resolve/
 * re-homing), update the entry in the same change.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { MATRIX_JSONB_COLUMNS } from '../../src/core/db/matrix.ts';
import {
	clearOntologyCaches,
	compareSiblingOrder,
	findFirstDescendantTipoByModel,
	getChildrenNodes,
	getOrderedSubtree,
	getPropertiesByTipo,
} from '../../src/core/ontology/resolver.ts';
import {
	extractSourceLiterals,
	normalizeSqlLiteral,
	type SourceLiteral,
} from '../helpers/sql_literals.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

/**
 * THE census corpus: src/ + tools/ + scripts/, shared with the other write-path
 * gates (test/helpers/write_path_corpus.ts) so the roots cannot drift per gate.
 * scripts/ joined 2026-09-02 (P2-20/S-3): a one-off migration script queries
 * dd_ontology and rewrites matrix jsonb exactly like engine code does.
 */
const sourceFiles = writePathSourceFiles;

describe('census corpus', () => {
	test('the shared write-path corpus is populated and includes scripts/', () => {
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		expect(files).toContain('scripts/migrate_section_id_locators.ts');
	});
});

function read(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf-8');
}

// ---------------------------------------------------------------------------
// T1 — connection ownership: `new SQL(` allowlist.
// ---------------------------------------------------------------------------

/**
 * The ONLY files allowed to construct a Bun SQL pool. Two sanctioned separate
 * pools exist by design: the RAG vector store (a SEPARATE pgvector database)
 * and the MariaDB diffusion target (a different DBMS entirely).
 */
const NEW_SQL_ALLOWLIST = new Set<string>([
	'src/core/db/postgres.ts', // THE system-of-record pool
	'src/ai/rag/vector_store.ts', // sanctioned: separate pgvector DB
	'src/diffusion/targets/mariadb/db.ts', // sanctioned: MariaDB publication target
]);

describe('T1 — Postgres connection ownership', () => {
	test('`new SQL(` appears only in the sanctioned pool owners', () => {
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			if (!read(file).includes('new SQL(')) continue;
			if (NEW_SQL_ALLOWLIST.has(file)) continue;
			// The rest of targets/mariadb/ may grow helpers around its pool file.
			if (file.startsWith('src/diffusion/targets/mariadb/')) continue;
			violations.push(file);
		}
		expect(
			violations,
			`Unsanctioned SQL pool construction. Use the exported proxy/tx helpers from src/core/db/postgres.ts (or, for a genuinely separate datastore, add the file here WITH justification): ${violations.join(', ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// T2 — matrix DML confinement: one writer per table family.
//
// DESIGN. "One writer" is per TABLE FAMILY inside src/core/db/, not one file
// for everything: moving the Time Machine, ontology and derived-store SQL into
// matrix_write.ts would buy no invariant (each family has its own column
// contract) and would erase the module boundaries the families exist for. Each
// home is PINNED to its family below, so a home cannot quietly become a second
// writer of another family's tables.
//
// COUNTER CARVE-OUT. matrix_counter / matrix_counter_dd (and the `${counterTable}`
// door) are censused TOTAL — same corpus — by matrix_counter_monotonic_tripwire
// under a stricter (GREATEST-shape) law that pins its own writer set; owning
// them twice would force every counter change to re-pin two gates. They are
// carved out here BY NAME, with the same textual rule that gate uses.
//
// FAIL-CLOSED TARGETS. `INSERT INTO ${x}` resolves `x` to a string literal
// (same-file `const x = '…'` or one import hop to an `export const`). A target
// that resolves to a non-matrix name is out of scope; one that does NOT resolve
// COUNTS AS MATRIX and must either be resolved or enumerated. The MariaDB
// diffusion target directory is out by construction (its own DBMS, T1-sanctioned
// pool): its `${escapeSqlIdentifier(…)}` targets are publication tables.
// ---------------------------------------------------------------------------

/**
 * The DML verbs of the census — every statement that changes rows. Postgres
 * keywords and unquoted identifiers are CASE-INSENSITIVE (`update matrix_test`
 * is the same statement as `UPDATE matrix_test`), so every matcher here is
 * `i` and a matched unquoted name is folded to lowercase before it is
 * compared — a scanner that matched one spelling would be a style check.
 */
const T2_DML_VERB = String.raw`(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|(?<!\\)COPY)`;
/**
 * A target, read the way Postgres does: an optional `ONLY`, an optional
 * schema qualifier (`public.matrix_test`, `"public"."matrix_test"` — the
 * search_path makes them the same table), then the name: a matrix/dd_ontology
 * name, an interpolation, or any other identifier. The schema group is greedy
 * and the name alternative accepts any identifier, so `public.matrix_test`
 * always binds `public` as schema and `matrix_test` as the name.
 */
const T2_DML_SCHEMA = String.raw`(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?`;
const T2_DML_TARGET = String.raw`(?:ONLY\s+)?${T2_DML_SCHEMA}"?((?:matrix(?:_[a-z_]*)?|dd_ontology[a-z_]*)\b|\$\{([^}]*)\}|[A-Za-z_][A-Za-z0-9_]*)"?`;
const T2_DML = new RegExp(String.raw`\b${T2_DML_VERB}\s+${T2_DML_TARGET}`, 'gi');
/**
 * `COPY <table> [(cols)] FROM …` is a load (server-side file / STDIN through
 * the pool); `COPY <table> TO …` and `COPY (SELECT …) TO …` are exports. psql's
 * `\copy` is the psql channel's own shape (T2_PSQL_WRITE_SHAPES), excluded by
 * the lookbehind above.
 */
const T2_COPY_FROM = /^\s*(?:\([^)]*\)\s*)?FROM\b/i;
/** `MERGE INTO <target> [AS alias] USING …` — USING is mandatory syntax; "MERGE into ${x}" without it is prose. */
const T2_MERGE_USING = /^(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+USING\b/i;
/**
 * A literal that carries a matrix target with NO verb of its own
 * (`'UPDATE' + ' matrix_test SET …'`, `' matrix_test WHERE …'`): the verb lives
 * in another expression. Fail-closed like the dangling verb — a headless
 * target IS a DML site (the shape after the name is a write clause: SET,
 * VALUES, USING, WHERE, a column list before VALUES/SELECT), so it must be
 * enumerated or reassembled into one literal. An interpolated VERB
 * (`` `${verb} matrix_test SET …` ``) is the same shape with the verb in a
 * hole, so one leading hole is admitted before the target. A bare table-name
 * literal (`'matrix_test'`, the allowlist) is not this shape.
 */
const T2_HEADLESS_TARGET = new RegExp(
	String.raw`^\s*(?:\$\{[^}]*\}\s+)?(?:ONLY\s+)?${T2_DML_SCHEMA}"?((?:matrix(?:_[a-z_]*)?|dd_ontology[a-z_]*))\b"?(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*(?:\([^)]*\)\s*)?(?:SET|VALUES|USING|WHERE|SELECT|DEFAULT\s+VALUES)\b`,
	'i',
);
/**
 * A DML verb that is the LAST thing in its literal (`'UPDATE ' + table`,
 * `'DELETE FROM ' + name`): the target lives in another expression the walker
 * cannot see. Fail-closed — it is a site with an unresolved (null) target, so
 * it must be enumerated like any `${x}` that does not resolve. A bare word
 * literal (`'update'`, an action name) is NOT this shape: the verb must be
 * followed by whitespace, which is what a concatenation needs.
 */
const T2_DANGLING_VERB = new RegExp(String.raw`\b${T2_DML_VERB}\s+$`, 'i');

/** The counter gate's own matcher shape (matrix_counter_monotonic_tripwire), reused by name. */
const T2_COUNTER_TARGET = /^(?:matrix_counter(?:_dd)?|\$\{counterTable\})$/;

interface T2DmlSite {
	file: string;
	line: number;
	verb: string;
	/** The literal table name, or null when an interpolation did not resolve. */
	table: string | null;
	/** The raw target text as written (`matrix_users`, `${table}` …). */
	target: string;
}

/**
 * Resolve an interpolated identifier to the string literal it names: same-file
 * `const NAME = '…'` first, then ONE import hop to an `export const NAME = '…'`.
 * Anything else (a call, a member access, a computed value) returns null.
 */
function resolveInterpolatedIdentifier(file: string, expression: string): string | null {
	if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return null;
	const literalOf = (source: string, exported: boolean): string | null => {
		const declaration = new RegExp(
			String.raw`${exported ? String.raw`export\s+` : String.raw`(?:^|[^.\w])`}(?:const|let|var)\s+${expression}\s*(?::\s*[^=\n]+?)?\s*=\s*(['"\`])([^'"\`\n]*)\1`,
			'm',
		);
		const match = declaration.exec(source);
		return match ? (match[2] as string) : null;
	};
	if (!existsSync(join(REPO_ROOT, file))) return null; // fail-closed: an unknown file resolves nothing
	const ownSource = stripComments(read(file));
	const own = literalOf(ownSource, false);
	if (own !== null) return own;
	const importPattern = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
	for (const match of ownSource.matchAll(importPattern)) {
		const names = (match[1] as string).split(',').map((name) => name.trim().split(/\s+as\s+/)[0]);
		if (!names.includes(expression)) continue;
		const target = resolve(join(REPO_ROOT, dirname(file)), match[2] as string);
		if (!existsSync(target)) return null;
		return literalOf(stripComments(readFileSync(target, 'utf-8')), true);
	}
	return null;
}

/**
 * The comment-stripped literals of a census file (SQL lives in literals): the
 * TypeScript comments stripped from the source, then the SQL comments from
 * each literal — `UPDATE <block comment> matrix_test` and
 * `UPDATE\n-- x\nmatrix_test` are `UPDATE matrix_test` to Postgres, so they
 * are to the matchers.
 */
function sqlLiterals(file: string): SourceLiteral[] {
	return sqlStatementsOf(extractSourceLiterals(stripComments(read(file))));
}

/** The same literals with their SQL comments removed (line numbers preserved). */
function sqlStatementsOf(literals: SourceLiteral[]): SourceLiteral[] {
	return literals.map((literal) => ({
		line: literal.line,
		text: normalizeSqlLiteral(literal.text),
	}));
}

/**
 * Every DML site of one file whose target is a matrix/dd_ontology table or an
 * interpolation. Non-matrix literal targets are dropped here; interpolations
 * are resolved (fail-closed) and the resolved non-matrix ones dropped too.
 */
function dmlSitesOf(file: string, literals: SourceLiteral[] = sqlLiterals(file)): T2DmlSite[] {
	const sites: T2DmlSite[] = [];
	for (const literal of sqlStatementsOf(literals)) {
		const dangling = T2_DANGLING_VERB.exec(literal.text);
		if (dangling !== null) {
			const line = literal.line + literal.text.slice(0, dangling.index).split('\n').length - 1;
			const verb = (dangling[1] as string).replace(/\s+/g, ' ').toUpperCase();
			sites.push({ file, line, verb, table: null, target: '<concatenated target>' });
		}
		const headless = T2_HEADLESS_TARGET.exec(literal.text);
		if (headless !== null) {
			const named = (headless[1] as string).toLowerCase();
			sites.push({
				file,
				line: literal.line,
				verb: '<CONCATENATED VERB>',
				table: named,
				target: named,
			});
		}
		for (const match of literal.text.matchAll(T2_DML)) {
			const verb = (match[1] as string).replace(/\s+/g, ' ').toUpperCase();
			const rest = literal.text.slice(match.index + match[0].length);
			if (verb === 'COPY' && !T2_COPY_FROM.test(rest)) continue; // COPY … TO: an export
			if (verb === 'MERGE INTO' && !T2_MERGE_USING.test(rest)) continue; // prose, not a statement
			// Unquoted identifiers fold to lowercase in Postgres; a quoted mixed-case
			// name would be a different table, which no matrix family has — fold too.
			const named = (match[2] as string).toLowerCase();
			const hole = match[3];
			const line = literal.line + literal.text.slice(0, match.index).split('\n').length - 1;
			if (hole === undefined) {
				if (!/^(?:matrix|dd_ontology)/.test(named)) continue;
				sites.push({ file, line, verb, table: named, target: named });
				continue;
			}
			const resolved = resolveInterpolatedIdentifier(file, hole.trim());
			if (resolved !== null && !/^(?:matrix|dd_ontology)/.test(resolved)) continue;
			sites.push({ file, line, verb, table: resolved, target: `\${${hole}}` });
		}
	}
	return sites;
}

/**
 * The writer homes, each pinned to ITS family. `family` is the set of literal
 * table names the home may write; an interpolated target inside a home is the
 * home's own identifier gate (matrix_write.ts: assertMatrixTable; db_assets.ts:
 * the store catalog) and is accepted. `floor` is the anti-vacuity minimum of
 * DML sites the home must still carry — a home that lost its statements is a
 * scanner that stopped seeing them, not an engine that stopped writing.
 */
const T2_WRITER_HOMES: Readonly<
	Record<string, { family: readonly string[]; floor: number; what: string }>
> = {
	'src/core/db/matrix_write.ts': {
		family: ['matrix_updates'], // + every MATRIX_TABLE_ALLOWLIST table via ${tableName}
		floor: 11,
		what: 'record tables (upsert, per-key, append, counter-allocated and explicit-id insert, delete) + matrix_updates',
	},
	'src/core/db/time_machine.ts': {
		family: ['matrix_time_machine'],
		floor: 1,
		what: 'the Time Machine audit rows',
	},
	'src/core/db/dd_ontology.ts': {
		family: ['dd_ontology', 'dd_ontology_recovery'],
		floor: 5,
		what: 'the ontology definition rows + the recovery snapshot',
	},
	'src/core/db/db_assets.ts': {
		family: ['matrix_string_search', 'matrix_relation_index'],
		floor: 2,
		what: 'the derived search stores (truncate + rebuild)',
	},
};

/**
 * DML OUTSIDE the writer homes, on the pool channel — ENUMERATED, exact count
 * per file, shrink-only. Every entry states why the statement is not a
 * matrix_write.ts door. The staleness self-test below fails when a listed
 * file no longer carries exactly `writes` sites — so a site that MOVES into a
 * home must delete (or decrement) its entry in the same change, and a new site
 * cannot hide behind an old count.
 */
const T2_DML_OUTSIDE_WRITER: Readonly<Record<string, { writes: number; reason: string }>> = {
	// --- engine, serving ---------------------------------------------------
	'src/core/area_maintenance/user_stats.ts': {
		writes: 2,
		reason:
			"T4 owner of matrix_stats (not a record table: no counter, no TM); the DELETE + the `||` merge UPDATE are that family's own writer.",
	},
	'src/core/area_maintenance/widgets/database_info.ts': {
		writes: 1,
		reason:
			'consolidate_table: renumbers the PRIMARY KEY `id` of a whole table (UPDATE … SET id = …), a maintenance shape no record door has — the jsonb columns are untouched.',
	},
	'src/core/diffusion_bridge/diffusion_delete.ts': {
		writes: 4,
		reason:
			'activityTable() may resolve to a dedalo_ts_test_* SEAM table that assertMatrixTable refuses by design; all four statements (the dd1758 INSERT, the retention DELETE of SETTLED rows only, the pending→unpublished flip, the PUB-02 retry stamp) are ::text::jsonb / in-SQL jsonb_set (no JS-side read-modify-write).',
	},
	// --- offline v6→v7 transforms (the engine is not serving) ---------------
	'src/core/update/transform/lang.ts': {
		writes: 2,
		reason:
			'v6→v7 lang rewrite over EVERY row of a table (matrix_time_machine + `${table}`): a whole-column transform run offline by the update engine, not a record write.',
	},
	'src/core/update/transform/locators.ts': {
		writes: 3,
		reason:
			"v6→v7 locator rewrite: whole-table UPDATEs (matrix_time_machine + `${table}`) inside one transaction, offline; the counter INSERT is the counter gate's.",
	},
	'src/core/update/transform/portalize.ts': {
		writes: 1,
		reason: 'v6→v7 portalize: matrix_time_machine whole-table rewrite, offline.',
	},
	'src/core/update/transform/tables.ts': {
		writes: 2,
		reason:
			'v6→v7 table move: INSERT … SELECT + DELETE between two record tables, whole rows, offline.',
	},
	'src/core/update/transform/tipos.ts': {
		writes: 3,
		reason:
			"v6→v7 tipo rename: whole-table section_tipo / locator text rewrites, offline; the counter pair is the counter gate's.",
	},
	// --- operator one-offs (scripts/, never run by the engine) -------------
	'scripts/migrate_section_id_locators.ts': {
		writes: 1,
		reason:
			'section_id int-normalize sweep: the rewrite UPDATE runs on a row read FOR UPDATE inside withTransaction; the marker row goes through appendMatrixUpdateRow.',
	},
	'scripts/migrate_v6_passwords.ts': {
		writes: 1,
		reason:
			'one-shot v6 password re-hash on matrix_users: jsonb built server-side (jsonb_build_object), the hash a ::text bind; run once at cutover.',
	},
	'scripts/repair_tm_test_tail.ts': {
		writes: 1,
		reason: 'suite-only Time Machine tail repair (matrix_time_machine), marker-guarded.',
	},
	'scripts/repair_tm_timestamps.ts': {
		writes: 1,
		reason:
			'Time Machine timestamp repair (matrix_time_machine), dry-run by default, explicit range, transaction stated.',
	},
	// --- suite fixtures (marker-guarded; the suite database only) ------------
	'src/core/test_data/projects_fixture.ts': {
		writes: 1,
		reason:
			'explicit-id matrix_projects fixture row (assertTestDatabase first); the sweep uses deleteMatrixRecord.',
	},
	'src/core/test_data/run_created_records.ts': {
		writes: 3,
		reason:
			"client-run sweep: scoped DELETEs of the records a run CREATED (section_id above the run's own counter mark) + their TM and dd542 activity rows (marker-guarded).",
	},
	'src/core/test_data/seed.ts': {
		writes: 2,
		reason:
			'test3 playground seed: TRUNCATE + scoped DELETE of the canonical table before reseeding (marker-guarded).',
	},
	'src/core/test_data/situations/situation.ts': {
		writes: 3,
		reason:
			'situation teardown: scoped DELETEs of the records + their TM rows for a zz* scratch tld (marker-guarded).',
	},
	'src/core/test_data/synthetic_hierarchy_fixture.ts': {
		writes: 5,
		reason:
			'synthetic hierarchy fixture teardown: scoped DELETEs of matrix_hierarchy(_main) + TM rows (marker-guarded).',
	},
	'src/core/test_data/test_corpus/ensure.ts': {
		writes: 11,
		reason:
			"generic-test-TLD corpus provision/drop: scoped DELETEs + the TM row INSERT that pins a corpus record's history (marker-guarded).",
	},
};

/**
 * Interpolated targets that DO NOT resolve to a literal and are NOT matrix
 * tables: the T4 owners whose table name is computed (a test seam `options.table
 * ?? OWN_TABLE`, a resolved jobs table). Fail-closed means they are enumerated
 * — and every entry MUST be a T4 owner (asserted): the table a T4 owner writes
 * is its own family, which the T4 test already keeps everyone else off.
 */
const T2_UNRESOLVED_OWNER_TARGETS: Readonly<Record<string, { targets: number; reason: string }>> = {
	'src/core/error_report/store.ts': {
		targets: 3,
		reason:
			'`${name}` = tableOrThrow(options.table) ?? ERROR_REPORTS_TABLE (dedalo_ts_error_reports).',
	},
	'src/core/section/record/temporal_store.ts': {
		targets: 4,
		reason:
			'`${name}` = tableOrThrow(options.table) ?? TEMPORAL_SCRATCH_TABLE (dedalo_ts_temporal_scratch).',
	},
	'src/diffusion/jobs/queue.ts': {
		// 12 → 13 with PUB-13: `finishJob` is now LEASE-fenced (it may only end a
		// row the caller still owns), so the terminal transition of a QUEUED row
		// that no runner ever claimed — the owner-scoped cancel — became its own
		// state-guarded statement, `finalizeQueuedJob`.
		targets: 13,
		reason:
			'`${DIFFUSION_JOBS_TABLE}` = resolveJobsTable() (dedalo_ts_diffusion_jobs or its seam).',
	},
	'src/diffusion/jobs/run_ledger.ts': {
		// DIFF-1 (audit 2026-09-26): the job-scoped run ledger — one self-fenced
		// append per committed batch, one fenced clear when the run completes.
		targets: 2,
		reason:
			'`${DIFFUSION_JOB_LEDGER_TABLE}` = schema.ts (dedalo_ts_diffusion_job_ledger, or `<jobs seam>_ledger`).',
	},
};

/**
 * THE PSQL CHANNEL. `runPsql` / `runPsqlScript` (src/core/install/pg_exec.ts)
 * and the suite builders' own psql spawn ship SQL TEXT to a psql child: DML on
 * stdin (src/ never in `-c` — psql_argv_sql_tripwire), `\copy … FROM`,
 * `SELECT setval(…)`, or a whole `-f <file>` restore.
 * None of it passes matrix_write.ts, json_codec, a transaction the engine
 * owns, or the Time Machine — that is the hazard, and every such file is
 * enumerated with its write-shape count and the ENCODING GUARANTEE that makes
 * the channel safe: values reach Postgres verbatim inside quoted literals (psql
 * substitutes nothing inside '…' / $tag$…$tag$; there is no Bun type inference,
 * so the ::text::jsonb bind trap does not exist on this channel).
 *
 * A psql-channel file may not ALSO import the pool (asserted): one channel per
 * file is what makes this attribution exact.
 */
const T2_PSQL_WRITE_CHANNEL: Readonly<Record<string, { writes: number; reason: string }>> = {
	'src/core/install/root_pw.ts': {
		writes: 1,
		reason:
			'install-time root password on matrix_users, over the just-persisted connection descriptor (the pool is not bound to it yet); the jsonb is built SERVER-SIDE (jsonb_build_array/object) from a regex-validated argon2 literal shipped on stdin — no encoding hop.',
	},
	'src/core/install/hierarchy_import.ts': {
		writes: 2,
		reason:
			"`\\copy matrix_hierarchy FROM STDIN` of a shipped .copy.gz (COPY text is the table's own dump format), the scoped REPLACE pre-DELETE, and the GREATEST counter upsert (counter gate law).",
	},
	'src/core/ontology/data_io_import.ts': {
		writes: 8,
		reason:
			"ontology data IO: DELETE + `\\copy FROM` of a staged file in ONE psql transaction (two script shapes + the `-f` run), the setval bump, and the in-SQL jsonb_set tld normalization on matrix_ontology; the counter upsert is the counter gate's.",
	},
	'src/core/ontology/recovery_file.ts': {
		writes: 1,
		reason: '`-f` restore of a dd_ontology recovery dump (plain SQL the engine itself wrote).',
	},
	'src/core/install/db_restore.ts': {
		writes: 1,
		reason:
			'`-f` restore of the vendored install seed (install/db/dedalo_install.pgsql.gz). The seed is COMPILED with every migration applied (install/seed_build.ts; install_seed_manifest_tripwire goes STALE on a new one), so no migration is applied after the restore.',
	},
	'src/core/install/seed_build.ts': {
		writes: 9,
		reason:
			'install SEED COMPILER: every statement targets a scratch database it CREATED and MARKED (`dedalo_seed_build_<pid>` / `dedalo_seed_verify_<pid>`, dedalo_seed_build_marker; dropped by the oid captured at CREATE) — no installation database is read or written. Shapes: the `-1 -f` of schema.sql and of each migration file, the `\\copy` loads of the repo-owned sources (scaffold, langs, registry), the one-transaction data and order scripts (`-f -`: TRUNCATE of what does not ship, canonical records as `$seed$`-dollar-quoted JSON.stringify output — psql never interpolates inside a quoted literal — and a server-side jsonb_build_object data-version row from validated literals; CLUSTER + store rebuilds), the marker INSERT.',
	},
	'scripts/seed_bootstrap_extract.ts': {
		writes: 3,
		reason:
			'ONE-TIME seed-source extraction (kept as provenance): restores the seed from GIT (`HEAD:install/db/…`) into a scratch database it creates and marks, applies the migration files, drops orphan sequences, cuts + deactivates the hierarchy registry (server-side jsonb_build_object), then exports the sources. Never touches an installation database.',
	},
};

/** A psql-channel WRITE shape inside one literal / argv. */
const T2_PSQL_WRITE_SHAPES: readonly RegExp[] = [
	/^\s*\\+copy\s+(?!\()[\s\S]*\bFROM\b/i, // \copy <table> … FROM (a load; `\copy (SELECT …) TO` is an export)
	/^\s*SELECT\s+setval\s*\(/i, // sequence bump
];

function usesPsqlChannel(code: string): boolean {
	return /\brunPsql(?:Script)?\s*\(/.test(code) || /resolvePgBinary\(\s*'psql'\s*\)/.test(code);
}

/** Count the write shapes a psql-channel file ships: DML sites + copy-FROM + setval + `-f <file>`. */
function psqlWriteShapes(file: string): number {
	const code = stripComments(read(file));
	const literals = extractSourceLiterals(code);
	let count = dmlSitesOf(file, literals).filter(
		(site) => !T2_COUNTER_TARGET.test(site.target),
	).length;
	for (const literal of literals) {
		if (T2_PSQL_WRITE_SHAPES.some((shape) => shape.test(literal.text))) count++;
	}
	// `'-f', <file>` argv: a restore/script run. `'-f', '-'` is stdin, counted
	// through the DML text it carries, not here.
	for (const match of code.matchAll(/'-f'\s*,\s*('[^']*'|[A-Za-z_][\w.]*)/g)) {
		if (match[1] !== "'-'") count++;
	}
	return count;
}

/**
 * P0-3 — the UNLOCKED READ-MODIFY-WRITE shape. Per file: a SELECT that projects
 * a matrix jsonb column (or `${column}`) from a matrix target WITHOUT
 * `FOR UPDATE`, paired with an UPDATE of a matrix target that binds a jsonb
 * VALUE into its SET clause (`$n::text::jsonb` / `${x}::text::jsonb`, or an
 * interpolated SET). Per-file pairing is the honest static form: it cannot see
 * data flow, so a file where the read and the write are unrelated is listed
 * with the reason, not fixed. matrix_write.ts is the chokepoint that holds the
 * locked twin (readMatrixKeyForUpdate) and is the one file exempt by name.
 */
const T2_JSONB_COLUMN = new RegExp(
	String.raw`"?\b(?:${MATRIX_JSONB_COLUMNS.join('|')})\b"?|\$\{[^}]*[cC]olumn[^}]*\}`,
	'i',
);
const T2_MATRIX_READ_TARGET = String.raw`(?:ONLY\s+)?${T2_DML_SCHEMA}"?(?:matrix(?:_[a-z_]*)?|\$\{[^}]*\})"?`;
const T2_SELECT_FROM_MATRIX = new RegExp(
	String.raw`\bSELECT\b([\s\S]*?)\bFROM\s+${T2_MATRIX_READ_TARGET}(?:\s+(?:AS\s+)?([a-z_]\w*))?`,
	'gi',
);
/** A whole-row projection: `*`, `t.*`, `to_jsonb(t)`, `row_to_json(t)`, the alias itself. */
const T2_WHOLE_ROW =
	/(?<!count\s*\(\s*)\*|\b(?:to_jsonb|to_json|row_to_json|jsonb_agg|json_agg)\s*\(/i;
/**
 * The projection (everything between SELECT and `FROM <matrix target>`) reads
 * a jsonb column when it NAMES one — in ANY context: bare, `->`/`#>`/`@>`/`?`/
 * `-`-walked, cast, aliased, subscripted, wrapped in a function
 * (`jsonb_array_elements("relation")`). FAIL-CLOSED: the column name anywhere
 * in the projection is a read; the operator or function around it is not what
 * decides. Or when it is the whole row (`*`, `t.*`, `to_jsonb(t)`,
 * `row_to_json(t)`, a bare alias `SELECT t FROM matrix_test t`): the whole row
 * IS the jsonb columns. `count(*)` is not a projection of the row.
 */
function hasUnlockedJsonbRead(text: string): boolean {
	for (const match of text.matchAll(T2_SELECT_FROM_MATRIX)) {
		const projection = match[1] as string;
		if (T2_JSONB_COLUMN.test(projection) || T2_WHOLE_ROW.test(projection)) return true;
		const alias = match[2];
		if (alias !== undefined && projection.trim().toLowerCase() === alias.toLowerCase()) return true;
	}
	return false;
}
const T2_BOUND_JSONB_UPDATE = new RegExp(
	String.raw`\b(?:UPDATE\s+${T2_MATRIX_READ_TARGET}|MERGE\s+INTO\s+${T2_MATRIX_READ_TARGET})[\s\S]*?\bSET\b(?:\s*\$\{|[\s\S]*?(?:\$\d+|\$\{[^}]*\})\s*::\s*text\s*::\s*jsonb)`,
	'i',
);

const T2_UNLOCKED_RMW_EXEMPT: Readonly<Record<string, string>> = {
	'src/core/area_maintenance/user_stats.ts':
		'T4 owner of matrix_stats: the unlocked SELECTs are the report pages; the UPDATE merges values built from the REQUEST (`|| jsonb_build_object`), never from a read-back row.',
	'src/core/update/transform/locators.ts':
		'offline v6→v7 transform, single writer while it runs: reads a page of rows, rewrites their locators, writes the page back.',
	'scripts/migrate_section_id_locators.ts':
		'the rewrite pair is LOCKED (SELECT … FOR UPDATE at the row, inside withTransaction); the unlocked SELECTs are the candidate census and the post-verify count.',
};

function isMatrixScopedTarget(file: string, literal: string): boolean {
	// A `${…}` target in a T4-owner file whose interpolation is enumerated
	// resolves to that owner's table — out of matrix scope.
	if (file in T2_UNRESOLVED_OWNER_TARGETS && !/\bmatrix/.test(literal)) return false;
	return true;
}

describe('T2 — matrix DML confinement (one writer per table family)', () => {
	const homes = Object.keys(T2_WRITER_HOMES);
	const inScope = (file: string): boolean =>
		!file.startsWith('src/diffusion/targets/mariadb/') && !homes.includes(file);

	test('the census sees the writer homes (anti-vacuity: each home carries its floor of DML sites)', () => {
		for (const [home, { floor }] of Object.entries(T2_WRITER_HOMES)) {
			const sites = dmlSitesOf(home).filter((site) => !T2_COUNTER_TARGET.test(site.target));
			expect(
				sites.length,
				`${home}: ${sites.map((s) => `${s.line}:${s.verb} ${s.target}`).join(', ')}`,
			).toBeGreaterThanOrEqual(floor);
		}
		// The append door and the sequence-id door landed in matrix_write.ts
		// (P1-15): the scanner must see BOTH shapes there, or a regression that
		// moved them back out would look like a smaller home, not a violation.
		const matrixWrite = read('src/core/db/matrix_write.ts');
		expect(matrixWrite).toContain('export async function appendMatrixKeyItems');
		expect(matrixWrite).toContain('export async function insertMatrixRowSequenceId');
		expect(matrixWrite).toContain('export async function appendMatrixUpdateRow');
	});

	test('each writer home writes ONLY its own family', () => {
		const violations: string[] = [];
		for (const [home, { family }] of Object.entries(T2_WRITER_HOMES)) {
			for (const site of dmlSitesOf(home)) {
				if (T2_COUNTER_TARGET.test(site.target)) continue;
				if (site.table === null) continue; // the home's own identifier gate
				if (family.includes(site.table)) continue;
				violations.push(`${home}:${site.line} ${site.verb} ${site.table}`);
			}
		}
		expect(
			violations,
			`A writer home wrote outside its family — the family's OWN home is the door: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('no matrix/dd_ontology DML outside the writer homes except the enumerated sites (exact counts)', () => {
		const violations: string[] = [];
		const counts = new Map<string, T2DmlSite[]>();
		for (const file of sourceFiles()) {
			if (!inScope(file)) continue;
			const code = stripComments(read(file));
			if (usesPsqlChannel(code)) continue; // the psql clause below owns it
			const sites = dmlSitesOf(file, extractSourceLiterals(code)).filter(
				(site) => !T2_COUNTER_TARGET.test(site.target),
			);
			if (sites.length === 0) continue;
			const unresolvedOwner = T2_UNRESOLVED_OWNER_TARGETS[file];
			if (unresolvedOwner !== undefined) {
				const unresolved = sites.filter((site) => site.table === null);
				if (unresolved.length !== sites.length || unresolved.length !== unresolvedOwner.targets) {
					violations.push(
						`${file}: ${sites.length} DML site(s), ${unresolved.length} unresolved — the owner entry says ${unresolvedOwner.targets} unresolved and no literal matrix target`,
					);
				}
				continue;
			}
			counts.set(file, sites);
			const listed = T2_DML_OUTSIDE_WRITER[file];
			if (listed === undefined) {
				violations.push(
					`${file}: ${sites.map((s) => `${s.line}:${s.verb} ${s.target}`).join(', ')} — move the statement into its src/core/db writer home (matrix_write.ts for record tables)`,
				);
			} else if (listed.writes !== sites.length) {
				violations.push(
					`${file}: ${sites.length} DML site(s) but the entry says ${listed.writes} — ${sites.map((s) => `${s.line}:${s.verb} ${s.target}`).join(', ')}`,
				);
			}
		}
		expect(violations, `T2 violations:\n${violations.join('\n')}`).toEqual([]);
		// Anti-vacuity: the census found the enumerated files (a scanner that
		// sees nothing would pass a list-only test).
		expect(counts.size).toBeGreaterThanOrEqual(Object.keys(T2_DML_OUTSIDE_WRITER).length);
	});

	test('the enumerated lists stay honest (staleness self-test: shrink-only, exact, owners are T4 owners)', () => {
		const stale: string[] = [];
		for (const file of Object.keys(T2_DML_OUTSIDE_WRITER)) {
			if (!existsSync(join(REPO_ROOT, file))) {
				stale.push(`${file}: deleted/moved`);
				continue;
			}
			const sites = dmlSitesOf(file).filter((site) => !T2_COUNTER_TARGET.test(site.target));
			if (sites.length === 0)
				stale.push(`${file}: carries no matrix DML any more — delete its entry`);
			if (homes.includes(file)) stale.push(`${file}: is a writer home`);
			if (file in T2_PSQL_WRITE_CHANNEL) stale.push(`${file}: listed on both channels`);
		}
		for (const [file, entry] of Object.entries(T2_UNRESOLVED_OWNER_TARGETS)) {
			const owner = SUBSYSTEM_OWNED_TABLES.some(({ owners }) =>
				owners.some((prefix) => file === prefix || file.startsWith(prefix)),
			);
			if (!owner)
				stale.push(`${file}: not a T4 owner — an unresolved target there is a matrix table`);
			if (!existsSync(join(REPO_ROOT, file))) stale.push(`${file}: deleted/moved`);
			else if (dmlSitesOf(file).filter((s) => s.table === null).length !== entry.targets)
				stale.push(`${file}: unresolved-target count drifted from ${entry.targets}`);
		}
		expect(stale, stale.join('\n')).toEqual([]);
	});

	test('the psql channel: every file shipping DML text / copy-FROM / -f restores through psql is enumerated with its exact write-shape count', () => {
		const violations: string[] = [];
		const seen = new Set<string>();
		for (const file of sourceFiles()) {
			if (file === 'src/core/install/pg_exec.ts') continue; // the channel itself
			const code = stripComments(read(file));
			if (!usesPsqlChannel(code)) continue;
			const shapes = psqlWriteShapes(file);
			if (shapes === 0) continue;
			if (/from\s+['"][^'"]*db\/postgres\.ts['"]/.test(code)) {
				violations.push(
					`${file}: ships writes through psql AND imports the pool — one channel per file`,
				);
			}
			seen.add(file);
			const listed = T2_PSQL_WRITE_CHANNEL[file];
			if (listed === undefined) {
				violations.push(`${file}: ${shapes} psql write shape(s) not enumerated`);
			} else if (listed.writes !== shapes) {
				violations.push(
					`${file}: ${shapes} psql write shape(s) but the entry says ${listed.writes}`,
				);
			}
		}
		for (const file of Object.keys(T2_PSQL_WRITE_CHANNEL)) {
			if (!seen.has(file))
				violations.push(`${file}: stale psql-channel entry (no write shape / not a psql user)`);
		}
		expect(violations, violations.join('\n')).toEqual([]);
		expect(seen.size).toBeGreaterThanOrEqual(5); // anti-vacuity: the channel is in use
	});

	test('P0-3: no unlocked read-modify-write of a matrix jsonb column outside matrix_write.ts', () => {
		const violations: string[] = [];
		const paired = new Set<string>();
		for (const file of sourceFiles()) {
			// Writer homes are not exempt from the RMW rule — only matrix_write.ts,
			// which holds the LOCKED twin (readMatrixKeyForUpdate); MariaDB is out.
			if (file === 'src/core/db/matrix_write.ts') continue;
			if (file.startsWith('src/diffusion/targets/mariadb/')) continue;
			const literals = sqlLiterals(file).filter((literal) =>
				isMatrixScopedTarget(file, literal.text),
			);
			const unlocked = literals.filter(
				(literal) => hasUnlockedJsonbRead(literal.text) && !/FOR\s+UPDATE\b/i.test(literal.text),
			);
			const bound = literals.filter((literal) => T2_BOUND_JSONB_UPDATE.test(literal.text));
			if (unlocked.length === 0 || bound.length === 0) continue;
			paired.add(file);
			if (file in T2_UNLOCKED_RMW_EXEMPT) continue;
			violations.push(
				`${file}: unlocked jsonb SELECT at line(s) ${unlocked.map((l) => l.line).join(',')} + bound jsonb UPDATE at line(s) ${bound.map((l) => l.line).join(',')} — read the key under readMatrixKeyForUpdate (matrix_write.ts) inside the transaction that writes it`,
			);
		}
		expect(violations, violations.join('\n')).toEqual([]);
		const stale = Object.keys(T2_UNLOCKED_RMW_EXEMPT).filter((file) => !paired.has(file));
		expect(
			stale,
			`stale RMW exemptions (no longer pair a read with a write): ${stale.join(', ')}`,
		).toEqual([]);
	});

	test('positive controls: the scanner sees a planted offender of every clause', () => {
		// Pool DML outside a home, literal target.
		const bare = dmlSitesOf('src/zz_planted.ts', [
			{ text: 'INSERT INTO matrix_test (section_tipo) VALUES ($1)', line: 1 },
		]);
		expect(bare.map((s) => `${s.verb} ${s.table}`)).toEqual(['INSERT INTO matrix_test']);
		// Lowercase / mixed-case spellings are the SAME statement to Postgres
		// (keywords and unquoted identifiers fold): every one is a site.
		const folded = dmlSitesOf('src/zz_planted.ts', [
			{ text: 'update matrix_test set data = $1::text::jsonb where section_id = $2', line: 1 },
			{ text: 'delete from matrix_test where section_id = $1', line: 2 },
			{ text: 'Insert Into MATRIX_TEST (section_id) VALUES ($1)', line: 3 },
			{ text: 'truncate table Dd_Ontology', line: 4 },
		]);
		expect(folded.map((s) => `${s.line}:${s.verb} ${s.table}`)).toEqual([
			'1:UPDATE matrix_test',
			'2:DELETE FROM matrix_test',
			'3:INSERT INTO matrix_test',
			'4:TRUNCATE TABLE dd_ontology',
		]);
		// A verb with its target in ANOTHER expression (`'UPDATE ' + table`) is a
		// site with an unresolved target (fail-closed); a bare action word is not.
		const dangling = dmlSitesOf('src/zz_planted.ts', [
			{ text: 'delete from ', line: 1 },
			{ text: 'UPDATE\n  ', line: 2 },
			{ text: 'update', line: 5 },
			{ text: 'mode:insert into', line: 6 },
		]);
		expect(dangling.map((s) => `${s.line}:${s.verb} ${s.table}`)).toEqual([
			'1:DELETE FROM null',
			'2:UPDATE null',
		]);
		// The other half of a split statement — a HEADLESS matrix target
		// (`'UPDATE' + ' matrix_test SET …'`) — is a site too; a bare table-name
		// literal (the allowlist's `'matrix_test'`) is not.
		const headless = dmlSitesOf('src/zz_planted.ts', [
			{ text: ' matrix_test SET data = NULL WHERE section_id = $1', line: 1 },
			{ text: 'matrix_test WHERE section_id = $1', line: 2 },
			{ text: ' public.matrix_test (section_id, data) VALUES ($1, $2)', line: 3 },
			{ text: 'matrix_test', line: 4 },
			{ text: 'matrix_test_x', line: 5 },
			{ text: '${verb} matrix_test SET data = NULL WHERE section_id = $1', line: 6 }, // the verb in a hole
			{ text: '${verb} matrix_test', line: 7 }, // no write clause: not a site
		]);
		expect(headless.map((s) => `${s.line}:${s.table}`)).toEqual([
			'1:matrix_test',
			'2:matrix_test',
			'3:matrix_test',
			'6:matrix_test',
		]);
		// SQL COMMENTS between verb and target are nothing to Postgres — and to
		// the matchers (a `--` inside a quoted path is a path, not a comment).
		const commented = dmlSitesOf('src/zz_planted.ts', [
			{
				text: 'UPDATE /* c */ matrix_test SET data = $1::text::jsonb WHERE section_id = $2',
				line: 1,
			},
			{
				text: 'UPDATE\n-- x\nmatrix_test SET data = $1::text::jsonb WHERE section_id = $2',
				line: 2,
			},
			{ text: 'INSERT INTO -- t\n public.matrix_test (section_id) VALUES ($1)', line: 4 },
			{ text: "WITH x AS (SELECT '{a--b}' AS p) UPDATE matrix_test SET data = NULL", line: 5 }, // a quoted `--` hides nothing
			{ text: '${i--} UPDATE /* a\n b */ ONLY matrix_test SET data = NULL', line: 6 },
			// The SOURCE bytes of a quoted string: `\n` is an escape, two
			// characters to a regex, one newline at runtime.
			{ text: String.raw`UPDATE\nmatrix_test SET data = NULL`, line: 7 },
			{ text: String.raw`UPDATE\n-- x\nmatrix_test SET data = NULL`, line: 8 },
		]);
		expect(commented.map((s) => `${s.line}:${s.verb} ${s.table}`)).toEqual([
			'1:UPDATE matrix_test',
			'2:UPDATE matrix_test',
			'4:INSERT INTO matrix_test',
			'5:UPDATE matrix_test',
			'6:UPDATE matrix_test',
			'7:UPDATE matrix_test',
			'8:UPDATE matrix_test',
		]);
		// The spellings Postgres reads as the SAME table / statement: ONLY, a
		// schema qualifier (bare or quoted), MERGE, a server-side COPY … FROM.
		const postgresShaped = dmlSitesOf('src/zz_planted.ts', [
			{ text: 'UPDATE public.matrix_test SET data = NULL WHERE section_id = $1', line: 1 },
			{ text: 'UPDATE "public"."matrix_test" SET data = NULL WHERE section_id = $1', line: 2 },
			{ text: 'UPDATE ONLY public.matrix_test SET data = NULL', line: 3 },
			{
				text: 'MERGE INTO matrix_test t USING (SELECT $1::int AS sid) s ON t.section_id = s.sid WHEN MATCHED THEN UPDATE SET data = $2 WHEN NOT MATCHED THEN INSERT (section_id) VALUES ($1)',
				line: 4,
			},
			{ text: "COPY matrix_test FROM '/tmp/rows.csv'", line: 5 },
			{ text: 'COPY matrix_test (section_id, data) FROM STDIN', line: 6 },
			{ text: 'DELETE FROM public.dd_ontology WHERE tld = $1', line: 7 },
			// …and not: an export, a `\copy` (the psql channel's shape), prose, a schema-qualified non-matrix table.
			{ text: "COPY matrix_test TO '/tmp/rows.csv'", line: 8 },
			{ text: "COPY (SELECT * FROM matrix_test) TO '/tmp/rows.csv'", line: 9 },
			{ text: '\\copy matrix_hierarchy FROM STDIN', line: 10 },
			{ text: 'or --execute to MERGE into ${target}', line: 11 },
			{ text: 'UPDATE public.dedalo_ts_x SET a = 1', line: 12 },
		]);
		expect(postgresShaped.map((s) => `${s.line}:${s.verb} ${s.table}`)).toEqual([
			'1:UPDATE matrix_test',
			'2:UPDATE matrix_test',
			'3:UPDATE matrix_test',
			'4:MERGE INTO matrix_test',
			'5:COPY matrix_test',
			'6:COPY matrix_test',
			'7:DELETE FROM dd_ontology',
		]);
		// Interpolated target that does not resolve → fail-closed (table null, still a site).
		const opaque = dmlSitesOf('src/zz_planted.ts', [
			{ text: 'DELETE FROM "${table}" WHERE 1', line: 1 },
		]);
		expect(opaque).toHaveLength(1);
		expect(opaque[0]?.table).toBeNull();
		// A resolvable non-matrix identifier leaves the census (locks.ts's LOCK_TABLE).
		expect(resolveInterpolatedIdentifier('src/core/section/locks.ts', 'LOCK_TABLE')).toBe(
			'dedalo_ts_component_locks',
		);
		// One import hop resolves too (the marker constants module).
		expect(
			resolveInterpolatedIdentifier(
				'src/core/test_data/test_database_marker.ts',
				'TEST_MARKER_TABLE',
			),
		).toBe('dedalo_test_marker');
		expect(dmlSitesOf('src/core/section/locks.ts')).toEqual([]);
		// Non-matrix literal targets are never sites.
		expect(dmlSitesOf('src/zz_planted.ts', [{ text: 'DELETE FROM dedalo_ts_x', line: 1 }])).toEqual(
			[],
		);
		// The psql channel: stdin DML, copy-FROM, setval and a -f restore each count.
		expect(T2_PSQL_WRITE_SHAPES[0]?.test('\\copy matrix_hierarchy (a, b) FROM STDIN')).toBe(true);
		expect(T2_PSQL_WRITE_SHAPES[0]?.test("\\copy (SELECT a FROM matrix_test) TO '/tmp/x'")).toBe(
			false,
		);
		expect(T2_PSQL_WRITE_SHAPES[1]?.test("SELECT setval('matrix_test_id_seq', 1)")).toBe(true);
		expect(
			usesPsqlChannel("await runPsql(conn, ['-c', 'UPDATE matrix_users SET string = null'])"),
		).toBe(true);
		// The RMW pair: an unlocked jsonb read and a bound jsonb write.
		const unlockedRead =
			'SELECT "string"->\'test1\' AS items FROM "${table}" WHERE section_id = $1';
		expect(hasUnlockedJsonbRead(unlockedRead)).toBe(true);
		// The whole row, a function-wrapped column and a `||`-walked column are reads too…
		expect(hasUnlockedJsonbRead('SELECT * FROM matrix_test WHERE section_id = $1')).toBe(true);
		expect(hasUnlockedJsonbRead('select t.* from matrix_test t where t.id = $1')).toBe(true);
		expect(
			hasUnlockedJsonbRead(
				'SELECT jsonb_array_elements("relation") FROM matrix_test WHERE section_id = $1',
			),
		).toBe(true);
		// …so is the column under ANY operator, and the row under any spelling
		// (fail-closed: the name in the projection is the read, not the operator).
		for (const projection of [
			"data #> '{a}'",
			"data @> '{}'",
			"data ? 'k'",
			"data - 'k'",
			"data['a'][0]",
			'data::text',
			'jsonb_typeof(data), section_id',
			'to_jsonb(t) AS row',
			'row_to_json(t)',
			'jsonb_agg(t)',
			't',
		]) {
			expect(
				hasUnlockedJsonbRead(
					`SELECT ${projection} FROM public.matrix_test t WHERE section_id = $1`,
				),
				projection,
			).toBe(true);
		}
		// …a count, a non-jsonb projection, a different alias and a non-matrix source are not.
		expect(hasUnlockedJsonbRead('SELECT count(*) FROM matrix_test')).toBe(false);
		expect(hasUnlockedJsonbRead('SELECT section_id FROM matrix_test')).toBe(false);
		expect(hasUnlockedJsonbRead('SELECT u FROM matrix_test t')).toBe(false);
		expect(hasUnlockedJsonbRead('SELECT * FROM dedalo_ts_component_locks')).toBe(false);
		expect(hasUnlockedJsonbRead(`${unlockedRead} FOR UPDATE`)).toBe(true); // the lock is checked separately
		expect(/FOR\s+UPDATE\b/i.test(`${unlockedRead} FOR UPDATE`)).toBe(true);
		// The write half in MERGE's and the schema-qualified spelling.
		expect(
			T2_BOUND_JSONB_UPDATE.test(
				'MERGE INTO matrix_test t USING x ON 1=1 WHEN MATCHED THEN UPDATE SET data = $2::text::jsonb',
			),
		).toBe(true);
		expect(
			T2_BOUND_JSONB_UPDATE.test(
				'UPDATE public.matrix_test SET data = $2::text::jsonb WHERE id = $1',
			),
		).toBe(true);
		expect(
			T2_BOUND_JSONB_UPDATE.test(
				'UPDATE "matrix_test" SET "string" = jsonb_set(COALESCE("string", \'{}\'::jsonb), \'{test1}\', $3::text::jsonb) WHERE section_id = $1',
			),
		).toBe(true);
		expect(T2_BOUND_JSONB_UPDATE.test('UPDATE "${table}" SET ${setClauses} WHERE id = $1')).toBe(
			true,
		);
		// Not a jsonb-value bind: an int stamped in-SQL (diffusion_delete's shape).
		expect(
			T2_BOUND_JSONB_UPDATE.test(
				"UPDATE matrix_test SET relation = jsonb_set(relation, '{a,0}', (relation->'a'->0) || jsonb_build_object('k', $2::int)) WHERE section_id = $1",
			),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// T3 — dd_ontology direct-read RATCHET.
// ---------------------------------------------------------------------------

/**
 * Files still running their own `FROM dd_ontology` queries (audit S2-19: 37
 * at census time; 4 hand-rolled walks already migrated onto the resolver
 * accessors). The canonical homes — src/core/db/ and src/core/ontology/ —
 * are exempt: that pair IS the repository layer the reads consolidate into.
 *
 * RULE: a file NOT on this list must not query dd_ontology directly — use
 * the src/core/ontology accessors. When you migrate a listed file, delete
 * its entry (the ratchet only goes down).
 */
const DD_ONTOLOGY_DIRECT_READ_RATCHET = new Set<string>([
	'src/core/area/dashboard.ts',
	// children.ts: getRelatedParentTipo's direct `relations` read now goes
	// through the resolver's nodeCache (getNode) — entry retired 2026-09-05
	// (PERF-02; the staleness self-test below enforces this pruning).
	'src/core/relations/request_config/build.ts',
	'src/core/relations/request_config/implicit.ts',
	'src/core/relations/request_config/explicit.ts',
	// dd_info.ts, info_widgets.ts, tm_record.ts: migrated off direct dd_ontology
	// queries — entries retired 2026-07-07 (staleness self-test below now
	// enforces this pruning mechanically).
	'src/core/diffusion_bridge/diffusion_delete.ts',
	'src/core/diffusion_bridge/diffusion_map.ts',
	// environment.ts: its model='label' dd_ontology rebuild died with the
	// labels-to-repo-catalog migration (WC-033) — entry retired 2026-07-16.
	'src/core/api/handlers/login_context.ts',
	'src/core/api/handlers/menu.ts',
	// ontology_delete.ts re-homed into src/core/ontology/ (WS-C S2-22) — that
	// directory IS the exempt canonical home, so its ratchet entry is retired.
	'src/core/resolve/relation_index.ts',
	'src/core/resolve/relation_list.ts',
	'src/core/resolve/section_elements_context.ts',
	'src/core/resolve/security_access_datalist.ts',
	// S2-23 split: widget_request.ts's dd_ontology readers moved verbatim into
	// their per-widget modules (the anti-lockout / root-area tipo lookups)
	'src/core/area_maintenance/widgets/config_areas.ts',
	'src/core/area_maintenance/widgets/menu_skip_tipos.ts',
	'src/core/search/search_related.ts',
	'src/core/section/buttons.ts',
	'src/core/section/list_definitions/node_find.ts',
	'src/core/section/list_definitions/section_list.ts',
	'src/core/section/record/create_record.ts',
	'src/core/ts_object/ts_object.ts',
	'src/diffusion/plan/virtual_tree.ts',
	'src/diffusion/resolve/resolver.ts',
	// scripts/ entered the census 2026-09-02 (P2-20/S-3, shared write-path
	// corpus). An install-specific (numisdata) one-off migration that reads
	// dd_ontology directly to find the alias/model rows it rewrites; never run
	// by the engine. Listed, not migrated: the resolver caches are the wrong
	// tool for a one-shot CLI that must see the rows it just wrote (its DML is
	// under T2 like any other script's).
	'scripts/migrate_component_alias.ts',
]);

/**
 * Files still hand-rolling a `WITH RECURSIVE` ontology walk instead of using
 * getOrderedSubtree / findFirstDescendantTipoByModel (which own the ONE
 * sibling order/tiebreak policy). ALL nine census walks are migrated
 * (2026-07-07, debris workstream): relations/children.ts, area/tree.ts,
 * ontology/section_id_component.ts, ts_object/ts_object.ts, delete_record.ts,
 * diffusion_map.ts, diffusion resolver, virtual_tree, the two tool
 * list-shape walks. Only the canonical home remains.
 */
const RECURSIVE_WALK_RATCHET = new Set<string>([
	'src/core/ontology/resolver.ts', // the canonical home
]);

describe('T3 — dd_ontology read consolidation ratchet (S2-19)', () => {
	test('no NEW file queries dd_ontology directly', () => {
		const pattern = /FROM\s+dd_ontology\b/i;
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			if (file.startsWith('src/core/db/') || file.startsWith('src/core/ontology/')) continue;
			if (!pattern.test(read(file))) continue;
			if (DD_ONTOLOGY_DIRECT_READ_RATCHET.has(file)) continue;
			violations.push(file);
		}
		expect(
			violations,
			`New direct dd_ontology query. Use the cached accessors in src/core/ontology/ (resolver.ts, labels.ts, section_map.ts) — do NOT extend this ratchet list upward: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('no NEW hand-rolled WITH RECURSIVE ontology walk', () => {
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			const content = read(file);
			if (!content.includes('WITH RECURSIVE') || !/dd_ontology/.test(content)) continue;
			if (RECURSIVE_WALK_RATCHET.has(file)) continue;
			violations.push(file);
		}
		expect(
			violations,
			`New recursive ontology walk. Use getOrderedSubtree / findFirstDescendantTipoByModel from src/core/ontology/resolver.ts (one order/tiebreak policy): ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('ratchets stay honest — no stale entries for files that no longer match (staleness self-test)', () => {
		// Same posture as module_state_tripwire's allowlist self-tests: a stale
		// entry makes the gate look stricter than it is (the file could regress
		// back to direct queries without a diff review noticing). A deleted/moved
		// file is stale too.
		const directReadPattern = /FROM\s+dd_ontology\b/i;
		const staleDirectRead = [...DD_ONTOLOGY_DIRECT_READ_RATCHET].filter((file) => {
			try {
				return !directReadPattern.test(read(file));
			} catch {
				return true; // file deleted or moved
			}
		});
		expect(
			staleDirectRead,
			`Stale DD_ONTOLOGY_DIRECT_READ_RATCHET entries — these files no longer query dd_ontology directly; delete their entries (the ratchet must match reality): ${staleDirectRead.join(', ')}`,
		).toEqual([]);

		const staleWalk = [...RECURSIVE_WALK_RATCHET].filter((file) => {
			try {
				const content = read(file);
				return !content.includes('WITH RECURSIVE') || !/dd_ontology/.test(content);
			} catch {
				return true;
			}
		});
		expect(staleWalk, `Stale RECURSIVE_WALK_RATCHET entries: ${staleWalk.join(', ')}`).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// T4 — subsystem-owned tables: one owning module per table family.
// ---------------------------------------------------------------------------

/**
 * The ACCEPT tier of DEC-09: these table families keep local SQL, owned by
 * exactly one module (plus src/core/db/, the T1 home, which may list table
 * names in its allowlist catalogs). Touching a family's tables from anywhere
 * else must go through the owner's exported API instead.
 */
const SUBSYSTEM_OWNED_TABLES: readonly {
	family: string;
	tablePattern: RegExp;
	owners: readonly string[];
	/** NAME-ONLY exemptions: files that mention the table name without any SQL
	 * against it (each entry must carry an inline reason at its family). */
	exempt?: readonly string[];
}[] = [
	{
		family: 'component locks',
		tablePattern: /dedalo_ts_component_locks/,
		owners: ['src/core/section/locks.ts'],
	},
	{
		family: 'diffusion jobs',
		tablePattern: /dedalo_ts_diffusion_job/,
		owners: ['src/diffusion/jobs/'],
	},
	{
		family: 'RAG (separate pgvector DB)',
		tablePattern: /rag_embeddings|rag_index_queue/,
		owners: ['src/ai/rag/'],
		// NAME-ONLY exemption (no SQL against the table): the suite-database
		// builder names the vendored schema FILE `install/db/rag_embeddings.sql`
		// in its docblock and its completion log line; the vector database itself
		// is rebuilt through src/ai/rag's exported API.
		exempt: ['scripts/test_db_setup.ts'],
	},
	{
		family: 'user activity stats',
		tablePattern: /matrix_stats/,
		owners: ['src/core/area_maintenance/user_stats.ts'],
		// NAME-ONLY exemptions (no SQL against the table): the projects-filter
		// exemption constant (PHP $ar_tables_skip_projects parity) lists
		// 'matrix_stats' as an excluded-from-ACL table name.
		exempt: [
			'src/core/search/sql_assembler.ts',
			// The suite-database builder's docblock inventories what the vendored
			// dump holds ("`matrix_stats` 2 rows") — prose, no SQL.
			'scripts/test_db_setup.ts',
		],
	},
	{
		family: 'error-report intake (WC-017)',
		tablePattern: /dedalo_ts_error_reports/,
		owners: ['src/core/error_report/store.ts'],
	},
	{
		// The engine records WHO started an agent session, because the site-builder
		// daemon's own SessionMeta has no owner field — so this table is the only
		// answer to "may this user drive that session", and a second module writing
		// it could hand one user another's running agent.
		family: 'site-builder session ownership (2026-08-24, P2-8b)',
		tablePattern: /dedalo_ts_sitebuilder_sessions/,
		owners: ['tools/tool_sitebuilder/server/session_owner.ts'],
	},
	{
		family: 'test-database marker (2026-08-19)',
		tablePattern: /dedalo_test_marker/,
		owners: [
			'src/core/test_data/test_database_marker.ts',
			// The literal's DB-FREE definition half (split 2026-08-25, D13): the same
			// owner module in two files, so scripts/test_db_setup.ts can name the
			// table through the constant without importing the pool.
			'src/core/test_data/test_database_marker_constants.ts',
		],
		// NAME-ONLY exemptions (no SQL against the table): two test-data doors
		// NAME the marker row in the comment that explains why they call
		// `assertTestDatabase()` first — the guard is the owner's exported API,
		// and naming the thing being asked for is what makes the comment useful.
		exempt: [
			'src/core/test_data/situations/situation.ts',
			'src/core/test_data/test_tld_materialize.ts',
			// The RAG marker guard (P1-16, 2026-08-30). It NAMES the matrix marker
			// once, in the docblock sentence that explains what it is a twin OF —
			// the matrix pool has a `dedalo_test_marker` row, the vector pool now
			// has its own equivalent, and the analogy is the whole reason the file
			// has the shape it does. It issues no SQL against the matrix table and
			// owns a different one.
			'src/ai/rag/test_rag_db.ts',
			// scripts/ entered the census 2026-09-02 (P2-20/S-3). Both name the
			// marker ROW in prose only: test_db_setup.ts's docblock says which step
			// stamps it (through the owner module), client_test_runner.ts's says
			// the `/health` fingerprint is derived from the same row this process
			// reads. Neither issues SQL against the table.
			'scripts/test_db_setup.ts',
			'scripts/client_test_runner.ts',
		],
	},
	{
		family: 'temporal scratch (WC-079)',
		tablePattern: /dedalo_ts_temporal_scratch/,
		owners: ['src/core/section/record/temporal_store.ts'],
	},
];

// ---------------------------------------------------------------------------
// T3 — behavioral gate for the canonical accessors themselves.
//
// The accessors exist so the 9 hand-rolled walks stop re-deciding semantics;
// this pins THE semantics: the sibling order/tiebreak policy, the DFS
// pre-order, the section-containment guard, and the virtual-section
// fallback. Scratch TLD 'zzw' rows only; purged in afterAll.
// ---------------------------------------------------------------------------

const SCRATCH_TLD = 'zzw';

function scratchNode(overrides: Partial<DdOntologyNode> & { tipo: string }): DdOntologyNode {
	return {
		tipo: overrides.tipo,
		parent: overrides.parent ?? null,
		term: overrides.term ?? null,
		model: overrides.model ?? null,
		order_number: overrides.order_number ?? null,
		relations: overrides.relations ?? null,
		tld: SCRATCH_TLD,
		properties: overrides.properties ?? null,
		model_tipo: overrides.model_tipo ?? null,
		is_model: overrides.is_model ?? false,
		is_translatable: overrides.is_translatable ?? false,
		is_main: overrides.is_main ?? false,
		propiedades: overrides.propiedades ?? null,
		machine_name: overrides.machine_name ?? null,
		use_machine_name: overrides.use_machine_name ?? false,
	};
}

afterAll(async () => {
	await deleteTldNodes(SCRATCH_TLD);
	clearOntologyCaches();
});

/**
 * Scratch subtree (order_number in parentheses; canonical sibling order is
 * order ASC nulls-last, tipo tiebreak):
 *
 *   zzw0 (section)
 *   ├─ zzw20 (2, section_group)   ── zzw21 (component_input_text, properties)
 *   ├─ zzw30 (2, section_group)              ← ties with zzw20 → tipo order
 *   └─ zzw10 (9, section)         ── zzw12 (component_filter)
 *                                     ↑ nested SECTION: returned, not descended
 *   zzw40 (section, relations→[zzw0])        ← virtual section, no own subtree (a tipo IN tld zzw — SURF-1 grammar)
 */
async function seedScratchSubtree(): Promise<void> {
	await upsertDdOntologyNode(scratchNode({ tipo: 'zzw0', model: 'section' }));
	await upsertDdOntologyNode(
		scratchNode({ tipo: 'zzw20', parent: 'zzw0', model: 'section_group', order_number: 2 }),
	);
	await upsertDdOntologyNode(
		scratchNode({ tipo: 'zzw30', parent: 'zzw0', model: 'section_group', order_number: 2 }),
	);
	await upsertDdOntologyNode(
		scratchNode({ tipo: 'zzw10', parent: 'zzw0', model: 'section', order_number: 9 }),
	);
	await upsertDdOntologyNode(
		scratchNode({
			tipo: 'zzw21',
			parent: 'zzw20',
			model: 'component_input_text',
			properties: { probe: 'value' },
		}),
	);
	await upsertDdOntologyNode(
		scratchNode({ tipo: 'zzw12', parent: 'zzw10', model: 'component_filter' }),
	);
	await upsertDdOntologyNode(
		scratchNode({ tipo: 'zzw40', model: 'section', relations: [{ tipo: 'zzw0' }] }),
	);
	clearOntologyCaches();
}

describe('T3 — canonical accessor semantics (one policy for all walks)', () => {
	test('compareSiblingOrder: order ASC, NULLs (Infinity) last, tipo tiebreak', () => {
		const items = [
			{ tipo: 'b', orderNumber: Number.POSITIVE_INFINITY },
			{ tipo: 'c', orderNumber: 1 },
			{ tipo: 'a', orderNumber: 2 },
			{ tipo: 'b2', orderNumber: 2 },
			{ tipo: 'a9', orderNumber: Number.POSITIVE_INFINITY },
		];
		expect([...items].sort(compareSiblingOrder).map((item) => item.tipo)).toEqual([
			'c',
			'a',
			'b2',
			'a9',
			'b',
		]);
	});

	test('getOrderedSubtree: DFS pre-order, canonical sibling order, section-bounded', async () => {
		await seedScratchSubtree();
		const walk = await getOrderedSubtree('zzw0');
		// zzw20/zzw30 tie on order 2 → tipo order; zzw10 (9) last; the nested
		// section zzw10 is RETURNED but not descended (zzw12 absent).
		expect(walk.map((node) => node.tipo)).toEqual(['zzw20', 'zzw21', 'zzw30', 'zzw10']);
		const crossing = await getOrderedSubtree('zzw0', { crossSections: true });
		expect(crossing.map((node) => node.tipo)).toEqual([
			'zzw20',
			'zzw21',
			'zzw30',
			'zzw10',
			'zzw12',
		]);
		const withRoot = await getOrderedSubtree('zzw0', { includeRoot: true });
		expect(withRoot[0]?.tipo).toBe('zzw0');
	});

	test('getChildrenNodes: direct children in canonical order', async () => {
		await seedScratchSubtree();
		const children = await getChildrenNodes('zzw0');
		expect(children.map((node) => node.tipo)).toEqual(['zzw20', 'zzw30', 'zzw10']);
	});

	test('getPropertiesByTipo: cached node properties; null for unknown', async () => {
		await seedScratchSubtree();
		expect(await getPropertiesByTipo('zzw21')).toEqual({ probe: 'value' });
		expect(await getPropertiesByTipo('zzw-none')).toBeNull();
	});

	test('findFirstDescendantTipoByModel: bounded walk + virtual-section fallback', async () => {
		await seedScratchSubtree();
		expect(await findFirstDescendantTipoByModel('zzw0', 'component_input_text')).toBe('zzw21');
		// The nested section's own component is NOT reachable from the parent walk…
		expect(await findFirstDescendantTipoByModel('zzw0', 'component_filter')).toBeNull();
		// …but IS from the nested section itself.
		expect(await findFirstDescendantTipoByModel('zzw10', 'component_filter')).toBe('zzw12');
		// Virtual section resolves through relations[0].tipo by default…
		expect(await findFirstDescendantTipoByModel('zzw40', 'component_input_text')).toBe('zzw21');
		// …and stays strict own-subtree when the caller opts out.
		expect(
			await findFirstDescendantTipoByModel('zzw40', 'component_input_text', {
				virtualFallback: false,
			}),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// T4 (companion) — src/external is SQL-FREE.
//
// The external subsystem reads the ontology through the resolver accessors and
// holds its rows in memory; it owns NO table. Stated as a gate because the
// tempting next step — "let's snapshot remote rows into a table so they survive
// a restart" — is a write path, and a write path that appeared inside an
// outbound subsystem would bypass matrix_write/json_codec and the TM audit
// entirely. When a snapshot store is genuinely wanted it gets its own owning
// module and its own T4 family row, in a change that has to edit THIS line.
// ---------------------------------------------------------------------------

describe('T4b — src/external owns no SQL', () => {
	test('no SQL statement, pool or table name under src/external/**', () => {
		const forbidden = [
			{
				name: 'SQL text',
				pattern: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/,
			},
			{ name: 'the sql proxy', pattern: /\bsql\s*(?:\.\s*unsafe\s*\(|`)/ },
			{ name: 'a pool', pattern: /\bnew\s+SQL\s*\(/ },
			{
				name: 'a matrix/dd table',
				pattern: /\b(?:matrix_[a-z_]+|dd_ontology|dedalo_ts_[a-z_]+)\b/,
			},
		];
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			if (!file.startsWith('src/external/')) continue;
			// Strip comments: the module headers legitimately discuss dd_ontology.
			// The shared, string-literal-aware stripper — a regex one could be made
			// to eat the rest of a line, and with it a real violation.
			const code = stripComments(read(file));
			for (const { name, pattern } of forbidden) {
				if (pattern.test(code)) violations.push(`${file}: ${name}`);
			}
		}
		expect(
			violations,
			`src/external must stay SQL-free — it reads the ontology through src/core/ontology accessors and owns no table: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('the scan actually covers the subsystem', () => {
		expect(
			sourceFiles().filter((file) => file.startsWith('src/external/')).length,
		).toBeGreaterThanOrEqual(9);
	});
});

describe('T4 — subsystem-owned table families', () => {
	for (const { family, tablePattern, owners, exempt } of SUBSYSTEM_OWNED_TABLES) {
		test(`${family}: tables referenced only by the owning module`, () => {
			const violations: string[] = [];
			for (const file of sourceFiles()) {
				if (file.startsWith('src/core/db/')) continue; // T1 home (name catalogs)
				if (owners.some((owner) => file === owner || file.startsWith(owner))) continue;
				if (exempt?.includes(file)) continue; // name-only, reasoned above
				if (tablePattern.test(read(file))) violations.push(file);
			}
			expect(
				violations,
				`'${family}' tables referenced outside owner ${owners.join(', ')} — call the owner's exported API: ${violations.join(', ')}`,
			).toEqual([]);
		});
	}
});
