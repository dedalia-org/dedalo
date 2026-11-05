/**
 * UNSAVED-WORK GUARD CONTRACT — client/dedalo/core/common/js/events.js
 *
 * WHY THIS FILE EXISTS. `window.unsaved_data` is the one flag standing between
 * a half-typed record and a closed tab: `check_unsaved_data` gates BOTH the
 * auto-save sweep and the confirm() dialog on it, and page.js gates the
 * beforeunload prompt on it. It used to be a plain page-wide boolean that ANY
 * component could assign — and `set_changed_data` assigned it `false` on the
 * branch where the component's OWN value matched its db_data snapshot. So a
 * component reverting its own edit disarmed the guard for every OTHER dirty
 * component on the page: type in a debounced component_text_area, then type and
 * delete one character in a second field, then navigate away, and the text_area
 * edit was dropped with no save, no prompt and no log line.
 *
 * The flag is now DERIVED. Instances register while they hold a genuine unsaved
 * change and may only ever retire THEMSELVES.
 *
 * WHAT IS PINNED (contract, not implementation):
 *  A. The flag is false at rest and true while any instance is registered.
 *  B. AN INSTANCE MAY ONLY RETIRE ITSELF. Deregistering A while B is still
 *     registered leaves the guard armed. This is the defect above.
 *  C. `set_before_unload(false)` CANNOT disarm a registered instance. It clears
 *     only the coarse instance-less assertion — this is the exact call
 *     `set_changed_data`'s revert branch and `save()` make, and the whole reason
 *     the bug existed.
 *  D. `set_before_unload(true)` still arms the guard with no instance at all,
 *     for the two keystroke guards that have no component to register
 *     (view_default_edit_filter_records, view_default_edit_security_access).
 *  E. `reset_unsaved_data()` clears registry AND assertion together — the
 *     deliberate page-wide reset, reachable only from check_unsaved_data's ONE
 *     resolution ("the user accepted the loss"; the auto-save sweep no longer
 *     resets — what it could not flush must reach the prompt, see
 *     client test_unsaved_guard CHECK_UNSAVED_DATA).
 *  F. Registration is idempotent and deregistering an unknown instance is a
 *     no-op, so a double save or a destroy-after-save cannot corrupt the count.
 *
 *  G. CALL-SITE SHAPE (source scan). The registry only helps if the component
 *     layer actually uses it, so `set_changed_data`'s revert branch must call
 *     `deregister_unsaved_instance` and must NOT call `set_before_unload(false)`,
 *     and no client file outside events.js may assign `window.unsaved_data`
 *     directly — a direct write is silently overwritten by the next recompute,
 *     which is how tool_indexation's guard broke when the flag became derived.
 *
 * HARNESS. `events.js` is imported REAL; it needs only `window` and SHOW_DEBUG.
 * The "instances" are bare objects — the registry keys on identity and reads no
 * property of them, which is itself part of the contract. No DB, no server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_ROOT = join(import.meta.dir, '..', '..', 'client', 'dedalo');
const CLIENT_COMMON = join(CLIENT_ROOT, 'core', 'common', 'js');
const EVENTS_PATH = join(CLIENT_COMMON, 'events.js');
const COMPONENT_COMMON_PATH = join(
	CLIENT_ROOT,
	'core',
	'component_common',
	'js',
	'component_common.js',
);

type EventsModule = {
	set_before_unload: (value: boolean) => boolean | undefined;
	register_unsaved_instance: (instance: object) => boolean;
	deregister_unsaved_instance: (instance: object) => boolean;
	register_uncommitted_input: (node: object) => boolean;
	deregister_uncommitted_input: (node: object) => boolean;
	reset_unsaved_data: () => boolean;
};

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let events: EventsModule;

const unsaved = () =>
	(globalThis as unknown as { window: { unsaved_data: boolean } }).window.unsaved_data;

beforeAll(async () => {
	for (const key of ['window', 'SHOW_DEBUG']) saved[key] = globals[key];
	globals.window = globalThis;
	globals.SHOW_DEBUG = false;
	events = (await import(EVENTS_PATH)) as unknown as EventsModule;
});

afterAll(() => {
	for (const key of ['window', 'SHOW_DEBUG']) globals[key] = saved[key];
});

beforeEach(() => {
	events.reset_unsaved_data();
});

describe('derived unsaved-data flag', () => {
	test('A. false at rest, true while an instance is registered', () => {
		expect(unsaved()).toBe(false);

		const component = {};
		events.register_unsaved_instance(component);
		expect(unsaved()).toBe(true);

		events.deregister_unsaved_instance(component);
		expect(unsaved()).toBe(false);
	});

	test('B. an instance may only retire itself — a revert cannot disarm another component', () => {
		const text_area = {}; // debounced edit, still unsaved
		const other_field = {}; // the user types one character…

		events.register_unsaved_instance(text_area);
		events.register_unsaved_instance(other_field);
		expect(unsaved()).toBe(true);

		// …and deletes it again: this field is back at its stored value
		events.deregister_unsaved_instance(other_field);

		expect(unsaved(), 'reverting one field disarmed the guard for a still-dirty component').toBe(
			true,
		);
	});

	test('C. set_before_unload(false) cannot disarm a registered instance', () => {
		const component = {};
		events.register_unsaved_instance(component);

		events.set_before_unload(false);

		expect(
			unsaved(),
			'the coarse retraction cleared a component registration it does not own',
		).toBe(true);
	});

	test('D. set_before_unload(true) still arms the guard with no instance at all', () => {
		expect(unsaved()).toBe(false);

		events.set_before_unload(true);
		expect(unsaved()).toBe(true);

		events.set_before_unload(false);
		expect(unsaved()).toBe(false);
	});

	test('E. reset_unsaved_data clears registry and assertion together', () => {
		events.register_unsaved_instance({});
		events.register_unsaved_instance({});
		events.set_before_unload(true);
		expect(unsaved()).toBe(true);

		events.reset_unsaved_data();

		expect(unsaved()).toBe(false);
	});

	test('F. registration is idempotent and an unknown deregister is a no-op', () => {
		const component = {};
		events.register_unsaved_instance(component);
		events.register_unsaved_instance(component);

		// one register + one deregister must balance, however many times it registered
		events.deregister_unsaved_instance(component);
		expect(unsaved()).toBe(false);

		// deregistering something that never registered must not throw or flip the flag
		expect(() => events.deregister_unsaved_instance({})).not.toThrow();
		expect(unsaved()).toBe(false);
	});
});

describe('H. uncommitted typing (blur-committed views)', () => {
	/**
	 * WHY. component_text_area debounces on keystrokes and registers ITSELF, so
	 * it was protected. Every view built on the native 'change' event —
	 * component_input_text (oh14), component_date (oh57), select, … — commits
	 * only on blur, and a reload/tab-close never blurs the focused field. The
	 * component therefore never registered, the derived flag stayed false, and
	 * the typed text was dropped with no prompt: the reported data loss.
	 */

	test('H1. a field being typed into arms the guard before its component knows', () => {
		expect(unsaved()).toBe(false);

		const input = {}; // a DOM node — the registry keys on identity only
		events.register_uncommitted_input(input);
		expect(unsaved(), 'typing into a blur-committed field left the guard disarmed').toBe(true);

		events.deregister_uncommitted_input(input);
		expect(unsaved()).toBe(false);
	});

	test('H2. one field committing cannot disarm another field still being typed into', () => {
		const field_a = {};
		const field_b = {};
		events.register_uncommitted_input(field_a);
		events.register_uncommitted_input(field_b);

		events.deregister_uncommitted_input(field_b);

		expect(unsaved(), 'committing one field disarmed the guard for another dirty field').toBe(true);
	});

	test('H3. set_before_unload(false) cannot disarm uncommitted typing', () => {
		events.register_uncommitted_input({});

		events.set_before_unload(false);

		expect(unsaved(), 'a save elsewhere cleared typing it does not own').toBe(true);
	});

	test('H4. reset_unsaved_data clears the typing registry too', () => {
		events.register_uncommitted_input({});
		events.reset_unsaved_data();
		expect(unsaved()).toBe(false);
	});
});

describe('G. call-site shape', () => {
	const strip_comments = (src: string) =>
		src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

	test('set_changed_data retires its own registration, never the page-wide flag', () => {
		const src = strip_comments(readFileSync(COMPONENT_COMMON_PATH, 'utf8'));
		const body = src.slice(src.indexOf('component_common.prototype.set_changed_data'));
		const fn = body.slice(0, body.indexOf('}//end set_changed_data'));

		expect(fn, 'set_changed_data no longer deregisters itself on the revert branch').toContain(
			'deregister_unsaved_instance(self)',
		);
		expect(fn, 'set_changed_data registers the instance when the value is genuinely new').toContain(
			'register_unsaved_instance(self)',
		);
		expect(
			fn.includes('set_before_unload(false)'),
			'set_changed_data clears the page-wide flag again — this IS the data-loss defect',
		).toBe(false);
	});

	test('events_init arms the guard from the live input event, in capture phase', () => {
		const src = strip_comments(readFileSync(EVENTS_PATH, 'utf8'));
		const body = src.slice(src.indexOf('export const events_init'));
		const fn = body.slice(0, body.indexOf('}//end events_init'));

		// capture phase: the component's own 'change' handler must run AFTER the
		// document-level commit handler, so its verdict wins.
		expect(
			fn,
			"no document-level 'input' listener — blur-committed views stay unprotected",
		).toMatch(/addEventListener\(\s*'input'[\s\S]*capture:\s*true/);
		expect(fn).toMatch(/addEventListener\(\s*'change'[\s\S]*capture:\s*true/);
		expect(fn, "'focusout' is what covers type-then-revert, where 'change' never fires").toContain(
			"'focusout'",
		);
		expect(fn).toContain('register_uncommitted_input');
		expect(fn).toContain('deregister_uncommitted_input');
		// the portal lookup box sits inside the EDIT wrapper; typing a query must not arm the guard
		expect(fn, 'autocomplete search typing would raise a false "Discard unsaved changes?"').toContain(
			"closest('.wrapper_service_autocomplete')",
		);
	});

	test('the beforeunload handler blurs the active element before reading the flag', () => {
		const src = strip_comments(
			readFileSync(join(CLIENT_ROOT, 'core', 'page', 'js', 'page.js'), 'utf8'),
		);
		const body = src.slice(src.indexOf('self.beforeunload_handler = function'));
		const fn = body.slice(0, body.indexOf("window.addEventListener('beforeunload'"));

		const blur_at = fn.indexOf('.blur()');
		const read_at = fn.indexOf('const unsaved_data');
		expect(blur_at, 'beforeunload no longer forces the focused field to commit').toBeGreaterThan(
			-1,
		);
		expect(blur_at, 'the blur must happen BEFORE window.unsaved_data is read').toBeLessThan(
			read_at,
		);
	});

	test('no client file outside events.js assigns window.unsaved_data directly', () => {
		const offenders: string[] = [];
		for (const root of [CLIENT_ROOT, join(import.meta.dir, '..', '..', 'tools')]) {
			const glob = new Bun.Glob('**/*.js');
			for (const rel of glob.scanSync({ cwd: root })) {
				const path = join(root, rel);
				if (path === EVENTS_PATH) continue;
				const src = strip_comments(readFileSync(path, 'utf8'));
				// an assignment, not a comparison (=== / !== / ==)
				if (/window\.unsaved_data\s*=[^=]/.test(src)) offenders.push(join(root, rel));
			}
		}
		expect(
			offenders,
			'a direct write is silently overwritten by the next recompute — call set_before_unload instead',
		).toEqual([]);
	});
});
