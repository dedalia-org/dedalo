/**
 * CLIENT CONTROL-NAMING tripwire (DEC-12; audit 2026-08-26 row P1-18, finding
 * CLI-10).
 *
 * WHAT WAS WRONG, twice.
 *
 * (1) NESTED GROUPS. `ui.component.build_wrapper_edit` names the component group
 *     BEFORE any content is committed, and the whole subtree then arrives in ONE
 *     append, so the naming really happens in `a11y.name_controls`. That function
 *     read the group label ONCE, for the container it was called on, and stamped
 *     it on every control in the subtree. Component groups NEST — a portal row is
 *     a labelled group holding one labelled group per column — so every column
 *     input in a portal announced the PORTAL's name ("Authors"), and adjacent
 *     fields became programmatically indistinguishable. A WRONG name is worse
 *     than a missing one: axe sees a name present and passes, which is exactly
 *     how this survived the first pass of the row.
 *
 * (1b) THE SHIPPED LINE VIEW — the refutation of the first fix. Naming a control
 *     by its nearest labelled ANCESTOR is only correct if the component it
 *     belongs to declares itself one. All 14 `view_line_edit_*` build their
 *     wrapper with `label : null` (the column heading is drawn once by the list
 *     header), so they built NO label node and NO group: `closest()` walked past
 *     the column and resolved to the PORTAL again, and a line control outside a
 *     portal got no name at all. The fix is at the chokepoint: a label-less
 *     wrapper is still declared a group, by TEXT. This gate reads WHICH a11y
 *     export `ui.component.build_wrapper_edit` calls on that branch and then
 *     EXECUTES that export over the shipped shape, so a rename cannot defeat it
 *     and a deletion reds it.
 *
 * (2) THE LOGIN FORM. Its fields carried a `placeholder` and nothing else. A
 *     placeholder is not a label: it vanishes on the first keystroke, and axe's
 *     `label` rule accepts a non-empty one — so neither the browser tier nor the
 *     axe leg would have caught it. It is the first surface every curator meets.
 *
 * WHAT THIS ASSERTS:
 *   - the naming chokepoint is EXECUTED, not grepped: `a11y.label_group` /
 *     `a11y.name_controls` are run over a nested group tree and each control must
 *     come out named by ITS OWN group — a spelling assertion here would be
 *     defeated by a rename, and a flat fixture cannot see the defect at all;
 *   - a TOTAL census of the login area's tracked JS: every text-entry control the
 *     login screen CREATES is named in the same file (through `a11y.set_label`,
 *     an `aria_label`/`aria-label` of its own, or a `<label for>`), with a floor
 *     so a parser that stops seeing controls cannot pass by finding nothing.
 *
 * HONEST LIMIT. The browser half — that a real curator's screen reader hears
 * those names on the real surfaces — is `test_a11y_keyboard` plus the axe phase
 * over the `component_group_nested` and `login_form` surfaces. What is proved
 * here is the law inside the chokepoint and the shape of the login source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// the REAL static table semantics of the row box (a pure module: only constants imported)
import {
	apply_table_semantics,
	create_record_window,
} from '../../client/dedalo/core/section_record/js/record_window.js';
import { browserSources } from '../helpers/browser_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const A11Y_MODULE = '../../client/dedalo/core/common/js/a11y.js';

/** Floor: the login census must stay a census. */
const MIN_LOGIN_CONTROLS = 5;

/** Floor: the line views are the shipped default of every portal column. */
const MIN_LINE_VIEWS = 10;

const UI_MODULE_PATH = 'client/dedalo/core/common/js/ui.js';

/** Controls a form label never has to name (they carry their own). */
const SELF_NAMING_TYPES = new Set(['hidden', 'submit', 'button', 'reset']);

/* ------------------------------------------------------------------ *
 * A minimal DOM, so the REAL a11y module can be executed outside a browser.
 * It implements exactly what `name_controls` / `label_group` use: attribute
 * access, `closest`, `querySelectorAll`, `id`, and a parent chain.
 * ------------------------------------------------------------------ */
class FakeElement {
	tagName: string;
	type: string | undefined;
	parentElement: FakeElement | null = null;
	children: FakeElement[] = [];
	private attrs = new Map<string, string>();
	/** What the REAL record window reads to build and stamp its rows. */
	readonly ownerDocument = FAKE_DOCUMENT;
	readonly isConnected = false;
	readonly classList = {
		contains: (name: string) => this.classes().includes(name),
		add: (name: string) => {
			if (!this.classes().includes(name))
				this.attrs.set('class', [...this.classes(), name].join(' '));
		},
		remove: (name: string) => {
			this.attrs.set(
				'class',
				this.classes()
					.filter((c) => c !== name)
					.join(' '),
			);
		},
	};

	constructor(tagName: string, attrs: Record<string, string> = {}) {
		this.tagName = tagName.toUpperCase();
		for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
		this.type = attrs.type;
	}
	private classes(): string[] {
		return (this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
	}
	set className(value: string) {
		this.attrs.set('class', value);
	}
	get id(): string {
		return this.attrs.get('id') ?? '';
	}
	set id(value: string) {
		this.attrs.set('id', value);
	}
	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, String(value));
	}
	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}
	hasAttribute(name: string): boolean {
		return this.attrs.has(name);
	}
	append(child: FakeElement): FakeElement {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}
	/** A fragment appends its children (the window assembles its fill in one). */
	appendChild(child: FakeElement): FakeElement {
		if (child.tagName === '#FRAGMENT') {
			for (const c of child.children.splice(0)) this.append(c);
			return child;
		}
		return this.append(child);
	}
	addEventListener(): void {}
	/** Supports the two selector shapes the module uses: a tag list and `[attr]`. */
	matches(selector: string): boolean {
		return selector.split(',').some((part) => {
			const one = part.trim();
			if (one.startsWith('[') && one.endsWith(']')) return this.attrs.has(one.slice(1, -1));
			return this.tagName === one.toUpperCase();
		});
	}
	closest(selector: string): FakeElement | null {
		let node: FakeElement | null = this;
		while (node !== null) {
			if (node.matches(selector)) return node;
			node = node.parentElement;
		}
		return null;
	}
	querySelectorAll(selector: string): FakeElement[] {
		const out: FakeElement[] = [];
		const walk = (node: FakeElement) => {
			for (const child of node.children) {
				if (child.matches(selector)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}
}

/** The document the record window builds through; never connected, so it never arms. */
const FAKE_DOCUMENT = {
	createElement: (tag: string) => new FakeElement(tag),
	createDocumentFragment: () => new FakeElement('#fragment'),
	defaultView: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} },
};

/** Every edit-safety binding the window requires, inert (nothing is released here). */
const INERT_EDIT_SAFETY = Object.fromEntries(
	[
		'deactivate',
		'settle',
		'orphan',
		'unsaved_instances',
		'uncommitted_nodes',
		'register_uncommitted',
		'commit_seq',
		'instance_of_node',
		'owned_elsewhere',
		'component_active',
		'service_autocomplete',
	].map((key) => [key, () => (key.endsWith('s') ? [] : null)]),
);

/**
 * The ROW BOX chain every table row view renders (WC-2026-10-30-section-record-row-box):
 * `list_body[role=table] > content_data[role=rowgroup] > section_record[role=row]
 * > .column[role=cell] > wrapper[role=group]`. The table is labelled by the
 * portal's own label, so a control resolving its name from the nearest labelled
 * ancestor would hear the PORTAL. EVERY role on the chain is stamped by the REAL
 * code: `apply_table_semantics` (table + label) and the REAL `create_record_window`
 * filling one row (rowgroup, row, cells) — this fixture stamps none.
 * Returns the row's cells (the component wrappers go inside them).
 */
async function buildRowBox(portal: FakeElement, portal_label_id: string | null, cells = 2) {
	const list_body = portal.append(new FakeElement('div', { class: 'list_body layout_table' }));
	apply_table_semantics(list_body as unknown as HTMLElement, null, portal_label_id ?? undefined);
	const content_data = list_body.append(new FakeElement('div', { class: 'content_data' }));
	const row = new FakeElement('div', { class: 'section_record' });
	const columns = Array.from({ length: cells }, () =>
		row.append(new FakeElement('div', { class: 'column' })),
	);
	await create_record_window({
		owner: { id: 'portal_owner' },
		slot: 'rows',
		generation: 1,
		container: content_data,
		rows: [{ section_tipo: 'test3', section_id: '1' }],
		layout: 'table',
		edit_safety: INERT_EDIT_SAFETY,
		build: async () => ({ instance: { status: 'built', ar_instances: [] }, node: row }),
	});
	let next = 0;
	const cell = () => {
		const c = columns[next++];
		if (!c) throw new Error('buildRowBox: more cells asked than built');
		return c;
	};
	return { list_body, content_data, row, cell };
}

/**
 * The portal row, in the shape `build_wrapper_edit` produces it: an outer group
 * with its own label, two sibling column groups each with their own, one input
 * per column — inside the row box chain.
 */
async function buildPortalRow() {
	const portal = new FakeElement('div');
	const portal_label = new FakeElement('div', { class: 'label', id: 'portal_label' });
	portal.append(portal_label);
	const { cell } = await buildRowBox(portal, portal_label.id);

	const column = (labelText: string) => {
		const wrapper = cell().append(new FakeElement('div'));
		const label = wrapper.append(new FakeElement('div', { class: 'label', 'data-x': labelText }));
		const content = wrapper.append(new FakeElement('div', { class: 'content_data' }));
		// the control is NOT created here: the two orders (present at build time,
		// arriving later) are the two paths a real column has, and the test drives
		// each of them explicitly.
		const addInput = () => content.append(new FakeElement('input', { type: 'text' }));
		return { wrapper, label, content, addInput };
	};
	const title = column('Title');
	const date = column('Date');
	return { portal, portal_label, title, date };
}

/**
 * The a11y export `ui.component.build_wrapper_edit` calls on the branch where NO
 * label node is rendered (`options.label === null || show_label === false`) —
 * the branch every `view_line_edit_*` takes. Read from the shipped source, so
 * the executed leg below runs whatever the application really runs; a branch
 * that names nothing has no such call and reds every leg that uses this.
 */
function suppressedLabelChokepoint(): string {
	const source = readFileSync(join(REPO_ROOT, UI_MODULE_PATH), 'utf8');
	const start = source.indexOf('if (options.label === null || show_label === false) {');
	expect(
		start,
		`${UI_MODULE_PATH}: the label-suppressed branch of build_wrapper_edit is gone`,
	).toBeGreaterThan(0);
	const end = source.indexOf('} else if (options.label)', start);
	expect(end, `${UI_MODULE_PATH}: the label branch chain changed shape`).toBeGreaterThan(start);
	const branch = source.slice(start, end);
	const called = /a11y\.([A-Za-z_$][\w$]*)\(\s*wrapper\s*,\s*label\s*\)/.exec(branch);
	expect(
		called?.[1],
		'a component whose label node is suppressed (every view_line_edit_*) must STILL be declared a named group at the chokepoint, or its controls are named by whatever ancestor happens to be labelled — the portal',
	).toBeTruthy();
	return called?.[1] ?? '';
}

async function lineViewFiles(): Promise<string[]> {
	// The corpus is the shared browser lister (census_derivation_tripwire: a gate
	// imports a lister that owns its roots rather than naming a directory here).
	return browserSources().filter((p) => /\/view_line_edit_[a-z_]+\.js$/.test(p));
}

/**
 * `label_group` touches `document` only to install the observer; give it a
 * body-less one — and REMEMBER that we did, because this process is shared with
 * every other gate: a stub `document` left behind makes a later file believe it
 * is running in a browser (mock_isolation_tripwire's own rule).
 */
let documentStubInstalled = false;

async function loadA11y() {
	const globals = globalThis as unknown as { document?: unknown };
	if (globals.document === undefined) {
		globals.document = {};
		documentStubInstalled = true;
	}
	return await import(A11Y_MODULE);
}

afterAll(() => {
	if (!documentStubInstalled) return;
	const globals = globalThis as unknown as { document?: unknown };
	globals.document = undefined;
	documentStubInstalled = false;
});

/* ------------------------------------------------------------------ *
 * The login census (pure, so a planted offender drives the same code).
 * ------------------------------------------------------------------ */
interface Control {
	variable: string;
	elementType: string;
	type: string | null;
	id: string | null;
	hasPlaceholder: boolean;
	named: boolean;
	why: string;
}

function scanControls(source: string): Control[] {
	const controls: Control[] = [];
	const factory =
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ui\.create_dom_element\(\s*\{([\s\S]{0,900}?)\n\t*\}\s*\)/g;
	let m: RegExpExecArray | null = factory.exec(source);
	while (m !== null) {
		const variable = m[1] ?? '';
		const body = m[2] ?? '';
		const elementType = (
			/element_type\s*:\s*['"]([a-z0-9]+)['"]/i.exec(body)?.[1] ?? 'div'
		).toLowerCase();
		if (elementType === 'input' || elementType === 'textarea' || elementType === 'select') {
			const type = /\btype\s*:\s*['"]([a-z-]+)['"]/i.exec(body)?.[1]?.toLowerCase() ?? null;
			const id = /\bid\s*:\s*['"]([\w-]+)['"]/.exec(body)?.[1] ?? null;
			const inlineName = /aria_label\s*:|['"]aria-label['"]\s*:/.test(body);
			const setLabel = new RegExp(
				`a11y\\.set_label\\(\\s*${variable}\\b|${variable}\\.setAttribute\\(\\s*['"]aria-label(?:ledby)?['"]`,
			).test(source);
			const labelFor = id !== null && new RegExp(`\\bfor\\s*:\\s*['"]${id}['"]`).test(source);
			const named = inlineName || setLabel || labelFor;
			controls.push({
				variable,
				elementType,
				type,
				id,
				hasPlaceholder: /\bplaceholder\s*:/.test(body),
				named,
				why: named
					? 'named in this file'
					: `<${elementType}${type ? ` type=${type}` : ''}> has no accessible name of its own`,
			});
		}
		m = factory.exec(source);
	}
	return controls;
}

async function loginAreaJs(): Promise<string[]> {
	// Same lister, narrowed to the login area by PATH — not by a walk root.
	return browserSources().filter((p) => p.startsWith(LOGIN_AREA) && p.endsWith('.js'));
}

/** The login area inside the shared browser corpus (a filter, not a walk root). */
const LOGIN_AREA = 'client/dedalo/core/login/';

describe('client_control_naming_tripwire', () => {
	test('NESTED groups: each control is named by its OWN group, executed through the chokepoint', async () => {
		const { label_group, name_controls } = await loadA11y();
		const { portal, portal_label, title, date } = await buildPortalRow();

		// the shipped order: each group is named while it is still EMPTY …
		label_group(title.wrapper, title.label);
		label_group(date.wrapper, date.label);
		label_group(portal, portal_label);
		// … the controls arrive afterwards …
		const title_input = title.addInput();
		const date_input = date.addInput();
		// … and the whole subtree is named in ONE pass from the OUTERMOST group,
		// which is what the one document observer does on the single commit append.
		const named = name_controls(portal);

		expect(named).toBe(2);
		expect(title_input.getAttribute('aria-labelledby')).toBe(title.label.id);
		expect(date_input.getAttribute('aria-labelledby')).toBe(date.label.id);
		expect(title_input.getAttribute('aria-labelledby')).not.toBe(portal_label.id);
		expect(title_input.getAttribute('aria-labelledby')).not.toBe(
			date_input.getAttribute('aria-labelledby'),
		);
		expect(portal_label.id).not.toBe(title.label.id);
	});

	test('the ROW BOX chain: the table label never names a column control', async () => {
		const { label_group, name_controls } = await loadA11y();
		const { portal, portal_label, title, date } = await buildPortalRow();
		label_group(title.wrapper, title.label);
		label_group(date.wrapper, date.label);
		label_group(portal, portal_label);
		const title_input = title.addInput();
		const date_input = date.addInput();
		name_controls(portal);

		// the chain is the shipped one: table > rowgroup > row > cell > group
		const list_body = portal.children.find((c) => c.getAttribute('class')?.includes('list_body'));
		expect(list_body?.getAttribute('role')).toBe('table');
		expect(list_body?.getAttribute('aria-labelledby')).toBe(portal_label.id);
		const cell = title.wrapper.parentElement;
		expect(cell?.getAttribute('role')).toBe('cell');
		expect(cell?.parentElement?.getAttribute('role')).toBe('row');
		expect(cell?.parentElement?.parentElement?.getAttribute('role')).toBe('rowgroup');
		expect(title.wrapper.getAttribute('role')).toBe('group');

		// each control hears its OWN column, never the table's (= the portal's) label
		expect(title_input.getAttribute('aria-labelledby')).toBe(title.label.id);
		expect(date_input.getAttribute('aria-labelledby')).toBe(date.label.id);
		expect(title_input.getAttribute('aria-labelledby')).not.toBe(portal_label.id);
	});

	test('NESTED groups: the control PRESENT at build time is named by its own group too', async () => {
		const { label_group } = await loadA11y();
		const { portal, portal_label, title, date } = await buildPortalRow();
		// the other order: the columns are filled BEFORE anything is named, which is
		// what a component whose data resolved first produces.
		const title_input = title.addInput();
		const date_input = date.addInput();

		label_group(title.wrapper, title.label);
		label_group(date.wrapper, date.label);
		label_group(portal, portal_label);

		expect(title_input.getAttribute('aria-labelledby')).toBe(title.label.id);
		expect(date_input.getAttribute('aria-labelledby')).toBe(date.label.id);
		expect(title_input.getAttribute('aria-labelledby')).not.toBe(portal_label.id);
	});

	test('a FLAT group still names its own controls, and a named control is left alone', async () => {
		const { label_group } = await loadA11y();
		const wrapper = new FakeElement('div');
		const label = wrapper.append(new FakeElement('div', { class: 'label' }));
		const content = wrapper.append(new FakeElement('div'));
		const plain = content.append(new FakeElement('input', { type: 'text' }));
		const own = content.append(new FakeElement('input', { type: 'text', 'aria-label': 'Its own' }));
		const hidden = content.append(new FakeElement('input', { type: 'hidden' }));

		label_group(wrapper, label);

		expect(wrapper.getAttribute('role')).toBe('group');
		expect(wrapper.getAttribute('aria-labelledby')).toBe(label.id);
		expect(plain.getAttribute('aria-labelledby')).toBe(label.id);
		expect(own.getAttribute('aria-labelledby')).toBe(null);
		expect(own.getAttribute('aria-label')).toBe('Its own');
		expect(hidden.getAttribute('aria-labelledby')).toBe(null);
	});

	test('the SHIPPED line view (no label node) names its own controls, executed through the chokepoint', async () => {
		const a11y = await loadA11y();
		const declare_group = a11y[suppressedLabelChokepoint()] as (w: unknown, t: string) => unknown;
		expect(typeof declare_group).toBe('function');

		// the shipped portal row: the PORTAL has a label node; its columns are line
		// views, which render none.
		const portal = new FakeElement('div');
		const portal_label = portal.append(
			new FakeElement('div', { class: 'label', id: 'portal_label' }),
		);
		const { cell } = await buildRowBox(portal, portal_label.id);

		const column = (labelText: string) => {
			const wrapper = cell().append(new FakeElement('div'));
			const content = wrapper.append(new FakeElement('div', { class: 'content_data' }));
			declare_group(wrapper, labelText); // ← what build_wrapper_edit does, label node absent
			return { wrapper, content };
		};
		const title = column('Title');
		const date = column('<b>Date</b>'); // ontology labels are HTML; a name is text
		a11y.label_group(portal, portal_label);

		// the controls arrive with the single commit append, as they really do
		const title_input = title.content.append(new FakeElement('input', { type: 'text' }));
		const date_input = date.content.append(new FakeElement('input', { type: 'text' }));
		a11y.name_controls(portal);

		expect(title_input.getAttribute('aria-label')).toBe('Title');
		expect(date_input.getAttribute('aria-label')).toBe('Date');
		expect(title_input.getAttribute('aria-labelledby')).toBe(null);
		expect(date_input.getAttribute('aria-labelledby')).toBe(null);
	});

	test('a line-view control with NO labelled ancestor is named all the same', async () => {
		const a11y = await loadA11y();
		const declare_group = a11y[suppressedLabelChokepoint()] as (w: unknown, t: string) => unknown;

		// a section_record line outside any portal: before the fix, name_controls
		// returned 0 here and the field announced as "edit text, blank".
		const wrapper = new FakeElement('div');
		const content = wrapper.append(new FakeElement('div', { class: 'content_data' }));
		const input = content.append(new FakeElement('input', { type: 'text' }));
		const hidden = content.append(new FakeElement('input', { type: 'hidden' }));

		declare_group(wrapper, 'Inventory number');

		expect(wrapper.getAttribute('role')).toBe('group');
		expect(input.getAttribute('aria-label')).toBe('Inventory number');
		expect(hidden.getAttribute('aria-label')).toBe(null);
	});

	test('every shipped line view goes through the naming chokepoint (TOTAL census, floored)', async () => {
		const files = await lineViewFiles();
		expect(files.length).toBeGreaterThan(MIN_LINE_VIEWS);

		const outside = files.filter(
			(file) =>
				!/ui\.component\.build_wrapper_edit\s*\(/.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
		);
		expect(
			outside.sort().join('\n'),
			'a line view that builds its own wrapper bypasses the ONE place a component group is named',
		).toBe('');

		// and the chokepoint they all reach really declares the group
		expect(suppressedLabelChokepoint()).not.toBe('');
	});

	test('the LOGIN screen names every text-entry control it creates (TOTAL census, floored)', async () => {
		const files = await loginAreaJs();
		expect(files.length).toBeGreaterThan(0);

		const controls: Array<{ file: string; control: Control }> = [];
		for (const file of files) {
			for (const control of scanControls(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
				controls.push({ file, control });
			}
		}
		expect(controls.length).toBeGreaterThan(MIN_LOGIN_CONTROLS);

		const unnamed = controls
			.filter(({ control }) => !control.named)
			.filter(({ control }) => control.type === null || !SELF_NAMING_TYPES.has(control.type))
			.map(
				({ file, control }) =>
					`${file}: ${control.variable} — ${control.why}` +
					(control.hasPlaceholder
						? ' (a placeholder is NOT a name: it disappears on the first keystroke)'
						: ''),
			);
		expect(unnamed.sort().join('\n')).toBe('');
	});

	test('a planted placeholder-only control IS caught, and naming it clears it', () => {
		const planted = `
			const user_input = ui.create_dom_element({
				id				: 'username',
				element_type	: 'input',
				type			: 'text',
				placeholder		: 'User name',
				parent			: step
			})
			const auth_input = ui.create_dom_element({
				id				: 'auth',
				element_type	: 'input',
				type			: 'password',
				placeholder		: 'Password',
				parent			: step
			})
			a11y.set_label(auth_input, 'Password')
			const submit_input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'submit',
				parent			: step
			})
		`;
		const byVar = new Map(scanControls(planted).map((c) => [c.variable, c]));
		expect(byVar.get('user_input')?.named).toBe(false);
		expect(byVar.get('user_input')?.hasPlaceholder).toBe(true);
		expect(byVar.get('auth_input')?.named).toBe(true);
		expect(byVar.get('submit_input')?.named).toBe(false);
		expect(SELF_NAMING_TYPES.has(byVar.get('submit_input')?.type ?? '')).toBe(true);
	});
});
