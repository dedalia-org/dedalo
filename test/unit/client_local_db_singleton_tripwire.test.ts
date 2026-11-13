/**
 * SHARED INDEXEDDB CONNECTION CONTRACT — client/dedalo/core/common/js/data_manager.js
 *
 * WHY THIS FILE EXISTS. Every `*_local_db*` helper called `get_local_db()`, and
 * `get_local_db()` called `indexedDB.open()` unconditionally — so a page opened
 * one connection PER read and PER write and closed none of them (there is no
 * `db.close()` on any of those paths). Two costs, one of them structural:
 *
 *  1. The open/version-check round trip was paid on every cache lookup, on the
 *     hottest store ('data', used by the data_manager.request cache).
 *  2. The accumulated open connections PIN the database, so any
 *     `deleteDatabase` can only ever fire `onblocked` while the tab lives.
 *
 * WHAT IS PINNED (contract, not implementation):
 *  A. Many mixed operations across many stores open exactly ONE connection.
 *  B. Concurrent first callers share a single open() — no thundering herd.
 *  C. A FAILED open is not memoized: the next call retries.
 *  D. A `versionchange` from another tab closes this connection and drops the
 *     memo, so the next caller transparently reopens (and the other tab's
 *     upgrade is not blocked forever).
 *  E. delete_whole_local_db() CLOSES this page's connection before calling
 *     deleteDatabase — otherwise it can only block.
 *  F. `blocked` does not end the open: the browser may still complete it later.
 *     A connection arriving after we gave up is CLOSED on arrival, never left
 *     as an unreferenced handle pinning the database open.
 *  G. A pure read opens a READONLY transaction. IndexedDB serialises overlapping
 *     readwrite transactions on a store and runs readonly ones concurrently, so
 *     a read declared readwrite queues behind every other operation on the
 *     busiest store ('data', the request cache).
 *
 * HARNESS. A hand-rolled fake IndexedDB (bun has none) installed on the window
 * seam data_manager reads (`window.indexedDB || window.mozIndexedDB || …`). It
 * counts open() calls and records close() ordering. ui.js is masked for the
 * same reason as client_instances_inflight_tripwire.test.ts — it is not
 * importable from disk at all. No DB, no network, no credentials.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes client
// modules, which are process-global — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_COMMON = join(
		import.meta.dir,
		'..',
		'..',
		'client',
		'dedalo',
		'core',
		'common',
		'js',
	);
	const DATA_MANAGER_PATH = join(CLIENT_COMMON, 'data_manager.js');

	type Journal = {
		opens: number;
		closes: number;
		deletes: number;
		order: string[];
		tx: Array<{ table: string; mode: string }>;
	};

	type DataManager = {
		get_local_db: () => Promise<unknown>;
		set_local_db_data: (data: unknown, table: string) => Promise<unknown>;
		get_local_db_data: (id: string, table: string, use_cache?: boolean) => Promise<unknown>;
		delete_local_db_data: (id: string, table: string) => Promise<unknown>;
		delete_whole_local_db: () => Promise<unknown>;
	};

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	let data_manager: DataManager;
	let journal: Journal;
	/** set to fail the NEXT open() only */
	let fail_next_open = false;
	/** set to fire `blocked` on the NEXT open(), then complete it late (real IDB does this) */
	let block_next_open = false;
	/** the handle handed to a late, already-abandoned open — test F inspects it */
	let late_db: FakeDb | null = null;
	/** the live fake connections, so a test can drive versionchange */
	let live_dbs: FakeDb[] = [];

	const STORES = ['rqo', 'context', 'status', 'data', 'ontology', 'pagination'];

	/** fires a request's handler on a later macrotask, like a real IDBRequest */
	const fire = (fn: () => void) => setTimeout(fn, 0);

	class FakeDb {
		version = 11;
		closed = false;
		onclose: (() => void) | null = null;
		onversionchange: (() => void) | null = null;
		objectStoreNames = { contains: (n: string) => STORES.includes(n) };
		createObjectStore() {
			return {};
		}
		deleteObjectStore() {}
		close() {
			this.closed = true;
			journal.closes++;
			journal.order.push('close');
		}
		transaction(_table: string | string[], _mode: string) {
			// faithful to the spec: a closed connection cannot start a transaction.
			// Without this an implementation that hands out closed handles would pass.
			if (this.closed) {
				throw new Error('InvalidStateError: the database connection is closing or closed');
			}
			journal.tx.push({
				table: Array.isArray(_table) ? _table.join(',') : _table,
				mode: _mode,
			});
			const tx: Record<string, unknown> = { onerror: null, oncomplete: null, error: null };
			// a readonly transaction MUST refuse mutations (spec: ReadOnlyError). Without
			// this the fake would happily accept a put under readonly, so a future write
			// path that picked the wrong mode could pass unnoticed.
			const deny_if_readonly = (op: string) => {
				if (_mode !== 'readwrite') {
					throw new Error(`ReadOnlyError: ${op} is not allowed in a ${_mode} transaction`);
				}
			};
			tx.objectStore = () => ({
				put: (v: unknown) => {
					deny_if_readonly('put');
					return make_req(v);
				},
				get: () => make_req({ id: 'x', value: { ok: true } }),
				delete: () => {
					deny_if_readonly('delete');
					return make_req(true);
				},
				clear: () => {
					deny_if_readonly('clear');
					return make_req(true);
				},
			});
			return tx;
		}
	}

	const make_req = (result: unknown) => {
		const req: Record<string, unknown> = { onsuccess: null, onerror: null, result, error: null };
		fire(() => {
			const cb = req.onsuccess as ((e: unknown) => void) | null;
			if (cb) cb({ target: { result } });
		});
		return req;
	};

	const fake_indexedDB = {
		open(_name: string, _version?: number) {
			journal.opens++;
			journal.order.push('open');
			const req: Record<string, unknown> = {
				onsuccess: null,
				onerror: null,
				onblocked: null,
				onupgradeneeded: null,
				result: null,
			};
			const should_fail = fail_next_open;
			const should_block = block_next_open;
			fail_next_open = false;
			block_next_open = false;
			fire(() => {
				if (should_block) {
					// 1) tell the caller it is blocked — the request stays PENDING
					const blocked_cb = req.onblocked as ((e: unknown) => void) | null;
					if (blocked_cb) blocked_cb({ target: req });
					// 2) the other tab goes away and the SAME request completes anyway
					fire(() => {
						const db = new FakeDb();
						live_dbs.push(db);
						late_db = db;
						req.result = db;
						const ok_cb = req.onsuccess as ((e: unknown) => void) | null;
						if (ok_cb) ok_cb({ target: { result: db } });
					});
					return;
				}
				if (should_fail) {
					const cb = req.onerror as ((e: unknown) => void) | null;
					if (cb) cb({ target: { error: new Error('fake open failure') } });
					return;
				}
				const db = new FakeDb();
				live_dbs.push(db);
				req.result = db;
				const cb = req.onsuccess as ((e: unknown) => void) | null;
				if (cb) cb({ target: { result: db } });
			});
			return req;
		},
		deleteDatabase(_name: string) {
			journal.deletes++;
			journal.order.push('deleteDatabase');
			const req: Record<string, unknown> = {
				onsuccess: null,
				onerror: null,
				onblocked: null,
				result: null,
			};
			fire(() => {
				const cb = req.onsuccess as ((e: unknown) => void) | null;
				if (cb) cb({ target: { result: null } });
			});
			return req;
		},
	};

	beforeAll(async () => {
		for (const key of ['window', 'page_globals', 'SHOW_DEBUG', 'indexedDB', 'DEDALO_API_URL'])
			saved[key] = globals[key];

		globals.page_globals = { dedalo_data_lang: 'lg-eng', stream_readers: [] };
		globals.SHOW_DEBUG = false;
		globals.DEDALO_API_URL = '/api/v1/json/';
		globals.indexedDB = fake_indexedDB; // the seam: window.indexedDB
		globals.window = globalThis;

		mock.module(join(CLIENT_COMMON, 'ui.js'), () => ({
			ui: {
				create_dom_element: () => ({ classList: { add() {}, remove() {} }, addEventListener() {} }),
				show_message: () => {},
			},
		}));

		data_manager = ((await import(DATA_MANAGER_PATH)) as { data_manager: DataManager })
			.data_manager;
	});

	afterAll(async () => {
		// FORGET THE FAKE CONNECTION FIRST. `local_db_promise` is module state of a
		// module every test file shares; left memoized, the fake store below (whose
		// get() answers `{ok:true}` for ANY key) serves the next file's reads as
		// cache hits — client_request_coalescing_tripwire went red on the hosted
		// tier that way (2026-09-23). Closed while the fake indexedDB is still
		// installed, so the close reaches the fake and nothing dangles.
		await data_manager.delete_whole_local_db().catch(() => {});
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete globals[key];
			else globals[key] = saved[key];
		}
		mock.restore();
	});

	beforeEach(async () => {
		// each test starts from a closed, forgotten connection
		await data_manager.delete_whole_local_db().catch(() => {});
		journal = { opens: 0, closes: 0, deletes: 0, order: [], tx: [] };
		fail_next_open = false;
		block_next_open = false;
		late_db = null;
		live_dbs = [];
	});

	describe('local db — one connection for the whole page (A)', () => {
		test('mixed reads/writes/deletes across every store open() exactly once', async () => {
			await data_manager.set_local_db_data({ id: 'k1', value: 1 }, 'data');
			await data_manager.get_local_db_data('k1', 'data');
			await data_manager.get_local_db_data('k2', 'status', true); // legacy use_cache=true, now ignored
			await data_manager.delete_local_db_data('k1', 'data');
			await data_manager.set_local_db_data({ id: 'p', value: 2 }, 'pagination');
			await data_manager.get_local_db_data('c', 'context');

			// pre-fix this was 6 — one open per helper call, none ever closed
			expect(journal.opens).toBe(1);
		});
	});

	describe('local db — concurrent first callers share one open (B)', () => {
		test('a burst of get_local_db() calls issued together triggers a single open()', async () => {
			const dbs = await Promise.all([
				data_manager.get_local_db(),
				data_manager.get_local_db(),
				data_manager.get_local_db(),
				data_manager.get_local_db(),
			]);

			expect(journal.opens).toBe(1);
			// and they all got the SAME handle
			expect(dbs[0]).toBe(dbs[1]);
			expect(dbs[0]).toBe(dbs[3]);
		});
	});

	describe('local db — a failed open is not memoized (C)', () => {
		test('after an open failure the next call retries instead of caching false forever', async () => {
			fail_next_open = true;
			const first = await data_manager.get_local_db();
			expect(first).toBe(false);
			expect(journal.opens).toBe(1);

			// the memo must have been dropped: this must actually reopen
			const second = await data_manager.get_local_db();
			expect(journal.opens).toBe(2);
			expect(second).not.toBe(false);
		});
	});

	describe('local db — versionchange from another tab releases the connection (D)', () => {
		test('the connection closes, the memo drops, and the next call reopens', async () => {
			const first = await data_manager.get_local_db();
			expect(journal.opens).toBe(1);
			expect(live_dbs.length).toBe(1);

			// another tab starts an upgrade/delete
			const db = live_dbs[0] as FakeDb;
			expect(typeof db.onversionchange).toBe('function');
			(db.onversionchange as () => void)();

			// we must have stepped aside, or the other tab blocks forever
			expect(db.closed).toBe(true);

			const second = await data_manager.get_local_db();
			expect(journal.opens).toBe(2);
			expect(second).not.toBe(first);
		});
	});

	describe('local db — a handle that died WITHOUT a close event is replaced (H)', () => {
		// Safari drops the IndexedDB server connection of a backgrounded tab: no
		// `close` event reaches the memo, and db.transaction() throws from then on.
		test('read, write and delete reopen once instead of failing for the page life', async () => {
			await data_manager.get_local_db();
			(live_dbs[0] as FakeDb).closed = true; // dead, memo still holds it

			expect(await data_manager.get_local_db_data('k1', 'status')).toBeDefined();
			expect(journal.opens).toBe(2);

			(live_dbs[live_dbs.length - 1] as FakeDb).closed = true;
			await data_manager.set_local_db_data({ id: 'k1', value: 1 }, 'status');
			(live_dbs[live_dbs.length - 1] as FakeDb).closed = true;
			await data_manager.delete_local_db_data('k1', 'status');
			expect(journal.opens).toBe(4);
		});
	});

	describe('local db — delete closes this page connection first (E)', () => {
		test('delete_whole_local_db closes before deleteDatabase, not after', async () => {
			await data_manager.get_local_db();
			expect(journal.opens).toBe(1);

			await data_manager.delete_whole_local_db();

			expect(journal.closes).toBeGreaterThan(0);
			expect(journal.deletes).toBe(1);
			// ORDER is the invariant: a delete issued while we still hold the
			// connection can only ever fire onblocked
			expect(journal.order.indexOf('close')).toBeLessThan(journal.order.indexOf('deleteDatabase'));
		});
	});

	describe('local db — a late connection after `blocked` is closed, not leaked (F)', () => {
		/**
		 * Per spec `blocked` does NOT end the open request: it stays pending and
		 * still fires `success` once the blocking connection goes away. The code
		 * gives up on `blocked` so callers are not stranded — which means a real
		 * IDBDatabase can arrive afterwards with nobody holding it and no
		 * invalidation wired. Left alone it pins the database open for the life of
		 * the page and blocks every future upgrade/delete from ANY tab: the exact
		 * pathology this singleton exists to remove, reintroduced on the one path
		 * nobody looks at.
		 */
		test('get_local_db resolves false, and the connection that arrives later is closed', async () => {
			block_next_open = true;

			const result = await data_manager.get_local_db();
			expect(result).toBe(false);
			expect(journal.opens).toBe(1);

			// let the abandoned request complete, as a real browser would
			await new Promise((r) => setTimeout(r, 10));

			expect(late_db).not.toBeNull();
			// the orphan must have been closed on arrival
			expect((late_db as FakeDb).closed).toBe(true);
			expect(journal.closes).toBeGreaterThan(0);

			// and the page recovers: the memo was never poisoned
			const retry = await data_manager.get_local_db();
			expect(retry).not.toBe(false);
			expect(journal.opens).toBe(2);
		});
	});

	describe('local db — reads do not take a write lock (G)', () => {
		test('a pure get opens READONLY; writes and deletes still open readwrite', async () => {
			await data_manager.get_local_db_data('k', 'data');
			expect(journal.tx).toEqual([{ table: 'data', mode: 'readonly' }]);

			journal.tx = [];
			await data_manager.set_local_db_data({ id: 'k', value: 1 }, 'data');
			await data_manager.delete_local_db_data('k', 'data');
			expect(journal.tx).toEqual([
				{ table: 'data', mode: 'readwrite' },
				{ table: 'data', mode: 'readwrite' },
			]);
		});

		test('no read path anywhere opens a readwrite transaction', async () => {
			await data_manager.get_local_db_data('a', 'status');
			await data_manager.get_local_db_data('b', 'context', true);
			await data_manager.get_local_db_data('c', 'pagination');

			expect(journal.tx.length).toBe(3);
			expect(journal.tx.every((t) => t.mode === 'readonly')).toBe(true);
		});
	});
}
