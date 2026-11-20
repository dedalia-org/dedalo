// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, afterEach, assert */
/*eslint no-undef: "error"*/

import { open_tool, tool_common } from '../../../core/tools_common/js/tool_common.js';

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
 * The tool context is passed as an object and `window.open` is replaced for
 * the suite. The round-trip case is the one that reaches the server: it hands
 * the URL the window door built to `tool_common.init`, the code that runs in
 * the OPENED window, which rebuilds the caller (test52 of the test3 record).
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

	it('window → init: the opened window rebuilds its caller from the URL the door built', async () => {
		// 2026-11-20: an edit of the window door also rewrote the decompress
		// site in init() — an undeclared identifier there, so every tool opened
		// in its own window came up with no caller. Only the door was gated.
		const tool_config = { ddo_map: [{ tipo: caller.tipo, role: 'main_element' }] };
		const caller_options = { tag_id: 7 };
		await open_tool({
			caller,
			caller_options,
			tool_context: { ...tool_context('window', { width: 760, height: 500 }), tool_config },
		});
		assert.equal(opened.length, 1, 'window.open called once');
		const opened_url = new URL(opened[0].url, window.location.href);
		assert.isAbove(
			(opened_url.searchParams.get('raw_data') || '').length,
			20,
			'the URL carries the compressed caller',
		);

		const real_location = window.location.href;
		const tool = new tool_common();
		let initialized;
		try {
			// the opened window reads its own address
			window.history.replaceState({}, '', opened_url.search);
			initialized = await tool.init({
				model: 'tool_test_window_features',
				lang: caller.lang,
				mode: 'edit',
			});
		} finally {
			window.history.replaceState({}, '', real_location);
		}

		try {
			assert.isTrue(initialized, 'init succeeded');
			assert.isTrue(tool.caller_is_calculated, 'the caller came from the URL');
			assert.isOk(tool.caller, 'the caller was rebuilt: ' + tool.error);
			assert.equal(tool.caller.tipo, caller.tipo);
			assert.equal(tool.caller.section_tipo, caller.section_tipo);
			assert.equal(tool.caller.model, caller.model);
			assert.strictEqual(tool.caller.caller, tool, 'the rebuilt caller points back at the tool');
			assert.deepEqual(tool.caller_options, caller_options, 'per-open data crossed the URL');
			assert.deepEqual(tool.tool_config, tool_config, 'tool_config crossed the URL');
		} finally {
			await tool.caller?.destroy?.(true, true, true);
		}
	});

	it('modal: declared sizes land on the modal box', async () => {
		// own caller identity: the opening guard is keyed by tool + caller + lang
		const modal_caller = { ...caller, id_base: 'test_open_tool_window_features_sized' };
		const before_modals = new Set(document.querySelectorAll('dd-modal'));
		const view = open_tool({
			caller: modal_caller,
			tool_context: tool_context('modal', { width: '40rem', maxWidth: '90%' }),
		}).catch((error) => ({ error }));

		// the box is styled when the modal is attached, before the tool loads
		// (this tool has no module: its load fails afterwards, in the modal)
		let modal = null;
		for (let i = 0; i < 40 && !modal; i++) {
			await new Promise((resolve) => setTimeout(resolve, 30));
			modal =
				[...document.querySelectorAll('dd-modal')].find(
					(node) => !before_modals.has(node) && node.modal_content?.style.width,
				) || null;
		}
		try {
			assert.isOk(modal, 'a modal was built and its box styled');
			assert.equal(modal.modal_content.style.width, '40rem');
			assert.equal(modal.modal_content.style.maxWidth, '90%');
		} finally {
			await view;
			if (modal) {
				modal.transient = true;
				await modal.close();
			}
			document.querySelectorAll('dd-modal').forEach((node) => {
				if (!before_modals.has(node)) node.remove();
			});
		}
	});
});

// @license-end
