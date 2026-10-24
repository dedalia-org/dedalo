/**
 * Code RESTORE (code_restore.ts) — the update run in reverse, driven seam-first
 * against a TEMP tree (never projectRoot: the live swap is an operator drill).
 *
 * What this gate exists to hold, in the order a restore can hurt:
 *  - the client names a RESTORE POINT, never a path — an unknown name, a
 *    traversal name and a name outside the `dedalo_` grammar all refuse before
 *    anything is joined or moved;
 *  - a point that cannot boot (no package.json / no node_modules) is refused,
 *    because restoring it would leave the installation unable to start;
 *  - the DATABASE HAZARD is confirmed, not assumed: a point declaring another
 *    version refuses without `confirm_downgrade` and proceeds with it;
 *  - a failed SECOND rename leaves the live tree BYTE-IDENTICAL (the two
 *    renames are individually atomic, the pair is not);
 *  - the pending sentinel is on disk BEFORE the first rename and carries the
 *    RESTORE POINT's OWN installDigest — a sentinel naming the digest of the
 *    tree we move AWAY would make every restore look like a half-applied swap
 *    to boot_confirm.ts and scream in the log forever;
 *  - the outgoing tree lands as a NEW restore point (a restore is undoable);
 *  - the run lock is the UPDATE's lock, so a restore and an update can never
 *    interleave over one tree.
 *
 * No network, no DB, no zip CLI: a restore point is a directory this file
 * builds, so unlike the update suite every case here is unconditionally LIVE.
 *
 * `restoreCode` runs the full precondition gate (superuser + maintenance mode),
 * so the suite flips maintenance mode on a SCRATCH state file (S1-18 guard
 * below) exactly as test/unit/code_update.test.ts does.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
import { setServerState } from '../../src/core/resolve/server_state.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	bunPinOf,
	type CodeRestoreSeams,
	declaredVersionOf,
	honoursSmokeBoot,
	restorabilityOf,
	restoreCode,
	restorePointIsBootable,
} from '../../src/core/update/code_restore.ts';
import {
	acquireRunLockOrRefuse,
	codeRunLockPath,
	codeStagingDir,
	STAGING_KEEP_MARKER,
	type UpdatePhaseFrame,
} from '../../src/core/update/code_update.ts';
import { INSTALL_STAMP_PATH } from '../../src/core/update/install_stamp.ts';
import { DEDALO_VERSION_TRIPLE } from '../../src/core/update/version.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const STATE_PATH = readEnv('DEDALO_TS_STATE_PATH');
if (STATE_PATH === undefined) {
	// Scratch state file required (S1-18): this suite flips maintenance_mode.
	throw new Error(
		'update_restore_native.test.ts: DEDALO_TS_STATE_PATH is not set — refusing to run against the live server state file (S1-18)',
	);
}

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;
const RUNNING = DEDALO_VERSION_TRIPLE.join('.');

const ROOT = scratchDir('code_restore');

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });
	setServerState({ maintenance_mode: true });
});
afterAll(() => {
	setServerState({ maintenance_mode: false });
	rmSync(ROOT, { recursive: true, force: true });
});

/** Default seams: a temp tree, no restart, the swap-blessed channel. */
function restoreSeams(overrides: Partial<CodeRestoreSeams> = {}): CodeRestoreSeams {
	return {
		restart: () => {},
		supervised: true,
		smokeBoot: async () => {},
		channel: 'tree_swap',
		...overrides,
	};
}

/** The LIVE tree a restore renames aside — stamped like a real install. */
function buildLiveTree(targetRoot: string, digest: string): void {
	writeTree(targetRoot, RUNNING, digest);
	writeFileSync(join(targetRoot, 'src', 'live_only.ts'), '// only in the live tree');
}

/**
 * A restore point as the swap leaves one: package.json + node_modules (the
 * bootability contract the rollback script leans on), its own version.ts and
 * its own install stamp.
 */
function buildRestorePoint(
	backupRoot: string,
	name: string,
	version: string,
	digest: string | null,
	options: { bootable?: boolean } = {},
): string {
	const dir = join(backupRoot, name);
	writeTree(dir, version, digest);
	if (options.bootable === false) rmSync(join(dir, 'node_modules'), { recursive: true });
	return dir;
}

/**
 * The shared tree shape: the markers a restore reads and one payload file.
 *
 * `src/server.ts` and `.bun-version` are not decoration — they are two of the
 * gates. The pre-flight boot only runs against a tree that provably honours
 * DEDALO_SMOKE_BOOT, and a pin other than the running Bun blocks the point
 * outright, so a tree built here has to look like one cut by a current engine.
 */
function writeTree(dir: string, version: string, digest: string | null): void {
	const [major, minor, patch] = version.split('.');
	mkdirSync(join(dir, 'src', 'core', 'update'), { recursive: true });
	mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
	writeFileSync(join(dir, 'package.json'), `{"name":"dedalo","version":"${version}"}`);
	writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '// dep');
	writeFileSync(join(dir, '.bun-version'), `${Bun.version}\n`);
	writeFileSync(
		join(dir, 'src', 'server.ts'),
		"const smokeBoot = readEnv('DEDALO_SMOKE_BOOT') === 'true';\n",
	);
	writeFileSync(
		join(dir, 'src', 'core', 'update', 'version.ts'),
		`export const DEDALO_VERSION_TRIPLE = Object.freeze([${major}, ${minor}, ${patch}]);\n`,
	);
	if (digest !== null) {
		writeFileSync(
			join(dir, INSTALL_STAMP_PATH),
			JSON.stringify({ digest, channel: 'master', installed_at: new Date().toISOString() }),
		);
	}
}

/** Recursive content digest of a tree — the "byte-identical" assertion. */
function treeDigest(dir: string): string {
	const hash = createHash('sha256');
	const walk = (d: string): void => {
		for (const name of readdirSync(d).sort()) {
			const full = join(d, name);
			hash.update(name);
			if (lstatSync(full).isDirectory()) walk(full);
			else hash.update(readFileSync(full));
		}
	};
	walk(dir);
	return hash.digest('hex');
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** One scratch case dir per test — the pipeline writes into both roots. */
function caseDirs(name: string): { targetRoot: string; backupRoot: string } {
	const base = join(ROOT, name);
	return { targetRoot: join(base, 'live'), backupRoot: join(base, 'backups') };
}

describe('restorabilityOf — the ONE predicate the panel and the pipeline share', () => {
	test('a bootable, version-declaring, pin-matching point is restorable; the three blockers name themselves', () => {
		expect(restorabilityOf({ bootable: true, version: '7.0.0', bun_pin: Bun.version })).toEqual({
			restorable: true,
			reason: null,
		});
		expect(restorabilityOf({ bootable: false, version: '7.0.0', bun_pin: null })).toEqual({
			restorable: false,
			reason: 'not_bootable',
		});
		expect(restorabilityOf({ bootable: true, version: null, bun_pin: null })).toEqual({
			restorable: false,
			reason: 'unknown_version',
		});
		// The swap hands the tree to the RUNNING bun and the smoke boot spawns
		// process.execPath, so a foreign pin can pass pre-flight and then be
		// started on a runtime its node_modules was never built for. The update
		// refuses the same case outright (code_update.ts prepareQuarantine).
		expect(restorabilityOf({ bootable: true, version: '7.0.0', bun_pin: '0.0.1' })).toEqual({
			restorable: false,
			reason: 'bun_pin_mismatch',
		});
		// NO pin is not a mismatch: a tree that pins nothing runs anywhere.
		expect(restorabilityOf({ bootable: true, version: '7.0.0', bun_pin: null }).restorable).toBe(
			true,
		);
		// A version MISMATCH is deliberately restorable — it is the waivable
		// hazard the confirmation exists for, not a blocker.
		expect(
			restorabilityOf({ bootable: true, version: '6.9.9', bun_pin: Bun.version }).restorable,
		).toBe(true);
	});

	test('the facts are read from the point itself', () => {
		const { backupRoot } = caseDirs('facts');
		const good = buildRestorePoint(backupRoot, 'dedalo_7.0.0_x', '7.0.0', DIGEST_A);
		const broken = buildRestorePoint(backupRoot, 'dedalo_7.0.0_y', '7.0.0', null, {
			bootable: false,
		});
		expect(restorePointIsBootable(good)).toBe(true);
		expect(declaredVersionOf(good)).toBe('7.0.0');
		expect(bunPinOf(good)).toBe(Bun.version);
		expect(restorePointIsBootable(broken)).toBe(false);
		expect(declaredVersionOf(join(backupRoot, 'nothing_here'))).toBeNull();
		// An absent `.bun-version` is "no pin", never a pin that can never match.
		expect(bunPinOf(join(backupRoot, 'nothing_here'))).toBeNull();
		// The smoke-boot contract is read from the tree that would have to obey it.
		expect(honoursSmokeBoot(good)).toBe(true);
		rmSync(join(good, 'src', 'server.ts'));
		expect(honoursSmokeBoot(good)).toBe(false);
	});
});

describe('the listing the panel renders IS the listing the pipeline resolves against', () => {
	test('every point carries the verdict facts, and the verdict is the predicate’s', async () => {
		// status.ts's header law, mechanically: the panel may never reach a
		// verdict the pipeline reaches differently. Both sides read THESE rows.
		const { backupRoot } = caseDirs('listing');
		buildRestorePoint(backupRoot, `dedalo_${RUNNING}_ppppppp_1`, RUNNING, DIGEST_A);
		const foreign = buildRestorePoint(backupRoot, `dedalo_${RUNNING}_ppppppp_2`, RUNNING, DIGEST_B);
		writeFileSync(join(foreign, '.bun-version'), '0.0.1\n');
		const { readRestorePoints } = await import('../../src/core/update/status.ts');

		const points = readRestorePoints(backupRoot);
		expect(points).toHaveLength(2);
		for (const point of points) {
			expect(point.version).toBe(RUNNING);
			expect(typeof point.bootable).toBe('boolean');
			expect(restorabilityOf(point)).toEqual({
				restorable: point.restorable,
				reason: point.restorable_reason,
			});
		}
		const blocked = points.find((point) => point.bun_pin === '0.0.1');
		expect(blocked?.restorable).toBe(false);
		expect(blocked?.restorable_reason).toBe('bun_pin_mismatch');
	});
});

describe('restoreCode refusals (nothing on disk moves)', () => {
	test('an unknown name, a traversal name and a non-dedalo_ name each refuse', async () => {
		const { targetRoot, backupRoot } = caseDirs('names');
		buildLiveTree(targetRoot, DIGEST_A);
		buildRestorePoint(backupRoot, `dedalo_${RUNNING}_aaaaaaa_s`, RUNNING, DIGEST_B);
		const before = treeDigest(targetRoot);

		const unknown = await refusalOf(
			restoreCode(
				{ name: 'dedalo_7.0.0_nope' },
				SUPERUSER,
				restoreSeams({ targetRoot, backupRoot }),
			),
		);
		expect(unknown.code).toBe('update.refused');
		expect(unknown.message).toContain('Unknown restore point');

		// The name grammar refuses BEFORE any join: a separator, a traversal
		// segment, an empty name or a name outside the listing's own prefix.
		for (const name of ['../x', 'a/b', '..', '', 'backups', `../${`dedalo_${RUNNING}_x`}`]) {
			const refusal = await refusalOf(
				restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.message).toContain('Malformed restore point name');
		}
		// nothing moved and no run lock was left behind
		expect(treeDigest(targetRoot)).toBe(before);
		expect(existsSync(codeRunLockPath(backupRoot))).toBe(false);
	});

	test('a non-bootable restore point refuses and says why', async () => {
		const { targetRoot, backupRoot } = caseDirs('not_bootable');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_bbbbbbb_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B, { bootable: false });
		const before = treeDigest(targetRoot);

		const refusal = await refusalOf(
			restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
		);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.message).toContain('not bootable');
		expect(treeDigest(targetRoot)).toBe(before);
	});

	test('a point pinning another Bun refuses, naming both runtimes', async () => {
		// The pin the update refuses a RELEASE on, applied to the tree a restore
		// would hand to the same running bun.
		const { targetRoot, backupRoot } = caseDirs('bun_pin');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_jjjjjjj_s`;
		const dir = buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		writeFileSync(join(dir, '.bun-version'), '0.0.1\n');
		const before = treeDigest(targetRoot);

		const refusal = await refusalOf(
			restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
		);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.message).toContain('0.0.1');
		expect(refusal.message).toContain(Bun.version);
		expect(treeDigest(targetRoot)).toBe(before);
	});

	test('an operator SECRET the point does not ship refuses BEFORE the swap could bury it', async () => {
		// The first rename carries the WHOLE live tree into the backup dir. The
		// update refuses this exact state; a restore that proceeded would leave
		// the installation running without its TLS material and with the files in
		// a backup nobody was told about. Both ends of the walk: an entry at the
		// ROOT (the walk starts at prefix '' — this is why dropping the update's
		// root whitelist from this path lost no secret coverage), and one NESTED
		// under a directory the point ships.
		const { targetRoot, backupRoot } = caseDirs('drop_in');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_kkkkkkk_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		mkdirSync(join(targetRoot, 'certs'), { recursive: true });
		writeFileSync(join(targetRoot, 'certs', 'server.pem'), '-----BEGIN-----\n');
		const before = treeDigest(targetRoot);

		const rootRefusal = await refusalOf(
			restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
		);
		expect(rootRefusal.code).toBe('update.refused');
		expect(rootRefusal.message).toContain('secret-shaped');
		expect(rootRefusal.message).toContain('certs');
		expect(treeDigest(targetRoot)).toBe(before);
		rmSync(join(targetRoot, 'certs'), { recursive: true });

		// …and the NESTED secret-shaped walk, under a directory the point ships.
		mkdirSync(join(targetRoot, 'src', 'certs'), { recursive: true });
		writeFileSync(join(targetRoot, 'src', 'certs', 'server.pem'), '-----BEGIN-----\n');
		const nestedRefusal = await refusalOf(
			restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
		);
		expect(nestedRefusal.code).toBe('update.refused');
		expect(nestedRefusal.message).toContain('secret-shaped');
		expect(existsSync(join(targetRoot, 'src', 'certs', 'server.pem'))).toBe(true);
	});

	test('an OLDER point restores even though later releases added root entries', async () => {
		// THE REGRESSION (2026-08-26). The restore path inherited the update's
		// ROOT WHITELIST, which reads `shipped` from the tree about to land —
		// sound only while that tree is NEWER. Here it is OLDER, so every root
		// entry a later release added (SECURITY.md in f6ded58d80, cliff.toml in
		// 8a26b27a6d, install.sh in 7e3a27e026 …) read as "unaccounted" and the
		// restore refused, telling the operator to DELETE SHIPPED FILES. Neither
		// the first gate nor the live drill caught it: both built the point and
		// the live tree from the same shape, so no root-entry delta existed.
		const { targetRoot, backupRoot } = caseDirs('older_point');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_ppppppp_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		// shipped by the RUNNING release, absent from the older point
		writeFileSync(join(targetRoot, 'SECURITY.md'), '# Security\n');
		writeFileSync(join(targetRoot, 'cliff.toml'), '[changelog]\n');

		const answer = await restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot }));
		expect(answer.ok).toBe(true);
		// the point landed, and the outgoing tree (with its extra root files) is
		// the new restore point — nothing was lost, it just moved aside
		expect(existsSync(join(targetRoot, 'src', 'live_only.ts'))).toBe(false);
		const parked = readdirSync(backupRoot).filter((entry) => entry.startsWith('dedalo_'));
		expect(parked).toHaveLength(1);
		expect(existsSync(join(backupRoot, parked[0] as string, 'SECURITY.md'))).toBe(true);
	});

	test('a point declaring no version refuses — provenance that cannot be read is not restored', async () => {
		const { targetRoot, backupRoot } = caseDirs('no_version');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_ccccccc_s`;
		const dir = buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		rmSync(join(dir, 'src', 'core', 'update', 'version.ts'));

		const refusal = await refusalOf(
			restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
		);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.message).toContain('does not declare a Dédalo version');
	});
});

describe('the database hazard is CONFIRMED, never assumed', () => {
	test('a version mismatch refuses without confirm_downgrade and proceeds with it', async () => {
		const { targetRoot, backupRoot } = caseDirs('downgrade');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = 'dedalo_6.9.9_ddddddd_s';
		buildRestorePoint(backupRoot, name, '6.9.9', DIGEST_B);
		const before = treeDigest(targetRoot);

		const refusal = await refusalOf(
			restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
		);
		expect(refusal.code).toBe('update.refused');
		expect(refusal.message).toContain('6.9.9');
		expect(refusal.message).toContain('does NOT revert database migrations');
		expect(refusal.message).toContain('confirm_downgrade');
		expect(treeDigest(targetRoot)).toBe(before);

		// …and the SAME request with the waiver runs the whole pipeline.
		const out = await restoreCode(
			{ name, confirm_downgrade: true },
			SUPERUSER,
			restoreSeams({ targetRoot, backupRoot }),
		);
		expect(out.ok).toBe(true);
		expect(out.data).toEqual({ version: '6.9.9' });
		expect(declaredVersionOf(targetRoot)).toBe('6.9.9');
	});
});

describe('the full restore swap against a temp tree', () => {
	test('the point lands, the outgoing tree becomes a NEW restore point, the sentinel carries the POINT’s digest', async () => {
		const { targetRoot, backupRoot } = caseDirs('swap');
		buildLiveTree(targetRoot, DIGEST_A);
		// .git is a PRESERVED root entry: it must be carried into the restored tree.
		mkdirSync(join(targetRoot, '.git'), { recursive: true });
		writeFileSync(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/v7');
		const name = `dedalo_${RUNNING}_bbbbbbb_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		writeFileSync(join(backupRoot, name, 'src', 'point_only.ts'), '// only in the point');

		let restarted = '';
		const frames: UpdatePhaseFrame[] = [];
		let smokeBooted = '';
		const out = await restoreCode(
			{ name },
			SUPERUSER,
			restoreSeams({
				targetRoot,
				backupRoot,
				restart: (reason) => {
					restarted = reason;
				},
				smokeBoot: async (dir) => {
					smokeBooted = dir;
				},
				onPhase: (frame) => frames.push(frame),
			}),
		);

		expect(out.ok).toBe(true);
		expect(out.data).toEqual({ version: RUNNING });
		expect(String(out.msg)).toContain(`Restored Dédalo ${RUNNING} from ${name}`);
		expect(restarted).toContain(name);
		// THE NEW STEP: the backup was proven to boot BEFORE the live tree moved.
		expect(smokeBooted).toBe(join(backupRoot, name));
		// the point's tree is in place, the live-only file is gone, .git carried over
		expect(existsSync(join(targetRoot, 'src', 'point_only.ts'))).toBe(true);
		expect(existsSync(join(targetRoot, 'src', 'live_only.ts'))).toBe(false);
		expect(readFileSync(join(targetRoot, '.git', 'HEAD'), 'utf8')).toContain('refs/heads/v7');
		// the restore point was CONSUMED (moved, not copied)
		expect(existsSync(join(backupRoot, name))).toBe(false);
		// the OUTGOING tree is a new restore point, node_modules included
		const points = readdirSync(backupRoot).filter((entry) => entry.startsWith('dedalo_'));
		expect(points).toHaveLength(1);
		const newPoint = join(backupRoot, points[0] as string);
		// named after the tree it HOLDS: the running version + that tree's digest
		expect(points[0]).toContain(RUNNING);
		expect(points[0]).toContain(DIGEST_A.slice(0, 7));
		expect(existsSync(join(newPoint, 'src', 'live_only.ts'))).toBe(true);
		expect(existsSync(join(newPoint, 'node_modules', 'dep', 'index.js'))).toBe(true);
		// THE SENTINEL: the rollback contract's exact flat keys, and the
		// installDigest is the RESTORE POINT's own — never this process's.
		const sentinel = JSON.parse(
			readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
		) as Record<string, unknown>;
		expect(sentinel).toEqual({
			version: RUNNING,
			previousVersion: RUNNING,
			updateMode: 'clean',
			stamp: sentinel.stamp,
			backupDir: newPoint,
			installDigest: DIGEST_B,
			status: 'pending',
			rollback_attempted: false,
		});
		// PHASE TRACK: the fetch/install half is `skipped`, so the client's
		// reducer needs no restore-specific branch.
		expect(frames.map((frame) => frame.phase)).toEqual(['preflight', 'swap', 'restart']);
		const first = frames[0] as UpdatePhaseFrame;
		expect(
			first.phases.filter((phase) => phase.status === 'skipped').map((phase) => phase.id),
		).toEqual(['download', 'verify', 'extract', 'deps']);
		const last = frames.at(-1) as UpdatePhaseFrame;
		expect(last.expected_version).toBe(RUNNING);
		// staging swept, lock released
		expect(existsSync(join(backupRoot, '.code_staging'))).toBe(false);
		expect(existsSync(codeRunLockPath(backupRoot))).toBe(false);
	});

	test('a point that predates DEDALO_SMOKE_BOOT is NOT booted, and the track says `skipped`', async () => {
		// The flag landed 2026-08-23; a tree cut before it ignores it and runs its
		// FULL boot — migrations, schedulers, diffusion, watchers — against the
		// live database, as a second instance, while this process is still
		// serving. Booting it is worse than not checking it, so it is not booted.
		const { targetRoot, backupRoot } = caseDirs('flag_blind');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_lllllll_s`;
		const dir = buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		writeFileSync(join(dir, 'src', 'server.ts'), '// a tree cut before the flag existed\n');

		let smokeBooted = '';
		const frames: UpdatePhaseFrame[] = [];
		const out = await restoreCode(
			{ name },
			SUPERUSER,
			restoreSeams({
				targetRoot,
				backupRoot,
				smokeBoot: async (booted) => {
					smokeBooted = booted;
				},
				onPhase: (frame) => frames.push(frame),
			}),
		);

		expect(out.ok).toBe(true);
		expect(smokeBooted).toBe('');
		// `skipped`, never a false `done`: the operator is told the check did not run.
		expect(frames.map((frame) => frame.phase)).toEqual(['swap', 'restart']);
		const first = frames[0] as UpdatePhaseFrame;
		expect(
			first.phases.filter((phase) => phase.status === 'skipped').map((phase) => phase.id),
		).toEqual(['download', 'verify', 'extract', 'deps', 'preflight']);
	});

	test('a point that FAILS its pre-flight boot never touches the live tree', async () => {
		// The one behaviour that makes a restore more than `mv`: a backup dir is a
		// tree nobody has executed since the day it was moved aside. Every other
		// gate in this file seams smokeBoot to a no-op, so without this case the
		// module's whole reason to exist was asserted nowhere.
		const { targetRoot, backupRoot } = caseDirs('preflight_fail');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_qqqqqqq_s`;
		const dir = buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		const before = treeDigest(targetRoot);
		const frames: UpdatePhaseFrame[] = [];

		const refusal = await refusalOf(
			restoreCode(
				{ name },
				SUPERUSER,
				restoreSeams({
					targetRoot,
					backupRoot,
					smokeBoot: async () => {
						throw new Error('the restored tree exited 1 during its boot check');
					},
					onPhase: (frame) => frames.push(frame),
				}),
			),
		);

		expect(refusal.code).toBe('update.failed');
		// NOTHING moved: the live tree is byte-identical and the point still exists
		expect(treeDigest(targetRoot)).toBe(before);
		expect(existsSync(join(dir, 'package.json'))).toBe(true);
		expect(readdirSync(backupRoot).filter((entry) => entry.startsWith('dedalo_'))).toEqual([name]);
		// no sentinel was written — it is written INSIDE the swap, which never ran
		expect(existsSync(join(backupRoot, 'last_code_update.json'))).toBe(false);
		// the track blames the phase that actually stopped, and staging + lock are clean
		expect(frames.at(-1)?.phases.find((phase) => phase.status === 'failed')?.id).toBe('preflight');
		expect(existsSync(join(backupRoot, '.code_staging'))).toBe(false);
		expect(existsSync(codeRunLockPath(backupRoot))).toBe(false);
	});

	test('a DOUBLE rename failure never wedges staging with a marker for a tree that is not there', async () => {
		// restoreAfterFailedSwap parks the incoming tree under STAGING_KEEP_MARKER
		// — true for an UPDATE (its quarantine IS staging), false for a restore
		// (the incoming tree is the restore point, staging is empty). The marker
		// there kept an empty dir forever and hard-refused every later update AND
		// restore, on an installation that had just lost its live tree.
		const { targetRoot, backupRoot } = caseDirs('double_fail');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_mmmmmmm_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);

		const refusal = await refusalOf(
			restoreCode(
				{ name },
				SUPERUSER,
				restoreSeams({
					targetRoot,
					backupRoot,
					renameIntoPlace: () => {
						throw new Error('injected second-rename failure');
					},
					renameRestore: () => {
						throw new Error('injected restore-rename failure');
					},
				}),
			),
		);
		expect(refusal.code).toBe('update.failed');
		// both surviving trees are named, and staging is not claimed to hold one
		expect(refusal.message).toContain(name);
		expect(refusal.message).not.toContain('parked in staging');
		expect(existsSync(join(codeStagingDir(backupRoot), STAGING_KEEP_MARKER))).toBe(false);
		expect(existsSync(codeStagingDir(backupRoot))).toBe(false);
		// …so the NEXT attempt is refused on its own merits, never on a marker.
		const next = await refusalOf(
			restoreCode(
				{ name: 'dedalo_7.0.0_nope' },
				SUPERUSER,
				restoreSeams({ targetRoot, backupRoot }),
			),
		);
		expect(next.message).toContain('Unknown restore point');
	});

	test('an UNSTAMPED restore point OMITS installDigest (boot_confirm falls back to the version compare)', async () => {
		const { targetRoot, backupRoot } = caseDirs('unstamped');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_eeeeeee_s`;
		buildRestorePoint(backupRoot, name, RUNNING, null);

		const out = await restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot }));
		expect(out.ok).toBe(true);
		const sentinel = JSON.parse(
			readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
		) as Record<string, unknown>;
		// An EMPTY STRING would scream a mismatch on every boot — the field is absent.
		expect('installDigest' in sentinel).toBe(false);
	});

	test('the pending sentinel is on disk, naming the intended backup dir, BEFORE the first rename', async () => {
		const { targetRoot, backupRoot } = caseDirs('sentinel_order');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_fffffff_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		// The first-rename seam observes the disk AT THE MOMENT the live tree is
		// about to move — an end-state assertion could not prove the ordering.
		let observed: { status: unknown; digest: unknown; targetIntact: boolean } | null = null;

		const out = await restoreCode(
			{ name },
			SUPERUSER,
			restoreSeams({
				targetRoot,
				backupRoot,
				renameToBackup: (from, to) => {
					const sentinel = JSON.parse(
						readFileSync(join(backupRoot, 'last_code_update.json'), 'utf8'),
					) as Record<string, unknown>;
					observed = {
						status: sentinel.status,
						digest: sentinel.installDigest,
						targetIntact: existsSync(join(from, 'package.json')),
					};
					renameSync(from, to);
				},
			}),
		);

		expect(out.ok).toBe(true);
		expect(observed).not.toBeNull();
		const seen = observed as unknown as {
			status: unknown;
			digest: unknown;
			targetIntact: boolean;
		};
		expect(seen.status).toBe('pending');
		expect(seen.digest).toBe(DIGEST_B);
		expect(seen.targetIntact).toBe(true); // the live tree had not moved yet
	});

	test('a failed SECOND rename leaves the live tree BYTE-IDENTICAL', async () => {
		const { targetRoot, backupRoot } = caseDirs('rename_fail');
		buildLiveTree(targetRoot, DIGEST_A);
		mkdirSync(join(targetRoot, '.git'), { recursive: true });
		writeFileSync(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/v7');
		const before = treeDigest(targetRoot);
		const name = `dedalo_${RUNNING}_ggggggg_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);

		const refusal = await refusalOf(
			restoreCode(
				{ name },
				SUPERUSER,
				restoreSeams({
					targetRoot,
					backupRoot,
					renameIntoPlace: () => {
						throw new Error('injected rename failure');
					},
				}),
			),
		);
		expect(refusal.code).toBe('update.failed');
		expect(refusal.message).toContain('previous tree was restored');
		// the live tree is back in place, .git included, byte for byte
		expect(treeDigest(targetRoot)).toBe(before);
		// the pre-swap pending sentinel was RETRACTED (nothing for the rollback to do)
		expect(existsSync(join(backupRoot, 'last_code_update.json'))).toBe(false);
		// the restore point survived where it was
		expect(existsSync(join(backupRoot, name, 'package.json'))).toBe(true);
		expect(existsSync(codeRunLockPath(backupRoot))).toBe(false);
	});
});

describe('single-flight: the restore takes the UPDATE’s run lock', () => {
	test('a restore refuses while the update run lock is held', async () => {
		const { targetRoot, backupRoot } = caseDirs('lock_held');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_hhhhhhh_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		const before = treeDigest(targetRoot);

		// The lock an updateCode run holds — same path, same file.
		const release = acquireRunLockOrRefuse(backupRoot, '7.0.1');
		try {
			const refusal = await refusalOf(
				restoreCode({ name }, SUPERUSER, restoreSeams({ targetRoot, backupRoot })),
			);
			expect(refusal.code).toBe('update.refused');
			expect(refusal.message).toContain('is already running on this installation');
			expect(treeDigest(targetRoot)).toBe(before);
		} finally {
			release();
		}
	});

	test('an update cannot take the lock while a restore is mid-flight', async () => {
		const { targetRoot, backupRoot } = caseDirs('lock_inflight');
		buildLiveTree(targetRoot, DIGEST_A);
		const name = `dedalo_${RUNNING}_iiiiiii_s`;
		buildRestorePoint(backupRoot, name, RUNNING, DIGEST_B);
		// The smoke-boot seam runs INSIDE the lock, exactly where an update's
		// own acquisition would land.
		// A holder, not a bare `let`: TS narrows a closure-assigned local to its
		// initializer type, and the assertions below read a string.
		const concurrent: { message: string } = { message: '' };
		const out = await restoreCode(
			{ name },
			SUPERUSER,
			restoreSeams({
				targetRoot,
				backupRoot,
				smokeBoot: async () => {
					try {
						acquireRunLockOrRefuse(backupRoot, '7.0.1')();
						concurrent.message = 'TAKEN — the restore did NOT hold the update lock';
					} catch (error) {
						concurrent.message = error instanceof Error ? error.message : String(error);
					}
				},
			}),
		);
		expect(out.ok).toBe(true);
		expect(concurrent.message).toContain('is already running on this installation');
		// …and the holder it names is the RESTORE (its version), not a second update.
		expect(concurrent.message).toContain(RUNNING);
	});
});
