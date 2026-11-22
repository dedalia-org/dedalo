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
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { writeAtomically } from '../../src/core/media/atomic.ts';
import { persistTranscodedOrReport } from '../../src/core/media/av_versions.ts';
import {
	acquireComponentLock,
	type ComponentLockContext,
	componentLockBusy,
	componentLockFileName,
	componentLockHolder,
	componentLockIsOurs,
	HOST_ID,
	heartbeatPath,
	refreshComponentLock,
	releaseComponentLock,
	staleReason,
} from '../../src/core/media/component_lock.ts';
import { assertJobHold } from '../../src/core/media/job_scope.ts';
import { type JobTarget, MediaJobManager } from '../../src/core/media/jobs.ts';
import { mustGet } from '../helpers/assert.ts';
import { markProcessesDir } from '../helpers/media_scratch_root.ts';
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
	extra: { lockStaleAfterMs?: number; lockClock?: () => number; deadlineMs?: number } = {},
) =>
	new MediaJobManager({
		budgets: { media: 2, maintenance: 2 },
		instanceId,
		lockHeartbeatMs: 0,
		lockStaleAfterMs: extra.lockStaleAfterMs ?? BOUND,
		...(extra.lockClock === undefined ? {} : { lockClock: extra.lockClock }),
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

	test('outside a held job the hold check is a no-op', () => {
		expect(() => assertJobHold()).not.toThrow();
	});

	test('a deadline keeps the component until the worker SETTLES (L4)', async () => {
		const a = manager('inst-a', { deadlineMs: 20 });
		const b = manager('inst-b');
		const job = liveJob(a, target(24));
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(await settled(a, job.id)).toBe('stopped'); // the deadline fired
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

	test('no residue: every lock, heartbeat and mutex this file took is gone', () => {
		const left = existsSync(LOCKS) ? readdirSync(LOCKS) : [];
		expect(left).toEqual([]);
	});
});
