/**
 * CLIENT KEYBOARD-ACTIVATION tripwire (DEC-12; audit 2026-08-26 row P1-18,
 * findings CLI-10 / CLI-11 / CLI-22).
 *
 * WHAT WAS WRONG. The cataloguing surface was built out of bare `div`/`span`
 * nodes carrying one POINTER listener. A grep over the whole thesaurus client —
 * the widget that IS the controlled vocabulary — returned exactly one `keydown`
 * handler, and its only job was `stopPropagation`. Two facts compounded:
 *   1. no role, no tabindex: Tab never lands on the node at all;
 *   2. the listeners are on **mousedown**, and keyboard activation dispatches
 *      **click** — so even a retrofitted `tabindex` would not have made Enter
 *      work. A native `<button>` whose only listener is `mousedown` is
 *      keyboard-dead for exactly the same reason.
 *
 * WHAT THIS ASSERTS, over a TOTAL census of the tracked browser JS (client/ +
 * tools/, vendored `lib/` trees excluded by name):
 *   - every element the file itself CREATES and then wires to a pointer event is
 *     either natively activable and listening for `click`, or goes through the
 *     ONE shared helper `a11y.make_activable` — which attaches the pointer
 *     listener AND the Enter/Space listener to the same callback;
 *   - `mousedown`-only activation is an offender even on a real `<button>`;
 *   - every file that still has unconverted sites is ENUMERATED in
 *     `engineering/client_a11y_backlog.json` with a per-file count and a reason,
 *     and those counts may only FALL (a file that improves and is not re-banked
 *     is red, so the backlog cannot outlive the debt it records).
 *
 * WHAT IT CANNOT SEE, stated rather than hidden: a listener attached to a node
 * this file did not create (a parameter, a cached pointer, a DOM query) has no
 * resolvable element type here. Those sites are COUNTED and floored, never
 * judged — the browser-side gate (`test_a11y_keyboard`, driven through the
 * headless-Chrome tier) is what proves the real surfaces respond to a real key.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSources } from '../helpers/browser_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const BACKLOG_PATH = 'engineering/client_a11y_backlog.json';

/** Floors: the census must stay a census. */
const MIN_FILES_SCANNED = 500;
const MIN_POINTER_SITES = 400;

/** Vendored third-party browser code is not ours to rewire. */
const VENDOR_SEGMENTS = ['/lib/', '/vendor/'];

/** Elements the browser already makes keyboard-activable. */
const NATIVE_ACTIVABLE = new Set(['button', 'input', 'select', 'textarea', 'a', 'summary']);

interface PointerSite {
	file: string;
	line: number;
	variable: string;
	event: 'click' | 'mousedown';
	/** The element type the file gives this variable, when it creates it here. */
	elementType: string | null;
	offender: boolean;
	why: string;
}

/**
 * Element types the file assigns to its own variables:
 *   const x = ui.create_dom_element({ element_type : 'div', … })
 *   const x = document.createElement('span')
 * A variable created more than once with different types resolves to null
 * (unknown) rather than guessing.
 */
function elementTypes(source: string): Map<string, string | null> {
	const types = new Map<string, string | null>();
	const set = (name: string, type: string) => {
		if (types.has(name) && types.get(name) !== type) types.set(name, null);
		else types.set(name, type);
	};
	const factory =
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ui\.create_dom_element\(\s*\{([\s\S]{0,900}?)\}\s*\)/g;
	let m: RegExpExecArray | null = factory.exec(source);
	while (m !== null) {
		const body = m[2] ?? '';
		const typeMatch = /element_type\s*:\s*['"]([a-z0-9]+)['"]/i.exec(body);
		set(m[1] ?? '', typeMatch ? (typeMatch[1] ?? 'div').toLowerCase() : 'div');
		m = factory.exec(source);
	}
	const created =
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(\s*['"]([a-z0-9-]+)['"]/gi;
	m = created.exec(source);
	while (m !== null) {
		set(m[1] ?? '', (m[2] ?? '').toLowerCase());
		m = created.exec(source);
	}
	const built = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ui\.build_button\(/g;
	m = built.exec(source);
	while (m !== null) {
		set(m[1] ?? '', 'button');
		m = built.exec(source);
	}
	return types;
}

/** Variables handed to the shared helper in this file. */
function activableVariables(source: string): Set<string> {
	const names = new Set<string>();
	const re = /a11y\.make_activable\(\s*([A-Za-z_$][\w$]*)/g;
	let m: RegExpExecArray | null = re.exec(source);
	while (m !== null) {
		names.add(m[1] ?? '');
		m = re.exec(source);
	}
	return names;
}

/** Every pointer-activation site in one file, judged. Pure — the positive control drives it. */
function scanSource(file: string, source: string): PointerSite[] {
	const types = elementTypes(source);
	const activable = activableVariables(source);
	const clickListeners = new Set<string>();
	const listener = /([A-Za-z_$][\w$]*)\s*\.addEventListener\(\s*['"](click|mousedown)['"]/g;
	let m: RegExpExecArray | null = listener.exec(source);
	const raw: Array<{ variable: string; event: 'click' | 'mousedown'; index: number }> = [];
	while (m !== null) {
		const variable = m[1] ?? '';
		const event = (m[2] ?? 'click') as 'click' | 'mousedown';
		if (event === 'click') clickListeners.add(variable);
		raw.push({ variable, event, index: m.index });
		m = listener.exec(source);
	}
	const sites: PointerSite[] = [];
	for (const entry of raw) {
		const elementType = types.has(entry.variable)
			? (types.get(entry.variable) as string | null)
			: null;
		const line = source.slice(0, entry.index).split('\n').length;
		let offender = false;
		let why = '';
		if (activable.has(entry.variable)) {
			why = 'wired through a11y.make_activable';
		} else if (elementType === null) {
			why = 'element type not resolvable in this file (not judged)';
		} else if (entry.event === 'mousedown' && !clickListeners.has(entry.variable)) {
			offender = true;
			why = `mousedown-only activation on <${elementType}>: keyboard activation dispatches click, never mousedown`;
		} else if (!NATIVE_ACTIVABLE.has(elementType)) {
			offender = true;
			why = `pointer activation on a non-native <${elementType}> with no role, tab stop or activation key`;
		} else {
			why = `native <${elementType}> activated by click`;
		}
		sites.push({
			file,
			line,
			variable: entry.variable,
			event: entry.event,
			elementType,
			offender,
			why,
		});
	}
	return sites;
}

interface Backlog {
	rule: string;
	files: Record<string, { pointer_only_sites: number; reason: string }>;
}

function loadBacklog(): Backlog {
	return JSON.parse(readFileSync(join(REPO_ROOT, BACKLOG_PATH), 'utf8')) as Backlog;
}

async function trackedBrowserJs(): Promise<string[]> {
	// The corpus is the shared browser lister (census_derivation_tripwire: a gate
	// imports a lister that owns its roots rather than naming one in-file). It is
	// git's view of client/ + tools/, vendored libraries already excluded; the
	// VENDOR_SEGMENTS filter stays as this gate's own, slightly wider, exclusion.
	return browserSources().filter((p) => !VENDOR_SEGMENTS.some((seg) => p.includes(seg)));
}

describe('client_keyboard_activation_tripwire', () => {
	test('the census is TOTAL over the tracked browser JS', async () => {
		const files = await trackedBrowserJs();
		expect(files.length).toBeGreaterThan(MIN_FILES_SCANNED);
		let sites = 0;
		for (const file of files) {
			sites += scanSource(file, readFileSync(join(REPO_ROOT, file), 'utf8')).length;
		}
		expect(sites).toBeGreaterThan(MIN_POINTER_SITES);
	});

	test('every pointer-activated element is keyboard-activable, or enumerated in the backlog', async () => {
		const files = await trackedBrowserJs();
		const backlog = loadBacklog();
		const observed = new Map<string, PointerSite[]>();
		for (const file of files) {
			const offenders = scanSource(file, readFileSync(join(REPO_ROOT, file), 'utf8')).filter(
				(s) => s.offender,
			);
			if (offenders.length > 0) observed.set(file, offenders);
		}

		const errors: string[] = [];
		for (const [file, offenders] of observed) {
			const banked = backlog.files[file];
			if (banked === undefined) {
				errors.push(
					`${file}: ${offenders.length} pointer-only activation site(s), none banked. Route them through a11y.make_activable (client/dedalo/core/common/js/a11y.js) — first: line ${offenders[0]?.line} (${offenders[0]?.why}).`,
				);
			} else if (offenders.length > banked.pointer_only_sites) {
				errors.push(
					`${file}: ${offenders.length} pointer-only activation site(s), banked ${banked.pointer_only_sites}. The backlog is SHRINK-ONLY.`,
				);
			}
		}
		expect(errors.sort().join('\n')).toBe('');
	});

	test('the backlog only records debt that is still there (shrink-only, no stale rows)', async () => {
		const files = await trackedBrowserJs();
		const backlog = loadBacklog();
		const counts = new Map<string, number>();
		for (const file of files) {
			counts.set(
				file,
				scanSource(file, readFileSync(join(REPO_ROOT, file), 'utf8')).filter((s) => s.offender)
					.length,
			);
		}
		const stale: string[] = [];
		for (const [file, entry] of Object.entries(backlog.files)) {
			const actual = counts.get(file);
			if (actual === undefined) {
				stale.push(`${file}: banked but no longer scanned (deleted or renamed) — drop the row`);
			} else if (actual < entry.pointer_only_sites) {
				stale.push(
					`${file}: banked ${entry.pointer_only_sites}, now ${actual} — the debt shrank; lower the number in ${BACKLOG_PATH}`,
				);
			}
			if (!entry.reason || entry.reason.trim().length < 10) {
				stale.push(`${file}: backlog rows need a reason`);
			}
		}
		expect(stale.sort().join('\n')).toBe('');
	});

	test('a planted offender IS caught, and the helper DOES clear it', () => {
		const planted = `
			const bare_toggle = ui.create_dom_element({ element_type : 'div', class_name : 'x' })
			bare_toggle.addEventListener('mousedown', handler)
			const real_button = ui.create_dom_element({ element_type : 'button' })
			real_button.addEventListener('click', handler)
			const fixed_toggle = ui.create_dom_element({ element_type : 'span' })
			a11y.make_activable(fixed_toggle, { on_activate : handler })
			fixed_toggle.addEventListener('mousedown', handler)
		`;
		const sites = scanSource('planted.js', planted);
		const byVar = new Map(sites.map((s) => [s.variable, s]));
		expect(byVar.get('bare_toggle')?.offender).toBe(true);
		expect(byVar.get('real_button')?.offender).toBe(false);
		expect(byVar.get('fixed_toggle')?.offender).toBe(false);
	});

	test('a mousedown-only NATIVE button is an offender too (the subtle half)', () => {
		const planted = `
			const search_button = ui.create_dom_element({ element_type : 'button' })
			search_button.addEventListener('mousedown', handler)
		`;
		const site = scanSource('planted.js', planted)[0] as PointerSite;
		expect(site.offender).toBe(true);
		expect(site.why).toContain('mousedown-only');
	});

	test('the shared helper RUNS: the same callback is reached by the pointer AND by the key', async () => {
		// Executed, not grepped. The helper is dependency-free on purpose, so it
		// loads outside a browser and its BEHAVIOUR — not the spelling of a
		// listener — is what this asserts.
		const { make_activable } = await import('../../client/dedalo/core/common/js/a11y.js');
		const listeners = new Map<string, Array<(e: unknown) => void>>();
		const attributes = new Map<string, string>();
		const element = {
			tagName: 'DIV',
			getAttribute: (name: string) => attributes.get(name) ?? null,
			setAttribute: (name: string, value: string) => attributes.set(name, value),
			hasAttribute: (name: string) => attributes.has(name),
			addEventListener: (type: string, fn: (e: unknown) => void) => {
				listeners.set(type, [...(listeners.get(type) ?? []), fn]);
			},
		};
		let activations = 0;
		make_activable(element as unknown as HTMLElement, {
			on_activate: () => activations++,
			label: 'Children',
			pointer_event: 'mousedown',
		});

		expect(attributes.get('role')).toBe('button');
		expect(attributes.get('tabindex')).toBe('0');
		expect(attributes.get('aria-label')).toBe('Children');

		const fire = (type: string, event: Record<string, unknown>) => {
			for (const fn of listeners.get(type) ?? []) fn(event);
		};
		fire('mousedown', {});
		expect(activations).toBe(1);
		// the whole point: keyboard activation dispatches click, never mousedown —
		// so the KEY must reach the same callback through this helper.
		fire('keydown', { key: 'Enter', target: element, preventDefault: () => {} });
		expect(activations).toBe(2);
		fire('keydown', { key: 'a', target: element, preventDefault: () => {} });
		expect(activations).toBe(2);
	});
});
