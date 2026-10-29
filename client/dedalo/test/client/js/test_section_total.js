// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach */
/*eslint no-undef: "error"*/

import { data_manager } from '../../../core/common/js/data_manager.js';
import { section } from '../../../core/section/js/section.js';

/**
 * TEST_SECTION_TOTAL
 * section.get_total shares its pending count ONLY for the same query.
 *
 * A new search resets self.total while the previous filter's count can still be
 * in flight (a slow count: Activity, Time Machine). Reusing that promise, or
 * letting it land late, would paint the OLD filter's total under the new rows. Drives the shipped section.prototype.get_total; backend-free
 * (data_manager.request patched, each count resolved by hand).
 */

const make_section = () => {
	const instance = Object.create(section.prototype);
	Object.assign(instance, {
		id: 'section_total_test3',
		model: 'section',
		tipo: 'test3',
		section_tipo: 'test3',
		mode: 'list',
		lang: 'lg-eng',
		total: null,
		_total_promise: null,
		rqo: { sqo: { section_tipo: ['test3'], limit: 10, offset: 0, filter: null } },
	});
	return instance;
};

describe(`SECTION TOTAL`, function () {
	let original_request = null;
	let pending = []; // one {body, resolve(total)} per count sent

	beforeEach(() => {
		original_request = data_manager.request;
		pending = [];
		data_manager.request = (options) =>
			new Promise((resolve) => {
				pending.push({
					body: options.body,
					resolve: (total) => resolve({ ok: true, data: { total } }),
				});
			});
	});
	afterEach(() => {
		data_manager.request = original_request;
	});

	it(`two calls for the same query send ONE count and share it`, async () => {
		const s = make_section();
		const a = s.get_total();
		const b = s.get_total();
		assert.equal(pending.length, 1, 'one count request');
		pending[0].resolve(47);
		assert.equal(await a, 47);
		assert.equal(await b, 47);
		assert.equal(s.total, 47, 'cached');
		assert.equal(await s.get_total(), 47);
		assert.equal(pending.length, 1, 'the cached total sends nothing');
	});

	it(`a new search while the old count is in flight gets its OWN count, and the late old one is dropped`, async () => {
		const s = make_section();
		const old_count = s.get_total();

		// a new search (search.js): total reset, filter changed, rows re-read
		s.total = null;
		s.rqo.sqo.filter = { $and: [{ q: 'x' }] };
		const new_count = s.get_total();

		assert.equal(pending.length, 2, 'the new filter is counted, not joined to the old count');
		assert.deepEqual(pending[1].body.sqo.filter, s.rqo.sqo.filter);

		pending[1].resolve(3);
		assert.equal(await new_count, 3);
		pending[0].resolve(47); // the old filter's count lands last
		await old_count;

		assert.equal(s.total, 3, 'the superseded count does not overwrite the current total');
		assert.equal(await s.get_total(), 3);
	});
});

