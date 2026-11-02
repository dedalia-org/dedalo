// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/

import { request_failed, response_data } from '../../../core/common/js/api_error.js';
import { lock_rows } from '../../../core/common/js/common.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import {
	deregister_uncommitted_input,
	deregister_unsaved_instance,
	events_init,
	get_unsaved_instances,
	orphaned_unsaved,
	register_uncommitted_input,
	register_unsaved_instance,
	reset_unsaved_data,
	uncommitted_nodes_snapshot,
} from '../../../core/common/js/events.js';
import { get_all_instances, get_instance } from '../../../core/common/js/instances.js';
import { ROW_WINDOW_MAX_ROWS } from '../../../core/common/js/row_window.js';
import { max_page_limit } from '../../../core/common/js/sqo_limit.js';
import { ui } from '../../../core/common/js/ui.js';
import {
	orphan_unsaved_instance,
	save_unsaved_components,
} from '../../../core/component_common/js/component_common.js';
import { activate_autocomplete } from '../../../core/component_portal/js/render_edit_component_portal.js';
import { ts_object } from '../../../core/ts_object/js/ts_object.js';

/**
 * TEST_ROW_INVARIANT
 * The ROW INVARIANT of every adopted row view, measured on the real views
 * (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md):
 *   - `content_data.children` is exactly one `.section_record` per entry, child
 *     i carrying `data-index="i"`; at most ROW_WINDOW_MAX_ROWS are BUILT, the
 *     rest childless `aria-hidden` placeholders, which exist only above the bound;
 *   - the roles per layout: table → list_body[table] > content_data[rowgroup] >
 *     row[row], and on desktop the table's content_data and rows are grid boxes
 *     (a view sheet flattening them to `display: contents` beats the row box); list → content_data[list] > row[listitem]; a zero-row
 *     content_data carries no role and a header-less zero-row table drops its own;
 *   - `.list_after` is the ONE non-row sibling: never inside content_data, never
 *     inside role=table; a section's zero-row list says no_records there, and a
 *     window over the bound carries the print notice there;
 *   - `ar_instances` holds EXACTLY the built rows after every transition (no
 *     leak), the door's generation only grows, and a transition to N=0 retires
 *     the old window (size 0, no row record left).
 *
 * Every view is built for real on the SUITE database (test3 list, the test80
 * portal on test3/2, the dd15 Time Machine list scoped to test3/1) and then
 * handed synthetic pages of N ∈ {0, 3, 201, max} locator entries through the
 * same door a row-set operation uses: the owner row lock, then a content
 * render. The cells render empty — the invariant is about rows, not values.
 *
 * Plus the operation legs on REAL data: section pagination keeps the invariant;
 * a pending editor node REFUSES a row-set operation on Cancel (nothing changes)
 * and proceeds on OK (the node is discarded); the door's generation survives a
 * destroying refresh.
 *
 * And, on a scratch situation BUILT here (test3 records created through the
 * engine's create door, linked into the test80 portal of a scratch test3 host,
 * swept in after()):
 *   - ROW LOCK: one refusal leg per lock_rows call site (portal navigate, tag
 *     filter, reset filter, link, unlink, add, sort_data, sort_by_column,
 *     refresh destroy:true / destroy:false, section refresh destroy:true): Cancel
 *     returns the refusal with nothing sent, written or replaced; the SAME
 *     operation then runs again and renders normally (the invariant holds after
 *     it: tag filter, link and sort keep it). OK: scoped discard (an unrelated
 *     unsaved instance and an orphan stay registered) and freeze (the old rows
 *     are inert while the request is held). Owner destroy with a pending node
 *     logs it and completes;
 *   - lock before prompt: a typed-not-blurred real input_text is committed by
 *     both navigates without a confirm, and saved; an unrelated failed save or
 *     orphan does not make portal navigate prompt nor touch the registry;
 *   - edit safety on real editors: flush commits a typed-not-blurred input_text
 *     and saves it; every change-committing editor advances commit_seq on the
 *     window's synthetic change; a dirty failed row leaves an orphan (still
 *     registered) and the rebuilt row a fresh instance; an open autocomplete
 *     pins its row, and so does a real dataframe whose frame modal is being
 *     edited (the modal lives outside the row: its section hangs from the
 *     slot); destroy:false adoption keeps a dirty changed_data;
 *   - N=3→0 through unlink and through an empty tag filter retires the window;
 *   - a nested list portal is destroyed in cascade with its outer row; the Time
 *     Machine decorate / mark_empty_columns reach a row built late; a portal
 *     embedded in a ts_object node renders through the door and goes with it;
 *   - mosaic (the core mosaic portal and one tool mosaic, whose view installs
 *     its own hover controller): the hover overlay's own editors (committed,
 *     never pending; a stub that ignores change refuses and defers the
 *     teardown); the core mosaic's alt modal
 *     (slot 'alt' never touches the tile window; a dirty alt edit survives close).
 */

// events_init. The uncommitted-node guard's document listeners (the `input`
// arm, the `change` / `focusout` retire) are what the window's commit judges
// against. The application attaches them from core/page/js/index.js, which the
// test runner page never boots, so the suite attaches the REAL wiring itself.
events_init();

// DOM container
const container = document.getElementById('content');
const test_container = ui.create_dom_element({
	element_type: 'div',
	class_name: 'container row_invariant',
	parent: container,
});

/** Two animation frames: the window arms (connected sync) on the first. */
const frames = () =>
	new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const entries_of = (section_tipo, n) =>
	Array.from({ length: n }, (_, i) => ({
		section_tipo: section_tipo,
		section_id: i + 1,
		paginated_key: i,
	}));

const row_instances = (owner) => (owner.ar_instances || []).filter((el) => el.model === 'section_record');

/**
 * VIEW_CASES
 * Every adopted view (the row-box WC entry's scope). `layout` is what the view
 * hands the door; `section: true` marks the section lists (no_records in
 * list_after at N=0).
 */
const section_case = (view, layout) => ({
	name: `section ${view}`,
	layout,
	section: true,
	entries_tipo: 'test3',
	make: () =>
		get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'list',
			view: view,
			id_variant: `row_invariant_${view}`,
		}),
	view,
});

/** The inspector's history read: its row source is matrix_time_machine. */
const history_sqo = () => {
	const sqo = {
		id: 'section_history',
		section_tipo: ['test3'],
		limit: 10,
		offset: 0,
		order: [{ direction: 'DESC', path: [{ component_tipo: 'id' }] }],
		skip_projects_filter: true,
		filter_by_locators: [{ section_tipo: 'test3', section_id: 1 }],
	};
	sqo.mode = 'tm'; // the ROW SOURCE (never a render mode)
	return sqo;
};

const tm_case = (tm_view, layout) => ({
	name: `time machine ${tm_view}`,
	layout,
	section: true,
	entries_tipo: 'dd15',
	make: async () => {
		const tm_list = await get_instance({
			model: 'section',
			tipo: 'dd15',
			section_tipo: 'dd15',
			mode: 'list',
			id_variant: `row_invariant_tm_${tm_view}`,
			caller_tipo: 'test3',
			buttons: false,
			filter: false,
			session_save: false,
			request_config: [
				{
					api_engine: 'dedalo',
					type: 'main',
					sqo: history_sqo(),
					show: {},
				},
			],
		});
		tm_list.source_add = { tm_surface: 'inspector_record' };
		tm_list.tm_no_id_column = true;
		tm_list.tm_view = tm_view;
		return tm_list;
	},
});

const portal_case = (view, mode, layout, references = false, labelled = false) => ({
	name: `portal ${mode} ${view}`,
	layout,
	section: false,
	entries_tipo: 'test3',
	make: () =>
		get_instance({
			model: 'component_portal',
			tipo: 'test80',
			section_tipo: 'test3',
			section_id: 2,
			mode: mode,
			view: view,
			id_variant: `row_invariant_${mode}_${view}`,
		}),
	view,
	references,
	labelled,
});

const tool_case = (host, view, render, path) => ({
	name: `tool mosaic ${view}`,
	layout: 'list',
	section: host === 'section',
	tool: { view, render, path, mode: host === 'section' ? 'list' : 'edit' },
	entries_tipo: 'test3',
	make: () =>
		host === 'section'
			? get_instance({
					model: 'section',
					tipo: 'test3',
					section_tipo: 'test3',
					mode: 'list',
					id_variant: `row_invariant_${view}`,
				})
			: get_instance({
					model: 'component_portal',
					tipo: 'test80',
					section_tipo: 'test3',
					section_id: 2,
					mode: 'edit',
					view: view,
					id_variant: `row_invariant_${view}`,
				}),
	view,
});

const VIEW_CASES = [
	section_case('default', 'table'),
	section_case('base', 'table'),
	section_case('thesaurus_list', 'table'),
	tm_case('tool', 'table'),
	tm_case('mini', 'table'),
	tm_case('history', 'list'),
	portal_case('default', 'edit', 'table', true, true),
	portal_case('content', 'edit', 'table', true),
	portal_case('line', 'edit', 'list', true),
	portal_case('tree', 'edit', 'list'),
	portal_case('indexation', 'edit', 'list'),
	portal_case('mosaic', 'edit', 'list'),
	portal_case('default', 'list', 'table'),
	portal_case('line', 'list', 'list'),
	tool_case(
		'section',
		'tool_cataloging_mosaic',
		'view_tool_cataloging_mosaic',
		'../../../tools/tool_cataloging/js/view_tool_cataloging_mosaic.js',
	),
	tool_case(
		'portal',
		'coins_mosaic',
		'view_coins_mosaic_portal',
		'../../../tools/tool_numisdata_order_coins/js/view_coins_mosaic_portal.js',
	),
];

/**
 * ASSERT_INVARIANT
 * @param {Object} owner
 * @param {Object} view_case
 * @param {number} n - the page size handed to the view
 * @returns {number} the built row count
 */
const assert_invariant = (owner, view_case, n) => {
	const wrapper = owner.node;
	const content_data = wrapper.content_data || wrapper.querySelector('.content_data');
	assert.equal(content_data instanceof Element, true, 'content_data expected');
	const record_window = owner.record_windows?.rows;
	assert.equal(Boolean(record_window), true, 'no record window on the owner (record_windows.rows)');
	assert.equal(record_window.size, n, 'the window holds the page');

	// rows
	const children = Array.from(content_data.children);
	assert.equal(children.length, n, `content_data has ${children.length} children for ${n} entries`);
	let built = 0;
	let placeholders = 0;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!child.classList.contains('section_record') || child.dataset.index !== String(i)) {
			assert.fail(`child ${i} is not the section_record of index ${i}`);
		}
		if (child.classList.contains('placeholder')) {
			placeholders++;
			if (child.childNodes.length !== 0 || child.getAttribute('aria-hidden') !== 'true') {
				assert.fail(`placeholder ${i} is not an aria-hidden leaf`);
			}
		} else {
			built++;
		}
	}
	assert.equal(built, Math.min(n, ROW_WINDOW_MAX_ROWS), 'built rows = min(N, bound)');
	assert.equal(placeholders, Math.max(0, n - ROW_WINDOW_MAX_ROWS), 'placeholders only above the bound');

	// no leak: the registered rows ARE the built rows
	const instances = row_instances(owner);
	assert.equal(instances.length, built, `ar_instances holds ${instances.length} rows for ${built} built`);
	for (let i = 0; i < children.length; i++) {
		const instance = record_window.record_at(i);
		if (instance && !instances.includes(instance)) {
			assert.fail(`built row ${i}'s record is not in ar_instances`);
		}
	}

	// roles
	const list_body = content_data.parentElement?.classList.contains('list_body')
		? content_data.parentElement
		: null;
	if (n === 0) {
		assert.equal(content_data.getAttribute('role'), null, 'a zero-row content_data carries no role');
		if (view_case.layout === 'table' && list_body) {
			const header = list_body.querySelector(':scope > .header_wrapper_list');
			const visible = Boolean(header) && !header.classList.contains('hide') && !header.hasAttribute('hidden');
			assert.equal(
				list_body.getAttribute('role'),
				visible ? 'table' : null,
				'a zero-row table keeps role=table only with a visible header row',
			);
		}
	} else if (view_case.layout === 'table') {
		assert.equal(content_data.getAttribute('role'), 'rowgroup');
		if (list_body) {
			assert.equal(list_body.getAttribute('role'), 'table');
			// a wrapper that renders a label node names its table with it
			const label_id = wrapper.label?.id || null;
			if (view_case.labelled) {
				assert.equal(Boolean(label_id), true, 'this view renders a label node (the aria-labelledby leg would be vacuous)');
			}
			if (label_id) {
				assert.equal(list_body.getAttribute('aria-labelledby'), label_id, 'the table is not named by the owner label');
			}
		}
		for (const child of children) {
			if (child.getAttribute('role') !== 'row') {
				assert.fail(`row ${child.dataset.index} has role ${child.getAttribute('role')}, not row`);
			}
		}
		// the ROW BOX, as the browser lays it out: on desktop (and print) the
		// table rule makes content_data and every row a grid box (column subgrid).
		// A view sheet that flattens them (`display: contents`) beats the table
		// rule and the row has no box: no ring, no drop target.
		if (list_body?.classList.contains('layout_table') && window.matchMedia('(min-width: 1025px)').matches) {
			assert.equal(getComputedStyle(content_data).display, 'grid', 'a table content_data is not a grid box');
			for (const child of children) {
				const display = getComputedStyle(child).display;
				if (display !== 'grid') {
					assert.fail(`table row ${child.dataset.index} is display:${display}, not a grid row box`);
				}
			}
		}
	} else {
		assert.equal(content_data.getAttribute('role'), 'list');
		for (const child of children) {
			if (child.getAttribute('role') !== 'listitem') {
				assert.fail(`row ${child.dataset.index} has role ${child.getAttribute('role')}, not listitem`);
			}
		}
	}

	// list_after: the one non-row sibling
	const list_afters = Array.from(wrapper.querySelectorAll('.list_after')).filter(
		(node) => !content_data.contains(node),
	);
	assert.equal(list_afters.length <= 1, true, `${list_afters.length} .list_after nodes in one owner`);
	const list_after = list_afters[0] || null;
	if (list_after) {
		assert.equal(list_after.closest('[role="table"]'), null, '.list_after inside role=table');
		assert.equal(
			list_after.previousElementSibling,
			list_body || content_data,
			'.list_after is not the sibling right after list_body / content_data',
		);
	}
	if (view_case.section && n === 0) {
		assert.equal(Boolean(list_after?.querySelector('.no_records')), true, 'a zero-row section says no_records in .list_after');
	}
	if (n > ROW_WINDOW_MAX_ROWS) {
		assert.equal(Boolean(list_after?.querySelector('.print_notice')), true, 'a window over the bound carries the print notice in .list_after');
	}
	if (view_case.references && n > 0 && (owner.data?.references || []).length > 0) {
		assert.equal(Boolean(list_after?.querySelector('.references, .references_container')), true, 'references live in .list_after');
	}

	return built;
};

const PAGE_SIZES = () => [0, 3, ROW_WINDOW_MAX_ROWS + 1, max_page_limit(), 3, 0];

for (const view_case of VIEW_CASES) {
	describe(`ROW INVARIANT — ${view_case.name}`, function () {
		this.timeout(120000);

		let owner;
		let generation = 0;

		PAGE_SIZES().forEach((n, step) => {
			it(`step ${step}: N=${n} keeps the invariant, the roles and .list_after`, async () => {
				if (step === 0) {
					owner = await view_case.make();
					await owner.build(true);
					if (view_case.tool) {
						owner.render_views = owner.render_views || [];
						owner.render_views.push({
							view: view_case.tool.view,
							mode: view_case.tool.mode,
							render: view_case.tool.render,
							path: view_case.tool.path,
						});
						for (const column of owner.columns_map || []) {
							column.in_mosaic = true;
							column.hover = true;
						}
					}
					if (view_case.view) {
						owner.view = view_case.view;
						if (owner.context) {
							owner.context.view = view_case.view;
						}
					}
					owner.data = owner.data || {};
					owner.data.entries = entries_of(view_case.entries_tipo, n);
					const node = await owner.render();
					test_container.appendChild(node);
				} else {
					// the row-set operation shape: lock, mutate, content render
					const previous = owner.record_windows.rows;
					const release = await lock_rows(owner);
					assert.equal(typeof release, 'function', 'the row lock was refused with nothing pending');
					try {
						owner.data.entries = entries_of(view_case.entries_tipo, n);
						// a row-set operation rebuilds before it renders (status 'built');
						// a 'rendered' owner asked for the same level returns its old node
						owner.status = 'built';
						await owner.render({ render_level: 'content' });
					} finally {
						release();
					}
					assert.notEqual(owner.record_windows.rows, previous, 'the content render did not supersede the window');
				}
				await frames();

				const next_generation = owner.record_window_generation?.rows;
				assert.equal(next_generation > generation, true, 'the door generation must only grow');
				generation = next_generation;

				const built = assert_invariant(owner, view_case, n);
				assert.equal(built <= ROW_WINDOW_MAX_ROWS, true);
			});
		});

		it('destroying the owner destroys every window and row record', async () => {
			await owner.destroy(true, true, true);
			assert.equal(owner.record_windows, null);
			assert.equal(row_instances(owner).length, 0);
		});
	});
}

/**
 * OPERATIONS ON REAL DATA
 * test3 list, page limit 2: pagination keeps the invariant; a pending editor
 * node planted in a built row (an input no editor commits, registered as
 * uncommitted — the only way a value can live in a row and nowhere else)
 * refuses the operation on Cancel and is discarded on OK.
 */
describe('ROW INVARIANT — operations on the real test3 list', function () {
	this.timeout(120000);

	let section;
	const original_confirm = window.confirm;

	const build_section = async () => {
		section = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'list',
			id_variant: 'row_invariant_operations',
			session_save: false,
		});
		await section.build(true);
		section.rqo.sqo.limit = 2;
		section.rqo.sqo.offset = 0;
		await section.build(true);
		const node = await section.render();
		test_container.appendChild(node);
		await frames();
	};

	const plant_pending = () => {
		const row = section.node.content_data.children[0];
		const input = ui.create_dom_element({
			element_type: 'input',
			type: 'text',
			class_name: 'row_invariant_pending',
			value: 'typed, never committed',
			parent: row.querySelector('.column') || row,
		});
		register_uncommitted_input(input);
		return input;
	};

	it('pagination (section.navigate) keeps the invariant and ar_instances === built', async () => {
		await build_section();
		const generation = section.record_window_generation.rows;
		const n_before = section.record_windows.rows.size;
		assert.equal(n_before > 0, true, 'the suite test3 list has records');

		const moved = await section.navigate({
			callback: () => {
				section.rqo.sqo.offset = 2;
			},
			navigation_history: false,
		});
		assert.equal(moved, true, 'section.navigate refused with nothing pending');
		await frames();
		assert.equal(section.record_window_generation.rows > generation, true);
		const n = section.record_windows.rows.size;
		assert_invariant(section, { layout: 'table', section: true }, n);
	});

	it('a pending row node REFUSES navigate on Cancel: nothing changes', async () => {
		const pending = plant_pending();
		window.confirm = () => false;
		try {
			const content_data = section.node.content_data;
			const record_window = section.record_windows.rows;
			const offset = section.rqo.sqo.offset;
			const data = section.data;

			const moved = await section.navigate({
				callback: () => {
					section.rqo.sqo.offset = 0;
				},
				navigation_history: false,
			});
			assert.equal(moved, false, 'navigate proceeded over a pending node');
			assert.equal(section.status, 'rendered');
			assert.equal(section.node.content_data, content_data, 'content_data was replaced');
			assert.equal(section.record_windows.rows, record_window, 'the window was replaced');
			assert.equal(section.rqo.sqo.offset, offset, 'the offset moved');
			assert.equal(section.data, data, 'the data moved');
			assert.equal(content_data.closest('[inert]'), null, 'the refused rows were left inert');
			assert.equal(pending.value, 'typed, never committed');
			assert.equal(uncommitted_nodes_snapshot().includes(pending), true, 'the pending node left the registry');
		} finally {
			window.confirm = original_confirm;
		}
	});

	it('the same navigate proceeds on OK and discards the pending node', async () => {
		const pending = section.node.content_data.querySelector('.row_invariant_pending');
		assert.equal(Boolean(pending), true);
		window.confirm = () => true;
		try {
			const content_data = section.node.content_data;
			const moved = await section.navigate({
				callback: () => {
					section.rqo.sqo.offset = 0;
				},
				navigation_history: false,
			});
			assert.equal(moved, true, 'navigate refused after OK');
			await frames();
			assert.notEqual(section.node.content_data, content_data, 'the rows were not replaced');
			assert.equal(uncommitted_nodes_snapshot().includes(pending), false, 'the discarded node is still registered');
			assert_invariant(section, { layout: 'table', section: true }, section.record_windows.rows.size);
		} finally {
			window.confirm = original_confirm;
			deregister_uncommitted_input(pending);
		}
	});

	it('a pending row node REFUSES refresh on Cancel', async () => {
		const pending = plant_pending();
		window.confirm = () => false;
		try {
			const content_data = section.node.content_data;
			const result = await section.refresh({ destroy: false });
			assert.equal(result, false, 'refresh proceeded over a pending node');
			assert.equal(section.node.content_data, content_data);
			assert.equal(Boolean(section.record_windows), true, 'record_windows was nulled');
		} finally {
			window.confirm = original_confirm;
			deregister_uncommitted_input(pending);
			pending.remove();
		}
	});

	it('a pending row node REFUSES a destroying refresh on Cancel (record_windows kept)', async () => {
		const pending = plant_pending();
		window.confirm = () => false;
		try {
			const content_data = section.node.content_data;
			const record_window = section.record_windows.rows;
			const data = section.data;
			const result = await section.refresh({ destroy: true });
			assert.equal(result, false, 'refresh destroy:true proceeded over a pending node');
			assert.equal(section.status, 'rendered');
			assert.equal(section.node.content_data, content_data);
			assert.equal(section.record_windows?.rows, record_window, 'record_windows was nulled or replaced');
			assert.equal(section.data, data, 'the data moved');
			assert.equal(uncommitted_nodes_snapshot().includes(pending), true, 'the pending node left the registry');
		} finally {
			window.confirm = original_confirm;
			deregister_uncommitted_input(pending);
			pending.remove();
		}
	});

	it('the door generation survives a destroying refresh (owner-monotonic per slot)', async () => {
		const generation = section.record_window_generation.rows;
		const result = await section.refresh({ destroy: true });
		assert.notEqual(result, false, 'refresh refused with nothing pending');
		await frames();
		assert.equal(section.record_window_generation.rows > generation, true, 'the generation restarted');
		assert_invariant(section, { layout: 'table', section: true }, section.record_windows.rows.size);
	});

	it('destroying the section destroys its window', async () => {
		await section.destroy(true, true, true);
		assert.equal(section.record_windows, null);
	});
});

/**
 * SCRATCH SITUATION
 * Built here, never read from the ambient database: test3 records created
 * through the engine's create door — a host and a second host (test80 links),
 * the linked targets, an unlink victim, a spare to link and the record the
 * planted editors write into — plus one test1572 record whose list row carries
 * the nested test1613 list portal. Everything is swept in the last after()
 * (links first, then the records).
 */
const SCRATCH_SECTION = 'test3';
const PORTAL_TIPO = 'test80'; // test3 → test3, show ddo_map: test52
const EDITOR_TIPO = 'test52'; // component_input_text on test3
const NESTED_HOST_SECTION = 'test1572'; // its section_list carries the test1613 portal
const FRAME_HOST_SECTION = 'test6099'; // carries the test6744 dataframe slot (main test6117)
const FRAME_SLOT_TIPO = 'test6744'; // component_dataframe on test6099
const PAGE_LIMIT = 2;
const TARGET_COUNT = 5;

const scratch = {
	host: null,
	host_b: null,
	targets: [],
	victim: null,
	spare: null,
	editor_record: null,
	nested_host: null,
	frame_host: null,
	created: [],
};

const api = async (body) => {
	const api_response = await data_manager.request({ body });
	if (request_failed(api_response)) {
		throw new Error(`test_row_invariant: ${body.action} refused: ${api_response.error.code}`);
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
		throw new Error(`test_row_invariant: create returned no section_id for ${section_tipo}`);
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
		throw new Error(`test_row_invariant: count answered no total for ${section_tipo}`);
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

const locator_of = (section_id) => ({ section_tipo: SCRATCH_SECTION, section_id });

/** Whether `instance`'s caller chain reaches `ancestor` (the window's in_row walk). */
const reaches = (instance, ancestor) => {
	let current = instance;
	for (let depth = 0; current && depth < 32; depth++) {
		if (current === ancestor) {
			return true;
		}
		current = current.caller;
	}
	return false;
};

let scratch_seq = 0;

/**
 * BUILD_SCRATCH_PORTAL
 * A fresh test80 instance on a scratch host, page limit forced, rendered and
 * appended. `tool` ({render, path}) renders it through a tool mosaic view (the
 * tool's own render_views entry, every column in the mosaic and the hover),
 * the way tool_case does.
 * @param {Object} options - {host, view, limit, tool}
 * @return {Promise<Object>}
 */
const build_scratch_portal = async ({ host = scratch.host, view = 'default', limit = PAGE_LIMIT, tool = null } = {}) => {
	const instance = await get_instance({
		model: 'component_portal',
		tipo: PORTAL_TIPO,
		section_tipo: SCRATCH_SECTION,
		section_id: host,
		mode: 'edit',
		view: view,
		id_variant: `row_invariant_scratch_${view}_${++scratch_seq}`,
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
	if (tool) {
		instance.render_views = instance.render_views || [];
		instance.render_views.push({ view, mode: 'edit', render: tool.render, path: tool.path });
		for (const column of instance.columns_map || []) {
			column.in_mosaic = true;
			column.hover = true;
		}
	}
	const node = await instance.render();
	test_container.appendChild(node);
	await frames();
	return instance;
};

/**
 * SPY_REQUESTS
 * Record every data_manager request (pass-through by default). `answer`, when
 * given, decides per body: return undefined to pass through, anything else is
 * the response.
 * @param {Function} [answer]
 * @return {{calls: Array<Object>, restore: Function}}
 */
const spy_requests = (answer = null) => {
	const original = data_manager.request;
	const calls = [];
	data_manager.request = async (options) => {
		const body = options?.body || {};
		calls.push(body);
		const answered = answer ? await answer(body, () => original.call(data_manager, options)) : undefined;
		return answered !== undefined ? answered : original.call(data_manager, options);
	};
	return {
		calls,
		restore: () => {
			data_manager.request = original;
		},
	};
};

/** A save request of the planted editors' component. */
const is_editor_save = (body) => body?.action === 'save' && body?.source?.tipo === EDITOR_TIPO;

/** The failed-save envelope the client reads as an API error. */
const failed_save = () => ({
	ok: false,
	error: { is_api_error: true, code: 'request.invalid_data', message: 'test_row_invariant: save refused on purpose' },
});

/**
 * PLANT_PENDING_IN
 * An input no editor commits, registered as uncommitted inside row `index`:
 * the only way a value lives in a row and nowhere else (a pending node).
 */
const plant_pending_in = (owner, index = 0) => {
	const row = owner.node.content_data.children[index];
	const input = ui.create_dom_element({
		element_type: 'input',
		type: 'text',
		class_name: 'row_invariant_pending',
		value: 'typed, never committed',
		parent: row.querySelector(':scope > .column') || row,
	});
	register_uncommitted_input(input);
	return input;
};

const clear_pending = (node) => {
	if (node) {
		deregister_uncommitted_input(node);
		node.remove();
	}
};

/**
 * PLANT_EDITOR
 * A REAL editor, built and rendered in edit mode on the scratch editor record,
 * owned by `row_instance` (its caller — in_row reaches the row) and placed in
 * `host_node`; then TYPED, never blurred: its control holds `value` and is
 * registered as uncommitted (what the events.js capture `input` listener does).
 * @param {Object} row_instance - The section_record (or hover / alt record)
 * @param {HTMLElement} host_node - Where the editor's node goes (inside the row)
 * @param {Object} [options] - {model, tipo, type} the editor and how to type
 * @return {Promise<{editor: Object, control: HTMLElement, seq0: number, key: Object}>}
 */
const plant_editor = async (row_instance, host_node, options = {}) => {
	const model = options.model || 'component_input_text';
	const tipo = options.tipo || EDITOR_TIPO;
	const key = {
		model: model,
		tipo: tipo,
		section_tipo: SCRATCH_SECTION,
		section_id: scratch.editor_record,
		mode: 'edit',
		lang: page_globals?.dedalo_data_lang ?? 'lg-eng',
		id_variant: `row_invariant_editor_${++scratch_seq}`,
	};
	const editor = await get_instance({ ...key, caller: row_instance });
	editor.caller = row_instance;
	await editor.build(true);
	const node = await editor.render();
	assert.equal(node instanceof Element, true, `${model} rendered no node`);
	host_node.appendChild(node);
	row_instance.ar_instances = row_instance.ar_instances || [];
	if (!row_instance.ar_instances.includes(editor)) {
		row_instance.ar_instances.push(editor);
	}
	// some editors (component_iri) build their controls after an async step
	const find = options.find || ((n) => n.querySelector('input:not([type="hidden"]), select'));
	await wait_until(() => find(node) instanceof Element, 4000);
	const control = find(node);
	assert.equal(control instanceof Element, true, `${model} rendered no control to type into`);
	(options.type || ((c) => (c.value = `row invariant ${scratch_seq}`)))(control);
	control.dispatchEvent(new Event('input', { bubbles: true }));
	if (!uncommitted_nodes_snapshot().includes(control)) {
		register_uncommitted_input(control);
	}
	return { editor, control, seq0: editor.commit_seq || 0, key };
};

/** Every component of this suite's fakes leaves the registry whatever happens. */
const fake_component = (id) => ({
	id: id,
	type: 'component',
	model: 'component_input_text',
	tipo: EDITOR_TIPO,
	data: { changed_data: [{ action: 'update', id: 1, value: id }] },
	events_tokens: [],
	caller: { ar_instances: [] },
	save: async () => false,
	destroy: async () => true,
});

describe('ROW INVARIANT — scratch situation', function () {
	this.timeout(120000);

	before(async () => {
		scratch.host = await create_record(SCRATCH_SECTION);
		scratch.host_b = await create_record(SCRATCH_SECTION);
		for (let i = 0; i < TARGET_COUNT; i++) {
			scratch.targets.push(await create_record(SCRATCH_SECTION));
		}
		scratch.victim = await create_record(SCRATCH_SECTION);
		scratch.spare = await create_record(SCRATCH_SECTION);
		scratch.editor_record = await create_record(SCRATCH_SECTION);
		scratch.nested_host = await create_record(NESTED_HOST_SECTION);
		scratch.frame_host = await create_record(FRAME_HOST_SECTION);

		const portal = await build_scratch_portal({ limit: 20 });
		const outcome = await portal.link_records([...scratch.targets, scratch.victim].map(locator_of));
		await portal.destroy(true, true, true);
		if (outcome.linked.length !== TARGET_COUNT + 1) {
			throw new Error(`test_row_invariant: linked ${outcome.linked.length} of ${TARGET_COUNT + 1} records`);
		}
	});

	it('the scratch host holds its links', async () => {
		const portal = await build_scratch_portal({ limit: 20 });
		try {
			assert.equal(portal.record_windows.rows.size, TARGET_COUNT + 1);
		} finally {
			await portal.destroy(true, true, true);
		}
	});

	/**
	 * ROW LOCK — one refusal leg per lock_rows call site
	 * For each row-set operation: a pending node planted in row 0, Cancel answered →
	 * the operation answers its refusal, NOTHING is sent (network spy) or written
	 * (change_value spy), status / data / offset / content_data / window are the
	 * same objects, the rows are not inert, the node keeps its value, stays
	 * registered and holds the focus. Then the node goes, and the SAME operation
	 * runs again: it proceeds and renders new rows that keep the invariant.
	 * Removing the lock from any of these doors turns its leg red.
	 */
	const LOCK_OPERATIONS = [
		{
			name: 'portal navigate',
			limit: PAGE_LIMIT,
			run: (p) =>
				p.navigate({
					callback: () => {
						p.rqo.sqo.offset = PAGE_LIMIT;
					},
				}),
			refused: (result) => result === false,
		},
		{
			name: 'filter_data_by_tag_id',
			run: (p) => p.filter_data_by_tag_id({ tag: { tag_id: 'row_invariant_no_such_tag' } }),
			refused: (result) => result === false,
		},
		{
			name: 'reset_filter_data',
			run: (p) => p.reset_filter_data(),
			refused: (result) => result === false,
		},
		{
			name: 'link_records',
			run: (p) => p.link_records([locator_of(scratch.spare)]),
			refused: (result) => result?.linked?.length === 0 && result?.refused?.[0]?.reason === 'cancelled',
		},
		{
			name: 'unlink_record',
			run: (p) => {
				const entry = (p.data.entries || []).find((el) => Number(el.section_id) === scratch.victim);
				assert.equal(Boolean(entry), true, 'the unlink victim is not on the page');
				return p.unlink_record(entry);
			},
			refused: (result) => result === false,
		},
		{
			name: 'add_new_element',
			run: async (p) => {
				const result = await p.add_new_element(SCRATCH_SECTION);
				if (p.created_section_id) {
					scratch.created.push(Number(p.created_section_id));
				}
				return result;
			},
			refused: (result) => result === false,
		},
		{
			name: 'sort_data',
			run: (p) => {
				const entries = p.data.entries || [];
				return p.sort_data({
					value: entries[1],
					source_key: entries[1].paginated_key,
					target_key: entries[0].paginated_key,
				});
			},
			refused: (result) => result === false,
		},
		{
			name: 'sort_by_column',
			// the fixture declares no sort_by_column column (the server refuses the
			// write, which is not this gate's subject): the re-run stubs change_value
			stub_write: true,
			run: (p) => p.sort_by_column({ tipo: EDITOR_TIPO }, 'ASC'),
			refused: (result) => result === false,
		},
		{
			name: 'refresh destroy:true',
			run: (p) => p.refresh({ destroy: true }),
			refused: (result) => result === false,
		},
		{
			name: 'refresh destroy:false',
			run: (p) => p.refresh({ destroy: false }),
			refused: (result) => result === false,
		},
	];

	describe('ROW LOCK — one refusal leg per lock_rows call site (portal)', function () {
		this.timeout(120000);

		const original_confirm = window.confirm;

		for (const op of LOCK_OPERATIONS) {
			it(`${op.name}: Cancel refuses with nothing sent or changed; the same call then proceeds`, async () => {
				const portal = await build_scratch_portal({ limit: op.limit || 20 });
				let pending = null;
				try {
					pending = plant_pending_in(portal, 0);
					const before = {
						status: portal.status,
						data: portal.data,
						offset: portal.rqo?.sqo?.offset,
						content_data: portal.node.content_data,
						record_window: portal.record_windows.rows,
					};
					const writes = [];
					const original_change_value = portal.change_value;
					portal.change_value = async (options) => {
						writes.push(options);
						return original_change_value.call(portal, options);
					};
					const network = spy_requests();
					let confirms = 0;
					window.confirm = () => {
						confirms++;
						return false;
					};
					let result;
					try {
						result = await op.run(portal);
					} finally {
						network.restore();
						window.confirm = original_confirm;
					}
					assert.equal(confirms, 1, 'the lock did not ask (own confirm) about the pending node');
					assert.equal(op.refused(result), true, `${op.name} proceeded over a pending node`);
					assert.equal(network.calls.length, 0, `${op.name} sent ${network.calls.length} request(s) after a Cancel`);
					assert.equal(writes.length, 0, `${op.name} reached change_value after a Cancel`);
					assert.equal(portal.status, 'rendered');
					assert.equal(portal.data, before.data, 'the data moved');
					assert.equal(portal.rqo?.sqo?.offset, before.offset, 'the offset moved');
					assert.equal(portal.node.content_data, before.content_data, 'content_data was replaced');
					assert.equal(portal.record_windows?.rows, before.record_window, 'the window was replaced or nulled');
					assert.equal(before.content_data.closest('[inert]'), null, 'the refused rows were left inert');
					assert.equal(pending.value, 'typed, never committed');
					assert.equal(uncommitted_nodes_snapshot().includes(pending), true, 'the pending node left the registry');
					assert.equal(document.activeElement, pending, 'the focus did not return to the pending node');

					// the node goes (it committed elsewhere): the same call proceeds
					clear_pending(pending);
					pending = null;
					if (op.stub_write) {
						// null, never false: the operation hands change_value's answer
						// back, and false is the lock's refusal
						portal.change_value = async (options) => {
							writes.push(options);
							return null;
						};
					} else {
						portal.change_value = original_change_value;
					}
					const rerun = spy_requests();
					let again;
					try {
						again = await op.run(portal);
					} finally {
						rerun.restore();
					}
					await frames();
					assert.equal(op.refused(again), false, `${op.name} still refused with nothing pending`);
					assert.notEqual(portal.node.content_data, before.content_data, `${op.name} rendered no new rows`);
					if (op.stub_write) {
						assert.equal(writes.length, 1, `${op.name} never reached its write`);
					}
					assert.equal(portal.status, 'rendered', `${op.name} left the portal in status ${portal.status}`);
					assert_invariant(portal, { layout: 'table' }, portal.record_windows.rows.size);
				} finally {
					window.confirm = original_confirm;
					clear_pending(pending);
					await portal.destroy(true, true, true);
				}
			});
		}

		it('OK is a SCOPED discard: an unrelated unsaved instance and an orphan stay registered', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			const unrelated = fake_component('row_invariant_unrelated_unsaved');
			const orphan = fake_component('row_invariant_unrelated_orphan');
			let pending = null;
			try {
				register_unsaved_instance(unrelated);
				orphan_unsaved_instance(orphan);
				assert.equal(orphaned_unsaved.has(orphan), true, 'the orphan was not planted');
				pending = plant_pending_in(portal, 0);
				let confirms = 0;
				window.confirm = () => {
					confirms++;
					return true;
				};
				const moved = await portal.navigate({
					callback: () => {
						portal.rqo.sqo.offset = PAGE_LIMIT;
					},
				});
				assert.equal(moved, true, 'navigate refused after OK');
				assert.equal(confirms, 1, 'one confirm (the lock), never a page-wide prompt');
				assert.equal(uncommitted_nodes_snapshot().includes(pending), false, 'the discarded node is still registered');
				assert.equal(get_unsaved_instances().includes(unrelated), true, 'OK discarded an unrelated unsaved instance');
				assert.equal(orphaned_unsaved.has(orphan), true, 'OK discarded an unrelated orphan');
				assert.equal(window.unsaved_data, true, 'the guard fell although unrelated edits remain');
			} finally {
				window.confirm = original_confirm;
				clear_pending(pending);
				deregister_unsaved_instance(unrelated);
				// the orphan leaves only through a save or the user's discard
				reset_unsaved_data();
				await portal.destroy(true, true, true);
			}
		});

		it('OK freezes the old rows while the request is in flight (inert, no focus)', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			let pending = null;
			let release_request = null;
			const held = new Promise((resolve) => {
				release_request = resolve;
			});
			const network = spy_requests(async () => {
				await held;
				return undefined;
			});
			try {
				pending = plant_pending_in(portal, 0);
				const other = ui.create_dom_element({
					element_type: 'input',
					type: 'text',
					class_name: 'row_invariant_other',
					parent: portal.node.content_data.children[1].querySelector(':scope > .column'),
				});
				window.confirm = () => true;
				const old_content = portal.node.content_data;
				const operation = portal.navigate({
					callback: () => {
						portal.rqo.sqo.offset = PAGE_LIMIT;
					},
				});
				const sent = await wait_until(() => network.calls.length > 0, 5000);
				assert.equal(sent, true, 'the navigate never reached its request');
				assert.equal(pending.closest('[inert]') !== null, true, 'the discarded node is not inert while the request is held');
				assert.equal(other.closest('[inert]') !== null, true, 'another old-row editor is not inert while the request is held');
				const active = document.activeElement;
				pending.focus();
				assert.equal(document.activeElement, active, 'the discarded node took the focus');
				other.focus();
				assert.equal(document.activeElement, active, 'an old-row editor took the focus');
				release_request();
				assert.equal(await operation, true);
				assert.notEqual(portal.node.content_data, old_content);
			} finally {
				release_request();
				network.restore();
				window.confirm = original_confirm;
				clear_pending(pending);
				await portal.destroy(true, true, true);
			}
		});

		it('owner destroy with a pending node logs it (console.error) and completes', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			const pending = plant_pending_in(portal, 0);
			const original_error = console.error;
			const errors = [];
			console.error = (...args) => {
				errors.push(args);
			};
			try {
				await portal.destroy(true, true, true);
			} finally {
				console.error = original_error;
				clear_pending(pending);
			}
			assert.equal(portal.status, 'destroyed');
			assert.equal(portal.record_windows, null);
			assert.equal(
				errors.some((args) => String(args[0]).includes('pending editor value is dropped')),
				true,
				'the dropped pending value was not logged',
			);
		});
	});

	/**
	 * LOCK BEFORE PROMPT
	 * A REAL input_text typed, never blurred (keyboard paging, page.js Shift+Arrow
	 * calls navigate without a blur): both navigates commit it without a confirm,
	 * save it, then render the new page.
	 */
	describe('ROW LOCK — lock before prompt (real input_text, typed, not blurred)', function () {
		this.timeout(120000);

		const original_confirm = window.confirm;

		it('section.navigate: no confirm, the value is committed and saved, the page turns', async () => {
			const section = await get_instance({
				model: 'section',
				tipo: 'test3',
				section_tipo: 'test3',
				mode: 'list',
				id_variant: 'row_invariant_prompt_section',
				session_save: false,
			});
			await section.build(true);
			section.rqo.sqo.limit = PAGE_LIMIT;
			section.rqo.sqo.offset = 0;
			await section.build(true);
			test_container.appendChild(await section.render());
			await frames();
			let confirms = 0;
			window.confirm = () => {
				confirms++;
				return false;
			};
			const network = spy_requests();
			try {
				const row = section.record_windows.rows.record_at(0);
				const host = section.node.content_data.children[0].querySelector(':scope > .column');
				const { editor, seq0 } = await plant_editor(row, host);
				const content_data = section.node.content_data;
				const moved = await section.navigate({
					callback: () => {
						section.rqo.sqo.offset = PAGE_LIMIT;
					},
					navigation_history: false,
				});
				assert.equal(confirms, 0, 'the typed value made navigate prompt');
				assert.equal(moved, true, 'navigate refused a value it can commit');
				assert.equal(editor.commit_seq > seq0, true, 'the typed value was not committed');
				assert.equal(await wait_until(() => network.calls.some(is_editor_save)), true, 'the committed value was never saved');
				assert.notEqual(section.node.content_data, content_data, 'the page did not turn');
			} finally {
				network.restore();
				window.confirm = original_confirm;
				await section.destroy(true, true, true);
			}
		});

		it('portal navigate: no confirm, the value is committed and saved, the page turns', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			let confirms = 0;
			window.confirm = () => {
				confirms++;
				return false;
			};
			const network = spy_requests();
			try {
				const row = portal.record_windows.rows.record_at(0);
				const host = portal.node.content_data.children[0].querySelector(':scope > .column');
				const { editor, seq0 } = await plant_editor(row, host);
				const content_data = portal.node.content_data;
				const moved = await portal.navigate({
					callback: () => {
						portal.rqo.sqo.offset = PAGE_LIMIT;
					},
				});
				assert.equal(confirms, 0, 'the typed value made navigate prompt');
				assert.equal(moved, true, 'navigate refused a value it can commit');
				assert.equal(editor.commit_seq > seq0, true, 'the typed value was not committed');
				assert.equal(await wait_until(() => network.calls.some(is_editor_save)), true, 'the committed value was never saved');
				assert.notEqual(portal.node.content_data, content_data, 'the page did not turn');
			} finally {
				network.restore();
				window.confirm = original_confirm;
				await portal.destroy(true, true, true);
			}
		});

		it('portal navigate with an unrelated failed save and orphan: no confirm, registry unchanged', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			const unrelated = fake_component('row_invariant_prompt_unsaved');
			const orphan = fake_component('row_invariant_prompt_orphan');
			let confirms = 0;
			window.confirm = () => {
				confirms++;
				return true;
			};
			try {
				register_unsaved_instance(unrelated);
				orphan_unsaved_instance(orphan);
				const unsaved_before = get_unsaved_instances();
				const moved = await portal.navigate({
					callback: () => {
						portal.rqo.sqo.offset = PAGE_LIMIT;
					},
				});
				assert.equal(moved, true);
				assert.equal(confirms, 0, 'an unrelated edit made portal navigate prompt');
				assert.deepEqual(get_unsaved_instances(), unsaved_before, 'portal navigate changed the unsaved registry');
				assert.equal(orphaned_unsaved.has(orphan), true, 'portal navigate discarded an unrelated orphan');
			} finally {
				window.confirm = original_confirm;
				deregister_unsaved_instance(unrelated);
				reset_unsaved_data();
				await portal.destroy(true, true, true);
			}
		});
	});

	/**
	 * CHANGE-COMMITTING EDITORS
	 * Every editor that commits on the native `change` (the uncommitted-node set
	 * arms it) must commit on the window's synthetic change + blur: the outcome
	 * judge is commit_seq, never the Set (the capture listener empties it either
	 * way). An editor that ignores it reads as PENDING through the real
	 * commit_uncommitted — its row would ask discard/cancel forever.
	 */
	const COMMITTING_EDITORS = [
		{ model: 'component_input_text', tipo: 'test52' },
		{ model: 'component_number', tipo: 'test22', type: (c) => (c.value = '7') },
		{ model: 'component_email', tipo: 'test208', type: (c) => (c.value = 'row.invariant@example.test') },
		{
			model: 'component_iri',
			tipo: 'test140',
			find: (n) => n.querySelector('input[type="url"]') || n.querySelector('input:not([type="hidden"])'),
			type: (c) => (c.value = 'https://example.test/row_invariant'),
		},
		{ model: 'component_date', tipo: 'test145', type: (c) => (c.value = '2020') },
		{
			model: 'component_select',
			tipo: 'test91',
			find: (n) => n.querySelector('select'),
			type: (c) => (c.selectedIndex = c.options.length > 1 ? 1 : 0),
		},
		{
			model: 'component_select_lang',
			tipo: 'test89',
			find: (n) => n.querySelector('select'),
			type: (c) => (c.selectedIndex = c.options.length > 1 ? 1 : 0),
		},
		{
			model: 'component_radio_button',
			tipo: 'test87',
			find: (n) => n.querySelector('input[type="radio"]'),
			type: (c) => (c.checked = true),
		},
		{
			model: 'component_check_box',
			tipo: 'test88',
			find: (n) => n.querySelector('input[type="checkbox"]'),
			type: (c) => (c.checked = !c.checked),
		},
	];

	describe('ROW EDIT SAFETY — real editors in real rows', function () {
		this.timeout(120000);

		for (const spec of COMMITTING_EDITORS) {
			it(`${spec.model} commits on the window's synthetic change (commit_seq advances, not pending)`, async () => {
				const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
				try {
					const row = portal.record_windows.rows.record_at(0);
					const host = portal.node.content_data.children[0].querySelector(':scope > .column');
					const { editor, control, seq0 } = await plant_editor(row, host, spec);
					const { pending } = portal.record_windows.rows.commit_uncommitted([0]);
					assert.equal(editor.commit_seq > seq0, true, `${spec.model} ignored the synthetic change`);
					assert.equal(pending.length, 0, `${spec.model} reads as pending`);
					assert.equal(uncommitted_nodes_snapshot().includes(control), false);
					await wait_until(() => !editor.saving && !editor.change_value_promise, 8000);
				} finally {
					await portal.destroy(true, true, true);
				}
			});
		}

		it('flush commits a typed-not-blurred input_text and saves it', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			const network = spy_requests();
			try {
				const row = portal.record_windows.rows.record_at(0);
				const host = portal.node.content_data.children[0].querySelector(':scope > .column');
				const { editor, control, seq0 } = await plant_editor(row, host);
				const flushed = await portal.record_windows.rows.flush([0]);
				assert.equal(flushed.pending.length, 0, 'flush left the typed value pending');
				assert.equal(flushed.failed.length, 0, 'flush failed the committed value');
				assert.equal(editor.commit_seq > seq0, true, 'flush did not commit the typed value');
				assert.equal(uncommitted_nodes_snapshot().includes(control), false);
				assert.equal(network.calls.some(is_editor_save), true, 'flush never saved the committed value');
			} finally {
				network.restore();
				await portal.destroy(true, true, true);
			}
		});

		it('destroy:false adoption keeps a dirty component changed_data', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			let component = null;
			try {
				const row = portal.record_windows.rows.record_at(0);
				component = (row.ar_instances || []).find((el) => el.type === 'component') || null;
				assert.equal(Boolean(component), true, 'row 0 holds no component');
				component.data = component.data || {};
				const marker = Object.freeze({ action: 'update', id: 1, value: 'row invariant adoption marker' });
				component.data.changed_data = [marker];
				const result = await portal.refresh({ destroy: false });
				assert.notEqual(result, false);
				await frames();
				assert.equal(portal.record_windows.rows.record_at(0), row, 'refresh destroy:false did not adopt row 0');
				assert.equal(
					(component.data?.changed_data || []).includes(marker),
					true,
					'the adopted component lost its changed_data',
				);
			} finally {
				if (component?.data) {
					component.data.changed_data = [];
				}
				await portal.destroy(true, true, true);
			}
		});

		it('a dirty failed row leaves an orphan (still registered) and the rebuilt row a fresh instance', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			const network = spy_requests((body) => (is_editor_save(body) ? failed_save() : undefined));
			let editor = null;
			let swept = null;
			try {
				const row = portal.record_windows.rows.record_at(0);
				const host = portal.node.content_data.children[0].querySelector(':scope > .column');
				const planted = await plant_editor(row, host);
				editor = planted.editor;
				// the commit runs, its save fails: registered, changed_data kept
				planted.control.dispatchEvent(new Event('change', { bubbles: true }));
				const registered = await wait_until(
					() => get_unsaved_instances().includes(editor) && !editor.saving && !editor.change_value_promise,
				);
				assert.equal(registered, true, 'the failed save did not register the instance');

				// page away (the old row is retired: its dirty editor cannot settle)
				assert.equal(
					await portal.navigate({
						callback: () => {
							portal.rqo.sqo.offset = PAGE_LIMIT;
						},
					}),
					true,
				);
				assert.equal(orphaned_unsaved.has(editor), true, 'the dirty failed instance was not orphaned');
				assert.equal(get_unsaved_instances().includes(editor), true, 'the orphan left the unsaved registry');
				assert.notEqual(editor.status, 'destroyed', 'a dirty instance was destroyed');

				// back: index 0 is rebuilt
				assert.equal(
					await portal.navigate({
						callback: () => {
							portal.rqo.sqo.offset = 0;
						},
					}),
					true,
				);
				await frames();
				assert.notEqual(portal.record_windows.rows.record_at(0), row, 'the rebuilt row adopted the retired record');
				assert.equal(orphaned_unsaved.has(editor), true, 'the orphan did not survive the rebuild');
				// the same key builds a FRESH instance: the cache never hands the orphan back
				const fresh = await get_instance({ ...planted.key });
				assert.notEqual(fresh, editor, 'the instance cache handed the orphan back');
				await fresh.destroy(true, true, true);

				// a later successful save sweeps the orphan
				network.restore();
				await save_unsaved_components();
				swept = !orphaned_unsaved.has(editor);
			} finally {
				network.restore();
				if (editor && orphaned_unsaved.has(editor)) {
					// never leave an orphan for the next suite
					await save_unsaved_components();
				}
				await portal.destroy(true, true, true);
			}
			assert.equal(swept, true, 'a successful save did not sweep the orphan');
		});

		it('an open autocomplete pins its row (rebuild refused) until it closes', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			try {
				const record_window = portal.record_windows.rows;
				const row = record_window.record_at(0);
				const host = portal.node.content_data.children[0].querySelector(':scope > .column');
				const nested = await get_instance({
					model: 'component_portal',
					tipo: PORTAL_TIPO,
					section_tipo: SCRATCH_SECTION,
					section_id: scratch.editor_record,
					mode: 'edit',
					id_variant: `row_invariant_autocomplete_${++scratch_seq}`,
					caller: row,
				});
				nested.caller = row;
				await nested.build(true);
				host.appendChild(await nested.render());
				row.ar_instances.push(nested);
				await activate_autocomplete(nested, nested.node);
				assert.equal(Boolean(nested.autocomplete) && page_globals.service_autocomplete === nested.autocomplete, true, 'no live autocomplete');
				assert.equal(await record_window.rebuild(0), false, 'a row with an open autocomplete was rebuilt');
				assert.equal(record_window.record_at(0), row);
				await nested.autocomplete.destroy(true, true, true);
				assert.equal(await record_window.rebuild(0), true, 'the row stayed pinned after the autocomplete closed');
			} finally {
				await portal.destroy(true, true, true);
			}
		});

		it('an open dataframe pins its row (rebuild refused) while its frame modal is edited', async () => {
			const portal = await build_scratch_portal({ limit: PAGE_LIMIT });
			let frame_section = null;
			try {
				const record_window = portal.record_windows.rows;
				const row = record_window.record_at(0);
				const host = portal.node.content_data.children[0].querySelector(':scope > .column');
				// a REAL dataframe slot (test6744 on a scratch test6099 record), owned
				// by the row, rendered in the row
				const dataframe = await get_instance({
					model: 'component_dataframe',
					tipo: FRAME_SLOT_TIPO,
					section_tipo: FRAME_HOST_SECTION,
					section_id: scratch.frame_host,
					mode: 'list',
					id_variant: `row_invariant_dataframe_${++scratch_seq}`,
					caller: row,
				});
				dataframe.caller = row;
				await dataframe.build(true);
				// one frame entry: the chip opens its target in the frame modal. The
				// target is the scratch editor record, so the modal holds a real
				// test52 editor (the pin is about the modal's chain, not the frame's
				// section)
				dataframe.data = dataframe.data || {};
				dataframe.data.entries = [{ section_tipo: SCRATCH_SECTION, section_id: scratch.editor_record }];
				host.appendChild(await dataframe.render());
				row.ar_instances.push(dataframe);

				// open the modal through the chip (its real door)
				const chip = dataframe.node.querySelector('.button.activate');
				assert.equal(Boolean(chip), true, 'the dataframe rendered no chip');
				chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
				const opened = await wait_until(() => {
					frame_section = get_all_instances().find((el) =>
						el.model === 'section' &&
						el.mode === 'edit' &&
						el.tipo === SCRATCH_SECTION &&
						Number(el.section_id) === scratch.editor_record &&
						el.status === 'rendered' &&
						el.node?.closest('dd-modal')) || null;
					return Boolean(frame_section);
				}, 15000);
				assert.equal(opened, true, 'the frame modal never rendered its section');

				// edit in the modal: its editor becomes the active component
				let editor = null;
				const found = await wait_until(() => {
					editor = get_all_instances().find((el) =>
						el.tipo === EDITOR_TIPO && el.status === 'rendered' && el.node && reaches(el, frame_section)) || null;
					return Boolean(editor);
				}, 15000);
				assert.equal(found, true, 'the frame modal holds no rendered test52 editor');
				await ui.component.activate(editor, false);
				assert.equal(page_globals.component_active, editor, 'the modal editor is not the active component');

				// the modal lives outside the row, yet the row is pinned: the frame
				// section hangs from the dataframe (red when it hangs from nothing)
				assert.equal(await record_window.rebuild(0), false, 'a row whose dataframe modal is being edited was rebuilt');
				assert.equal(record_window.record_at(0), row);

				await ui.component.deactivate(editor);
				const modal = frame_section.node.closest('dd-modal');
				await modal.close();
				await wait_until(() => !modal.isConnected, 4000);
				// the close refreshes the chip; let it land before the row goes
				await wait_until(() => dataframe.status === 'rendered', 4000);
				assert.equal(await record_window.rebuild(0), true, 'the row stayed pinned after the frame modal closed');
			} finally {
				if (frame_section && frame_section.status !== 'destroyed') {
					const modal = frame_section.node?.closest('dd-modal');
					if (modal) {
						await modal.close();
					}
					await frame_section.destroy(true, true, true);
				}
				await portal.destroy(true, true, true);
			}
		});
	});

	/**
	 * TRANSITIONS
	 */
	describe('ROW INVARIANT — N=3→0 retires the window', function () {
		this.timeout(120000);

		it('through unlink of the last records', async () => {
			const seed = await build_scratch_portal({ host: scratch.host_b, limit: 20 });
			const seeded = await seed.link_records(scratch.targets.slice(0, 3).map(locator_of));
			await seed.destroy(true, true, true);
			assert.equal(seeded.linked.length, 3, 'the second host was not seeded');

			const portal = await build_scratch_portal({ host: scratch.host_b, limit: 20 });
			try {
				assert.equal(portal.record_windows.rows.size, 3);
				const generation = portal.record_window_generation.rows;
				assert.equal(await portal.unlink_record((portal.data.entries || []).slice()), true);
				await frames();
				assert.equal(portal.record_window_generation.rows > generation, true, 'the zero-row window did not supersede');
				assert.equal(portal.record_windows.rows.size, 0);
				assert.equal(portal.node.content_data.children.length, 0);
				assert.equal(row_instances(portal).length, 0, 'retired rows leaked in ar_instances');
			} finally {
				await portal.destroy(true, true, true);
			}
		});

		it('through an empty tag filter (and back through reset_filter_data)', async () => {
			const portal = await build_scratch_portal({ limit: 3 });
			try {
				assert.equal(portal.record_windows.rows.size, 3);
				await portal.filter_data_by_tag_id({ tag: { tag_id: 'row_invariant_no_such_tag' } });
				await frames();
				assert.equal(portal.record_windows.rows.size, 0);
				assert.equal(portal.node.content_data.children.length, 0);
				assert.equal(row_instances(portal).length, 0, 'retired rows leaked in ar_instances');
				await portal.reset_filter_data();
				await frames();
				assert_invariant(portal, { layout: 'table' }, portal.record_windows.rows.size);
				assert.equal(portal.record_windows.rows.size > 0, true);
			} finally {
				await portal.destroy(true, true, true);
			}
		});
	});

	describe('ROW INVARIANT — nested and late rows', function () {
		this.timeout(120000);

		it('a nested list portal is destroyed in cascade with its outer row (and arms no observer)', async () => {
			const section = await get_instance({
				model: 'section',
				tipo: NESTED_HOST_SECTION,
				section_tipo: NESTED_HOST_SECTION,
				mode: 'list',
				id_variant: 'row_invariant_nested',
				session_save: false,
			});
			await section.build(true);
			test_container.appendChild(await section.render());
			await frames();
			try {
				const record_window = section.record_windows.rows;
				let index = -1;
				let nested = null;
				for (let i = 0; i < record_window.size; i++) {
					const row = record_window.record_at(i);
					nested = (row?.ar_instances || []).find((el) => el.model === 'component_portal' && el.record_windows) || null;
					if (nested) {
						index = i;
						break;
					}
				}
				assert.equal(index !== -1, true, 'no test1572 row carries a nested list portal with a window');
				const inner = nested.record_windows.rows;
				assert.equal(inner.size <= ROW_WINDOW_MAX_ROWS, true);
				assert.equal(await record_window.rebuild(index), true, 'the outer row was not released');
				assert.equal(nested.status, 'destroyed', 'the nested portal outlived its row');
				assert.equal(nested.record_windows, null, 'the nested window outlived its row');
				assert.equal(inner.signal.aborted, true, 'the nested window listeners outlived its row');
			} finally {
				await section.destroy(true, true, true);
			}
		});

		it('Time Machine: decorate and mark_empty_columns reach a row built late', async () => {
			const tm_list = await tm_case('tool', 'table').make();
			// a host tool and its subject: the Id cell renders the row action
			tm_list.tm_no_id_column = false;
			await tm_list.build(true);
			tm_list.caller = { model: 'tool_time_machine', caller: { model: 'section', tipo: 'test3', section_tipo: 'test3' } };
			const n = ROW_WINDOW_MAX_ROWS + 1;
			tm_list.data = tm_list.data || {};
			tm_list.data.entries = Array.from({ length: n }, (_, i) => ({
				section_tipo: 'dd15',
				section_id: i + 1,
				paginated_key: i,
				caller_section_tipo: 'test3',
				caller_section_id: 1,
				matrix_id: i + 1,
			}));
			test_container.appendChild(await tm_list.render());
			await frames();
			// the previewed row (the door drops the marker of a superseded window)
			tm_list.tm_active_index = n - 1;
			try {
				const record_window = tm_list.record_windows.rows;
				const content_data = tm_list.node.content_data;
				assert.equal(content_data.children[n - 1].classList.contains('placeholder'), true, 'the last row was built eagerly');
				assert.equal(Boolean(content_data.children[0].querySelector(':scope > .column > .button_view')), true, 'the eager rows carry no row action (fixture)');
				await record_window.reveal(n - 1);
				const late = content_data.children[n - 1];
				assert.equal(late.classList.contains('placeholder'), false, 'reveal did not build the row');
				assert.equal(late.querySelectorAll(':scope > .column.empty_column').length > 0, true, 'mark_empty_columns missed the late row');
				assert.equal(late.classList.contains('link'), true, 'decorate missed the late row');
				assert.equal(Boolean(late.querySelector(':scope > .column > .button_view.warning')), true, 'the active marker missed the late row');
			} finally {
				tm_list.caller = null;
				await tm_list.destroy(true, true, true);
			}
		});

		it('a portal embedded in a ts_object node renders through the door (invariant kept, torn down with the node)', async () => {
			// the node: a thesaurus term on the scratch host, its node data served by a
			// stubbed get_node_data (the tree fixture shape test_render_budget uses);
			// every other request — the embedded portal's — reaches the suite server
			const network = spy_requests((body) =>
				body.action === 'get_node_data'
					? {
							ok: true,
							data: {
								ts_id: `${SCRATCH_SECTION}_${scratch.host}`,
								ts_parent: null,
								section_tipo: SCRATCH_SECTION,
								section_id: String(scratch.host),
								order: 1,
								is_descriptor: true,
								is_indexable: true,
								has_descriptor_children: false,
								children_tipo: 'test71',
								permissions_button_new: 3,
								permissions_button_delete: 3,
								permissions_indexation: 3,
								ar_elements: [
									{ type: 'term', tipo: 'test71_term', value: 'Term', model: 'component_input_text' },
								],
							},
						}
					: undefined,
			);
			let term = null;
			try {
				term = await ts_object.get_instance({
					area_model: 'area_thesaurus',
					caller: {
						filter: {},
						build_options: {},
						id: 'row_invariant_ts_object_caller',
						id_base: `${SCRATCH_SECTION}__${SCRATCH_SECTION}`,
						model: 'area_thesaurus',
					},
					children_tipo: 'test71',
					is_ontology: false,
					is_root_node: false,
					linker: undefined,
					section_id: String(scratch.host),
					section_tipo: SCRATCH_SECTION,
					thesaurus_mode: 'default',
					thesaurus_view_mode: null,
				});
				await term.build(true);
				test_container.appendChild(await term.render());

				// the node's own door for an element: the test80 portal of the host
				await term.show_component_in_ts_object({ tipo: PORTAL_TIPO, type: 'portal', model: 'component_portal' });
				await frames();
				const wrapper = Array.from(term.data_container.children).find((node) => node.instance?.model === 'component_portal');
				assert.equal(Boolean(wrapper), true, 'the ts_object node rendered no portal');
				const portal = wrapper.instance;
				assert.equal(Boolean(portal.record_windows?.rows), true, 'the embedded portal has no record window');
				const n = portal.record_windows.rows.size;
				assert.equal(n, (portal.data?.entries || []).length, 'the window does not hold the page');
				assert.equal(n > 0, true, 'the scratch host lists no links (fixture)');
				assert_invariant(portal, { layout: 'table' }, n);

				// toggled off: the node tears the portal down with its window
				await term.show_component_in_ts_object({ tipo: PORTAL_TIPO, type: 'portal', model: 'component_portal' });
				assert.equal(portal.status, 'destroyed', 'the embedded portal outlived its toggle');
				assert.equal(portal.record_windows, null, 'the embedded window outlived its portal');
			} finally {
				network.restore();
				if (term) {
					await term.destroy(true, true, true);
				}
			}
		});
	});

	/**
	 * MOSAIC — hover overlay and alt modal
	 * The overlay's editors belong to the hover controller, never the window: a
	 * typed overlay input_text is committed and saved by a page change and by an
	 * owner destroy without a prompt or a log; a stub that ignores change IS
	 * pending (the lock refuses) and defers the teardown (no next hover) — on the
	 * core mosaic portal AND one tool mosaic (coins_mosaic installs its own
	 * delegate_row_hover). The core mosaic's alt modal is slot 'alt': it never touches the tile window, and a dirty alt edit
	 * survives the close.
	 */
	const hover_of = async (portal, index) => {
		const tile = portal.node.content_data.children[index];
		tile.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		const shown = await wait_until(() => tile.querySelector(':scope > .sr_mosaic_hover'));
		assert.equal(shown, true, `tile ${index} showed no hover overlay`);
		const overlay = tile.querySelector(':scope > .sr_mosaic_hover');
		const instance = (portal.ar_instances || []).find((el) => el.node === overlay) || null;
		assert.equal(Boolean(instance), true, 'the hover overlay instance is not registered on the portal');
		return { tile, overlay, instance };
	};

	/** The hover-overlay shapes: the core mosaic portal and one tool mosaic. */
	const HOVER_MOSAICS = [
		{ name: 'mosaic portal', view: 'mosaic', tool: null },
		{
			name: 'tool mosaic coins_mosaic',
			view: 'coins_mosaic',
			tool: {
				render: 'view_coins_mosaic_portal',
				path: '../../../tools/tool_numisdata_order_coins/js/view_coins_mosaic_portal.js',
			},
		},
	];

	describe('ROW INVARIANT — mosaic hover overlay and alt modal', function () {
		this.timeout(120000);

		const original_confirm = window.confirm;

		// the core mosaic portal and one TOOL mosaic: the tool views install their
		// own delegate_row_hover, so the overlay's owned-elsewhere binding is gated
		// on both shapes
		for (const mosaic of HOVER_MOSAICS) {
			it(`${mosaic.name}: a typed overlay input_text is committed and saved by a page change: no confirm, no log`, async () => {
				const portal = await build_scratch_portal({ view: mosaic.view, limit: PAGE_LIMIT, tool: mosaic.tool });
				const network = spy_requests();
				const original_error = console.error;
				const errors = [];
				let confirms = 0;
				window.confirm = () => {
					confirms++;
					return false;
				};
				try {
					const { overlay, instance } = await hover_of(portal, 0);
					console.error = (...args) => {
						errors.push(args);
					};
					const { editor, seq0 } = await plant_editor(instance, overlay);
					const moved = await portal.navigate({
						callback: () => {
							portal.rqo.sqo.offset = PAGE_LIMIT;
						},
					});
					assert.equal(moved, true, 'the overlay value was judged pending');
					assert.equal(confirms, 0, 'the overlay value made navigate prompt');
					assert.equal(editor.commit_seq > seq0, true, 'the overlay value was not committed');
					assert.equal(await wait_until(() => network.calls.some(is_editor_save)), true, 'the overlay value was never saved');
					assert.equal(errors.filter((args) => String(args[0]).includes('pending')).length, 0, 'the overlay value was logged as pending');
				} finally {
					console.error = original_error;
					network.restore();
					window.confirm = original_confirm;
					await portal.destroy(true, true, true);
				}
			});

			it(`${mosaic.name}: a typed overlay input_text is committed and saved by an owner destroy: no log`, async () => {
				const portal = await build_scratch_portal({ view: mosaic.view, limit: PAGE_LIMIT, tool: mosaic.tool });
				const network = spy_requests();
				const original_error = console.error;
				const errors = [];
				try {
					const { overlay, instance } = await hover_of(portal, 0);
					const { editor, seq0 } = await plant_editor(instance, overlay);
					console.error = (...args) => {
						errors.push(args);
					};
					await portal.destroy(true, true, true);
					console.error = original_error;
					assert.equal(editor.commit_seq > seq0, true, 'the owner destroy did not commit the overlay value');
					assert.equal(await wait_until(() => network.calls.some(is_editor_save)), true, 'the overlay value was never saved');
					assert.equal(errors.filter((args) => String(args[0]).includes('pending')).length, 0, 'the overlay value was logged as pending');
				} finally {
					console.error = original_error;
					network.restore();
					if (portal.status !== 'destroyed') {
						await portal.destroy(true, true, true);
					}
				}
			});

			it(`${mosaic.name}: an overlay stub that ignores change IS pending: the lock refuses and the teardown is deferred`, async () => {
				const portal = await build_scratch_portal({ view: mosaic.view, limit: PAGE_LIMIT, tool: mosaic.tool });
				let stub = null;
				try {
					const { overlay } = await hover_of(portal, 0);
					stub = ui.create_dom_element({
						element_type: 'input',
						type: 'text',
						class_name: 'row_invariant_pending',
						value: 'typed in the overlay, never committed',
						parent: overlay,
					});
					register_uncommitted_input(stub);
					window.confirm = () => false;
					const content_data = portal.node.content_data;
					const moved = await portal.navigate({
						callback: () => {
							portal.rqo.sqo.offset = PAGE_LIMIT;
						},
					});
					assert.equal(moved, false, 'navigate proceeded over a pending overlay node');
					assert.equal(portal.node.content_data, content_data);

					// deferred teardown: hovering the next tile renders no overlay there
					const next = content_data.children[1];
					next.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
					const moved_on = await wait_until(() => next.querySelector(':scope > .sr_mosaic_hover'), 1500);
					assert.equal(moved_on, false, 'the next hover rendered over a pending overlay');
					assert.equal(Boolean(content_data.children[0].querySelector(':scope > .sr_mosaic_hover')), true, 'the pending overlay was torn down');

					// once the node goes, the teardown runs and the next hover renders
					clear_pending(stub);
					stub = null;
					content_data.dispatchEvent(new PointerEvent('pointerleave'));
					next.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
					assert.equal(await wait_until(() => next.querySelector(':scope > .sr_mosaic_hover')), true, 'the next hover never rendered');
				} finally {
					window.confirm = original_confirm;
					clear_pending(stub);
					await portal.destroy(true, true, true);
				}
			});

			it(`${mosaic.name}: a deferred teardown that resolves shows the tile ALREADY under the pointer (no new pointerover)`, async () => {
				const portal = await build_scratch_portal({ view: mosaic.view, limit: PAGE_LIMIT, tool: mosaic.tool });
				let stub = null;
				try {
					const { overlay } = await hover_of(portal, 0);
					stub = ui.create_dom_element({
						element_type: 'input',
						type: 'text',
						class_name: 'row_invariant_pending',
						value: 'typed in the overlay, not yet committed',
						parent: overlay,
					});
					register_uncommitted_input(stub);
					// a synthetic pointerover sets no :hover, and the core mosaic shows its
					// overlay only under :hover / :focus-within (display:none otherwise, so
					// unfocusable): stand in for the real pointer's :hover just long enough
					// to focus, then :focus-within alone must keep it shown
					overlay.style.display = 'grid';
					stub.focus();
					overlay.style.removeProperty('display');
					assert.equal(document.activeElement, stub, 'the overlay stub took no focus (the retry rides its focusout)');
					assert.notEqual(getComputedStyle(overlay).display, 'none', ':focus-within did not keep the focused overlay shown');

					// the pointer moves on while the node is pending: the teardown defers
					const content_data = portal.node.content_data;
					const next = content_data.children[1];
					next.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
					assert.equal(await wait_until(() => next.querySelector(':scope > .sr_mosaic_hover'), 1500), false, 'the next hover rendered over a pending overlay');

					// the node commits and the focus leaves the overlay; the pointer
					// STAYS on the next tile, so no further pointerover will ever come
					deregister_uncommitted_input(stub);
					stub.blur();
					assert.equal(
						await wait_until(() => next.querySelector(':scope > .sr_mosaic_hover')),
						true,
						'the resolved teardown never showed the tile under the pointer',
					);
					assert.equal(Boolean(content_data.children[0].querySelector(':scope > .sr_mosaic_hover')), false, 'the resolved overlay was not torn down');
				} finally {
					clear_pending(stub);
					await portal.destroy(true, true, true);
				}
			});
		}

		it('the alt modal is slot alt: the tile window is untouched, and a dirty alt edit survives close', async () => {
			const portal = await build_scratch_portal({ view: 'mosaic', limit: PAGE_LIMIT });
			const network = spy_requests();
			try {
				const tiles = portal.record_windows.rows;
				const tiles_generation = portal.record_window_generation.rows;
				const tiles_children = Array.from(portal.node.content_data.children);
				const same_tiles = () => {
					const now = portal.node.content_data.children;
					return now.length === tiles_children.length && tiles_children.every((node, i) => now[i] === node);
				};
				const { overlay } = await hover_of(portal, 0);
				const button = overlay.querySelector(':scope > .button_alt_container');
				assert.equal(Boolean(button), true, 'the overlay has no alt button');
				button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				assert.equal(await wait_until(() => portal.record_windows?.alt), true, 'the alt table never opened');
				const alt = portal.record_windows.alt;
				assert.equal(portal.record_windows.rows, tiles, 'the alt table replaced the tile window');
				assert.equal(portal.record_window_generation.rows, tiles_generation, 'slot alt bumped the rows generation');
				assert.equal(portal.record_window_generation.alt >= 1, true);
				assert.equal(tiles.signal.aborted, false, 'slot alt aborted the tile window');
				assert.equal(same_tiles(), true, 'slot alt touched the tiles');

				// a dirty edit in the alt row, typed, never blurred
				const alt_row = alt.record_at(0);
				const alt_host = alt_row.node.querySelector(':scope > .column') || alt_row.node;
				const { editor, seq0 } = await plant_editor(alt_row, alt_host);
				portal.modal.close();
				assert.equal(await wait_until(() => !portal.record_windows?.alt), true, 'the alt slot was never torn down');
				assert.equal(editor.commit_seq > seq0, true, 'the alt close dropped the typed value');
				assert.equal(await wait_until(() => network.calls.some(is_editor_save)), true, 'the alt value was never saved');
				assert.equal(portal.record_windows.rows, tiles);
				assert.equal(portal.record_window_generation.rows, tiles_generation, 'closing slot alt bumped the rows generation');
				assert.equal(tiles.signal.aborted, false);
				assert.equal(same_tiles(), true, 'closing slot alt touched the tiles');
			} finally {
				network.restore();
				await portal.destroy(true, true, true);
			}
		});
	});

	// THE SWEEP lives in THIS describe: every scratch leg above is nested, so
	// mocha runs it after all of them (a failed before included), and it
	// PROVES the situation is gone — a count per section, never assumed
	after(async () => {
		const failures = [];
		const attempt = async (what, fn) => {
			try {
				await fn();
			} catch (error) {
				failures.push(`${what}: ${error?.message || error}`);
			}
		};
		// links first (no locator may outlive its record), then the records
		for (const host of [scratch.host, scratch.host_b]) {
			if (!host) {
				continue;
			}
			await attempt(`unlink host ${host}`, async () => {
				const portal = await build_scratch_portal({ host, limit: 20 });
				try {
					await portal.change_value({
						changed_data: [Object.freeze({ action: 'set_data', id: null, value: null })],
						refresh: false,
					});
				} finally {
					await portal.destroy(true, true, true);
				}
			});
		}
		const by_section = [
			[
				SCRATCH_SECTION,
				[
					...scratch.targets,
					scratch.victim,
					scratch.spare,
					scratch.editor_record,
					...scratch.created,
					scratch.host,
					scratch.host_b,
				],
			],
			[NESTED_HOST_SECTION, [scratch.nested_host]],
			[FRAME_HOST_SECTION, [scratch.frame_host]],
		];
		for (const [section_tipo, ids] of by_section) {
			for (const section_id of ids.filter(Boolean)) {
				await attempt(`delete ${section_tipo}/${section_id}`, () => delete_record(section_tipo, section_id));
			}
		}
		// nothing is left: every scratch id of every section counts zero
		for (const [section_tipo, ids] of by_section) {
			const live = ids.filter(Boolean);
			if (live.length === 0) {
				continue;
			}
			await attempt(`count ${section_tipo}`, async () => {
				const left = await count_records(section_tipo, live);
				if (left !== 0) {
					throw new Error(`${left} scratch record(s) left in ${section_tipo} (${live.join(', ')})`);
				}
			});
		}
		test_container.innerHTML = '';
		assert.deepEqual(failures, [], 'the scratch situation was not swept clean');
	});
});

// @license-end
