/**
 * NEEDS_DB_RESTORE (update audit 2026-10-29, U-02; design §3.2, Phase 2.3;
 * owner decision D-2) — src/core/update/run/rollback.ts + the leaf CLI
 * scripts/update_run_rollback_check.ts the shell scripts consume.
 *
 *  - a failure before the swap is FAILED_PRE_SWAP; after it, ROLLED_BACK_CODE
 *    only while the data model held, else NEEDS_DB_RESTORE;
 *  - the NEEDS_DB_RESTORE report names the run's backup, the loss window (the
 *    dump instant) and the ordered human actions — and says so when the backup
 *    was waived instead of naming one;
 *  - the CLI answers each case with its exit code, and an UNREADABLE journal is
 *    never read as "no run" (the caller must not roll back on it). The CLI runs
 *    as a real process: it is what the scripts execute.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollbackCheck } from '../../scripts/update_run_rollback_check.ts';
import {
	DEFAULT_RELEASE_STEPS,
	type ReleasePlan,
	type ReleaseStepKind,
} from '../../src/core/update/catalog_file.ts';
import {
	createRunJournal,
	type RunJournal,
	writeRunJournal,
} from '../../src/core/update/run/journal.ts';
import { planRun } from '../../src/core/update/run/plan.ts';
import {
	canAutoRollback,
	dbRestoreReport,
	failureExit,
	phaseCrossesModel,
} from '../../src/core/update/run/rollback.ts';

const roots: string[] = [];
const scratch = () => {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_rollback_'));
	roots.push(root);
	return root;
};
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PLANS = {
	'7.0.2': { version: '7.0.2', compat: 'compatible', steps: [], declared: true },
	'7.1.0': { version: '7.1.0', compat: 'incompatible', steps: [], declared: true },
} as unknown as Record<string, ReleasePlan>;

function run(
	phases: [string, ReleaseStepKind, 'ok' | 'failed'][],
	backup: RunJournal['backup'] = null,
): RunJournal {
	return {
		...createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.1.0', data: '7.1.0', model: '7.1.0' },
			plan: phases.map(([release, kind]) => ({ release, step: { kind } })),
		}),
		state: 'BACKED_UP',
		backup,
		phases: phases.map(([release, kind, outcome]) => ({
			release,
			step: { kind },
			started: '2026-10-30T10:00:00.000Z',
			finished: '2026-10-30T10:01:00.000Z',
			outcome,
			evidence: {},
		})),
	};
}

describe('failureExit — where a failed phase takes the run', () => {
	test('before the swap: nothing the install runs changed', () => {
		expect(failureExit(run([['7.1.0', 'ontology', 'failed']]), PLANS)).toBe('FAILED_PRE_SWAP');
	});
	test('after the swap, model held: the code goes back by itself', () => {
		const journal = run([
			['7.1.0', 'code', 'ok'],
			['7.0.2', 'schema', 'failed'],
		]);
		expect(failureExit(journal, PLANS)).toBe('ROLLED_BACK_CODE');
	});
	test('after the swap, model crossed: a human restores the database with the code', () => {
		const journal = run([
			['7.1.0', 'code', 'ok'],
			['7.1.0', 'schema', 'failed'],
		]);
		expect(failureExit(journal, PLANS)).toBe('NEEDS_DB_RESTORE');
	});
});

describe('dbRestoreReport — what the human is told', () => {
	const crossed = (backup: RunJournal['backup']) =>
		run(
			[
				['7.1.0', 'code', 'ok'],
				['7.1.0', 'data', 'failed'],
			],
			backup,
		);

	test('names the backup, the loss window and the ordered actions', () => {
		const report = dbRestoreReport(
			crossed({ path: '/b/run.custom.backup', taken: '2026-10-30T09:59:00.000Z', waivedBy: null }),
			PLANS,
		);
		expect(report).toMatchObject({
			crossedBy: '7.1.0 data',
			backup: '/b/run.custom.backup',
			lossWindowFrom: '2026-10-30T09:59:00.000Z',
			previousRelease: '7.0.1',
		});
		expect(report.actions[0]).toContain('maintenance');
		expect(report.actions[1]).toContain('/b/run.custom.backup');
		expect(report.actions[2]).toContain('7.0.1');
		expect(report.actions[3]).toContain(report.run_id);
	});

	test('a waived backup is said, never papered over with a guess', () => {
		const report = dbRestoreReport(crossed({ path: null, taken: null, waivedBy: 1 }), PLANS);
		expect(report.backup).toBeNull();
		expect(report.lossWindowFrom).toBeNull();
		expect(report.actions[1]).toContain('took no backup');
	});
});

describe('the leaf CLI the shell scripts execute', () => {
	const cli = (root: string) =>
		Bun.spawnSync(
			[
				'bun',
				'run',
				join(import.meta.dir, '../../scripts/update_run_rollback_check.ts'),
				'--root',
				root,
			],
			{
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);

	test('no run → 3; an unreadable journal → 4, never "no run"', async () => {
		const empty = scratch();
		expect((await rollbackCheck(empty)).code).toBe(3);
		const torn = scratch();
		writeFileSync(join(torn, '20261030T100000Z_torn.json'), '{"format":1,');
		expect((await rollbackCheck(torn)).code).toBe(4);
	});

	test('a run whose model held → 0, as a real process', async () => {
		const root = scratch();
		await writeRunJournal(root, run([['7.0.1', 'code', 'ok']]));
		const answer = cli(root);
		expect(answer.exitCode).toBe(0);
		expect(JSON.parse(answer.stdout.toString()).verdict).toBe('allowed');
	});

	test('a run that crossed the shipped model → 1 with the report (a planted unknown release counts as crossing)', async () => {
		const root = scratch();
		await writeRunJournal(
			root,
			run([
				['7.0.1', 'code', 'ok'],
				['99.0.0', 'schema', 'ok'],
			]),
		);
		const answer = cli(root);
		expect(answer.exitCode).toBe(1);
		const line = JSON.parse(answer.stdout.toString());
		expect(line.verdict).toBe('needs_db_restore');
		expect(line.report.crossedBy).toBe('99.0.0 schema');
	});

	test('a malformed call → 2', () => {
		const answer = Bun.spawnSync(
			['bun', 'run', join(import.meta.dir, '../../scripts/update_run_rollback_check.ts'), '--nope'],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		expect(answer.exitCode).toBe(2);
	});
});

describe('owner ruling 2026-11-11 (T1-25): code-only and same-triple never cross', () => {
	// BUILT through the real planner (planRun) with planted plans; each run is
	// judged against BOTH the full plans (production effects.plans) and the
	// journal's own release_plans (the leaf CLI), failing each post-swap
	// database phase in turn.
	const plan = (
		version: string,
		compat: ReleasePlan['compat'],
		steps: ReleasePlan['steps'] = DEFAULT_RELEASE_STEPS,
		declared = false,
	): ReleasePlan => ({ version, compat, steps, declared });
	const CODE_ONLY = { '7.0.0': plan('7.0.0', null), '7.0.1': plan('7.0.1', null) };
	const WITH_MINOR = {
		...CODE_ONLY,
		'7.1.0': plan(
			'7.1.0',
			'incompatible',
			[{ kind: 'code' }, { kind: 'schema' }, { kind: 'data', sql: ['select 1'] }],
			true,
		),
	};

	/** The planned run, failing the planned phase at `failAt` (every earlier one ok). */
	function plannedRun(
		installedRelease: string,
		target: string,
		plans: Record<string, ReleasePlan>,
		failAt: (entry: RunJournal['plan'][number]) => boolean,
		data: readonly number[] = [7, 0, 0],
		targetData: readonly number[] = data,
	): RunJournal {
		const planned = planRun({ installedRelease, installedData: data, target, plans, targetData });
		if (!planned.ok) throw new Error(`unplannable: ${JSON.stringify(planned)}`);
		const fail = planned.plan.findIndex(failAt);
		if (fail === -1) throw new Error(`no such phase in ${JSON.stringify(planned.plan)}`);
		const journal = createRunJournal({
			from: planned.from,
			to: planned.to,
			plan: planned.plan,
			releasePlans: planned.releasePlans,
		});
		return {
			...journal,
			state: 'BACKED_UP',
			phases: planned.plan.slice(0, fail + 1).map((entry, index) => ({
				...entry,
				started: '2026-11-12T10:00:00.000Z',
				finished: '2026-11-12T10:01:00.000Z',
				outcome: index === fail ? 'failed' : 'ok',
				evidence: {},
			})),
		};
	}
	const at = (release: string, kind: ReleaseStepKind) => (entry: RunJournal['plan'][number]) =>
		entry.release === release && entry.step.kind === kind;
	const exits = (journal: RunJournal, plans: Record<string, ReleasePlan>) => [
		failureExit(journal, plans),
		failureExit(journal, journal.release_plans),
	];

	test('a code-only patch (default steps, no compat): any post-swap phase failing rolls the code back', () => {
		for (const kind of ['ontology', 'schema', 'ancillary'] as const) {
			const journal = plannedRun('7.0.0', '7.0.1', CODE_ONLY, at('7.0.1', kind));
			expect(exits(journal, CODE_ONLY)).toEqual(['ROLLED_BACK_CODE', 'ROLLED_BACK_CODE']);
			expect(canAutoRollback(journal, CODE_ONLY).allowed).toBe(true);
		}
	});

	test('a code-only patch declaring [code]: the appended target schema failing rolls the code back', () => {
		const plans = { ...CODE_ONLY, '7.0.1': plan('7.0.1', null, [{ kind: 'code' }], true) };
		const journal = plannedRun('7.0.0', '7.0.1', plans, at('7.0.1', 'schema'));
		expect(exits(journal, plans)).toEqual(['ROLLED_BACK_CODE', 'ROLLED_BACK_CODE']);
	});

	test('same triple (prerelease → prerelease / stable, a dev reinstall, even an incompatible triple): rolls back', () => {
		const cases: [string, string, Record<string, ReleasePlan>, number[]][] = [
			['7.0.0-beta.7', '7.0.0-beta.8', CODE_ONLY, [7, 0, 0]],
			['7.0.0-beta.8', '7.0.0', CODE_ONLY, [7, 0, 0]],
			['7.0.1-dev', '7.0.1-dev', CODE_ONLY, [7, 0, 0]],
			['7.1.0-beta.2', '7.1.0', WITH_MINOR, [7, 1, 0]],
		];
		for (const [from, to, plans, data] of cases) {
			const triple = to.split('-')[0] as string;
			const journal = plannedRun(from, to, plans, at(triple, 'schema'), data);
			expect(exits(journal, plans)).toEqual(['ROLLED_BACK_CODE', 'ROLLED_BACK_CODE']);
		}
	});

	test('controls (fail closed): a walked incompatible, unknown or contract-faulty release still crosses', () => {
		const minor = plannedRun(
			'7.0.1',
			'7.1.0',
			WITH_MINOR,
			at('7.1.0', 'data'),
			[7, 0, 0],
			[7, 1, 0],
		);
		expect(exits(minor, WITH_MINOR)).toEqual(['NEEDS_DB_RESTORE', 'NEEDS_DB_RESTORE']);
		const faulty = {
			...CODE_ONLY,
			'7.0.1': plan('7.0.1', null, [{ kind: 'code' }, { kind: 'schema' }], true),
		};
		const contract = plannedRun('7.0.0', '7.0.1', faulty, at('7.0.1', 'schema'));
		expect(exits(contract, faulty)).toEqual(['NEEDS_DB_RESTORE', 'NEEDS_DB_RESTORE']);
		const unknown = run([
			['7.0.2', 'code', 'ok'],
			['99.0.0', 'schema', 'failed'],
		]);
		expect(failureExit(unknown, PLANS)).toBe('NEEDS_DB_RESTORE');
	});

	test('a walk over a code-only patch into an incompatible minor crosses only at the minor', () => {
		const early = plannedRun(
			'7.0.0',
			'7.1.0',
			WITH_MINOR,
			at('7.0.1', 'schema'),
			[7, 0, 0],
			[7, 1, 0],
		);
		expect(exits(early, WITH_MINOR)).toEqual(['ROLLED_BACK_CODE', 'ROLLED_BACK_CODE']);
		const late = plannedRun(
			'7.0.0',
			'7.1.0',
			WITH_MINOR,
			at('7.1.0', 'data'),
			[7, 0, 0],
			[7, 1, 0],
		);
		expect(exits(late, WITH_MINOR)).toEqual(['NEEDS_DB_RESTORE', 'NEEDS_DB_RESTORE']);
	});

	test('phaseCrossesModel: an unreadable installed release is never read as "not walked"', () => {
		const journal = {
			...run([['7.0.2', 'code', 'ok']]),
			from: { release: 'garbage', data: '7.0.0', model: '7.0.0' },
		};
		const phase = {
			...(journal.phases[0] as RunJournal['phases'][number]),
			release: '7.0.1',
			step: { kind: 'schema' as const },
		};
		expect(phaseCrossesModel(phase, journal, { '7.0.1': plan('7.0.1', 'incompatible') })).toBe(
			true,
		);
		expect(phaseCrossesModel(phase, journal, { '7.0.1': plan('7.0.1', 'compatible') })).toBe(false);
	});
});
