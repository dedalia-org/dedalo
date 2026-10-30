/**
 * A ONE-OFF REPAIR APPLY PROVES ITS BACKUP AND HOLDS THE UPDATE LOCK (update audit
 * 2026-10-29, U-49) — scripts/migrate_section_id_locators.ts withApplyPreconditions.
 *
 * Its header names "the mandatory fresh backup" as the recovery model (no Time
 * Machine rows by design), and nothing checked for one. Now an --apply:
 *  - refuses when the shared freshness verdict refuses, before its body runs;
 *  - with --waive-backup proceeds, and the waiver is logged with the user;
 *  - runs holding the UPDATE_RUN lock, and is refused while another holds it,
 *    or while an update run's journal is in flight (review 2026-10-30 #9);
 * and a dry run needs neither (no backup read, no lock).
 * Seams only (the verdict and the lock are injected): DB-free.
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cliMain,
	parseArgs,
	withApplyPreconditions,
} from '../../scripts/migrate_section_id_locators.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { createRunJournal, writeRunJournal } from '../../src/core/update/run/journal.ts';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
/** An empty journal root: no run in flight (never the install's own runs dir). */
function scratchRuns(): string {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_repair_runs_'));
	roots.push(root);
	return root;
}

function lockSpy() {
	const state = { held: false, acquired: 0 };
	const acquire = async () => {
		if (state.held) return null;
		state.held = true;
		state.acquired++;
		return {
			release: async () => {
				state.held = false;
			},
		};
	};
	return { state, acquire };
}

const noBackup = async () => {
	throw new Error('planted: no backup');
};

async function outcome(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return 'ran';
	} catch (error) {
		return isDedaloError(error) ? error.code : String(error);
	}
}

describe('the apply preconditions', () => {
	test('--waive-backup is parsed only as itself', () => {
		expect(parseArgs(['--all', '--user', '1', '--apply']).waiveBackup).toBe(false);
		expect(parseArgs(['--all', '--user', '1', '--apply', '--waive-backup']).waiveBackup).toBe(true);
	});

	test('an apply without a fresh backup is refused before its body runs', async () => {
		const lock = lockSpy();
		let ran = false;
		const result = await outcome(() =>
			withApplyPreconditions(
				{ apply: true, waiveBackup: false, userId: 7 },
				async () => {
					ran = true;
				},
				{ requireBackup: noBackup, acquire: lock.acquire, runsRoot: scratchRuns() },
			),
		);
		expect(result).toBe('Error: planted: no backup');
		expect(ran).toBe(false);
		expect(lock.state.acquired).toBe(0);
	});

	test('the waiver proceeds, is logged with the user, and the body runs under the lock', async () => {
		const lock = lockSpy();
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		let heldInside = false;
		try {
			await withApplyPreconditions(
				{ apply: true, waiveBackup: true, userId: 7 },
				async () => {
					heldInside = lock.state.held;
				},
				{ requireBackup: noBackup, acquire: lock.acquire, runsRoot: scratchRuns() },
			);
			expect(warn.mock.calls.flat().join(' ')).toContain('WAIVED by user 7');
		} finally {
			warn.mockRestore();
		}
		expect(heldInside).toBe(true);
		expect(lock.state.held).toBe(false);
	});

	test('refused while another holder has the lock', async () => {
		const lock = lockSpy();
		await lock.acquire();
		const result = await outcome(() =>
			withApplyPreconditions({ apply: true, waiveBackup: false, userId: 7 }, async () => {}, {
				requireBackup: async () => {},
				acquire: lock.acquire,
				runsRoot: scratchRuns(),
			}),
		);
		expect(result).toBe('update.refused');
	});

	test('#9: refused while an update run is in flight, though the lock is free; the lock is released', async () => {
		const lock = lockSpy();
		const runs = scratchRuns();
		await writeRunJournal(
			runs,
			createRunJournal({
				from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
				to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
				plan: [],
			}),
		);
		let ran = false;
		const result = await outcome(() =>
			withApplyPreconditions(
				{ apply: true, waiveBackup: false, userId: 7 },
				async () => {
					ran = true;
				},
				{ requireBackup: async () => {}, acquire: lock.acquire, runsRoot: runs },
			),
		);
		expect(result).toBe('update.refused');
		expect(ran).toBe(false);
		expect(lock.state.held).toBe(false);
	});

	test('a dry run reads no backup and takes no lock', async () => {
		const lock = lockSpy();
		const result = await outcome(() =>
			withApplyPreconditions({ apply: false, waiveBackup: false, userId: 7 }, async () => {}, {
				requireBackup: noBackup,
				acquire: lock.acquire,
				runsRoot: scratchRuns(),
			}),
		);
		expect(result).toBe('ran');
		expect(lock.state.acquired).toBe(0);
	});
});

/**
 * Review 2026-10-30 #5: the cases above drive the helper, so the CLI could skip
 * it (`return run(args)`) with them green. These drive the CLI entry the
 * import.meta.main path calls, with the run body stubbed.
 */
describe('the CLI entry routes its run through the preconditions', () => {
	const APPLY = ['--all', '--user', '7', '--apply'];

	function runSpy() {
		const calls: unknown[] = [];
		const run = async (args: unknown) => {
			calls.push(args);
			return 0;
		};
		return { calls, run };
	}

	test('an --apply with a refusing backup verdict throws before the run body is called', async () => {
		const lock = lockSpy();
		const body = runSpy();
		const result = await outcome(() =>
			cliMain(APPLY, {
				requireBackup: noBackup,
				acquire: lock.acquire,
				runsRoot: scratchRuns(),
				run: body.run,
			}),
		);
		expect(result).toBe('Error: planted: no backup');
		expect(body.calls).toHaveLength(0);
		expect(lock.state.acquired).toBe(0);
	});

	test('an --apply with a fresh backup runs the body under the lock', async () => {
		const lock = lockSpy();
		let heldInside = false;
		const code = await cliMain(APPLY, {
			requireBackup: async () => {},
			acquire: lock.acquire,
			runsRoot: scratchRuns(),
			run: async () => {
				heldInside = lock.state.held;
				return 0;
			},
		});
		expect(code).toBe(0);
		expect(heldInside).toBe(true);
		expect(lock.state.held).toBe(false);
	});

	test('a dry run calls the body with the parsed args, no backup read, no lock', async () => {
		const lock = lockSpy();
		const body = runSpy();
		const code = await cliMain(['--all', '--user', '7'], {
			requireBackup: noBackup,
			acquire: lock.acquire,
			runsRoot: scratchRuns(),
			run: body.run,
		});
		expect(code).toBe(0);
		expect(body.calls).toHaveLength(1);
		expect(body.calls[0]).toMatchObject({ apply: false, userId: 7, tables: 'all' });
		expect(lock.state.acquired).toBe(0);
	});
});
