/**
 * GATE — the section/portal row box: `record_window.js` keeps the ROW INVARIANT,
 * the bound, and every pending edit (WC-2026-10-30-section-record-row-box).
 *
 *   client/dedalo/core/section_record/js/record_window.js
 *
 * HERMETIC. The module is pure by construction (its only imports are the three
 * `row_window.js` constants, and every DOM global it touches is read from
 * `container.ownerDocument` / its `defaultView`), so it runs here on a COUNTING
 * FAKE DOM with a fake IntersectionObserver and a fake requestAnimationFrame.
 * Nothing is substituted process-wide (no mock.module, no globalThis writes):
 * the fakes reach the module only through the container it is handed, so this
 * gate needs no isolated child process.
 *
 * Every edit-safety operation is INJECTED (`edit_safety`); this gate pins the
 * injected contract. The real bindings (ui.component.deactivate,
 * component_common settle/orphan_unsaved_instance, the events.js registry)
 * belong to the section/portal doors — which doors and which suites gate them
 * is staging state: WC-2026-10-30-section-record-row-box (Date / Decision). The fake
 * document REPRODUCES the events.js capture listener (`events.js` commit_handler:
 * every `change` removes its target from the uncommitted Set BEFORE the view's
 * own handler runs), so "pending" can only be judged by OUTCOME here, exactly
 * as in the browser.
 *
 * Legs (in order):
 *   1. invariant + bound for N ∈ {0, 1, 200, 201, 1000, 5000}, then seeded
 *      randomized grow/release/pin/reveal sequences (no row built twice while
 *      live, every superseded build destroyed once): children === N, data-index
 *      i at position i, N ≤ bound → no placeholder and NO observer constructed,
 *      N > bound → built ≤ bound + pinned, placeholders childless, aria-hidden,
 *      listener-free; a release goes down to EXACTLY bound − margin;
 *   2. each pin kind blocks release;
 *  2b. a pin that appears while the release flush awaits keeps the row (the
 *      verdict is re-checked after the flush); an edit that appears while a
 *      rebuild flush awaits refuses the rebuild;
 *   3. flush commits an uncommitted node before settle; pending is decided by
 *      outcome (an editor that ignores `change`, and a node with no in-row
 *      instance, are pending, re-registered and reported by commit_uncommitted
 *      / flush / destroy); a committing editor is not; the release-time flush
 *      verdict alone keeps a pending row (pin 5 blinded), and a pending row is
 *      released once its node is committed (re-judged, never sticky);
 *   4. an `owned_elsewhere` node (hover overlay) is skipped entirely;
 *   5. freeze / thaw;
 *   6. a failed settle orphans the instance exactly once and never destroys it;
 *      a release re-settles a recorded failure (still failing → kept; now
 *      succeeding → released);
 *   7. retire adoption (red-on-old: a fill-time adopted set would destroy a
 *      live row), the destroy set computed AFTER the retire flush, inert old
 *      container, aborted signal;
 *   8. generation: the window uses the one it is given, bumps only its own;
 *      another slot's window is untouched; every edit_safety binding, absent
 *      alone, is refused by name (census over the harness bindings, floored);
 *   9. N=3 → 0 supersession;
 *  10. the import set is the row_window.js constants only; no free page / DOM
 *      global (scope-resolved census, positive controls on an unexecuted
 *      branch), DOM read only through doc / view; the bound FOLLOWS
 *      the imported constant (measured: the module re-run against a scratch
 *      row_window.js exporting other values fills to THAT bound);
 *  11. a failed build keeps its index as [data-failed]; reveal retries it;
 *  12. a stale build (after destroy / retire) is never inserted; its instance
 *      is destroyed unless the successor window holds it;
 *  12b. teardown racing an in-flight step: destroy() during a release flushes
 *      the 'releasing' row and orphans its failed settle exactly once; a
 *      rebuild(i) resuming after retire / destroy destroys nothing;
 *  13. detached fill: --placeholder_size only after the container connects;
 *  14. destroy disconnects the observer, also when its flush throws (then
 *      generation++ and rejects);
 *  14b. a throwing edit-safety binding during a release leaves the row built
 *      and pinned, sticky (never stuck 'releasing'); during a retire, no row is
 *      destroyed, the map is cleared, the window torn down, logged once; a
 *      non-empty container throws;
 *  15. semantics sync: table with / without header, list, N=0 (header-less
 *      table drops role=table; a hidden header counts as absent; a later N>0
 *      window in the same list_body restores it), N > bound rowcount/rowindex
 *      offsets.
 *  Plus the pure helpers row_of / carry_row_attributes / apply_table_semantics
 *  and the keyboard focusin door.
 *
 * The decide_drop legs live in client_relation_move_native (stage 3), not here.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const RECORD_WINDOW_REL = 'client/dedalo/core/section_record/js/record_window.js';
const ROW_WINDOW_REL = 'client/dedalo/core/common/js/row_window.js';

// ─────────────────────────────────────────────────────────────────────────────
// The counting fake DOM
// ─────────────────────────────────────────────────────────────────────────────

type Listener = { type: string; fn: (event: FakeEvent) => void; capture: boolean };

class FakeEvent {
	type: string;
	bubbles: boolean;
	target: FakeElement | null = null;
	constructor(type: string, options: { bubbles?: boolean } = {}) {
		this.type = type;
		this.bubbles = options.bubbles === true;
	}
}

class FakeElement {
	tagName: string;
	ownerDocument: FakeDocument;
	parentNode: FakeElement | null = null;
	nodeType = 1;
	_children: FakeElement[] = [];
	_classes = new Set<string>();
	_attributes = new Map<string, string>();
	_listeners: Listener[] = [];
	/** Every addEventListener call ever made on this node (aborted ones included). */
	listener_calls = 0;
	inert = false;
	hovered = false;
	height = 0;
	_instance: unknown = null;
	_style = new Map<string, string>();
	style = {
		setProperty: (name: string, value: string) => this._style.set(name, value),
		getPropertyValue: (name: string) => this._style.get(name) ?? '',
		removeProperty: (name: string) => this._style.delete(name),
	};
	classList = {
		add: (...names: string[]) => {
			for (const n of names) if (n) this._classes.add(n);
		},
		remove: (...names: string[]) => {
			for (const n of names) this._classes.delete(n);
		},
		contains: (name: string) => this._classes.has(name),
	};
	constructor(doc: FakeDocument, tag: string) {
		this.ownerDocument = doc;
		this.tagName = tag.toUpperCase();
	}
	get className(): string {
		return [...this._classes].join(' ');
	}
	set className(value: string) {
		this._classes = new Set(value.split(/\s+/).filter(Boolean));
	}
	get children(): FakeElement[] {
		return this._children;
	}
	get childElementCount(): number {
		return this._children.length;
	}
	get parentElement(): FakeElement | null {
		return this.parentNode && !(this.parentNode instanceof FakeFragment) ? this.parentNode : null;
	}
	get isConnected(): boolean {
		let node: FakeElement | null = this;
		while (node) {
			if (node === this.ownerDocument.body) return true;
			node = node.parentNode;
		}
		return false;
	}
	get dataset(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [name, value] of this._attributes) {
			if (name.startsWith('data-')) out[name.slice(5)] = value;
		}
		return out;
	}
	setAttribute(name: string, value: string) {
		this._attributes.set(name, String(value));
	}
	getAttribute(name: string): string | null {
		return this._attributes.get(name) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this._attributes.has(name);
	}
	removeAttribute(name: string) {
		this._attributes.delete(name);
	}
	_detach() {
		if (this.parentNode) {
			const siblings = this.parentNode._children;
			const at = siblings.indexOf(this);
			if (at !== -1) siblings.splice(at, 1);
			this.parentNode = null;
		}
	}
	appendChild(child: FakeElement): FakeElement {
		if (child instanceof FakeFragment) {
			const moved = child._children;
			child._children = [];
			for (const node of moved) {
				node.parentNode = this;
				this._children.push(node);
			}
			return child;
		}
		child._detach();
		child.parentNode = this;
		this._children.push(child);
		return child;
	}
	replaceWith(node: FakeElement) {
		const parent = this.parentNode;
		if (!parent) return;
		node._detach();
		const at = parent._children.indexOf(this);
		parent._children[at] = node;
		node.parentNode = parent;
		this.parentNode = null;
	}
	remove() {
		this._detach();
	}
	contains(other: FakeElement | null): boolean {
		let node = other;
		while (node) {
			if (node === this) return true;
			node = node.parentNode;
		}
		return false;
	}
	closest(selector: string): FakeElement | null {
		const cls = selector.replace(/^\./, '');
		let node: FakeElement | null = this;
		while (node) {
			if (node._classes.has(cls)) return node;
			node = node.parentElement;
		}
		return null;
	}
	matches(selector: string): boolean {
		if (selector === ':hover') return this.hovered;
		return false;
	}
	getBoundingClientRect() {
		return { height: this.height, width: 0, top: 0, left: 0, bottom: this.height, right: 0 };
	}
	addEventListener(
		type: string,
		fn: (event: FakeEvent) => void,
		options?: { capture?: boolean; signal?: AbortSignal } | boolean,
	) {
		this.listener_calls++;
		const opts = typeof options === 'object' && options !== null ? options : {};
		const listener: Listener = { type, fn, capture: opts.capture === true };
		if (opts.signal?.aborted) return;
		this._listeners.push(listener);
		opts.signal?.addEventListener('abort', () => {
			this._listeners = this._listeners.filter((l) => l !== listener);
		});
	}
	get live_listeners(): number {
		return this._listeners.length;
	}
	dispatchEvent(event: FakeEvent): boolean {
		event.target = this;
		// events.js capture listener on `document`: EVERY change retires its
		// target from the uncommitted Set before the view's own handler runs
		if (event.type === 'change' || event.type === 'focusout') {
			this.ownerDocument.uncommitted.delete(this);
		}
		this.ownerDocument.dispatched.push({ type: event.type, node: this });
		let node: FakeElement | null = this;
		while (node) {
			for (const l of [...node._listeners]) if (l.type === event.type) l.fn(event);
			if (!event.bubbles) break;
			node = node.parentNode;
		}
		return true;
	}
}

class FakeFragment extends FakeElement {}

/** Fake IntersectionObserver: records construction, observation and disconnect. */
class FakeIntersectionObserver {
	static constructed: FakeIntersectionObserver[] = [];
	callback: (entries: Array<{ target: FakeElement; isIntersecting: boolean }>) => void;
	options: unknown;
	observed = new Set<FakeElement>();
	disconnected = false;
	constructor(
		callback: (entries: Array<{ target: FakeElement; isIntersecting: boolean }>) => void,
		options: unknown,
	) {
		this.callback = callback;
		this.options = options;
		FakeIntersectionObserver.constructed.push(this);
	}
	observe(node: FakeElement) {
		this.observed.add(node);
	}
	unobserve(node: FakeElement) {
		this.observed.delete(node);
	}
	disconnect() {
		this.disconnected = true;
		this.observed.clear();
	}
	/** Report the observed nodes whose index is in `reach` as intersecting, the rest not.
	 * `rect_height`: also hand each entry a `boundingClientRect` of that height (a real
	 * observer always does; omitted, the window must fall back to measuring). */
	fire(reach: Set<number>, rect_height?: number) {
		const entries = [...this.observed].map((target) => ({
			target,
			isIntersecting: reach.has(Number(target.dataset.index)),
			...(rect_height === undefined ? {} : { boundingClientRect: { height: rect_height } }),
		}));
		this.callback(entries);
	}
}

class FakeDocument {
	body: FakeElement;
	activeElement: FakeElement | null = null;
	/** events.js uncommitted_nodes, as the capture listener mutates it. */
	uncommitted = new Set<FakeElement>();
	dispatched: Array<{ type: string; node: FakeElement }> = [];
	raf_queue: Array<() => void> = [];
	defaultView: Record<string, unknown>;
	constructor() {
		this.body = new FakeElement(this, 'body');
		this.defaultView = {
			Event: FakeEvent,
			IntersectionObserver: FakeIntersectionObserver,
			requestAnimationFrame: (fn: () => void) => {
				this.raf_queue.push(fn);
				return this.raf_queue.length;
			},
			cancelAnimationFrame: () => {},
		};
	}
	createElement(tag: string): FakeElement {
		return new FakeElement(this, tag);
	}
	createDocumentFragment(): FakeFragment {
		return new FakeFragment(this, '#fragment');
	}
	/** Run one animation frame. */
	frame() {
		const queue = this.raf_queue;
		this.raf_queue = [];
		for (const fn of queue) fn();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Instances, rows and the edit-safety fakes
// ─────────────────────────────────────────────────────────────────────────────

type FakeInstance = {
	id: string;
	model: string;
	status: string;
	caller: FakeInstance | null;
	ar_instances: FakeInstance[];
	destroy_calls: number;
	commit_seq: number;
	saving?: boolean;
	changing?: boolean;
	change_value_pool?: unknown[];
	settle_result?: boolean;
	on_settle?: () => Promise<void>;
	on_deactivate?: () => Promise<void>;
	destroy: (...args: unknown[]) => Promise<void>;
};

let instance_seq = 0;
const make_instance = (model: string, caller: FakeInstance | null): FakeInstance => {
	const self: FakeInstance = {
		id: `${model}_${++instance_seq}`,
		model,
		status: 'built',
		caller,
		ar_instances: [],
		destroy_calls: 0,
		commit_seq: 0,
		destroy: async () => {
			self.destroy_calls++;
			self.status = 'destroyed';
		},
	};
	return self;
};

type EditorKind = 'committing' | 'ignoring';

/**
 * A rendered row: `.section_record` > 2 × `.column` > `.wrapper_component` >
 * `input`. The row instance owns one component per column; each input's
 * `change` listener is the editor's own commit (or, 'ignoring', a custom
 * editor that does not commit on the synthetic change).
 */
const render_row = (
	doc: FakeDocument,
	instance: FakeInstance,
	editor: EditorKind = 'committing',
) => {
	const node = doc.createElement('div');
	node.className = `section_record ${instance.id}`;
	node.height = 40;
	instance.ar_instances = [];
	const inputs: FakeElement[] = [];
	for (let c = 0; c < 2; c++) {
		const column = doc.createElement('div');
		column.className = 'column';
		const wrapper = doc.createElement('div');
		wrapper.className = 'wrapper_component edit';
		const component = make_instance('component_input_text', instance);
		instance.ar_instances.push(component);
		wrapper._instance = component;
		const input = doc.createElement('input');
		if (editor === 'committing') {
			input.addEventListener('change', () => {
				component.commit_seq++;
			});
		}
		wrapper.appendChild(input);
		column.appendChild(wrapper);
		node.appendChild(column);
		inputs.push(input);
	}
	return { node, inputs };
};

type Harness = ReturnType<typeof make_harness>;

/** One owner, one document, the edit-safety fakes and their call logs. */
const make_harness = () => {
	const doc = new FakeDocument();
	const owner = make_instance('component_portal', null);
	const unsaved = new Set<FakeInstance>();
	const log = {
		settle: [] as Array<{ instance: FakeInstance; seq: number }>,
		deactivate: [] as FakeInstance[],
		orphan: [] as FakeInstance[],
		register: [] as FakeElement[],
		/** deactivate + settle in ONE sequence: their relative order is assertable */
		calls: [] as Array<['deactivate' | 'settle', FakeInstance]>,
	};
	const page = {
		active: null as FakeInstance | null,
		autocomplete: null as FakeInstance | null,
	};
	const edit_safety = {
		deactivate: async (instance: FakeInstance) => {
			log.deactivate.push(instance);
			log.calls.push(['deactivate', instance]);
			if (instance.on_deactivate) await instance.on_deactivate();
			// ui.component.deactivate nulls page_globals.component_active
			if (page.active === instance) page.active = null;
		},
		settle: async (instance: FakeInstance) => {
			log.settle.push({ instance, seq: instance.commit_seq });
			log.calls.push(['settle', instance]);
			if (instance.on_settle) await instance.on_settle();
			const ok = instance.settle_result !== false;
			if (ok) unsaved.delete(instance);
			return ok;
		},
		orphan: (instance: FakeInstance) => {
			log.orphan.push(instance);
		},
		unsaved_instances: () => [...unsaved],
		uncommitted_nodes: () => [...doc.uncommitted],
		register_uncommitted: (node: FakeElement) => {
			log.register.push(node);
			doc.uncommitted.add(node);
		},
		commit_seq: (instance: FakeInstance) => instance.commit_seq,
		instance_of_node: (wrapper: FakeElement | null) => (wrapper?._instance as FakeInstance) ?? null,
		owned_elsewhere: (node: FakeElement) => node.closest('.sr_mosaic_hover') !== null,
		component_active: () => page.active,
		service_autocomplete: () => page.autocomplete,
	};
	return { doc, owner, unsaved, log, page, edit_safety };
};

/** A connected list_body > content_data (optionally with a header row). */
const make_container = (h: Harness, options: { header?: boolean; connected?: boolean } = {}) => {
	const list_body = h.doc.createElement('div');
	list_body.className = 'list_body layout_table';
	if (options.header) {
		const header = h.doc.createElement('div');
		header.className = 'header_wrapper_list';
		for (let c = 0; c < 2; c++) {
			const head = h.doc.createElement('div');
			head.className = 'head_column';
			header.appendChild(head);
		}
		list_body.appendChild(header);
	}
	const content_data = h.doc.createElement('div');
	content_data.className = 'content_data';
	list_body.appendChild(content_data);
	if (options.connected !== false) h.doc.body.appendChild(list_body);
	return { list_body, content_data };
};

type WindowHandle = {
	size: number;
	generation: number;
	signal: AbortSignal;
	entry_of: (i: number) => unknown;
	record_at: (i: number) => FakeInstance | null;
	is_built: (i: number) => boolean;
	reveal: (i: number) => Promise<void>;
	ensure_built: (from: number, to: number) => Promise<void>;
	rebuild: (i: number) => Promise<boolean>;
	hold: (i: number, reason?: string) => void;
	unhold: (i: number, reason?: string) => void;
	commit_uncommitted: (indexes?: number[]) => { pending: Array<{ node: FakeElement }> };
	freeze: () => void;
	thaw: () => void;
	flush: (
		indexes?: number[],
	) => Promise<{ failed: FakeInstance[]; pending: Array<{ node: FakeElement }> }>;
	retire: (next: WindowHandle | null) => Promise<{ failed: FakeInstance[]; pending: unknown[] }>;
	destroy: () => Promise<{ failed: FakeInstance[]; pending: Array<{ node: FakeElement }> }>;
	idle: () => Promise<void>;
};

type RecordWindowModule = {
	create_record_window: (options: Record<string, unknown>) => Promise<WindowHandle>;
	row_of: (
		content_data: FakeElement,
		target: unknown,
	) => { node: FakeElement; index: number } | null;
	carry_row_attributes: (a: FakeElement, b: FakeElement) => void;
	apply_table_semantics: (
		list_body: FakeElement,
		header: FakeElement | null,
		label_id?: string,
	) => void;
};

let rw: RecordWindowModule;
let ROW_WINDOW_MAX_ROWS = 0;
let ROW_WINDOW_MARGIN = 0;

type Entry = { section_tipo: string; section_id: number; paginated_key: number };
const entries = (n: number): Entry[] =>
	Array.from({ length: n }, (_, i) => ({
		section_tipo: 'test3',
		section_id: i + 1,
		paginated_key: i,
	}));

/**
 * Open a window. `build` defaults to a fresh row instance per call, rendered
 * by render_row; `cache` (entry → instance) emulates the instance cache hit
 * of instances.js (a section_record key carries no row_key).
 */
const open = async (
	h: Harness,
	content_data: FakeElement,
	options: {
		n?: number;
		rows?: Entry[];
		generation?: number;
		slot?: string;
		layout?: 'table' | 'list';
		cache?: Map<Entry, FakeInstance>;
		editor?: (i: number) => EditorKind;
		build?: (entry: Entry, i: number) => Promise<unknown>;
		decorate?: (node: FakeElement, i: number) => void;
		draggable_rows?: boolean;
	} = {},
): Promise<{ handle: WindowHandle; built_log: BuildRecord[] }> => {
	const rows = options.rows ?? entries(options.n ?? 0);
	const built_log: BuildRecord[] = [];
	const build =
		options.build ??
		(async (entry: Entry, i: number) => {
			let instance = options.cache?.get(entry);
			if (!instance) {
				instance = make_instance('section_record', h.owner);
				options.cache?.set(entry, instance);
			}
			built_log.push({ index: i, instance });
			instance.status = 'built';
			if (!h.owner.ar_instances.includes(instance)) h.owner.ar_instances.push(instance);
			const { node } = render_row(h.doc, instance, options.editor?.(i));
			return { instance, node };
		});
	const handle = await rw.create_record_window({
		owner: h.owner,
		slot: options.slot ?? 'rows',
		generation: options.generation ?? 1,
		container: content_data,
		rows,
		build,
		layout: options.layout ?? 'table',
		draggable_rows: options.draggable_rows === true,
		decorate: options.decorate,
		edit_safety: h.edit_safety,
	});
	return { handle, built_log };
};

type BuildRecord = { index: number; instance: FakeInstance };

/**
 * No row is built twice, and nothing a build made leaks: every instance the
 * build door returned is either the one record_at(i) answers for its index, or
 * destroyed EXACTLY once (released / rebuilt). A second build of a live index
 * swaps over the first instance without destroying it — red here (the row
 * invariant alone cannot see it: the replacing node is a `.section_record` too).
 */
const assert_single_build = (handle: WindowHandle, built_log: BuildRecord[]) => {
	const live = new Map<number, number>();
	for (const { index, instance } of built_log) {
		if (handle.record_at(index) === instance) {
			live.set(index, (live.get(index) ?? 0) + 1);
			expect(instance.destroy_calls, `live row ${index} is not destroyed`).toBe(0);
		} else {
			expect(instance.destroy_calls, `superseded build of row ${index} destroyed once`).toBe(1);
		}
	}
	for (const [index, count] of live) expect(count, `row ${index} built once while live`).toBe(1);
};

/** The invariant: N children, `.section_record`, data-index i at position i. */
const assert_invariant = (content_data: FakeElement, n: number) => {
	expect(content_data.children.length).toBe(n);
	for (let i = 0; i < n; i++) {
		const child = content_data.children[i] as FakeElement;
		expect(child.classList.contains('section_record')).toBe(true);
		expect(child.getAttribute('data-index')).toBe(String(i));
	}
};

const placeholders_of = (content_data: FakeElement) =>
	content_data.children.filter((c) => c.classList.contains('placeholder'));
const built_count = (content_data: FakeElement) =>
	content_data.children.filter((c) => !c.classList.contains('placeholder')).length;

/** Placeholders are childless, aria-hidden, listener-free leaves. */
const assert_placeholders_are_leaves = (content_data: FakeElement) => {
	for (const p of placeholders_of(content_data)) {
		expect(p.children.length).toBe(0);
		expect(p.getAttribute('aria-hidden')).toBe('true');
		expect(p.listener_calls).toBe(0);
		expect(p.hasAttribute('draggable')).toBe(false);
	}
};

/** Seeded PRNG (mulberry32): a red randomized run is reproducible. */
const prng = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const range_set = (from: number, to: number) => {
	const out = new Set<number>();
	for (let i = from; i <= to; i++) out.add(i);
	return out;
};

const last_observer = () =>
	FakeIntersectionObserver.constructed[
		FakeIntersectionObserver.constructed.length - 1
	] as FakeIntersectionObserver;

// console noise from the module's deliberate error/warn paths is captured, not printed
const error_spy = spyOn(console, 'error').mockImplementation(() => {});
const warn_spy = spyOn(console, 'warn').mockImplementation(() => {});

beforeAll(async () => {
	rw = (await import(join(REPO_ROOT, RECORD_WINDOW_REL))) as RecordWindowModule;
	const constants = (await import(join(REPO_ROOT, ROW_WINDOW_REL))) as {
		ROW_WINDOW_MAX_ROWS: number;
		ROW_WINDOW_MARGIN: number;
	};
	ROW_WINDOW_MAX_ROWS = constants.ROW_WINDOW_MAX_ROWS;
	ROW_WINDOW_MARGIN = constants.ROW_WINDOW_MARGIN;
});

afterAll(() => {
	error_spy.mockRestore();
	warn_spy.mockRestore();
});

/**
 * Blind pin 5 (an uncommitted node inside the row) while leaving the flush's
 * own snapshot intact, so a leg can isolate the release-time flush verdict.
 * The two readers call the bindings in a fixed order: is_pinned reads
 * component_active → unsaved_instances → uncommitted_nodes; flush_indexes
 * reads component_active → uncommitted_nodes → unsaved_instances. So a read
 * of uncommitted_nodes right after unsaved_instances is the pin check's.
 */
const blind_uncommitted_pin = (h: Harness) => {
	let last: 'active' | 'unsaved' | null = null;
	const component_active = h.edit_safety.component_active;
	const unsaved_instances = h.edit_safety.unsaved_instances;
	const uncommitted_nodes = h.edit_safety.uncommitted_nodes;
	h.edit_safety.component_active = () => {
		last = 'active';
		return component_active();
	};
	h.edit_safety.unsaved_instances = () => {
		last = 'unsaved';
		return unsaved_instances();
	};
	h.edit_safety.uncommitted_nodes = () => (last === 'unsaved' ? [] : uncommitted_nodes());
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. invariant + bound
// ─────────────────────────────────────────────────────────────────────────────

describe('1. the row invariant and the bound', () => {
	for (const n of [0, 1, 200, 201, 1000, 5000]) {
		test(`N=${n}: children === N, index order, bound, observer only above the bound`, async () => {
			const h = make_harness();
			const { content_data } = make_container(h);
			const constructed_before = FakeIntersectionObserver.constructed.length;
			const { handle } = await open(h, content_data, { n });
			h.doc.frame(); // arming

			assert_invariant(content_data, n);
			expect(handle.size).toBe(n);
			const observers = FakeIntersectionObserver.constructed.length - constructed_before;
			if (n <= ROW_WINDOW_MAX_ROWS) {
				expect(placeholders_of(content_data).length).toBe(0);
				expect(observers, 'N ≤ bound constructs NO observer').toBe(0);
				expect(built_count(content_data)).toBe(n);
			} else {
				expect(built_count(content_data)).toBe(ROW_WINDOW_MAX_ROWS);
				expect(placeholders_of(content_data).length).toBe(n - ROW_WINDOW_MAX_ROWS);
				expect(observers).toBe(1);
				// the observer watches every child
				expect(last_observer().observed.size).toBe(n);
				assert_placeholders_are_leaves(content_data);
			}
			// no listener on any row node (rows are delegated)
			for (const child of content_data.children) expect(child.listener_calls).toBe(0);
			await handle.destroy();
		});
	}

	for (const n of [201, 1000, 5000]) {
		test(`N=${n}: seeded random grow / release / pin / reveal keeps the invariant and built ≤ bound + pinned`, async () => {
			const random = prng(0x5eed + n);
			const h = make_harness();
			const { content_data } = make_container(h);
			const { handle, built_log } = await open(h, content_data, { n });
			h.doc.frame();
			const io = last_observer();
			const held = new Set<number>();

			for (let stepi = 0; stepi < 40; stepi++) {
				const roll = random();
				if (roll < 0.5) {
					// scroll: a 10-row viewport somewhere
					const at = Math.floor(random() * n);
					io.fire(range_set(at, Math.min(n - 1, at + 9)));
				} else if (roll < 0.65) {
					// pin a built row
					const built = content_data.children
						.map((c, i) => (c.classList.contains('placeholder') ? -1 : i))
						.filter((i) => i >= 0);
					const pick = built[Math.floor(random() * built.length)];
					if (pick !== undefined && held.size < 20) {
						handle.hold(pick, 'test');
						held.add(pick);
					}
				} else if (roll < 0.75) {
					const pick = [...held][Math.floor(random() * held.size)];
					if (pick !== undefined) {
						handle.unhold(pick, 'test');
						held.delete(pick);
					}
				} else if (roll < 0.9) {
					const at = Math.floor(random() * n);
					await handle.reveal(at);
					expect(handle.is_built(at)).toBe(true);
				} else {
					const at = Math.floor(random() * n);
					await handle.ensure_built(at - 5, at + 5);
				}
				await handle.idle();

				assert_invariant(content_data, n);
				const pinned_built = [...held].filter((i) => handle.is_built(i)).length;
				expect(built_count(content_data)).toBeLessThanOrEqual(ROW_WINDOW_MAX_ROWS + pinned_built);
				// a held row is never released
				for (const i of held) expect(handle.is_built(i)).toBe(true);
				assert_placeholders_are_leaves(content_data);
				// the instances behind the built rows are exactly what record_at answers
				for (let i = 0; i < n; i++) {
					const child = content_data.children[i] as FakeElement;
					expect(handle.record_at(i) !== null).toBe(!child.classList.contains('placeholder'));
				}
				assert_single_build(handle, built_log);
			}
			await handle.destroy();
		});
	}

	test('a released row instance is destroyed (remove_dom false) and leaves its placeholder sized', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const first = handle.record_at(0) as FakeInstance;
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(handle.is_built(0)).toBe(false);
		expect(first.destroy_calls).toBe(1);
		const placeholder = content_data.children[0] as FakeElement;
		expect(placeholder.style.getPropertyValue('--row_size')).toBe('40px');
		// hysteresis: 200 built + 580..629 in reach = 250, released farthest-first
		// down to EXACTLY bound − margin (a release that stops at the bound, or a
		// margin of its own, is red here)
		expect(built_count(content_data)).toBe(ROW_WINDOW_MAX_ROWS - ROW_WINDOW_MARGIN);
		expect(handle.is_built(580), 'the rows in reach stay built').toBe(true);
		expect(handle.is_built(629)).toBe(true);
		await handle.destroy();
	});

	test('release sizes the placeholder from the observer rect, never by forcing a layout', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const rect_spy = spyOn(FakeElement.prototype, 'getBoundingClientRect');
		try {
			// the real observer hands every entry its rect (55px here, the node says 40)
			last_observer().fire(range_set(600, 609), 55);
			await handle.idle();
			expect(handle.is_built(0)).toBe(false);
			const placeholder = content_data.children[0] as FakeElement;
			expect(placeholder.style.getPropertyValue('--row_size')).toBe('55px');
			expect(
				rect_spy,
				'a release measured a row the observer had already sized',
			).not.toHaveBeenCalled();
		} finally {
			rect_spy.mockRestore();
		}
		await handle.destroy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. pins
// ─────────────────────────────────────────────────────────────────────────────

describe('2. every pin kind blocks release', () => {
	/**
	 * N=1000: rows 0..199 built; a scroll to 600 builds 580..620, which pushes
	 * the window over the bound, and the release walks farthest-first from row
	 * 0. Unpinned, row 0 is released (the control); pinned, it survives.
	 */
	const scenario = async (pin: (h: Harness, handle: WindowHandle, row0: FakeElement) => void) => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		pin(h, handle, content_data.children[0] as FakeElement);
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		assert_invariant(content_data, 1000);
		const survived = handle.is_built(0);
		await handle.destroy();
		return survived;
	};

	test('control: an unpinned row 0 is released', async () => {
		expect(await scenario(() => {})).toBe(false);
	});

	const component_of_row0 = (handle: WindowHandle) =>
		(handle.record_at(0) as FakeInstance).ar_instances[0] as FakeInstance;

	const pins: Array<[string, (h: Harness, handle: WindowHandle, row0: FakeElement) => void]> = [
		[
			'1 focus inside the row',
			(h, _handle, row0) => {
				h.doc.activeElement = row0.children[0]?.children[0]?.children[0] as FakeElement;
			},
		],
		['2 explicit hold', (_h, handle) => handle.hold(0, 'drag')],
		[
			'3 component_active through the modal caller chain (node outside the row)',
			(h, handle) => {
				const modal = make_instance('component_portal', component_of_row0(handle));
				h.page.active = make_instance('component_input_text', modal);
			},
		],
		['4 unsaved registry', (h, handle) => h.unsaved.add(component_of_row0(handle))],
		[
			'5 uncommitted editor node',
			(h, _handle, row0) => {
				h.doc.uncommitted.add(row0.children[0]?.children[0]?.children[0] as FakeElement);
			},
		],
		[
			'6 live service_autocomplete',
			(h, handle) => {
				h.page.autocomplete = make_instance('service_autocomplete', component_of_row0(handle));
			},
		],
		['7a saving', (_h, handle) => (component_of_row0(handle).saving = true)],
		['7b changing', (_h, handle) => (component_of_row0(handle).changing = true)],
		['7c change_value_pool', (_h, handle) => (component_of_row0(handle).change_value_pool = [{}])],
		['8a :hover', (_h, _handle, row0) => (row0.hovered = true)],
		['8b .dragging', (_h, _handle, row0) => row0.classList.add('dragging')],
	];
	for (const [name, pin] of pins) {
		test(`pin ${name}`, async () => {
			expect(await scenario(pin)).toBe(true);
		});
	}

	test('a destroyed service_autocomplete pins nothing', async () => {
		expect(
			await scenario((h, handle) => {
				const service = make_instance('service_autocomplete', component_of_row0(handle));
				service.status = 'destroyed';
				h.page.autocomplete = service;
			}),
		).toBe(false);
	});
});

describe('2b. a pin that appears DURING the release / rebuild flush', () => {
	/**
	 * N=1000, row 0 carries a recorded failed settle of X (no live pin), so the
	 * release walk reaches row 0 and its flush re-settles X — an await, during
	 * which `appear` adds a pin (the user came back to the row). The verdict
	 * taken before the flush is stale: the row must stay built, nothing in it
	 * destroyed. Red on a release_one that does not re-check after its flush.
	 */
	const release_scenario = async (
		appear: (h: Harness, handle: WindowHandle, row0: FakeElement, y: FakeInstance) => void,
	) => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const row = handle.record_at(0) as FakeInstance;
		const [x, y] = row.ar_instances as [FakeInstance, FakeInstance];
		x.settle_result = false;
		h.unsaved.add(x);
		expect((await handle.flush([0])).failed).toEqual([x]);
		x.settle_result = true;
		h.unsaved.delete(x);
		let appeared = false;
		x.on_settle = async () => {
			appeared = true;
			appear(h, handle, content_data.children[0] as FakeElement, y);
		};
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(appeared, 'the release reached row 0 and its flush').toBe(true);
		assert_invariant(content_data, 1000);
		const outcome = {
			built: handle.is_built(0),
			row_destroyed: row.destroy_calls,
			y_destroyed: y.destroy_calls,
		};
		h.page.active = null;
		h.doc.activeElement = null;
		h.doc.uncommitted.clear();
		h.unsaved.clear();
		await handle.destroy();
		return outcome;
	};

	test('control: no pin appears → row 0 is released', async () => {
		expect(await release_scenario(() => {})).toEqual({
			built: false,
			row_destroyed: 1,
			y_destroyed: 0,
		});
	});

	const appearing: Array<
		[string, (h: Harness, handle: WindowHandle, row0: FakeElement, y: FakeInstance) => void]
	> = [
		['a hold (drag source)', (_h, handle) => handle.hold(0, 'drag')],
		[
			'focus',
			(h, _handle, row0) =>
				(h.doc.activeElement = row0.children[1]?.children[0]?.children[0] as FakeElement),
		],
		['a new active component', (h, _handle, _row0, y) => (h.page.active = y)],
		['a new unsaved instance', (h, _handle, _row0, y) => h.unsaved.add(y)],
		[
			'a new uncommitted node',
			(h, _handle, row0) =>
				h.doc.uncommitted.add(row0.children[1]?.children[0]?.children[0] as FakeElement),
		],
		['back in reach', () => last_observer().fire(range_set(0, 9))],
	];
	for (const [name, appear] of appearing) {
		test(`release: ${name} during the flush keeps the row built, nothing destroyed`, async () => {
			expect(await release_scenario(appear)).toEqual({
				built: true,
				row_destroyed: 0,
				y_destroyed: 0,
			});
		});
	}

	/** rebuild(0) on N=3: X unsaved in row 0, its settle is the await. */
	const rebuild_scenario = async (
		appear: (h: Harness, row0: FakeElement, y: FakeInstance) => void,
	) => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const row = handle.record_at(0) as FakeInstance;
		const [x, y] = row.ar_instances as [FakeInstance, FakeInstance];
		h.unsaved.add(x);
		x.on_settle = async () => appear(h, content_data.children[0] as FakeElement, y);
		const rebuilt = await handle.rebuild(0);
		const outcome = {
			rebuilt,
			same_row: handle.record_at(0) === row,
			row_destroyed: row.destroy_calls,
			y_destroyed: y.destroy_calls,
		};
		h.page.active = null;
		h.doc.uncommitted.clear();
		h.unsaved.clear();
		await handle.destroy();
		return outcome;
	};

	test('rebuild control: no edit appears → rebuilt', async () => {
		expect(await rebuild_scenario(() => {})).toEqual({
			rebuilt: true,
			same_row: false,
			row_destroyed: 1,
			y_destroyed: 0,
		});
	});

	test('rebuild control: an in-row active component at the start is deactivated by the flush, then rebuilt', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const row = handle.record_at(0) as FakeInstance;
		h.page.active = row.ar_instances[0] as FakeInstance;
		expect(await handle.rebuild(0)).toBe(true);
		expect(row.destroy_calls).toBe(1);
		await handle.destroy();
	});

	const appearing_edits: Array<[string, (h: Harness, row0: FakeElement, y: FakeInstance) => void]> =
		[
			['a new active component', (h, _row0, y) => (h.page.active = y)],
			['a new unsaved instance', (h, _row0, y) => h.unsaved.add(y)],
			[
				'a new uncommitted node',
				(h, row0) =>
					h.doc.uncommitted.add(row0.children[1]?.children[0]?.children[0] as FakeElement),
			],
			['a save starting', (_h, _row0, y) => (y.saving = true)],
		];
	for (const [name, appear] of appearing_edits) {
		test(`rebuild: ${name} during the flush refuses, nothing destroyed`, async () => {
			expect(await rebuild_scenario(appear)).toEqual({
				rebuilt: false,
				same_row: true,
				row_destroyed: 0,
				y_destroyed: 0,
			});
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 3-4. uncommitted nodes: outcome-judged commit, owned_elsewhere skip
// ─────────────────────────────────────────────────────────────────────────────

describe('3. flush commits uncommitted nodes, judged by outcome', () => {
	test('a committing editor: dispatched change + blur, commit_seq advances BEFORE settle, not pending', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const input = content_data.children[1]?.children[0]?.children[0]?.children[0] as FakeElement;
		const component = (handle.record_at(1) as FakeInstance).ar_instances[0] as FakeInstance;
		h.doc.uncommitted.add(input);

		const result = await handle.flush();
		expect(result.pending).toEqual([]);
		expect(result.failed).toEqual([]);
		expect(h.doc.dispatched.filter((d) => d.node === input).map((d) => d.type)).toEqual([
			'change',
			'blur',
		]);
		const settled = h.log.settle.find((s) => s.instance === component);
		expect(settled, 'the committed instance is settled').toBeDefined();
		expect(settled?.seq, 'the value reached the instance before settle').toBe(1);
		expect(h.doc.uncommitted.has(input)).toBe(false);
		expect(h.log.register).toEqual([]);
		await handle.destroy();
	});

	test('an editor that ignores the synthetic change IS pending (red-on-Set-membership control)', async () => {
		// The capture listener removed the node from the Set on `change`, so a
		// membership-judged implementation would read "committed" here.
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, {
			n: 3,
			editor: (i) => (i === 2 ? 'ignoring' : 'committing'),
		});
		const input = content_data.children[2]?.children[0]?.children[0]?.children[0] as FakeElement;
		h.doc.uncommitted.add(input);

		const committed = handle.commit_uncommitted();
		expect(committed.pending.map((p) => p.node)).toEqual([input]);
		expect(h.log.register, 're-registered after the capture listener removed it').toEqual([input]);
		expect(h.doc.uncommitted.has(input)).toBe(true);

		const flushed = await handle.flush();
		expect(flushed.pending.map((p) => p.node)).toEqual([input]);
		expect(h.doc.uncommitted.has(input)).toBe(true);

		const destroyed = await handle.destroy();
		expect(destroyed.pending.map((p) => p.node)).toEqual([input]);
		expect(h.doc.uncommitted.has(input)).toBe(true);
	});

	test('a node with no resolvable in-row instance is pending', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const wrapper = content_data.children[0]?.children[0]?.children[0] as FakeElement;
		wrapper._instance = null; // unresolvable
		const input = wrapper.children[0] as FakeElement;
		h.doc.uncommitted.add(input);
		const result = await handle.flush();
		expect(result.pending.map((p) => p.node)).toEqual([input]);
		expect(h.doc.uncommitted.has(input)).toBe(true);
		await handle.destroy();
	});

	test('a resolvable instance that is NOT in the row is pending (judged against the row, not the Set)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const wrapper = content_data.children[0]?.children[0]?.children[0] as FakeElement;
		wrapper._instance = make_instance('component_input_text', h.owner); // caller: the portal
		const input = wrapper.children[0] as FakeElement;
		h.doc.uncommitted.add(input);
		const result = await handle.flush();
		expect(result.pending.map((p) => p.node)).toEqual([input]);
		await handle.destroy();
	});

	test('a pending node keeps its row from release: the release-time flush verdict alone (pin 5 blinded)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, {
			n: 1000,
			editor: (i) => (i === 0 ? 'ignoring' : 'committing'),
		});
		h.doc.frame();
		const input = content_data.children[0]?.children[0]?.children[0]?.children[0] as FakeElement;
		h.doc.uncommitted.add(input);
		blind_uncommitted_pin(h);
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(
			h.doc.dispatched.some((d) => d.node === input && d.type === 'change'),
			'the release reached the flush of row 0',
		).toBe(true);
		expect(handle.is_built(0), 'the pending verdict kept row 0 built').toBe(true);
		assert_invariant(content_data, 1000);
		await handle.destroy();
	});

	test('a pending row becomes releasable once its node is committed (the verdict is re-judged, not sticky)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, {
			n: 1000,
			editor: (i) => (i === 0 ? 'ignoring' : 'committing'),
		});
		h.doc.frame();
		const input = content_data.children[0]?.children[0]?.children[0]?.children[0] as FakeElement;
		h.doc.uncommitted.add(input);
		expect((await handle.flush([0])).pending.map((p) => p.node)).toEqual([input]);
		// the editor's own path commits the value later: the guard drops the node
		h.doc.uncommitted.delete(input);
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(handle.is_built(0), 'released: no live pin, and the re-flush is clean').toBe(false);
		assert_invariant(content_data, 1000);
		await handle.destroy();
	});

	test('the active in-row component is deactivated, then settled (settle sees the deactivate commit)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const component = (handle.record_at(1) as FakeInstance).ar_instances[1] as FakeInstance;
		h.page.active = component;
		// as ui.component.deactivate does: the editor's last change becomes a
		// save (commit + registered unsaved) only when it is deactivated
		component.on_deactivate = async () => {
			component.commit_seq++;
			h.unsaved.add(component);
		};
		const result = await handle.flush();
		const order = h.log.calls
			.filter(([, instance]) => instance === component)
			.map(([kind]) => kind);
		expect(order, 'deactivate BEFORE settle (red on a swapped order)').toEqual([
			'deactivate',
			'settle',
		]);
		const settled = h.log.settle.filter((s) => s.instance === component);
		expect(
			settled.map((s) => s.seq),
			'settle saw the post-deactivate commit',
		).toEqual([1]);
		expect(result.failed).toEqual([]);
		expect(h.unsaved.has(component), 'the deactivate-time change was settled').toBe(false);
		await handle.destroy();
	});
});

describe('4. owned_elsewhere nodes (hover overlay) are skipped', () => {
	test('not dispatched, not pending, not re-registered (red-on-in_row control)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		// a hover overlay inside row 1 whose editor instance's caller is the PORTAL:
		// judged against in_row it would be "pending"
		const row1 = content_data.children[1] as FakeElement;
		const overlay = h.doc.createElement('div');
		overlay.className = 'sr_mosaic_hover';
		const wrapper = h.doc.createElement('div');
		wrapper.className = 'wrapper_component edit';
		wrapper._instance = make_instance('component_input_text', h.owner);
		const input = h.doc.createElement('input');
		wrapper.appendChild(input);
		overlay.appendChild(wrapper);
		row1.appendChild(overlay);
		h.doc.uncommitted.add(input);

		expect(handle.commit_uncommitted().pending).toEqual([]);
		expect((await handle.flush()).pending).toEqual([]);
		expect((await handle.destroy()).pending).toEqual([]);
		expect(h.doc.dispatched.filter((d) => d.node === input)).toEqual([]);
		expect(h.log.register).toEqual([]);
		// untouched: still the hover controller's to commit
		expect(h.doc.uncommitted.has(input)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5-6. freeze/thaw, failed settle
// ─────────────────────────────────────────────────────────────────────────────

describe('5. freeze / thaw', () => {
	test('inert set and removed; thaw on a detached container is a no-op', async () => {
		const h = make_harness();
		const { list_body, content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		handle.freeze();
		expect(content_data.inert).toBe(true);
		handle.thaw();
		expect(content_data.inert).toBe(false);
		handle.freeze();
		list_body.remove(); // swapped out
		handle.thaw();
		expect(content_data.inert).toBe(true);
		await handle.destroy();
	});
});

describe('6. a failed settle orphans, never destroys', () => {
	test('destroy: orphan exactly once (twice-called destroy included), instance never destroyed', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const failing = (handle.record_at(1) as FakeInstance).ar_instances[0] as FakeInstance;
		failing.settle_result = false;
		h.unsaved.add(failing);
		const result = await handle.destroy();
		await handle.destroy();
		expect(result.failed).toEqual([failing]);
		expect(h.log.orphan).toEqual([failing]);
		expect(failing.destroy_calls).toBe(0);
	});

	test('retire: orphan exactly once, never destroyed; the row instance is destroyed', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const row = handle.record_at(1) as FakeInstance;
		const failing = row.ar_instances[0] as FakeInstance;
		failing.settle_result = false;
		h.unsaved.add(failing);
		const next = make_container(h);
		const { handle: successor } = await open(h, next.content_data, { n: 0, generation: 2 });
		await handle.retire(successor);
		expect(h.log.orphan).toEqual([failing]);
		expect(failing.destroy_calls).toBe(0);
		expect(row.destroy_calls).toBe(1);
		await successor.destroy();
	});

	test('release: a failed flush pins the row instead of releasing it', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const failing = (handle.record_at(0) as FakeInstance).ar_instances[0] as FakeInstance;
		failing.settle_result = false;
		// settled once by an explicit flush, then no longer in the registry: only
		// the flush verdict can pin it
		h.unsaved.add(failing);
		const first = await handle.flush([0]);
		expect(first.failed).toEqual([failing]);
		h.unsaved.delete(failing);
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(handle.is_built(0)).toBe(true);
		expect(failing.destroy_calls).toBe(0);
		// what kept it: the release re-settled the recorded failure, which failed again
		expect(h.log.settle.filter((s) => s.instance === failing).length).toBeGreaterThanOrEqual(2);
		await handle.destroy();
	});

	test('release: a failed row becomes releasable once a later settle of it succeeds (not sticky)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const failing = (handle.record_at(0) as FakeInstance).ar_instances[0] as FakeInstance;
		failing.settle_result = false;
		h.unsaved.add(failing);
		expect((await handle.flush([0])).failed).toEqual([failing]);
		// the value is saved later (the instance leaves the registry, settle succeeds)
		failing.settle_result = true;
		h.unsaved.delete(failing);
		const settles_before = h.log.settle.filter((s) => s.instance === failing).length;
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(handle.is_built(0), 'released after a clean re-flush').toBe(false);
		expect(
			h.log.settle.filter((s) => s.instance === failing).length,
			'the release re-settled the recorded failure',
		).toBe(settles_before + 1);
		expect(h.log.orphan).toEqual([]);
		await handle.destroy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-9. retire, generation, N=3→0
// ─────────────────────────────────────────────────────────────────────────────

describe('7. retire adoption', () => {
	test('an instance the new window adopted by identity survives (red-on-old: fill-time destroy-after-fill)', async () => {
		const h = make_harness();
		const cache = new Map<Entry, FakeInstance>();
		const rows = entries(3);
		const old = make_container(h);
		const { handle: w1 } = await open(h, old.content_data, { rows, cache });
		const [a, b, c] = [0, 1, 2].map((i) => w1.record_at(i) as FakeInstance);
		// the new page holds entry 0 (cache hit → the SAME section_record) and a new one
		const next = make_container(h);
		const { handle: w2 } = await open(h, next.content_data, {
			rows: [rows[0] as Entry, { section_tipo: 'test3', section_id: 99, paginated_key: 3 }],
			cache,
			generation: 2,
		});
		expect(w2.record_at(0)).toBe(a as FakeInstance);

		await w1.retire(w2);
		expect(a?.destroy_calls, 'the adopted row is live in the new window').toBe(0);
		expect(b?.destroy_calls).toBe(1);
		expect(c?.destroy_calls).toBe(1);
		expect(old.content_data.inert).toBe(true);
		expect(w1.signal.aborted).toBe(true);
		await w2.destroy();
	});

	test('an instance the new window builds from the cache DURING the retire flush is not destroyed', async () => {
		const h = make_harness();
		const cache = new Map<Entry, FakeInstance>();
		const rows = entries(3);
		const old = make_container(h);
		const { handle: w1 } = await open(h, old.content_data, { rows, cache });
		const b = w1.record_at(1) as FakeInstance;
		const c = w1.record_at(2) as FakeInstance;

		// the new window: 201 rows, entry 200 is the old row 1 (cache hit), still a placeholder
		const next_rows = entries(201).map((e, i) => (i === 200 ? (rows[1] as Entry) : e));
		const next = make_container(h);
		const { handle: w2 } = await open(h, next.content_data, {
			rows: next_rows,
			cache,
			generation: 2,
		});
		expect(w2.is_built(200)).toBe(false);

		// row 1 holds an unsaved component; its settle (retire step 5) lets the
		// new window build index 200 — which takes the old instance from the cache
		const dirty = b.ar_instances[0] as FakeInstance;
		h.unsaved.add(dirty);
		dirty.on_settle = async () => {
			await w2.reveal(200);
		};

		await w1.retire(w2);
		expect(w2.record_at(200)).toBe(b);
		expect(b.destroy_calls, 'destroy set computed after the flush, not at fill time').toBe(0);
		expect(c.destroy_calls).toBe(1);
		await w2.destroy();
	});

	test('retire unholds and stops: no observer, no further builds', async () => {
		const h = make_harness();
		const old = make_container(h);
		const { handle: w1 } = await open(h, old.content_data, { n: 1000 });
		h.doc.frame();
		const io = last_observer();
		w1.hold(3, 'drag');
		const next = make_container(h);
		const { handle: w2 } = await open(h, next.content_data, { n: 0, generation: 2 });
		await w1.retire(w2);
		expect(io.disconnected).toBe(true);
		await w1.reveal(500);
		expect(w1.is_built(500)).toBe(false);
		await w2.destroy();
	});
});

describe('8. generation', () => {
	test('uses the given generation, bumps only its own; another slot is untouched', async () => {
		const h = make_harness();
		const rows_c = make_container(h);
		const alt_c = make_container(h);
		const { handle: rows_w } = await open(h, rows_c.content_data, {
			n: 3,
			generation: 7,
			slot: 'rows',
		});
		const { handle: alt_w } = await open(h, alt_c.content_data, {
			n: 1,
			generation: 1,
			slot: 'alt',
		});
		expect(rows_w.generation).toBe(7);
		expect(alt_w.generation).toBe(1);

		await alt_w.destroy();
		expect(alt_w.generation).toBe(2);
		expect(rows_w.generation, 'the alt slot never bumps rows').toBe(7);
		expect(rows_w.signal.aborted).toBe(false);
		assert_invariant(rows_c.content_data, 3);

		const next = make_container(h);
		const { handle: successor } = await open(h, next.content_data, { n: 0, generation: 8 });
		await rows_w.retire(successor);
		expect(rows_w.generation).toBe(8);
		expect(successor.generation).toBe(8);
		await successor.destroy();
	});

	test('the door must supply the generation (no count of its own)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		await expect(
			rw.create_record_window({
				owner: h.owner,
				container: content_data,
				rows: [],
				build: async () => null,
				edit_safety: h.edit_safety,
			}),
		).rejects.toThrow(/generation/);
	});

	test('every edit_safety binding is required (none silently skipped)', async () => {
		// the census is the harness's own binding set (the module documents
		// eleven); each one absent alone must be refused BY NAME, so dropping any
		// key from the module's required list turns this red
		const keys = Object.keys(make_harness().edit_safety);
		expect(keys.length, 'census floor: the eleven documented bindings').toBe(11);
		for (const key of keys) {
			const h = make_harness();
			const { content_data } = make_container(h);
			const partial = { ...h.edit_safety } as Record<string, unknown>;
			delete partial[key];
			let message = '';
			try {
				await rw.create_record_window({
					owner: h.owner,
					generation: 1,
					container: content_data,
					rows: [],
					build: async () => null,
					edit_safety: partial,
				});
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message, `absent ${key} is refused by name`).toMatch(
				new RegExp(`bindings missing: (.*, )?${key}(,|$)`),
			);
		}
		// control: the complete set opens
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 0 });
		await handle.destroy();
	});
});

describe('9. N=3 → 0', () => {
	test('the zero-row window retires the old one: zero observers, zero children', async () => {
		const h = make_harness();
		const old = make_container(h);
		const { handle: w3 } = await open(h, old.content_data, { n: 3 });
		const olds = [0, 1, 2].map((i) => w3.record_at(i) as FakeInstance);
		const constructed_before = FakeIntersectionObserver.constructed.length;
		const next = make_container(h);
		const { handle: w0 } = await open(h, next.content_data, { n: 0, generation: 2 });
		h.doc.frame();
		await w3.retire(w0);
		expect(w0.size).toBe(0);
		expect(next.content_data.children.length).toBe(0);
		expect(FakeIntersectionObserver.constructed.length).toBe(constructed_before);
		for (const instance of olds) expect(instance.destroy_calls).toBe(1);
		await w0.destroy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. import set + bound
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FREE-IDENTIFIER CENSUS — every identifier the module READS that no scope of
 * its own binds (an ambient global), with its reference count, plus every
 * property read off the module's `doc` / `view` bindings (the two doors to
 * the DOM). A scope-resolved walk over the @babel/parser AST: function /
 * arrow / method params and hoisted `var`, block `let` / `const` / `class` /
 * function declarations, for-head and catch bindings, imports. So a free
 * `page_globals` / `document` / `window` read is seen on ANY path — an error
 * branch the fake-DOM legs never execute included — and a same-named local in
 * another function does not hide it.
 */
type AstNode = { type: string; [key: string]: unknown };
const is_node = (value: unknown): value is AstNode =>
	typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
const SKIP_KEYS = new Set([
	'loc',
	'start',
	'end',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
	'comments',
	'range',
]);
const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
]);

const free_identifier_census = (source: string) => {
	const ast = parse(source, { sourceType: 'module' });
	const free = new Map<string, number>();
	const members = { doc: new Set<string>(), view: new Set<string>() };

	const pattern_names = (pattern: unknown, out: Set<string>) => {
		if (!is_node(pattern)) return;
		switch (pattern.type) {
			case 'Identifier':
				out.add(pattern.name as string);
				return;
			case 'ObjectPattern':
				for (const p of pattern.properties as AstNode[]) {
					pattern_names(p.type === 'RestElement' ? p.argument : p.value, out);
				}
				return;
			case 'ArrayPattern':
				for (const e of pattern.elements as unknown[]) pattern_names(e, out);
				return;
			case 'AssignmentPattern':
				pattern_names(pattern.left, out);
				return;
			case 'RestElement':
				pattern_names(pattern.argument, out);
				return;
		}
	};
	/** Block-level declarations of a statement list (let/const/class/function/import). */
	const block_declarations = (statements: unknown[], out: Set<string>) => {
		for (const raw of statements) {
			if (!is_node(raw)) continue;
			const statement =
				(raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration') &&
				is_node(raw.declaration)
					? raw.declaration
					: raw;
			if (statement.type === 'VariableDeclaration') {
				for (const d of statement.declarations as AstNode[]) pattern_names(d.id, out);
			} else if (
				(statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
				is_node(statement.id)
			) {
				out.add(statement.id.name as string);
			} else if (statement.type === 'ImportDeclaration') {
				for (const s of statement.specifiers as AstNode[])
					out.add((s.local as AstNode).name as string);
			}
		}
	};
	/** `var` declarations hoisted to the enclosing function (nested functions excluded). */
	const hoisted_vars = (node: unknown, out: Set<string>) => {
		if (Array.isArray(node)) {
			for (const n of node) hoisted_vars(n, out);
			return;
		}
		if (!is_node(node) || FUNCTION_TYPES.has(node.type)) return;
		if (node.type === 'VariableDeclaration' && node.kind === 'var') {
			for (const d of node.declarations as AstNode[]) pattern_names(d.id, out);
		}
		for (const [key, value] of Object.entries(node)) {
			if (!SKIP_KEYS.has(key)) hoisted_vars(value, out);
		}
	};

	const bound = (name: string, scopes: Set<string>[]) => scopes.some((scope) => scope.has(name));
	const reference = (name: string, scopes: Set<string>[]) => {
		if (!bound(name, scopes)) free.set(name, (free.get(name) ?? 0) + 1);
	};
	/** A binding pattern: binding names are not references; defaults and computed keys are. */
	const visit_pattern = (pattern: unknown, scopes: Set<string>[]) => {
		if (!is_node(pattern)) return;
		if (pattern.type === 'AssignmentPattern') {
			visit_pattern(pattern.left, scopes);
			visit(pattern.right, scopes);
		} else if (pattern.type === 'ObjectPattern') {
			for (const p of pattern.properties as AstNode[]) {
				if (p.type === 'RestElement') visit_pattern(p.argument, scopes);
				else {
					if (p.computed) visit(p.key, scopes);
					visit_pattern(p.value, scopes);
				}
			}
		} else if (pattern.type === 'ArrayPattern') {
			for (const e of pattern.elements as unknown[]) visit_pattern(e, scopes);
		} else if (pattern.type === 'RestElement') {
			visit_pattern(pattern.argument, scopes);
		} else if (pattern.type !== 'Identifier') {
			visit(pattern, scopes); // a member-expression target (assignment)
		}
	};
	const visit_children = (node: AstNode, scopes: Set<string>[]) => {
		for (const [key, value] of Object.entries(node)) {
			if (SKIP_KEYS.has(key)) continue;
			if (Array.isArray(value)) for (const v of value) visit(v, scopes);
			else visit(value, scopes);
		}
	};
	const visit_function = (node: AstNode, scopes: Set<string>[]) => {
		const scope = new Set<string>(['arguments']);
		if (node.type === 'FunctionExpression' && is_node(node.id)) scope.add(node.id.name as string);
		for (const p of node.params as unknown[]) pattern_names(p, scope);
		hoisted_vars(node.body, scope);
		const body = node.body as AstNode;
		if (body.type === 'BlockStatement') block_declarations(body.body as unknown[], scope);
		const inner = [...scopes, scope];
		for (const p of node.params as unknown[]) visit_pattern(p, inner);
		if (body.type === 'BlockStatement') for (const s of body.body as unknown[]) visit(s, inner);
		else visit(body, inner);
	};
	const visit = (node: unknown, scopes: Set<string>[]): void => {
		if (!is_node(node)) return;
		switch (node.type) {
			case 'Identifier':
				reference(node.name as string, scopes);
				return;
			case 'ImportDeclaration':
			case 'BreakStatement':
			case 'ContinueStatement':
			case 'MetaProperty':
				return;
			case 'LabeledStatement':
				visit(node.body, scopes);
				return;
			case 'MemberExpression':
			case 'OptionalMemberExpression': {
				const object = node.object as AstNode;
				const property = node.property as AstNode;
				if (object.type === 'Identifier' && !node.computed && property.type === 'Identifier') {
					const name = object.name as string;
					if (name === 'doc' || name === 'view') members[name].add(property.name as string);
				}
				visit(object, scopes);
				if (node.computed) visit(property, scopes);
				return;
			}
			case 'ObjectProperty':
			case 'ClassProperty':
				if (node.computed) visit(node.key, scopes);
				visit(node.value, scopes);
				return;
			case 'VariableDeclarator':
				visit_pattern(node.id, scopes);
				visit(node.init, scopes);
				return;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				visit_function(node, scopes);
				return;
			case 'ObjectMethod':
			case 'ClassMethod':
			case 'ClassPrivateMethod':
				if (node.computed) visit(node.key, scopes);
				visit_function(node, scopes);
				return;
			case 'ClassDeclaration':
			case 'ClassExpression': {
				const scope = new Set<string>();
				if (is_node(node.id)) scope.add(node.id.name as string);
				visit(node.superClass, scopes);
				visit(node.body, [...scopes, scope]);
				return;
			}
			case 'Program':
			case 'BlockStatement':
			case 'StaticBlock': {
				const scope = new Set<string>();
				block_declarations(node.body as unknown[], scope);
				if (node.type === 'Program') hoisted_vars(node.body, scope);
				for (const s of node.body as unknown[]) visit(s, [...scopes, scope]);
				return;
			}
			case 'SwitchStatement': {
				visit(node.discriminant, scopes);
				const scope = new Set<string>();
				for (const c of node.cases as AstNode[])
					block_declarations(c.consequent as unknown[], scope);
				for (const c of node.cases as AstNode[]) visit_children(c, [...scopes, scope]);
				return;
			}
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement': {
				const head = (node.type === 'ForStatement' ? node.init : node.left) as AstNode | null;
				const scope = new Set<string>();
				if (head && head.type === 'VariableDeclaration') {
					for (const d of head.declarations as AstNode[]) pattern_names(d.id, scope);
				}
				visit_children(node, [...scopes, scope]);
				return;
			}
			case 'CatchClause': {
				const scope = new Set<string>();
				pattern_names(node.param, scope);
				visit_pattern(node.param, [...scopes, scope]);
				visit(node.body, [...scopes, scope]);
				return;
			}
			case 'ExportNamedDeclaration':
			case 'ExportDefaultDeclaration':
				visit(node.declaration, scopes);
				return;
			default:
				visit_children(node, scopes);
		}
	};
	visit(ast.program, []);
	return { free, doc_members: members.doc, view_members: members.view };
};

/**
 * The ambient names the module may read: language builtins and `console`.
 * `globalThis` is allowed ONCE — the `view` fallback when the container's
 * document has no defaultView. No DOM / page global is on this list.
 */
const AMBIENT_ALLOWED = new Set([
	'undefined',
	'NaN',
	'Infinity',
	'console',
	'Promise',
	'Map',
	'Set',
	'WeakMap',
	'WeakSet',
	'Array',
	'Object',
	'Number',
	'String',
	'Boolean',
	'Math',
	'JSON',
	'Error',
	'TypeError',
	'RangeError',
	'Symbol',
	'AbortController',
	'Date',
]);
const DOC_MEMBERS_ALLOWED = [
	'activeElement',
	'createDocumentFragment',
	'createElement',
	'defaultView',
];
const VIEW_MEMBERS_ALLOWED = [
	'Event',
	'IntersectionObserver',
	'cancelAnimationFrame',
	'requestAnimationFrame',
];

/** Violations of the purity rule in a module source (empty = pure). */
const purity_violations = (source: string) => {
	const { free, doc_members, view_members } = free_identifier_census(source);
	const out: string[] = [];
	for (const [name, count] of free) {
		if (name === 'globalThis') {
			if (count !== 1) out.push(`globalThis ×${count} (only the one defaultView fallback)`);
		} else if (!AMBIENT_ALLOWED.has(name)) {
			out.push(`free ${name}`);
		}
	}
	for (const m of doc_members) if (!DOC_MEMBERS_ALLOWED.includes(m)) out.push(`doc.${m}`);
	for (const m of view_members) if (!VIEW_MEMBERS_ALLOWED.includes(m)) out.push(`view.${m}`);
	return out.sort();
};

describe('10. import set and the bound', () => {
	const source = readFileSync(join(REPO_ROOT, RECORD_WINDOW_REL), 'utf8');
	const ast = parse(source, { sourceType: 'module' });

	test('pure by construction: no free page / DOM global, DOM read only through doc / view', () => {
		expect(purity_violations(source)).toEqual([]);
		const { free, doc_members, view_members } = free_identifier_census(source);
		// the census is not vacuous: it sees the module's real ambient reads and doors
		expect(free.get('console') ?? 0).toBeGreaterThan(0);
		expect(free.get('globalThis')).toBe(1);
		expect([...doc_members].sort()).toEqual(DOC_MEMBERS_ALLOWED);
		expect([...view_members].sort()).toEqual(VIEW_MEMBERS_ALLOWED);
		// module-level and local bindings are NOT free
		for (const name of [
			'create_record_window',
			'row_of',
			'ROW_WINDOW_MAX_ROWS',
			'container',
			'edit_safety',
			'index',
			'error',
		]) {
			expect(free.has(name), name).toBe(false);
		}
	});

	test('purity census positive controls: a planted read on an unexecuted branch is caught', () => {
		// planted in the :hover catch branch, which the fake-DOM legs never run
		const anchor = '// a DOM without :hover support pins nothing here';
		expect(source.split(anchor).length, 'anchor present once').toBe(2);
		const plant = (code: string) => source.replace(anchor, `${anchor}\n\t\t\t\t${code}`);
		expect(purity_violations(plant('void page_globals.component_active'))).toEqual([
			'free page_globals',
		]);
		expect(purity_violations(plant('void document.activeElement'))).toEqual(['free document']);
		expect(purity_violations(plant('void window.page_globals'))).toEqual(['free window']);
		expect(purity_violations(plant('void globalThis.page_globals'))).toEqual([
			'globalThis ×2 (only the one defaultView fallback)',
		]);
		expect(purity_violations(plant('void view.page_globals'))).toEqual(['view.page_globals']);
		expect(purity_violations(plant('void doc.body'))).toEqual(['doc.body']);
		// a same-named local elsewhere does not hide a free read
		const shadowed = plant('void document.activeElement').replace(
			'export const row_of',
			'const shadow_probe = () => { const document = null; return document }\nexport const row_of',
		);
		expect(shadowed).not.toBe(plant('void document.activeElement'));
		expect(purity_violations(shadowed)).toEqual(['free document']);
	});

	test('the only import is the row_window.js constants', () => {
		const imports = ast.program.body.filter(
			(node) =>
				node.type === 'ImportDeclaration' ||
				node.type === 'ExportAllDeclaration' ||
				(node.type === 'ExportNamedDeclaration' && node.source != null),
		);
		expect(imports.length).toBe(1);
		const declaration = imports[0] as {
			source: { value: string };
			specifiers: Array<{ imported?: { name?: string } }>;
		};
		expect(declaration.source.value).toBe('../../common/js/row_window.js');
		const names = declaration.specifiers.map((s) => s.imported?.name).sort();
		expect(names).toEqual(['ROW_WINDOW_MARGIN', 'ROW_WINDOW_MAX_ROWS', 'ROW_WINDOW_ROOT_MARGIN']);
		// no dynamic import either
		expect(stripComments(source, { blankStrings: true })).not.toMatch(/\bimport\s*\(/);
	});

	test('the bound FOLLOWS the imported constant (module re-run against a scratch row_window.js)', async () => {
		// An outcome, not a spelling: the verbatim module, next to a scratch
		// row_window.js exporting a different bound/margin, must fill to THAT
		// bound and arm its observer above it. A literal of its own (200, 100*2,
		// …) fills to the real bound and fails here.
		const scratch = mkdtempSync(join(tmpdir(), 'record_window_bound_'));
		try {
			mkdirSync(join(scratch, 'core', 'section_record', 'js'), { recursive: true });
			mkdirSync(join(scratch, 'core', 'common', 'js'), { recursive: true });
			const bound = 7;
			const margin = 2;
			expect(bound).not.toBe(ROW_WINDOW_MAX_ROWS);
			writeFileSync(
				join(scratch, 'core', 'common', 'js', 'row_window.js'),
				`export const ROW_WINDOW_MAX_ROWS = ${bound};\n` +
					`export const ROW_WINDOW_MARGIN = ${margin};\n` +
					"export const ROW_WINDOW_ROOT_MARGIN = '0px';\n",
			);
			const copy = join(scratch, 'core', 'section_record', 'js', 'record_window.js');
			writeFileSync(copy, source);
			const alt = (await import(copy)) as RecordWindowModule;

			const h = make_harness();
			const { content_data } = make_container(h);
			const constructed_before = FakeIntersectionObserver.constructed.length;
			const handle = await alt.create_record_window({
				owner: h.owner,
				generation: 1,
				container: content_data,
				rows: entries(50),
				build: async () => {
					const instance = make_instance('section_record', h.owner);
					return { instance, node: render_row(h.doc, instance).node };
				},
				edit_safety: h.edit_safety,
			});
			h.doc.frame();
			assert_invariant(content_data, 50);
			expect(built_count(content_data)).toBe(bound);
			expect(FakeIntersectionObserver.constructed.length, 'N > the scratch bound arms').toBe(
				constructed_before + 1,
			);
			// the release target is the scratch bound − the scratch margin: 7 built +
			// 39..41 in reach = 10, released farthest-first (0..4) down to EXACTLY 5
			last_observer().fire(range_set(40, 40));
			await handle.idle();
			expect(built_count(content_data)).toBe(bound - margin);
			expect(handle.is_built(4)).toBe(false);
			expect(handle.is_built(5)).toBe(true);
			expect(handle.is_built(40)).toBe(true);
			await handle.destroy();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('the real bound: 5000 entries build exactly ROW_WINDOW_MAX_ROWS', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 5000 });
		expect(built_count(content_data)).toBe(ROW_WINDOW_MAX_ROWS);
		await handle.destroy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 11-14. failed build, stale build, detached fill, destroy
// ─────────────────────────────────────────────────────────────────────────────

describe('11. a failed build keeps its index', () => {
	for (const reason of ['throw', 'null', 'destroyed'] as const) {
		test(`${reason}: [data-failed] at the same index, logged, reveal retries`, async () => {
			const h = make_harness();
			const { content_data } = make_container(h);
			let broken = true;
			const errors_before = error_spy.mock.calls.length;
			const build = async (_entry: Entry, i: number) => {
				const instance = make_instance('section_record', h.owner);
				if (i === 1 && broken) {
					if (reason === 'throw') throw new Error('boom');
					if (reason === 'null') return null;
					instance.status = 'destroyed';
				}
				return { instance, node: render_row(h.doc, instance).node };
			};
			const { handle } = await open(h, content_data, { n: 3, build });
			assert_invariant(content_data, 3);
			const failed = content_data.children[1] as FakeElement;
			expect(failed.classList.contains('placeholder')).toBe(true);
			expect(failed.getAttribute('data-failed')).toBe(reason);
			expect(error_spy.mock.calls.length).toBeGreaterThan(errors_before);
			expect(handle.record_at(1)).toBeNull();

			broken = false;
			await handle.reveal(1);
			assert_invariant(content_data, 3);
			expect(handle.is_built(1)).toBe(true);
			expect((content_data.children[1] as FakeElement).hasAttribute('data-failed')).toBe(false);
			await handle.destroy();
		});
	}

	test('a failed placeholder above the bound is not rebuilt by the observer (only reveal retries)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		let calls_for_250 = 0;
		const build = async (_entry: Entry, i: number) => {
			const instance = make_instance('section_record', h.owner);
			if (i === 250) {
				calls_for_250++;
				throw new Error('boom');
			}
			return { instance, node: render_row(h.doc, instance).node };
		};
		const { handle } = await open(h, content_data, { n: 1000, build });
		h.doc.frame();
		last_observer().fire(range_set(245, 254));
		await handle.idle();
		expect(calls_for_250).toBe(1);
		last_observer().fire(range_set(246, 255));
		await handle.idle();
		expect(calls_for_250).toBe(1);
		assert_invariant(content_data, 1000);
		await handle.destroy();
	});
});

describe('12. a stale build is never inserted', () => {
	const deferred_window = async (h: Harness, late_instance?: FakeInstance) => {
		const { content_data } = make_container(h);
		let release_build: () => void = () => {};
		const late: FakeInstance[] = [];
		const build = async (_entry: Entry, i: number) => {
			const instance =
				i === 200 && late_instance ? late_instance : make_instance('section_record', h.owner);
			if (i === 200) {
				late.push(instance);
				await new Promise<void>((resolve) => {
					release_build = resolve;
				});
			}
			return { instance, node: render_row(h.doc, instance).node };
		};
		const { handle } = await open(h, content_data, { n: 201, build });
		return { handle, content_data, late, release: () => release_build() };
	};

	test('after destroy: instance destroyed, placeholder kept', async () => {
		const h = make_harness();
		const { handle, content_data, late, release } = await deferred_window(h);
		const revealing = handle.reveal(200);
		await Promise.resolve();
		const destroying = handle.destroy();
		release();
		await revealing;
		await destroying;
		expect(late[0]?.destroy_calls).toBe(1);
		expect((content_data.children[200] as FakeElement).classList.contains('placeholder')).toBe(
			true,
		);
		assert_invariant(content_data, 201);
	});

	test('after retire: an instance the successor does NOT hold is destroyed', async () => {
		const h = make_harness();
		const { handle, content_data, late, release } = await deferred_window(h);
		const revealing = handle.reveal(200);
		await Promise.resolve();
		const next = make_container(h);
		const { handle: successor } = await open(h, next.content_data, { n: 0, generation: 2 });
		const retiring = handle.retire(successor);
		release();
		await revealing;
		await retiring;
		expect(late[0]?.destroy_calls).toBe(1);
		expect((content_data.children[200] as FakeElement).classList.contains('placeholder')).toBe(
			true,
		);
		await successor.destroy();
	});

	test('after retire: an instance the successor HOLDS survives the late discard', async () => {
		// the instance cache hands the SAME section_record to both windows: the
		// old window's late build of entry 200 resolves AFTER the successor has
		// adopted that instance at its row 0. Destroying it would kill a live row.
		const h = make_harness();
		const shared = make_instance('section_record', h.owner);
		const { handle, content_data, late, release } = await deferred_window(h, shared);
		const revealing = handle.reveal(200);
		await Promise.resolve();
		const next = make_container(h);
		const { handle: successor } = await open(h, next.content_data, {
			n: 1,
			generation: 2,
			build: async () => ({ instance: shared, node: render_row(h.doc, shared).node }),
		});
		expect(successor.record_at(0)).toBe(shared);
		const retiring = handle.retire(successor);
		release();
		await revealing;
		await retiring;
		expect(late[0]).toBe(shared);
		expect(shared.destroy_calls, 'the successor shows it: never destroyed by the old window').toBe(
			0,
		);
		expect(successor.record_at(0)).toBe(shared);
		expect((content_data.children[200] as FakeElement).classList.contains('placeholder')).toBe(
			true,
		);
		await successor.destroy();
	});
});

describe('12b. teardown races an in-flight release / rebuild', () => {
	/** Spin microtasks until `cond` holds (bounded: a hang is a red, not a timeout). */
	const until = async (cond: () => boolean, label: string) => {
		for (let k = 0; k < 500 && !cond(); k++) await Promise.resolve();
		expect(cond(), label).toBe(true);
	};
	const gate = () => {
		let open_gate: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			open_gate = resolve;
		});
		return { promise, open: () => open_gate() };
	};
	const settles_of = (h: Harness, instance: FakeInstance) =>
		h.log.settle.filter((s) => s.instance === instance).length;

	test('destroy() during a release: the releasing row is in its flush; a failed settle is orphaned once, never destroyed', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const row = handle.record_at(0) as FakeInstance;
		const failing = row.ar_instances[0] as FakeInstance;
		failing.settle_result = false;
		// a recorded failure, out of the registry: the release re-settles it
		// (pin 4 cannot hold the row), and only a flush verdict can orphan it
		h.unsaved.add(failing);
		expect((await handle.flush([0])).failed).toEqual([failing]);
		h.unsaved.delete(failing);
		const save = gate();
		failing.on_settle = () => save.promise;
		last_observer().fire(range_set(600, 609));
		await until(() => settles_of(h, failing) === 2, 'the release is awaiting its settle');
		expect(
			(content_data.children[0] as FakeElement).classList.contains('placeholder'),
			'row 0 is mid-release: not yet a placeholder',
		).toBe(false);
		const destroying = handle.destroy();
		save.open();
		const result = await destroying;
		await handle.idle();
		expect(result.failed, "destroy's verdict covers the releasing row").toEqual([failing]);
		expect(h.log.orphan, 'orphaned exactly once (not by the dead release too)').toEqual([failing]);
		expect(failing.destroy_calls).toBe(0);
		expect(row.destroy_calls, 'the dead release destroyed nothing').toBe(0);
	});

	test('rebuild(i) resuming after retire(successor): the instance the successor holds is never destroyed', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const row0 = handle.record_at(0) as FakeInstance;
		const row1 = handle.record_at(1) as FakeInstance;
		// row 1: a dirty child whose (clean) save is still in flight when retire starts
		const dirty1 = row1.ar_instances[0] as FakeInstance;
		const save1 = gate();
		dirty1.on_settle = () => save1.promise;
		h.unsaved.add(dirty1);
		// row 0: retire's own flush of it outlasts rebuild's, so retire has not
		// cleared its instance map when rebuild resumes
		const dirty0 = row0.ar_instances[0] as FakeInstance;
		const save0 = gate();
		dirty0.on_settle = () => save0.promise;
		h.unsaved.add(dirty0);
		const rebuilding = handle.rebuild(1);
		await until(() => settles_of(h, dirty1) === 1, 'rebuild is awaiting its flush');
		// the instance cache hands row1 to the successor (no re-render of its children)
		const next = make_container(h);
		const { handle: successor } = await open(h, next.content_data, {
			n: 1,
			generation: 2,
			build: async () => {
				const node = h.doc.createElement('div');
				node.className = `section_record ${row1.id}`;
				return { instance: row1, node };
			},
		});
		expect(successor.record_at(0)).toBe(row1);
		const retiring = handle.retire(successor);
		await until(() => settles_of(h, dirty0) === 1, "retire is awaiting row 0's flush");
		save1.open();
		expect(await rebuilding, 'a dead window refuses the rebuild').toBe(false);
		save0.open();
		await retiring;
		expect(row1.destroy_calls, 'the successor shows it: never destroyed').toBe(0);
		expect(successor.record_at(0)).toBe(row1);
		expect(row0.destroy_calls, 'retire destroys what the successor does not hold').toBe(1);
		await successor.destroy();
	});

	test('rebuild(i) resuming after destroy(): a failed child is orphaned once, its row never destroyed', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const row1 = handle.record_at(1) as FakeInstance;
		const dirty = row1.ar_instances[0] as FakeInstance;
		// rebuild's settle succeeds, destroy's (later) settle of the same
		// instance fails: the two verdicts disagree, the teardown's must win
		const first = gate();
		const second = gate();
		let call = 0;
		dirty.on_settle = async () => {
			call++;
			if (call === 1) {
				await first.promise;
				dirty.settle_result = true;
			} else {
				await second.promise;
				dirty.settle_result = false;
			}
		};
		h.unsaved.add(dirty);
		const rebuilding = handle.rebuild(1);
		await until(() => settles_of(h, dirty) === 1, 'rebuild is awaiting its flush');
		// the clean first settle would deregister it; keep it registered for destroy
		const destroying = handle.destroy();
		await until(() => settles_of(h, dirty) === 2, "destroy is awaiting the row's flush");
		first.open();
		expect(await rebuilding, 'a dead window refuses the rebuild').toBe(false);
		h.unsaved.add(dirty);
		second.open();
		const result = await destroying;
		expect(result.failed).toEqual([dirty]);
		expect(h.log.orphan, 'orphaned exactly once').toEqual([dirty]);
		expect(dirty.destroy_calls).toBe(0);
		expect(row1.destroy_calls, 'the row holding an orphaned edit is never destroyed here').toBe(0);
	});
});

describe('13. detached fill', () => {
	test('--placeholder_size is written only after the container connects', async () => {
		const h = make_harness();
		const { list_body, content_data } = make_container(h, { connected: false });
		const constructed_before = FakeIntersectionObserver.constructed.length;
		const { handle } = await open(h, content_data, { n: 300 });
		h.doc.frame();
		h.doc.frame();
		expect(content_data.style.getPropertyValue('--placeholder_size')).toBe('');
		expect(FakeIntersectionObserver.constructed.length, 'a detached window arms nothing').toBe(
			constructed_before,
		);
		h.doc.body.appendChild(list_body); // common.render swaps it in
		h.doc.frame();
		expect(content_data.style.getPropertyValue('--placeholder_size')).toBe('40.0px');
		expect(FakeIntersectionObserver.constructed.length).toBe(constructed_before + 1);
		await handle.destroy();
	});
});

describe('14. destroy', () => {
	test('disconnects the observer and aborts the delegated listeners', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 201 });
		h.doc.frame();
		const io = last_observer();
		expect(content_data.live_listeners).toBe(1); // focusin
		await handle.destroy();
		expect(io.disconnected).toBe(true);
		expect(handle.signal.aborted).toBe(true);
		expect(content_data.live_listeners).toBe(0);
	});

	test('a throwing flush still tears the window down (stop, generation++), then rejects', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 201, generation: 4 });
		h.doc.frame();
		const io = last_observer();
		const active = (handle.record_at(0) as FakeInstance).ar_instances[0] as FakeInstance;
		h.page.active = active;
		h.edit_safety.deactivate = async () => {
			throw new Error('deactivate boom');
		};
		await expect(handle.destroy()).rejects.toThrow(/deactivate boom/);
		expect(io.disconnected, 'observer disconnected').toBe(true);
		expect(handle.signal.aborted, 'delegated listeners aborted').toBe(true);
		expect(content_data.live_listeners).toBe(0);
		expect(handle.generation, 'a payload stamped with the old generation goes stale').toBe(5);
		expect(handle.record_at(0), 'instance map cleared').toBeNull();
		// a second destroy is a no-op, not a second flush
		expect(await handle.destroy()).toEqual({ failed: [], pending: [] });
	});
});

describe('14b. a throwing step and a non-empty container', () => {
	test('a throwing edit-safety binding during a release: row stays built AND pinned, logged once, no unhandled rejection', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		// row 0's flush runs (a) deactivate on the in-row active component: it throws
		const active = (handle.record_at(0) as FakeInstance).ar_instances[0] as FakeInstance;
		const original_deactivate = h.edit_safety.deactivate;
		let throws = 0;
		h.edit_safety.deactivate = async (instance: FakeInstance) => {
			if (instance === active) {
				throws++;
				throw new Error('deactivate boom');
			}
			return original_deactivate(instance);
		};
		// is_pinned(0) must be false for the release to reach the flush: the
		// active component pins its row, so expose it to the flush only
		let flushing = false;
		h.edit_safety.component_active = () => (flushing ? active : null);
		const original_settle = h.edit_safety.settle;
		const unsaved_before = h.edit_safety.unsaved_instances;
		h.edit_safety.unsaved_instances = () => {
			// is_pinned reads unsaved_instances AFTER component_active; the
			// flush reads component_active first — flip on the pin check's tail
			flushing = true;
			return unsaved_before();
		};
		const unhandled: unknown[] = [];
		const on_unhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', on_unhandled);
		const errors_before = error_spy.mock.calls.filter((c) =>
			String(c[0]).includes('step failed'),
		).length;
		try {
			last_observer().fire(range_set(600, 609));
			await handle.idle();
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			process.off('unhandledRejection', on_unhandled);
		}
		expect(throws, 'the release reached the throwing flush').toBe(1);
		expect(handle.is_built(0), 'never stuck releasing').toBe(true);
		expect(handle.record_at(0)).not.toBeNull();
		expect((content_data.children[0] as FakeElement).classList.contains('placeholder')).toBe(false);
		const step_errors =
			error_spy.mock.calls.filter((c) => String(c[0]).includes('step failed')).length -
			errors_before;
		expect(step_errors, 'logged once by run()').toBe(1);
		// run()'s queue.catch subscribes to the dropped step: no second report
		expect(unhandled, 'the observer-dropped step is not an unhandled rejection').toEqual([]);
		// a THROW pin is sticky (the window never retries a throwing binding on
		// its own): a later step with clean bindings does not release row 0
		h.edit_safety.deactivate = original_deactivate;
		h.edit_safety.settle = original_settle;
		h.edit_safety.component_active = () => null;
		h.edit_safety.unsaved_instances = unsaved_before;
		last_observer().fire(range_set(700, 709));
		await handle.idle();
		expect(handle.is_built(0), 'the throwing flush pinned row 0').toBe(true);
		// and the built row is still in the owner destroy flush
		await handle.destroy();
	});

	test('a throwing flush in rebuild(i): rejects, row stays built AND pinned', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const row = handle.record_at(0) as FakeInstance;
		const active = row.ar_instances[0] as FakeInstance;
		const original_deactivate = h.edit_safety.deactivate;
		h.edit_safety.component_active = () => active;
		h.edit_safety.deactivate = async () => {
			throw new Error('deactivate boom');
		};
		await expect(handle.rebuild(0)).rejects.toThrow(/deactivate boom/);
		expect(handle.is_built(0)).toBe(true);
		expect(handle.record_at(0)).toBe(row);
		h.edit_safety.deactivate = original_deactivate;
		h.edit_safety.component_active = () => null;
		// row 0 is the farthest from the reach: only the pin keeps it
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(handle.is_built(0), 'the throwing flush pinned row 0').toBe(true);
		expect(row.destroy_calls).toBe(0);
		await handle.destroy();
	});

	test('a throwing flush in retire: no row destroyed, map cleared, torn down, logged once, rejects', async () => {
		const h = make_harness();
		const old = make_container(h);
		const { handle } = await open(h, old.content_data, { n: 3, generation: 7 });
		const rows = [0, 1, 2].map((i) => handle.record_at(i) as FakeInstance);
		h.page.active = rows[1]?.ar_instances[0] as FakeInstance;
		h.edit_safety.deactivate = async () => {
			throw new Error('deactivate boom');
		};
		const next = make_container(h);
		const { handle: successor } = await open(h, next.content_data, { n: 0, generation: 8 });
		const logged_before = error_spy.mock.calls.filter((c) =>
			String(c[0]).includes('retire flush threw'),
		).length;
		await expect(handle.retire(successor)).rejects.toThrow(/deactivate boom/);
		// no verdict: nothing is judged clean, so no row (and no component) is destroyed
		for (const row of rows) {
			expect(row.destroy_calls).toBe(0);
			for (const component of row.ar_instances) expect(component.destroy_calls).toBe(0);
		}
		expect(h.log.orphan, 'no verdict to orphan by').toEqual([]);
		// the dead window lets go of every row and acts no more
		for (let i = 0; i < 3; i++)
			expect(handle.record_at(i), `row ${i} released by the map`).toBeNull();
		expect(handle.signal.aborted).toBe(true);
		expect(old.content_data.inert).toBe(true);
		expect(handle.generation).toBe(8);
		expect(
			error_spy.mock.calls.filter((c) => String(c[0]).includes('retire flush threw')).length -
				logged_before,
			'logged once',
		).toBe(1);
		// a second retire / destroy is a no-op, not a second flush
		expect(await handle.retire(successor)).toEqual({ failed: [], pending: [] });
		expect(await handle.destroy()).toEqual({ failed: [], pending: [] });
		await successor.destroy();
	});

	test('a non-empty container throws (leftover children would shift every index)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		content_data.appendChild(h.doc.createElement('div'));
		await expect(open(h, content_data, { n: 3 })).rejects.toThrow(/container must be empty/);
		expect(content_data.children.length, 'nothing appended').toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('15. semantics sync', () => {
	const open_table = async (n: number, header: boolean) => {
		const h = make_harness();
		const { list_body, content_data } = make_container(h, { header });
		const header_node = header ? (list_body.children[0] as FakeElement) : null;
		rw.apply_table_semantics(list_body, header_node);
		const { handle } = await open(h, content_data, { n });
		h.doc.frame();
		return { handle, list_body, content_data, header_node };
	};

	test('table with header, N=3: table / row+columnheader / rowgroup / row / cell, no rowcount', async () => {
		const { handle, list_body, content_data, header_node } = await open_table(3, true);
		expect(list_body.getAttribute('role')).toBe('table');
		expect(header_node?.getAttribute('role')).toBe('row');
		for (const head of header_node?.children ?? [])
			expect(head.getAttribute('role')).toBe('columnheader');
		expect(content_data.getAttribute('role')).toBe('rowgroup');
		for (const row of content_data.children) {
			expect(row.getAttribute('role')).toBe('row');
			for (const cell of row.children) expect(cell.getAttribute('role')).toBe('cell');
			expect(row.hasAttribute('aria-rowindex')).toBe(false);
		}
		expect(list_body.hasAttribute('aria-rowcount')).toBe(false);
		await handle.destroy();
	});

	test('table with header, N=0: the table keeps only its header row', async () => {
		const { handle, list_body, content_data } = await open_table(0, true);
		expect(list_body.getAttribute('role')).toBe('table');
		expect(content_data.hasAttribute('role')).toBe(false);
		await handle.destroy();
	});

	test('header-less table, N=0: role=table dropped (a table owning no row fails aria-required-children)', async () => {
		const { handle, list_body, content_data } = await open_table(0, false);
		expect(list_body.hasAttribute('role')).toBe(false);
		expect(content_data.hasAttribute('role')).toBe(false);
		await handle.destroy();
	});

	test('HIDDEN header (.hide / [hidden]), N=0: role=table dropped — a display:none header is no row', async () => {
		for (const hide of ['class', 'attribute'] as const) {
			const h = make_harness();
			const { list_body, content_data } = make_container(h, { header: true });
			const header_node = list_body.children[0] as FakeElement;
			rw.apply_table_semantics(list_body, header_node);
			if (hide === 'class') header_node.className = 'header_wrapper_list hide';
			else header_node.setAttribute('hidden', '');
			const { handle } = await open(h, content_data, { n: 0 });
			h.doc.frame();
			expect([hide, list_body.hasAttribute('role')]).toEqual([hide, false]);
			expect(content_data.hasAttribute('role')).toBe(false);
			await handle.destroy();
		}
	});

	test('HIDDEN header, N=201: not counted (rowcount N, rowindex i+1)', async () => {
		const h = make_harness();
		const { list_body, content_data } = make_container(h, { header: true });
		const header_node = list_body.children[0] as FakeElement;
		rw.apply_table_semantics(list_body, header_node);
		header_node.className = 'header_wrapper_list hide';
		const { handle } = await open(h, content_data, { n: 201 });
		h.doc.frame();
		expect(list_body.getAttribute('aria-rowcount')).toBe('201');
		expect((content_data.children[0] as FakeElement).getAttribute('aria-rowindex')).toBe('1');
		await handle.destroy();
	});

	test('N=0 then N>0 in the SAME list_body (a content render): role=table comes back', async () => {
		for (const header of [false, true]) {
			const h = make_harness();
			const { list_body, content_data } = make_container(h, { header });
			const header_node = header ? (list_body.children[0] as FakeElement) : null;
			rw.apply_table_semantics(list_body, header_node);
			// the portal views hide their header at N=0
			if (header_node) header_node.className = 'header_wrapper_list hide';
			const { handle: empty } = await open(h, content_data, { n: 0 });
			h.doc.frame();
			expect([header, list_body.hasAttribute('role')]).toEqual([header, false]);
			// the content swap: a new content_data replaces the old one, header shown again
			const next = h.doc.createElement('div');
			next.className = 'content_data';
			content_data.replaceWith(next);
			if (header_node) header_node.className = 'header_wrapper_list';
			const { handle: filled } = await open(h, next, { n: 2 });
			h.doc.frame();
			expect([header, list_body.getAttribute('role')]).toEqual([header, 'table']);
			expect(next.getAttribute('role')).toBe('rowgroup');
			await empty.destroy();
			await filled.destroy();
		}
	});

	test('header-less table, N=201: rowcount N, rowindex i+1 (no header offset); placeholders row+hidden', async () => {
		const { handle, list_body, content_data } = await open_table(201, false);
		expect(list_body.getAttribute('aria-rowcount')).toBe('201');
		expect((content_data.children[0] as FakeElement).getAttribute('aria-rowindex')).toBe('1');
		expect((content_data.children[199] as FakeElement).getAttribute('aria-rowindex')).toBe('200');
		const placeholder = content_data.children[200] as FakeElement;
		expect(placeholder.getAttribute('role')).toBe('row');
		expect(placeholder.getAttribute('aria-hidden')).toBe('true');
		await handle.destroy();
	});

	test('table with header, N=201: rowcount N+1, rowindex i+2, also on a row built later', async () => {
		const { handle, list_body, content_data } = await open_table(201, true);
		expect(list_body.getAttribute('aria-rowcount')).toBe('202');
		expect((content_data.children[0] as FakeElement).getAttribute('aria-rowindex')).toBe('2');
		await handle.reveal(200);
		expect(handle.is_built(200)).toBe(true);
		expect((content_data.children[200] as FakeElement).getAttribute('aria-rowindex')).toBe('202');
		// the reveal pushed the window over the bound: rows were released, the
		// rowcount still counts every row
		expect(built_count(content_data)).toBeLessThanOrEqual(ROW_WINDOW_MAX_ROWS);
		expect(list_body.getAttribute('aria-rowcount')).toBe('202');
		await handle.destroy();
	});

	test('position attributes are cleared when the last placeholder leaves (presence flip)', async () => {
		const h = make_harness();
		const { list_body, content_data } = make_container(h, { header: true });
		rw.apply_table_semantics(list_body, list_body.children[0] as FakeElement);
		let fail_once = true;
		const build = async (_entry: Entry, i: number) => {
			const instance = make_instance('section_record', h.owner);
			if (i === 1 && fail_once) {
				fail_once = false;
				throw new Error('boom');
			}
			return { instance, node: render_row(h.doc, instance).node };
		};
		// N=3 with one failed row: a placeholder exists below the bound
		const { handle } = await open(h, content_data, { n: 3, build });
		h.doc.frame();
		expect(list_body.getAttribute('aria-rowcount')).toBe('4');
		expect((content_data.children[0] as FakeElement).getAttribute('aria-rowindex')).toBe('2');
		await handle.reveal(1);
		expect(placeholders_of(content_data).length).toBe(0);
		expect(list_body.hasAttribute('aria-rowcount')).toBe(false);
		for (const row of content_data.children) expect(row.hasAttribute('aria-rowindex')).toBe(false);
		await handle.destroy();
	});

	test('list layout: role=list only when N>0, listitem rows, setsize/posinset only with placeholders', async () => {
		const h = make_harness();
		const small = make_container(h);
		const { handle: w3 } = await open(h, small.content_data, { n: 3, layout: 'list' });
		h.doc.frame();
		expect(small.content_data.getAttribute('role')).toBe('list');
		for (const row of small.content_data.children) {
			expect(row.getAttribute('role')).toBe('listitem');
			expect(row.hasAttribute('aria-posinset')).toBe(false);
			for (const cell of row.children) expect(cell.hasAttribute('role')).toBe(false);
		}
		const empty = make_container(h);
		const { handle: w0 } = await open(h, empty.content_data, { n: 0, layout: 'list' });
		h.doc.frame();
		expect(empty.content_data.hasAttribute('role')).toBe(false);
		const big = make_container(h);
		const { handle: w201 } = await open(h, big.content_data, { n: 201, layout: 'list' });
		h.doc.frame();
		const row5 = big.content_data.children[5] as FakeElement;
		expect(row5.getAttribute('aria-posinset')).toBe('6');
		expect(row5.getAttribute('aria-setsize')).toBe('201');
		expect((big.content_data.children[200] as FakeElement).getAttribute('role')).toBe('listitem');
		await w3.destroy();
		await w0.destroy();
		await w201.destroy();
	});

	test('draggable_rows stamps built rows only; decorate runs on fill AND on later swaps', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const decorated: number[] = [];
		const { handle } = await open(h, content_data, {
			n: 201,
			draggable_rows: true,
			decorate: (_node, i) => decorated.push(i),
		});
		expect((content_data.children[0] as FakeElement).getAttribute('draggable')).toBe('true');
		expect((content_data.children[200] as FakeElement).hasAttribute('draggable')).toBe(false);
		expect(decorated.length).toBe(ROW_WINDOW_MAX_ROWS);
		await handle.reveal(200);
		expect(decorated).toContain(200);
		expect((content_data.children[200] as FakeElement).getAttribute('draggable')).toBe('true');
		await handle.destroy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers + keyboard + rebuild
// ─────────────────────────────────────────────────────────────────────────────

describe('pure helpers', () => {
	test('row_of: Text node → parent; resolves through a nested section_record; null outside', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const row2 = content_data.children[2] as FakeElement;
		// a nested row (hover record / nested portal row) inside row 2
		const nested = h.doc.createElement('div');
		nested.className = 'section_record';
		nested.setAttribute('data-index', '0');
		const deep = h.doc.createElement('span');
		nested.appendChild(deep);
		row2.appendChild(nested);
		expect(rw.row_of(content_data, deep)).toEqual({ node: row2, index: 2 });
		const text = { nodeType: 3, parentElement: deep };
		expect(rw.row_of(content_data, text)).toEqual({ node: row2, index: 2 });
		expect(rw.row_of(content_data, h.doc.body)).toBeNull();
		await handle.destroy();
	});

	test('carry_row_attributes copies the window-owned attributes', () => {
		const h = make_harness();
		const a = h.doc.createElement('div');
		const b = h.doc.createElement('div');
		a.setAttribute('data-index', '4');
		a.setAttribute('role', 'row');
		a.setAttribute('aria-rowindex', '5');
		a.setAttribute('draggable', 'true');
		rw.carry_row_attributes(a, b);
		expect(b.getAttribute('data-index')).toBe('4');
		expect(b.getAttribute('role')).toBe('row');
		expect(b.getAttribute('aria-rowindex')).toBe('5');
		expect(b.getAttribute('draggable')).toBe('true');
		expect(b.hasAttribute('aria-posinset')).toBe(false);
	});
});

describe('keyboard and rebuild', () => {
	test('focusin on a row builds ± margin around it (Tab and Shift+Tab never reach an unbuilt row)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		// scroll to 600: 580..629 built, the fill's far rows released; both sides
		// of row 600's ± margin are placeholders BEFORE the focus
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		const below = 600 - ROW_WINDOW_MARGIN;
		const above = 600 + ROW_WINDOW_MARGIN;
		expect(handle.is_built(600)).toBe(true);
		expect(handle.is_built(below), 'the − side starts unbuilt').toBe(false);
		expect(handle.is_built(above), 'the + side starts unbuilt').toBe(false);
		const row600 = content_data.children[600] as FakeElement;
		const input = row600.children[0]?.children[0]?.children[0] as FakeElement;
		input.dispatchEvent(new FakeEvent('focusin', { bubbles: true }));
		await handle.idle();
		for (let i = below; i <= above; i++) expect(handle.is_built(i), `row ${i} built`).toBe(true);
		assert_invariant(content_data, 1000);
		await handle.destroy();
	});

	test('reveal / ensure_built on built rows build nothing (no row is built twice)', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle, built_log } = await open(h, content_data, { n: 1000 });
		h.doc.frame();
		const builds = built_log.length;
		await handle.reveal(10);
		await handle.ensure_built(0, 150);
		await handle.idle();
		expect(built_log.length, 'every row asked for was already built').toBe(builds);
		assert_single_build(handle, built_log);
		// a released row is built again by reveal — once
		last_observer().fire(range_set(600, 609));
		await handle.idle();
		expect(handle.is_built(0)).toBe(false);
		await handle.reveal(0);
		await handle.reveal(0);
		expect(built_log.filter((b) => b.index === 0).length).toBe(2);
		assert_single_build(handle, built_log);
		await handle.destroy();
	});

	test('rebuild(i): a clean row is replaced by a fresh instance at the same index; a dirty one is refused', async () => {
		const h = make_harness();
		const { content_data } = make_container(h);
		const { handle } = await open(h, content_data, { n: 3 });
		const before = handle.record_at(1) as FakeInstance;
		expect(await handle.rebuild(1)).toBe(true);
		expect(before.destroy_calls).toBe(1);
		const after = handle.record_at(1) as FakeInstance;
		expect(after).not.toBe(before);
		assert_invariant(content_data, 3);

		const failing = after.ar_instances[0] as FakeInstance;
		failing.settle_result = false;
		h.unsaved.add(failing);
		expect(await handle.rebuild(1)).toBe(false);
		expect(handle.record_at(1)).toBe(after);
		expect(after.destroy_calls).toBe(0);
		h.unsaved.delete(failing);
		failing.settle_result = true;
		await handle.destroy();
	});
});
