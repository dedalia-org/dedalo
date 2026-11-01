// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals, get_label */
/*eslint no-undef: "error"*/

import { ApiError, request_failed, response_data } from '../../../core/common/js/api_error.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { ui } from '../../../core/common/js/ui.js';
import {
	can_save_view_order,
	can_view_sort,
	declared_order_of,
} from '../../../core/component_portal/js/drag_and_drop.js';

/**
 * TEST_PORTAL_ORDER
 * The portal order model, client half (stage O2 — engineering/wire_contract/
 * WC-2026-10-31-portal-order-model.md): a column header click is a TEMPORARY
 * view order, never a write; the order indicator; "save current order"; reset;
 * and the declared (ontology) order.
 *
 * The situation is BUILT here, never read from the ambient database: one host
 * test3 record and three test3 records (the generic `test` TLD's self-portal
 * test80 → test3, default view) are created through the engine's own create door,
 * linked into test80, and swept in after() (links first, then the records). The
 * page limit is forced to 2, so page 2 exists.
 *
 * Two server facts are BUILT client side, on the live instance's context (no
 * ontology node may be created for them):
 *   - the column opt-in `sort_by_column: true` on test80's test52 ddo (no suite
 *     portal declares one), which is what makes the header offer the sort;
 *   - `context.declared_order` (the declared-order legs), as test_portal_row_drag
 *     does.
 * Because the server validates the view_order column against the ONTOLOGY
 * (relations/order_locators.ts assertViewOrder), and refuses `sort_by_column` on
 * a column that does not opt in, the API is observed through a data_manager.request
 * spy: a read carrying `sqo.view_order` is RECORDED and forwarded without it (the
 * stored order) — its answer's page then REVERSED, so a view-ordered page never
 * equals the stored-order page a save echo carries (each entry keeps its stored
 * `paginated_key`, as the server's view-ordered read does) — and the one
 * `sort_by_column` save is recorded and answered with a real read (nothing is
 * written). The server half — the full list ordered before
 * paginating, the stored-index paginated_key, the column / declared_order
 * refusals, the strict sqoSchema wire shape — is
 * test/unit/portal_order_native.test.ts (the twin of every strip below). The
 * recorded `sqo.view_order` is asserted with deepEqual, which pins its keys
 * exactly ({tipo, direction}, nothing else) — the shape that schema accepts.
 *
 * What is asserted:
 *   - header click: view_order set, the read carries sqo.view_order (offset 0),
 *     NO write request, the arrow shows the direction, no drag source;
 *   - the indicator: "<Order>: <column> ↓/↑", a reset and a save button (real
 *     <button>s), the accessible name spells the direction;
 *   - pagination and a destroying refresh keep the view order;
 *   - reset: view_order null, the read carries none, the indicator and the arrow
 *     clear, the drag source is back;
 *   - save current order: ONE sort_by_column request (column + direction), then
 *     the view order clears;
 *   - declared order: without a view order the indicator shows the PERMANENT
 *     declared order (no button); the header view-sort still works there, the
 *     indicator shows the temporary order + reset, never save; save_view_order
 *     sends nothing; no drag source with or without a view order;
 *   - link / unlink under a view order: the save echo (STORED order) is never
 *     rendered — the rows are re-read under the view order, the indicator and the
 *     arrow stay true to them;
 *   - a refused order change restores the previous order, offset and arrow;
 *   - single flight: an order change / reset / save issued while another order change
 *     or any other read is in flight is refused, with no second build and nothing sent;
 *   - a view order the SERVER refuses (the read fails): the portal is re-read under
 *     the previous order and stays usable (status 'rendered'; refresh / sort / reset
 *     accepted again);
 *   - a refused "save current order": the view order stands (indicator temporary,
 *     both buttons), the refusal echo is dropped and the rows re-read under it;
 *   - mosaic, under a view order and under a declared order: the alt table adds no
 *     second order indicator (one Save / Reset group per portal);
 *   - read permission: the arrow and reset are offered, save is not;
 *   - backend-free: the header gate (ui.allow_column_order: read permission, no
 *     print view, no external source, the column opt-in), the arrow's default
 *     direction read from the LIVE view order (never a stale closure), can_save_view_order at
 *     read permission, and the normalization of the server's declared-order field
 *     (drag_and_drop.js declared_order_of).
 */

// DOM container
const container = document.getElementById('content');
const test_container = ui.create_dom_element({
	element_type: 'div',
	class_name: 'container portal_order',
	parent: container,
});

const HOST_SECTION = 'test3';
const PORTAL_TIPO = 'test80';
const ORDER_COLUMN = 'test52';
const RECORD_COUNT = 3;
const PAGE_LIMIT = 2;

const api = async (body) => {
	const api_response = await data_manager.request({ body });
	if (request_failed(api_response)) {
		throw new Error(`test_portal_order: ${body.action} refused: ${api_response.error.code}`);
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
		throw new Error(`test_portal_order: create returned no section_id for ${section_tipo}`);
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
		throw new Error(`test_portal_order: count answered no total for ${section_tipo}`);
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
const record_ids = [];
let variant_seq = 0;

/**
 * BUILD_PORTAL
 * A fresh test80 instance on the host record (default view unless asked, page limit
 * forced), with the ORDER_COLUMN opted in to the header sort and, when asked, a
 * declared order injected — then rendered and appended. The 'mosaic' view puts every
 * column in the tile and the hover overlay (the overlay carries the alt-table button),
 * on the ddo so every rebuild keeps it, as test_row_invariant's tool mosaics do.
 * @param {Object} options - {declared, limit, permissions, view}
 * @return {Promise<Object>} the instance
 */
const build_portal = async ({ declared = false, limit = PAGE_LIMIT, permissions = null, view = 'default' } = {}) => {
	const instance = await get_instance({
		model: 'component_portal',
		tipo: PORTAL_TIPO,
		section_tipo: HOST_SECTION,
		section_id: host_id,
		mode: 'edit',
		view: view,
		id_variant: `portal_order_${++variant_seq}`,
	});
	await instance.build(true);
	if (view !== 'default') {
		instance.view = view;
		if (instance.context) {
			instance.context.view = view;
		}
	}
	// the column opt-in (WC-048 per-ddo sort_by_column), built client side
	for (const request_config of instance.context?.request_config || []) {
		for (const ddo of request_config?.show?.ddo_map || []) {
			if (ddo.tipo === ORDER_COLUMN) {
				ddo.sort_by_column = true;
			}
			if (view === 'mosaic') {
				ddo.in_mosaic = true;
				ddo.hover = true;
			}
		}
	}
	if (declared) {
		instance.context.declared_order = [{ tipo: ORDER_COLUMN, direction: 'ASC' }];
	}
	if (limit) {
		instance.rqo.sqo.limit = limit;
		if (instance.request_config_object?.sqo) {
			instance.request_config_object.sqo.limit = limit;
		}
	}
	await instance.build(true);
	if (permissions !== null) {
		// the instance's permissions are its context's (common.js getter/setter), which a
		// refresh keeps: the level holds for every later render of this instance
		instance.permissions = permissions;
	}
	const node = await instance.render();
	test_container.appendChild(node);
	return instance;
};

/**
 * SPY_API
 * Replace data_manager.request by a recorder (restore() puts it back):
 *   - a request carrying `sqo.view_order` is recorded in `view_reads` and forwarded
 *     WITHOUT it (the server validates the column against the ontology, where no
 *     suite portal opts in — the server-side twin that reads WITH it is
 *     test/unit/portal_order_native.test.ts); its answer's portal page is REVERSED
 *     (view_ordered_answer) and kept in `view_answers`;
 *   - a `save` whose changed_data is `sort_by_column` is recorded in `sort_saves`
 *     and answered with a real read of the instance (nothing is written);
 *   - every other `save` is recorded in `writes` and forwarded;
 *   - every read of the portal (an rqo with an sqo) is recorded in `reads`;
 *   - `log` keeps the sequence ('write' / 'view_read'), for "what came after the save".
 * Refusal switches (the server's refusals, answered as the failure envelope the
 * client reads — nothing is sent for them):
 *   - `refuse_view_reads`: a read carrying `sqo.view_order` is answered refused
 *     (assertViewOrder: a column whose order path the principal cannot read);
 *   - `refuse_sort_saves`: a `sort_by_column` save is answered refused.
 * @param {Object} instance - the portal (its rqo answers the stubbed save)
 * @return {Object} {reads, view_reads, view_answers, sort_saves, writes, log, refuse_view_reads, refuse_sort_saves, restore}
 */
/** A plain-data copy (an rqo may carry non-cloneable members structuredClone refuses). */
const json_clone = (value) => JSON.parse(JSON.stringify(value));

/** The failure envelope the client reads as a server refusal (data_manager's shape). */
const refused = (what) => ({
	ok: false,
	error: new ApiError({ code: 'request.invalid_data', message: `test_portal_order: ${what} refused on purpose` }),
});

/**
 * VIEW_ORDERED_ANSWER
 * Makes a stored-order read answer distinguishable as the VIEW-ordered one: the host
 * portal datum's page is reversed (each entry keeps its own stored `paginated_key`, the
 * server's view-ordered shape). Without it the forwarded read and a save echo would be
 * the same stored sequence, and "the rows are the view-ordered read's" could not fail.
 * @param {Object} answer - the api answer (mutated)
 * @return {Object} the answer
 */
const view_ordered_answer = (answer) => {
	const datum = portal_datum_of(answer);
	if (Array.isArray(datum?.entries)) {
		datum.entries.reverse();
	}
	return answer;
};

const spy_api = (instance) => {
	const original = data_manager.request;
	const spy = {
		reads: [],
		view_reads: [],
		view_answers: [],
		sort_saves: [],
		writes: [],
		log: [],
		refuse_view_reads: false,
		refuse_sort_saves: false,
	};
	data_manager.request = async (options) => {
		const body = options?.body;
		if (body?.action === 'save') {
			const changed = body?.data?.changed_data || [];
			if (changed.some((el) => el?.action === 'sort_by_column')) {
				spy.sort_saves.push(json_clone(body));
				if (spy.refuse_sort_saves) {
					return refused('sort_by_column');
				}
				const read = json_clone(instance.rqo);
				delete read.sqo.view_order;
				return original.call(data_manager, { ...options, body: read });
			}
			spy.writes.push(json_clone(body));
			spy.log.push('write');
			return original.call(data_manager, options);
		}
		if (body?.source?.tipo === PORTAL_TIPO && body?.sqo) {
			spy.reads.push(json_clone(body));
			if (body.sqo?.view_order) {
				spy.view_reads.push(json_clone(body));
				spy.log.push('view_read');
				if (spy.refuse_view_reads) {
					return refused('view_order read');
				}
				const stripped = json_clone(body);
				delete stripped.sqo.view_order;
				const answer = view_ordered_answer(await original.call(data_manager, { ...options, body: stripped }));
				spy.view_answers.push(answer);
				return answer;
			}
		}
		return original.call(data_manager, options);
	};
	spy.restore = () => {
		data_manager.request = original;
	};
	return spy;
};

const content_of = (instance) => instance.node.content_data || instance.node.querySelector('.content_data');
const handles_of = (instance) => content_of(instance).querySelectorAll(':scope > .section_record .drag');
const indicator_of = (instance) => instance.node.querySelector(':scope > .list_after > .order_indicator');
const last = (list) => list[list.length - 1];

/** The header sort arrow of `tipo` (ui.add_column_order_set), or undefined. */
const sort_node_of = (instance, tipo = ORDER_COLUMN) => {
	const header = instance.node.list_body?.querySelector(':scope > .header_wrapper_list');
	return (header?.sort_nodes || []).find((node) => node.column_tipo === tipo);
};

/** A real click on the header arrow; resolves once its async work is done. */
const click_sort = async (instance) => {
	const sort_node = sort_node_of(instance);
	assert.equal(sort_node instanceof Element, true, `the ${ORDER_COLUMN} header offers no sort arrow`);
	sort_node.click();
	const done = await wait_until(() => !sort_node.classList.contains('loading'));
	assert.equal(done, true, 'the header sort never settled');
	return sort_node;
};

/** A real click on an indicator button; resolves once `settled()` holds. */
const click_indicator = async (instance, selector, settled) => {
	const button = indicator_of(instance)?.querySelector(`:scope > ${selector}`);
	assert.equal(button instanceof HTMLButtonElement, true, `the indicator has no ${selector} <button>`);
	button.click();
	const done = await wait_until(settled);
	assert.equal(done, true, `${selector} never settled`);
};

/** The `section_tipo_section_id` keys of a portal datum's entries, in order. */
const entry_keys = (data) => (data?.entries || []).map((entry) => `${entry.section_tipo}_${entry.section_id}`);

/** This portal's datum in an api answer (the host record's test80). */
const portal_datum_of = (answer) =>
	(response_data(answer)?.data || []).find(
		(el) => el.tipo === PORTAL_TIPO && String(el.section_id) === String(host_id),
	);

const order_label = () => get_label.order || 'Order';
const column_label = (instance) =>
	(instance.columns_map || []).find((column) => column.tipo === ORDER_COLUMN)?.label || ORDER_COLUMN;

describe('PORTAL ORDER', function () {
	this.timeout(120000);

	before(async () => {
		host_id = await create_record(HOST_SECTION);
		for (let i = 0; i < RECORD_COUNT; i++) {
			record_ids.push(await create_record(HOST_SECTION));
		}
		const source = await build_portal({ limit: 10 });
		try {
			const outcome = await source.link_records(
				record_ids.map((section_id) => ({ section_tipo: HOST_SECTION, section_id })),
			);
			if (outcome.linked.length !== RECORD_COUNT) {
				throw new Error(`test_portal_order: linked ${outcome.linked.length} of ${RECORD_COUNT} records`);
			}
		} finally {
			await source.destroy(true, true, true);
		}
	});

	after(async () => {
		// links first (no locator may outlive its record), then the records
		const instance = await build_portal({ limit: 10 });
		await instance.change_value({
			changed_data: [Object.freeze({ action: 'set_data', id: null, value: null })],
			refresh: false,
		});
		await instance.destroy(true, true, true);
		for (const section_id of record_ids) {
			await delete_record(HOST_SECTION, section_id);
		}
		if (host_id) {
			await delete_record(HOST_SECTION, host_id);
		}
		test_container.innerHTML = '';
		// PROVE nothing is left (a count, never assumed)
		const ids = [...record_ids, ...(host_id ? [host_id] : [])];
		if (ids.length > 0) {
			assert.equal(await count_records(HOST_SECTION, ids), 0, `scratch records left in ${HOST_SECTION}`);
		}
	});

	it('precondition: the saved order shows rows, a drag source, an arrow and no indicator', async () => {
		const instance = await build_portal();
		try {
			assert.equal(content_of(instance).children.length, PAGE_LIMIT);
			assert.equal(handles_of(instance).length, PAGE_LIMIT, 'a default-view portal row has its .drag handle');
			assert.equal(sort_node_of(instance) instanceof Element, true, 'the opted-in column offers a sort arrow');
			assert.equal(instance.view_order, null);
			assert.equal(indicator_of(instance), null, 'an indicator on the saved order');
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('header click: a TEMPORARY view_order — the read carries it, nothing is written, no drag source', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			const sort_node = await click_sort(instance);
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.equal(spy.view_reads.length, 1, 'the header click did not re-read with sqo.view_order');
			assert.deepEqual(last(spy.view_reads).sqo.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.equal(last(spy.view_reads).sqo.offset, 0, 'a new order starts on the first page');
			assert.equal(spy.writes.length, 0, 'the header click wrote');
			assert.equal(spy.sort_saves.length, 0, 'the header click persisted a sort_by_column');
			assert.equal(sort_node.classList.contains('desc'), true, 'the arrow does not show DESC');
			assert.equal(handles_of(instance).length, 0, 'a drag source under a view order');
			assert.equal(content_of(instance).children.length, PAGE_LIMIT, 'the rows were not re-rendered');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('indicator: "<Order>: <column> ↓/↑" with a reset and a save button', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			await click_sort(instance);
			let indicator = indicator_of(instance);
			assert.equal(indicator instanceof HTMLElement, true, 'no indicator under a view order');
			assert.equal(indicator.classList.contains('temporary'), true);
			const text = indicator.querySelector('.order_text').textContent;
			assert.equal(text.startsWith(`${order_label()}: `), true, `indicator text '${text}'`);
			assert.equal(text.includes(column_label(instance)), true, `the column label is missing from '${text}'`);
			assert.equal(indicator.querySelector('.order_direction').textContent, '↓');
			assert.equal(
				indicator.getAttribute('aria-label').includes(get_label.descending || 'descending'),
				true,
				'the accessible name does not spell the direction',
			);
			assert.equal(indicator.querySelector(':scope > button.order_reset') instanceof HTMLButtonElement, true);
			assert.equal(indicator.querySelector(':scope > button.order_save') instanceof HTMLButtonElement, true);

			// a second click reverses it
			await click_sort(instance);
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'ASC' });
			indicator = indicator_of(instance);
			assert.equal(indicator.querySelector('.order_direction').textContent, '↑');
			assert.deepEqual(last(spy.view_reads).sqo.view_order, { tipo: ORDER_COLUMN, direction: 'ASC' });
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'a header click wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('pagination and a destroying refresh keep the view order', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			await click_sort(instance);
			const moved = await instance.navigate({
				callback: () => {
					instance.rqo.sqo.offset = PAGE_LIMIT;
				},
			});
			assert.equal(moved, true, 'portal navigate refused');
			assert.deepEqual(last(spy.reads).sqo.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.equal(last(spy.reads).sqo.offset, PAGE_LIMIT);

			const refreshed = await instance.refresh(); // destroy:true (the default)
			assert.equal(refreshed, true, 'refresh refused');
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.deepEqual(last(spy.reads).sqo.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.equal(indicator_of(instance) instanceof HTMLElement, true, 'the indicator was lost on refresh');
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'paging wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('reset: back to the saved order — no view_order on the read, no indicator, drag source back', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			const sort_node = await click_sort(instance);
			const reads_before = spy.reads.length;
			await click_indicator(instance, '.order_reset', () => instance.view_order === null && !indicator_of(instance));
			assert.equal(spy.reads.length, reads_before + 1, 'reset did not re-read');
			assert.equal('view_order' in last(spy.reads).sqo, false, 'the reset read still carries a view_order');
			assert.equal(indicator_of(instance), null);
			assert.equal(sort_node.classList.contains('asc') || sort_node.classList.contains('desc'), false, 'the arrow kept its direction');
			assert.equal(handles_of(instance).length, PAGE_LIMIT, 'the drag source did not come back');
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'reset wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('save current order: ONE sort_by_column request (column + direction), then the view order clears', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			await click_sort(instance);
			await click_indicator(instance, '.order_save', () => spy.sort_saves.length > 0 && instance.view_order === null);
			assert.equal(spy.sort_saves.length, 1, 'save current order did not send exactly one sort_by_column');
			const changed = spy.sort_saves[0].data.changed_data;
			assert.equal(changed.length, 1);
			assert.equal(changed[0].component_tipo, ORDER_COLUMN);
			assert.equal(changed[0].direction, 'DESC');
			assert.equal(instance.view_order, null, 'the view order outlived its save');
			assert.equal(indicator_of(instance), null, 'the indicator outlived the save');
			assert.equal(handles_of(instance).length, PAGE_LIMIT, 'the drag source did not come back after the save');
			assert.equal(spy.writes.length, 0, 'save current order sent another write');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('declared order: the indicator shows it PERMANENTLY (no button), no drag source', async () => {
		const instance = await build_portal({ declared: true });
		try {
			const indicator = indicator_of(instance);
			assert.equal(indicator instanceof HTMLElement, true, 'no indicator under a declared order');
			assert.equal(indicator.classList.contains('declared'), true);
			const text = indicator.querySelector('.order_text').textContent;
			assert.equal(text.includes(column_label(instance)), true, `the declared column is missing from '${text}'`);
			assert.equal(indicator.querySelector('.order_direction').textContent, '↑');
			assert.equal(indicator.querySelectorAll('button').length, 0, 'a button on the permanent declared order');
			assert.equal(handles_of(instance).length, 0, 'a drag source under a declared order');
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('declared order: the header view-sort works — temporary indicator + reset, never save, never a drag source', async () => {
		const instance = await build_portal({ declared: true });
		const spy = spy_api(instance);
		try {
			await click_sort(instance);
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.deepEqual(last(spy.view_reads).sqo.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			const indicator = indicator_of(instance);
			assert.equal(indicator.classList.contains('temporary'), true);
			assert.equal(indicator.querySelector(':scope > button.order_reset') instanceof HTMLButtonElement, true);
			assert.equal(indicator.querySelector(':scope > button.order_save'), null, 'a save button under a declared order');
			assert.equal(handles_of(instance).length, 0, 'a drag source under a declared order with a view order');

			// save_view_order refuses there, with nothing sent
			assert.equal(await instance.save_view_order(), false);
			assert.equal(spy.sort_saves.length, 0, 'a sort_by_column was sent under a declared order');

			// reset: back to the declared order
			await click_indicator(instance, '.order_reset', () => instance.view_order === null);
			const back = indicator_of(instance);
			assert.equal(back?.classList.contains('declared'), true, 'the declared order is not shown after reset');
			assert.equal(back.querySelectorAll('button').length, 0);
			assert.equal(handles_of(instance).length, 0, 'a drag source under a declared order after reset');
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'the declared-order legs wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('link / unlink under a view order: the save echo is not rendered — the rows are RE-READ under it', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		const view = { tipo: ORDER_COLUMN, direction: 'DESC' };
		let unlinked = null;
		/** After a save: a view-ordered read followed it, and every order claim matches that read. */
		const assert_read_under_view = (what) => {
			const last_write = spy.log.lastIndexOf('write');
			assert.equal(last_write > -1, true, `${what} sent no save`);
			assert.equal(
				spy.log.lastIndexOf('view_read') > last_write,
				true,
				`${what} rendered its save echo (STORED order) instead of re-reading under the view order`,
			);
			assert.deepEqual(last(spy.view_reads).sqo.view_order, view);
			// non-vacuous: the view-ordered page (reversed by the spy) differs from the
			// stored-order page the save echo carries, so rendering the echo fails here
			const view_keys = entry_keys(portal_datum_of(last(spy.view_answers)));
			assert.equal(view_keys.length > 1, true, `${what}: precondition — the view-ordered page has fewer than 2 rows`);
			assert.notDeepEqual(view_keys, [...view_keys].reverse(), `${what}: precondition — the page order is not observable`);
			assert.deepEqual(
				entry_keys(instance.data),
				view_keys,
				`${what}: the rendered rows are not the ones the view-ordered read answered`,
			);
			assert.deepEqual(instance.view_order, view, `${what} lost the view order`);
			assert.equal(indicator_of(instance)?.classList.contains('temporary'), true, `${what}: indicator not temporary`);
			assert.equal(sort_node_of(instance)?.classList.contains('desc'), true, `${what}: the arrow lost DESC`);
			assert.equal(handles_of(instance).length, 0, `${what}: a drag source under a view order`);
		};
		try {
			await click_sort(instance);
			const entry = instance.data.entries[0];
			assert.equal(Boolean(entry?.id), true, 'no row entry to unlink');
			unlinked = { section_tipo: entry.section_tipo, section_id: entry.section_id };

			assert.equal(await instance.unlink_record(entry), true, 'unlink refused');
			assert_read_under_view('unlink');

			const outcome = await instance.link_records([unlinked]);
			assert.equal(outcome.linked.length, 1, 'the relink was refused');
			unlinked = null;
			assert_read_under_view('link');
			assert.equal(spy.sort_saves.length, 0, 'a link / unlink persisted the view order');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
			if (unlinked) {
				// the fixture's three links must survive a failed leg
				const fixer = await build_portal({ limit: 10 });
				try {
					const restored = await fixer.link_records([unlinked]);
					if (restored.linked.length !== 1) {
						console.error('test_portal_order: the unlinked fixture record could not be re-linked', restored);
					}
				} finally {
					await fixer.destroy(true, true, true);
				}
			}
		}
	});

	it('a refused order change restores the previous order, offset and arrow (nothing read)', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			await click_sort(instance); // DESC
			const moved = await instance.navigate({
				callback: () => {
					instance.rqo.sqo.offset = PAGE_LIMIT;
				},
			});
			assert.equal(moved, true, 'portal navigate refused');
			const sort_node = sort_node_of(instance);
			assert.equal(sort_node?.classList.contains('desc'), true, 'precondition: the arrow shows DESC on page 2');
			const view_reads_before = spy.view_reads.length;
			// the re-read fails (an own property shadows the prototype refresh)
			instance.refresh = async () => false;
			try {
				sort_node.click(); // asks ASC
				const done = await wait_until(() => !sort_node.classList.contains('loading'));
				assert.equal(done, true, 'the refused header sort never settled');
			} finally {
				delete instance.refresh;
			}
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' }, 'the previous order was not restored');
			assert.equal(instance.rqo.sqo.offset, PAGE_LIMIT, 'the previous offset was not restored');
			assert.deepEqual(instance.rqo.sqo.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' }, 'the rqo kept the refused order');
			assert.equal(sort_node.classList.contains('desc'), true, 'the arrow does not show the restored DESC');
			assert.equal(sort_node.classList.contains('asc'), false, 'the arrow shows the refused ASC');
			assert.equal(spy.view_reads.length, view_reads_before, 'a refused change was read');
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'a refused change wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('single flight: an order change while another one or any read is in flight is refused, no second build', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		const proto_build = Object.getPrototypeOf(instance).build;
		let builds = 0;
		let on_build_started = null;
		// count every build; run `on_build_started` once the read is in flight (status 'building')
		instance.build = function (...args) {
			builds++;
			const pending = proto_build.apply(this, args);
			if (on_build_started) {
				const callback = on_build_started;
				on_build_started = null;
				callback();
			}
			return pending;
		};
		const desc = { tipo: ORDER_COLUMN, direction: 'DESC' };
		try {
			// 1. another order change (another column's arrow, Reset, Save) while the first reads
			let concurrent = null;
			let status_in_flight = null;
			on_build_started = () => {
				status_in_flight = instance.status;
				concurrent = Promise.all([
					instance.set_view_order({ tipo: ORDER_COLUMN, direction: 'ASC' }),
					instance.clear_view_order(),
					instance.save_view_order(),
				]);
			};
			const first = instance.set_view_order(desc);
			// the same tick: the claim is already held
			assert.equal(await instance.set_view_order({ tipo: ORDER_COLUMN, direction: 'ASC' }), false, 'a twin change in the same tick passed');
			assert.equal(await first, true, 'the first order change failed');
			assert.equal(status_in_flight, 'building', 'precondition: the concurrent calls ran while the first read was in flight');
			assert.deepEqual(await concurrent, [false, false, false], 'an order change / reset / save ran beside an in-flight one');
			assert.equal(builds, 1, 'a second build ran beside the first');
			assert.equal(spy.view_reads.length, 1, 'a second view-ordered read was sent');
			assert.equal(spy.sort_saves.length, 0, 'save current order was sent during a read');
			assert.deepEqual(instance.view_order, desc, 'a refused concurrent change altered the order');
			assert.equal(instance.status, 'rendered');

			// 2. any other read in flight (a plain refresh): refused on status, nothing built
			builds = 0;
			let during_refresh = null;
			on_build_started = () => {
				during_refresh = instance.set_view_order({ tipo: ORDER_COLUMN, direction: 'ASC' });
			};
			assert.equal(await instance.refresh({ destroy: false }), true, 'the refresh failed');
			assert.equal(await during_refresh, false, 'an order change ran beside a refresh');
			assert.equal(builds, 1, 'an order change built beside a refresh');
			assert.deepEqual(instance.view_order, desc, 'the refused change altered the order');

			// 3. the claim is released: idle again, a reset is accepted
			assert.equal(await instance.clear_view_order(), true, 'reset refused after the refused changes');
			assert.equal(spy.writes.length, 0, 'the single-flight leg wrote');
		} finally {
			delete instance.build;
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('a view order the SERVER refuses: re-read under the previous order, the portal stays usable', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			const reads_before = spy.reads.length;
			spy.refuse_view_reads = true;
			const changed = await instance.set_view_order({ tipo: ORDER_COLUMN, direction: 'DESC' });
			spy.refuse_view_reads = false;
			assert.equal(changed, false, 'a refused view order reported success');
			assert.equal(spy.view_reads.length, 1, 'the view-ordered read was not sent');
			assert.equal(instance.view_order, null, 'the refused order was kept');
			assert.equal('view_order' in instance.rqo.sqo, false, 'the rqo kept the refused order');
			// the failed build left the instance 'initialized'; it is re-read and rendered
			assert.equal(instance.status, 'rendered', 'the portal is left unusable after the refused read');
			assert.equal(spy.reads.length, reads_before + 2, 'no re-read under the restored order');
			assert.equal('view_order' in last(spy.reads).sqo, false, 'the recovery read carries the refused order');
			assert.equal(indicator_of(instance), null, 'an indicator for an order that was never read');
			assert.equal(sort_node_of(instance)?.classList.contains('desc'), false, 'the arrow shows the refused order');
			assert.equal(handles_of(instance).length, PAGE_LIMIT, 'the drag source did not come back');
			assert.equal(content_of(instance).children.length, PAGE_LIMIT, 'the rows were not rendered again');

			// usable: every refresh-driven action is accepted again
			assert.equal(await instance.refresh({ destroy: false }), true, 'refresh refused after the recovery');
			assert.equal(
				await instance.set_view_order({ tipo: ORDER_COLUMN, direction: 'ASC' }),
				true,
				'a later header sort refused after the recovery',
			);
			assert.equal(await instance.clear_view_order(), true, 'reset refused after the recovery');
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'the refused view order wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	it('a refused "save current order": the view order stands, indicator temporary with both buttons, rows re-read under it', async () => {
		const instance = await build_portal();
		const spy = spy_api(instance);
		try {
			await click_sort(instance); // DESC
			const view_reads_before = spy.view_reads.length;
			spy.refuse_sort_saves = true;
			const answer = await instance.save_view_order();
			spy.refuse_sort_saves = false;
			assert.equal(spy.sort_saves.length, 1, 'save current order sent no sort_by_column');
			assert.equal(request_failed(answer), true, 'the refusal did not reach the caller');
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' }, 'a refused save cleared the view order');
			const indicator = indicator_of(instance);
			assert.equal(indicator?.classList.contains('temporary'), true, 'the indicator is not temporary after a refused save');
			assert.equal(indicator.querySelector(':scope > button.order_reset') instanceof HTMLButtonElement, true);
			assert.equal(indicator.querySelector(':scope > button.order_save') instanceof HTMLButtonElement, true);
			assert.equal(sort_node_of(instance)?.classList.contains('desc'), true, 'the arrow lost DESC');
			assert.equal(handles_of(instance).length, 0, 'a drag source under the standing view order');
			// the refusal echo is dropped (echo_hides_view_order): the rows are re-read under the view order
			assert.equal(spy.view_reads.length, view_reads_before + 1, 'no re-read under the view order after the refused save');
			assert.deepEqual(last(spy.view_reads).sqo.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			assert.equal(instance.status, 'rendered', 'the portal is left unusable after the refused save');
			assert.equal(spy.writes.length, 0, 'the refused save sent another write');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});

	/**
	 * The mosaic alt table: ONE indicator per portal. The alt modal's list_after opts out
	 * (order_indicator:false), so the main list's slot is the only Save / Reset group.
	 */
	const open_alt_of = async (instance) => {
		const tile = content_of(instance).children[0];
		assert.equal(tile instanceof Element, true, 'the mosaic has no tile');
		tile.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		assert.equal(await wait_until(() => tile.querySelector(':scope > .sr_mosaic_hover')), true, 'the tile showed no hover overlay');
		const button = tile.querySelector(':scope > .sr_mosaic_hover > .button_alt_container');
		assert.equal(button instanceof Element, true, 'the hover overlay has no alt button');
		button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		assert.equal(await wait_until(() => instance.record_windows?.alt && instance.modal), true, 'the alt table never opened');
		return instance.modal;
	};
	const close_alt_of = async (instance) => {
		if (instance.record_windows?.alt && instance.modal) {
			instance.modal.close();
			await wait_until(() => !instance.record_windows?.alt);
		}
	};
	for (const leg of [
		{ name: 'a view order', declared: false },
		{ name: 'a declared order', declared: true },
	]) {
		it(`mosaic under ${leg.name}: the alt table adds no second order indicator`, async () => {
			const instance = await build_portal({ view: 'mosaic', declared: leg.declared });
			const spy = spy_api(instance);
			try {
				if (!leg.declared) {
					assert.equal(
						await instance.set_view_order({ tipo: ORDER_COLUMN, direction: 'DESC' }),
						true,
						'the mosaic portal refused the view order',
					);
				}
				assert.equal(instance.node.querySelectorAll('.order_indicator').length, 1, 'the mosaic list shows no single indicator');
				const modal = await open_alt_of(instance);
				assert.equal(modal.querySelector('.content_data') instanceof Element, true, 'the alt table rendered no rows');
				assert.equal(modal.querySelectorAll('.order_indicator').length, 0, 'the alt table shows a second order indicator');
				assert.equal(instance.node.querySelectorAll('.order_indicator').length, 1, 'opening the alt table changed the list indicator');
				assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'the mosaic legs wrote');
			} finally {
				await close_alt_of(instance);
				spy.restore();
				instance.view_order = null;
				await instance.destroy(true, true, true);
			}
		});
	}

	it('read permission: the arrow and reset are offered, save is not', async () => {
		const instance = await build_portal({ permissions: 1 });
		const spy = spy_api(instance);
		try {
			assert.equal(instance.permissions, 1, 'the instance is not at read permission');
			await click_sort(instance);
			assert.deepEqual(instance.view_order, { tipo: ORDER_COLUMN, direction: 'DESC' });
			const indicator = indicator_of(instance);
			assert.equal(indicator?.classList.contains('temporary'), true, 'no temporary indicator at read permission');
			assert.equal(indicator.querySelector(':scope > button.order_reset') instanceof HTMLButtonElement, true);
			assert.equal(indicator.querySelector(':scope > button.order_save'), null, 'a save button at read permission');
			assert.equal(await instance.save_view_order(), false, 'save_view_order accepted at read permission');
			assert.equal(spy.writes.length + spy.sort_saves.length, 0, 'read permission wrote');
		} finally {
			spy.restore();
			instance.view_order = null;
			await instance.destroy(true, true, true);
		}
	});
});

describe('PORTAL ORDER — gates (backend-free)', function () {
	const opted = { tipo: 'x1', sortable: true, sort_by_column: true };

	/** A plain portal-shaped self: edit, read permission, default view, own source. */
	const fake_portal = (overrides = {}) =>
		Object.assign(
			{
				model: 'component_portal',
				mode: 'edit',
				permissions: 1,
				view: 'default',
				context: { properties: {} },
				can_view_sort(column) {
					return can_view_sort(this, column);
				},
			},
			overrides,
		);

	it('ui.allow_column_order: read permission is enough; print, external, unopted and non-edit are refused', () => {
		assert.equal(ui.allow_column_order(fake_portal(), opted), true, 'read permission (1) gets no arrow');
		assert.equal(ui.allow_column_order(fake_portal({ permissions: 2 }), opted), true);
		assert.equal(ui.allow_column_order(fake_portal({ permissions: 0 }), opted), false, 'no permission got an arrow');
		assert.equal(ui.allow_column_order(fake_portal({ view: 'print' }), opted), false, 'the print view got an arrow');
		assert.equal(
			ui.allow_column_order(fake_portal({ view: undefined, context: { view: 'print', properties: {} } }), opted),
			false,
			'a context print view got an arrow',
		);
		assert.equal(
			ui.allow_column_order(fake_portal({ context: { properties: { source: { mode: 'external' } } } }), opted),
			false,
			'an external source got an arrow',
		);
		assert.equal(ui.allow_column_order(fake_portal(), { ...opted, sort_by_column: false }), false, 'an unopted column got an arrow');
		assert.equal(ui.allow_column_order(fake_portal(), { ...opted, sortable: false }), false, 'an unsortable column got an arrow');
		assert.equal(ui.allow_column_order(fake_portal({ mode: 'list' }), opted), false, 'a list-mode portal got an arrow');
		assert.equal(ui.allow_column_order(fake_portal({ can_view_sort: undefined }), opted), false);
	});

	it('header arrow: the default direction follows the LIVE view order, never a stale closure', async () => {
		// a portal-shaped self whose set_view_order records the asked direction
		const asked = [];
		const self = fake_portal({
			view_order: { tipo: 'a', direction: 'ASC' }, // the header is BUILT under A's order
			set_view_order(view_order) {
				asked.push(view_order);
				return Promise.resolve(false); // nothing re-read: the state is the test's
			},
		});
		const header_wrapper = document.createElement('div');
		header_wrapper.sort_nodes = [];
		const arrow_a = ui.add_column_order_set(self, { tipo: 'a', sortable: true, sort_by_column: true }, header_wrapper);
		const arrow_b = ui.add_column_order_set(self, { tipo: 'b', sortable: true, sort_by_column: true }, header_wrapper);
		header_wrapper.sort_nodes.push(arrow_a, arrow_b);
		/** Put the portal under `view_order` the way its render does (classes re-synced). */
		const under = (view_order) => {
			self.view_order = view_order;
			ui.set_column_order_state(header_wrapper, view_order);
		};
		const hover = (arrow) => arrow.dispatchEvent(new MouseEvent('mouseenter'));
		/** Hover + click; resolves once the click settled (its loading guard is gone). */
		const hover_and_click = async (arrow) => {
			const count = asked.length;
			hover(arrow);
			arrow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			assert.equal(asked.length, count + 1, 'the click asked no order');
			assert.equal(await wait_until(() => !arrow.classList.contains('loading')), true, 'the click never settled');
			return last(asked);
		};

		// B becomes the active order (another column's click): the first click on A
		// sorts ascending — A's build-time 'ASC' must not block the flip
		under({ tipo: 'b', direction: 'DESC' });
		assert.deepEqual(await hover_and_click(arrow_a), { tipo: 'a', direction: 'ASC' }, 'a stale closure blocked the ASC default');

		// B hovered while A is active (its default flips to ASC) ... then the view order
		// is cleared (reset / save): the first click on B sorts descending again
		under({ tipo: 'a', direction: 'ASC' });
		hover(arrow_b);
		under(null);
		assert.deepEqual(await hover_and_click(arrow_b), { tipo: 'b', direction: 'DESC' }, 'the default stayed ASC with no active order');

		// the active column toggles its LIVE direction
		under({ tipo: 'a', direction: 'DESC' });
		assert.deepEqual(await hover_and_click(arrow_a), { tipo: 'a', direction: 'ASC' }, 'the active column did not toggle');
	});

	it('can_save_view_order: write permission only', () => {
		const view_order = { tipo: 'x1', direction: 'ASC' };
		assert.equal(can_save_view_order(fake_portal({ view_order, permissions: 1 })), false, 'save offered at read permission');
		assert.equal(can_save_view_order(fake_portal({ view_order, permissions: 2 })), true);
		assert.equal(can_save_view_order(fake_portal({ view_order: null, permissions: 2 })), false);
	});

	it('declared_order_of: absent / empty / non-array / mixed entries normalize', () => {
		const self = { context: {} };
		assert.deepEqual(declared_order_of(self), [], 'absent');
		assert.deepEqual(declared_order_of(null), [], 'no instance');
		self.context.declared_order = [];
		assert.deepEqual(declared_order_of(self), [], 'empty');
		self.context.declared_order = true;
		assert.deepEqual(declared_order_of(self), [{ tipo: null, direction: null }], 'a non-array truthy value');
		self.context.declared_order = [{ tipo: 'a', direction: 'DESC' }, null, 'b', { tipo: 5 }];
		assert.deepEqual(
			declared_order_of(self),
			[
				{ tipo: 'a', direction: 'DESC' },
				{ tipo: null, direction: 'ASC' },
			],
			'mixed entries',
		);
		// the gates agree with it (has_declared_order = a non-empty list)
		const write_self = Object.assign(fake_portal({ view_order: { tipo: 'a', direction: 'ASC' }, permissions: 2 }), {
			context: self.context,
		});
		assert.equal(can_save_view_order(write_self), false, 'save offered under a declared order');
		write_self.context.declared_order = [];
		assert.equal(can_save_view_order(write_self), true, 'an empty declared list still blocks save');
	});
});

// @license-end
