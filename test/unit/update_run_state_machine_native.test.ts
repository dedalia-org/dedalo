/**
 * THE UPDATE RUN (update audit 2026-10-29, design §3, Phase 2.1):
 * src/core/update/run/{states,journal,rollback,plan,lock,verify}.ts.
 *
 *  - the state machine moves only along a run's own happy path (its release
 *    steps, D-1) or to a side exit, and never out of a terminal state;
 *  - a phase's success IS the move to its state; a journal is written durably
 *    and read back; a non-terminal OR unreadable journal blocks a new run;
 *  - the rollback predicate (D-2) allows an automatic code rollback only while
 *    no database phase of an incompatible release ran;
 *  - the planner walks the catalog with one code swap, ontology preconditions
 *    first, and refuses what it cannot name;
 *  - the UPDATE_RUN lock is exclusive across sessions and released for the next,
 *    and held() reads pg_locks for its own session (review 2026-10-30 #8);
 *  - VERIFIED is every predicate ok, and a predicate that throws is a failure.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationSha256 } from '../../install/db/migration_ledger.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ReleasePlan, ReleaseStep } from '../../src/core/update/catalog_file.ts';
import {
	blockingRun,
	createRunJournal,
	finishPhase,
	type RunJournal,
	readRunJournals,
	startPhase,
	transition,
	writeRunJournal,
} from '../../src/core/update/run/journal.ts';
import {
	tryAcquireUpdateRunLock,
	UPDATE_RUN_LOCK_KEY,
	UPDATE_RUN_LOCK_NAMESPACE,
} from '../../src/core/update/run/lock.ts';
import { planRun } from '../../src/core/update/run/plan.ts';
import { canAutoRollback } from '../../src/core/update/run/rollback.ts';
import { canTransition, happyPath, isTerminal } from '../../src/core/update/run/states.ts';
import { type VerifyReads, verifyRun } from '../../src/core/update/run/verify.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';
import { dataModelOf } from '../../src/core/update/version_contract.ts';

const roots: string[] = [];
const scratchRoot = () => {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_update_runs_'));
	roots.push(root);
	return root;
};
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const plansOf = (
	entries: Record<string, { compat: 'compatible' | 'incompatible' | null; steps: ReleaseStep[] }>,
): Record<string, ReleasePlan> =>
	Object.fromEntries(
		Object.entries(entries).map(([version, { compat, steps }]) => [
			version,
			{ version, compat, steps, declared: true },
		]),
	);

const CATALOG = plansOf({
	'7.0.1': { compat: null, steps: [{ kind: 'code' }] },
	'7.0.2': { compat: 'compatible', steps: [{ kind: 'code' }, { kind: 'schema' }] },
	'7.1.0': {
		compat: 'incompatible',
		steps: [
			{ kind: 'ontology', min: '7.0.2' },
			{ kind: 'code' },
			{ kind: 'ontology' },
			{ kind: 'data' },
		],
	},
});

const ENDPOINT = { release: '7.0.0', data: '7.0.0', model: '7.0.0' };
const journalOf = (plan: RunJournal['plan']) =>
	createRunJournal({
		from: ENDPOINT,
		to: { release: '7.1.0', data: '7.1.0', model: '7.1.0' },
		plan,
	});

describe('states: the happy path is the run’s own steps', () => {
	const phases = ['ontology', 'code', 'schema'] as const;
	test('each state moves to the next one only', () => {
		const path = happyPath([...phases]);
		expect(path).toEqual([
			'PLANNED',
			'PREFLIGHT_OK',
			'BACKED_UP',
			'ONTOLOGY_APPLIED',
			'CODE_SWAPPED',
			'SCHEMA_APPLIED',
			'VERIFIED',
			'CONFIRMED',
		]);
		expect(canTransition([...phases], 0, 'PLANNED', 'PREFLIGHT_OK')).toBe(true);
		expect(canTransition([...phases], 0, 'PLANNED', 'BACKED_UP')).toBe(false);
		expect(canTransition([...phases], 0, 'BACKED_UP', 'ONTOLOGY_APPLIED')).toBe(true);
		expect(canTransition([...phases], 1, 'ONTOLOGY_APPLIED', 'CODE_SWAPPED')).toBe(true);
		expect(canTransition([...phases], 2, 'CODE_SWAPPED', 'VERIFIED')).toBe(false);
		expect(canTransition([...phases], 3, 'SCHEMA_APPLIED', 'VERIFIED')).toBe(true);
		expect(canTransition([...phases], 3, 'VERIFIED', 'CONFIRMED')).toBe(true);
	});

	test('side exits: before the swap a run fails clean; after it, rollback or a human', () => {
		expect(canTransition([...phases], 0, 'PLANNED', 'REFUSED')).toBe(true);
		expect(canTransition([...phases], 1, 'ONTOLOGY_APPLIED', 'FAILED_PRE_SWAP')).toBe(true);
		expect(canTransition([...phases], 1, 'ONTOLOGY_APPLIED', 'ROLLED_BACK_CODE')).toBe(false);
		expect(canTransition([...phases], 2, 'CODE_SWAPPED', 'FAILED_PRE_SWAP')).toBe(false);
		expect(canTransition([...phases], 2, 'CODE_SWAPPED', 'ROLLED_BACK_CODE')).toBe(true);
		expect(canTransition([...phases], 2, 'CODE_SWAPPED', 'NEEDS_DB_RESTORE')).toBe(true);
	});

	test('a terminal state goes nowhere', () => {
		for (const state of ['CONFIRMED', 'REFUSED', 'NEEDS_DB_RESTORE', 'ROLLED_BACK_CODE'] as const) {
			expect(isTerminal(state)).toBe(true);
			expect(canTransition([...phases], 3, state, 'VERIFIED')).toBe(false);
			expect(canTransition([...phases], 3, state, 'MANUAL')).toBe(false);
		}
	});
});

describe('journal: phases drive the state, and the file is the run’s memory', () => {
	const plan: RunJournal['plan'] = [
		{ release: '7.0.2', step: { kind: 'code' } },
		{ release: '7.0.2', step: { kind: 'schema' } },
	];

	test('a phase’s success is the move to its state; a transition into a phase state is refused', () => {
		let journal = transition(transition(journalOf(plan), 'PREFLIGHT_OK'), 'BACKED_UP');
		expect(() => transition(journal, 'CODE_SWAPPED')).toThrow(/reached by finishing its phase/);
		journal = finishPhase(startPhase(journal), 'ok', { swapped: true });
		expect(journal.state).toBe('CODE_SWAPPED');
		expect(() => transition(journal, 'VERIFIED')).toThrow(/not a transition of this run/);
		journal = finishPhase(startPhase(journal), 'ok', { applied: ['0015_x.sql'] });
		expect(journal.state).toBe('SCHEMA_APPLIED');
		journal = transition(transition(journal, 'VERIFIED'), 'CONFIRMED');
		expect(journal.phases.map((phase) => [phase.step.kind, phase.outcome])).toEqual([
			['code', 'ok'],
			['schema', 'ok'],
		]);
		expect(() => startPhase(journal)).toThrow(/no phase to start/);
	});

	test('a failed phase leaves the state for the side exit', () => {
		let journal = transition(transition(journalOf(plan), 'PREFLIGHT_OK'), 'BACKED_UP');
		journal = finishPhase(startPhase(journal), 'ok', {});
		journal = finishPhase(startPhase(journal), 'failed', { error: 'boom' });
		expect(journal.state).toBe('CODE_SWAPPED');
		expect(transition(journal, 'ROLLED_BACK_CODE').state).toBe('ROLLED_BACK_CODE');
	});

	test('written durably, read back; a non-terminal run blocks a new one, a terminal one does not', async () => {
		const root = scratchRoot();
		expect(await blockingRun(root)).toBeNull();
		const running = transition(journalOf(plan), 'PREFLIGHT_OK');
		await writeRunJournal(root, running);
		const [read] = await readRunJournals(root);
		expect(read?.ok && read.journal).toEqual(running);
		expect((await blockingRun(root))?.ok).toBe(true);
		await writeRunJournal(root, transition(running, 'FAILED_PRE_SWAP', 'disk full'));
		expect(await blockingRun(root)).toBeNull();
		// floor: the directory scanned holds the journal (the empty .tmp list is not an empty read)
		expect(readdirSync(root).length).toBeGreaterThan(0);
		expect(readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
	});

	test('an unreadable journal blocks too — a torn file is no proof that no run is in flight', async () => {
		const root = scratchRoot();
		writeFileSync(join(root, '20261030T000000Z_torn.json'), '{"format":1,"run_');
		const blocking = await blockingRun(root);
		expect(blocking?.ok).toBe(false);
	});
});

describe('rollback predicate (D-2)', () => {
	const run = (
		phases: { release: string; kind: ReleaseStep['kind']; outcome: 'ok' | 'failed' | 'skipped' }[],
	) => ({
		...journalOf([]),
		phases: phases.map(({ release, kind, outcome }) => ({
			release,
			step: { kind },
			started: '',
			finished: '',
			outcome,
			evidence: {},
		})),
	});

	test('code + compatible schema: the previous code still fits — allowed', () => {
		const verdict = canAutoRollback(
			run([
				{ release: '7.0.2', kind: 'code', outcome: 'ok' },
				{ release: '7.0.2', kind: 'schema', outcome: 'ok' },
			]),
			CATALOG,
		);
		expect(verdict.allowed).toBe(true);
	});

	test('a database phase of an incompatible release — even a FAILED one — needs a human', () => {
		for (const outcome of ['ok', 'failed'] as const) {
			const verdict = canAutoRollback(
				run([
					{ release: '7.1.0', kind: 'code', outcome: 'ok' },
					{ release: '7.1.0', kind: 'data', outcome },
				]),
				CATALOG,
			);
			expect(verdict.allowed).toBe(false);
			expect(verdict.crossedBy).toBe('7.1.0 data');
		}
		const skipped = canAutoRollback(
			run([{ release: '7.1.0', kind: 'data', outcome: 'skipped' }]),
			CATALOG,
		);
		expect(skipped.allowed).toBe(true);
	});

	test('a release this code’s catalog does not know is never assumed compatible', () => {
		const unknown = run([
			{ release: '9.9.9', kind: 'code', outcome: 'ok' },
			{ release: '9.9.9', kind: 'schema', outcome: 'ok' },
		]);
		expect(canAutoRollback(unknown, CATALOG).allowed).toBe(false);
	});

	test('a phase BEFORE the swap never crosses — the previous code ran through it', () => {
		const preSwap = run([
			{ release: '7.1.0', kind: 'ontology', outcome: 'ok' },
			{ release: '7.1.0', kind: 'code', outcome: 'ok' },
		]);
		expect(canAutoRollback(preSwap, CATALOG).allowed).toBe(true);
		expect(
			canAutoRollback(run([{ release: '7.1.0', kind: 'ontology', outcome: 'failed' }]), CATALOG)
				.allowed,
		).toBe(true);
	});
});

describe('planner', () => {
	test('one code swap; ontology preconditions first; each release’s steps after, in order', () => {
		const plan = planRun({
			installedRelease: '7.0.0',
			installedData: [7, 0, 0],
			target: '7.1.0',
			plans: CATALOG,
			targetData: [7, 1, 0],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.plan.map(({ release, step }) => `${release} ${step.kind}`)).toEqual([
			'7.1.0 ontology',
			'7.1.0 code',
			'7.0.2 schema',
			'7.1.0 ontology',
			'7.1.0 data',
		]);
		expect(plan.from.model).toBe('7.0.0');
		expect(plan.to.model).toBe('7.1.0');
	});

	test('refuses what it cannot name', () => {
		const refusal = (target: string, installed = '7.0.2') =>
			planRun({
				installedRelease: installed,
				installedData: [7, 0, 0],
				target,
				plans: CATALOG,
				targetData: [7, 0, 0],
			});
		expect(refusal('7.0.9')).toMatchObject({ ok: false, refusal: 'release_unknown' });
		expect(refusal('7.0.1')).toMatchObject({ ok: false, refusal: 'not_forward' });
		expect(refusal('not-a-version')).toMatchObject({ ok: false, refusal: 'release_unreadable' });
	});

	test('the same triple is a code-only run (prerelease → stable, a developer build); the walk’s plans are journaled', () => {
		const same = planRun({
			installedRelease: '7.0.2-beta.1',
			installedData: [7, 0, 0],
			target: '7.0.2',
			plans: CATALOG,
			targetData: [7, 0, 0],
		});
		expect(same).toMatchObject({ ok: true, releasePlans: {} });
		// the run owns the boot's migrations: a schema phase for the target closes it (#3)
		if (same.ok)
			expect(same.plan).toEqual([
				{ release: '7.0.2', step: { kind: 'code' } },
				{ release: '7.0.2', step: { kind: 'schema' } },
			]);
		const walked = planRun({
			installedRelease: '7.0.0',
			installedData: [7, 0, 0],
			target: '7.1.0',
			plans: CATALOG,
			targetData: [7, 1, 0],
		});
		if (!walked.ok) throw new Error('planned walk refused');
		expect(Object.keys(walked.releasePlans).sort()).toEqual(['7.0.1', '7.0.2', '7.1.0']);
		expect(createRunJournal(walked).release_plans['7.1.0']?.compat).toBe('incompatible');
	});
});

describe('UPDATE_RUN lock', () => {
	test('exclusive across sessions, released for the next; a second release is a no-op', async () => {
		const first = await tryAcquireUpdateRunLock();
		let next: Awaited<ReturnType<typeof tryAcquireUpdateRunLock>> = null;
		try {
			expect(first).not.toBeNull();
			expect(await first?.held?.()).toBe(true); // pg_locks, on its own session (#8)
			expect(await tryAcquireUpdateRunLock()).toBeNull();
			await first?.release();
			expect(await first?.held?.()).toBe(false);
			await first?.release();
			next = await tryAcquireUpdateRunLock();
			expect(next).not.toBeNull();
			expect(await next?.held?.()).toBe(true);
		} finally {
			// a failed expectation above must not leave the real lock held for the suite
			await first?.release();
			await next?.release();
		}
	});
});

describe('UPDATE_RUN lock on a dead session', () => {
	test('#7: release() on a terminated session resolves (never replaces the outcome it guards); held() is false; the lock is free', async () => {
		const { sql } = await import('../../src/core/db/postgres.ts');
		const lock = await tryAcquireUpdateRunLock();
		let next: Awaited<ReturnType<typeof tryAcquireUpdateRunLock>> = null;
		try {
			expect(lock).not.toBeNull();
			// Ends EXACTLY this lock's own session on the marked suite DB — never
			// another database's holder of the same key on a shared cluster.
			await assertTestDatabase('update_run_state_machine.dead_session');
			expect(lock?.pid).toBeGreaterThan(0);
			await sql.unsafe(
				`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory'
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
				   AND classid = $1 AND objid = $2 AND objsubid = 2 AND granted AND pid = $3`,
				[UPDATE_RUN_LOCK_NAMESPACE, UPDATE_RUN_LOCK_KEY, lock?.pid],
			);
			expect(await lock?.held?.()).toBe(false);
			await lock?.release(); // resolves
			next = await tryAcquireUpdateRunLock();
			expect(next).not.toBeNull();
		} finally {
			await lock?.release();
			await next?.release();
		}
	});
});

describe('post-verify', () => {
	const ledger = {
		format: 1,
		migrations: {
			'0001_a.sql': {
				sha256: migrationSha256('A'),
				class: 'compatible' as const,
				release: '7.0.0',
			},
		},
	};
	const reads = (overrides: Partial<VerifyReads> = {}): VerifyReads => ({
		pendingBootMigrations: async () => [],
		recordedHashes: async () => [{ version: '0001_a.sql', sha256: migrationSha256('A') }],
		ledger: async () => ledger,
		installedDataVersion: async () => [7, 1, 0],
		...overrides,
	});
	const journal = { ...journalOf([]), to: { release: '7.1.0', data: '7.1.0', model: '7.1.0' } };

	test('every predicate ok → VERIFIED (a target from the SHIPPED catalog)', async () => {
		// data_model reads the shipped catalog (version_contract.ts dataModelOf), so
		// the target must be one it knows: the engine's own data version and its model.
		const shippedModel = dataModelOf(DEDALO_DATA_VERSION);
		if (shippedModel === null) throw new Error('the shipped data version has no model');
		const shipped = {
			...journalOf([]),
			to: {
				release: formatVersion(DEDALO_DATA_VERSION),
				data: formatVersion(DEDALO_DATA_VERSION),
				model: formatVersion(shippedModel),
			},
		};
		const result = await verifyRun(
			shipped,
			reads({ installedDataVersion: async () => [...DEDALO_DATA_VERSION] }),
		);
		expect(result.verdicts.map((v) => [v.id, v.ok])).toEqual([
			['schema_clean', true],
			['data_version', true],
			['data_model', true],
		]);
		expect(result.verified).toBe(true);
	});

	test('a target model the shipped catalog does not know → data_model red, not VERIFIED', async () => {
		// 7.1.0 is above every shipped release: its model is unknown, an honest red.
		const result = await verifyRun(journal, reads());
		expect(result.verdicts.map((v) => v.id)).toEqual([
			'schema_clean',
			'data_version',
			'data_model',
		]);
		expect(result.verdicts.find((v) => v.id === 'schema_clean')?.ok).toBe(true);
		expect(result.verdicts.find((v) => v.id === 'data_version')?.ok).toBe(true);
		expect(result.verdicts.find((v) => v.id === 'data_model')?.ok).toBe(false);
		expect(result.verified).toBe(false);
	});

	test('a pending migration, a drifted hash, a behind database, a throwing read: each is red, by name', async () => {
		const pending = await verifyRun(
			journal,
			reads({ pendingBootMigrations: async () => ['0015_x.sql'] }),
		);
		expect(pending.verified).toBe(false);
		expect(pending.verdicts[0]?.detail).toContain('pending: 0015_x.sql');
		const drifted = await verifyRun(
			journal,
			reads({ recordedHashes: async () => [{ version: '0001_a.sql', sha256: 'f'.repeat(64) }] }),
		);
		expect(drifted.verdicts[0]?.detail).toContain('hash differs from the ledger: 0001_a.sql');
		const behind = await verifyRun(journal, reads({ installedDataVersion: async () => [7, 0, 0] }));
		expect(behind.verdicts.find((v) => v.id === 'data_version')?.ok).toBe(false);
		const broken = await verifyRun(
			journal,
			reads({
				ledger: async () => {
					throw new Error('gone');
				},
			}),
		);
		expect(broken.verdicts[0]).toMatchObject({ id: 'schema_clean', ok: false });
		expect(broken.verified).toBe(false);
	});
});
