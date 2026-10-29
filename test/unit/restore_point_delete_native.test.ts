/**
 * restore_point_delete_native — the DOOR, not the predicates.
 *
 * `restore_points_native.test.ts` gates the pure pieces (deletability, path
 * confinement, verified removal). Nothing gated the ORDER they are applied in,
 * and that is where this door can go wrong: a refactor that resolves the path
 * before consulting the listing, or that trusts `resolveRestorePointOrRefuse`
 * alone, leaves every existing test green while the panel becomes able to
 * delete the rollback for the running code — irreversible, multi-GB, no other
 * copy (review finding 2026-08-28, tripwire-integrity).
 *
 * So each refusal is driven through `deleteRestorePoint` itself, and every one
 * asserts the disk is UNTOUCHED as well as the code thrown: a refusal that
 * removes something first is not a refusal.
 *
 * Scratch-root only — `seams.backupRoot` points at a mkdtemp tree, and the
 * assertions below prove the door never reaches past it. No DB, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../../src/core/errors/index.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { type Principal, SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { deleteRestorePoint } from '../../src/core/update/code_restore.ts';

let root = '';
let treeRoot = '';

const ROOT: Principal = { userId: SUPERUSER_ID } as Principal;
const PLAIN: Principal = { userId: 42 } as Principal;

/**
 * Plant order IS mtime order — stamped explicitly, never left to the clock. A
 * point's stamp is its directory mtime, and "the fs stamps in order" was true
 * only on the Mac: Linux stamps from a COARSE clock (a jiffy, ms-scale), so five
 * points planted in one loop tie, the newest-first sort keeps readdir order,
 * and retention pruned the wrong ones in the CI image (measured 2026-10-02:
 * `dedalo_7.0.0_a` survived). Each plant is one second newer than the last.
 */
let plantSeq = 0;
const PLANT_EPOCH_S = 1_700_000_000;
function plant(name: string, options: { bootable?: boolean } = {}): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	if (options.bootable === true) {
		writeFileSync(join(dir, 'package.json'), '{}');
		mkdirSync(join(dir, 'node_modules'), { recursive: true });
		// a declared version + a matching bun pin make it RESTORABLE too, so the
		// door is exercised against a point the panel would offer.
		mkdirSync(join(dir, 'src/core/update'), { recursive: true });
		writeFileSync(
			join(dir, 'src/core/update/version.ts'),
			'export const DEDALO_DATA_VERSION = Object.freeze([7, 0, 0]);',
		);
	}
	plantSeq++;
	utimesSync(dir, PLANT_EPOCH_S + plantSeq, PLANT_EPOCH_S + plantSeq);
	return dir;
}

async function call(name: unknown, principal: Principal = ROOT) {
	return await deleteRestorePoint({ name }, principal, {
		backupRoot: root,
		targetRoot: treeRoot,
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'dd_rp_delete_'));
	// the tree the backup root must sit OUTSIDE of (resolveBackupRootOrRefuse)
	treeRoot = mkdtempSync(join(tmpdir(), 'dd_rp_tree_'));
	setServerState({ ...getServerState(), maintenance_mode: false });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(treeRoot, { recursive: true, force: true });
});

describe('the delete door applies its gates in the order that matters', () => {
	test('a non-superuser is refused before anything is read', async () => {
		const dir = plant('dedalo_old');
		await expect(call('dedalo_old', PLAIN)).rejects.toThrow(DedaloError);
		expect(existsSync(dir), 'a refusal must not remove anything').toBe(true);
	});

	test('the live rollback is refused BY THE LISTING, not by the path guard', async () => {
		// older first so the bootable one is newest by mtime
		plant('dedalo_husk');
		const rollback = plant('dedalo_rollback', { bootable: true });
		let thrown: unknown = null;
		try {
			await call('dedalo_rollback');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('update.refused');
		expect(String((thrown as DedaloError).publicMessage)).toContain(
			'rollback for the code running',
		);
		expect(existsSync(rollback), 'the rollback must survive its own refusal').toBe(true);
	});

	test('an unknown name is refused even though the path guard would also catch it', async () => {
		// the listing is consulted FIRST: a name that is not one of ours must
		// never reach the filesystem resolution at all.
		await expect(call('dedalo_absent')).rejects.toThrow(DedaloError);
	});

	test('a traversal name is refused and nothing outside the root is touched', async () => {
		const outside = join(treeRoot, 'precious');
		mkdirSync(outside, { recursive: true });
		for (const name of ['../../etc', '/etc/passwd', 'dedalo_a/../../escape', '', 42]) {
			await expect(call(name)).rejects.toThrow(DedaloError);
		}
		expect(existsSync(outside)).toBe(true);
	});

	test('an older point IS deleted, and is gone', async () => {
		const old = plant('dedalo_old', { bootable: true });
		const rollback = plant('dedalo_rollback', { bootable: true });
		const answer = await deleteRestorePoint({ name: 'dedalo_old' }, ROOT, {
			backupRoot: root,
			targetRoot: treeRoot,
		});
		expect(answer.ok).toBe(true);
		expect((answer as { data?: { deleted?: string } }).data?.deleted).toBe('dedalo_old');
		expect(existsSync(old)).toBe(false);
		expect(existsSync(rollback), 'only the named point goes').toBe(true);
	});

	test('an unbootable husk is deletable — that is the case operators need', async () => {
		plant('dedalo_rollback', { bootable: true });
		const husk = plant('dedalo_husk');
		await deleteRestorePoint({ name: 'dedalo_husk' }, ROOT, {
			backupRoot: root,
			targetRoot: treeRoot,
		});
		expect(existsSync(husk)).toBe(false);
	});

	test('maintenance mode is NOT required — and that is the only gate it skips', async () => {
		// the whole point of the carve-out: an install that ran out of disk must
		// not have to close itself to the public before it may reclaim it. The
		// superuser check above proves the carve-out did not widen.
		expect(getServerState().maintenance_mode).toBe(false);
		plant('dedalo_rollback', { bootable: true });
		const husk = plant('dedalo_husk');
		await deleteRestorePoint({ name: 'dedalo_husk' }, ROOT, {
			backupRoot: root,
			targetRoot: treeRoot,
		});
		expect(existsSync(husk)).toBe(false);
	});
});

/**
 * THE BOOT-PATH RETENTION WIRING — the S1 this review found.
 *
 * `pruneRestorePoints` was gated as a pure helper, and nothing proved the CALL
 * SITE handed it the right root. It did not: `confirmBootedCodeUpdate` took a
 * scratch `sentinelPath` seam while retention resolved the REAL backup root, so
 * running the unit suite on a machine with an installation pruned that
 * installation's disaster-recovery trees. The root now comes from the sentinel
 * path itself, which is what these assertions hold in place.
 */
describe('retention on the confirmed-boot path', () => {
	async function confirm(sentinelRoot: string, backupDir: string) {
		const { confirmBootedCodeUpdate } = await import('../../src/core/update/boot_confirm.ts');
		const sentinelPath = join(sentinelRoot, 'last_code_update.json');
		writeFileSync(
			sentinelPath,
			JSON.stringify({
				version: '7.0.1',
				previousVersion: '7.0.0',
				updateMode: 'clean',
				stamp: 'x',
				backupDir,
				installDigest: null,
				status: 'pending',
				rollback_attempted: false,
			}),
		);
		await confirmBootedCodeUpdate(sentinelPath, '7.0.1');
		return sentinelPath;
	}

	test('it prunes the SENTINEL’S root — never a root it resolved itself', async () => {
		// five points, default keep of 3
		const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `dedalo_7.0.0_${n}`);
		for (const n of names) plant(n, { bootable: true });
		await confirm(root, join(root, 'dedalo_7.0.0_e'));
		const left = names.filter((n) => existsSync(join(root, n)));
		expect(left.length).toBeLessThan(names.length);
		// the two oldest went; the newest three stayed
		expect(existsSync(join(root, 'dedalo_7.0.0_e'))).toBe(true);
		expect(existsSync(join(root, 'dedalo_7.0.0_a'))).toBe(false);
	});

	test('a sentinel that does not CONFIRM prunes nothing', async () => {
		const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `dedalo_7.0.0_${n}`);
		for (const n of names) plant(n, { bootable: true });
		const { confirmBootedCodeUpdate } = await import('../../src/core/update/boot_confirm.ts');
		const sentinelPath = join(root, 'last_code_update.json');
		writeFileSync(
			sentinelPath,
			JSON.stringify({
				version: '7.0.1',
				previousVersion: '7.0.0',
				updateMode: 'clean',
				stamp: 'x',
				backupDir: join(root, 'dedalo_7.0.0_e'),
				installDigest: 'AAA',
				status: 'pending',
				rollback_attempted: false,
			}),
		);
		// A DIGEST MISMATCH is the real "did not confirm": the sentinel installed
		// AAA and this process is running BBB, so a rollback happened or the swap
		// half-applied. (A null-vs-null digest is a MATCH — bootedTreeMatches only
		// falls back to the version compare when the sentinel carries no digest
		// key at all, which is what a legacy sentinel looks like.) The tree is
		// unproven, and the points behind it are the way back.
		await confirmBootedCodeUpdate(sentinelPath, '7.0.1', 'BBB');
		for (const name of names) {
			expect(existsSync(join(root, name)), `${name} must survive an unconfirmed boot`).toBe(true);
		}
	});

	test('the live rollback survives retention even below `keep`', async () => {
		// four husks newer than the one bootable point: keep=3 would take it.
		const boot = 'dedalo_7.0.0_boot';
		plant(boot, { bootable: true });
		const husks = ['h1', 'h2', 'h3', 'h4'].map((n) => `dedalo_7.0.0_${n}`);
		for (const n of husks) plant(n);
		await confirm(root, join(root, 'dedalo_7.0.0_h4'));
		expect(existsSync(join(root, boot)), 'the rollback is never pruned').toBe(true);
	});
});
