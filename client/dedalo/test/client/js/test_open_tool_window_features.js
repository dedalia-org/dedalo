// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, afterEach, assert */
/*eslint no-undef: "error"*/

import { open_tool } from '../../../core/tools_common/js/tool_common.js';

/**
 * TOOL WINDOW FEATURES — THE OPEN PATH
 * A tool's `windowFeatures` is parsed against the closed grammar of
 * tools_common/js/window_features.js (WC-2026-11-19-window-features-grammar).
 * That module is loaded by `open_tool` on the first tool that DECLARES
 * features, not with the page (test/unit/page_load_budget_native.test.ts counts
 * the boot graph), so the grammar reaching the two open doors is a contract of
 * its own — the module's unit gate (test/unit/client_window_features.test.ts)
 * cannot see whether tool_common still asks it.
 *
 * Backend-free: the tool context is passed as an object, and every case ends
 * before a tool module is requested (a refusal) or at `window.open`, which is
 * replaced for the suite.
 */
describe('TOOL WINDOW FEATURES — THE OPEN PATH', () => {
	const real_open = window.open;
	let opened = [];

	const caller = {
		id_base: 'test_open_tool_window_features_caller',
		tipo: 'test52',
		section_tipo: 'test3',
		section_id: 1,
		mode: 'edit',
		model: 'component_input_text',
		lang: 'lg-eng',
		label: 'caller',
	};

	// TOOL_CONTEXT. A registration this suite owns: no such tool exists, so a case
	// that got past the grammar would fail loudly at the module request.
	const tool_context = (open_as, windowFeatures) => ({
		name: 'tool_test_window_features',
		label: 'window features',
		properties: { open_as, windowFeatures },
	});

	// REFUSAL. The error an open rejects with (the test fails when it resolves).
	const refusal = async (open_as, windowFeatures) => {
		try {
			const result = await open_tool({
				caller,
				tool_context: tool_context(open_as, windowFeatures),
			});
			return { resolved: result };
		} catch (error) {
			return { error };
		}
	};

	const modals = () => document.querySelectorAll('dd-modal').length;

	before(() => {
		window.open = (url, target, features) => {
			opened.push({ url, target, features });
			return { resizeTo() {}, focus() {}, closed: false };
		};
	});

	afterEach(() => {
		opened = [];
	});

	after(() => {
		window.open = real_open;
	});

	it('window: the legacy relative form reaches window.open as a NUMBER', async () => {
		const tool_window = await open_tool({
			caller,
			tool_context: tool_context('window', {
				left: 'return screen.width -760',
				top: 0,
				width: 760,
				height: 500,
			}),
		});
		assert.ok(tool_window, 'the window was opened');
		assert.equal(opened.length, 1, 'window.open called once');
		const features = opened[0].features.split(',');
		assert.include(
			features,
			`left=${window.screen.width - 760}`,
			'the relative form was computed from the screen',
		);
		assert.include(features, 'width=760');
		assert.include(features, 'height=500');
		assert.include(opened[0].url, 'tool=tool_test_window_features');
	});

	it('window: a value outside the grammar opens NOTHING and names its key', async () => {
		window.test_open_tool_window_features_ran = false;
		const outcome = await refusal('window', {
			top: 0,
			left: 'return (window.test_open_tool_window_features_ran = true, 0)',
		});
		assert.isDefined(
			outcome.error,
			'the open was refused, it resolved: ' + JSON.stringify(outcome.resolved),
		);
		assert.include(outcome.error.message, 'left', 'the refusal names the key');
		assert.equal(opened.length, 0, 'window.open was never called');
		assert.isFalse(window.test_open_tool_window_features_ran, 'the value was not run');
		window.test_open_tool_window_features_ran = undefined;
	});

	it('window: a tool with no features opens a new tab', async () => {
		const tool_window = await open_tool({ caller, tool_context: tool_context('window', null) });
		assert.ok(tool_window, 'the window was opened');
		assert.equal(opened.length, 1, 'window.open called once');
		assert.isNull(opened[0].features, 'no features string: a new tab');
	});

	it('modal: a key outside the size allowlist builds NO modal and names its key', async () => {
		const before_modals = modals();
		const outcome = await refusal('modal', { width: '34rem', onload: 'x' });
		assert.isDefined(
			outcome.error,
			'the open was refused, it resolved: ' + JSON.stringify(outcome.resolved),
		);
		assert.include(outcome.error.message, 'onload', 'the refusal names the key');
		assert.equal(modals(), before_modals, 'no modal was built');
	});

	it('modal: a refusal releases the opening guard (the next open is judged, not swallowed)', async () => {
		const first = await refusal('modal', { background: 'red' });
		assert.isDefined(first.error, 'first open refused');
		// With the guard still held, view_modal answers `false` (already opening)
		// and the tool could not be opened again until a page reload.
		const second = await refusal('modal', { background: 'red' });
		assert.isDefined(
			second.error,
			'second open refused by the grammar, it resolved: ' + JSON.stringify(second.resolved),
		);
		assert.include(second.error.message, 'background');
	});
});

// @license-end
