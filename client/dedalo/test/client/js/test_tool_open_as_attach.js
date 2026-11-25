// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, beforeEach, afterEach, assert, DEDALO_TOOLS_URLS */
/*eslint no-undef: "error"*/

import { CLIENT_ERROR } from '../../../core/common/js/api_error.js';
import { ERROR_SIGNAL } from '../../../core/common/js/error_dispatch.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance, get_instance_by_id } from '../../../core/common/js/instances.js';
import { is_tool_attached, open_tool } from '../../../core/tools_common/js/tool_common.js';
import { elements } from './elements.js';

/**
 * TOOL OPEN MODE `open_as:'attach'` (tool_common.view_attach)
 * An attach tool has no modal and no window: it is built straight onto its live
 * caller through its own attach()/detach(), the button is a pressed/released
 * toggle, and core owns the lifecycle (caller re-render → re-attach, caller
 * destroy → teardown).
 *
 * THE TOOL: test/client/fixtures/tool_test_attach — a scratch tool that never
 * ships under tools/. The suite maps its directory in DEDALO_TOOLS_URLS (the
 * additional-tools-root door instances.js and tool_css_url already honour), so
 * the REAL get_instance import/construct/init path and the real tool CSS load
 * run; the mapping is removed after the suite.
 *
 * THE CALLER: a real component_input_text (test52 of test3, the shared read-only
 * record of elements.js) built and rendered on the suite server, with the
 * fixture tool injected into its tools so its own render builds the button.
 * Nothing is written.
 */

const TOOL_NAME = 'tool_test_attach';
const FIXTURE_BASE = new URL(`../fixtures/${TOOL_NAME}`, import.meta.url).href;

const element = elements.find((el) => el.model === 'component_input_text');

const tool_context = () => ({
	name: TOOL_NAME,
	model: TOOL_NAME,
	label: 'attach fixture',
	icon: '../../core/themes/default/icons/edit.svg',
	show_in_component: true,
	properties: { open_as: 'attach' },
});

// WAIT_FOR. Polls a condition (the re-attach and the destroy-driven teardown are
// not awaited by anything the suite can hold).
const wait_for = async (condition, label, timeout = 4000) => {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) {
			throw new Error(`timed out waiting for: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const modal_count = () => document.querySelectorAll('dd-modal').length;
const surfaces = (root = document) => root.querySelectorAll('.tool_test_attach_surface');
const tool_buttons = (caller) =>
	caller.node ? [...caller.node.querySelectorAll(`[data-tool="${TOOL_NAME}"].button.tool`)] : [];
const attached_names = (caller) =>
	(caller.node?.getAttribute('data-tools-attached') || '').split(/\s+/).filter(Boolean);

describe('TOOL OPEN_AS ATTACH (view_attach)', function () {
	this.timeout(20000);

	const container = document.getElementById('content');
	let fixture;
	let caller;
	let caller_count = 0;
	let had_tools_urls_key = false;

	// error spies: the page-wide signal handle_api_error raises once per failure,
	// and the 'notification' payloads render_error_toast publishes (no page
	// subscriber in the suite frame, so no real toast reaches the screen)
	let signals = [];
	let notifications = [];
	let notification_token = null;
	const signal_listener = (event) => signals.push(event.detail);

	// BUILD_CALLER. A fresh live test52 instance, rendered into the suite frame,
	// carrying the fixture tool in its tools list.
	const build_caller = async () => {
		caller_count++;
		const instance = await get_instance({
			model: element.model,
			tipo: element.tipo,
			section_tipo: element.section_tipo,
			section_id: element.section_id,
			mode: 'edit',
			lang: element.lang,
			id_variant: `test_tool_open_as_attach_${caller_count}`,
		});
		await instance.build(true);
		const context_tool = tool_context();
		instance.context.tools = [...(instance.context.tools || []), context_tool];
		instance.tools = [...(instance.tools || []).filter((t) => t.name !== TOOL_NAME), context_tool];
		const node = await instance.render();
		container.appendChild(node);
		return instance;
	};

	const open = (target = caller) => open_tool({ caller: target, tool_context: tool_context() });

	before(async () => {
		assert.isObject(
			window.DEDALO_TOOLS_URLS,
			'set_environment published the additional-tools map (the door the fixture rides)',
		);
		had_tools_urls_key = Object.hasOwn(DEDALO_TOOLS_URLS, TOOL_NAME);
		DEDALO_TOOLS_URLS[TOOL_NAME] = FIXTURE_BASE;
		fixture = (await import(`${FIXTURE_BASE}/js/${TOOL_NAME}.js`)).attach_fixture;
		window.addEventListener(ERROR_SIGNAL, signal_listener);
		notification_token = event_manager.subscribe('notification', (payload) => {
			notifications.push(payload);
		});
	});

	after(() => {
		if (!had_tools_urls_key) {
			delete DEDALO_TOOLS_URLS[TOOL_NAME];
		}
		window.removeEventListener(ERROR_SIGNAL, signal_listener);
		event_manager.unsubscribe(notification_token);
	});

	beforeEach(async () => {
		fixture.reset();
		signals = [];
		notifications = [];
		caller = await build_caller();
		assert.equal(tool_buttons(caller).length, 1, 'the caller rendered the fixture tool button');
		assert.equal(
			tool_buttons(caller)[0].getAttribute('aria-pressed'),
			'false',
			'an attach tool button is a released toggle before any open',
		);
	});

	afterEach(async () => {
		fixture.attach_delay_ms = 0;
		if (caller && is_tool_attached(TOOL_NAME, caller)) {
			await open(caller); // toggle off (awaits the teardown)
		}
		if (caller && caller.status !== 'destroyed') {
			await caller.destroy(true, true, true);
		}
		caller = null;
		for (const surface of surfaces()) surface.remove();
		fixture.reset();
	});

	it('attach: resolves the instance, attach() once, render() never, no modal, markers set', async () => {
		const seen_modals = [];
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const added of record.addedNodes) {
					if (added.nodeType !== Node.ELEMENT_NODE) continue;
					if (added.matches('dd-modal') || added.querySelector('dd-modal')) seen_modals.push(added);
				}
			}
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
		const modals_before = modal_count();

		let instance;
		try {
			instance = await open();
			await new Promise((resolve) => setTimeout(resolve, 50)); // let a late modal show itself
		} finally {
			observer.disconnect();
		}

		assert.isObject(instance, 'open_tool resolved the tool instance');
		assert.equal(instance.model, TOOL_NAME);
		assert.strictEqual(instance.caller, caller, 'the tool decorates the live caller');
		assert.equal(instance.status, 'built');
		assert.strictEqual(get_instance_by_id(instance.id), instance, 'the instance is registered');
		assert.deepEqual(
			fixture.log.find((e) => e.op === 'build'),
			{ op: 'build', id: instance.id, autoload: true },
			'build(true)',
		);
		assert.equal(fixture.count('attach'), 1, 'attach() called once');
		assert.equal(fixture.count('render'), 0, 'render() never called');
		assert.equal(seen_modals.length, 0, 'no <dd-modal> ever appeared');
		assert.equal(modal_count(), modals_before);
		assert.equal(surfaces(caller.node).length, 1, 'the tool UI is on the caller node');
		assert.include(attached_names(caller), TOOL_NAME, 'caller.node[data-tools-attached~=tool]');
		assert.equal(tool_buttons(caller)[0].getAttribute('aria-pressed'), 'true');
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));
		assert.equal(signals.length, 0, 'no error surfaced');
	});

	it('toggle: a second open detaches + destroys and resolves false; markers cleared', async () => {
		const instance = await open();
		assert.isObject(instance);

		const second = await open();

		assert.isFalse(second, 'the toggle-off open resolves false');
		assert.equal(fixture.count('detach'), 1, 'detach() called once');
		assert.equal(fixture.count('destroy'), 1, 'destroy() called once');
		assert.equal(instance.status, 'destroyed', 'the tool instance is destroyed');
		assert.isNull(get_instance_by_id(instance.id), 'the instance left the registry');
		assert.equal(surfaces().length, 0, 'the tool UI is gone');
		assert.notInclude(attached_names(caller), TOOL_NAME);
		assert.isFalse(
			caller.node.hasAttribute('data-tools-attached'),
			'an empty token list drops the attribute',
		);
		assert.equal(tool_buttons(caller)[0].getAttribute('aria-pressed'), 'false');
		assert.isFalse(is_tool_attached(TOOL_NAME, caller));
		assert.equal(fixture.count('attach'), 1, 'no re-attach on toggle-off');
	});

	it('click while loading: a second open during a slow attach is refused (false), attach() once', async () => {
		fixture.attach_delay_ms = 200;

		const first = open();
		const second = open();
		const [first_result, second_result] = await Promise.all([first, second]);

		assert.isFalse(second_result, 'the open during loading is refused');
		assert.isObject(first_result, 'the first open attached');
		assert.equal(fixture.count('init'), 1, 'one instance created');
		assert.equal(fixture.count('attach'), 1, 'attach() called once');
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));
		assert.equal(surfaces().length, 1);
	});

	it('loading marker: aria-busy + class loading while it loads, absent after', async () => {
		fixture.attach_delay_ms = 200;

		const pending = open();
		await wait_for(() => fixture.count('attach') === 1, 'attach() started');

		const [button] = tool_buttons(caller);
		assert.equal(button.getAttribute('aria-busy'), 'true', 'aria-busy during load');
		assert.isTrue(button.classList.contains('loading'), 'class loading during load');
		assert.isFalse(is_tool_attached(TOOL_NAME, caller), 'not attached while loading');

		const instance = await pending;
		assert.isObject(instance);
		assert.isFalse(button.hasAttribute('aria-busy'), 'aria-busy removed after load');
		assert.isFalse(button.classList.contains('loading'), 'class loading removed after load');
		assert.equal(button.getAttribute('aria-pressed'), 'true');
	});

	it('caller re-render (render and refresh): detach then attach again onto the new node, no duplicate UI', async () => {
		const instance = await open();
		assert.isObject(instance);
		const old_node = caller.node;

		// rebuild + render (no server read): a full render from 'built' replaces
		// the caller node. (render() on an already 'rendered' instance returns the
		// same node and publishes nothing — no re-render happened.)
		await caller.build(false);
		await caller.render();
		await wait_for(() => fixture.count('attach') === 2, 're-attach after render');

		const ops = fixture.ops().filter((op) => op === 'attach' || op === 'detach');
		assert.deepEqual(ops, ['attach', 'detach', 'attach'], 'detach THEN attach');
		assert.notStrictEqual(caller.node, old_node, 'the caller replaced its node');
		assert.isTrue(document.contains(caller.node));
		assert.equal(surfaces().length, 1, 'one tool UI in the document (no duplicate)');
		assert.equal(surfaces(caller.node).length, 1, 'the tool UI is on the NEW node');
		assert.equal(surfaces(old_node).length, 0, 'nothing left on the old node');
		assert.include(attached_names(caller), TOOL_NAME, 'marker re-applied on the new node');
		assert.equal(tool_buttons(caller).length, 1);
		assert.equal(
			tool_buttons(caller)[0].getAttribute('aria-pressed'),
			'true',
			'rebuilt button reads pressed',
		);
		assert.equal(fixture.count('render'), 0, 'render() never called');
		assert.equal(fixture.count('init'), 1, 'the same instance re-attached');
		assert.equal(fixture.count('destroy'), 0, 'not destroyed by a re-render');

		// refresh: destroy(delete_self=false) + build + render — re-attach, NOT teardown
		const node_before_refresh = caller.node;
		await caller.refresh();
		await wait_for(() => fixture.count('attach') === 3, 're-attach after refresh');

		assert.equal(fixture.count('destroy'), 0, 'a refresh does not tear the tool down');
		assert.equal(fixture.count('detach'), 2);
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));
		assert.equal(surfaces().length, 1, 'still one tool UI after refresh');
		assert.equal(surfaces(caller.node).length, 1);
		assert.equal(surfaces(node_before_refresh).length, caller.node === node_before_refresh ? 1 : 0);
		assert.include(attached_names(caller), TOOL_NAME);
		assert.equal(instance.status, 'built');
		assert.equal(signals.length, 0, 'no error surfaced');
	});

	it('caller destroy: detach + destroy, registry cleared (a fresh caller attaches anew)', async () => {
		const instance = await open();
		assert.isObject(instance);
		const destroyed_caller = caller;

		await destroyed_caller.destroy(true, true, true);
		assert.isFalse(is_tool_attached(TOOL_NAME, destroyed_caller), 'released at once');
		await wait_for(() => fixture.count('destroy') === 1, 'tool destroyed');

		assert.equal(fixture.count('detach'), 1, 'detach() called once');
		assert.equal(instance.status, 'destroyed');
		assert.isNull(get_instance_by_id(instance.id));
		assert.equal(surfaces().length, 0);

		// the registry entry is gone: the same key opens anew (a stale entry would
		// toggle off and resolve false)
		fixture.reset();
		caller = await build_caller();
		assert.equal(tool_buttons(caller)[0].getAttribute('aria-pressed'), 'false');
		const reopened = await open();
		assert.isObject(reopened, 'a new attach on the same key');
		assert.notStrictEqual(reopened, instance);
		assert.equal(fixture.count('attach'), 1);
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));
	});

	// ASSERT_FAILURE. Runs one failing open; returns the failing open's log (the
	// fixture log before the retry) for the case's own path-specific checks.
	const assert_failure = async (label, setup, expect_attach_calls) => {
		setup();
		const result = await open();
		const failed_log = [...fixture.log];

		assert.isFalse(result, `${label}: open resolves false`);
		assert.equal(fixture.count('attach'), expect_attach_calls, `${label}: attach() calls`);
		assert.equal(fixture.count('destroy'), 1, `${label}: the built instance is destroyed`);
		assert.isFalse(is_tool_attached(TOOL_NAME, caller), `${label}: nothing attached`);
		assert.equal(surfaces().length, 0, `${label}: no tool UI left`);
		assert.isFalse(caller.node.hasAttribute('data-tools-attached'), `${label}: no attached marker`);
		const [button] = tool_buttons(caller);
		assert.isFalse(button.hasAttribute('aria-busy'), `${label}: aria-busy cleared`);
		assert.isFalse(button.classList.contains('loading'), `${label}: loading cleared`);
		assert.equal(button.getAttribute('aria-pressed'), 'false', `${label}: released`);

		await wait_for(() => signals.length > 0, `${label}: the error is dispatched`);
		await new Promise((resolve) => setTimeout(resolve, 50)); // a second dispatch would land here
		assert.equal(signals.length, 1, `${label}: ONE error dispatched`);
		assert.equal(signals[0].code, CLIENT_ERROR.RENDER_FAILED, `${label}: client.render_failed`);
		// the toast is deduped by code + text for a few seconds, so only the first
		// failure of the run publishes one — never more than one per failure
		assert.isAtMost(notifications.length, 1, `${label}: at most one toast`);
		for (const payload of notifications) {
			assert.equal(payload.api_error?.code, CLIENT_ERROR.RENDER_FAILED);
			assert.deepEqual(payload.api_error?.details, { reason: 'tool_attach' });
		}

		// the guard was released: the next open is judged, not refused
		fixture.reset();
		const retry = await open();
		assert.isObject(retry, `${label}: a later open attaches`);
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));

		return failed_log;
	};

	it('failure: a tool without detach() is refused before attach — false, cleaned, one error (toast payload)', async () => {
		const failed_log = await assert_failure(
			'no detach',
			() => {
				fixture.omit_detach = true;
			},
			0,
		);
		assert.deepEqual(
			failed_log.map((e) => e.op),
			['init', 'build', 'destroy'],
			'the contract is checked after build, before attach',
		);
		assert.equal(notifications.length, 1, 'the first failure published exactly one toast');
	});

	it('failure: attach() throws — false, cleaned, one error', async () => {
		const failed_log = await assert_failure(
			'attach throws',
			() => {
				fixture.attach_throws = true;
			},
			1,
		);
		const ops = failed_log.map((e) => e.op);
		assert.deepEqual(
			ops,
			['init', 'build', 'attach', 'destroy'],
			'attach threw → destroyed, never attached',
		);
		assert.notInclude(ops, 'detach', 'core does not detach a tool that never attached');
	});

	it('failure: attach() resolves falsy — false, cleaned, one error', async () => {
		const failed_log = await assert_failure(
			'attach falsy',
			() => {
				fixture.attach_result = false;
			},
			1,
		);
		const ops = failed_log.map((e) => e.op);
		assert.deepEqual(ops, ['init', 'build', 'attach', 'destroy'], 'falsy attach → destroyed');
	});

	it('render during the FIRST attach: not missed — ends attached to the new node, one UI', async () => {
		fixture.attach_delay_ms = 200;

		const pending = open();
		await wait_for(() => fixture.count('attach') === 1, 'first attach() started');
		const old_node = caller.node;

		// the caller re-renders while the first attach() is still running
		await caller.build(false);
		await caller.render();
		assert.notStrictEqual(caller.node, old_node, 'the caller replaced its node during the attach');

		const instance = await pending;
		assert.isObject(instance, 'the open still resolves the instance');
		await wait_for(() => fixture.count('attach') === 2, 're-attach after the first attach');
		fixture.attach_delay_ms = 0;
		await wait_for(() => surfaces(caller.node).length === 1, 'tool UI on the new node');

		assert.equal(surfaces().length, 1, 'one tool UI in the document');
		assert.equal(surfaces(old_node).length, 0, 'nothing left on the old node');
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));
		assert.include(attached_names(caller), TOOL_NAME, 'marker on the new node');
		assert.equal(tool_buttons(caller)[0].getAttribute('aria-pressed'), 'true');
		assert.equal(signals.length, 0, 'no error surfaced');
	});

	it('keyboard: the attach button is a tab stop and Enter / Space toggle the tool', async () => {
		const [button] = tool_buttons(caller);
		assert.equal(button.getAttribute('role'), 'button');
		assert.equal(button.getAttribute('tabindex'), '0', 'a tab stop');

		const press = (key) =>
			button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

		press('Enter');
		await wait_for(() => is_tool_attached(TOOL_NAME, caller), 'Enter attached the tool');
		assert.equal(surfaces(caller.node).length, 1);
		assert.equal(tool_buttons(caller)[0].getAttribute('aria-pressed'), 'true');

		press(' ');
		await wait_for(() => fixture.count('destroy') === 1, 'Space detached the tool');
		assert.isFalse(is_tool_attached(TOOL_NAME, caller));
		assert.equal(surfaces().length, 0);
		assert.equal(tool_buttons(caller)[0].getAttribute('aria-pressed'), 'false');
	});

	it('two live callers sharing id_base + lang attach independently (B never tears down A)', async () => {
		const caller_b = await build_caller();
		try {
			assert.equal(caller_b.id_base, caller.id_base, 'same id_base');
			assert.equal(caller_b.lang, caller.lang, 'same lang');
			assert.notEqual(caller_b.id, caller.id, 'two live instances');

			const instance_a = await open(caller);
			const instance_b = await open(caller_b);

			assert.isObject(instance_a);
			assert.isObject(instance_b, "B's open attaches B (not a toggle of A)");
			assert.notStrictEqual(instance_a, instance_b, 'one tool instance per caller');
			assert.isTrue(is_tool_attached(TOOL_NAME, caller));
			assert.isTrue(is_tool_attached(TOOL_NAME, caller_b));
			assert.equal(surfaces(caller.node).length, 1);
			assert.equal(surfaces(caller_b.node).length, 1);

			// toggling B off leaves A attached
			assert.isFalse(await open(caller_b));
			assert.isFalse(is_tool_attached(TOOL_NAME, caller_b));
			assert.isTrue(is_tool_attached(TOOL_NAME, caller), 'A is still attached');
			assert.equal(instance_b.status, 'destroyed');
			assert.equal(instance_a.status, 'built');
			assert.equal(surfaces(caller.node).length, 1);
		} finally {
			if (is_tool_attached(TOOL_NAME, caller_b)) await open(caller_b);
			if (caller_b.status !== 'destroyed') await caller_b.destroy(true, true, true);
		}
	});

	it('caller lang changed in place (rebuild_component_in_lang): still recognised as attached', async () => {
		const instance = await open();
		assert.isObject(instance);
		const original_lang = caller.lang;

		try {
			caller.lang = original_lang === 'lg-spa' ? 'lg-eng' : 'lg-spa'; // what rebuild_component_in_lang does
			assert.isTrue(
				is_tool_attached(TOOL_NAME, caller),
				'the key follows the live instance, not its lang',
			);

			const second = await open();
			assert.isFalse(second, 'the open toggles the attached tool off');
			assert.equal(fixture.count('init'), 1, 'no second instance created');
			assert.equal(fixture.count('detach'), 1);
			assert.equal(instance.status, 'destroyed');
			assert.equal(surfaces().length, 0);
		} finally {
			caller.lang = original_lang;
		}
	});

	it('destroy_ without a render (a refresh whose build fails): detached at once, re-attached by a later render', async () => {
		const instance = await open();
		assert.isObject(instance);

		// what common.refresh does first: destroy(delete_self=false) — publishes
		// destroy_<id> while the caller stays alive; no render follows here
		await caller.destroy(false, true, false);
		await wait_for(() => fixture.count('detach') === 1, 'detached on destroy_');

		assert.equal(surfaces().length, 0, 'nothing attached on the DOM');
		assert.equal(fixture.count('destroy'), 0, 'the tool is not destroyed (the caller lives)');
		assert.equal(instance.status, 'built');

		// a later render re-attaches, without a second detach (already detached)
		await caller.build(false);
		await caller.render();
		await wait_for(() => fixture.count('attach') === 2, 're-attach after render');

		assert.equal(fixture.count('detach'), 1, 'no redundant detach');
		assert.equal(surfaces().length, 1);
		assert.equal(surfaces(caller.node).length, 1);
		assert.isTrue(is_tool_attached(TOOL_NAME, caller));
		assert.equal(signals.length, 0, 'no error surfaced');
	});
});
