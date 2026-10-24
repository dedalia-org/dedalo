/**
 * UPDATE-DESCRIPTOR TRIPWIRE (OPS-6): a data-update descriptor that the atomic
 * engine cannot honour is REFUSED — at definition time (module load) and before
 * the first statement of a run — never discovered half-way through a migration.
 *
 * THE DEFECT. The descriptor type admitted `runPreScripts` (serialized to the
 * wire, then silently ignored by the engine) and `componentsUpdate` (discovered
 * as `engine.uncovered_scope` only AFTER the preceding SQL steps had already
 * committed). Nothing inspected `sqlUpdate` entries, so a descriptor could carry
 * transaction control (`COMMIT` — which would end the engine's one transaction
 * mid-run), a session `SET` (which outlives the run on a pooled connection), its
 * own `statement_timeout`/`lock_timeout` (which the engine owns), or a form that
 * cannot run inside a transaction at all (`CONCURRENTLY`, `VACUUM`) — each of
 * which breaks the atomic contract.
 *
 * WHAT THIS PINS, as outcomes:
 *   1. every shipped `UPDATE_CATALOG` descriptor validates clean;
 *   2. a truth table — one synthetic descriptor per rule — is refused with the
 *      named code by `validateUpdateDescriptor`, by `validateCatalog`, AND by
 *      `updateVersion`, which issues ZERO statements for it (the query tap reads
 *      0, and a scratch INSERT placed FIRST in the descriptor stays absent);
 *   3. lexical look-alikes (`'COMMIT'` in a string literal, `$$…$$` bodies,
 *      comments) are NOT refused — the lexer is not a substring match;
 *   4. `toWireDescriptor` never emits the pruned keys;
 *   5. non-vacuity: a scratch descriptor's steps really do execute through
 *      `withMaintenanceTransaction` — on the maintenance pool, under the unit's
 *      OWN `SET LOCAL statement_timeout = 0` — and a forced rollback there
 *      persists nothing;
 *   6. the module-load check is CALLED: catalog.ts, loaded in a child with one
 *      bad entry injected into UPDATE_CATALOG, refuses to load (`update.refused`)
 *      — the exported validateCatalog being correct proves nothing if the
 *      module never runs it.
 *
 * Scratch table `dedalo_ts_test_upd_<pid>_desc` on the lane SUITE database
 * (assertTestDatabase first), dropped in afterAll. `matrix_updates` is never
 * written (the version-row seam writes nowhere).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import * as postgresModule from '../../src/core/db/postgres.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithQueryTap } from '../../src/core/db/query_tap.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import * as catalogModule from '../../src/core/update/catalog.ts';
import {
	type DataUpdateDescriptor,
	UPDATE_CATALOG,
	type UpdateDescriptor,
} from '../../src/core/update/catalog.ts';
import { SCRIPT_REGISTRY, updateVersion } from '../../src/core/update/engine.ts';
import { childDriver, driverResult, repoModule } from '../helpers/child_driver.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';

// ---------------------------------------------------------------------------
// the FINAL surface (spec §1.9, §2.1), resolved by name so this gate loads on
// the pre-fix tree and fails per assertion instead of at link time.
// ---------------------------------------------------------------------------

interface DescriptorViolation {
	rule: string;
	code: string;
	detail: string;
}
type ValidateDescriptor = (
	key: string,
	descriptor: unknown,
	knownScriptIds: ReadonlySet<string> | readonly string[],
) => DescriptorViolation[];
type ValidateCatalog = (catalog: Readonly<Record<string, unknown>>) => void;
type WithMaintenanceTransaction = <T>(
	work: (ctx: { signal?: AbortSignal; checkpoint: () => Promise<void> }) => Promise<T>,
	options: { lockTimeout: string; signal?: AbortSignal; lockRetryDelaysMs?: readonly number[] },
) => Promise<T>;

function exported<T>(module: object, name: string): T {
	const value = (module as Record<string, unknown>)[name];
	if (typeof value !== 'function') {
		throw new Error(`${name} is not exported — the OPS-6 surface it names does not exist`);
	}
	return value as T;
}

const PID = process.pid;
const TABLE = `dedalo_ts_test_upd_${PID}_desc`;
const LOG_PATH = scratchFile('update_descriptor', 'update_descriptor.log');
const SCRIPT_IDS = ['zz.ok'];
const SCRIPTS = { 'zz.ok': async () => ({ ok: true }) };

beforeAll(async () => {
	await assertTestDatabase('update_descriptor_tripwire');
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${TABLE}" (id serial PRIMARY KEY, tag text NOT NULL)`,
		[],
	);
});

afterAll(async () => {
	await sql.unsafe(`DROP TABLE IF EXISTS "${TABLE}"`, []);
	rmSync(LOG_PATH, { force: true });
});

beforeEach(async () => {
	await sql.unsafe(`TRUNCATE "${TABLE}"`, []);
});

const insertFirst = (tag: string) => `INSERT INTO "${TABLE}" (tag) VALUES ('${tag}')`;

async function rowsTagged(tag: string): Promise<number> {
	const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${TABLE}" WHERE tag = $1`, [
		tag,
	])) as { n: number }[];
	return rows[0]?.n ?? -1;
}

function descriptor(parts: Record<string, unknown>): DataUpdateDescriptor {
	return {
		versionMajor: 7,
		versionMedium: 0,
		versionMinor: 1,
		updateFromMajor: 7,
		updateFromMedium: 0,
		updateFromMinor: 0,
		updateData: true,
		...parts,
	} as unknown as DataUpdateDescriptor;
}

/** Every step key the client could send, all checked. */
function checkEverything(d: UpdateDescriptor): Record<string, boolean> {
	const record = d as unknown as Record<string, unknown[] | undefined>;
	const checked: Record<string, boolean> = {};
	for (const [key, wire] of [
		['sqlUpdate', 'SQL_update'],
		['runScripts', 'run_scripts'],
		['componentsUpdate', 'components_update'],
		['runPreScripts', 'run_pre_scripts'],
	] as const) {
		(record[key] ?? []).forEach((_, index) => {
			checked[`${wire}_${index}`] = true;
		});
	}
	return checked;
}

// ---------------------------------------------------------------------------
// the truth table — one synthetic descriptor per rule
// ---------------------------------------------------------------------------

interface Row {
	rule: string;
	key?: string;
	descriptor: UpdateDescriptor;
	code: 'engine.uncovered_scope' | 'update.refused';
	/** false when the engine can never match it (key mismatch): validator legs only. */
	runnable: boolean;
}

const TAG = 'must_not_run';

const REFUSED: Row[] = [
	{
		rule: 'runPreScripts present',
		descriptor: descriptor({
			sqlUpdate: [insertFirst(TAG)],
			runPreScripts: [{ info: 'pre', scriptId: 'zz.ok', stopOnError: true }],
		}),
		code: 'engine.uncovered_scope',
		runnable: true,
	},
	{
		rule: 'componentsUpdate present',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)], componentsUpdate: ['component_date'] }),
		code: 'engine.uncovered_scope',
		runnable: true,
	},
	{
		rule: 'unknown key',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)], zzUnknownKey: true }),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'two statements in one entry',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), 'SELECT 1; SELECT 2'] }),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'transaction control: COMMIT',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), 'COMMIT'] }),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'transaction control behind a comment',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), '/*x*/ COMMIT'] }),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'session SET',
		descriptor: descriptor({
			sqlUpdate: [insertFirst(TAG), "SET application_name = 'zz_ops6_probe'"],
		}),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'engine-owned timeout directive',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), 'SET LOCAL statement_timeout = 0'] }),
		code: 'update.refused',
		runnable: true,
	},
	// The timeout class, in every spelling PostgreSQL accepts (review 2026-09-30:
	// the literal-stripped body blanked a quoted GUC name, and the set_config rule
	// matched only a plain '…' first argument).
	...(
		[
			['quoted lock_timeout name', 'SET LOCAL "lock_timeout" = 0'],
			['quoted statement_timeout name', `SET LOCAL "statement_timeout" = '1s'`],
			['set_config with an E-string name', "SELECT set_config(E'lock_timeout', '0', true)"],
			[
				'set_config with a dollar-quoted name',
				'SELECT set_config($g$lock_timeout$g$, $v$0$v$, true)',
			],
			['set_config with an escaped name', "SELECT set_config(E'lock\\137timeout', '0', true)"],
			['a quoted set_config call', `SELECT "set_config"('search_path', 'public', true)`],
			['a pg_settings write', "UPDATE pg_settings SET setting = '0' WHERE name = 'search_path'"],
			['a quoted GUC name (any setting)', 'SET LOCAL "search_path" = public'],
			['a unicode-escaped GUC name', 'SET LOCAL U&"lock\\005ftimeout" = 0'],
			// Only the raw-text rule sees this one: not a SET statement, name quoted.
			// Scoped to a database that does not exist, so a MUTATION that drops the
			// rule fails at the statement — it can never commit a role default
			// (an unscoped one leaked `statement_timeout = 1s` onto the suite role,
			// cluster-wide, during this gate's own mutation run).
			[
				'a role default via a quoted name',
				`ALTER ROLE CURRENT_USER IN DATABASE zz_ops6_nope SET "statement_timeout" = '1s'`,
			],
		] as const
	).map(
		([rule, statement]): Row => ({
			rule,
			descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), statement] }),
			code: 'update.refused',
			runnable: true,
		}),
	),
	// A DO body is CODE the run executes, not a literal (review 2026-09-30: both
	// forms below validated clean and left a session GUC on a maintenance
	// connection that later work reuses).
	...(
		[
			[
				'DO body: set_config(…, false)',
				"DO $$BEGIN PERFORM set_config('search_path', 'pg_catalog', false); END$$",
			],
			['DO body: EXECUTE a session SET', "DO $$BEGIN EXECUTE 'SET search_path = zz'; END$$"],
			['DO body: a leading session SET', 'DO $body$BEGIN SET search_path = zz; END$body$'],
			[
				'DO body: EXECUTE format of a RESET',
				"DO $$BEGIN EXECUTE format('RESET %s', 'search_path'); END$$",
			],
			[
				'DO body: a quoted set_config call',
				`DO $$BEGIN PERFORM "set_config"('search_path', 'pg_catalog', false); END$$`,
			],
			['DO body: DISCARD', "DO 'BEGIN DISCARD ALL; END'"],
		] as const
	).map(
		([rule, statement]): Row => ({
			rule,
			descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), statement] }),
			code: 'update.refused',
			runnable: true,
		}),
	),
	{
		rule: 'CONCURRENTLY',
		descriptor: descriptor({
			sqlUpdate: [
				insertFirst(TAG),
				`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${TABLE}_zz_idx" ON "${TABLE}" (tag)`,
			],
		}),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'VACUUM',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), `VACUUM "${TABLE}"`] }),
		code: 'update.refused',
		runnable: true,
	},
	// The rest of PostgreSQL's PreventInTransactionBlock class (review
	// 2026-09-30: each validated clean and failed only at run time, 25001).
	...(
		[
			['REINDEX SCHEMA', 'REINDEX SCHEMA public'],
			['REINDEX (options) SCHEMA', 'REINDEX (VERBOSE) SCHEMA public'],
			['a table-less CLUSTER', 'CLUSTER'],
			['a table-less CLUSTER VERBOSE', 'CLUSTER VERBOSE'],
			['ALTER DATABASE … SET TABLESPACE', 'ALTER DATABASE zz_ops6_nope SET TABLESPACE pg_default'],
			['a SUBSCRIPTION command', 'DROP SUBSCRIPTION IF EXISTS zz_ops6_nope'],
		] as const
	).map(
		([rule, statement]): Row => ({
			rule,
			descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), statement] }),
			code: 'update.refused',
			runnable: true,
		}),
	),
	// runScripts shape (the engine reads stopOnError by truthiness: a step
	// missing it would be classed SOFT, left unchecked and skipped while the
	// stamp claims it ran).
	...(
		[
			['a runScripts step missing stopOnError', { info: 'x', scriptId: 'zz.ok' }],
			[
				'a runScripts step with a non-boolean stopOnError',
				{ info: 'x', scriptId: 'zz.ok', stopOnError: 'yes' },
			],
			['a runScripts step missing info', { scriptId: 'zz.ok', stopOnError: true }],
			['a runScripts step missing scriptId', { info: 'x', stopOnError: true }],
		] as const
	).map(
		([rule, step]): Row => ({
			rule,
			descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)], runScripts: [step] }),
			code: 'update.refused',
			runnable: true,
		}),
	),
	// version fields: non-negative integers only.
	{
		rule: 'a non-integer version field',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)], versionMinor: 1.5 }),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'a negative version field',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)], versionMinor: -1 }),
		code: 'update.refused',
		runnable: true,
	},
	// statement_lexing: an entry the lexer cannot close is refused, never a TypeError.
	{
		rule: 'an unterminated string literal',
		descriptor: descriptor({
			sqlUpdate: [insertFirst(TAG), `INSERT INTO "${TABLE}" (tag) VALUES ('open`],
		}),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'an unterminated block comment',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG), 'SELECT 1 /* open'] }),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'unknown scriptId',
		descriptor: descriptor({
			sqlUpdate: [insertFirst(TAG)],
			runScripts: [{ info: 'x', scriptId: 'zz.no_such_script', stopOnError: true }],
		}),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'duplicate executionOrder entry',
		descriptor: descriptor({
			sqlUpdate: [insertFirst(TAG)],
			executionOrder: ['SQL_update', 'SQL_update'],
		}),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'executionOrder omits a step the descriptor carries',
		descriptor: descriptor({
			sqlUpdate: [insertFirst(TAG)],
			runScripts: [{ info: 'x', scriptId: 'zz.ok', stopOnError: true }],
			executionOrder: ['SQL_update'],
		}),
		code: 'update.refused',
		runnable: true,
	},
	{
		rule: 'updateData is not a boolean',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)], updateData: 'yes' }),
		code: 'update.refused',
		runnable: true,
	},
	{
		// Uncovered scope is reported FIRST even when an update.refused violation
		// precedes it in key order (the engine leg reads the thrown code).
		rule: 'uncovered scope wins over an earlier refused violation',
		descriptor: descriptor({
			zzUnknownKey: true,
			sqlUpdate: [insertFirst(TAG)],
			componentsUpdate: ['component_date'],
		}),
		code: 'engine.uncovered_scope',
		runnable: true,
	},
	{
		// A code-only release is never matched by the engine (runnable: false) —
		// the validator and the module-load check are the only doors.
		rule: 'a code-only descriptor carries steps',
		descriptor: descriptor({ updateData: false, sqlUpdate: [insertFirst(TAG)] }),
		code: 'update.refused',
		runnable: false,
	},
	{
		rule: 'catalog key does not match the descriptor version',
		key: '799',
		descriptor: descriptor({ sqlUpdate: [insertFirst(TAG)] }),
		code: 'update.refused',
		runnable: false,
	},
];

/** Lexical look-alikes: a substring match would refuse these; the lexer must not. */
const ALLOWED: { rule: string; descriptor: UpdateDescriptor; tag: string }[] = [
	{
		rule: "'COMMIT' inside a string literal",
		descriptor: descriptor({ sqlUpdate: [`INSERT INTO "${TABLE}" (tag) VALUES ('COMMIT')`] }),
		tag: 'COMMIT',
	},
	{
		rule: 'BEGIN/VACUUM inside a string literal, with a trailing semicolon',
		descriptor: descriptor({
			sqlUpdate: [`INSERT INTO "${TABLE}" (tag) VALUES ('BEGIN; VACUUM');`],
		}),
		tag: 'BEGIN; VACUUM',
	},
	{
		rule: 'dollar-quoted body',
		descriptor: descriptor({
			sqlUpdate: [`INSERT INTO "${TABLE}" (tag) VALUES ($zz$SET x; COMMIT$zz$)`],
		}),
		tag: 'SET x; COMMIT',
	},
	{
		// The DO-body rules read code, not every SET: an UPDATE … SET and a
		// SET LOCAL inside a DO body run (and the body's own INSERT lands).
		rule: 'DO body: UPDATE … SET and SET LOCAL are not session state',
		descriptor: descriptor({
			sqlUpdate: [
				`DO $$BEGIN SET LOCAL search_path = public; INSERT INTO "${TABLE}" (tag) VALUES ('do_body'); UPDATE "${TABLE}" SET tag = tag WHERE tag = 'do_body'; END$$`,
			],
		}),
		tag: 'do_body',
	},
	{
		rule: 'SET LOCAL of a non-timeout GUC and a comment',
		descriptor: descriptor({
			sqlUpdate: [
				'SET LOCAL search_path = public',
				`/* COMMIT */ INSERT INTO "${TABLE}" (tag) VALUES ('commented')`,
			],
		}),
		tag: 'commented',
	},
	{
		// The not-in-transaction rule names the SCHEMA/DATABASE/SYSTEM forms only:
		// a table REINDEX runs inside the unit.
		rule: 'REINDEX TABLE is not a not-in-transaction form',
		descriptor: descriptor({
			sqlUpdate: [`REINDEX TABLE "${TABLE}"`, `INSERT INTO "${TABLE}" (tag) VALUES ('reindexed')`],
		}),
		tag: 'reindexed',
	},
];

function keyOf(row: { key?: string; descriptor: UpdateDescriptor }): string {
	return row.key ?? catalogModule.catalogKeyOf(row.descriptor);
}

describe('update descriptor tripwire: the shipped catalog', () => {
	test('every UPDATE_CATALOG descriptor validates clean', () => {
		const validate = exported<ValidateDescriptor>(catalogModule, 'validateUpdateDescriptor');
		const scriptIds = Object.keys(SCRIPT_REGISTRY);
		const entries = Object.entries(UPDATE_CATALOG);
		expect(entries.length).toBeGreaterThan(0);
		for (const [key, entry] of entries) {
			expect(validate(key, entry, scriptIds), `catalog entry ${key}`).toEqual([]);
		}
		expect(() =>
			exported<ValidateCatalog>(catalogModule, 'validateCatalog')(UPDATE_CATALOG),
		).not.toThrow();
	});
});

describe('update descriptor tripwire: one refusal per rule', () => {
	for (const row of REFUSED) {
		test(`validator: ${row.rule} → ${row.code}`, () => {
			const validate = exported<ValidateDescriptor>(catalogModule, 'validateUpdateDescriptor');
			const codes = validate(keyOf(row), row.descriptor, SCRIPT_IDS).map((v) => v.code);
			expect(codes, `no violation for: ${row.rule}`).toContain(row.code);
			// The module-load check (validateCatalog) refuses a catalog holding it.
			const validateCatalog = exported<ValidateCatalog>(catalogModule, 'validateCatalog');
			let thrown: unknown = null;
			try {
				validateCatalog({ [keyOf(row)]: row.descriptor });
			} catch (error) {
				thrown = error;
			}
			expect((thrown as { code?: string } | null)?.code, String(thrown)).toBe(row.code);
		});

		if (row.runnable) {
			test(`engine: ${row.rule} → ${row.code}, ZERO statements, the first INSERT absent`, async () => {
				let thrown: unknown = null;
				const { report } = await runWithQueryTap(`descriptor ${row.rule}`, async () => {
					try {
						return await updateVersion(checkEverything(row.descriptor), {
							catalog: { [keyOf(row)]: row.descriptor },
							scripts: SCRIPTS,
							currentVersion: [7, 0, 0],
							logPath: LOG_PATH,
							writeVersionRow: async () => {},
							reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
						});
					} catch (error) {
						thrown = error;
						return null;
					}
				});
				expect(
					report.count,
					`the engine issued statements for a refused descriptor (${row.rule})`,
				).toBe(0);
				expect(await rowsTagged(TAG)).toBe(0);
				expect((thrown as { code?: string } | null)?.code, String(thrown)).toBe(row.code);
			}, 30000);
		}
	}
});

describe('update descriptor tripwire: lexical look-alikes are not refused', () => {
	for (const row of ALLOWED) {
		test(`allowed: ${row.rule}`, async () => {
			const validate = exported<ValidateDescriptor>(catalogModule, 'validateUpdateDescriptor');
			expect(
				validate(catalogModule.catalogKeyOf(row.descriptor), row.descriptor, SCRIPT_IDS),
			).toEqual([]);
			const out = await updateVersion(checkEverything(row.descriptor), {
				catalog: { [catalogModule.catalogKeyOf(row.descriptor)]: row.descriptor },
				scripts: SCRIPTS,
				currentVersion: [7, 0, 0],
				// The in-transaction re-read is BUILT, not read from the suite DB's
				// matrix_updates (whose stamped version is ambient state).
				readVersionInTx: async () => [7, 0, 0],
				logPath: LOG_PATH,
				writeVersionRow: async () => {},
				reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
			});
			expect(out.ok, out.msg.join(' | ')).toBe(true);
			expect(await rowsTagged(row.tag)).toBe(1);
		}, 30000);
	}
});

describe('update descriptor tripwire: the wire never carries the pruned keys', () => {
	test('toWireDescriptor emits neither run_pre_scripts nor components_update', () => {
		for (const row of REFUSED.slice(0, 2)) {
			const wire = catalogModule.toWireDescriptor(row.descriptor);
			expect(Object.keys(wire)).not.toContain('run_pre_scripts');
			expect(Object.keys(wire)).not.toContain('components_update');
		}
	});
});

describe('update descriptor tripwire: non-vacuity', () => {
	test('a scratch descriptor step executes through withMaintenanceTransaction; a forced rollback persists nothing', async () => {
		const withMaintenanceTransaction = exported<WithMaintenanceTransaction>(
			postgresModule,
			'withMaintenanceTransaction',
		);
		const scratch = descriptor({ sqlUpdate: [insertFirst('dry_run')] });
		let seenInside = -1;
		let inside: { application_name?: string; timeout_source?: string } = {};
		const forced = new Error('zz forced rollback');
		let caught: unknown = null;
		try {
			await withMaintenanceTransaction(
				async ({ checkpoint }) => {
					for (const statement of scratch.sqlUpdate ?? []) {
						await checkpoint();
						await sql.unsafe(statement, []);
					}
					seenInside = await rowsTagged('dry_run');
					// This process's ceiling is 0 already, so reading
					// statement_timeout would prove nothing. What is measured
					// instead: the unit runs on the MAINTENANCE pool (its
					// application_name), and its statement_timeout was set by the
					// unit itself (`SET LOCAL` → source 'session'; a startup value
					// reads 'client', a role default 'user').
					const rows = (await sql.unsafe(
						"SELECT current_setting('application_name') AS application_name, (SELECT source FROM pg_settings WHERE name = 'statement_timeout') AS timeout_source",
						[],
					)) as { application_name: string; timeout_source: string }[];
					inside = rows[0] ?? {};
					throw forced;
				},
				{ lockTimeout: '5s' },
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(forced);
		expect(seenInside, 'the step never ran inside the maintenance transaction').toBe(1);
		expect(inside.application_name, 'the unit did not run on the maintenance pool').toStartWith(
			'dedalo_maintenance:',
		);
		expect(
			inside.timeout_source,
			'the unit did not SET LOCAL its own statement_timeout (it relied on routing alone)',
		).toBe('session');
		expect(await rowsTagged('dry_run'), 'a rolled-back maintenance transaction persisted').toBe(0);
	}, 30000);

	test('a COMMIT issued by a step is refused BEFORE it is sent: the unit stays one, and the write before it rolls back', async () => {
		const withMaintenanceTransaction = exported<WithMaintenanceTransaction>(
			postgresModule,
			'withMaintenanceTransaction',
		);
		const forced = new Error('zz forced rollback after the refused COMMIT');
		let refusal: { code?: string; message?: string } | null = null;
		let checkpointPassed = false;
		let caught: unknown = null;
		try {
			await withMaintenanceTransaction(
				async ({ checkpoint }) => {
					await checkpoint();
					await sql.unsafe(insertFirst('commit_slip'), []);
					// What the validator refuses in a descriptor, issued by a step anyway.
					try {
						await sql.unsafe('COMMIT', []);
					} catch (error) {
						refusal = error as { code?: string; message?: string };
					}
					// The transaction id did not change: nothing ended the unit.
					await checkpoint();
					checkpointPassed = true;
					throw forced;
				},
				{ lockTimeout: '5s' },
			);
		} catch (error) {
			caught = error;
		}
		const refused = refusal as { code?: string; message?: string } | null;
		expect(refused?.code, 'the COMMIT was sent').toBe('internal.invariant');
		expect(refused?.message).toContain('transaction control');
		expect(checkpointPassed, 'the transaction ended despite the refusal').toBe(true);
		expect(caught).toBe(forced);
		// THE OUTCOME: had the COMMIT reached the server, the INSERT before it
		// would have persisted through the forced rollback.
		expect(await rowsTagged('commit_slip'), 'the COMMIT reached the server').toBe(0);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 6. the module-load check is called (a child: catalog.ts must load fresh)
// ---------------------------------------------------------------------------

/** One data entry the atomic contract refuses (transaction control), as source text. */
const BAD_ENTRY =
	"'799': { versionMajor: 7, versionMedium: 9, versionMinor: 9, updateFromMajor: 7, updateFromMedium: 9, updateFromMinor: 8, updateData: true, sqlUpdate: ['COMMIT'] },";
const FREEZE_OPEN = 'Object.freeze({';

/**
 * Load catalog.ts through a runtime plugin that (when `inject`) splices
 * BAD_ENTRY into the UPDATE_CATALOG literal. The splice reports whether its
 * anchor was found, so a reshaped catalog fails this leg loudly instead of
 * leaving it vacuous.
 */
function moduleLoadDriver(inject: boolean): string {
	return `
import { readFileSync } from 'node:fs';
let injected = false;
Bun.plugin({
	name: 'zz-bad-update-catalog-entry',
	setup(build) {
		build.onLoad({ filter: /src[\\/]core[\\/]update[\\/]catalog\\.ts$/ }, (args) => {
			let source = readFileSync(args.path, 'utf8');
			if (${inject}) {
				const declared = source.indexOf('export const UPDATE_CATALOG');
				const open = declared === -1 ? -1 : source.indexOf(${JSON.stringify(FREEZE_OPEN)}, declared);
				if (open !== -1) {
					const at = open + ${FREEZE_OPEN.length};
					source = source.slice(0, at) + ${JSON.stringify(BAD_ENTRY)} + source.slice(at);
					injected = true;
				}
			}
			return { contents: source, loader: 'ts' };
		});
	},
});
let outcome;
try {
	const catalog = await import(${repoModule('src/core/update/catalog.ts')});
	outcome = { imported: true, keys: Object.keys(catalog.UPDATE_CATALOG) };
} catch (e) {
	outcome = { imported: false, code: e?.code, rule: e?.coordinates?.rule, message: String(e?.message ?? e) };
}
console.log('RESULT ' + JSON.stringify({ injected, outcome }));
process.exit(0);
`;
}

interface ModuleLoadResult {
	injected: boolean;
	outcome: { imported: boolean; keys?: string[]; code?: string; rule?: string; message?: string };
}

describe('update descriptor tripwire: the module-load check runs', () => {
	const loader = childDriver('dedalo-update-catalog-load');
	afterAll(() => loader.dispose());

	test('catalog.ts refuses to LOAD with a bad UPDATE_CATALOG entry (update.refused); the untouched catalog loads', async () => {
		const control = await loader.run('catalog_load_control.ts', moduleLoadDriver(false), {});
		expect(control.exitCode, control.stderr).toBe(0);
		const clean = driverResult<ModuleLoadResult>(control.stdout, control.stderr);
		expect(clean.outcome.imported, JSON.stringify(clean.outcome)).toBe(true);
		expect(clean.outcome.keys ?? []).not.toContain('799');

		const bad = await loader.run('catalog_load_bad.ts', moduleLoadDriver(true), {});
		expect(bad.exitCode, bad.stderr).toBe(0);
		const refused = driverResult<ModuleLoadResult>(bad.stdout, bad.stderr);
		expect(
			refused.injected,
			'the UPDATE_CATALOG literal moved: the splice anchor was not found',
		).toBe(true);
		expect(
			refused.outcome.imported,
			`catalog.ts loaded a descriptor the engine cannot honour — validateCatalog(UPDATE_CATALOG) is not called at module load: ${JSON.stringify(refused.outcome)}`,
		).toBe(false);
		expect(refused.outcome.code, JSON.stringify(refused.outcome)).toBe('update.refused');
		expect(refused.outcome.rule).toBe('transaction_control');
	}, 60000);
});
