/**
 * A1-01 owner ruling 5 — ONE AV BUILD PER COMPONENT ACROSS SERVER INSTANCES.
 *
 * The in-memory arbiter answers for one process; two instances sharing a media
 * tree each had their own, so each admitted a build of the same component. The
 * cross-process half is a lock FILE per component in the shared processes dir
 * (src/core/media/component_lock.ts), taken with the in-memory claim — memory
 * first, then the file — and released with it.
 *
 * Two MediaJobManager instances in this process stand for two processes: each
 * has its own registry and its own instance id, and they share one marked
 * scratch processes dir — exactly what two servers sharing DEDALO_MEDIA_PROCESSES_DIR
 * see. Pinned, each against its own mutation:
 *  - a claim / an exclusive submit / the pre-flight question on instance B is
 *    refused while instance A holds the component (claim, adopted claim, job);
 *    another component of the same record is free; the end of A's holder frees B;
 *  - a STALE lock is reclaimed (and logged): a dead pid on this host, a
 *    heartbeat older than the bound (another host), an unreadable file older
 *    than the bound (a crash mid-create), this instance's own leftover; a LIVE
 *    one (fresh heartbeat, fresh half-written file) is not;
 *  - a leftover reclaim mutex past the bound is cleared;
 *  - the holder refreshes its heartbeat; a release never deletes a lock that
 *    another instance reclaimed meanwhile.
 *
 * Pure job-manager situation: no record, no media file, no DB row — the
 * section ids are lock keys only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
	acquireComponentLock,
	componentLockFileName,
} from '../../src/core/media/component_lock.ts';
import { type JobTarget, MediaJobManager } from '../../src/core/media/jobs.ts';
import { mustGet } from '../helpers/assert.ts';
import { markProcessesDir } from '../helpers/media_scratch_root.ts';
import { refusalOfSync } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_component_lock');
const PROCESSES = join(ROOT, 'processes');
const LOCKS = join(PROCESSES, 'component_locks');
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;
const releases: (() => void)[] = [];

const target = (sectionId: number, component = 'test94', quality = '404'): JobTarget => ({
	section_tipo: 'test3',
	section_id: sectionId,
	component_tipo: component,
	lang: null,
	quality,
	scope: 'component',
});
const lockPath = (sectionId: number, component = 'test94'): string =>
	join(LOCKS, componentLockFileName(['test3', sectionId, component, ''].join('|')));
const lockOwner = (sectionId: number) =>
	JSON.parse(readFileSync(lockPath(sectionId), 'utf8')) as {
		instance: string;
		token: string;
		heartbeat_at: number;
		host: string;
		pid: number;
	};

const manager = (
	instanceId: string,
	extra: { lockStaleAfterMs?: number; lockHeartbeatMs?: number } = {},
) => new MediaJobManager({ budgets: { media: 2, maintenance: 2 }, instanceId, ...extra });

/** A gated exclusive job on `m` for `t`; returns its release. */
function liveJob(
	m: MediaJobManager,
	t: JobTarget,
	claim?: ReturnType<MediaJobManager['claimTarget']>,
) {
	let finish = (): void => {};
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	releases.push(finish);
	const record = m.submit('test_lock_job', async () => await gate, {
		lane: 'media',
		target: t,
		exclusive: true,
		...(claim ? { claim } : {}),
	});
	return { finish, id: record.id };
}

/** A pid that is certainly dead on this host: a child that already exited. */
function deadPid(): number {
	const child = Bun.spawnSync(['true']);
	return mustGet(child.pid, 'child pid');
}

/** Plant a foreign lock file for `sectionId`. */
function plant(sectionId: number, owner: Record<string, unknown>): void {
	writeFileSync(
		lockPath(sectionId),
		JSON.stringify({
			key: ['test3', sectionId, 'test94', ''].join('|'),
			holder: 'claim_x_1',
			token: 'planted-token',
			started_at: Date.now(),
			heartbeat_at: Date.now(),
			...owner,
		}),
	);
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(PROCESSES);
});

afterEach(() => {
	for (const release of releases.splice(0)) release();
});

afterAll(() => {
	if (previousProcessesDir === undefined)
		Reflect.deleteProperty(process.env, 'DEDALO_MEDIA_PROCESSES_DIR');
	else process.env.DEDALO_MEDIA_PROCESSES_DIR = previousProcessesDir;
	rmSync(ROOT, { recursive: true, force: true });
});

describe('two instances sharing one processes dir', () => {
	test('a claim on A refuses B (claim, exclusive submit, pre-flight); release frees B', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const claim = mustGet(a.claimTarget(target(1)), 'A claim');
		expect(existsSync(lockPath(1))).toBe(true);
		expect(lockOwner(1).instance).toBe('inst-a');
		// Another tier of the same component: still the component.
		expect(b.claimTarget(target(1, 'test94', '1080'))).toBeNull();
		expect(b.isOccupied(target(1, 'test94', '1080'))).toBe(true);
		const refused = refusalOfSync(() =>
			b.submit('test_lock_job', async () => null, {
				lane: 'media',
				target: target(1),
				exclusive: true,
			}),
		);
		expect(refused.code).toBe('media.build_running');
		// Another component of the same record is free.
		mustGet(b.claimTarget(target(1, 'test81')), 'B other component').release();
		claim.release();
		expect(existsSync(lockPath(1))).toBe(false);
		mustGet(b.claimTarget(target(1)), 'B after release').release();
	});

	test('an adopted claim and a running job keep the file; the job end frees B', async () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const claim = mustGet(a.claimTarget(target(2)), 'A claim');
		const job = liveJob(a, target(2), claim);
		claim.release(); // adopted: a no-op, the JOB holds the component
		expect(b.claimTarget(target(2))).toBeNull();
		expect(lockOwner(2).instance).toBe('inst-a');
		job.finish();
		await Bun.sleep(30);
		expect(existsSync(lockPath(2))).toBe(false);
		mustGet(b.claimTarget(target(2)), 'B after job').release();
	});

	test('an exclusive submit (no claim) holds the file under its job', async () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const job = liveJob(a, target(3));
		expect(b.claimTarget(target(3))).toBeNull();
		job.finish();
		await Bun.sleep(30);
		mustGet(b.claimTarget(target(3)), 'B after job').release();
	});

	test('an UNSCOPED target takes no file', () => {
		const a = manager('inst-a');
		const claim = mustGet(a.claimTarget({ ...target(4), scope: undefined }), 'unscoped');
		expect(existsSync(lockPath(4))).toBe(false);
		claim.release();
	});
});

describe('stale locks are reclaimed (and logged); live ones are not', () => {
	test('a dead pid on this host: reclaimed', () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			plant(10, { host: hostname(), pid: deadPid(), instance: 'inst-dead' });
			const claim = mustGet(manager('inst-b').claimTarget(target(10)), 'reclaim dead pid');
			expect(lockOwner(10).instance).toBe('inst-b');
			expect(errors.mock.calls.some((call) => String(call[0]).includes('reclaimed'))).toBe(true);
			claim.release();
		} finally {
			errors.mockRestore();
		}
	});

	test('a live pid of another instance with a fresh heartbeat: NOT reclaimed', () => {
		plant(11, { host: hostname(), pid: process.pid, instance: 'inst-live' });
		expect(manager('inst-b').claimTarget(target(11))).toBeNull();
		expect(lockOwner(11).instance).toBe('inst-live');
		rmSync(lockPath(11));
	});

	test('another host: fresh heartbeat holds, an old one is reclaimed', () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			plant(12, { host: 'elsewhere.invalid', pid: 1, instance: 'inst-far' });
			expect(manager('inst-b').claimTarget(target(12))).toBeNull();
			plant(12, {
				host: 'elsewhere.invalid',
				pid: 1,
				instance: 'inst-far',
				heartbeat_at: Date.now() - 10 * 60_000,
			});
			const claim = mustGet(manager('inst-b').claimTarget(target(12)), 'reclaim old heartbeat');
			expect(lockOwner(12).instance).toBe('inst-b');
			claim.release();
		} finally {
			errors.mockRestore();
		}
	});

	test('crash leftovers: an old unreadable lock is reclaimed, a fresh one is busy', () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			writeFileSync(lockPath(13), '');
			expect(manager('inst-b').claimTarget(target(13))).toBeNull();
			const old = new Date(Date.now() - 10 * 60_000);
			utimesSync(lockPath(13), old, old);
			const claim = mustGet(manager('inst-b').claimTarget(target(13)), 'reclaim crash leftover');
			expect(lockOwner(13).instance).toBe('inst-b');
			claim.release();
		} finally {
			errors.mockRestore();
		}
	});

	test("this instance's own leftover (not held in memory) is reclaimed", () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			plant(14, { host: hostname(), pid: process.pid, instance: 'inst-self' });
			const claim = mustGet(manager('inst-self').claimTarget(target(14)), 'own leftover');
			expect(lockOwner(14).token).not.toBe('planted-token');
			claim.release();
		} finally {
			errors.mockRestore();
		}
	});

	test('a leftover reclaim mutex past the bound is cleared; the next attempt reclaims', () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			plant(15, { host: hostname(), pid: deadPid(), instance: 'inst-dead' });
			const mutex = `${lockPath(15)}.reclaim`;
			writeFileSync(mutex, '{}');
			const old = new Date(Date.now() - 10 * 60_000);
			utimesSync(mutex, old, old);
			const b = manager('inst-b');
			expect(b.claimTarget(target(15))).toBeNull(); // this attempt clears the mutex
			expect(existsSync(mutex)).toBe(false);
			mustGet(b.claimTarget(target(15)), 'next attempt').release();
		} finally {
			errors.mockRestore();
		}
	});
});

describe('the reclaim race', () => {
	test('a lock that comes ALIVE between the stale judgment and the reclaim mutex is not removed', () => {
		// Instance X reads a stale lock; before X takes the reclaim mutex, Y has
		// already reclaimed it and holds it live. X must re-judge under the mutex
		// and back off — deleting Y's lock would admit two builds. The `now` seam
		// is the moment between X's first judgment and its mutex: Y's live lock is
		// planted there.
		plant(30, { host: hostname(), pid: deadPid(), instance: 'inst-dead' });
		let calls = 0;
		const handle = acquireComponentLock(['test3', 30, 'test94', ''].join('|'), 'claim_x_9', {
			dir: LOCKS,
			instance: 'inst-x',
			staleAfterMs: 120_000,
			holdsInMemory: () => false,
			now: () => {
				calls += 1;
				if (calls === 2)
					plant(30, { host: hostname(), pid: process.pid, instance: 'inst-y', token: 'y-live' });
				return Date.now();
			},
		});
		expect(handle).toBeNull();
		expect(lockOwner(30).token).toBe('y-live');
		expect(existsSync(`${lockPath(30)}.reclaim`)).toBe(false);
		rmSync(lockPath(30));
	});
});

describe('the holder', () => {
	test('refreshes its heartbeat while it holds the component', async () => {
		const a = manager('inst-a', { lockHeartbeatMs: 20 });
		const claim = mustGet(a.claimTarget(target(20)), 'claim');
		const first = lockOwner(20).heartbeat_at;
		await Bun.sleep(120);
		expect(lockOwner(20).heartbeat_at).toBeGreaterThan(first);
		claim.release();
	});

	test('a release never deletes a lock another instance reclaimed meanwhile', () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			// A never refreshes (1 h); B's bound is 1 ms, so B judges A stale.
			const a = manager('inst-a', { lockHeartbeatMs: 3_600_000 });
			const b = manager('inst-b', { lockStaleAfterMs: 1 });
			const claimA = mustGet(a.claimTarget(target(21)), 'A claim');
			Bun.sleepSync(5);
			const claimB = mustGet(b.claimTarget(target(21)), 'B reclaims');
			claimA.release();
			expect(existsSync(lockPath(21))).toBe(true);
			expect(lockOwner(21).instance).toBe('inst-b');
			claimB.release();
			expect(existsSync(lockPath(21))).toBe(false);
		} finally {
			errors.mockRestore();
		}
	});

	test('no residue: every lock and mutex this file took is gone', () => {
		const left = existsSync(LOCKS) ? readdirSync(LOCKS) : [];
		expect(left).toEqual([]);
	});
});
