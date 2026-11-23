/**
 * A1-01 owner ruling 5 — ONE AV BUILD PER COMPONENT ACROSS SERVER INSTANCES —
 * and the review of it (M1, M2, L1–L4, L7).
 *
 * The in-memory arbiter answers for one process; two instances sharing a media
 * tree each had their own, so each admitted a build of the same component. The
 * cross-process half is a lock FILE per component in the shared processes dir
 * (src/core/media/component_lock.ts), taken with the in-memory claim — memory
 * first, then the file — and released with it.
 *
 * Two MediaJobManager instances in this process stand for two processes: each
 * has its own registry and instance id, and they share one marked scratch
 * processes dir. A lock of ANOTHER machine is planted (host ≠ HOST_ID), since
 * two managers of one process are, correctly, one process to the lock. Every
 * clock is INJECTED and every heartbeat is a manual tick (`heartbeatNow`), so
 * nothing here waits on wall time. Pinned, each against its own mutation:
 *  - a claim / an exclusive submit / the pre-flight on B is refused while A
 *    holds the component; the end of A's holder frees B; an adopted claim's
 *    lock names the job (L7);
 *  - staleness: a dead pid on this machine (immediate); a live pid answering
 *    EPERM is alive (L2); another boot of this hostname is not judged by pid
 *    (L2); this process's pid with a token no manager here holds (L3);
 *    another machine: only a heartbeat SEEN unchanged for the bound on the
 *    reader's own clock — skewed wall clocks never make a live lock stale (M1);
 *    an unreadable lock likewise; a leftover mutex likewise (L1);
 *  - CAS: a lock replaced between the stale judgment and the reclaim is put
 *    back; a release / a refresh racing a steal never touches the new owner's
 *    lock (M2);
 *  - the holder: a manual tick beats; a lost hold aborts and FAILS its job; a
 *    job whose lock was stolen publishes nothing — no rename, no write-back (M1);
 *    a deadline keeps the component until the worker settles (L4); a shutdown
 *    releases held claims' locks (L3); a raw filesystem failure is typed (L1).
 *
 * Pure job-manager situation: no record, no media file, no DB row — the
 * section ids are lock keys only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { writeAtomically } from '../../src/core/media/atomic.ts';
import { AvRecordHold, withAvComponentClaim } from '../../src/core/media/av_component_claim.ts';
import { persistTranscodedOrReport } from '../../src/core/media/av_versions.ts';
import {
	acquireComponentLock,
	type ComponentLockContext,
	type ComponentShareHooks,
	componentLockBusy,
	componentLockFileName,
	componentLockHolder,
	componentLockIsOurs,
	componentShareDir,
	HOST_ID,
	heartbeatPath,
	refreshComponentLock,
	releaseComponentLock,
	staleReason,
} from '../../src/core/media/component_lock.ts';
import { moveToDeleted } from '../../src/core/media/file_ops.ts';
import { assertJobHold } from '../../src/core/media/job_scope.ts';
import { type JobTarget, MediaJobManager } from '../../src/core/media/jobs.ts';
import { MOUNT_REVERIFY_MS } from '../../src/core/media/processes_mount.ts';
import { mustGet } from '../helpers/assert.ts';
import { markMediaRoot, markProcessesDir } from '../helpers/media_scratch_root.ts';
import { refusalOf, refusalOfSync } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_component_lock');
const PROCESSES = join(ROOT, 'processes');
const LOCKS = join(PROCESSES, 'component_locks');
const OUT = join(ROOT, 'out');
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;
const releases: (() => void)[] = [];
const BOUND = 1_000;

const keyOf = (sectionId: number, component = 'test94'): string =>
	['test3', sectionId, component, ''].join('|');
const target = (sectionId: number, component = 'test94', quality = '404'): JobTarget => ({
	section_tipo: 'test3',
	section_id: sectionId,
	component_tipo: component,
	lang: null,
	quality,
	scope: 'component',
});
const lockPath = (sectionId: number, component = 'test94'): string =>
	join(LOCKS, componentLockFileName(keyOf(sectionId, component)));
const lockOwner = (sectionId: number) =>
	JSON.parse(readFileSync(lockPath(sectionId), 'utf8')) as {
		instance: string;
		token: string;
		host: string;
		pid: number;
	};
const beatOf = (sectionId: number, token: string): number =>
	(JSON.parse(readFileSync(heartbeatPath(lockPath(sectionId), token), 'utf8')) as { beat: number })
		.beat;

/** A settable reader clock. */
function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

const manager = (
	instanceId: string,
	extra: {
		lockStaleAfterMs?: number;
		lockClock?: () => number;
		deadlineMs?: number;
		lockShareHooks?: ComponentShareHooks;
	} = {},
) =>
	new MediaJobManager({
		budgets: { media: 2, maintenance: 2 },
		instanceId,
		lockHeartbeatMs: 0,
		lockStaleAfterMs: extra.lockStaleAfterMs ?? BOUND,
		...(extra.lockClock === undefined ? {} : { lockClock: extra.lockClock }),
		...(extra.lockShareHooks === undefined ? {} : { lockShareHooks: extra.lockShareHooks }),
		...(extra.deadlineMs === undefined ? {} : { deadlinesMs: { media: extra.deadlineMs } }),
	});

/** A gated exclusive job on `m` for `t`; `body` runs after the gate opens. */
function liveJob(
	m: MediaJobManager,
	t: JobTarget,
	claim?: ReturnType<MediaJobManager['claimTarget']>,
	body: () => Promise<unknown> = async () => null,
) {
	let finish = (): void => {};
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	releases.push(finish);
	const record = m.submit(
		'test_lock_job',
		async () => {
			await gate;
			return await body();
		},
		{ lane: 'media', target: t, exclusive: true, ...(claim ? { claim } : {}) },
	);
	return { finish, id: record.id };
}

/** Wait until the job is terminal (bounded; never a fixed sleep as the assertion). */
async function settled(m: MediaJobManager, id: string): Promise<string> {
	for (let i = 0; i < 200; i += 1) {
		const status = m.status(id)?.status;
		if (status !== 'queued' && status !== 'running') return String(status);
		await Bun.sleep(5);
	}
	throw new Error(`job ${id} never settled`);
}

/** Wait until the job's worker runs (bounded). */
async function running(m: MediaJobManager, id: string): Promise<void> {
	for (let i = 0; i < 200; i += 1) {
		if (m.status(id)?.status === 'running') return;
		await Bun.sleep(5);
	}
	throw new Error(`job ${id} never ran`);
}

/** A pid that is certainly dead on this machine: a child that already exited. */
function deadPid(): number {
	return mustGet(Bun.spawnSync(['true']).pid, 'child pid');
}

/** Plant a lock (and optionally its heartbeat) for `sectionId`. */
function plant(sectionId: number, owner: Record<string, unknown>, beat?: number): string {
	const token = String(owner.token ?? 'planted-token');
	writeFileSync(
		lockPath(sectionId),
		JSON.stringify({
			key: keyOf(sectionId),
			token,
			started_at: Date.now(),
			...owner,
		}),
	);
	if (beat !== undefined) {
		writeFileSync(heartbeatPath(lockPath(sectionId), token), JSON.stringify({ beat, holder: 'x' }));
	}
	return token;
}

/** The names in the locks dir that are siblings of section `sectionId`'s lock. */
const siblingsOf = (sectionId: number): string[] => {
	const base = componentLockFileName(keyOf(sectionId));
	return readdirSync(LOCKS).filter((name) => name.startsWith(`${base}.`));
};

/** Remove a planted lock and its heartbeat. */
function unplant(sectionId: number, token = 'planted-token'): void {
	rmSync(lockPath(sectionId), { force: true });
	rmSync(heartbeatPath(lockPath(sectionId), token), { force: true });
}

const FAR = { host: 'elsewhere.invalid#boot#1', pid: 1, instance: 'inst-far' };

/** Swallow the expected reclaim/loss log lines of one test. */
function quietErrors<T>(fn: () => T): T {
	const errors = spyOn(console, 'error').mockImplementation(() => {});
	try {
		return fn();
	} finally {
		errors.mockRestore();
	}
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
		mustGet(b.claimTarget(target(1, 'test81')), 'B other component').release();
		claim.release();
		expect(existsSync(lockPath(1))).toBe(false);
		mustGet(b.claimTarget(target(1)), 'B after release').release();
	});

	test('an adopted claim keeps the file, relabelled to the JOB (L7); the job end frees B', async () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const claim = mustGet(a.claimTarget(target(2)), 'A claim');
		expect(componentLockHolder(lockPath(2))).toBe(claim.id);
		const job = liveJob(a, target(2), claim);
		claim.release(); // adopted: a no-op, the JOB holds the component
		expect(b.claimTarget(target(2))).toBeNull();
		expect(componentLockHolder(lockPath(2))).toBe(job.id);
		job.finish();
		expect(await settled(a, job.id)).toBe('done');
		expect(existsSync(lockPath(2))).toBe(false);
		mustGet(b.claimTarget(target(2)), 'B after job').release();
	});

	test('an exclusive submit (no claim) holds the file under its job', async () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const job = liveJob(a, target(3));
		expect(b.claimTarget(target(3))).toBeNull();
		job.finish();
		await settled(a, job.id);
		mustGet(b.claimTarget(target(3)), 'B after job').release();
	});

	test('an UNSCOPED target takes no file', () => {
		const a = manager('inst-a');
		const claim = mustGet(a.claimTarget({ ...target(4), scope: undefined }), 'unscoped');
		expect(existsSync(lockPath(4))).toBe(false);
		claim.release();
	});
});

describe('stale locks: judged on this machine by pid, elsewhere by an OBSERVED heartbeat', () => {
	test('a dead pid on this machine: reclaimed at once', () => {
		quietErrors(() => {
			plant(10, { host: HOST_ID, pid: deadPid(), instance: 'inst-dead' });
			const claim = mustGet(manager('inst-b').claimTarget(target(10)), 'reclaim dead pid');
			expect(lockOwner(10).instance).toBe('inst-b');
			claim.release();
		});
	});

	test('a pid answering EPERM is ALIVE (L2): never reclaimed by the pid rule', () => {
		// pid 1 exists and belongs to root: signal 0 from this user is EPERM (as
		// root it simply succeeds — alive either way).
		plant(11, { host: HOST_ID, pid: 1, instance: 'inst-init' }, 0);
		expect(manager('inst-b').claimTarget(target(11))).toBeNull();
		expect(lockOwner(11).instance).toBe('inst-init');
		unplant(11);
	});

	test('another BOOT of this hostname is not judged by its pid (L2) — only by its heartbeat', () => {
		const time = clock();
		const b = manager('inst-b', { lockClock: time.now });
		plant(12, { host: `${hostname()}#another-boot#1`, pid: deadPid(), instance: 'inst-old' }, 0);
		expect(b.claimTarget(target(12))).toBeNull(); // the dead pid is not ours to judge
		time.advance(BOUND + 1);
		quietErrors(() => mustGet(b.claimTarget(target(12)), 'heartbeat unchanged').release());
	});

	test("this process's pid with a token no manager here holds: reclaimed at once (L3)", () => {
		quietErrors(() => {
			plant(13, { host: HOST_ID, pid: process.pid, instance: 'inst-gone' });
			const claim = mustGet(manager('inst-b').claimTarget(target(13)), 'own-pid leftover');
			expect(lockOwner(13).token).not.toBe('planted-token');
			claim.release();
		});
	});

	test('another machine: a heartbeat SEEN unchanged for the bound is stale; a beating one never', () => {
		const time = clock();
		const b = manager('inst-b', { lockClock: time.now });
		plant(14, FAR, 0);
		expect(b.claimTarget(target(14))).toBeNull(); // first sighting: never stale
		time.advance(BOUND / 2);
		writeFileSync(heartbeatPath(lockPath(14), 'planted-token'), '{"beat":1,"holder":"x"}');
		time.advance(BOUND / 2 + 10);
		expect(b.claimTarget(target(14))).toBeNull(); // it beat: the count restarted
		time.advance(BOUND + 1);
		quietErrors(() => mustGet(b.claimTarget(target(14)), 'unchanged past the bound').release());
	});

	test('skewed clocks never make a live lock stale (M1): no written time is compared', () => {
		const time = clock();
		const b = manager('inst-b', { lockClock: time.now });
		// A holder whose wall clock is a day behind (or ahead) of ours, still beating.
		for (const skew of [-86_400_000, 86_400_000]) {
			plant(15, { ...FAR, started_at: Date.now() + skew, heartbeat_at: Date.now() + skew }, 0);
			for (let beat = 1; beat <= 3; beat += 1) {
				expect(b.claimTarget(target(15))).toBeNull();
				time.advance(BOUND + 1);
				writeFileSync(
					heartbeatPath(lockPath(15), 'planted-token'),
					JSON.stringify({ beat, holder: 'x' }),
				);
			}
			expect(b.claimTarget(target(15))).toBeNull();
			unplant(15);
		}
	});

	test('crash leftovers: an unreadable lock is busy until SEEN unchanged for the bound', () => {
		const time = clock();
		const b = manager('inst-b', { lockClock: time.now });
		writeFileSync(lockPath(16), '');
		expect(b.claimTarget(target(16))).toBeNull();
		time.advance(BOUND + 1);
		quietErrors(() => {
			const claim = mustGet(b.claimTarget(target(16)), 'reclaim crash leftover');
			expect(lockOwner(16).instance).toBe('inst-b');
			claim.release();
		});
	});

	test('a leftover reclaim mutex SEEN unchanged for the bound is cleared (L1); the next attempt reclaims', () => {
		const time = clock();
		const b = manager('inst-b', { lockClock: time.now });
		plant(17, { host: HOST_ID, pid: deadPid(), instance: 'inst-dead' });
		const mutex = `${lockPath(17)}.reclaim`;
		writeFileSync(mutex, 'crashed');
		expect(b.claimTarget(target(17))).toBeNull(); // first sighting of the mutex
		expect(existsSync(mutex)).toBe(true);
		time.advance(BOUND + 1);
		expect(b.claimTarget(target(17))).toBeNull(); // this attempt clears it
		expect(existsSync(mutex)).toBe(false);
		quietErrors(() => mustGet(b.claimTarget(target(17)), 'next attempt').release());
	});
});

describe('compare-and-swap (M2, L1)', () => {
	const context = (now: () => number): ComponentLockContext => ({
		dir: LOCKS,
		instance: 'inst-x',
		staleAfterMs: BOUND,
		observations: new Map(),
		now,
	});

	test('a lock replaced between the stale judgment and the reclaim is put back, not removed', () => {
		// X judges an old unreadable lock stale; before X takes it aside, Y has
		// replaced it with a live lock. X's CAS sees another file and restores it.
		writeFileSync(lockPath(30), '');
		const time = clock();
		const ctx = context(time.now);
		expect(acquireComponentLock(keyOf(30), 'claim_x_1', ctx)).toBeNull();
		time.advance(BOUND + 1);
		let calls = 0;
		const racing = context(() => {
			calls += 1;
			// Call 1: the first judgment. Call 2: the re-judgment under the mutex —
			// AFTER it read the lock it judged; Y's live lock lands right there.
			if (calls === 2) plant(30, { ...FAR, instance: 'inst-y', token: 'y-live' }, 0);
			return time.now();
		});
		racing.observations = ctx.observations;
		quietErrors(() => expect(acquireComponentLock(keyOf(30), 'claim_x_2', racing)).toBeNull());
		expect(lockOwner(30).token).toBe('y-live');
		expect(existsSync(`${lockPath(30)}.reclaim`)).toBe(false);
		unplant(30, 'y-live');
	});

	test('a stale lock replaced by a LIVE one before the reclaim is put back (token CAS)', () => {
		plant(36, { ...FAR, token: 'far-old' }, 0);
		const time = clock();
		const ctx = context(time.now);
		expect(acquireComponentLock(keyOf(36), 'claim_x_1', ctx)).toBeNull(); // first sighting
		time.advance(BOUND + 1);
		let calls = 0;
		const racing = context(() => {
			calls += 1;
			if (calls === 2) {
				// Another instance reclaimed it first: its fresh lock replaces far-old.
				unplant(36, 'far-old');
				plant(36, { ...FAR, instance: 'inst-y', token: 'y-live' }, 0);
			}
			return time.now();
		});
		racing.observations = ctx.observations;
		quietErrors(() => expect(acquireComponentLock(keyOf(36), 'claim_x_2', racing)).toBeNull());
		expect(lockOwner(36).token).toBe('y-live');
		expect(beatOf(36, 'y-live')).toBe(0);
		unplant(36, 'y-live');
	});

	test('a stale MUTEX re-created by another reclaimer before the clear is put back (L1)', () => {
		plant(37, { host: HOST_ID, pid: deadPid(), instance: 'inst-dead' });
		const mutex = `${lockPath(37)}.reclaim`;
		writeFileSync(mutex, 'crashed');
		const time = clock();
		const ctx = context(time.now);
		expect(acquireComponentLock(keyOf(37), 'claim_x_1', ctx)).toBeNull(); // first sighting
		time.advance(BOUND + 1);
		const racing = context(() => {
			// The clear judged the crashed mutex; another reclaimer replaced it first.
			rmSync(mutex);
			writeFileSync(mutex, 'a live reclaimer, a different file');
			return time.now();
		});
		racing.observations = ctx.observations;
		expect(acquireComponentLock(keyOf(37), 'claim_x_2', racing)).toBeNull();
		expect(readFileSync(mutex, 'utf8')).toBe('a live reclaimer, a different file');
		rmSync(mutex);
		unplant(37);
	});

	test('THREE PARTIES: a stale release never empties the path — a third acquirer finds it held (F2)', () => {
		// A acquired, then lost its lock (reclaimed: B holds it now). A releases,
		// unaware; in A's CAS window C tries to acquire. The check must never have
		// vacated the path: C is refused and B still holds ITS lock on disk.
		const a = mustGet(
			acquireComponentLock(
				keyOf(31),
				'claim_a',
				context(() => 0),
			),
			'A',
		);
		rmSync(lockPath(31));
		const b = mustGet(
			acquireComponentLock(
				keyOf(31),
				'claim_b',
				context(() => 0),
			),
			'B',
		);
		let c: ReturnType<typeof acquireComponentLock> = null;
		releaseComponentLock(a, {
			between: () => {
				c = acquireComponentLock(
					keyOf(31),
					'claim_c',
					context(() => 0),
				);
			},
		});
		expect(c).toBeNull();
		expect(componentLockIsOurs(b)).toBe(true);
		expect(existsSync(heartbeatPath(lockPath(31), b.token))).toBe(true);
		expect(existsSync(heartbeatPath(lockPath(31), a.token))).toBe(false);
		expect(siblingsOf(31).filter((name) => name.includes('-peek'))).toEqual([]);
		releaseComponentLock(b);
		expect(existsSync(lockPath(31))).toBe(false);
	});

	test('a lock replaced AFTER the CAS check and before the rename is put back (inode CAS, F2)', () => {
		const a = mustGet(
			acquireComponentLock(
				keyOf(38),
				'claim_a',
				context(() => 0),
			),
			'A',
		);
		quietErrors(() =>
			releaseComponentLock(a, {
				beforeRename: () => {
					// The peek said "ours"; right then the path is reclaimed by another.
					rmSync(lockPath(38));
					plant(38, { ...FAR, token: 'thief' }, 0);
				},
			}),
		);
		expect(lockOwner(38).token).toBe('thief');
		expect(beatOf(38, 'thief')).toBe(0);
		expect(siblingsOf(38).filter((name) => !name.includes('thief'))).toEqual([]);
		unplant(38, 'thief');
	});

	test("a release of a lock reclaimed from us puts the new owner's lock back", () => {
		const ctx = context(() => 0);
		const a = mustGet(acquireComponentLock(keyOf(32), 'claim_a', ctx), 'A');
		rmSync(lockPath(32));
		plant(32, { ...FAR, token: 'thief' }, 0);
		quietErrors(() => releaseComponentLock(a));
		expect(lockOwner(32).token).toBe('thief');
		expect(beatOf(32, 'thief')).toBe(0);
		unplant(32, 'thief');
	});

	test("a refresh racing a steal writes only its OWN heartbeat — never the new owner's", () => {
		const ctx = context(() => 0);
		const a = mustGet(acquireComponentLock(keyOf(33), 'claim_a', ctx), 'A');
		const refreshed = refreshComponentLock(a, {
			between: () => {
				rmSync(lockPath(33));
				plant(33, { ...FAR, token: 'thief' }, 0);
			},
		});
		expect(refreshed).toBe(true); // it checked before the steal
		expect(lockOwner(33).token).toBe('thief');
		expect(beatOf(33, 'thief')).toBe(0);
		expect(refreshComponentLock(a)).toBe(false); // the next beat sees the loss
		quietErrors(() => releaseComponentLock(a));
		expect(lockOwner(33).token).toBe('thief');
		unplant(33, 'thief');
	});

	test('a release whose files are already gone does not throw (ENOENT tolerated)', () => {
		const a = mustGet(
			acquireComponentLock(
				keyOf(34),
				'claim_a',
				context(() => 0),
			),
			'A',
		);
		rmSync(lockPath(34));
		rmSync(heartbeatPath(lockPath(34), a.token));
		quietErrors(() => releaseComponentLock(a));
		expect(existsSync(lockPath(34))).toBe(false);
	});

	test('a raw filesystem failure is TYPED (media.operation_failed), never a bare error', () => {
		const notADir = join(ROOT, 'not_a_dir');
		writeFileSync(notADir, 'x');
		const error = refusalOfSync(() =>
			acquireComponentLock(keyOf(35), 'claim_a', { ...context(() => 0), dir: notADir }),
		);
		expect(error).toBeInstanceOf(DedaloError);
		expect(error.code).toBe('media.operation_failed');
		rmSync(notADir);
	});
});

describe('what cannot be read is busy (F1)', () => {
	const context = (now: () => number): ComponentLockContext => ({
		dir: LOCKS,
		instance: 'inst-x',
		staleAfterMs: BOUND,
		observations: new Map(),
		now,
	});

	test('an UNREADABLE live lock with a beating heartbeat is never reclaimed', () => {
		plant(50, { ...FAR, token: 'far-live' }, 0);
		chmodSync(lockPath(50), 0o200); // EACCES for this reader, as for a foreign uid
		const time = clock();
		const ctx = context(time.now);
		try {
			let beat = 0;
			for (const step of [0, BOUND / 2, BOUND + 1, 3 * BOUND]) {
				time.advance(step);
				writeFileSync(
					heartbeatPath(lockPath(50), 'far-live'),
					JSON.stringify({ beat: ++beat, holder: 'x' }),
				);
				expect(quietErrors(() => acquireComponentLock(keyOf(50), 'claim_x', ctx))).toBeNull();
				expect(quietErrors(() => componentLockBusy(keyOf(50), ctx))).toBe(true);
			}
		} finally {
			chmodSync(lockPath(50), 0o640);
		}
		expect(lockOwner(50).token).toBe('far-live');
		unplant(50, 'far-live');
	});

	test('an unreadable lock is logged as BUSY, never judged stale, even with no heartbeat at all', () => {
		plant(51, { ...FAR, token: 'far-mute' });
		chmodSync(lockPath(51), 0o200);
		const time = clock();
		const ctx = context(time.now);
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(acquireComponentLock(keyOf(51), 'claim_x', ctx)).toBeNull();
			time.advance(10 * BOUND);
			expect(acquireComponentLock(keyOf(51), 'claim_x', ctx)).toBeNull();
			expect(errors.mock.calls.flat().join(' ')).toContain('treated as BUSY, never reclaimed');
		} finally {
			errors.mockRestore();
			chmodSync(lockPath(51), 0o640);
		}
		expect(lockOwner(51).token).toBe('far-mute');
		unplant(51, 'far-mute');
	});

	test("a TRANSIENT read error of the holder's own lock is retried, not a loss", () => {
		const a = mustGet(
			acquireComponentLock(
				keyOf(52),
				'claim_a',
				context(() => 0),
			),
			'A',
		);
		const read = spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
			throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
		});
		try {
			expect(componentLockIsOurs(a)).toBe(true);
		} finally {
			read.mockRestore();
		}
		releaseComponentLock(a);
	});

	test("a PERSISTENT read error of the holder's own lock is loud (typed), never 'lost'; the heartbeat keeps beating", () => {
		const a = mustGet(
			acquireComponentLock(
				keyOf(53),
				'claim_a',
				context(() => 0),
			),
			'A',
		);
		chmodSync(lockPath(53), 0o200);
		try {
			const error = refusalOfSync(() => componentLockIsOurs(a));
			expect(error).toBeInstanceOf(DedaloError);
			expect(error.code).toBe('media.operation_failed');
			expect(quietErrors(() => refreshComponentLock(a))).toBe(true);
			expect(beatOf(53, a.token)).toBe(1);
		} finally {
			chmodSync(lockPath(53), 0o640);
		}
		expect(componentLockIsOurs(a)).toBe(true);
		releaseComponentLock(a);
	});
});

describe('what cannot be stat-ed is not gone (F1)', () => {
	test("a malformed lock whose stat fails (EIO) is never judged 'gone' — the error is loud", () => {
		writeFileSync(lockPath(56), '');
		const ctx: ComponentLockContext = {
			dir: LOCKS,
			instance: 'inst-x',
			staleAfterMs: BOUND,
			observations: new Map(),
			now: () => 0,
		};
		const stat = spyOn(fs, 'statSync').mockImplementation(() => {
			throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
		});
		try {
			expect(() => staleReason(null, lockPath(56), ctx)).toThrow('EIO');
		} finally {
			stat.mockRestore();
		}
		rmSync(lockPath(56));
	});
});

describe('orphans are swept (F6)', () => {
	test("a held lock's crashed siblings go once SEEN unchanged for the bound; a changing one stays", () => {
		const time = clock();
		const ctx: ComponentLockContext = {
			dir: LOCKS,
			instance: 'inst-x',
			staleAfterMs: BOUND,
			observations: new Map(),
			now: time.now,
		};
		const path = lockPath(54);
		const orphans = [
			heartbeatPath(path, 'crashed-token'),
			`${path}.crashed-token.new`,
			`${heartbeatPath(path, 'crashed-token')}.tmp.123.abc`,
			`${path}.reclaim`, // a mutex left without its lock
			`${path}.release-peek.99.uuid`,
			`${path}.reclaim.99.uuid`,
		];
		const changing = `${path}.other-token.hb`;
		const neighbour = `${lockPath(55)}.crashed-token.new`; // another lock's file
		const vanishing = `${path}.gone-token.hb`; // removed by someone else between sightings
		for (const file of [...orphans, changing, neighbour, vanishing]) writeFileSync(file, 'x');
		const first = mustGet(acquireComponentLock(keyOf(54), 'claim_a', ctx), 'first');
		for (const file of orphans) expect(existsSync(file)).toBe(true); // first sighting only
		releaseComponentLock(first);
		time.advance(BOUND + 1);
		writeFileSync(changing, 'changed meanwhile');
		rmSync(vanishing);
		const second = quietErrors(() =>
			mustGet(acquireComponentLock(keyOf(54), 'claim_b', ctx), 'second'),
		);
		for (const file of orphans) expect(existsSync(file)).toBe(false);
		expect(existsSync(changing)).toBe(true);
		expect(existsSync(neighbour)).toBe(true);
		expect(existsSync(heartbeatPath(path, second.token))).toBe(true);
		expect(componentLockIsOurs(second)).toBe(true);
		// The reader forgets what it no longer sees (no unbounded observation map).
		const watched = [...ctx.observations.keys()].filter((key) => key.startsWith('orphan:'));
		expect(watched.sort()).toEqual(
			[`orphan:${changing}`, `orphan:${heartbeatPath(path, second.token)}`].sort(),
		);
		releaseComponentLock(second);
		rmSync(changing);
		rmSync(neighbour);
	});
});

describe('host identity', () => {
	test('HOST_ID carries a per-boot part on the platforms that have one (Linux boot_id, macOS kern.bootsessionuuid)', () => {
		const [host, boot] = HOST_ID.split('#');
		expect(host).toBe(hostname());
		if (process.platform === 'linux' || process.platform === 'darwin') {
			expect(boot?.length ?? 0).toBeGreaterThan(8);
		}
	});

	test.skipIf(process.platform !== 'darwin')(
		'the boot part does not depend on PATH: a launchd PATH (/usr/bin:/bin, no /usr/sbin) gives the same identity (N2 — darwin only: the sysctl leg)',
		() => {
			const probe = Bun.spawnSync(
				[
					process.execPath,
					'-e',
					"const m = await import('./src/core/media/component_lock.ts'); console.log(m.HOST_ID)",
				],
				{
					cwd: join(import.meta.dir, '..', '..'),
					env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			expect(probe.stdout.toString().trim()).toBe(HOST_ID);
			expect(probe.stderr.toString()).not.toContain('did not answer');
		},
	);
});

/** A per-lang component target of record `sectionId`. */
const langTarget = (sectionId: number, lang: string, component = 'test94'): JobTarget => ({
	...target(sectionId, component),
	lang,
});

/** Steal the lock at `path` for a far, live owner (another instance reclaimed it). */
function stealLock(path: string, token = 'thief'): void {
	rmSync(path);
	writeFileSync(path, JSON.stringify({ key: 'stolen', started_at: Date.now(), ...FAR, token }));
	writeFileSync(heartbeatPath(path, token), JSON.stringify({ beat: 0, holder: 'x' }));
}

/** Drop a stolen lock and its heartbeat. */
function dropStolen(path: string, token = 'thief'): void {
	rmSync(path, { force: true });
	rmSync(heartbeatPath(path, token), { force: true });
}

/** Run `fn` while the locks dir refuses every write: a refusal that touches no file passes, one that does throws. */
function withLocksDirReadOnly<T>(fn: () => T): T {
	chmodSync(LOCKS, 0o500);
	try {
		return fn();
	} finally {
		chmodSync(LOCKS, 0o750);
	}
}

describe('claims re-check their hold (F3)', () => {
	test('work UNDER a claim whose lock was stolen does not rename its output into place', async () => {
		const a = manager('inst-a');
		const claim = mustGet(a.claimTarget(target(60)), 'claim');
		const out = join(OUT, 'claim_60.mp4');
		stealLock(lockPath(60));
		const refused = await refusalOf(
			a.runUnderClaim(claim, () =>
				writeAtomically(out, async (temp) => writeFileSync(temp, 'conformed')),
			),
		);
		expect(refused.code).toBe('media.build_running');
		expect(existsSync(out)).toBe(false);
		quietErrors(() => claim.release());
		expect(lockOwner(60).token).toBe('thief'); // the new owner's lock untouched
		dropStolen(lockPath(60));
	});

	test('a claim still held publishes; a released claim checks nothing', async () => {
		const a = manager('inst-a');
		const claim = mustGet(a.claimTarget(target(61)), 'claim');
		const out = join(OUT, 'claim_61.mp4');
		await a.runUnderClaim(claim, () =>
			writeAtomically(out, async (temp) => writeFileSync(temp, 'ok')),
		);
		expect(existsSync(out)).toBe(true);
		claim.release();
		expect(() => a.assertClaimHolds(claim.id)).not.toThrow();
		rmSync(out);
	});

	test('a claim whose lock was stolen is never ADOPTED by its job', () => {
		const a = manager('inst-a');
		const claim = mustGet(a.claimTarget(target(62)), 'claim');
		stealLock(lockPath(62));
		const refused = quietErrors(() =>
			refusalOfSync(() =>
				a.submit('test_lock_job', async () => null, {
					lane: 'media',
					target: target(62),
					exclusive: true,
					claim,
				}),
			),
		);
		expect(refused.code).toBe('media.build_running');
		quietErrors(() => claim.release());
		expect(lockOwner(62).token).toBe('thief');
		dropStolen(lockPath(62));
	});

	test('withAvComponentClaim runs its operation under the claim: a stolen hold publishes nothing', async () => {
		const av = mustGet(mediaTypeOf('component_av'), 'av spec');
		const identity = { sectionTipo: 'test3', sectionId: 63, componentTipo: 'test94', lang: null };
		const out = join(OUT, 'conform_63.mp4');
		const refused = await quietErrors(() =>
			refusalOf(
				withAvComponentClaim(av, identity, 'conform', async () => {
					stealLock(lockPath(63)); // reclaimed while the operation awaited
					await writeAtomically(out, async (temp) => writeFileSync(temp, 'remuxed'));
				}),
			),
		);
		expect(refused.code).toBe('media.build_running');
		expect(existsSync(out)).toBe(false);
		expect(lockOwner(63).token).toBe('thief');
		dropStolen(lockPath(63));
	});

	test('a record hold re-checks a component it already holds: reclaimed meanwhile → refused', () => {
		const hold = new AvRecordHold('test3', 64);
		expect(hold.takeComponents(['test94'])).toBe(true);
		expect(() => hold.require('test94')).not.toThrow();
		const all = join(LOCKS, componentLockFileName('test3|64|test94|*'));
		stealLock(all);
		expect(quietErrors(() => refusalOfSync(() => hold.require('test94'))).code).toBe(
			'media.build_running',
		);
		quietErrors(() => hold.release());
		expect(JSON.parse(readFileSync(all, 'utf8')).token).toBe('thief');
		dropStolen(all);
	});
});

describe('whole-component claims: every lang (F4)', () => {
	test('while held, a build in ANY lang is refused — on this instance and on another; released, both pass', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const claims = mustGet(a.claimWholeComponents('test3', 65, ['test94'], 'record_media'), 'all');
		for (const lang of ['lg-fra', 'lg-eng']) {
			expect(a.claimTarget(langTarget(65, lang))).toBeNull();
			expect(b.claimTarget(langTarget(65, lang))).toBeNull();
			expect(b.isOccupied(langTarget(65, lang))).toBe(true);
		}
		expect(b.claimTarget(target(65))).toBeNull();
		// Another component of the record is not held.
		const neighbour = mustGet(b.claimTarget(target(65, 'test81')), 'neighbour');
		neighbour.release();
		for (const claim of claims) claim.release();
		for (const m of [a, b]) {
			const freed = mustGet(m.claimTarget(langTarget(65, 'lg-fra')), 'freed');
			freed.release();
		}
	});

	test('any lang held — here or elsewhere — refuses the whole claim, and nothing it took stays held', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		for (const holder of [a, b]) {
			const lang = mustGet(holder.claimTarget(langTarget(66, 'lg-deu')), 'lang claim');
			expect(a.claimWholeComponents('test3', 66, ['test81', 'test94'], 'record_media')).toBeNull();
			const other = mustGet(b.claimTarget(target(66, 'test81')), 'test81 given back');
			other.release();
			lang.release();
		}
		const claims = mustGet(
			a.claimWholeComponents('test3', 66, ['test81', 'test94'], 'record_media'),
			'free now',
		);
		expect(b.claimWholeComponents('test3', 66, ['test94'], 'record_media')).toBeNull();
		for (const claim of claims) claim.release();
	});

	test('on ONE instance the refusals are answered in memory, before any lock file is touched', () => {
		const a = manager('inst-a');
		const whole = mustGet(a.claimWholeComponents('test3', 67, ['test94'], 'record_media'), 'all');
		expect(withLocksDirReadOnly(() => a.claimTarget(langTarget(67, 'lg-ita')))).toBeNull();
		for (const claim of whole) claim.release();
		const lang = mustGet(a.claimTarget(langTarget(68, 'lg-ita')), 'lang');
		expect(
			withLocksDirReadOnly(() => a.claimWholeComponents('test3', 68, ['test94'], 'record_media')),
		).toBeNull();
		lang.release();
	});

	test('a whole-component target is a claim only: never claimTarget, never a job', () => {
		const a = manager('inst-a');
		const whole: JobTarget = { ...target(69), scope: 'component_all' };
		expect(refusalOfSync(() => a.claimTarget(whole)).code).toBe('internal.invariant');
		expect(
			refusalOfSync(() =>
				a.submit('test_lock_job', async () => null, {
					lane: 'media',
					target: whole,
					exclusive: true,
				}),
			).code,
		).toBe('internal.invariant');
	});
});

/** The component key (section|id|component) and the whole-component lock path of record `sectionId`. */
const componentKey = (sectionId: number, component = 'test94'): string =>
	['test3', sectionId, component].join('|');
const wholePath = (sectionId: number, component = 'test94'): string =>
	join(LOCKS, componentLockFileName(`${componentKey(sectionId, component)}|*`));
const shareDirOf = (sectionId: number, component = 'test94'): string =>
	componentShareDir(LOCKS, componentKey(sectionId, component));
const shareEntries = (sectionId: number): string[] =>
	existsSync(shareDirOf(sectionId)) && statSync(shareDirOf(sectionId)).isDirectory()
		? readdirSync(shareDirOf(sectionId))
		: [];
/** After the last lang left: the share dir STAYS, empty — a leave never removes it (final review F3). */
const leftEmpty = (sectionId: number): boolean =>
	existsSync(shareDirOf(sectionId)) &&
	statSync(shareDirOf(sectionId)).isDirectory() &&
	readdirSync(shareDirOf(sectionId)).length === 0;
/** Does a whole holder's TOMBSTONE (a file at the share dir's name) stand for record `sectionId`? */
const tombstoneOf = (sectionId: number): boolean =>
	existsSync(shareDirOf(sectionId)) && statSync(shareDirOf(sectionId)).isFile();
/** The per-lang lock path of record `sectionId`. */
const langLockPath = (sectionId: number, lang: string): string =>
	join(LOCKS, componentLockFileName(`${componentKey(sectionId)}|${lang}`));
/** Plant a whole holder's lock at its own path + its TOMBSTONE (a link of it) at the share name. */
function plantTombstone(sectionId: number, owner: Record<string, unknown>): void {
	writeFileSync(
		wholePath(sectionId),
		JSON.stringify({ key: `${componentKey(sectionId)}|*`, started_at: 0, ...owner }),
	);
	fs.linkSync(wholePath(sectionId), shareDirOf(sectionId));
}

/**
 * Run `fn` with the reader's view of the locks dir STALE the way an NFS client
 * cache can be (`lookupcache=all`: a cached negative dentry, a cached listing):
 * every existence check under it answers "absent", every listing "empty".
 * Mutating calls (link, rmdir, mkdir, rename) still reach the filesystem — the
 * server. A look that decides by lookup or listing is fooled; one that decides
 * by the server's answer to a mutation is not.
 */
function withStaleClientView<T>(fn: () => T): T {
	const realExists = fs.existsSync;
	const realList = fs.readdirSync;
	const exists = spyOn(fs, 'existsSync').mockImplementation((path) =>
		String(path).startsWith(LOCKS) ? false : realExists(path),
	);
	const list = spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, options?: never) =>
		String(path).startsWith(LOCKS) ? [] : realList(path, options)) as typeof fs.readdirSync);
	try {
		return fn();
	} finally {
		exists.mockRestore();
		list.mockRestore();
	}
}

describe('the any-lang ↔ all-langs look is the SERVER’s answer, never a cached one (N1, R1)', () => {
	test('crossed, per-lang first: the whole claim that crosses between its registration and its return is refused — never both', () => {
		const b = manager('inst-b');
		let whole: ReturnType<MediaJobManager['claimWholeComponents']> | 'not crossed' = 'not crossed';
		const a = manager('inst-a', {
			lockShareHooks: {
				afterPublish: (side) => {
					if (side === 'lang' && whole === 'not crossed') {
						whole = b.claimWholeComponents('test3', 70, ['test94'], 'record_media');
					}
				},
			},
		});
		const lang = a.claimTarget(langTarget(70, 'lg-fra'));
		expect(whole).toBeNull(); // B published, rmdir met A's registration (ENOTEMPTY)
		expect(existsSync(wholePath(70))).toBe(false); // and gave its lock back
		expect(tombstoneOf(70)).toBe(false); // a refused whole claim leaves no tombstone
		const held = mustGet(lang, 'A proceeds: its registration was answered by the server');
		expect(shareEntries(70)).toHaveLength(1); // A's registration stands while it holds
		held.release();
		expect(leftEmpty(70)).toBe(true); // released: its registration gone, the dir kept (F3)
	});

	test('crossed, whole first: the per-lang claim that crosses after the tombstone is refused — never both', () => {
		const a = manager('inst-a');
		let lang: ReturnType<MediaJobManager['claimTarget']> | 'not crossed' = 'not crossed';
		let langLockAfterRefusal = true;
		const b = manager('inst-b', {
			lockShareHooks: {
				afterPublish: (side) => {
					if (side === 'whole' && lang === 'not crossed') {
						lang = a.claimTarget(langTarget(71, 'lg-fra'));
						langLockAfterRefusal = existsSync(langLockPath(71, 'lg-fra'));
					}
				},
			},
		});
		const whole = b.claimWholeComponents('test3', 71, ['test94'], 'record_media');
		expect(lang).toBeNull(); // A published, its registration met the tombstone (ENOTDIR)
		expect(langLockAfterRefusal).toBe(false); // and A gave its own lock back
		const claims = mustGet(whole, 'B proceeds: the share was empty when it closed it');
		expect(tombstoneOf(71)).toBe(true); // the tombstone stands while B holds
		for (const claim of claims) claim.release();
		expect(existsSync(shareDirOf(71))).toBe(false); // released: the tombstone taken back
		mustGet(a.claimTarget(langTarget(71, 'lg-fra')), 'the lang is free again').release();
	});

	test('crossed in the gap: a lang that registers between the whole rmdir and its tombstone proceeds; the whole claim is refused', () => {
		const a = manager('inst-a');
		let lang = 'not crossed' as ReturnType<MediaJobManager['claimTarget']> | 'not crossed';
		const b = manager('inst-b', {
			lockShareHooks: {
				beforeTombstone: () => {
					if (lang === 'not crossed') lang = a.claimTarget(langTarget(80, 'lg-fra'));
				},
			},
		});
		const whole = b.claimWholeComponents('test3', 80, ['test94'], 'record_media');
		expect(whole).toBeNull(); // the tombstone met A's new dir (EEXIST), the rmdir its entry
		expect(tombstoneOf(80)).toBe(false);
		expect(existsSync(wholePath(80))).toBe(false);
		const held = mustGet(
			lang === 'not crossed' ? null : lang,
			'A registered: the share name was free at the server',
		);
		expect(shareEntries(80)).toHaveLength(1);
		held.release();
		expect(leftEmpty(80)).toBe(true);
	});

	test('a STALE client view (cached negative dentry / listing) never lets the whole claim past a held lang', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const lang = mustGet(a.claimTarget(langTarget(72, 'lg-fra')), 'A lang');
		expect(
			withStaleClientView(() => b.claimWholeComponents('test3', 72, ['test94'], 'record_media')),
		).toBeNull();
		lang.release();
	});

	test('a STALE client view never lets a lang past a held whole claim', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const claims = mustGet(b.claimWholeComponents('test3', 73, ['test94'], 'record_media'), 'B');
		expect(withStaleClientView(() => a.claimTarget(langTarget(73, 'lg-fra')))).toBeNull();
		expect(tombstoneOf(73)).toBe(true);
		for (const claim of claims) claim.release();
	});

	test('different langs of one component share it: held on two instances at once', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const fra = mustGet(a.claimTarget(langTarget(74, 'lg-fra')), 'fra');
		const eng = mustGet(b.claimTarget(langTarget(74, 'lg-eng')), 'eng');
		expect(shareEntries(74)).toHaveLength(2);
		expect(a.claimWholeComponents('test3', 74, ['test94'], 'record_media')).toBeNull();
		fra.release();
		eng.release();
		expect(leftEmpty(74)).toBe(true);
	});

	test('langs racing each other — mid-registration, mid-leave — never refuse each other (no wait, no probe)', () => {
		const b = manager('inst-b');
		let eng = 'not crossed' as ReturnType<MediaJobManager['claimTarget']> | 'not crossed';
		const a = manager('inst-a', {
			lockShareHooks: {
				// A's lang registered → B's lang claims in that very gap.
				afterPublish: (side) => {
					if (side === 'lang' && eng === 'not crossed') {
						eng = b.claimTarget(langTarget(81, 'lg-eng'));
					}
				},
			},
		});
		const sleep = spyOn(Bun, 'sleepSync');
		try {
			const fra = mustGet(a.claimTarget(langTarget(81, 'lg-fra')), 'fra');
			const engHeld = mustGet(
				eng === 'not crossed' ? null : eng,
				'eng claimed while fra was registering',
			);
			expect(shareEntries(81)).toHaveLength(2);
			fra.release(); // leaving never removes the dir: eng's registration is
			expect(shareEntries(81)).toHaveLength(1); // untouched, nothing to race
			engHeld.release();
			expect(leftEmpty(81)).toBe(true);
			// The dir a WHOLE holder removes (its vacant rmdir) between our mkdir
			// and our link is made again — not a refusal.
			rmSync(shareDirOf(81), { recursive: true });
			const realMkdir = fs.mkdirSync;
			let removedOnce = false;
			const mkdir = spyOn(fs, 'mkdirSync').mockImplementation(((
				path: fs.PathLike,
				options?: fs.MakeDirectoryOptions,
			) => {
				const made = realMkdir(path, options);
				if (!removedOnce && String(path) === shareDirOf(81)) {
					removedOnce = true;
					fs.rmdirSync(path);
				}
				return made;
			}) as typeof fs.mkdirSync);
			let spa: ReturnType<MediaJobManager['claimTarget']> = null;
			try {
				spa = b.claimTarget(langTarget(81, 'lg-spa'));
			} finally {
				mkdir.mockRestore();
			}
			expect(removedOnce).toBe(true);
			mustGet(spa, 'spa registered after its dir was made again').release();
			expect(sleep).not.toHaveBeenCalled(); // nothing waits
		} finally {
			sleep.mockRestore();
		}
		expect(leftEmpty(81)).toBe(true);
	});

	test('a DEAD registration (its holder died without leaving) is dropped by the whole claim; a live one is not', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		mkdirSync(shareDirOf(75), { recursive: true });
		// A dead holder on this machine: its registration is a link of its lock.
		const dead = join(ROOT, 'dead_lock');
		writeFileSync(
			dead,
			JSON.stringify({
				key: `${componentKey(75)}|lg-deu`,
				host: HOST_ID,
				pid: deadPid(),
				instance: 'gone',
				token: 'dead-token',
				started_at: 0,
			}),
		);
		fs.linkSync(dead, join(shareDirOf(75), 'dead.lock.dead-token'));
		rmSync(dead);
		const claims = mustGet(
			quietErrors(() => b.claimWholeComponents('test3', 75, ['test94'], 'record_media')),
			'B past the dead registration',
		);
		expect(tombstoneOf(75)).toBe(true);
		for (const claim of claims) claim.release();
		// A LIVE holder's registration is never dropped.
		const lang = mustGet(a.claimTarget(langTarget(75, 'lg-fra')), 'A lang');
		expect(b.claimWholeComponents('test3', 75, ['test94'], 'record_media')).toBeNull();
		lang.release();
	});

	test("a DEAD whole holder's tombstone does not block a lang (reclaimed by CAS), nor the next whole claim", () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		plantTombstone(76, { host: HOST_ID, pid: deadPid(), instance: 'gone', token: 'dead-whole' });
		const lang = mustGet(
			quietErrors(() => a.claimTarget(langTarget(76, 'lg-fra'))),
			'A past the dead tombstone',
		);
		expect(shareEntries(76)).toHaveLength(1); // the name is a dir again, with A's entry
		lang.release();
		expect(leftEmpty(76)).toBe(true);
		fs.rmdirSync(shareDirOf(76)); // as a whole holder's vacant rmdir would
		rmSync(wholePath(76)); // the dead holder's own lock (judged by its own rules on the lock path)
		// The whole side meets a dead tombstone too (rmdir: ENOTDIR) — reclaimed, then closed.
		plantTombstone(76, { host: HOST_ID, pid: deadPid(), instance: 'gone', token: 'dead-whole' });
		const deadLock = readFileSync(wholePath(76), 'utf8');
		rmSync(wholePath(76)); // its lock went, its tombstone stayed
		const claims = mustGet(
			quietErrors(() => b.claimWholeComponents('test3', 76, ['test94'], 'record_media')),
			'B past the dead tombstone',
		);
		expect(readFileSync(shareDirOf(76), 'utf8')).not.toBe(deadLock); // B's own tombstone now
		for (const claim of claims) claim.release();
		expect(existsSync(shareDirOf(76))).toBe(false);
	});

	test("a LIVE far whole holder's tombstone refuses a lang while its heartbeat (at its LOCK) beats; unchanged for the bound → reclaimed", () => {
		const tick = clock();
		const a = manager('inst-a', { lockClock: tick.now });
		plantTombstone(82, { ...FAR, token: 'far-whole' });
		const beat = (n: number) =>
			writeFileSync(
				heartbeatPath(wholePath(82), 'far-whole'),
				JSON.stringify({ beat: n, holder: 'x' }),
			);
		beat(0);
		expect(a.claimTarget(langTarget(82, 'lg-fra'))).toBeNull(); // first sighting
		tick.advance(BOUND + 1);
		beat(1);
		expect(a.claimTarget(langTarget(82, 'lg-fra'))).toBeNull(); // it beat: live
		expect(tombstoneOf(82)).toBe(true);
		tick.advance(BOUND + 1);
		const lang = mustGet(
			quietErrors(() => a.claimTarget(langTarget(82, 'lg-fra'))),
			'unchanged for the bound: the tombstone is reclaimed',
		);
		lang.release();
		rmSync(wholePath(82));
		rmSync(heartbeatPath(wholePath(82), 'far-whole'));
	});

	test("a registration's sightings are its OWN: judging that lang's current lock never restarts its count", () => {
		const tick = clock();
		const b = manager('inst-b', { lockClock: tick.now });
		const key = `${componentKey(78)}|lg-fra`;
		const langLock = join(LOCKS, componentLockFileName(key));
		// The lang is held NOW by a live far holder (token T2) …
		writeFileSync(langLock, JSON.stringify({ key, ...FAR, token: 'T2', started_at: 0 }));
		writeFileSync(heartbeatPath(langLock, 'T2'), JSON.stringify({ beat: 0, holder: 'x' }));
		// … and an OLD registration of that lang (token T1, its heartbeat long gone) was left behind.
		mkdirSync(shareDirOf(78), { recursive: true });
		writeFileSync(
			join(shareDirOf(78), 'old.lock.T1'),
			JSON.stringify({ key, ...FAR, token: 'T1', started_at: 0 }),
		);
		expect(b.claimWholeComponents('test3', 78, ['test94'], 'record_media')).toBeNull(); // first sighting
		tick.advance(BOUND / 2 + 1);
		expect(b.claimTarget(langTarget(78, 'lg-fra'))).toBeNull(); // judges the LOCK (T2, live)
		tick.advance(BOUND / 2 + 1);
		const claims = mustGet(
			quietErrors(() => b.claimWholeComponents('test3', 78, ['test94'], 'record_media')),
			'the old registration, unchanged for the bound, is dropped',
		);
		for (const claim of claims) claim.release();
		rmSync(langLock);
		rmSync(heartbeatPath(langLock, 'T2'));
	});

	test('a release whose share cannot be left still gives the LOCK back (logged)', () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		const lang = mustGet(a.claimTarget(langTarget(79, 'lg-fra')), 'A lang');
		chmodSync(shareDirOf(79), 0o500); // the registration cannot be unlinked
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			lang.release();
			expect(errors.mock.calls.flat().join(' ')).toContain('leaving');
		} finally {
			errors.mockRestore();
			chmodSync(shareDirOf(79), 0o750);
		}
		expect(existsSync(langLockPath(79, 'lg-fra'))).toBe(false); // the lock itself went
		const again = mustGet(b.claimTarget(langTarget(79, 'lg-fra')), 'the lang is free');
		again.release();
		// The registration left behind is dead (its token is gone): the whole claim drops it.
		const claims = mustGet(
			quietErrors(() => b.claimWholeComponents('test3', 79, ['test94'], 'record_media')),
			'whole after the leftover is judged dead',
		);
		for (const claim of claims) claim.release();
	});

	test('a release takes back only ITS tombstone (CAS): one that is not its own is left, logged', () => {
		const b = manager('inst-b');
		const claims = mustGet(b.claimWholeComponents('test3', 77, ['test94'], 'record_media'), 'B');
		// The name now holds ANOTHER holder's tombstone (B's was reclaimed meanwhile).
		rmSync(shareDirOf(77));
		writeFileSync(
			shareDirOf(77),
			JSON.stringify({ key: `${componentKey(77)}|*`, ...FAR, token: 'other', started_at: 0 }),
		);
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			for (const claim of claims) claim.release();
			expect(errors.mock.calls.flat().join(' ')).toContain('not ours');
		} finally {
			errors.mockRestore();
		}
		expect(tombstoneOf(77)).toBe(true); // the other holder's tombstone stands
		expect(existsSync(wholePath(77))).toBe(false); // B's own lock went all the same
		rmSync(shareDirOf(77));
	});
});

describe('share dirs are BOUNDED: an idle empty one is swept (final review)', () => {
	/** Any lock acquire runs the sweep: a lang claim on another record, released at once. */
	const sweepVia = (m: MediaJobManager, sectionId: number): void =>
		mustGet(m.claimTarget(langTarget(sectionId, 'lg-cat')), 'a sweeping acquire').release();
	const sweptLines = (fn: () => void): string => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			fn();
			return errors.mock.calls.flat().join(' ');
		} finally {
			errors.mockRestore();
		}
	};

	test('an EMPTY share dir seen unchanged for the bound is removed — not before', () => {
		const tick = clock();
		const m = manager('inst-sweep', { lockClock: tick.now });
		mkdirSync(shareDirOf(87));
		sweepVia(m, 93); // first sighting
		tick.advance(BOUND);
		sweepVia(m, 93);
		expect(existsSync(shareDirOf(87))).toBe(true); // not past the bound yet
		tick.advance(1);
		expect(sweptLines(() => sweepVia(m, 93))).toContain('swept idle share dir');
		expect(existsSync(shareDirOf(87))).toBe(false);
	});

	test("a dir that vanished before the sweep's rmdir (ENOENT) is not reported swept", () => {
		const tick = clock();
		const m = manager('inst-sweep', { lockClock: tick.now });
		mkdirSync(shareDirOf(88));
		sweepVia(m, 97);
		tick.advance(BOUND + 1);
		const realRmdir = fs.rmdirSync;
		const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(((path: fs.PathLike) => {
			if (String(path) === shareDirOf(88) && existsSync(path)) realRmdir(path); // removed elsewhere first
			return realRmdir(path);
		}) as typeof fs.rmdirSync);
		let lines = '';
		try {
			lines = sweptLines(() => sweepVia(m, 97));
		} finally {
			rmdir.mockRestore();
		}
		expect(existsSync(shareDirOf(88))).toBe(false);
		expect(lines).not.toContain(`swept idle share dir ${shareDirOf(88)}`);
	});

	test('a share dir holding a live REGISTRATION is kept past the bound — the registration intact', () => {
		const tick = clock();
		const a = manager('inst-holder');
		const m = manager('inst-sweep', { lockClock: tick.now });
		const lang = mustGet(a.claimTarget(langTarget(89, 'lg-fra')), 'A lang');
		sweepVia(m, 94);
		tick.advance(BOUND + 1);
		sweepVia(m, 94);
		expect(shareEntries(89)).toHaveLength(1); // the server refused the rmdir (ENOTEMPTY)
		expect(m.claimWholeComponents('test3', 89, ['test94'], 'record_media')).toBeNull();
		lang.release();
	});

	test('a lang whose OWN acquire sweeps its idle share dir still registers (ENOENT → mkdir → link)', () => {
		const tick = clock();
		const m = manager('inst-sweep', { lockClock: tick.now });
		mkdirSync(shareDirOf(91));
		const before = statSync(shareDirOf(91)).ino;
		sweepVia(m, 95);
		tick.advance(BOUND + 1);
		let lang = null as ReturnType<MediaJobManager['claimTarget']>;
		expect(
			sweptLines(() => {
				lang = m.claimTarget(langTarget(91, 'lg-fra'));
			}),
		).toContain(`swept idle share dir ${shareDirOf(91)}`);
		const held = mustGet(lang, 'registered in the dir made again');
		expect(statSync(shareDirOf(91)).ino).not.toBe(before); // a NEW dir …
		expect(shareEntries(91)).toHaveLength(1); // … holding the registration
		held.release();
	});

	test("a registration that lands between the sweep's look and its rmdir is never lost (ENOTEMPTY)", () => {
		const tick = clock();
		const m = manager('inst-sweep', { lockClock: tick.now });
		const other = manager('inst-racer');
		mkdirSync(shareDirOf(92));
		sweepVia(m, 96);
		tick.advance(BOUND + 1);
		const realRmdir = fs.rmdirSync;
		let racer = 'not raced' as ReturnType<MediaJobManager['claimTarget']> | 'not raced';
		const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(((path: fs.PathLike) => {
			if (String(path) === shareDirOf(92) && racer === 'not raced') {
				racer = other.claimTarget(langTarget(92, 'lg-fra')); // registers in the old dir
			}
			return realRmdir(path);
		}) as typeof fs.rmdirSync);
		try {
			sweepVia(m, 96);
		} finally {
			rmdir.mockRestore();
		}
		const held = mustGet(racer === 'not raced' ? null : racer, 'the racer proceeded');
		expect(shareEntries(92)).toHaveLength(1); // its registration stands in the kept dir
		expect(m.claimWholeComponents('test3', 92, ['test94'], 'record_media')).toBeNull();
		held.release();
	});
});

describe('a throw mid-claim gives back everything already taken (final review F1)', () => {
	const COMPONENTS = ['test94', 'test95'];
	/** Nothing of record `sectionId` is held: no whole lock, no tombstone — and a new whole claim passes. */
	function expectAllGivenBack(m: MediaJobManager, sectionId: number): void {
		for (const component of COMPONENTS) {
			expect(existsSync(wholePath(sectionId, component))).toBe(false);
			expect(existsSync(shareDirOf(sectionId, component))).toBe(false);
		}
		const again = mustGet(
			m.claimWholeComponents('test3', sectionId, COMPONENTS, 'record_media'),
			'a later whole claim (same manager: memory keys given back too)',
		);
		for (const claim of again) claim.release();
	}
	const eio = (): never => {
		throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
	};

	test('an ACQUIRE error of a later component releases the earlier whole lock', () => {
		const m = manager('inst-f1-acquire');
		const realLink = fs.linkSync;
		const link = spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) =>
			String(to) === wholePath(83, 'test95') ? eio() : realLink(from, to)) as typeof fs.linkSync);
		try {
			expect(() => m.claimWholeComponents('test3', 83, COMPONENTS, 'record_media')).toThrow();
		} finally {
			link.mockRestore();
		}
		expectAllGivenBack(m, 83);
	});

	test('the MOUNT refused when the share is closed (re-verify lapsed) releases every whole lock', () => {
		let reads = 0;
		let now = 0;
		const nfs = `120 29 0:52 / ${fs.realpathSync(PROCESSES)} rw - nfs4 fs:/export rw,vers=4.2,hard`;
		const m = new MediaJobManager({
			budgets: { media: 2, maintenance: 2 },
			instanceId: 'inst-f1-mount',
			lockHeartbeatMs: 0,
			lockStaleAfterMs: BOUND,
			clock: () => (now += MOUNT_REVERIFY_MS), // every lock call re-reads the table
			lockMountProbe: {
				platform: 'linux',
				deviceOf: () => '0:52',
				mountinfo: () => {
					reads += 1;
					return reads === 3 ? nfs : ''; // the 3rd read: the share-closing lockContext
				},
			},
		});
		expect(refusalOfSync(() => m.claimWholeComponents('test3', 84, COMPONENTS, 'x')).code).toBe(
			'media.not_configured',
		);
		expect(reads).toBe(3);
		expectAllGivenBack(m, 84);
	});

	test('an rmdir failure closing a later share releases the earlier one — its TOMBSTONE taken back', () => {
		const m = manager('inst-f1-rmdir');
		const realRmdir = fs.rmdirSync;
		let earlierTombstoneStood = false;
		const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(((path: fs.PathLike) => {
			if (String(path) !== shareDirOf(85, 'test95')) return realRmdir(path);
			earlierTombstoneStood = statSync(shareDirOf(85, 'test94')).isFile();
			return eio();
		}) as typeof fs.rmdirSync);
		try {
			expect(() => m.claimWholeComponents('test3', 85, COMPONENTS, 'record_media')).toThrow();
		} finally {
			rmdir.mockRestore();
		}
		expect(earlierTombstoneStood).toBe(true); // test94's share was closed when test95's failed
		expectAllGivenBack(m, 85);
	});

	test('a throw AFTER a tombstone is placed (before its handle is returned) takes that tombstone back', () => {
		let thrown = false;
		const m = manager('inst-f1-hook', {
			lockShareHooks: {
				afterPublish: (side, key) => {
					if (side === 'whole' && key.endsWith('test95') && !thrown) {
						thrown = true;
						throw new Error('injected after the tombstone');
					}
				},
			},
		});
		expect(() => m.claimWholeComponents('test3', 86, COMPONENTS, 'record_media')).toThrow(
			'injected after the tombstone',
		);
		expectAllGivenBack(m, 86);
	});
});

describe('the holder', () => {
	test('a manual tick beats the heartbeat (no wall-clock wait)', () => {
		const a = manager('inst-a');
		const claim = mustGet(a.claimTarget(target(20)), 'claim');
		const token = lockOwner(20).token;
		expect(beatOf(20, token)).toBe(0);
		a.heartbeatNow();
		a.heartbeatNow();
		expect(beatOf(20, token)).toBe(2);
		claim.release();
	});

	test('a LOST hold aborts its job and FAILS it (lock_lost), writing nothing', async () => {
		const a = manager('inst-a');
		let workerRanToItsEnd = false;
		const job = liveJob(a, target(21), undefined, async () => {
			workerRanToItsEnd = true;
			return null;
		});
		await running(a, job.id);
		const token = lockOwner(21).token;
		// Another instance reclaims it (A stalled past the bound).
		rmSync(lockPath(21));
		plant(21, { ...FAR, token: 'thief' }, 0);
		quietErrors(() => a.heartbeatNow());
		job.finish();
		expect(await settled(a, job.id)).toBe('error');
		expect(workerRanToItsEnd).toBe(true);
		expect(lockOwner(21).token).toBe('thief'); // the new owner's lock untouched
		expect(beatOf(21, 'thief')).toBe(0);
		expect(existsSync(heartbeatPath(lockPath(21), token))).toBe(false); // our beat abandoned
		expect(shareEntries(21)).toEqual([]); // and our share registration withdrawn
		unplant(21, 'thief');
	});

	test('a job whose lock was stolen does not RENAME its output into place (M1)', async () => {
		const a = manager('inst-a');
		const out = join(OUT, 'tier_404.mp4');
		const job = liveJob(a, target(22), undefined, async () => {
			await writeAtomically(out, async (temp) => writeFileSync(temp, 'encoded'));
		});
		rmSync(lockPath(22));
		plant(22, { ...FAR, token: 'thief' }, 0);
		job.finish(); // no heartbeat tick: the rename's own check must catch it
		expect(await quietErrors(() => settled(a, job.id))).toBe('error');
		expect(existsSync(out)).toBe(false);
		expect(existsSync(OUT) ? readdirSync(OUT) : []).toEqual([]); // temp swept too
		unplant(22, 'thief');
	});

	test('a job whose lock was stolen does not WRITE BACK files_info (M1)', async () => {
		const a = manager('inst-a');
		const av = mustGet(mediaTypeOf('component_av'), 'av spec');
		let outcome: unknown = 'not reached';
		const job = liveJob(a, target(23), undefined, async () => {
			outcome = await refusalOf(
				persistTranscodedOrReport(
					av,
					{ sectionTipo: 'test3', sectionId: 23, componentTipo: 'test94', lang: null },
					{ initialMediaPath: '', maxItemsFolder: 1000 },
				),
			).catch((error: unknown) => error);
		});
		rmSync(lockPath(23));
		plant(23, { ...FAR, token: 'thief' }, 0);
		job.finish();
		await quietErrors(() => settled(a, job.id));
		expect((outcome as DedaloError).code).toBe('media.build_running');
		unplant(23, 'thief');
	});

	test('a job whose lock was stolen moves nothing to deleted/ (N3)', async () => {
		const media = markMediaRoot(join(ROOT, 'media'));
		const dir = join(media, 'av', '404');
		mkdirSync(dir, { recursive: true });
		const file = join(dir, 'test94_test3_26.mp4');
		writeFileSync(file, 'the tier');
		const a = manager('inst-a');
		let moved: unknown = 'not reached';
		const job = liveJob(a, target(26), undefined, async () => {
			moved = moveToDeleted(file, { mediaRoot: media });
		});
		rmSync(lockPath(26));
		plant(26, { ...FAR, token: 'thief' }, 0);
		job.finish();
		expect(await quietErrors(() => settled(a, job.id))).toBe('error');
		expect(moved).toBe('not reached');
		expect(readdirSync(dir)).toEqual(['test94_test3_26.mp4']); // not even deleted/ made
		unplant(26, 'thief');
		// The same door outside a held job moves (the check is the hold's, not the door's).
		expect(moveToDeleted(file, { mediaRoot: media })).not.toBeNull();
		expect(existsSync(file)).toBe(false);
	});

	test('outside a held job the hold check is a no-op', () => {
		expect(() => assertJobHold()).not.toThrow();
	});

	test('a deadline keeps the component until the worker SETTLES (L4)', async () => {
		// A deadline no real timer reaches in this test: the gate FIRES it
		// (deadlineNow), never races a short wall-clock budget.
		const a = manager('inst-a', { deadlineMs: 600_000 });
		const b = manager('inst-b');
		const job = liveJob(a, target(24));
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			await running(a, job.id);
			expect(a.deadlineNow(job.id)).toBe(true);
			expect(a.status(job.id)?.status).toBe('stopped'); // the deadline fired
			expect(a.deadlineNow(job.id)).toBe(false); // once
			expect(b.claimTarget(target(24))).toBeNull(); // the worker still runs
			expect(a.isOccupied(target(24))).toBe(true);
			job.finish();
			for (let i = 0; i < 200 && existsSync(lockPath(24)); i += 1) await Bun.sleep(5);
			mustGet(b.claimTarget(target(24)), 'free after the settle').release();
		} finally {
			errors.mockRestore();
		}
	});

	test("a shutdown releases held CLAIMS' locks too (L3)", () => {
		const a = manager('inst-a');
		const b = manager('inst-b');
		mustGet(a.claimTarget(target(25)), 'A claim');
		a.interruptLive('test shutdown');
		expect(existsSync(lockPath(25))).toBe(false);
		mustGet(b.claimTarget(target(25)), 'B after shutdown').release();
	});

	test('no residue: every lock, heartbeat, mutex and tombstone this file took is gone (empty share dirs stay, by design — F3)', () => {
		const left = existsSync(LOCKS) ? readdirSync(LOCKS) : [];
		const residue = left.filter((name) => {
			const path = join(LOCKS, name);
			const emptyShare =
				name.endsWith('.langs') && statSync(path).isDirectory() && readdirSync(path).length === 0;
			return !emptyShare;
		});
		expect(residue).toEqual([]);
	});
});
