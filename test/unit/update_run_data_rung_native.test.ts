/**
 * THE DATA PHASE'S RUNG (review 2026-10-30 #2) — run/data_rung.ts rungVerdict,
 * the guard production.ts dataPhase asks before engine.ts updateVersion (which
 * runs whatever rung the database stands on):
 *
 *  - at the rung's target → applied: a phase resumed after its rung COMMITTED
 *    (died in the post-commit reconcile) is ok, nothing runs again;
 *  - at the rung's source → run;
 *  - anywhere else (the next release's source, an unknown version) → refuse,
 *    nothing runs — never the next release's rung under this phase;
 *  - a release that declares no data rung → refuse.
 *
 * And the WIRING (review 2026-10-30 (4) #1): production.ts dataPhase with its
 * seams injected — applied / misplaced never call the rung, the source calls it
 * once. Plus isDefaultOntologyStep (#11), the predicate behind sourceOptional,
 * and assertSentinelStatus — the read-back behind the needs-restore flip (#4).
 * And the REAL productionRunEffects with its seams (review 2026-10-30 (5) #2/#4):
 * runners.data asks the rung, markNeedsRestore / confirm read the sentinel back,
 * backup refuses stale / unproven and journals a waiver.
 *
 * DB-less.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { DEDALO_ENGINE_VERSION } from '../../src/core/update/build_stamp.ts';
import type { UpdateDescriptor } from '../../src/core/update/catalog.ts';
import { type Freshness, freshBackupRefusal } from '../../src/core/update/preconditions.ts';
import { rungVerdict } from '../../src/core/update/run/data_rung.ts';
import {
	createRunJournal,
	type RunJournal,
	startPhase,
	transition,
} from '../../src/core/update/run/journal.ts';
import {
	assertSentinelStatus,
	dataPhase,
	isDefaultOntologyStep,
	productionRunEffects,
} from '../../src/core/update/run/production.ts';

const rung = (to: number[], from: number[]): UpdateDescriptor => ({
	updateData: true,
	versionMajor: to[0] as number,
	versionMedium: to[1] as number,
	versionMinor: to[2] as number,
	updateFromMajor: from[0] as number,
	updateFromMedium: from[1] as number,
	updateFromMinor: from[2] as number,
	sqlUpdate: ['SELECT 1'],
});

const CATALOG: Record<string, UpdateDescriptor> = {
	'7.0.1': {
		updateData: false,
		versionMajor: 7,
		versionMedium: 0,
		versionMinor: 1,
		updateFromMajor: 7,
		updateFromMedium: 0,
		updateFromMinor: 0,
	},
	'7.1.0': rung([7, 1, 0], [7, 0, 0]),
	'7.2.0': rung([7, 2, 0], [7, 1, 0]),
};

describe('a data phase runs its own rung, and only it', () => {
	test('at the source: run', () => {
		expect(rungVerdict('7.1.0', [7, 0, 0], CATALOG)).toEqual({ kind: 'run' });
	});

	test('at the target (resumed after the commit): applied, nothing runs again', () => {
		expect(rungVerdict('7.1.0', [7, 1, 0], CATALOG)).toEqual({
			kind: 'applied',
			dataVersion: '7.1.0',
		});
	});

	test('one rung past (the next release’s source): refused — never the next rung under this phase', () => {
		const verdict = rungVerdict('7.1.0', [7, 2, 0], CATALOG);
		expect(verdict.kind).toBe('refuse');
		expect(verdict.kind === 'refuse' && verdict.summary).toContain('nothing was run');
		// and the next release's own phase, at 7.1.0, runs its rung
		expect(rungVerdict('7.2.0', [7, 1, 0], CATALOG)).toEqual({ kind: 'run' });
	});

	test('a release with no data rung (code-only, or absent) is refused', () => {
		expect(rungVerdict('7.0.1', [7, 0, 0], CATALOG)).toMatchObject({ kind: 'refuse' });
		expect(rungVerdict('9.9.9', [7, 0, 0], CATALOG)).toMatchObject({ kind: 'refuse' });
	});
});

describe('production dataPhase asks the rung before it runs anything (#1)', () => {
	const phaseAt = async (current: number[]) => {
		let ran = 0;
		const result = await dataPhase(
			{ release: '7.1.0' },
			{
				currentDataVersion: async () => current,
				catalog: CATALOG,
				runRung: async () => {
					ran++;
					return { ok: true, msg: ['ran'], errors: [] };
				},
			},
		);
		return { result, ran };
	};

	test('at the target: ok already_applied, the rung never runs', async () => {
		const { result, ran } = await phaseAt([7, 1, 0]);
		expect(result).toEqual({
			outcome: 'ok',
			evidence: { already_applied: true, data_version: '7.1.0' },
		});
		expect(ran).toBe(0);
	});

	test('one rung past: failed, nothing was run', async () => {
		const { result, ran } = await phaseAt([7, 2, 0]);
		expect(result.outcome).toBe('failed');
		expect(String(result.evidence.summary)).toContain('nothing was run');
		expect(ran).toBe(0);
	});

	test('at the source: the rung runs once', async () => {
		const { result, ran } = await phaseAt([7, 0, 0]);
		expect(result.outcome).toBe('ok');
		expect(ran).toBe(1);
	});
});

describe('isDefaultOntologyStep — may the step pass without a source? (#11)', () => {
	const journal = (declared: boolean, withCode: boolean): RunJournal => ({
		...createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
			plan: [
				{ release: '7.0.2', step: { kind: 'ontology' } },
				...(withCode ? [{ release: '7.0.2', step: { kind: 'code' as const } }] : []),
			],
		}),
		release_plans: {
			'7.0.2': { version: '7.0.2', compat: 'compatible', steps: [], declared },
		},
	});

	test('undeclared release inside a code run: yes', () => {
		expect(isDefaultOntologyStep({ release: '7.0.2' }, journal(false, true))).toBe(true);
	});
	test('declared step inside a code run: no', () => {
		expect(isDefaultOntologyStep({ release: '7.0.2' }, journal(true, true))).toBe(false);
	});
	test('ontology-only run (no code phase): no', () => {
		expect(isDefaultOntologyStep({ release: '7.0.2' }, journal(false, false))).toBe(false);
	});
});

describe('assertSentinelStatus — the flip is read back (#4)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_sentinel_status_'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const sentinel = (status: string) => {
		const path = join(dir, `${status}.json`);
		writeFileSync(path, JSON.stringify({ status }));
		return path;
	};

	test('pending after the flip throws (markFailedBootSchema only logged its failure)', async () => {
		await expect(assertSentinelStatus(sentinel('pending'), 'needs_restore')).rejects.toThrow(
			"not 'needs_restore'",
		);
	});
	test('needs_restore, no file, no sentinel path: ok', async () => {
		await assertSentinelStatus(sentinel('needs_restore'), 'needs_restore');
		await assertSentinelStatus(join(dir, 'absent.json'), 'needs_restore');
		await assertSentinelStatus(null, 'needs_restore');
	});
});

describe('the REAL production effects, seams injected ((5) #2/#4)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_production_effects_'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const otherTreeSentinel = () => {
		// pending, for a tree that is NOT the booted one: the flip must leave it as it is
		const path = join(dir, `sentinel_${Math.round(performance.now() * 1000)}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				version: '0.0.1',
				previousVersion: '0.0.0',
				updateMode: 'tree_swap',
				stamp: 'planted',
				backupDir: dir,
				status: 'pending',
			}),
		);
		return path;
	};
	const run = (plan: { release: string; step: { kind: 'code' | 'data' } }[]): RunJournal =>
		createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.1.0', data: '7.1.0', model: '7.1.0' },
			plan,
		});

	test('runners.data is the rung-guarded phase: one rung past fails, the rung never runs', async () => {
		let ran = 0;
		const effects = productionRunEffects(null, null, undefined, {
			dataPhase: {
				currentDataVersion: async () => [7, 2, 0],
				catalog: CATALOG,
				runRung: async () => {
					ran++;
					return { ok: true };
				},
			},
		});
		const entry = { release: '7.1.0', step: { kind: 'data' as const } };
		const result = await effects.runners.data(entry, run([entry]));
		expect(result.outcome).toBe('failed');
		expect(ran).toBe(0);
	});

	test('markNeedsRestore rejects when the sentinel is still pending after the flip', async () => {
		const effects = productionRunEffects(null, null, undefined, {
			sentinelPath: otherTreeSentinel(),
		});
		await expect(effects.markNeedsRestore(run([]))).rejects.toThrow("not 'needs_restore'");
		const none = productionRunEffects(null, null, undefined, {
			sentinelPath: join(dir, 'absent.json'),
		});
		await none.markNeedsRestore(run([])); // no sentinel: nothing to flip
	});

	/** A PENDING sentinel of the BOOTED tree (no digest: matched by version, as boot_confirm reads it). */
	const bootedTreeSentinel = () => {
		const path = join(dir, `booted_${Math.round(performance.now() * 1000)}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				version: DEDALO_ENGINE_VERSION,
				previousVersion: '0.0.0',
				updateMode: 'tree_swap',
				stamp: 'planted',
				backupDir: join(dir, 'dedalo_prev'),
				status: 'pending',
			}),
		);
		return path;
	};
	const statusAt = (path: string) =>
		(JSON.parse(readFileSync(path, 'utf8')) as { status: string }).status;
	const captured = async (act: () => Promise<void>): Promise<string[]> => {
		const lines: string[] = [];
		const { log, error } = console;
		console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		try {
			await act();
		} finally {
			console.log = log;
			console.error = error;
		}
		return lines;
	};

	test('markNeedsRestore BEFORE a crossing phase: needs_restore, said as a precaution — never "NEEDS A HUMAN"', async () => {
		const path = bootedTreeSentinel();
		const effects = productionRunEffects(null, null, undefined, { sentinelPath: path });
		const entry = { release: '7.1.0', step: { kind: 'data' as const } };
		const about = startPhase(transition(transition(run([entry]), 'PREFLIGHT_OK'), 'BACKED_UP'));
		expect(about.state).not.toBe('NEEDS_DB_RESTORE');
		const lines = await captured(() => effects.markNeedsRestore(about));
		expect(statusAt(path)).toBe('needs_restore');
		expect(lines.some((line) => line.includes('crosses the data model at 7.1.0 data'))).toBe(true);
		expect(lines.some((line) => /NEEDS A HUMAN|migration failed/.test(line))).toBe(false);
	});

	test('markNeedsRestore of a run that ENDED NEEDS_DB_RESTORE: needs_restore, and the human is told', async () => {
		const path = bootedTreeSentinel();
		const effects = productionRunEffects(null, null, undefined, { sentinelPath: path });
		const ended: RunJournal = { ...run([]), state: 'NEEDS_DB_RESTORE' };
		const lines = await captured(() => effects.markNeedsRestore(ended));
		expect(statusAt(path)).toBe('needs_restore');
		expect(lines.some((line) => line.includes('NOT CONFIRMED — NEEDS A HUMAN'))).toBe(true);
		expect(lines.some((line) => line.includes('crosses the data model'))).toBe(false);
	});

	test('confirm rejects when the sentinel did not become confirmed', async () => {
		const effects = productionRunEffects(null, null, undefined, {
			sentinelPath: otherTreeSentinel(),
		});
		await expect(
			effects.confirm(run([{ release: '7.1.0', step: { kind: 'code' } }])),
		).rejects.toThrow("not 'confirmed'");
	});

	test('backup: stale or unproven refuses; fresh names the dump; a waiver journals the user and reads nothing', async () => {
		const verdict = { filePath: '/backups/x.custom.backup', mtimeMs: Date.UTC(2026, 9, 30) };
		const freshness = (over: Partial<Freshness>) => async () =>
			({
				newest: 0,
				hours: 1,
				stale: false,
				verified: true,
				verdict,
				rejected: [],
				...over,
			}) as Freshness;
		const backupWith = (fresh: () => Promise<Freshness>, waiveBackup = false) =>
			productionRunEffects(
				{
					principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
					codeRequest: null,
					waiveBackup,
				},
				null,
				undefined,
				{ freshness: fresh },
			).backup(run([]));
		await expect(backupWith(freshness({ stale: true }))).rejects.toThrow('backup');
		await expect(backupWith(freshness({ verdict: null }))).rejects.toThrow('backup');
		// The refusal NAMES the dump and why (preconditions.ts freshBackupRefusal),
		// typed update.refused — never a generic sentence.
		const refusalOf = async (fresh: () => Promise<Freshness>) => {
			const error = await backupWith(fresh).then(
				() => null,
				(caught: unknown) => caught,
			);
			if (!isDedaloError(error)) throw new Error(`not a DedaloError: ${String(error)}`);
			return error;
		};
		const cut = { filePath: '/backups/cut.custom.backup', reason: 'truncated' };
		const truncated = await refusalOf(
			freshness({
				hours: null,
				stale: true,
				verified: false,
				verdict: null,
				rejected: [cut],
			} as unknown as Partial<Freshness>),
		);
		expect(truncated.code).toBe('update.refused');
		expect(truncated.publicMessage).toContain('cut.custom.backup');
		expect(truncated.publicMessage).toContain('truncated');
		const slow = await refusalOf(
			freshness({
				hours: null,
				stale: true,
				verified: false,
				verdict: null,
				rejected: [{ ...cut, reason: 'unverifiable_timeout' }],
			} as unknown as Partial<Freshness>),
		);
		expect(slow.code).toBe('update.refused');
		expect(slow.publicMessage).toContain('DEDALO_BACKUP_VERIFY_SECONDS_PER_GB');
		expect(await backupWith(freshness({}))).toEqual({
			path: '/backups/x.custom.backup',
			taken: '2026-10-30T00:00:00.000Z',
			waivedBy: null,
		});
		let read = 0;
		expect(
			await backupWith(async () => {
				read++;
				return freshness({ stale: true })();
			}, true),
		).toEqual({ path: null, taken: null, waivedBy: -1 });
		expect(read).toBe(0);
	});
});

describe('freshBackupRefusal — the one refusal builder', () => {
	test('an age with no proven artifact (verdict null) is refused, typed; fresh and proven is not', () => {
		const base = { newest: 1, hours: 1, stale: false, verified: false, rejected: [] };
		const refusal = freshBackupRefusal({ ...base, verdict: null } as Freshness);
		expect(refusal?.code).toBe('update.refused');
		expect(refusal?.publicMessage).toContain('No proven restorable database backup');
		const proven = { filePath: '/b/x.backup', mtimeMs: 1 } as unknown as Freshness['verdict'];
		expect(
			freshBackupRefusal({ ...base, verified: true, verdict: proven } as Freshness),
		).toBeNull();
	});
});
