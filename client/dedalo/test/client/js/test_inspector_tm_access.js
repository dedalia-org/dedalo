// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach, page_globals */
/*eslint no-undef: "error"*/

import { ApiError } from '../../../core/common/js/api_error.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { ui } from '../../../core/common/js/ui.js';
// (!) ORDER MATTERS: inspector.js first (see test_inspector_loading.js).
import '../../../core/inspector/js/inspector.js';
import {
	has_inspected_record,
	has_time_machine_access,
	load_component_history,
	load_time_machine_list,
	render_time_machine_blocks,
} from '../../../core/inspector/js/render_inspector.js';
import { section } from '../../../core/section/js/section.js';

/**
 * TEST_INSPECTOR_TM_ACCESS
 * The inspector's Latest changes / Component history blocks for a user WITHOUT
 * the section's history grant (WC-2026-10-22-tm-scope-whole-request).
 *
 * 1. THE GUARD: the server stamps context.config.time_machine_list per
 *    principal (null = no grant). Null → neither block is rendered and neither
 *    loader sends a dd15 request; a tipo → both blocks.
 * 2. A FAILED BUILD (the dd15 read refused anyway): the block shows ONE quiet
 *    panel-local line — never the page-level no-access panel (big icon, Home
 *    link) — and render() is never called on the failed instance.
 *
 * Backend-free: data_manager.request patched on the shared singleton.
 */

// load_block swaps the placeholder for the result on a requestAnimationFrame
const next_frame = () =>
	new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

describe(`INSPECTOR TIME MACHINE ACCESS`, function () {
	this.timeout(10000);

	let container = null;
	let original_request = null;
	let original_render = null;
	let original_page_error;
	let requests = [];
	let dd15_renders = 0;

	const make_self = (time_machine_list) => ({
		id: 'inspector_tm_access_test',
		section_tipo: 'test3',
		caller: {
			section_tipo: 'test3',
			section_id: 1,
			mode: 'edit',
			context: { config: { relation_list_tipo: null, time_machine_list } },
		},
	});

	beforeEach(() => {
		container = ui.create_dom_element({
			element_type: 'div',
			parent: document.getElementById('content'),
		});
		original_request = data_manager.request;
		original_render = section.prototype.render;
		original_page_error = page_globals.page_error;
		page_globals.page_error = null;
		requests = [];
		dd15_renders = 0;
		data_manager.request = async (options) => {
			requests.push(options.body);
			return {
				ok: false,
				request_id: 'rq-tm-access',
				error: new ApiError({
					code: 'perm.denied',
					status: 403,
					request_id: 'rq-tm-access',
					source: 'envelope',
				}),
			};
		};
		section.prototype.render = function (...args) {
			if (this.tipo === 'dd15') dd15_renders++;
			return original_render.apply(this, args);
		};
	});
	afterEach(() => {
		data_manager.request = original_request;
		section.prototype.render = original_render;
		page_globals.page_error = original_page_error;
		container.remove();
	});

	it(`the grant flag is the server's per-principal tipo, nothing else`, () => {
		assert.isTrue(has_time_machine_access(make_self('test3_tm')));
		assert.isFalse(has_time_machine_access(make_self(null)));
		assert.isFalse(has_time_machine_access(make_self('')));
		assert.isFalse(has_time_machine_access({ caller: { context: {} } }));
	});

	it(`null → no time machine blocks and no dd15 request`, async () => {
		const self = make_self(null);
		assert.isFalse(render_time_machine_blocks(self, container));
		assert.isNull(container.querySelector('.time_machine_list'));
		assert.isNull(container.querySelector('.component_history'));
		// every trigger the inspector fires (save, pagination, activation) finds no block
		assert.isNull(await load_time_machine_list(self, { reload: true }));
		assert.isNull(
			await load_component_history(self, { tipo: 'test52', section_tipo: 'test3', lang: 'lg-eng' }),
		);
		assert.equal(requests.length, 0, 'no request reached the server');
	});

	it(`a granted tipo → both blocks`, () => {
		const self = make_self('test3_tm');
		assert.isTrue(render_time_machine_blocks(self, container));
		assert.isOk(container.querySelector('.time_machine_list'));
		assert.isOk(container.querySelector('.component_history'));
	});

	it(`granted, but the edit view resolved no record → no block (nothing to inspect)`, () => {
		for (const section_id of [null, undefined, '']) {
			const self = make_self('test3_tm');
			self.caller.section_id = section_id;
			assert.isFalse(has_inspected_record(self), String(section_id));
			assert.isFalse(render_time_machine_blocks(self, container), String(section_id));
		}
		assert.isNull(container.querySelector('.time_machine_list'));
		const zero = make_self('test3_tm');
		zero.caller.section_id = 0;
		assert.isTrue(has_inspected_record(zero), '0 is a valid id');
	});

	it(`build() false → a quiet panel-local line, render() never called`, async () => {
		const self = make_self('test3_tm');
		render_time_machine_blocks(self, container);
		const body = self.time_machine_list_container;
		body.classList.remove('hide'); // the user opened the block

		const node = await load_time_machine_list(self, { reload: true });
		await next_frame();

		// the block's answer IS the quiet line, never a rendered instance node
		assert.isTrue(
			node?.classList?.contains('inspector_block_failure'),
			'the loader answered the quiet line',
		);
		assert.isAbove(requests.length, 0, 'the dd15 read was sent and refused');
		assert.equal(dd15_renders, 0, 'render() is never called on the failed instance');
		const line = body.querySelector('.inspector_block_failure');
		assert.isOk(line, 'the block holds the quiet failure line');
		assert.equal(line.title, 'request_id: rq-tm-access', 'request_id only in the tooltip');
		assert.notInclude(line.textContent, 'rq-tm-access');
		assert.isNull(body.querySelector('.page_error_container'), 'no page-level error panel');
		assert.isNull(body.querySelector('a'), 'no Home link');
		assert.isNull(page_globals.page_error, 'an embedded refusal never sets the page slot');

		if (self.tm_list) await self.tm_list.destroy(true, true);
	});

	it(`component history: same quiet line on a failed build`, async () => {
		const self = make_self('test3_tm');
		render_time_machine_blocks(self, container);
		const body = self.component_history_container;
		body.classList.remove('hide');

		const node = await load_component_history(
			self,
			{ tipo: 'test52', section_tipo: 'test3', lang: 'lg-eng' },
			{ reload: true },
		);
		await next_frame();

		assert.isTrue(
			node?.classList?.contains('inspector_block_failure'),
			'the loader answered the quiet line',
		);

		assert.equal(dd15_renders, 0, 'render() is never called on the failed instance');
		assert.isOk(body.querySelector('.inspector_block_failure'));
		assert.isNull(body.querySelector('.page_error_container'), 'no page-level error panel');

		if (self.component_history_list) await self.component_history_list.destroy(true, true);
	});
});
