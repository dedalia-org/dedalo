/**
 * MEDIA COPY WORKER (PUBLICATION_HOST_SPEC §5.2, decisions M3/M4; Review Focus 2):
 * per host, ONE run at a time and at most ONE queued run that absorbs every
 * transition arriving meanwhile; unpublish forwarded at once, publish debounced;
 * a failure never wedges a lane; every other caller (the media_copy reconcile, the
 * widget) runs in the SAME host lane; a flip emitted inside a writer's transaction
 * never drags that transaction into the run; boot wiring only in a real boot.
 *
 * WRITES: none (fake copy world, fake sync hosts). One empty transaction on the
 * lane database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInTransaction, withTransaction } from '../../src/core/db/postgres.ts';
import { registerMediaCopySink } from '../../src/diffusion/targets/mediastore/media_copy.ts';
import {
	applyCopyWith,
	type CopyApplyReport,
	recordRoundFailure,
	syncHostWith,
	withdrawNowWith,
} from '../../src/diffusion/targets/mediastore/media_copy_apply.ts';
import {
	activeMediaCopyWorker,
	inMediaCopyLane,
	MediaCopyWorker,
	startMediaCopyRelay,
	startMediaCopyWorker,
} from '../../src/diffusion/targets/mediastore/media_copy_worker.ts';
import { emitPubTransition } from '../../src/diffusion/targets/mediastore/pub_transitions.ts';
import { mediaPath, newWorld, okReport, planFrom, worldDeps } from '../helpers/media_copy_world.ts';

const stops: (() => void)[] = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});
let logSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
	logSpy = spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
	logSpy.mockRestore();
});

function worker(
	syncHost: (
		host: string,
		keys: readonly string[],
		takeWithdrawn: () => readonly string[],
	) => Promise<CopyApplyReport | null>,
	hosts: string[] = ['pub1'],
	publishDebounceMs = 60_000,
): MediaCopyWorker {
	const created = new MediaCopyWorker({ listHosts: () => hosts, syncHost, publishDebounceMs });
	stops.push(() => created.stop());
	return created;
}

function gated(): { gate: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { gate, release };
}

describe('MediaCopyWorker', () => {
	test('unpublish is forwarded at once to every host, without waiting for the publish debounce', async () => {
		const calls: string[][] = [];
		const w = worker(
			async (host, keys) => {
				calls.push([host, ...keys]);
				return null;
			},
			['pub1', 'pub2'],
		);
		w.notify('test3_1', false);
		w.notify('test3_2', false);
		await w.idle();
		expect(calls).toEqual([
			['pub1', 'test3_1', 'test3_2'],
			['pub2', 'test3_1', 'test3_2'],
		]);
	});

	test('publish transitions are debounced into one run per host', async () => {
		const calls: string[][] = [];
		const w = worker(
			async (host, keys) => {
				calls.push([host, ...keys]);
				return null;
			},
			['pub1'],
			20,
		);
		w.notify('test3_1', true);
		w.notify('test3_2', true);
		w.notify('test3_3', true);
		await w.idle();
		expect(calls).toEqual([['pub1']]);
	});

	test('one host never runs two syncs at once; transitions during a run coalesce into ONE queued run', async () => {
		const calls: string[][] = [];
		let running = 0;
		let maxRunning = 0;
		const { gate, release } = gated();
		const w = worker(async (_host, keys) => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			calls.push([...keys]);
			if (calls.length === 1) await gate;
			running -= 1;
			return null;
		});
		w.notify('test3_1', false);
		await Bun.sleep(5);
		w.notify('test3_2', false);
		await Bun.sleep(0);
		w.notify('test3_3', false);
		await Bun.sleep(0);
		release();
		await w.idle();
		expect(calls).toEqual([['test3_1'], ['test3_2', 'test3_3']]);
		expect(maxRunning).toBe(1);
	});

	test('hosts do not wait on each other', async () => {
		const order: string[] = [];
		const { gate, release } = gated();
		const w = worker(
			async (host) => {
				order.push(`start ${host}`);
				if (host === 'pub1') await gate;
				order.push(`end ${host}`);
				return null;
			},
			['pub1', 'pub2'],
		);
		w.notify('test3_1', false);
		await Bun.sleep(5);
		expect(order).toEqual(['start pub1', 'start pub2', 'end pub2']);
		release();
		await w.idle();
		expect(order).toEqual(['start pub1', 'start pub2', 'end pub2', 'end pub1']);
	});

	test('exclusive work runs in the host lane: never beside a sync of the same host', async () => {
		const order: string[] = [];
		const { gate, release } = gated();
		const w = worker(async () => {
			order.push('sync start');
			await gate;
			order.push('sync end');
			return null;
		});
		const sync = w.sync('pub1');
		await Bun.sleep(1);
		const work = w.exclusive('pub1', async () => {
			order.push('exclusive');
			return 7;
		});
		await Bun.sleep(5);
		expect(order).toEqual(['sync start']);
		release();
		expect(await work).toBe(7);
		await sync;
		expect(order).toEqual(['sync start', 'sync end', 'exclusive']);
	});

	test('a failing run never wedges the lane; sync(host) answers the run it joined', async () => {
		let n = 0;
		const report = okReport('pub1');
		const w = worker(async () => {
			n += 1;
			if (n === 1) throw new Error('boom (test)');
			return report;
		});
		await expect(w.sync('pub1')).rejects.toThrow('boom (test)');
		expect(await w.sync('pub1')).toBe(report);
	});

	test('afterSync hears every report; a throwing listener breaks nothing', async () => {
		const seen: string[] = [];
		const report = okReport('pub1');
		const w = new MediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 60_000,
			syncHost: async () => report,
			afterSync: (host, r) => {
				seen.push(`${host}:${r.state}`);
				throw new Error('listener broke (test)');
			},
		});
		stops.push(() => w.stop());
		expect(await w.sync('pub1')).toBe(report);
		expect(seen).toEqual(['pub1:ok']);
	});

	test('an unreadable host registry is logged, never thrown into the marker writer', async () => {
		const calls: string[] = [];
		const w = new MediaCopyWorker({
			listHosts: () => {
				throw new Error('registry_invalid (test)');
			},
			publishDebounceMs: 60_000,
			syncHost: async (host) => {
				calls.push(host);
				return null;
			},
		});
		stops.push(() => w.stop());
		expect(() => w.notify('test3_1', false)).not.toThrow();
		await w.idle();
		expect(calls).toEqual([]);
	});

	test('Review Focus 2: unpublished while its put is in flight → no file and no marker on the agent', async () => {
		const world = newWorld();
		const K = 'test3_1';
		const path = mediaPath(K);
		world.local.set(path, { bytes: 'jpeg', mtimeMs: 1 });
		world.published.add(K);
		const inFlight = gated();
		const putStarted = gated();
		world.duringPut = async () => {
			putStarted.release();
			await inFlight.gate;
		};
		const d = worldDeps(world);
		const w = worker(
			(host, keys) =>
				syncHostWith(
					{
						takesCopy: async () => true,
						plan: async () => planFrom(world),
						apply: (h, plan) => applyCopyWith(d, h, plan),
						recordFailure: (h, error) => recordRoundFailure(d, h, error),
					},
					host,
					keys,
				),
			['pub1'],
			0,
		);
		w.notify(K, true);
		await putStarted.gate;
		world.published.delete(K);
		w.notify(K, false);
		inFlight.release();
		await w.idle();
		expect(world.agentFiles.has(path)).toBe(false);
		expect(world.agentMarkers.has(K)).toBe(false);
		const putAt = world.calls.indexOf(`put ${path}`);
		expect(world.calls.indexOf(`mark ${K} true`)).toBeLessThan(putAt);
		expect(world.calls.lastIndexOf(`mark ${K} false`)).toBeGreaterThan(putAt);
		expect(world.calls.lastIndexOf(`del ${path}`)).toBeGreaterThan(putAt);
		expect(world.runtime.get('pub1')?.pending_deletions).toEqual([]);
	});

	test('M2: an unpublish during a long multi-put round drops the agent marker at the NEXT unit, not after the round', async () => {
		const world = newWorld();
		const A = 'test3_1';
		const B = 'test3_2';
		const a1 = mediaPath(A);
		const a2 = mediaPath(A, 'test88');
		const b1 = mediaPath(B);
		world.local.set(a1, { bytes: 'jpeg', mtimeMs: 1 });
		world.local.set(a2, { bytes: 'jpeg', mtimeMs: 1 });
		world.local.set(b1, { bytes: 'png!', mtimeMs: 1 });
		world.published.add(A);
		world.published.add(B);
		world.agentMarkers.add(B); // B copied in an earlier round
		world.agentFiles.set(b1, 'png!');
		const inFlight = gated();
		const putStarted = gated();
		world.duringPut = async (path) => {
			if (path === a1) {
				putStarted.release();
				await inFlight.gate;
			}
		};
		const d = worldDeps(world);
		const w = worker(
			(host, keys, takeWithdrawn) =>
				syncHostWith(
					{
						takesCopy: async () => true,
						plan: async () => planFrom(world),
						apply: (h, plan, options) => applyCopyWith(d, h, plan, options),
						recordFailure: (h, error) => recordRoundFailure(d, h, error),
					},
					host,
					keys,
					takeWithdrawn,
				),
			['pub1'],
			0,
		);
		w.notify(A, true);
		await putStarted.gate;
		world.published.delete(B);
		w.notify(B, false);
		await Bun.sleep(1);
		inFlight.release();
		await w.idle();
		const withdrawnAt = world.calls.indexOf(`mark ${B} false`);
		expect(withdrawnAt).toBeGreaterThan(world.calls.indexOf(`put ${a1}`));
		expect(withdrawnAt).toBeLessThan(world.calls.indexOf(`put ${a2}`));
		// The queued run then deletes B's bytes and verifies.
		expect(world.calls.lastIndexOf(`del ${b1}`)).toBeGreaterThan(world.calls.indexOf(`put ${a2}`));
		expect(world.agentFiles.has(b1)).toBe(false);
		expect(world.agentMarkers.has(B)).toBe(false);
		expect(world.agentFiles.has(a2)).toBe(true);
		expect(world.runtime.get('pub1')?.pending_deletions).toEqual([]);
	});

	test('withdrawn consent: an unpublish during a long streaming put reaches the agent BEFORE the put ends', async () => {
		const world = newWorld();
		const K = 'test3_1';
		const path = mediaPath(K);
		world.local.set(path, { bytes: 'jpeg', mtimeMs: 1 });
		world.published.add(K);
		const inFlight = gated();
		const putStarted = gated();
		world.duringPut = async () => {
			putStarted.release();
			await inFlight.gate;
		};
		const d = worldDeps(world);
		const pendingAtWithdrawal: string[][] = [];
		const created = new MediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 0,
			syncHost: (host, keys, takeWithdrawn) =>
				syncHostWith(
					{
						takesCopy: async () => true,
						plan: async () => planFrom(world),
						apply: (h, plan, options) => applyCopyWith(d, h, plan, options),
						recordFailure: (h, error) => recordRoundFailure(d, h, error),
					},
					host,
					keys,
					takeWithdrawn,
				),
			withdrawNow: (host, keys) =>
				withdrawNowWith(
					{
						...d,
						takesCopy: async () => true,
						mark: async (h, key, published, actor) => {
							pendingAtWithdrawal.push(
								(world.runtime.get('pub1')?.pending_deletions ?? []).map((p) => p.path),
							);
							return d.mark(h, key, published, actor);
						},
					},
					host,
					keys,
				),
		});
		stops.push(() => created.stop());
		created.notify(K, true);
		await putStarted.gate;
		world.published.delete(K);
		created.notify(K, false);
		for (let i = 0; i < 200 && world.agentMarkers.has(K); i++) await Bun.sleep(1);
		// The put is still streaming, and the agent already holds no marker for the key.
		expect(world.agentMarkers.has(K)).toBe(false);
		expect(world.agentFiles.has(path)).toBe(false);
		expect(pendingAtWithdrawal[0]).toEqual(['.publication/pub/test3_1']);
		inFlight.release();
		await created.idle();
		expect(world.agentFiles.has(path)).toBe(false);
		expect(world.agentMarkers.has(K)).toBe(false);
		expect(world.runtime.get('pub1')).toMatchObject({ state: 'ok', pending_deletions: [] });
	});

	test('a late immediate withdrawal never outlives the round that verifies it (the lane waits for it)', async () => {
		// The race the publication-host drill caught on a hosted runner (2026-11-08): the
		// immediate withdrawal asks the agent's status first; when that is slow, the queued
		// round (withdraw-only pass, plan, verify) used to finish FIRST and verify the marker
		// gone — then the late withdrawal re-recorded it pending, after every verify. The
		// runtime then listed a deletion nothing would verify until some later round (the
		// panel turns it overdue). The lane now starts no unit before the host's in-flight
		// immediate withdrawals settle; the withdrawal itself still waits for nothing.
		const world = newWorld();
		const K = 'test3_1';
		const path = mediaPath(K);
		world.local.set(path, { bytes: 'jpeg', mtimeMs: 1 });
		world.published.add(K);
		const d = worldDeps(world);
		const slowStatus = gated();
		const order: string[] = [];
		const created = new MediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 0,
			syncHost: (host, keys, takeWithdrawn) => {
				order.push(`sync:${keys.join(',')}`);
				return syncHostWith(
					{
						takesCopy: async () => true,
						plan: async () => planFrom(world),
						apply: (h, plan, options) => applyCopyWith(d, h, plan, options),
						recordFailure: (h, error) => recordRoundFailure(d, h, error),
					},
					host,
					keys,
					takeWithdrawn,
				);
			},
			withdrawNow: (host, keys) =>
				withdrawNowWith(
					{
						...d,
						takesCopy: async () => {
							await slowStatus.gate;
							order.push('withdrawNow:status answered');
							return true;
						},
					},
					host,
					keys,
				),
		});
		stops.push(() => created.stop());
		await created.sync('pub1');
		expect(world.agentMarkers.has(K)).toBe(true);
		expect(world.agentFiles.has(path)).toBe(true);
		order.length = 0;

		world.published.delete(K);
		created.notify(K, false);
		// Give an unordered lane every chance to run its round before the status answers.
		await Bun.sleep(20);
		slowStatus.release();
		await created.idle();

		expect(order).toEqual(['withdrawNow:status answered', `sync:${K}`]);
		expect(world.agentMarkers.has(K)).toBe(false);
		expect(world.agentFiles.has(path)).toBe(false);
		expect(world.runtime.get('pub1')).toMatchObject({ state: 'ok', pending_deletions: [] });
	});

	test('exclusive work also starts only after the host’s in-flight immediate withdrawals', async () => {
		const slow = gated();
		const order: string[] = [];
		const created = new MediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 60_000,
			syncHost: async (_host, keys) => {
				order.push(`sync:${keys.join(',')}`);
				return null;
			},
			withdrawNow: async () => {
				await slow.gate;
				order.push('withdrawNow');
			},
		});
		stops.push(() => created.stop());
		created.notify('test3_7', false);
		await Bun.sleep(1);
		const work = created.exclusive('pub1', async () => {
			order.push('exclusive');
			return 1;
		});
		await Bun.sleep(10);
		slow.release();
		await work;
		await created.idle();
		expect(order).toEqual(['withdrawNow', 'sync:test3_7', 'exclusive']);
	});

	test('exclusive work receives the lane pre-empt drain; a queued run starting clears it', async () => {
		const drained: string[][] = [];
		const { gate, release } = gated();
		const w = worker(async () => {
			await gate;
			return null;
		});
		const sync = w.sync('pub1');
		await Bun.sleep(1);
		w.notify('test3_5', false);
		await Bun.sleep(1);
		const work = w.exclusive('pub1', async (take) => {
			drained.push([...take()]);
			return 1;
		});
		release();
		await Promise.all([sync, work]);
		await w.idle();
		// The flush's queued run started before the exclusive work: it owns the key.
		expect(drained).toEqual([[]]);
		const work2 = w.exclusive('pub1', async (take) => [...take()]);
		expect(await work2).toEqual([]);
	});
});

describe('the runner relay (cross-process M2)', () => {
	test('an unpublish is withdrawn on every host at once; a publish is ignored (a runner never copies); stop drains, bounded', async () => {
		const sent: string[] = [];
		const relay = startMediaCopyRelay({
			listHosts: () => ['pub1', 'pub2'],
			withdrawNow: async (host, keys) => {
				sent.push(`${host}:${keys.join(',')}`);
			},
		});
		emitPubTransition('test3_1', true);
		emitPubTransition('test3_2', false);
		emitPubTransition('test3_3', false);
		expect(await relay.stop(5_000)).toBe(true);
		expect(sent).toEqual(['pub1:test3_2,test3_3', 'pub2:test3_2,test3_3']);
		// stopped: no longer hears the seam
		emitPubTransition('test3_4', false);
		await Bun.sleep(1);
		expect(sent).toHaveLength(2);
		const stuck = startMediaCopyRelay({
			listHosts: () => ['pub1'],
			withdrawNow: async () => {
				await new Promise(() => {});
			},
		});
		emitPubTransition('test3_5', false);
		expect(await stuck.stop(20)).toBe(false);
	});
});

describe('boot wiring', () => {
	test('startMediaCopyWorker hears the pub/ seam until stopped; a second start is refused', async () => {
		const calls: string[][] = [];
		const stop = startMediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 60_000,
			syncHost: async (host, keys) => {
				calls.push([host, ...keys]);
				return null;
			},
		});
		stops.push(stop);
		expect(() =>
			startMediaCopyWorker({
				listHosts: () => [],
				publishDebounceMs: 1,
				syncHost: async () => null,
			}),
		).toThrow('started twice');
		emitPubTransition('test3_9', false);
		await activeMediaCopyWorker()?.idle();
		expect(calls).toEqual([['pub1', 'test3_9']]);
		stop();
		expect(activeMediaCopyWorker()).toBeNull();
		emitPubTransition('test3_10', false);
		await Bun.sleep(5);
		expect(calls).toHaveLength(1);
	});

	test('a flip emitted INSIDE a writer transaction runs detached from it (never on the batch connection)', async () => {
		const seen: boolean[] = [];
		const stop = startMediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 5,
			syncHost: async () => {
				seen.push(isInTransaction());
				return null;
			},
		});
		stops.push(stop);
		await withTransaction(async () => {
			expect(isInTransaction()).toBe(true);
			emitPubTransition('test3_11', false);
			emitPubTransition('test3_12', true);
		});
		await activeMediaCopyWorker()?.idle();
		await Bun.sleep(20);
		await activeMediaCopyWorker()?.idle();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((inTx) => inTx === false)).toBe(true);
	});

	test('detach layer: sync/enqueue called INSIDE a transaction (no sink in between) runs the sync detached', async () => {
		const seen: boolean[] = [];
		const w = worker(async () => {
			seen.push(isInTransaction());
			return null;
		});
		await withTransaction(async () => {
			expect(isInTransaction()).toBe(true);
			await w.sync('pub1');
		});
		expect(seen).toEqual([false]);
	});

	test('detach layer: notify INSIDE a transaction (no sink) — the immediate withdrawal and the queued run are both detached', async () => {
		const seen: [string, boolean][] = [];
		const created = new MediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 60_000,
			syncHost: async () => {
				seen.push(['sync', isInTransaction()]);
				return null;
			},
			withdrawNow: async () => {
				seen.push(['withdrawNow', isInTransaction()]);
			},
		});
		stops.push(() => created.stop());
		await withTransaction(async () => {
			created.notify('test3_15', false);
			await Bun.sleep(0);
		});
		await created.idle();
		expect([...seen].sort()).toEqual([
			['sync', false],
			['withdrawNow', false],
		]);
	});

	test('detach layer: the pub/ sink itself calls notify outside the writer transaction', async () => {
		const notified: boolean[] = [];
		const original = MediaCopyWorker.prototype.notify;
		const spy = spyOn(MediaCopyWorker.prototype, 'notify').mockImplementation(function (
			this: MediaCopyWorker,
			key: string,
			published: boolean,
		) {
			notified.push(isInTransaction());
			return original.call(this, key, published);
		});
		try {
			const stop = startMediaCopyWorker({
				listHosts: () => [],
				publishDebounceMs: 60_000,
				syncHost: async () => null,
			});
			stops.push(stop);
			await withTransaction(async () => {
				emitPubTransition('test3_16', false);
			});
			await activeMediaCopyWorker()?.idle();
		} finally {
			spy.mockRestore();
		}
		expect(notified).toEqual([false]);
	});

	test('exclusive / inMediaCopyLane entered INSIDE a transaction run detached from it (worker or not)', async () => {
		const seen: [string, boolean][] = [];
		const probe = (what: string) => async () => {
			seen.push([what, isInTransaction()]);
			return what;
		};
		const w = worker(async () => null);
		await withTransaction(async () => {
			expect(isInTransaction()).toBe(true);
			expect(await inMediaCopyLane('pub1', probe('no worker'))).toBe('no worker');
			expect(await w.exclusive('pub1', probe('exclusive'))).toBe('exclusive');
		});
		const stop = startMediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 60_000,
			syncHost: async () => null,
		});
		stops.push(stop);
		await withTransaction(async () => {
			expect(await inMediaCopyLane('pub1', probe('worker lane'))).toBe('worker lane');
		});
		expect(seen).toEqual([
			['no worker', false],
			['exclusive', false],
			['worker lane', false],
		]);
	});

	test('an unpublished key outside the agent marker grammar is dropped, never fails the batch it came with', async () => {
		const calls: string[][] = [];
		const w = worker(async (host, keys) => {
			calls.push([host, ...keys]);
			return null;
		});
		w.notify('Rsc1_1', false);
		w.notify('rsc1_2', false);
		await w.idle();
		expect(calls).toEqual([['pub1', 'rsc1_2']]);
	});

	test('inMediaCopyLane: directly without a worker; through the started worker lane otherwise', async () => {
		expect(await inMediaCopyLane('pub1', async () => 'direct')).toBe('direct');
		const order: string[] = [];
		const { gate, release } = gated();
		const stop = startMediaCopyWorker({
			listHosts: () => ['pub1'],
			publishDebounceMs: 60_000,
			syncHost: async () => {
				order.push('sync');
				await gate;
				return null;
			},
		});
		stops.push(stop);
		const sync = activeMediaCopyWorker()?.sync('pub1');
		await Bun.sleep(1);
		const laned = inMediaCopyLane('pub1', async () => {
			order.push('lane');
			return 'laned';
		});
		await Bun.sleep(5);
		expect(order).toEqual(['sync']);
		release();
		expect(await laned).toBe('laned');
		await sync;
		expect(order).toEqual(['sync', 'lane']);
	});

	test('registerMediaCopySink is the media_index transition seam', () => {
		const heard: string[] = [];
		const off = registerMediaCopySink((key, published) => {
			heard.push(`${key}:${published}`);
		});
		emitPubTransition('test3_13', true);
		off();
		emitPubTransition('test3_14', true);
		expect(heard).toEqual(['test3_13:true']);
	});

	test('server.ts starts it only in a real boot (not smoke), behind the reconcile scheduler gate, stopped by the drain', () => {
		const text = readFileSync(join(import.meta.dir, '..', '..', 'src', 'server.ts'), 'utf8');
		const at = text.indexOf('startMediaCopy({');
		expect(at).toBeGreaterThan(0);
		// A box that is not installed never boots this far (install_state_boot), so the
		// smoke boot is the only skip.
		const guard = text.lastIndexOf('if (!smokeBoot) {', at);
		expect(guard).toBeGreaterThan(text.indexOf('const shutdownStops'));
		expect(text.lastIndexOf('} // end if (!smokeBoot)', at)).toBeLessThan(guard);
		expect(text.indexOf('} // end if (!smokeBoot)', at)).toBeGreaterThan(at);
		expect(
			text.lastIndexOf("readString('DEDALO_RECONCILE_SCHEDULER_ENABLED') !== 'false'", at),
		).toBeGreaterThan(guard);
		expect(text).toContain("await import('./diffusion/api/media_copy.ts')");
		// The boot worker withdraws at once, outside the lane (withdrawn consent never waits for a put).
		const facade = readFileSync(
			join(import.meta.dir, '..', '..', 'src', 'diffusion', 'api', 'media_copy.ts'),
			'utf8',
		);
		expect(facade).toMatch(/startMediaCopyWorker\(\{[^}]*\bwithdrawNow,/);
	});
});
