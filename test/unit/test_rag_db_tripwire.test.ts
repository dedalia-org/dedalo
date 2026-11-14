/**
 * THE TEST-VECTOR-DATABASE TRIPWIRE — the THIRD shared surface of "a test never
 * writes production data" (DEC-12; audit 2026-08-26 REMEDIATION P1-16),
 * 2026-08-30.
 *
 * THE DEFECT THIS GATE MAKES UNREACHABLE. Until 2026-08-30 the suite wrote into
 * the INSTALLATION's vector database. Measured on this machine, 2026-08-29/30:
 * `src/ai/rag/vector_store.ts` built its pool's database name as
 * `readEnv('DEDALO_RAG_DB_NAME') ?? readString('RAG_DB_NAME')`;
 * `DEDALO_RAG_DB_NAME` was undefined and `RAG_DB_NAME` resolves to
 * `dedalo7_rag` — a real installation semantic index — and NOTHING in
 * `test/preload/` repointed it. `ragSql` is a SEPARATE pool from the matrix
 * pool, so it sat outside BOTH laws the project already had: the matrix
 * database's `dedalo_test_marker` row with `assertTestDatabase()`, and the media
 * tree's `.dedalo_test_media` file with `assertTestMediaRoot()`. The failing
 * INSERT that `test/unit/rag_api|rag_ask|rag_pipeline` produced on a machine
 * with no sidecar was not only a missing-embedding symptom: it was the PROOF
 * that `bun test` reached `dedalo7_rag` and wrote there — partition DDL,
 * upserts, and `DELETE FROM rag_embeddings`.
 *
 * (The index is rebuildable, unlike heritage masters or matrix rows. That makes
 * the damage repairable; it never makes the write allowed. A
 * `DELETE FROM rag_embeddings WHERE section_tipo = …` against a curator's live
 * index is a silent, hours-long re-embed nobody asked for, and on this machine
 * the embedding sidecar is a local model — on an installation it can be a paid
 * API.)
 *
 * THE MECHANISM, in one line: `DEDALO_TEST_RAG_DB_NAME` BOTH repoints `ragSql`
 * and ARMS a refusal, and every WRITE door of the store asks the connected
 * database for its `dedalo_test_rag_marker` row before its first statement
 * (`src/ai/rag/test_rag_db.ts`; `vector_store.ts` `buildRagSqlOptions`). One key
 * does both halves, exactly as `DEDALO_TEST_MEDIA_ROOT` does for the media
 * tree — so a run cannot be armed at the installation's index, nor repointed
 * with the guard asleep.
 *
 * SIX RULES, each with an anti-vacuity probe:
 *
 *  1. THE WRITE-DOOR INVENTORY IS DERIVED, not enumerated. Every top-level
 *     CALLABLE of `vector_store.ts` — a `function` declaration, a bound
 *     function, an arrow, expression-bodied or not — whose body carries a write
 *     statement (DML/DDL text, a module SQL constant that is a write, a
 *     transaction, or the partition stored procedure — comments stripped) must
 *     call `assertTestRagDatabase(` BEFORE that statement, or carry a named
 *     reason in `EXEMPT_DOORS`. A stale exemption is a failure: a dead exemption
 *     widens the law silently. The census is COMPLETE on two axes: no write
 *     statement in the file may sit outside every span the parser cuts (a
 *     backstop that turns an unparsed syntax into a RED instead of a silent
 *     pass — the hole an arrow-shaped door walked through on 2026-08-30), and
 *     the pool does not escape from the ENGINE, since no source under `src/`,
 *     `tools/` or `scripts/` outside `vector_store.ts` imports `ragSql`. (Tests
 *     and preloads DO import it — this gate itself does — which is why the
 *     escape check is scoped to engine sources and not to the whole tree.)
 *  2. THE REFUSAL IS PROVED ON REAL DATABASES, IN BOTH DIRECTIONS. Pointed at a
 *     real UNMARKED database the guard refuses, names the door, says nothing was
 *     written, and is READ BACK to prove it wrote nothing; pointed at a real
 *     MARKED one it returns. The marked target is built by the real producer
 *     inside a matrix transaction that is ROLLED BACK, so no database keeps a
 *     table this gate made. The misrouted-restore refusal (a marker naming
 *     ANOTHER database) is proved the same way, and so are both arming states:
 *     unarmed the guard issues NO query at all (proved with a connection that
 *     throws if touched — the property that makes it safe to ship, because
 *     production indexing can never be refused by it), armed it refuses.
 *  3. THE MARKER LITERALS HAVE EXACTLY ONE DEFINITION. No file re-types
 *     `dedalo_test_rag_marker` or the purpose sentence; every consumer imports
 *     them. (This is the media gate's rule 3 from the other side: there the two
 *     necessary spellings are asserted equal; here a second spelling is not
 *     necessary at all, so any second spelling is the failure.)
 *  4. THE SEAM IS ACTUALLY ON IN THIS PROCESS, and the database it names is a
 *     marked one that is NOT the installation's: the guard is armed, the pool's
 *     own `current_database()` IS the seam's database, that database carries the
 *     marker, and a REAL write door completes against it. Plus: the key is a
 *     declared `test_seam` catalog key (not a stray env read), and the seam is
 *     read in the ONE place the database is decided, ahead of both operator
 *     spellings.
 *  5. ONE SETTER PER TIER. `src/` and `tools/` set the key NEVER — production
 *     must not be able to arm itself. Exactly one file under `test/preload/`
 *     sets it, `bunfig.toml` registers that same file, and the assignment sits
 *     behind no `if` and no early `return` (arm first, provision second — a
 *     preload that sometimes arms is a preload that leaves the installation's
 *     index reachable on the day it does not). Exactly two files under
 *     `scripts/` set it: `scripts/test_db_setup.ts` (the builder) and
 *     `scripts/client_test_server.ts` (the client suite's OWN server, which
 *     otherwise read the installation's index — 2026-09-30). And there is ONE PRODUCER
 *     of the marker — `test/helpers/test_rag_database.ts`, the provisioner both
 *     tiers call: stamping a database "disposable" is provenance, claimable only
 *     by the code that just created it, and NO engine module may mint it.
 *  6. THE NAME IS DERIVED, NEVER ASSIGNED. Both tiers arm the seam from opposite
 *     sides of the database repoint, so both take the name from ONE derivation,
 *     `suiteRagDatabaseName(suiteDb)` — which refuses the installation's index
 *     by name (proved in BOTH directions, the vacuity that made the matrix
 *     twin's distinctness check useless for months) and gives each suite
 *     database, shard clones included, a vector database of its own.
 *
 * HONEST LIMITS, stated because a gate that hides them is worse than no gate.
 *
 * (a) The doors' refusal is proved on the REAL guard against REAL databases,
 *     and each door's WIRING is proved by derivation (rule 1, including the
 *     order of the call). It is not proved by making each door itself refuse:
 *     the pool is module-level and frozen at import, so the only way to make a
 *     door see an unmarked database mid-run would be to REMOVE the marker from
 *     the vector database this process shares with whatever else is running —
 *     the one mutation that could poison a concurrent run. The media gate can
 *     point its doors at a temp directory; a pool cannot be pointed anywhere.
 *     What binds instead is stronger than a name check: rule 4 proves the pool
 *     is on the seam's database and a real door completes there, and rule 1
 *     proves every door asks first.
 * (b) It covers the doors of the STORE. A test file holding `ragSql` and
 *     issuing raw DDL of its own (several do — `test/unit/rag_store.test.ts`
 *     drops a partition) bypasses the marker by construction, because raw pool
 *     access is not a door. Those writes are covered by the OTHER half of the
 *     one key: armed means REPOINTED, so they land in the test vector database
 *     whether or not they ask. Rule 5 is what keeps that half true.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SQL } from 'bun';
import { Glob } from 'bun';
import {
	assertTestRagDatabase,
	ragDatabaseIsMarked,
	readTestRagDatabaseMarker,
	requireTestRagDatabase,
	TEST_RAG_MARKER_PURPOSE,
	TEST_RAG_MARKER_TABLE,
	testRagDatabaseName,
	testRagGuardArmed,
	writeTestRagDatabaseMarker,
} from '../../src/ai/rag/test_rag_db.ts';
import { deleteRecordChunks, ragSql } from '../../src/ai/rag/vector_store.ts';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { NEW_IN_V7 } from '../../src/config/migration_map.ts';
import { readString } from '../../src/config/readers.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8');

/** The one module holding the pool, and therefore the one module with doors. */
const VECTOR_STORE = 'src/ai/rag/vector_store.ts';
/** The guard module — the only file entitled to name the marker literals. */
const GUARD_MODULE = 'src/ai/rag/test_rag_db.ts';

/** Every `.ts` under the engine + its scripts, repo-relative, tests excluded. */
function engineSources(): string[] {
	const files: string[] = [];
	for (const dir of ['src', 'tools', 'scripts']) {
		for (const match of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, dir) })) {
			if (match.endsWith('.test.ts')) continue;
			files.push(relative(REPO_ROOT, join(REPO_ROOT, dir, match)));
		}
	}
	return files.sort();
}

// ---------------------------------------------------------------------------
// RULE 1 — the write-door inventory, DERIVED from vector_store.ts.
// ---------------------------------------------------------------------------

/**
 * What makes a function body a WRITE. Text-level, comments stripped, so prose
 * about a delete never counts as one:
 *
 *  - the four DML/DDL families the store actually issues;
 *  - `.begin(` — this store opens a transaction only to write in it, and the
 *    statements inside it may live in a module constant (they do: the upsert),
 *    so the transaction itself is the honest marker of the flush;
 *  - `rag_create_model_partition` — a SELECT that is a DDL statement in
 *    disguise. A regex over SQL verbs alone would classify the partition
 *    provisioner as a READ and quietly excuse the exact door that leaves a
 *    stray partition on an installation's index.
 */
const WRITE_STATEMENTS: readonly RegExp[] = [
	/\bINSERT\s+INTO\b/i,
	/\bUPDATE\s+"?[a-z_]+"?\s+SET\b/i,
	/\bDELETE\s+FROM\b/i,
	/\bTRUNCATE\b/i,
	/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i,
	/\.begin\s*\(/,
	/\brag_create_model_partition\b/,
];

/** The guard call a write door must make, and the earliest write in its body. */
const GUARD_CALL = 'assertTestRagDatabase(';

/**
 * Module-level SQL constants that ARE writes, derived from the module itself.
 * `upsertEmbeddingRows` executes `UPSERT_ROW_SQL`, whose INSERT text lives
 * OUTSIDE the function — a body scan alone would not see it. Deriving the
 * constant set (rather than naming it) keeps a second extracted statement
 * covered the day someone extracts it. The SPAN is carried too, because the
 * coverage backstop below has to know that this INSERT is accounted for where
 * it is DECLARED, and is not an orphan write no callable owns.
 */
interface SqlConstant {
	name: string;
	start: number;
	end: number;
}

function writeSqlConstants(source: string): SqlConstant[] {
	const constants: SqlConstant[] = [];
	const pattern = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g;
	for (const match of source.matchAll(pattern)) {
		const [whole = '', name = '', body = ''] = match;
		if (!WRITE_STATEMENTS.some((rule) => rule.test(body))) continue;
		const start = match.index as number;
		constants.push({ name, start, end: start + whole.length });
	}
	return constants;
}

interface StoreFunction {
	name: string;
	body: string;
	start: number;
	end: number;
}

/**
 * The head of every top-level CALLABLE, WHATEVER ITS SYNTAX: a `function`
 * declaration, or a name BOUND to a function or an arrow
 * (`export const wipe = async (): Promise<void> => { … }`).
 *
 * The second alternative is not decoration. Until 2026-08-30 this census matched
 * `function` heads ONLY, and an arrow — the shape a contributor reaches for
 * first — was never cut into a body, so it was never classified and never asked
 * for the guard. PROVED by mutation that day: appending
 * `export const wipeEverything = async (): Promise<void> => { await
 * ragSql.unsafe('DELETE FROM rag_embeddings'); };` to the store left rule 1
 * GREEN — an unguarded full-table delete of an installation's index, invisible
 * to the gate written to forbid exactly that.
 */
const CALLABLE_HEAD =
	/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?(?:function\b|[(<]|\w+\s*=>)/gm;

/**
 * Where a head's body ends. The opener is the first `{` at paren/bracket depth
 * ZERO — destructured parameters and object-typed parameters put braces INSIDE
 * the parameter list, and taking those for the body cuts it off at the first
 * comma, hiding every statement after it. An arrow with an expression body has
 * no brace at all, so the statement's `;` closes it instead: an expression-bodied
 * `const wipe = () => ragSql.unsafe('DELETE …')` is a door too.
 */
function bodyEnd(source: string, start: number): number {
	let paren = 0;
	let bracket = 0;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (character === '(') paren += 1;
		else if (character === ')') paren -= 1;
		else if (character === '[') bracket += 1;
		else if (character === ']') bracket -= 1;
		else if (paren !== 0 || bracket !== 0) continue;
		else if (character === ';') return index + 1;
		else if (character === '{') {
			let depth = 0;
			for (let scan = index; scan < source.length; scan += 1) {
				if (source[scan] === '{') depth += 1;
				else if (source[scan] === '}') {
					depth -= 1;
					if (depth === 0) return scan + 1;
				}
			}
			return source.length;
		}
	}
	return source.length;
}

/**
 * Every top-level callable of the store, with its OWN body (comments stripped),
 * cut at its matching closing brace.
 *
 * NOT "from this head to the next head", which is the obvious slice and is
 * WRONG here in a way that silently inverts the gate: `UPSERT_ROW_SQL` is a
 * module-level constant declared BETWEEN `lexicalSearch` and `upsertRowParams`,
 * so a head-to-head slice hands its INSERT text to `lexicalSearch` — measured
 * 2026-08-30, the first run of this gate classified that SELECT-only door as an
 * unguarded write and demanded a marker check on a read. An over-eager
 * classifier does not merely produce a false red: the natural repair is to add
 * the guard, which gates reads by accident.
 */
function storeFunctions(source: string): StoreFunction[] {
	const functions: StoreFunction[] = [];
	for (const head of source.matchAll(CALLABLE_HEAD)) {
		const start = head.index as number;
		const end = bodyEnd(source, start);
		functions.push({
			name: (head[1] ?? head[2]) as string,
			body: source.slice(start, end),
			start,
			end,
		});
	}
	return functions;
}

/** The earliest index of a write in `body`, or -1 when there is none. */
function firstWriteIndex(body: string, sqlConstants: readonly string[]): number {
	let earliest = -1;
	const rules = [...WRITE_STATEMENTS, ...sqlConstants.map((name) => new RegExp(`\\b${name}\\b`))];
	for (const rule of rules) {
		const found = body.search(rule);
		if (found !== -1 && (earliest === -1 || found < earliest)) earliest = found;
	}
	return earliest;
}

/** Every raw write statement in the module, with the offset it sits at. */
function writeOccurrences(source: string): { text: string; index: number }[] {
	const found: { text: string; index: number }[] = [];
	for (const rule of WRITE_STATEMENTS) {
		const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
		for (const match of source.matchAll(new RegExp(rule.source, flags))) {
			found.push({ text: match[0], index: match.index as number });
		}
	}
	return found.sort((left, right) => left.index - right.index);
}

/** 1-based line of `index` in `source` — so an uncovered write can be found. */
function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

/**
 * Write doors that do NOT ask the guard, each with the reason. Reasons are facts
 * about what the function DOES, never "it looked safe". STALENESS IS FAILURE.
 */
const EXEMPT_DOORS: Readonly<Record<string, string>> = {
	// EMPTY, and that is the strongest state this map has: today every function
	// of the store that carries a statement asks the guard first. The map stays
	// because the alternative to an exemption WITH a reason is an exemption in
	// someone's head. `deleteRecord` is not listed — it carries no statement at
	// all (it is one call to `deleteRecordChunks`), so the classifier never
	// classifies it as a door and an entry here would be stale on arrival; the
	// delegation is asserted on its own below.
};

const STORE_SOURCE = stripComments(read(VECTOR_STORE));
const SQL_CONSTANTS = writeSqlConstants(STORE_SOURCE);
const SQL_CONSTANT_NAMES = SQL_CONSTANTS.map((constant) => constant.name);
const STORE_FUNCTIONS = storeFunctions(STORE_SOURCE);
const WRITE_DOORS = STORE_FUNCTIONS.filter(
	(fn) => firstWriteIndex(fn.body, SQL_CONSTANT_NAMES) !== -1,
);

describe('rule 1 — the write-door inventory is derived', () => {
	test('the classifier sees the doors we know about, and NOT the read doors', () => {
		// Anti-vacuity in both directions: a broken parser gives an empty
		// inventory (every assertion below passes over nothing), and an
		// over-eager classifier gives "every function is a write door" (which
		// would demand a guard on a SELECT and get one added, gating reads by
		// accident). Both are pinned.
		expect(STORE_FUNCTIONS.length).toBeGreaterThan(10);
		expect(
			SQL_CONSTANT_NAMES,
			'the upsert statement constant must be classified a write',
		).toContain('UPSERT_ROW_SQL');
		const names = WRITE_DOORS.map((fn) => fn.name);
		for (const door of [
			'ensureModelPartition',
			'replaceRecordChunks',
			'deleteRecordChunks',
			'ensureModelPartitionTyped',
			'upsertEmbeddingRows',
			'deleteStale',
			'deleteRecordModality',
		]) {
			expect(names, `${door} must be classified as a WRITE door`).toContain(door);
		}
		for (const reader of [
			'denseSearch',
			'lexicalSearch',
			'diffHashes',
			'getRecordVectors',
			'queryDense',
			'lexicalQuery',
			'listSectionIds',
		]) {
			expect(names, `${reader} reads — the law is about writes`).not.toContain(reader);
		}
	});

	test('the classifier cuts a body out of EVERY callable syntax (mutation control)', () => {
		// The hole this control pins closed, measured 2026-08-30: a `function`-only
		// head pattern never cut an arrow into a body, so an unguarded
		// `DELETE FROM rag_embeddings` written as `export const … = async () => {}`
		// was classified as nothing at all and rule 1 stayed green. Every form is
		// fed through the REAL parser here, including the two that break a naive
		// brace search — destructured parameters (whose `{` is not the body) and an
		// expression body (which has no `{`).
		const synthetic = [
			"export const wipeEverything = async (): Promise<void> => {\n\tawait ragSql.unsafe('DELETE FROM rag_embeddings');\n};",
			"const wipeTwo = function (): void {\n\tragSql.unsafe('TRUNCATE rag_embeddings');\n};",
			'export const wipeThree = ({ model }: { model: string }): void => {\n\tragSql.unsafe(`DROP TABLE ${model}`);\n};',
			"export const wipeFour = () => ragSql.unsafe('DELETE FROM rag_embeddings');",
			"export async function wipeFive(): Promise<void> {\n\tawait ragSql.unsafe('DELETE FROM rag_embeddings');\n}",
		].join('\n\n');
		const parsed = storeFunctions(synthetic);
		expect(parsed.map((fn) => fn.name)).toEqual([
			'wipeEverything',
			'wipeTwo',
			'wipeThree',
			'wipeFour',
			'wipeFive',
		]);
		for (const fn of parsed) {
			expect(
				firstWriteIndex(fn.body, SQL_CONSTANT_NAMES),
				`${fn.name} must be cut into a body that still holds its statement`,
			).not.toBe(-1);
		}
		// And a bound value that is NOT a callable stays out of the census, or the
		// module's own `export const ragSql = new SQL(…)` would be a phantom door.
		expect(storeFunctions('export const ragSql = new SQL(buildRagSqlOptions());')).toEqual([]);
	});

	test('EVERY write statement in the module lands inside something classified', () => {
		// The backstop that makes rule 1 fail-CLOSED. The rules above only speak
		// about text the parser managed to cut into a body; a syntax it does not
		// understand (a class method, a generic arrow, a callable this pattern
		// never anticipated) would carry its statement outside every span and be
		// judged by nothing. So every write occurrence in the file must sit inside
		// a classified callable, or inside the module SQL constant that declares
		// it. An orphan is a RED that demands the census be widened — never a
		// silent pass.
		const spans = [...STORE_FUNCTIONS, ...SQL_CONSTANTS];
		const orphans = writeOccurrences(STORE_SOURCE)
			.filter((write) => !spans.some((span) => write.index >= span.start && write.index < span.end))
			.map((write) => `${write.text.trim()} (line ${lineOf(STORE_SOURCE, write.index)})`);
		expect(
			orphans,
			`These write statements in ${VECTOR_STORE} belong to no callable this census can cut a body from — widen CALLABLE_HEAD/bodyEnd until they do, so the guard rule above can judge them: ${orphans.join(', ')}`,
		).toEqual([]);
		// Anti-vacuity: the occurrence scan really finds the module's statements.
		expect(writeOccurrences(STORE_SOURCE).length).toBeGreaterThan(5);
	});

	test('every write door asks the guard BEFORE its first statement', () => {
		const offenders: string[] = [];
		for (const door of WRITE_DOORS) {
			if (EXEMPT_DOORS[door.name] !== undefined) continue;
			const guardAt = door.body.indexOf(GUARD_CALL);
			const writeAt = firstWriteIndex(door.body, SQL_CONSTANT_NAMES);
			if (guardAt === -1) {
				offenders.push(`${door.name} (no ${GUARD_CALL} call)`);
				continue;
			}
			// ORDER IS THE WHOLE POINT: a guard asked after the statement has
			// already run refuses a write that happened, and the "NOTHING WAS
			// WRITTEN" sentence in its message becomes a lie.
			if (guardAt > writeAt) offenders.push(`${door.name} (guard asked AFTER the statement)`);
		}
		expect(
			offenders,
			`These vector-store functions write without asking '${TEST_RAG_MARKER_TABLE}' first. Call await assertTestRagDatabase(ragSql, '<door>') before the statement, or add an entry to EXEMPT_DOORS saying what the function does instead: ${offenders.join(', ')}`,
		).toEqual([]);
	});

	test('no exemption is stale', () => {
		const live = new Set(WRITE_DOORS.map((fn) => fn.name));
		const stale = Object.keys(EXEMPT_DOORS).filter((name) => !live.has(name));
		expect(
			stale,
			`Exempt functions that no longer write (or no longer exist). Delete the entry — a dead exemption widens the law silently: ${stale.join(', ')}`,
		).toEqual([]);
	});

	test('every exemption carries a substantive reason', () => {
		const thin = Object.entries(EXEMPT_DOORS)
			.filter(([, reason]) => reason.trim().length < 40)
			.map(([name]) => name);
		expect(thin, `An exemption reason must say what the function DOES: ${thin.join(', ')}`).toEqual(
			[],
		);
	});

	test('the one delegating wrapper adds no statement of its own', () => {
		// `deleteRecord` is the shape that would otherwise slip past a body-level
		// classifier: it deletes a record's vectors and never names a statement.
		// It is safe BECAUSE it delegates, so that is what is asserted — it holds
		// no SQL of its own, and it reaches a door that does ask the guard. If it
		// ever grows a statement, rule 1 classifies it as a door the same day and
		// demands its own assert.
		const wrapper = STORE_FUNCTIONS.find((fn) => fn.name === 'deleteRecord');
		expect(wrapper, 'deleteRecord disappeared — re-derive this rule').toBeDefined();
		const body = (wrapper as StoreFunction).body;
		expect(firstWriteIndex(body, SQL_CONSTANT_NAMES)).toBe(-1);
		expect(body).toContain('deleteRecordChunks(');
		const delegate = STORE_FUNCTIONS.find((fn) => fn.name === 'deleteRecordChunks');
		expect((delegate as StoreFunction).body).toContain(GUARD_CALL);
	});

	test('the pool does not escape the store — so the door census is complete', () => {
		// `ragSql` is exported, and every guarantee above is about functions in
		// ONE file. A module elsewhere holding the pool would write outside the
		// census entirely, and rule 1 would go on passing while proving nothing
		// about that module. Measured 2026-08-30: no engine source outside the
		// store IMPORTS it.
		// Matched on the IMPORT CLAUSE, not on any mention, and that distinction is
		// load-bearing rather than pedantic: `ragSql` is a module-level export, so an
		// import is the only way to HOLD it, while several engine sources merely NAME
		// it in prose — scripts/unit_baseline.ts inside a baseline REASON string, and
		// scripts/test_db_setup.ts twice in comments about this very guard. Those are
		// prose about the defect, which stripComments cannot strip, and none of them
		// is an escape.
		const holders = engineSources().filter(
			(file) =>
				file !== VECTOR_STORE &&
				file !== GUARD_MODULE &&
				/import\s*(?:type\s*)?\{[^}]*\bragSql\b[^}]*\}/.test(stripComments(read(file))),
		);
		expect(
			holders,
			`Only ${VECTOR_STORE} may hold the RAG pool — a module that imports \`ragSql\` writes outside every door this gate derives: ${holders.join(', ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 2 — the refusal, on REAL databases, in BOTH directions.
// ---------------------------------------------------------------------------

/**
 * The UNMARKED target is the suite's MATRIX database: a real, reachable
 * Postgres database that is disposable (it carries `dedalo_test_marker`) and
 * that categorically does not carry the RAG marker. Using it rather than the
 * vector database is deliberate — proving the refusal must never require
 * removing the marker from a database another process may be indexing into.
 */
async function matrixDatabaseName(): Promise<string> {
	const rows = (await sql.unsafe('SELECT current_database() AS live')) as { live: string }[];
	return rows[0]?.live ?? '';
}

/** Is the RAG marker table present on the matrix connection right now? */
async function ragMarkerTablePresent(): Promise<boolean> {
	const rows = (await sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS present', [
		`public.${TEST_RAG_MARKER_TABLE}`,
	])) as { present: boolean }[];
	return rows[0]?.present === true;
}

/** A connection that FAILS if it is used at all — the "no query issued" probe. */
const untouchableSql = {
	unsafe: () => {
		throw new Error('the guard queried a database it was not armed for');
	},
} as unknown as SQL;

/** The message of a refusal, or null when the call did not refuse. */
async function refusalOf(probe: () => Promise<unknown>): Promise<string | null> {
	try {
		await probe();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Run `probe` inside a matrix transaction that is ALWAYS rolled back. */
async function inRolledBackTransaction<T>(probe: () => Promise<T>): Promise<T> {
	const rollback = new Error('test_rag_db_tripwire: intentional rollback');
	let captured: T | undefined;
	try {
		await withTransaction(async () => {
			captured = await probe();
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}
	return captured as T;
}

describe('rule 2 — the guard refuses an unmarked vector database, and writes nothing', () => {
	test('the unmarked target is real, reachable and legitimately writable (anti-vacuity)', async () => {
		// The probe surface must itself be a declared-disposable database: this
		// gate creates the marker table on it inside a rolled-back transaction
		// below, and "DB writes in tests only on scratch surfaces" has no
		// exception for a tripwire.
		await assertTestDatabase('test_rag_db_tripwire');
		expect(await matrixDatabaseName()).not.toBe('');
		expect(await ragMarkerTablePresent()).toBe(false);
	});

	test('requireTestRagDatabase REFUSES, names the door, and wrote NOTHING', async () => {
		const before = await ragMarkerTablePresent();
		const message = await refusalOf(async () =>
			requireTestRagDatabase(sql, 'test_rag_db_tripwire probe'),
		);
		expect(message, 'the guard did NOT refuse an unmarked database').not.toBeNull();
		expect(message).toContain('test_rag_db_tripwire probe');
		expect(message).toContain(TEST_RAG_MARKER_TABLE);
		expect(message).toContain('REFUSING');
		expect(message).toContain('NOTHING WAS WRITTEN');
		// It names the database it refused, which is what makes the message
		// actionable when a run is pointed somewhere unexpected.
		expect(message).toContain(await matrixDatabaseName());
		// The load-bearing half: the refusal happened before any statement — the
		// guard did not "helpfully" create the marker it was missing.
		expect(before).toBe(false);
		expect(await ragMarkerTablePresent()).toBe(false);
		expect(await ragDatabaseIsMarked(sql)).toBe(false);
	});

	test('the SAME database, MARKED by the real producer, is accepted (the other direction)', async () => {
		// A guard nobody proves in both directions may be refusing for some other
		// reason — an unreachable database, a typo'd table name — or not refusing
		// at all. The marker is written by the REAL producer
		// (`writeTestRagDatabaseMarker`, the one `test:db:setup` calls) inside a
		// transaction that is rolled back, so the probe leaves no table behind.
		const outcome = await inRolledBackTransaction(async () => {
			const marker = await writeTestRagDatabaseMarker(sql, {
				build_stamp: new Date().toISOString(),
				git_rev: 'test_rag_db_tripwire',
			});
			return {
				marker,
				marked: await ragDatabaseIsMarked(sql),
				refusal: await refusalOf(async () => requireTestRagDatabase(sql, 'probe')),
				armedRefusal: await refusalOf(async () => assertTestRagDatabase(sql, 'probe')),
			};
		});
		expect(outcome.marker.database_name).toBe(await matrixDatabaseName());
		expect(outcome.marked).toBe(true);
		expect(outcome.refusal, 'a marked database must be accepted').toBeNull();
		expect(outcome.armedRefusal).toBeNull();
		// And the rollback really happened: this gate never leaves a marker on a
		// database it did not build.
		expect(await ragMarkerTablePresent()).toBe(false);
	});

	test('a marker naming ANOTHER database refuses LOUDER than an absent one', async () => {
		// The misrouted restore: a dump of the test vector database restored into
		// the installation's would carry the marker with it. An absence is
		// ambiguous; a marker naming somewhere else is a fact about a mistake, so
		// it must refuse rather than authorize.
		const foreign = 'dedalo7_rag';
		const message = await inRolledBackTransaction(async () => {
			await writeTestRagDatabaseMarker(sql, {
				build_stamp: new Date().toISOString(),
				git_rev: 'test_rag_db_tripwire',
			});
			await sql.unsafe(`UPDATE "${TEST_RAG_MARKER_TABLE}" SET database_name = $1 WHERE id = 1`, [
				foreign,
			]);
			return refusalOf(async () => readTestRagDatabaseMarker(sql));
		});
		expect(message, 'a foreign marker must refuse, not return null').not.toBeNull();
		expect(message).toContain(foreign);
		expect(message).toContain(await matrixDatabaseName());
		expect(await ragMarkerTablePresent()).toBe(false);
	});

	test('a table whose purpose sentence is not ours is refused', async () => {
		// The purpose is a CHECK constraint precisely so it cannot be reproduced
		// by accident; this proves the READER enforces it too, so a hand-made
		// `dedalo_test_rag_marker` (no constraint, plausible-looking row) does not
		// authorize a single write.
		const message = await inRolledBackTransaction(async () => {
			await sql.unsafe(`CREATE TABLE "${TEST_RAG_MARKER_TABLE}" (
				id integer PRIMARY KEY, purpose text NOT NULL, database_name text NOT NULL,
				build_stamp text NOT NULL, git_rev text NOT NULL)`);
			await sql.unsafe(
				`INSERT INTO "${TEST_RAG_MARKER_TABLE}" VALUES (1, 'looks disposable to me', current_database(), 'x', 'y')`,
			);
			return refusalOf(async () => readTestRagDatabaseMarker(sql));
		});
		expect(message, 'a hand-made marker row must be refused').not.toBeNull();
		expect(message).toContain(TEST_RAG_MARKER_TABLE);
		expect(await ragMarkerTablePresent()).toBe(false);
	});
});

describe('rule 2b — arming: one key, two states, no query when unarmed', () => {
	/** `test/` composes process environments; the `process.env` ban covers `src/`+`tools/`. */
	function withSeam<T>(value: string | undefined, probe: () => T): T {
		const saved = process.env.DEDALO_TEST_RAG_DB_NAME;
		try {
			if (value === undefined) delete process.env.DEDALO_TEST_RAG_DB_NAME;
			else process.env.DEDALO_TEST_RAG_DB_NAME = value;
			return probe();
		} finally {
			if (saved === undefined) delete process.env.DEDALO_TEST_RAG_DB_NAME;
			else process.env.DEDALO_TEST_RAG_DB_NAME = saved;
		}
	}

	test('UNARMED: the assert issues no query at all and never refuses', async () => {
		// THE PROPERTY THAT MAKES THIS SAFE TO SHIP. On an installation the key is
		// unset, and indexing must behave exactly as it did before the guard
		// existed — no extra round trip, and above all no refusal. Proved with a
		// connection that throws the moment it is touched, so "it did not query"
		// is a fact rather than an inference from a passing call.
		await withSeam(undefined, async () => {
			expect(testRagGuardArmed()).toBe(false);
			expect(testRagDatabaseName()).toBeNull();
			await assertTestRagDatabase(untouchableSql, 'production indexer');
		});
	});

	test('ARMED: the same call on the same unmarked database refuses', async () => {
		const message = await withSeam('dedalo_rag_tripwire_probe', async () => {
			expect(testRagGuardArmed()).toBe(true);
			return refusalOf(async () => assertTestRagDatabase(sql, 'armed probe'));
		});
		expect(message, 'armed + unmarked must refuse').not.toBeNull();
		expect(message).toContain('armed probe');
		expect(message).toContain('NOTHING WAS WRITTEN');
	});

	test('an EMPTY key is not armed (an unset variable spelled the other way)', () => {
		withSeam('', () => {
			expect(testRagDatabaseName()).toBeNull();
			expect(testRagGuardArmed()).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// RULE 3 — the marker literals have exactly ONE definition.
// ---------------------------------------------------------------------------

/**
 * Everywhere a marker spelling could live: the engine, its scripts, and the two
 * test directories that compose a run. `test/unit/**` is excluded on purpose —
 * a gate asserting the constant's value (this file does, above) is not a second
 * definition of it.
 */
function markerNamingSources(): string[] {
	return [
		...engineSources(),
		...[...new Glob('*.ts').scanSync({ cwd: join(REPO_ROOT, 'test', 'helpers') })].map(
			(name) => `test/helpers/${name}`,
		),
		...PRELOAD_FILES,
	].sort();
}

/** The table name AS SQL: after a SQL keyword, optionally quoted or schema-qualified. */
function sqlSpellingMatcher(): RegExp {
	return new RegExp(
		`(?:FROM|INTO|TABLE|UPDATE|JOIN|regclass\\()\\s*(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?['"\`]?(?:public\\.)?"?${TEST_RAG_MARKER_TABLE}`,
		'i',
	);
}

describe('rule 3 — one spelling of the marker, imported everywhere', () => {
	test('the constants are what this gate and the setup script pin', () => {
		expect(TEST_RAG_MARKER_TABLE).toBe('dedalo_test_rag_marker');
		expect(TEST_RAG_MARKER_PURPOSE.length).toBeGreaterThan(80);
		expect(TEST_RAG_MARKER_PURPOSE).toContain('DISPOSABLE');
	});

	test('the SQL-spelling matcher is not vacuous (positive and negative controls)', () => {
		const inSql = sqlSpellingMatcher();
		for (const spelling of [
			`SELECT 1 FROM ${TEST_RAG_MARKER_TABLE}`,
			`select * from "${TEST_RAG_MARKER_TABLE}" where id = 1`,
			`INSERT INTO "${TEST_RAG_MARKER_TABLE}" VALUES (1)`,
			`CREATE TABLE IF NOT EXISTS ${TEST_RAG_MARKER_TABLE} (`,
			`DROP TABLE IF EXISTS "${TEST_RAG_MARKER_TABLE}"`,
			`UPDATE ${TEST_RAG_MARKER_TABLE} SET database_name = current_database()`,
			`to_regclass('public.${TEST_RAG_MARKER_TABLE}')`,
		]) {
			expect(inSql.test(spelling), `must be seen as a SQL spelling: ${spelling}`).toBe(true);
		}
		for (const prose of [
			`marked '${TEST_RAG_MARKER_TABLE}'; the installation's index is untouched`,
			`it carries no ${TEST_RAG_MARKER_TABLE} row, so it has not declared itself`,
			`arms the ${TEST_RAG_MARKER_TABLE} refusal — one key`,
		]) {
			expect(inSql.test(prose), `explaining the guard is not defining it: ${prose}`).toBe(false);
		}
		// And the corpus is real: the two test tiers and the engine are all in it.
		const corpus = markerNamingSources();
		expect(corpus.length).toBeGreaterThan(100);
		expect(corpus).toContain('test/helpers/test_rag_database.ts');
		expect(corpus).toContain(GUARD_MODULE);
	});

	test('no other source re-types the table name INTO SQL, or the purpose at all', () => {
		// A marker whose name is spelled twice is a marker that eventually gets
		// CHECKED in one place and WRITTEN in the other. Unlike the media marker
		// (whose preload-safe copy is forced by an import-ordering constraint),
		// nothing here is prevented from importing the constant — so a second
		// spelling is never necessary, and therefore never allowed.
		//
		// "Spelling" means IN SQL: the name after FROM/INTO/TABLE/UPDATE/JOIN, or
		// schema-qualified. Naming the table in operator DOCUMENTATION (the
		// catalog's `doc` for DEDALO_TEST_RAG_DB_NAME) or in a log line ("marked
		// 'dedalo_test_rag_marker'") is the guard EXPLAINING itself, not a second
		// definition — and both are strings, which no comment stripper removes.
		// The purpose sentence has no such legitimate second home, so it is
		// matched literally.
		const inSql = sqlSpellingMatcher();
		const retypers = markerNamingSources().filter((file) => {
			if (file === GUARD_MODULE) return false;
			const code = stripComments(read(file));
			return inSql.test(code) || code.includes(TEST_RAG_MARKER_PURPOSE);
		});
		expect(
			retypers,
			`Only ${GUARD_MODULE} may spell the marker literals — import TEST_RAG_MARKER_TABLE / TEST_RAG_MARKER_PURPOSE instead: ${retypers.join(', ')}`,
		).toEqual([]);
	});

	test('no install seed or migration creates the marker table', () => {
		// Property 1 of the marker's header: there is NO OTHER PRODUCER. A seed or
		// migration that created it would stamp every installation's vector
		// database as disposable.
		//
		// The corpus is DERIVED — every `.sql` under install/db/, not just
		// migrations/. `install/db/rag_embeddings.sql` is the vector-store schema
		// applied to EVERY vector database there is: an operator's real semantic
		// index (docs/administration/ai/rag_cookbook.md) and the suite's alike
		// (test/helpers/test_rag_database.ts). Planting the marker DDL there would
		// declare every installation's index disposable and authorize every write
		// this gate exists to refuse — with a migrations-only scan still green.
		const seeds = [
			...new Glob('**/*.sql').scanSync({ cwd: join(REPO_ROOT, 'install', 'db') }),
		].sort();
		expect(seeds, 'install/db/ holds no .sql at all — this scan would prove nothing').not.toEqual(
			[],
		);
		expect(seeds, 'the vector-store schema seed must be INSIDE the scanned corpus').toContain(
			'rag_embeddings.sql',
		);
		expect(
			seeds.some((file) => file.startsWith('migrations/')),
			'the matrix migrations must be inside the scanned corpus',
		).toBe(true);
		const producers = seeds.filter((file) =>
			readFileSync(join(REPO_ROOT, 'install', 'db', file), 'utf-8').includes(TEST_RAG_MARKER_TABLE),
		);
		expect(
			producers,
			`No install seed or migration may mark a database as disposable — only the suite's provisioner may: ${producers.join(', ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 4 — the seam is ON in THIS process, and points at a marked test index.
// ---------------------------------------------------------------------------

describe('rule 4 — this run is armed, on a marked vector database', () => {
	test('the guard is armed and the seam names a database', () => {
		expect(
			testRagGuardArmed(),
			"DEDALO_TEST_RAG_DB_NAME is not set in this process: the suite's vector writes are reaching whatever RAG_DB_NAME resolves to — on this machine, the installation's index. The `bun test` preload must set it UNCONDITIONALLY.",
		).toBe(true);
		expect(testRagDatabaseName()).not.toBe('');
	});

	test('the seam is NOT the installation vector database', () => {
		const installation = readString('RAG_DB_NAME');
		expect(installation, 'RAG_DB_NAME must resolve, or this comparison proves nothing').not.toBe(
			'',
		);
		expect(testRagDatabaseName()).not.toBe(installation);
	});

	test('the POOL is on the seam database — asked of the connection itself', async () => {
		// Not "the key is set" and not "the options object says so": the pool is
		// built once at import from `buildRagSqlOptions()`, and the only proof
		// that the seam actually moved it is the connection's own answer.
		const rows = (await ragSql.unsafe('SELECT current_database() AS live', [])) as {
			live: string;
		}[];
		const seam = testRagDatabaseName();
		expect(seam).not.toBeNull();
		expect(rows[0]?.live).toBe(seam as string);
	});

	test('that database carries the marker, and a REAL write door completes on it', async () => {
		expect(
			await ragDatabaseIsMarked(ragSql),
			`the suite vector database carries no '${TEST_RAG_MARKER_TABLE}' row — build it with 'bun run test:db:setup'`,
		).toBe(true);
		// The positive direction on a REAL door of the store: it passes the guard
		// and its DELETE runs. The locator is a generic-`test`-TLD section tipo
		// with an id no fixture mints, so the statement matches nothing — the
		// point is that the door was allowed through, on the database rule 4 has
		// just proved is the disposable one.
		await deleteRecordChunks('test2', 987654321);
	});

	test('the key is a declared, classified config key (not a stray env read)', () => {
		expect(CONFIG_CATALOG.DEDALO_TEST_RAG_DB_NAME).toBeDefined();
		expect(CONFIG_CATALOG.DEDALO_TEST_RAG_DB_NAME?.scope).toBe('test_seam');
		expect([...NEW_IN_V7]).toContain('DEDALO_TEST_RAG_DB_NAME');
	});

	test('the seam is read where the database is DECIDED, ahead of both operator keys', () => {
		// One key repoints AND arms only if the repoint happens in the single
		// place the pool's database is chosen. Read anywhere else, a process could
		// be armed while the pool still pointed at the installation's index.
		const store = stripComments(read(VECTOR_STORE));
		const seamAt = store.indexOf('testRagDatabaseName()');
		const dedaloAt = store.indexOf("readEnv('DEDALO_RAG_DB_NAME')");
		const legacyAt = store.indexOf("readString('RAG_DB_NAME')");
		expect(seamAt).toBeGreaterThan(-1);
		expect(dedaloAt).toBeGreaterThan(-1);
		expect(legacyAt).toBeGreaterThan(-1);
		expect(seamAt).toBeLessThan(dedaloAt);
		expect(dedaloAt).toBeLessThan(legacyAt);
	});
});

// ---------------------------------------------------------------------------
// RULE 5 — one setter per tier, one producer of the marker.
// ---------------------------------------------------------------------------

/** Does this source SET the seam key? (Reading it, or naming it in prose, is not setting it.) */
function setsSeamKey(source: string): boolean {
	return /process\.env\.DEDALO_TEST_RAG_DB_NAME\s*=/.test(stripComments(source));
}

const PRELOAD_FILES = [...new Glob('*.ts').scanSync({ cwd: join(REPO_ROOT, 'test', 'preload') })]
	.map((name) => `test/preload/${name}`)
	.sort();

describe('rule 5 — one setter per tier', () => {
	test('the setter matcher is not vacuous (positive control)', () => {
		expect(setsSeamKey('process.env.DEDALO_TEST_RAG_DB_NAME = name;')).toBe(true);
		expect(setsSeamKey('process.env.DEDALO_TEST_RAG_DB_NAME=db')).toBe(true);
		expect(setsSeamKey('// never set DEDALO_TEST_RAG_DB_NAME = x\n')).toBe(false);
		expect(setsSeamKey('const db = process.env.DEDALO_TEST_RAG_DB_NAME ?? "";')).toBe(false);
		expect(PRELOAD_FILES.length).toBeGreaterThan(3);
		expect(engineSources().length).toBeGreaterThan(100);
	});

	test('NO engine source arms itself — the key is set from the test tiers only', () => {
		// A `src/` or `tools/` file setting the key would arm the guard inside a
		// SERVING process, where a legitimately unmarked installation index would
		// then refuse every index write. The seam is a property of a RUN, never of
		// the engine.
		const offenders = engineSources().filter(
			(file) => !file.startsWith('scripts/') && setsSeamKey(read(file)),
		);
		expect(
			offenders,
			`Production code must never arm the test-vector-database seam: ${offenders.join(', ')}`,
		).toEqual([]);
	});

	test('EXACTLY ONE preload sets it, and bunfig.toml registers that file', () => {
		const setters = PRELOAD_FILES.filter((file) => setsSeamKey(read(file)));
		expect(
			setters,
			`Exactly one file under test/preload/ must set DEDALO_TEST_RAG_DB_NAME — UNCONDITIONALLY, because a preload that sometimes arms the guard is a preload that leaves the installation's vector database reachable on the day it does not. Found: ${setters.join(', ') || '(none)'}`,
		).toHaveLength(1);
		const preload = setters[0] as string;
		const bunfig = read('bunfig.toml');
		expect(
			bunfig.includes(`"./${preload}"`),
			`${preload} sets the seam but bunfig.toml does not preload it, so no test run is armed`,
		).toBe(true);
	});

	test('the preload arms UNCONDITIONALLY — no branch can leave the key unset', () => {
		// The media preload's law, and the reason it survives a failure to build
		// the root: an armed guard on a missing/unmarked database refuses every
		// vector write naming itself, which is the correct outcome. Leaving the
		// key unset hands the run the installation's index instead. Mechanically:
		// the assignment may not be the consequent of an `if`, and it may not be
		// guarded by an early `return`.
		const preload = PRELOAD_FILES.filter((file) => setsSeamKey(read(file)))[0] as string;
		const code = stripComments(read(preload));
		const assignAt = code.search(/process\.env\.DEDALO_TEST_RAG_DB_NAME\s*=/);
		expect(assignAt).toBeGreaterThan(-1);
		const before = code.slice(0, assignAt);
		expect(
			/\bif\s*\([^)]*\)\s*\{?\s*$/.test(before.trimEnd()),
			'the arming assignment must not sit behind an `if` — arm first, then repair',
		).toBe(false);
		expect(
			/\breturn\b/.test(before),
			'the preload must not be able to return before arming the guard',
		).toBe(false);
	});

	test('EXACTLY TWO scripts set it: the suite builder and the client suite server', () => {
		// client_test_server.ts arms the spawned server beside its DB_NAME and media
		// repoint — without it that server's ragSql resolved to the installation's
		// semantic index (test_db_marker_tripwire rule 6b proves the outcome).
		const setters = engineSources().filter(
			(file) => file.startsWith('scripts/') && setsSeamKey(read(file)),
		);
		expect(setters).toEqual(['scripts/client_test_server.ts', 'scripts/test_db_setup.ts']);
	});

	test('ONE PRODUCER of the marker, and it is not in the engine', () => {
		// Stamping a database "disposable" is provenance: it may be claimed ONLY
		// by the code that just created that database. `test:db:setup` and the
		// preload both reach it through the same provisioner, so the producer is
		// ONE file — and it is a test-tier file, because an engine module able to
		// mint the row could stamp an installation's index and authorize every
		// write this gate exists to refuse.
		const producers = markerNamingSources().filter(
			(file) =>
				file !== GUARD_MODULE && stripComments(read(file)).includes('writeTestRagDatabaseMarker'),
		);
		expect(
			producers,
			`Only the suite's vector-database provisioner may stamp a database as disposable: ${producers.join(', ')}`,
		).toEqual(['test/helpers/test_rag_database.ts']);
		expect(
			producers.filter((file) => file.startsWith('src/') || file.startsWith('tools/')),
			'no engine module may mint marker provenance',
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 6 — the suite's vector database NAME is DERIVED, never assigned.
// ---------------------------------------------------------------------------

/**
 * WHY THIS RULE EXISTS. Rule 5 pins WHO may set the key; this pins WHAT they may
 * set it to. Two tiers arm the seam — the `bun test` preload and
 * `scripts/test_db_setup.ts` — and they sit on OPPOSITE SIDES of the database
 * repoint (`test/preload/test_database.ts` rewrites `DB_NAME` mid-preload). If
 * each composed the vector database name in its own words, the builder would
 * create one database and the run would write to another: `bun run test:db:setup`
 * would report a rebuilt, marked fixture while `bun test` refused every vector
 * write against a name nobody had built — or, worse, found an unmarked database
 * sitting there.
 *
 * That is the measured `<app>_test_test` debris of the media seam (see
 * test_media_root_tripwire's rule 6 header) transposed onto a database, so the
 * answer is the same one: ONE derivation, `suiteRagDatabaseName(suiteDb)`, which
 * both tiers call with the suite database they resolved, and which REFUSES the
 * installation's index by name before returning.
 */

describe('rule 6 — the name comes from ONE derivation, and it refuses the install index', () => {
	test('every setter derives the name — none composes one of its own', async () => {
		const helper = 'test/helpers/test_rag_database.ts';
		const preload = PRELOAD_FILES.filter((file) => setsSeamKey(read(file)))[0] as string;
		const scriptSetters = engineSources().filter(
			(file) => file.startsWith('scripts/') && setsSeamKey(read(file)),
		);
		expect(scriptSetters.length).toBeGreaterThan(0);
		for (const file of [preload, ...scriptSetters]) {
			const code = stripComments(read(file));
			expect(code, `${file} must derive the name through suiteRagDatabaseName()`).toContain(
				'suiteRagDatabaseName(',
			);
			// A tier that also spelled `${'${suiteDb}'}_rag` itself would be free to drift
			// from the derivation the day the derivation changes.
			expect(
				/`\$\{[A-Za-z_]+\}_rag`/.test(code),
				`${file} re-composes the suite vector database name instead of deriving it`,
			).toBe(false);
		}
		expect(read(helper)).toContain('export function suiteRagDatabaseName');
	});

	test('the derivation refuses the installation vector database, both directions', async () => {
		const { assertDistinctFromInstallRagDatabase, installationRagDatabaseName } = await import(
			'../helpers/test_rag_database.ts'
		);
		const install = installationRagDatabaseName();
		expect(install).not.toBe('');
		// It refuses the installation's own name…
		expect(() => assertDistinctFromInstallRagDatabase(install)).toThrow();
		// …and stays quiet on a distinct one. Without this second half the guard
		// could be refusing everything (or nothing) and the first half would not
		// notice — the vacuity that made the matrix twin's distinctness check
		// useless for months (test_db_marker_tripwire rule 6).
		expect(assertDistinctFromInstallRagDatabase(`${install}_suite`)).toBe(`${install}_suite`);
	});

	test('the derived name pairs with the suite database, and never collides', async () => {
		const { suiteRagDatabaseName, installationRagDatabaseName } = await import(
			'../helpers/test_rag_database.ts'
		);
		// Over the database THIS process runs on, plus shard clones of it: each
		// suite database must get its OWN vector database, or one shard's rebuild
		// wipes another's index mid-assertion — the shard hazard the media seam's
		// rule 6b spells out, on the third surface.
		const suiteDb = process.env.DB_NAME ?? '';
		expect(suiteDb).not.toBe('');
		const names = [suiteDb, `${suiteDb}__shard1`, `${suiteDb}__shard2`].map((db) =>
			suiteRagDatabaseName(db),
		);
		expect(new Set(names).size, 'two suite databases must never share one vector database').toBe(
			names.length,
		);
		for (const name of names) {
			expect(name).not.toBe(installationRagDatabaseName());
			expect(name.startsWith(suiteDb)).toBe(true);
		}
		// And THIS process is on the one the derivation gives for its own database.
		expect(testRagDatabaseName()).toBe(names[0] as string);
	});
});
