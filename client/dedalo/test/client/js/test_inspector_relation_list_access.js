// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach, page_globals */
/*eslint no-undef: "error"*/

import { ApiError } from '../../../core/common/js/api_error.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { ui } from '../../../core/common/js/ui.js';
// (!) ORDER MATTERS: inspector.js first (see test_inspector_loading.js).
import '../../../core/inspector/js/inspector.js';
import {
	has_relation_list_access,
	render_inspector,
	render_relation_list,
} from '../../../core/inspector/js/render_inspector.js';
import { fetch_inverse_relations } from '../../../core/section/js/build_graph_data.js';

/**
 * TEST_INSPECTOR_RELATION_LIST_ACCESS
 * The inspector Relations block (WC-2026-10-27-relation-list-grant-stamp,
 * WC-2026-10-27-start-deep-link-record-scope).
 *
 * 1. THE GUARD: config.relation_list_tipo is stamped per principal (null = no
 *    grant) and a record-less edit view (section_id null) has nothing to list:
 *    either → no block — asserted on the inspector's own content build too.
 * 2. NO NULL PIN: relation_list.build() and the graph's fetch_inverse_relations
 *    with no record send nothing (the server rejects a null pin as request.invalid_rqo).
 * 3. A FAILED READ: build() → false, total 0 (the count never survives it),
 *    build_error set; the block shows ONE quiet .inspector_block_failure line —
 *    on first open AND on a page turn (never an empty page over total 0).
 *
 * Backend-free: data_manager.request patched on the shared singleton.
 */

const COLLAPSED_ID = 'inspector_relation_list';

const wait_for = async (predicate, timeout = 5000) => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeout) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
};

describe(`INSPECTOR RELATION LIST ACCESS`, function () {
	this.timeout(10000);

	let container = null;
	let original_request = null;
	let original_page_error;
	let requests = [];

	const make_self = (relation_list_tipo, section_id) => ({
		id: 'inspector_relation_list_access_test',
		section_tipo: 'test3',
		mode: 'edit',
		events_tokens: [],
		caller: {
			id: 'inspector_relation_list_access_caller',
			section_tipo: 'test3',
			section_id,
			mode: 'edit',
			context: { config: { relation_list_tipo, time_machine_list: null } },
		},
	});

	beforeEach(() => {
		container = ui.create_dom_element({
			element_type: 'div',
			parent: document.getElementById('content'),
		});
		original_request = data_manager.request;
		original_page_error = page_globals.page_error;
		page_globals.page_error = null;
		requests = [];
		// the count answers, the read is refused: the count must not survive it
		data_manager.request = async (options) => {
			requests.push(options.body);
			if (options.body?.action === 'count') {
				return { ok: true, request_id: 'rq-rl-count', data: { total: 7 } };
			}
			return {
				ok: false,
				request_id: 'rq-rl-access',
				error: new ApiError({
					code: 'perm.denied',
					status: 403,
					request_id: 'rq-rl-access',
					source: 'envelope',
				}),
			};
		};
	});
	afterEach(async () => {
		data_manager.request = original_request;
		page_globals.page_error = original_page_error;
		container.remove();
		// the block's open/closed memory is per browser: leave none behind
		await data_manager.delete_local_db_data(COLLAPSED_ID, 'status');
	});

	it(`the block needs the server's per-principal tipo AND a record`, () => {
		assert.isTrue(has_relation_list_access(make_self('test3_rl', 1)));
		assert.isTrue(has_relation_list_access(make_self('test3_rl', 0)), '0 is a valid id');
		assert.isFalse(has_relation_list_access(make_self(null, 1)), 'not granted');
		assert.isFalse(has_relation_list_access(make_self('', 1)));
		assert.isFalse(has_relation_list_access(make_self('test3_rl', null)), 'no record');
		assert.isFalse(has_relation_list_access(make_self('test3_rl', undefined)));
		assert.isFalse(has_relation_list_access(make_self('test3_rl', '')));
		assert.isFalse(has_relation_list_access({ caller: { context: {} } }));
	});

	it(`the inspector content mounts the block only with a grant and a record`, async () => {
		const mounted = async (relation_list_tipo, section_id) => {
			const self = make_self(relation_list_tipo, section_id);
			Object.assign(self.caller, { tools: [], get_all_target_sections: () => [] });
			Object.assign(self.caller.context, { buttons: [], tools: [] });
			const content = await render_inspector.prototype.edit.call(self, {
				render_level: 'content',
			});
			for (const token of self.events_tokens) event_manager.unsubscribe(token);
			return content.querySelector('.relation_list_container') !== null;
		};
		assert.deepEqual(
			{
				granted: await mounted('test3_rl', 1),
				no_grant: await mounted(null, 1),
				no_record: await mounted('test3_rl', null),
			},
			{ granted: true, no_grant: false, no_record: false },
		);
	});

	it(`relation_list.build() with no record → false, no request`, async () => {
		const relation_list = await get_instance({
			model: 'relation_list',
			tipo: 'test3_rl',
			section_tipo: 'test3',
			section_id: null,
			mode: 'edit',
		});
		assert.isFalse(await relation_list.build());
		assert.equal(requests.length, 0, 'no null pin reached the server');
		assert.isNotOk(relation_list.build_error, 'no record is not a failure');
		await relation_list.destroy(true, true);
	});

	it(`a refused read → build false, total 0, build_error set`, async () => {
		const relation_list = await get_instance({
			model: 'relation_list',
			tipo: 'test3_rl',
			section_tipo: 'test3',
			section_id: 1,
			mode: 'edit',
		});
		assert.isFalse(await relation_list.build());
		assert.isAbove(requests.length, 0, 'the read was sent and refused');
		assert.equal(relation_list.total, 0, 'the count total did not survive the failed read');
		assert.equal(relation_list.build_error?.code, 'perm.denied');
		await relation_list.destroy(true, true);
	});

	it(`the inspector block paints one quiet line on a refused read`, async () => {
		const self = make_self('test3_rl', 2);
		const block = render_relation_list(self);
		container.appendChild(block);
		block.querySelector('.relation_list_head').click(); // the user opens the block
		const body = block.querySelector('.relation_list_body');
		assert.isTrue(
			await wait_for(() => body.querySelector('.inspector_block_failure') !== null),
			'the quiet failure line was painted',
		);
		const line = body.querySelector('.inspector_block_failure');
		assert.equal(line.title, 'request_id: rq-rl-access', 'request_id only in the tooltip');
		assert.isNull(body.querySelector('.page_error_container'), 'no page-level error panel');
		assert.isNull(page_globals.page_error, 'an embedded refusal never sets the page slot');
		const relation_list = await get_instance({
			model: 'relation_list',
			tipo: 'test3_rl',
			section_tipo: 'test3',
			section_id: 2,
			mode: 'edit',
		});
		await relation_list.destroy(true, true);
	});

	it(`a page turn whose read is refused paints the quiet line`, async () => {
		const refused_request = data_manager.request;
		let refuse = false;
		data_manager.request = async (options) =>
			refuse || options.body?.action === 'count'
				? refused_request(options)
				: (requests.push(options.body), { ok: true, data: { context: [], data: [] } });
		const self = make_self('test3_rl', 3);
		const block = render_relation_list(self);
		container.appendChild(block);
		block.querySelector('.relation_list_head').click();
		const body = block.querySelector('.relation_list_body');
		const relation_list = await get_instance({
			model: 'relation_list',
			tipo: 'test3_rl',
			section_tipo: 'test3',
			section_id: 3,
			mode: 'edit',
		});
		assert.isTrue(
			await wait_for(() => relation_list.status === 'rendered' && !body.hasAttribute('aria-busy')),
			'the first page rendered',
		);
		assert.isNull(body.querySelector('.inspector_block_failure'));
		refuse = true; // the grant is revoked mid-session
		event_manager.publish('relation_list_paginator_test3', relation_list);
		assert.isTrue(
			await wait_for(() => body.querySelector('.inspector_block_failure') !== null),
			'the refused turn reached the failure line',
		);
		for (const token of self.events_tokens) event_manager.unsubscribe(token);
		await relation_list.destroy(true, true);
	});

	it(`the graph's inverse fetch with no record → empty, no request`, async () => {
		const graph_self = { context: { config: { relation_list_tipo: 'test3_rl' } } };
		const empty = { nodes: [], links: [], total: 0, loaded: 0 };
		assert.deepEqual(await fetch_inverse_relations(graph_self, 'test3', null), empty);
		assert.deepEqual(await fetch_inverse_relations(graph_self, 'test3', undefined), empty);
		assert.equal(requests.length, 0, 'no null pin reached the server');
	});
});
