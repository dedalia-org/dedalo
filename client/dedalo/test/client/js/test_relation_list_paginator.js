// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert */
/*eslint no-undef: "error"*/

import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';

/**
 * TEST_RELATION_LIST_PAGINATOR
 * The inspector's Relations panel pages through the SAME compact strip the
 * Latest changes panel renders ('« ‹ › » 1-10 of 405'): a real `paginator`
 * instance in 'mini' mode, never the bespoke Total/Page line it used to build.
 *
 * The interesting half is the wiring, not the look: the strip publishes
 * `paginator_goto_<paginator.id>`, relation_list turns that into the offset the
 * panel rebuilds from and republishes the panel's own
 * `relation_list_paginator_<section_tipo>` event. A missed subscription would
 * leave the arrows dead — which no layout check would catch.
 *
 * Backend-free: built with autoload=false and an explicit total, so no request.
 */

describe('RELATION_LIST — compact mini paginator', function () {
	this.timeout(10000);

	const KEY = 'test_relation_list_paginator_instance';
	let instance = null;
	let container = null;

	before(async () => {
		instance = await get_instance({
			model: 'relation_list',
			tipo: 'test3',
			section_tipo: 'test3',
			section_id: 1,
			mode: 'edit',
			total: 25, // 3 pages of 10: the strip has somewhere to go
			key: KEY,
		});
		await instance.build(false);

		container = document.createElement('div');
		document.getElementById('content').appendChild(container);
	});

	after(async () => {
		if (instance) {
			await instance.destroy(true, false, true);
		}
		if (container) {
			container.remove();
		}
	});

	it('renders the shared mini strip (row range, four arrows)', async () => {
		const wrapper = await instance.render();
		container.appendChild(wrapper);

		const strip = wrapper.querySelector(
			':scope > .paginator_container > .wrapper_paginator.paginator.mini',
		);
		assert.isOk(strip, 'the panel must render the shared paginator component in mini mode');

		const info = strip.querySelector('.paginator_info .page_info');
		assert.isOk(info, 'the strip must carry the row-range label');
		assert.match(info.textContent, /1-10\b.*\b25$/, 'the label is the page range and the total');

		assert.isOk(
			strip.querySelector('.btn.paginator_first_icon.inactive'),
			'on page 1 the first-page arrow is inactive',
		);
		assert.isOk(
			strip.querySelector('.btn.paginator_next_icon:not(.inactive)'),
			'on page 1 the next arrow is live',
		);
	});

	it('turns the page: publishes the panel event with the new offset', async () => {
		const strip = container.querySelector('.paginator_container');
		assert.isOk(strip, 'the strip is mounted');

		let published = null;
		const token = event_manager.subscribe('relation_list_paginator_test3', (relation_list) => {
			published = relation_list;
		});

		try {
			const next = strip.querySelector('.btn.paginator_next_icon');
			next.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			await Promise.resolve();

			assert.equal(instance.offset, 10, 'the next page starts at record 11');
			assert.isOk(published, 'the panel must be told to rebuild');
			assert.equal(published.offset, 10, 'the published offset is the new page position');
		} finally {
			event_manager.unsubscribe(token);
		}
	});
});

// @license-end
