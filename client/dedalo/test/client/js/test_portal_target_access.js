// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach, page_globals */
/*eslint no-undef: "error"*/

import { ApiError } from '../../../core/common/js/api_error.js';
import { snapshot_read_state } from '../../../core/common/js/common.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import {
	handle_api_error,
	reset_error_dispatch_state,
} from '../../../core/common/js/error_dispatch.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { ui } from '../../../core/common/js/ui.js';
import { buttons } from '../../../core/component_portal/js/buttons.js';
import { component_portal } from '../../../core/component_portal/js/component_portal.js';
import {
	can_open_target,
	render_column_id,
} from '../../../core/component_portal/js/render_edit_component_portal.js';
import { view_line_edit_portal } from '../../../core/component_portal/js/view_line_edit_portal.js';

/**
 * TEST_PORTAL_TARGET_ACCESS
 * A portal whose targets carry different grants for the user (the context's
 * `request_config[].sqo.section_tipo[]` items stamp THE CALLER's section-level
 * permissions). The owner report: a line-view portal with one unreadable target
 * offered a pencil on its rows; the record window's read was refused, and on
 * return the portal's refresh read was refused too — and build_autoload handed
 * the LIVE wrapper to the dispatcher, so the full-page no-access panel was
 * appended INSIDE the portal, under the rows.
 *
 *   1. can_open_target: grant >= 1 opens, 0 (or "0") does not, unknown section
 *      does not (unless the caller says so), an external engine always opens;
 *   2. the row pencil renders only on rows whose target is readable (line view,
 *      shared default render_column_id — whose context menu still opens a
 *      section absent from the sqo, and whose window refreshes the portal on
 *      return, rebuilding row instances), and edit_record_handler refuses the unreadable
 *      target without opening a window;
 *   3. an EMBEDDED rendered portal whose refresh read is refused keeps its rows
 *      (same content node), is 'building' while the dispatch runs and
 *      'rendered' after, gets no `.api_error_panel` inside its wrapper, never
 *      sets the page slot — the refusal is a toast; a PAGE ROOT keeps the
 *      page-scope failure (control); a refused navigate (portal page turn,
 *      embedded section search) restores the sqo it changed.
 *
 * Blocks 1-2 are backend-free stubs on the generic `test` TLD; block 3 builds
 * real test80 portals / a test3 list on the suite server, then patches
 * data_manager.request.
 */

const READABLE = 'test3';
const UNREADABLE = 'test2';

/** A portal context with two Dédalo targets: one readable (2), one not (0). */
const two_target_context = (view) => ({
	view,
	request_config: [
		{
			api_engine: 'dedalo',
			type: 'main',
			sqo: {
				section_tipo: [
					{ tipo: UNREADABLE, permissions: 0, model: 'section' },
					{ tipo: READABLE, permissions: 2, model: 'section' },
				],
			},
		},
	],
});

/** A stub portal caller for the row renderers and edit_record_handler. */
const stub_portal = (view) => ({
	id: `stub_portal_${view}`,
	model: 'component_portal',
	type: 'component',
	mode: 'edit',
	view,
	section_tipo: 'test3',
	permissions: 2,
	show_interface: {},
	context: two_target_context(view),
	refresh: async () => true,
});

const refused = () => ({
	ok: false,
	request_id: 'rq-portal-refresh',
	error: new ApiError({
		code: 'perm.denied',
		status: 403,
		request_id: 'rq-portal-refresh',
		source: 'envelope',
	}),
});

describe(`PORTAL TARGET ACCESS`, function () {
	this.timeout(30000);

	describe(`can_open_target`, function () {
		it(`reads the stamped per-target grant`, () => {
			const self = stub_portal('line');
			assert.isTrue(can_open_target(self, READABLE), 'permissions 2 → openable');
			assert.isFalse(can_open_target(self, UNREADABLE), 'permissions 0 → not openable');
		});
		it(`an unknown section is not openable unless the caller says so`, () => {
			const self = stub_portal('line');
			assert.isFalse(can_open_target(self, 'test999'), 'default: unknown → false');
			assert.isTrue(
				can_open_target(self, 'test999', { unknown: true }),
				'indexation: unknown → true',
			);
			assert.isFalse(can_open_target({}, READABLE), 'no request_config → false');
		});
		it(`an external engine target always opens; a stated grant wins over unknown:true`, () => {
			const self = {
				context: {
					request_config: [
						{ api_engine: 'zenon', sqo: { section_tipo: [{ tipo: 'test5', permissions: 0 }] } },
						{ api_engine: 'dedalo', sqo: { section_tipo: [{ tipo: UNREADABLE, permissions: 0 }] } },
					],
				},
			};
			assert.isTrue(can_open_target(self, 'test5'), 'external engine: Dédalo grants do not apply');
			assert.isFalse(
				can_open_target(self, UNREADABLE, { unknown: true }),
				'stated 0 is never openable',
			);
		});
		it(`a string grant is coerced, never fails open`, () => {
			const self = {
				context: {
					request_config: [
						{
							api_engine: 'dedalo',
							sqo: {
								section_tipo: [
									{ tipo: UNREADABLE, permissions: '0' },
									{ tipo: READABLE, permissions: '1' },
								],
							},
						},
					],
				},
			};
			assert.isFalse(can_open_target(self, UNREADABLE), '"0" is a stated 0');
			assert.isTrue(can_open_target(self, READABLE), '"1" is readable');
		});
	});

	describe(`row pencil and edit_record_handler`, function () {
		let original_open = null;
		let opened = [];
		beforeEach(() => {
			opened = [];
			original_open = window.open;
			window.open = (url, target) => {
				const win = { closed: false, resizeTo() {}, focus() {} };
				opened.push({ url, target, win });
				return win;
			};
		});
		afterEach(() => {
			window.open = original_open;
		});

		it(`line view: the pencil renders only on a readable-target row`, () => {
			const self = stub_portal('line');
			const readable = view_line_edit_portal.render_column_id({
				caller: self,
				section_id: '1',
				section_tipo: READABLE,
			});
			const unreadable = view_line_edit_portal.render_column_id({
				caller: self,
				section_id: '1',
				section_tipo: UNREADABLE,
			});
			assert.isNotNull(readable.querySelector('button.button_edit'), 'readable target: pencil');
			assert.isNull(unreadable.querySelector('button.button_edit'), 'unreadable target: no pencil');
		});

		it(`default render_column_id: no open button on an unreadable-target row (id still shown)`, () => {
			const self = stub_portal('default');
			self.show_interface = { show_section_id: true };
			const readable = render_column_id({
				caller: self,
				section_id: '7',
				section_tipo: READABLE,
				drag: false,
			});
			const unreadable = render_column_id({
				caller: self,
				section_id: '7',
				section_tipo: UNREADABLE,
				drag: false,
			});
			assert.isNotNull(
				readable.querySelector('button.button_edit'),
				'readable target: open button',
			);
			assert.isNull(unreadable.querySelector('button.button_edit'), 'unreadable target: none');
			assert.equal(
				unreadable.querySelector('.section_id')?.textContent,
				'7',
				'the id stays visible',
			);
		});

		it(`default render_column_id: a section absent from the sqo keeps its button (context menu opens it)`, () => {
			const self = stub_portal('default');
			const fragment = render_column_id({
				caller: self,
				section_id: '7',
				section_tipo: 'test999',
				drag: false,
			});
			const button = fragment.querySelector('button.button_edit');
			assert.isNotNull(button, 'unknown section: button kept');
			button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
			assert.equal(opened.length, 1, 'the context menu opened the record window');
			assert.include(opened[0].url, 'tipo=test999');
		});

		it(`default render_column_id: the context-menu window refreshes the portal on return (row instances rebuilt)`, async () => {
			const self = stub_portal('default');
			const refreshes = [];
			self.refresh = async (options) => {
				refreshes.push(options);
				return true;
			};
			const fragment = render_column_id({
				caller: self,
				section_id: '7',
				section_tipo: READABLE,
				drag: false,
			});
			fragment
				.querySelector('button.button_edit')
				.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
			assert.equal(opened.length, 1, 'opened');
			// the user comes back to this window: open_window's focus fallback runs
			// on_blur once, after its debounce (RECORD_SAVE_DEBOUNCE_MS = 150)
			window.dispatchEvent(new Event('focus'));
			await new Promise((resolve) => setTimeout(resolve, 300));
			opened[0].win.closed = true; // let the watcher tear itself down
			assert.equal(refreshes.length, 1, 'the portal refreshed on return');
			// default destroy (true): kept row instances would show pre-edit data
			assert.notStrictEqual(refreshes[0].destroy, false, 'row instances are rebuilt');
			assert.strictEqual(refreshes[0].build_autoload, true);
		});

		it(`edit_record_handler refuses the unreadable target and opens the readable one`, async () => {
			const self = stub_portal('line');
			const handler = component_portal.prototype.edit_record_handler;

			const refused_window = await handler.call(self, {
				section_tipo: UNREADABLE,
				section_id: '1',
			});
			assert.isUndefined(refused_window, 'nothing opened for an unreadable target');
			assert.equal(opened.length, 0, 'window.open never called');

			const new_window = await handler.call(self, { section_tipo: READABLE, section_id: '1' });
			assert.isOk(new_window, 'the readable target opens');
			assert.equal(opened.length, 1);
			assert.include(opened[0].url, `tipo=${READABLE}`);
		});
	});

	describe(`a refused REFRESH of a live EMBEDDED instance`, function () {
		let original_request = null;
		let original_page_error;
		const built = [];

		beforeEach(() => {
			original_request = data_manager.request;
			original_page_error = page_globals.page_error;
			page_globals.page_error = null;
		});
		afterEach(async () => {
			data_manager.request = original_request;
			page_globals.page_error = original_page_error ?? null;
			while (built.length) {
				await built.pop().destroy(true, true, true);
			}
		});

		/** A rendered, attached test80 portal; `caller` undefined = a PAGE ROOT. */
		const live_portal = async (caller) => {
			const instance = await get_instance({
				model: 'component_portal',
				tipo: 'test80',
				section_tipo: 'test3',
				section_id: 1,
				mode: 'edit',
				view: 'line',
				lang: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
				id_variant: `target_access_${Math.random()}`,
				caller,
			});
			built.push(instance);
			assert.notEqual(await instance.build(true), false, 'the first build succeeds');
			const wrapper = await instance.render();
			document.getElementById('content').appendChild(wrapper);
			assert.equal(instance.status, 'rendered');
			// the row door fills content_data once it is in the DOM: wait for the
			// rows of the entries the read answered before snapshotting
			const content = wrapper.content_data;
			const entries = instance.data?.entries?.length ?? 0;
			const deadline = Date.now() + 5000;
			while (entries > 0 && content?.children.length === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
			return instance;
		};

		/** Every refusal toast published while `fn` runs, with the status at toast time. */
		const refusal_toasts = async (instance, fn) => {
			reset_error_dispatch_state();
			const seen = [];
			const token = event_manager.subscribe('notification', (payload) => {
				if (payload?.api_error?.request_id === 'rq-portal-refresh') {
					seen.push({ payload, status: instance.status });
				}
			});
			try {
				await fn();
			} finally {
				event_manager.unsubscribe(token);
			}
			return seen;
		};

		const embedded_caller = () => ({
			model: 'section',
			type: 'section',
			id: `fake_section_${Math.random()}`,
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'edit',
		});

		it(`keeps the last good render, injects no panel, and toasts the refusal`, async () => {
			const instance = await live_portal(embedded_caller());
			const wrapper = instance.node;
			const content_before = wrapper.content_data;
			assert.instanceOf(content_before, HTMLElement, 'the line view exposes its content_data');
			const rows_before = content_before.children.length;
			const content_html = content_before.innerHTML;
			const entries_before = instance.data?.entries?.length ?? 0;

			data_manager.request = async () => refused();
			let result;
			const toasts = await refusal_toasts(instance, async () => {
				result = await instance.refresh({ destroy: false, build_autoload: true });
			});

			assert.isFalse(result, 'refresh answers false');
			assert.equal(
				instance.status,
				'rendered',
				'status back to rendered: a later refresh can retry',
			);
			assert.isNull(wrapper.querySelector('.api_error_panel'), 'no page panel inside the portal');
			assert.isNull(
				wrapper.querySelector('.page_error_container'),
				'no page panel inside the portal',
			);
			assert.strictEqual(
				wrapper.content_data,
				content_before,
				'the rendered rows are the same node',
			);
			assert.isTrue(content_before.isConnected, 'still in the document');
			assert.equal(content_before.children.length, rows_before, 'every row kept');
			assert.equal(content_before.innerHTML, content_html, 'and unchanged');
			assert.equal(instance.data?.entries?.length ?? 0, entries_before, 'data kept');
			assert.isNull(page_globals.page_error, 'a refused refresh never sets the page slot');
			assert.equal(toasts.length, 1, 'the refusal is surfaced compactly (one toast)');
			// while the dispatch is pending (a relogin overlay can wait minutes) the
			// instance is NOT 'rendered': a concurrent refresh() would start a second build
			assert.equal(toasts[0].status, 'building', 'still building while the dispatch runs');

			// a later refresh is accepted again
			data_manager.request = original_request;
			assert.isTrue(
				await instance.refresh({ destroy: false, build_autoload: true }),
				'refresh retries',
			);
		});

		it(`a PAGE-ROOT instance keeps the page-scope failure (control)`, async () => {
			const instance = await live_portal(undefined);
			data_manager.request = async () => refused();
			const result = await instance.refresh({ destroy: false, build_autoload: true });
			assert.isFalse(result);
			assert.equal(instance.status, 'initialized', 'a page root is not a live refresh');
			assert.equal(page_globals.page_error?.code, 'perm.denied', 'its refusal is the page failure');
		});

		it(`portal navigate: a refused page turn restores the sqo it changed`, async () => {
			const instance = await live_portal(embedded_caller());
			const sqo_before = JSON.parse(JSON.stringify(instance.rqo.sqo));
			const total_before = instance.total;

			data_manager.request = async () => refused();
			const navigated = await instance.navigate({
				callback: () => {
					instance.rqo.sqo.offset = (instance.rqo.sqo.offset || 0) + 50;
				},
			});

			assert.isFalse(navigated, 'navigate answers false');
			assert.equal(instance.status, 'rendered');
			assert.deepEqual(
				JSON.parse(JSON.stringify(instance.rqo.sqo)),
				sqo_before,
				'the sqo describes the rows on screen again',
			);
			assert.equal(instance.total, total_before, 'total kept');
			assert.isNull(instance.node.querySelector('.api_error_panel'), 'no panel');
		});

		it(`section navigate (embedded list): a refused search restores its read state`, async () => {
			const section = await get_instance({
				model: 'section',
				tipo: 'test3',
				section_tipo: 'test3',
				mode: 'list',
				id_variant: `target_access_section_${Math.random()}`,
				caller: { model: 'inspector', id: 'fake_inspector_target_access' },
				session_save: false,
				buttons: false,
				filter: false,
			});
			built.push(section);
			assert.notEqual(await section.build(true), false, 'the first build succeeds');
			document.getElementById('content').appendChild(await section.render());
			assert.equal(section.status, 'rendered');

			// what search update_caller does: snapshot, then write the sqo BEFORE navigate
			const read_state = snapshot_read_state(section);
			const sqo_before = JSON.parse(JSON.stringify(section.rqo.sqo));
			section.total = null;
			section.rqo.sqo.offset = 0;
			section.rqo.sqo.filter = {
				$and: [{ q: 'never shown', path: [{ section_tipo: 'test3', component_tipo: 'test52' }] }],
			};

			data_manager.request = async () => refused();
			const navigated = await section.navigate({
				callback: null,
				navigation_history: true,
				action: 'search',
				read_state,
			});

			assert.isFalse(navigated, 'navigate answers false');
			assert.equal(section.status, 'rendered', 'the embedded list keeps its rows');
			assert.deepEqual(
				JSON.parse(JSON.stringify(section.rqo.sqo)),
				sqo_before,
				'the refused filter is not left in the sqo',
			);
			assert.equal(section.total, read_state.total, 'total restored');
			assert.isNull(section.node.querySelector('.api_error_panel'), 'no panel inside the list');
		});
	});

	describe(`a refused add_new_element (T0-2)`, function () {
		// The save is refused at the TRANSPORT (window.fetch stubbed for the
		// add_new_element body only), so the real data_manager runs: it publishes
		// 'api_error' and this block answers it exactly as page.js does
		// (page_scope:false). The test frame has no page instance of its own.
		let original_fetch = null;
		let page_token = null;
		const built = [];

		beforeEach(() => {
			original_fetch = window.fetch;
			reset_error_dispatch_state();
			page_token = event_manager.subscribe('api_error', (api_error) =>
				handle_api_error(api_error, { scope: 'page', page_scope: false }),
			);
		});
		afterEach(async () => {
			window.fetch = original_fetch;
			event_manager.unsubscribe(page_token);
			while (built.length) {
				await built.pop().destroy(true, true, true);
			}
		});

		const refuse_add_new_element = (code, status) => {
			window.fetch = async (url, init) => {
				if (typeof init?.body === 'string' && init.body.includes('"add_new_element"')) {
					return new Response(
						JSON.stringify({
							ok: false,
							request_id: 'rq-add-new-element',
							error: { code, message: `refused ${code}`, retryable: false },
						}),
						{ status, headers: { 'content-type': 'application/json' } },
					);
				}
				return original_fetch(url, init);
			};
		};

		/** Toasts carrying `code` published while `fn` runs. */
		const toasts_of = async (code, fn) => {
			const seen = [];
			const token = event_manager.subscribe('notification', (payload) => {
				if (payload?.api_error?.code === code) seen.push(payload);
			});
			try {
				await fn();
				await new Promise((resolve) => setTimeout(resolve, 150));
			} finally {
				event_manager.unsubscribe(token);
			}
			return seen;
		};

		const live_portal = async () => {
			const instance = await get_instance({
				model: 'component_portal',
				tipo: 'test80',
				section_tipo: 'test3',
				section_id: 1,
				mode: 'edit',
				view: 'line',
				lang: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
				id_variant: `add_new_refused_${Math.random()}`,
				caller: {
					model: 'section',
					type: 'section',
					id: `fake_section_${Math.random()}`,
					tipo: 'test3',
					section_tipo: 'test3',
					mode: 'edit',
				},
			});
			built.push(instance);
			assert.notEqual(await instance.build(true), false, 'the first build succeeds');
			document.getElementById('content').appendChild(await instance.render());
			assert.equal(instance.status, 'rendered');
			return instance;
		};

		for (const [code, status] of [
			['perm.denied', 403],
			['request.invalid_source', 400],
		]) {
			it(`${code}: one toast, render kept, created_section_id null`, async () => {
				const instance = await live_portal();
				const wrapper = instance.node;
				const entries_before = JSON.stringify(instance.data?.entries ?? []);
				const page_error_before = page_globals.page_error ?? null;

				refuse_add_new_element(code, status);
				let result;
				const toasts = await toasts_of(code, async () => {
					result = await instance.add_new_element('test3');
				});

				assert.isFalse(result, 'add_new_element answers false');
				assert.equal(toasts.length, 1, 'exactly ONE toast (never silent, never twice)');
				assert.isNull(instance.created_section_id, 'no created address');
				assert.strictEqual(instance.node, wrapper, 'same wrapper');
				assert.isTrue(wrapper.isConnected, 'still in the document');
				assert.equal(instance.status, 'rendered', 'render kept');
				assert.isNull(wrapper.querySelector('.api_error_panel'), 'no panel inside the portal');
				assert.isNull(
					wrapper.querySelector('.page_error_container'),
					'no page panel inside the portal',
				);
				assert.equal(
					JSON.stringify(instance.data?.entries ?? []),
					entries_before,
					'data untouched',
				);
				assert.strictEqual(
					page_globals.page_error ?? null,
					page_error_before,
					'page slot untouched',
				);
			});
		}

		it(`the "+" button opens no modal on a refusal`, async () => {
			const instance = await live_portal();
			instance.target_section = [{ tipo: 'test3', label: 'test3' }];
			const button = buttons.render_button_add(instance);

			const original_attach = ui.attach_to_modal;
			let modals = 0;
			ui.attach_to_modal = (...args) => {
				modals++;
				return original_attach.apply(ui, args);
			};
			refuse_add_new_element('perm.denied', 403);
			try {
				const toasts = await toasts_of('perm.denied', async () => {
					const settled = new Promise((resolve) => {
						const token = event_manager.subscribe('notification', () => {
							event_manager.unsubscribe(token);
							resolve();
						});
						setTimeout(resolve, 5000);
					});
					button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
					await settled;
				});
				assert.equal(toasts.length, 1, 'one toast');
				assert.equal(modals, 0, 'no modal opened');
				assert.isNull(instance.created_section_id);
			} finally {
				ui.attach_to_modal = original_attach;
			}
		});
	});
});
