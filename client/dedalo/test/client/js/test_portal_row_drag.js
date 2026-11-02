// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/

import { request_failed, response_data } from '../../../core/common/js/api_error.js';
import { lock_rows } from '../../../core/common/js/common.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { ROW_WINDOW_MAX_ROWS } from '../../../core/common/js/row_window.js';
import * as touch_pick from '../../../core/common/js/touch_pick.js';
import { ui } from '../../../core/common/js/ui.js';
import { PORTAL_ROW_MIME } from '../../../core/component_portal/js/drag_and_drop.js';
import { component_relation_children } from '../../../core/component_relation_children/js/component_relation_children.js';
import { prune_rules } from '../../../core/page/js/css.js';
import { render_column_node_callback } from '../../../core/section_record/js/view_default_list_section_record.js';

/**
 * TEST_PORTAL_ROW_DRAG
 * The portal row drag of the row box (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md),
 * driven with REAL DragEvent / DataTransfer on real portals of the SUITE
 * database: the generic `test` TLD's compatible pair test1611 ↔ test1613
 * (section test1572; each names the other in `properties.draggable_to`).
 *
 * The situation is BUILT here, never read from the ambient database: one host
 * test1572 record and four records of test1611's OWN target section (read from
 * the built portal's `target_section`, never named here) are created through
 * the engine's own create door, linked into test1611, and swept in after()
 * (links first, then the records). Both portal nodes declare `view:'mosaic'`; the default-view
 * legs build the instance with an explicit `view:'default'` override (no new
 * ontology node). The page limit is forced to 2, so page 2 exists.
 *
 * What is asserted:
 *   - default view, page 1 and page 2: the drop hands `sort_data` ABSOLUTE
 *     keys (the offset is never added), and ONE real reorder on page 2 is
 *     persisted and read back;
 *   - the mosaic and line views drag the ROW itself;
 *   - a MOVE into the EMPTY partner portal lands through its wrapper;
 *   - a foreign drag (no portal MIME type) is not defaultPrevented and reaches
 *     an ancestor listener;
 *   - no drag source on a declared-order portal (with a non-empty
 *     draggable_to), with or without view_order, nor while a view_order is set
 *     on a portal without declared order, nor with reorderable=false (the
 *     relation_children flag) or permissions 1;
 *   - the handle carries no `hide` class; desktop visibility is CSS-only
 *     (opacity 0 at rest, 1 on row focus-within / its own focus-visible, the hit
 *     point at its centre is the handle), Tab reaches it and Enter opens
 *     move-to-position;
 *   - dblclick and Enter move-to-position on page 2 send absolute keys;
 *   - dragstart with placeholders present does not throw and the dragged row
 *     stays built (pinned) across a scroll that releases its neighbours;
 *   - a stale generation is refused (no request, not bubbled), including a
 *     payload stamped before a destroying refresh;
 *   - a portal inside a ts_object node leaves thesaurus drags to the term;
 *   - touch: tap picks a row, tap on another row places it (sort_data); a
 *     foreign pick is not consumed by a portal row.
 *   - phone (360px): the handle on a portal CARD is shown without hover, in
 *     flow inside the Id cell, which does not clip it, and the hit point at
 *     its centre is the handle (the stage-6 leg of the WC entry).
 * (!) The visibility leg reads the served main.css: it needs the CSS build of
 * component_portal.less (bun run css:build), as every CSS-reading suite does.
 */

// DOM container
const container = document.getElementById('content');
const test_container = ui.create_dom_element({
	element_type: 'div',
	class_name: 'container portal_row_drag',
	parent: container,
});

const HOST_SECTION = 'test1572';
const SOURCE_TIPO = 'test1611';
const TARGET_TIPO = 'test1613';
const RECORD_COUNT = 4;
const PAGE_LIMIT = 2;

const api = async (body) => {
	const api_response = await data_manager.request({ body });
	if (request_failed(api_response)) {
		throw new Error(`test_portal_row_drag: ${body.action} refused: ${api_response.error.code}`);
	}
	return response_data(api_response);
};

const section_source = (section_tipo, section_id = null) => ({
	typo: 'source',
	type: 'section',
	model: 'section',
	tipo: section_tipo,
	section_tipo: section_tipo,
	section_id: section_id,
	mode: 'edit',
	lang: page_globals?.dedalo_data_lang ?? 'lg-eng',
});

const create_record = async (section_tipo) => {
	const section_id = Number(await api({ action: 'create', source: section_source(section_tipo) }));
	if (!Number.isInteger(section_id) || section_id < 1) {
		throw new Error(`test_portal_row_drag: create returned no section_id for ${section_tipo}`);
	}
	return section_id;
};

const delete_record = (section_tipo, section_id) =>
	api({
		action: 'delete',
		source: Object.assign(section_source(section_tipo, section_id), { delete_mode: 'delete_record' }),
	});

/** How many of `section_ids` still exist in `section_tipo` (the sweep's proof). */
const count_records = async (section_tipo, section_ids) => {
	const answer = await api({
		action: 'count',
		prevent_lock: true,
		source: section_source(section_tipo),
		sqo: {
			section_tipo: [section_tipo],
			filter_by_locators: section_ids.map((section_id) => ({ section_tipo, section_id: String(section_id) })),
		},
	});
	const total = Number(answer?.total);
	if (!Number.isInteger(total)) {
		throw new Error(`test_portal_row_drag: count answered no total for ${section_tipo}`);
	}
	return total;
};

const wait_until = async (predicate, ms = 8000) => {
	const started = performance.now();
	while (!(await predicate())) {
		if (performance.now() - started > ms) {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
};

let host_id = null;
let record_section = null;
const record_ids = [];
let variant_seq = 0;

/**
 * BUILD_PORTAL
 * A fresh portal instance on the host record, page limit forced, rendered and
 * appended.
 * @param {Object} options - {tipo, view, limit, as_model}
 * @return {Promise<Object>} the instance
 */
const build_portal = async ({ tipo = SOURCE_TIPO, view = 'default', limit = PAGE_LIMIT, as_model = null } = {}) => {
	const instance = await get_instance({
		model: 'component_portal',
		tipo: tipo,
		section_tipo: HOST_SECTION,
		section_id: host_id,
		mode: 'edit',
		view: view,
		id_variant: `portal_row_drag_${view}_${++variant_seq}`,
	});
	await instance.build(true);
	instance.view = view;
	if (instance.context) {
		instance.context.view = view;
	}
	if (limit) {
		instance.rqo.sqo.limit = limit;
		if (instance.request_config_object?.sqo) {
			instance.request_config_object.sqo.limit = limit;
		}
		await instance.build(true);
	}
	if (as_model) {
		// a portal-aliased model (`export const <model> = component_portal`): the
		// SAME class and views, its own `model` (common.js: options.model)
		instance.model = as_model;
	}
	const node = await instance.render();
	test_container.appendChild(node);
	return instance;
};

const content_of = (instance) => instance.node.content_data || instance.node.querySelector('.content_data');
const row_at = (instance, index) => content_of(instance).children[index];

/** The source node of row `index`: its own `.drag` handle (default view) or the row itself. */
const source_node_of = (instance, index) => {
	const row = row_at(instance, index);
	return instance.view === 'default' ? row.querySelector('.drag') : row;
};

/** A real dragstart at the row's source node; returns the event and its DataTransfer. */
const start_drag = (instance, index) => {
	const data_transfer = new DataTransfer();
	const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
	source_node_of(instance, index).dispatchEvent(event);
	return { event, data_transfer };
};

const end_drag = (instance, index) => {
	row_at(instance, index)?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
};

const drop_on = (node, data_transfer) => {
	const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
	node.dispatchEvent(over);
	const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
	node.dispatchEvent(drop);
	return { over, drop };
};

/** Replace instance.sort_data by a recording spy that writes nothing. */
const spy_sort_data = (instance) => {
	const calls = [];
	instance.sort_data = async (options) => {
		calls.push(options);
		return { ok: true };
	};
	return calls;
};

const stored_ids = (instance) => (instance.data?.entries || []).map((el) => Number(el.section_id));

/**
 * PRUNE_CARD_LABELS
 * Drop every phone-card label rule (`#col_<id>::before`) earlier legs injected:
 * the dynamic stylesheet is page-wide and keyed by column id, so a label left by
 * another render would make a label assertion pass for a render that attached none.
 */
const prune_card_labels = () => {
	prune_rules((rule) => /^#col_\S+::before$/.test(rule.selectorText ?? ''));
};

/**
 * ASSERT_CARD_LABELS
 * Every value cell of the phone card `row` shows its column label: the card rule
 * displays its `::before` (list.less 'PHONE CARDS') and the CONTENT is the label
 * view_default_list_section_record attached (ui.make_column_responsive, every
 * caller model). The content is what proves the JS half: the display alone comes
 * from the card rule whatever the content is.
 * @param {HTMLElement} row - a built phone-card row
 * @param {string} who - the assertion prefix
 */
const assert_card_labels = (row, who) => {
	const value_cells = [...row.querySelectorAll(':scope > .column')].filter((cell) => cell.component_instance);
	assert.equal(value_cells.length > 0, true, `${who}: the row has no value cell (the label leg would be vacuous)`);
	let labelled = 0;
	for (const cell of value_cells) {
		const template = document.createElement('template');
		template.innerHTML = String(cell.component_instance.label ?? '');
		const label = template.content.textContent;
		if (!label) {
			continue;
		}
		labelled++;
		const before = getComputedStyle(cell, '::before');
		assert.equal(before.display, 'flex', `${who}: ${cell.id} shows no label band`);
		assert.equal(before.content, JSON.stringify(label), `${who}: ${cell.id} is not labelled '${label}'`);
	}
	assert.equal(labelled > 0, true, `${who}: no value cell has a label (the label leg would be vacuous)`);
};

/** Frames + a delay: transitions (the handle's opacity) settle. */
const settle_frames = (ms = 0) =>
	new Promise((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, ms))),
	);

/** The newest move-to-position input, once the modal is open. */
const position_input = async () => {
	const found = await wait_until(() => document.querySelectorAll('input.target_key').length > 0, 3000);
	if (!found) {
		return null;
	}
	const inputs = document.querySelectorAll('input.target_key');
	return inputs[inputs.length - 1];
};

/** Click the newest move-to-position OK: it closes the modal (an unchanged position sends nothing). */
const close_position = () => {
	const buttons = document.querySelectorAll('.button_sort_order');
	buttons[buttons.length - 1].click();
};

describe('PORTAL ROW DRAG', function () {
	this.timeout(120000);

	before(async () => {
		host_id = await create_record(HOST_SECTION);
		const source = await build_portal({ view: 'default', limit: 10 });
		const target_section = Array.isArray(source.target_section) ? source.target_section : [];
		record_section = target_section[0]?.tipo || null;
		if (target_section.length !== 1 || !record_section) {
			await source.destroy(true, true, true);
			throw new Error(`test_portal_row_drag: ${SOURCE_TIPO} must declare ONE target section`);
		}
		for (let i = 0; i < RECORD_COUNT; i++) {
			record_ids.push(await create_record(record_section));
		}
		const outcome = await source.link_records(
			record_ids.map((section_id) => ({ section_tipo: record_section, section_id })),
		);
		await source.destroy(true, true, true);
		if (outcome.linked.length !== RECORD_COUNT) {
			throw new Error(`test_portal_row_drag: linked ${outcome.linked.length} of ${RECORD_COUNT} records`);
		}
	});

	after(async () => {
		// links first (no locator may outlive its record), then the records
		for (const tipo of [SOURCE_TIPO, TARGET_TIPO]) {
			const instance = await build_portal({ tipo, view: 'default', limit: 10 });
			await instance.change_value({
				changed_data: [Object.freeze({ action: 'set_data', id: null, value: null })],
				refresh: false,
			});
			await instance.destroy(true, true, true);
		}
		for (const section_id of record_ids) {
			await delete_record(record_section, section_id);
		}
		if (host_id) {
			await delete_record(HOST_SECTION, host_id);
		}
		test_container.innerHTML = '';
		// PROVE nothing is left (a count per section, never assumed)
		const left = [
			...(record_section && record_ids.length > 0 ? [[record_section, record_ids]] : []),
			...(host_id ? [[HOST_SECTION, [host_id]]] : []),
		];
		for (const [section_tipo, ids] of left) {
			assert.equal(await count_records(section_tipo, ids), 0, `scratch records left in ${section_tipo}`);
		}
	});

	it('default view: the handle carries no hide class and the page holds PAGE_LIMIT rows', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			const rows = content_of(instance).children;
			assert.equal(rows.length, PAGE_LIMIT);
			const handle = source_node_of(instance, 0);
			assert.equal(handle instanceof Element, true, 'the default-view row has its .drag handle');
			assert.equal(handle.classList.contains('hide'), false, 'the handle is never display:none');
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('default view page 1: the drop hands sort_data absolute keys', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			const calls = spy_sort_data(instance);
			const { event, data_transfer } = start_drag(instance, 1);
			assert.equal(event.defaultPrevented, false, 'the reorder source was refused');
			assert.equal(Array.from(data_transfer.types).includes(PORTAL_ROW_MIME), true);
			const { drop } = drop_on(row_at(instance, 0), data_transfer);
			end_drag(instance, 1);
			assert.equal(drop.defaultPrevented, true);
			assert.equal(calls.length, 1, 'sort_data was not called once');
			assert.equal(calls[0].source_key, 1);
			assert.equal(calls[0].target_key, 0);
			assert.equal(Number(calls[0].value.section_id), stored_ids(instance)[1]);
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('default view page 2: keys stay absolute (the offset is never added)', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			const moved = await instance.navigate({
				callback: () => {
					instance.rqo.sqo.offset = PAGE_LIMIT;
				},
			});
			assert.equal(moved, true, 'portal navigate refused');
			const calls = spy_sort_data(instance);
			const { data_transfer } = start_drag(instance, 1);
			drop_on(row_at(instance, 0), data_transfer);
			end_drag(instance, 1);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].source_key, PAGE_LIMIT + 1);
			assert.equal(calls[0].target_key, PAGE_LIMIT);
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('default view page 2: one REAL reorder is persisted and read back', async () => {
		const instance = await build_portal({ view: 'default' });
		let before_order = null;
		try {
			const reader = await build_portal({ view: 'default', limit: 10 });
			before_order = stored_ids(reader);
			await reader.destroy(true, true, true);

			await instance.navigate({
				callback: () => {
					instance.rqo.sqo.offset = PAGE_LIMIT;
				},
			});
			const real_sort_data = instance.sort_data.bind(instance);
			let answer;
			instance.sort_data = async (options) => {
				answer = await real_sort_data(options);
				return answer;
			};
			const { data_transfer } = start_drag(instance, 1);
			drop_on(row_at(instance, 0), data_transfer);
			end_drag(instance, 1);
			const settled = await wait_until(() => answer !== undefined);
			assert.equal(settled, true, 'the reorder never answered');
			assert.equal(answer?.ok, true, 'the reorder was not saved');
		} finally {
			await instance.destroy(true, true, true);
		}

		const check = await build_portal({ view: 'default', limit: 10 });
		try {
			const after_order = stored_ids(check);
			const expected = before_order.slice();
			[expected[PAGE_LIMIT], expected[PAGE_LIMIT + 1]] = [expected[PAGE_LIMIT + 1], expected[PAGE_LIMIT]];
			assert.deepEqual(after_order, expected, 'the persisted order is not the dropped one');
		} finally {
			await check.destroy(true, true, true);
		}
	});

	for (const view of ['mosaic', 'line']) {
		it(`${view} view: the row itself is the drag source`, async () => {
			const instance = await build_portal({ view });
			try {
				const calls = spy_sort_data(instance);
				const { event, data_transfer } = start_drag(instance, 1);
				assert.equal(event.defaultPrevented, false, `the ${view} row dragstart was refused`);
				assert.equal(Array.from(data_transfer.types).includes(PORTAL_ROW_MIME), true);
				drop_on(row_at(instance, 0), data_transfer);
				end_drag(instance, 1);
				assert.equal(calls.length, 1);
				assert.equal(calls[0].source_key, 1);
				assert.equal(calls[0].target_key, 0);
			} finally {
				await instance.destroy(true, true, true);
			}
		});
	}

	it('MOVE into the empty partner portal lands through its wrapper', async () => {
		const source = await build_portal({ view: 'default' });
		const target = await build_portal({ tipo: TARGET_TIPO, view: 'default' });
		try {
			assert.equal(content_of(target).children.length, 0, 'the partner portal starts empty');
			const linked = [];
			target.link_records = async (values) => {
				linked.push(...values);
				return { linked: [], refused: [{ locator: values[0], reason: 'test_spy' }], total: 0 };
			};
			const original_alert = window.alert;
			window.alert = () => {};
			try {
				const { data_transfer } = start_drag(source, 0);
				const { over, drop } = drop_on(target.node, data_transfer);
				end_drag(source, 0);
				assert.equal(over.defaultPrevented, true, 'the wrapper refused the MOVE at dragover');
				assert.equal(drop.defaultPrevented, true);
				const reached = await wait_until(() => linked.length > 0, 3000);
				assert.equal(reached, true, 'the MOVE never reached link_records');
				assert.equal(Number(linked[0].section_id), stored_ids(source)[0]);
			} finally {
				window.alert = original_alert;
			}
		} finally {
			await target.destroy(true, true, true);
			await source.destroy(true, true, true);
		}
	});

	it('a foreign drag (no portal MIME) is not defaultPrevented and reaches an ancestor', async () => {
		const instance = await build_portal({ view: 'default' });
		const seen = [];
		const ancestor = (event) => seen.push(event.type);
		test_container.addEventListener('dragover', ancestor);
		test_container.addEventListener('drop', ancestor);
		try {
			const data_transfer = new DataTransfer();
			data_transfer.setData('text/plain', JSON.stringify({ source_type: 'default', ts_id: 'x' }));
			const { over, drop } = drop_on(row_at(instance, 0), data_transfer);
			assert.equal(over.defaultPrevented, false, 'a foreign dragover was taken');
			assert.equal(drop.defaultPrevented, false, 'a foreign drop was taken');
			assert.deepEqual(seen, ['dragover', 'drop'], 'the foreign drag did not bubble to the ancestor');
		} finally {
			test_container.removeEventListener('dragover', ancestor);
			test_container.removeEventListener('drop', ancestor);
			await instance.destroy(true, true, true);
		}
	});

	it('no drag source on a declared-order portal (non-empty draggable_to), with or without view_order', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			assert.equal((instance.properties?.draggable_to || []).length > 0, true, 'test1611 names a partner');
			// only its presence is read (has_declared_order): any column tipo of this portal
			const order_tipo = instance.columns_map?.[0]?.tipo || SOURCE_TIPO;
			instance.context.declared_order = [{ tipo: order_tipo, direction: 'ASC' }];
			for (const view_order of [null, [{ tipo: order_tipo, direction: 'DESC' }]]) {
				instance.view_order = view_order;
				const { event, data_transfer } = start_drag(instance, 0);
				end_drag(instance, 0);
				assert.equal(event.defaultPrevented, true, `a declared-order source started (view_order ${Boolean(view_order)})`);
				assert.equal(data_transfer.getData(PORTAL_ROW_MIME), '');
			}
		} finally {
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('no drag source while a view_order is set on a portal without declared order', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			instance.view_order = [{ tipo: instance.columns_map?.[0]?.tipo || SOURCE_TIPO, direction: 'DESC' }];
			const { event } = start_drag(instance, 0);
			end_drag(instance, 0);
			assert.equal(event.defaultPrevented, true, 'a view_order source started');
		} finally {
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	// reorderable: the value the REAL component_relation_children carries (a
	// relation_children that lost its flag reds here, not just a portal stub)
	for (const [flag, value] of [
		['reorderable', component_relation_children.prototype.reorderable],
		['permissions', 1],
	]) {
		it(`no drag source with ${flag}=${value}`, async () => {
			if (flag === 'reorderable') {
				assert.equal(value, false, 'component_relation_children is reorderable again: this leg has nothing to refuse');
			}
			const instance = await build_portal({ view: 'default' });
			try {
				// control: the same row IS a source before the flag is set
				const control = start_drag(instance, 0);
				end_drag(instance, 0);
				assert.equal(control.event.defaultPrevented, false, 'the unflagged row is no source: the leg would be vacuous');
				instance[flag] = value;
				const { event, data_transfer } = start_drag(instance, 0);
				end_drag(instance, 0);
				assert.equal(event.defaultPrevented, true, `a ${flag}=${value} source started`);
				assert.equal(data_transfer.getData(PORTAL_ROW_MIME), '');
			} finally {
				await instance.destroy(true, true, true);
			}
		});
	}

	it('desktop handle: opacity 0 at rest, 1 when reached; the hit point is the handle; Tab + Enter open move-to-position', async () => {
		// the reveal is a DESKTOP rule (component_portal.less, min-width
		// breakpoint + 1) and the suite frame sits under the breakpoint: the leg
		// widens its own frame for its duration, and proves it got there
		const frame = window.frameElement;
		const frame_width = frame ? frame.style.width : null;
		if (frame) {
			frame.style.width = '1440px';
		}
		const instance = await build_portal({ view: 'default' });
		try {
			await settle_frames();
			assert.equal(window.matchMedia('(min-width: 1025px)').matches, true, 'the leg could not reach the desktop width');
			const handle = source_node_of(instance, 0);
			handle.scrollIntoView({ block: 'center' });
			await settle_frames();
			assert.equal(getComputedStyle(handle).display === 'none', false, 'the handle is display:none');
			assert.equal(getComputedStyle(handle).opacity, '0', 'the handle is visible at rest');
			assert.equal(handle.tabIndex >= 0, true, 'the handle is not in the Tab order');

			handle.focus();
			assert.equal(document.activeElement, handle, 'the handle cannot take the focus');
			await settle_frames(300);
			assert.equal(getComputedStyle(handle).opacity, '1', 'the reached handle is not revealed');
			const box = handle.getBoundingClientRect();
			assert.equal(box.width > 0 && box.height > 0, true, 'the handle has no box');
			const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
			assert.equal(hit === handle || handle.contains(hit), true, 'the point at the handle centre is not the handle');

			const calls = spy_sort_data(instance);
			handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			const input = await position_input();
			assert.equal(Boolean(input), true, 'Enter on the handle opened no move-to-position');
			assert.equal(Number(input.value), 1, 'the modal does not show the row position');
			close_position();
			assert.equal(calls.length, 0, 'an unchanged position was sent');
		} finally {
			await instance.destroy(true, true, true);
			if (frame) {
				frame.style.width = frame_width;
			}
		}
	});

	it('phone card handle (360px): shown without hover, in flow in the Id cell, and the hit point at its centre is the handle', async () => {
		// the stage-6 leg (row-box WC entry, phone portal cards): below the desktop
		// breakpoint a top-level portal table is a card list (list.less 'PHONE
		// CARDS') whose sticky Id cell holds the handle IN FLOW and never clips it
		// (component_portal.less). The leg narrows its own frame to the phone floor
		// for its duration, and proves it got there
		const frame = window.frameElement;
		const frame_width = frame ? frame.style.width : null;
		if (frame) {
			frame.style.width = '360px';
		}
		prune_card_labels();
		const instance = await build_portal({ view: 'default' });
		try {
			await settle_frames();
			assert.equal(window.matchMedia('(max-width: 1024px)').matches, true, 'the leg could not reach the phone width');
			if (document.activeElement && document.activeElement !== document.body) {
				document.activeElement.blur();
			}
			const row = row_at(instance, 0);
			assert.equal(getComputedStyle(row).display, 'grid', 'the portal row is not a phone card');
			const handle = source_node_of(instance, 0);
			assert.equal(handle instanceof Element, true, 'the default-view row has its .drag handle');
			const id_cell = handle.closest('.column_section_id');
			assert.equal(Boolean(id_cell) && row.contains(id_cell), true, 'the handle is not inside the row Id cell');
			handle.scrollIntoView({ block: 'center' });
			await settle_frames(300);
			assert.equal(row.matches(':hover, :focus-within'), false, 'the leg must measure the row at rest');
			assert.equal(getComputedStyle(handle).opacity, '1', 'the phone handle is hidden at rest');
			assert.equal(getComputedStyle(handle).position, 'static', 'the phone handle is not in flow');
			const id_style = getComputedStyle(id_cell);
			assert.equal(id_style.overflowX === 'visible' && id_style.overflowY === 'visible', true, 'the Id cell clips the handle');
			const box = handle.getBoundingClientRect();
			assert.equal(box.width > 0 && box.height > 0, true, 'the handle has no box');
			assert.equal(box.left >= 0 && box.right <= window.innerWidth, true, 'the handle is outside the viewport');
			const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
			assert.equal(hit === handle || handle.contains(hit), true, 'the point at the handle centre is not the handle');
			// the card holds its cells: the trash button beside its 22% label once
			// ran 100% wide past the card edge, the phone page was laid out wider
			// than the screen and scaled down, and a real tap at the handle's
			// layout centre landed on the next card's trash button (crawl journey
			// portal_reorder). Every cell child stays inside the card's box
			// every value cell is labelled (the card's field names)
			assert_card_labels(row, 'portal card');
			const remove_button = row.querySelector(':scope > .column_remove > .button_remove');
			assert.equal(remove_button instanceof HTMLElement, true, 'the default-view row has its trash cell (the containment leg would be vacuous)');
			const card_right = row.getBoundingClientRect().right;
			for (const cell_child of row.querySelectorAll(':scope > .column > *')) {
				const right = cell_child.getBoundingClientRect().right;
				assert.equal(right <= card_right + 0.5, true, `a card cell child overflows the card (${cell_child.className}: ${right} > ${card_right})`);
			}
		} finally {
			await instance.destroy(true, true, true);
			if (frame) {
				frame.style.width = frame_width;
			}
		}
	});

	it('phone card labels (360px): a portal-aliased model (component_relation_related) gets the same labelled cards', async () => {
		// the cards are decided by the CSS marker (`.list_body.layout_table`), which
		// every portal-family model carries (view_default_edit_portal); the labels
		// must follow, never a caller-model name (row-box WC entry, phone portal
		// cards). The leg narrows its own frame to the phone floor for its duration
		const frame = window.frameElement;
		const frame_width = frame ? frame.style.width : null;
		if (frame) {
			frame.style.width = '360px';
		}
		prune_card_labels();
		const instance = await build_portal({ view: 'default', as_model: 'component_relation_related' });
		try {
			await settle_frames(300);
			assert.equal(window.matchMedia('(max-width: 1024px)').matches, true, 'the leg could not reach the phone width');
			assert.equal(instance.model, 'component_relation_related', 'the leg did not render as the aliased model');
			const row = row_at(instance, 0);
			// render_column_node stamps `column_<caller model>` on each value cell
			assert.equal(
				row.querySelector(':scope > .column.column_component_relation_related') instanceof HTMLElement,
				true,
				'the row caller is not the aliased model',
			);
			assert.equal(getComputedStyle(row).display, 'grid', 'the aliased-model row is not a phone card');
			assert_card_labels(row, 'component_relation_related card');
		} finally {
			await instance.destroy(true, true, true);
			if (frame) {
				frame.style.width = frame_width;
			}
		}
	});

	it('phone card labels: a label is CSS string TEXT (an apostrophe renders; a quote cannot add declarations; a control character survives)', async () => {
		// the label rides an id-scoped `content:'…'` rule (css.js process_rule
		// interpolates it between single quotes): unescaped, `Data d'alta` ends
		// the string and the card loses its label, and a crafted label adds
		// declarations to the rule. The REAL attach path (render_column_node_*
		// → attach_card_label) must hand the stylesheet the label as its text
		const cases = [
			{ id: 'card_label_probe_apostrophe', label: "Data d'alta" },
			{ id: 'card_label_probe_backslash', label: 'a\\b "c"' },
			{ id: 'card_label_probe_crafted', label: "x';visibility:hidden;content:'y" },
			// control characters: escaped as hex + terminating space (css_string_text's
			// control arm); a raw newline would end the CSS string and drop the rule
			{ id: 'card_label_probe_newline', label: 'line one\nline two' },
			{ id: 'card_label_probe_tab', label: 'a\tb' },
			{ id: 'card_label_probe_unit_separator', label: 'a\u001fb' },
			{ id: 'card_label_probe_delete', label: 'a\u007fb' },
		];
		// CSSOM "serialize a string" (what getPropertyValue answers): control
		// characters U+0001–U+001F and U+007F come back as `\<hex> `, a quote or
		// backslash backslash-escaped, all in double quotes. For a label without
		// control characters this equals JSON.stringify(label).
		const css_serialized = (text) => `"${[...text].map((ch) => {
			const code = ch.charCodeAt(0);
			if ((code >= 0x1 && code <= 0x1f) || code === 0x7f) {
				return `\\${code.toString(16)} `;
			}
			return (ch === '"' || ch === '\\') ? `\\${ch}` : ch;
		}).join('')}"`;
		const rule_of = (selector) => {
			for (const sheet of document.styleSheets) {
				let rules;
				try {
					rules = sheet.cssRules;
				} catch {
					continue;
				}
				for (const rule of rules) {
					if (rule.selectorText === selector) {
						return rule;
					}
				}
			}
			return null;
		};
		prune_card_labels();
		try {
			for (const { id, label } of cases) {
				render_column_node_callback({ id, label, callback: () => null }, null);
			}
			// css.js queues the rules and flushes them on the next animation frame
			await settle_frames();
			for (const { id, label } of cases) {
				const rule = rule_of(`#col_${id}::before`);
				assert.equal(rule instanceof CSSStyleRule, true, `${id}: no label rule was attached (the leg would be vacuous)`);
				assert.equal(rule.style.getPropertyValue('content'), css_serialized(label), `${id}: the label is not its own text`);
				assert.equal(rule.style.getPropertyValue('visibility'), '', `${id}: the label added a declaration`);
				assert.equal(rule.style.length, 1, `${id}: the label rule carries more than its content`);
			}
		} finally {
			prune_card_labels();
		}
	});

	for (const gesture of ['dblclick', 'Enter']) {
		it(`page 2: ${gesture} move-to-position sends absolute keys`, async () => {
			const instance = await build_portal({ view: 'default' });
			try {
				assert.equal(
					await instance.navigate({
						callback: () => {
							instance.rqo.sqo.offset = PAGE_LIMIT;
						},
					}),
					true,
				);
				const calls = spy_sort_data(instance);
				const handle = source_node_of(instance, 1);
				if (gesture === 'dblclick') {
					handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
				} else {
					handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
				}
				const input = await position_input();
				assert.equal(Boolean(input), true, `${gesture} opened no move-to-position`);
				assert.equal(Number(input.value), PAGE_LIMIT + 2, 'the modal does not show the ABSOLUTE 1-based position');
				input.value = String(PAGE_LIMIT + 1);
				close_position();
				assert.equal(await wait_until(() => calls.length > 0, 3000), true, 'the move was not sent');
				assert.equal(calls[0].source_key, PAGE_LIMIT + 1);
				assert.equal(calls[0].target_key, PAGE_LIMIT);
			} finally {
				await instance.destroy(true, true, true);
			}
		});
	}

	it('dragstart with placeholders present does not throw; the dragged row stays built across a scroll', async () => {
		const instance = await build_portal({ view: 'default' });
		const errors = [];
		const on_error = (event) => errors.push(event.error || event.message);
		window.addEventListener('error', on_error);
		try {
			// a page over the bound (synthetic entries: the rows are about rows, not values)
			const n = ROW_WINDOW_MAX_ROWS + 60;
			const release = await lock_rows(instance);
			assert.equal(typeof release, 'function');
			try {
				instance.data.entries = Array.from({ length: n }, (_, i) => ({
					// distinct locators: a section_record key carries no row_key
					section_tipo: record_section,
					section_id: i + 1,
					paginated_key: i,
				}));
				await instance.render({ render_level: 'content' });
			} finally {
				release();
			}
			await settle_frames();
			const record_window = instance.record_windows.rows;
			const content = content_of(instance);
			assert.equal(content.children.length, n);
			assert.equal(content.querySelectorAll(':scope > .placeholder').length > 0, true, 'no placeholder: the leg needs a page over the bound');

			const dragged = record_window.record_at(0);
			const { event, data_transfer } = start_drag(instance, 0);
			assert.equal(event.defaultPrevented, false, 'the dragstart was refused');
			assert.equal(Array.from(data_transfer.types).includes(PORTAL_ROW_MIME), true);
			assert.equal(errors.length, 0, `dragstart threw: ${errors[0]}`);

			// scroll to the end: rows near the start are released, the dragged one is not
			content.lastElementChild.scrollIntoView({ block: 'end' });
			const released = await wait_until(async () => {
				await record_window.idle();
				return content.children[1].classList.contains('placeholder');
			}, 8000);
			assert.equal(released, true, 'the scroll released nothing (the pin leg would be vacuous)');
			assert.equal(content.children[0].classList.contains('placeholder'), false, 'the dragged row was released');
			assert.equal(record_window.record_at(0), dragged, 'the dragged row was rebuilt');
			end_drag(instance, 0);
			assert.equal(errors.length, 0, `the drag threw: ${errors[0]}`);
		} finally {
			window.removeEventListener('error', on_error);
			test_container.scrollIntoView({ block: 'start' });
			await instance.destroy(true, true, true);
		}
	});

	it('a payload stamped before a destroying refresh is stale (owner-monotonic generation)', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			const { data_transfer } = start_drag(instance, 1);
			end_drag(instance, 1);
			const json = data_transfer.getData(PORTAL_ROW_MIME);
			const generation = instance.record_window_generation.rows;
			assert.notEqual(await instance.refresh({ destroy: true }), false);
			assert.equal(instance.record_window_generation.rows > generation, true, 'the generation restarted');
			const calls = spy_sort_data(instance);
			const stale = new DataTransfer();
			stale.setData(PORTAL_ROW_MIME, json);
			stale.setData('text/plain', json);
			const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: stale });
			row_at(instance, 0).dispatchEvent(drop);
			assert.equal(drop.defaultPrevented, true, 'the stale drop was not taken');
			assert.equal(calls.length, 0, 'a pre-refresh payload was sent');
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('a portal inside a ts_object node leaves thesaurus drags to the term', async () => {
		const instance = await build_portal({ view: 'default' });
		const term = ui.create_dom_element({
			element_type: 'div',
			class_name: 'wrap_ts_object',
			parent: test_container,
		});
		term.appendChild(instance.node);
		const seen = [];
		const on_term = (event) => {
			seen.push(event.type);
			event.preventDefault();
		};
		term.addEventListener('dragover', on_term);
		term.addEventListener('drop', on_term);
		try {
			// what ts_object's own dragstart writes (core/ts_object/js/drag_and_drop.js)
			const data_transfer = new DataTransfer();
			data_transfer.setData(
				'text/plain',
				JSON.stringify({ source_type: 'default', moving_instance_id: 'ts_x', parent_instance_id: 'ts_y' }),
			);
			for (const node of [row_at(instance, 0), instance.node]) {
				seen.length = 0;
				const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
				node.dispatchEvent(over);
				const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data_transfer });
				node.dispatchEvent(drop);
				assert.deepEqual(seen, ['dragover', 'drop'], 'the portal swallowed a thesaurus drag');
				assert.equal(over.defaultPrevented && drop.defaultPrevented, true, 'the term did not receive the drag');
			}
		} finally {
			term.removeEventListener('dragover', on_term);
			term.removeEventListener('drop', on_term);
			await instance.destroy(true, true, true);
			term.remove();
		}
	});

	it('a stale generation is refused: accepted, never sent, not bubbled', async () => {
		const instance = await build_portal({ view: 'default' });
		try {
			const { data_transfer } = start_drag(instance, 1);
			end_drag(instance, 1);
			const payload = JSON.parse(data_transfer.getData(PORTAL_ROW_MIME));
			const stale = new DataTransfer();
			const stale_json = JSON.stringify({ ...payload, window_generation: payload.window_generation - 1 });
			stale.setData(PORTAL_ROW_MIME, stale_json);
			stale.setData('text/plain', stale_json);
			const calls = spy_sort_data(instance);
			const seen = [];
			const ancestor = () => seen.push('drop');
			test_container.addEventListener('drop', ancestor);
			try {
				const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: stale });
				row_at(instance, 0).dispatchEvent(drop);
				assert.equal(drop.defaultPrevented, true);
				assert.equal(calls.length, 0, 'a stale payload was sent');
				assert.equal(seen.length, 0, 'a stale drop bubbled');
			} finally {
				test_container.removeEventListener('drop', ancestor);
			}
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('touch: tap picks a row, tap on another row places it; a foreign pick is not consumed', async () => {
		const instance = await build_portal({ view: 'default' });
		const original_match_media = window.matchMedia;
		window.matchMedia = (query) => ({
			matches: query === '(pointer: coarse)',
			media: query,
			addEventListener() {},
			removeEventListener() {},
		});
		try {
			touch_pick.cancel();
			const calls = spy_sort_data(instance);
			source_node_of(instance, 1).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			assert.equal(touch_pick.active(), true, 'the tap on the handle did not pick the row');
			row_at(instance, 0).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			const placed = await wait_until(() => calls.length > 0, 3000);
			assert.equal(placed, true, 'the second tap did not place the row');
			assert.equal(calls[0].source_key, 1);
			assert.equal(calls[0].target_key, 0);
			assert.equal(touch_pick.active(), false, 'the place did not consume the pick');

			// a foreign pick (a tool card) survives a tap on a portal row
			touch_pick.pick(JSON.stringify({ locator: { section_tipo: 'test3', section_id: 1 } }), '1');
			row_at(instance, 0).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			assert.equal(touch_pick.active(), true, 'a portal row consumed a foreign pick');
		} finally {
			touch_pick.cancel();
			window.matchMedia = original_match_media;
			await instance.destroy(true, true, true);
		}
	});
});

// @license-end
