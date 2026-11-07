/**
 * The update_ontology TLD input belongs to the OPERATOR (DEC-12 gate).
 *
 * WHAT WENT WRONG WITHOUT THIS GATE (real, 2026-08-22): selecting a master
 * server ran a handler that did `tlds_input.value = …`, so every click on the
 * server picker silently threw away the list the operator had just typed — and
 * because no configured master publishes a `tld` field, the "new" value it wrote
 * was always the installation default. Editing the list first and picking the
 * server second was unusable.
 *
 * The rule now: the input is written in exactly four places — the initial
 * prefill, the operator's own typing, an EXPLICIT tick in the TLD catalog, and
 * the catalog's "Default selection" / "Clear" buttons. A server selection only
 * lists what that master offers (build_tld_catalog set_server).
 *
 * ASSERTIONS:
 *   1. the `ontology_server_select_change` subscriber does not assign the input;
 *   2. the value survives a reload — it is read from and written to
 *      localStorage under the documented key (the pre-2026-11-07 line is read
 *      once with matrix_dd appended: it was implicit then);
 *   3. the master's own list is never applied wholesale: the catalog offers no
 *      "select every offered TLD" (a manifest is 200+ TLDs, every language pack
 *      included) — its only bulk writers are the configured default and clear;
 *   4. the rows' ticked state is DERIVED from the input, and the input's own
 *      keystrokes repaint it — a row that says "selected" while the line says
 *      otherwise is a worse lie than no highlight at all.
 *
 * Honest limit: this reads the source, so it proves the shape of the wiring, not
 * that the rendered widget behaves (no DOM here — the behaviour was verified in
 * the browser when it landed). It fires on the regression it was written for:
 * re-introducing an input assignment in the selection handler.
 *
 * DB-less, network-less → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const RENDER = join(
	REPO_ROOT,
	'client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js',
);
const src = readFileSync(RENDER, 'utf8');

/** The body of the function subscribed to `ontology_server_select_change`. */
function selection_handler_body(): string {
	const start = src.indexOf('const render_handler');
	expect(start, 'the server-selection handler must still be named render_handler').toBeGreaterThan(
		-1,
	);
	const end = src.indexOf('event_manager.subscribe(', start);
	expect(end, 'render_handler must still be the subscribed handler').toBeGreaterThan(start);
	return src.slice(start, end);
}

describe('update_ontology admin notes', () => {
	test('the admin note is COLLAPSED on load, in every configuration state', () => {
		// The panel's first screen is the update itself; the summary pill already
		// reports state ("None configured"), so the note may not open itself — the
		// empty-picker case used to. (The serving note left for serve_ontology,
		// 2026-09-28.) The slice must be non-empty: build_tld_catalog is declared
		// BEFORE build_client_info, so bounding by it yields '' and the gate goes
		// vacuous — bounded by the next function below instead.
		const start = src.indexOf('const build_client_info');
		const end = src.indexOf('const get_content_data_edit', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const notes = src.slice(start, end);
		expect(notes).toContain("element_type	: 'details'");
		expect(/setAttribute\('open'/.test(notes), 'the admin note may not open itself on render').toBe(
			false,
		);

		// …and a closed <details> whose body carries an explicit `display` is not
		// hidden by UA styles alone in every engine: the CSS states the closed case.
		const css = readFileSync(
			join(
				REPO_ROOT,
				'client/dedalo/core/area_maintenance/widgets/update_ontology/css/update_ontology.less',
			),
			'utf8',
		);
		expect(css).toMatch(/&:not\(\[open\]\) \.serving_body \{\n\t\t\tdisplay: none;/);
	});
});

describe('update_ontology master-server selection', () => {
	test('the chosen master survives a reload, and each picker owns its radio group', () => {
		// Remembered by URL — names are free text and may repeat.
		expect(src).toMatch(/getItem\(storage_key\)/);
		expect(src).toMatch(/store_server\(storage_key, current_server\.url\)/);
		// Restored only when the server is still REACHABLE and still configured.
		expect(src).toMatch(
			/if \(reachable && stored_url!==null && current_server\.url===stored_url\)/,
		);

		// The picker is built before the form subscribes, so the restored choice is
		// announced afterwards — otherwise the TLD catalog would still say
		// "pick a server" next to a checked radio.
		expect(src).toContain('publish_active_server(servers, on_server_change)');

		// A radio group is document-wide by name and this panel renders twice (Map
		// + List): a shared name made the second picker's restore uncheck the first.
		expect(src).toMatch(/const group_name = 'ontology_server_' \+ \(\+\+picker_seq\)/);
		expect(
			/name\s*:\s*'ontology_server'/.test(src),
			'the radio group name must be per-picker, never the shared literal',
		).toBe(false);

		// update_code reuses this picker over a different server list: its own key.
		const update_code = readFileSync(
			join(
				REPO_ROOT,
				'client/dedalo/core/area_maintenance/widgets/update_code/js/render_update_code.js',
			),
			'utf8',
		);
		expect(update_code).toContain("'dedalo.update_code.server'");
	});
});

describe('update_ontology TLD input ownership', () => {
	test('selecting a master does NOT write the TLD input', () => {
		const body = selection_handler_body();

		expect(
			/tlds_input\s*\.\s*value\s*=/.test(body),
			'the ontology_server_select_change handler must not assign tlds_input.value — ' +
				"a server selection lists that master's ontologies, it never discards the " +
				"operator's list",
		).toBe(false);
	});

	test('the operator line survives a reload (localStorage, one documented key)', () => {
		expect(src).toContain("const TLDS_STORAGE_KEY			= 'dedalo.update_ontology.selection'");
		expect(src).toContain("const TLDS_STORAGE_KEY_BEFORE	= 'dedalo.update_ontology.tlds'");
		// the older line never named the shared value lists (they were implicit)
		expect(src).toContain("before + ',matrix_dd'");
		// read on render, written on every edit
		expect(src).toMatch(/getItem\(TLDS_STORAGE_KEY\)/);
		expect(src).toMatch(/setItem\(TLDS_STORAGE_KEY,/);
		expect(src).toMatch(/addEventListener\('input',/);
		// both sides guarded: a private-mode browser throws on access and the
		// panel must still render
		expect(src.match(/catch \(_error\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	test('the catalog rows reflect the input line, typing included', () => {
		// ONE painter, reading the input — not a second copy of the state.
		expect(src).toMatch(/const sync = function \(\) \{/);
		expect(src).toMatch(/const current\t= new Set\(current_list\(\)\)/);
		expect(src).toMatch(/entry\.input\.checked = on/);
		// every writer goes through write (set + repaint), and hand typing repaints too
		expect(src).toMatch(
			/const write = \(list_value\) => \{\n\t\tset_value\(list_value\.join\(','\)\)\n\t\tsync\(\)/,
		);
		const input_listener = src.slice(
			src.indexOf("tlds_input.addEventListener('input'"),
			src.indexOf("// the picked master's ontologies ABOVE the input"),
		);
		expect(
			input_listener.includes('sync_catalog()'),
			'typing in the TLD input must repaint the catalog — otherwise a row keeps ' +
				'claiming a TLD is in a line the operator has just emptied',
		).toBe(true);
	});

	test('the master manifest is never applied wholesale', () => {
		const start = src.indexOf('const build_tld_catalog');
		const catalog = src.slice(start, src.indexOf('}//end build_tld_catalog', start));
		expect(start).toBeGreaterThan(-1);
		// the bulk writers are exactly the configured default and clear
		expect(catalog.match(/write\((?!current\))[^)]*\)/g)).toEqual(['write(defaults)', 'write([])']);
		expect(catalog).toContain("const defaults	= [...new Set([...tracked, 'matrix_dd'])]");
	});
});

describe('update_ontology server picker: no cross-widget event bleed', () => {
	test('the shared picker publishes NOTHING itself; only its caller does, via on_change', () => {
		// The regression (2026-08-23): render_servers_list published
		// ontology_server_select_change on EVERY radio change, and update_code
		// reuses the picker on the same dashboard — picking a CODE server reset
		// the ontology widget's reference row while its radio stayed checked.
		const picker = src.slice(
			src.indexOf('export const render_servers_list'),
			src.indexOf('}//end render_servers_list'),
		);
		expect(
			picker.includes('event_manager.publish('),
			'render_servers_list must not publish any event — selection travels ' +
				"through the caller's on_change callback only",
		).toBe(false);
		expect(picker).toContain('on_change');
		expect(picker).toMatch(
			/if \(typeof on_change==='function'\) \{\n\t\t\t\t\ton_change\(current_server\)/,
		);

		// publish_active_server goes through the same callback, never bare
		const announcer = src.slice(
			src.indexOf('const publish_active_server'),
			src.indexOf('}//end publish_active_server'),
		);
		expect(announcer.includes('event_manager.publish(')).toBe(false);
		expect(announcer).toContain('on_change(active)');

		// …and update_ontology's OWN caller still publishes, exactly once,
		// from its callback with the tld payload it always carried
		expect(
			src.match(/event_manager\.publish\('ontology_server_select_change'/g)?.length,
			"exactly ONE publish site: the ontology caller's on_change callback",
		).toBe(1);
		expect(src).toContain(
			"event_manager.publish('ontology_server_select_change', server ? (server.tld || null) : null)",
		);
		expect(src).toContain(
			"render_servers_list(value, 'ONTOLOGY_SERVERS', 'dedalo.update_ontology.server', on_server_change)",
		);
		expect(src).toContain('publish_active_server(servers, on_server_change)');
	});
});

describe('update_ontology failures render IN the panel', () => {
	// Real, 2026-09-30: a refused import (`maintenance.action_failed`, origin
	// mismatch) showed NOTHING — handle_api_error routed it to a toast, and the
	// toast lands in the inspector bubble container this area does not show. The
	// page-wide 'api_error' channel still runs the policy (relogin, error report);
	// the panel owns the visible failure.
	const fn_start = src.indexOf('export const build_failure');
	const fn_body = src.slice(fn_start, src.indexOf('}//end build_failure', fn_start));

	test('both phases append build_failure to body_response; no widget-level toast', () => {
		expect(fn_start).toBeGreaterThan(-1);
		expect(src).toContain(
			'body_response.appendChild(build_failure(server_ontology_api_response.error))',
		);
		expect(src).toContain('body_response.appendChild(build_failure(api_response.error))');
		expect(/handle_api_error\s*\(/.test(src), 'a toast is invisible in this area').toBe(false);
	});

	test('the server message and request_id ride with the label — as text nodes', () => {
		// the label ('The maintenance action failed') alone hides the cause
		expect(fn_body).toContain('error_text(api_error)');
		expect(fn_body).toContain('api_error?.message');
		expect(fn_body).toContain('api_error?.request_id');
		expect(fn_body).toContain('document.createTextNode(line)');
		expect(/inner_html|innerHTML/.test(fn_body), 'server text never reaches an HTML sink').toBe(
			false,
		);
	});
});

describe('update_ontology results are scrolled into view', () => {
	// The response surface sits below the TLD reference block and the submit
	// button: a result or a failure landed under the fold and the panel looked
	// idle unless the operator scrolled. The mechanism is the shared ui.reveal
	// (pinned in client_ui_reveal.test.ts); no local copy.
	test('every ending reveals its node', () => {
		expect(src).not.toContain('scrollIntoView');
		// Phase 1 + Phase 2 failures (envelope and non-envelope), the version
		// change shown while Phase 2 runs, and the success status line
		expect(src).toContain(
			'ui.reveal(body_response.appendChild(build_failure(server_ontology_api_response.error)))',
		);
		expect(src).toContain(
			'ui.reveal(body_response.appendChild(build_failure(api_response.error)))',
		);
		expect(src).toContain(
			'ui.reveal(body_response.appendChild(build_version_change(current_ontology, result.info)))',
		);
		expect(src.match(/ui\.reveal\(ui\.create_dom_element\(/g)?.length).toBe(3);
	});
});
