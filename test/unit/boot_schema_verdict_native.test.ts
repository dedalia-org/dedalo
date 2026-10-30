/**
 * BOOT SCHEMA VERDICT + DATA VERSION GATE (update audit 2026-10-29, U-01 / U-04 /
 * U-19 / U-37) — Phase 0 of audits/2026-10-29_update/DESIGN.md.
 *
 * What used to happen: a failed boot migration run was one journal line; /health
 * stayed green; boot_confirm flipped the update sentinel to `confirmed` and pruned
 * the restore points — every rollback disarmed while the panel said "updated".
 * And nothing compared the installed data version with the code's.
 *
 * The contract proven here, end to end on the real doors (no source-text pins):
 *  1. runBootSchema RETURNS a verdict, including whether the failed run had
 *     already moved the schema;
 *  2. a failed verdict is NEVER confirmed: schema untouched → stays `pending`
 *     (the watchdog's rollback acts on the red /health); schema moved →
 *     `needs_restore` (owner rule D-2: no automatic rollback across a moved
 *     schema); a good verdict confirms as before;
 *  3. /health goes red on a failed run and on a database NEWER than the code,
 *     and reports — without going red — a database BEHIND the code;
 *  4. the code-update door refuses while the data version does not match;
 *  5. the sentinel writes are atomic, and the rollback script's rewrite keeps
 *     every key it does not own (the waiver trace).
 *
 * DB: runBootSchema's heal step runs against the suite database (idempotent DDL),
 * after assertTestDatabase.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BootSchemaVerdict, runBootSchema } from '../../install/db/migrate.ts';
import { buildHealthPayload } from '../../src/core/api/health_payload.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { writeTextFileDurablyAsync as writeFileAtomic } from '../../src/core/files/durable_async.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	confirmBootedCodeUpdate,
	markFailedBootSchema,
} from '../../src/core/update/boot_confirm.ts';
import { classifyDataVersion } from '../../src/core/update/boot_state.ts';
import { requireDataVersionCurrent } from '../../src/core/update/preconditions.ts';

const ROLLBACK_SCRIPT = join(import.meta.dir, '..', '..', 'deploy', 'dedalo-code-rollback.sh');
const DIGEST = 'a'.repeat(64);

beforeAll(async () => {
	await assertTestDatabase('boot_schema_verdict_native');
});

/** Every scratch root this file creates — swept after the run. */
const tempRoots: string[] = [];
function scratchRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}
afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** A scratch backup root holding a pending sentinel for a tree with DIGEST. */
function pendingSentinel(extra: Record<string, unknown> = {}): string {
	const root = scratchRoot('boot_verdict_');
	const path = join(root, 'last_code_update.json');
	writeFileSync(
		path,
		JSON.stringify(
			{
				version: '7.0.1',
				previousVersion: '7.0.0',
				updateMode: 'clean',
				stamp: '2026-10-29T00-00-00',
				backupDir: join(root, 'dedalo_7.0.0_stamp'),
				installDigest: DIGEST,
				status: 'pending',
				rollback_attempted: false,
				...extra,
			},
			null,
			'\t',
		),
	);
	return path;
}

function statusOf(path: string): string {
	return (JSON.parse(readFileSync(path, 'utf8')) as { status: string }).status;
}

function failed(schemaMoved: boolean | null): BootSchemaVerdict {
	return {
		state: 'failed',
		applied: schemaMoved ? ['0015_x.sql'] : [],
		deferred: [],
		schemaMoved,
		error: 'boom',
	};
}

describe('runBootSchema returns its verdict', () => {
	test('a run that throws AFTER applying a file: failed, schema moved, the applied file named', async () => {
		let census = ['0015_a.sql', '0016_b.sql'];
		const verdict = await runBootSchema({
			pending: async () => ({ pending: census }),
			migrate: async () => {
				census = ['0016_b.sql']; // 0015 landed, 0016 failed
				throw new Error('0016: constraint violated (simulated)');
			},
		});
		expect(verdict.state).toBe('failed');
		expect(verdict.schemaMoved).toBe(true);
		expect(verdict.applied).toEqual(['0015_a.sql']);
		expect(verdict.error).toContain('0016');
	});

	test('a run that throws before applying anything: failed, schema NOT moved', async () => {
		const verdict = await runBootSchema({
			pending: async () => ({ pending: ['0015_a.sql'] }),
			migrate: async () => {
				throw new Error('lock wait timed out (simulated)');
			},
		});
		expect(verdict).toMatchObject({ state: 'failed', schemaMoved: false, applied: [] });
	});

	test('an unreadable census: failed, schemaMoved unknown (null) — never guessed', async () => {
		const verdict = await runBootSchema({
			pending: async () => {
				throw new Error('census down');
			},
			migrate: async () => {
				throw new Error('db down');
			},
		});
		expect(verdict).toMatchObject({ state: 'failed', schemaMoved: null });
	});

	test('a good run: ok, its applied files reported', async () => {
		const verdict = await runBootSchema({
			pending: async () => ({ pending: [] }),
			migrate: async () => ({ applied: ['0015_a.sql'], skipped: 14, deferred: [] }),
		});
		expect(verdict).toEqual({
			state: 'ok',
			applied: ['0015_a.sql'],
			deferred: [],
			schemaMoved: true,
			error: null,
		});
	});
});

describe('boot confirmation follows the verdict', () => {
	test('failed, schema untouched → NOT confirmed, stays pending (the watchdog rolls back)', async () => {
		const path = pendingSentinel();
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, failed(false));
		expect(statusOf(path)).toBe('pending');
	});

	test('failed, schema moved → needs_restore (no automatic rollback, D-2)', async () => {
		const path = pendingSentinel();
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, failed(true));
		expect(statusOf(path)).toBe('needs_restore');
	});

	test('failed, schema unknown → needs_restore (unknown is read as moved, never as untouched)', async () => {
		const path = pendingSentinel();
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, failed(null));
		expect(statusOf(path)).toBe('needs_restore');
	});

	test('PRE-LISTEN: markFailedBootSchema writes needs_restore before any confirm, without a DB', async () => {
		const moved = pendingSentinel();
		await markFailedBootSchema(failed(true), moved, '7.0.1', DIGEST);
		expect(statusOf(moved)).toBe('needs_restore');
		// untouched schema: stays pending for the watchdog's rollback
		const untouched = pendingSentinel();
		await markFailedBootSchema(failed(false), untouched, '7.0.1', DIGEST);
		expect(statusOf(untouched)).toBe('pending');
		// another tree's sentinel (a rollback happened) is never touched
		const foreign = pendingSentinel();
		await markFailedBootSchema(failed(true), foreign, '7.0.1', 'other-digest');
		expect(statusOf(foreign)).toBe('pending');
		// an ok verdict marks nothing
		const fine = pendingSentinel();
		await markFailedBootSchema(
			{ ...failed(false), state: 'ok', error: null },
			fine,
			'7.0.1',
			DIGEST,
		);
		expect(statusOf(fine)).toBe('pending');
	});

	test('needs_restore is confirmed by a later OK boot of the same tree (a human fixed forward), never by a failed one', async () => {
		const path = pendingSentinel({ status: 'needs_restore' });
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, failed(true));
		expect(statusOf(path)).toBe('needs_restore');
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, null);
		expect(statusOf(path)).toBe('needs_restore');
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, {
			state: 'ok',
			applied: [],
			deferred: [],
			schemaMoved: false,
			error: null,
		});
		expect(statusOf(path)).toBe('confirmed');
	});

	test('the post-confirm hook never runs for a refused confirmation', async () => {
		const path = pendingSentinel();
		let ran = false;
		await confirmBootedCodeUpdate(
			path,
			'7.0.1',
			DIGEST,
			() => {
				ran = true;
			},
			failed(true),
		);
		expect(ran).toBe(false);
	});

	test('anti-vacuity: an ok verdict still confirms, atomically (no temp file left behind)', async () => {
		const path = pendingSentinel({ backup_waived: true });
		const ok: BootSchemaVerdict = {
			state: 'ok',
			applied: [],
			deferred: [],
			schemaMoved: false,
			error: null,
		};
		await confirmBootedCodeUpdate(path, '7.0.1', DIGEST, null, ok);
		const sentinel = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		expect(sentinel.status).toBe('confirmed');
		expect(sentinel.backup_waived).toBe(true);
		const root = join(path, '..');
		expect(readdirSync(root)).toEqual(['last_code_update.json']);
	});
});

describe('/health carries the boot facts', () => {
	const BASE = { dbOk: true, entity: 'e', installDigest: null, requestId: 'r' };
	const code = [7, 0, 0];

	test('a failed migration run is red', () => {
		const payload = buildHealthPayload({ ...BASE, bootSchema: 'failed' });
		expect(payload.result).toBe('error');
		expect(payload.boot_schema).toBe('failed');
	});

	test('a database NEWER than the code is red', () => {
		const payload = buildHealthPayload({
			...BASE,
			dataVersion: classifyDataVersion([7, 1, 0], code),
		});
		expect(payload.result).toBe('error');
		expect(payload.data_version?.state).toBe('ahead');
	});

	test('a database BEHIND the code is reported, not red (an Update data is due)', () => {
		const payload = buildHealthPayload({
			...BASE,
			bootSchema: 'ok',
			dataVersion: classifyDataVersion([6, 9, 0], code),
		});
		expect(payload.result).toBe('ok');
		expect(payload.data_version).toEqual({ state: 'pending', installed: '6.9.0', code: '7.0.0' });
	});

	test('anti-vacuity: all good is ok', () => {
		const payload = buildHealthPayload({
			...BASE,
			bootSchema: 'ok',
			dataVersion: classifyDataVersion(code, code),
		});
		expect(payload.result).toBe('ok');
	});
});

describe('the code-update door refuses a data version that does not match the code', () => {
	async function refusal(read: () => Promise<number[]>): Promise<string | null> {
		try {
			await requireDataVersionCurrent(read, [7, 0, 0]);
			return null;
		} catch (error) {
			return isDedaloError(error) ? `${error.code}:${String(error.coordinates?.rule)}` : 'untyped';
		}
	}

	test('pending, ahead, missing row and unreadable all refuse — typed, with the reason', async () => {
		expect(await refusal(async () => [6, 9, 0])).toBe('update.refused:data_version_pending');
		expect(await refusal(async () => [7, 1, 0])).toBe('update.refused:data_version_ahead');
		expect(await refusal(async () => [])).toBe('update.refused:data_version_unknown');
		expect(
			await refusal(async () => {
				throw new Error('db down');
			}),
		).toBe('update.refused:data_version_unknown');
	});

	test('anti-vacuity: a matching data version passes', async () => {
		expect(await refusal(async () => [7, 0, 0])).toBeNull();
	});
});

describe('sentinel writes are atomic and keep what they do not own', () => {
	test('writeFileAtomic replaces the bytes and leaves no temp file; a failed write leaves the target untouched', async () => {
		const root = scratchRoot('atomic_');
		const path = join(root, 'f.json');
		writeFileSync(path, 'old');
		await writeFileAtomic(path, 'new');
		expect(readFileSync(path, 'utf8')).toBe('new');
		expect(readdirSync(root)).toEqual(['f.json']);
		// a target whose directory vanished: the write rejects, nothing is created
		const gone = join(root, 'missing', 'f.json');
		await expect(writeFileAtomic(gone, 'x')).rejects.toThrow();
		expect(existsSync(gone)).toBe(false);
	});

	test('the rollback script keeps backup_waived and every unknown key across its rewrite', () => {
		const root = scratchRoot('rollback_keys_');
		const appDir = join(root, 'master_dedalo');
		const backupRoot = join(root, 'backups');
		mkdirSync(join(appDir, 'src'), { recursive: true });
		writeFileSync(join(appDir, 'src', 'server.ts'), '// live tree');
		mkdirSync(backupRoot, { recursive: true });
		// state 2: the crash landed before the first rename — backupDir never created
		writeFileSync(
			join(backupRoot, 'last_code_update.json'),
			JSON.stringify(
				{
					version: '7.0.1',
					previousVersion: '7.0.0',
					updateMode: 'clean',
					stamp: 's',
					backupDir: join(backupRoot, 'dedalo_7.0.0_s'),
					installDigest: DIGEST,
					status: 'pending',
					rollback_attempted: false,
					backup_waived: true,
					future_key: 'kept',
				},
				null,
				'\t',
			),
		);
		const run = spawnSync(
			'bash',
			[ROLLBACK_SCRIPT, '--no-restart', '--app-dir', appDir, '--backup-root', backupRoot],
			{ encoding: 'utf8' },
		);
		expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
		const sentinel = JSON.parse(readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'));
		expect(sentinel.rollback_attempted).toBe(true);
		expect(sentinel.backup_waived).toBe(true);
		expect(sentinel.future_key).toBe('kept');
		expect(sentinel.installDigest).toBe(DIGEST);
		expect(readdirSync(backupRoot)).toEqual(['last_code_update.json']);
		// macOS `sync` takes no path: the script's fallback flushes the whole
		// system, which can take seconds on a busy disk
	}, 60000);

	test('a torn (status-less) sentinel is RED for the rollback script, never "nothing to do"', () => {
		const root = scratchRoot('rollback_torn_');
		const appDir = join(root, 'master_dedalo');
		mkdirSync(appDir, { recursive: true });
		writeFileSync(join(root, 'last_code_update.json'), '');
		const run = spawnSync(
			'bash',
			[ROLLBACK_SCRIPT, '--no-restart', '--app-dir', appDir, '--backup-root', root],
			{ encoding: 'utf8' },
		);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('torn');
	});
});
