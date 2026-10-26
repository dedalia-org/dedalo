// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, beforeEach, afterEach, assert */
/*eslint no-undef: "error"*/

import { event_manager } from '../../../core/common/js/event_manager.js';
import { paginator } from '../../../core/paginator/js/paginator.js';

/**
 * TEST_PAGINATOR_PAGE_TURN
 * What a page turn measures for its height FLIP (paginator.paginate →
 * smooth_page_swap): the rows container (`.list_body`) when it has a box, and
 * the caller's own node when it does not.
 *
 * The second case is the inspector's Component history: its `.list_body` is
 * `display: contents` and measures 0, so the old code bailed out of the
 * animation entirely while Latest changes and Relations animated. That made the
 * three panels page differently.
 *
 * Backend-free: a synthetic caller node + a paginator driven through the real
 * paginate() path, with Element.animate recorded instead of played.
 */

describe('PAGINATOR — page-turn height FLIP target', function () {
	this.timeout(10000);

	let caller = null;
	let paginator_instance = null;
	let original_animate = null;
	const animate_calls = [];

	beforeEach(() => {
		animate_calls.length = 0;
		original_animate = Element.prototype.animate;
		Element.prototype.animate = function (...args) {
			animate_calls.push({ node: this, from: args[0]?.[0]?.height, to: args[0]?.[1]?.height });
			return original_animate.apply(this, args);
		};

		const node = document.createElement('div');
		node.style.cssText = 'position:fixed;left:-9999px;top:0;width:100px;';
		document.body.appendChild(node);

		caller = {
			id: 'test_paginator_page_turn_' + Math.random().toString(36).slice(2),
			model: 'section',
			status: 'rendered',
			node,
		};

		paginator_instance = new paginator();
		paginator_instance.init({ caller, mode: 'mini' });
		paginator_instance.status = 'rendered';
		paginator_instance.node = document.createElement('div');
	});

	afterEach(async () => {
		Element.prototype.animate = original_animate;
		await paginator_instance.destroy();
		caller.node.remove();
	});

	// one page turn: paginate from the current height, then deliver the new page
	const turn_page = async (height_node, height_after) => {
		paginator_instance.paginate(10);
		height_node.style.height = height_after;
		event_manager.publish('render_' + caller.id, caller.node);
		await Promise.resolve();
	};

	it('animates the list_body when it has a box (Latest changes)', async () => {
		caller.node.style.height = '40px';
		const list_body = document.createElement('div');
		list_body.className = 'list_body';
		list_body.style.height = '40px';
		caller.node.appendChild(list_body);

		await turn_page(list_body, '90px');

		assert.equal(animate_calls.length, 1, 'the page turn must animate one height change');
		assert.equal(animate_calls[0].node, list_body, 'the rows container is the animated node');
		assert.equal(animate_calls[0].from, '40px');
		assert.equal(animate_calls[0].to, '90px');
	});

	it('falls back to the caller node when list_body is display:contents (Component history)', async () => {
		caller.node.style.height = '40px';
		const list_body = document.createElement('div');
		list_body.className = 'list_body';
		list_body.style.display = 'contents';
		list_body.innerHTML = '<div style="height:40px">row</div>';
		caller.node.appendChild(list_body);

		assert.equal(
			Math.round(list_body.getBoundingClientRect().height),
			0,
			'the premise: a display:contents list_body measures 0',
		);

		await turn_page(caller.node, '90px');

		assert.equal(animate_calls.length, 1, 'the page turn must still animate');
		assert.equal(
			animate_calls[0].node,
			caller.node,
			'the caller node is the animated node when the list_body has no box',
		);
		assert.equal(animate_calls[0].from, '40px');
		assert.equal(animate_calls[0].to, '90px');
	});

	it('ignores a .list_body nested below the caller (an edit section contains the inspector)', async () => {
		caller.node.style.height = '40px';
		const inspector = document.createElement('div');
		inspector.className = 'inspector';
		const nested = document.createElement('div');
		nested.className = 'list_body';
		nested.style.height = '40px';
		inspector.appendChild(nested);
		caller.node.appendChild(inspector);

		await turn_page(caller.node, '90px');

		assert.equal(animate_calls.length, 1, 'the page turn must animate the section, not a panel');
		assert.equal(
			animate_calls[0].node,
			caller.node,
			'a nested list_body belongs to an inspector panel and must not be animated',
		);
	});
});

// @license-end
