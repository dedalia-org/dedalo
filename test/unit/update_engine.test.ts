/**
 * Data-migration catalog + engine (UPDATE_PROCESS Phase 3). The engine runs
 * against FIXTURE descriptors through the seams — the REAL matrix_updates
 * writer is NEVER exercised here (a stray version row would lie to every
 * engine sharing the dev DB; the injected writer spy is mandatory). SQL
 * steps use self-contained statements (temp-free SELECTs) on purpose.
 *
 * Since OPS-6 a run is ONE atomic transaction on the suite database, and the
 * SELECTION RULE refuses a run that leaves a required step unchecked. The
 * in-transaction version re-read is INJECTED ([7,0,0]) — the suite DB's stamped
 * matrix_updates version is ambient state a gate must not depend on; the REAL
 * reader (readInstalledDataVersionStrict) has its own leg below, which builds its
 * situation inside a rolled-back transaction. The atomic/abort/single-flight/
 * crash legs live in update_engine_atomic_native; this file keeps the
 * PHP-parity step semantics and message bytes, and the widget's job shape.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realConfigModule from '../../src/config/config.ts';
import { readEnv } from '../../src/config/env.ts';
import {
	getBackupDir,
	getCurrentDataVersion,
	newestUsableBackup,
	readInstalledDataVersionStrict,
} from '../../src/core/area_maintenance/backup.ts';
import { dispatchWidgetRequest } from '../../src/core/area_maintenance/widgets/registry.ts';
import { appendMatrixUpdateRow } from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { jobAbortInfo, mediaJobs } from '../../src/core/media/jobs.ts';
import { setServerState } from '../../src/core/resolve/server_state.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	catalogKeyOf,
	type DataUpdateDescriptor,
	getMatchedDescriptor,
	getUpdateVersion,
	toWireDescriptor,
} from '../../src/core/update/catalog.ts';
import * as realEngine from '../../src/core/update/engine.ts';
import { ROLLED_BACK_LINE, updateVersion } from '../../src/core/update/engine.ts';
import * as realOwnership from '../../src/core/update/ownership.ts';
import { PANEL_WAIT_MS } from '../../src/core/update/preconditions.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';

const STATE_PATH = readEnv('DEDALO_TS_STATE_PATH');
if (STATE_PATH === undefined) {
	throw new Error(
		'update_engine.test.ts: DEDALO_TS_STATE_PATH is not set — refusing to run against the live server state file (S1-18)',
	);
}

const REAL_OWNERSHIP = { ...realOwnership };
const REAL_ENGINE = { ...realEngine };
const REAL_CONFIG = { ...realConfigModule };
/** Scratch DATABASE backup dirs for the inline widget legs (never the installation's). */
const BACKUP_SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_update_engine_backups_'));
afterAll(() => {
	mock.module('../../src/core/update/ownership.ts', () => REAL_OWNERSHIP);
	mock.module('../../src/core/update/engine.ts', () => REAL_ENGINE);
	mock.module('../../src/config/config.ts', () => REAL_CONFIG);
	mock.restore();
	setServerState({ maintenance_mode: false });
	rmSync(BACKUP_SCRATCH, { recursive: true, force: true });
});

/**
 * Run `body` with `config.ops` pointing at a scratch backup dir (and optionally a
 * scratch pg_restore bin dir). The inline update_data_version run asks the
 * backup verdict of the CONFIGURED directory — a full pg_restore read that writes
 * `.verified` sidecars — and nothing else in this suite repoints it: without this
 * it read the installation's ../private/backups/db (review, 2026-09-30). The
 * safety is asserted as an OUTCOME before the call: if the mock ever stops
 * reaching the backup module, this reds instead of reading real dumps.
 */
async function withScratchBackups<T>(
	ops: { backupDir: string; pgBinPath?: string },
	body: () => Promise<T>,
): Promise<T> {
	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG,
		config: { ...REAL_CONFIG.config, ops: { ...REAL_CONFIG.config.ops, ...ops } },
	}));
	try {
		expect(getBackupDir()).toBe(ops.backupDir);
		return await body();
	} finally {
		mock.module('../../src/config/config.ts', () => REAL_CONFIG);
	}
}

/** The error an inline widget dispatch throws (the empty catalog always refuses). */
async function inlineRefusal(principal: Principal): Promise<DedaloError> {
	try {
		await dispatchWidgetRequest(
			principal,
			{ model: 'update_data_version', action: 'update_data_version' },
			{ updates_checked: {} },
		);
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('the inline run did not refuse');
}

const LOG_PATH = scratchFile('update_engine', 'update_engine.log');
afterAll(() => rmSync(LOG_PATH, { force: true }));

const FIXTURE: DataUpdateDescriptor = {
	versionMajor: 7,
	versionMedium: 0,
	versionMinor: 1,
	updateFromMajor: 7,
	updateFromMedium: 0,
	updateFromMinor: 0,
	updateData: true,
	sqlUpdate: ['SELECT 1'],
	runScripts: [
		{ info: 'ok step', scriptId: 'fixture.ok', stopOnError: true },
		{ info: 'soft fail', scriptId: 'fixture.soft_fail', stopOnError: false },
	],
};
const CATALOG = { [catalogKeyOf(FIXTURE)]: FIXTURE };
/** A second SQL step that fails — the whole run rolls back. */
const FAILING_SQL: DataUpdateDescriptor = {
	...FIXTURE,
	sqlUpdate: ['SELECT 1', 'SELECT no_such_column FROM pg_class'],
	runScripts: undefined,
};
/** A stop_on_error script that fails. */
const HARD_SCRIPT: DataUpdateDescriptor = {
	...FIXTURE,
	sqlUpdate: undefined,
	runScripts: [{ info: 'hard fail', scriptId: 'fixture.hard_fail', stopOnError: true }],
};

describe('catalog matching (PHP get_update_version semantics)', () => {
	test('linear updateFrom match; code-only releases skipped; empty current = null', () => {
		expect(getUpdateVersion([7, 0, 0], CATALOG)).toEqual([7, 0, 1]);
		expect(getUpdateVersion([6, 8, 10], CATALOG)).toBeNull();
		expect(getUpdateVersion([], CATALOG)).toBeNull();
		const codeOnly = { ...FIXTURE, updateData: false };
		expect(getUpdateVersion([7, 0, 0], { '701': codeOnly })).toBeNull();
		expect(getMatchedDescriptor([7, 0, 0], CATALOG)).toBe(FIXTURE);
	});

	test('the live catalog is EMPTY (7.0.0 is current — nothing to update)', () => {
		expect(getUpdateVersion([7, 0, 0])).toBeNull();
	});

	test('wire descriptor carries the PHP key shape the client checkbox-derives from', () => {
		const wire = toWireDescriptor(FIXTURE);
		expect(Object.keys(wire)).toEqual([
			'version_major',
			'version_medium',
			'version_minor',
			'update_from_major',
			'update_from_medium',
			'update_from_minor',
			'SQL_update',
			'run_scripts',
		]);
		expect((wire.run_scripts as Record<string, unknown>[])[0]).toEqual({
			info: 'ok step',
			script_class: 'ts_script',
			script_method: 'fixture.ok',
			stop_on_error: true,
			script_vars: [],
		});
	});
});

describe('engine step semantics (fixture catalog, injected writer)', () => {
	const scripts = {
		'fixture.ok': async () => ({ ok: true, msg: 'ok ran' }),
		'fixture.soft_fail': async () => ({ ok: false, msg: 'soft broke', errors: ['soft'] }),
		'fixture.hard_fail': async () => false,
	};

	function run(
		updatesChecked: Record<string, unknown>,
		descriptor: DataUpdateDescriptor = FIXTURE,
	) {
		const written: string[] = [];
		const outcome = updateVersion(updatesChecked, {
			catalog: { [catalogKeyOf(descriptor)]: descriptor },
			scripts,
			currentVersion: [7, 0, 0],
			readVersionInTx: async () => [7, 0, 0],
			logPath: LOG_PATH,
			writeVersionRow: async (version) => {
				written.push(version);
			},
			// Stub: the real reconciler sweeps live matrix rows (hermeticity).
			reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
		});
		return outcome.then((result) => ({ ...result, written }));
	}

	test('an unchecked SOFT script is skipped with a line; success stamps the version row (PHP tail bytes)', async () => {
		const out = await run({ SQL_update_0: true, run_scripts_0: true });
		expect(out.ok).toBe(true);
		expect(out.written).toEqual(['7.0.1']);
		expect(out.msg).toEqual([
			'Updated SQL_update 1',
			'Updated script: fixture.ok',
			'Skipped script: fixture.soft_fail (not re-offered)',
			'Observer mirrors reconciled: 0 repaired, 0 shrink(s) held (see update log)',
			'Updated Dédalo data version: 7.0.1',
			'Updated version successfully',
		]);
		const log = readFileSync(LOG_PATH, 'utf8');
		expect(log).toContain('Updating [SQL_update] 1 )))');
		expect(log).toContain('query: SELECT 1');
	});

	test('reconcile refusals are VISIBLE in the update message (sub-law + >2000 freeze)', async () => {
		// A refused record must never read as handled: the seam carries
		// sublawRefused AND bigResultRefused, and the summary line names both
		// (review 2026-08-02 — the freeze was log-file-only before).
		const out = await updateVersion(
			{ SQL_update_0: true, run_scripts_0: true },
			{
				catalog: CATALOG,
				scripts,
				currentVersion: [7, 0, 0],
				readVersionInTx: async () => [7, 0, 0],
				logPath: LOG_PATH,
				writeVersionRow: async () => {},
				reconcileMirrors: async () => ({
					repaired: 4,
					shrinksSkipped: 2,
					sublawRefused: 1,
					bigResultRefused: 3,
				}),
			},
		);
		expect(out.ok).toBe(true);
		expect(out.msg).toContain(
			'Observer mirrors reconciled: 4 repaired, 2 shrink(s) held, 1 observer(s) REFUSED (unported sub-law), 3 record(s) at the >2000-reference freeze (not written) (see update log)',
		);
	});

	test('a failing SQL step HARD-ABORTS and rolls back: no version row, PHP abort log bytes', async () => {
		const out = await run({ SQL_update_0: true, SQL_update_1: true }, FAILING_SQL);
		expect(out.ok).toBe(false);
		expect(out.written).toEqual([]);
		expect(out.msg[0]).toBe('Updated SQL_update 1');
		expect(out.msg[1]).toStartWith('Error on SQL_update:');
		expect(out.msg[2]).toBe(ROLLED_BACK_LINE);
		expect(readFileSync(LOG_PATH, 'utf8')).toContain(
			'ERROR [SQL_update] 2\nThe result is false. Check your query sentence. The update process aborted.',
		);
	});

	test('run_scripts: soft failure continues, stop_on_error aborts without the version row', async () => {
		const soft = await run({ SQL_update_0: true, run_scripts_0: true, run_scripts_1: true });
		expect(soft.ok).toBe(true); // soft fail did not abort
		expect(soft.msg).toContain('Error updating Dédalo data');
		expect(soft.written).toEqual(['7.0.1']);

		const hard = await run({ run_scripts_0: true }, HARD_SCRIPT);
		expect(hard.ok).toBe(false);
		expect(hard.errors).toContain('unable to run update script');
		expect(hard.written).toEqual([]);
		expect(hard.msg.at(-1)).toBe(ROLLED_BACK_LINE);
	});

	test('checkbox values must be strictly true (PHP !== true): a required step so "checked" is REFUSED', async () => {
		// The selection rule (OPS-6): the stamp claims every SQL step and every
		// stop_on_error script, so a truthy-but-not-true value leaves a required
		// step unchecked and the run is refused before any statement.
		const refusal = await refusalOf(
			run({ SQL_update_0: 'true', run_scripts_0: true, run_scripts_1: 1 }),
		);
		expect(refusal.code).toBe('update.refused');
		// A soft script with a non-true value is skipped, the run succeeds.
		const out = await run({ SQL_update_0: true, run_scripts_0: true, run_scripts_1: 1 });
		expect(out.ok).toBe(true);
		expect(out.msg).toContain('Skipped script: fixture.soft_fail (not re-offered)');
	});

	test('components_update descriptors are refused in PREFLIGHT, LOUDLY (ledgered unsupported path)', async () => {
		const withComponents = {
			'701': { ...FIXTURE, componentsUpdate: ['component_date'] } as DataUpdateDescriptor,
		};
		// The uncovered-scope refusal is REGISTERED (`engine.uncovered_scope`);
		// the ledgered sentence stays the LOG-only message.
		const refusal = await refusalOf(
			updateVersion(
				{ components_update_0: true },
				{
					catalog: withComponents,
					scripts,
					currentVersion: [7, 0, 0],
					logPath: LOG_PATH,
					writeVersionRow: async () => {},
				},
			),
		);
		expect(refusal.code).toBe('engine.uncovered_scope');
		expect(refusal.message).toMatch(/components_update steps are not supported/);
	});

	test('no matching descriptor: PHP nothing-to-update bytes', async () => {
		const out = await updateVersion(
			{},
			{
				catalog: CATALOG,
				currentVersion: [6, 8, 10],
				logPath: LOG_PATH,
				writeVersionRow: async () => {},
			},
		);
		expect(out.ok).toBe(false);
		expect(out.msg).toEqual(['Unable to get proper update version. Nothing to update']);
	});
});

describe('readInstalledDataVersionStrict (the engine re-read), built in a rolled-back transaction', () => {
	test('the newest version row; [] only when matrix_updates is absent; any other failure throws (the panel read degrades to [])', async () => {
		await assertTestDatabase('update_engine:strict_reader');
		const probeRollback = new Error('update_engine strict-reader probe: roll back');
		const seen: Record<string, unknown> = {};
		// Every write below is undone by the ROLLBACK: nothing of the suite DB's
		// matrix_updates changes, and nothing ambient is read — the situation
		// (a newest row 7.9.99; then no table; then a failed read) is built here.
		const outcome = await withTransaction(async () => {
			await appendMatrixUpdateRow({ dedalo_version: '7.9.99', update_date: '2026-09-30 00:00:00' });
			seen.newest = await readInstalledDataVersionStrict();
			await sql.unsafe('ALTER TABLE "matrix_updates" RENAME TO "matrix_updates_zz_probe"', []);
			seen.absent = await readInstalledDataVersionStrict();
			// The 42P01 above aborted the transaction: the next read fails (25P02).
			seen.strictAfterAbort = await readInstalledDataVersionStrict().then(
				(value) => ({ value }),
				(error: { errno?: string }) => ({ errno: error?.errno }),
			);
			seen.panelAfterAbort = await getCurrentDataVersion();
			throw probeRollback;
		}).then(
			() => 'committed',
			(error: unknown) => error,
		);
		expect(outcome).toBe(probeRollback);
		expect(seen.newest).toEqual([7, 9, 99]);
		expect(seen.absent).toEqual([]);
		expect(seen.strictAfterAbort).toEqual({ errno: '25P02' });
		expect(seen.panelAfterAbort).toEqual([]);
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "matrix_updates" WHERE data->>'dedalo_version' = '7.9.99'`,
			[],
		)) as { n: number }[];
		expect(rows[0]?.n, 'the probe row survived its rollback').toBe(0);
	});
});

/** Wait (bounded) until a submitted job is no longer queued or running. */
async function settleJob(id: string): Promise<void> {
	for (let tries = 0; tries < 200; tries++) {
		const status = mediaJobs.status(id)?.status;
		if (status !== 'queued' && status !== 'running') break;
		await Bun.sleep(25);
	}
}

describe('widget open mode (mocked gate; engine short-circuits on the empty catalog)', () => {
	const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;

	test('inline run reaches the engine and reports nothing-to-update', async () => {
		mock.module('../../src/core/update/ownership.ts', () => ({
			...REAL_OWNERSHIP,
			engineOwnsInstall: () => true,
		}));
		setServerState({ maintenance_mode: true });
		try {
			// live catalog is empty → the engine's no-descriptor refusal, not the
			// coexisting bespoke denial (proves the OPEN branch ran). Since the P1
			// error sweep that refusal is a THROW of maintenance.action_failed whose
			// PUBLIC sentence is the engine's own.
			const emptyBackups = join(BACKUP_SCRATCH, 'empty');
			mkdirSync(emptyBackups, { recursive: true });
			const error = await withScratchBackups({ backupDir: emptyBackups }, () =>
				inlineRefusal(SUPERUSER),
			);
			expect(error.code).toBe('maintenance.action_failed');
			expect(error.publicMessage).toContain(
				'Unable to get proper update version. Nothing to update',
			);
		} finally {
			setServerState({ maintenance_mode: false });
			mock.module('../../src/core/update/ownership.ts', () => REAL_OWNERSHIP);
		}
	});

	test('inline run: the backup warning waits a BOUNDED time, then carries the settled verdict', async () => {
		// The inline run is an HTTP request: it must never await a full archive read
		// (the server's idle timeout would cut it). Replacing the bounded look with
		// the settled `backupFreshness`, or dropping the warnings, reds here.
		mock.module('../../src/core/update/ownership.ts', () => ({
			...REAL_OWNERSHIP,
			engineOwnsInstall: () => true,
		}));
		setServerState({ maintenance_mode: true });
		const dir = join(BACKUP_SCRATCH, 'cut');
		const binDir = join(BACKUP_SCRATCH, 'cut_bin');
		const gate = join(BACKUP_SCRATCH, 'cut.release');
		mkdirSync(dir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		const archive = join(dir, '2026-01-01_000000.zz.postgresql_-1_forced_dbv7.custom.backup');
		writeFileSync(archive, 'PGDMP a dump cut short');
		const halfHourAgo = new Date(Date.now() - 30 * 60_000);
		utimesSync(archive, halfHourAgo, halfHourAgo);
		// The TOC lists; the FULL read blocks until released, then reports the cut.
		writeFileSync(
			join(binDir, 'pg_restore'),
			`#!/bin/sh\nif [ "$1" = "--list" ]; then exit 0; fi\ni=0\nwhile [ ! -f '${gate}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done\necho "pg_restore: error: could not read from input file: end of file" >&2\nexit 1\n`,
		);
		chmodSync(join(binDir, 'pg_restore'), 0o755);
		try {
			await withScratchBackups({ backupDir: dir, pgBinPath: binDir }, async () => {
				const startedAt = Date.now();
				const pending = await inlineRefusal(SUPERUSER);
				expect(Date.now() - startedAt).toBeLessThan(PANEL_WAIT_MS + 5000);
				expect(pending.publicMessage).toContain('is still being verified');
				writeFileSync(gate, '');
				await newestUsableBackup(dir); // the shared scan, settled
				const settled = await inlineRefusal(SUPERUSER);
				expect(settled.publicMessage).toContain('did not verify (truncated)');
			});
		} finally {
			writeFileSync(gate, '');
			setServerState({ maintenance_mode: false });
			mock.module('../../src/core/update/ownership.ts', () => REAL_OWNERSHIP);
		}
	}, 60_000);

	test('a background run is submitted with NO deadline (deadline_ms 0) on a lane that has one', async () => {
		// An atomic run cannot be cut by a clock: a deadline firing mid-run rolls
		// the whole unit back, and the rerun meets the same clock. The positive
		// control proves the 0 is the submit's override, not the lane's default.
		setServerState({ maintenance_mode: true });
		try {
			const response = (await dispatchWidgetRequest(
				SUPERUSER,
				{ model: 'update_data_version', action: 'update_data_version' },
				{ updates_checked: {}, background_running: true },
			)) as { extend?: { pfile?: string } };
			const jobId = (response.extend?.pfile ?? '').replace(/\.json$/, '');
			const record = mediaJobs.status(jobId);
			expect(record?.kind, `no update_data job for pfile ${response.extend?.pfile}`).toBe(
				'update_data',
			);
			expect(record?.lane).toBe('maintenance');
			expect(record?.deadline_ms, 'the update job inherits the lane deadline').toBe(0);
			const control = mediaJobs.submit('zz_update_deadline_control', async () => true, {
				lane: 'maintenance',
			});
			expect(
				control.deadline_ms,
				'the maintenance lane has no deadline here (vacuous leg)',
			).toBeGreaterThan(0);
			await settleJob(jobId);
			await settleJob(control.id);
		} finally {
			setServerState({ maintenance_mode: false });
		}
	});

	test("a background run hands the engine the JOB's abort signal: stopping the job aborts the run", async () => {
		// The widget's worker is the ONLY place the job's signal reaches the
		// engine; the engine's own abort leg (update_engine_atomic_native (e))
		// proves a signal cancels the running statement. Dropping `{ signal }`
		// here would leave a stopped job's migration running (and committing)
		// while the job reads "stopped". The engine is replaced by a probe that
		// records the third argument and waits for its abort.
		let captured: AbortSignal | undefined | 'not called' = 'not called';
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mock.module('../../src/core/update/engine.ts', () => ({
			...REAL_ENGINE,
			updateVersion: async (
				_checked: Record<string, unknown>,
				_seams?: unknown,
				run?: { signal?: AbortSignal },
			) => {
				captured = run?.signal;
				entered();
				const signal = run?.signal;
				if (signal !== undefined) {
					await new Promise<void>((resolve) =>
						signal.addEventListener('abort', () => resolve(), { once: true }),
					);
				}
				return { ok: false, msg: ['probe'], errors: [] };
			},
		}));
		setServerState({ maintenance_mode: true });
		try {
			const response = (await dispatchWidgetRequest(
				SUPERUSER,
				{ model: 'update_data_version', action: 'update_data_version' },
				{ updates_checked: {}, background_running: true },
			)) as { extend?: { pfile?: string } };
			const jobId = (response.extend?.pfile ?? '').replace(/\.json$/, '');
			await Promise.race([started, Bun.sleep(5000)]);
			const signal = captured as AbortSignal | undefined | 'not called';
			expect(signal, 'the job worker never reached the engine').not.toBe('not called');
			expect(signal, 'the widget handed the engine no abort signal').toBeInstanceOf(AbortSignal);
			expect((signal as AbortSignal).aborted).toBe(false);
			expect(mediaJobs.stop(jobId), `job ${jobId} could not be stopped`).toBe(true);
			expect((signal as AbortSignal).aborted, 'stopping the job did not abort the run').toBe(true);
			expect(jobAbortInfo(signal as AbortSignal)?.cause).toBe('stop');
			await settleJob(jobId);
		} finally {
			setServerState({ maintenance_mode: false });
			mock.module('../../src/core/update/engine.ts', () => REAL_ENGINE);
		}
	});
});
