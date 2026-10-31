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

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import * as realConfigModule from '../../src/config/config.ts';
import { processEnvValue, readEnv, seedProcessEnv, unsetProcessEnv } from '../../src/config/env.ts';
import * as realBackupModule from '../../src/core/area_maintenance/backup.ts';
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
	dataVersionState,
	refreshDataVersionState,
	resetBootStateForTest,
} from '../../src/core/update/boot_state.ts';
import * as realCatalogModule from '../../src/core/update/catalog.ts';
import {
	catalogKeyOf,
	type DataUpdateDescriptor,
	getMatchedDescriptor,
	getUpdateVersion,
	rungAboveCodeData,
	toWireDescriptor,
} from '../../src/core/update/catalog.ts';
import * as realEngine from '../../src/core/update/engine.ts';
import { ROLLED_BACK_LINE, updateVersion } from '../../src/core/update/engine.ts';
import * as realOwnership from '../../src/core/update/ownership.ts';
import { PANEL_WAIT_MS } from '../../src/core/update/preconditions.ts';
import * as realScriptsModule from '../../src/core/update/scripts.ts';
import { DEDALO_DATA_VERSION } from '../../src/core/update/version.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { removeScratchDir, scratchDir, scratchFile } from '../helpers/scratch_dir.ts';

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
			// the door's backup leg is gated in update_door_precondition_class_tripwire;
			// these cases are about the engine behind it
			{ updates_checked: {}, waive_backup: true },
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
	versionMedium: 1,
	versionMinor: 0,
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
		expect(getUpdateVersion([7, 0, 0], CATALOG)).toEqual([7, 1, 0]);
		expect(getUpdateVersion([6, 8, 10], CATALOG)).toBeNull();
		expect(getUpdateVersion([], CATALOG)).toBeNull();
		const codeOnly = { ...FIXTURE, updateData: false };
		expect(getUpdateVersion([7, 0, 0], { '7.0.1': codeOnly })).toBeNull();
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
			// the fake rung (7.1.0) is above this tree's data version: the code it simulates
			codeDataVersion: [7, 1, 0],
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
		expect(out.written).toEqual(['7.1.0']);
		expect(out.msg).toEqual([
			'Updated SQL_update 1',
			'Updated script: fixture.ok',
			'Skipped script: fixture.soft_fail (not re-offered)',
			'Observer mirrors reconciled: 0 repaired, 0 shrink(s) held (see update log)',
			'Updated Dédalo data version: 7.1.0',
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
				// the fake rung (7.1.0) is above this tree's data version: the code it simulates
				codeDataVersion: [7, 1, 0],
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
			'Observer mirrors reconciled: 4 repaired, 2 shrink(s) held, 1 observer(s) REFUSED (ambiguous or malformed value law), 3 record(s) at the >2000-reference freeze (not written) (see update log)',
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
		expect(soft.written).toEqual(['7.1.0']);

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
			'7.1.0': { ...FIXTURE, componentsUpdate: ['component_date'] } as DataUpdateDescriptor,
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
					// the fake rung (7.1.0) is above this tree's data version: the code it simulates
					codeDataVersion: [7, 1, 0],
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

describe("no rung above the code's own data version", () => {
	const okScript = mock(async () => ({ ok: true, msg: 'ran' }));
	/** A one-script data rung `from` → `target` (every version derived by the caller, none pinned here). */
	function rung(from: readonly number[], target: readonly number[]): DataUpdateDescriptor {
		return {
			...FIXTURE,
			versionMajor: target[0] as number,
			versionMedium: target[1] as number,
			versionMinor: target[2] as number,
			updateFromMajor: from[0] as number,
			updateFromMedium: from[1] as number,
			updateFromMinor: from[2] as number,
			runScripts: [{ info: 'ok step', scriptId: 'fixture.ok', stopOnError: true }],
		};
	}
	interface Attempt {
		/** The `codeDataVersion` seam; undefined = the production default. */
		code: readonly number[] | undefined;
		descriptor?: DataUpdateDescriptor;
		updatesChecked?: Record<string, unknown>;
		logPath?: string;
	}
	function attempt({
		code,
		descriptor = FIXTURE_RUNG,
		updatesChecked = { SQL_update_0: true, run_scripts_0: true },
		logPath = LOG_PATH,
	}: Attempt) {
		const written: string[] = [];
		const steps: string[] = [];
		const from = [
			descriptor.updateFromMajor,
			descriptor.updateFromMedium,
			descriptor.updateFromMinor,
		];
		okScript.mockClear();
		const outcome = updateVersion(updatesChecked, {
			catalog: { [catalogKeyOf(descriptor)]: descriptor },
			scripts: { 'fixture.ok': okScript },
			currentVersion: from,
			...(code === undefined ? {} : { codeDataVersion: code }),
			readVersionInTx: async () => {
				steps.push('readVersionInTx');
				return from;
			},
			logPath,
			writeVersionRow: async (version) => {
				written.push(version);
			},
			reconcileMirrors: async () => {
				steps.push('reconcileMirrors');
				return { repaired: 0, shrinksSkipped: 0 };
			},
		});
		return { outcome, written, steps };
	}
	/** The seam cases: FIXTURE's own 7.0.0 → 7.1.0 rung, the code version passed explicitly. */
	const FIXTURE_RUNG = rung([7, 0, 0], [7, 1, 0]);
	/** The DEFAULT cases: built FROM DEDALO_DATA_VERSION, so they hold across every data-version bump. */
	const CODE = [...DEDALO_DATA_VERSION];
	const NEXT_MEDIUM = [CODE[0] as number, (CODE[1] as number) + 1, 0];
	const PREVIOUS_MAJOR = [(CODE[0] as number) - 1, 0, 0];

	test('rungAboveCodeData is pure and strict on both sides', () => {
		expect(rungAboveCodeData([7, 1, 0], [7, 0, 0])).toBe(true);
		expect(rungAboveCodeData([7, 0, 1], [7, 0, 0])).toBe(true);
		expect(rungAboveCodeData([8, 0, 0], [7, 9, 9])).toBe(true);
		expect(rungAboveCodeData([7, 1, 0], [7, 1, 0])).toBe(false);
		expect(rungAboveCodeData([7, 0, 0], [7, 1, 0])).toBe(false);
		expect(rungAboveCodeData([6, 8, 10], [7, 0, 0])).toBe(false);
	});

	test('a rung above codeDataVersion is REFUSED (update.refused, rule rung_above_code): no step, no script, no version row', async () => {
		const run = attempt({ code: [7, 0, 0] });
		const refusal = await refusalOf(run.outcome);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.coordinates).toMatchObject({
			rule: 'rung_above_code',
			target: '7.1.0',
			code: '7.0.0',
		});
		expect(okScript).not.toHaveBeenCalled();
		expect(run.written).toEqual([]);
		expect(run.steps).toEqual([]);
	});

	test('the refusal comes BEFORE the preflight and the log file: a rung above the code that ALSO breaks the validator and leaves a required box unchecked answers rung_above_code, and the log path is never created', async () => {
		const logPath = scratchFile('update_engine_rung_order', 'never_created.log');
		// unregistered script id (validator refusal) + run_scripts_0 unchecked (selection refusal):
		// either preflight leg would answer first if the rung check moved below it
		const broken: DataUpdateDescriptor = {
			...FIXTURE_RUNG,
			runScripts: [{ info: 'unregistered', scriptId: 'fixture.unregistered', stopOnError: true }],
		};
		const run = attempt({
			code: [7, 0, 0],
			descriptor: broken,
			updatesChecked: { SQL_update_0: true },
			logPath,
		});
		const refusal = await refusalOf(run.outcome);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.coordinates).toMatchObject({ rule: 'rung_above_code' });
		expect(existsSync(logPath)).toBe(false);
		expect(run.steps).toEqual([]);
		// anti-vacuity: at the code's own version the same descriptor IS a preflight refusal
		const control = attempt({
			code: [7, 1, 0],
			descriptor: broken,
			updatesChecked: { SQL_update_0: true },
			logPath,
		});
		const preflightRefusal = await refusalOf(control.outcome);
		expect(preflightRefusal.coordinates?.rule).not.toBe('rung_above_code');
		expect(existsSync(logPath)).toBe(false);
	});

	test('control: a rung EQUAL to codeDataVersion runs and stamps its version row', async () => {
		const run = attempt({ code: [7, 1, 0] });
		const out = await run.outcome;
		expect(out.ok).toBe(true);
		expect(okScript).toHaveBeenCalledTimes(1);
		expect(run.written).toEqual(['7.1.0']);
	});

	test('no seam: the default is DEDALO_DATA_VERSION — a rung one medium above it is refused', async () => {
		const run = attempt({ code: undefined, descriptor: rung(CODE, NEXT_MEDIUM) });
		const refusal = await refusalOf(run.outcome);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.coordinates).toMatchObject({
			rule: 'rung_above_code',
			target: NEXT_MEDIUM.join('.'),
			code: CODE.join('.'),
		});
		expect(okScript).not.toHaveBeenCalled();
		expect(run.written).toEqual([]);
	});

	test('no seam, control: a rung whose target IS DEDALO_DATA_VERSION runs and stamps it', async () => {
		const run = attempt({ code: undefined, descriptor: rung(PREVIOUS_MAJOR, CODE) });
		const out = await run.outcome;
		expect(out.ok).toBe(true);
		expect(okScript).toHaveBeenCalledTimes(1);
		expect(run.written).toEqual([CODE.join('.')]);
	});
});

/**
 * The `codeDataVersion` seam must never reach the engine from a SHIPPED door
 * (engineering/wire_contract/WC-2026-10-31-update-rung-above-code.md). Measured
 * as an OUTCOME, not a spelling: every production caller of `updateVersion` —
 * the update_data_version widget (inline and background) and the update run's
 * data phase (run/production.ts DATA_PHASE_DEPS.runRung) — is driven with a
 * catalog rung one medium ABOVE DEDALO_DATA_VERSION, and each must answer
 * `update.refused` / `rung_above_code` with no script run and no log opened. A
 * door that forwards a seams object carrying `codeDataVersion` (however it is
 * spelled — a forwarded options bag, a spread, a computed key) lifts the ceiling
 * and reds its leg. The importer census pins the set of doors: a new importer
 * of engine.ts reds until it gets a leg here.
 *
 * The situation is module-level: catalog.ts UPDATE_CATALOG, scripts.ts
 * SCRIPT_REGISTRY and backup.ts' version readers are spread-snapshot mocks
 * (re-installed after each case); UPDATE_LOG_FILE points at a scratch path. The
 * engine refuses before its preflight, its log and its transaction, so nothing
 * here writes the suite database.
 */
/**
 * The importer census: every file under `dirs` (relative to `root`) whose static
 * or dynamic relative/absolute import RESOLVES (the way the runtime does — an
 * extension-less, `.js`, directory-index or absolute spelling counts the same)
 * to `target`. Sorted, unique, repo-relative. `.d.ts` files carry no runtime
 * import; a shebang line is blanked (scanImports refuses it).
 */
function importersOf(
	target: string,
	root: string,
	dirs: readonly string[],
): { importers: string[]; scanned: number } {
	const importers = new Set<string>();
	let scanned = 0;
	for (const dir of dirs) {
		if (!existsSync(join(root, dir))) continue;
		for (const rel of new Glob('**/*.{ts,js,mjs}').scanSync({ cwd: join(root, dir) })) {
			const path = `${dir}/${rel}`;
			scanned += 1;
			if (path.endsWith('.d.ts')) continue;
			const loader = path.endsWith('.ts') ? 'ts' : 'js';
			const source = readFileSync(join(root, path), 'utf8').replace(/^#!.*/, '');
			for (const { path: specifier } of new Bun.Transpiler({ loader }).scanImports(source)) {
				if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
				let resolved: string;
				try {
					resolved = Bun.resolveSync(specifier, join(root, dirname(path)));
				} catch {
					continue;
				}
				if (resolved === target) importers.add(path);
			}
		}
	}
	return { importers: [...importers].sort(), scanned };
}

describe('no shipped door lifts the rung-above-code ceiling', () => {
	const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;
	const CODE = [...DEDALO_DATA_VERSION];
	const NEXT_MEDIUM = [CODE[0] as number, (CODE[1] as number) + 1, 0];
	const PREVIOUS_MAJOR = [(CODE[0] as number) - 1, 0, 0];
	const sentinel = mock(async () => ({ ok: false, msg: 'door sentinel ran' }));
	function rungTo(from: readonly number[], target: readonly number[]): DataUpdateDescriptor {
		return {
			...FIXTURE,
			versionMajor: target[0] as number,
			versionMedium: target[1] as number,
			versionMinor: target[2] as number,
			updateFromMajor: from[0] as number,
			updateFromMedium: from[1] as number,
			updateFromMinor: from[2] as number,
			sqlUpdate: undefined,
			runScripts: [{ info: 'door sentinel', scriptId: 'fixture.door_sentinel', stopOnError: true }],
		};
	}
	/** The rung the doors must refuse: from the code's own version to one medium above it. */
	const ABOVE = rungTo(CODE, NEXT_MEDIUM);
	/** The control rung: its target IS the code's version — the ceiling lets it through. */
	const AT_CODE = rungTo(PREVIOUS_MAJOR, CODE);
	const CHECKED = { run_scripts_0: true };
	const REAL_CATALOG = { ...realCatalogModule };
	const REAL_SCRIPTS = { ...realScriptsModule };
	const REAL_BACKUP = { ...realBackupModule };
	const PRIOR_LOG_FILE = processEnvValue('UPDATE_LOG_FILE');
	const scratch = mkdtempSync(join(tmpdir(), 'dedalo_update_door_ceiling_'));
	/** Writable: a run that got past the ceiling would create it. */
	const logPath = join(scratch, 'update.log');
	/** Unwritable (a path under a regular file): the control run stops at the log, before any statement. */
	const blockedLogPath = join(scratch, 'not_a_dir', 'update.log');
	writeFileSync(join(scratch, 'not_a_dir'), '');

	function installSituation(descriptor: DataUpdateDescriptor, log: string): void {
		sentinel.mockClear();
		mock.module('../../src/core/update/catalog.ts', () => ({
			...REAL_CATALOG,
			UPDATE_CATALOG: Object.freeze({ [catalogKeyOf(descriptor)]: descriptor }),
		}));
		mock.module('../../src/core/update/scripts.ts', () => ({
			...REAL_SCRIPTS,
			SCRIPT_REGISTRY: Object.freeze({ 'fixture.door_sentinel': sentinel }),
		}));
		mock.module('../../src/core/area_maintenance/backup.ts', () => ({
			...REAL_BACKUP,
			getCurrentDataVersion: async () => [
				descriptor.updateFromMajor,
				descriptor.updateFromMedium,
				descriptor.updateFromMinor,
			],
			readInstalledDataVersionStrict: async () => [
				descriptor.updateFromMajor,
				descriptor.updateFromMedium,
				descriptor.updateFromMinor,
			],
		}));
		mock.module('../../src/core/update/ownership.ts', () => ({
			...REAL_OWNERSHIP,
			engineOwnsInstall: () => true,
		}));
		seedProcessEnv({ UPDATE_LOG_FILE: log });
		setServerState({ maintenance_mode: true });
	}
	afterEach(() => {
		mock.module('../../src/core/update/catalog.ts', () => REAL_CATALOG);
		mock.module('../../src/core/update/scripts.ts', () => REAL_SCRIPTS);
		mock.module('../../src/core/area_maintenance/backup.ts', () => REAL_BACKUP);
		mock.module('../../src/core/update/ownership.ts', () => REAL_OWNERSHIP);
		if (PRIOR_LOG_FILE === undefined) unsetProcessEnv(['UPDATE_LOG_FILE']);
		else seedProcessEnv({ UPDATE_LOG_FILE: PRIOR_LOG_FILE });
		setServerState({ maintenance_mode: false });
		rmSync(logPath, { force: true });
	});
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	/** The ceiling's refusal, as the engine throws it (target/code from this tree's constant). */
	function expectCeilingRefusal(error: unknown): void {
		expect(error).toBeInstanceOf(DedaloError);
		const refusal = error as DedaloError;
		expect(refusal.code).toBe('update.refused');
		expect(refusal.coordinates).toMatchObject({
			rule: 'rung_above_code',
			target: NEXT_MEDIUM.join('.'),
			code: CODE.join('.'),
		});
	}
	async function inlineDoor(): Promise<unknown> {
		const emptyBackups = join(scratch, 'backups');
		mkdirSync(emptyBackups, { recursive: true });
		return withScratchBackups({ backupDir: emptyBackups }, () =>
			dispatchWidgetRequest(
				SUPERUSER,
				{ model: 'update_data_version', action: 'update_data_version' },
				{ updates_checked: CHECKED, waive_backup: true },
			).then(
				(response) => ({ answered: response }),
				(error: unknown) => error,
			),
		);
	}
	async function productionRunRung(): Promise<unknown> {
		const { DATA_PHASE_DEPS } = await import('../../src/core/update/run/production.ts');
		return DATA_PHASE_DEPS.runRung().then(
			(response) => ({ answered: response }),
			(error: unknown) => error,
		);
	}

	test('the update_data_version widget, INLINE: refused, no script, no log', async () => {
		installSituation(ABOVE, logPath);
		expectCeilingRefusal(await inlineDoor());
		expect(sentinel).not.toHaveBeenCalled();
		expect(existsSync(logPath)).toBe(false);
	});

	test('control: the same inline door with a rung AT the code version passes the ceiling (stops at the log)', async () => {
		installSituation(AT_CODE, blockedLogPath);
		const error = await inlineDoor();
		expect(error).toBeInstanceOf(DedaloError);
		expect((error as DedaloError).code).toBe('maintenance.action_failed');
		expect((error as DedaloError).publicMessage).toContain('update_log file is not available');
		expect(sentinel).not.toHaveBeenCalled();
	});

	test('the update_data_version widget, BACKGROUND job: refused, no script, no log', async () => {
		installSituation(ABOVE, logPath);
		const response = (await dispatchWidgetRequest(
			SUPERUSER,
			{ model: 'update_data_version', action: 'update_data_version' },
			{ updates_checked: CHECKED, background_running: true, waive_backup: true },
		)) as { extend?: { pfile?: string } };
		const jobId = (response.extend?.pfile ?? '').replace(/\.json$/, '');
		await settleJob(jobId);
		const record = mediaJobs.status(jobId);
		expect(record?.kind, `no update_data job for pfile ${response.extend?.pfile}`).toBe(
			'update_data',
		);
		expect(record?.status).toBe('error');
		expect(record?.error?.code).toBe('update.refused');
		// the public sentence names the mocked rung's target: the refusal came from THIS situation
		expect(record?.errors.join('\n')).toContain(
			`the ${NEXT_MEDIUM.join('.')} data update needs a build of that version`,
		);
		expect(sentinel).not.toHaveBeenCalled();
		expect(existsSync(logPath)).toBe(false);
	});

	test('the update run data phase (run/production.ts DATA_PHASE_DEPS.runRung): refused, no script, no log', async () => {
		installSituation(ABOVE, logPath);
		expectCeilingRefusal(await productionRunRung());
		expect(sentinel).not.toHaveBeenCalled();
		expect(existsSync(logPath)).toBe(false);
	});

	test('control: the same data-phase door with a rung AT the code version passes the ceiling (stops at the log)', async () => {
		installSituation(AT_CODE, blockedLogPath);
		expect(await productionRunRung()).toEqual({
			answered: {
				ok: false,
				msg: ["Error (1). It's not possible set update_log file"],
				errors: ['update_log file is not available'],
			},
		});
		expect(sentinel).not.toHaveBeenCalled();
	});

	test('the doors above are EVERY importer of update/engine.ts under src/, tools/, scripts/ and install/', () => {
		const root = join(import.meta.dir, '..', '..');
		const engine = join(root, 'src', 'core', 'update', 'engine.ts');
		// Non-door importers, each with the reason it may reach updateVersion without a ceiling leg.
		const NON_DOOR_IMPORTERS: Record<string, string> = {
			'scripts/update_full_drill.ts':
				'opt-in drill harness on the marked suite DB; drives scratch rungs on purpose, never shipped as a door',
		};
		const { importers, scanned } = importersOf(engine, root, [
			'src',
			'tools',
			'scripts',
			'install',
		]);
		expect(scanned).toBeGreaterThan(100);
		// Each door is driven above. A new importer: give it a door leg and list it,
		// or (not shipped) list it in NON_DOOR_IMPORTERS with its reason.
		expect(importers.filter((path) => !(path in NON_DOOR_IMPORTERS))).toEqual([
			'src/core/area_maintenance/widgets/update_data_version.ts',
			'src/core/update/run/production.ts',
		]);
		// a stale exemption is red too: every listed non-door still imports the engine
		for (const path of Object.keys(NON_DOOR_IMPORTERS)) expect(importers).toContain(path);
	});

	test('the census counts every spelling of an import (extension-less, .js, absolute, dynamic, re-export, shebang .js)', () => {
		// A planted tree, run through the SAME census function as the live gate above:
		// a spelling the census misses goes red here, not silently green there.
		const root = scratchDir('update_engine_census', { realpath: true });
		try {
			const plant = (rel: string, text: string): void => {
				mkdirSync(join(root, dirname(rel)), { recursive: true });
				writeFileSync(join(root, rel), text);
			};
			plant('src/core/update/engine.ts', 'export const updateVersion = 1;\n');
			plant('src/core/update/index.ts', "export * from './engine.ts';\n");
			plant('src/core/update/types.d.ts', "import type { x } from './engine';\n");
			plant(
				'src/a/bare.ts',
				"import { updateVersion } from '../core/update/engine';\nexport { updateVersion };\n",
			);
			plant(
				'src/a/dot_ts.ts',
				"import { updateVersion } from '../core/update/engine.ts';\nexport { updateVersion };\n",
			);
			plant(
				'src/a/dot_js.ts',
				"import { updateVersion } from '../core/update/engine.js';\nexport { updateVersion };\n",
			);
			plant('src/a/dynamic.ts', "export const load = () => import('../core/update/engine');\n");
			plant(
				'src/a/absolute.ts',
				`import { updateVersion } from '${join(root, 'src/core/update/engine.ts')}';\nexport { updateVersion };\n`,
			);
			plant(
				'scripts/cli.js',
				"#!/usr/bin/env bun\nimport { updateVersion } from '../src/core/update/engine';\nconsole.log(updateVersion);\n",
			);
			plant(
				'src/a/via_index.ts',
				"import { updateVersion } from '../core/update';\nexport { updateVersion };\n",
			);
			plant(
				'src/a/unrelated.ts',
				"import { x } from '../core/update/engine_not';\nimport { y } from 'node:fs';\nexport { x, y };\n",
			);
			const engine = join(root, 'src', 'core', 'update', 'engine.ts');
			expect(importersOf(engine, root, ['src', 'scripts']).importers).toEqual([
				'scripts/cli.js',
				'src/a/absolute.ts',
				'src/a/bare.ts',
				'src/a/dot_js.ts',
				'src/a/dot_ts.ts',
				'src/a/dynamic.ts',
				'src/core/update/index.ts',
			]);
		} finally {
			removeScratchDir(root);
		}
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
				{ updates_checked: {}, background_running: true, waive_backup: true },
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
				{ updates_checked: {}, background_running: true, waive_backup: true },
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

describe('a committed rung re-reads the served data version (U-04)', () => {
	// The engine re-classifies with the REAL strict reader (no seam): a read-only
	// matrix_updates SELECT on the suite database. The rung itself writes nothing
	// (injected version writer + reconcile stub, as in the step-semantics cases).
	afterEach(() => {
		resetBootStateForTest();
	});

	function committedRung() {
		return updateVersion(
			{ SQL_update_0: true },
			{
				catalog: { [catalogKeyOf(FIXTURE)]: { ...FIXTURE, runScripts: undefined } },
				scripts: {},
				currentVersion: [7, 0, 0],
				// the fake rung (7.1.0) is above this tree's data version: the code it simulates
				codeDataVersion: [7, 1, 0],
				readVersionInTx: async () => [7, 0, 0],
				logPath: LOG_PATH,
				writeVersionRow: async () => {},
				reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
			},
		);
	}

	test('a recorded state (a served process) is RE-READ after the commit — it moves off the seeded value', async () => {
		// Seed with a version no database holds: only a re-read after the rung can
		// replace it. Delete refreshServedDataVersion() in updateVersion → stays 0.0.1.
		await refreshDataVersionState(async () => [0, 0, 1]);
		expect(dataVersionState()?.installed).toBe('0.0.1');
		const out = await committedRung();
		expect(out.ok).toBe(true);
		const reread = await readInstalledDataVersionStrict();
		expect(reread.length).toBeGreaterThan(0);
		expect(dataVersionState()?.installed).toBe(reread.join('.'));
		expect(dataVersionState()?.installed).not.toBe('0.0.1');
	});

	test('no recorded state (a test / CLI process) → the engine starts no read of its own', async () => {
		const out = await committedRung();
		expect(out.ok).toBe(true);
		expect(dataVersionState()).toBeNull();
	});
});
