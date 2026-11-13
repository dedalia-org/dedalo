// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, before, after */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_IMPORT_DEDALO_CSV
 * Client-side coverage for the Dédalo CSV bulk-import tool.
 *
 * The tool's deeper build/render path needs a host section, a service_upload
 * child instance and live API round-trips (get_csv_files, etc.), none of which
 * are guaranteed in the headless harness. This suite therefore asserts the
 * reliable, fixture-free contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 * The SAMPLE DATA suite at the end is the exception: it drives the real upload
 * door + get_csv_files on the suite server and renders the server's own answer.
 */

import {request_failed, response_data} from '../../../core/common/js/api_error.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {create_transfer} from '../../../core/services/service_upload/js/upload_transport.js'
import * as render_module from '../../../tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js'
import {
	import_mode_allowed,
	render_columns_mapper,
	render_file_info
} from '../../../tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js'
import {
	render_csv_files_messages,
	tool_import_dedalo_csv
} from '../../../tools/tool_import_dedalo_csv/js/tool_import_dedalo_csv.js'



describe('TOOL_IMPORT_DEDALO_CSV CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_import_dedalo_csv, 'function', 'expected tool_import_dedalo_csv to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_import_dedalo_csv()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.events_tokens, null, 'expected events_tokens null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.caller, null, 'expected caller null')
		// tool-specific null-seeded property
		assert.equal(instance.csv_files_list, null, 'expected csv_files_list null')
		assert.equal(instance.csv_files_notices, null, 'expected csv_files_notices null')
		assert.equal(instance.csv_files_errors, null, 'expected csv_files_errors null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_import_dedalo_csv.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_import_dedalo_csv.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_import_dedalo_csv.prototype.refresh, 'function', 'expected refresh wired')
		// render modes delegated to render_tool_import_dedalo_csv
		assert.equal(typeof tool_import_dedalo_csv.prototype.edit, 'function', 'expected edit wired')
		assert.equal(typeof tool_import_dedalo_csv.prototype.upload_done, 'function', 'expected upload_done wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_import_dedalo_csv.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_import_dedalo_csv.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_import_dedalo_csv.prototype.load_csv_files_list, 'function', 'expected load_csv_files_list defined')
		assert.equal(typeof tool_import_dedalo_csv.prototype.remove_file, 'function', 'expected remove_file defined')
		assert.equal(typeof tool_import_dedalo_csv.prototype.import_files, 'function', 'expected import_files defined')
		assert.equal(typeof tool_import_dedalo_csv.prototype.get_section_components_list, 'function', 'expected get_section_components_list defined')
		assert.equal(typeof tool_import_dedalo_csv.prototype.process_uploaded_file, 'function', 'expected process_uploaded_file defined')
	})

})



describe('TOOL_IMPORT_DEDALO_CSV APPEND MODE SELECTOR', function() {

	this.timeout(10000)

	// a stub component list, as get_section_components_list answers it
	const components = [
		{label: 'Id', value: 'test102', model: 'component_section_id', import_append: null},
		{label: 'Portal', value: 'test80', model: 'component_portal', import_append: 'items'},
		{label: 'Geo', value: 'test100', model: 'component_geolocation', import_append: 'geo_layer'},
		{label: 'Select', value: 'test91', model: 'component_select', import_append: null},
		{label: 'Created', value: 'dd199', model: 'component_date', import_append: 'items'}
	]

	const build = async function() {
		const self = {
			get_section_components_list	: async () => ({label: 'Test', list: components}),
			get_tool_label				: () => null,
			csv_files_list				: []
		}
		const item = {
			file_info		: ['section_id', 'test80', 'test100', 'test91', 'dd199'],
			section_tipo	: 'test3',
			ar_columns_map	: [],
			sample_data		: []
		}
		self.csv_files_list.push({checked: true, ar_columns_map: item.ar_columns_map})
		const container = document.createElement('div')
		container.appendChild(await render_columns_mapper(self, item))
		const lines = [...container.querySelectorAll('.columns_mapper_line:not(.names)')]
		return {self, item, lines}
	}
	const mode_select = (line) => line.querySelector('.import_mode_container select.import_mode_select')
	const change = (node, value) => {
		node.value = value
		node.dispatchEvent(new Event('change'))
	}

	it('import_mode_allowed: a policy on a regular column only', function() {
		assert.equal(import_mode_allowed({tipo: 'test80', map_to: 'test80', model: 'component_portal'}, 'items'), true)
		assert.equal(import_mode_allowed({tipo: 'test100', map_to: 'test100', model: 'component_geolocation'}, 'geo_layer'), true)
		assert.equal(import_mode_allowed({tipo: 'test91', map_to: 'test91', model: 'component_select'}, null), false)
		assert.equal(import_mode_allowed({tipo: 'section_id', map_to: 'test102', model: 'component_section_id'}, 'items'), false)
		assert.equal(import_mode_allowed({tipo: 'x', map_to: 'x', model: 'section_id'}, 'items'), false)
		assert.equal(import_mode_allowed({tipo: 'dd199', map_to: 'dd199', model: 'component_date'}, 'items'), false)
		assert.equal(import_mode_allowed(null, 'items'), false)
	})

	it('the selector renders only where append is allowed; geolocation says "Add as new layer"', async function() {
		const {item, lines} = await build()
		assert.equal(lines.length, 5)
		assert.equal(mode_select(lines[0]), null, 'section_id: no selector')
		assert.notEqual(mode_select(lines[1]), null, 'portal: selector')
		assert.notEqual(mode_select(lines[2]), null, 'geolocation: selector')
		assert.equal(mode_select(lines[3]), null, 'select (policy null): no selector')
		assert.equal(mode_select(lines[4]), null, 'audit dd199: no selector')
		assert.equal(item.ar_columns_map[1].import_mode, 'replace')
		assert.equal(item.ar_columns_map[3].import_mode, undefined)
		const geo_options = [...mode_select(lines[2]).options].map(o => o.textContent)
		assert.include(geo_options, 'Add as new layer')
		const portal_options = [...mode_select(lines[1]).options].map(o => o.textContent)
		assert.include(portal_options, 'Append')
	})

	it('the choice is written to ar_columns_map and reset on a target change', async function() {
		const {item, lines} = await build()
		change(mode_select(lines[1]), 'append')
		assert.equal(item.ar_columns_map[1].import_mode, 'append')

		// a new target whose model refuses append: the selector goes, the mode is dropped
		change(lines[1].querySelector('select.column_select'), 'test91')
		assert.equal(mode_select(lines[1]), null)
		assert.equal(item.ar_columns_map[1].import_mode, undefined)

		// a new target that appends: the selector comes back at the default
		change(lines[3].querySelector('select.column_select'), 'test80')
		assert.notEqual(mode_select(lines[3]), null)
		assert.equal(item.ar_columns_map[3].import_mode, 'replace')
	})

	it('no time-machine switch and no TM-off warning: every import is revertible (D1)', function() {
		// WC-2026-09-27-bulk-revert-undo-log: a save under a bulk id always writes
		// its undo pair, so the opt-out and the warning it needed are gone. A
		// resurrected export would mean the switch came back.
		assert.equal(render_module.update_append_tm_warning, undefined, 'update_append_tm_warning must stay removed')
		// import_files takes the file list only (no time_machine_save argument)
		assert.equal(tool_import_dedalo_csv.prototype.import_files.length, 1, 'import_files(files)')
	})

	it('a re-render (section_tipo change) drops a refused append and keeps a preserved one', async function() {
		const {self, item, lines} = await build()
		change(mode_select(lines[1]), 'append')
		assert.equal(item.ar_columns_map[1].import_mode, 'append')

		// the new section refuses append on the portal: its mode is dropped
		const refusing = components.map(c => ({...c, import_append: null}))
		self.get_section_components_list = async () => ({label: 'Other', list: refusing})
		await render_columns_mapper(self, item)
		assert.equal(item.ar_columns_map[1].import_mode, undefined)

		// the reverse: a preserved 'append' on a re-matched column survives
		item.ar_columns_map[1].import_mode = 'append'
		self.get_section_components_list = async () => ({label: 'Test', list: components})
		await render_columns_mapper(self, item)
		assert.equal(item.ar_columns_map[1].import_mode, 'append')
	})

})

describe('TOOL_IMPORT_DEDALO_CSV SECTION-INFO COLUMNS', function() {

	this.timeout(10000)

	// get_section_components_list now appends dd196's children (the common
	// section-info components) after the section's own — for a global admin.
	// An exported CSV carries them as plain tipo headers (dd200) or suffixed
	// ones (dd199_dmy); both must be AUTO-checked and mapped, or the operator
	// re-maps every audit column by hand (the reported bug). A DERIVED dd196
	// child (dd1596, component_inverse) is NOT in the server's list (the door
	// refuses it in every mode), so its header stays unchecked and unmapped.
	const components = [
		{label: 'Id', value: 'test102', model: 'component_section_id', import_append: null},
		{label: 'Text', value: 'test52', model: 'component_input_text', import_append: 'items'},
		{label: 'Created by', value: 'dd200', model: 'component_select', import_append: null},
		{label: 'Created', value: 'dd199', model: 'component_date', import_append: null}
	]

	const build = async function(list) {
		const self = {
			get_section_components_list	: async () => ({label: 'Test', list}),
			get_tool_label				: () => null,
			csv_files_list				: []
		}
		const item = {
			file_info		: ['section_id', 'test52', 'dd200', 'dd199_dmy', 'dd1596'],
			section_tipo	: 'test3',
			ar_columns_map	: [],
			sample_data		: []
		}
		self.csv_files_list.push({checked: true, ar_columns_map: item.ar_columns_map})
		const container = document.createElement('div')
		container.appendChild(await render_columns_mapper(self, item))
		const lines = [...container.querySelectorAll('.columns_mapper_line:not(.names)')]
		return {item, lines}
	}
	const checkbox = (line) => line.querySelector('input[type="checkbox"]')
	const target = (line) => line.querySelector('select.column_select')

	it('a dd200 header and a dd199_dmy header are auto-checked and mapped', async function() {
		const {item, lines} = await build(components)
		assert.equal(lines.length, 5)
		assert.equal(checkbox(lines[2]).checked, true, 'dd200: checked')
		assert.equal(target(lines[2]).value, 'dd200', 'dd200: selected in the dropdown')
		assert.equal(item.ar_columns_map[2].checked, true)
		assert.equal(item.ar_columns_map[2].map_to, 'dd200')
		assert.equal(item.ar_columns_map[2].model, 'component_select')
		assert.equal(checkbox(lines[3]).checked, true, 'dd199_dmy: checked')
		assert.equal(item.ar_columns_map[3].map_to, 'dd199')
	})

	// CLIENT behaviour only: the list here is a stub, so this case cannot prove the
	// server stops offering derived models (that is the server unit gate
	// "no listed item has a DERIVED model"). It pins that a header absent from
	// the list the client receives is never auto-checked or mapped.
	it('a header absent from the received list (dd1596) stays unchecked and unmapped', async function() {
		const {item, lines} = await build(components)
		assert.equal(checkbox(lines[4]).checked, false, 'dd1596: unchecked')
		assert.notEqual(item.ar_columns_map[4]?.checked, true)
		assert.equal(item.ar_columns_map[4]?.map_to, undefined)
	})

	it('without them in the list (the old server answer) the same headers stay unmapped', async function() {
		// the control: proves the assertions above are about the list, not the header
		const {item, lines} = await build(components.filter(c => !c.value.startsWith('dd')))
		assert.equal(checkbox(lines[2]).checked, false, 'dd200: unchecked')
		assert.notEqual(item.ar_columns_map[2].checked, true)
		assert.equal(item.ar_columns_map[2].map_to, undefined)
		assert.equal(checkbox(lines[3]).checked, false, 'dd199_dmy: unchecked')
	})

})


describe('TOOL_IMPORT_DEDALO_CSV SAMPLE DATA (real server answer)', function() {

	this.timeout(30000)

	// The mapper's "Sample data" cell is the first non-empty value of a column
	// across `sample_data`. The server used to ship the HEADER as sample row 0, so
	// every column showed its own name (= the Name cell) as its sample. This case
	// uses NO stubbed payload for the item: the CSV goes through the real upload
	// door, the tool's own process_uploaded_file, and get_csv_files, and the item
	// rendered is exactly what the server answered. Only the target-component list
	// is stubbed — it is not what is under test.
	// Row 2 (the first data row) has an EMPTY third cell, so that column must fall
	// through to row 3.
	const file_name	= `sample_preview_${Date.now()}.csv`
	const csv		= 'section_id;test52;test88\n101;first_value;\n102;second_value;row3_value\n'
	let item		= null

	const tool_api = async function(action, options) {
		const api_response = await data_manager.request({body: {
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: true,
			source			: {model: 'tool_import_dedalo_csv', action},
			options
		}})
		if (request_failed(api_response)) {
			const error = new Error(`${action} refused: ${api_response.error.code} ${api_response.error.message}`)
			error.code = api_response.error.code
			throw error
		}
		return response_data(api_response)
	}

	before(async function() {
		// the situation: a CSV staged through the real upload door
		const upload = await create_transfer({
			file			: new File([csv], file_name, {type: 'text/csv'}),
			name			: file_name,
			key_dir			: 'csv',
			chunk_size_mb	: 0
		}).start()
		assert.ok(upload && !request_failed(upload) && upload.file_data, `upload staged the CSV: ${JSON.stringify(upload?.error || upload)}`)
		const processed = await tool_api('process_uploaded_file', {file_data: upload.file_data})
		assert.equal(processed.file_name, file_name)
		const listed = await tool_api('get_csv_files', {})
		item = (listed.files || []).find(file => file.name===file_name) || null
		assert.ok(item, 'get_csv_files lists the staged CSV')
	})

	after(async function() {
		// the tool's own door: a SOFT delete (renames it into the user's deleted/ dir
		// inside the marked suite media root, which `bun run test:db:setup` sweeps;
		// get_csv_files never lists deleted/). Only one refusal is tolerated: not
		// found when before() never got the file listed — anything else fails loudly.
		try {
			await tool_api('delete_csv_file', {file_name})
		} catch (error) {
			if (!(item===null && error.code==='tool.target_not_found')) throw error
		}
		// zero residue in the live list
		const listed = await tool_api('get_csv_files', {})
		assert.equal((listed.files || []).some(file => file.name===file_name), false, 'staged CSV still listed after cleanup')
	})

	it('the server preview carries data rows only', function() {
		assert.deepEqual(item.file_info, ['section_id', 'test52', 'test88'])
		assert.deepEqual(item.sample_data, [
			['101', 'first_value', ''],
			['102', 'second_value', 'row3_value']
		])
		assert.equal(item.n_records, 2)
	})

	it('each Sample data cell shows the row-2 value; an empty row-2 cell falls through to row 3', async function() {
		const self = {
			get_section_components_list	: async () => ({label: 'Test', list: [
				{label: 'Id', value: 'test102', model: 'component_section_id', import_append: null},
				{label: 'Text', value: 'test52', model: 'component_input_text', import_append: 'items'}
			]}),
			get_tool_label				: () => null,
			csv_files_list				: []
		}
		const rendered = Object.assign({}, item, {section_tipo: 'test3', ar_columns_map: []})
		self.csv_files_list.push({checked: true, ar_columns_map: rendered.ar_columns_map})
		const container = document.createElement('div')
		container.appendChild(await render_columns_mapper(self, rendered))
		const lines = [...container.querySelectorAll('.columns_mapper_line:not(.names)')]
		assert.equal(lines.length, 3)
		const samples = lines.map(line => line.querySelector('.sample_data').textContent)
		assert.deepEqual(samples, ['101', 'first_value', 'row3_value'])
	})

})

describe('TOOL_IMPORT_DEDALO_CSV READ ERRORS (real server answer)', function() {

	this.timeout(30000)

	// T1-S18. A staged CSV the server refuses to READ (here: it already carries a
	// U+FFFD, i.e. it was damaged before it reached us) is absent from `files`,
	// and its sentence travels in get_csv_files' `errors`. The controller used to
	// send that sentence to console.error, so the file vanished from the panel
	// with no reason given. The situation is built through the real upload door,
	// the tool's own process_uploaded_file and the controller's own
	// load_csv_files_list — no stubbed payload.
	const file_name	= `bad_read_${Date.now()}.csv`
	const csv		= 'section_id;test52\n1;bad\uFFFD\n'
	let staged		= false
	let self		= null

	const tool_api = async function(action, options) {
		const api_response = await data_manager.request({body: {
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: true,
			source			: {model: 'tool_import_dedalo_csv', action},
			options
		}})
		if (request_failed(api_response)) {
			const error = new Error(`${action} refused: ${api_response.error.code} ${api_response.error.message}`)
			error.code = api_response.error.code
			throw error
		}
		return response_data(api_response)
	}

	before(async function() {
		const upload = await create_transfer({
			file			: new File([csv], file_name, {type: 'text/csv'}),
			name			: file_name,
			key_dir			: 'csv',
			chunk_size_mb	: 0
		}).start()
		assert.ok(upload && !request_failed(upload) && upload.file_data, `upload staged the CSV: ${JSON.stringify(upload?.error || upload)}`)
		const processed = await tool_api('process_uploaded_file', {file_data: upload.file_data})
		assert.equal(processed.file_name, file_name)
		staged = true

		self		= new tool_import_dedalo_csv()
		self.model	= 'tool_import_dedalo_csv'
		self.mode	= 'edit'
		self.csv_files_list = await tool_import_dedalo_csv.prototype.load_csv_files_list.call(self)
	})

	after(async function() {
		// The tool's own SOFT delete — it accepts a file the list does not show.
		if (staged) {
			await tool_api('delete_csv_file', {file_name})
		}
	})

	it('the controller keeps the read error for the panel', function() {
		assert.ok(Array.isArray(self.csv_files_errors), 'csv_files_errors is kept')
		const mine = self.csv_files_errors.filter(line => line.includes(file_name))
		assert.equal(mine.length, 1, `one read error names the file: ${JSON.stringify(self.csv_files_errors)}`)
	})

	it('the panel paints it in the error channel, a notice outside it, once', function() {
		const container = document.createElement('div')
		container.appendChild(document.createElement('div')) // the tool body's own content
		const probe = Object.assign(Object.create(self), {
			csv_files_notices	: ['seeded.csv: the file is not UTF-8 — it was read as windows-1252 and converted.'],
			csv_files_errors	: self.csv_files_errors
		})
		render_csv_files_messages(probe, container)
		render_csv_files_messages(probe, container) // a content-level refresh re-enters

		const error_containers = container.querySelectorAll(':scope > .dedalo_last_error_container')
		assert.equal(error_containers.length, 1, 'one error block, not duplicated')
		const pre = error_containers[0].querySelector('.error_pre')
		assert.ok(pre && pre.textContent.includes(file_name), 'the error block names the file')

		const notices = container.querySelectorAll(':scope > .notice_msg')
		assert.equal(notices.length, 1, 'one notice block, not duplicated')
		assert.equal(notices[0].querySelector('.dedalo_last_error_container'), null, 'the notice is not in the error channel')
		assert.ok(notices[0].textContent.includes('seeded.csv'))
		// notices first, then the errors, both above the body's own content
		assert.equal(container.firstChild, notices[0])
		assert.equal(container.children[1], error_containers[0])
	})

	// C51 (owner 2026-11-13), WC-2026-11-13-csv-staged-file-read-error-card:
	// the unreadable file is ALSO listed in `files`, as a `read_error` entry
	// with no column analysis, and the panel renders it as a card the operator
	// can delete from. Before: absent from `files`, so no card and no delete
	// button — the staged file could not be removed from the panel.
	it('the server lists the unreadable file as a read_error entry, without a column analysis', function() {
		const mine = self.csv_files_list.filter(item => item.name === file_name)
		assert.equal(mine.length, 1, `one files entry names the file: ${JSON.stringify(self.csv_files_list.map(i => i.name))}`)
		assert.equal(typeof mine[0].read_error, 'string')
		assert.ok(mine[0].read_error.length > 0, 'the entry carries the refusal sentence')
		assert.equal(mine[0].ar_columns_map, undefined, 'no column analysis')
		assert.equal(mine[0].file_info, undefined, 'no header')
	})

	it('the panel renders it as a delete-only card: name, sentence, delete — no checkbox, no mapper, no preview', function() {
		const item = self.csv_files_list.find(item => item.name === file_name)
		const card = render_file_info(self, item)
		assert.ok(card.classList.contains('file_item') && card.classList.contains('unreadable'), 'an unreadable file_item card')
		assert.ok(card.querySelector('.file_line .file_name').textContent === file_name, 'the card names the file')
		assert.equal(card.querySelector('.read_error').textContent, item.read_error, 'the sentence is shown as text')
		assert.ok(card.querySelector('.file_line .button.delete'), 'the delete button is offered')
		assert.equal(card.querySelector('input[type="checkbox"]'), null, 'no selection: it can never be imported')
		assert.equal(card.querySelector('.columns_mapper'), null, 'no mapper')
		assert.equal(card.querySelector('.preview'), null, 'no preview')
		assert.equal(card.querySelector('.section_tipo'), null, 'no section input')
	})

	it('the sentence is a text node: markup in a read_error renders literally', function() {
		const card = render_file_info(self, {dir: 'x', name: 'x.csv', read_error: '<b class="injected">boom</b> &amp; more'})
		assert.equal(card.querySelector('.injected'), null, 'no element was parsed out of the sentence')
		assert.equal(card.querySelector('.read_error').textContent, '<b class="injected">boom</b> &amp; more')
	})

	it('a readable entry still renders the full card (control)', function() {
		const readable = self.csv_files_list.find(item => !item.read_error)
		if (!readable) {
			this.skip() // the suite user has no other staged CSV in this run
			return
		}
		const card = render_file_info(self, readable)
		assert.ok(!card.classList.contains('unreadable'))
		assert.ok(card.querySelector('input[type="checkbox"]'), 'selection offered')
		assert.ok(card.querySelector('.columns_mapper'), 'mapper offered')
	})

})

// @license-end
