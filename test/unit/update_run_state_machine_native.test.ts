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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { migrationSha256 } from '../../install/db/migration_ledger.ts';
import { OS_ROWS } from '../../src/core/install/host/os_support.ts';
import {
	renderTemplate,
	SYSTEMD_DIR,
	UNIT_TEMPLATES,
} from '../../src/core/install/host/systemd/render.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ReleasePlan, ReleaseStep } from '../../src/core/update/catalog_file.ts';
import {
	type HostUnitsState,
	isReleaseRender,
	readHostUnitsState,
	shippedTemplateNames,
} from '../../src/core/update/run/host_units.ts';
import {
	blockingRun,
	createRunJournal,
	finishPhase,
	newRunId,
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
import {
	type PredicateVerdict,
	type VerifyReads,
	verifyRun,
} from '../../src/core/update/run/verify.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';
import { dataModelOf } from '../../src/core/update/version_contract.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
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
		// The backup step's refusal: nothing ran, so REFUSED — never after the backup.
		expect(canTransition([...phases], 0, 'PREFLIGHT_OK', 'REFUSED')).toBe(true);
		expect(canTransition([...phases], 0, 'BACKED_UP', 'REFUSED')).toBe(false);
		expect(canTransition([...phases], 1, 'ONTOLOGY_APPLIED', 'REFUSED')).toBe(false);
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

	test('run ids sort by start time within one second — the random suffix never decides "newest"', async () => {
		// dev drill 2026-11-02: a refused run and the real one started in the same
		// second; a seconds-only id let the suffix order them. 40 pairs, 1 ms apart,
		// written in reverse: the read order must still be the start order.
		const root = scratchRoot();
		const base = Date.parse('2026-11-02T11:58:56.000Z');
		const expected: string[] = [];
		for (let i = 0; i < 40; i++) {
			const earlier = { ...journalOf([]), run_id: newRunId(new Date(base + 2 * i)) };
			const later = { ...journalOf([]), run_id: newRunId(new Date(base + 2 * i + 1)) };
			await writeRunJournal(root, later);
			await writeRunJournal(root, earlier);
			expected.push(earlier.run_id, later.run_id);
		}
		const read = (await readRunJournals(root)).map((r) => (r.ok ? r.journal.run_id : r.file));
		expect(read).toEqual([...expected].sort());
		expect(read).toEqual(expected);
		expect(newRunId(new Date('2026-11-02T11:58:56.123Z'))).toMatch(
			/^20261102T115856123Z_[0-9a-f]{8}$/,
		);
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
			// pg_terminate_backend only SIGNALS: the backend frees its advisory lock when it
			// has exited. Wait for that (bounded) — under load the immediate re-acquire raced
			// it — so the leg measures "the lock is free", not the scheduler.
			for (let attempt = 0; attempt < 100; attempt++) {
				const alive = (await sql.unsafe('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
					lock?.pid,
				])) as unknown[];
				if (alive.length === 0) break;
				await Bun.sleep(50);
			}
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
		hostUnits: async () => ({ kind: 'not_systemd' as const }),
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
			['host_units', true],
		]);
		expect(result.verified).toBe(true);
	});

	test("host_units (C33): the host's templates vs this release's render — ALWAYS ok; a difference is an OFFER (the root re-render command), never a failure", async () => {
		const refresh =
			'sudo /opt/dedalo/bun/1.4.4/bun run /home/ded_zzhu/dedalo/scripts/ops/host_units_refresh.ts --instance zzhu';
		const of = async (state: HostUnitsState) =>
			(await verifyRun(journal, reads({ hostUnits: async () => state }))).verdicts.find(
				(v) => v.id === 'host_units',
			) as PredicateVerdict;
		// not a systemd instance: ok, said, no offer
		const none = await of({ kind: 'not_systemd' });
		expect(none).toMatchObject({ ok: true });
		expect(none.offer).toBeUndefined();
		expect(none.detail).toContain('not a production systemd instance');
		// current: ok, no offer
		const current = await of({ kind: 'current', refresh });
		expect(current.ok).toBe(true);
		expect(current.offer).toBeUndefined();
		// legacy (pre-C32 instance, templates current or not): ok, the offer IS the derived command
		const legacy = await of({ kind: 'legacy', refresh, templates: [] });
		expect(legacy.ok).toBe(true);
		expect(legacy.offer).toBe(refresh);
		expect(legacy.detail).toContain('before the writable-roots release');
		// differs: STILL ok (the run never writes /etc/systemd), the offer IS the manifest's command
		const differs = await of({
			kind: 'differs',
			refresh,
			templates: ['dedalo-ts@.service', 'dedalo-backup@.timer'],
		});
		expect(differs.ok).toBe(true);
		expect(differs.offer).toBe(refresh);
		expect(differs.detail).toContain('dedalo-ts@.service, dedalo-backup@.timer');
		expect(differs.detail).toContain('ran as the service user');
		expect(differs.detail).toContain(refresh);
		// the manifest named but unreadable: ok, no command to offer (the engine names the script)
		const unreadable = await of({
			kind: 'manifest_unreadable',
			path: '/etc/systemd/system/dedalo-ts@zzhu.service.d/dedalo-writable-roots.json',
			reason: 'not JSON',
		});
		expect(unreadable.ok).toBe(true);
		expect(unreadable.offer).toBeUndefined();
		expect(unreadable.detail).toContain('not JSON');
		expect(unreadable.detail).toContain('host_units_refresh.ts');
		// a differing host never un-verifies the run: the other predicates decide
		const run = await verifyRun(
			journal,
			reads({
				hostUnits: async () => ({ kind: 'differs', refresh, templates: ['dedalo-ts@.service'] }),
				installedDataVersion: async () => [7, 1, 0],
			}),
		);
		expect(run.verdicts.find((v) => v.id === 'host_units')?.ok).toBe(true);
		expect(run.verdicts.filter((v) => !v.ok).map((v) => v.id)).toEqual(['data_model']);
	});

	test("readHostUnitsState (C33): no manifest named → not_systemd; the manifest's refresh is the offer; a template absent or of other bytes differs, this release's render (any OS row) is current", async () => {
		const host = scratchRoot();
		const manifest = join(host, 'dedalo-writable-roots.json');
		const refresh =
			'sudo /opt/dedalo/bun/1.4.4/bun run /home/ded_zzhu/dedalo/scripts/ops/host_units_refresh.ts --instance zzhu';
		writeFileSync(
			manifest,
			JSON.stringify({
				format: 1,
				instance: 'zzhu',
				stamp: 'x',
				read_write_paths: ['/home/ded_zzhu'],
				refresh,
			}),
		);
		// the "host": every template at its /etc/systemd/system path, in a map the read consults
		const files = new Map<string, string>();
		const readText = async (path: string) => files.get(path) ?? null;
		const source = REPO_ROOT;
		expect(await readHostUnitsState({ manifestPath: undefined, readText, source })).toEqual({
			kind: 'not_systemd',
		});
		expect(await readHostUnitsState({ manifestPath: '', readText, source })).toEqual({
			kind: 'not_systemd',
		});
		// NO manifest but the installer's templates ON the host: an instance installed
		// before C32 — `legacy`, the offer derived from the tree (the instance = the
		// directory the tree lives in), whatever the templates' state (RED before: not_systemd)
		files.set(join(SYSTEMD_DIR, 'dedalo-ts@.service'), 'an earlier release render');
		const legacy = await readHostUnitsState({ manifestPath: undefined, readText, source });
		expect(legacy).toMatchObject({ kind: 'legacy', templates: [...UNIT_TEMPLATES].sort() });
		expect((legacy as { refresh: string }).refresh).toContain(
			`${join(source, 'scripts/ops/host_units_refresh.ts')} --instance ${basename(dirname(source))}`,
		);
		files.delete(join(SYSTEMD_DIR, 'dedalo-ts@.service'));
		// the manifest itself is read through the seam: absent → unreadable, said
		expect(await readHostUnitsState({ manifestPath: manifest, readText, source })).toEqual({
			kind: 'manifest_unreadable',
			path: manifest,
			reason: 'cannot be read',
		});
		files.set(manifest, '{ not json');
		expect(await readHostUnitsState({ manifestPath: manifest, readText, source })).toMatchObject({
			kind: 'manifest_unreadable',
			reason: 'not JSON',
		});
		files.set(manifest, readFileSync(manifest, 'utf8'));
		// no template on the host: every one differs (absent counts)
		const empty = await readHostUnitsState({ manifestPath: manifest, readText, source });
		expect(empty).toEqual({ kind: 'differs', refresh, templates: [...UNIT_TEMPLATES].sort() });
		// the names this read judges are the installer's templates (the server closure stays off host/)
		expect(await shippedTemplateNames(source)).toEqual([...UNIT_TEMPLATES].sort());
		// every template this release's render, each on a DIFFERENT OS row (the read needs no host facts)
		UNIT_TEMPLATES.forEach((name, i) => {
			const row = OS_ROWS[i % OS_ROWS.length] as (typeof OS_ROWS)[number];
			files.set(join(SYSTEMD_DIR, name), renderTemplate(name, row, source));
		});
		expect(await readHostUnitsState({ manifestPath: manifest, readText, source })).toEqual({
			kind: 'current',
			refresh,
		});
		// the placeholder law: a render for ANY PostgreSQL unit name is this release's; another
		// unit name, or one extra byte, is not (no host fact decides)
		const serverSource = readFileSync(join(source, 'deploy/systemd/dedalo-ts@.service'), 'utf8');
		expect(serverSource).toContain('@@PG_SERVICE@@');
		for (const row of OS_ROWS) {
			expect(isReleaseRender(serverSource, renderTemplate('dedalo-ts@.service', row, source))).toBe(
				true,
			);
		}
		expect(
			isReleaseRender(
				serverSource,
				serverSource.replace(/@@PG_SERVICE@@/g, 'postgresql-19.service'),
			),
		).toBe(true);
		expect(
			isReleaseRender(serverSource, serverSource.replace(/@@PG_SERVICE@@/g, 'mariadb.service')),
		).toBe(false);
		expect(
			isReleaseRender(
				serverSource,
				`${renderTemplate('dedalo-ts@.service', OS_ROWS[0] as (typeof OS_ROWS)[number], source)}\n`,
			),
		).toBe(false);
		expect(isReleaseRender(serverSource, serverSource)).toBe(false);
		// a template with no placeholder: byte equality
		const timer = readFileSync(join(source, 'deploy/systemd/dedalo-backup@.timer'), 'utf8');
		expect(isReleaseRender(timer, timer)).toBe(true);
		expect(isReleaseRender(timer, `${timer} `)).toBe(false);
		// one template of other bytes (an earlier release's, a hand edit): named
		files.set(join(SYSTEMD_DIR, 'dedalo-ts@.service'), '[Unit]\nDescription=older\n');
		expect(await readHostUnitsState({ manifestPath: manifest, readText, source })).toEqual({
			kind: 'differs',
			refresh,
			templates: ['dedalo-ts@.service'],
		});
	});

	test('a target model the shipped catalog does not know → data_model red, not VERIFIED', async () => {
		// 7.1.0 is above every shipped release: its model is unknown, an honest red.
		const result = await verifyRun(journal, reads());
		expect(result.verdicts.map((v) => v.id)).toEqual([
			'schema_clean',
			'data_version',
			'data_model',
			'host_units',
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
