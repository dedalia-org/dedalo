/**
 * THE PROCESSES DIR'S MOUNT IS VERIFIED (A1-01 third review N1b) —
 * src/core/media/processes_mount.ts.
 *
 * The component locks decide exclusion by the server's answer to a mutation;
 * their STALENESS judgement still reads through the client cache. So on Linux
 * an NFS processes dir must be mounted lookupcache=none + actimeo=0/noac, and
 * not nocto — or the lock door (and the boot) refuse, typed. Gated here:
 *  - mountinfo parsing on real-format lines (escaped mount points, `maj:min`,
 *    per-mount + superblock options), the mount that holds a path — BY DEVICE
 *    (st_dev vs maj:min, R3: an over-mount resolves to what the kernel resolved),
 *    the deepest whole-segment prefix (last of stacked equals) only when no
 *    prefix mount carries the device; the glibc st_dev decoding;
 *  - a dir that does not exist yet is judged on its nearest existing ancestor,
 *    and nothing is created (R2);
 *  - the verdict: every missing option named, a local filesystem never judged;
 *  - the door: a manager on an incoherent mount refuses every component claim
 *    with `media.not_configured` and writes no lock; on a coherent one it
 *    claims, and re-reads the mount only past MOUNT_REVERIFY_MS (R3 — a remount
 *    is refused within the bound); the boot entry throws the same; off Linux
 *    nothing is verified;
 *  - the SMOKE boot's read-only verdict on the live dir the updater names (R2).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	configuredProcessesDir,
	type JobTarget,
	MediaJobManager,
	verifyProcessesDirMount,
} from '../../src/core/media/jobs.ts';
import {
	assertProcessesMountCoherent,
	decodeLinuxDevice,
	linuxDeviceOf,
	MOUNT_REVERIFY_MS,
	type MountEntry,
	mountOf,
	nfsCoherenceProblems,
	parseMountInfo,
	readMountTable,
	verifySmokeProcessesDirMount,
} from '../../src/core/media/processes_mount.ts';
import { mustGet } from '../helpers/assert.ts';
import { markProcessesDir } from '../helpers/media_scratch_root.ts';
import { refusalOfSync } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_processes_mount');
const PROCESSES = join(ROOT, 'processes');
const LOCKS = join(PROCESSES, 'component_locks');
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;

const ROOT_EXT4 = '29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro';
/** An nfs4 mount as `mount -t nfs4 fs:/export /srv/media` leaves it: every cache on. */
const NFS_DEFAULTS =
	'rw,vers=4.2,rsize=1048576,wsize=1048576,namlen=255,hard,proto=tcp,timeo=600,retrans=2,sec=sys,clientaddr=10.0.0.5,local_lock=none,addr=10.0.0.9';
/** The same share mounted as §8.1 asks: lookupcache=none + actimeo=0 (shown as the four times). */
const NFS_COHERENT =
	'rw,vers=4.2,rsize=1048576,wsize=1048576,namlen=255,acregmin=0,acregmax=0,acdirmin=0,acdirmax=0,soft,proto=tcp,timeo=50,retrans=2,sec=sys,clientaddr=10.0.0.5,lookupcache=none,local_lock=none,addr=10.0.0.9';
const nfsLine = (mountPoint: string, superOptions: string, fsType = 'nfs4', id = 120): string =>
	`${id} 29 0:52 / ${mountPoint} rw,relatime shared:60 - ${fsType} fs.example:/export ${superOptions}`;
const entry = (fsType: string, options: string): MountEntry => ({
	mountPoint: '/srv/media',
	device: '0:52',
	fsType,
	options: options.split(','),
});

const target = (sectionId: number): JobTarget => ({
	section_tipo: 'test3',
	section_id: sectionId,
	component_tipo: 'test94',
	lang: null,
	quality: '404',
	scope: 'component',
});

/** A mountinfo where the processes dir's real path sits on one mount of `superOptions`. */
const mountinfoOver = (superOptions: string): string =>
	[ROOT_EXT4, nfsLine(realpathSync(PROCESSES), superOptions)].join('\n');

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(PROCESSES);
});

afterAll(() => {
	if (previousProcessesDir === undefined)
		Reflect.deleteProperty(process.env, 'DEDALO_MEDIA_PROCESSES_DIR');
	else process.env.DEDALO_MEDIA_PROCESSES_DIR = previousProcessesDir;
	rmSync(ROOT, { recursive: true, force: true });
});

describe('mountinfo: which mount holds the processes dir', () => {
	test('a real-format line: mount point unescaped, per-mount AND superblock options', () => {
		const [root, share] = parseMountInfo(
			`${ROOT_EXT4}\n${nfsLine('/srv/dedalo\\040media', 'rw,lookupcache=none')}\n`,
		);
		expect(root?.fsType).toBe('ext4');
		expect(share).toEqual({
			mountPoint: '/srv/dedalo media',
			device: '0:52',
			fsType: 'nfs4',
			options: ['rw', 'relatime', 'rw', 'lookupcache=none'], // optional fields (shared:60) are not options
		});
	});

	test('the longest whole-segment prefix wins; a sibling sharing a prefix does not; the last of stacked equals wins', () => {
		const mounts = parseMountInfo(
			[
				ROOT_EXT4,
				nfsLine('/srv/med', NFS_DEFAULTS, 'nfs4', 121),
				nfsLine('/srv/media', NFS_DEFAULTS, 'nfs4', 122),
				nfsLine('/srv/media', NFS_COHERENT, 'nfs4', 123),
			].join('\n'),
		);
		expect(mountOf('/srv/media/processes', mounts)?.options).toContain('lookupcache=none');
		expect(mountOf('/srv/media', mounts)?.options).toContain('lookupcache=none');
		expect(mountOf('/srv/medium/processes', mounts)?.fsType).toBe('ext4');
		expect(mountOf('/var/lib/dedalo', mounts)?.fsType).toBe('ext4');
	});

	test('OVER-MOUNTS resolve by device (R3): the mount the kernel resolved, never the deepest prefix', () => {
		// An NFS share at /srv, mounted AFTER a local disk at /srv/media: the
		// path now resolves into the NFS share (the disk beneath is hidden), but
		// the deepest prefix is still the hidden /srv/media.
		const hiddenDisk = parseMountInfo(
			[
				ROOT_EXT4,
				'40 29 259:5 / /srv/media rw,relatime - ext4 /dev/nvme1n1 rw',
				nfsLine('/srv', NFS_DEFAULTS, 'nfs4', 124),
			].join('\n'),
		);
		expect(mountOf('/srv/media/processes', hiddenDisk)?.fsType).toBe('ext4'); // prefix alone: wrong
		expect(mountOf('/srv/media/processes', hiddenDisk, '0:52')?.fsType).toBe('nfs4');
		// The converse: an NFS share at /srv/media hidden by a local disk mounted at /srv.
		const hiddenShare = parseMountInfo(
			[
				ROOT_EXT4,
				nfsLine('/srv/media', NFS_DEFAULTS, 'nfs4', 125),
				'41 29 259:6 / /srv rw,relatime - ext4 /dev/nvme2n1 rw',
			].join('\n'),
		);
		expect(mountOf('/srv/media/processes', hiddenShare, '259:6')?.fsType).toBe('ext4');
		// No prefix mount carries the device (a btrfs subvolume): the deepest prefix decides.
		expect(mountOf('/srv/media/processes', hiddenShare, '0:99')?.fsType).toBe('nfs4');
	});

	test("st_dev is decoded the glibc way into mountinfo's maj:min", () => {
		expect(decodeLinuxDevice(0x801n)).toBe('8:1');
		expect(decodeLinuxDevice(0x10302n)).toBe('259:2');
		expect(decodeLinuxDevice(52n)).toBe('0:52'); // an NFS superblock's anonymous device
		expect(decodeLinuxDevice(44n | (256n << 12n))).toBe('0:300'); // minor past 8 bits
		expect(decodeLinuxDevice(4096n << 32n)).toBe('4096:0'); // major past 12 bits
	});
});

describe('the verdict', () => {
	test('a default NFS mount: lookups and attributes cached — both named', () => {
		expect(nfsCoherenceProblems(entry('nfs', NFS_DEFAULTS))).toHaveLength(2); // NFSv3 too
		const problems = nfsCoherenceProblems(entry('nfs4', NFS_DEFAULTS));
		expect(problems).toHaveLength(2);
		expect(problems.join(' ')).toContain('lookupcache=none');
		expect(problems.join(' ')).toContain('actimeo=0');
	});

	test('lookupcache=none + actimeo=0 (the four times at 0) or noac: coherent, on nfs and nfs4', () => {
		expect(nfsCoherenceProblems(entry('nfs4', NFS_COHERENT))).toEqual([]);
		expect(nfsCoherenceProblems(entry('nfs', NFS_COHERENT))).toEqual([]);
		expect(nfsCoherenceProblems(entry('nfs4', 'rw,noac,lookupcache=none'))).toEqual([]);
	});

	test('one attribute time left cached is still cached', () => {
		const partial = 'rw,lookupcache=none,acregmin=0,acregmax=0,acdirmin=0,acdirmax=60';
		expect(nfsCoherenceProblems(entry('nfs4', partial))).toEqual([
			'attributes are cached (set actimeo=0 or noac)',
		]);
	});

	test('lookupcache=pos is not none; nocto is refused even with every cache off', () => {
		expect(nfsCoherenceProblems(entry('nfs4', 'rw,noac,lookupcache=pos'))).toHaveLength(1);
		expect(nfsCoherenceProblems(entry('nfs4', `${NFS_COHERENT},nocto`))).toEqual([
			'nocto is set (close-to-open consistency is required)',
		]);
	});

	test('a filesystem that is not NFS is never judged', () => {
		expect(nfsCoherenceProblems(entry('ext4', 'rw'))).toEqual([]);
		expect(nfsCoherenceProblems(entry('xfs', 'rw,noatime'))).toEqual([]);
	});
});

describe('the door and the boot refuse an incoherent mount, typed', () => {
	test('the lock door: every component claim refuses with media.not_configured and writes no lock', () => {
		const m = new MediaJobManager({
			instanceId: 'mount-bad',
			lockHeartbeatMs: 0,
			lockMountProbe: { platform: 'linux', mountinfo: () => mountinfoOver(NFS_DEFAULTS) },
		});
		const refusal = refusalOfSync(() => m.claimTarget(target(1)));
		expect(refusal.code).toBe('media.not_configured');
		expect(refusal.message).toContain('lookupcache=none');
		expect(existsSync(LOCKS) ? readdirSync(LOCKS) : []).toEqual([]);
		// Not verified once and forgotten: the next call (a whole claim) refuses too.
		expect(refusalOfSync(() => m.claimWholeComponents('test3', 2, ['test94'], 'x')).code).toBe(
			'media.not_configured',
		);
		expect(existsSync(LOCKS) ? readdirSync(LOCKS) : []).toEqual([]);
	});

	test('on a coherent mount the door claims — and reads the mount again only past MOUNT_REVERIFY_MS (R3)', () => {
		let reads = 0;
		let table = NFS_COHERENT;
		let now = 1_000;
		const m = new MediaJobManager({
			instanceId: 'mount-good',
			lockHeartbeatMs: 0,
			clock: () => now,
			lockMountProbe: {
				platform: 'linux',
				mountinfo: () => {
					reads += 1;
					return mountinfoOver(table);
				},
			},
		});
		mustGet(m.claimTarget(target(3)), 'first').release();
		now += MOUNT_REVERIFY_MS - 1;
		mustGet(m.claimTarget(target(4)), 'second, within the bound').release();
		expect(reads).toBe(1);
		// Remounted with the caches on while the instance runs: seen past the bound.
		table = NFS_DEFAULTS;
		now += 1;
		expect(refusalOfSync(() => m.claimTarget(target(5))).code).toBe('media.not_configured');
		expect(reads).toBe(2);
		// A refusal is not remembered: fixed, the very next call passes.
		table = NFS_COHERENT;
		mustGet(m.claimTarget(target(6)), 'remounted coherent').release();
		expect(reads).toBe(3);
	});

	test('the boot entry throws the same typed refusal; off Linux nothing is verified', () => {
		const bad = { mountinfo: () => mountinfoOver(NFS_DEFAULTS) };
		expect(refusalOfSync(() => verifyProcessesDirMount({ platform: 'linux', ...bad })).code).toBe(
			'media.not_configured',
		);
		expect(() => verifyProcessesDirMount({ platform: 'darwin', ...bad })).not.toThrow();
		expect(() =>
			assertProcessesMountCoherent(PROCESSES, { platform: 'linux', mountinfo: () => ROOT_EXT4 }),
		).not.toThrow();
	});

	test('the mount table is read with a CEILING: past it, or unopenable, the mount is refused typed — never trusted', () => {
		const table = join(ROOT, 'mountinfo');
		writeFileSync(table, `${ROOT_EXT4}\n`);
		expect(readMountTable(table, 4096)).toBe(`${ROOT_EXT4}\n`);
		const over = refusalOfSync(() => readMountTable(table, 16));
		expect(over.code).toBe('media.not_configured');
		expect(over.message).toContain('larger than 16 bytes');
		expect(refusalOfSync(() => readMountTable(join(ROOT, 'absent'))).code).toBe(
			'media.not_configured',
		);
	});

	test('a dir not made yet is judged on its NEAREST EXISTING ancestor — by its device — and nothing is created (R2)', () => {
		const future = join(ROOT, 'not', 'made', 'yet');
		const asked: string[] = [];
		const probe = {
			platform: 'linux',
			mountinfo: () => [ROOT_EXT4, nfsLine(realpathSync(ROOT), NFS_DEFAULTS)].join('\n'),
			deviceOf: (path: string) => {
				asked.push(path);
				return '0:52';
			},
		};
		const refusal = refusalOfSync(() => assertProcessesMountCoherent(future, probe));
		expect(refusal.code).toBe('media.not_configured');
		expect(asked).toEqual([ROOT]);
		expect(existsSync(join(ROOT, 'not'))).toBe(false);
	});

	test("the door judges the mount BY THE DIR'S DEVICE: a share stacked over a local disk is refused (R3)", () => {
		// A local disk at the processes dir, then an NFS share mounted OVER its
		// parent: the dir now lives on the share (its device is the share's).
		const mountinfo = () =>
			[
				ROOT_EXT4,
				`40 29 259:5 / ${realpathSync(PROCESSES)} rw,relatime - ext4 /dev/nvme1n1 rw`,
				nfsLine(realpathSync(ROOT), NFS_DEFAULTS),
			].join('\n');
		const onShare = { platform: 'linux', mountinfo, deviceOf: () => '0:52' };
		expect(refusalOfSync(() => assertProcessesMountCoherent(PROCESSES, onShare)).code).toBe(
			'media.not_configured',
		);
		// …and the disk itself, when the kernel resolves the dir to it, is not judged.
		const onDisk = { ...onShare, deviceOf: () => '259:5' };
		expect(() => assertProcessesMountCoherent(PROCESSES, onDisk)).not.toThrow();
	});

	test.skipIf(!existsSync('/proc/self/mountinfo'))(
		'on a host with /proc the REAL table is read and judged (this host: Linux)',
		() => {
			const mounts = parseMountInfo(readMountTable());
			expect(mounts.length).toBeGreaterThan(0);
			// The decoding agrees with the kernel: '/' has a mount carrying its st_dev.
			expect(mounts.some((mount) => mount.device === linuxDeviceOf('/'))).toBe(true);
		},
	);
});

describe('the SMOKE boot reads the same verdict on the LIVE dir, read only (R2)', () => {
	const KEY = 'DEDALO_SMOKE_PROCESSES_DIR';
	const nfsOverRoot = {
		platform: 'linux',
		mountinfo: () => [ROOT_EXT4, nfsLine(realpathSync(ROOT), NFS_DEFAULTS)].join('\n'),
		deviceOf: () => '0:52',
	};
	const withKey = (value: string | undefined, fn: () => void): void => {
		const previous = process.env[KEY];
		if (value === undefined) Reflect.deleteProperty(process.env, KEY);
		else process.env[KEY] = value;
		try {
			fn();
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, KEY);
			else process.env[KEY] = previous;
		}
	};

	test('the live dir the updater names, on a default NFS mount: refused typed, nothing created', () => {
		const live = join(ROOT, 'live_processes');
		withKey(live, () => {
			const refusal = refusalOfSync(() => verifySmokeProcessesDirMount(nfsOverRoot));
			expect(refusal.code).toBe('media.not_configured');
			expect(refusal.message).toContain(live);
		});
		expect(existsSync(live)).toBe(false);
	});

	test('on a coherent mount it passes; an updater that names no dir is SAID, nothing judged', () => {
		withKey(join(ROOT, 'live_processes'), () => {
			expect(() =>
				verifySmokeProcessesDirMount({
					...nfsOverRoot,
					mountinfo: () => [ROOT_EXT4, nfsLine(realpathSync(ROOT), NFS_COHERENT)].join('\n'),
				}),
			).not.toThrow();
		});
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			withKey(undefined, () => {
				expect(() => verifySmokeProcessesDirMount(nfsOverRoot)).not.toThrow();
			});
			expect(warn.mock.calls.flat().join(' ')).toContain('NOT verified');
		} finally {
			warn.mockRestore();
		}
	});

	test('the dir the updater hands over is the configured one, resolved without being created', () => {
		expect(configuredProcessesDir()).toBe(PROCESSES);
	});
});
