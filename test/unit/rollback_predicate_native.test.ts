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
import type { ReleasePlan, ReleaseStepKind } from '../../src/core/update/catalog_file.ts';
import {
	createRunJournal,
	type RunJournal,
	writeRunJournal,
} from '../../src/core/update/run/journal.ts';
import { dbRestoreReport, failureExit } from '../../src/core/update/run/rollback.ts';

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
