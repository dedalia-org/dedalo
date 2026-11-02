/**
 * THE ROW LOCK THAWS WHOEVER RELEASES LAST, AND A DEFERRED HOVER TEARDOWN
 * SHOWS THE TILE UNDER THE POINTER — two outcome gates of the row-box client
 * (WC-2026-10-30-section-record-row-box), driven through the REAL modules:
 *
 *   client/dedalo/core/common/js/common.js          lock_rows
 *   client/dedalo/core/section_record/js/row_hover.js delegate_row_hover
 *
 * A. lock_rows. The first acquire of an owner commits and FREEZES every row
 *    window slot (`inert`); a nested acquire (the refresh inside a navigate)
 *    only counts. The freeze must be lifted by the release that brings the
 *    depth back to 0 — in EITHER order. It used to be carried by the first
 *    acquire's release only: when the nested holder released LAST, nothing
 *    thawed and the rows stayed inert (a page that no longer takes input,
 *    with no error anywhere). Legs: both release orders, idempotent release,
 *    one commit per first acquire, re-acquire re-freezes, Cancel freezes
 *    nothing.
 *
 * B. row_hover. A hover overlay holding a PENDING editor node (its value lives
 *    only in the node) defers its teardown: the next tile's overlay is not
 *    rendered. When the deferral resolves (focus leaves the overlay after the
 *    node committed) and the pointer already sits on another tile, that tile's
 *    overlay must appear: its pointerover was consumed while deferred and the
 *    controller's `row.index===wanted` guard drops every repeat, so without the
 *    re-show the tile under the pointer never gets one until the pointer leaves
 *    and comes back. Controls: a focusout while the pointer is back on the
 *    deferred tile tears nothing down; a still-pending node keeps deferring.
 *    Same guard, other door: a show that ends WITHOUT an overlay (render threw,
 *    answered null, the row was replaced meanwhile) must forget the tile, or
 *    the next pointerover on it is dropped and it never gets an overlay.
 *    Control: a lost render of a tile the pointer already left keeps the
 *    newer tile wanted (a repeat on it renders nothing).
 *
 * C. build(true) of a refresh({destroy:false}) (destroy_unwindowed_dependencies)
 *    keeps the window rows but destroys every other dependency. The live hover
 *    instance is one of them; when its editor's save FAILED (still unsaved
 *    after settle) a direct cascade destroy deregistered it, unorphaned — the
 *    typed value vanished from the unsaved guard. The hover must go through its
 *    controller: the dirty editor is ORPHANED and not destroyed. Control: a
 *    clean hover editor is not orphaned; non-hover dependencies still go.
 *
 * HERMETIC + ISOLATED GATE: section.js (row_edit_safety), ui.js and css.js are
 * substituted (process-global), so the body runs in its own child process.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_CORE = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');

	// ── fake DOM (only what the two modules touch) ─────────────────────────────
	type Listener = { fn: (e: FakeEvent) => void; signal?: AbortSignal };
	class FakeClassList {
		private set = new Set<string>();
		add(...names: string[]) {
			for (const n of names) this.set.add(n);
		}
		remove(...names: string[]) {
			for (const n of names) this.set.delete(n);
		}
		contains(name: string) {
			return this.set.has(name);
		}
	}
	type FakeEvent = { type: string; target: FakeEl; relatedTarget?: FakeEl | null };
	class FakeEl {
		nodeType = 1;
		children: FakeEl[] = [];
		parentElement: FakeEl | null = null;
		classList = new FakeClassList();
		dataset: Record<string, string> = {};
		listeners = new Map<string, Listener[]>();
		dispatched: string[] = [];
		constructor(...classes: string[]) {
			this.classList.add(...classes);
		}
		appendChild(child: FakeEl) {
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		prepend(child: FakeEl) {
			child.parentElement = this;
			this.children.unshift(child);
		}
		remove() {
			const parent = this.parentElement;
			if (!parent) return;
			parent.children = parent.children.filter((c) => c !== this);
			this.parentElement = null;
		}
		contains(other: FakeEl | null | undefined): boolean {
			for (let n: FakeEl | null | undefined = other; n; n = n.parentElement)
				if (n === this) return true;
			return false;
		}
		closest(selector: string): FakeEl | null {
			const name = selector.replace(/^\./, '');
			for (let n: FakeEl | null = this; n; n = n.parentElement)
				if (n.classList.contains(name)) return n;
			return null;
		}
		addEventListener(type: string, fn: (e: FakeEvent) => void, options?: { signal?: AbortSignal }) {
			const list = this.listeners.get(type) ?? [];
			list.push({ fn, signal: options?.signal });
			this.listeners.set(type, list);
		}
		dispatchEvent(event: { type: string }) {
			this.dispatched.push(event.type);
			return true;
		}
	}
	/** Bubble from target to the root, running every live listener. */
	function fire(type: string, target: FakeEl, relatedTarget: FakeEl | null = null) {
		const event: FakeEvent = { type, target, relatedTarget };
		for (let n: FakeEl | null = target; n; n = n.parentElement) {
			for (const l of n.listeners.get(type) ?? []) if (!l.signal?.aborted) l.fn(event);
		}
	}

	// ── the edit-safety bindings row_hover reads (section.js row_edit_safety) ──
	const uncommitted = new Set<FakeEl>();
	let editor_commits = false; // a committing editor advances commit_seq on change
	const seq = new Map<object, number>();
	const instance_by_wrapper = new Map<FakeEl, object>();
	// leg C: an unsaved (dirty) instance whose save fails, and the orphan record
	const unsaved = new Set<object>();
	const failing = new Set<object>();
	const orphaned: object[] = [];
	const row_edit_safety = {
		component_active: () => null,
		deactivate: async () => {},
		settle: async (instance: object) => !failing.has(instance),
		// the real orphan (component_common orphan_unsaved_instance) leaves the caller's ar_instances
		orphan: (instance: { caller?: { ar_instances?: object[] } }) => {
			orphaned.push(instance);
			const list = instance.caller?.ar_instances;
			if (Array.isArray(list) && list.includes(instance)) list.splice(list.indexOf(instance), 1);
		},
		unsaved_instances: () => [...unsaved],
		uncommitted_nodes: () => [...uncommitted],
		register_uncommitted: (node: FakeEl) => uncommitted.add(node),
		commit_seq: (instance: object) => seq.get(instance) ?? 0,
		instance_of_node: (wrapper: FakeEl | null) =>
			wrapper ? (instance_by_wrapper.get(wrapper) ?? null) : null,
		owned_elsewhere: () => false,
		service_autocomplete: () => null,
	};

	/** An export this gate never reaches: declared (no truncation), loud if called. */
	const unreached = (name: string) => () => {
		throw new Error(`client_row_lock_hover_native: ${name} is not part of this gate`);
	};
	// EVERY export of section.js is declared (a partial mock truncates the module)
	mock.module(join(CLIENT_CORE, 'section', 'js', 'section.js'), () => ({
		section: unreached('section'),
		get_section_records: unreached('get_section_records'),
		row_edit_safety,
		build_section_record_for: unreached('build_section_record_for'),
		window_section_rows: unreached('window_section_rows'),
		holds_component_locks: unreached('holds_component_locks'),
	}));
	mock.module(join(CLIENT_CORE, 'common', 'js', 'ui.js'), () => ({
		ui: { create_dom_element: () => new FakeEl(), activate_tooltips: () => {} },
	}));
	const CSS_PATH = join(CLIENT_CORE, 'page', 'js', 'css.js');
	const real_css = await import(CSS_PATH);
	mock.module(CSS_PATH, () => ({ ...real_css, get_inserted_rules: () => [] }));

	const g = globalThis as Record<string, any>;
	const saved: Record<string, unknown> = {};
	beforeAll(() => {
		for (const key of [
			'page_globals',
			'Node',
			'get_label',
			'SHOW_DEBUG',
			'SHOW_DEVELOPER',
			'window',
			'confirm',
		]) {
			saved[key] = g[key];
		}
		g.window = g.window ?? g;
		g.page_globals = { page_error: null };
		g.Node = { ELEMENT_NODE: 1 };
		g.get_label = {};
		g.SHOW_DEBUG = false;
		g.SHOW_DEVELOPER = false;
	});
	afterAll(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete g[key];
			else g[key] = value;
		}
		mock.restore();
	});

	// ── A. lock_rows ───────────────────────────────────────────────────────────
	type FakeWindow = {
		inert: boolean;
		commits: number;
		freezes: number;
		pending: Array<{ node: FakeEl; instance: object | null; index: number }>;
		commit_uncommitted: () => { pending: FakeWindow['pending'] };
		freeze: () => void;
		thaw: () => void;
	};
	function fake_window(): FakeWindow {
		const w: FakeWindow = {
			inert: false,
			commits: 0,
			freezes: 0,
			pending: [],
			commit_uncommitted: () => {
				w.commits++;
				return { pending: w.pending };
			},
			freeze: () => {
				w.freezes++;
				w.inert = true;
			},
			thaw: () => {
				w.inert = false;
			},
		};
		return w;
	}

	describe('A. lock_rows: the release that reaches depth 0 thaws, in any order', () => {
		let lock_rows: (owner: object) => Promise<(() => void) | null>;
		beforeAll(async () => {
			({ lock_rows } = await import(join(CLIENT_CORE, 'common', 'js', 'common.js')));
		});

		test('nested holder releases LAST → the rows thaw', async () => {
			const rows = fake_window();
			const alt = fake_window();
			const owner: Record<string, any> = { record_windows: { rows, alt } };
			const outer = await lock_rows(owner);
			const inner = await lock_rows(owner);
			expect(outer).toBeFunction();
			expect(inner).toBeFunction();
			expect(rows.inert && alt.inert).toBe(true);
			outer?.();
			expect(rows.inert, 'still held by the nested holder').toBe(true);
			inner?.();
			expect(rows.inert, 'the last release thaws the first acquire’s freeze').toBe(false);
			expect(alt.inert).toBe(false);
			expect(owner.row_lock_depth).toBe(0);
		});

		test('first holder releases LAST → the rows thaw (the order that always worked)', async () => {
			const rows = fake_window();
			const owner: Record<string, any> = { record_windows: { rows } };
			const outer = await lock_rows(owner);
			const inner = await lock_rows(owner);
			inner?.();
			expect(rows.inert).toBe(true);
			outer?.();
			expect(rows.inert).toBe(false);
		});

		test('a nested acquire neither re-commits nor re-freezes; release is idempotent', async () => {
			const rows = fake_window();
			const owner: Record<string, any> = { record_windows: { rows } };
			const outer = await lock_rows(owner);
			const inner = await lock_rows(owner);
			expect(rows.commits).toBe(1);
			expect(rows.freezes).toBe(1);
			outer?.();
			outer?.(); // a second call must not decrement again
			expect(owner.row_lock_depth).toBe(1);
			expect(rows.inert).toBe(true);
			inner?.();
			expect(rows.inert).toBe(false);
		});

		test('re-acquire after a full release commits and freezes again; a stale release does nothing', async () => {
			const rows = fake_window();
			const owner: Record<string, any> = { record_windows: { rows } };
			const first = await lock_rows(owner);
			first?.();
			const second = await lock_rows(owner);
			expect(rows.commits).toBe(2);
			expect(rows.inert).toBe(true);
			first?.(); // released already: a no-op on the new lock
			expect(rows.inert).toBe(true);
			second?.();
			expect(rows.inert).toBe(false);
		});

		test('Cancel on a pending node → null, nothing frozen, depth 0', async () => {
			const rows = fake_window();
			const node = new FakeEl('input');
			(node as unknown as { focus: () => void }).focus = () => {};
			rows.pending = [{ node, instance: null, index: 0 }];
			const owner: Record<string, any> = { record_windows: { rows } };
			g.confirm = () => false;
			const release = await lock_rows(owner);
			expect(release).toBeNull();
			expect(rows.freezes).toBe(0);
			expect(rows.inert).toBe(false);
			expect(owner.row_lock_depth ?? 0).toBe(0);
		});
	});

	// ── B. row_hover deferred teardown ─────────────────────────────────────────
	describe('B. row_hover: a resolved deferred teardown shows the tile under the pointer', () => {
		let delegate_row_hover: (options: Record<string, unknown>) => {
			index: number | null;
			deferred: boolean;
			idle: () => Promise<void>;
		};
		beforeAll(async () => {
			({ delegate_row_hover } = await import(
				join(CLIENT_CORE, 'section_record', 'js', 'row_hover.js')
			));
		});

		/**
		 * Three tiles; render_hover builds an overlay with one editor node.
		 * `failures` (consumed once per index) makes that render end without an
		 * overlay: it throws, answers null, or the row is replaced meanwhile —
		 * after `hold` resolves, when given (a render still in flight).
		 */
		function situation(
			failures = new Map<number, 'throw' | 'null' | 'replaced'>(),
			hold: Promise<unknown> | null = null,
		) {
			uncommitted.clear();
			editor_commits = false;
			const content_data = new FakeEl('content_data');
			for (let i = 0; i < 3; i++) {
				const row = new FakeEl('section_record');
				row.dataset.index = String(i);
				content_data.appendChild(row);
			}
			const rendered: number[] = [];
			const editors = new Map<number, FakeEl>();
			const caller: Record<string, any> = {
				model: 'component_portal',
				tipo: 'test80',
				ar_instances: [],
			};
			const render_hover = async (index: number) => {
				rendered.push(index);
				const failure = failures.get(index);
				failures.delete(index);
				if (failure && hold) await hold;
				if (failure === 'throw') throw new Error('planted render failure');
				if (failure === 'null') return null;
				if (failure === 'replaced') {
					// the window rebuilt the row while the render was in flight
					const fresh = new FakeEl('section_record');
					fresh.dataset.index = String(index);
					fresh.parentElement = content_data;
					content_data.children[index] = fresh;
				}
				const instance: Record<string, any> = {
					status: 'rendered',
					caller,
					destroy: async () => {},
				};
				instance.destroy = async () => {
					instance.status = 'destroyed';
				};
				const node = new FakeEl('section_record');
				const wrapper = node.appendChild(new FakeEl('wrapper_component'));
				const editor = wrapper.appendChild(new FakeEl('input_value'));
				editor.dispatchEvent = (event: { type: string }) => {
					editor.dispatched.push(event.type);
					if (event.type === 'change') {
						uncommitted.delete(editor); // the events.js capture deregistration
						if (editor_commits) seq.set(instance, (seq.get(instance) ?? 0) + 1);
					}
					return true;
				};
				const editor_instance = { caller: instance };
				instance_by_wrapper.set(wrapper, editor_instance);
				seq.set(editor_instance, 0);
				editors.set(index, editor);
				return { instance, node };
			};
			const controller = delegate_row_hover({ caller, content_data, render_hover });
			const overlay_on = (i: number) =>
				(content_data.children[i] as FakeEl).children.some((c) =>
					c.classList.contains('sr_mosaic_hover'),
				);
			return { content_data, controller, rendered, editors, overlay_on };
		}

		test('pending → deferred; focusout after the commit shows the tile the pointer is on', async () => {
			const { content_data, controller, rendered, editors, overlay_on } = situation();
			const row = (i: number) => content_data.children[i] as FakeEl;

			fire('pointerover', row(0));
			await controller.idle();
			expect(controller.index).toBe(0);
			expect(overlay_on(0)).toBe(true);

			// a typed-not-committed value in the overlay, its editor ignoring change
			const editor = editors.get(0) as FakeEl;
			uncommitted.add(editor);

			fire('pointerover', row(1));
			await controller.idle();
			expect(controller.deferred, 'the pending node defers the teardown').toBe(true);
			expect(overlay_on(0)).toBe(true);
			expect(rendered).toEqual([0]);

			// the pointer moves within tile 1: the guard drops the repeat
			fire('pointerover', row(1));
			await controller.idle();
			expect(rendered).toEqual([0]);

			// the user commits (blur) — the node leaves the registry — focus leaves the overlay
			uncommitted.delete(editor);
			fire('focusout', editor, null);
			await controller.idle();
			expect(controller.deferred).toBe(false);
			expect(overlay_on(0), 'the deferred overlay is torn down').toBe(false);
			expect(rendered, 'the tile under the pointer gets its overlay').toEqual([0, 1]);
			expect(controller.index).toBe(1);
			expect(overlay_on(1)).toBe(true);
		});

		test('control: a still-pending node keeps deferring and renders nothing', async () => {
			const { content_data, controller, rendered, editors, overlay_on } = situation();
			const row = (i: number) => content_data.children[i] as FakeEl;
			fire('pointerover', row(0));
			await controller.idle();
			const editor = editors.get(0) as FakeEl;
			uncommitted.add(editor);
			fire('pointerover', row(2));
			await controller.idle();
			fire('focusout', editor, null);
			await controller.idle();
			expect(controller.deferred).toBe(true);
			expect(overlay_on(0)).toBe(true);
			expect(rendered).toEqual([0]);
			expect(uncommitted.has(editor), 'the pending node is re-registered').toBe(true);
		});

		test('control: focusout while the pointer is back on the deferred tile tears nothing down', async () => {
			const { content_data, controller, rendered, editors, overlay_on } = situation();
			const row = (i: number) => content_data.children[i] as FakeEl;
			fire('pointerover', row(0));
			await controller.idle();
			const editor = editors.get(0) as FakeEl;
			uncommitted.add(editor);
			fire('pointerover', row(1));
			await controller.idle();
			fire('pointerover', row(0)); // back on tile 0
			await controller.idle();
			uncommitted.delete(editor);
			fire('focusout', editor, null);
			await controller.idle();
			expect(controller.index).toBe(0);
			expect(overlay_on(0)).toBe(true);
			expect(rendered).toEqual([0]);
		});

		test('control: pointer left the mosaic → the retry tears down and shows nothing', async () => {
			const { content_data, controller, rendered, editors, overlay_on } = situation();
			const row = (i: number) => content_data.children[i] as FakeEl;
			fire('pointerover', row(0));
			await controller.idle();
			const editor = editors.get(0) as FakeEl;
			uncommitted.add(editor);
			fire('pointerleave', content_data);
			await controller.idle();
			expect(controller.deferred).toBe(true);
			uncommitted.delete(editor);
			fire('focusout', editor, null);
			await controller.idle();
			expect(controller.index).toBeNull();
			expect(overlay_on(0)).toBe(false);
			expect(rendered).toEqual([0]);
		});

		// A render that ends without an overlay must not leave `wanted` naming the
		// tile: the pointerover guard (`row.index===wanted`) would drop every later
		// pointerover on it, so the tile under the pointer never got its overlay
		// until the pointer left it.
		for (const failure of ['throw', 'null', 'replaced'] as const) {
			test(`a ${failure} render releases the tile: the next pointerover on it renders`, async () => {
				const quiet = console.error;
				console.error = () => {};
				try {
					const { content_data, controller, rendered, overlay_on } = situation(
						new Map([[1, failure]]),
					);
					const row = (i: number) => content_data.children[i] as FakeEl;
					fire('pointerover', row(1));
					await controller.idle();
					expect(rendered).toEqual([1]);
					expect(controller.index, 'nothing shown').toBeNull();
					expect(overlay_on(1)).toBe(false);
					// the pointer moves within the same tile
					fire('pointerover', row(1));
					await controller.idle();
					expect(rendered, 'the tile is rendered again').toEqual([1, 1]);
					expect(controller.index).toBe(1);
					expect(overlay_on(1)).toBe(true);
				} finally {
					console.error = quiet;
				}
			});
		}

		test('control: a lost render for a tile the pointer LEFT keeps the newer wanted', async () => {
			let release = () => {};
			const hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { content_data, controller, rendered, overlay_on } = situation(
				new Map([[0, 'null']]),
				hold,
			);
			const row = (i: number) => content_data.children[i] as FakeEl;
			fire('pointerover', row(0));
			while (rendered.length === 0) await Promise.resolve(); // 0's render in flight
			fire('pointerover', row(2)); // the pointer moved on meanwhile
			release();
			await controller.idle();
			expect(rendered).toEqual([0, 2]);
			expect(controller.index).toBe(2);
			expect(overlay_on(2)).toBe(true);
			// the newer tile is still the wanted one: a repeat renders nothing
			fire('pointerover', row(2));
			await controller.idle();
			expect(rendered).toEqual([0, 2]);
		});
	});

	describe('C. build(true) tears the live hover down through its controller (failed edit orphaned)', () => {
		let delegate_row_hover: (options: Record<string, unknown>) => {
			index: number | null;
			instance: object | null;
			idle: () => Promise<void>;
		};
		let destroy_unwindowed_dependencies: (owner: object) => Promise<void>;
		beforeAll(async () => {
			({ delegate_row_hover } = await import(
				join(CLIENT_CORE, 'section_record', 'js', 'row_hover.js')
			));
			({ destroy_unwindowed_dependencies } = await import(
				join(CLIENT_CORE, 'common', 'js', 'common.js')
			));
		});

		/** A portal with one window row, a live hover on tile 0 with one editor, one other dependency. */
		async function situation(save_fails: boolean) {
			uncommitted.clear();
			unsaved.clear();
			failing.clear();
			orphaned.length = 0;
			const content_data = new FakeEl('content_data');
			for (let i = 0; i < 2; i++) {
				const row = new FakeEl('section_record');
				row.dataset.index = String(i);
				content_data.appendChild(row);
			}
			const destroyed: object[] = [];
			const make = (extra: Record<string, unknown> = {}) => {
				const instance: Record<string, any> = { status: 'rendered', ...extra };
				instance.destroy = async (_self?: boolean, deps?: boolean) => {
					instance.status = 'destroyed';
					destroyed.push(instance);
					// the common.destroy cascade: children go, and leave the unsaved registry
					if (deps)
						for (const child of instance.ar_instances ?? []) await child.destroy(true, true);
					unsaved.delete(instance);
				};
				return instance;
			};
			const window_row = make();
			const other = make();
			const owner: Record<string, any> = {
				model: 'component_portal',
				tipo: 'test80',
				ar_instances: [window_row, other],
				record_windows: {
					rows: { size: 1, record_at: (i: number) => (i === 0 ? window_row : null) },
				},
			};
			const made: { editor?: Record<string, any> } = {};
			const render_hover = async () => {
				const hover = make({ caller: owner });
				made.editor = make({ caller: hover });
				hover.ar_instances = [made.editor];
				const node = new FakeEl('section_record');
				node.appendChild(new FakeEl('wrapper_component'));
				return { instance: hover, node };
			};
			const controller = delegate_row_hover({ caller: owner, content_data, render_hover });
			fire('pointerover', content_data.children[0] as FakeEl);
			await controller.idle();
			const hover = controller.instance as Record<string, any>;
			expect(hover, 'the hover overlay is live').toBeTruthy();
			expect(owner.ar_instances).toContain(hover);
			// the user typed in the overlay; the save failed → still unsaved
			const editor = made.editor as Record<string, any>;
			unsaved.add(editor);
			if (save_fails) failing.add(editor);
			return { owner, controller, hover, editor, window_row, other, destroyed };
		}

		test('a failed-save hover editor is orphaned, not destroyed', async () => {
			const { owner, hover, editor, window_row, other } = await situation(true);
			await destroy_unwindowed_dependencies(owner);
			expect(orphaned, 'the failed edit is orphaned').toContain(editor);
			expect(editor.status, 'the orphan is never destroyed').not.toBe('destroyed');
			expect(unsaved.has(editor), 'the edit stays in the unsaved guard').toBe(true);
			expect(owner.row_hovers?.rows, 'the controller left its slot').toBeUndefined();
			expect(owner.ar_instances).not.toContain(hover);
			expect(other.status, 'non-window dependencies still go').toBe('destroyed');
			expect(window_row.status, 'the window row is held').toBe('rendered');
			expect(owner.ar_instances).toEqual([window_row]);
		});

		test('control: a clean hover editor is not orphaned', async () => {
			const { owner, editor, other } = await situation(false);
			await destroy_unwindowed_dependencies(owner);
			// a unit control over a planted situation, not a census: the clean editor
			// itself is named, and nothing else was orphaned either
			expect(orphaned, 'the clean edit is not orphaned').not.toContain(editor);
			expect(orphaned, 'nothing was orphaned').toHaveLength(0);
			expect(other.status).toBe('destroyed');
			expect(owner.row_hovers?.rows).toBeUndefined();
		});
	});
}
