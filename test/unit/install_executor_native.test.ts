/**
 * THE TERMINAL INSTALLER'S EXECUTOR LOOP, DRIVEN OVER A FAKE MACHINE
 * (src/core/install/executor.ts; terminal installer phase 1, 2026-10-11).
 *
 * The executor's resume safety rests on a handful of rules — this gate drives
 * each through executeInstall with a fake step table and a fake host
 * (test/helpers/install_fake_executor.ts) in a temp private dir, and asserts what
 * the run DID (which steps ran, in what order, what the state file says, what was
 * refused) — never how the code spells it:
 *
 *  - a fresh run writes the plan + state only after every precondition passed;
 *    a refusal before that (a non-empty target, a held database lock, an
 *    existing install record) writes NOTHING and runs no step;
 *  - every step is checkpointed: a step that throws is recorded `failed`, the
 *    steps after it stay `pending`, and the outcome carries the resume/abort hint;
 *  - resume: a step recorded `done` with a verify is re-verified (and a failing
 *    verify is DRIFT, refused); one recorded `done` without a verify is skipped
 *    (never re-run — the drill's fingerprint depends on it); a step left
 *    `running`/`failed` whose work verifiably LANDED is adopted, not re-run; one
 *    whose work did not land is run again; `consumedBy` lets the consumer's
 *    verdict stand in for its producer's;
 *  - a resume refuses a modified plan file, another engine version, different
 *    answers (naming the keys) and a missing needed secret (`secretsNeeded`);
 *  - the run-dir lock refuses a LIVE holder on this host and reclaims a dead one;
 *  - state writes are atomic (no `.tmp` left) at 0600 in a 0700 dir;
 *  - --abort undoes in REVERSE plan order, only started steps, never a sealed
 *    install, and touches nothing without `--confirm-database` once the seed
 *    started; it removes the plan, the state and the run dir.
 * The real step table against a real database is install_resume_drill's.
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ExecutorRequest,
	executeInstall,
	secretsNeeded,
} from '../../src/core/install/executor.ts';
import type { InstallStepId } from '../../src/core/install/install_plan.ts';
import {
	acquireRunLock,
	type InstallState,
	LOCK_FILE,
	modeOf,
	PLAN_FILE,
	type PlanFile,
	releaseRunLock,
	STATE_FILE,
} from '../../src/core/install/run_files.ts';
import { lockPlace } from '../../src/core/install/run_files_core.ts';
import { DONE_TEXT } from '../../src/core/install/screen_text.ts';
import { ALREADY_COMPLETE_LINE } from '../../src/core/install/step_loop.ts';
import { INSTALL_STEPS } from '../../src/core/install/steps.ts';
import {
	announceRetiredProperties,
	resetRetiredPropertyAnnouncements,
} from '../../src/core/ontology/retired_property_notice.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';
import {
	FAKE_BASE_ANSWERS,
	type FakeTable,
	fakeHost,
	fakePlan,
	fakeTable,
	recordingIo,
	withPrivateDir,
} from '../helpers/install_fake_executor.ts';

/** A fresh temp private dir under this file's scratch root (removed in afterAll). */
const privateRoot = mkdtempSync(join(tmpdir(), 'dedalo_fake_install_'));
afterAll(() => rmSync(privateRoot, { recursive: true, force: true }));
const scratchPrivateDir = (): string => mkdtempSync(join(privateRoot, 'private_'));

const ROOT_PW = 'Mosaic-Kestrel-Harbor-47';

const runDirOf = (dir: string): string => join(dir, 'install');
const readState = (dir: string): InstallState =>
	JSON.parse(readFileSync(join(runDirOf(dir), STATE_FILE), 'utf8')) as InstallState;
const readPlan = (dir: string): PlanFile =>
	JSON.parse(readFileSync(join(runDirOf(dir), PLAN_FILE), 'utf8')) as PlanFile;

/** A table whose verify answers from `landed` (a step's run lands its work). */
function landingTable(
	calls: string[],
	landed: Set<InstallStepId>,
	overrides: Partial<Record<InstallStepId, Partial<FakeTable[InstallStepId]>>> = {},
	verified: readonly InstallStepId[] = [
		'persist_config',
		'install_db_from_default_file',
		'install_ontologies',
		'set_root_pw',
		'install_finish',
	],
): FakeTable {
	const withVerify: Partial<Record<InstallStepId, Partial<FakeTable[InstallStepId]>>> = {};
	for (const id of verified) {
		withVerify[id] = {
			run: async () => {
				calls.push(`run:${id}`);
				landed.add(id);
				return { ok: true, msg: `${id} ok` };
			},
			verify: async () => ({ ok: landed.has(id), detail: landed.has(id) ? 'landed' : 'absent' }),
		};
	}
	for (const [id, override] of Object.entries(overrides)) {
		withVerify[id as InstallStepId] = { ...(withVerify[id as InstallStepId] ?? {}), ...override };
	}
	return fakeTable(calls, withVerify);
}

function freshRequest(
	planFile: PlanFile,
	plan: ReturnType<typeof fakePlan>['plan'],
): ExecutorRequest {
	return { mode: 'fresh', planFile, plan, secrets: { root_password: ROOT_PW } };
}

const runs = (calls: readonly string[]): string[] =>
	calls.filter((call) => call.startsWith('run:')).map((call) => call.slice(4));

// ── fresh ────────────────────────────────────────────────────────────────────

describe('executor — a fresh run', () => {
	test('runs every plan step in order, checkpoints each done, and leaves atomic 0600 files in a 0700 dir', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host, state: machine } = fakeHost();
			const { io } = recordingIo();
			const outcome = await executeInstall(freshRequest(planFile, plan), io, {
				table: fakeTable(calls),
				host,
			});
			expect(outcome.result).toBe('complete');
			expect(outcome.exitCode).toBe(0);
			expect(plan.steps.length).toBeGreaterThan(5);
			expect(runs(calls)).toEqual([...plan.steps]);
			const state = readState(dir);
			expect(state.outcome).toBe('complete');
			expect(Object.keys(state.steps)).toEqual([...plan.steps]);
			for (const step of plan.steps) expect(state.steps[step]?.status, step).toBe('done');
			expect(readPlan(dir).plan_hash).toBe(planFile.plan_hash);
			// Atomic writes: no tmp left; the lock is released; modes.
			expect(readdirSync(runDirOf(dir)).sort()).toEqual([PLAN_FILE, STATE_FILE].sort());
			expect(modeOf(runDirOf(dir))).toBe(0o700);
			expect(modeOf(join(runDirOf(dir), PLAN_FILE))).toBe(0o600);
			expect(modeOf(join(runDirOf(dir), STATE_FILE))).toBe(0o600);
			// The server-side lock was taken once and released.
			expect([machine.locksTaken, machine.locksReleased]).toEqual([1, 1]);
		});
	});

	test('a non-empty target is refused before ANY write and before any step', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host, state: machine } = fakeHost();
			machine.database = {
				...machine.database,
				emptyForInstall: false,
				userObjectCount: 1,
				userObjects: ['public.stray'],
			};
			const outcome = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls),
				host,
			});
			expect(outcome.result).toBe('refused');
			expect(outcome.message).toContain('is not empty (1 objects, e.g. public.stray)');
			expect(outcome.hint).toEqual([]);
			expect(calls).toEqual([]);
			expect(readdirSync(dir)).toEqual([]);
			expect(machine.locksTaken).toBe(machine.locksReleased);
		});
	});

	test('another session holding the database lock is refused, nothing written', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host, state: machine } = fakeHost();
			machine.lockFree = false;
			const outcome = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls),
				host,
			});
			expect(outcome.message).toContain('another install is running against database');
			expect(calls).toEqual([]);
			expect(readdirSync(dir)).toEqual([]);
		});
	});

	test('a sealed private dir is refused (a fresh install never overwrites a live one)', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host, state: machine } = fakeHost();
			machine.installStatus = 'sealed';
			const outcome = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls),
				host,
			});
			expect(outcome.result).toBe('refused');
			expect(outcome.message).toContain('SEALED');
			expect(calls).toEqual([]);
			expect(readdirSync(dir)).toEqual([]);
		});
	});

	test('a second fresh run over the record refuses and changes nothing', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host } = fakeHost();
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls),
				host,
			});
			const before = readFileSync(join(runDirOf(dir), STATE_FILE), 'utf8');
			calls.length = 0;
			const again = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls),
				host,
			});
			expect(again.result).toBe('refused');
			expect(again.message).toContain('an install record exists');
			expect(calls).toEqual([]);
			expect(readFileSync(join(runDirOf(dir), STATE_FILE), 'utf8')).toBe(before);
		});
	});

	test('a failing step is recorded failed, the rest stay pending, the hint names resume + abort', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const outcome = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls, {
					install_ontologies: {
						run: async () => {
							throw new Error('ontology import exploded');
						},
					},
				}),
				host: fakeHost().host,
			});
			expect(outcome).toMatchObject({
				exitCode: 1,
				result: 'failed',
				failedStep: 'install_ontologies',
			});
			expect(outcome.message).toContain('ontology import exploded');
			const state = readState(dir);
			expect(state.steps.install_ontologies?.status).toBe('failed');
			expect(state.steps.install_ontologies?.error?.message).toContain('ontology import exploded');
			const at = plan.steps.indexOf('install_ontologies');
			for (const step of plan.steps.slice(at + 1))
				expect(state.steps[step]?.status, step).toBe('pending');
			for (const step of plan.steps.slice(0, at))
				expect(state.steps[step]?.status, step).toBe('done');
			const hint = outcome.hint.join('\n');
			expect(hint).toContain('--resume');
			expect(hint).toContain(`--abort --confirm-database ${String(FAKE_BASE_ANSWERS.db_database)}`);
			// set_root_pw is not done: the hint says the root password is needed again.
			expect(hint).toContain('root password');
			expect(existsSync(join(runDirOf(dir), LOCK_FILE))).toBe(false);
		});
	});
});

// ── resume ───────────────────────────────────────────────────────────────────

/** Fresh run failing at `failAt`, then the state for a resume. */
async function failedRun(
	dir: string,
	failAt: InstallStepId,
	landed: Set<InstallStepId>,
): Promise<{ plan: ReturnType<typeof fakePlan>['plan']; planFile: PlanFile }> {
	const { plan, planFile } = fakePlan();
	const calls: string[] = [];
	await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
		table: landingTable(calls, landed, {
			[failAt]: {
				run: async () => {
					throw new Error(`${failAt} failed`);
				},
			},
		}),
		host: fakeHost().host,
	});
	expect(readState(dir).steps[failAt]?.status).toBe('failed');
	return { plan, planFile };
}

describe('executor — resume', () => {
	test('re-verifies the done steps with a verify, SKIPS the done ones without, runs the rest', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			const { plan } = await failedRun(dir, 'install_hierarchies', landed);
			const calls: string[] = [];
			const { io, lines } = recordingIo();
			const outcome = await executeInstall({ mode: 'resume', secrets: {} }, io, {
				table: landingTable(calls, landed),
				host: fakeHost().host,
			});
			expect(outcome.result).toBe('complete');
			// campaign 3b N7: each done step SAYS what the resume did with it — re-checked
			// (its verify's own detail), or nothing to re-check — never a bare "skipped".
			const text = lines.join('\n');
			expect(text).toContain('done in an earlier run — verified again: landed');
			expect(text).toContain('done in an earlier run — nothing to re-check, not run again');
			expect(text).not.toContain('— skipped');
			const at = plan.steps.indexOf('install_hierarchies');
			// Nothing done before the failure ran again — probes and verify-less steps included.
			expect(runs(calls)).toEqual(plan.steps.slice(at));
			expect(readState(dir).outcome).toBe('complete');
			expect(readState(dir).runs.map((run) => run.mode)).toEqual(['fresh', 'resume']);
		});
	});

	test('a resume of a complete install runs nothing and says already complete', async () => {
		await withPrivateDir(scratchPrivateDir(), async () => {
			const landed = new Set<InstallStepId>();
			const { plan, planFile } = fakePlan();
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: landingTable([], landed),
				host: fakeHost().host,
			});
			const calls: string[] = [];
			const { io, lines } = recordingIo();
			const outcome = await executeInstall({ mode: 'resume', secrets: {} }, io, {
				table: landingTable(calls, landed),
				host: fakeHost().host,
			});
			expect(outcome.result).toBe('already_complete');
			expect(runs(calls)).toEqual([]);
			expect(lines.join('\n')).toContain(ALREADY_COMPLETE_LINE);
			// The reference quotes the line it really prints (campaign 3b N7).
			expect(
				readFileSync(
					join(import.meta.dir, '../../docs/install/installer_reference.md'),
					'utf8',
				).replace(/\s+/g, ' '),
			).toContain(`\`${ALREADY_COMPLETE_LINE}\``);
		});
	});

	test('a step recorded done whose outcome is gone is DRIFT — refused, nothing re-run', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'install_hierarchies', landed);
			landed.delete('install_ontologies'); // changed outside the installer
			const calls: string[] = [];
			const outcome = await executeInstall({ mode: 'resume', secrets: {} }, recordingIo().io, {
				table: landingTable(calls, landed),
				host: fakeHost().host,
			});
			expect(outcome.result).toBe('failed');
			expect(outcome.message).toContain(
				'step install_ontologies was recorded done but its outcome is missing',
			);
			expect(runs(calls)).toEqual([]);
		});
	});

	test('a step left RUNNING whose work landed is adopted (not re-run); a FAILED one whose work did not land is re-run', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'install_ontologies', landed);
			// A crash (SIGKILL) after the import committed but before its checkpoint:
			// the record says `running`, the work is there.
			const statePath = join(runDirOf(dir), STATE_FILE);
			const crashed = readState(dir);
			(crashed.steps.install_ontologies as { status: string }).status = 'running';
			writeFileSync(statePath, JSON.stringify(crashed));
			landed.add('install_ontologies');
			const calls: string[] = [];
			await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				recordingIo().io,
				{
					table: landingTable(calls, landed),
					host: fakeHost().host,
				},
			);
			expect(runs(calls)).not.toContain('install_ontologies');
			expect(readState(dir).steps.install_ontologies?.verify?.ok).toBe(true);
		});
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'install_ontologies', landed);
			const calls: string[] = [];
			await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				recordingIo().io,
				{
					table: landingTable(calls, landed),
					host: fakeHost().host,
				},
			);
			expect(runs(calls)[0]).toBe('install_ontologies');
		});
	});

	test('consumedBy: a producer whose own verify fails is satisfied by its consumer having verified', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			const staged = { present: true };
			// The REAL table's relation (the import deletes the staged files it consumes).
			expect(INSTALL_STEPS.stage_ontologies.consumedBy).toBe('install_ontologies');
			const stageVerify = {
				consumedBy: INSTALL_STEPS.stage_ontologies.consumedBy,
				verify: async () => ({
					ok: staged.present,
					detail: staged.present ? 'staged' : 'staging gone',
				}),
			};
			const { plan, planFile } = fakePlan();
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: landingTable([], landed, {
					stage_ontologies: stageVerify,
					install_hierarchies: {
						run: async () => {
							throw new Error('stop here');
						},
					},
				}),
				host: fakeHost().host,
			});
			// The import consumed (deleted) the staged files — the producer's own check fails now.
			staged.present = false;
			const calls: string[] = [];
			const outcome = await executeInstall({ mode: 'resume', secrets: {} }, recordingIo().io, {
				table: landingTable(calls, landed, { stage_ontologies: stageVerify }),
				host: fakeHost().host,
			});
			expect(outcome.message ?? 'complete').toBe('complete');
			expect(outcome.result).toBe('complete');
			expect(runs(calls)).not.toContain('stage_ontologies');
			expect(readState(dir).steps.stage_ontologies?.verify?.detail).toContain(
				'consumed by install_ontologies',
			);
		});
	});

	test('refuses a modified plan file, another engine version, and different answers (naming the keys)', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			const { planFile } = await failedRun(dir, 'install_hierarchies', landed);
			const planPath = join(runDirOf(dir), PLAN_FILE);
			const original = readFileSync(planPath, 'utf8');
			const resume = (request: Partial<ExecutorRequest> = {}) =>
				executeInstall({ mode: 'resume', secrets: {}, ...request }, recordingIo().io, {
					table: landingTable([], landed),
					host: fakeHost().host,
				});

			writeFileSync(planPath, original.replace('"entity": "fake"', '"entity": "tampered"'));
			expect((await resume()).message).toContain('plan hash mismatch');

			const otherEngine = { ...planFile, engine_version: '0.0.1' };
			const { planHash } = await import('../../src/core/install/run_files.ts');
			otherEngine.plan_hash = planHash(otherEngine);
			const state = readState(dir);
			state.plan_hash = otherEngine.plan_hash;
			writeFileSync(planPath, JSON.stringify(otherEngine));
			writeFileSync(join(runDirOf(dir), STATE_FILE), JSON.stringify(state));
			expect((await resume()).message).toContain(
				`plan was written by engine 0.0.1; this is ${formatVersion(DEDALO_DATA_VERSION)}`,
			);

			writeFileSync(planPath, original);
			state.plan_hash = planFile.plan_hash;
			writeFileSync(join(runDirOf(dir), STATE_FILE), JSON.stringify(state));
			const { normalizeInstallAnswers } = await import('../../src/core/install/install_plan.ts');
			const given = normalizeInstallAnswers({
				...FAKE_BASE_ANSWERS,
				entity: 'other',
				db_port: '5433',
			}).answers;
			const differing = await resume({ givenAnswers: given });
			expect(differing.message).toContain('answers differ from the saved plan: db_port, entity');
			// Same answers: accepted.
			const same = normalizeInstallAnswers({ ...FAKE_BASE_ANSWERS }).answers;
			expect((await resume({ givenAnswers: same })).result).toBe('complete');
		});
	});

	test('secretsNeeded: db/mysql/smtp only while persist_config is not done; root only while set_root_pw is not', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			const secrets = {
				db_password: 'Db-Secret-1',
				smtp_pass: 'Smtp-Secret-2',
				root_password: ROOT_PW,
			};
			const { planFile } = fakePlan(secrets);
			expect(secretsNeeded(planFile, null)).toEqual(['db_password', 'smtp_pass', 'root_password']);
			const state = (await failedRunWith(
				dir,
				planFile,
				landed,
				'check_directories',
			)) as InstallState;
			// persist_config done → the .env carries the secrets back; set_root_pw still to do.
			expect(state.steps.persist_config?.status).toBe('done');
			expect(secretsNeeded(planFile, state)).toEqual(['root_password']);
			const done = structuredClone(state);
			for (const record of Object.values(done.steps)) record.status = 'done';
			expect(secretsNeeded(planFile, done)).toEqual([]);
			// A resume without the root password it still needs is refused, by name.
			const refused = await executeInstall({ mode: 'resume', secrets: {} }, recordingIo().io, {
				table: landingTable([], landed),
				host: fakeHost().host,
			});
			expect(refused.message).toContain(
				'--resume needs the root password (set_root_pw has not run)',
			);
		});
	});
});

/** A fresh run of `planFile` failing at `failAt`; answers the saved state. */
async function failedRunWith(
	dir: string,
	planFile: PlanFile,
	landed: Set<InstallStepId>,
	failAt: InstallStepId,
): Promise<InstallState> {
	await executeInstall(
		{ mode: 'fresh', planFile, secrets: { root_password: ROOT_PW } },
		recordingIo().io,
		{
			table: landingTable([], landed, {
				[failAt]: {
					run: async () => {
						throw new Error('stop');
					},
				},
			}),
			host: fakeHost().host,
		},
	);
	return readState(dir);
}

// ── the run-dir lock ─────────────────────────────────────────────────────────

describe('executor — the run-dir lock', () => {
	test('a LIVE holder on this host is refused; a dead pid is reclaimed with a plain note', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const sleeper = Bun.spawn(['sleep', '30']);
			try {
				const { mkdirSync } = await import('node:fs');
				mkdirSync(runDirOf(dir), { recursive: true, mode: 0o700 });
				const lockPath = join(runDirOf(dir), LOCK_FILE);
				writeFileSync(
					lockPath,
					JSON.stringify({ pid: sleeper.pid, host: hostname(), started_at: 'then', mode: 'fresh' }),
				);
				const calls: string[] = [];
				const live = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
					table: fakeTable(calls),
					host: fakeHost().host,
				});
				expect(live.message).toContain(`another install is running (pid ${sleeper.pid}`);
				expect(calls).toEqual([]);
				expect(existsSync(lockPath), 'a live holder keeps its lock').toBe(true);

				sleeper.kill('SIGKILL');
				await sleeper.exited;
				const { io, lines } = recordingIo();
				const reclaimed = await executeInstall(freshRequest(planFile, plan), io, {
					table: fakeTable(calls),
					host: fakeHost().host,
				});
				expect(reclaimed.result).toBe('complete');
				// campaign 3c D9: the expected case in plain words — a note, never a ⚠ warning.
				const said = lines.join('\n');
				expect(said).toContain(
					`the earlier, interrupted run's install lock was released (process ${sleeper.pid} is no longer running)`,
				);
				expect(said).not.toContain('⚠');
				expect(said).not.toContain('stale');
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				sleeper.kill('SIGKILL');
			}
		});
	});
});

describe('a reclaimed lock in plain words (campaign 3c D9, 3d C3d-F3)', () => {
	test('another host (the engine child’s container) is a note naming it; only an unreadable lock is a warning', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dd-lock-'));
		try {
			const notes: string[] = [];
			const warnings: string[] = [];
			const sink = {
				note: (line: string) => notes.push(line),
				warn: (line: string) => warnings.push(line),
			};
			const lock = join(dir, LOCK_FILE);
			// The place the holder recorded is said — never "container or host" (C3d-F3).
			const holder = { pid: 1, host: 'a24a29fdf0d3', started_at: 'then', mode: 'fresh' };
			for (const place of ['container', 'host', undefined] as const) {
				writeFileSync(lock, JSON.stringify({ ...holder, place }));
				expect(acquireRunLock('resume', sink, dir).ok).toBe(true);
				releaseRunLock(dir);
			}
			expect(notes).toEqual([
				"the earlier, interrupted run's install lock was released (it ran in container a24a29fdf0d3)",
				"the earlier, interrupted run's install lock was released (it ran on host a24a29fdf0d3)",
				"the earlier, interrupted run's install lock was released (it ran on a24a29fdf0d3, another machine or container)",
			]);
			expect(warnings).toEqual([]);
			// The lock a run takes records its place: a container's runtime marker decides it.
			expect(acquireRunLock('fresh', sink, dir).ok).toBe(true);
			expect(JSON.parse(readFileSync(lock, 'utf8')).place).toBe(lockPlace());
			releaseRunLock(dir);
			expect(lockPlace((path) => path === '/.dockerenv')).toBe('container');
			expect(lockPlace((path) => path === '/run/.containerenv')).toBe('container');
			expect(lockPlace(() => false)).toBe('host');
			// CONTROL: a lock that cannot be read is odd — the one warning.
			writeFileSync(lock, 'not json');
			expect(acquireRunLock('resume', sink, dir).ok).toBe(true);
			expect(warnings).toEqual(['reclaimed an unreadable install lock']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── abort ────────────────────────────────────────────────────────────────────

describe('executor — abort', () => {
	test('without --confirm-database (seed started) it touches nothing; confirmed, it undoes STARTED steps in reverse', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			const { plan } = await failedRun(dir, 'set_root_pw', landed);
			const calls: string[] = [];
			const before = readFileSync(join(runDirOf(dir), STATE_FILE), 'utf8');
			const unconfirmed = await executeInstall({ mode: 'abort', secrets: {} }, recordingIo().io, {
				table: landingTable(calls, landed),
				host: fakeHost().host,
			});
			expect(unconfirmed.exitCode).toBe(1);
			expect(unconfirmed.message).toContain('confirm with --confirm-database');
			expect(calls).toEqual([]);
			expect(readFileSync(join(runDirOf(dir), STATE_FILE), 'utf8')).toBe(before);

			const wrong = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: 'some_other_db' },
				recordingIo().io,
				{ table: landingTable(calls, landed), host: fakeHost().host },
			);
			expect(wrong.exitCode).toBe(1);
			expect(wrong.message).toContain('confirm with --confirm-database');
			expect(calls).toEqual([]);

			const confirmed = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: String(FAKE_BASE_ANSWERS.db_database) },
				recordingIo().io,
				{ table: landingTable(calls, landed), host: fakeHost().host },
			);
			expect(confirmed.result).toBe('aborted');
			const at = plan.steps.indexOf('set_root_pw');
			const started = plan.steps.slice(0, at + 1);
			expect(calls.map((call) => call.replace('undo:', ''))).toEqual([...started].reverse());
			expect(calls.every((call) => call.startsWith('undo:'))).toBe(true);
			// The record and its directory are gone.
			expect(existsSync(runDirOf(dir))).toBe(false);
		});
	});

	test('a SEALED install is never aborted', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			const { plan, planFile } = fakePlan();
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: landingTable([], landed),
				host: fakeHost().host,
			});
			const calls: string[] = [];
			const outcome = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: String(FAKE_BASE_ANSWERS.db_database) },
				recordingIo().io,
				{ table: landingTable(calls, landed), host: fakeHost().host },
			);
			expect(outcome.exitCode).toBe(1);
			expect(outcome.message).toContain('SEALED');
			// A refusal — nothing was undone — is never worded "install failed" (campaign 3b N24).
			expect(outcome.result).toBe('refused');
			expect(outcome.failedStep).toBeNull();
			expect(DONE_TEXT.failure(outcome)).toStartWith('refused: this install is SEALED');
			expect(calls).toEqual([]);
			expect(readState(dir).outcome).toBe('complete');
		});
	});
});

// ── review fixes (2026-10-11): the database is the install's only by its stamp,
// the operator's own .env backups are never the install's, a re-run step is
// never adopted, and a partial resume command line compares only what it gives.

describe("executor — what is the install's, and what is not", () => {
	test('a role that cannot STAMP the database (not its owner) is refused before any write', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host, state: machine } = fakeHost();
			machine.database = { ...machine.database, canStamp: false };
			const outcome = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: fakeTable(calls),
				host,
			});
			expect(outcome.result).toBe('refused');
			expect(outcome.message).toContain('does not own database');
			expect(calls).toEqual([]);
			expect(readdirSync(dir)).toEqual([]);
		});
	});

	test('a neverAdopt step left RUNNING is re-run even though its verify passes', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'install_db_from_default_file', landed);
			const statePath = join(runDirOf(dir), STATE_FILE);
			const crashed = readState(dir);
			(crashed.steps.install_db_from_default_file as { status: string }).status = 'running';
			writeFileSync(statePath, JSON.stringify(crashed));
			landed.add('install_db_from_default_file');
			const calls: string[] = [];
			const neverAdopt = { neverAdopt: true } as const;
			const outcome = await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				recordingIo().io,
				{
					table: landingTable(calls, landed, { install_db_from_default_file: neverAdopt }),
					host: fakeHost().host,
				},
			);
			expect(outcome.result).toBe('complete');
			expect(runs(calls)[0]).toBe('install_db_from_default_file');
			// The real seed step is one of them (its engine half commits piecemeal).
			expect(INSTALL_STEPS.install_db_from_default_file.neverAdopt).toBe(true);
		});
	});

	test('a resume compares ONLY the answers given: an omitted one is not "different"', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'install_hierarchies', landed);
			const { normalizeInstallAnswers } = await import('../../src/core/install/install_plan.ts');
			const resume = (raw: Record<string, unknown>) =>
				executeInstall(
					{
						mode: 'resume',
						secrets: {},
						givenAnswers: normalizeInstallAnswers(raw).answers,
						givenKeys: Object.keys(raw),
					},
					recordingIo().io,
					{ table: landingTable([], landed), host: fakeHost().host },
				);
			// Normalized, `{entity}` alone differs from the saved db_database/db_username
			// (their defaults) — measured, so the case below is not vacuous.
			const { answerDifferences } = await import('../../src/core/install/run_files.ts');
			expect(
				answerDifferences(
					readPlan(dir).answers,
					normalizeInstallAnswers({ entity: 'fake' }).answers,
				),
			).toContain('db_database');
			const differing = await resume({ entity: 'other' });
			expect(differing.message).toContain('answers differ from the saved plan: entity —');
			expect((await resume({ entity: 'fake' })).result).toBe('complete');
		});
	});

	test("an operator's own .env.bak.* (before the install) survives adoption AND --abort; the install's own goes", async () => {
		// The test process's OWN session store lives outside the install's private dir
		// (the preload's scratch): the runtime-file undo must never take it (it did, and
		// every later session gate of the tier read a deleted sqlite file).
		const ownStore = String(process.env.DEDALO_SESSION_DB_PATH);
		const madeStore = !existsSync(ownStore);
		if (madeStore) writeFileSync(ownStore, '');
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			writeFileSync(join(dir, '.env.bak.1000'), 'OPERATOR=1\n');
			const { plan, planFile } = fakePlan();
			const landed = new Set<InstallStepId>();
			// persist_config writes its backup + .env, then dies before its checkpoint.
			const crashingPersist = {
				run: async () => {
					writeFileSync(join(dir, '.env.bak.2000'), 'INSTALL=1\n');
					writeFileSync(join(dir, '.env'), 'DB_NAME=x\n');
					landed.add('persist_config');
					throw new Error('crash after the write');
				},
			};
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: landingTable([], landed, { persist_config: crashingPersist }),
				host: fakeHost().host,
			});
			expect(readState(dir).steps.persist_config?.status).toBe('failed');
			// The resume ADOPTS it (its work landed), then stops at a later step.
			await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				recordingIo().io,
				{
					table: landingTable([], landed, {
						install_hierarchies: {
							run: async () => {
								throw new Error('stop');
							},
						},
					}),
					host: fakeHost().host,
				},
			);
			const state = readState(dir);
			expect(state.steps.persist_config?.status).toBe('done');
			expect(state.created.env_backups).toEqual(['.env.bak.2000']);
			// --abort with the REAL persist_config undo.
			const outcome = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: String(FAKE_BASE_ANSWERS.db_database) },
				recordingIo().io,
				{
					table: landingTable([], landed, {
						persist_config: { undo: INSTALL_STEPS.persist_config.undo },
					}),
					host: fakeHost().host,
				},
			);
			expect(outcome.result, outcome.message ?? '').toBe('aborted');
			expect(existsSync(join(dir, '.env.bak.1000'))).toBe(true);
			expect(existsSync(join(dir, '.env.bak.2000'))).toBe(false);
			expect(existsSync(join(dir, '.env'))).toBe(false);
			expect(
				existsSync(ownStore),
				"a runtime file outside the private dir is not the install's",
			).toBe(true);
		});
		if (madeStore) rmSync(ownStore, { force: true });
	});

	test('--abort never resets a database that is neither stamped by this install nor empty — and undoes nothing', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'set_root_pw', landed);
			const { host, state: machine } = fakeHost();
			// e.g. a real backup restored into the database after the run died.
			machine.database = {
				...machine.database,
				emptyForInstall: false,
				userObjectCount: 42,
				installStamp: null,
			};
			const calls: string[] = [];
			const confirm = String(FAKE_BASE_ANSWERS.db_database);
			const refused = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: confirm },
				recordingIo().io,
				{ table: landingTable(calls, landed), host },
			);
			expect(refused.exitCode).toBe(1);
			expect(refused.message).toContain('is not stamped by this install');
			expect(calls).toEqual([]);
			// Another install's stamp: refused all the same.
			machine.database = { ...machine.database, installStamp: 'another-install' };
			expect(
				(
					await executeInstall(
						{ mode: 'abort', secrets: {}, confirmDatabase: confirm },
						recordingIo().io,
						{
							table: landingTable(calls, landed),
							host,
						},
					)
				).message,
			).toContain('is not stamped by this install');
			expect(calls).toEqual([]);
			// THIS install's stamp: the reset proceeds.
			machine.database = { ...machine.database, installStamp: readState(dir).install_id };
			const aborted = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: confirm },
				recordingIo().io,
				{ table: landingTable(calls, landed), host },
			);
			expect(aborted.result).toBe('aborted');
			expect(calls).toContain('undo:install_db_from_default_file');
		});
	});

	test('an --abort that never reached the seed still takes the server-side lock (refused while another holds it)', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const landed = new Set<InstallStepId>();
			await failedRun(dir, 'check_directories', landed);
			expect(readState(dir).created.seed_started).toBe(false);
			const { host, state: machine } = fakeHost();
			machine.lockFree = false;
			const calls: string[] = [];
			const held = await executeInstall({ mode: 'abort', secrets: {} }, recordingIo().io, {
				table: landingTable(calls, landed),
				host,
			});
			expect(held.exitCode).toBe(1);
			expect(held.message).toContain('another install is running against database');
			expect(calls).toEqual([]);
			machine.lockFree = true;
			const aborted = await executeInstall({ mode: 'abort', secrets: {} }, recordingIo().io, {
				table: landingTable(calls, landed),
				host,
			});
			expect(aborted.result).toBe('aborted');
			expect(machine.locksTaken).toBe(1);
			expect(machine.locksReleased).toBe(1);
		});
	});
});

describe('run files — the stale-lock reclaim is atomic', () => {
	test('the race: a reclaimer that read a DEAD holder never deletes the fresh lock another process took meanwhile', async () => {
		const dir = scratchPrivateDir();
		const { reclaimStaleLock } = await import('../../src/core/install/run_files.ts');
		const lockPath = join(dir, LOCK_FILE);
		const deadHolder = {
			pid: 999_999_1,
			host: hostname(),
			started_at: 'then',
			mode: 'fresh' as const,
		};
		// B already reclaimed the dead lock and wrote its own fresh one…
		const fresh = { pid: 4242, host: hostname(), started_at: 'now', mode: 'fresh' as const };
		writeFileSync(lockPath, `${JSON.stringify(fresh)}\n`);
		const before = readFileSync(lockPath, 'utf8');
		// …then A, which read the dead holder before B acted, reclaims: it must lose.
		expect(reclaimStaleLock(lockPath, deadHolder)).toBe(false);
		expect(readFileSync(lockPath, 'utf8')).toBe(before);
		expect(readdirSync(dir)).toEqual([LOCK_FILE]);
		// The holder it actually read IS removed.
		expect(reclaimStaleLock(lockPath, fresh)).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
		// Nothing to reclaim: a no-op.
		expect(reclaimStaleLock(lockPath, fresh)).toBe(false);
	});
});

// ── phase 2 (2026-10-12): per-item rows, and the salt shown once ─────────────

describe('executor — the per-item rows and the one-time display (phase 2)', () => {
	test("a step's details are printed after it, one row per directory / per tool, in WORDS", async () => {
		await withPrivateDir(scratchPrivateDir(), async () => {
			const { plan, planFile } = fakePlan();
			const calls: string[] = [];
			const { host } = fakeHost();
			const { io, lines } = recordingIo();
			const table = fakeTable(calls, {
				check_directories: {
					run: async () => ({
						ok: true,
						dirs: [
							{ label: 'Private config', path: '/zz/private', exists: true, writable: true },
							{ label: 'Media', path: '/zz/media', exists: false, writable: false },
							{ label: 'Cache', path: '/zz/cache', exists: true, writable: false },
						],
					}),
					details: INSTALL_STEPS.check_directories.details,
				},
				register_tools: {
					run: async () => ({
						ok: true,
						report: [
							{ name: 'tool_zz_a', version: '1.2', errors: [], warnings: [] },
							{ name: 'tool_zz_b', version: null, errors: [], warnings: ['no icon'] },
							{ name: 'tool_zz_c', version: '0.1', errors: ['bad register.json'], warnings: [] },
						],
					}),
					details: INSTALL_STEPS.register_tools.details,
				},
			});
			const outcome = await executeInstall(freshRequest(planFile, plan), io, { table, host });
			expect(outcome.result).toBe('complete');
			for (const row of [
				'    ok  Private config  /zz/private',
				'    missing  Media  /zz/media',
				'    not writable  Cache  /zz/cache',
				'    ok  tool_zz_a 1.2',
				'    warn  tool_zz_b: no icon',
				'    error  tool_zz_c: bad register.json',
			]) {
				expect(lines, row).toContain(row);
			}
			// The rows follow THEIR step: the directory rows come before the tool rows.
			expect(lines.indexOf('    ok  Private config  /zz/private')).toBeLessThan(
				lines.indexOf('    ok  tool_zz_a 1.2'),
			);
			// The production table wires both (the rows are not a fake-only feature).
			expect(INSTALL_STEPS.check_directories.details).toBeFunction();
			expect(INSTALL_STEPS.register_tools.details).toBeFunction();
		});
	});

	/** A table whose persist_config writes a .env with a GENERATED salt (as the real one does). */
	const SALT = 'feedfacecafebeef0123456789abcdef';
	const saltTable = (calls: string[], dir: string): FakeTable =>
		fakeTable(calls, {
			persist_config: {
				run: async () => {
					calls.push('run:persist_config');
					writeFileSync(join(dir, '.env'), `DEDALO_SALT_STRING=${SALT}\n`, { mode: 0o600 });
					return { ok: true, msg: 'persisted' };
				},
			},
		});

	test('the generated salt reaches the front end showOnce EXACTLY once, never the log; a resume never shows it again', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const { host } = fakeHost();
			const shown: string[][] = [];
			const { io, lines } = recordingIo();
			const terminalIo = {
				...io,
				showOnce: (out: readonly string[]) => {
					shown.push([...out]);
					return true;
				},
			};
			const outcome = await executeInstall(freshRequest(planFile, plan), terminalIo, {
				table: saltTable([], dir),
				host,
			});
			expect(outcome.result).toBe('complete');
			expect(shown).toHaveLength(1);
			expect(shown[0]?.join('\n')).toContain(SALT);
			expect(lines.join('\n')).not.toContain(SALT);
			expect(readState(dir).created.salt_shown).toBe(true);
			// A resume of the finished install: nothing shown again.
			const again = await executeInstall(
				{ mode: 'resume', planFile, plan, secrets: { root_password: ROOT_PW } },
				terminalIo,
				{ table: saltTable([], dir), host },
			);
			expect(again.exitCode).toBe(0);
			expect(shown).toHaveLength(1);
		});
	});

	test('a showOnce with no terminal (output redirected): the salt is NOT printed, NOT marked shown — the run says where it is stored', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const { host } = fakeHost();
			const { io, lines } = recordingIo();
			const redirected = { ...io, showOnce: () => false };
			const outcome = await executeInstall(freshRequest(planFile, plan), redirected, {
				table: saltTable([], dir),
				host,
			});
			expect(outcome.result).toBe('complete');
			expect(lines.join('\n')).not.toContain(SALT);
			expect(lines.some((line) => line.includes('DEDALO_SALT_STRING stored in'))).toBe(true);
			expect(readState(dir).created.salt_shown).toBe(false);
		});
	});

	test('without a showOnce (the headless CLI) the salt is logged once, as before (control)', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const { host } = fakeHost();
			const { io, lines } = recordingIo();
			await executeInstall(freshRequest(planFile, plan), io, { table: saltTable([], dir), host });
			expect(lines.filter((line) => line.includes(SALT))).toHaveLength(1);
			expect(readState(dir).created.salt_shown).toBe(true);
		});
	});
});

// ── campaign 3 (2026-10-13): the unserved seal, the media tree, the child's hints ──

/** An engine-only plan (what a host route's child runs) and a host whose database fingerprint `fp` answers. */
function engineOnlyRun(fp: { value: string | null }) {
	const { plan, planFile } = fakePlan({}, { ...FAKE_BASE_ANSWERS, engine_only: true });
	const { host } = fakeHost();
	return { plan, planFile, host: { ...host, databaseFingerprint: async () => fp.value } };
}

describe('executor — a SEALED install is undone only as an UNSERVED host child (C3-11)', () => {
	const abortRequest = (unservedAttested: boolean): ExecutorRequest => ({
		mode: 'abort',
		secrets: {},
		confirmDatabase: String(FAKE_BASE_ANSWERS.db_database),
		unservedAttested,
	});

	test('the seal records the database fingerprint (after its own root login); attested + unchanged → undone', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const fp = { value: 'a'.repeat(32) };
			const landed = new Set<InstallStepId>();
			const { plan, planFile, host } = engineOnlyRun(fp);
			const fresh = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: landingTable([], landed),
				host,
			});
			expect(fresh.result).toBe('complete');
			expect(readState(dir).created.sealed_fingerprint).toBe('a'.repeat(32));
			const calls: string[] = [];
			const { io, lines } = recordingIo();
			const outcome = await executeInstall(abortRequest(true), io, {
				table: landingTable(calls, landed),
				host,
			});
			expect(outcome.message).toBeNull();
			expect(outcome.result).toBe('aborted');
			expect(calls).toContain('undo:install_db_from_default_file');
			expect(lines.join('\n')).toContain('sealed but never served');
			expect(existsSync(runDirOf(dir))).toBe(false);
		});
	});

	for (const [name, attested, change, engineOnly] of [
		['no host attestation', false, false, true],
		['attested, but the database changed since the seal (it served)', true, true, true],
		['attested, but not a host child (no engine_only)', true, false, false],
	] as const) {
		test(`refused, nothing undone: ${name}`, async () => {
			await withPrivateDir(scratchPrivateDir(), async (dir) => {
				const fp = { value: 'b'.repeat(32) as string | null };
				const landed = new Set<InstallStepId>();
				const run = engineOnlyRun(fp);
				const { plan, planFile } = engineOnly ? run : fakePlan();
				await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
					table: landingTable([], landed),
					host: run.host,
				});
				if (change) fp.value = 'c'.repeat(32);
				const calls: string[] = [];
				const outcome = await executeInstall(abortRequest(attested), recordingIo().io, {
					table: landingTable(calls, landed),
					host: run.host,
				});
				expect(outcome.exitCode).toBe(1);
				expect(outcome.message).toContain('SEALED');
				expect(calls).toEqual([]);
				expect(readState(dir).outcome).toBe('complete');
			});
		});
	}

	test('a later run never launders a changed database into a new seal', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const fp = { value: 'd'.repeat(32) as string | null };
			const landed = new Set<InstallStepId>();
			const { plan, planFile, host } = engineOnlyRun(fp);
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table: landingTable([], landed),
				host,
			});
			fp.value = 'e'.repeat(32);
			const resumed = await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				recordingIo().io,
				{ table: landingTable([], landed), host },
			);
			expect(resumed.result).toBe('already_complete');
			expect(readState(dir).created.sealed_fingerprint).toBe('d'.repeat(32));
		});
	});
});

describe('executor — check_directories records the media tree it made; --abort prunes it (C3-9)', () => {
	test('the created media tree is recorded (absolute); the real undo removes its EMPTY directories, never one holding a file', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const media = mkdtempSync(join(privateRoot, 'media_'));
			const created = ['av', 'av/subtitles', 'image', 'image/original'];
			const { plan, planFile } = fakePlan();
			const table = fakeTable([], {
				check_directories: {
					run: async () => {
						for (const path of created) mkdirSync(join(media, path), { recursive: true });
						return { ok: true, msg: 'dirs ok', mediaTree: { root: media, created } };
					},
				},
			});
			await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
				table,
				host: fakeHost().host,
			});
			const state = readState(dir);
			expect(state.created.media_tree).toEqual(created.map((path) => join(media, path)));
			// A file someone put in one of them: that directory (and its parent) stays.
			writeFileSync(join(media, 'image/original/kept.jpg'), 'x');
			const said = await (
				INSTALL_STEPS.check_directories.undo as NonNullable<
					(typeof INSTALL_STEPS)['check_directories']['undo']
				>
			)({ plan: planFile, state, secrets: {} });
			expect(said).toContain('media tree: 2 empty director(ies) removed');
			expect(existsSync(join(media, 'av'))).toBe(false);
			expect(existsSync(join(media, 'image/original/kept.jpg'))).toBe(true);
			expect(readdirSync(media)).toEqual(['image']);
		});
	});
});

describe("executor — a host route's engine child prints no hint of its own (C3-54)", () => {
	test('delegated (--events-jsonl): a failure carries no `bun run scripts/install.ts` hint; a plain run does', async () => {
		for (const delegated of [true, false]) {
			await withPrivateDir(scratchPrivateDir(), async () => {
				const { plan, planFile } = fakePlan();
				const table = fakeTable([], {
					install_ontologies: {
						run: async () => {
							throw new Error('the ontology import failed');
						},
					},
				});
				const { io } = recordingIo();
				const outcome = await executeInstall(
					freshRequest(planFile, plan),
					delegated ? { ...io, delegated: true } : io,
					{ table, host: fakeHost().host },
				);
				expect(outcome.result).toBe('failed');
				if (delegated) expect(outcome.hint).toEqual([]);
				else expect(outcome.hint.join('\n')).toContain('scripts/install.ts --resume');
			});
		}
	});
});

describe('executor — an --engine-only run by hand names ITS command, not a bare bun run (campaign 3b C3-54)', () => {
	test("its failure hint says the same command with --resume / --abort, never `bun run scripts/install.ts`; a plain run's keeps it", async () => {
		for (const engineOnly of [true, false]) {
			await withPrivateDir(scratchPrivateDir(), async () => {
				const { plan, planFile } = fakePlan(
					{},
					{ ...FAKE_BASE_ANSWERS, ...(engineOnly ? { engine_only: true } : {}) },
				);
				const table = fakeTable([], {
					install_ontologies: {
						run: async () => {
							throw new Error('the ontology import failed');
						},
					},
				});
				const outcome = await executeInstall(freshRequest(planFile, plan), recordingIo().io, {
					table,
					host: fakeHost().host,
				});
				expect(outcome.result).toBe('failed');
				const hint = outcome.hint.join('\n');
				const db = String(FAKE_BASE_ANSWERS.db_database);
				if (engineOnly) {
					expect(hint).not.toContain('bun run scripts/install.ts');
					expect(hint).toContain('the same command you ran, with --resume added');
					expect(hint).toContain(
						`the same command you ran, with --abort --confirm-database ${db} added`,
					);
					expect(hint).toContain('manual_install.md#manual-host_engine');
				} else {
					expect(hint).toContain('bun run scripts/install.ts --resume');
				}
			});
		}
	});
});

describe('executor — a Ctrl-C that kills the running step is ONE interruption (campaign 3b N12)', () => {
	test("the step's child dies of the same SIGINT: no failure block, exit 130, the run recorded interrupted", async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			// Ctrl-C reaches the whole process group: the installer's handler AND the step's child,
			// whose death (exit 130) the step reports as its failure.
			const table = fakeTable([], {
				install_ontologies: {
					run: async () => {
						process.emit('SIGINT');
						throw new Error('the engine steps failed (exit 130)');
					},
				},
			});
			const exits: number[] = [];
			class Exited extends Error {}
			const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
				exits.push(code ?? 0);
				throw new Exited(`exit ${code}`);
			}) as never);
			const { io, lines } = recordingIo();
			let settled: unknown = null;
			try {
				settled = await executeInstall(freshRequest(planFile, plan), io, {
					table,
					host: fakeHost().host,
				});
			} catch (error) {
				settled = error;
			} finally {
				exit.mockRestore();
			}
			// It never returned a failure outcome: it left through the interruption's exit.
			expect(settled).toBeInstanceOf(Exited);
			expect(exits).toEqual([130]);
			const said = lines.join('\n');
			expect(said.match(/install interrupted \(SIGINT\)/g)?.length).toBe(1);
			expect(said).not.toContain('install failed');
			const state = readState(dir);
			expect(state.runs.at(-1)?.result).toBe('interrupted');
			expect(state.steps.install_ontologies?.status).toBe('failed');
		});
	});
});

describe("executor — a host route's engine CHILD says its interrupt as a sub-line (campaign 3c D11)", () => {
	test('delegated io + SIGTERM: "engine stopped (SIGTERM) at step [x]", no ✖, exit 143; the run’s own keeps its ✖ block', async () => {
		for (const delegated of [true, false]) {
			await withPrivateDir(scratchPrivateDir(), async () => {
				const { plan, planFile } = fakePlan();
				const table = fakeTable([], {
					install_ontologies: {
						run: async () => {
							process.emit('SIGTERM');
							throw new Error('the engine steps failed (exit 143)');
						},
					},
				});
				const exits: number[] = [];
				class Exited extends Error {}
				const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
					exits.push(code ?? 0);
					throw new Exited(`exit ${code}`);
				}) as never);
				const recorded = recordingIo();
				const io = delegated ? { ...recorded.io, delegated: true as const } : recorded.io;
				let settled: unknown = null;
				try {
					settled = await executeInstall(freshRequest(planFile, plan), io, {
						table,
						host: fakeHost().host,
					});
				} catch (error) {
					settled = error;
				} finally {
					exit.mockRestore();
				}
				expect(settled).toBeInstanceOf(Exited);
				expect(exits).toEqual([143]);
				const said = recorded.lines.join('\n');
				if (delegated) {
					expect(said).toContain('engine stopped (SIGTERM) at step [install_ontologies]');
					expect(said).not.toContain('✖');
				} else {
					expect(said).toContain('✖ install interrupted (SIGTERM) at step [install_ontologies]');
				}
			});
		}
	});
});

describe("executor — the ontology's RETIRED-property lines stay out of the operator's terminal (campaign 3b C3-72)", () => {
	test('announced during an install: counted, printed nowhere; outside an install: printed', async () => {
		await withPrivateDir(scratchPrivateDir(), async () => {
			resetRetiredPropertyAnnouncements();
			const { plan, planFile } = fakePlan();
			// What the resolver does on a node carrying a retired key (resolver.ts reportRetiredProperties).
			const table = fakeTable([], {
				install_ontologies: {
					run: async () => {
						announceRetiredProperties('zz_retired_node', ['multi_value']);
						return { ok: true, msg: 'ontologies ok' };
					},
				},
			});
			const printed: string[] = [];
			const errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
				printed.push(args.map(String).join(' '));
			});
			const { io, lines } = recordingIo();
			try {
				const outcome = await executeInstall(freshRequest(planFile, plan), io, {
					table,
					host: fakeHost().host,
				});
				expect(outcome.result).toBe('complete');
				expect([...printed, ...lines].join('\n')).not.toContain('zz_retired_node');
				// Positive control: the same announcement outside an install reaches stderr.
				resetRetiredPropertyAnnouncements();
				announceRetiredProperties('zz_retired_node', ['multi_value']);
				expect(printed.join('\n')).toContain('zz_retired_node');
			} finally {
				errors.mockRestore();
				resetRetiredPropertyAnnouncements();
			}
		});
	});
});

describe('executor — a seed restore orphaned by a killed run never blocks its own resume/abort (campaign 3e F5)', () => {
	const OTHER_INSTALL = '00000000-0000-4000-8000-000000000000';

	/** A failed fresh run (at the seed), then the target as the server still shows it. */
	async function orphanedSeed(dir: string, owner: 'own' | 'other') {
		const landed = new Set<InstallStepId>();
		const { plan } = await failedRun(dir, 'install_db_from_default_file', landed);
		const installId = readState(dir).install_id;
		const ended: string[] = [];
		const { host, state } = fakeHost();
		state.database = {
			...state.database,
			seedRestoreRunning: 124,
			seedRestoreInstallId: owner === 'own' ? installId : OTHER_INSTALL,
			installSessions: [124],
		};
		host.endSeedRestore = async (id) => {
			ended.push(id);
			state.database = { ...state.database, seedRestoreRunning: null, installSessions: [] };
			return [124];
		};
		return { plan, installId, ended, host, landed };
	}

	test('resume: its OWN orphan is ended (said), then the run completes; another install’s refuses, untouched', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { installId, ended, host, landed } = await orphanedSeed(dir, 'own');
			const { io, lines } = recordingIo();
			const outcome = await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				io,
				{
					table: landingTable([], landed),
					host,
				},
			);
			expect(outcome.message).toBeNull();
			expect(outcome.result).toBe('complete');
			expect(ended).toEqual([installId]);
			expect(lines.join('\n')).toContain(
				"ended the seed restore an interrupted run left on 'dedalo_fake_target' (backend pid 124)",
			);
		});
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { ended, host, landed } = await orphanedSeed(dir, 'other');
			const outcome = await executeInstall(
				{ mode: 'resume', secrets: { root_password: ROOT_PW } },
				recordingIo().io,
				{
					table: landingTable([], landed),
					host,
				},
			);
			expect(outcome.result).toBe('refused');
			expect(outcome.message).toContain(
				"a seed restore into 'dedalo_fake_target' is still running (backend pid 124)",
			);
			expect(ended).toEqual([]);
		});
	});

	test('abort: its OWN orphan is ended, then the undo runs', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { ended, host, installId, landed } = await orphanedSeed(dir, 'own');
			const outcome = await executeInstall(
				{ mode: 'abort', secrets: {}, confirmDatabase: 'dedalo_fake_target' },
				recordingIo().io,
				{ table: landingTable([], landed), host },
			);
			expect(outcome.message).toBeNull();
			expect(outcome.result).toBe('aborted');
			expect(ended).toEqual([installId]);
		});
	});

	test('Ctrl-C during the seed ends the restore’s server session before the run exits', async () => {
		await withPrivateDir(scratchPrivateDir(), async (dir) => {
			const { plan, planFile } = fakePlan();
			const ended: string[] = [];
			const { host } = fakeHost();
			host.endSeedRestore = async (id) => {
				ended.push(id);
				return [124];
			};
			const table = fakeTable([], {
				install_db_from_default_file: {
					run: async () => {
						process.emit('SIGINT');
						throw new Error('psql died of the same SIGINT');
					},
				},
			});
			class Exited extends Error {}
			const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
				throw new Exited(`exit ${code}`);
			}) as never);
			const { io, lines } = recordingIo();
			let settled: unknown = null;
			try {
				settled = await executeInstall(freshRequest(planFile, plan), io, { table, host });
			} catch (error) {
				settled = error;
			} finally {
				exit.mockRestore();
			}
			expect(settled).toBeInstanceOf(Exited);
			expect(ended).toEqual([readState(dir).install_id]);
			expect(lines.join('\n')).toContain(
				"ended the seed restore's database session (backend pid 124)",
			);
		});
	});
});
