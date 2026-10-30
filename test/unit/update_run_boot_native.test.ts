/**
 * THE BOOT'S VIEW OF THE UPDATE RUN (update audit 2026-10-29, Phase 2 #6/#15) —
 * src/core/update/run/boot.ts, over scratch run roots (no database, no network).
 *
 *  - readBootRun: no journal → null; a terminal run → null; a non-terminal run
 *    whose only phase is pre-swap (ontology) → ownsBoot false; a run whose code
 *    phase started (running or ok) → ownsBoot true; a torn journal → null AND a
 *    loud console.error naming the file (it blocks every new run);
 *  - bootRunDecision, fed the BootRun objects readBootRun returned, so the two
 *    compose: a smoke boot does nothing; no run → boot + online migrations, no
 *    resume; a pre-swap run → migrations AND a resume; a run owning the boot →
 *    no boot runner, no online lane, a resume.
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BootRun, bootRunDecision, readBootRun } from '../../src/core/update/run/boot.ts';
import {
	createRunJournal,
	finishPhase,
	type RunJournal,
	startPhase,
	transition,
	writeRunJournal,
} from '../../src/core/update/run/journal.ts';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_update_boot_'));
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

/** Plant `journal` in a fresh root and read the boot's view of it. */
async function bootRunOf(journal: RunJournal): Promise<{ root: string; run: BootRun | null }> {
	const root = scratch();
	await writeRunJournal(root, journal);
	expect(readdirSync(root)).toEqual([`${journal.run_id}.json`]);
	return { root, run: await readBootRun(root) };
}

describe('readBootRun: which run, if any, this boot belongs to', () => {
	test('no journal (a missing root, an empty root) → null', async () => {
		expect(await readBootRun(join(scratch(), 'absent'))).toBeNull();
		expect(await readBootRun(scratch())).toBeNull();
	});

	test('a non-terminal run with only its ontology phase (pre-swap) → ownsBoot false', async () => {
		for (const journal of [runAt(0, true), runAt(1)]) {
			const { run } = await bootRunOf(journal);
			expect(run?.journal.run_id).toBe(journal.run_id);
			expect(run?.journal.phases.map((phase) => phase.step.kind)).toEqual(['ontology']);
			expect(run?.ownsBoot).toBe(false);
		}
	});

	test('a run whose code phase started (running, or ok) → ownsBoot true', async () => {
		for (const journal of [runAt(1, true), runAt(2), runAt(2, true)]) {
			const { run } = await bootRunOf(journal);
			expect(run?.journal.run_id).toBe(journal.run_id);
			expect(run?.journal.phases.some((phase) => phase.step.kind === 'code')).toBe(true);
			expect(run?.ownsBoot).toBe(true);
		}
	});

	test('a terminal run → null', async () => {
		const ended = transition(runAt(1), 'ABANDONED', 'ended by a human');
		expect(ended.state).toBe('ABANDONED');
		const { run } = await bootRunOf(ended);
		expect(run).toBeNull();
	});

	test('a torn journal → null, said loudly with the file', async () => {
		const root = scratch();
		const torn = join(root, '20261030T000000Z_deadbeef.json');
		writeFileSync(torn, '{"format":1,"run_id":"20261030T0');
		const spy = spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(await readBootRun(root)).toBeNull();
			expect(spy).toHaveBeenCalledTimes(1);
			const logged = String(spy.mock.calls[0]?.[0]);
			expect(logged).toContain(torn);
			expect(logged).toContain('cannot be read');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('bootRunDecision: what this boot does, composed with readBootRun', () => {
	test('smoke boot → nothing at all, even when a run owns the boot', async () => {
		const { run } = await bootRunOf(runAt(2));
		expect(run?.ownsBoot).toBe(true);
		const nothing = { bootMigrations: false, onlineMigrations: false, resumeRun: false };
		expect(bootRunDecision(true, run)).toEqual(nothing);
		expect(bootRunDecision(true, null)).toEqual(nothing);
	});

	test('no run → boot + online migrations, no resume', async () => {
		const run = await readBootRun(scratch());
		expect(run).toBeNull();
		expect(bootRunDecision(false, run)).toEqual({
			bootMigrations: true,
			onlineMigrations: true,
			resumeRun: false,
		});
	});

	test('a pre-swap run → the boot runs its migrations AND resumes the run', async () => {
		const { run } = await bootRunOf(runAt(1));
		expect(run?.ownsBoot).toBe(false);
		expect(bootRunDecision(false, run)).toEqual({
			bootMigrations: true,
			onlineMigrations: true,
			resumeRun: true,
		});
	});

	test('a run owning the boot → no boot runner, no online lane, a resume', async () => {
		const { run } = await bootRunOf(runAt(2));
		expect(run?.ownsBoot).toBe(true);
		expect(bootRunDecision(false, run)).toEqual({
			bootMigrations: false,
			onlineMigrations: false,
			resumeRun: true,
		});
	});
});
