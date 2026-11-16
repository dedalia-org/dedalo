/**
 * AN INSTALLED TREE IS REFUSED WHERE IT IS FIRST KNOWABLE, IN THE RUN'S WORDS
 * (T1-P08, engineering/TODO.md TODO-050). On HEAD 180b1770a1 an install over
 * an installed checkout walked every screen and was refused only by the run,
 * after the Review and a typed `yes`. Gated by OUTCOME:
 *
 *  1. developer: a finished engine record / a SEALED state file is an
 *     `Installation` FAIL row on the System check (screen 2) whose detail IS
 *     the run's sentence (installed_here.ts — one rule, one wording); an
 *     unfinished record is not (the Welcome offers resume/abort for it), an
 *     empty private dir is an ok row (anti-vacuity); the probe creates nothing;
 *  2. the session over the REAL System check quits from screen 2 — never
 *     reaches the Database screen;
 *  3. docker: the instance volume, the checkout's earlier stack files and the
 *     stack's host record fail the System check with the run's sentences
 *     (stack/preflight.ts existingStackProblems, host_executor.ts
 *     hostRecordSentence); production: a host run record with no registry
 *     entry fails the Instance row;
 *  4. the Database screen's probe says a non-empty / not-owned target with the
 *     run's sentences (fresh_target.ts); production `--db-mode create` never
 *     inspects;
 *  5. the developer Review preflight carries the same refusal; the delegated
 *     engine child's does not;
 *  6. the real plain installer quit over a FINISHED record says "nothing was
 *     installed", never "the unfinished install is kept" (PTY).
 *
 * DB-free (the database probe's reads are seams). Writes only under this
 * file's mkdtemp root.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processEnvValue, seedProcessEnv, unsetProcessEnv } from '../../src/config/env.ts';
import type { TargetDatabaseState } from '../../src/core/install/db_restore.ts';
import { freshTargetProblems } from '../../src/core/install/fresh_target.ts';
import { hostRecordSentence } from '../../src/core/install/host/host_executor.ts';
import { INSTALL_STATE_ROOT, STACK_RUN_DIR } from '../../src/core/install/host/layout.ts';
import { reviewPreflightRefusals } from '../../src/core/install/host/review.ts';
import { SCRATCH_MARKER } from '../../src/core/install/host/scratch.ts';
import { sourceTreeRoot } from '../../src/core/install/host/source.ts';
import { ENV_FILE, PRIVATE_VOLUME, stackFileOf } from '../../src/core/install/host/stack/layout.ts';
import { existingStackProblems } from '../../src/core/install/host/stack/preflight.ts';
import { buildInstallPlan, normalizeInstallAnswers } from '../../src/core/install/install_plan.ts';
import { runInteractiveInstall } from '../../src/core/install/install_session.ts';
import {
	engineInstalledHere,
	engineRecordSentence,
	peekInstallStatus,
	SEALED_PRIVATE_DIR,
} from '../../src/core/install/installed_here.ts';
import type { PsqlProbe } from '../../src/core/install/pg_bin.ts';
import { databaseProbe, systemCheck } from '../../src/core/install/probes.ts';
import { type InstallState, STATE_FILE, STATE_SCHEMA } from '../../src/core/install/run_files.ts';
import { scriptedInstallPrompter } from '../../src/core/install/ui_plain/prompter.ts';
import { emptyTarget } from '../helpers/install_fake_executor.ts';
import { scratchStackFacts } from '../helpers/install_host_scratch.ts';
import { allCases, splitCase } from '../helpers/install_parity_cases.ts';
import {
	fakeProbes,
	GOOD_ROOT_PASSWORD,
	scriptForPlan,
	thesaurusOffer,
} from '../helpers/install_plain_script.ts';

const ROOT = join(import.meta.dir, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'dedalo_install_existing_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PSQL: PsqlProbe = {
	state: 'found',
	path: '/usr/bin/psql',
	version: 'psql (PostgreSQL) 18.1',
};
const psql = (): PsqlProbe => PSQL;

/** Run `work` with `values` set (undefined: unset) and the previous values restored. */
async function withEnv<T>(
	values: Readonly<Record<string, string | undefined>>,
	work: () => Promise<T>,
): Promise<T> {
	const previous = Object.fromEntries(
		Object.keys(values).map((key) => [key, processEnvValue(key)]),
	);
	const apply = (set: Readonly<Record<string, string | undefined>>): void => {
		for (const [key, value] of Object.entries(set)) {
			if (value === undefined) unsetProcessEnv([key]);
			else seedProcessEnv({ [key]: value });
		}
	};
	apply(values);
	try {
		return await work();
	} finally {
		apply(previous);
	}
}

/** A private dir (with its own state file) holding a run record of `outcome` (null: none). */
function privateDirWith(outcome: InstallState['outcome'] | null, installStatus?: string) {
	const dir = mkdtempSync(join(scratch, 'private_'));
	if (outcome !== null) {
		mkdirSync(join(dir, 'install'), { recursive: true });
		writeFileSync(
			join(dir, 'install', STATE_FILE),
			JSON.stringify({ schema: STATE_SCHEMA, outcome, steps: {}, runs: [] }),
		);
	}
	if (installStatus !== undefined) {
		writeFileSync(join(dir, 'ts_state.json'), JSON.stringify({ install_status: installStatus }));
	}
	return {
		dir,
		env: { DEDALO_INSTALL_PRIVATE_DIR: dir, DEDALO_TS_STATE_PATH: join(dir, 'ts_state.json') },
	};
}

const installationRows = (rows: readonly { label: string; state: string; detail: string }[]) =>
	rows.filter((row) => row.label === 'Installation');

describe('1. developer: the System check says an installed tree, in the run’s words', () => {
	test('a FINISHED record: an Installation FAIL row = the run’s sentence; the check is not ok', async () => {
		const { dir, env } = privateDirWith('complete');
		await withEnv(env, async () => {
			const outcome = await systemCheck('developer', { psql });
			const rows = installationRows(outcome.rows ?? []);
			const expected = engineRecordSentence(
				join(dir, 'install'),
				{ outcome: 'complete' } as InstallState,
				'<db>',
			);
			expect(rows).toEqual([{ state: 'fail', label: 'Installation', detail: expected }]);
			expect(expected).toContain('already installed');
			expect(expected).not.toContain('--abort');
			expect(outcome.ok).toBe(false);
		});
	});

	test('a SEALED state file: a FAIL row with the run’s SEALED sentence', async () => {
		const { env } = privateDirWith(null, 'sealed');
		await withEnv(env, async () => {
			const rows = installationRows((await systemCheck('developer', { psql })).rows ?? []);
			expect(rows.map((row) => [row.state, row.detail])).toEqual([['fail', SEALED_PRIVATE_DIR]]);
		});
	});

	test('CONTROLS: an empty private dir is an ok row; an UNFINISHED record is the Welcome’s, not a fail', async () => {
		const empty = privateDirWith(null);
		await withEnv(empty.env, async () => {
			const rows = installationRows((await systemCheck('developer', { psql })).rows ?? []);
			expect(rows.map((row) => row.state)).toEqual(['ok']);
		});
		const unfinished = privateDirWith('in_progress', 'terminal_installing');
		await withEnv(unfinished.env, async () => {
			expect(engineInstalledHere()).toEqual([]);
			const rows = installationRows((await systemCheck('developer', { psql })).rows ?? []);
			expect(rows.map((row) => row.state)).toEqual(['ok']);
		});
	});

	test('read-only: peeking a state file whose directory is missing creates nothing', async () => {
		const missing = join(scratch, 'never_created');
		await withEnv(
			{ DEDALO_INSTALL_PRIVATE_DIR: missing, DEDALO_TS_STATE_PATH: join(missing, 'ts_state.json') },
			async () => {
				expect(peekInstallStatus()).toBeUndefined();
				expect(engineInstalledHere()).toEqual([]);
			},
		);
		expect(existsSync(missing)).toBe(false);
	});
});

const CASES = allCases(join(scratch, 'unused_source'));

/** The developer case's flags plan and the script that walks it (Review: quit). */
function developerWalk() {
	const answerCase = CASES.find((item) => item.name === 'route developer (explicit)');
	if (answerCase === undefined) throw new Error('no developer case');
	const { raw, plain } = splitCase(answerCase.argv);
	const flags = buildInstallPlan(raw);
	expect(flags.errors).toEqual([]);
	const script = scriptForPlan(flags, Object.keys(plain), { root_password: GOOD_ROOT_PASSWORD }, [
		'quit',
	]);
	return { flags, script };
}

describe('2. the session over the REAL System check stops at screen 2', () => {
	test('a finished record: quit from the System check, the Database screen never shown', async () => {
		const { env } = privateDirWith('complete');
		await withEnv(env, async () => {
			const { script } = developerWalk();
			script.answers['system.probe_action'] = 'quit';
			const prompter = scriptedInstallPrompter(script);
			const probes = fakeProbes();
			probes.system = async (route, instance) => systemCheck(route, { psql }, instance ?? '');
			const result = await runInteractiveInstall({
				prompter,
				probes,
				priorEnv: {},
				thesauri: thesaurusOffer(),
				host: {},
				givenSecrets: {},
				unfinished: null,
			});
			expect(result.kind).toBe('quit');
			expect(prompter.asked).toContain('screen:system');
			expect(prompter.asked).not.toContain('screen:database');
			expect(prompter.asked).not.toContain('review');
		});
	});
});

/** A marked scratch host root (the host fs maps every host path under it). */
function hostRoot(): string {
	const root = mkdtempSync(join(scratch, 'host_'));
	mkdirSync(join(root, SCRATCH_MARKER), { recursive: true });
	return root;
}

/** A host path's file under the scratch root. */
function plant(root: string, path: string, text: string): void {
	const real = join(root, path);
	mkdirSync(join(real, '..'), { recursive: true });
	writeFileSync(real, text);
}

const STATE_TEXT = (outcome: string) =>
	JSON.stringify({ schema: STATE_SCHEMA, outcome, steps: {}, runs: [] });

describe('3. docker / production: the existing instance at screen 2', () => {
	const source = sourceTreeRoot();
	const stack = { ...scratchStackFacts(), volumes: [PRIVATE_VOLUME] };

	test('docker: the instance volume and an earlier .dedalo.env fail with the run’s sentences', async () => {
		const root = hostRoot();
		plant(root, join(source, ENV_FILE), 'DEDALO_X=1\n');
		await withEnv({ DEDALO_INSTALL_HOST_ROOT: root }, async () => {
			const outcome = await systemCheck('docker', { psql, stack: async () => stack });
			const expected = existingStackProblems(
				{
					source,
					fs: { exists: (path) => existsSync(join(root, path)) },
					stackFile: stackFileOf(normalizeInstallAnswers({ route: 'docker' }).answers),
				},
				stack,
			);
			expect(expected).toHaveLength(2);
			expect(installationRows(outcome.rows ?? []).map((row) => row.detail)).toEqual(expected);
			expect(outcome.ok).toBe(false);
		});
	});

	test('trial: the stack’s host record fails with the run’s sentence; CONTROL: a clean checkout is ok', async () => {
		const clean = hostRoot();
		await withEnv({ DEDALO_INSTALL_HOST_ROOT: clean }, async () => {
			const outcome = await systemCheck('trial', {
				psql,
				stack: async () => scratchStackFacts(),
			});
			expect(installationRows(outcome.rows ?? []).map((row) => row.state)).toEqual(['ok']);
		});
		const root = hostRoot();
		const runDir = join(source, STACK_RUN_DIR);
		plant(root, join(runDir, STATE_FILE), STATE_TEXT('in_progress'));
		await withEnv({ DEDALO_INSTALL_HOST_ROOT: root }, async () => {
			const outcome = await systemCheck('trial', {
				psql,
				stack: async () => scratchStackFacts(),
			});
			const sentence = hostRecordSentence({ route: 'trial' }, join(root, runDir));
			expect(installationRows(outcome.rows ?? []).map((row) => row.detail)).toEqual([sentence]);
		});
	});

	test('production: a host run record with no registry entry fails the Instance row', async () => {
		const root = hostRoot();
		const runDir = `${INSTALL_STATE_ROOT}/museo`;
		plant(root, join(runDir, STATE_FILE), STATE_TEXT('complete'));
		await withEnv({ DEDALO_INSTALL_HOST_ROOT: root }, async () => {
			const outcome = await systemCheck(
				'production',
				{ psql, firewall: async () => null },
				'museo',
			);
			const row = (outcome.rows ?? []).find((item) => item.label === 'Instance');
			expect(row?.state).toBe('fail');
			expect(row?.detail).toContain(
				hostRecordSentence({ route: 'production', instance: 'museo' }, join(root, runDir)),
			);
			// CONTROL: another name is free.
			const free = await systemCheck('production', { psql, firewall: async () => null }, 'prado');
			expect((free.rows ?? []).find((item) => item.label === 'Instance')?.state).toBe('ok');
		});
	});
});

/** A target database state (exists, empty, stampable unless overridden). */
function target(over: Partial<TargetDatabaseState> = {}): TargetDatabaseState {
	return { ...emptyTarget(), ...over };
}

describe('4. the Database screen says what the run would refuse', () => {
	const answers = { route: 'developer', db_database: 'dedalo_probe_scratch' };
	const seams = (state: TargetDatabaseState, inspected: string[] = []) => ({
		connect: async () => ({ can_connect: true, db_exists: true, msg: 'connected' }),
		serverVersion: async () => null,
		psqlVersion: async () => null,
		inspect: async (posted: Record<string, unknown>) => {
			inspected.push(String(posted.db_database));
			return state;
		},
	});

	test('a non-empty database: not ok, the run’s sentence', async () => {
		const full = target({
			emptyForInstall: false,
			userObjectCount: 3,
			userObjects: ['a', 'b', 'c'],
		});
		const outcome = await databaseProbe(answers, 'pw', seams(full));
		expect(outcome.ok).toBe(false);
		const [sentence] = freshTargetProblems('dedalo_probe_scratch', full);
		expect(sentence).toContain('is not empty');
		expect(outcome.detail).toContain(sentence as string);
	});

	test('a database the install role does not own: not ok, the owner sentence', async () => {
		const foreign = target({ canStamp: false });
		const outcome = await databaseProbe(answers, 'pw', seams(foreign));
		expect(outcome.ok).toBe(false);
		expect(outcome.detail).toContain('does not own database');
	});

	test('CONTROLS: an empty stampable database is ok; production --db-mode create never inspects', async () => {
		expect((await databaseProbe(answers, 'pw', seams(target()))).ok).toBe(true);
		const inspected: string[] = [];
		const created = await databaseProbe(
			{ route: 'production', db_mode: 'create', instance: 'museo' },
			'pw',
			seams(target({ emptyForInstall: false }), inspected),
		);
		expect(created.ok).toBe(true);
		expect(inspected).toEqual([]);
	});
});

describe('5. the developer Review preflight carries the refusal', () => {
	test('a finished record: the run’s sentence before `yes`; the engine child: none', async () => {
		const { env } = privateDirWith('complete');
		await withEnv(env, async () => {
			const { flags } = developerWalk();
			const refusals = await reviewPreflightRefusals(flags);
			expect(refusals).toEqual(engineInstalledHere());
			expect(refusals).toHaveLength(1);
			const child = { ...flags, answers: { ...flags.answers, engine_only: true } };
			expect(await reviewPreflightRefusals(child)).toEqual([]);
		});
	});
});

describe('6. the real plain installer over a FINISHED record', () => {
	test('quit at the first question: "nothing was installed", never "unfinished … kept"', async () => {
		const { dir } = privateDirWith('complete');
		let text = '';
		const decoder = new TextDecoder();
		const proc = Bun.spawn([process.execPath, 'run', 'scripts/install.ts', '--plain'], {
			cwd: ROOT,
			env: {
				...Bun.env,
				TERM: 'xterm-256color',
				DEDALO_INSTALL_PRIVATE_DIR: dir,
				DEDALO_TS_STATE_PATH: join(dir, 'ts_state.json'),
			},
			terminal: {
				cols: 100,
				rows: 30,
				data: (_terminal: unknown, chunk: Uint8Array) => {
					text += decoder.decode(chunk, { stream: true });
				},
			},
		});
		const until = Date.now() + 30000;
		while (!/Install type/.test(text) && Date.now() < until) await Bun.sleep(25);
		expect(text).toContain('Install type');
		await Bun.sleep(150);
		(proc as unknown as { terminal: { write(data: string): void } }).terminal.write('quit\r');
		const code = await proc.exited;
		await Bun.sleep(50);
		expect(code).toBe(0);
		const tail = text.slice(text.lastIndexOf('quit'));
		expect(tail).toContain('nothing was installed');
		expect(tail).not.toContain('unfinished install is kept');
	}, 60000);
});
