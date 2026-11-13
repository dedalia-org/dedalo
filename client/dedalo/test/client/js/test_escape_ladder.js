// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/

/**
 * ESCAPE LADDER — T1-P07
 *
 * The application's Escape contract (run_escape_ladder, component_common.js):
 * ESC deactivates the active component unless a narrower scope consumes it —
 * modal → CSS fullscreen → a component whose owns_escape() is true LIVE →
 * deactivate. Two editors broke it:
 *  - component_text_area swallowed ESC (stopPropagation) as its AV play/pause
 *    key whether or not any media component was subscribed, so ESC never left
 *    a text area;
 *  - component_json's editor root (vanilla-jsoneditor .jse-main)
 *    stopPropagation()s every keydown, so the page never saw ESC at all.
 *
 * Runs the REAL page keydown handler (a page instance's init → add_events) and
 * real KeyboardEvents on the real editable surfaces. Read-only on test3/1: no
 * value is edited, so a deactivate saves nothing.
 *
 * Known limit: a synthetic dispatchEvent keeps the test frame on the stack, so
 * the trusted-event microtask hazard (a microtask runs between listeners) is
 * not reproducible here; the json case pins the macrotask ordering instead
 * (still active after a microtask, deactivated after a macrotask).
 */

import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { ui } from '../../../core/common/js/ui.js';
// namespace import: on a tree without the export every case still RUNS (and reds
// on its own assertion) instead of the whole suite dying at module link time
import * as component_common_module from '../../../core/component_common/js/component_common.js';
import { elements } from './elements.js';

const section_tipo = 'test3';
const section_id = 1;

const container = document.getElementById('content');
const fixture = ui.create_dom_element({
	element_type: 'div',
	class_name: 'escape_ladder_fixture',
});
container.prepend(fixture);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * WAIT_FOR
 * Poll a predicate (20 ms steps) until true or the deadline.
 * @param {function} predicate
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
const wait_for = async (predicate, ms = 2000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await sleep(20);
	}
	return predicate();
}; //end wait_for

/**
 * PRESS_ESCAPE
 * Dispatch a real Escape keydown on a node (bubbles, cancelable).
 * @param {HTMLElement} node
 * @returns {KeyboardEvent} the dispatched event (defaultPrevented readable)
 */
const press_escape = (node) => {
	const evt = new KeyboardEvent('keydown', {
		key: 'Escape',
		code: 'Escape',
		keyCode: 27,
		bubbles: true,
		cancelable: true,
		composed: true,
	});
	node.dispatchEvent(evt);
	return evt;
}; //end press_escape

/**
 * BUILD_EDIT
 * Build + render an edit/default instance into the fixture.
 */
const build_edit = async (model, tipo, after_build = null) => {
	const base = elements.find((el) => el.model === model) || {};
	const options = Object.assign({}, base, {
		model: model,
		tipo: tipo,
		section_tipo: section_tipo,
		section_id: section_id,
		mode: 'edit',
		view: 'default',
		permissions: 2,
		id_variant: 'escape_ladder',
	});
	const instance = await get_instance(options);
	await instance.build(true);
	if (after_build) {
		after_build(instance);
	}
	const node = await instance.render();
	fixture.appendChild(node);
	return instance;
}; //end build_edit

/**
 * ACTIVATE
 * Activate a component the way a click does and confirm it took.
 */
const activate = async (instance) => {
	await ui.component.activate(instance);
	assert.equal(page_globals.component_active, instance, 'activation precondition');
	assert.equal(instance.active, true, 'activation precondition (instance.active)');
}; //end activate

const is_deactivated = (instance) =>
	page_globals.component_active !== instance && instance.active !== true;

describe('ESCAPE LADDER (T1-P07)', function () {
	this.timeout(20000);

	let page = null;
	let input_text = null;
	let text_area = null;
	let json = null;
	let saved_modal;

	before(async () => {
		saved_modal = window.modal;

		// the REAL page keydown handler: page.init → add_events
		page = await get_instance({
			model: 'page',
			menu: false,
		});

		json = await build_edit('component_json', 'test18');
		text_area = await build_edit('component_text_area', 'test17', (instance) => {
			instance.auto_init_editor = true;
		});
		input_text = await build_edit('component_input_text', 'test52');

		// editors ready: CKEditor editable + jsoneditor's CodeMirror content
		json.node.scrollIntoView();
		const text_area_ready = await wait_for(
			() => !!text_area.node.querySelector('.ck-editor__editable'),
			8000,
		);
		assert.equal(text_area_ready, true, 'text_area editor (CKEditor editable) never materialised');
		const json_ready = await wait_for(() => !!json.node.querySelector('.cm-content'), 8000);
		assert.equal(json_ready, true, 'json editor (CodeMirror content) never materialised');
	});

	after(async () => {
		window.modal = saved_modal;
		if (page_globals.component_active) {
			await ui.component.deactivate(page_globals.component_active);
		}
		for (const instance of [input_text, text_area, json]) {
			if (instance) {
				await instance.destroy(true, true, true);
			}
		}
		if (page) {
			await page.destroy(true, true, true); // removes the document keydown listener
		}
		fixture.remove();
	});

	// helpers bound to the live nodes (editors can re-render on (de)activation)
	const editable = () => text_area.node.querySelector('.ck-editor__editable');
	const cm_content = () => json.node.querySelector('.cm-content');
	const esc_event = () => `key_up_esc_${text_area.id_base}`;

	it('CONTROL: ESC in an input_text deactivates it (the real page handler is wired in this frame)', async () => {
		await activate(input_text);
		const input = input_text.node.querySelector('input');
		assert.isOk(input, 'input_text edit renders an <input>');
		input.focus();
		press_escape(input);
		assert.equal(
			await wait_for(() => is_deactivated(input_text)),
			true,
			'input_text still active after ESC',
		);
	});

	it('the ladder is ONE exported function (component_common.run_escape_ladder)', () => {
		assert.equal(typeof component_common_module.run_escape_ladder, 'function');
	});

	it('text_area UNBOUND: ESC deactivates it (no observer subscribed → the key is not swallowed)', async () => {
		assert.equal(
			event_manager.get_event_count(esc_event()),
			0,
			`precondition: nothing subscribed to ${esc_event()}`,
		);
		await activate(text_area);
		editable().focus();
		const evt = press_escape(editable());
		assert.equal(evt.defaultPrevented, false, 'an unbound text_area must not consume ESC');
		assert.equal(
			await wait_for(() => is_deactivated(text_area)),
			true,
			'text_area still active after ESC',
		);
	});

	it('text_area: owns_escape() answers the LIVE binding', () => {
		assert.equal(typeof text_area.owns_escape, 'function', 'component_text_area.owns_escape');
		assert.equal(text_area.owns_escape(), false, 'unbound → does not own ESC');
		const token = event_manager.subscribe(esc_event(), () => {});
		try {
			assert.equal(text_area.owns_escape(), true, 'bound → owns ESC');
		} finally {
			event_manager.unsubscribe(token);
		}
		assert.equal(
			text_area.owns_escape(),
			false,
			'unsubscribed → no longer owns ESC (never cached)',
		);
	});

	it('CONTROL text_area BOUND (transcription): ESC plays/pauses, the text area stays active', async () => {
		const calls = [];
		const token = event_manager.subscribe(esc_event(), (payload) => {
			calls.push(payload);
		});
		try {
			await activate(text_area);
			editable().focus();
			const evt = press_escape(editable());
			await sleep(150);
			assert.equal(calls.length, 1, 'the play/pause observer received ESC once');
			assert.equal(calls[0], text_area.context.features.av_player.av_rewind_seconds);
			assert.equal(evt.defaultPrevented, true, 'bound ESC is consumed');
			assert.equal(page_globals.component_active, text_area, 'bound ESC must not deactivate');
		} finally {
			event_manager.unsubscribe(token);
		}
	});

	it('text_area bound → observer gone → ESC deactivates (live, not cached)', async () => {
		const token = event_manager.subscribe(esc_event(), () => {});
		await activate(text_area);
		event_manager.unsubscribe(token);
		editable().focus();
		press_escape(editable());
		assert.equal(
			await wait_for(() => is_deactivated(text_area)),
			true,
			'text_area still active after its observer left',
		);
	});

	it('CONTROL text_area with play/pause reconfigured to F4: ESC deactivates', async () => {
		const av_player = text_area.context.features.av_player;
		const saved_code = av_player.av_play_pause_code;
		av_player.av_play_pause_code = 'F4';
		try {
			await activate(text_area);
			editable().focus();
			press_escape(editable());
			assert.equal(
				await wait_for(() => is_deactivated(text_area)),
				true,
				'text_area still active after ESC',
			);
		} finally {
			av_player.av_play_pause_code = saved_code;
		}
	});

	it("json: ESC deactivates it — after the editor's dispatch (macrotask), never before", async () => {
		await activate(json);
		cm_content().focus();
		const evt = press_escape(cm_content());
		assert.equal(
			evt.defaultPrevented,
			false,
			'precondition: the editor did not consume a bare ESC',
		);
		assert.equal(
			page_globals.component_active,
			json,
			'decided synchronously (must wait for the dispatch)',
		);
		await Promise.resolve();
		assert.equal(
			page_globals.component_active,
			json,
			'decided in a microtask (would pre-empt CodeMirror on a trusted event)',
		);
		await macrotask();
		assert.equal(
			await wait_for(() => is_deactivated(json), 1000),
			true,
			'json still active after ESC',
		);
	});

	it("json with a text selection: the first ESC is the editor's (collapse), the second leaves", async () => {
		await activate(json);
		cm_content().focus();
		const editor = json.editors[0];
		assert.isOk(
			editor && typeof editor.select === 'function',
			'jsoneditor instance exposes select()',
		);
		editor.select({ type: 'text', ranges: [{ anchor: 0, head: 1 }], main: 0 });
		await sleep(50);
		const first = press_escape(cm_content());
		assert.equal(
			first.defaultPrevented,
			true,
			'precondition: CodeMirror consumed ESC to collapse the selection',
		);
		await sleep(100);
		assert.equal(
			page_globals.component_active,
			json,
			'an ESC the editor consumed must not deactivate',
		);
		press_escape(cm_content());
		assert.equal(
			await wait_for(() => is_deactivated(json), 1000),
			true,
			'json still active after the second ESC',
		);
	});

	it('one event runs the ladder once (both entry paths may see it)', async () => {
		const run_escape_ladder = component_common_module.run_escape_ladder;
		assert.equal(typeof run_escape_ladder, 'function', 'run_escape_ladder exported');
		await activate(json);
		const evt = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', cancelable: true });
		assert.equal(run_escape_ladder(evt), true, 'first run handles it');
		assert.equal(await wait_for(() => is_deactivated(json), 1000), true, 'first run deactivates');
		await activate(json);
		assert.equal(run_escape_ladder(evt), false, 'the same event is not handled twice');
		await sleep(50);
		assert.equal(page_globals.component_active, json, 'a replayed event must not deactivate');
		// CONTROL: a fresh event does
		assert.equal(run_escape_ladder(new KeyboardEvent('keydown', { key: 'Escape' })), true);
		assert.equal(await wait_for(() => is_deactivated(json), 1000), true);
	});

	it('CONTROL modal precedence: an open modal owns ESC — nothing is deactivated', async () => {
		window.modal = { stub: true };
		try {
			await activate(json);
			cm_content().focus();
			press_escape(cm_content());
			await sleep(100);
			assert.equal(page_globals.component_active, json, 'json deactivated under a modal');

			await activate(text_area);
			editable().focus();
			press_escape(editable());
			await sleep(100);
			assert.equal(page_globals.component_active, text_area, 'text_area deactivated under a modal');
		} finally {
			window.modal = saved_modal;
		}
	});
});
