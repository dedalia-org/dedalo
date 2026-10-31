// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert */
/*eslint no-undef: "error"*/

import { data_manager } from '../../../core/common/js/data_manager.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { create_row_window, ROW_WINDOW_MAX_ROWS } from '../../../core/common/js/row_window.js';
import {
	bound_sqo_limit,
	ENGINE_DEFAULT_MAX_LIMIT,
	max_page_limit,
} from '../../../core/common/js/sqo_limit.js';
import * as touch_pick from '../../../core/common/js/touch_pick.js';
import { ui } from '../../../core/common/js/ui.js';
import { PORTAL_ROW_MIME } from '../../../core/component_portal/js/drag_and_drop.js';
import { ts_object } from '../../../core/ts_object/js/ts_object.js';

/**
 * TEST_RENDER_BUDGET
 * The browser must not build without bound (audit P2-31 / CLI-29 / CLI-30).
 *
 * The behavioural half of test/unit/client_render_budget_native.test.ts: a list
 * handed RENDER_BUDGET_ENTRIES (5,000) locator entries keeps ONE section_record
 * per entry in content_data (the record window's row invariant,
 * engineering/wire_contract/WC-2026-10-30-section-record-row-box.md), builds
 * at most ROW_WINDOW_MAX_ROWS of them (the rest are childless placeholders) and
 * registers exactly the built rows; each portal EDIT view (the show-all door)
 * and both tool mosaics do the same, and the tool mosaics stay drag sources; a
 * thesaurus node handed 5,000 children materializes at most
 * ROW_WINDOW_MAX_ROWS of them (its own row_window); revealing the LAST row
 * still respects the bound and a released row takes its record out of
 * ar_instances; destroying the owner destroys the window. The entries are synthetic on
 * purpose: a real server page is capped at DEDALO_SEARCH_CLIENT_MAX_LIMIT
 * (DEC-07, 1000), so the renderer's own bound is proved with in-browser
 * entries — the server's bound is the sqo/children-door gates' business.
 *
 * Plus the client limit bound (sqo_limit.js): the page_globals ceiling is what
 * the server published, bound_sqo_limit never yields 0, and the two suites that
 * used to send 0 now send the ceiling (test_component_portal_pagination,
 * test_open_related_data).
 *
 * Runs on the SUITE database: the list block builds the real test3 section
 * (context + columns from the server) and then REPLACES its page with the
 * synthetic entries; the tree block mocks data_manager.request the way
 * test_ts_object does (node fixtures, no server), restored in after().
 */

// RENDER_BUDGET_ENTRIES. The bun half reads this constant: it must be >= 5000.
const RENDER_BUDGET_ENTRIES = 5000;

// DOM container
const container = document.getElementById('content');
const test_container = ui.create_dom_element({
	element_type: 'div',
	class_name: 'container render_budget',
	parent: container,
});

describe('RENDER BUDGET — sqo_limit', () => {
	it('max_page_limit is the SERVER ceiling published in page_globals, a positive integer', () => {
		assert.equal(
			typeof page_globals.dedalo_search_client_max_limit,
			'number',
			'page_globals.dedalo_search_client_max_limit must be served (WC-2026-09-04-client-limit-bound)',
		);
		assert.equal(max_page_limit(), page_globals.dedalo_search_client_max_limit);
		assert.equal(Number.isInteger(max_page_limit()) && max_page_limit() >= 1, true);
	});

	it('bound_sqo_limit never yields 0 or more than the ceiling', () => {
		const max = max_page_limit();
		assert.equal(bound_sqo_limit(0), max, '0 ("all") is the ceiling');
		assert.equal(bound_sqo_limit(-5), max);
		assert.equal(bound_sqo_limit('all'), max);
		assert.equal(bound_sqo_limit(undefined), max);
		assert.equal(bound_sqo_limit(max + 1), max);
		assert.equal(bound_sqo_limit(10), 10, 'a page size within the bound passes through');
		assert.equal(bound_sqo_limit('7'), 7);
	});

	it('a page without the key falls back LOUDLY to the engine default', () => {
		const saved = page_globals.dedalo_search_client_max_limit;
		const errors = [];
		const original_error = console.error;
		console.error = (...args) => errors.push(args);
		try {
			page_globals.dedalo_search_client_max_limit = undefined;
			assert.equal(max_page_limit(), ENGINE_DEFAULT_MAX_LIMIT);
			assert.equal(errors.length >= 1, true, 'the fallback must be reported, never silent');
		} finally {
			console.error = original_error;
			page_globals.dedalo_search_client_max_limit = saved;
		}
	});
});

describe('RENDER BUDGET — row_window (pure)', () => {
	it(`materializes at most ROW_WINDOW_MAX_ROWS of ${RENDER_BUDGET_ENTRIES} items, and reveal keeps the bound`, async () => {
		const host = ui.create_dom_element({
			element_type: 'div',
			parent: test_container,
		});
		const items = Array.from({ length: RENDER_BUDGET_ENTRIES }, (_, i) => ({ i }));
		let built = 0;
		let released = 0;
		const owner = {};
		const row_window = create_row_window({
			owner: owner,
			container: host,
			items: items,
			materialize: (item) => {
				built++;
				const node = document.createElement('div');
				node.className = 'budget_row';
				node.dataset.i = item.i;
				return node;
			},
			release: () => {
				released++;
			},
		});
		await row_window.fill();

		assert.equal(owner.row_window, row_window, 'the window is stored on its owner');
		assert.equal(host.querySelectorAll('.budget_row').length, ROW_WINDOW_MAX_ROWS);
		assert.equal(built, ROW_WINDOW_MAX_ROWS);
		assert.equal(row_window.range().total, RENDER_BUDGET_ENTRIES);
		assert.equal(row_window.range().end, ROW_WINDOW_MAX_ROWS);
		assert.equal(
			host.querySelector('.row_window_spacer.bottom').hidden,
			false,
			'the rows not built are represented by the spacer',
		);

		// reveal the LAST item: the window re-centres, the bound holds
		const last = await row_window.reveal(RENDER_BUDGET_ENTRIES - 1);
		assert.equal(last instanceof Element, true);
		assert.equal(last.dataset.i, String(RENDER_BUDGET_ENTRIES - 1));
		assert.equal(
			host.querySelectorAll('.budget_row').length <= ROW_WINDOW_MAX_ROWS,
			true,
			'reveal must not grow the window past the bound',
		);
		assert.equal(released, ROW_WINDOW_MAX_ROWS, 'the first window was released');
		assert.equal(host.querySelector('.row_window_spacer.bottom').hidden, true);
		assert.equal(host.querySelector('.row_window_spacer.top').hidden, false);

		// append extends the total without exceeding the bound
		await row_window.append([{ i: RENDER_BUDGET_ENTRIES }]);
		assert.equal(row_window.range().total, RENDER_BUDGET_ENTRIES + 1);
		assert.equal(host.querySelectorAll('.budget_row').length <= ROW_WINDOW_MAX_ROWS, true);

		// destroy disconnects and forgets
		row_window.destroy();
		assert.equal(owner.row_window, null);
		assert.equal(host.querySelector('.row_window_spacer'), null, 'spacers leave with the window');
	});

	it('a caller may LOWER max_rows, never raise it', async () => {
		const host = ui.create_dom_element({ element_type: 'div', parent: test_container });
		const items = Array.from({ length: 50 }, (_, i) => ({ i }));
		const lowered = create_row_window({
			container: host,
			items: items,
			max_rows: 5,
			materialize: () => document.createElement('div'),
		});
		await lowered.fill();
		assert.equal(host.children.length - 2, 5, '5 rows + 2 spacers');
		lowered.destroy();
		const raised = create_row_window({
			container: host,
			items: items,
			max_rows: ROW_WINDOW_MAX_ROWS * 10,
			materialize: () => document.createElement('div'),
		});
		assert.equal(raised.max_rows, ROW_WINDOW_MAX_ROWS);
		raised.destroy();
	});
});

/**
 * RECORD WINDOW HELPERS
 * The section, portal and tool-mosaic blocks below measure the RECORD window
 * (section_record/js/record_window.js, stored by the section.js door as
 * `owner.record_windows.rows`), whose row invariant is the contract of
 * engineering/wire_contract/WC-2026-10-30-section-record-row-box.md:
 * `content_data.children` is exactly one `.section_record` per entry, child i
 * carrying `data-index="i"`; at most ROW_WINDOW_MAX_ROWS of them are BUILT rows,
 * the rest are childless `.placeholder` rows. There is no spacer any more
 * (`.row_window_spacer` is the thesaurus tree's own row_window, below).
 */

/**
 * SYNTHETIC_ENTRIES
 * 5,000 locators of the generic test section. The datum holds no data for
 * them: every cell renders empty, which is exactly the cost this measures
 * (instances + DOM per row, not values).
 * @returns {Object[]}
 */
const synthetic_entries = () =>
	Array.from({ length: RENDER_BUDGET_ENTRIES }, (_, i) => ({
		section_tipo: 'test3',
		section_id: i + 1,
		paginated_key: i,
	}));

/**
 * WAIT_UNTIL
 * Polls `predicate` every 50ms; resolves true once it holds, false after `ms`.
 * @param {Function} predicate
 * @param {number} [ms=5000]
 * @returns {Promise<boolean>}
 */
const wait_until = async (predicate, ms = 5000) => {
	const started = performance.now();
	while (!predicate()) {
		if (performance.now() - started > ms) {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
};

/**
 * ROW_INSTANCES
 * The owner's registered row records. The door pushes every built row into
 * `owner.ar_instances` and a released row's destroy takes it out again.
 * @param {Object} owner
 * @returns {Object[]}
 */
const row_instances = (owner) => (owner.ar_instances || []).filter((el) => el.model === 'section_record');

/**
 * ASSERT_RECORD_WINDOW
 * The invariant of one owner's `rows` window over the 5,000-entry page.
 * @param {Object} owner - section / component_portal instance
 * @param {HTMLElement} content_data
 * @returns {{record_window: Object, built: number[]}} the window and its built indexes
 */
const assert_record_window = (owner, content_data) => {
	const record_window = owner.record_windows?.rows;
	assert.equal(Boolean(record_window), true, 'the view did not open a record window (record_windows.rows)');
	assert.equal(record_window.size, RENDER_BUDGET_ENTRIES, 'the window holds every entry');

	const children = Array.from(content_data.children);
	assert.equal(
		children.length,
		RENDER_BUDGET_ENTRIES,
		`content_data has ${children.length} children for ${RENDER_BUDGET_ENTRIES} entries: one row per entry, nothing else`,
	);

	const built = [];
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!child.classList.contains('section_record') || child.dataset.index !== String(i)) {
			assert.fail(`child ${i} is not the section_record of index ${i} (${child.className} / ${child.dataset.index})`);
		}
		if (child.classList.contains('placeholder')) {
			if (child.childNodes.length !== 0) {
				assert.fail(`placeholder ${i} is not a leaf (${child.childNodes.length} child nodes)`);
			}
		} else {
			built.push(i);
		}
	}
	assert.equal(built.length > 0, true, 'the first window must be built when render resolves');
	assert.equal(
		built.length <= ROW_WINDOW_MAX_ROWS,
		true,
		`built ${built.length} rows for a ${RENDER_BUDGET_ENTRIES}-entry page; the bound is ${ROW_WINDOW_MAX_ROWS}`,
	);
	for (const i of built) {
		if (!record_window.is_built(i)) {
			assert.fail(`row ${i} is in the DOM as a built row but the window says it is not built`);
		}
	}

	// the registered rows ARE the built rows: no released row's record lingers
	const instances = row_instances(owner);
	assert.equal(
		instances.length,
		built.length,
		`ar_instances holds ${instances.length} section_records for ${built.length} built rows`,
	);
	for (const i of built) {
		if (!instances.includes(record_window.record_at(i))) {
			assert.fail(`the record of built row ${i} is not in ar_instances`);
		}
	}

	assert.equal(
		(owner.node || content_data).querySelector('.row_window_spacer'),
		null,
		'no .row_window_spacer: the record window keeps one placeholder per unbuilt row',
	);

	return { record_window, built };
};

/**
 * ASSERT_REVEAL
 * reveal(n) builds children[n] in place (the neighbours keep their indexes),
 * keeps the bound, and the rows it releases to get back under it take their
 * records out of ar_instances.
 * @param {Object} owner
 * @param {HTMLElement} content_data
 * @param {number} index
 * @returns {Promise<number[]>} the built indexes after the reveal
 */
const assert_reveal = async (owner, content_data, index) => {
	const record_window = owner.record_windows.rows;
	const before = new Map();
	for (let i = 0; i < record_window.size; i++) {
		const instance = record_window.record_at(i);
		if (instance) {
			before.set(i, instance);
		}
	}
	const was_built = record_window.is_built(index);

	await record_window.reveal(index);
	await record_window.idle();

	const node = content_data.children[index];
	assert.equal(record_window.is_built(index), true, `row ${index} must be built after reveal`);
	assert.equal(node.classList.contains('placeholder'), false, `children[${index}] is still a placeholder`);
	assert.equal(node.dataset.index, String(index));
	if (index > 0) {
		assert.equal(content_data.children[index - 1].dataset.index, String(index - 1), 'the previous neighbour moved');
	}
	if (index < RENDER_BUDGET_ENTRIES - 1) {
		assert.equal(content_data.children[index + 1].dataset.index, String(index + 1), 'the next neighbour moved');
	}

	const { built } = assert_record_window(owner, content_data);

	// a reveal past a full window builds one row over the bound: the window
	// releases back under it, and every released record leaves ar_instances
	const released = [...before.keys()].filter((i) => !record_window.is_built(i));
	if (!was_built && before.size === ROW_WINDOW_MAX_ROWS) {
		assert.equal(released.length > 0, true, 'a reveal over a full window must release rows');
	}
	const instances = row_instances(owner);
	for (const i of released) {
		assert.equal(content_data.children[i].classList.contains('placeholder'), true, `released row ${i} is not a placeholder`);
		assert.equal(instances.includes(before.get(i)), false, `the released record of row ${i} is still in ar_instances`);
	}
	assert.equal(built.includes(index), true);
	return built;
};

/**
 * ASSERT_FAR_SCROLL
 * Scrolling far placeholders into view builds them through the window's
 * IntersectionObserver; once the built rows pass the bound the far-away rows
 * are released and their records leave ar_instances.
 * @param {Object} owner
 * @param {HTMLElement} content_data
 * @returns {Promise<number>} how many of the rows built before the scroll were released
 */
const assert_far_scroll = async (owner, content_data) => {
	const record_window = owner.record_windows.rows;
	const before = new Map();
	for (let i = 0; i < record_window.size; i++) {
		const instance = record_window.record_at(i);
		if (instance) {
			before.set(i, instance);
		}
	}

	const targets = [1000, 1800, 2600, 3400, 4200];
	for (const target of targets) {
		content_data.children[target].scrollIntoView({ block: 'center' });
		const reached = await wait_until(() => record_window.is_built(target));
		assert.equal(reached, true, `scrolling row ${target} into view did not build it`);
		await record_window.idle();
	}

	const released = [...before.keys()].filter((i) => !record_window.is_built(i));
	assert.equal(released.length > 0, true, 'a far scroll past the bound must release rows');
	const instances = row_instances(owner);
	for (const i of released) {
		assert.equal(instances.includes(before.get(i)), false, `the released record of row ${i} is still in ar_instances`);
	}
	assert_record_window(owner, content_data);
	window.scrollTo(0, 0);
	return released.length;
};

describe('RENDER BUDGET — section list view', function () {
	this.timeout(60000);

	let section;
	let content_data;

	it(`a ${RENDER_BUDGET_ENTRIES}-row page keeps one row per entry and builds at most ROW_WINDOW_MAX_ROWS`, async () => {
		section = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'list',
			id_variant: 'render_budget',
		});
		await section.build(true);

		section.data = section.data || {};
		section.data.entries = synthetic_entries();

		const node = await section.render();
		test_container.appendChild(node);

		content_data = node.content_data || node.querySelector('.content_data');
		assert.equal(content_data instanceof Element, true, 'content_data expected');
		assert_record_window(section, content_data);
	});

	it('reveal(n) builds children[n] in place, keeps the bound and releases into ar_instances', async () => {
		const last = await assert_reveal(section, content_data, RENDER_BUDGET_ENTRIES - 1);
		assert.equal(last.includes(RENDER_BUDGET_ENTRIES - 1), true);
		const middle = Math.floor(RENDER_BUDGET_ENTRIES / 2);
		const built = await assert_reveal(section, content_data, middle);
		assert.equal(built.includes(middle) && built.length <= ROW_WINDOW_MAX_ROWS, true);
	});

	it('a far scroll builds through the observer and releases far rows', async () => {
		const released = await assert_far_scroll(section, content_data);
		assert.equal(released > 0, true, 'the far scroll released no row');
	});

	it('destroying the section destroys the window', async () => {
		await section.destroy(true, true, true);
		assert.equal(section.record_windows, null);
		assert.equal(row_instances(section).length, 0);
	});
});

/**
 * PORTAL EDIT VIEWS
 * The paginator — hence "show all", the ceiling page — exists only in portal
 * EDIT mode (component_portal.js build), so the edit views are the door CLI-29
 * reproduced through. Each one is built for real on the suite database (test3
 * record 2, portal test80) and then handed the synthetic page. The mosaic's
 * hover and alt records are built ON DEMAND (row_hover.js / the 'alt' slot),
 * so every view registers exactly one record per built row.
 */
const PORTAL_EDIT_VIEWS = ['default', 'content', 'line', 'tree', 'indexation', 'mosaic'];

for (const portal_view of PORTAL_EDIT_VIEWS) {
	describe(`RENDER BUDGET — portal edit view ${portal_view}`, function () {
		this.timeout(60000);

		let component;
		let content_data;

		it(`a ${RENDER_BUDGET_ENTRIES}-row page keeps one row per entry and builds at most ROW_WINDOW_MAX_ROWS`, async () => {
			component = await get_instance({
				model: 'component_portal',
				tipo: 'test80',
				section_tipo: 'test3',
				section_id: 2,
				mode: 'edit',
				view: portal_view,
				id_variant: `render_budget_${portal_view}`,
			});
			await component.build(true);
			// the dispatcher reads self.view || self.context.view
			component.view = portal_view;
			if (component.context) {
				component.context.view = portal_view;
			}

			component.data = component.data || {};
			component.data.entries = synthetic_entries();

			const node = await component.render();
			test_container.appendChild(node);

			content_data = node.content_data || node.querySelector('.content_data');
			assert.equal(content_data instanceof Element, true, 'content_data expected');
			assert_record_window(component, content_data);
		});

		it('reveal(n) builds children[n] in place, keeps the bound and releases into ar_instances', async () => {
			const built = await assert_reveal(component, content_data, RENDER_BUDGET_ENTRIES - 1);
			assert.equal(built.includes(RENDER_BUDGET_ENTRIES - 1) && built.length <= ROW_WINDOW_MAX_ROWS, true);
		});

		it('destroying the portal destroys the window', async () => {
			await component.destroy(true, true, true);
			assert.equal(component.record_windows, null);
			assert.equal(row_instances(component).length, 0);
		});
	});
}

/**
 * TOOL MOSAIC VIEWS
 * The two mosaics a TOOL injects through `render_views` — outside the core
 * view files, on the same 1000-row page (audit P2-31 residue). Same
 * measurement as PORTAL_EDIT_VIEWS above (the hover overlay is built on demand
 * by row_hover.js, so one record per built row), plus the drag source they
 * exist for: outside edit mode, without paginator or `draggable_to`, the tile
 * IS the source (drag_and_drop.js bind_tool_row_drag, TOOL_ROW_SOURCES).
 *
 * Two hosts, because that is what the two tools are:
 *   - tool_cataloging's mosaic is a SECTION view in list mode (it reads the
 *     ordinary list's saved pagination key); its card is dropped on a
 *     thesaurus ts_object term (payload `caller: 'tool_cataloging'`);
 *   - the coins mosaic is a component_portal EDIT view (behind "show all").
 * Each is registered on the instance exactly as its tool registers it — a
 * render_views entry with the module path — and then handed the synthetic page.
 *
 * (!) Their own info columns (the cataloging drag handle, the coins
 * original/copy control) are callback columns bound to their tool's caller,
 * which this generic test3 situation does not provide. section_record's
 * render_callback CATCHES a throwing callback and renders the column empty, so
 * the row still builds and the count this block measures is unaffected.
 * Building a tool caller here would mean naming an install's tipos, which a
 * generic gate never does.
 */
const TOOL_MOSAIC_VIEWS = [
	{
		host: 'section',
		mode: 'list',
		view: 'tool_cataloging_mosaic',
		render: 'view_tool_cataloging_mosaic',
		path: '../../../tools/tool_cataloging/js/view_tool_cataloging_mosaic.js',
		caller_name: 'tool_cataloging',
	},
	{
		host: 'portal',
		mode: 'edit',
		view: 'coins_mosaic',
		render: 'view_coins_mosaic_portal',
		path: '../../../tools/tool_numisdata_order_coins/js/view_coins_mosaic_portal.js',
		caller_name: null,
	},
];

/**
 * DRAGSTART_ON
 * A real DragEvent with a real DataTransfer, dispatched on the row node.
 * @param {HTMLElement} node
 * @returns {{event: DragEvent, data_transfer: DataTransfer}}
 */
const dragstart_on = (node) => {
	const data_transfer = new DataTransfer();
	const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
	node.dispatchEvent(event);
	return { event, data_transfer };
};

for (const mosaic_view of TOOL_MOSAIC_VIEWS) {
	describe(`RENDER BUDGET — tool mosaic view ${mosaic_view.view}`, function () {
		this.timeout(60000);

		let instance;
		let content_data;

		it(`a ${RENDER_BUDGET_ENTRIES}-row page keeps one row per entry and builds at most ROW_WINDOW_MAX_ROWS`, async () => {
			instance =
				mosaic_view.host === 'section'
					? await get_instance({
							model: 'section',
							tipo: 'test3',
							section_tipo: 'test3',
							mode: 'list',
							id_variant: `render_budget_${mosaic_view.view}`,
						})
					: await get_instance({
							model: 'component_portal',
							tipo: 'test80',
							section_tipo: 'test3',
							section_id: 2,
							mode: 'edit',
							view: mosaic_view.view,
							id_variant: `render_budget_${mosaic_view.view}`,
						});
			await instance.build(true);

			// the tool's own registration: a render_views entry with the module path
			instance.render_views = instance.render_views || [];
			instance.render_views.push({
				view: mosaic_view.view,
				mode: mosaic_view.mode,
				render: mosaic_view.render,
				path: mosaic_view.path,
			});
			// the dispatcher reads self.view || self.context.view (portal) /
			// self.context.view || self.view (section list)
			instance.view = mosaic_view.view;
			if (instance.context) {
				instance.context.view = mosaic_view.view;
			}

			// the columns the mosaic slices: both views filter the columns_map by
			// `in_mosaic` (tile) and `hover` (overlay)
			for (const column of instance.columns_map || []) {
				column.in_mosaic = true;
				column.hover = true;
			}

			instance.data = instance.data || {};
			instance.data.entries = synthetic_entries();

			const node = await instance.render();
			test_container.appendChild(node);

			content_data = node.content_data || node.querySelector('.content_data');
			assert.equal(content_data instanceof Element, true, 'content_data expected');
			assert_record_window(instance, content_data);
		});

		it('reveal(n) builds children[n] in place, keeps the bound and releases into ar_instances', async () => {
			const built = await assert_reveal(instance, content_data, RENDER_BUDGET_ENTRIES - 1);
			assert.equal(built.includes(RENDER_BUDGET_ENTRIES - 1) && built.length <= ROW_WINDOW_MAX_ROWS, true);
		});

		it('a built tile is a drag source: draggable, dragstart not refused, text/plain row payload, no portal MIME', async () => {
			const tile = content_data.children[0];
			assert.equal(tile.classList.contains('placeholder'), false, 'row 0 is built after the fill');
			assert.equal(tile.getAttribute('draggable'), 'true', 'a tool-mosaic tile carries draggable=true');

			const { event, data_transfer } = dragstart_on(tile);
			try {
				assert.equal(event.defaultPrevented, false, 'the tool row dragstart must not be refused');
				assert.equal(
					Array.from(data_transfer.types).includes(PORTAL_ROW_MIME),
					false,
					'a tool payload never carries the portal MIME type (no portal may take it)',
				);
				const payload = JSON.parse(data_transfer.getData('text/plain'));
				assert.deepEqual(payload.locator, instance.record_windows.rows.entry_of(0));
				assert.equal(payload.paginated_key, 0);
				assert.equal(payload.caller, mosaic_view.caller_name ?? undefined);
			} finally {
				tile.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
			}
		});

		it('on touch, a tap on a built tile picks its payload (touch_pick)', () => {
			const original_match_media = window.matchMedia;
			window.matchMedia = (query) => ({
				matches: query === '(pointer: coarse)',
				media: query,
				addEventListener() {},
				removeEventListener() {},
			});
			try {
				touch_pick.cancel();
				const tile = content_data.children[0];
				tile.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				assert.equal(touch_pick.active(), true, 'the tap did not pick the tile');
				const payload = JSON.parse(touch_pick.peek());
				assert.deepEqual(payload.locator, instance.record_windows.rows.entry_of(0));
			} finally {
				touch_pick.cancel();
				window.matchMedia = original_match_media;
			}
		});

		if (mosaic_view.caller_name === 'tool_cataloging') {
			it('a cataloging card dropped on a thesaurus ts_object term reaches the term drop handler', async () => {
				// the term: a descriptor ts_object node, served by a mocked
				// data_manager.request the way the tree block below does (no server)
				const original_request = data_manager.request;
				const requests = [];
				data_manager.request = async (options) => {
					const body = options.body;
					requests.push(body?.action);
					if (body?.action === 'get_node_data') {
						return {
							ok: true,
							data: {
								ts_id: 'test3_1',
								ts_parent: null,
								section_tipo: 'test3',
								section_id: '1',
								order: 1,
								is_descriptor: true,
								is_indexable: true,
								has_descriptor_children: false,
								children_tipo: 'test71',
								permissions_button_new: 3,
								permissions_button_delete: 3,
								permissions_indexation: 3,
								ar_elements: [
									{ type: 'term', tipo: 'test71_term', value: 'Term 1', model: 'component_input_text' },
								],
							},
						};
					}
					if (body?.action === 'add_child') {
						return { ok: true, data: 900001 };
					}
					return { ok: true, data: true };
				};

				const published = [];
				const token = event_manager.subscribe('ts_add_child_tool_cataloging', (data) => {
					published.push(data);
				});

				let term;
				try {
					term = await ts_object.get_instance({
						area_model: 'area_thesaurus',
						caller: {
							filter: {},
							build_options: {},
							id: 'render_budget_cataloging_caller',
							id_base: 'test3__test3',
							model: 'area_thesaurus',
						},
						children_tipo: 'test71',
						is_ontology: false,
						is_root_node: false,
						linker: undefined,
						section_id: '1',
						section_tipo: 'test3',
						thesaurus_mode: 'default',
						thesaurus_view_mode: null,
					});
					await term.build(true);
					const term_node = await term.render();
					test_container.appendChild(term_node);
					assert.equal(term_node.classList.contains('wrap_ts_object'), true, 'the term node is a wrap_ts_object');

					// the card's own dragstart payload, then a real drop on the term
					const tile = content_data.children[0];
					const { data_transfer } = dragstart_on(tile);
					tile.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
					const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
					term_node.dispatchEvent(drop);

					assert.equal(drop.defaultPrevented, true, 'the term drop handler did not take the card');
					const reached = await wait_until(() => published.length > 0);
					assert.equal(reached, true, 'the term did not publish ts_add_child_tool_cataloging');
					assert.equal(requests.includes('add_child'), true, 'the term did not create the child');
					assert.deepEqual(published[0].locator, instance.record_windows.rows.entry_of(0));
					assert.equal(published[0].new_ts_section.section_id, 900001);
				} finally {
					event_manager.unsubscribe(token);
					data_manager.request = original_request;
					if (term) {
						await term.destroy(true, true, true);
					}
				}
			});
		}

		it('destroying the owner destroys the window', async () => {
			await instance.destroy(true, true, true);
			assert.equal(instance.record_windows, null);
			assert.equal(row_instances(instance).length, 0);
		});
	});
}

describe('RENDER BUDGET — thesaurus tree', function () {
	this.timeout(60000);

	// node fixtures, mocked the way test_ts_object.js does (no server)
	const original_request = data_manager.request;
	const ROOT = { section_tipo: 'test3', section_id: '1' };
	const child_fixture = (i) => ({
		ts_id: `test3_${i}`,
		ts_parent: 'test3_1',
		section_tipo: 'test3',
		section_id: String(i),
		order: i,
		is_descriptor: true,
		is_indexable: true,
		has_descriptor_children: false,
		children_tipo: 'test71',
		permissions_button_new: 3,
		permissions_button_delete: 3,
		permissions_indexation: 3,
		ar_elements: [
			{
				type: 'term',
				tipo: 'test71_term',
				value: `Term ${i}`,
				model: 'component_input_text',
			},
		],
	});

	before(() => {
		data_manager.request = async (options) => {
			const body = options.body;
			const source = body?.source || {};
			if (body?.action === 'get_node_data' && String(source.section_id) === ROOT.section_id) {
				return {
					ok: true,
					data: { ...child_fixture(1), ts_parent: null, has_descriptor_children: true },
				};
			}
			return { ok: true, data: true };
		};
	});
	after(() => {
		data_manager.request = original_request;
	});

	let instance;

	it(`a node handed ${RENDER_BUDGET_ENTRIES} children materializes at most ROW_WINDOW_MAX_ROWS`, async () => {
		instance = await ts_object.get_instance({
			area_model: 'area_thesaurus',
			caller: {
				filter: {},
				build_options: {},
				id: 'render_budget_caller',
				id_base: 'test3__test3',
				model: 'area_thesaurus',
			},
			children_tipo: 'test71',
			is_ontology: false,
			is_root_node: false,
			linker: undefined,
			section_id: ROOT.section_id,
			section_tipo: ROOT.section_tipo,
			thesaurus_mode: 'default',
			thesaurus_view_mode: null,
		});
		await instance.build(true);
		const node = await instance.render();
		test_container.appendChild(node);
		assert.equal(
			instance.children_container instanceof Element,
			true,
			'children_container expected',
		);

		const ar_children_data = Array.from({ length: RENDER_BUDGET_ENTRIES }, (_, i) =>
			child_fixture(i + 2),
		);
		instance.children_data = { ar_children_data, pagination: null };
		const result = await instance.render_children({
			clean_children_container: true,
			children_data: instance.children_data,
		});
		assert.equal(result, true);

		const wrappers = instance.children_container.querySelectorAll(':scope > .wrap_ts_object');
		assert.equal(
			wrappers.length > 0,
			true,
			'the first window of children must be in the tree when render_children resolves',
		);
		assert.equal(
			wrappers.length <= ROW_WINDOW_MAX_ROWS,
			true,
			`built ${wrappers.length} children for ${RENDER_BUDGET_ENTRIES}; the bound is ${ROW_WINDOW_MAX_ROWS}`,
		);
		assert.equal(
			instance.ar_instances.filter((el) => el.model === 'ts_object').length <= ROW_WINDOW_MAX_ROWS,
			true,
		);
		assert.equal(instance.row_window.range().total, RENDER_BUDGET_ENTRIES);
	});

	it('reveal_child materializes a far child (the search-hierarchization door) within the bound', async () => {
		const far = `test3_${RENDER_BUDGET_ENTRIES + 1}`;
		const node = await instance.reveal_child(far);
		assert.equal(node instanceof Element, true, 'the far child must be in the tree after reveal');
		assert.equal(instance.children_container.contains(node), true);
		const wrappers = instance.children_container.querySelectorAll(':scope > .wrap_ts_object');
		assert.equal(wrappers.length <= ROW_WINDOW_MAX_ROWS, true);
		assert.equal(await instance.reveal_child('test3_nope'), null, 'not a child → null');
	});

	it('virtual_order is index-based across the window', () => {
		// the revealed last child carries its DATA position, not a DOM count
		const last = instance.ar_instances.find(
			(el) => el.model === 'ts_object' && el.ts_id === `test3_${RENDER_BUDGET_ENTRIES + 1}`,
		);
		assert.equal(Boolean(last), true);
		assert.equal(last.virtual_order, RENDER_BUDGET_ENTRIES);
	});

	it('destroying the node stops the window', async () => {
		await instance.destroy(true, true, true);
		assert.equal(instance.row_window, null);
	});
});

// @license-end
