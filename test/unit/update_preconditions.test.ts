/**
 * core/update/preconditions.ts + the update_data_version EXECUTE refactored
 * onto it (UPDATE_PROCESS Phase 0). Since the P1 error sweep the refusals are
 * TYPED THROWS (engineering/ERRORS_SPEC.md §4) of a registered code
 * (`perm.superuser_required` / `maintenance.mode_required`), so what is pinned
 * here is the CODE (the machine channel) plus the registry sentence each
 * refusal carries — the PHP sentence itself moved into the registry.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
import { dispatchWidgetRequest } from '../../src/core/area_maintenance/widgets/registry.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { setServerState } from '../../src/core/resolve/server_state.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	backupWarningsWithin,
	checkUpdatePreconditions,
	requireFreshBackup,
} from '../../src/core/update/preconditions.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

/** The DedaloError a thunk threw (fails the test when it threw nothing typed). */
function thrownBy(run: () => unknown): DedaloError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a DedaloError, nothing was thrown');
}

/** The same, for an async call. */
async function rejectedBy(run: () => Promise<unknown>): Promise<DedaloError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a DedaloError, nothing was thrown');
}

const STATE_PATH = readEnv('DEDALO_TS_STATE_PATH');
if (STATE_PATH === undefined) {
	// Scratch state file required (S1-18): these tests flip maintenance_mode.
	throw new Error(
		'update_preconditions.test.ts: DEDALO_TS_STATE_PATH is not set — refusing to run against the live server state file (S1-18)',
	);
}

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;
// Global-admin but NOT superuser: passes the dispatch admin gate, must fail
// the superuser precondition.
const PLAIN_ADMIN: Principal = { userId: 5, isGlobalAdmin: true, isDeveloper: false } as Principal;

afterAll(() => {
	setServerState({ maintenance_mode: false });
});

describe('checkUpdatePreconditions — required checks (registered refusal codes)', () => {
	test('non-superuser refused first, PHP order', () => {
		setServerState({ maintenance_mode: false }); // must not matter: superuser first
		const error = thrownBy(() => checkUpdatePreconditions(PLAIN_ADMIN));
		expect(error.code).toBe('perm.superuser_required');
		expect(error.message).toBe('Only the Dédalo superuser can perform this action');
	});

	test('superuser without maintenance mode refused', () => {
		setServerState({ maintenance_mode: false });
		const error = thrownBy(() => checkUpdatePreconditions(SUPERUSER));
		expect(error.code).toBe('maintenance.mode_required');
		expect(error.message).toBe('This action requires maintenance mode to be enabled');
	});

	test('superuser + maintenance mode passes — and asks nothing about backups', () => {
		// SYNCHRONOUS and backup-free by design (OPS-1): the backup verdict is a
		// full archive read, asked separately and only after these gates.
		setServerState({ maintenance_mode: true });
		try {
			expect(checkUpdatePreconditions(SUPERUSER)).toBeUndefined();
		} finally {
			setServerState({ maintenance_mode: false });
		}
	});
});

/**
 * The stubs below are NOT custom-format archives, so on every host they take the
 * foreign-format path: counted, never claimed as proven — the degradation that
 * keeps an install whose `*.backup` files are plain-SQL dumps working. They are
 * named `db.backup`, NOT `db.custom.backup`: that suffix is the engine's own
 * grammar, and a file under it without the archive magic is `not_an_archive`
 * (backup_freshness_deep_native leg N). The deep verdict on REAL archive bytes
 * is backup_freshness_deep_native's.
 */
function stub(dir: string, name: string, hoursOld: number): void {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, 'x');
	const at = (Date.now() - hoursOld * 3600000) / 1000;
	utimesSync(file, at, at);
}

describe('backupWarningsWithin — the data-migration WARNING (never refuses)', () => {
	const scratch = scratchDir('precond_backup');

	test('no backup dir / no *.backup files → warns, still ok', async () => {
		expect(await backupWarningsWithin(60_000, join(scratch, 'absent'))).toEqual([
			'Warning. No database backup found — make a backup before updating',
		]);
	});

	test('fresh *.backup → no warning; non-backup files ignored', async () => {
		const dir = join(scratch, 'fresh');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'note.txt'), 'not a backup');
		// AGED PAST THE IN-PROGRESS WINDOW, deliberately: on a host that cannot
		// verify a stub the engine falls back to "might a dump still be writing
		// this?", and a file whose mtime is THIS INSTANT is exactly that question.
		stub(dir, 'db.backup', 10 / 60);
		expect(await backupWarningsWithin(60_000, dir)).toEqual([]);
	});

	test('stale *.backup (older than the throttle window) → hours-old warning', async () => {
		const dir = join(scratch, 'stale');
		stub(dir, 'db.backup', 10);
		expect(await backupWarningsWithin(60_000, dir)).toEqual([
			'Warning. Newest database backup is about 10 hours old — make a fresh backup before updating',
		]);
	});

	test('a backup check that FAILS (pg_restore cannot be spawned) is a warning, never a refusal', async () => {
		// A real custom-format header, so the verdict must READ it — through a
		// pg_restore that does not exist: the scan itself rejects (spawn ENOENT).
		// The data migration must still run: its caller gets a warning, not a throw.
		const dir = join(scratch, 'unreadable');
		mkdirSync(dir, { recursive: true });
		const file = join(dir, 'db.custom.backup');
		writeFileSync(file, 'PGDMP\u0001\u000e\u0000 not a whole archive');
		const at = (Date.now() - 3600000) / 1000;
		utimesSync(file, at, at);
		const missingBin = join(scratch, 'no_such_pg_restore');
		let warnings: string[] | undefined;
		let thrown: unknown;
		try {
			warnings = await backupWarningsWithin(60_000, dir, { pgRestoreBin: missingBin });
		} catch (error) {
			thrown = error;
		}
		expect(thrown, 'the backup check threw — the migration would be refused').toBeUndefined();
		expect(warnings).toEqual([
			'Warning. The database backup could not be checked (see the server log) — make sure a restorable backup exists before updating',
		]);
	});
});

describe('requireFreshBackup — the code-update REFUSAL', () => {
	const scratch = scratchDir('precond_require');

	test('no backup → update.refused (never a warning), naming the waiver', async () => {
		const error = await rejectedBy(() => requireFreshBackup(join(scratch, 'absent')));
		expect(error.code).toBe('update.refused');
		expect(error.publicMessage).toContain('No database backup found');
		expect(error.publicMessage).toContain('waive_backup');
	});

	test('stale backup (older than the throttle window) → update.refused', async () => {
		const dir = join(scratch, 'stale');
		stub(dir, 'db.backup', 10);
		const error = await rejectedBy(() => requireFreshBackup(dir));
		expect(error.code).toBe('update.refused');
		expect(error.publicMessage).toContain('hours old');
	});

	test('fresh backup passes', async () => {
		// THE REFUSAL MODE IS WHY THE AGEING MATTERS — here a wrong answer does not
		// warn, it BLOCKS the update.
		const dir = join(scratch, 'fresh');
		stub(dir, 'db.backup', 10 / 60);
		expect(await requireFreshBackup(dir)).toBeUndefined();
	});

	test('the WARN path is untouched: same findings stay warnings', async () => {
		// update_data_version's responses are byte-frozen — the require mode must
		// not have changed a single warn byte.
		expect(await backupWarningsWithin(60_000, join(scratch, 'absent'))).toEqual([
			'Warning. No database backup found — make a backup before updating',
		]);
	});
});

describe('update_data_version EXECUTE through the widget dispatch (typed refusals)', () => {
	function run(principal: Principal) {
		return dispatchWidgetRequest(
			principal,
			{ model: 'update_data_version', action: 'update_data_version' },
			{},
		) as unknown as Promise<Record<string, unknown>>;
	}

	test('non-superuser admin → the superuser refusal', async () => {
		const error = await rejectedBy(() => run(PLAIN_ADMIN));
		expect(error.code).toBe('perm.superuser_required');
		expect(error.message).toBe('Only the Dédalo superuser can perform this action');
	});

	test('superuser, maintenance off → the maintenance-mode refusal', async () => {
		setServerState({ maintenance_mode: false });
		const error = await rejectedBy(() => run(SUPERUSER));
		expect(error.code).toBe('maintenance.mode_required');
		expect(error.message).toBe('This action requires maintenance mode to be enabled');
	});

	test('the frozen whenClosed branch keeps the bespoke engine_denied bytes', async () => {
		// 2026-07-11 cutover: the LIVE gate is collapsed to true, so dispatch
		// runs the OPEN branch (the TS migration engine — update_engine.test.ts).
		// The closed branch survives byte-frozen on the gated mark; pin it there.
		const { widget } = await import(
			'../../src/core/area_maintenance/widgets/update_data_version.ts'
		);
		const { ownershipMark } = await import('../../src/core/area_maintenance/widgets/support.ts');
		const handler = widget.apiActions?.update_data_version;
		expect(handler).toBeDefined();
		const whenClosed = ownershipMark(handler as NonNullable<typeof handler>)?.whenClosed;
		expect(whenClosed).toBeDefined();
		setServerState({ maintenance_mode: true });
		try {
			const error = await rejectedBy(() =>
				(whenClosed as NonNullable<typeof whenClosed>)({}, SUPERUSER),
			);
			expect(error.code).toBe('maintenance.widget_unavailable');
			expect(error.publicMessage).toBe(
				"Error. 'update_data_version.update_data_version' is not runnable on this engine: the migration catalog (updates.php) belongs to the PHP install. Run it from the PHP maintenance dashboard.",
			);
		} finally {
			setServerState({ maintenance_mode: false });
		}
	});
});

/**
 * THE MAINTENANCE-MODE CARVE-OUT IS A CENSUS, not a convention.
 *
 * `maintenance: false` was added for ONE caller (deleteRestorePoint: removing a
 * backup directory never touches the live tree, and an install that ran out of
 * disk must not have to close itself to the public before it may reclaim it).
 * Nothing stopped the next caller from reaching for it — the tests above only
 * assert the DEFAULT path refuses, so a code swap or a tree restore could
 * acquire the flag and run on an install open to the public with every gate
 * green (review finding 2026-08-28, tripwire-integrity).
 *
 * SHRINK-ONLY: an entry may be removed (by deleting the bypass), never added
 * without moving this list and saying why. Same shape as the exact-file
 * allowlists config_env_tripwire uses.
 */
describe('who may skip the maintenance gate', () => {
	/** file → the ONE function that may pass the flag, and the reason it may. */
	const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
		'src/core/update/code_restore.ts':
			'deleteRestorePoint — removes a BACKUP directory; touches no live tree, serves no request differently',
	});

	test('only the registered callers pass `maintenance: false`', async () => {
		const { readdirSync, readFileSync, statSync } = await import('node:fs');
		const { join, relative, resolve } = await import('node:path');
		const SRC = resolve(import.meta.dir, '../../src');
		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.endsWith('.ts')) continue;
				// CODE, never prose: preconditions.ts DOCUMENTS the option in its
				// own header, and a census that counts the definition as a caller
				// can never be satisfied. Strip comments, then look for the
				// option as an OBJECT KEY in any whitespace/ordering shape.
				const code = readFileSync(full, 'utf8')
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
				if (/maintenance\s*:\s*false/.test(code)) {
					found.push(relative(resolve(import.meta.dir, '../..'), full));
				}
			}
		};
		walk(SRC);
		expect(
			found.sort(),
			'a NEW caller may not bypass maintenance mode silently — add it to ALLOWED with its reason, or do not pass the flag',
		).toEqual(Object.keys(ALLOWED).sort());
	});

	test('every allowlist entry is still real (shrink-only, no stale entries)', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		for (const [file, reason] of Object.entries(ALLOWED)) {
			const source = readFileSync(resolve(import.meta.dir, '../..', file), 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
			expect(/maintenance\s*:\s*false/.test(source), `${file} no longer bypasses — drop it`).toBe(
				true,
			);
			// the reason names the function, so a reader can find it
			const fn = String(reason).split(' ')[0] as string;
			expect(source).toContain(fn);
		}
	});
});
