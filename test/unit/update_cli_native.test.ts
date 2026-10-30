/**
 * THE UPDATE RUN'S COMMAND LINE (update audit 2026-10-29, Phase 2.6; U-33) —
 * scripts/update.ts, over scratch journal roots (no database, no network).
 *
 *  - status names the run in flight and its phases; no run → exit 3; an
 *    unreadable journal → exit 4 (it blocks every new run);
 *  - abort ends a run by a human: ABANDONED before the swap, MANUAL after it,
 *    REFUSED from PLANNED; refused while the code phase runs (the swap may have
 *    landed) and while any process holds the update lock (or it cannot be read);
 *    afterwards no run blocks;
 *  - check is the rollback predicate's verdict;
 *  - apply / resume are refused here with the reason (the server owns them);
 *  - plan reads the master's manifest: a release it does not offer is refused.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortTarget, type LockProbe, runUpdateCli } from '../../scripts/update.ts';
import { rollbackCheck } from '../../scripts/update_run_rollback_check.ts';
import {
	blockingRun,
	createRunJournal,
	finishPhase,
	type RunJournal,
	startPhase,
	transition,
	unclosedRestore,
	writeRunJournal,
} from '../../src/core/update/run/journal.ts';
import { planCodeUpdate } from '../../src/core/update/run/start.ts';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_update_cli_'));
	roots.push(root);
	return root;
}

/** A run of [ontology, code, schema] advanced `phasesOk` phases, optionally with the next running. */
function runAt(phasesOk: number, running = false): RunJournal {
	let journal = createRunJournal({
		from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
		to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
		plan: [
			{ release: '7.0.2', step: { kind: 'ontology' } },
			{ release: '7.0.2', step: { kind: 'code' } },
			{ release: '7.0.2', step: { kind: 'schema' } },
		],
	});
	journal = transition(journal, 'PREFLIGHT_OK');
	journal = transition(journal, 'BACKED_UP');
	for (let at = 0; at < phasesOk; at++) journal = finishPhase(startPhase(journal), 'ok', {});
	return running ? startPhase(journal) : journal;
}

/** A free update lock (no process drives the run). */
const FREE: LockProbe = async () => ({ release: async () => {} });
const cli = (root: string, ...argv: string[]) => runUpdateCli([...argv, '--root', root], FREE);

describe('status', () => {
	test('no run → 3; a run in flight → 0, named, with its phases', async () => {
		const root = scratch();
		expect((await cli(root, 'status')).code).toBe(3);
		await writeRunJournal(root, runAt(1, true));
		const shown = await cli(root, 'status');
		expect(shown.code).toBe(0);
		expect(shown.lines[0]).toContain('IN FLIGHT');
		expect(shown.lines.join('\n')).toContain('7.0.2 code — running');
		expect(shown.lines.join('\n')).toContain('7.0.2 schema — pending');
	});

	test('an unreadable journal → 4', async () => {
		const root = scratch();
		writeFileSync(join(root, '20261030T000000Z_torn.json'), '{"format":');
		expect((await cli(root, 'status')).code).toBe(4);
	});
});

describe('abort', () => {
	test('the human exits: REFUSED from PLANNED, ABANDONED before the swap, MANUAL after it', () => {
		const planned = createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
			plan: [],
		});
		expect(abortTarget(planned)).toBe('REFUSED');
		expect(abortTarget(runAt(1))).toBe('ABANDONED');
		expect(abortTarget(runAt(0, true))).toBe('ABANDONED');
		expect(abortTarget(runAt(2))).toBe('MANUAL');
		expect(abortTarget(runAt(2, true))).toBe('MANUAL');
		expect(abortTarget(runAt(1, true))).toContain('swap may have landed');
	});

	test('ends the run on disk (a running phase marked aborted); nothing blocks after it', async () => {
		const root = scratch();
		await writeRunJournal(root, runAt(2, true));
		const ended = await cli(root, 'abort', 'migration', 'hung');
		expect(ended.code).toBe(0);
		expect(await blockingRun(root)).toBeNull();
		const shown = await cli(root, 'status', '--json');
		const journal = shown.json as RunJournal;
		expect(journal.state).toBe('MANUAL');
		expect(journal.note).toContain('migration hung');
		expect(journal.phases.at(-1)).toMatchObject({ outcome: 'failed', evidence: { aborted: true } });
	});

	test('refused while a process holds the update lock — the live server would overwrite the abort; the lock is released after', async () => {
		const root = scratch();
		await writeRunJournal(root, runAt(2, true));
		const held = await runUpdateCli(['abort', '--root', root], async () => null);
		expect(held.code).toBe(1);
		expect(held.lines[0]).toContain('holds the update lock');
		expect(await blockingRun(root)).not.toBeNull();
		const unreadable = await runUpdateCli(['abort', '--root', root], async () => {
			throw new Error('planted: database down');
		}).catch((error: unknown) => String(error));
		expect(String(unreadable)).toContain('cannot read the update lock');
		let released = 0;
		const ended = await runUpdateCli(['abort', '--root', root], async () => ({
			release: async () => {
				released++;
			},
		}));
		expect(ended.code).toBe(0);
		expect(released).toBe(1);
	});

	test('closes a NEEDS_DB_RESTORE run (B3): new runs blocked until then, free after', async () => {
		const root = scratch();
		const restored = transition(runAt(2), 'NEEDS_DB_RESTORE', 'planted');
		await writeRunJournal(root, restored);
		expect(await blockingRun(root)).toBeNull(); // terminal: nothing resumes it
		expect((await unclosedRestore(root))?.run_id).toBe(restored.run_id);
		const closed = await cli(root, 'abort', 'restored', 'the', 'dump');
		expect(closed.code).toBe(0);
		expect(closed.json).toMatchObject({ run_id: restored.run_id, restore_closed: true });
		expect(await unclosedRestore(root)).toBeNull();
		expect((await cli(root, 'abort')).code).toBe(3);
	});

	test('refused while the code phase runs; no run → 3', async () => {
		const root = scratch();
		expect((await cli(root, 'abort')).code).toBe(3);
		await writeRunJournal(root, runAt(1, true));
		expect((await cli(root, 'abort')).code).toBe(1);
		expect(await blockingRun(root)).not.toBeNull();
	});
});

describe('check, apply, resume', () => {
	test('check answers the rollback predicate; apply / resume are the server’s', async () => {
		const root = scratch();
		expect((await cli(root, 'check')).code).toBe(3);
		// Known verdicts, planted: [ontology, code, schema] all ran — the schema phase
		// AFTER the code swap. Its release compat decides (the journal's own plans).
		const planOf = (compat: 'compatible' | 'incompatible') => ({
			'7.0.2': { version: '7.0.2', compat, steps: [], declared: true },
		});
		await writeRunJournal(root, { ...runAt(3), release_plans: planOf('compatible') });
		const allowed = await cli(root, 'check');
		expect(allowed.code).toBe(0);
		expect(allowed.json).toMatchObject({ verdict: 'allowed' });
		expect(allowed).toMatchObject(
			await rollbackCheck(root).then(({ code, line }) => ({ code, json: line })),
		);

		const refusedRoot = scratch();
		await writeRunJournal(refusedRoot, { ...runAt(3), release_plans: planOf('incompatible') });
		const refused = await cli(refusedRoot, 'check');
		expect(refused.code).toBe(1);
		expect(refused.json).toMatchObject({
			verdict: 'needs_db_restore',
			report: { crossedBy: '7.0.2 schema', previousRelease: '7.0.1' },
		});
		expect(refused).toMatchObject(
			await rollbackCheck(refusedRoot).then(({ code, line }) => ({ code, json: line })),
		);
		// FLOOR: the same incompatible release whose database phase ran only BEFORE the
		// swap (the ontology precondition) is still allowed — the verdict reads order.
		const preSwapRoot = scratch();
		await writeRunJournal(preSwapRoot, { ...runAt(2), release_plans: planOf('incompatible') });
		const preSwap = await cli(preSwapRoot, 'check');
		expect(preSwap.code).toBe(0);
		expect(preSwap.json).toMatchObject({ verdict: 'allowed' });
		for (const command of ['apply', 'resume']) {
			const answer = await cli(root, command);
			expect(answer.code).toBe(2);
			expect(answer.lines[0]).toContain('runs in the server');
		}
		expect((await cli(root, 'nonsense')).code).toBe(2);
	});
});

describe('plan (the dry run)', () => {
	test('a release the master does not offer is refused; no master configured is said', async () => {
		const master = { url: 'https://master.example/api/', code: 'k' };
		const empty = async () => ({ items: [], plans: { plans: {}, data: {} } });
		expect(await planCodeUpdate('7.0.2', empty, [master])).toMatchObject({
			ok: false,
			refusal: 'release_unknown',
		});
		expect(await planCodeUpdate('7.0.2', empty, [])).toMatchObject({
			ok: false,
			detail: expect.stringContaining('CODE_SERVERS'),
		});
	});
});
