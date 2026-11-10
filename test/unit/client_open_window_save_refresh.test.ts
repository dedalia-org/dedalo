/**
 * OPEN_WINDOW SAVE-DRIVEN REFRESH — client/dedalo/core/common/js/utils/util.js
 *
 * WHY. `open_window({on_blur})` used to run on_blur ONCE, on the opener's next
 * 'focus'. That read raced the child window's save (blur → save, then return
 * to the opener: the read won, the portal showed the OLD value), and a focus
 * with no save consumed the one-shot listener, so later saves never refreshed.
 * Now the child reports each component save to its opener (component_common
 * run_save → broadcast_record_save → window.opener.postMessage) and the
 * opener's watch runs on_blur AFTER the write.
 *
 * PINNED:
 *  A. a 'saved' message from THIS child runs on_blur (and later saves too);
 *  B. a message from another window, or another origin, is ignored (window
 *     names are not unique across tabs: the source window is the key);
 *  C. a burst of saves = one on_blur (debounced);
 *  D. a closed child tears the watch down (message + focus listeners gone);
 *  E. the focus fallback still runs on_blur once (windows that never report);
 *  F. a child closed with a 'saving' never followed by 'saved' (save started in
 *     beforeunload) gets one settled refresh;
 *  G. re-opening the same window name replaces the watch (no stacked listeners);
 *  H. focus while a save is in flight does NOT refresh: the 'saved' drives it;
 *  I. runs never overlap: a run asked for while on_blur's promise is pending
 *     re-runs once it settles (common.refresh drops a concurrent call);
 *  J. a 'failed' closes the 'saving': focus refreshes again.
 *
 * HARNESS. util.js REAL; ui.js / instances.js masked; window.open and the
 * window listener registry are stubs. No DB, no browser.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

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
	const UTIL_PATH = join(CLIENT_COMMON, 'utils', 'util.js');

	type UtilModule = {
		open_window: (options: Record<string, unknown>) => unknown;
		broadcast_record_save: (type: string, instance: Record<string, unknown>) => void;
	};

	const ORIGIN = 'http://dedalo.test';
	// debounce is 150ms, close/unload settle 1000ms: generous margins, full-suite load
	const SETTLE = 400;

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	const KEYS = [
		'window',
		'page_globals',
		'SHOW_DEBUG',
		'DEDALO_CORE_URL',
		'get_label',
		'location',
		'opener',
		'addEventListener',
		'removeEventListener',
	];
	let util: UtilModule;
	let listeners: Record<string, ((e: unknown) => void)[]> = {};
	type Child = { closed: boolean; resizeTo(): void; focus(): void };
	let open_answer: Child | null = null;

	const fake_window = (): Child => ({ closed: false, resizeTo() {}, focus() {} });
	const fire = (type: string, e: unknown) => {
		for (const fn of [...(listeners[type] ?? [])]) fn(e);
	};
	/** a report from `child` (as broadcast_record_save posts it) */
	const child_says = (type: string, child: Child, origin = ORIGIN) =>
		fire('message', {
			origin,
			source: child,
			data: {
				source: 'dedalo_record_save',
				type,
				section_tipo: 'test3',
				section_id: 1,
				component_tipo: 'test52',
			},
		});
	const focus = () => fire('focus', { type: 'focus' });
	const count = (type: string) => (listeners[type] ?? []).length;
	/** open a watched window; returns [child, call counter] */
	const open = (name: string, on_blur?: () => unknown) => {
		const child = fake_window();
		open_answer = child;
		const calls = { n: 0 };
		util.open_window({
			url: '/dedalo/core/page/?x',
			name,
			on_blur: () => {
				calls.n++;
				return on_blur?.();
			},
		});
		return [child, calls] as const;
	};
	/** close the child and let the watch notice it */
	const close = (child: { closed: boolean }) => {
		child.closed = true;
		focus();
	};

	beforeAll(async () => {
		for (const key of KEYS) saved[key] = globals[key];
		globals.window = globalThis;
		globals.page_globals = {
			dedalo_data_lang: 'lg-eng',
			dedalo_data_nolan: 'lg-nolan',
			stream_readers: [],
		};
		globals.SHOW_DEBUG = false;
		globals.DEDALO_CORE_URL = '/dedalo/core';
		globals.get_label = {};
		globals.location = { origin: ORIGIN };
		globals.addEventListener = (type: string, fn: (e: unknown) => void) => {
			listeners[type] = [...(listeners[type] ?? []), fn];
		};
		globals.removeEventListener = (type: string, fn: (e: unknown) => void) => {
			listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
		};
		(globals.window as Record<string, unknown>).screen = { width: 1920, height: 1080 };
		(globals.window as Record<string, unknown>).open = () => open_answer;

		mock.module(join(CLIENT_COMMON, 'ui.js'), () => ({
			ui: {
				create_dom_element: () => ({ classList: { add() {}, remove() {} }, addEventListener() {} }),
			},
		}));
		mock.module(join(CLIENT_COMMON, 'instances.js'), () => ({
			get_all_instances: () => [],
			get_instances_custom_map: () => new Map(),
			add_instance: () => {},
			get_instance_by_id: () => undefined,
			find_instances: () => [],
			delete_instance: () => true,
			delete_instances: () => 0,
			key_instances_builder: () => '',
			get_instance: async () => ({}),
		}));

		util = (await import(UTIL_PATH)) as unknown as UtilModule;
	});

	afterAll(() => {
		mock.restore();
		for (const key of KEYS) globals[key] = saved[key];
	});

	beforeEach(() => {
		listeners = {};
	});

	describe('open_window on_blur watch', () => {
		test('A. a save from this child runs on_blur after the debounce', async () => {
			const [child, calls] = open('record_view_test3_1');
			child_says('saved', child);
			expect(calls.n, 'on_blur must wait for the debounce').toBe(0);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			// later saves still refresh (the old one-shot listener did not)
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(2);
			close(child);
		});

		test('B. a save from another window or origin is ignored', async () => {
			const [child, calls] = open('section_view');
			child_says('saved', fake_window()); // same name, another tab's child
			child_says('saved', child, 'http://elsewhere.test');
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(0);
			close(child);
		});

		test('C. a burst of saves is one refresh', async () => {
			const [child, calls] = open('record_view_test3_1');
			for (let i = 0; i < 5; i++) child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			close(child);
		});

		test('D. a closed child tears the watch down', async () => {
			const [child, calls] = open('record_view_test3_1');
			expect(count('message')).toBe(1);
			expect(count('focus')).toBe(1);
			close(child);
			expect(count('message'), 'message listener leaked after close').toBe(0);
			expect(count('focus'), 'focus listener leaked after close').toBe(0);
			await Bun.sleep(SETTLE);
			const before = calls.n;
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n, 'a torn-down watch still refreshed').toBe(before);
		});

		test('E. focus fallback runs once while the child is open', async () => {
			const [child, calls] = open('external_1');
			focus();
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			focus();
			await Bun.sleep(SETTLE);
			expect(calls.n, 'focus fallback is one-shot').toBe(1);
			close(child);
		});

		test('F. closed with an unreported save → one settled refresh', async () => {
			const [child, calls] = open('record_view_test3_1');
			child_says('saving', child);
			close(child);
			await Bun.sleep(SETTLE);
			expect(calls.n, 'refresh must wait for the save to settle').toBe(0);
			await Bun.sleep(1000);
			expect(calls.n).toBe(1);
		});

		test('G. re-open of the same name replaces the watch', async () => {
			const [first, first_calls] = open('record_view_test3_1');
			const [second, second_calls] = open('record_view_test3_1');
			expect(count('message')).toBe(1);
			expect(count('focus')).toBe(1);
			child_says('saved', second);
			await Bun.sleep(SETTLE);
			expect(first_calls.n).toBe(0);
			expect(second_calls.n).toBe(1);
			close(first);
			close(second);
		});

		test('H. focus during an in-flight save waits for its saved', async () => {
			const [child, calls] = open('record_view_test3_1');
			child_says('saving', child);
			focus(); // the user returns to the opener before the save commits
			await Bun.sleep(SETTLE);
			expect(calls.n, 'a read before the commit would show the old value').toBe(0);
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			close(child);
		});

		test('I. a run asked for while on_blur is in flight re-runs after it', async () => {
			let release: () => void = () => {};
			const [child, calls] = open(
				'record_view_test3_1',
				() => new Promise<void>((r) => (release = r)),
			);
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			child_says('saved', child); // second commit while the first refresh builds
			await Bun.sleep(SETTLE);
			expect(calls.n, 'runs must not overlap').toBe(1);
			release();
			await Bun.sleep(10);
			expect(calls.n, 'the second save must still refresh').toBe(2);
			release();
			close(child);
		});

		test('J. a failed save closes its saving: focus refreshes', async () => {
			const [child, calls] = open('record_view_test3_1');
			child_says('saving', child);
			child_says('failed', child);
			focus();
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			close(child);
		});

		test('K. child unloads mid-save (reload, stays open) → settled refresh, later saves not blocked', async () => {
			const [child, calls] = open('record_view_test3_1');
			child_says('saving', child);
			child_says('unloading', child); // its 'saved' will never come
			await Bun.sleep(SETTLE);
			expect(calls.n, 'refresh must wait for the save to settle').toBe(0);
			await Bun.sleep(1000);
			expect(calls.n).toBe(1);
			child_says('saving', child); // the reloaded page saves again
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n, 'a stuck in-flight count blocked the next refresh').toBe(2);
			close(child);
		});

		test('L. on_blur resolving false (refresh refused) is retried once, not forever', async () => {
			const [child, calls] = open('record_view_test3_1', () => Promise.resolve(false));
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			await Bun.sleep(1000);
			expect(calls.n, 'a refused refresh must be retried').toBe(2);
			await Bun.sleep(1200);
			expect(calls.n, 'the retry is one-shot').toBe(2);
			close(child);
		});

		test('M. a save-driven run spends the focus fallback', async () => {
			const [child, calls] = open('record_view_test3_1');
			child_says('saved', child);
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			focus(); // returning to the opener would only repeat the refresh
			await Bun.sleep(SETTLE);
			expect(calls.n).toBe(1);
			close(child);
		});
	});

	describe('on_blur callers return their refresh', () => {
		// the watch can wait for / retry a refresh only when it gets its promise:
		// a callback that drops it lets common.refresh silently refuse a second run
		test('every open_window on_blur that refreshes returns the promise', async () => {
			const root = join(import.meta.dir, '..', '..');
			const files = [
				...new Bun.Glob('client/dedalo/**/*.js').scanSync(root),
				...new Bun.Glob('tools/**/*.js').scanSync(root),
			];
			const BODY = /on_blur\s*:\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{([\s\S]*?)\n\s*\}/g;
			const refreshing: string[] = [];
			const offenders: string[] = [];
			for (const file of files) {
				const src = await Bun.file(join(root, file)).text();
				if (!src.includes('on_blur')) continue;
				for (const m of src.matchAll(BODY)) {
					for (const line of (m[1] ?? '').split('\n')) {
						if (!/\.refresh(_element)?\(/.test(line) || line.trim().startsWith('//')) continue;
						refreshing.push(file);
						if (!/\breturn\b/.test(line)) offenders.push(`${file}: ${line.trim()}`);
					}
				}
			}
			expect(refreshing.length, 'the scan found no refreshing callback (vacuous)').toBeGreaterThanOrEqual(10);
			expect(offenders).toEqual([]);
		});
	});

	describe('broadcast_record_save', () => {
		test('reports the unload once per page (pagehide → unloading)', () => {
			const got: unknown[] = [];
			const w = globals.window as Record<string, unknown>;
			w.opener = { postMessage: (m: unknown) => got.push(m) };
			util.broadcast_record_save('saving', { section_tipo: 'test3', section_id: 1, tipo: 'test52' });
			util.broadcast_record_save('saved', { section_tipo: 'test3', section_id: 1, tipo: 'test52' });
			expect(count('pagehide'), 'hooked once').toBe(1);
			fire('pagehide', {});
			w.opener = null;
			expect(got.at(-1)).toEqual({ source: 'dedalo_record_save', type: 'unloading' });
		});

		test('posts {source, type, record} to the opener at its own origin; no-op without one', () => {
			const got: unknown[][] = [];
			const w = globals.window as Record<string, unknown>;
			w.opener = { postMessage: (...args: unknown[]) => got.push(args) };
			util.broadcast_record_save('saved', { section_tipo: 'test3', section_id: 1, tipo: 'test52' });
			w.opener = null;
			util.broadcast_record_save('saved', { section_tipo: 'test3', section_id: 1, tipo: 'test52' });
			expect(got).toEqual([
				[
					{
						source: 'dedalo_record_save',
						type: 'saved',
						section_tipo: 'test3',
						section_id: 1,
						component_tipo: 'test52',
					},
					ORIGIN,
				],
			]);
		});
	});
}
