// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, before, after */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_EXPORT
 * Client-side coverage for the data-export tool, in two layers.
 *
 * 1. The locked client template: the module exports a constructor named as its
 *    model, construction seeds the documented properties and the export
 *    runtime, the prototype is wired, and flat_table renders one page as text.
 *
 * 2. THE SERVER-BUILT EXPORT, end to end through the real tool UI on the suite
 *    server. The suite BUILDS its situation: it creates more than three preview
 *    pages of test3 records through the engine's own create door, exports
 *    exactly those (filter_by_locators), and deletes them again. See the
 *    'TOOL_EXPORT SERVER-BUILT EXPORT' describe for what it asserts.
 *
 * 3. The per-column PARENTS checkbox per data format (WC-049 + addendum
 *    2026-09-25): enabled in value / grid_value, disabled with a visible note in
 *    dedalo_raw, re-evaluated on every format change and after a preset.
 *
 * 4. The DROP MODEL of the "Active elements" list (drag_tool_export.js): the
 *    pointer's midpoint rule picks the insertion index, one marker shows it
 *    (below the last row = after it, never before), a duplicate shows no marker
 *    and is refused, a sort onto its own position is a no-op, and the drop
 *    lands exactly where the marker was.
 *
 * 5. The PHONE GESTURES (phone_tool_export.js): a tap-to-add "+" builds the
 *    same column the drag does (append, duplicate refused), and the up/down
 *    reorder buttons perform the same move the sort drop does.
 */

import {tool_export} from '../../../tools/tool_export/js/tool_export.js'
import {flat_table} from '../../../tools/tool_export/js/flat_table.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {get_instance} from '../../../core/common/js/instances.js'
import {request_failed, response_data, ApiError} from '../../../core/common/js/api_error.js'
import {create_job_follower_group} from '../../../core/common/js/job_follow.js'
import {ui} from '../../../core/common/js/ui.js'
import {apply_export_preset, build_export_config, edit_user_export_preset} from '../../../tools/tool_export/js/export_user_presets.js'
import {
	get_drop_index,
	on_dragstart,
	on_dragover,
	on_dragleave,
	on_dragend,
	on_drop,
	set_sort_payload
} from '../../../tools/tool_export/js/drag_tool_export.js'
import {
	render_add_column_button,
	add_export_component_from_row,
	move_export_component,
	update_phone_reorder_state
} from '../../../tools/tool_export/js/phone_tool_export.js'
import {render_phone_reorder} from '../../../core/tools_common/js/phone_reorder.js'



describe('TOOL_EXPORT CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_export, 'function', 'expected tool_export to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_export()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.type, null, 'expected type null')
		assert.equal(instance.source_lang, null, 'expected source_lang null')
		assert.equal(instance.caller, null, 'expected caller null')
		assert.equal(instance.data_format, null, 'expected data_format null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_export.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_export.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_export.prototype.refresh, 'function', 'expected refresh wired')
		// render mode delegated to render_tool_export
		assert.equal(typeof tool_export.prototype.edit, 'function', 'expected edit wired')
		assert.equal(typeof tool_export.prototype.build_export_component, 'function', 'expected build_export_component wired')
		assert.equal(typeof tool_export.prototype.sync_ar_ddo_to_export, 'function', 'expected sync_ar_ddo_to_export wired')
		// section element helpers delegated from common
		assert.equal(typeof tool_export.prototype.get_section_elements_context, 'function', 'expected get_section_elements_context wired')
		assert.equal(typeof tool_export.prototype.calculate_component_path, 'function', 'expected calculate_component_path wired')
		// drag-and-drop handlers
		assert.equal(typeof tool_export.prototype.on_dragstart, 'function', 'expected on_dragstart wired')
		assert.equal(typeof tool_export.prototype.on_dragover, 'function', 'expected on_dragover wired')
		assert.equal(typeof tool_export.prototype.on_dragleave, 'function', 'expected on_dragleave wired')
		assert.equal(typeof tool_export.prototype.on_drop, 'function', 'expected on_drop wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_export.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_export.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_export.prototype.get_section_id, 'function', 'expected get_section_id defined')
		// the server-built export (the browser never holds the export)
		assert.equal(typeof tool_export.prototype.start_export_job, 'function', 'expected start_export_job defined')
		assert.equal(typeof tool_export.prototype.get_export_preview, 'function', 'expected get_export_preview defined')
		assert.equal(typeof tool_export.prototype.list_export_jobs, 'function', 'expected list_export_jobs defined')
		assert.equal(typeof tool_export.prototype.start_export_file, 'function', 'expected start_export_file defined')
		assert.equal(typeof tool_export.prototype.stop_export_process, 'function', 'expected stop_export_process defined')
		assert.equal(typeof tool_export.prototype.reset_export_runtime, 'function', 'expected reset_export_runtime defined')
		// the in-browser file builders are gone (files are built on the server)
		assert.equal(tool_export.prototype.get_export_grid, undefined, 'get_export_grid must be gone')
		assert.equal(tool_export.prototype.get_export_xsl, undefined, 'get_export_xsl must be gone')
		assert.equal(tool_export.prototype.export_table_with_xlsx_lib, undefined, 'export_table_with_xlsx_lib must be gone')
		assert.equal(typeof tool_export.prototype.on_close_actions, 'function', 'expected on_close_actions defined')
		assert.equal(typeof tool_export.prototype.update_local_db_data, 'function', 'expected update_local_db_data defined')
		assert.equal(typeof tool_export.prototype.compose_id, 'function', 'expected compose_id defined')
	})

	it('flat_table renders ONE page in the server column order, text only', function() {
		const table = new flat_table({show_tipo_in_label: true})
		const node = table.render_page({
			cols : [
				{t:'col', i:2, key:'b', label:'B', path:[{component_tipo:'test52'}]},
				{t:'col', i:0, key:'a', label:'A'}
			],
			rows : [
				{t:'row', rec:1, sub:0, c:{0:'<b>x</b>', 2:'y'}},
				{t:'row', rec:1, sub:1, c:{2:'z'}},
				{t:'row', rec:2, sub:0, c:{}}
			]
		})
		const header = [...node.querySelectorAll('tr.row_header th')].map(th => th.textContent)
		assert.deepEqual(header, ['B [test52]', 'A'], 'header follows the page cols order')
		const body = node.querySelectorAll('tr:not(.row_header)')
		assert.equal(body.length, 3, 'exactly the page rows')
		assert.equal(node.querySelectorAll('tr.sub_row').length, 1, 'breakdown sub-row marked')
		assert.equal(body[0].children[1].textContent, '<b>x</b>', 'a value is text, never parsed HTML')
		assert.equal(body[0].querySelector('b'), null, 'no element created from a value')
		assert.equal(typeof table.to_delimited, 'undefined', 'no client-side file writer')
	})

	it('construct owns an export runtime that reset releases', function() {
		const instance = new tool_export()
		assert.equal(typeof instance.job_followers.cancel_all, 'function', 'expected a follower group')
		let fired = false
		instance.export_timers.add(setTimeout(() => { fired = true }, 0))
		const old_signal = instance.export_abort.signal
		instance.reset_export_runtime()
		assert.equal(old_signal.aborted, true, 'in-flight requests aborted')
		assert.equal(instance.export_timers.size, 0, 'timers cleared')
		return new Promise(resolve => setTimeout(() => {
			assert.equal(fired, false, 'a cleared timer never fires')
			resolve()
		}, 20))
	})

})



/**
 * THE SERVER-BUILT EXPORT — the real tool, the real server, a built situation.
 *
 * Situation: EXPORT_RECORDS new test3 records (created here through the
 * engine's create door and deleted in `after`), exported through a caller whose
 * SQO names exactly those records, with the preview page size pinned to
 * PAGE_SIZE — so the export is more than three pages. The column is the record's
 * own component_section_id (test102), which makes every row identify its record.
 *
 * The caller is a minimal section stand-in (the tool reads only its model,
 * tipo/section_tipo, label, rqo.source / rqo.sqo, build() and get_total()); the
 * TOOL is the real one: its registered context, build, render, buttons, pager
 * and job followers, against the suite server.
 *
 * Asserted:
 *   - after Export, the DOM never holds more rows than the page size (observed
 *     on every mutation of the preview container, not only at the end);
 *   - the pager walks every page and reaches the last record; every record is
 *     seen exactly once;
 *   - CSV, XLSX and HTML built by build_export_file (clicked through the
 *     download buttons) and fetched from the returned url contain all records;
 *   - Stop / a cancelled export leaves no enabled download button;
 *   - reopening the tool reconnects to the finished export;
 *   - destroying the tool leaves no follower, timer, frame or request behind.
 *
 * Downloads: the tool hands the url to a hidden <a download>; a capturing click
 * listener records the url and cancels the navigation, so the headless browser
 * writes nothing to disk and the test fetches the url itself.
 */
describe('TOOL_EXPORT SERVER-BUILT EXPORT', function() {

	this.timeout(180000)

	const SECTION			= 'test3'
	const SECTION_ID_TIPO	= 'test102' // component_section_id
	const LANG				= 'lg-eng'
	const EXPORT_RECORDS	= 80
	const PAGE_SIZE			= 25 // one of the tool's page-size options
	const PAGE_SIZE_KEY		= 'tool_export_preview_page_size'
	const EXPECTED_PAGES	= Math.ceil(EXPORT_RECORDS / PAGE_SIZE)

	const created_ids	= []
	const id_set		= new Set()
	let tool_context	= null
	let caller			= null
	let tool			= null
	let ended_job_id	= null
	let tool_seq		= 0
	let stored_page_size	= null
	const captured_downloads = []

	// capture the tool's <a download> clicks: record the url, write nothing
	const on_download_click = function(e) {
		const link = e.target
		if (link && link.tagName==='A' && link.hasAttribute('download')) {
			e.preventDefault()
			captured_downloads.push(link.href)
		}
	}

	const container = document.getElementById('content') || document.body
	const test_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container tool_export_server_built',
		parent			: container
	})

	// WAIT_FOR: poll a predicate (the export is asynchronous by nature)
	const wait_for = async function(predicate, label, timeout=60000) {
		const start = Date.now()
		while (Date.now() - start < timeout) {
			if (predicate()) {
				return true
			}
			await new Promise(resolve => setTimeout(resolve, 50))
		}
		throw new Error('timed out waiting for: ' + label)
	}

	// API: a plain dd_core_api call, failing loudly
	const api = async function(body) {
		const api_response = await data_manager.request({body})
		if (request_failed(api_response)) {
			throw new Error(`${body.action} refused: ${api_response.error.code}`)
		}
		return response_data(api_response)
	}

	const section_source = function(section_id=null) {
		return {
			typo			: 'source',
			type			: 'section',
			model			: 'section',
			tipo			: SECTION,
			section_tipo	: SECTION,
			section_id		: section_id,
			mode			: 'edit',
			lang			: LANG
		}
	}

	// in bounded parallel batches (the create door is one request per record)
	const in_batches = async function(items, fn, size=8) {
		for (let i = 0; i < items.length; i += size) {
			await Promise.all(items.slice(i, i + size).map(fn))
		}
	}

	const make_caller = function(ids) {
		return {
			id				: 'test_tool_export_caller',
			id_base			: 'test_tool_export_caller',
			model			: 'section',
			type			: 'section',
			tipo			: SECTION,
			section_tipo	: SECTION,
			section_id		: null,
			mode			: 'list',
			lang			: LANG,
			label			: 'test3',
			status			: 'built',
			rqo				: {
				source	: section_source(),
				sqo		: {
					section_tipo		: [SECTION],
					filter_by_locators	: ids.map(id => ({section_tipo: SECTION, section_id: id})),
					limit				: 10,
					offset				: 0
				}
			},
			build		: async function() { return true },
			get_total	: async function() { return ids.length }
		}
	}

	// OPEN_TOOL: the real tool from its registered context, rendered into the page
	const open_tool = async function(before_render=null) {
		const instance = await get_instance(Object.assign(
			{caller: caller, caller_options: null},
			tool_context,
			{lang: LANG, type: 'tool', id_variant: 'test_tool_export_' + (++tool_seq)}
		))
		await instance.build(true)
		if (before_render) {
			before_render(instance)
		}
		const wrapper = await instance.render()
		test_container.replaceChildren(wrapper)
		return instance
	}

	const export_ddo = function() {
		return {
			id					: SECTION + '_' + SECTION_ID_TIPO + '_list_' + LANG,
			tipo				: SECTION_ID_TIPO,
			section_tipo		: SECTION,
			model				: 'component_section_id',
			parent				: SECTION,
			lang				: LANG,
			mode				: 'list',
			label				: SECTION_ID_TIPO,
			value_with_parents	: false,
			path				: [{
				section_tipo	: SECTION,
				component_tipo	: SECTION_ID_TIPO,
				model			: 'component_section_id',
				name			: SECTION_ID_TIPO
			}]
		}
	}

	// click Export with this suite's column and options
	const click_export = function(instance) {
		instance.data_format		= 'value'
		instance.breakdown			= 'default'
		instance.ar_ddo_to_export	= [export_ddo()]
		instance.export_ui.button_export.click()
	}

	const body_rows = function(node) {
		return [...node.querySelectorAll('tr:not(.row_header)')]
	}

	// the created record a row stands for (its section_id cell)
	const row_record_id = function(tr) {
		for (const cell of tr.children) {
			const text = cell.textContent.trim()
			if (id_set.has(text)) {
				return text
			}
		}
		return null
	}

	const is_terminal = (state) => !!state && ['ended','cancelled','failed','interrupted'].includes(state.status)

	const settled_preview = (instance, page) => {
		const state = instance.export_state
		return !!state && !!state.preview && state.preview_loading===false && state.preview.page===page
	}

	const assert_downloads_follow_status = function(instance, label) {
		const ended = instance.export_state && instance.export_state.status==='ended'
		for (const [format, button] of instance.export_ui.download_buttons) {
			if (!ended) {
				assert.equal(button.disabled, true, `${label}: ${format} download must be disabled (status ${instance.export_state?.status})`)
			}
		}
	}

	// the newest export of this section, read from the server (not the tool)
	const newest_export = async function() {
		const data = await api({
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: true,
			source			: {model: 'tool_export', action: 'list_export_jobs'},
			options			: {section_tipo: SECTION}
		})
		return (data && data.jobs && data.jobs[0]) || null
	}

	before(async function() {
		// the page size this suite pins (restored in after)
		try {
			stored_page_size = localStorage.getItem(PAGE_SIZE_KEY)
			localStorage.setItem(PAGE_SIZE_KEY, String(PAGE_SIZE))
		} catch (error) {
			throw new Error('localStorage unavailable: the page size cannot be pinned')
		}
		document.addEventListener('click', on_download_click, true)

		// the situation: EXPORT_RECORDS fresh records, created through the engine
		await in_batches(Array.from({length: EXPORT_RECORDS}), async () => {
			const section_id = await api({action: 'create', source: section_source()})
			assert.ok(Number(section_id) > 0, 'create returned a section_id')
			created_ids.push(Number(section_id))
		})
		created_ids.sort((a, b) => a - b)
		for (const id of created_ids) {
			id_set.add(String(id))
		}
		assert.equal(id_set.size, EXPORT_RECORDS, 'every created record is distinct')

		const context_data = await api({
			action			: 'get_element_context',
			prevent_lock	: true,
			source			: {model: 'tool_export'}
		})
		tool_context = context_data && context_data[0]
		assert.ok(tool_context, 'the tool_export context is served (tool registered and authorized)')

		caller = make_caller(created_ids)
	})

	after(async function() {
		document.removeEventListener('click', on_download_click, true)
		try {
			if (stored_page_size===null) {
				localStorage.removeItem(PAGE_SIZE_KEY)
			}else{
				localStorage.setItem(PAGE_SIZE_KEY, stored_page_size)
			}
		} catch (error) {
			// nothing to restore
		}
		if (tool && tool.status!=='destroyed') {
			await tool.destroy(true, true, true)
		}
		test_container.remove()
		// no export of these records may still be running when they go
		const start = Date.now()
		while (Date.now() - start < 30000) {
			const job = await newest_export().catch(() => null)
			if (!job || job.status!=='running') {
				break
			}
			await new Promise(resolve => setTimeout(resolve, 250))
		}
		// the exports this suite built (the main one, the stopped ones, their CSV /
		// XLSX / HTML files) go through the owner's own door, so no job is left
		// listed for test3 — the next run's reconnect and newest_export() read that list
		const list_jobs = async () => ((await api({
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: true,
			source			: {model: 'tool_export', action: 'list_export_jobs'},
			options			: {section_tipo: SECTION}
		}).catch(() => null)) || {}).jobs || []
		let listed = await list_jobs()
		const settle_start = Date.now()
		while (listed.some(job => job.status==='running') && Date.now() - settle_start < 30000) {
			await new Promise(resolve => setTimeout(resolve, 250))
			listed = await list_jobs()
		}
		for (const job of listed) {
			await api({
				dd_api			: 'dd_tools_api',
				action			: 'tool_request',
				prevent_lock	: true,
				source			: {model: 'tool_export', action: 'delete_export_job'},
				options			: {section_tipo: SECTION, job_id: job.job_id}
			}).catch(() => null) // refused (busy): the check below names it
		}
		const remaining = await list_jobs()
		assert.deepEqual(remaining.map(job => job.job_id + ':' + job.status), [], 'no export of this suite is left behind')
		// sweep the situation (the rows the engine wrote ABOUT these records — the
		// delete's time-machine snapshot, the activity — are swept by the runner:
		// scripts/client_test_runner.ts sweepRunCreatedRecords)
		await in_batches(created_ids, async (id) => {
			await api({
				action	: 'delete',
				source	: Object.assign(section_source(id), {delete_mode: 'delete_record'})
			})
		})
	})

	it('Export: the DOM never holds more rows than the page size', async function() {
		tool = await open_tool()
		// the reconnect of a fresh open may paint an older export: wait for it to settle
		await new Promise(resolve => setTimeout(resolve, 300))

		const data_container = tool.export_ui.export_data_container
		let max_rows = 0
		let mutations = 0
		const observer = new MutationObserver(() => {
			mutations++
			max_rows = Math.max(max_rows, body_rows(data_container).length)
		})
		observer.observe(data_container, {childList: true, subtree: true})

		click_export(tool)
		const accepted = tool.export_state
		await wait_for(() => tool.export_state===accepted && is_terminal(accepted) && settled_preview(tool, 0), 'the export to end with page 0 loaded')
		observer.disconnect()

		const state = tool.export_state
		assert.equal(state.status, 'ended', 'the export ended: ' + (state.error_text || state.error_code || ''))
		assert.equal(state.total, EXPORT_RECORDS, 'total = the created records')
		assert.equal(state.preview.page_size, PAGE_SIZE, 'the pinned page size was served')
		assert.ok(mutations > 0, 'the preview was painted')
		assert.ok(max_rows <= PAGE_SIZE, `the DOM held at most ${PAGE_SIZE} rows (max observed ${max_rows})`)
		assert.equal(body_rows(data_container).length, PAGE_SIZE, 'the first page is full')
		ended_job_id = state.job_id
		assert.ok(ended_job_id, 'the export has an artifact id')

		// downloads enabled only now, media_zip only with media columns (none here)
		for (const [format, button] of tool.export_ui.download_buttons) {
			assert.equal(button.disabled, format==='media_zip', `${format} button enabled state after the end`)
		}
	})

	it('the pager walks every page and reaches the last record', async function() {
		const pager = tool.export_ui.pager
		const data_container = tool.export_ui.export_data_container
		const seen = new Map()
		const collect = () => {
			const rows = body_rows(data_container)
			assert.ok(rows.length <= PAGE_SIZE, `a page holds at most ${PAGE_SIZE} rows (got ${rows.length})`)
			for (const tr of rows) {
				const id = row_record_id(tr)
				assert.ok(id, 'every row carries one of the created records')
				seen.set(id, (seen.get(id) || 0) + 1)
			}
		}

		collect()
		let pages = 1
		while (!pager.next.disabled) {
			const expected = tool.export_state.page + 1
			pager.next.click()
			await wait_for(() => settled_preview(tool, expected), 'page ' + expected)
			collect()
			pages++
			assert.ok(pages <= EXPECTED_PAGES, 'the pager never runs past the last page')
		}

		const preview = tool.export_state.preview
		assert.equal(pages, EXPECTED_PAGES, 'pages walked')
		assert.equal(preview.first_record + preview.records, EXPORT_RECORDS, 'the last page ends at the last record')
		assert.equal(preview.has_more, false, 'nothing after the last page')
		assert.equal(pager.last.disabled, true, 'last disabled on the last page')
		assert.equal(seen.size, EXPORT_RECORDS, 'every record seen')
		assert.ok([...seen.values()].every(count => count===1), 'every record seen exactly once')

		// first → last jumps straight to the last page
		pager.first.click()
		await wait_for(() => settled_preview(tool, 0), 'page 0')
		pager.last.click()
		await wait_for(() => settled_preview(tool, EXPECTED_PAGES - 1), 'the last page')
		assert.ok(pager.range.textContent.includes(String(EXPORT_RECORDS)), 'the range names the last record: ' + pager.range.textContent)
	})

	// DOWNLOAD: click the format's button, wait for the url the tool hands over
	const download = async function(format) {
		const before = captured_downloads.length
		const button = tool.export_ui.download_buttons.get(format)
		assert.equal(button.disabled, false, format + ' button enabled')
		button.click()
		const status_node = tool.export_ui.download_status
		await wait_for(
			() => captured_downloads.length > before || status_node.classList.contains('error'),
			format + ' file built'
		)
		assert.ok(captured_downloads.length > before, `${format} built: ${status_node.textContent}`)
		const url = captured_downloads[captured_downloads.length - 1]
		const response = await fetch(url, {credentials: 'same-origin'})
		assert.equal(response.ok, true, `${format} url answers (${response.status})`)
		return response
	}

	it('CSV built by the server holds every record', async function() {
		const text = await (await download('csv')).text()
		const lines = text.replace(/^﻿/, '').split('\n')
		assert.equal(lines.length, EXPORT_RECORDS + 1, 'header + one line per record')
		const found = new Set()
		for (const line of lines.slice(1)) {
			for (const field of line.split(';')) {
				const value = field.replace(/^"|"$/g, '')
				if (id_set.has(value)) {
					found.add(value)
				}
			}
		}
		assert.equal(found.size, EXPORT_RECORDS, 'every record in the CSV')
	})

	it('HTML built by the server holds every record', async function() {
		const text = await (await download('html')).text()
		const doc = new DOMParser().parseFromString(text, 'text/html')
		const rows = body_rows(doc)
		assert.equal(rows.length, EXPORT_RECORDS, 'one row per record')
		const found = new Set(rows.map(row_record_id).filter(Boolean))
		assert.equal(found.size, EXPORT_RECORDS, 'every record in the HTML')
		assert.equal(doc.querySelector('script'), null, 'no script in the file')
	})

	// READ_ZIP_ENTRY: one entry of a (non-ZIP64) archive, through its central directory
	const read_zip_entry = async function(bytes, name) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let eocd = -1
		for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
			if (view.getUint32(i, true)===0x06054b50) { eocd = i; break }
		}
		assert.ok(eocd >= 0, 'zip end record')
		const entries	= view.getUint16(eocd + 10, true)
		let offset		= view.getUint32(eocd + 16, true)
		const decoder	= new TextDecoder()
		for (let n = 0; n < entries; n++) {
			assert.equal(view.getUint32(offset, true), 0x02014b50, 'central record')
			const method		= view.getUint16(offset + 10, true)
			const compressed	= view.getUint32(offset + 20, true)
			const name_length	= view.getUint16(offset + 28, true)
			const extra_length	= view.getUint16(offset + 30, true)
			const comment_length= view.getUint16(offset + 32, true)
			const local			= view.getUint32(offset + 42, true)
			const entry_name	= decoder.decode(bytes.subarray(offset + 46, offset + 46 + name_length))
			if (entry_name===name) {
				const data_start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
				const data = bytes.subarray(data_start, data_start + compressed)
				if (method===0) {
					return decoder.decode(data)
				}
				assert.equal(method, 8, 'deflate')
				const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
				return await new Response(stream).text()
			}
			offset += 46 + name_length + extra_length + comment_length
		}
		return null
	}

	it('XLSX built by the server holds every record', async function() {
		const bytes = new Uint8Array(await (await download('xlsx')).arrayBuffer())
		assert.ok(bytes.length > 22, 'a non-empty file')
		assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'PK zip magic')
		const sheet = await read_zip_entry(bytes, 'xl/worksheets/sheet1.xml')
		assert.ok(sheet, 'the workbook has sheet1')
		const rows = sheet.match(/<row[\s>]/g) || []
		assert.equal(rows.length, EXPORT_RECORDS + 1, 'header + one row per record')
		for (const id of id_set) {
			assert.ok(sheet.includes('>' + id + '<'), 'record ' + id + ' in the sheet')
		}
	})

	it('a second download clicked while a file is being prepared WAITS for it, never races it', async function() {
		// The server admits one running file build per user by default
		// (export_job.ts exportFileLaneShare), so the tool queues the second
		// click instead of submitting it to be refused with export.too_many_jobs.
		const real_start = tool.start_export_file
		const calls = []
		const pending = []
		tool.start_export_file = function(file_options) {
			calls.push(file_options.format)
			return new Promise((resolve) => pending.push(resolve))
		}
		// a refused submit settles a build at once (no lane job to follow)
		const refused = {ok: false, request_id: '', error: {code: 'request.invalid_options', message: 'test double', label_key: null, retryable: false}}
		try {
			const tsv = tool.export_ui.download_buttons.get('tsv')
			const ods = tool.export_ui.download_buttons.get('ods')
			tsv.click()
			ods.click()
			await new Promise((resolve) => setTimeout(resolve, 50))
			assert.deepEqual(calls, ['tsv'], 'only the first build is submitted while it runs')
			assert.ok(ods.classList.contains('loading') && ods.disabled, 'the queued button shows as waiting')
			pending.shift()(refused)
			await wait_for(() => calls.length===2, 'the queued build submitted after the first settled', 5000)
			assert.deepEqual(calls, ['tsv', 'ods'], 'the second build ran after the first')
			pending.shift()(refused)
			await wait_for(() => !ods.classList.contains('loading'), 'the second build settled', 5000)
		} finally {
			tool.start_export_file = real_start
			for (const resolve of pending) resolve(refused)
		}
	})

	it('reopening the tool reconnects to the finished export', async function() {
		await tool.destroy(true, true, true)
		tool = await open_tool()
		await wait_for(() => tool.export_state && tool.export_state.job_id===ended_job_id && settled_preview(tool, 0), 'the reconnect to the ended export')
		const state = tool.export_state
		assert.equal(state.status, 'ended', 'reconnected as ended')
		assert.equal(state.total, EXPORT_RECORDS, 'reconnected total')
		assert.equal(body_rows(tool.export_ui.export_data_container).length, PAGE_SIZE, 'the first page is shown, one page only')
		assert.equal(tool.export_ui.download_buttons.get('csv').disabled, false, 'downloads enabled after the reconnect')
		assert.equal(tool.job_followers.size(), 0, 'an ended export is not followed')
	})

	// FAKE_FOLLOWER_GROUP: the job_followers seam under the test's control. The
	// lane job's frames are the one thing a real export cannot be made to deliver
	// on cue (a stop lands only between hydrate batches, so on a small export it
	// races the end); the tool's own logic between the frames and the paint is
	// what these cases pin.
	const fake_follower_group = function() {
		const entries = []
		return {
			entries,
			follow : function(job_id, handlers) {
				const entry = {job_id, handlers, cancelled: false, done: false}
				entries.push(entry)
				return function() { entry.cancelled = true }
			},
			cancel_all : function() {
				for (const entry of entries) {
					entry.cancelled = true
				}
			},
			size : function() {
				return entries.filter(el => !el.cancelled && !el.done).length
			},
			// deliver a frame / the end to a live follower
			frame : function(job_id, frame) {
				const entry = entries.find(el => el.job_id===job_id && !el.cancelled && !el.done)
				if (entry && entry.handlers.on_frame) {
					entry.handlers.on_frame(frame)
				}
				return !!entry
			},
			done : function(job_id, frame) {
				const entry = entries.find(el => el.job_id===job_id && !el.cancelled && !el.done)
				if (entry) {
					entry.done = true
					entry.handlers.on_done && entry.handlers.on_done(frame)
				}
				return !!entry
			}
		}
	}

	const accepted_lane = (lane_job_id) => ({ok: true, request_id: 'test', data: true, job_id: lane_job_id, pfile: lane_job_id + '.json'})
	const jobs_response = (jobs) => ({ok: true, request_id: 'test', data: {jobs}})
	const transient_failure = () => ({ok: false, error: new ApiError({code: 'client.network', transport: true, retryable: true})})
	// a worker's raw exception line (an absolute path): must never reach the screen
	const RAW_LINE = 'ENOENT: no such file or directory, open \'/srv/private/.export_artifacts/x\''

	it('Stop before the first progress frame paints cancelled, never failed, and no raw worker text', async function() {
		const followers	= fake_follower_group()
		const stopped	= []
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.job_followers			= followers
			instance.list_export_jobs		= async () => jobs_response([])
			instance.start_export_job		= async () => accepted_lane('fake_lane_stop')
			instance.stop_export_process	= async (pfile) => { stopped.push(pfile); return {ok: true, request_id: 'test', data: true} }
		})
		click_export(tool)
		const accepted = tool.export_state
		await wait_for(() => accepted.status==='running' && followers.size()===1, 'the accepted export followed')
		assert.equal(tool.export_ui.button_stop.classList.contains('hide'), false, 'Stop visible (the pfile is known)')
		assert.equal(tool.export_ui.button_export.disabled, true, 'Export disabled while this tool can stop the job')

		tool.export_ui.button_stop.click()
		await wait_for(() => stopped.length===1 && accepted.stop_requested===true, 'the stop accepted')
		assert.equal(stopped[0], 'fake_lane_stop.json', 'Stop sent THIS export\'s pfile')
		// the lane job ends with no artifact id ever seen (stopped while queued)
		followers.done('fake_lane_stop', {is_running: false, data: {msg: 'Running tool_export::build_export_artifact'}, errors: [RAW_LINE]})
		await wait_for(() => is_terminal(accepted), 'the stopped export to settle')

		assert.equal(accepted.status, 'cancelled', 'an accepted Stop is cancelled, not failed')
		const text = tool.export_ui.response_container.textContent
		assert.ok(text.length > 0, 'the reason is shown')
		assert.equal(text.includes('ENOENT') || text.includes('/srv/'), false, 'no raw worker text on screen: ' + text)
		assert.equal(tool.export_ui.button_stop.classList.contains('hide'), true, 'Stop hidden once cancelled')
		for (const [format, button] of tool.export_ui.download_buttons) {
			assert.equal(button.disabled, true, format + ' disabled for a cancelled export')
		}
	})

	it('a failure before the first progress frame shows the label, not the worker\'s exception', async function() {
		const followers = fake_follower_group()
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.job_followers		= followers
			instance.list_export_jobs	= async () => jobs_response([])
			instance.start_export_job	= async () => accepted_lane('fake_lane_fail')
		})
		click_export(tool)
		const accepted = tool.export_state
		await wait_for(() => followers.size()===1, 'the accepted export followed')
		followers.done('fake_lane_fail', {is_running: false, data: null, errors: [RAW_LINE]})
		await wait_for(() => is_terminal(accepted), 'the failed export to settle')

		assert.equal(accepted.status, 'failed', 'failed')
		const text = tool.export_ui.response_container.textContent
		assert.ok(text.length > 0, 'the reason is shown')
		assert.equal(text.includes('ENOENT') || text.includes('/srv/'), false, 'no raw worker text on screen: ' + text)
	})

	it('a failed manifest never shows an unfilled label template or a bare code', async function() {
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.list_export_jobs = async () => jobs_response([{
				job_id		: 'fake_quota_job',
				status		: 'failed',
				section_tipo: SECTION,
				created_at	: new Date().toISOString(),
				total		: EXPORT_RECORDS,
				records		: 3,
				rows		: 3,
				files		: [],
				error		: {code: 'export.artifact_quota'}
			}])
		})
		await wait_for(() => tool.export_state && tool.export_state.status==='failed', 'the failed export painted')
		const text = tool.export_ui.response_container.textContent
		assert.ok(text.length > 0, 'the reason is shown')
		assert.equal(/\{[a-z_]+\}/i.test(text), false, 'no {placeholder} leaked: ' + text)
		assert.equal(text.startsWith('export.artifact_quota'), false, 'not the bare code: ' + text)
	})

	it('a NARROWED export says so on the status line: one notice, no coordinates', async function() {
		const ended_page = (job_id) => ({ok: true, request_id: 'test', data: {
			job_id, status: 'ended', cols: [], final_order: true, rows: [], elided: [],
			page: 0, page_size: PAGE_SIZE, first_record: 0, records: 0, has_more: false,
			total_records: 3, written_records: 3
		}})
		const notice = get_label.error_perm_out_of_scope || 'Some records are outside your scope'
		const status_with = async function(narrowed) {
			const job_id = 'fake_narrowed_' + String(narrowed)
			await tool.destroy(true, true, true)
			tool = await open_tool((instance) => {
				instance.list_export_jobs	= async () => jobs_response([{
					job_id		: job_id,
					status		: 'ended',
					section_tipo: SECTION,
					created_at	: new Date().toISOString(),
					total		: 3,
					records		: 3,
					rows		: 3,
					files		: [],
					narrowed	: narrowed,
					error		: null
				}])
				instance.get_export_preview	= async () => ended_page(job_id)
			})
			await wait_for(() => tool.export_state && tool.export_state.job_id===job_id && settled_preview(tool, 0), 'the ended export painted')
			return tool.export_ui.response_container.textContent
		}
		const narrowed = await status_with(true)
		assert.ok(narrowed.includes(notice), 'the narrowing is told: ' + narrowed)
		assert.equal(narrowed.split(notice).length - 1, 1, 'ONE notice')
		assert.equal(tool.export_ui.response_container.classList.contains('error'), false, 'an ended export, not a failure')
		const whole = await status_with(false)
		assert.equal(whole.includes(notice), false, 'a whole export says nothing: ' + whole)
	})

	it('an export an EXTERNAL source left INCOMPLETE says so: status line, downloads note, Run again re-runs the recorded export', async function() {
		const ended_page = (job_id) => ({ok: true, request_id: 'test', data: {
			job_id, status: 'ended', cols: [], final_order: true, rows: [], elided: [],
			page: 0, page_size: PAGE_SIZE, first_record: 0, records: 0, has_more: false,
			total_records: 3, written_records: 3
		}})
		const degraded_of = (retryable) => ({
			incomplete: true, retryable, cells: 5, records: 2,
			counts: [{service: 'zenon', state: retryable ? 'circuit_open' : 'disabled', cells: 5}],
			sample: [], sample_limit: 20
		})
		const submitted = []
		const open_with = async function(external_degraded, tag) {
			const job_id = 'fake_external_' + (tag || String(external_degraded ? external_degraded.retryable : 'clean'))
			await tool.destroy(true, true, true)
			tool = await open_tool((instance) => {
				instance.list_export_jobs	= async () => jobs_response([{
					job_id		: job_id,
					status		: 'ended',
					section_tipo: SECTION,
					created_at	: new Date().toISOString(),
					total		: 3,
					records		: 3,
					rows		: 3,
					files		: [],
					narrowed	: false,
					external_degraded	: external_degraded,
					error		: null
				}])
				instance.get_export_preview	= async () => ended_page(job_id)
				instance.start_export_job	= async (options) => {
					submitted.push(options)
					return {ok: false, request_id: 'test', error: {code: 'export.too_many_jobs', details: {limit: 2}}}
				}
			})
			await wait_for(() => tool.export_state && tool.export_state.job_id===job_id && settled_preview(tool, 0), 'the ended export painted')
			return job_id
		}
		const ui_refs = () => tool.export_ui

		// retryable: the counts + the service + "run it again", the note, the button
		const job_id = await open_with(degraded_of(true))
		let text = ui_refs().response_container.textContent
		assert.ok(text.includes('5'), 'the missing cells are counted: ' + text)
		assert.ok(text.includes('zenon'), 'the source is named: ' + text)
		const rerun_advice = tool.get_tool_label('export_external_rerun_advice') || 'Run the export again once the source is available.'
		assert.ok(text.includes(rerun_advice), 'it says to run it again: ' + text)
		assert.equal(ui_refs().response_container.classList.contains('error'), false, 'an ended export, not a failure')
		assert.equal(ui_refs().download_incomplete_note.classList.contains('hide'), false, 'the downloads say they are incomplete')
		for (const [format, button] of ui_refs().download_buttons) {
			if (format==='media_zip') continue
			assert.equal(button.disabled, false, 'the files stay downloadable: ' + format)
		}
		assert.equal(ui_refs().button_rerun.classList.contains('hide'), false, 'Run again is offered')
		ui_refs().button_rerun.click()
		await wait_for(() => submitted.length===1, 'the re-run submitted')
		assert.deepEqual(submitted[0], {rerun_of: job_id}, 'the RECORDED export is re-run, not the form')

		// not retryable (disabled): the administrator advice, no Run again
		await open_with(degraded_of(false))
		text = ui_refs().response_container.textContent
		const admin_advice = tool.get_tool_label('export_external_admin_advice') || 'The external source is disabled or misconfigured: contact the administrator.'
		assert.ok(text.includes(admin_advice), 'it says who can fix it: ' + text)
		assert.equal(ui_refs().button_rerun.classList.contains('hide'), true, 'no Run again for a disabled source')

		// TRUNCATED only (the size limits cut values that ARE partly in the files):
		// said for what it is — not "could not be read", no administrator, no Run again
		await open_with({
			incomplete: true, retryable: false, cells: 4, records: 2, missing_cells: 0, missing_records: 0,
			counts: [{service: 'zenon', state: 'truncated', cells: 4}],
			sample: [], sample_limit: 20
		}, 'truncated')
		text = ui_refs().response_container.textContent
		const truncated_label = (tool.get_tool_label('export_external_truncated')
			|| 'Incomplete: {cells} values from external sources ({services}) were cut to the export\'s size limits.')
			.replace('{cells}', '4').replace('{services}', 'zenon')
		assert.ok(text.includes(truncated_label), 'the cut values are named as cut: ' + text)
		assert.equal(text.includes(admin_advice), false, 'no administrator for a size limit: ' + text)
		assert.equal(text.includes(rerun_advice), false, 'no re-run advice for a size limit: ' + text)
		assert.equal(ui_refs().button_rerun.classList.contains('hide'), true, 'no Run again for a size limit')

		// 1 MISSING + 300 STALE: the missing count is 1 (the stale values are in the files)
		await open_with({
			incomplete: true, retryable: true, cells: 301, records: 150, missing_cells: 1, missing_records: 1,
			counts: [{service: 'zenon', state: 'stale', cells: 300}, {service: 'zenon', state: 'unavailable', cells: 1}],
			sample: [], sample_limit: 20
		}, 'mixed')
		text = ui_refs().response_container.textContent
		const missing_line = (tool.get_tool_label('export_external_incomplete')
			|| 'Incomplete: {cells} values from external sources ({services}) could not be read, in {records} records.')
			.replace('{cells}', '1').replace('{services}', 'zenon').replace('{records}', '1')
		assert.ok(text.includes(missing_line), 'one value could not be read, in one record: ' + text)
		assert.equal(text.includes('301'), false, 'stale values are not counted as unread: ' + text)
		assert.ok(text.includes(rerun_advice), 'the missing one can be re-read: ' + text)

		// clean: nothing said
		await open_with(null)
		text = ui_refs().response_container.textContent
		assert.equal(text.includes(rerun_advice) || text.includes(admin_advice), false, 'a whole export says nothing: ' + text)
		assert.equal(ui_refs().download_incomplete_note.classList.contains('hide'), true, 'no incomplete note')
		assert.equal(ui_refs().button_rerun.classList.contains('hide'), true, 'no Run again')
	})

	it('a WIDE export pages its columns: one window drawn, the pager asks for the next, media offered from every column', async function() {
		const asked = []
		const window_of = (col_page) => {
			const first = col_page * 100
			const count = col_page===0 ? 100 : 50
			const cols = Array.from({length: count}, (_, k) => ({
				t: 'col', i: first + k, key: 'k' + (first + k), label: 'L' + (first + k),
				cell_type: 'text', model: 'component_input_text', after: null
			}))
			const c = {}
			for (const col of cols) {
				c[String(col.i)] = 'v' + col.i
			}
			return {ok: true, request_id: 'test', data: {
				job_id: 'fake_wide', status: 'ended', cols, final_order: true,
				col_page, col_page_size: 100, first_col: first, total_cols: 150,
				// the media column lives in the window NOT drawn first
				col_models: ['component_input_text', 'component_image'],
				media_models: ['component_image'],
				rows: [{t: 'row', rec: 1, sub: 0, c}], elided: [],
				page: 0, page_size: PAGE_SIZE, first_record: 0, records: 1, has_more: false,
				total_records: 1, written_records: 1
			}}
		}
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.list_export_jobs	= async () => jobs_response([{
				job_id: 'fake_wide', status: 'ended', section_tipo: SECTION,
				created_at: new Date().toISOString(), total: 1, records: 1, rows: 1,
				files: [], narrowed: false, error: null
			}])
			instance.get_export_preview	= async (options) => {
				asked.push(options.col_page)
				return window_of(options.col_page || 0)
			}
		})
		await wait_for(() => tool.export_state && tool.export_state.job_id==='fake_wide' && settled_preview(tool, 0), 'the wide export painted')
		const container = tool.export_ui.export_data_container
		const header_cells = () => container.querySelectorAll('tr.row_header > *').length
		assert.equal(header_cells(), 100, 'one window of columns drawn')
		const pager = container.querySelector('.export_column_pager')
		assert.ok(pager, 'the column pager is shown')
		assert.ok(/1–100/.test(pager.textContent) && /150/.test(pager.textContent), 'the range is told: ' + pager.textContent)
		assert.equal(tool.export_ui.download_buttons.get('media_zip').disabled, false, 'media offered from media_models, not the window')
		pager.querySelector('.column_next').click()
		await wait_for(() => tool.export_state.col_page===1 && settled_preview(tool, 0), 'the next column window')
		assert.equal(asked[asked.length - 1], 1, 'the next window was asked for')
		assert.equal(header_cells(), 50, 'the second window drawn')
		assert.equal(container.querySelector('.export_column_pager .column_next').disabled, true, 'no window after the last')
	})

	it('a PORTAL column whose targets hold images offers the media ZIP from media_models, never from the column models', async function() {
		// The server's answer for a value-format portal export: the one column is
		// a component_portal (text cells mixing image URLs and a name), and the
		// walk READ component_image through it — media_models says so.
		const preview_of = (media_models, col_models, media_rerun_required=false) => ({ok: true, request_id: 'test', data: {
			job_id: 'fake_portal', status: 'ended', final_order: true,
			cols: [{t: 'col', i: 0, key: 'zzmz1_zzmz2', label: 'Photos', cell_type: 'text',
				model: 'component_portal', path: [{section_tipo: 'zzmz1', component_tipo: 'zzmz2'}], after: null}],
			col_page: 0, col_page_size: 100, first_col: 0, total_cols: 1,
			col_models, media_models, media_rerun_required,
			rows: [{t: 'row', rec: 1, sub: 0, c: {'0': 'http://media.example.test/image/1.5MB/0/test99_test3_1.jpg, Photographer One'}}],
			elided: [], page: 0, page_size: PAGE_SIZE, first_record: 0, records: 1, has_more: false,
			total_records: 1, written_records: 1
		}})
		const open_portal = async (media_models, col_models, media_rerun_required=false) => {
			await tool.destroy(true, true, true)
			tool = await open_tool((instance) => {
				instance.list_export_jobs	= async () => jobs_response([{
					job_id: 'fake_portal', status: 'ended', section_tipo: SECTION,
					created_at: new Date().toISOString(), total: 1, records: 1, rows: 1,
					files: [], narrowed: false, error: null
				}])
				instance.get_export_preview	= async () => preview_of(media_models, col_models, media_rerun_required)
			})
			await wait_for(() => tool.export_state && tool.export_state.job_id==='fake_portal' && settled_preview(tool, 0), 'the portal export painted')
		}

		// related media: offered, and the quality modal lists the image model
		await open_portal(['component_image', 'component_pdf'], ['component_portal'])
		assert.equal(tool.export_ui.download_buttons.get('media_zip').disabled, false, 'the portal export offers the media ZIP')
		assert.deepEqual(tool.media_components_in_data, ['component_image', 'component_pdf'], 'the modal lists the models the export READ')

		// the column models alone never enable it: media_models is the signal
		await open_portal([], ['component_image'])
		assert.equal(tool.export_ui.download_buttons.get('media_zip').disabled, true, 'no media_models, no media ZIP')
		assert.deepEqual(tool.media_components_in_data, [], 'nothing to choose a quality for')

		// an export made BEFORE capture with a portal column: still offered, so
		// its info.txt can say rerun_required (a disabled button hid the reason)
		await open_portal([], ['component_portal'], true)
		assert.equal(tool.export_ui.download_buttons.get('media_zip').disabled, false, 'media_rerun_required offers the media ZIP')
		assert.deepEqual(tool.media_components_in_data, [], 'no quality to choose: nothing will be archived')
	})

	it('reconnect: a lane job arms Stop only once its frame names this export; the poll survives a failed page', async function() {
		const followers		= fake_follower_group()
		let preview_calls	= 0
		const created_at	= Date.now() - 5000
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.job_followers		= followers
			instance.list_export_jobs	= async () => jobs_response([{
				job_id		: 'fake_running_job',
				status		: 'running',
				section_tipo: SECTION,
				created_at	: new Date(created_at).toISOString(),
				total		: EXPORT_RECORDS,
				records		: 5,
				rows		: 5,
				files		: [],
				error		: null
			}])
			// newest first: another export's (queued) lane job, a job scheduled
			// after this export began (cannot be its writer), then the real one
			instance.get_background_jobs = async () => ({ok: true, request_id: 'test', data: [
				{id: 'lane_later', action: 'build_export_artifact', status: 'running', started_at: created_at + 1000},
				{id: 'lane_other', action: 'build_export_artifact', status: 'running', started_at: created_at - 100},
				{id: 'lane_mine', action: 'build_export_artifact', status: 'running', started_at: created_at - 200}
			]})
			instance.get_export_preview = async () => { preview_calls++; return transient_failure() }
		})
		await wait_for(() => tool.export_state && followers.entries.length===2, 'the candidates followed')
		const state = tool.export_state
		assert.deepEqual(followers.entries.map(el => el.job_id), ['lane_other', 'lane_mine'], 'only the lane jobs that may be this export\'s writer')
		assert.equal(state.pfile, null, 'no pfile before a frame proves the match')
		assert.equal(tool.export_ui.button_stop.classList.contains('hide'), true, 'Stop hidden before the match')

		// the poll keeps going through a transient page failure
		await wait_for(() => preview_calls >= 2, 'the preview poll to retry after a failed page', 8000)

		followers.frame('lane_other', {is_running: true, data: {job_id: 'another_export', written: 1, total: 9}})
		assert.equal(followers.entries[0].cancelled, true, 'the mismatching candidate is dropped')
		assert.equal(state.pfile, null, 'still nothing to stop')

		followers.frame('lane_mine', {is_running: true, data: {job_id: 'fake_running_job', written: 7, total: EXPORT_RECORDS}})
		assert.equal(state.following, true, 'the confirmed lane job is followed')
		assert.equal(state.pfile, 'lane_mine.json', 'Stop armed with THIS export\'s pfile')
		assert.equal(tool.export_ui.button_stop.classList.contains('hide'), false, 'Stop visible after the match')
		assert.equal(followers.size(), 1, 'one live follower: the confirmed one')
	})

	it('reconnect: an export QUEUED in the lane (no manifest yet) is the current one — followed, Stop armed', async function() {
		const followers = fake_follower_group()
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.job_followers		= followers
			// an OLDER ended export has a manifest; the queued one has none yet
			instance.list_export_jobs	= async () => ({ok: true, request_id: 'test', data: {
				jobs	: [{
					job_id		: 'fake_older_ended',
					status		: 'ended',
					section_tipo: SECTION,
					created_at	: new Date(Date.now() - 60000).toISOString(),
					total		: EXPORT_RECORDS,
					records		: EXPORT_RECORDS,
					rows		: EXPORT_RECORDS,
					files		: [],
					error		: null
				}],
				pending	: [{background_job_id: 'lane_queued', submitted_at: Date.now() - 1000}]
			}})
			instance.get_background_jobs = async () => ({ok: true, request_id: 'test', data: []})
		})
		await wait_for(() => tool.export_state && followers.entries.some(el => el.job_id==='lane_queued'), 'the queued export followed')
		const state = tool.export_state
		assert.equal(state.lane_job_id, 'lane_queued', 'the queued lane job is the current export')
		assert.notEqual(state.job_id, 'fake_older_ended', 'the older export is NOT painted as the current one')
		assert.equal(state.status, 'running', 'running (queued)')
		assert.equal(state.pfile, 'lane_queued.json', 'Stop armed with the queued job\'s pfile')
		assert.equal(tool.export_ui.button_stop.classList.contains('hide'), false, 'Stop visible')

		// the walk starts: its first progress frame names the artifact
		followers.frame('lane_queued', {is_running: true, data: {job_id: 'fake_queued_artifact', written: 1, total: EXPORT_RECORDS}})
		assert.equal(state.job_id, 'fake_queued_artifact', 'the artifact id taken from the frame')
	})

	it('a job stream that drops while the export is still QUEUED is followed again, never painted failed', async function() {
		const followers = fake_follower_group()
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.job_followers		= followers
			instance.list_export_jobs	= async () => ({ok: true, request_id: 'test', data: {
				jobs	: [],
				pending	: instance.export_state && instance.export_state.lane_job_id==='lane_q_drop'
					? [{background_job_id: 'lane_q_drop', submitted_at: Date.now()}]
					: []
			}})
			instance.start_export_job	= async () => accepted_lane('lane_q_drop')
		})
		click_export(tool)
		const accepted = tool.export_state
		await wait_for(() => followers.size()===1, 'the accepted export followed')
		// the stream closes with no terminal frame while the job still waits
		followers.done('lane_q_drop', null)
		await wait_for(() => followers.entries.filter(el => el.job_id==='lane_q_drop' && !el.cancelled && !el.done).length===1, 'the queued job followed again', 8000)
		assert.equal(tool.export_state, accepted, 'the same export')
		assert.equal(accepted.status, 'running', 'still running, not failed')
		assert.equal(accepted.pfile, 'lane_q_drop.json', 'Stop still armed')
	})

	it('a new Export while a file is being built releases its download button', async function() {
		const followers	= fake_follower_group()
		let jobs		= [{
			job_id		: 'fake_ended_job',
			status		: 'ended',
			section_tipo: SECTION,
			created_at	: new Date().toISOString(),
			total		: EXPORT_RECORDS,
			records		: EXPORT_RECORDS,
			rows		: EXPORT_RECORDS,
			files		: [],
			error		: null
		}]
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.job_followers		= followers
			instance.list_export_jobs	= async () => jobs_response(jobs)
			instance.get_export_preview	= async () => transient_failure()
			instance.start_export_file	= async () => accepted_lane('fake_file_lane')
			instance.start_export_job	= async () => accepted_lane('fake_run_lane')
		})
		await wait_for(() => tool.export_state && tool.export_state.status==='ended', 'the ended export painted')
		const csv = tool.export_ui.download_buttons.get('csv')
		assert.equal(csv.disabled, false, 'csv enabled for the ended export')

		csv.click()
		await wait_for(() => followers.entries.some(el => el.job_id==='fake_file_lane'), 'the file build followed')
		assert.equal(csv.classList.contains('loading'), true, 'busy while the file builds')

		// a new Export cancels the file's follow: its button must not stay busy
		click_export(tool)
		const accepted = tool.export_state
		assert.equal(followers.entries.find(el => el.job_id==='fake_file_lane').cancelled, true, 'the file follow released')
		assert.equal(csv.classList.contains('loading'), false, 'the abandoned build leaves no busy button')

		// the new export ends: every download is enabled again
		await wait_for(() => followers.entries.some(el => el.job_id==='fake_run_lane' && !el.cancelled), 'the new export followed')
		jobs = [Object.assign({}, jobs[0], {job_id: 'fake_ended_job_2'})]
		followers.frame('fake_run_lane', {is_running: true, data: {job_id: 'fake_ended_job_2', written: EXPORT_RECORDS, total: EXPORT_RECORDS}})
		followers.done('fake_run_lane', {is_running: false, data: {ok: true, data: {job_id: 'fake_ended_job_2'}}, errors: []})
		await wait_for(() => accepted.status==='ended', 'the new export ended')
		assert.equal(csv.disabled, false, 'csv enabled again after the new export ended')
	})

	it('a follower cancelled by its caller leaves the group (size counts only live streams)', function() {
		const group		= create_job_follower_group()
		const cancel	= group.follow('test_tool_export_no_such_job', {})
		assert.equal(group.size(), 1, 'followed')
		cancel()
		assert.equal(group.size(), 0, 'a caller-side cancel prunes the group')
		group.cancel_all()
	})

	it('a cancelled export leaves no enabled download button', async function() {
		// The server records a stop as manifest status 'cancelled' with
		// error.code export.cancelled (tools/tool_export/server/export_job.ts
		// failJob; gated by tool_export_job_native). A real stop lands only between
		// hydrate batches, so on a small export it races the end; this case hands
		// the tool that manifest summary for its reconnect, deterministically.
		await tool.destroy(true, true, true)
		tool = await open_tool((instance) => {
			instance.list_export_jobs = async function() {
				return {ok: true, data: {jobs: [{
					job_id		: ended_job_id,
					status		: 'cancelled',
					section_tipo: SECTION,
					total		: EXPORT_RECORDS,
					records		: 10,
					rows		: 10,
					files		: [],
					error		: {code: 'export.cancelled'}
				}]}}
			}
		})
		await wait_for(() => tool.export_state && tool.export_state.status==='cancelled', 'the cancelled export painted')
		// let any (wrong) preview request land before asserting
		await new Promise(resolve => setTimeout(resolve, 300))
		for (const [format, button] of tool.export_ui.download_buttons) {
			assert.equal(button.disabled, true, format + ' disabled for a cancelled export')
		}
		assert.equal(tool.export_ui.button_print.disabled, true, 'print disabled (no page)')
		assert.equal(tool.export_state.preview, null, 'no page loaded')
		assert.equal(body_rows(tool.export_ui.export_data_container).length, 0, 'no rows shown')
		assert.equal(tool.export_ui.response_container.classList.contains('error'), true, 'the reason is shown as an error')
		assert.ok(tool.export_ui.response_container.textContent.length > 0, 'the reason is not empty')
		assert.equal(tool.export_ui.button_stop.classList.contains('hide'), true, 'nothing to stop')
		assert.equal(tool.export_ui.button_export.disabled, false, 'a new export can start')
	})

	it('Delete removes an ended export from the server and empties the view', async function() {
		await tool.destroy(true, true, true)
		tool = await open_tool()
		await wait_for(() => tool.export_state===null || is_terminal(tool.export_state), 'the reconnect to settle')
		click_export(tool)
		await wait_for(() => tool.export_state && tool.export_state.status==='ended' && tool.export_state.job_id && settled_preview(tool, 0), 'a fresh export to end')
		const job_id = tool.export_state.job_id
		const button_delete = tool.export_ui.button_delete
		assert.equal(button_delete.classList.contains('hide'), false, 'Delete is offered for an ended export')

		// the confirm is the user's: refused, nothing is sent
		const original_confirm = window.confirm
		let asked = 0
		try {
			window.confirm = () => { asked++; return false }
			button_delete.click()
			await new Promise(resolve => setTimeout(resolve, 300))
			assert.equal(asked, 1, 'the user is asked first')
			assert.equal(tool.export_state && tool.export_state.job_id, job_id, 'a refused confirm keeps the export')

			window.confirm = () => { asked++; return true }
			button_delete.click()
			await wait_for(() => tool.export_state===null, 'the view to empty after the delete')
		} finally {
			window.confirm = original_confirm
		}
		assert.equal(asked, 2, 'asked once per click')
		assert.equal(body_rows(tool.export_ui.export_data_container).length, 0, 'no rows shown')
		assert.equal(button_delete.classList.contains('hide'), true, 'nothing left to delete')
		assert.ok(tool.export_ui.response_container.textContent.length > 0, 'the deletion is reported')
		for (const [format, button] of tool.export_ui.download_buttons) {
			assert.equal(button.disabled, true, format + ' disabled after the delete')
		}
		// the server no longer has it
		const data = await api({
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: true,
			source			: {model: 'tool_export', action: 'list_export_jobs'},
			options			: {section_tipo: SECTION}
		})
		assert.equal((data.jobs || []).some(job => job.job_id===job_id), false, 'the export is gone from the list')
	})

	it('destroying the tool mid-export leaves no follower, timer, frame or request', async function() {
		await tool.destroy(true, true, true)
		tool = await open_tool()
		await wait_for(() => tool.export_state && is_terminal(tool.export_state) && tool.export_state.preview_loading===false, 'the reconnect to settle')

		// count the tool's requests from here on (the shared data_manager singleton)
		const original_request = data_manager.request
		let tool_requests_after_destroy = 0
		let destroyed = false
		data_manager.request = function(options) {
			if (destroyed && options?.body?.source?.model==='tool_export') {
				tool_requests_after_destroy++
			}
			return original_request.apply(this, arguments)
		}
		// the destroy lands right after the first follow opens — a microtask, so
		// no network turn can end the export in between (deterministic)
		const real_follow = tool.job_followers.follow
		let follow_opened = null
		const first_follow = new Promise(resolve => { follow_opened = resolve })
		tool.job_followers.follow = function() {
			const cancel = real_follow.apply(this, arguments)
			follow_opened()
			return cancel
		}
		try {
			click_export(tool)
			const accepted = tool.export_state
			await first_follow
			const followed = tool.job_followers.size()
			assert.equal(accepted.following, true, 'the export is being followed')

			const signal = tool.export_abort.signal
			await tool.destroy(true, true, true)
			destroyed = true

			assert.ok(followed >= 1, 'the running export was followed before the destroy')
			assert.equal(tool.job_followers.size(), 0, 'no job stream left open')
			assert.equal(tool.export_timers.size, 0, 'no timer left')
			assert.equal(tool.export_raf, null, 'no animation frame left')
			assert.equal(signal.aborted, true, 'in-flight requests aborted')
			assert.equal(tool.export_abort.signal.aborted, true, 'no request may start after the destroy')
			assert.equal(tool.export_state, null, 'the export view is released')

			// longer than the preview poll: nothing wakes up for the destroyed tool
			await new Promise(resolve => setTimeout(resolve, 2500))
			assert.equal(tool_requests_after_destroy, 0, 'no tool_export request after the destroy')
		} finally {
			data_manager.request = original_request
		}
	})
})

describe('TOOL_EXPORT PARENTS CHECKBOX (per data format)', function() {

	this.timeout(60000)

	const SECTION		= 'test3'
	const PORTAL		= 'test80' // component_portal → test3 (hierarchical: test3 owns test71)
	const LANG			= 'lg-eng'
	const FORMAT_KEY	= 'selected_data_format_export'
	const BREAKDOWN_KEY	= 'selected_breakdown_export' // a preset apply sets it too

	let tool			= null
	const stored		= new Map()

	const container = document.getElementById('content') || document.body
	const test_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container tool_export_parents_check',
		parent			: container
	})

	const portal_ddo = function(value_with_parents) {
		return {
			id					: SECTION + '_' + PORTAL + '_list_' + LANG,
			tipo				: PORTAL,
			section_tipo		: SECTION,
			model				: 'component_portal',
			parent				: SECTION,
			lang				: LANG,
			mode				: 'list',
			label				: PORTAL,
			value_with_parents	: value_with_parents,
			path				: [{
				section_tipo	: SECTION,
				component_tipo	: PORTAL,
				model			: 'component_portal',
				name			: PORTAL
			}]
		}
	}

	// the parents label/check/note of the ONE column this suite adds
	const parents_nodes = function() {
		const label = tool.user_selection_list.querySelector('.export_component_parents')
		assert.ok(label, 'the portal column renders its parents checkbox (server-confirmed hierarchical target)')
		return {
			label	: label,
			check	: label.querySelector('.export_component_parents_check'),
			note	: label.querySelector('.export_component_parents_note')
		}
	}

	const select_format = function(value) {
		const select = tool.node.querySelector('.select_data_format_export')
		select.value = value
		select.dispatchEvent(new Event('change'))
	}

	const assert_state = function(format, enabled) {
		const {label, check, note} = parents_nodes()
		assert.equal(tool.data_format, format, 'the tool follows the select')
		assert.equal(check.disabled, !enabled, `${format}: checkbox ${enabled ? 'enabled' : 'disabled'}`)
		assert.equal(label.classList.contains('disabled'), !enabled, `${format}: label marked`)
		assert.ok(note, 'the note node exists')
		assert.equal(note.classList.contains('hide'), enabled, `${format}: the 'not in Raw' note ${enabled ? 'hidden' : 'visible'}`)
	}

	before(async function() {
		for (const key of [FORMAT_KEY, BREAKDOWN_KEY]) {
			try {
				stored.set(key, localStorage.getItem(key))
			} catch (error) {
				stored.set(key, null)
			}
		}
		const api_response = await data_manager.request({body: {
			action			: 'get_element_context',
			prevent_lock	: true,
			source			: {model: 'tool_export'}
		}})
		if (request_failed(api_response)) {
			throw new Error('get_element_context refused: ' + api_response.error.code)
		}
		const tool_context = response_data(api_response)[0]
		assert.ok(tool_context, 'the tool_export context is served')
		const caller = {
			id			: 'test_tool_export_parents_caller',
			id_base		: 'test_tool_export_parents_caller',
			model		: 'section',
			type		: 'section',
			tipo		: SECTION,
			section_tipo: SECTION,
			section_id	: null,
			mode		: 'list',
			lang		: LANG,
			label		: SECTION,
			status		: 'built',
			rqo			: {
				source	: {typo: 'source', type: 'section', model: 'section', tipo: SECTION, section_tipo: SECTION, section_id: null, mode: 'list', lang: LANG},
				sqo		: {section_tipo: [SECTION], filter_by_locators: [{section_tipo: SECTION, section_id: 1}], limit: 10, offset: 0}
			},
			build		: async function() { return true },
			get_total	: async function() { return 1 }
		}
		tool = await get_instance(Object.assign(
			{caller: caller, caller_options: null},
			tool_context,
			{lang: LANG, type: 'tool', id_variant: 'test_tool_export_parents'}
		))
		await tool.build(true)
		// the IndexedDB selection must not change under this suite
		tool.update_local_db_data = async function() { return true }
		const wrapper = await tool.render()
		test_container.replaceChildren(wrapper)
		// only this suite's column in the list (a restored selection is dropped)
		await new Promise(resolve => setTimeout(resolve, 300))
		tool.user_selection_list.replaceChildren()
	})

	after(async function() {
		if (tool && tool.status!=='destroyed') {
			await tool.destroy(true, true, true)
		}
		test_container.remove()
		for (const [key, value] of stored) {
			try {
				if (value===null) {
					localStorage.removeItem(key)
				}else{
					localStorage.setItem(key, value)
				}
			} catch (error) {
				// nothing to restore
			}
		}
	})

	it('enabled in value and grid_value, disabled with a visible note in dedalo_raw, re-evaluated on every format change', async function() {
		select_format('value')
		const node = await tool.build_export_component(portal_ddo(true))
		tool.user_selection_list.appendChild(node)
		assert_state('value', true)
		assert.equal(parents_nodes().check.checked, true, 'the ddo flag is shown')

		select_format('dedalo_raw')
		assert_state('dedalo_raw', false)
		assert.equal(parents_nodes().check.checked, true, 'the flag is kept (restored when the format comes back)')

		select_format('grid_value')
		assert_state('grid_value', true)

		select_format('dedalo_raw')
		select_format('value')
		assert_state('value', true)
	})

	it('a column built while dedalo_raw is selected starts disabled', async function() {
		select_format('dedalo_raw')
		tool.user_selection_list.replaceChildren()
		tool.user_selection_list.appendChild(await tool.build_export_component(portal_ddo(false)))
		assert.equal(parents_nodes().check.checked, false, 'the ddo flag (off) is shown')
		assert_state('dedalo_raw', false)
		select_format('value')
		assert_state('value', true)
	})

	it('a preset carrying the flag with dedalo_raw restores a DISABLED checkbox', async function() {
		select_format('value')
		await apply_export_preset({
			self		: tool,
			config		: {data_format: 'dedalo_raw', breakdown: 'default', ar_ddo_to_export: [portal_ddo(true)]},
			section_id	: null
		})
		assert_state('dedalo_raw', false)
		assert.equal(parents_nodes().check.checked, true, 'the preset flag is kept')
		select_format('value')
		assert_state('value', true)
	})
})

describe('TOOL_EXPORT REFERENCES CHECKBOX (calculated relations, per data format)', function() {

	this.timeout(60000)

	const SECTION		= 'test3'
	const RELATED		= 'test56' // component_relation_related dd621 MULTIDIRECTIONAL: has calculated relations
	const UNIDIRECTIONAL	= 'test54' // component_relation_related dd620: none — no checkbox (server-confirmed)
	const PORTAL		= 'test80' // component_portal (no references checkbox)
	const LANG			= 'lg-eng'
	const FORMAT_KEY	= 'selected_data_format_export'
	const BREAKDOWN_KEY	= 'selected_breakdown_export'

	let tool			= null
	const stored		= new Map()

	const container = document.getElementById('content') || document.body
	const test_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container tool_export_references_check',
		parent			: container
	})

	const column_ddo = function(tipo, model, value_with_references) {
		return {
			id						: SECTION + '_' + tipo + '_list_' + LANG,
			tipo					: tipo,
			section_tipo			: SECTION,
			model					: model,
			parent					: SECTION,
			lang					: LANG,
			mode					: 'list',
			label					: tipo,
			value_with_parents		: false,
			value_with_references	: value_with_references,
			path					: [{
				section_tipo	: SECTION,
				component_tipo	: tipo,
				model			: model,
				name			: tipo
			}]
		}
	}
	const related_ddo = (flag) => column_ddo(RELATED, 'component_relation_related', flag)

	const references_nodes = function() {
		const label = tool.user_selection_list.querySelector('.export_component_references')
		assert.ok(label, 'the related column renders its references checkbox')
		return {
			label	: label,
			check	: label.querySelector('.export_component_references_check'),
			note	: label.querySelector('.export_component_references_note')
		}
	}

	const select_format = function(value) {
		const select = tool.node.querySelector('.select_data_format_export')
		select.value = value
		select.dispatchEvent(new Event('change'))
	}

	const assert_state = function(format, enabled) {
		const {label, check, note} = references_nodes()
		assert.equal(tool.data_format, format, 'the tool follows the select')
		assert.equal(check.disabled, !enabled, `${format}: checkbox ${enabled ? 'enabled' : 'disabled'}`)
		assert.equal(label.classList.contains('disabled'), !enabled, `${format}: label marked`)
		assert.ok(note, 'the note node exists')
		assert.equal(note.classList.contains('hide'), enabled, `${format}: the 'not in Raw' note ${enabled ? 'hidden' : 'visible'}`)
	}

	before(async function() {
		for (const key of [FORMAT_KEY, BREAKDOWN_KEY]) {
			try {
				stored.set(key, localStorage.getItem(key))
			} catch (error) {
				stored.set(key, null)
			}
		}
		const api_response = await data_manager.request({body: {
			action			: 'get_element_context',
			prevent_lock	: true,
			source			: {model: 'tool_export'}
		}})
		if (request_failed(api_response)) {
			throw new Error('get_element_context refused: ' + api_response.error.code)
		}
		const tool_context = response_data(api_response)[0]
		assert.ok(tool_context, 'the tool_export context is served')
		const caller = {
			id			: 'test_tool_export_references_caller',
			id_base		: 'test_tool_export_references_caller',
			model		: 'section',
			type		: 'section',
			tipo		: SECTION,
			section_tipo: SECTION,
			section_id	: null,
			mode		: 'list',
			lang		: LANG,
			label		: SECTION,
			status		: 'built',
			rqo			: {
				source	: {typo: 'source', type: 'section', model: 'section', tipo: SECTION, section_tipo: SECTION, section_id: null, mode: 'list', lang: LANG},
				sqo		: {section_tipo: [SECTION], filter_by_locators: [{section_tipo: SECTION, section_id: 1}], limit: 10, offset: 0}
			},
			build		: async function() { return true },
			get_total	: async function() { return 1 }
		}
		tool = await get_instance(Object.assign(
			{caller: caller, caller_options: null},
			tool_context,
			{lang: LANG, type: 'tool', id_variant: 'test_tool_export_references'}
		))
		await tool.build(true)
		// the IndexedDB selection must not change under this suite
		tool.update_local_db_data = async function() { return true }
		const wrapper = await tool.render()
		test_container.replaceChildren(wrapper)
		await new Promise(resolve => setTimeout(resolve, 300))
		tool.user_selection_list.replaceChildren()
	})

	after(async function() {
		if (tool && tool.status!=='destroyed') {
			await tool.destroy(true, true, true)
		}
		test_container.remove()
		for (const [key, value] of stored) {
			try {
				if (value===null) {
					localStorage.removeItem(key)
				}else{
					localStorage.setItem(key, value)
				}
			} catch (error) {
				// nothing to restore
			}
		}
	})

	it('gated by the SERVER: a dd621 related renders it (and no parents check); a dd620 related and a portal do not', async function() {
		select_format('value')
		tool.user_selection_list.replaceChildren()
		const related = await tool.build_export_component(related_ddo(false))
		assert.ok(related.querySelector('.export_component_references'), 'dd621 related: references checkbox')
		assert.equal(related.querySelector('.export_component_parents'), null, 'related: no parents checkbox')
		// same model, no calculated relations: the server says no (T0-9 D4 — the
		// export would refuse the flag on it)
		const unidirectional = await tool.build_export_component(column_ddo(UNIDIRECTIONAL, 'component_relation_related', false))
		assert.equal(unidirectional.querySelector('.export_component_references'), null, 'dd620 related: no references checkbox')
		const portal = await tool.build_export_component(column_ddo(PORTAL, 'component_portal', false))
		assert.equal(portal.querySelector('.export_component_references'), null, 'portal: no references checkbox')
	})

	it('enabled in value and grid_value, disabled with a visible note in dedalo_raw; the check writes the ddo flag', async function() {
		select_format('value')
		tool.user_selection_list.replaceChildren()
		const ddo = related_ddo(false)
		tool.user_selection_list.appendChild(await tool.build_export_component(ddo))
		assert_state('value', true)
		const {check} = references_nodes()
		assert.equal(check.checked, false, 'the ddo flag (off) is shown')
		check.checked = true
		check.dispatchEvent(new Event('change'))
		assert.equal(ddo.value_with_references, true, 'checking writes ddo.value_with_references')

		select_format('dedalo_raw')
		assert_state('dedalo_raw', false)
		assert.equal(references_nodes().check.checked, true, 'the flag is kept')

		select_format('grid_value')
		assert_state('grid_value', true)
		select_format('value')
	})

	it('a preset round-trips the flag: applied → shown checked (disabled in raw) and saved back inside ar_ddo_to_export', async function() {
		select_format('value')
		await apply_export_preset({
			self		: tool,
			config		: {data_format: 'dedalo_raw', breakdown: 'default', ar_ddo_to_export: [related_ddo(true)]},
			section_id	: null
		})
		assert_state('dedalo_raw', false)
		assert.equal(references_nodes().check.checked, true, 'the preset flag is shown')
		select_format('value')
		assert_state('value', true)
		const config = build_export_config(tool)
		const saved = config.ar_ddo_to_export.find(el => el.tipo===RELATED)
		assert.ok(saved, 'the related column is in the saved config')
		assert.equal(saved.value_with_references, true, 'the flag rides the saved ddo')
	})
})



describe('TOOL_EXPORT DROP MODEL (one zone, one marker)', function() {

	// a fake tool: only what the drag handlers touch. Rows are real DOM nodes
	// in a real, laid-out list so the midpoint rule reads real geometry.
	let zone, list, self, rows
	const ROW_H = 30

	const make_row = (id) => {
		const node = document.createElement('div')
		node.className = 'export_component'
		node.style.cssText = `height:${ROW_H}px;margin:0;padding:0`
		node.textContent = id
		node.ddo = {id}
		return node
	}
	const fake_event = (client_y) => ({
		clientY			: client_y,
		dataTransfer	: {dropEffect: null, effectAllowed: null, setData() {}},
		preventDefault() {},
		stopPropagation() {}
	})
	// the pointer over the row `i`, at a fraction of its height
	const y_at = (i, fraction) => list.getBoundingClientRect().top + ROW_H * (i + fraction)
	const order = () => [...list.children].filter(n => n.classList.contains('export_component')).map(n => n.ddo.id)
	const marker_index = () => [...list.children].indexOf(list.querySelector('.drop_marker'))

	before(function() {
		zone = document.createElement('div')
		zone.style.cssText = 'position:fixed;top:0;left:0;width:300px;height:400px'
		list = document.createElement('div')
		zone.appendChild(list)
		document.body.appendChild(zone)
	})
	after(function() {
		zone.remove()
	})

	const reset = () => {
		list.replaceChildren()
		rows = ['a', 'b', 'c'].map(make_row)
		list.append(...rows)
		self = {
			user_selection_list		: list,
			compose_id				: (ddo) => ddo.tipo,
			sync_ar_ddo_to_export() { this.synced = order() },
			update_local_db_data() { this.saved = true },
			build_export_component	: async (ddo) => make_row(ddo.id)
		}
	}
	const start_add = (tipo) => on_dragstart.call(self, {path: [], ddo: {tipo, label: tipo}}, fake_event(0))

	it('get_drop_index: upper half = before, lower half = after, below all = end', function() {
		reset()
		assert.equal(get_drop_index(rows, y_at(0, 0.25)), 0)
		assert.equal(get_drop_index(rows, y_at(0, 0.75)), 1)
		assert.equal(get_drop_index(rows, y_at(2, 0.75)), 3)
		assert.equal(get_drop_index(rows, y_at(5, 0)), 3, 'far below the list appends')
		assert.equal(get_drop_index([], 10), 0)
	})

	it('below the last row the marker sits AFTER it and the drop appends', async function() {
		reset()
		start_add('new')
		on_dragover.call(self, zone, fake_event(y_at(4, 0.5)))
		assert.equal(marker_index(), 3, 'the marker is the last child')
		assert.equal(list.querySelectorAll('.drop_marker').length, 1, 'exactly one marker')
		on_drop.call(self, zone, fake_event(y_at(4, 0.5)))
		assert.equal(list.querySelector('.drop_marker'), null, 'no marker after the drop')
		await new Promise(r => setTimeout(r, 0))
		assert.deepEqual(order(), ['a', 'b', 'c', 'new'])
		assert.deepEqual(self.synced, ['a', 'b', 'c', 'new'], 'the order is synced from the DOM')
	})

	it('the lower half of a row inserts after it', async function() {
		reset()
		start_add('new')
		on_dragover.call(self, zone, fake_event(y_at(0, 0.8)))
		assert.equal(marker_index(), 1)
		on_drop.call(self, zone, fake_event(y_at(0, 0.8)))
		await new Promise(r => setTimeout(r, 0))
		assert.deepEqual(order(), ['a', 'new', 'b', 'c'])
	})

	it('a duplicate shows no marker, marks the existing row, and is refused', function() {
		reset()
		start_add('b')
		const event = fake_event(y_at(0, 0.2))
		on_dragover.call(self, zone, event)
		assert.equal(list.querySelector('.drop_marker'), null, 'no marker')
		assert.equal(event.dataTransfer.dropEffect, 'none', 'the drop is refused')
		assert.ok(rows[1].classList.contains('drop_duplicate'), 'the existing row is marked')
		assert.equal(on_drop.call(self, zone, fake_event(y_at(0, 0.2))), false)
		assert.deepEqual(order(), ['a', 'b', 'c'])
		assert.ok(!rows[1].classList.contains('drop_duplicate'), 'the mark is cleared')
	})

	it('a sort onto its own position is a no-op; elsewhere it moves the row', function() {
		reset()
		set_sort_payload.call(self, rows[0])
		on_dragover.call(self, zone, fake_event(y_at(0, 0.8)))
		assert.equal(list.querySelector('.drop_marker'), null, 'just below itself: no marker')
		on_dragover.call(self, zone, fake_event(y_at(2, 0.8)))
		assert.equal(marker_index(), 3)
		on_drop.call(self, zone, fake_event(y_at(2, 0.8)))
		assert.deepEqual(order(), ['b', 'c', 'a'])
	})

	it('leaving the zone or ending the drag leaves no marker nor payload', function() {
		reset()
		start_add('new')
		on_dragover.call(self, zone, fake_event(y_at(1, 0.2)))
		on_dragleave.call(self, zone, {relatedTarget: rows[0]})
		assert.ok(list.querySelector('.drop_marker'), 'moving between its own children keeps the marker')
		on_dragleave.call(self, zone, {relatedTarget: document.body})
		assert.equal(list.querySelector('.drop_marker'), null, 'really leaving removes it')
		on_dragover.call(self, zone, fake_event(y_at(1, 0.2)))
		on_dragend.call(self)
		assert.equal(list.querySelector('.drop_marker'), null)
		assert.equal(self.drag_payload, null)
	})
})

describe('TOOL_EXPORT PHONE GESTURES (tap to add, buttons to reorder)', function() {

	// The touch twins of the two drags (phone_tool_export.js). The same fake
	// tool the DROP MODEL uses, plus the phone methods under test.
	let list, self

	const make_row = (id) => {
		const node = document.createElement('div')
		node.className = 'export_component'
		node.textContent = id
		node.ddo = {id, tipo: id, lang: 'lg-eng'}
		// the phone reorder control every selected row carries
		// (build_export_component)
		node.appendChild(render_phone_reorder({
			labels	: {up: 'Up', down: 'Down'},
			on_move	: (direction) => self.move_export_component(node, direction)
		}))
		return node
	}
	const order = () => [...list.children]
		.filter(n => n.classList.contains('export_component'))
		.map(n => n.ddo.id)

	before(function() {
		list = document.createElement('div')
		document.body.appendChild(list)
	})
	after(function() {
		list.remove()
	})

	const reset = () => {
		list.replaceChildren()
		self = {
			user_selection_list		: list,
			compose_id				: (ddo) => ddo.tipo,
			on_drop					: on_drop,
			sync_ar_ddo_to_export() { this.synced = order() },
			update_local_db_data() { this.saved = true },
			build_export_component	: async (ddo) => make_row(ddo.id),
			add_export_component_from_row	: add_export_component_from_row,
			move_export_component			: move_export_component,
			update_phone_reorder_state		: update_phone_reorder_state
		}
	}

	it('the "+" adds a column through the one drop path (append)', async function() {
		reset()
		const row = document.createElement('li')
		row.ddo = {tipo: 'new', lang: 'lg-eng', label: 'new'}

		let added = 0
		const button = render_add_column_button({
			label		: 'Add column',
			field_label	: 'New',
			on_add		: () => {
				added++
				self.add_export_component_from_row(row, [])
			}
		})
		assert.equal(button.type, 'button', 'a real button')
		assert.equal(button.getAttribute('aria-label'), 'Add column: New', 'accessible name')

		button.click()
		assert.equal(added, 1, 'the tap fires the add once')
		await new Promise(resolve => setTimeout(resolve, 0))
		assert.deepEqual(order(), ['new'], 'the column landed (append)')
		assert.deepEqual(self.synced, ['new'], 'the order is synced from the DOM')
		assert.equal(self.saved, true, 'persisted')
	})

	it('requires on_add', function() {
		assert.throws(() => render_add_column_button({label: 'x'}))
	})

	it('a duplicate tap is refused and points at the existing row', function() {
		reset()
		list.appendChild(make_row('a'))
		const row = document.createElement('li')
		row.ddo = {tipo: 'a', lang: 'lg-eng'}

		assert.equal(add_export_component_from_row.call(self, row, []), false, 'no second column')
		assert.deepEqual(order(), ['a'])
		assert.ok(list.children[0].classList.contains('drop_duplicate'), 'the existing row is pointed at')
	})

	it('move_export_component reorders and syncs (the same move the sort drop does)', function() {
		reset()
		list.append(make_row('a'), make_row('b'), make_row('c'))
		const rows = [...list.children]

		assert.equal(self.move_export_component(rows[0], 1), true, 'a moves down')
		assert.deepEqual(order(), ['b', 'a', 'c'])
		assert.deepEqual(self.synced, ['b', 'a', 'c'], 'synced')
		assert.equal(self.saved, true, 'persisted')

		self.move_export_component(rows[0], -1)
		assert.deepEqual(order(), ['a', 'b', 'c'], 'and back up')
	})

	it('an out-of-range move is a no-op (first cannot go up, last cannot go down)', function() {
		reset()
		list.append(make_row('a'), make_row('b'))
		const [first, last] = [...list.children]

		assert.equal(self.move_export_component(first, -1), false)
		assert.equal(self.move_export_component(last, 1), false)
		assert.deepEqual(order(), ['a', 'b'])
	})

	it('update_phone_reorder_state disables the two ends', function() {
		reset()
		list.append(make_row('a'), make_row('b'), make_row('c'))
		self.update_phone_reorder_state()

		const ends = [...list.children].map(row => {
			const [up, down] = row.querySelectorAll('.phone_reorder > .phone_reorder_btn')
			return [up.disabled, down.disabled]
		})
		assert.deepEqual(ends, [[true, false], [false, false], [false, true]])
	})
})

describe('TOOL_EXPORT PRESET EDITOR (dialog chrome)', function() {

	this.timeout(10000)

	// The preset editor is a small dialog: its fields declare, per ddo, the
	// interface they need (applied client-side by section_record — the server
	// strips client ddo properties). No tool buttons on any field, and the name
	// (one per preset) offers no 'add value' button: with both off the name
	// field draws no floating toolbar that could overlap the dialog header.
	it('declares tools:false on every field and button_add:false on the name', async function() {

		// a record id nobody has: the read is harmless, the declaration is what is pinned
		const section = await edit_user_export_preset({}, 999999999)
		try {
			const ddo_map = section.request_config
				.find(el => el.api_engine==='dedalo' && el.type==='main')
				.show.ddo_map
			const interface_of = (tipo) => ddo_map.find(el => el.tipo===tipo)?.properties?.show_interface

			assert.deepEqual(interface_of('dd624'), {tools:false, button_add:false}, 'name: no tools, no add value')
			assert.deepEqual(interface_of('dd640'), {tools:false}, 'public: no tools')
			assert.deepEqual(interface_of('dd641'), {tools:false}, 'default: no tools')
		} finally {
			await section.destroy?.(true, true, true)
		}
	})
})

// @license-end
