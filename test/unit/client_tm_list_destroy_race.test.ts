/**
 * SECTION_RECORD ROW RENDER SURVIVES A DESTROY MID-RENDER — the contract of
 *   client/dedalo/core/section_record/js/view_default_list_section_record.js
 * plus the serialization that stops the race from happening at all in
 *   client/dedalo/core/inspector/js/render_inspector.js (load_time_machine_list)
 *
 * WHY THIS FILE EXISTS. The inspector's "Latest changes" panel has TWO
 * independent triggers for the same load — the block's expose callback
 * (render_inspector.js) and the `save` / update_section_info idle callbacks
 * (inspector.js) — and they can fire in the same frame. Unserialized, the second
 * call runs `self.tm_list.destroy(true, true)` first, and destroy() nullifies
 * `caller` on every section_record it owns (common.js do_delete_self). The first
 * call is by then INSIDE `get_content_data`, awaiting its column instances; when
 * it resumes, `render_empty_column_node` reads `self.caller.model` and the row
 * render dies with
 *
 *   TypeError: Cannot read properties of null (reading 'model')
 *
 * The panel then stays stuck on `loading`, with the failure surfacing only as an
 * unhandled rejection in the console. Reported live against oh1‑1.
 *
 * Two things are pinned here, because the fix is two-layered:
 *
 *  1. THE SHIELD (functional). A row render whose instance is destroyed across
 *     the `get_content_data` await RESOLVES with a node instead of throwing —
 *     including the zero-instance column path, which is the one that actually
 *     threw. `biome.jsonc` excludes `**\/client`, so nothing else looks at this
 *     module; without this test the regression is silent again.
 *  2. THE ROOT FIX (source shape). `load_time_machine_list` chains through
 *     `self.tm_list_loading` so overlapping loads QUEUE instead of destroying
 *     each other's in-flight render. render_inspector.js cannot be imported here
 *     (its import graph reaches serving seams that are not paths on disk), so
 *     this half is a source assertion.
 *
 * HONEST LIMIT of (2): it proves the serialization is still wired, not that the
 * chain is correct under every trigger order. (1) is the behavioural net under it.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file substitutes client
// modules, which are process-global — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CLIENT_CORE = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');
	const UI_PATH = join(CLIENT_CORE, 'common', 'js', 'ui.js');
	const EVENTS_PATH = join(CLIENT_CORE, 'common', 'js', 'events.js');
	const VIEW_PATH = join(
		CLIENT_CORE,
		'section_record',
		'js',
		'view_default_list_section_record.js',
	);
	const INSPECTOR_PATH = join(CLIENT_CORE, 'inspector', 'js', 'render_inspector.js');

	// ────────────────────────────────────────────────────────────────────────────
	// Minimal DOM: exactly the surface this view touches
	// ────────────────────────────────────────────────────────────────────────────

	class FakeNode {
		tag: string;
		classes: string[] = [];
		children: FakeNode[] = [];
		attributes = new Map<string, string>();
		text = '';
		id = '';
		constructor(tag: string) {
			this.tag = tag;
		}
		// the row window stamps data-index / role on the row node it is handed
		// (WC-2026-10-30-section-record-row-box)
		setAttribute(name: string, value: string) {
			this.attributes.set(name, String(value));
		}
		getAttribute(name: string): string | null {
			return this.attributes.get(name) ?? null;
		}
		get dataset(): Record<string, string> {
			const out: Record<string, string> = {};
			for (const [name, value] of this.attributes) {
				if (name.startsWith('data-')) out[name.slice(5)] = value;
			}
			return out;
		}
		get textContent(): string {
			return this.text + this.children.map((c) => c.textContent).join('');
		}
		/** The two shapes mark_empty_columns uses: `:scope > .x` and a tag list. */
		querySelectorAll(selector: string): FakeNode[] {
			const scoped = /^:scope\s*>\s*\.([\w-]+)$/.exec(selector);
			if (scoped) return this.children.filter((c) => c.classes.includes(scoped[1] ?? ''));
			const tags = selector.split(',').map((t) => t.trim().toLowerCase());
			const out: FakeNode[] = [];
			const walk = (node: FakeNode) => {
				for (const child of node.children) {
					if (tags.includes(child.tag.toLowerCase())) out.push(child);
					walk(child);
				}
			};
			walk(this);
			return out;
		}
		querySelector(selector: string): FakeNode | null {
			return this.querySelectorAll(selector)[0] ?? null;
		}
		classList = {
			add: (...names: string[]) => {
				for (const name of names) if (name && !this.classes.includes(name)) this.classes.push(name);
			},
			remove: (...names: string[]) => {
				this.classes = this.classes.filter((c) => !names.includes(c));
			},
			contains: (name: string) => this.classes.includes(name),
		};
		appendChild(child: FakeNode): FakeNode {
			// a fragment splices its children in, as the real DOM does
			if (child instanceof FakeFragment) {
				this.children.push(...child.children);
				child.children = [];
				return child;
			}
			this.children.push(child);
			return child;
		}
		addEventListener() {}
	}

	class FakeFragment extends FakeNode {
		constructor() {
			super('#fragment');
		}
	}

	/** Mirrors the real factory's option subset used by this module. */
	const fake_create_dom_element = (options: Record<string, unknown>) => {
		const node = new FakeNode(String(options.element_type ?? 'div'));
		if (options.class_name) node.classList.add(...String(options.class_name).split(' '));
		if (options.id) node.id = String(options.id);
		const parent = options.parent as FakeNode | undefined;
		if (parent) parent.appendChild(node);
		return node;
	};

	const globals = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};

	type ViewModule = {
		view_default_list_section_record: {
			render: (self: unknown, options: unknown) => Promise<unknown>;
		};
	};

	let view_module: ViewModule;

	/**
	 * A section_record double. `destroy_on_columns` reproduces the race exactly:
	 * the concurrent reload lands while `get_ar_columns_instances_list()` is awaited,
	 * so `caller` is already null when the column loop resumes.
	 */
	const make_section_record = (options: {
		destroy_on_columns: boolean;
		filled_column?: boolean;
	}) => {
		const self = {
			id: 'sr_test',
			model: 'section_record',
			tipo: 'dd15',
			mode: 'list',
			context: { view: 'line' },
			caller: { model: 'section', permissions: 3 } as { model: string } | null,
			// a zero-instance column: the exact path through render_empty_column_node
			// (plus, when asked, a callback column that renders a value)
			columns_map: [
				{ id: 'dd1574', label: 'Value' },
				...(options.filled_column
					? [
							{
								id: 'dd1573',
								label: 'Who',
								callback: () => {
									const node = new FakeNode('span');
									node.text = 'Admin';
									return node;
								},
							},
						]
					: []),
			],
			get_ar_columns_instances_list: async () => {
				await Promise.resolve();
				if (options.destroy_on_columns) {
					// what common.js do_delete_self does to every owned instance
					self.caller = null;
				}
				return [];
			},
		};
		return self;
	};

	beforeAll(async () => {
		for (const key of ['document', 'SHOW_DEBUG', 'window', 'DocumentFragment', 'Node'])
			saved[key] = globals[key];

		const fake_document = new FakeNode('#document');
		(fake_document as unknown as Record<string, unknown>).createElement = (tag: string) =>
			new FakeNode(tag);
		globals.document = fake_document;
		globals.SHOW_DEBUG = false;
		globals.window = globalThis;
		globals.DocumentFragment = FakeFragment;
		// the callback-column guard checks `instanceof Node`
		globals.Node = FakeNode;

		// (!) The real ui.js imports core/tools_common/js/tool_common.js, a SERVING
		// seam with no relative path on disk — mocking it is the only way to import
		// the module under test. Same reason as client_upload_queue_render.test.ts.
		mock.module(UI_PATH, () => ({
			ui: {
				create_dom_element: fake_create_dom_element,
				make_column_responsive: () => true,
			},
		}));
		// OVERRIDE, NEVER REPLACE. `mock.module` is process-global and bun test
		// shares one process, so a mock that returns only the exports THIS file
		// happens to use silently truncates the module for every other file that
		// imports it — they then fail at import with "Export named 'x' not found",
		// nowhere near the cause. Measured 2026-08-21: this mock hid
		// `dd_request_idle_callback` from client_upload_queue_render. Spreading the
		// real module keeps the surface whole and still stubs what this file needs.
		const real_events = (await import(EVENTS_PATH)) as Record<string, unknown>;
		mock.module(EVENTS_PATH, () => ({
			...real_events,
			when_in_dom: () => true,
		}));

		view_module = (await import(VIEW_PATH)) as ViewModule;
	});

	afterAll(() => {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete globals[key];
			else globals[key] = saved[key];
		}
		mock.restore();
	});

	describe('section_record row render — destroy mid-render', () => {
		test('the healthy row still renders its columns', async () => {
			const self = make_section_record({ destroy_on_columns: false });

			const node = (await view_module.view_default_list_section_record.render(self, {
				add_hilite_row: true,
			})) as FakeNode;

			expect(node).toBeInstanceOf(FakeNode);
			expect(node.id).toBe('sr_test');
			// the empty placeholder column keeps the grid aligned
			expect(node.children.length).toBe(1);
			expect(node.children[0]?.classes).toContain('empty');
		});

		test('a row destroyed across the await resolves instead of throwing', async () => {
			const self = make_section_record({ destroy_on_columns: true });

			// Before the fix this rejected with
			// "Cannot read properties of null (reading 'model')" out of
			// render_empty_column_node, leaving the inspector panel on `loading`.
			const node = (await view_module.view_default_list_section_record.render(self, {
				add_hilite_row: true,
			})) as FakeNode;

			expect(node).toBeInstanceOf(FakeNode);
			expect(self.caller).toBeNull();
			// the node is orphaned — the WINNING render owns the DOM, so this one
			// deliberately carries no columns
			expect(node.children.length).toBe(0);
		});
	});

	// The TM tool list marks its value-less cells per ROW (render option), so a row
	// the row window builds later (a placeholder swap) is marked too
	// (WC-2026-10-30-section-record-row-box). The destroy path must stay inert.
	describe('section_record row render — mark_empty_columns', () => {
		test('a healthy row marks ONLY its value-less cells', async () => {
			const self = make_section_record({ destroy_on_columns: false, filled_column: true });

			const node = (await view_module.view_default_list_section_record.render(self, {
				add_hilite_row: false,
				mark_empty_columns: true,
			})) as FakeNode;

			expect(node.children.length).toBe(2);
			const [empty, filled] = node.children;
			expect(empty?.classes).toContain('empty_column');
			expect(filled?.textContent).toBe('Admin');
			expect(filled?.classes).not.toContain('empty_column');
		});

		test('without the option nothing is marked (the option is the only switch)', async () => {
			const self = make_section_record({ destroy_on_columns: false, filled_column: true });

			const node = (await view_module.view_default_list_section_record.render(self, {
				add_hilite_row: false,
			})) as FakeNode;

			expect(node.children.length).toBe(2);
			for (const column of node.children) expect(column.classes).not.toContain('empty_column');
		});

		test('a row destroyed across the await resolves and marks nothing', async () => {
			const self = make_section_record({ destroy_on_columns: true, filled_column: true });

			const node = (await view_module.view_default_list_section_record.render(self, {
				add_hilite_row: false,
				mark_empty_columns: true,
			})) as FakeNode;

			expect(node).toBeInstanceOf(FakeNode);
			expect(self.caller).toBeNull();
			// the orphaned node carries no columns, so there is nothing to mark
			expect(node.children.length).toBe(0);
			expect(node.querySelectorAll(':scope > .column').length).toBe(0);
		});
	});

	describe('load_time_machine_list serializes its two triggers', () => {
		const source = readFileSync(INSPECTOR_PATH, 'utf8');

		test('the exported entry point routes through the shared serializer load_block', () => {
			const entry = source.slice(source.indexOf('export const load_time_machine_list'));
			const body = entry.slice(0, entry.indexOf('}//end load_time_machine_list'));

			expect(body).toContain('load_block(');
			// the run that destroys self.tm_list is the SERIALIZED task
			expect(body).toContain('load_time_machine_list_instance(self)');
			// the destroy lives in the serialized task, never in the entry point
			expect(body).not.toContain('self.tm_list.destroy');
		});

		test('load_block chains each load per container, and a failure does not poison the chain', () => {
			const entry = source.slice(source.indexOf('export const load_block'));
			const body = entry.slice(0, entry.indexOf('}//end load_block'));

			// the previous load is awaited BEFORE the next one starts
			expect(body).toContain('container._block_load');
			expect(body).toMatch(/previous\s*\.catch\(\s*\(\)\s*=>\s*null\s*\)\s*\.then\(start\)/);
		});

		test('the destroy that nullifies section_record callers is inside the serialized task', () => {
			const run = source.slice(source.indexOf('const load_time_machine_list_instance'));
			const body = run.slice(0, run.indexOf('}//end load_time_machine_list_instance'));

			expect(body).toContain('self.tm_list.destroy');
		});
	});
}
