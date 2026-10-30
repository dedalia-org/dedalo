/**
 * runTransform — the DRY-RUN GATE for the whole move_* family (WC-025).
 *
 * `const dryRun = options.dry_run !== false` is the only thing standing between
 * an operator clicking "preview" and an irreversible, DB-wide locator rewrite:
 * the move_* executors have NO rollback (they write through the matrix
 * primitives with Time Machine suppressed). engine.ts was loaded by zero tests
 * before this file, so the gate had no mechanical guard at all.
 *
 * Hermetic by construction: `definitions.ts` is mocked with an injectable
 * in-memory catalog (no filesystem, no config dir) and the executor is a FAKE
 * that only records into the recorder — no real transform ever runs here.
 * The mock is restored to the real module in `afterAll` because `mock.module`
 * is process-global and `mock.restore()` does not revert it.
 *
 * CORRECTED 2026-08-09 (defect D16 was a LEDGER ERROR, not a code defect): the
 * `content === null` → "unparsable definition file" branch in engine.ts is NOT
 * unreachable. `JSON.parse('null')` RETURNS null without throwing, so a
 * definition file containing the literal `null` is listed by
 * `listDefinitionFiles` (it enters `available` with content null) and then
 * loads as null — the branch fires. A file truncated or replaced between the
 * list and the load (TOCTOU) reaches it too. The branch is correct behaviour
 * and is now covered below. What genuinely disappears silently is a MALFORMED
 * file: definitions.ts swallows the parse error and drops the name from the
 * list with no report — a separate, deliberate PHP json_decode-null parity
 * behaviour, left as-is here.
 *
 * ONE EXECUTED FILE = ONE ATOMIC UNIT (OPS-6/PERF-11, the last describe below):
 * an EXECUTE runs each file in a real maintenance transaction, so those legs
 * touch the lane SUITE database — one scratch table `dedalo_ts_test_tr_<pid>`
 * (assertTestDatabase first; dropped in afterAll). The executor stays a fake.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { registerCommitAction, sql } from '../../src/core/db/postgres.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { COMMIT_ONLY_ACTIONS_DROPPED_LINE } from '../../src/core/update/scripts.ts';
import type { TransformRecorder } from '../../src/core/update/transform/report.ts';

// --- injectable definition catalog (replaces the filesystem) ----------------

/** file_name → parsed content, as `listDefinitionFiles` would have produced. */
let CATALOG: Record<string, unknown> = {};
/** every file name `loadDefinitionFile` was asked for, in call order. */
let loadCalls: string[] = [];
/** every widget id the engine listed/loaded against (confinement is per-widget). */
let widgetsSeen: string[] = [];

const DEFINITIONS_PATH = '../../src/core/update/transform/definitions.ts';
// A SNAPSHOT (spread), never the namespace itself: Bun's mock.module rewrites the
// live namespace object IN PLACE, so a bare `await import()` captured here would
// hold the MOCK after the line below — and the afterAll "restore" re-installed the
// mock for every later file (transform_engine, matrix_counter_monotonic and
// record_generation went red after this file, in any order that ran it first).
const REAL_DEFINITIONS = { ...(await import(DEFINITIONS_PATH)) };

mock.module(DEFINITIONS_PATH, () => ({
	...REAL_DEFINITIONS,
	listDefinitionFiles: (widget: string) => {
		widgetsSeen.push(widget);
		return Object.entries(CATALOG).map(([file_name, content]) => ({ file_name, content }));
	},
	loadDefinitionFile: (widget: string, fileName: string) => {
		widgetsSeen.push(widget);
		loadCalls.push(fileName);
		return Object.hasOwn(CATALOG, fileName) ? CATALOG[fileName] : null;
	},
}));

/**
 * The DOOR legs drive move_tld through the real widget door; its executor
 * (`executeChangesInTipos`, resolved lazily by move_common.executorFor) is
 * replaced by whatever the leg sets here — a fake that writes the scratch table.
 */
type DoorExecutor = (items: unknown, recorder: TransformRecorder) => Promise<void>;
let doorExecutor: DoorExecutor = async () => {};
const TIPOS_PATH = '../../src/core/update/transform/tipos.ts';
const REAL_TIPOS = { ...(await import(TIPOS_PATH)) }; // snapshot — see REAL_DEFINITIONS
mock.module(TIPOS_PATH, () => ({
	...REAL_TIPOS,
	executeChangesInTipos: (items: unknown, recorder: TransformRecorder) =>
		doorExecutor(items, recorder),
}));

// engine.ts must be imported AFTER the mock is installed, so its static
// bindings resolve to the injected catalog and never touch a real dir.
const { runTransform } = await import('../../src/core/update/transform/engine.ts');

/** The scratch table the atomicity legs write through a fake executor. */
const SCRATCH = `dedalo_ts_test_tr_${process.pid}`;

// The DOOR legs execute a destructive_shared door (core/update/door_class.ts):
// maintenance mode, the backup waived (that leg is gated in
// update_door_precondition_class_tripwire — these legs are about the job).
let maintenanceBefore = false;

beforeAll(async () => {
	await assertTestDatabase('transform_run_native');
	maintenanceBefore = getServerState().maintenance_mode === true;
	setServerState({ maintenance_mode: true });
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${SCRATCH}" (id serial PRIMARY KEY, tag text NOT NULL)`,
		[],
	);
});

afterAll(async () => {
	setServerState({ maintenance_mode: maintenanceBefore });
	mock.module(DEFINITIONS_PATH, () => REAL_DEFINITIONS);
	mock.module(TIPOS_PATH, () => REAL_TIPOS);
	mock.restore();
	await sql.unsafe(`DROP TABLE IF EXISTS "${SCRATCH}"`, []);
});

afterEach(() => {
	CATALOG = {};
	loadCalls = [];
	widgetsSeen = [];
});

// --- fake executor ---------------------------------------------------------

interface ExecutorCall {
	items: unknown;
	recorder: TransformRecorder;
}

/**
 * Records each invocation and (optionally) writes one delta per call, so the
 * report's counts prove the executor's work was actually merged in.
 */
function spyExecutor(options: { record?: boolean; throwOn?: string } = {}) {
	const calls: ExecutorCall[] = [];
	const executor = async (items: unknown, recorder: TransformRecorder): Promise<void> => {
		calls.push({ items, recorder });
		// an await tick: proves runTransform AWAITS the executor instead of
		// firing it and reporting before the deltas land.
		await Promise.resolve();
		if (options.throwOn !== undefined && JSON.stringify(items) === options.throwOn) {
			throw new Error('boom');
		}
		if (options.record !== false) {
			recorder.record({ op: 'update', table: 'matrix', target: `call ${calls.length}` });
		}
	};
	return { calls, executor };
}

// ---------------------------------------------------------------------------
// THE DRY-RUN GATE — `dry_run !== false`
// ---------------------------------------------------------------------------

describe('runTransform dry-run gate (WC-025)', () => {
	// Every one of these is a value a sloppy client could send for "no, really
	// execute". Only the boolean false may mutate; a truthy-string 'false' or a
	// 0/null coming off a form must stay a PREVIEW.
	const dryCases: [string, unknown][] = [
		["string 'false'", 'false'],
		["string 'true'", 'true'],
		['number 0', 0],
		['number 1', 1],
		['null', null],
		['undefined', undefined],
		['boolean true', true],
		['empty string', ''],
		['object', {}],
	];

	for (const [label, dry_run] of dryCases) {
		test(`dry_run = ${label} → DRY RUN`, async () => {
			CATALOG = { 'a.json': [{ old: 'x1', new: 'y1' }] };
			const { calls, executor } = spyExecutor();
			const report = await runTransform(
				'move_tld',
				{ dry_run, files_selected: ['a.json'] },
				executor,
			);

			// the recorder handed to the executor carries the mode: an executor
			// that consults recorder.dryRun is what actually skips the write.
			expect(calls.length).toBe(1);
			expect(calls[0]!.recorder.dryRun).toBe(true);
			expect(report.dryRun).toBe(true);
			expect(report.msg).toContain('DRY RUN');
			expect(report.msg).not.toContain('executed');
		});
	}

	test('dry_run absent (key never sent) → DRY RUN', async () => {
		CATALOG = { 'a.json': 1 };
		const { calls, executor } = spyExecutor();
		const report = await runTransform('move_tld', { files_selected: ['a.json'] }, executor);
		expect(calls[0]!.recorder.dryRun).toBe(true);
		expect(report.dryRun).toBe(true);
	});

	test('dry_run: false (the ONLY mutating value) → execute', async () => {
		CATALOG = { 'a.json': 1 };
		const { calls, executor } = spyExecutor();
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json'] },
			executor,
		);
		expect(calls[0]!.recorder.dryRun).toBe(false);
		expect(report.dryRun).toBe(false);
		expect(report.msg).toContain('executed');
		expect(report.msg).not.toContain('DRY RUN');
	});

	test('the no-rollback warning is present in dry run and absent when executing', async () => {
		CATALOG = { 'a.json': 1 };
		const dry = await runTransform(
			'move_tld',
			{ files_selected: ['a.json'] },
			spyExecutor().executor,
		);
		const exec = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json'] },
			spyExecutor().executor,
		);
		expect(dry.msg).toContain('move_tld (no rollback for locator moves — dry run first)');
		expect(exec.msg).toContain('move_tld');
		expect(exec.msg).not.toContain('no rollback');
	});
});

// ---------------------------------------------------------------------------
// files_selected validation — the refusal envelope
// ---------------------------------------------------------------------------

describe('runTransform files_selected refusal', () => {
	// The refusal must be a full, well-formed report (the widget renders these
	// fields blind): a bare {ok:false} would crash the client, and a missing
	// dryRun would make a refused EXECUTE look like a refused preview.
	const refusal = {
		ok: false,
		dryRun: true,
		msg: 'Error. No definition files selected',
		errors: ['files_selected is required'],
		counts: {},
		sample: [],
	};

	const badSelections: [string, unknown][] = [
		['absent', undefined],
		["a bare string 'a.json' (not an array)", 'a.json'],
		['an array of non-strings', [123]],
		['an empty array', []],
		['null', null],
		['an object', { 0: 'a.json' }],
	];

	for (const [label, files_selected] of badSelections) {
		test(`files_selected ${label} → refusal envelope, executor never called`, async () => {
			CATALOG = { 'a.json': 1 };
			const { calls, executor } = spyExecutor();
			const report = await runTransform('move_tld', { files_selected }, executor);
			expect(report).toEqual(refusal);
			expect(calls.length).toBe(0);
			expect(loadCalls).toEqual([]);
		});
	}

	test('refusal keeps dryRun:false when the operator asked to execute', async () => {
		// otherwise a refused execute is indistinguishable from a refused preview
		// in the operator log.
		const report = await runTransform('move_tld', { dry_run: false }, spyExecutor().executor);
		expect(report.dryRun).toBe(false);
		expect(report.ok).toBe(false);
	});

	test('rawOptions null/undefined → refusal, no throw', async () => {
		const { calls, executor } = spyExecutor();
		expect(await runTransform('move_tld', null, executor)).toEqual(refusal);
		expect(await runTransform('move_tld', undefined, executor)).toEqual(refusal);
		expect(calls.length).toBe(0);
	});

	test('mixed array keeps only the string entries', async () => {
		CATALOG = { 'a.json': 1 };
		const { calls, executor } = spyExecutor();
		const report = await runTransform(
			'move_tld',
			{ files_selected: [123, 'a.json', null, { file: 'b.json' }] },
			executor,
		);
		expect(loadCalls).toEqual(['a.json']);
		expect(calls.length).toBe(1);
		expect(report.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// confinement — a selected file must be in the widget's own dir
// ---------------------------------------------------------------------------

describe('runTransform definition-file confinement', () => {
	test('unavailable + traversal names are refused; only the real file runs', async () => {
		CATALOG = { 'a.json': [{ old: 'x1', new: 'y1' }] };
		const { calls, executor } = spyExecutor();
		const report = await runTransform(
			'move_tld',
			{ files_selected: ['b.json', '../move_lang/b.json', 'a.json'] },
			executor,
		);

		// both misses are named (the operator must see WHICH file was dropped —
		// a silent skip would make a partial transform look complete)…
		expect(report.errors).toEqual([
			'definition file not found in move_tld: b.json',
			'definition file not found in move_tld: ../move_lang/b.json',
		]);
		// …and the load is never even attempted for them.
		expect(loadCalls).toEqual(['a.json']);
		expect(calls.length).toBe(1);
		expect(calls[0]!.items).toEqual([{ old: 'x1', new: 'y1' }]);

		// errors downgrade the report but the run still reports its work
		expect(report.ok).toBe(false);
		expect(report.msg).toContain('Warning');
		expect(report.msg).toContain('2 error(s)');
		expect(report.counts).toEqual({ update: 1 });
	});

	test('a definition file whose content is null is REPORTED, not silently run (D16)', async () => {
		// Reachability proof for engine.ts's `content === null` arm, which the
		// defect ledger called unreachable: JSON.parse('null') does not throw, so
		// a file holding the four bytes `null` is listed AND loads as null. The
		// operator must be told the file was dropped; the executor must not run.
		CATALOG = { 'nulldef.json': null, 'a.json': [{ old: 'x1', new: 'y1' }] };
		const { calls, executor } = spyExecutor();
		const report = await runTransform(
			'move_to_table',
			{ files_selected: ['nulldef.json', 'a.json'] },
			executor,
		);

		expect(loadCalls).toEqual(['nulldef.json', 'a.json']);
		expect(report.errors).toEqual(['unparsable definition file: nulldef.json']);
		expect(calls.length).toBe(1);
		expect(calls[0]!.items).toEqual([{ old: 'x1', new: 'y1' }]);
		expect(report.ok).toBe(false);
	});

	test('every list/load is scoped to the widget passed in', async () => {
		CATALOG = { 'a.json': 1 };
		await runTransform('move_lang', { files_selected: ['a.json'] }, spyExecutor().executor);
		expect(widgetsSeen).toEqual(['move_lang', 'move_lang']);
	});

	test('the widget id is echoed in the report msg', async () => {
		CATALOG = { 'a.json': 1 };
		for (const widget of ['move_tld', 'move_locator', 'move_to_portal', 'move_to_table'] as const) {
			const report = await runTransform(
				widget,
				{ files_selected: ['a.json'] },
				spyExecutor().executor,
			);
			expect(report.msg).toContain(widget);
		}
	});
});

// ---------------------------------------------------------------------------
// executor dispatch + error containment
// ---------------------------------------------------------------------------

describe('runTransform executor dispatch', () => {
	test('one shared recorder across all files; counts merge, order preserved', async () => {
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		const { calls, executor } = spyExecutor();
		const report = await runTransform(
			'move_tld',
			{ files_selected: ['b.json', 'a.json'] },
			executor,
		);
		expect(loadCalls).toEqual(['b.json', 'a.json']);
		expect(calls.map((c) => c.items)).toEqual([{ n: 2 }, { n: 1 }]);
		// the SAME recorder instance — a per-file recorder would report only the
		// last file's deltas.
		expect(calls[0]!.recorder).toBe(calls[1]!.recorder);
		// both deltas landed ⇒ the executor was awaited before toReport()
		expect(report.counts).toEqual({ update: 2 });
		expect(report.sample.map((d) => d.target)).toEqual(['call 1', 'call 2']);
	});

	test('a repeated selection runs the file twice (no dedupe today)', async () => {
		CATALOG = { 'a.json': 1 };
		const { calls, executor } = spyExecutor();
		await runTransform('move_tld', { files_selected: ['a.json', 'a.json'] }, executor);
		expect(calls.length).toBe(2);
	});

	test('an executor throw is contained per file and does not abort the run', async () => {
		CATALOG = { 'ok.json': { n: 1 }, 'bad.json': { n: 2 } };
		const { calls, executor } = spyExecutor({ throwOn: JSON.stringify({ n: 2 }) });
		let thrown: unknown = null;
		const report = await runTransform(
			'move_tld',
			{ files_selected: ['bad.json', 'ok.json'] },
			executor,
		).catch((error) => {
			thrown = error;
			return null;
		});
		// runTransform must never reject: the widget shows the report, not a 500.
		expect(thrown).toBeNull();
		expect(report?.errors).toEqual(['bad.json: boom']);
		// the file after the throwing one still ran
		expect(calls.length).toBe(2);
		expect(report?.counts).toEqual({ update: 1 });
		expect(report?.ok).toBe(false);
		expect(report?.dryRun).toBe(true);
	});

	test('a clean run reports result:true with no errors', async () => {
		CATALOG = { 'a.json': 1 };
		const report = await runTransform(
			'move_tld',
			{ files_selected: ['a.json'] },
			spyExecutor().executor,
		);
		expect(report.ok).toBe(true);
		expect(report.errors).toEqual([]);
		expect(report.msg).toContain('OK.');
	});

	test('an executor that records nothing still returns an empty, valid report', async () => {
		CATALOG = { 'a.json': 1 };
		const report = await runTransform(
			'move_tld',
			{ files_selected: ['a.json'] },
			spyExecutor({ record: false }).executor,
		);
		expect(report.counts).toEqual({});
		expect(report.sample).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.msg).toContain('0 change(s)');
	});
});

// ---------------------------------------------------------------------------
// ONE EXECUTED FILE = ONE ATOMIC UNIT (OPS-6/PERF-11)
// ---------------------------------------------------------------------------

describe('runTransform execute: each definition file applies whole or not at all', () => {
	/** A fake executor that WRITES one tagged row per call, then (optionally) fails. */
	function writingExecutor(fail: (items: unknown, attempt: number) => unknown | null) {
		let attempts = 0;
		const executor = async (items: unknown, recorder: TransformRecorder): Promise<void> => {
			attempts += 1;
			const tag = `${JSON.stringify(items)}#${attempts}`;
			await sql.unsafe(`INSERT INTO "${SCRATCH}" (tag) VALUES ($1)`, [tag]);
			recorder.record({ op: 'insert', table: SCRATCH, target: tag });
			const failure = fail(items, attempts);
			if (failure !== null) throw failure;
		};
		return { executor, attempts: () => attempts };
	}

	async function tags(): Promise<string[]> {
		const rows = (await sql.unsafe(`SELECT tag FROM "${SCRATCH}" ORDER BY id`, [])) as {
			tag: string;
		}[];
		return rows.map((row) => row.tag);
	}

	afterEach(async () => {
		await sql.unsafe(`DELETE FROM "${SCRATCH}"`, []);
	});

	test('a file that fails after writing is ROLLED BACK: its write is gone, its delta unreported, the next file still applies', async () => {
		CATALOG = { 'bad.json': { n: 1 }, 'ok.json': { n: 2 } };
		const { executor } = writingExecutor((items) =>
			(items as { n: number }).n === 1 ? new Error('boom after write') : null,
		);
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['bad.json', 'ok.json'] },
			executor,
		);
		// Pre-atomicity the first file's INSERT autocommitted: a half-applied file
		// the report still counted as a change.
		expect(await tags()).toEqual(['{"n":2}#2']);
		expect(report.counts).toEqual({ insert: 1 });
		expect(report.sample.map((delta) => delta.target)).toEqual(['{"n":2}#2']);
		expect(report.errors).toEqual([
			'bad.json: boom after write — rolled back: nothing of this file was applied',
		]);
		expect(report.ok).toBe(false);
	});

	test('a lock timeout (55P03) retries the WHOLE file; the discarded attempt is neither kept nor counted', async () => {
		CATALOG = { 'a.json': { n: 1 } };
		const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), {
			errno: '55P03',
		});
		const { executor, attempts } = writingExecutor((_items, attempt) =>
			attempt === 1 ? lockTimeout : null,
		);
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json'] },
			executor,
		);
		expect(attempts()).toBe(2);
		expect(await tags()).toEqual(['{"n":1}#2']);
		expect(report.counts).toEqual({ insert: 1 });
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	}, 15000);

	test('the executor runs INSIDE one transaction on the maintenance lane', async () => {
		CATALOG = { 'a.json': 1 };
		let seen: { xid: string | null; app: string } | undefined;
		await runTransform('move_tld', { dry_run: false, files_selected: ['a.json'] }, async () => {
			// An autocommit statement starts a fresh transaction with no xid yet; the
			// unit has already taken one (its COMMIT detector), so a non-null xid here
			// means the executor is inside the unit's transaction.
			const rows = (await sql.unsafe(
				`SELECT pg_current_xact_id_if_assigned()::text AS xid,
				        current_setting('application_name') AS app`,
				[],
			)) as { xid: string | null; app: string }[];
			seen = { xid: rows[0]?.xid ?? null, app: String(rows[0]?.app) };
		});
		expect(seen?.app).toStartWith('dedalo_maintenance:');
		expect(seen?.xid).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// A FAILED FILE IS NEVER "ROLLED BACK" ON A GUESS (OPS-6/PERF-11 review)
// ---------------------------------------------------------------------------

describe('runTransform execute: a failed file reports what its transaction ACTUALLY did', () => {
	/**
	 * A scratch table whose unique key is checked AT COMMIT (DEFERRABLE INITIALLY
	 * DEFERRED): an executor that writes a duplicate finishes its work, the
	 * engine sends COMMIT, and the COMMIT itself fails — the exact moment a lost
	 * connection or a pool force-closed at shutdown strikes, when the outcome is
	 * decided server-side and the client only sees an error.
	 */
	const DEFERRED = `${SCRATCH}_dfr`;

	beforeAll(async () => {
		await sql.unsafe(`DROP TABLE IF EXISTS "${DEFERRED}"`, []);
		await sql.unsafe(
			`CREATE TABLE "${DEFERRED}" (tag text, CONSTRAINT "${DEFERRED}_k" UNIQUE (tag) DEFERRABLE INITIALLY DEFERRED)`,
			[],
		);
	});

	afterAll(async () => {
		await sql.unsafe(`DROP TABLE IF EXISTS "${DEFERRED}"`, []);
	});

	afterEach(async () => {
		await sql.unsafe(`DELETE FROM "${DEFERRED}"`, []);
	});

	async function deferredTags(): Promise<string[]> {
		const rows = (await sql.unsafe(`SELECT tag FROM "${DEFERRED}" ORDER BY tag`, [])) as {
			tag: string;
		}[];
		return rows.map((row) => row.tag);
	}

	/** File n=1 fails AT ITS COMMIT (a deferred duplicate); any other file writes one row. */
	function commitFailingExecutor() {
		const xids: string[] = [];
		const executor = async (items: unknown, recorder: TransformRecorder): Promise<void> => {
			const n = (items as { n: number }).n;
			const [row] = (await sql.unsafe('SELECT pg_current_xact_id()::text AS xid', [])) as {
				xid: string;
			}[];
			xids.push(String(row?.xid));
			const values = n === 1 ? "('dup'), ('dup')" : `('n${n}')`;
			await sql.unsafe(`INSERT INTO "${DEFERRED}" (tag) VALUES ${values}`, []);
			recorder.record({ op: 'insert', table: DEFERRED, target: `n${n}` });
		};
		return { executor, xids };
	}

	test("the REAL status read: a COMMIT that failed and PostgreSQL aborted → rolled back (the transaction asked about is the file's own)", async () => {
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		const { executor, xids } = commitFailingExecutor();
		const { readTransactionStatus } = await import('../../src/core/db/postgres.ts');
		const asked: string[] = [];
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json', 'b.json'] },
			executor,
			{
				readXactStatus: (xid) => {
					asked.push(xid);
					return readTransactionStatus(xid);
				},
			},
		);
		// Asked once, about file a's own transaction (b applied, nothing to ask).
		expect(xids).toHaveLength(2);
		expect(asked).toEqual(xids.slice(0, 1));
		expect(await deferredTags()).toEqual(['n2']);
		expect(report.counts).toEqual({ insert: 1 });
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toStartWith('a.json: ');
		expect(report.errors[0]).toEndWith(' — rolled back: nothing of this file was applied');
	});

	test('PostgreSQL reports the failed file COMMITTED (a lost COMMIT reply): reported applied, its deltas counted, never "rolled back"', async () => {
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		const { executor } = commitFailingExecutor();
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json', 'b.json'] },
			executor,
			{ readXactStatus: async () => 'committed' },
		);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toStartWith('a.json: ');
		expect(report.errors[0]).toContain('PostgreSQL reports its transaction COMMITTED');
		expect(report.errors.join('\n')).not.toMatch(/rolled back|nothing of this file/);
		// The committed file's deltas persisted: the report counts them; b still ran.
		expect(report.counts).toEqual({ insert: 2 });
		expect(report.sample.map((delta) => delta.target)).toEqual(['n1', 'n2']);
	});

	test('a file reported COMMITTED after its COMMIT failed: its commit-only actions really were dropped, and the report SAYS so (cross-ops:r2)', async () => {
		CATALOG = { 'a.json': { n: 1 } };
		const { executor: failingAtCommit } = commitFailingExecutor();
		let ran = 0;
		const executor = async (items: unknown, recorder: TransformRecorder): Promise<void> => {
			// What an engine write helper queues: the observer ledger, a revocation.
			expect(registerCommitAction(() => void ran++)).toBe(true);
			await failingAtCommit(items, recorder);
		};
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json'] },
			executor,
			{ readXactStatus: async () => 'committed' },
		);
		expect(ran, 'the commit-only lane ran after a COMMIT the engine saw fail').toBe(0);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain('PostgreSQL reports its transaction COMMITTED');
		expect(report.errors[0]).toEndWith(`; ${COMMIT_ONLY_ACTIONS_DROPPED_LINE}`);
	});

	for (const [leg, readXactStatus] of [
		[
			'the status cannot be read',
			async () => {
				throw new Error('simulated: the database is unreachable');
			},
		],
		['the status stays in progress', async () => 'in progress'],
		['the status is NULL', async () => null],
	] as const) {
		test(`${leg}: OUTCOME UNKNOWN, never "rolled back" — and no later file runs`, async () => {
			CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
			const { executor, xids } = commitFailingExecutor();
			const report = await runTransform(
				'move_tld',
				{ dry_run: false, files_selected: ['a.json', 'b.json'] },
				executor,
				{ readXactStatus },
			);
			expect(xids).toHaveLength(1);
			expect(report.errors).toHaveLength(2);
			expect(report.errors[0]).toStartWith('a.json: ');
			expect(report.errors[0]).toContain('outcome UNKNOWN');
			expect(report.errors[0]).not.toMatch(/rolled back|nothing of this file/);
			expect(report.errors[1]).toBe(
				"b.json: not run — the transform was stopped (an earlier file's outcome is uncertain) before it started",
			);
			expect(report.counts).toEqual({});
		}, 15000);
	}

	test('a file whose transaction ENDED mid-unit is PARTIALLY applied — never "rolled back" — and no later file runs', async () => {
		const { transactionEndedMidUnit } = await import('../../src/core/db/postgres.ts');
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		const asked: string[] = [];
		const ran: number[] = [];
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json', 'b.json'] },
			async (items) => {
				ran.push((items as { n: number }).n);
				// The checkpoint's own verdict (the pool refuses transaction control
				// before it is sent, so a real one cannot be produced from here).
				throw transactionEndedMidUnit('100', '101');
			},
			{
				readXactStatus: async (xid) => {
					asked.push(xid);
					return 'aborted';
				},
			},
		);
		expect(ran).toEqual([1]);
		expect(asked).toEqual([]);
		expect(report.errors).toEqual([
			"a.json: PARTIALLY applied — a statement ended the file's transaction mid-unit (xact 100 → 101): what ran before it persisted and what ran after it autocommitted; inspect the data before re-running it (a locator move is not idempotent)",
			"b.json: not run — the transform was stopped (an earlier file's outcome is uncertain) before it started",
		]);
	});

	test('an ABORTED file is classified by its transaction too: an unreadable status is UNKNOWN, never "aborted — rolled back"', async () => {
		CATALOG = { 'a.json': { n: 3 } };
		const controller = new AbortController();
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json'] },
			async () => {
				controller.abort();
			},
			{ signal: controller.signal, readXactStatus: async () => null },
		);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toStartWith('a.json: aborted (aborted) — outcome UNKNOWN');
	});
});

// ---------------------------------------------------------------------------
// AN EXECUTE IS STOPPABLE AND SINGLE-FLIGHT (OPS-6/PERF-11 r3)
// ---------------------------------------------------------------------------

describe('runTransform execute: a stop rolls the running file back; a concurrent run is refused', () => {
	/** A promise the test awaits until the executor is INSIDE file n=1's unit. */
	function deferred(): { promise: Promise<void>; resolve: () => void } {
		let resolve: () => void = () => {};
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}

	/**
	 * Writes one tagged row per file, then — on file n=1 — sits in an 8s server-side
	 * sleep (the stand-in for a long rewrite statement). Only a cancel of the
	 * RUNNING statement ends it early; an abort checked between files would not.
	 */
	function sleepingExecutor(entered: () => void) {
		const ran: number[] = [];
		const executor = async (items: unknown, recorder: TransformRecorder): Promise<void> => {
			const n = (items as { n: number }).n;
			ran.push(n);
			await sql.unsafe(`INSERT INTO "${SCRATCH}" (tag) VALUES ($1)`, [`n${n}`]);
			recorder.record({ op: 'insert', table: SCRATCH, target: `n${n}` });
			if (n === 1) {
				entered();
				await sql.unsafe('SELECT pg_sleep(8)', []);
			}
		};
		return { executor, ran };
	}

	async function tags(): Promise<string[]> {
		const rows = (await sql.unsafe(`SELECT tag FROM "${SCRATCH}" ORDER BY id`, [])) as {
			tag: string;
		}[];
		return rows.map((row) => row.tag);
	}

	afterEach(async () => {
		doorExecutor = async () => {};
		await sql.unsafe(`DELETE FROM "${SCRATCH}"`, []);
	});

	test('a stop mid-file cancels its running statement, rolls that file back, and runs no later file', async () => {
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		const { jobAbortReason } = await import('../../src/core/media/jobs.ts');
		const inside = deferred();
		const { executor, ran } = sleepingExecutor(inside.resolve);
		const controller = new AbortController();
		const running = runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json', 'b.json'] },
			executor,
			{ signal: controller.signal },
		);
		await inside.promise;
		const stoppedAt = performance.now();
		controller.abort(jobAbortReason({ cause: 'stop' }));
		const report = await running;
		// The 8s statement was CANCELLED, not waited out.
		expect(performance.now() - stoppedAt).toBeLessThan(5000);
		// File a's INSERT is gone (rolled back); file b never ran.
		expect(await tags()).toEqual([]);
		expect(ran).toEqual([1]);
		expect(report.counts).toEqual({});
		expect(report.errors).toEqual([
			'a.json: aborted (stop) — rolled back: nothing of this file was applied',
			'b.json: not run — the transform was aborted (stop) before it started',
		]);
		expect(report.ok).toBe(false);
	}, 20000);

	test("an abort that lands AFTER the file's last statement (before its COMMIT) still rolls the file back", async () => {
		CATALOG = { 'a.json': { n: 4 } };
		const controller = new AbortController();
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json'] },
			async (_items, recorder) => {
				await sql.unsafe(`INSERT INTO "${SCRATCH}" (tag) VALUES ('late')`, []);
				recorder.record({ op: 'insert', table: SCRATCH, target: 'late' });
				// No statement follows: nothing is running for the abort to cancel.
				controller.abort();
			},
			{ signal: controller.signal },
		);
		expect(await tags()).toEqual([]);
		expect(report.counts).toEqual({});
		expect(report.errors).toEqual([
			'a.json: aborted (aborted) — rolled back: nothing of this file was applied',
		]);
	});

	test('an abort before the first file runs nothing', async () => {
		CATALOG = { 'a.json': { n: 2 }, 'b.json': { n: 3 } };
		const { executor, ran } = sleepingExecutor(() => {});
		const controller = new AbortController();
		controller.abort();
		const report = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json', 'b.json'] },
			executor,
			{ signal: controller.signal },
		);
		expect(ran).toEqual([]);
		expect(await tags()).toEqual([]);
		expect(report.errors).toEqual([
			'a.json: not run — the transform was aborted (aborted) before it started',
			'b.json: not run — the transform was aborted (aborted) before it started',
		]);
	});

	test('a transform holding the run lock elsewhere refuses the file AT ONCE (no lock-wait retries) and stops the run', async () => {
		const { TRANSFORM_RUN_LOCK_KEY } = await import('../../src/core/update/transform/engine.ts');
		CATALOG = { 'a.json': { n: 2 }, 'b.json': { n: 3 } };
		const { executor, ran } = sleepingExecutor(() => {});
		const holder = await sql.reserve();
		try {
			await holder.unsafe('BEGIN', []);
			await holder.unsafe('SELECT pg_advisory_xact_lock($1::bigint)', [TRANSFORM_RUN_LOCK_KEY]);
			const startedAt = performance.now();
			const report = await runTransform(
				'move_tld',
				{ dry_run: false, files_selected: ['a.json', 'b.json'] },
				executor,
			);
			// Refused, never queued: the 1/2/4/8s lock retries would take > 15s.
			expect(performance.now() - startedAt).toBeLessThan(3000);
			expect(ran).toEqual([]);
			expect(await tags()).toEqual([]);
			expect(report.errors).toEqual([
				'a.json: refused — another move_* transform is running; nothing of this file was applied',
				'b.json: not run — the transform was refused before it started',
			]);
		} finally {
			await holder.unsafe('ROLLBACK', []);
			holder.release();
		}
		// Positive control: with the lock free the same run applies.
		const free = await runTransform(
			'move_tld',
			{ dry_run: false, files_selected: ['a.json', 'b.json'] },
			executor,
		);
		expect(free.errors).toEqual([]);
		expect(await tags()).toEqual(['n2', 'n3']);
	}, 20000);

	test('THE DOOR: an execute is a stoppable maintenance job (no deadline, owned); a second execute is refused while it runs; the stop rolls the file back and frees the door', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		const SOURCE = { model: 'move_tld', action: 'move_tld' };
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		const inside = deferred();
		const sleeping = sleepingExecutor(inside.resolve);
		doorExecutor = sleeping.executor;

		const submittedAt = performance.now();
		const response = await dispatchWidgetRequest(ROOT, SOURCE, {
			waive_backup: true,
			dry_run: false,
			files_selected: ['a.json', 'b.json'],
		});
		// Answered at once — the run is NOT inline in the request.
		expect(performance.now() - submittedAt).toBeLessThan(3000);
		const pfile = String(response.extend?.pfile ?? '');
		expect(pfile, JSON.stringify(response)).toEndWith('.json');
		expect(response.extend?.pid).toBe(process.pid);
		const jobId = pfile.slice(0, -'.json'.length);
		const queued = mediaJobs.status(jobId);
		expect(queued?.lane).toBe('maintenance');
		expect(queued?.deadline_ms).toBe(0);
		expect(queued?.user_id).toBe(-1);

		await inside.promise;
		// A resubmit while the first runs is REFUSED, not queued behind its locks.
		let refusal: unknown = null;
		await dispatchWidgetRequest(ROOT, SOURCE, {
			waive_backup: true,
			dry_run: false,
			files_selected: ['b.json'],
		}).catch((error) => {
			refusal = error;
		});
		// The door's UPDATE_RUN lock (held by the running job) refuses it first.
		expect((refusal as { code?: string } | null)?.code).toBe('update.refused');
		expect(sleeping.ran).toEqual([1]);

		const stoppedAt = performance.now();
		expect(mediaJobs.stop(jobId)).toBe(true);
		let record = mediaJobs.status(jobId);
		const deadline = Date.now() + 15000;
		while (record !== null && (record.status === 'queued' || record.status === 'running')) {
			if (Date.now() > deadline) break;
			await Bun.sleep(25);
			record = mediaJobs.status(jobId);
		}
		expect(performance.now() - stoppedAt).toBeLessThan(5000);
		expect(record?.status).toBe('stopped');
		// A user's own stop is not a failure: no typed error, no errors[] line on the frame.
		expect(record?.error).toBeUndefined();
		expect(record?.errors).toEqual([]);
		expect(await tags()).toEqual([]);
		expect(sleeping.ran).toEqual([1]);
		const data = record?.data as Record<string, unknown> & {
			ok?: boolean;
			errors?: string[];
			dry_run?: boolean;
		};
		expect(data?.ok).toBe(false);
		// ERRORS_SPEC §5.3: a frame never carries `result:false/msg/errors`.
		expect(Object.hasOwn(data ?? {}, 'result')).toBe(false);
		expect(data?.dry_run).toBe(false);
		expect(data?.errors).toEqual([
			'a.json: aborted (stop) — rolled back: nothing of this file was applied',
			'b.json: not run — the transform was aborted (stop) before it started',
		]);

		// The door is free again: the next execute is accepted and applies.
		doorExecutor = sleepingExecutor(() => {}).executor;
		const again = await dispatchWidgetRequest(ROOT, SOURCE, {
			waive_backup: true,
			dry_run: false,
			files_selected: ['b.json'],
		});
		const againId = String(again.extend?.pfile ?? '').slice(0, -'.json'.length);
		let finished = mediaJobs.status(againId);
		const doneBy = Date.now() + 15000;
		while (finished !== null && (finished.status === 'queued' || finished.status === 'running')) {
			if (Date.now() > doneBy) break;
			await Bun.sleep(25);
			finished = mediaJobs.status(againId);
		}
		expect(finished?.status).toBe('done');
		expect((finished?.data as { ok?: boolean })?.ok).toBe(true);
		expect(await tags()).toEqual(['n2']);
	}, 40000);

	/** Poll a job until it leaves queued/running (or the budget runs out). */
	async function settledJob(id: string) {
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		let record = mediaJobs.status(id);
		const deadline = Date.now() + 15000;
		while (record !== null && (record.status === 'queued' || record.status === 'running')) {
			if (Date.now() > deadline) break;
			await Bun.sleep(25);
			record = mediaJobs.status(id);
		}
		return record;
	}

	test('THE DOOR: a FAILED execute (a file rolled back) ends `error` with the typed maintenance.action_failed body — never a `done` frame carrying the failure — and its report stays the job data', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		CATALOG = { 'a.json': { n: 1 }, 'b.json': { n: 2 } };
		doorExecutor = async (items, recorder) => {
			const n = (items as { n: number }).n;
			await sql.unsafe(`INSERT INTO "${SCRATCH}" (tag) VALUES ($1)`, [`n${n}`]);
			recorder.record({ op: 'insert', table: SCRATCH, target: `n${n}` });
			if (n === 1) throw new Error('unique violation stand-in');
		};
		const response = await dispatchWidgetRequest(
			ROOT,
			{ model: 'move_tld', action: 'move_tld' },
			{ waive_backup: true, dry_run: false, files_selected: ['a.json', 'b.json'] },
		);
		const jobId = String(response.extend?.pfile ?? '').slice(0, -'.json'.length);
		const record = await settledJob(jobId);
		expect(record?.status).toBe('error');
		expect(record?.error?.code).toBe('maintenance.action_failed');
		// The failure's own sentence is what the frame says (the admin's answer).
		expect(record?.errors.join(' ')).toContain(
			'a.json: unique violation stand-in — rolled back: nothing of this file was applied',
		);
		const data = record?.data as Record<string, unknown> & { ok?: boolean; errors?: string[] };
		expect(data?.ok).toBe(false);
		expect(Object.hasOwn(data ?? {}, 'result')).toBe(false);
		expect(data?.errors).toEqual([
			'a.json: unique violation stand-in — rolled back: nothing of this file was applied',
		]);
		// File b still applied (a rolled-back file does not abort the run).
		expect(await tags()).toEqual(['n2']);
	}, 30000);

	test("THE DOOR: an execute REFUSED by another process's run lock ends `error` (typed), not `done`", async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const { TRANSFORM_RUN_LOCK_KEY } = await import('../../src/core/update/transform/engine.ts');
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		CATALOG = { 'a.json': { n: 2 } };
		doorExecutor = sleepingExecutor(() => {}).executor;
		const holder = await sql.reserve();
		try {
			await holder.unsafe('BEGIN', []);
			await holder.unsafe('SELECT pg_advisory_xact_lock($1::bigint)', [TRANSFORM_RUN_LOCK_KEY]);
			const response = await dispatchWidgetRequest(
				ROOT,
				{ model: 'move_tld', action: 'move_tld' },
				{ waive_backup: true, dry_run: false, files_selected: ['a.json'] },
			);
			const record = await settledJob(
				String(response.extend?.pfile ?? '').slice(0, -'.json'.length),
			);
			expect(record?.status).toBe('error');
			expect(record?.error?.code).toBe('maintenance.action_failed');
			expect((record?.data as { errors?: string[] })?.errors).toEqual([
				'a.json: refused — another move_* transform is running; nothing of this file was applied',
			]);
		} finally {
			await holder.unsafe('ROLLBACK', []);
			holder.release();
		}
		expect(await tags()).toEqual([]);
	}, 30000);

	test('THE DOOR: an execute stopped while still QUEUED for a maintenance slot frees the door (its worker never ran)', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		const SOURCE = { model: 'move_tld', action: 'move_tld' };
		CATALOG = { 'a.json': { n: 2 } };
		const sleeping = sleepingExecutor(() => {});
		doorExecutor = sleeping.executor;
		// Occupy every maintenance slot, so the execute's job waits in the queue.
		const gate = deferred();
		const blockers = Array.from({ length: mediaJobs.laneDepths().maintenance.max }, () =>
			mediaJobs.submit('zz_transform_blocker', async () => gate.promise, { lane: 'maintenance' }),
		);
		const waitTerminal = async (id: string) => {
			let record = mediaJobs.status(id);
			const deadline = Date.now() + 15000;
			while (record !== null && (record.status === 'queued' || record.status === 'running')) {
				if (Date.now() > deadline) break;
				await Bun.sleep(25);
				record = mediaJobs.status(id);
			}
			return record;
		};
		try {
			const queued = await dispatchWidgetRequest(ROOT, SOURCE, {
				waive_backup: true,
				dry_run: false,
				files_selected: ['a.json'],
			});
			const queuedId = String(queued.extend?.pfile ?? '').slice(0, -'.json'.length);
			await Bun.sleep(50);
			expect(mediaJobs.status(queuedId)?.status).toBe('queued');
			expect(mediaJobs.stop(queuedId)).toBe(true);
			expect((await waitTerminal(queuedId))?.status).toBe('stopped');
			expect(sleeping.ran).toEqual([]);
			// The claim went with it: the next execute is ACCEPTED (it queues too).
			const next = await dispatchWidgetRequest(ROOT, SOURCE, {
				waive_backup: true,
				dry_run: false,
				files_selected: ['a.json'],
			});
			const nextId = String(next.extend?.pfile ?? '').slice(0, -'.json'.length);
			gate.resolve();
			expect((await waitTerminal(nextId))?.status).toBe('done');
			expect(await tags()).toEqual(['n2']);
		} finally {
			gate.resolve();
			for (const blocker of blockers) await waitTerminal(blocker.id);
		}
	}, 40000);

	test('THE DOOR: a job that could not even be submitted frees the door (the refusal reaches the caller)', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		const SOURCE = { model: 'move_tld', action: 'move_tld' };
		CATALOG = { 'a.json': { n: 2 } };
		doorExecutor = sleepingExecutor(() => {}).executor;
		// An UNMARKED processes dir under the armed seam: submit refuses before
		// the job exists (media.invalid_path) — so no terminal callback ever fires.
		const unmarked = mkdtempSync(join(tmpdir(), 'dedalo-transform-unmarked-'));
		const previous = process.env.DEDALO_MEDIA_PROCESSES_DIR;
		let refusal: unknown = null;
		try {
			process.env.DEDALO_MEDIA_PROCESSES_DIR = unmarked;
			await dispatchWidgetRequest(ROOT, SOURCE, {
				waive_backup: true,
				dry_run: false,
				files_selected: ['a.json'],
			}).catch((error) => {
				refusal = error;
			});
		} finally {
			if (previous === undefined) delete process.env.DEDALO_MEDIA_PROCESSES_DIR;
			else process.env.DEDALO_MEDIA_PROCESSES_DIR = previous;
			rmSync(unmarked, { recursive: true, force: true });
		}
		expect((refusal as { code?: string } | null)?.code).toBe('media.invalid_path');
		// The claim was released: the next execute is accepted.
		const next = await dispatchWidgetRequest(ROOT, SOURCE, {
			waive_backup: true,
			dry_run: false,
			files_selected: ['a.json'],
		});
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const nextId = String(next.extend?.pfile ?? '').slice(0, -'.json'.length);
		let record = mediaJobs.status(nextId);
		const deadline = Date.now() + 15000;
		while (record !== null && (record.status === 'queued' || record.status === 'running')) {
			if (Date.now() > deadline) break;
			await Bun.sleep(25);
			record = mediaJobs.status(nextId);
		}
		expect(record?.status).toBe('done');
	}, 30000);

	test('THE DOOR: a DRY RUN is a stoppable, owned maintenance job too (the vendored client renders a job stream): it writes nothing, holds no claim, and its report is the job data', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		const SOURCE = { model: 'move_tld', action: 'move_tld' };
		CATALOG = { 'a.json': { n: 2 } };
		const { executor, ran } = sleepingExecutor(() => {});
		const release = deferred();
		const dryEntered = deferred();
		let dryLane = '';
		doorExecutor = async (items, recorder) => {
			if (recorder.dryRun) {
				ran.push((items as { n: number }).n);
				// The job is detached from the door's scope: it must declare its own,
				// or its full-table reads run under the request pool's ceiling.
				const [row] = (await sql.unsafe(
					"SELECT current_setting('application_name') AS name",
					[],
				)) as { name: string }[];
				dryLane = row?.name ?? '';
				recorder.record({ op: 'update', table: 'matrix', target: 'would' });
				dryEntered.resolve();
				await release.promise;
			} else await executor(items, recorder);
		};
		const submittedAt = performance.now();
		const response = await dispatchWidgetRequest(ROOT, SOURCE, {
			waive_backup: true,
			files_selected: ['a.json'],
		});
		expect(performance.now() - submittedAt).toBeLessThan(3000);
		expect(response.extend?.dry_run).toBe(true);
		expect(response.extend?.pid).toBe(process.pid);
		const pfile = String(response.extend?.pfile ?? '');
		expect(pfile, JSON.stringify(response)).toEndWith('.json');
		const jobId = pfile.slice(0, -'.json'.length);
		const queued = mediaJobs.status(jobId);
		expect(queued?.lane).toBe('maintenance');
		expect(queued?.deadline_ms).toBe(0);
		expect(queued?.user_id).toBe(-1);
		await dryEntered.promise;
		// No claim: an execute submitted while the dry run runs is ACCEPTED.
		const execute = await dispatchWidgetRequest(ROOT, SOURCE, {
			waive_backup: true,
			dry_run: false,
			files_selected: ['a.json'],
		});
		release.resolve();
		const record = await settledJob(jobId);
		expect(record?.status).toBe('done');
		const data = record?.data as Record<string, unknown> & {
			ok?: boolean;
			dry_run?: boolean;
			counts?: Record<string, number>;
		};
		expect(data?.ok).toBe(true);
		expect(data?.dry_run).toBe(true);
		expect(Object.hasOwn(data ?? {}, 'result')).toBe(false);
		expect(ran).toEqual([2]);
		expect(dryLane).toMatch(/^dedalo_maintenance:\d+:/);
		const executed = await settledJob(
			String(execute.extend?.pfile ?? '').slice(0, -'.json'.length),
		);
		expect(executed?.status).toBe('done');
		// Only the EXECUTE wrote.
		expect(await tags()).toEqual(['n2']);
	}, 30000);

	test('THE DOOR: a FAILED dry run (an executor that throws) ends `error`, typed — the same failure channel as an execute', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as never;
		CATALOG = { 'a.json': { n: 2 } };
		doorExecutor = async () => {
			throw new Error('a definition the executor cannot plan');
		};
		const response = await dispatchWidgetRequest(
			ROOT,
			{ model: 'move_tld', action: 'move_tld' },
			{ waive_backup: true, files_selected: ['a.json'] },
		);
		const record = await settledJob(String(response.extend?.pfile ?? '').slice(0, -'.json'.length));
		expect(record?.status).toBe('error');
		expect(record?.error?.code).toBe('maintenance.action_failed');
		expect((record?.data as { errors?: string[]; dry_run?: boolean })?.errors).toEqual([
			'a.json: a definition the executor cannot plan',
		]);
		expect(await tags()).toEqual([]);
	}, 30000);
});
