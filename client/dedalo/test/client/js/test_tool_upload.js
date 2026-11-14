// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UPLOAD
 * Client-side coverage for the file-upload tool.
 *
 * The tool's deeper build/render path instantiates a live `service_upload`
 * child (drag-and-drop file picker) and needs a host section with a configured
 * upload caller plus a real browser file dialog, none of which is guaranteed in
 * the headless harness. This suite therefore asserts the reliable, fixture-free
 * contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 */

import {get_content_data} from '../../../core/services/service_upload/js/render_edit_service_upload.js'
import {tool_upload} from '../../../tools/tool_upload/js/tool_upload.js'



describe('TOOL_UPLOAD CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_upload, 'function', 'expected tool_upload to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_upload()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.events_tokens, null, 'expected events_tokens null')
		assert.equal(instance.type, null, 'expected type null')
		assert.equal(instance.caller, null, 'expected caller null')
		assert.equal(instance.service_upload, null, 'expected service_upload null')
		assert.equal(instance.max_size_bytes, null, 'expected max_size_bytes null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_upload.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_upload.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_upload.prototype.refresh, 'function', 'expected refresh wired')
		// render modes delegated to render_tool_upload
		assert.equal(typeof tool_upload.prototype.edit, 'function', 'expected edit wired')
		assert.equal(typeof tool_upload.prototype.list, 'function', 'expected list wired')
		assert.equal(typeof tool_upload.prototype.mini, 'function', 'expected mini wired')
		assert.equal(typeof tool_upload.prototype.upload_done, 'function', 'expected upload_done wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_upload.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_upload.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_upload.prototype.process_uploaded_file_controller, 'function', 'expected process_uploaded_file_controller defined')
	})

})



/**
* SERVICE_UPLOAD OCR OPTIONS (T0-11 D3)
* The upload's OCR panel offers ONLY the langs the server measured it can OCR
* (system_info.pdf_ocr_langs), shows only when pdf_ocr_engine is true AND that
* list is not empty, and seeds process_options.ocr_lang from the shown option
* (it stayed null until a click before). Fixture-free: get_content_data over a
* plain self carrying the system_info fields service_upload.build copies.
*/
describe('SERVICE_UPLOAD OCR OPTIONS', function() {

	const fake_self = function(overrides) {
		return Object.assign({
			// a real caller (component or tool) always carries its context; features
			// may be absent (render_info tolerates that, not a context-less caller)
			caller						: {model : 'component_pdf', context : {}},
			allowed_extensions			: ['pdf'],
			max_size_bytes				: 1024*1024*1024,
			upload_service_chunk_files	: false,
			sys_get_temp_dir			: '/tmp',
			upload_tmp_dir				: '/tmp',
			upload_tmp_perms			: 0,
			session_cache_expire		: 180,
			max_concurrent				: 2,
			pdf_ocr_engine				: true,
			pdf_ocr_langs				: []
		}, overrides)
	}

	// the first app lang the page knows, so the label lookup is exercised
	const app_langs		= page_globals.dedalo_application_langs || []
	const first_lang	= app_langs[0] ? app_langs[0].value : 'lg-eng'

	it('offers only pdf_ocr_langs and seeds ocr_lang from the shown option', function() {
		const self		= fake_self({pdf_ocr_langs : [first_lang, 'lg-zzz']})
		const node		= get_content_data(self)
		const select	= node.querySelector('.ocr_options_container select')
		assert.ok(select, 'expected the OCR select')
		const values = [...select.options].map(el => el.value)
		assert.deepEqual(values, [first_lang, 'lg-zzz'], 'expected exactly pdf_ocr_langs, in order')
		assert.equal(self.process_options.ocr_lang, select.value, 'expected ocr_lang = the shown option')
		assert.ok(values.includes(self.process_options.ocr_lang), 'expected ocr_lang not null')
	})

	it("updates ocr_lang on 'change' (keyboard selection included)", function() {
		const self		= fake_self({pdf_ocr_langs : [first_lang, 'lg-zzz']})
		const node		= get_content_data(self)
		const select	= node.querySelector('.ocr_options_container select')
		select.value = 'lg-zzz'
		select.dispatchEvent(new Event('change'))
		assert.equal(self.process_options.ocr_lang, 'lg-zzz')
	})

	it('no OCR panel without an installed lang, or without the engine', function() {
		const no_langs = get_content_data(fake_self({pdf_ocr_langs : []}))
		assert.equal(no_langs.querySelector('.ocr_options_container'), null, 'expected no panel without langs')
		const no_engine = get_content_data(fake_self({pdf_ocr_engine : false, pdf_ocr_langs : [first_lang]}))
		assert.equal(no_engine.querySelector('.ocr_options_container'), null, 'expected no panel without engine')
	})

})

// @license-end
