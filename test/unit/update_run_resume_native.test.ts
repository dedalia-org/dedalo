/**
 * THE RUN SURVIVES ITS PROCESS (update audit 2026-10-29, U-03/U-10; design
 * §3.2, Phase 2.2) — src/core/update/run/executor.ts.
 *
 * The process is KILLED inside every phase of a planted walk in turn (the
 * phase's runner never returns: the journal holds it `running`, as a SIGKILL
 * would leave it), and a fresh "process" resumes from the journal alone:
 *
 *  - a database phase that was running runs AGAIN (idempotent by design) and
 *    the run ends CONFIRMED, every planned phase ok exactly once in the end;
 *  - the code phase is settled by the booted tree: the target → it continues;
 *    the previous release → FAILED_PRE_SWAP, nothing else runs;
 *  - maintenance is held to the end and restored to the operator's own value;
 *    a refusal / failure exit restores it, NEEDS_DB_RESTORE keeps it ON;
 *  - a second run is refused while one is in flight; a red verify is a failure.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { ReleasePlan, ReleaseStep } from '../../src/core/update/catalog_file.ts';
import {
	type PhaseResult,
	type RunEffects,
	resumeUpdateRun,
	startPlannedRun,
	startUpdateRun,
} from '../../src/core/update/run/executor.ts';
import {
	closeRestore,
	createRunJournal,
	type RunJournal,
	readRunJournals,
	transition,
	writeRunJournal,
} from '../../src/core/update/run/journal.ts';
import { ontologyOnlyPlan } from '../../src/core/update/run/plan.ts';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const plan = (
	version: string,
	compat: ReleasePlan['compat'],
	kinds: ReleaseStep['kind'][],
): ReleasePlan => ({
	version,
	compat,
	steps: kinds.map((kind) => ({ kind })),
	declared: true,
});
const PLANS: Record<string, ReleasePlan> = {
	'7.0.2': plan('7.0.2', 'compatible', ['code', 'schema']),
	'7.1.0': plan('7.1.0', 'incompatible', ['ontology', 'code', 'ontology', 'data', 'ancillary']),
};
const INPUT = {
	installedRelease: '7.0.1',
	installedData: [7, 0, 0],
	target: '7.1.0',
	targetData: [7, 1, 0],
};
const EXPECTED = [
	'7.1.0 ontology',
	'7.1.0 code',
	'7.0.2 schema',
	'7.1.0 ontology',
	'7.1.0 data',
	'7.1.0 ancillary',
];

interface World {
	root: string;
	maintenance: boolean;
	calls: string[];
	confirmed: number;
	rolledBack: number;
	needsRestore: number[];
	reported: string[];
}

/** One "process": its effects over the shared world. `hangAt` = the call index whose runner never returns. */
function processOf(
	world: World,
	options: {
		booted?: string;
		digest?: string | null;
		hangAt?: number;
		fail?: string;
		verified?: boolean;
	} = {},
): { effects: RunEffects; reached: Promise<void> } {
	let reach: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const runner =
		(kind: ReleaseStep['kind']) =>
		async (entry: { release: string }): Promise<PhaseResult> => {
			const name = `${entry.release} ${kind}`;
			world.calls.push(name);
			if (options.hangAt === world.calls.length - 1) {
				reach();
				return new Promise<PhaseResult>(() => {});
			}
			if (options.fail === name) return { outcome: 'failed', evidence: { error: 'planted' } };
			return { outcome: 'ok', evidence: {}, restarting: kind === 'code' };
		};
	let held = false;
	const effects: RunEffects = {
		root: world.root,
		lock: async () => {
			if (held) return null;
			held = true;
			return {
				release: async () => {
					held = false;
				},
			};
		},
		maintenance: {
			get: () => world.maintenance,
			set: (on) => {
				world.maintenance = on;
			},
		},
		preflight: async () => null,
		backup: async () => ({
			path: '/backups/run.custom.backup',
			taken: '2026-10-30T10:00:00.000Z',
			waivedBy: null,
		}),
		runners: {
			code: runner('code'),
			ontology: runner('ontology'),
			schema: runner('schema'),
			data: runner('data'),
			ancillary: runner('ancillary'),
		},
		verify: async () => ({
			verified: options.verified ?? true,
			verdicts: [{ id: 'data_version', ok: options.verified ?? true, detail: 'planted' }],
		}),
		confirm: async () => void world.confirmed++,
		rollbackCode: async () => void world.rolledBack++,
		markNeedsRestore: async () => {
			// where in the call sequence the sentinel was marked (calls made before it)
			world.needsRestore.push(world.calls.length);
		},
		report: (journal) => void world.reported.push(journal.state),
		bootedRelease: () => options.booted ?? '7.0.1',
		bootedDigest: () => options.digest ?? null,
		plans: PLANS,
	};
	return { effects, reached };
}

function world(maintenance = false): World {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_run_resume_'));
	roots.push(root);
	return {
		root,
		maintenance,
		calls: [],
		confirmed: 0,
		rolledBack: 0,
		needsRestore: [],
		reported: [],
	};
}

async function journalOf(w: World): Promise<RunJournal> {
	const [read] = await readRunJournals(w.root);
	if (read === undefined || !read.ok) throw new Error('no readable journal');
	return read.journal;
}

const okPhases = (journal: RunJournal) =>
	journal.phases
		.filter((phase) => phase.outcome === 'ok')
		.map((phase) => `${phase.release} ${phase.step.kind}`);

describe('a clean run: start → restart into the target → resume → CONFIRMED', () => {
	test('every phase once, in plan order; maintenance held, then restored to OFF', async () => {
		const w = world(false);
		const first = await startUpdateRun(INPUT, processOf(w).effects);
		expect(first.state).toBe('restarting');
		expect(w.maintenance).toBe(true);
		const second = await resumeUpdateRun(processOf(w, { booted: '7.1.0' }).effects);
		expect(second?.journal.state).toBe('CONFIRMED');
		expect(w.calls).toEqual(EXPECTED);
		expect(okPhases(await journalOf(w))).toEqual(EXPECTED);
		expect(w.maintenance).toBe(false);
		expect(w.confirmed).toBe(1);
		expect(w.reported.at(-1)).toBe('CONFIRMED');
		expect(await resumeUpdateRun(processOf(w).effects)).toBeNull();
	});

	test('an operator who had maintenance ON keeps it ON after the run', async () => {
		const w = world(true);
		await startUpdateRun(INPUT, processOf(w).effects);
		await resumeUpdateRun(processOf(w, { booted: '7.1.0' }).effects);
		expect(w.maintenance).toBe(true);
	});
});

describe('killed inside every phase, resumed from the journal alone', () => {
	for (const [index, name] of EXPECTED.entries()) {
		test(`killed in phase ${index} (${name})`, async () => {
			const w = world(false);
			const afterCode = index > 1;
			if (afterCode) {
				await startUpdateRun(INPUT, processOf(w).effects);
				const dying = processOf(w, { booted: '7.1.0', hangAt: index });
				void resumeUpdateRun(dying.effects);
				await dying.reached;
			} else {
				const dying = processOf(w, { hangAt: index });
				void startUpdateRun(INPUT, dying.effects);
				await dying.reached;
			}
			expect((await journalOf(w)).phases.at(-1)?.outcome).toBe('running');
			const resumed = await resumeUpdateRun(processOf(w, { booted: '7.1.0' }).effects);
			if (index === 1) {
				// the code phase died before restarting, but the target booted: it landed
				expect(resumed?.state).toBe('ended');
			}
			const final =
				index === 0 ? await resumeUpdateRun(processOf(w, { booted: '7.1.0' }).effects) : resumed;
			expect(final?.journal.state).toBe('CONFIRMED');
			const journal = await journalOf(w);
			expect(okPhases(journal)).toEqual(EXPECTED);
			if (name.endsWith('code')) {
				expect(w.calls.filter((call) => call === name)).toHaveLength(1);
			} else {
				// the interrupted database phase ran again — journaled as interrupted, then ok
				expect(journal.phases.some((phase) => phase.evidence.interrupted === true)).toBe(true);
				expect(w.calls.filter((call) => call === name).length).toBeGreaterThanOrEqual(2);
			}
			expect(w.maintenance).toBe(false);
		});
	}

	test('the swap did not land (the previous tree booted): FAILED_PRE_SWAP, nothing else runs', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		const resumed = await resumeUpdateRun(processOf(w, { booted: '7.0.1' }).effects);
		expect(resumed?.journal.state).toBe('FAILED_PRE_SWAP');
		expect(w.calls).toEqual(EXPECTED.slice(0, 2));
		expect(w.maintenance).toBe(false);
	});
});

describe('a developer build: the version stays, the digest moves', () => {
	const dev = {
		installedRelease: '7.0.1',
		installedData: [7, 0, 0],
		target: '7.0.1',
		targetDigest: 'd'.repeat(64),
	};

	test('a same-triple run swaps the code, applies the target’s migrations (#3), lands on the digest', async () => {
		const w = world(false);
		const first = await startUpdateRun(dev, processOf(w).effects);
		// the run owns the boot's migrations, so its plan applies them: a new
		// migration in a developer build must land, not be verified missing
		expect(first.journal.plan).toEqual([
			{ release: '7.0.1', step: { kind: 'code' } },
			{ release: '7.0.1', step: { kind: 'schema' } },
		]);
		const resumed = await resumeUpdateRun(
			processOf(w, { booted: '7.0.1', digest: 'd'.repeat(64) }).effects,
		);
		expect(resumed?.journal.state).toBe('CONFIRMED');
		expect(w.calls).toEqual(['7.0.1 code', '7.0.1 schema']);
	});

	test('the same version on the OLD digest: the swap did not land', async () => {
		const w = world(false);
		await startUpdateRun(dev, processOf(w).effects);
		const resumed = await resumeUpdateRun(
			processOf(w, { booted: '7.0.1', digest: 'o'.repeat(64) }).effects,
		);
		expect(resumed?.journal.state).toBe('FAILED_PRE_SWAP');
	});
});

describe('an ontology-only run (the panel’s Update ontology)', () => {
	const only = () =>
		ontologyOnlyPlan({ installedRelease: '7.0.1', installedData: [7, 0, 0], plans: PLANS });

	test('one ontology phase on the installed release, no restart → CONFIRMED, maintenance restored', async () => {
		const w = world(false);
		const ended = await startPlannedRun(only(), processOf(w).effects);
		expect(ended).toMatchObject({ state: 'ended', journal: { state: 'CONFIRMED' } });
		expect(w.calls).toEqual(['7.0.1 ontology']);
		expect(w.maintenance).toBe(false);
	});

	test('killed mid-import: the next boot re-runs the phase forward', async () => {
		const w = world(false);
		const dying = processOf(w, { hangAt: 0 });
		void startPlannedRun(only(), dying.effects);
		await dying.reached;
		const resumed = await resumeUpdateRun(processOf(w).effects);
		expect(resumed?.journal.state).toBe('CONFIRMED');
		expect(w.calls).toEqual(['7.0.1 ontology', '7.0.1 ontology']);
	});

	test('a failed import is a pre-swap failure, its summary in the note; never a database restore', async () => {
		const w = world(false);
		const failing = processOf(w, { fail: '7.0.1 ontology' });
		const ended = await startPlannedRun(only(), failing.effects);
		expect(ended.journal.state).toBe('FAILED_PRE_SWAP');
		expect(w.needsRestore).toEqual([]);
		expect(w.maintenance).toBe(false);
	});
});

describe('failure exits', () => {
	test('a compatible schema failing after the swap rolls the code back', async () => {
		// a walk within ONE data model (7.0.1 → 7.0.2, compatible): the previous code still fits
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const resumed = await resumeUpdateRun(
			processOf(w, { booted: '7.0.2', fail: '7.0.2 schema' }).effects,
		);
		expect(resumed).toMatchObject({ state: 'restarting', journal: { state: 'ROLLED_BACK_CODE' } });
		expect(w.rolledBack).toBe(1);
	});

	test('an incompatible data phase failing: NEEDS_DB_RESTORE, report journaled, maintenance stays ON', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		const resumed = await resumeUpdateRun(
			processOf(w, { booted: '7.1.0', fail: '7.1.0 data' }).effects,
		);
		expect(resumed?.journal.state).toBe('NEEDS_DB_RESTORE');
		const journal = await journalOf(w);
		expect(journal.restore?.backup).toBe('/backups/run.custom.backup');
		expect(journal.restore?.crossedBy).toBe('7.1.0 ontology');
		expect(w.maintenance).toBe(true);
		expect(w.rolledBack).toBe(0);
		// the supervisor must never roll back over it: the sentinel said needs_restore
		// BEFORE the first post-swap phase of the incompatible release ran
		expect(w.needsRestore[0]).toBe(3);
		expect(w.calls[3]).toBe('7.1.0 ontology');
	});

	test('(4) #4: a needs-restore flip that does not land: the crossing phase never runs, journaled skipped; the code rolls back (model not crossed)', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		const effects = processOf(w, { booted: '7.1.0' }).effects;
		effects.markNeedsRestore = async () => {
			throw new Error('planted: ENOSPC on the sentinel');
		};
		const resumed = await resumeUpdateRun(effects);
		expect(resumed?.journal.state).toBe('ROLLED_BACK_CODE');
		expect(w.calls.slice(3)).toEqual([]); // 7.1.0 ontology (the crossing phase) never ran
		const journal = await journalOf(w);
		expect(journal.phases.at(-1)).toMatchObject({
			release: '7.1.0',
			step: { kind: 'ontology' },
			outcome: 'skipped',
			evidence: { not_run: true },
		});
		expect(String(journal.note)).toContain('ENOSPC');
		expect(w.rolledBack).toBe(1);
	});

	test('a red post-verify is a failure, never a confirm', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		const resumed = await resumeUpdateRun(
			processOf(w, { booted: '7.1.0', verified: false }).effects,
		);
		expect(resumed?.journal.state).toBe('NEEDS_DB_RESTORE');
		expect((await journalOf(w)).verify?.[0]?.ok).toBe(false);
		expect(w.confirmed).toBe(0);
	});

	test('a pre-swap ontology failure is FAILED_PRE_SWAP and restores maintenance', async () => {
		const w = world(false);
		const ended = await startUpdateRun(INPUT, processOf(w, { fail: '7.1.0 ontology' }).effects);
		expect(ended.journal.state).toBe('FAILED_PRE_SWAP');
		expect(w.maintenance).toBe(false);
	});

	test('B4: a NEEDS_DB_RESTORE run blocks every new run until a human closes it', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		await resumeUpdateRun(processOf(w, { booted: '7.1.0', fail: '7.1.0 data' }).effects);
		const held = await journalOf(w);
		expect(held.state).toBe('NEEDS_DB_RESTORE');
		const refusal = await startUpdateRun(INPUT, processOf(w).effects).catch(
			(error: unknown) => error,
		);
		expect(isDedaloError(refusal) && refusal.coordinates?.rule).toBe('restore_pending');
		await writeRunJournal(w.root, closeRestore(held, 'restored'));
		const next = await startUpdateRun(INPUT, processOf(w).effects);
		expect(next.journal.run_id).not.toBe(held.run_id);
	});

	test('a second run is refused while one is in flight', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		let caught: unknown = null;
		try {
			await startUpdateRun(INPUT, processOf(w).effects);
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught) && caught.coordinates?.rule).toBe('run_in_flight');
	});
});

describe('review 2026-10-30: the confirm, the rollback restart, the shutdown, the runs root', () => {
	test('#11 + #8/#13: a confirm that throws leaves the run VERIFIED; the next boot confirms it without re-running anything', async () => {
		const w = world(false);
		await startUpdateRun(INPUT, processOf(w).effects);
		const failing = processOf(w, { booted: '7.1.0' }).effects;
		failing.confirm = async () => {
			throw new Error('planted: sentinel unwritable');
		};
		const first = await resumeUpdateRun(failing);
		expect(first).toMatchObject({ state: 'ended', journal: { state: 'VERIFIED' } });
		expect((await journalOf(w)).note).toContain('the confirm did not land');
		expect(w.maintenance).toBe(true); // not ended: maintenance stays held
		const callsBefore = w.calls.length;
		let verifies = 0;
		const next = processOf(w, { booted: '7.1.0' }).effects;
		next.verify = async () => {
			verifies++;
			return { verified: true, verdicts: [] };
		};
		const second = await resumeUpdateRun(next);
		expect(second?.journal.state).toBe('CONFIRMED');
		expect(w.calls.length).toBe(callsBefore); // no phase ran again
		expect(verifies).toBe(0); // its verdicts are on the journal
		expect(w.confirmed).toBe(1);
		expect(w.maintenance).toBe(false);
	});

	test('#22: an ordered code rollback restores the operator maintenance BEFORE the rollback restart', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		expect(w.maintenance).toBe(true);
		const effects = processOf(w, { booted: '7.0.2', fail: '7.0.2 schema' }).effects;
		const seenAtRollback: boolean[] = [];
		effects.rollbackCode = async () => {
			seenAtRollback.push(w.maintenance);
			w.rolledBack++;
		};
		await resumeUpdateRun(effects);
		expect(seenAtRollback).toEqual([false]);
		expect((await journalOf(w)).state).toBe('ROLLED_BACK_CODE');
	});

	test('#10: a phase failing WHILE the process stops stays running for the next boot — never a failure exit', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const effects = processOf(w, { booted: '7.0.2', fail: '7.0.2 schema' }).effects;
		effects.stopping = () => true;
		const stopped = await resumeUpdateRun(effects);
		expect(stopped?.state).toBe('restarting');
		const journal = await journalOf(w);
		expect(journal.state).toBe('CODE_SWAPPED');
		expect(journal.phases.at(-1)?.outcome).toBe('running');
		expect(w.rolledBack).toBe(0);
		// the next boot (not stopping) re-runs it forward and lands
		const next = await resumeUpdateRun(processOf(w, { booted: '7.0.2' }).effects);
		expect(next?.journal.state).toBe('CONFIRMED');
	});

	test('#7: the first journal creates a missing runs root, private (0700)', async () => {
		const parent = mkdtempSync(join(tmpdir(), 'dedalo_run_root_'));
		roots.push(parent);
		const root = join(parent, 'not', 'yet');
		const journal = createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
			plan: [],
		});
		await writeRunJournal(root, journal);
		expect(statSync(root).mode & 0o777).toBe(0o700);
		const [read] = await readRunJournals(root);
		expect(read?.ok && read.journal.run_id).toBe(journal.run_id);
	});
});

describe('review 2026-10-30 (3): the lock the run holds', () => {
	test('#8: a lock lost mid-run stops the run resumable (phase left running) — never a failure exit', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const effects = processOf(w, { booted: '7.0.2' }).effects;
		let checks = 0;
		effects.lock = async () => ({
			release: async () => {},
			held: async () => {
				checks++;
				return false; // the code settle runs no runner; the schema phase asks and finds it gone
			},
		});
		const stopped = await resumeUpdateRun(effects);
		expect(stopped?.state).toBe('restarting');
		expect(checks).toBe(1);
		const journal = await journalOf(w);
		expect(journal.state).toBe('CODE_SWAPPED');
		expect(journal.phases.at(-1)).toMatchObject({ step: { kind: 'schema' }, outcome: 'running' });
		expect(w.calls).not.toContain('7.0.2 schema'); // the runner never ran without the lock
		expect(w.rolledBack).toBe(0);
		const next = await resumeUpdateRun(processOf(w, { booted: '7.0.2' }).effects);
		expect(next?.journal.state).toBe('CONFIRMED');
	});

	test('(5) #7: a lock lost WHILE a phase ran: the phase is left running (not settled ok), resumable', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const effects = processOf(w, { booted: '7.0.2' }).effects;
		let checks = 0;
		effects.lock = async () => ({
			release: async () => {},
			held: async () => ++checks < 2, // held before the schema phase, gone after it
		});
		const stopped = await resumeUpdateRun(effects);
		expect(stopped?.state).toBe('restarting');
		expect(w.calls).toContain('7.0.2 schema'); // it ran…
		const journal = await journalOf(w);
		expect(journal.phases.at(-1)).toMatchObject({ step: { kind: 'schema' }, outcome: 'running' }); // …but was not settled
		const next = await resumeUpdateRun(processOf(w, { booted: '7.0.2' }).effects);
		expect(next?.journal.state).toBe('CONFIRMED');
	});

	test('(5) #10: a run that started while this start waited for the lock refuses it under the lock', async () => {
		const w = world(false);
		const effects = processOf(w).effects;
		effects.lock = async () => {
			// the other starter's run lands while this one waits for the lock
			await writeRunJournal(
				w.root,
				createRunJournal({
					from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
					to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
					plan: [],
				}),
			);
			return { release: async () => {} };
		};
		const refusal = await startUpdateRun(
			{ ...INPUT, target: '7.0.2', targetData: [7, 0, 0] },
			effects,
		).catch((error: unknown) => error);
		expect(isDedaloError(refusal) && refusal.coordinates?.rule).toBe('run_in_flight');
		expect(w.calls).toEqual([]);
	});

	test('#10: a lock held at boot is retried after each wait, and the run resumes once it frees', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const effects = processOf(w, { booted: '7.0.2' }).effects;
		let attempts = 0;
		effects.lock = async () => (++attempts < 3 ? null : { release: async () => {} });
		const waited: number[] = [];
		const resumed = await resumeUpdateRun(effects, [10, 20, 30], async (ms) => {
			waited.push(ms);
		});
		expect(attempts).toBe(3);
		expect(waited).toEqual([10, 20]);
		expect(resumed?.journal.state).toBe('CONFIRMED');
	});

	test('(4) #3: a run settled by the holder while the boot waited is NOT resumed from the stale snapshot', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const before = await journalOf(w);
		const effects = processOf(w, { booted: '7.0.2' }).effects;
		let attempts = 0;
		effects.lock = async () => (++attempts < 2 ? null : { release: async () => {} });
		const callsBefore = w.calls.length;
		const resumed = await resumeUpdateRun(effects, [10], async () => {
			// the holder (an operator's abort) ends the run during the wait
			await writeRunJournal(
				w.root,
				transition(before, 'ABANDONED', 'planted: aborted while the boot waited'),
			);
		});
		expect(resumed).toBeNull();
		expect(w.calls.length).toBe(callsBefore); // no runner ran
		expect((await journalOf(w)).state).toBe('ABANDONED'); // nothing overwrote it
	});

	test('#10: …never past the window, and never while the process stops', async () => {
		const w = world(false);
		const within = { ...INPUT, target: '7.0.2', targetData: [7, 0, 0] };
		await startUpdateRun(within, processOf(w).effects);
		const held = processOf(w, { booted: '7.0.2' }).effects;
		let attempts = 0;
		held.lock = async () => {
			attempts++;
			return null;
		};
		expect(await resumeUpdateRun(held, [1, 1], async () => {})).toBeNull();
		expect(attempts).toBe(3);
		const stopping = processOf(w, { booted: '7.0.2' }).effects;
		stopping.stopping = () => true;
		let tried = 0;
		stopping.lock = async () => {
			tried++;
			return null;
		};
		expect(await resumeUpdateRun(stopping, [1, 1], async () => {})).toBeNull();
		expect(tried).toBe(1); // the one attempt, no retry once stopping
		expect((await journalOf(w)).state).toBe('BACKED_UP'); // still in flight for the next boot
	});
});
