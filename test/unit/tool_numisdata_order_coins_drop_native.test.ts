/**
 * THE ORDERED-COINS DROP TARGET — the delegated drop of
 *   tools/tool_numisdata_order_coins/js/render_tool_numisdata_order_coins.js
 *   (drop_target_of, bind_ordered_coins_drop, mark_coin_used)
 * driven through the REAL module, the REAL record_window `row_of`, the REAL
 * common.js `lock_rows` and the REAL touch_pick (WC-2026-10-30-section-record-row-box).
 *
 * Since the row box the slots of the right panel are no per-node listeners:
 * ONE listener set on the ordered-coins wrapper resolves, PER EVENT, the row
 * (`row_of` over the wrapper's CURRENT content_data), its OWN
 * slot cell (`ORDERED_COINS_SLOT`) (a direct child of the row — never a slot of a
 * record nested inside a cell) and the slot's component from the row window's
 * `record_at` — never a node pointer. Legs:
 *  1. dragover on a slot: default prevented (drop enabled), propagation
 *     stopped, dropEffect 'move', the slot marked; ANYWHERE ELSE (another
 *     column, a placeholder row, a nested record's slot, outside the rows)
 *     nothing is prevented or stopped, so the portal's own handlers decide.
 *  2. drop on a slot: `assign_element` receives the slot's component (the
 *     record of THAT row) and the payload's locator; then the right panel is
 *     rebuilt UNDER THE ROW LOCK (lock_rows on ordered_coins: one commit, the
 *     freeze lifted) and ONLY the matching coin tile of the left mosaic is
 *     marked used. A malformed payload assigns nothing.
 *  3. resolution is at EVENT time: a page change (new content_data, new row
 *     window) is followed without re-binding.
 *  4. touch placement: a tap on a slot while a coin is picked places THAT pick
 *     (consumed); a tap elsewhere leaves a foreign pick alive and the event
 *     untouched; a tap with nothing picked does nothing.
 *  5. dragleave: leaving into the slot's own child keeps the mark; leaving the
 *     slot removes it.
 *
 * HERMETIC + ISOLATED GATE (ui.js / css.js substituted; a resolver plugin maps
 * the tool's serving-relative `../../../core/` imports onto client/dedalo/core).
 */

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { plugin } from 'bun';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_CORE = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');
	const TOOLS_ROOT = join(import.meta.dir, '..', '..', 'tools');
	const RENDER_PATH = join(
		TOOLS_ROOT,
		'tool_numisdata_order_coins',
		'js',
		'render_tool_numisdata_order_coins.js',
	);

	// The serving alias (/dedalo/tools/* imports back into /dedalo/core/*), for
	// importers under tools/ only, and only when plain resolution has no file.
	plugin({
		name: 'tool-numisdata-order-coins-serve-alias',
		setup(build) {
			build.onResolve({ filter: /^\.\.?\// }, (args) => {
				const importer = args.importer ?? '';
				if (!importer.startsWith(TOOLS_ROOT)) return undefined;
				const direct = resolve(dirname(importer), args.path);
				if (existsSync(direct)) return { path: direct };
				const matched = args.path.match(/(?:^|\/)core\/(.+)$/);
				const rest = matched?.[1];
				if (rest !== undefined && existsSync(join(CLIENT_CORE, rest)))
					return { path: join(CLIENT_CORE, rest) };
				return undefined;
			});
		},
	});

	// ── fake DOM ───────────────────────────────────────────────────────────────
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
	type Handler = (e: FakeEvent) => void;
	class FakeEl {
		nodeType = 1;
		children: FakeEl[] = [];
		parentElement: FakeEl | null = null;
		classList = new FakeClassList();
		dataset: Record<string, string> = {};
		listeners = new Map<string, Handler[]>();
		content_data?: FakeEl;
		className = '';
		textContent = '';
		type = '';
		constructor(...classes: string[]) {
			this.classList.add(...classes);
		}
		get firstChild(): FakeEl | null {
			return this.children[0] ?? null;
		}
		appendChild(child: FakeEl) {
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		removeChild(child: FakeEl) {
			this.children = this.children.filter((c) => c !== child);
			child.parentElement = null;
			return child;
		}
		remove() {
			this.parentElement?.removeChild(this);
		}
		setAttribute() {}
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
		querySelector(selector: string): FakeEl | null {
			// only ':scope > .column_original .drag'
			const column = this.children.find((c) => c.classList.contains('column_original'));
			const find = (n: FakeEl): FakeEl | null => {
				for (const c of n.children) {
					if (c.classList.contains('drag')) return c;
					const deep = find(c);
					if (deep) return deep;
				}
				return null;
			};
			return selector.includes('column_original') && column ? find(column) : null;
		}
		addEventListener(type: string, fn: Handler) {
			const list = this.listeners.get(type) ?? [];
			list.push(fn);
			this.listeners.set(type, list);
		}
	}
	class FakeDataTransfer {
		dropEffect = '';
		constructor(private readonly data: string) {}
		getData(type: string) {
			return type === 'text/plain' ? this.data : '';
		}
	}
	type FakeEvent = {
		type: string;
		target: FakeEl;
		relatedTarget: FakeEl | null;
		dataTransfer: FakeDataTransfer | null;
		prevented: boolean;
		stopped: boolean;
		preventDefault: () => void;
		stopPropagation: () => void;
	};
	function fire(
		type: string,
		target: FakeEl,
		options: { data?: string; relatedTarget?: FakeEl | null } = {},
	): FakeEvent {
		const event: FakeEvent = {
			type,
			target,
			relatedTarget: options.relatedTarget ?? null,
			dataTransfer: options.data === undefined ? null : new FakeDataTransfer(options.data),
			prevented: false,
			stopped: false,
			preventDefault: () => {
				event.prevented = true;
			},
			stopPropagation: () => {
				event.stopped = true;
			},
		};
		for (let n: FakeEl | null = target; n && !event.stopped; n = n.parentElement) {
			for (const fn of n.listeners.get(type) ?? []) fn(event);
		}
		return event;
	}

	// ── substitutions: ui.js (its one export), css.js (spread) ────────────────
	mock.module(join(CLIENT_CORE, 'common', 'js', 'ui.js'), () => ({
		ui: {
			create_dom_element: (options: { class_name?: string; parent?: FakeEl }) => {
				const el = new FakeEl(...(options?.class_name ?? '').split(' ').filter(Boolean));
				options?.parent?.appendChild(el);
				return el;
			},
			activate_tooltips: () => {},
		},
	}));
	const CSS_PATH = join(CLIENT_CORE, 'page', 'js', 'css.js');
	const real_css = await import(CSS_PATH);
	mock.module(CSS_PATH, () => ({ ...real_css, get_inserted_rules: () => [] }));

	const g = globalThis as Record<string, any>;
	const saved: Record<string, unknown> = {};
	// biome-ignore lint/suspicious/noExplicitAny: the module under test is untyped client JS
	let coins: any;
	// biome-ignore lint/suspicious/noExplicitAny: idem
	let touch_pick: any;

	beforeAll(async () => {
		for (const key of [
			'page_globals',
			'Node',
			'get_label',
			'SHOW_DEBUG',
			'SHOW_DEVELOPER',
			'window',
			'document',
		]) {
			saved[key] = g[key];
		}
		g.window = g.window ?? g;
		g.page_globals = { page_error: null };
		g.Node = { ELEMENT_NODE: 1 };
		g.get_label = {};
		g.SHOW_DEBUG = false;
		g.SHOW_DEVELOPER = false;
		g.document = { createElement: () => new FakeEl(), body: new FakeEl() };
		coins = await import(RENDER_PATH);
		touch_pick = await import(join(CLIENT_CORE, 'common', 'js', 'touch_pick.js'));
	});
	afterAll(() => {
		touch_pick?.cancel();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete g[key];
			else g[key] = value;
		}
		mock.restore();
	});

	// ── the situation: ordered_coins (3 rows, row 2 a placeholder) + the coin mosaic ──
	type Situation = ReturnType<typeof situation>;
	function situation() {
		const make_rows = (page: string) => {
			const content_data = new FakeEl('content_data');
			const slots: FakeEl[] = [];
			const others: FakeEl[] = [];
			const nested_slots: FakeEl[] = [];
			const records: Array<Record<string, unknown> | null> = [];
			for (let i = 0; i < 3; i++) {
				const row = content_data.appendChild(new FakeEl('section_record'));
				row.dataset.index = String(i);
				if (i === 2) {
					row.classList.add('placeholder');
					records.push(null);
				}
				// the slot column is the tool's OWN declaration, read from the module
				const slot = row.appendChild(new FakeEl('column', `column_${coins.ORDERED_COINS_SLOT}`));
				slot.appendChild(new FakeEl('wrapper_component'));
				const other = row.appendChild(new FakeEl('column', 'column_test52'));
				// a record nested inside a cell, with its own slot column
				const nested = other.appendChild(new FakeEl('section_record'));
				const nested_slot = nested.appendChild(
					new FakeEl('column', `column_${coins.ORDERED_COINS_SLOT}`),
				);
				slots.push(slot);
				others.push(other);
				nested_slots.push(nested_slot);
				if (i !== 2) {
					records.push({
						ar_instances: [
							{ column_id: 'test52', id: `${page}_r${i}_other` },
							{ column_id: coins.ORDERED_COINS_SLOT, id: `${page}_r${i}_slot` },
						],
					});
				}
			}
			const record_window = {
				record_at: (i: number) => records[i] ?? null,
				commits: 0,
				inert: false,
				commit_uncommitted: () => {
					record_window.commits++;
					return { pending: [] };
				},
				freeze: () => {
					record_window.inert = true;
				},
				thaw: () => {
					record_window.inert = false;
				},
			};
			return { content_data, slots, others, nested_slots, record_window };
		};

		const page1 = make_rows('p1');
		const wrapper = new FakeEl('wrapper_component', 'component_portal');
		wrapper.content_data = page1.content_data;
		wrapper.appendChild(page1.content_data);
		const ancestor = new FakeEl('ancestor');
		ancestor.appendChild(wrapper);
		const ancestor_seen: string[] = [];
		for (const type of ['dragover', 'drop', 'click', 'dragleave']) {
			ancestor.addEventListener(type, (e) => ancestor_seen.push(e.type));
		}

		// left mosaic: coins a/b/c, each tile with its .column_original .drag
		const left_cd = new FakeEl('content_data');
		const coin_entries = ['101', '102', '103'].map((id) => ({
			section_tipo: 'test3',
			section_id: id,
		}));
		const drags: FakeEl[] = coin_entries.map((_entry, i) => {
			const tile = left_cd.appendChild(new FakeEl('section_record'));
			tile.dataset.index = String(i);
			const column = tile.appendChild(new FakeEl('column_original'));
			return column.appendChild(new FakeEl('drag'));
		});

		const assigned: Array<{ caller: unknown; locator: unknown }> = [];
		let rebuilds = 0;
		const self: Record<string, any> = {
			node: { content_data: { right_container: new FakeEl('right_container') } },
			ordered_coins: {
				record_windows: { rows: page1.record_window },
				show_interface: {},
				destroy: async () => {},
				build: async () => true,
				render: async () => {
					rebuilds++;
					const node = new FakeEl('wrapper_component');
					node.content_data = new FakeEl('content_data');
					return node;
				},
			},
			coins: {
				record_windows: {
					rows: { size: coin_entries.length, entry_of: (i: number) => coin_entries[i] ?? null },
				},
				node: { content_data: left_cd },
			},
			assign_element: async (options: { caller: unknown; locator: unknown }) => {
				assigned.push(options);
				return true;
			},
		};
		const bound = coins.bind_ordered_coins_drop(self, wrapper);
		return {
			self,
			wrapper,
			page1,
			make_rows,
			drags,
			assigned,
			ancestor_seen,
			bound,
			rebuilds: () => rebuilds,
		};
	}
	const payload = (section_id: string) =>
		JSON.stringify({ locator: { section_tipo: 'test3', section_id }, kind: 'tool_row' });
	const settle = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	};

	describe('ordered-coins delegated drop target', () => {
		test('module exports the drop target trio; binding answers true', () => {
			expect(typeof coins.drop_target_of).toBe('function');
			expect(typeof coins.mark_coin_used).toBe('function');
			expect(coins.ORDERED_COINS_SLOT, 'the slot column is a tipo').toMatch(/^[a-z]+\d+$/);
			const s: Situation = situation();
			expect(s.bound).toBe(true);
			expect(coins.bind_ordered_coins_drop(s.self, null)).toBe(false);
		});

		test('1. dragover on a slot enables the drop; anywhere else is left alone', () => {
			const s = situation();
			const slot_child = s.page1.slots[1]?.children[0] as FakeEl;
			const on_slot = fire('dragover', slot_child, { data: payload('101') });
			expect(on_slot.prevented && on_slot.stopped).toBe(true);
			expect(on_slot.dataTransfer?.dropEffect).toBe('move');
			expect(s.page1.slots[1]?.classList.contains('dragover')).toBe(true);
			expect(s.ancestor_seen).toEqual([]);

			for (const [what, target] of [
				['another column', s.page1.others[0]],
				['a placeholder row slot', s.page1.slots[2]],
				['a nested record slot', s.page1.nested_slots[0]],
				['content_data itself', s.page1.content_data],
				['the wrapper', s.wrapper],
			] as Array<[string, FakeEl]>) {
				const e = fire('dragover', target, { data: payload('101') });
				expect(e.prevented, `${what}: not prevented`).toBe(false);
				expect(e.stopped, `${what}: not stopped`).toBe(false);
			}
			expect(s.page1.nested_slots[0]?.classList.contains('dragover')).toBe(false);
			expect(s.page1.slots[2]?.classList.contains('dragover')).toBe(false);
			expect(s.ancestor_seen.length, 'every non-slot dragover bubbles on').toBe(5);
		});

		test('2. drop on a slot assigns THAT row’s component, rebuilds under the row lock, marks only that coin', async () => {
			const s = situation();
			const drop = fire('drop', s.page1.slots[1] as FakeEl, { data: payload('102') });
			expect(drop.prevented && drop.stopped).toBe(true);
			expect(s.page1.slots[1]?.classList.contains('drop_ordered_coins')).toBe(true);
			await settle();
			expect(s.assigned.length).toBe(1);
			expect((s.assigned[0]?.caller as { id: string }).id).toBe('p1_r1_slot');
			expect(s.assigned[0]?.locator).toEqual({ section_tipo: 'test3', section_id: '102' });
			// rebuilt under the lock: committed once, frozen, thawed
			expect(s.page1.record_window.commits).toBe(1);
			expect(s.page1.record_window.inert).toBe(false);
			expect(s.rebuilds()).toBe(1);
			expect(s.self.ordered_coins.row_lock_depth).toBe(0);
			// only coin 102's tile is used
			expect(s.drags.map((d) => d.classList.contains('used'))).toEqual([false, true, false]);
		});

		test('2b. a malformed payload assigns nothing (logged)', async () => {
			const s = situation();
			const errors = spyOn(console, 'error').mockImplementation(() => {});
			try {
				fire('drop', s.page1.slots[0] as FakeEl, { data: '{not json' });
				fire('drop', s.page1.slots[0] as FakeEl, { data: JSON.stringify({ kind: 'tool_row' }) });
				await settle();
				expect(s.assigned).toEqual([]);
				expect(errors).toHaveBeenCalledTimes(2);
				expect(s.rebuilds()).toBe(0);
			} finally {
				errors.mockRestore();
			}
		});

		test('2c. a drop off any slot is not consumed and assigns nothing', async () => {
			const s = situation();
			const e = fire('drop', s.page1.nested_slots[1] as FakeEl, { data: payload('101') });
			expect(e.prevented || e.stopped).toBe(false);
			await settle();
			expect(s.assigned).toEqual([]);
			expect(s.ancestor_seen).toEqual(['drop']);
		});

		test('3. resolution follows a page change without re-binding', async () => {
			const s = situation();
			// page 1 answers first (a resolver that caches its first answer is red below)
			const before = fire('dragover', s.page1.slots[0] as FakeEl, { data: payload('101') });
			expect(before.prevented).toBe(true);
			const page2 = s.make_rows('p2');
			s.page1.content_data.remove();
			s.wrapper.appendChild(page2.content_data);
			s.wrapper.content_data = page2.content_data;
			s.self.ordered_coins.record_windows.rows = page2.record_window;
			fire('drop', page2.slots[0] as FakeEl, { data: payload('103') });
			await settle();
			expect((s.assigned[0]?.caller as { id: string }).id).toBe('p2_r0_slot');
			// a slot of the replaced page is detached from the wrapper: nothing happens
			const stale = fire('drop', s.page1.slots[0] as FakeEl, { data: payload('101') });
			expect(stale.prevented).toBe(false);
		});

		test('4. touch placement: a tap on a slot places the pick; elsewhere a foreign pick survives', async () => {
			const s = situation();
			// nothing picked: a tap on a slot does nothing
			const idle = fire('click', s.page1.slots[0] as FakeEl);
			expect(idle.prevented).toBe(false);

			touch_pick.pick(payload('101'), 'coin 101');
			const elsewhere = fire('click', s.page1.others[0] as FakeEl);
			expect(elsewhere.prevented || elsewhere.stopped).toBe(false);
			expect(touch_pick.active(), 'a tap off any slot never consumes the pick').toBe(true);

			const tap = fire('click', s.page1.slots[0] as FakeEl);
			expect(tap.prevented && tap.stopped).toBe(true);
			expect(touch_pick.active(), 'the pick is consumed').toBe(false);
			await settle();
			expect((s.assigned[0]?.caller as { id: string }).id).toBe('p1_r0_slot');
			expect(s.assigned[0]?.locator).toEqual({ section_tipo: 'test3', section_id: '101' });
			expect(s.drags.map((d) => d.classList.contains('used'))).toEqual([true, false, false]);
		});

		test('5. dragleave into the slot’s own child keeps the mark; leaving the slot removes it', () => {
			const s = situation();
			const slot = s.page1.slots[0] as FakeEl;
			fire('dragover', slot, { data: payload('101') });
			expect(slot.classList.contains('dragover')).toBe(true);
			fire('dragleave', slot, { relatedTarget: slot.children[0] as FakeEl });
			expect(slot.classList.contains('dragover')).toBe(true);
			fire('dragleave', slot, { relatedTarget: s.page1.others[0] as FakeEl });
			expect(slot.classList.contains('dragover')).toBe(false);
		});

		test('mark_coin_used ignores a locator of another section tipo', () => {
			const s = situation();
			coins.mark_coin_used(s.self, { section_tipo: 'test80', section_id: '101' });
			expect(s.drags.some((d) => d.classList.contains('used'))).toBe(false);
		});
	});
}
