/**
 * A MODAL'S OWN EDITORS COMMIT BEFORE THE PAGE-WIDE UNSAVED GUARD JUDGES THEM
 * — client/dedalo/core/common/js/dd-modal.js `before_close`.
 *
 * WHY. dd-modal's close awaits `check_unsaved_data()` before hiding. That guard
 * is PAGE-wide, and its OK runs `reset_unsaved_data()`. The mosaic alt table
 * (view_mosaic_edit_portal `open_alt_record`) edits a row INSIDE the modal and
 * commits it in `on_close` — which runs AFTER the guard. A typed-not-blurred
 * alt value was therefore judged "unsaved" by the very close that should
 * commit it, and the OK discarded it (the RED browser leg "a dirty alt edit
 * survives close", test_row_invariant). The root fix is an ordering seam:
 * `before_close` is awaited FIRST (modal still shown), so the alt window's
 * flush commits its rows and the guard sees only what could not be committed.
 *
 * Legs, all through the REAL `_closeModal` sequence (prototype methods on an
 * element-shaped object; `check_unsaved_data` is the only substitution):
 *  1. ORDER: before_close → check_unsaved_data → hide → publish_close →
 *     on_close; the guard starts only after the hook's promise SETTLED (a
 *     hook that commits asynchronously is awaited, not raced) — and the guard
 *     then observes the committed state (nothing left to discard).
 *  2. REFUSAL: a hook resolving `false` keeps the modal open — no guard, no
 *     hide, no on_close, close() resolves false; a later close runs again.
 *  3. UNSET: without a hook the sequence is exactly the old guard-first one.
 *  4. A THROWING hook is logged and the close falls through to the guard.
 *  5. A minimized modal runs no hook (it is not closed).
 *  6. Concurrent closes share ONE hook run.
 *
 * HERMETIC + ISOLATED GATE (component_common.js is substituted).
 */

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_CORE = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');

	/** The page registry the guard reads: a value typed in the alt row, not committed. */
	const registry = { dirty: false, discarded: false };
	const log: string[] = [];
	/** An export this gate never reaches: declared (no truncation), loud if called. */
	const unreached = (name: string) => () => {
		throw new Error(`client_modal_before_close_native: ${name} is not part of this gate`);
	};
	// EVERY export of component_common.js is declared (a partial mock truncates the module)
	mock.module(join(CLIENT_CORE, 'component_common', 'js', 'component_common.js'), () => ({
		component_common: unreached('component_common'),
		init_events_subscription: unreached('init_events_subscription'),
		save_unsaved_components: unreached('save_unsaved_components'),
		orphan_unsaved_instance: unreached('orphan_unsaved_instance'),
		deactivate_components: unreached('deactivate_components'),
		is_empty: unreached('is_empty'),
		activate_edit_in_list: unreached('activate_edit_in_list'),
		bind_edit_in_list: unreached('bind_edit_in_list'),
		get_dataframe: unreached('get_dataframe'),
		delete_dataframe: unreached('delete_dataframe'),
		attach_item_dataframe: unreached('attach_item_dataframe'),
		check_unsaved_data: async () => {
			log.push(`check_unsaved_data(dirty=${registry.dirty})`);
			if (registry.dirty) {
				// the user's OK on the page-wide prompt: reset_unsaved_data
				registry.dirty = false;
				registry.discarded = true;
			}
			return true;
		},
	}));

	const g = globalThis as Record<string, any>;
	const saved: Record<string, unknown> = {};
	// biome-ignore lint/suspicious/noExplicitAny: the class under test is untyped client JS
	let DDModal: any = null;

	beforeAll(async () => {
		for (const key of ['HTMLElement', 'customElements', 'get_label', 'page_globals', 'window'])
			saved[key] = g[key];
		g.window = g.window ?? g;
		g.page_globals = {}; // no service_autocomplete open
		g.HTMLElement = class {};
		g.customElements = {
			define: (name: string, cls: unknown) => {
				if (name === 'dd-modal') DDModal = cls;
			},
		};
		g.get_label = {};
		await import(join(CLIENT_CORE, 'common', 'js', 'dd-modal.js'));
	});
	afterAll(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete g[key];
			else g[key] = value;
		}
		mock.restore();
	});

	/** An element-shaped object running the REAL close sequence (no constructor: no shadow DOM). */
	function make_modal(hooks: { before_close?: unknown } = {}) {
		const classes = new Set(['modal_show']);
		const modal = Object.create(DDModal.prototype);
		Object.assign(modal, {
			mini: false,
			transient: false,
			_closing: null,
			_modalVisible: true,
			_modal: { classList: { remove: (c: string) => classes.delete(c) } },
			isConnected: true,
			remove: () => {
				log.push('remove');
				modal.isConnected = false;
			},
			dispatchEvent: (e: { type: string }) => {
				log.push(`event:${e.type}`);
				return true;
			},
			publish_close: () => log.push('publish_close'),
			on_close: () => log.push(`on_close(shown=${classes.has('modal_show')})`),
			before_close: null,
			...hooks,
		});
		return { modal, classes };
	}

	function reset() {
		log.length = 0;
		registry.dirty = false;
		registry.discarded = false;
	}

	describe('dd-modal before_close', () => {
		test('class captured from customElements.define', () => {
			expect(DDModal).not.toBeNull();
			expect(typeof DDModal.prototype._closeModal).toBe('function');
		});

		test('1. the hook is AWAITED before the page-wide guard, so a committed alt value survives', async () => {
			reset();
			registry.dirty = true; // typed, not blurred
			const { modal, classes } = make_modal({
				before_close: async (self: unknown) => {
					expect(self).toBe(modal);
					expect(classes.has('modal_show'), 'the hook runs while the modal is shown').toBe(true);
					log.push('before_close:start');
					await new Promise((r) => setTimeout(r, 5)); // an async commit (save round trip)
					registry.dirty = false; // the alt window flush committed the value
					log.push('before_close:end');
					return true;
				},
			});
			const closed = await modal.close();
			expect(closed).toBe(true);
			expect(log).toEqual([
				'before_close:start',
				'before_close:end',
				'check_unsaved_data(dirty=false)',
				'publish_close',
				'on_close(shown=false)',
				'event:dd-modal-close',
				'remove',
			]);
			expect(registry.discarded, 'the guard had nothing to discard').toBe(false);
		});

		test('2. a hook resolving false keeps the modal open; a later close runs it again', async () => {
			reset();
			let answer = false;
			let runs = 0;
			const { modal, classes } = make_modal({
				before_close: async () => {
					runs++;
					return answer;
				},
			});
			expect(await modal.close()).toBe(false);
			expect(log).toEqual([]);
			expect(classes.has('modal_show')).toBe(true);
			expect(modal.isConnected).toBe(true);
			answer = true;
			expect(await modal.close()).toBe(true);
			expect(runs).toBe(2);
			expect(log[0]).toBe('check_unsaved_data(dirty=false)');
		});

		test('3. no hook → the guard-first sequence, unchanged (and it still discards on OK)', async () => {
			reset();
			registry.dirty = true;
			const { modal } = make_modal();
			expect(await modal.close()).toBe(true);
			expect(log).toEqual([
				'check_unsaved_data(dirty=true)',
				'publish_close',
				'on_close(shown=false)',
				'event:dd-modal-close',
				'remove',
			]);
			expect(registry.discarded).toBe(true);
		});

		test('4. a throwing hook is logged and the close falls through to the guard', async () => {
			reset();
			const errors = spyOn(console, 'error').mockImplementation(() => {});
			try {
				const { modal } = make_modal({
					before_close: async () => {
						throw new Error('flush exploded');
					},
				});
				expect(await modal.close()).toBe(true);
				expect(log[0]).toBe('check_unsaved_data(dirty=false)');
				expect(errors).toHaveBeenCalled();
			} finally {
				errors.mockRestore();
			}
		});

		test('5. a minimized modal runs no hook', async () => {
			reset();
			let runs = 0;
			const { modal } = make_modal({
				before_close: async () => {
					runs++;
					return true;
				},
			});
			modal.mini = true;
			expect(await modal.close()).toBe(true);
			expect(runs).toBe(0);
			expect(log).toEqual([]);
		});

		test('6. concurrent closes share one hook run', async () => {
			reset();
			let runs = 0;
			const { modal } = make_modal({
				before_close: async () => {
					runs++;
					await new Promise((r) => setTimeout(r, 5));
					return true;
				},
			});
			const [a, b] = await Promise.all([modal.close(), modal.close()]);
			expect(a && b).toBe(true);
			expect(runs).toBe(1);
			expect(log.filter((l) => l.startsWith('on_close')).length).toBe(1);
		});
	});
}
